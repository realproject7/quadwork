"use strict";

// #1038: explicit, token-bound installation for the runtime resource policy
// and its disk-backed temp root. Nothing in this module runs at startup. The
// CLI is the sole production caller and always uses CONFIG_PATH; injectable
// filesystem seams exist only so the refusal paths can be tested.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { CONFIG_PATH } = require("./config");
const { parseRuntimeResources } = require("./resource-policy");
const {
  SecureResourceDirectoryError,
  createLinuxSecureDirectoryHandle,
  validateEntryName,
} = require("./resource-secure-directory");
const { ensureTempRoot, TMPFS_MAGIC, RAMFS_MAGIC } = require("./resource-temp");

const POLICY_FILE_MAX_BYTES = 64 * 1024;
const CONFIG_FILE_MAX_BYTES = 4 * 1024 * 1024;
const ACCEPTANCE_RE = /^[a-f0-9]{64}$/;
const MAX_RECOVERY_ENTRIES = 8;
const MAX_RECOVERY_ENTRY_BYTES = 255;
const OPERATION_CREATED_ENTRY_UNLOCATED = "operation_created_entry_unlocated";
const EMPTY_RECOVERY_ENTRIES = Object.freeze([]);
const RESOURCE_INSTALL_ERROR_STATE = new WeakMap();

function installErrorState(reason, recoveryEntries = EMPTY_RECOVERY_ENTRIES, recoveryScope = null) {
  return Object.freeze({
    reason: typeof reason === "string" ? reason : "resource_operation_failed",
    recoveryEntries,
    recoveryScope,
  });
}

class ResourceInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResourceInstallError";
    this.code = code;
    // Recovery metadata is authority-bearing operator output. Register every
    // genuine instance privately, and let only source-owned failure factories
    // replace the empty bounded state below.
    RESOURCE_INSTALL_ERROR_STATE.set(this, installErrorState(code));
  }
}

function fail(code, message) {
  throw new ResourceInstallError(code, message);
}

function normalizeRecoveryEntries(entries) {
  if (!Array.isArray(entries)) return Object.freeze([]);
  const accepted = [];
  const seen = new Set();
  for (const entry of entries) {
    if (accepted.length >= MAX_RECOVERY_ENTRIES) break;
    if (typeof entry !== "string"
      || entry.length === 0
      || Buffer.byteLength(entry, "utf8") > MAX_RECOVERY_ENTRY_BYTES
      || entry === "."
      || entry === ".."
      || entry.includes("\0")
      || entry.includes("/")
      || entry.includes("\\")
      || path.basename(entry) !== entry
      || seen.has(entry)) continue;
    seen.add(entry);
    accepted.push(entry);
  }
  return Object.freeze(accepted);
}

function normalizeRecoveryScope(scope) {
  return scope === OPERATION_CREATED_ENTRY_UNLOCATED ? scope : null;
}

function createRecoveryError(code, message, entries, scope = null) {
  const error = new ResourceInstallError(code, message);
  RESOURCE_INSTALL_ERROR_STATE.set(error, installErrorState(
    code,
    normalizeRecoveryEntries(entries),
    normalizeRecoveryScope(scope),
  ));
  return error;
}

function recoveryFailure(code, message, entries) {
  throw createRecoveryError(code, message, entries);
}

function resourceInstallFailureForError(error) {
  return RESOURCE_INSTALL_ERROR_STATE.get(error) || null;
}

function recoveryEntriesForError(error) {
  const state = resourceInstallFailureForError(error);
  return state ? state.recoveryEntries : EMPTY_RECOVERY_ENTRIES;
}

function recoveryScopeForError(error) {
  const state = resourceInstallFailureForError(error);
  return state ? state.recoveryScope : null;
}

