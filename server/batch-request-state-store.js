"use strict";

// #1046 M6: durable, project-scoped persistence for the normalized Batch
// Request subscription state.  This module deliberately has no watcher
// scheduling, GitHub, chat, route, or dispatch authority.  It exposes only an
// explicit initialization, a read-only recovery snapshot, and one atomic CAS
// application of a watcher reconciliation result.

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");
const {
  VERSION: SUBSCRIPTION_VERSION,
  BatchRequestSubscriptionError,
  dedupeKey,
  normalizeSubscriptionState,
} = require("./batch-request-subscription");
const {
  VERSION: WATCHER_VERSION,
  MAX_FETCHED_ISSUES,
} = require("./batch-request-watcher");
const {
  BatchRequestContractError,
  canonicalizeBatchRequestAuthority,
} = require("./batch-request-contract");

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const ISSUE_NUMBER_RE = /^[1-9]\d{0,6}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const DIAGNOSTIC_RE = /^[a-z][a-z0-9_]{2,127}$/;

class BatchRequestStateStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "BatchRequestStateStoreError";
    this.code = code;
  }
}

function fail(code, message) { throw new BatchRequestStateStoreError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function identity(value, code) {
  exact(value, ["installation_id", "project_id"], code);
  if (typeof value.installation_id !== "string" || !INSTALLATION_ID_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_ID_RE.test(value.project_id)) {
    fail(code, "installation/project identity is invalid");
  }
  return { installation_id: value.installation_id, project_id: value.project_id };
}
function sameIdentity(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id;
}
function expected(value, allowUninitialized, code) {
  exact(value, ["installation_id", "project_id", "revision"], code);
  const owner = identity({ installation_id: value.installation_id, project_id: value.project_id }, code);
  if (value.revision === null && allowUninitialized) return { ...owner, revision: null };
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    fail(code, "expected revision is invalid");
  }
  return { ...owner, revision: value.revision };
}
function canonicalSubscriptionState(value, code) {
  try { return normalizeSubscriptionState(value); }
  catch (error) {
    if (error instanceof BatchRequestSubscriptionError) fail(code, "subscription state is invalid");
    throw error;
  }
}
function assertFs(fs) {
  for (const name of ["mkdirSync", "lstatSync", "fstatSync", "readFileSync", "writeFileSync", "renameSync", "chmodSync", "openSync", "closeSync", "fsyncSync", "unlinkSync"]) {
    if (typeof fs[name] !== "function") fail("invalid_batch_request_state_store_options", `fs.${name} is required`);
  }
  return fs;
}
function storageDirectory(configDir) {
  if (typeof configDir !== "string" || !path.isAbsolute(configDir) || configDir.length > 1024 || /[\u0000\r\n]/.test(configDir)) {
    fail("invalid_batch_request_state_store_options", "config_dir must be a bounded absolute path");
  }
  return path.join(configDir, "batch-request-watchers");
}
function batchRequestStateStorePath(configDir, owner) {
  const normalized = identity(owner, "invalid_batch_request_state_store_identity");
  return path.join(storageDirectory(configDir), `${normalized.installation_id}--${normalized.project_id}.json`);
}
function lockPathFor(statePath) { return `${statePath}.lock`; }
function temporaryPathFor(statePath) {
  return `${statePath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`;
}
// The lock file body is this writer's proof of ownership. dev+ino alone cannot
// prove it: Linux reuses an inode number as soon as the old lock is unlinked
// and closed, so a replacement lock can carry the original's identity.
function lockToken() { return `${process.pid}.${crypto.randomBytes(16).toString("hex")}`; }
function modeOf(stats) { return stats.mode & 0o777; }
function lstatOrNull(fs, target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    fail("batch_request_state_store_unreadable", "state store path cannot be inspected");
  }
}
function sameFile(left, right) {
  return left && right && Number.isSafeInteger(left.dev) && Number.isSafeInteger(left.ino) &&
    left.dev === right.dev && left.ino === right.ino;
}
function assertRealDirectory(fs, target, expectedMode) {
  const stats = lstatOrNull(fs, target);
  if (stats === null) return null;
  if (stats.isSymbolicLink()) fail("batch_request_state_store_symlink_rejected", "state store paths cannot be symbolic links");
  if (!stats.isDirectory()) fail("batch_request_state_store_unreadable", "state store path is not a directory");
  if (expectedMode !== undefined && modeOf(stats) !== expectedMode) {
    fail("batch_request_state_store_insecure_permissions", "state store directory must be mode 0700");
  }
  return stats;
}
function ensureDirectory(fs, root, directory) {
  if (assertRealDirectory(fs, root) === null) {
    fs.mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
    if (assertRealDirectory(fs, root) === null) fail("batch_request_state_store_unreadable", "config root cannot be created");
  }
  if (assertRealDirectory(fs, directory, DIRECTORY_MODE) === null) {
    fs.mkdirSync(directory, { recursive: false, mode: DIRECTORY_MODE });
    if (assertRealDirectory(fs, directory, DIRECTORY_MODE) === null) fail("batch_request_state_store_unreadable", "state store directory cannot be created");
  }
}
function storageExists(fs, root, directory) {
  if (assertRealDirectory(fs, root) === null) return false;
  return assertRealDirectory(fs, directory, DIRECTORY_MODE) !== null;
}

