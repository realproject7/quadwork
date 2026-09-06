"use strict";

// #1063/#1064/#1074: the shared durable-file primitive.  These tests pin the
// writer lock, its identity checks, its bounded retry, and the atomic replace
// independently of any one store's schema.
//
// #1074 changed what the lock *is*.  It used to be the existence of a file
// carrying an owner record, which meant a writer had to judge that record and
// then act on the judgement by path — and a legitimate replacement arriving in
// that window was destroyed by the judge.  It is now a whole-file advisory
// lock held on an open descriptor, and the `.lock` file is a permanent,
// owner-only artifact that is never removed — newly created locks are empty,
// while an upgraded legacy body may remain as an inert diagnostic that is
// never ownership evidence.  The tests that used to pin the
// record, the liveness probe, and the reclaim are therefore replaced here by
// their successors:
//   - the record tests become two-directional metadata tests: whatever a lock
//     file contains, an unheld lock is acquired and a held one is refused, so
//     content is proven not to be part of the verdict either way;
//   - the reclaim tests become "a dead writer leaves nothing to reclaim";
//   - the replacement-vs-unlink tests become "an identity mismatch is retried
//     and then refused, and no lock path is ever unlinked or renamed".
// The liveness-probe classification moved out of this module entirely; the
// errno classification that replaced it lives in
// durable-store-advisory-lock.test.js.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FILE_MODE,
  DIRECTORY_MODE,
  MAX_LOCK_ATTEMPTS,
  LOCK_OPEN_FLAGS,
  createDurableStoreFiles,
} = require("./durable-store-files");
const { advisoryLockAdapter } = require("./durable-store-advisory-lock");

class ProbeStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ProbeStoreError";
    this.code = code;
  }
}
const CODES = Object.freeze({
  options: "probe_options",
  unreadable: "probe_unreadable",
  symlink_rejected: "probe_symlink",
  insecure_permissions: "probe_insecure",
  write_failed: "probe_write_failed",
  locked: "probe_locked",
  lock_unsafe: "probe_lock_unsafe",
  lock_failed: "probe_lock_failed",
  lock_acquire_changed: "probe_lock_acquire_changed",
  lock_release_changed: "probe_lock_release_changed",
  lock_release_failed: "probe_lock_release_failed",
});

const advisory = advisoryLockAdapter();
assert.equal(advisory.available, true, `the advisory lock primitive must be available: ${advisory.unavailable}`);
// Stated as a literal, not imported: asserting a retry count against the very
// constant the module exports would move with any change to it and pin nothing.
const EXPECTED_LOCK_ATTEMPTS = 3;
assert.equal(MAX_LOCK_ATTEMPTS, EXPECTED_LOCK_ATTEMPTS, "the acquisition retry bound is three attempts");
assert.equal(typeof LOCK_OPEN_FLAGS, "number", "the lock open flags include O_NOFOLLOW on this platform");
assert.equal((LOCK_OPEN_FLAGS & fs.constants.O_NOFOLLOW) !== 0, true, "the lock is opened O_NOFOLLOW");
assert.equal((LOCK_OPEN_FLAGS & fs.constants.O_CREAT) !== 0, true);
assert.equal((LOCK_OPEN_FLAGS & fs.constants.O_RDWR) !== 0, true);

