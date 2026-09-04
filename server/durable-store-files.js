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
//
// #1064: the lock body is an owner record (pid, per-acquisition token, host,
// creation instant).  A lock whose recorded owner is proven dead on this
// host is reclaimed after re-checking that the very same file (dev+ino) with
// the very same record is still at the path; a live, foreign, unverifiable,
// or unidentifiable owner always fails closed with the store's `locked`
// code.  Retries are bounded and never wait.

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const LOCK_RECORD_VERSION = 1;
const LOCK_RECORD_FIELDS = Object.freeze(["created_at", "host", "pid", "token", "version"]);
const MAX_LOCK_RECORD_BYTES = 512;
const MAX_LOCK_ATTEMPTS = 3;
const TOKEN_RE = /^[a-f0-9]{32}$/;
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
// and closed, so a replacement lock can carry the original's identity.  The
// token is never derived from injected entropy; it must be unforgeable.
function lockRecord() {
  return JSON.stringify({
    version: LOCK_RECORD_VERSION,
    pid: process.pid,
    token: crypto.randomBytes(16).toString("hex"),
    host: os.hostname(),
    created_at: Date.now(),
  });
}
function parseLockRecord(raw) {
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_LOCK_RECORD_BYTES) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!plain(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== LOCK_RECORD_FIELDS.length || keys.some((key, index) => key !== LOCK_RECORD_FIELDS[index])) return null;
  if (value.version !== LOCK_RECORD_VERSION || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.token !== "string" || !TOKEN_RE.test(value.token) ||
      typeof value.host !== "string" || value.host.length === 0 || value.host.length > 255 ||
      !Number.isSafeInteger(value.created_at) || value.created_at < 0) {
    return null;
  }
  return { version: LOCK_RECORD_VERSION, pid: value.pid, token: value.token, host: value.host, created_at: value.created_at };
}
// A signal-0 probe answers "alive" both when it succeeds and when it is
// refused: EPERM means the process exists but belongs to someone else.  Only
// ESRCH proves the pid is gone; anything else cannot be verified.
function classifyLivenessProbe(error) {
  const code = error && error.code;
  if (code === "ESRCH") return "dead";
  if (code === "EPERM") return "alive";
  return "unverifiable";
}
function ownerLiveness(pid) {
  try { process.kill(pid, 0); }
  catch (error) { return classifyLivenessProbe(error); }
  return "alive";
}

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
  // #1070: this is the only judgement of a durable store directory, and a
  // directory the caller did not create must pass it exactly like one it did.
  // A foreign owner is as disqualifying as a wrong mode: mode 0700 says
  // nothing about *whose* 0700 it is.
  function assertRealDirectory(target, expectedMode) {
    const stats = lstatOrNull(target);
    if (stats === null) return null;
    if (stats.isSymbolicLink()) fail(codes.symlink_rejected, "durable store paths cannot be symbolic links");
    if (!stats.isDirectory()) fail(codes.unreadable, "durable store path is not a directory");
    if (expectedMode !== undefined && modeOf(stats) !== expectedMode) {
      fail(codes.insecure_permissions, "durable store directory must be mode 0700");
    }
    const uid = ownerUid();
    if (uid !== null && stats.uid !== uid) fail(codes.insecure_permissions, "durable store directory belongs to another user");
    return stats;
  }
  // `chain` lists the store's own fixed directories from the config root down.
  // Only the root may be created recursively; every nested level is created
  // one at a time so a missing parent is never silently manufactured.
  //
  // #1070: two independent first writers can both find a level missing.  The
  // loser's non-recursive `mkdirSync` then raises EEXIST, which says only
  // that *something* now occupies the path.  It is therefore not swallowed:
  // it falls through to the same revalidation every freshly created level
  // passes, which admits only the exact owner-only directory and otherwise
  // fails closed with the owning store's own code.  There is no retry, and
  // every other errno still escapes untouched.
  function ensureDirectories(chain) {
    chain.forEach((entry, index) => {
      if (assertRealDirectory(entry.path, entry.mode) === null) {
        try { fs.mkdirSync(entry.path, { recursive: index === 0, mode: DIRECTORY_MODE }); }
        catch (error) { if (!error || error.code !== "EEXIST") throw error; }
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
  // Read the record of a lock someone else holds, through a descriptor that
  // is proven (dev+ino) to be the file lstat saw.  `null` means the lock is
  // gone; a `record` of null means the body cannot identify an owner.
  function readHeldLock(lockPath) {
    const stats = lockStat(lockPath);
    if (stats === null) return null;
    let descriptor;
    try { descriptor = fs.openSync(lockPath, "r"); }
    catch (error) {
      if (error && error.code === "ENOENT") return null;
      fail(codes.unreadable, "durable store writer lock cannot be opened");
    }
    let raw = null;
    try {
      const opened = fs.fstatSync(descriptor);
      if (sameFile(stats, opened) && opened.isFile() && modeOf(opened) === FILE_MODE && opened.size <= MAX_LOCK_RECORD_BYTES) {
        raw = fs.readFileSync(descriptor, "utf8");
      }
    } catch (error) {
      if (error instanceof StoreError) throw error;
      fail(codes.unreadable, "durable store writer lock cannot be read");
    } finally {
      try { fs.closeSync(descriptor); } catch { /* the descriptor is only for this read */ }
    }
    return { stats, raw, record: raw === null ? null : parseLockRecord(raw) };
  }
  // Reclaim a lock only after its recorded owner is proven dead on this host,
  // and only if the exact judged file (dev+ino) still carries the exact judged
  // record at the path.  Returns true when the caller may try the path again
  // and false when the lock must stay: a live, foreign, unverifiable, or
  // unidentifiable owner, or any replacement that appeared meanwhile.
  function reclaimDeadOwnerLock(lockPath) {
    const held = readHeldLock(lockPath);
    if (held === null) return true;
    if (held.record === null || held.record.host !== os.hostname() || ownerLiveness(held.record.pid) !== "dead") return false;
    const current = lockStat(lockPath);
    if (current === null) return true;
    if (!sameFile(held.stats, current)) return false;
    let raw;
    try { raw = fs.readFileSync(lockPath, "utf8"); }
    catch (error) {
      if (error && error.code === "ENOENT") return true;
      fail(codes.unreadable, "durable store writer lock cannot be re-read");
    }
    if (raw !== held.raw) return false;
    try { fs.unlinkSync(lockPath); }
    catch (error) {
      if (error && error.code === "ENOENT") return true;
      fail(codes.lock_failed, "dead owner's writer lock could not be reclaimed");
    }
    return true;
  }
  function acquireLock(lockPath) {
    for (let attempt = 1; ; attempt += 1) {
      let descriptor;
      try { descriptor = fs.openSync(lockPath, "wx", FILE_MODE); }
      catch (error) {
        if (!error || error.code !== "EEXIST") fail(codes.lock_failed, "durable store writer lock cannot be acquired");
        if (attempt >= MAX_LOCK_ATTEMPTS || !reclaimDeadOwnerLock(lockPath)) {
          fail(codes.locked, "durable store writer lock is held by a live or unverifiable owner");
        }
        continue;
      }
      return initializeLock(lockPath, descriptor);
    }
  }
  function initializeLock(lockPath, descriptor) {
    const record = lockRecord();
    let stats = null;
    try {
      fs.writeFileSync(descriptor, record, "utf8");
      fs.chmodSync(lockPath, FILE_MODE);
      fs.fsyncSync(descriptor);
      stats = fs.fstatSync(descriptor);
      if (!sameFile(stats, lockStat(lockPath))) fail(codes.lock_acquire_changed, "durable store writer lock changed during acquisition");
    } catch (error) {
      try { fs.closeSync(descriptor); } catch { /* fail closed */ }
      // This cleanup is only for the just-created, never-returned lock.  A
      // mismatched replacement is retained fail-closed for explicit recovery.
      try {
        if (sameFile(stats, lockStat(lockPath)) && fs.readFileSync(lockPath, "utf8") === record) fs.unlinkSync(lockPath);
      } catch { /* a replacement remains in place */ }
      if (error instanceof StoreError) throw error;
      fail(codes.lock_failed, "durable store writer lock cannot be initialized");
    }
    return { descriptor, lockPath, stats, record };
  }
  function releaseLock(lock) {
    let closeError = null;
    try { fs.closeSync(lock.descriptor); } catch (error) { closeError = error; }
    try {
      if (!sameFile(lock.stats, lockStat(lock.lockPath)) || fs.readFileSync(lock.lockPath, "utf8") !== lock.record) {
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
  MAX_LOCK_ATTEMPTS,
  modeOf,
  sameFile,
  parseLockRecord,
  classifyLivenessProbe,
  createDurableStoreFiles,
};