function assertStoredState(value) {
  exact(value, ["schema_version", "identity", "revision", "subscription_state"], "invalid_batch_request_state_store_state");
  if (value.schema_version !== SCHEMA_VERSION) fail("unknown_batch_request_state_store_schema", "state store schema is unsupported");
  identity(value.identity, "invalid_batch_request_state_store_state");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    fail("invalid_batch_request_state_store_state", "stored revision is invalid");
  }
  canonicalSubscriptionState(value.subscription_state, "invalid_batch_request_state_store_state");
  return value;
}
function recoverySnapshot(state) {
  assertStoredState(state);
  const subscriptionState = canonicalSubscriptionState(state.subscription_state, "invalid_batch_request_state_store_state");
  return freeze({
    schema_version: SCHEMA_VERSION,
    identity: clone(state.identity),
    revision: state.revision,
    subscription_state: clone(subscriptionState),
  });
}
function decodeState(fs, statePath, owner, allowMissing) {
  let raw;
  try {
    const before = fs.lstatSync(statePath);
    if (before.isSymbolicLink()) fail("batch_request_state_store_symlink_rejected", "state store paths cannot be symbolic links");
    if (!before.isFile() || modeOf(before) !== FILE_MODE) {
      fail("batch_request_state_store_insecure_permissions", "state store must be a mode 0600 file");
    }
    // Read through the checked descriptor. A pathname replacement between
    // lstat and open (or while reading) must fail rather than following a
    // symlink or accepting another file's otherwise-valid JSON.
    const descriptor = fs.openSync(statePath, "r");
    try {
      const opened = fs.fstatSync(descriptor);
      const current = fs.lstatSync(statePath);
      if (current.isSymbolicLink()) fail("batch_request_state_store_symlink_rejected", "state store paths cannot be symbolic links");
      if (!opened.isFile() || modeOf(opened) !== FILE_MODE || !current.isFile() || modeOf(current) !== FILE_MODE ||
          !sameFile(before, opened) || !sameFile(opened, current)) {
        fail("batch_request_state_store_unreadable", "state store changed while being opened");
      }
      raw = fs.readFileSync(descriptor, "utf8");
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error instanceof BatchRequestStateStoreError) throw error;
    if (error && error.code === "ENOENT") {
      if (allowMissing) return null;
      fail("batch_request_state_store_missing", "state store is not initialized");
    }
    fail("batch_request_state_store_unreadable", "state store cannot be read");
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { fail("corrupt_batch_request_state_store", "state store is corrupt"); }
  if (!plain(value) || value.schema_version !== SCHEMA_VERSION) {
    if (plain(value) && Object.prototype.hasOwnProperty.call(value, "schema_version")) {
      fail("unknown_batch_request_state_store_schema", "state store schema is unsupported");
    }
    fail("corrupt_batch_request_state_store", "state store is corrupt");
  }
  try { assertStoredState(value); }
  catch (error) {
    if (error instanceof BatchRequestStateStoreError && error.code === "unknown_batch_request_state_store_schema") throw error;
    fail("corrupt_batch_request_state_store", "state store validation failed");
  }
  if (!sameIdentity(value.identity, owner)) {
    fail("batch_request_state_store_identity_mismatch", "state store belongs to a different project");
  }
  // Do not let semantically equivalent JSON key ordering become a false
  // reconciliation transition. All callers operate on this canonical form.
  return {
    schema_version: SCHEMA_VERSION,
    identity: identity(value.identity, "invalid_batch_request_state_store_state"),
    revision: value.revision,
    subscription_state: canonicalSubscriptionState(value.subscription_state, "invalid_batch_request_state_store_state"),
  };
}
function writeStateAtomically(fs, statePath, state) {
  const directory = path.dirname(statePath);
  const temporaryPath = temporaryPathFor(statePath);
  let temporaryWritten = false;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    temporaryWritten = true;
    fs.chmodSync(temporaryPath, FILE_MODE);
    const fileDescriptor = fs.openSync(temporaryPath, "r");
    try { fs.fsyncSync(fileDescriptor); } finally { fs.closeSync(fileDescriptor); }
    fs.renameSync(temporaryPath, statePath);
    temporaryWritten = false;
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    if (temporaryWritten) {
      try { fs.unlinkSync(temporaryPath); } catch { /* temp cleanup only */ }
    }
    if (error instanceof BatchRequestStateStoreError) throw error;
    fail("batch_request_state_store_write_failed", "atomic state store write failed");
  }
}
function lockStat(fs, lockPath) {
  const stats = lstatOrNull(fs, lockPath);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== FILE_MODE) {
    fail("batch_request_state_store_lock_failed", "state store writer lock is unsafe");
  }
  return stats;
}
function acquireLock(fs, statePath) {
  const lockPath = lockPathFor(statePath);
  const token = lockToken();
  let descriptor;
  let ownStat = null;
  try { descriptor = fs.openSync(lockPath, "wx", FILE_MODE); }
  catch (error) {
    if (error && error.code === "EEXIST") {
      lockStat(fs, lockPath);
      fail("batch_request_state_store_locked", "state store has an active or stale writer lock");
    }
    fail("batch_request_state_store_lock_failed", "state store lock cannot be acquired");
  }
  try {
    fs.writeFileSync(descriptor, token, "utf8");
    fs.chmodSync(lockPath, FILE_MODE);
    fs.fsyncSync(descriptor);
    ownStat = fs.fstatSync(descriptor);
    if (!sameFile(ownStat, lockStat(fs, lockPath))) {
      fail("batch_request_state_store_lock_failed", "state store lock changed during acquisition");
    }
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* fail closed */ }
    try {
      if (sameFile(ownStat, lockStat(fs, lockPath)) && fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    } catch { /* replacement remains fail closed */ }
    if (error instanceof BatchRequestStateStoreError) throw error;
    fail("batch_request_state_store_lock_failed", "state store lock cannot be initialized");
  }
  return { descriptor, lockPath, stat: ownStat, token };
}
function releaseLock(fs, lock) {
  let closeError = null;
  try { fs.closeSync(lock.descriptor); } catch (error) { closeError = error; }
  try {
    if (!sameFile(lock.stat, lockStat(fs, lock.lockPath)) || fs.readFileSync(lock.lockPath, "utf8") !== lock.token) {
      fail("batch_request_state_store_lock_release_failed", "state store lock changed before release");
    }
    fs.unlinkSync(lock.lockPath);
  } catch (error) {
    if (error instanceof BatchRequestStateStoreError) throw error;
    fail("batch_request_state_store_lock_release_failed", "state store writer lock could not be released");
  }
  if (closeError) fail("batch_request_state_store_lock_release_failed", "state store writer lock could not be closed");
}
function withWriterLock(fs, statePath, action) {
  const lock = acquireLock(fs, statePath);
  let result;
  let actionError;
  try { result = action(); } catch (error) { actionError = error; }
  try { releaseLock(fs, lock); } catch (releaseError) {
    if (actionError) throw actionError;
    throw releaseError;
  }
  if (actionError) throw actionError;
  return result;
}