function throwsCode(fn, expected, message) {
  assert.throws(fn, (error) => error instanceof ProbeStoreError && error.code === expected, message || `expected ${expected}`);
}
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-durable-files-"));
  fs.chmodSync(directory, DIRECTORY_MODE);
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function files(fsImpl = fs, extra = {}) {
  return createDurableStoreFiles({ fs: fsImpl, error: ProbeStoreError, codes: CODES, ...extra });
}
// "Nobody holds this lock right now", asked of the kernel rather than of the
// file's existence or contents.  Every assertion that a writer let go uses it.
function unheld(lockPath) {
  const descriptor = fs.openSync(lockPath, "r+");
  try {
    if (!advisory.tryLock(descriptor)) return false;
    advisory.unlock(descriptor);
    return true;
  } finally { fs.closeSync(descriptor); }
}
// A real, live holder inside this process: a descriptor with the kernel lock
// on it.  It is a genuine second open file description, which is exactly what
// a competing writer has.
function holdLock(lockPath) {
  const descriptor = fs.openSync(lockPath, LOCK_OPEN_FLAGS, FILE_MODE);
  assert.equal(advisory.tryLock(descriptor), true, "the test holder took the lock");
  return { release() { advisory.unlock(descriptor); fs.closeSync(descriptor); } };
}
function plantLock(directory, body, mode = FILE_MODE) {
  const target = path.join(directory, "state.json");
  fs.writeFileSync(`${target}.lock`, body, { mode, flag: "wx" });
  fs.chmodSync(`${target}.lock`, mode);
  return target;
}

// Construction: the store's error class and every code slot are required;
// an incomplete fs, or an advisory adapter that is not one, fails with the
// store's own options code.
{
  assert.throws(() => createDurableStoreFiles({ fs, error: ProbeStoreError, codes: { ...CODES, locked: undefined } }), TypeError);
  assert.throws(() => createDurableStoreFiles({ fs, error: null, codes: CODES }), TypeError);
  throwsCode(() => files({ ...fs, fsyncSync: undefined }), "probe_options");
  throwsCode(() => files(null), "probe_options");
  throwsCode(() => files(fs, { random_bytes: "entropy" }), "probe_options");
  for (const bad of [null, {}, { tryLock: () => true }, { unlock() {} }, "lock"]) {
    throwsCode(() => files(fs, { advisory_lock: bad }), "probe_options", JSON.stringify(bad));
  }
}

// A lock this module creates is a permanent, empty, owner-only file, held for
// exactly the duration of the action and never removed.  (Empty is a property
// of the ones it creates, not of every lock it will accept — the block below
// this one plants legacy bodies and proves they survive untouched.)  Its inode
// is stable across acquisitions: the second writer locks the very same object
// as the first.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const lockPath = `${target}.lock`;
  let insideStats = null;
  assert.equal(files().withWriterLock(target, () => {
    insideStats = fs.lstatSync(lockPath);
    assert.equal(unheld(lockPath), false, "the lock is held for the whole action");
    return "written";
  }), "written");
  assert.equal(insideStats.isFile(), true);
  assert.equal(insideStats.size, 0, "the lock carries no body at all");
  assert.equal(insideStats.mode & 0o777, FILE_MODE);
  assert.equal(fs.existsSync(lockPath), true, "the lock file is permanent");
  assert.equal(fs.lstatSync(lockPath).size, 0, "release writes nothing into the lock");
  assert.equal(unheld(lockPath), true, "release hands the lock back to the kernel");
  files().withWriterLock(target, () => {
    const again = fs.lstatSync(lockPath);
    assert.equal(again.ino, insideStats.ino, "the second writer locks the same inode");
    assert.equal(again.dev, insideStats.dev);
  });
  // Injected entropy shapes temporary names only; it never reaches the lock.
  files(fs, { random_bytes: () => Buffer.alloc(16, 7) }).withWriterLock(target, () => {
    assert.equal(fs.lstatSync(lockPath).size, 0);
  });
});