function expectedUid(options) {
  if (Object.prototype.hasOwnProperty.call(options, "expectedUid")) return options.expectedUid;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function modeOf(stat) {
  return Number(stat.mode) & 0o7777;
}

function hasSingleLink(stat) {
  return stat.nlink === undefined || Number(stat.nlink) === 1;
}

function sameIdentity(left, right) {
  return left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && modeOf(left) === modeOf(right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameOwnedNode(left, right) {
  return left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && modeOf(left) === modeOf(right);
}

function sameNode(left, right) {
  return sameOwnedNode(left, right)
    && left.size === right.size
    && hasSingleLink(left)
    && hasSingleLink(right);
}

function validateOwner(stat, uid, code) {
  if (uid !== null && stat.uid !== uid) fail(code, "resource input has an unexpected owner");
}

function openNoFollow(fsImpl, filePath) {
  const constants = fsImpl.constants || fs.constants;
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("O_NOFOLLOW is unavailable");
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  return fsImpl.openSync(filePath, flags);
}

function readSecureRegularFile(filePath, { fsImpl = fs, maxBytes, kind, uid }) {
  let before;
  try {
    before = fsImpl.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") fail(`${kind}_missing`, `${kind} is missing`);
    fail(`${kind}_unreadable`, `${kind} cannot be inspected`);
  }
  if (before.isSymbolicLink() || !before.isFile()) fail(`${kind}_unsafe_type`, `${kind} must be a regular file`);
  if (!hasSingleLink(before)) fail(`${kind}_hardlink_unsafe`, `${kind} must have exactly one link`);
  validateOwner(before, uid, `${kind}_owner_mismatch`);
  if (modeOf(before) !== 0o600) fail(`${kind}_mode_unsafe`, `${kind} must use mode 0600`);
  if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) {
    fail(`${kind}_size_invalid`, `${kind} has an unsupported size`);
  }

  let fd;
  try {
    fd = openNoFollow(fsImpl, filePath);
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || !hasSingleLink(opened) || !sameIdentity(before, opened)) {
      fail(`${kind}_identity_changed`, `${kind} changed while opening`);
    }
    const raw = fsImpl.readFileSync(fd, "utf8");
    const after = fsImpl.fstatSync(fd);
    if (!hasSingleLink(after) || !sameIdentity(opened, after) || Buffer.byteLength(raw, "utf8") !== opened.size) {
      fail(`${kind}_identity_changed`, `${kind} changed while reading`);
    }
    const named = fsImpl.lstatSync(filePath);
    if (!hasSingleLink(named) || !sameIdentity(after, named)) fail(`${kind}_identity_changed`, `${kind} changed while reading`);
    return Object.freeze({ raw, identity: after });
  } catch (err) {
    if (err instanceof ResourceInstallError) throw err;
    fail(`${kind}_unreadable`, `${kind} cannot be read securely`);
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
  }
}

function parseJsonObject(raw, code, message) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(code, message);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message);
  return value;
}

function assertSafeConfigDirectory(fsImpl, uid) {
  const dir = path.dirname(CONFIG_PATH);
  let stat;
  try {
    stat = fsImpl.lstatSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") fail("config_missing", "QuadWork configuration is missing");
    fail("config_directory_unreadable", "QuadWork configuration directory cannot be inspected");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("config_directory_unsafe_type", "QuadWork configuration directory must be a real directory");
  }
  validateOwner(stat, uid, "config_directory_owner_mismatch");
  if (modeOf(stat) !== 0o700) fail("config_directory_mode_unsafe", "QuadWork configuration directory must use mode 0700");
  let canonical;
  try {
    canonical = fsImpl.realpathSync(dir);
  } catch {
    fail("config_directory_unreadable", "QuadWork configuration directory cannot be resolved");
  }
  if (canonical !== dir) fail("config_directory_aliased", "QuadWork configuration directory cannot contain path aliases");
  return stat;
}

function translateConfigDirectoryError(error) {
  if (!(error instanceof SecureResourceDirectoryError)) throw error;
  if (error.code === "entry_invalid") {
    fail("config_entry_invalid", "configuration entry name is invalid");
  }
  if (error.code === "rename_unavailable") {
    recoveryFailure(
      "config_exchange_unavailable",
      "atomic configuration exchange is unavailable",
      error.recoveryEntries,
    );
  }
  if (error.code === "rename_probe_failed") {
    recoveryFailure(
      "config_exchange_probe_failed",
      "atomic configuration exchange probe requires explicit recovery",
      error.recoveryEntries,
    );
  }
  if (error.code === "rename_failed") {
    fail("config_exchange_failed", "atomic configuration exchange failed");
  }
  fail("config_descriptor_anchor_unavailable", "configuration directory descriptor could not be opened securely");
}

