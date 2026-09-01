"use strict";

// #1060 M3: durable, one-candidate persistence for an already validated
// Delivery Manifest and its deterministic composition proof.  This module is
// deliberately closed: it cannot compose, publish, run Git, call a route, or
// contact a remote service.  It only records the two pure contracts after the
// caller has produced them, with one bounded pending -> composed transition.

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");
const {
  DeliveryCandidateError,
  assertDeliveryCandidateRef,
  deliveryCandidateKey,
  assertDeliveryManifest,
} = require("./delivery-candidate");
const {
  DeliveryComposerError,
  assertDeliveryCompositionProof,
} = require("./delivery-composer");

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const LIFECYCLE = new Set(["pending_composition", "composed"]);

class DeliveryCandidateStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DeliveryCandidateStoreError";
    this.code = code;
  }
}

function fail(code, message) { throw new DeliveryCandidateStoreError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function clone(value) {
  return Array.isArray(value) ? value.map(clone) : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function stable(value) {
  return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
}
function same(left, right) { return stable(left) === stable(right); }
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function modeOf(stats) { return stats.mode & 0o777; }
function sameFile(left, right) {
  return left && right && Number.isSafeInteger(left.dev) && Number.isSafeInteger(left.ino) &&
    left.dev === right.dev && left.ino === right.ino;
}

function candidateRef(value, code) {
  try { return assertDeliveryCandidateRef(value, code); }
  catch (error) {
    if (error instanceof DeliveryCandidateError) fail(code, "delivery candidate reference is invalid");
    throw error;
  }
}
function manifest(value, code) {
  try { return assertDeliveryManifest(value); }
  catch (error) {
    if (error instanceof DeliveryCandidateError) fail(code, "delivery manifest is invalid");
    throw error;
  }
}
function proof(value, manifestValue, code) {
  try { return assertDeliveryCompositionProof(value, manifestValue); }
  catch (error) {
    if (error instanceof DeliveryComposerError || error instanceof DeliveryCandidateError) {
      fail(code, "composition proof is invalid or stale for this manifest");
    }
    throw error;
  }
}
function sameRef(left, right) {
  try { return deliveryCandidateKey(left) === deliveryCandidateKey(right); }
  catch { return false; }
}
function identifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail(code, "identifier is invalid");
  return value;
}
function expected(value, allowUninitialized, code) {
  exact(value, ["delivery_candidate_ref", "revision"], code);
  const ref = candidateRef(value.delivery_candidate_ref, code);
  if (value.revision === null && allowUninitialized) return { delivery_candidate_ref: clone(ref), revision: null };
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) fail(code, "expected revision is invalid");
  return { delivery_candidate_ref: clone(ref), revision: value.revision };
}
function operationDigest(manifestValue, proofValue) {
  return hash({
    version: SCHEMA_VERSION,
    delivery_manifest_digest: manifestValue.delivery_manifest_digest,
    composition_proof_digest: proofValue.composition_proof_digest,
  });
}