// Two-directional: a lock file's metadata is not part of the verdict.  With
// no holder every one of these bodies is acquired; with a live holder every
// one of them is refused.  Neither direction changes the file.
withDirectory((directory) => {
  const bodies = ["", "locked", "{}", "null", "[]", JSON.stringify({ version: 1, pid: process.pid, token: "ab".repeat(16), host: os.hostname(), created_at: Date.now() }), "x".repeat(600)];
  for (const body of bodies) {
    const target = plantLock(directory, body);
    const lockPath = `${target}.lock`;
    const label = JSON.stringify(body.slice(0, 40));

    assert.equal(files().withWriterLock(target, () => "acquired"), "acquired", `${label}: an unheld lock is acquired whatever it says`);
    assert.equal(fs.readFileSync(lockPath, "utf8"), body, `${label}: acquiring never rewrites the lock`);

    const holder = holdLock(lockPath);
    try {
      throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_locked", `${label}: a held lock is refused whatever it says`);
    } finally { holder.release(); }
    assert.equal(fs.readFileSync(lockPath, "utf8"), body, `${label}: a refusal never rewrites the lock`);

    assert.equal(files().withWriterLock(target, () => "acquired"), "acquired", `${label}: the released lock is available again`);
    fs.unlinkSync(lockPath);
    fs.rmSync(target, { force: true });
  }
});

// A writer that died leaves nothing to reclaim: the kernel dropped its lock
// when its descriptors closed, and the file it left behind is simply locked
// again.  A live foreign holder is honoured for exactly as long as it lives.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const lockPath = `${target}.lock`;
  files().withWriterLock(target, () => "first");
  const holder = holdLock(lockPath);
  throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_locked");
  holder.release();
  assert.equal(files().withWriterLock(target, () => "after"), "after", "the lock outlives its holder without any recovery step");
});

// An unsafe lock object is refused outright rather than retried: a mode that
// lets another user open it, a file that is not a regular file, and a symlink
// at the lock path.  None of them is repaired, replaced, or removed.
withDirectory((directory) => {
  const target = plantLock(directory, "", 0o644);
  const lockPath = `${target}.lock`;
  throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_unsafe");
  assert.equal(fs.lstatSync(lockPath).mode & 0o777, 0o644, "the unsafe lock is left exactly as found");
  fs.unlinkSync(lockPath);

  fs.symlinkSync(path.join(directory, "elsewhere"), lockPath);
  throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_unsafe");
  assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true, "the symlink is left in place");
  assert.equal(fs.existsSync(path.join(directory, "elsewhere")), false, "O_NOFOLLOW never created the symlink's target");
  fs.unlinkSync(lockPath);

  fs.mkdirSync(lockPath, { mode: DIRECTORY_MODE });
  throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_failed");
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true);
});

// A lock owned by another user is unsafe even at mode 0600: this process can
// still open and lock it, so "owner-only" says nothing about *whose*.  A real
// foreign-owned file needs a second uid, which a test does not have, so the
// owner is forged through the fs seam — and the same stub returning this
// process's own uid is the negative control that shows the forgery is what
// produced the refusal.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const lockPath = `${target}.lock`;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  assert.notEqual(uid, null, "this platform reports a uid, so the owner check is live");
  let forge = 0;
  const foreignFs = Object.create(fs);
  foreignFs.fstatSync = (descriptor) => {
    const stats = fs.fstatSync(descriptor);
    if (stats.isFile() && (stats.mode & 0o777) === FILE_MODE) stats.uid = uid + forge;
    return stats;
  };
  forge = 1;
  throwsCode(() => files(foreignFs).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_unsafe");
  assert.equal(unheld(lockPath), true, "the refused acquisition released the lock it had taken");
  forge = 0;
  assert.equal(files(foreignFs).withWriterLock(target, () => "written"), "written",
    "the same stub reporting this process's own uid acquires, so the refusal above was the foreign owner");
});