function configHandleCall(callback) {
  try {
    return callback();
  } catch (error) {
    return translateConfigDirectoryError(error);
  }
}

function linuxConfigDirectoryHandleFactory({ directory, fsImpl, execFileSyncImpl, expectedUid: uid }) {
  let secureHandle;
  try {
    const directoryIdentity = fsImpl.lstatSync(directory);
    secureHandle = createLinuxSecureDirectoryHandle({
      directory,
      directoryIdentity,
      fsImpl,
      execFileSyncImpl,
      platform: "linux",
    });
    return {
      stat: () => configHandleCall(() => secureHandle.stat()),
      path: (name) => configHandleCall(() => secureHandle.path(validateEntryName(name))),
      assertExchangeAvailable: () => {
        const stem = `.resource-exchange-probe-${crypto.randomBytes(12).toString("hex")}`;
        const entries = Object.freeze([`${stem}-a`, `${stem}-b`]);
        configHandleCall(() => secureHandle.probeExchange(entries[0], entries[1]));
        return entries;
      },
      exchange: (from, to, sourceIdentity, destinationIdentity) => configHandleCall(
        () => secureHandle.commit({
          mode: "exchange",
          source: validateEntryName(from),
          destination: validateEntryName(to),
          sourceIdentity,
          destinationIdentity,
          expectedUid: uid,
        }),
      ),
      fsync: () => configHandleCall(() => secureHandle.fsync()),
      close: () => secureHandle.close(),
    };
  } catch (err) {
    if (secureHandle) {
      try { secureHandle.close(); } catch {}
    }
    if (err instanceof SecureResourceDirectoryError) {
      if (err.code === "rename_unavailable") {
        recoveryFailure("config_exchange_unavailable", "atomic configuration exchange is unavailable", err.recoveryEntries);
      }
      if (err.code === "rename_probe_failed") {
        recoveryFailure("config_exchange_probe_failed", "atomic configuration exchange probe requires explicit recovery", err.recoveryEntries);
      }
      if (err.code === "rename_failed") {
        fail("config_exchange_failed", "atomic configuration exchange failed");
      }
    }
    if (err instanceof ResourceInstallError) throw err;
    fail("config_descriptor_anchor_unavailable", "configuration directory descriptor could not be opened securely");
  }
}

function openConfigDirectoryHandle(directoryIdentity, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const factory = options.configDirectoryHandleFactory
    || ((options.platform || process.platform) === "linux" ? linuxConfigDirectoryHandleFactory : null);
  if (typeof factory !== "function") {
    fail("config_descriptor_anchor_unavailable", "secure configuration updates require a Linux directory descriptor");
  }
  let handle;
  try {
    handle = factory({
      directory: path.dirname(CONFIG_PATH),
      fsImpl,
      execFileSyncImpl: options.execFileSyncImpl || execFileSync,
      expectedUid: expectedUid(options),
    });
    const opened = handle.stat();
    if (!opened.isDirectory() || !sameOwnedNode(directoryIdentity, opened)) {
      fail("config_directory_changed", "QuadWork configuration directory changed before apply");
    }
    if (typeof handle.assertExchangeAvailable !== "function" || typeof handle.exchange !== "function") {
      fail("config_exchange_unavailable", "atomic configuration exchange is unavailable");
    }
    const probeEntries = normalizeRecoveryEntries(handle.assertExchangeAvailable());
    return Object.freeze({ handle, probeEntries });
  } catch (err) {
    if (handle) {
      try { handle.close(); } catch {}
    }
    if (err instanceof ResourceInstallError) throw err;
    fail("config_descriptor_anchor_unavailable", "configuration directory descriptor could not be verified");
  }
}

function assertNamedConfigDirectory(fsImpl, uid, expected) {
  const named = assertSafeConfigDirectory(fsImpl, uid);
  if (!sameOwnedNode(expected, named)) {
    fail("config_directory_changed", "QuadWork configuration directory changed during apply");
  }
}

