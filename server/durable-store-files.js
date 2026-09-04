"use strict";

// #1063: the one durable-file primitive behind the V2 durable stores
// (WorkTask pipeline, Batch Request state, Delivery Candidate, Head-control
// audit, TaskReviewRound, Head-control WorkTask domain).  It owns exactly
// the three concerns those stores used to copy: a validated fs surface with
// owner-only directory checks, one atomic replace (temporary -> fsync ->
// rename -> directory fsync), and one process-scoped writer lock.
//
// It is deliberately not a filesystem API.  Every store still derives its
// own fixed paths, owns its schema, and raises its own typed error class and
// vocabulary; this module only fills the slot each store names for a given
// failure.  It never selects a path, a process, or a signal for a caller.

const crypto = require("node:crypto");
const path = require("node:path");

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const REQUIRED_FS = Object.freeze([
  "mkdirSync", "lstatSync", "fstatSync", "readFileSync", "writeFileSync", "renameSync",
  "chmodSync", "openSync", "closeSync", "fsyncSync", "unlinkSync",
]);
// Every failure this module can raise, keyed by the store's own code for it.
const CODE_SLOTS = Object.freeze([
  "options", "unreadable", "symlink_rejected", "insecure_permissions", "write_failed",
  "locked", "lock_unsafe", "lock_failed", "lock_acquire_changed", "lock_release_changed", "lock_release_failed",
]);

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function modeOf(stats) { return stats.mode & 0o777; }
function sameFile(left, right) {
  return !!left && !!right && Number.isSafeInteger(left.dev) && Number.isSafeInteger(left.ino) &&
    left.dev === right.dev && left.ino === right.ino;
}
function ownerUid() {
  try { return typeof process.getuid === "function" ? process.getuid() : null; }
  catch { return null; }
}
// The lock file body is this writer's proof of ownership. dev+ino alone cannot
// prove it: Linux reuses an inode number as soon as the old lock is unlinked
// and closed, so a replacement lock can carry the original's identity.
function lockToken() { return `${process.pid}.${crypto.randomBytes(16).toString("hex")}`; }

