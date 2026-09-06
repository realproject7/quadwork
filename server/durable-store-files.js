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
// #1074: the writer lock is a whole-file advisory lock held on an open file
// descriptor, not the existence of a file at a path.  The `.lock` file is a
// permanent, empty, owner-only artifact: it is created once and then kept
// forever, because the lock lives in the kernel and the file is only the
// object the kernel keys it to.  Nothing in this module ever unlinks,
// renames, or truncates a lock path, and there is no owner record, no
// liveness probe, and no reaper — a dead writer's lock is released by the
// kernel when its descriptors close, so there is nothing left to reclaim.
//
// Path-addressed reasoning is what made the old lock unsafe: a writer could
// verify the identity of the file at a path and then act on that judgement
// *by path*, and a legitimate replacement in that window was deleted by the
// verifier.  Here the acquisition is the kernel call itself; identity is only
// re-checked afterwards, and a mismatch is answered by dropping the lock and
// retrying — bounded, never by removing anything.
//
// Consequence for operators: the `.lock` file existing means nothing, and
// deleting one while a writer holds it silently breaks mutual exclusion,
// because the next writer then creates a *different* file and locks that.
// docs/troubleshooting.md states this next to the opposite rule for the
// transient `config.lock`.

const crypto = require("node:crypto");
const nodeFsConstants = require("node:fs").constants;
const path = require("node:path");
const { AdvisoryLockError, advisoryLockAdapter } = require("./durable-store-advisory-lock");

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
// Only an identity mismatch (the file under the path changed while we were
// taking the kernel lock on it) is retried, and only this many times.  There
// is no waiting anywhere: contention is reported, never slept on.
const MAX_LOCK_ATTEMPTS = 3;
// O_NOFOLLOW is what keeps the lock from ever being taken through a symlink.
// It is not optional: a platform that cannot express it is reported as an
// unsafe lock rather than silently opening without it.
const LOCK_OPEN_FLAGS = typeof nodeFsConstants.O_NOFOLLOW === "number"
  ? (nodeFsConstants.O_CREAT | nodeFsConstants.O_RDWR | nodeFsConstants.O_NOFOLLOW)
  : null;