function readPolicyFile(policyFile, options = {}) {
  if (typeof policyFile !== "string" || !path.isAbsolute(policyFile) || path.normalize(policyFile) !== policyFile) {
    fail("policy_file_not_absolute", "--policy-file must be a normalized absolute path");
  }
  const fsImpl = options.fsImpl || fs;
  const uid = expectedUid(options);
  try {
    if (fsImpl.realpathSync(policyFile) !== policyFile) {
      fail("policy_file_aliased", "policy file cannot contain path aliases");
    }
  } catch (err) {
    if (err instanceof ResourceInstallError) throw err;
    fail("policy_file_unreadable", "policy file cannot be resolved securely");
  }
  const { raw } = readSecureRegularFile(policyFile, {
    fsImpl,
    maxBytes: POLICY_FILE_MAX_BYTES,
    kind: "policy_file",
    uid,
  });
  const parsed = parseJsonObject(raw, "policy_file_json_invalid", "policy file must contain one JSON object");
  try {
    const policy = parseRuntimeResources(parsed);
    if (!policy) fail("policy_absent", "policy file must contain an explicit runtime_resources v1 policy");
    return policy;
  } catch (err) {
    if (err instanceof ResourceInstallError) throw err;
    fail("invalid_resource_policy", "policy file does not contain a valid runtime_resources v1 policy");
  }
}

function policyProposal(policyFile, options = {}) {
  const policy = readPolicyFile(policyFile, options);
  return Object.freeze({
    ok: true,
    status: "proposal",
    action: "configure_runtime_resources",
    acceptance: Object.freeze({ sha256: sha256(policy) }),
    policy,
    plan: Object.freeze({
      destination: "~/.quadwork/config.json#runtime_resources",
      preserves_other_config_fields: true,
      creates_missing_config: false,
      previous_config_recovery: "private_random_sibling",
      exchange_probe_recovery: "reported_private_siblings",
    }),
  });
}

function readConfigSecure(options = {}, directoryHandle = null) {
  const fsImpl = options.fsImpl || fs;
  const uid = expectedUid(options);
  if (!directoryHandle) assertSafeConfigDirectory(fsImpl, uid);
  const secure = readSecureRegularFile(
    directoryHandle ? directoryHandle.path("config.json") : CONFIG_PATH,
    {
    fsImpl,
    maxBytes: CONFIG_FILE_MAX_BYTES,
    kind: "config",
    uid,
    },
  );
  const config = parseJsonObject(secure.raw, "config_json_invalid", "QuadWork configuration JSON is invalid");
  return Object.freeze({ ...secure, config });
}

