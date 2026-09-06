"use strict";

// #1074: the kernel half of the durable-store writer lock, on its own.
//
// Two things are pinned here.  First, that the real primitive actually
// excludes — taken twice, on two descriptors for the same file, the second
// attempt is refused, and it is refused *inside one process*, which is what
// keeps a store action from re-entering its own lock.  Second, that errno
// normalisation is closed on both sides: exactly the contention codes are
// read as "someone else has it", exactly the unavailability codes are read as
// "the kernel cannot enforce this here", and everything else is a hard
// failure rather than a lock quietly reported as free or as busy.
//
// The native errors below are constructed, not provoked: EOPNOTSUPP needs a
// filesystem this machine may not have, and a made-up errno is the only way
// to prove the unknown-error path is not swallowed.  Nothing that decides
// exclusion is faked — every exclusion assertion drives the real addon.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
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
} = require("./durable-store-advisory-lock");

function errno(code) {
  const error = new Error(code === undefined ? "no code" : code);
  if (code !== undefined) error.code = code;
  return error;
}
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-advisory-lock-"));
  fs.chmodSync(directory, 0o700);
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

// The classification is a closed set on both sides.  "failed" is the default
// precisely so an errno nobody anticipated can never be mistaken for either
// a busy lock or an unsupported filesystem.
{
  for (const code of CONTENTION_CODES) assert.equal(classifyAdvisoryLockError(errno(code)), "contention", code);
  for (const code of UNAVAILABLE_CODES) assert.equal(classifyAdvisoryLockError(errno(code)), "unavailable", code);
  assert.deepEqual([...CONTENTION_CODES].sort(), ["EACCES", "EAGAIN", "EWOULDBLOCK"]);
  assert.deepEqual([...UNAVAILABLE_CODES].sort(), ["ENOLCK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
  for (const code of ["EIO", "EBADF", "EPERM", "ENOENT", "EINTR", "ESRCH", "eagain", ""]) {
    assert.equal(classifyAdvisoryLockError(errno(code)), "failed", code);
  }
  assert.equal(classifyAdvisoryLockError(errno(undefined)), "failed");
  assert.equal(classifyAdvisoryLockError(null), "failed");
  assert.equal(classifyAdvisoryLockError(undefined), "failed");
  assert.equal(classifyAdvisoryLockError({ code: 11 }), "failed", "a numeric errno is not a code");
}

// Platform gating is the load's first question, so a platform with no
// prebuild never reaches a require that would fail with a stack trace.
{
  assert.deepEqual([...SUPPORTED_PLATFORMS].sort(), ["darwin", "linux", "win32"]);
  assert.equal(supportedPlatform(process.platform), true, `this platform (${process.platform}) is supported`);
  for (const platform of ["aix", "freebsd", "openbsd", "sunos", "android", ""]) {
    assert.equal(supportedPlatform(platform), false, platform);
  }
  const gated = loadAdvisoryLockNative({ platform: "sunos", load: () => assert.fail("an unsupported platform must not reach the require") });
  assert.equal(gated.native, null);
  assert.match(gated.unavailable, /sunos/);
}

// Every way the addon can fail to be usable is one verdict — "unavailable" —
// and never an exception escaping to a caller that would then run unlocked.
{
  const missing = loadAdvisoryLockNative({ load: () => { throw errno("MODULE_NOT_FOUND"); } });
  assert.equal(missing.native, null);
  assert.match(missing.unavailable, new RegExp(NATIVE_MODULE));
  for (const shape of [null, undefined, {}, { tryLock: () => true }, { unlock: () => {} }, { tryLock: 1, unlock: 2 }]) {
    const loaded = loadAdvisoryLockNative({ load: () => shape });
    assert.equal(loaded.native, null, JSON.stringify(shape));
    assert.match(loaded.unavailable, /tryLock and unlock|could not be loaded/);
  }
}

// An unavailable adapter refuses rather than returning a verdict.  A caller
// that ignores `available` still fails closed at its first lock attempt.
{
  const refusing = createAdvisoryLockAdapter({ native: null });
  assert.equal(refusing.available, false);
  assert.ok(typeof refusing.unavailable === "string" && refusing.unavailable.length > 0);
  for (const call of [() => refusing.tryLock(1), () => refusing.unlock(1)]) {
    assert.throws(call, (error) => error instanceof AdvisoryLockError && error.reason === "unavailable");
  }
  const gated = createAdvisoryLockAdapter({ platform: "sunos" });
  assert.equal(gated.available, false);
  assert.throws(() => gated.tryLock(1), (error) => error instanceof AdvisoryLockError && error.reason === "unavailable");
}

// Normalisation on the acquire path.  Contention is the only errno family
// that becomes a `false`; the rest keeps its reason and stays an error.
{
  function adapterThrowing(code) {
    return createAdvisoryLockAdapter({ native: { tryLock() { throw errno(code); }, unlock() { throw errno(code); } } });
  }
  for (const code of CONTENTION_CODES) {
    assert.equal(adapterThrowing(code).tryLock(7), false, code);
    // Contention on *release* is meaningless, so it is not swallowed there.
    assert.throws(() => adapterThrowing(code).unlock(7),
      (error) => error instanceof AdvisoryLockError && error.reason === "contention", code);
  }
  for (const code of UNAVAILABLE_CODES) {
    assert.throws(() => adapterThrowing(code).tryLock(7),
      (error) => error instanceof AdvisoryLockError && error.reason === "unavailable" && error.cause.code === code, code);
  }
  for (const code of ["EIO", "EBADF", undefined]) {
    assert.throws(() => adapterThrowing(code).tryLock(7),
      (error) => error instanceof AdvisoryLockError && error.reason === "failed", String(code));
    assert.throws(() => adapterThrowing(code).unlock(7),
      (error) => error instanceof AdvisoryLockError && error.reason === "failed", String(code));
  }
  for (const verdict of [undefined, null, 0, 1, "true", {}]) {
    const odd = createAdvisoryLockAdapter({ native: { tryLock: () => verdict, unlock() {} } });
    assert.throws(() => odd.tryLock(7),
      (error) => error instanceof AdvisoryLockError && error.reason === "failed" && /non-boolean/.test(error.message), String(verdict));
  }
  const plain = createAdvisoryLockAdapter({ native: { tryLock: () => true, unlock() {} } });
  assert.equal(plain.available, true);
  assert.equal(plain.tryLock(7), true);
  assert.equal(plain.unlock(7), undefined);
}

// The real addon.  If this machine cannot load it the whole suite must fail
// here: every exclusion claim below and in the durable stores rests on it,
// and a skipped load would turn all of them into assertions about nothing.
const shared = advisoryLockAdapter();
assert.equal(shared.available, true, `${NATIVE_MODULE} must load: ${shared.unavailable}`);
assert.equal(advisoryLockAdapter(), shared, "the process-wide adapter is built once");

// Exclusion binds to the file, and it binds across open file descriptions
// within a single process — which is what makes a store action re-entering
// its own writer lock a refusal rather than a silent second entry.
withDirectory((directory) => {
  const target = path.join(directory, "lock");
  const first = fs.openSync(target, "w+", 0o600);
  const second = fs.openSync(target, "r+", 0o600);
  try {
    assert.equal(shared.tryLock(first), true, "the first descriptor takes the lock");
    assert.equal(shared.tryLock(second), false, "a second descriptor on the same file is refused in the same process");
    shared.unlock(first);
    assert.equal(shared.tryLock(second), true, "the released lock is available to the next descriptor");
    shared.unlock(second);
  } finally {
    fs.closeSync(first);
    fs.closeSync(second);
  }
});

// Two different files never contend: the exclusion is a property of the
// inode, not of this process having called tryLock at all.  This is the
// negative control for the assertion above.
withDirectory((directory) => {
  const left = fs.openSync(path.join(directory, "left"), "w+", 0o600);
  const right = fs.openSync(path.join(directory, "right"), "w+", 0o600);
  try {
    assert.equal(shared.tryLock(left), true);
    assert.equal(shared.tryLock(right), true, "a lock on one file says nothing about another");
    shared.unlock(left);
    shared.unlock(right);
  } finally {
    fs.closeSync(left);
    fs.closeSync(right);
  }
});

// Closing a descriptor releases whatever it held.  That is the entire
// recovery story for a writer that dies: there is no record to reclaim.
withDirectory((directory) => {
  const target = path.join(directory, "lock");
  const held = fs.openSync(target, "w+", 0o600);
  assert.equal(shared.tryLock(held), true);
  fs.closeSync(held);
  const next = fs.openSync(target, "w+", 0o600);
  try {
    assert.equal(shared.tryLock(next), true, "a closed descriptor's lock is gone");
    shared.unlock(next);
  } finally { fs.closeSync(next); }
});

// A bad descriptor is a hard failure, not contention.
{
  assert.throws(() => shared.tryLock(-1), (error) => error instanceof AdvisoryLockError && error.reason === "failed");
}

console.log("durable-store-advisory-lock tests passed");