// Nor is a lock allowed on something that is not a regular file.  A directory
// is refused by the open itself, but an openable non-regular file — a FIFO,
// say — is not, so the kind is forged through the same seam, with the same
// stub reporting a regular file as the control.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const lockPath = `${target}.lock`;
  let regular = false;
  const oddKindFs = Object.create(fs);
  oddKindFs.fstatSync = (descriptor) => {
    const stats = fs.fstatSync(descriptor);
    if (stats.isFile() && (stats.mode & 0o777) === FILE_MODE) {
      const answer = regular;
      stats.isFile = () => answer;
    }
    return stats;
  };
  throwsCode(() => files(oddKindFs).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_unsafe");
  assert.equal(unheld(lockPath), true, "the refused acquisition released the lock it had taken");
  regular = true;
  assert.equal(files(oddKindFs).withWriterLock(target, () => "written"), "written",
    "the same stub reporting a regular file acquires, so the refusal above was the file kind");
});

// An unavailable primitive is a hard failure, never a fallback.  There is no
// path-based lock to fall back to, and writing unprotected is the defect.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const { AdvisoryLockError } = require("./durable-store-advisory-lock");
  const unavailable = {
    tryLock() { throw new AdvisoryLockError("unavailable", "no kernel support"); },
    unlock() { throw new AdvisoryLockError("unavailable", "no kernel support"); },
  };
  throwsCode(() => files(fs, { advisory_lock: unavailable }).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_failed");
  assert.equal(fs.existsSync(target), false, "nothing was written without a lock");
  const broken = {
    tryLock() { const error = new Error("EIO"); error.code = "EIO"; throw error; },
    unlock() {},
  };
  assert.throws(() => files(fs, { advisory_lock: broken }).withWriterLock(target, () => assert.fail("must not acquire")),
    (error) => error && error.code === "EIO", "an error the adapter never classified is not swallowed");
});