function createDurableStoreFiles(options) {
  if (!plain(options)) throw new TypeError("durable store files require an options object");
  const StoreError = options.error;
  const codes = options.codes;
  if (typeof StoreError !== "function") throw new TypeError("durable store files require the owning store's error class");
  if (!plain(codes) || CODE_SLOTS.some((slot) => typeof codes[slot] !== "string" || codes[slot].length === 0)) {
    throw new TypeError(`durable store files require codes for ${CODE_SLOTS.join(", ")}`);
  }
  const fail = (code, message) => { throw new StoreError(code, message); };
  const fs = options.fs;
  for (const name of REQUIRED_FS) {
    if (!fs || typeof fs[name] !== "function") fail(codes.options, `fs.${name} is required`);
  }
  const randomBytes = options.random_bytes === undefined ? crypto.randomBytes : options.random_bytes;
  if (typeof randomBytes !== "function") fail(codes.options, "random_bytes must be a function");

  function lstatOrNull(target) {
    try { return fs.lstatSync(target); }
    catch (error) {
      if (error && error.code === "ENOENT") return null;
      fail(codes.unreadable, "durable store path cannot be inspected");
    }
  }
  function assertRealDirectory(target, expectedMode) {
    const stats = lstatOrNull(target);
    if (stats === null) return null;
    if (stats.isSymbolicLink()) fail(codes.symlink_rejected, "durable store paths cannot be symbolic links");
    if (!stats.isDirectory()) fail(codes.unreadable, "durable store path is not a directory");
    if (expectedMode !== undefined && modeOf(stats) !== expectedMode) {
      fail(codes.insecure_permissions, "durable store directory must be mode 0700");
    }
    return stats;
  }
  // `chain` lists the store's own fixed directories from the config root down.
  // Only the root may be created recursively; every nested level is created
  // one at a time so a missing parent is never silently manufactured.
  function ensureDirectories(chain) {
    chain.forEach((entry, index) => {
      if (assertRealDirectory(entry.path, entry.mode) === null) {
        fs.mkdirSync(entry.path, { recursive: index === 0, mode: DIRECTORY_MODE });
        if (assertRealDirectory(entry.path, entry.mode) === null) fail(codes.unreadable, "durable store directory cannot be created");
      }
    });
  }
  function storageExists(chain) {
    return chain.every((entry) => assertRealDirectory(entry.path, entry.mode) !== null);
  }

  function temporaryPathFor(target) {
    const entropy = randomBytes(16);
    if (!Buffer.isBuffer(entropy) || entropy.length < 16) fail(codes.write_failed, "temporary path entropy is unavailable");
    return `${target}.${process.pid}.${entropy.subarray(0, 16).toString("hex")}.tmp`;
  }
  // Fsync the file, rename it over the target, then fsync the containing
  // directory so a completed rename is recoverable across a process or
  // machine restart.  Filesystems that do not expose a readable directory
  // descriptor fail closed rather than claiming a write.
  function writeFileAtomically(target, body) {
    if (typeof body !== "string") fail(codes.write_failed, "durable store body must be a string");
    let temporaryPath = null;
    let temporaryWritten = false;
    try {
      temporaryPath = temporaryPathFor(target);
      fs.writeFileSync(temporaryPath, body, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      temporaryWritten = true;
      fs.chmodSync(temporaryPath, FILE_MODE);
      const fileDescriptor = fs.openSync(temporaryPath, "r");
      try { fs.fsyncSync(fileDescriptor); } finally { fs.closeSync(fileDescriptor); }
      fs.renameSync(temporaryPath, target);
      temporaryWritten = false;
      const directoryDescriptor = fs.openSync(path.dirname(target), "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
      const finalStats = fs.lstatSync(target);
      if (finalStats.isSymbolicLink() || !finalStats.isFile() || modeOf(finalStats) !== FILE_MODE) {
        fail(codes.write_failed, "atomic replace did not produce an owner-only regular file");
      }
    } catch (error) {
      if (temporaryWritten) {
        try { fs.unlinkSync(temporaryPath); } catch { /* only the just-created temporary is eligible for cleanup */ }
      }
      if (error instanceof StoreError) throw error;
      fail(codes.write_failed, "atomic durable store write failed");
    }
  }

  function lockStat(lockPath) {
    const stats = lstatOrNull(lockPath);
    if (stats === null) return null;
    const uid = ownerUid();
    if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== FILE_MODE || (uid !== null && stats.uid !== uid)) {
      fail(codes.lock_unsafe, "durable store writer lock is unsafe");
    }
    return stats;
  }
  function acquireLock(lockPath) {
    const token = lockToken();
    let descriptor;
    let stats = null;
    try { descriptor = fs.openSync(lockPath, "wx", FILE_MODE); }
    catch (error) {
      if (error && error.code === "EEXIST") {
        lockStat(lockPath);
        fail(codes.locked, "durable store has an active or stale writer lock");
      }
      fail(codes.lock_failed, "durable store writer lock cannot be acquired");
    }
    try {
      fs.writeFileSync(descriptor, token, "utf8");
      fs.chmodSync(lockPath, FILE_MODE);
      fs.fsyncSync(descriptor);
      stats = fs.fstatSync(descriptor);
      if (!sameFile(stats, lockStat(lockPath))) fail(codes.lock_acquire_changed, "durable store writer lock changed during acquisition");
    } catch (error) {
      try { fs.closeSync(descriptor); } catch { /* fail closed */ }
      // This cleanup is only for the just-created, never-returned lock.  A
      // mismatched replacement is retained fail-closed for explicit recovery.
      try {
        if (sameFile(stats, lockStat(lockPath)) && fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
      } catch { /* a replacement remains in place */ }
      if (error instanceof StoreError) throw error;
      fail(codes.lock_failed, "durable store writer lock cannot be initialized");
    }
    return { descriptor, lockPath, stats, token };
  }
  function releaseLock(lock) {
    let closeError = null;
    try { fs.closeSync(lock.descriptor); } catch (error) { closeError = error; }
    try {
      if (!sameFile(lock.stats, lockStat(lock.lockPath)) || fs.readFileSync(lock.lockPath, "utf8") !== lock.token) {
        fail(codes.lock_release_changed, "durable store writer lock changed before release");
      }
      fs.unlinkSync(lock.lockPath);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      fail(codes.lock_release_failed, "durable store writer lock could not be released");
    }
    if (closeError) fail(codes.lock_release_failed, "durable store writer lock could not be closed");
  }
  // The action's own result or error always wins over a failed release: a
  // failed release leaves an owner-only lock behind, which every later
  // mutation fails closed on rather than guessing that it is stale.
  function withWriterLock(target, action) {
    const lock = acquireLock(`${target}.lock`);
    let result;
    let actionError;
    let actionFailed = false;
    try { result = action(); } catch (error) { actionError = error; actionFailed = true; }
    try { releaseLock(lock); } catch (releaseError) {
      if (actionFailed) throw actionError;
      throw releaseError;
    }
    if (actionFailed) throw actionError;
    return result;
  }

  return Object.freeze({ fs, lstatOrNull, assertRealDirectory, ensureDirectories, storageExists, writeFileAtomically, withWriterLock });
}

module.exports = {
  FILE_MODE,
  DIRECTORY_MODE,
  modeOf,
  sameFile,
  createDurableStoreFiles,
};