function writeConfigAtomic(previous, nextConfig, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const uid = expectedUid(options);
  const directoryIdentity = assertSafeConfigDirectory(fsImpl, uid);
  const data = JSON.stringify(nextConfig, null, 2);
  if (Buffer.byteLength(data, "utf8") > CONFIG_FILE_MAX_BYTES) {
    fail("config_size_invalid", "updated QuadWork configuration is too large");
  }
  const temporary = `.config.json.resource-install-${process.pid}-${crypto.randomBytes(12).toString("hex")}.recovery`;
  const constants = fsImpl.constants || fs.constants;
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    fail("config_descriptor_anchor_unavailable", "secure configuration updates require O_NOFOLLOW");
  }
  let directoryHandle;
  let fd;
  let candidateAttempted = false;
  let exchangeAttempted = false;
  let exchanged = false;
  let probeEntries = Object.freeze([]);
  try {
    const openedDirectory = openConfigDirectoryHandle(directoryIdentity, options);
    directoryHandle = openedDirectory.handle;
    probeEntries = openedDirectory.probeEntries;
    const temporaryPath = directoryHandle.path(temporary);
    candidateAttempted = true;
    fd = fsImpl.openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fsImpl.writeFileSync(fd, data, "utf8");
    fsImpl.fsyncSync(fd);
    const writtenStat = fsImpl.fstatSync(fd);
    if (!writtenStat.isFile() || !hasSingleLink(writtenStat) || modeOf(writtenStat) !== 0o600) {
      fail("config_atomic_write_unsafe", "secure temporary configuration could not be established");
    }
    validateOwner(writtenStat, uid, "config_atomic_write_owner_mismatch");
    fsImpl.closeSync(fd);
    fd = undefined;
    const tempStat = fsImpl.lstatSync(temporaryPath);
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || !sameNode(writtenStat, tempStat) || modeOf(tempStat) !== 0o600) {
      fail("config_atomic_write_unsafe", "secure temporary configuration could not be established");
    }
    validateOwner(tempStat, uid, "config_atomic_write_owner_mismatch");

    // Re-open and compare the exact old bytes immediately before commit. A
    // stale read-modify-write never replaces a concurrent config update.
    const current = readConfigSecure(options, directoryHandle);
    if (current.raw !== previous.raw || !sameIdentity(current.identity, previous.identity)) {
      fail("config_changed", "QuadWork configuration changed before apply");
    }
    assertNamedConfigDirectory(fsImpl, uid, directoryIdentity);
    exchangeAttempted = true;
    directoryHandle.exchange(temporary, "config.json", tempStat, current.identity);
    exchanged = true;
    const installed = fsImpl.lstatSync(directoryHandle.path("config.json"));
    if (!installed.isFile() || installed.isSymbolicLink() || !sameNode(tempStat, installed)) {
      fail("config_exchange_recovery_required", "configuration exchange requires explicit recovery");
    }
    const displaced = fsImpl.lstatSync(directoryHandle.path(temporary));
    if (!displaced.isFile() || displaced.isSymbolicLink() || !sameNode(current.identity, displaced)) {
      fail("config_exchange_recovery_required", "configuration exchange requires explicit recovery");
    }
    directoryHandle.fsync();
    const finalHandleDirectory = directoryHandle.stat();
    if (!finalHandleDirectory.isDirectory() || !sameOwnedNode(directoryIdentity, finalHandleDirectory)) {
      fail("config_directory_changed", "QuadWork configuration directory changed during apply");
    }
    assertNamedConfigDirectory(fsImpl, uid, directoryIdentity);
    const finalInstalled = fsImpl.lstatSync(directoryHandle.path("config.json"));
    const finalRecovery = fsImpl.lstatSync(directoryHandle.path(temporary));
    if (!finalInstalled.isFile()
      || finalInstalled.isSymbolicLink()
      || !sameNode(tempStat, finalInstalled)
      || !finalRecovery.isFile()
      || finalRecovery.isSymbolicLink()
      || !sameNode(current.identity, finalRecovery)) {
      fail("config_exchange_recovery_required", "configuration exchange requires explicit recovery");
    }
  } catch (err) {
    if (exchangeAttempted) {
      recoveryFailure(
        "config_exchange_recovery_required",
        "configuration exchange requires explicit recovery",
        [...probeEntries, temporary],
      );
    }
    if (candidateAttempted) {
      recoveryFailure(
        "config_write_failed_cleanup_required",
        "configuration candidate requires explicit recovery",
        [...probeEntries, temporary],
      );
    }
    if (probeEntries.length > 0) {
      recoveryFailure(
        "config_exchange_probe_cleanup_required",
        "configuration exchange probe requires explicit recovery",
        probeEntries,
      );
    }
    if (err instanceof ResourceInstallError) throw err;
    fail("config_write_failed", "QuadWork configuration could not be updated atomically");
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
    if (directoryHandle) {
      try { directoryHandle.close(); } catch {}
    }
  }
  if (!exchanged) fail("config_exchange_failed", "atomic configuration exchange did not complete");
  return Object.freeze({ recoveryEntry: temporary, probeEntries });
}

function applyPolicy({ policyFile, acceptanceSha256 }, options = {}) {
  if (!ACCEPTANCE_RE.test(acceptanceSha256 || "")) fail("acceptance_invalid", "an exact lowercase SHA-256 acceptance token is required");
  // Re-read and re-validate the source only after the apply invocation.
  const proposal = policyProposal(policyFile, options);
  if (proposal.acceptance.sha256 !== acceptanceSha256) fail("acceptance_mismatch", "policy acceptance token does not match the current policy file");
  const previous = readConfigSecure(options);
  const nextConfig = { ...previous.config, runtime_resources: proposal.policy };
  const written = writeConfigAtomic(previous, nextConfig, options);
  return Object.freeze({
    ok: true,
    status: "applied",
    action: proposal.action,
    acceptance: proposal.acceptance,
    policy: proposal.policy,
    plan: proposal.plan,
    result: Object.freeze({
      previous_config_recovery_entry: written.recoveryEntry,
      exchange_probe_recovery_entries: written.probeEntries,
    }),
  });
}

function minimumFreeBytes(policy) {
  const bytes = policy.temp_min_free_mib * 1024 * 1024;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail("temp_capacity_unsupported", "configured temp capacity is outside the supported range");
  return bytes;
}