// O_NOFOLLOW answers a symlink with ELOOP on Linux/macOS; some BSD kernels
// answer EMLINK.  Both mean "the lock path is a symlink", never "busy".
const SYMLINK_OPEN_CODES = Object.freeze(["ELOOP", "EMLINK"]);
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
  // The kernel half of the writer lock.  Production stores never pass this;
  // they share the process-wide adapter.  It is injectable only so a test can
  // substitute a *deliberately wrong* primitive and prove that the exclusion
  // this module reports actually comes from the kernel call.
  const advisory = options.advisory_lock === undefined ? advisoryLockAdapter() : options.advisory_lock;
  if (!advisory || typeof advisory.tryLock !== "function" || typeof advisory.unlock !== "function") {
    fail(codes.options, "advisory_lock must expose tryLock and unlock");
  }

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

  // The kernel's verdict is the whole acquisition; everything below only
  // decides whether the file it was taken on is one this store may use.
  //
  // `mismatch` is not a failure: it means the file at the path changed
  // identity between our open and our check, so this descriptor's lock
  // protects the wrong object.  The answer is to drop it and open the path
  // again — never to remove whatever is there now.
  function openLockDescriptor(lockPath) {
    if (LOCK_OPEN_FLAGS === null) {
      fail(codes.lock_unsafe, "durable store writer lock requires O_NOFOLLOW, which this platform does not provide");
    }
    try { return fs.openSync(lockPath, LOCK_OPEN_FLAGS, FILE_MODE); }
    catch (error) {
      if (error && SYMLINK_OPEN_CODES.includes(error.code)) {
        fail(codes.lock_unsafe, "durable store writer lock path is a symbolic link");
      }
      fail(codes.lock_failed, "durable store writer lock cannot be opened");
    }
  }
  // Raise the store's own code for whatever the kernel half reported.  An
  // unavailable primitive is a hard failure, never contention: a store that
  // cannot be protected must refuse to write, not write unprotected.
  function failAdvisory(error, releasing) {
    if (error instanceof AdvisoryLockError) {
      fail(releasing ? codes.lock_release_failed : codes.lock_failed,
        error.reason === "unavailable"
          ? "durable store writer lock cannot be enforced on this platform or filesystem"
          : "durable store writer lock primitive failed");
    }
    throw error;
  }
  // Checked only *after* the lock is held, because before that the answer is
  // worthless: anyone may replace the file between the check and the open.
  // fstat describes the object we locked; lstat describes what the path names
  // now.  Only their disagreement is retryable; an object that is not an
  // owner-only regular file is unsafe outright.
  function verifyLockedDescriptor(lockPath, descriptor) {
    const uid = ownerUid();
    let opened;
    try { opened = fs.fstatSync(descriptor); }
    catch { fail(codes.lock_failed, "durable store writer lock cannot be inspected"); }
    if (!opened.isFile() || modeOf(opened) !== FILE_MODE || (uid !== null && opened.uid !== uid)) {
      fail(codes.lock_unsafe, "durable store writer lock is unsafe");
    }
    // Only identity is asked of the path.  Re-asking it for mode or owner
    // would be asking about the inode `sameFile` has just proven is the one
    // fstat already answered for, and a check that cannot fire on its own is
    // not a check.  A symlink or a different object at the path is a
    // mismatch, and the retry's own O_NOFOLLOW open is what refuses it.
    const current = lstatOrNull(lockPath);
    if (current === null || !sameFile(opened, current)) return "mismatch";
    return "ok";
  }
  function dropLock(descriptor) {
    try { advisory.unlock(descriptor); } catch { /* the close below releases it regardless */ }
    try { fs.closeSync(descriptor); } catch { /* the descriptor is being abandoned */ }
  }
  function acquireLock(lockPath) {
    for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
      const descriptor = openLockDescriptor(lockPath);
      let acquired;
      try { acquired = advisory.tryLock(descriptor); }
      catch (error) {
        try { fs.closeSync(descriptor); } catch { /* fail closed */ }
        failAdvisory(error, false);
      }
      if (!acquired) {
        try { fs.closeSync(descriptor); } catch { /* fail closed */ }
        fail(codes.locked, "durable store writer lock is held by another writer");
      }
      let verdict;
      try { verdict = verifyLockedDescriptor(lockPath, descriptor); }
      catch (error) { dropLock(descriptor); throw error; }
      if (verdict === "ok") return { descriptor, lockPath, stats: fs.fstatSync(descriptor) };
      dropLock(descriptor);
    }
    fail(codes.lock_acquire_changed, "durable store writer lock changed during acquisition");
  }
  // Release always closes the descriptor, whatever else goes wrong: an open
  // descriptor is the lock, so leaking one would wedge the store far worse
  // than reporting a failed release does.
  //
  // The identity re-check is a detector, not a guarantee.  If the lock file
  // was replaced while we held it, our exclusion protected an object nobody
  // else was contending on, and the caller is told so rather than left to
  // assume the window was safe.
  function releaseLock(lock) {
    let changed = false;
    try { changed = !sameFile(lock.stats, lstatOrNull(lock.lockPath)); }
    catch { changed = true; }
    let unlockError = null;
    try { advisory.unlock(lock.descriptor); } catch (error) { unlockError = error; }
    let closeError = null;
    try { fs.closeSync(lock.descriptor); } catch (error) { closeError = error; }
    if (unlockError !== null) failAdvisory(unlockError, true);
    if (closeError !== null) fail(codes.lock_release_failed, "durable store writer lock could not be closed");
    if (changed) fail(codes.lock_release_changed, "durable store writer lock changed before release");
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
  LOCK_OPEN_FLAGS,
  modeOf,
  sameFile,
  createDurableStoreFiles,
};