// Identity mismatch: the file at the path is not the file we locked.  That is
// retried — the path is opened again — at most MAX_LOCK_ATTEMPTS times, and
// then refused with the store's acquire-changed code.  No waiting anywhere,
// and the thing at the path is never touched.
withDirectory((directory) => {
  const target = plantLock(directory, "planted");
  const lockPath = `${target}.lock`;
  let opens = 0;
  const forgingFs = Object.create(fs);
  forgingFs.openSync = (inspected, ...rest) => {
    if (inspected === lockPath) opens += 1;
    return fs.openSync(inspected, ...rest);
  };
  forgingFs.lstatSync = (inspected) => {
    const stats = fs.lstatSync(inspected);
    if (inspected === lockPath) stats.ino += 1;
    return stats;
  };
  const started = Date.now();
  throwsCode(() => files(forgingFs).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_acquire_changed");
  assert.equal(opens, EXPECTED_LOCK_ATTEMPTS, "the mismatch is retried exactly three times");
  assert.ok(Date.now() - started < 1000, "bounded retries never wait");
  assert.equal(fs.readFileSync(lockPath, "utf8"), "planted", "the file at the path is left alone");
  assert.equal(unheld(lockPath), true, "every abandoned attempt released its lock");
});
// A mismatch that clears on the second look is simply retried into a success.
withDirectory((directory) => {
  const target = plantLock(directory, "planted");
  const lockPath = `${target}.lock`;
  let inspections = 0;
  const flakyFs = Object.create(fs);
  flakyFs.lstatSync = (inspected) => {
    const stats = fs.lstatSync(inspected);
    if (inspected === lockPath) {
      inspections += 1;
      if (inspections === 1) stats.ino += 1;
    }
    return stats;
  };
  assert.equal(files(flakyFs).withWriterLock(target, () => "written"), "written");
  assert.ok(inspections >= 2, "the first look disagreed and a second was taken");
});
// A lock that vanishes from the path while we hold it is the same mismatch,
// and the vanished path is re-created by the retry rather than mourned.
withDirectory((directory) => {
  const target = plantLock(directory, "planted");
  const lockPath = `${target}.lock`;
  let removed = false;
  const vanishingFs = Object.create(fs);
  vanishingFs.fstatSync = (descriptor) => {
    if (!removed) { removed = true; fs.unlinkSync(lockPath); }
    return fs.fstatSync(descriptor);
  };
  assert.equal(files(vanishingFs).withWriterLock(target, () => "written"), "written");
  assert.equal(fs.existsSync(lockPath), true, "the retry created the lock the vanishing removed");
});

// #1064: a retry is a *re-open of the same path*, so it is only legitimate
// once the previous attempt's lock is provably gone.  If the unlock failed,
// the kernel's answer is unknown; if the close failed, the descriptor — and
// any lock still attached to it — is alive inside this process.  Either way
// the next open would be judged against a lock this writer may still hold, so
// the acquisition must stop, with the store's own lock-failure code, on the
// attempt that could not clean up.  It must not retry, and it must not report
// the milder verdict it was in the middle of.
//
// An unlock failure with a successful close is included deliberately: "the
// close probably released it" is a hope, and a retry may not be built on one.
withDirectory((directory) => {
  const target = plantLock(directory, "planted");
  const lockPath = `${target}.lock`;
  const { AdvisoryLockError: DropError } = require("./durable-store-advisory-lock");
  let opens = 0;
  const mismatchingFs = Object.create(fs);
  mismatchingFs.openSync = (inspected, ...rest) => {
    if (inspected === lockPath) opens += 1;
    return fs.openSync(inspected, ...rest);
  };
  mismatchingFs.lstatSync = (inspected) => {
    const stats = fs.lstatSync(inspected);
    if (inspected === lockPath) stats.ino += 1;
    return stats;
  };

  // Control first: with cleanup working, this very fs retries the bound and
  // reports the mismatch.  Every refusal below is measured against this.
  throwsCode(() => files(mismatchingFs).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_acquire_changed");
  assert.equal(opens, EXPECTED_LOCK_ATTEMPTS, "the mismatch alone is retried to the bound");

  // Unlock fails, close succeeds: fail closed on the first attempt.
  opens = 0;
  const failingUnlock = {
    tryLock: (descriptor) => advisory.tryLock(descriptor),
    unlock() { throw new DropError("failed", "unlock failed"); },
  };
  throwsCode(() => files(mismatchingFs, { advisory_lock: failingUnlock }).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_failed");
  assert.equal(opens, 1, "an abandonment whose unlock failed is never retried");
  assert.equal(unheld(lockPath), true, "the descriptor was still closed, so the kernel lock is gone");

  // Close fails: the descriptor outlives the attempt, so likewise no retry.
  // The stranded descriptors are closed by this test, not by the module.
  opens = 0;
  const stranded = [];
  const failingCloseFs = Object.create(mismatchingFs);
  failingCloseFs.closeSync = (descriptor) => {
    stranded.push(descriptor);
    const error = new Error("EIO");
    error.code = "EIO";
    throw error;
  };
  try {
    throwsCode(() => files(failingCloseFs).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_failed");
    assert.equal(opens, 1, "an abandonment whose close failed is never retried");
  } finally {
    for (const descriptor of stranded) { try { fs.closeSync(descriptor); } catch { /* already gone */ } }
  }
  assert.equal(stranded.length, 1, "the close was attempted exactly once, on the one attempt that ran");
  assert.equal(fs.readFileSync(lockPath, "utf8"), "planted", "no refusal touched the file at the path");
});

// The contention path opens a descriptor it never locks, and closing it is
// not bookkeeping: an fd this process cannot account for is what the next
// judgement about the path would be made underneath.  A failed close there is
// reported, not swallowed behind the milder "someone else holds it".
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const lockPath = `${target}.lock`;
  files().withWriterLock(target, () => "created the lock file");
  const stranded = [];
  const failingCloseFs = Object.create(fs);
  failingCloseFs.closeSync = (descriptor) => {
    stranded.push(descriptor);
    const error = new Error("EIO");
    error.code = "EIO";
    throw error;
  };
  const holder = holdLock(lockPath);
  try {
    // Control: with a working close, the same live holder is reported as
    // contention, so the difference below is the close and nothing else.
    throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_locked");
    throwsCode(() => files(failingCloseFs).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_failed");
  } finally {
    holder.release();
    for (const descriptor of stranded) { try { fs.closeSync(descriptor); } catch { /* already gone */ } }
  }
  assert.equal(stranded.length, 1, "the contention path closed exactly once");
});

// #1064: the acquisition takes exactly one fstat — the verifier's — and keeps
// the stats that verdict was reached on.  A second stat after the verdict
// re-asks a settled question, and a second stat that *throws* leaves a locked
// descriptor that is neither returned nor released: a kernel lock with no
// owner left to drop it.  The seam below makes every fstat after the first
// throw, which is precisely that failure; the acquisition must not notice it,
// because it must not be making the call.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const lockPath = `${target}.lock`;
  let stats = 0;
  const oneStatFs = Object.create(fs);
  oneStatFs.fstatSync = (descriptor) => {
    stats += 1;
    if (stats > 1) { const error = new Error("EIO"); error.code = "EIO"; throw error; }
    return fs.fstatSync(descriptor);
  };
  assert.equal(files(oneStatFs).withWriterLock(target, () => "written"), "written",
    "a successful acquisition never stats the descriptor a second time");
  assert.equal(stats, 1, "exactly one fstat, the verifier's, is taken per acquisition");
  assert.equal(unheld(lockPath), true, "the lock was released normally");
  // Negative control: the seam is live and its failure is fatal — let the
  // verifier's own stat throw and the acquisition fails closed, releasing
  // what it had taken.  So the pass above is "no second call", not "the stub
  // never fired".
  stats = 1;
  throwsCode(() => files(oneStatFs).withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_failed");
  assert.equal(unheld(lockPath), true, "the failed inspection released the lock it had taken");
});

// No production path ever unlinks, renames, or truncates a lock.  The
// recorder below is proven able to see such a call by the atomic replace's
// own temporary cleanup, which it does report.
withDirectory((directory) => {
  const touched = [];
  const recordingFs = Object.create(fs);
  recordingFs.unlinkSync = (inspected) => { touched.push(["unlink", inspected]); return fs.unlinkSync(inspected); };
  recordingFs.renameSync = (from, to) => { touched.push(["rename", from, to]); return fs.renameSync(from, to); };
  recordingFs.truncateSync = (inspected) => { touched.push(["truncate", inspected]); return fs.truncateSync(inspected); };
  const target = path.join(directory, "state.json");
  const layer = files(recordingFs);
  layer.withWriterLock(target, () => layer.writeFileAtomically(target, "{\"a\":1}\n"));
  const holder = holdLock(`${target}.lock`);
  try { throwsCode(() => layer.withWriterLock(target, () => assert.fail("must not acquire")), "probe_locked"); }
  finally { holder.release(); }
  // A write that fails after its temporary exists, so the cleanup path runs
  // under the same recorder.
  const failingFs = Object.create(recordingFs);
  failingFs.renameSync = (from, to) => { touched.push(["rename", from, to]); const error = new Error("EIO"); error.code = "EIO"; throw error; };
  const failing = files(failingFs);
  throwsCode(() => failing.withWriterLock(target, () => failing.writeFileAtomically(target, "{\"a\":2}\n")), "probe_write_failed");
  assert.deepEqual(touched.filter((entry) => entry.slice(1).some((value) => String(value).endsWith(".lock"))), [],
    `a lock path was mutated: ${JSON.stringify(touched)}`);
  // Negative control: the recorder is not blind — it saw the temporary's
  // rename, and the failed write's cleanup of its own temporary.
  assert.equal(touched.some((entry) => entry[0] === "rename" && entry[2] === target), true, JSON.stringify(touched));
  assert.equal(touched.some((entry) => entry[0] === "unlink" && entry[1].endsWith(".tmp")), true, JSON.stringify(touched));
});

// The action's own outcome wins over a failed release, and the descriptor is
// closed either way — an abandoned descriptor would keep the lock forever.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const lockPath = `${target}.lock`;
  const { AdvisoryLockError: ReleaseError } = require("./durable-store-advisory-lock");
  const failingRelease = {
    tryLock: (descriptor) => advisory.tryLock(descriptor),
    unlock() { throw new ReleaseError("failed", "unlock failed"); },
  };
  const layer = files(fs, { advisory_lock: failingRelease });
  throwsCode(() => layer.withWriterLock(target, () => "committed"), "probe_lock_release_failed");
  assert.equal(unheld(lockPath), true, "a failed unlock still closed the descriptor, which releases the lock");
  const boom = new Error("the action failed");
  assert.throws(() => layer.withWriterLock(target, () => { throw boom; }), (error) => error === boom,
    "the action's error takes precedence over the release error");
  assert.equal(unheld(lockPath), true);
});