function statfsState(fsImpl, target, options) {
  const statfs = options.statfs || ((value) => fsImpl.statfsSync(value, { bigint: true }));
  let facts;
  try {
    facts = statfs(target);
  } catch {
    fail("temp_statfs_failed", "resource temp filesystem cannot be inspected");
  }
  try {
    const type = BigInt(facts.type);
    const available = BigInt(facts.bavail) * BigInt(facts.bsize);
    return { type, available };
  } catch {
    fail("temp_statfs_invalid", "resource temp filesystem facts are invalid");
  }
}

function validateTempTarget(policy, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const uid = expectedUid(options);
  const root = policy.temp_root;
  const parent = path.dirname(root);
  const requiredBytes = minimumFreeBytes(policy);
  let parentStat;
  try {
    parentStat = fsImpl.lstatSync(parent);
  } catch {
    fail("temp_parent_missing", "resource temp parent directory must already exist");
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("temp_parent_unsafe", "resource temp parent must be a real directory");
  validateOwner(parentStat, uid, "temp_parent_owner_mismatch");
  if (modeOf(parentStat) !== 0o700) fail("temp_parent_mode_unsafe", "resource temp parent must use mode 0700");
  let canonicalParent;
  try {
    canonicalParent = fsImpl.realpathSync(parent);
  } catch {
    fail("temp_parent_unreadable", "resource temp parent cannot be resolved");
  }
  if (canonicalParent !== parent) fail("temp_parent_aliased", "resource temp parent cannot contain path aliases");

  let rootStat = null;
  try {
    rootStat = fsImpl.lstatSync(root);
  } catch (err) {
    if (!err || err.code !== "ENOENT") fail("temp_root_unreadable", "resource temp root cannot be inspected");
  }
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("temp_root_unsafe", "resource temp root must be a real directory");
    validateOwner(rootStat, uid, "temp_root_owner_mismatch");
    if (modeOf(rootStat) !== 0o700) fail("temp_root_mode_unsafe", "resource temp root must use mode 0700");
    let canonicalRoot;
    try { canonicalRoot = fsImpl.realpathSync(root); } catch { fail("temp_root_unreadable", "resource temp root cannot be resolved"); }
    if (canonicalRoot !== root) fail("temp_root_aliased", "resource temp root cannot contain path aliases");
  }
  const filesystem = statfsState(fsImpl, rootStat ? root : parent, options);
  if (filesystem.type === TMPFS_MAGIC || filesystem.type === RAMFS_MAGIC) {
    fail("temp_root_memory_backed", "resource temp root must be disk-backed");
  }
  if (filesystem.available < BigInt(requiredBytes)) fail("temp_root_low_capacity", "resource temp root does not have the accepted free capacity");
  return Object.freeze({
    root,
    parent,
    parentIdentity: parentStat,
    rootIdentity: rootStat,
    requiredBytes,
    currentState: rootStat ? "ready" : "create",
  });
}

function buildTempInstallProposal(options = {}) {
  const current = readConfigSecure(options);
  let policy;
  try {
    policy = parseRuntimeResources(current.config.runtime_resources);
  } catch {
    fail("invalid_resource_policy", "persisted runtime_resources policy is invalid");
  }
  if (!policy) fail("policy_absent", "an explicitly accepted runtime_resources policy is required");
  const target = validateTempTarget(policy, options);
  const plan = Object.freeze({
    action: "ensure_resource_temp_root",
    version: 1,
    temp_root: target.root,
    mode: "0700",
    minimum_free_bytes: target.requiredBytes,
    current_state: target.currentState,
    cleanup_paths: Object.freeze([]),
    failure_rollback: "none_preserve_created_root",
  });
  const proposal = Object.freeze({
    ok: true,
    status: "proposal",
    action: plan.action,
    acceptance: Object.freeze({ sha256: sha256(plan) }),
    plan,
  });
  return Object.freeze({ proposal, policy, target, configSnapshot: current });
}

function tempInstallProposal(options = {}) {
  return buildTempInstallProposal(options).proposal;
}