function assertFs(fs) {
  for (const name of ["mkdirSync", "lstatSync", "fstatSync", "readFileSync", "writeFileSync", "renameSync", "chmodSync", "openSync", "closeSync", "fsyncSync", "unlinkSync"]) {
    if (typeof fs[name] !== "function") fail("invalid_delivery_candidate_store_options", `fs.${name} is required`);
  }
  return fs;
}
function storageDirectory(configDir) {
  if (typeof configDir !== "string" || !path.isAbsolute(configDir) || configDir.length > 1024 || /[\u0000\r\n]/.test(configDir)) {
    fail("invalid_delivery_candidate_store_options", "config_dir must be a bounded absolute path");
  }
  return path.join(configDir, "delivery-candidates");
}
function candidateScopeDirectory(configDir, refValue) {
  const ref = candidateRef(refValue, "invalid_delivery_candidate_store_identity");
  return path.join(storageDirectory(configDir), `${ref.installation_id}--${ref.project_id}--${ref.repository_key}`);
}
function deliveryCandidateStorePath(configDir, refValue) {
  const ref = candidateRef(refValue, "invalid_delivery_candidate_store_identity");
  const filename = hash({ version: SCHEMA_VERSION, delivery_candidate_key: deliveryCandidateKey(ref) });
  return path.join(candidateScopeDirectory(configDir, ref), `${filename}.json`);
}
function lockPathFor(statePath) { return `${statePath}.lock`; }
function temporaryPathFor(statePath) { return `${statePath}.${crypto.randomBytes(12).toString("hex")}.tmp`; }
function lstatOrNull(fs, target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    fail("delivery_candidate_store_unreadable", "delivery candidate store cannot be inspected");
  }
}
function assertRealDirectory(fs, target, expectedMode) {
  const stats = lstatOrNull(fs, target);
  if (stats === null) return null;
  if (stats.isSymbolicLink()) fail("delivery_candidate_store_symlink_rejected", "delivery candidate store paths cannot be symbolic links");
  if (!stats.isDirectory()) fail("delivery_candidate_store_unreadable", "delivery candidate store path is not a directory");
  if (expectedMode !== undefined && modeOf(stats) !== expectedMode) {
    fail("delivery_candidate_store_insecure_permissions", "delivery candidate store directory must be mode 0700");
  }
  return stats;
}
function ensureDirectories(fs, configDir, directory, scopeDirectory) {
  if (assertRealDirectory(fs, configDir, DIRECTORY_MODE) === null) {
    fs.mkdirSync(configDir, { recursive: true, mode: DIRECTORY_MODE });
    if (assertRealDirectory(fs, configDir, DIRECTORY_MODE) === null) fail("delivery_candidate_store_unreadable", "config directory cannot be created");
  }
  if (assertRealDirectory(fs, directory, DIRECTORY_MODE) === null) {
    fs.mkdirSync(directory, { recursive: false, mode: DIRECTORY_MODE });
    if (assertRealDirectory(fs, directory, DIRECTORY_MODE) === null) fail("delivery_candidate_store_unreadable", "delivery candidate directory cannot be created");
  }
  if (assertRealDirectory(fs, scopeDirectory, DIRECTORY_MODE) === null) {
    fs.mkdirSync(scopeDirectory, { recursive: false, mode: DIRECTORY_MODE });
    if (assertRealDirectory(fs, scopeDirectory, DIRECTORY_MODE) === null) fail("delivery_candidate_store_unreadable", "candidate scope directory cannot be created");
  }
}
function storageExists(fs, configDir, directory, scopeDirectory) {
  if (assertRealDirectory(fs, configDir, DIRECTORY_MODE) === null) return false;
  if (assertRealDirectory(fs, directory, DIRECTORY_MODE) === null) return false;
  return assertRealDirectory(fs, scopeDirectory, DIRECTORY_MODE) !== null;
}