// A lock file replaced underneath a live holder is reported at release: the
// window this writer protected was not the window anyone else contended on.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const lockPath = `${target}.lock`;
  throwsCode(() => files().withWriterLock(target, () => {
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, "", { mode: FILE_MODE, flag: "wx" });
  }), "probe_lock_release_changed");
  assert.equal(unheld(lockPath), true, "the descriptor was closed even though the release was reported changed");
});

// Atomic replace: the temporary is fsynced and renamed, the directory is
// synced, the result is an owner-only regular file, and a failed rename
// leaves neither a temporary nor a changed target behind.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  files().writeFileAtomically(target, "{\"a\":1}\n");
  assert.equal(fs.readFileSync(target, "utf8"), "{\"a\":1}\n");
  assert.equal(fs.lstatSync(target).mode & 0o777, FILE_MODE);
  throwsCode(() => files().writeFileAtomically(target, { a: 2 }), "probe_write_failed");
  const failingFs = Object.create(fs);
  failingFs.renameSync = () => { const error = new Error("EIO"); error.code = "EIO"; throw error; };
  throwsCode(() => files(failingFs).writeFileAtomically(target, "{\"a\":2}\n"), "probe_write_failed");
  assert.equal(fs.readFileSync(target, "utf8"), "{\"a\":1}\n");
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
  throwsCode(() => files(fs, { random_bytes: () => Buffer.alloc(4) }).writeFileAtomically(target, "{}\n"), "probe_write_failed");
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

