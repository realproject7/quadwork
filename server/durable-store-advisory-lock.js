"use strict";

// #1074: the kernel-backed half of the durable stores' writer lock.
//
// The lock the durable stores need is "no two writers inside their protected
// actions at once".  A lock file whose *existence* is the lock cannot supply
// that: existence is addressed by path, and a path can be re-pointed at a
// different file between the moment a writer judges it and the moment the
// writer acts on that judgement.  A whole-file advisory lock is addressed by
// the open file description instead, so the kernel — not this code — decides
// who is inside, and a stale lock is released by the owner's death rather
// than by anyone reasoning about the owner.
//
// `fs-native-extensions` is the one dependency: flock(LOCK_EX|LOCK_NB) on
// macOS, fcntl(F_OFD_SETLK) on Linux, LockFileEx on Windows.  All three bind
// the lock to the open file description, so a second `open()` of the same
// file is refused even inside the same process — the durable stores rely on
// that to keep a store action from re-entering its own lock.
//
// This module owns exactly three concerns so nothing else has to know the
// native surface: loading the addon, gating the platform, and normalising
// errno.  It never touches a path, never creates or removes a file, and
// never decides what a caller does with a verdict.
//
// Fail-closed is not negotiable here.  A missing addon, a platform without a
// prebuild, or a filesystem that answers EOPNOTSUPP/ENOLCK means the kernel
// cannot enforce exclusion; the only safe answer is "unavailable", never a
// path-based lock standing in for one.  The rest — EAGAIN, EWOULDBLOCK,
// EACCES — is the ordinary "someone else holds it" answer.  Anything else is
// a hard failure and is deliberately *not* swallowed as contention: reading
// an unknown native error as "busy" would let a caller retry forever, and
// reading it as "free" would be the very defect this module exists to close.

const NATIVE_MODULE = "fs-native-extensions";
// A prebuild exists for every platform below; Alpine/musl is out of scope
// because the Linux prebuild is glibc-linked, and it surfaces here as a load
// failure rather than as a silent downgrade.
const SUPPORTED_PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);
const CONTENTION_CODES = Object.freeze(["EAGAIN", "EWOULDBLOCK", "EACCES"]);
const UNAVAILABLE_CODES = Object.freeze(["EOPNOTSUPP", "ENOTSUP", "ENOLCK", "ENOSYS"]);

class AdvisoryLockError extends Error {
  // `reason` is either "unavailable" (the kernel cannot enforce exclusion
  // here) or "failed" (it could, and something else went wrong).  Contention
  // is never an error: it is the boolean `false` verdict of tryLock.
  constructor(reason, message, cause) {
    super(message);
    this.name = "AdvisoryLockError";
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

// The one place an errno becomes a verdict.  "contention" and "unavailable"
// are closed sets; everything else — including an error with no code at all —
// is "failed", so an unrecognised native error can never be mistaken for a
// busy lock.
function classifyAdvisoryLockError(error) {
  const code = error && error.code;
  if (typeof code === "string") {
    if (CONTENTION_CODES.includes(code)) return "contention";
    if (UNAVAILABLE_CODES.includes(code)) return "unavailable";
  }
  return "failed";
}

function supportedPlatform(platform) {
  return SUPPORTED_PLATFORMS.includes(platform);
}

// Loading is a judgement, not an exception: a caller gets `{ native }` or
// `{ unavailable }` with the reason spelled out, and never a half-loaded
// module.  `load` is injectable so a test can drive the failure paths
// without breaking its own require cache.
function loadAdvisoryLockNative(options = {}) {
  const platform = options.platform === undefined ? process.platform : options.platform;
  if (!supportedPlatform(platform)) {
    return { native: null, unavailable: `${NATIVE_MODULE} has no prebuild for platform ${platform}` };
  }
  const load = typeof options.load === "function" ? options.load : (name) => require(name);
  let native;
  try { native = load(NATIVE_MODULE); }
  catch (error) {
    return { native: null, unavailable: `${NATIVE_MODULE} could not be loaded: ${(error && error.message) || error}` };
  }
  if (!native || typeof native.tryLock !== "function" || typeof native.unlock !== "function") {
    return { native: null, unavailable: `${NATIVE_MODULE} does not expose tryLock and unlock` };
  }
  return { native, unavailable: null };
}

// An adapter that refuses everything, carrying the reason it cannot work.
// It is returned instead of `null` so a caller that forgets to check
// `available` still fails closed at the first lock attempt rather than
// running unprotected.
function unavailableAdapter(reason) {
  const refuse = () => { throw new AdvisoryLockError("unavailable", reason); };
  return Object.freeze({ available: false, unavailable: reason, tryLock: refuse, unlock: refuse });
}

// `tryLock(fd)` -> true (this open file description now holds the exclusive
// whole-file lock) or false (someone else does).  `unlock(fd)` releases it.
// Neither ever touches a path.
function createAdvisoryLockAdapter(options = {}) {
  const loaded = options.native === undefined
    ? loadAdvisoryLockNative(options)
    : { native: options.native, unavailable: options.native ? null : `${NATIVE_MODULE} is unavailable` };
  if (loaded.unavailable !== null) return unavailableAdapter(loaded.unavailable);
  const native = loaded.native;
  return Object.freeze({
    available: true,
    unavailable: null,
    tryLock(fileDescriptor) {
      let acquired;
      try { acquired = native.tryLock(fileDescriptor); }
      catch (error) {
        const verdict = classifyAdvisoryLockError(error);
        if (verdict === "contention") return false;
        throw new AdvisoryLockError(verdict, `${NATIVE_MODULE}.tryLock failed: ${(error && error.message) || error}`, error);
      }
      // A non-boolean verdict means the addon is not the one this module was
      // written against.  Guessing which way to read it is exactly the kind
      // of silent downgrade this module exists to prevent.
      if (typeof acquired !== "boolean") {
        throw new AdvisoryLockError("failed", `${NATIVE_MODULE}.tryLock returned a non-boolean verdict`);
      }
      return acquired;
    },
    unlock(fileDescriptor) {
      try { native.unlock(fileDescriptor); }
      catch (error) {
        throw new AdvisoryLockError(classifyAdvisoryLockError(error), `${NATIVE_MODULE}.unlock failed: ${(error && error.message) || error}`, error);
      }
    },
  });
}

// The process-wide adapter every durable store shares.  It is built once and
// memoised: the addon load is the expensive part, and its verdict cannot
// change while the process lives.
let shared = null;
function advisoryLockAdapter() {
  if (shared === null) shared = createAdvisoryLockAdapter();
  return shared;
}

module.exports = {
  NATIVE_MODULE,
  SUPPORTED_PLATFORMS,
  CONTENTION_CODES,
  UNAVAILABLE_CODES,
  AdvisoryLockError,
  classifyAdvisoryLockError,
  supportedPlatform,
  loadAdvisoryLockNative,
  createAdvisoryLockAdapter,
  advisoryLockAdapter,
};