function tempRecoveryMetadata(fsImpl, target, ensureRoot, entryName, createdIdentity) {
  try {
    const namedParent = fsImpl.lstatSync(target.parent);
    if (!sameOwnedNode(namedParent, target.parentIdentity)) {
      return Object.freeze({
        entries: Object.freeze([]),
        scope: OPERATION_CREATED_ENTRY_UNLOCATED,
      });
    }
    const namedEntry = fsImpl.lstatSync(ensureRoot);
    if (!createdIdentity || !sameOwnedNode(namedEntry, createdIdentity)) {
      return Object.freeze({
        entries: Object.freeze([entryName]),
        scope: OPERATION_CREATED_ENTRY_UNLOCATED,
      });
    }
    return Object.freeze({ entries: Object.freeze([entryName]), scope: null });
  } catch {
    // Once mkdir has been attempted, ENOENT proves only that the accepted name
    // is currently absent. The operation-created inode may have been moved to
    // an unknowable sibling before a filesystem wrapper surfaced its error.
    return Object.freeze({
      entries: Object.freeze([]),
      scope: OPERATION_CREATED_ENTRY_UNLOCATED,
    });
  }
}

function applyTempInstall({ acceptanceSha256 }, options = {}) {
  if (!ACCEPTANCE_RE.test(acceptanceSha256 || "")) fail("acceptance_invalid", "an exact lowercase SHA-256 acceptance token is required");
  const built = buildTempInstallProposal(options);
  const { proposal, policy, target } = built;
  if (proposal.acceptance.sha256 !== acceptanceSha256) fail("acceptance_mismatch", "temp-root acceptance token does not match current policy and host state");
  const platform = options.platform || process.platform;
  if (platform !== "linux" && typeof options.rootHandleFactory !== "function") {
    fail("temp_platform_unsupported", "secure resource temp installation requires the Linux descriptor anchor");
  }
  const current = readConfigSecure(options);
  if (current.raw !== built.configSnapshot.raw || !sameIdentity(current.identity, built.configSnapshot.identity)) {
    fail("config_changed", "QuadWork configuration changed before temp-root apply");
  }
  let facts;
  let parentFd;
  let parentRoot = target.parent;
  const entryName = path.basename(proposal.plan.temp_root);
  let ensureRoot = proposal.plan.temp_root;
  let createdIdentity = null;
  let mkdirAttempted = false;
  let expectedRootIdentity = target.rootIdentity;
  let failure = null;
  try {
    if (platform === "linux") {
      const fsImpl = options.fsImpl || fs;
      const constants = fsImpl.constants || fs.constants;
      if (!Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
        fail("temp_descriptor_anchor_unavailable", "secure resource temp installation requires a Linux directory descriptor");
      }
      parentFd = fsImpl.openSync(
        target.parent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const anchoredParent = fsImpl.fstatSync(parentFd);
      if (!anchoredParent.isDirectory() || !sameOwnedNode(target.parentIdentity, anchoredParent)) {
        fail("temp_parent_identity_changed", "resource temp parent changed before apply");
      }
      parentRoot = `/proc/self/fd/${parentFd}`;
      let procParent;
      let canonicalProcParent;
      try {
        procParent = fsImpl.statSync(parentRoot);
        canonicalProcParent = fsImpl.realpathSync(parentRoot);
      } catch {
        fail("temp_descriptor_anchor_unavailable", "resource temp parent descriptor could not be verified");
      }
      if (!procParent.isDirectory()
        || !sameOwnedNode(anchoredParent, procParent)
        || canonicalProcParent !== target.parent) {
        fail("temp_descriptor_anchor_unavailable", "resource temp parent descriptor does not match the accepted parent");
      }
      ensureRoot = path.join(parentRoot, entryName);
    }
    if (target.currentState === "create") {
      const fsImpl = options.fsImpl || fs;
      try {
        fsImpl.lstatSync(ensureRoot);
        fail("temp_root_changed", "resource temp root appeared before apply");
      } catch (err) {
        if (err instanceof ResourceInstallError) throw err;
        if (!err || err.code !== "ENOENT") {
          fail("temp_root_create_unverified", "resource temp root absence could not be verified before create");
        }
      }
      // A filesystem wrapper can create the directory, move that inode to an
      // unknowable sibling, and then throw. From the instant mkdir is called,
      // no later pathname ENOENT can prove that the operation created nothing.
      mkdirAttempted = true;
      try {
        fsImpl.mkdirSync(ensureRoot, { recursive: false, mode: 0o700 });
      } catch (err) {
        // The native EEXIST result is the one trusted post-attempt outcome that
        // proves mkdir itself created nothing. Injectable filesystem wrappers
        // are not allowed to mint that proof.
        if (fsImpl === fs && err && err.code === "EEXIST") {
          mkdirAttempted = false;
          fail("temp_root_changed", "resource temp root appeared before apply");
        }
        throw err;
      }
      const created = fsImpl.lstatSync(ensureRoot);
      if (created.isSymbolicLink()
        || !created.isDirectory()
        || modeOf(created) !== 0o700
        || (expectedUid(options) !== null && created.uid !== expectedUid(options))) {
        fail("temp_root_create_unverified", "new resource temp root identity could not be verified");
      }
      createdIdentity = created;
      expectedRootIdentity = created;
    } else {
      const existing = (options.fsImpl || fs).lstatSync(ensureRoot);
      if (!sameOwnedNode(existing, expectedRootIdentity)
        || existing.isSymbolicLink()
        || !existing.isDirectory()) {
        fail("temp_root_identity_changed", "resource temp root changed before apply");
      }
    }
    facts = (options.ensureTempRoot || ensureTempRoot)({
      tempRoot: ensureRoot,
      minimumFreeBytes: proposal.plan.minimum_free_bytes,
      fsImpl: options.fsImpl,
      statfs: options.statfs,
      rootHandleFactory: options.rootHandleFactory,
      expectedUid: expectedUid(options),
    });
    if (!facts || facts.available !== true || facts.canonicalRoot !== policy.temp_root || facts.mode !== 0o700 || facts.diskBacked !== true) {
      fail("temp_install_unverified", "resource temp root installation could not be verified");
    }
    const installedRoot = (options.fsImpl || fs).lstatSync(ensureRoot);
    if (!sameOwnedNode(installedRoot, expectedRootIdentity)
      || installedRoot.isSymbolicLink()
      || !installedRoot.isDirectory()) {
      fail("temp_root_identity_changed", "resource temp root changed during apply");
    }
    let finalParent;
    try { finalParent = (options.fsImpl || fs).lstatSync(target.parent); } catch { fail("temp_parent_identity_changed", "resource temp parent changed during apply"); }
    if (!sameOwnedNode(target.parentIdentity, finalParent)) fail("temp_parent_identity_changed", "resource temp parent changed during apply");
    const finalRoot = (options.fsImpl || fs).lstatSync(target.root);
    if (!sameOwnedNode(finalRoot, expectedRootIdentity)
      || finalRoot.isSymbolicLink()
      || !finalRoot.isDirectory()) {
      fail("temp_root_identity_changed", "resource temp root changed during apply");
    }
    const finalConfig = readConfigSecure(options);
    if (finalConfig.raw !== built.configSnapshot.raw
      || !sameIdentity(finalConfig.identity, built.configSnapshot.identity)) {
      fail("config_changed", "QuadWork configuration changed during temp-root apply");
    }
  } catch (err) {
    failure = err instanceof ResourceInstallError
      ? err
      : new ResourceInstallError("temp_install_failed", "resource temp root could not be installed securely");
    if (mkdirAttempted || createdIdentity) {
      const recovery = tempRecoveryMetadata(
        options.fsImpl || fs,
        target,
        ensureRoot,
        entryName,
        createdIdentity,
      );
      failure = createRecoveryError(
        "temp_install_failed_cleanup_required",
        "resource temp installation may have created an entry and requires explicit recovery",
        recovery.entries,
        recovery.scope,
      );
    }
  } finally {
    if (parentFd !== undefined) {
      try { (options.fsImpl || fs).closeSync(parentFd); } catch {}
    }
  }
  if (failure) throw failure;
  return Object.freeze({
    ...proposal,
    status: "applied",
    result: Object.freeze({ ready: true, mode: "0700", disk_backed: true }),
  });
}

module.exports = {
  ResourceInstallError,
  resourceInstallFailureForError,
  recoveryEntriesForError,
  recoveryScopeForError,
  canonicalJson,
  sha256,
  policyProposal,
  applyPolicy,
  tempInstallProposal,
  applyTempInstall,
};