// Directory chain: only the root is created recursively, modes are checked
// where the store asks for them, and a symlink is rejected.
withDirectory((directory) => {
  const root = path.join(directory, "root");
  const nested = path.join(root, "store");
  const layer = files();
  assert.equal(layer.storageExists([{ path: root }, { path: nested, mode: DIRECTORY_MODE }]), false);
  layer.ensureDirectories([{ path: root }, { path: nested, mode: DIRECTORY_MODE }]);
  assert.equal(fs.lstatSync(nested).mode & 0o777, DIRECTORY_MODE);
  assert.equal(layer.storageExists([{ path: root }, { path: nested, mode: DIRECTORY_MODE }]), true);
  fs.chmodSync(nested, 0o755);
  throwsCode(() => layer.storageExists([{ path: root }, { path: nested, mode: DIRECTORY_MODE }]), "probe_insecure");
  fs.chmodSync(nested, DIRECTORY_MODE);
  fs.symlinkSync(nested, path.join(root, "link"));
  throwsCode(() => layer.assertRealDirectory(path.join(root, "link")), "probe_symlink");
  assert.throws(() => layer.ensureDirectories([{ path: path.join(directory, "missing", "deep") }, { path: path.join(directory, "missing", "deep", "x", "y"), mode: DIRECTORY_MODE }]), (error) => error.code === "ENOENT", "nested levels are never created recursively");
  assert.equal(fs.lstatSync(path.join(directory, "missing", "deep")).isDirectory(), true);
});

console.log("durable-store-files tests passed");