function canonicalIssueUrl(value, repository, number, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) fail(code, "issue URL is invalid");
  let parsed;
  try { parsed = new URL(value); }
  catch { fail(code, "issue URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.host !== "api.github.com" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== `/repos/${repository}/issues/${number}` || parsed.toString() !== value) {
    fail(code, "issue URL does not identify the exact canonical issue");
  }
  return value;
}
function assertHeadPlan(value, owner, currentState, nextState, code) {
  if (value === null) return null;
  exact(value, ["version", "kind", "recipients", "correlation_key", "issue_url", "anchors", "authority"], code);
  if (value.version !== SUBSCRIPTION_VERSION || value.kind !== "BATCH REQUEST" || !Array.isArray(value.recipients) ||
      value.recipients.length !== 1 || value.recipients[0] !== "head") {
    fail(code, "watcher plan is not an exact Head-only batch request");
  }
  exact(value.anchors, ["coordination_repo", "issue_number", "request_id", "authority_digest"], code);
  if (typeof value.anchors.coordination_repo !== "string" || !REPOSITORY_RE.test(value.anchors.coordination_repo) ||
      !Number.isSafeInteger(value.anchors.issue_number) || !ISSUE_NUMBER_RE.test(String(value.anchors.issue_number)) ||
      typeof value.anchors.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.anchors.request_id) ||
      typeof value.anchors.authority_digest !== "string" || !SHA_RE.test(value.anchors.authority_digest)) {
    fail(code, "watcher plan anchors are invalid");
  }
  let parsed;
  try { parsed = canonicalizeBatchRequestAuthority(value.authority); }
  catch (error) {
    if (error instanceof BatchRequestContractError) fail(code, "watcher plan authority is invalid");
    throw error;
  }
  if (!sameJson(value.authority, parsed.authority) || parsed.digest !== value.anchors.authority_digest ||
      parsed.authority.request_id !== value.anchors.request_id || parsed.authority.coordination_repo !== value.anchors.coordination_repo ||
      parsed.authority.target_installation_id !== owner.installation_id || parsed.authority.target_project_id !== owner.project_id) {
    fail(code, "watcher plan authority does not match state identity");
  }
  canonicalIssueUrl(value.issue_url, value.anchors.coordination_repo, value.anchors.issue_number, code);
  if (typeof value.correlation_key !== "string" || value.correlation_key !== dedupeKey(
    value.anchors.coordination_repo, value.anchors.issue_number, value.anchors.request_id, value.anchors.authority_digest,
  )) {
    fail(code, "watcher plan correlation key is invalid");
  }
  const record = nextState.records.find((entry) => entry.coordination_repo === value.anchors.coordination_repo &&
    entry.issue_number === value.anchors.issue_number && entry.request_id === value.anchors.request_id);
  const existing = currentState.records.find((entry) => entry.coordination_repo === value.anchors.coordination_repo &&
    entry.issue_number === value.anchors.issue_number && entry.request_id === value.anchors.request_id);
  if (!record || existing || record.status !== "delivered" || record.authority_digest !== value.anchors.authority_digest ||
      record.dedupe_key !== value.correlation_key || record.mutated_digest !== null) {
    fail(code, "watcher plan is not backed by one newly admitted delivery record");
  }
  return clone(value);
}
function assertWatcherResult(value, owner, currentState) {
  const code = "invalid_batch_request_state_store_result";
  exact(value, ["version", "next_state", "head_plan", "processed", "internal_diagnostics"], code);
  if (value.version !== WATCHER_VERSION || !Number.isSafeInteger(value.processed) || value.processed < 0 || value.processed > MAX_FETCHED_ISSUES ||
      !Array.isArray(value.internal_diagnostics) || value.internal_diagnostics.length > 1) {
    fail(code, "watcher reconciliation result is invalid");
  }
  for (const entry of value.internal_diagnostics) {
    exact(entry, ["code"], code);
    if (typeof entry.code !== "string" || !DIAGNOSTIC_RE.test(entry.code)) fail(code, "watcher diagnostic is invalid");
  }
  const nextState = canonicalSubscriptionState(value.next_state, code);
  const headPlan = assertHeadPlan(value.head_plan, owner, currentState, nextState, code);
  if (headPlan !== null && sameJson(currentState, nextState)) {
    fail(code, "watcher plan cannot be admitted without durable state progress");
  }
  return { next_state: nextState, head_plan: headPlan };
}
function assertInitialization(input) {
  exact(input, ["expected", "subscription_state"], "invalid_batch_request_state_store_initialization");
  const precondition = expected(input.expected, true, "invalid_batch_request_state_store_initialization");
  if (precondition.revision !== null) fail("invalid_batch_request_state_store_initialization", "initial revision must be null");
  return { precondition, subscription_state: canonicalSubscriptionState(input.subscription_state, "invalid_batch_request_state_store_initialization") };
}
function assertApplication(input) {
  exact(input, ["expected", "result"], "invalid_batch_request_state_store_apply");
  const precondition = expected(input.expected, false, "invalid_batch_request_state_store_apply");
  return { precondition, result: input.result };
}