function normalizeAcceptedOperation(value, code) {
  exact(value, ["correlation_id", "idempotency_key", "expected_revision", "operation_digest"], code);
  if (!/^[a-f0-9]{64}$/.test(value.operation_digest)) fail(code, "operation digest is invalid");
  if (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) fail(code, "accepted revision is invalid");
  return {
    correlation_id: identifier(value.correlation_id, code),
    idempotency_key: identifier(value.idempotency_key, code),
    expected_revision: value.expected_revision,
    operation_digest: value.operation_digest,
  };
}
function assertStoredState(value, expectedRef = null) {
  const code = "invalid_delivery_candidate_store_state";
  exact(value, ["schema_version", "delivery_candidate_ref", "revision", "lifecycle", "delivery_manifest", "composition_proof"], code);
  if (value.schema_version !== SCHEMA_VERSION || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    fail(code, "delivery candidate store schema or revision is invalid");
  }
  const ref = candidateRef(value.delivery_candidate_ref, code);
  if (expectedRef !== null && !sameRef(ref, expectedRef)) {
    fail("delivery_candidate_store_identity_mismatch", "delivery candidate store belongs to a different candidate");
  }
  const storedManifest = manifest(value.delivery_manifest, code);
  if (!sameRef(storedManifest.delivery_candidate_ref, ref)) {
    fail(code, "delivery manifest is not bound to the stored candidate reference");
  }
  exact(value.lifecycle, ["status", "accepted_operation"], code);
  if (!LIFECYCLE.has(value.lifecycle.status)) fail(code, "delivery candidate lifecycle is invalid");
  if (value.lifecycle.status === "pending_composition") {
    if (value.revision !== 0 || value.lifecycle.accepted_operation !== null || value.composition_proof !== null) {
      fail(code, "pending delivery candidate state is inconsistent");
    }
  } else {
    if (value.revision !== 1 || value.lifecycle.accepted_operation === null || value.composition_proof === null) {
      fail(code, "composed delivery candidate state is inconsistent");
    }
    const accepted = normalizeAcceptedOperation(value.lifecycle.accepted_operation, code);
    const storedProof = proof(value.composition_proof, storedManifest, code);
    if (accepted.operation_digest !== operationDigest(storedManifest, storedProof)) {
      fail(code, "accepted operation is not bound to stored manifest and proof");
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    delivery_candidate_ref: clone(ref),
    revision: value.revision,
    lifecycle: {
      status: value.lifecycle.status,
      accepted_operation: value.lifecycle.accepted_operation === null ? null : normalizeAcceptedOperation(value.lifecycle.accepted_operation, code),
    },
    delivery_manifest: clone(storedManifest),
    composition_proof: value.composition_proof === null ? null : clone(value.composition_proof),
  };
}
function snapshot(state, expectedRef) { return freeze(clone(assertStoredState(state, expectedRef))); }

function readState(fs, statePath, expectedRef, allowMissing) {
  let raw;
  try {
    const before = fs.lstatSync(statePath);
    if (before.isSymbolicLink()) fail("delivery_candidate_store_symlink_rejected", "delivery candidate state cannot be a symbolic link");
    if (!before.isFile() || modeOf(before) !== FILE_MODE) {
      fail("delivery_candidate_store_insecure_permissions", "delivery candidate state must be a 0600 regular file");
    }
    const descriptor = fs.openSync(statePath, "r");
    try {
      const opened = fs.fstatSync(descriptor);
      const current = fs.lstatSync(statePath);
      if (current.isSymbolicLink()) fail("delivery_candidate_store_symlink_rejected", "delivery candidate state cannot be a symbolic link");
      if (!opened.isFile() || !current.isFile() || modeOf(opened) !== FILE_MODE || modeOf(current) !== FILE_MODE ||
          !sameFile(before, opened) || !sameFile(opened, current)) {
        fail("delivery_candidate_store_unreadable", "delivery candidate state changed while being opened");
      }
      raw = fs.readFileSync(descriptor, "utf8");
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error instanceof DeliveryCandidateStoreError) throw error;
    if (error && error.code === "ENOENT") {
      if (allowMissing) return null;
      fail("delivery_candidate_store_missing", "delivery candidate state is not initialized");
    }
    fail("delivery_candidate_store_unreadable", "delivery candidate state cannot be read");
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail("corrupt_delivery_candidate_store", "delivery candidate state is corrupt"); }
  if (!plain(parsed) || parsed.schema_version !== SCHEMA_VERSION) {
    if (plain(parsed) && Object.prototype.hasOwnProperty.call(parsed, "schema_version")) {
      fail("unknown_delivery_candidate_store_schema", "delivery candidate state schema is unsupported");
    }
    fail("corrupt_delivery_candidate_store", "delivery candidate state is corrupt");
  }
  try { return assertStoredState(parsed, expectedRef); }
  catch (error) {
    if (error instanceof DeliveryCandidateStoreError &&
        (error.code === "delivery_candidate_store_identity_mismatch" || error.code === "unknown_delivery_candidate_store_schema")) throw error;
    fail("corrupt_delivery_candidate_store", "delivery candidate state failed validation");
  }
}
function writeStateAtomically(fs, statePath, state) {
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
    const directoryDescriptor = fs.openSync(path.dirname(statePath), "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    if (temporaryWritten) {
      try { fs.unlinkSync(temporaryPath); } catch { /* temporary cleanup only */ }
    }
    if (error instanceof DeliveryCandidateStoreError) throw error;
    fail("delivery_candidate_store_write_failed", "delivery candidate state could not be written atomically");
  }
}
function lockStat(fs, lockPath) {
  const stats = lstatOrNull(fs, lockPath);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== FILE_MODE) {
    fail("delivery_candidate_store_lock_failed", "delivery candidate writer lock is unsafe");
  }
  return stats;
}
function acquireLock(fs, statePath) {
  const lockPath = lockPathFor(statePath);
  let descriptor;
  let stat = null;
  try { descriptor = fs.openSync(lockPath, "wx", FILE_MODE); }
  catch (error) {
    if (error && error.code === "EEXIST") {
      lockStat(fs, lockPath);
      fail("delivery_candidate_store_locked", "delivery candidate state has an active or stale writer lock");
    }
    fail("delivery_candidate_store_lock_failed", "delivery candidate lock cannot be acquired");
  }
  try {
    fs.chmodSync(lockPath, FILE_MODE);
    fs.fsyncSync(descriptor);
    stat = fs.fstatSync(descriptor);
    if (!sameFile(stat, lockStat(fs, lockPath))) fail("delivery_candidate_store_lock_failed", "delivery candidate lock changed during acquisition");
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* fail closed */ }
    try { if (sameFile(stat, lockStat(fs, lockPath))) fs.unlinkSync(lockPath); } catch { /* replacement remains fail closed */ }
    if (error instanceof DeliveryCandidateStoreError) throw error;
    fail("delivery_candidate_store_lock_failed", "delivery candidate lock cannot be initialized");
  }
  return { descriptor, lockPath, stat };
}
function releaseLock(fs, lock) {
  let closeError = null;
  try { fs.closeSync(lock.descriptor); } catch (error) { closeError = error; }
  try {
    if (!sameFile(lock.stat, lockStat(fs, lock.lockPath))) {
      fail("delivery_candidate_store_lock_release_failed", "delivery candidate lock changed before release");
    }
    fs.unlinkSync(lock.lockPath);
  } catch (error) {
    if (error instanceof DeliveryCandidateStoreError) throw error;
    fail("delivery_candidate_store_lock_release_failed", "delivery candidate lock could not be released");
  }
  if (closeError) fail("delivery_candidate_store_lock_release_failed", "delivery candidate lock could not be closed");
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

function assertInitialization(input) {
  const code = "invalid_delivery_candidate_store_initialization";
  exact(input, ["expected", "delivery_manifest"], code);
  const precondition = expected(input.expected, true, code);
  if (precondition.revision !== null) fail(code, "initial revision must be null");
  const deliveryManifest = manifest(input.delivery_manifest, code);
  if (!sameRef(precondition.delivery_candidate_ref, deliveryManifest.delivery_candidate_ref)) {
    fail(code, "initial manifest is not bound to expected delivery candidate");
  }
  return { precondition, delivery_manifest: clone(deliveryManifest) };
}
function assertComposedRecord(input) {
  const code = "invalid_delivery_candidate_store_record";
  exact(input, ["expected", "delivery_manifest", "composition_proof", "correlation_id", "idempotency_key"], code);
  const precondition = expected(input.expected, false, code);
  const deliveryManifest = manifest(input.delivery_manifest, code);
  if (!sameRef(precondition.delivery_candidate_ref, deliveryManifest.delivery_candidate_ref)) {
    fail(code, "record manifest is not bound to expected delivery candidate");
  }
  const compositionProof = proof(input.composition_proof, deliveryManifest, code);
  const acceptedOperation = {
    correlation_id: identifier(input.correlation_id, code),
    idempotency_key: identifier(input.idempotency_key, code),
    expected_revision: precondition.revision,
    operation_digest: operationDigest(deliveryManifest, compositionProof),
  };
  return {
    precondition,
    delivery_manifest: clone(deliveryManifest),
    composition_proof: clone(compositionProof),
    accepted_operation: acceptedOperation,
  };
}
function replayMatches(existing, incoming) {
  return existing.correlation_id === incoming.correlation_id &&
    existing.idempotency_key === incoming.idempotency_key &&
    existing.expected_revision === incoming.expected_revision &&
    existing.operation_digest === incoming.operation_digest;
}
function hasIdentifierCollision(existing, incoming) {
  return existing.correlation_id === incoming.correlation_id || existing.idempotency_key === incoming.idempotency_key;
}

function createDeliveryCandidateStore(options) {
  exact(options, ["config_dir", "fs"], "invalid_delivery_candidate_store_options");
  const fs = assertFs(options.fs || nodeFs);
  const directory = storageDirectory(options.config_dir);

  function paths(ref) {
    const normalized = candidateRef(ref, "invalid_delivery_candidate_store_identity");
    return {
      ref: clone(normalized),
      scope: candidateScopeDirectory(options.config_dir, normalized),
      state: deliveryCandidateStorePath(options.config_dir, normalized),
    };
  }
  function readSnapshot(ref) {
    const target = paths(ref);
    if (!storageExists(fs, options.config_dir, directory, target.scope)) {
      fail("delivery_candidate_store_missing", "delivery candidate state is not initialized");
    }
    return snapshot(readState(fs, target.state, target.ref, false), target.ref);
  }
  function initialize(input) {
    const initial = assertInitialization(input);
    const target = paths(initial.precondition.delivery_candidate_ref);
    ensureDirectories(fs, options.config_dir, directory, target.scope);
    return withWriterLock(fs, target.state, () => {
      const existing = readState(fs, target.state, target.ref, true);
      if (existing !== null) fail("delivery_candidate_store_already_initialized", "delivery candidate state already exists");
      const state = {
        schema_version: SCHEMA_VERSION,
        delivery_candidate_ref: clone(target.ref),
        revision: 0,
        lifecycle: { status: "pending_composition", accepted_operation: null },
        delivery_manifest: clone(initial.delivery_manifest),
        composition_proof: null,
      };
      assertStoredState(state, target.ref);
      writeStateAtomically(fs, target.state, state);
      return snapshot(state, target.ref);
    });
  }
  function recordComposed(input) {
    const incoming = assertComposedRecord(input);
    const target = paths(incoming.precondition.delivery_candidate_ref);
    if (!storageExists(fs, options.config_dir, directory, target.scope)) {
      fail("delivery_candidate_store_missing", "delivery candidate state is not initialized");
    }
    return withWriterLock(fs, target.state, () => {
      const current = readState(fs, target.state, target.ref, false);
      if (!same(current.delivery_manifest, incoming.delivery_manifest)) {
        fail("delivery_candidate_store_manifest_mismatch", "composition record does not match the initialized manifest");
      }
      if (current.lifecycle.status === "composed") {
        const accepted = current.lifecycle.accepted_operation;
        if (replayMatches(accepted, incoming.accepted_operation)) {
          if (!same(current.composition_proof, incoming.composition_proof)) {
            fail("delivery_candidate_store_idempotency_collision", "replayed composition proof differs from accepted operation");
          }
          return freeze({ snapshot: snapshot(current, target.ref), persisted: false });
        }
        if (hasIdentifierCollision(accepted, incoming.accepted_operation)) {
          fail("delivery_candidate_store_idempotency_collision", "correlation or idempotency key is already bound to another composition");
        }
        fail("delivery_candidate_store_already_composed", "delivery candidate already has a composition proof");
      }
      if (current.revision !== incoming.precondition.revision) {
        fail("stale_delivery_candidate_store_revision", "delivery candidate state changed before composition was recorded");
      }
      const next = {
        schema_version: SCHEMA_VERSION,
        delivery_candidate_ref: clone(current.delivery_candidate_ref),
        revision: 1,
        lifecycle: { status: "composed", accepted_operation: clone(incoming.accepted_operation) },
        delivery_manifest: clone(current.delivery_manifest),
        composition_proof: clone(incoming.composition_proof),
      };
      assertStoredState(next, target.ref);
      writeStateAtomically(fs, target.state, next);
      return freeze({ snapshot: snapshot(next, target.ref), persisted: true });
    });
  }

  return freeze({ readSnapshot, initialize, recordComposed });
}

module.exports = {
  SCHEMA_VERSION,
  FILE_MODE,
  DIRECTORY_MODE,
  DeliveryCandidateStoreError,
  assertDeliveryCandidateStoreState: assertStoredState,
  deliveryCandidateStorePath,
  createDeliveryCandidateStore,
};