function createBatchRequestStateStore(options) {
  exact(options, ["config_dir", "fs"], "invalid_batch_request_state_store_options");
  const fs = assertFs(options.fs || nodeFs);
  const directory = storageDirectory(options.config_dir);

  function statePath(owner) {
    return batchRequestStateStorePath(options.config_dir, {
      installation_id: owner.installation_id,
      project_id: owner.project_id,
    });
  }
  function readRecoverySnapshot(owner) {
    const normalized = identity(owner, "invalid_batch_request_state_store_identity");
    if (!storageExists(fs, options.config_dir, directory)) {
      fail("batch_request_state_store_missing", "state store is not initialized");
    }
    return recoverySnapshot(decodeState(fs, statePath(normalized), normalized, false));
  }
  function initialize(input) {
    const initial = assertInitialization(input);
    const target = statePath(initial.precondition);
    ensureDirectory(fs, options.config_dir, directory);
    return withWriterLock(fs, target, () => {
      const existing = decodeState(fs, target, initial.precondition, true);
      if (existing !== null) fail("batch_request_state_store_already_initialized", "state store already exists");
      const state = {
        schema_version: SCHEMA_VERSION,
        identity: { installation_id: initial.precondition.installation_id, project_id: initial.precondition.project_id },
        revision: 0,
        subscription_state: clone(initial.subscription_state),
      };
      assertStoredState(state);
      writeStateAtomically(fs, target, state);
      return recoverySnapshot(state);
    });
  }
  function applyWatcherResult(input) {
    const application = assertApplication(input);
    const target = statePath(application.precondition);
    if (!storageExists(fs, options.config_dir, directory)) {
      fail("batch_request_state_store_missing", "state store is not initialized");
    }
    return withWriterLock(fs, target, () => {
      const current = decodeState(fs, target, application.precondition, false);
      if (current.revision !== application.precondition.revision) {
        fail("stale_batch_request_state_store_revision", "state store changed before reconciliation result application");
      }
      const admitted = assertWatcherResult(application.result, application.precondition, current.subscription_state);
      const changed = !sameJson(current.subscription_state, admitted.next_state);
      if (!changed) {
        return freeze({ snapshot: recoverySnapshot(current), head_plan: null, persisted: false });
      }
      const next = {
        schema_version: SCHEMA_VERSION,
        identity: clone(current.identity),
        revision: current.revision + 1,
        subscription_state: clone(admitted.next_state),
      };
      assertStoredState(next);
      writeStateAtomically(fs, target, next);
      // The only time a Head plan leaves this module is after its exact
      // backing delivery record and revision are safely committed.  A caller
      // that loses this receipt must reread/reconcile; a stale CAS never
      // replays the old plan.
      return freeze({ snapshot: recoverySnapshot(next), head_plan: admitted.head_plan === null ? null : freeze(clone(admitted.head_plan)), persisted: true });
    });
  }

  return freeze({ readRecoverySnapshot, initialize, applyWatcherResult });
}

module.exports = {
  SCHEMA_VERSION,
  FILE_MODE,
  DIRECTORY_MODE,
  BatchRequestStateStoreError,
  assertBatchRequestStateStoreState: assertStoredState,
  batchRequestStateStorePath,
  createBatchRequestStateStore,
};
