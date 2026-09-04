"use strict";

// #1063/#1064: the shared durable-file primitive.  These tests pin the lock
// record, the reap decision, the bounded retry, the replacement identity
// checks, and the atomic replace independently of any one store's schema.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FILE_MODE,
  DIRECTORY_MODE,
  MAX_LOCK_ATTEMPTS,
  parseLockRecord,
  classifyLivenessProbe,
  createDurableStoreFiles,
} = require("./durable-store-files");

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

function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof ProbeStoreError && error.code === expected, `expected ${expected}`);
}
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-durable-files-"));
  fs.chmodSync(directory, DIRECTORY_MODE);
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function files(fsImpl = fs, extra = {}) {
  return createDurableStoreFiles({ fs: fsImpl, error: ProbeStoreError, codes: CODES, ...extra });
}
function record(fields = {}) {
  return JSON.stringify({ version: 1, pid: process.pid, token: crypto.randomBytes(16).toString("hex"), host: os.hostname(), created_at: Date.now(), ...fields });
}
function deadPid() {
  const exited = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), (error) => error.code === "ESRCH");
  return exited.pid;
}
function plantLock(directory, body) {
  const target = path.join(directory, "state.json");
  fs.writeFileSync(`${target}.lock`, body, { mode: FILE_MODE, flag: "wx" });
  return target;
}

// Construction: the store's error class and every code slot are required;
// an incomplete fs fails with the store's own options code.
{
  assert.throws(() => createDurableStoreFiles({ fs, error: ProbeStoreError, codes: { ...CODES, locked: undefined } }), TypeError);
  assert.throws(() => createDurableStoreFiles({ fs, error: null, codes: CODES }), TypeError);
  throwsCode(() => files({ ...fs, fsyncSync: undefined }), "probe_options");
  throwsCode(() => files(null), "probe_options");
  throwsCode(() => files(fs, { random_bytes: "entropy" }), "probe_options");
}

// The lock record binds pid, an unforgeable token, the host, and the creation
// instant, and is removed on release.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  const before = Date.now();
  let seen = null;
  files().withWriterLock(target, () => { seen = fs.readFileSync(`${target}.lock`, "utf8"); });
  const parsed = JSON.parse(seen);
  assert.deepEqual(Object.keys(parsed), ["version", "pid", "token", "host", "created_at"]);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.pid, process.pid);
  assert.match(parsed.token, /^[a-f0-9]{32}$/);
  assert.equal(parsed.host, os.hostname());
  assert.ok(parsed.created_at >= before && parsed.created_at <= Date.now());
  assert.deepEqual(parseLockRecord(seen), parsed);
  assert.equal(fs.existsSync(`${target}.lock`), false);
  // Injected entropy shapes temporary names only; the token stays random.
  let second = null;
  files(fs, { random_bytes: () => Buffer.alloc(16, 7) }).withWriterLock(target, () => { second = JSON.parse(fs.readFileSync(`${target}.lock`, "utf8")).token; });
  assert.notEqual(second, parsed.token);
  assert.notEqual(second, "07".repeat(16));
});

// Only an exact record identifies an owner.
{
  for (const body of ["", "locked", `${process.pid}.${"ab".repeat(16)}`, "[]", "null", JSON.stringify({ pid: process.pid }),
    record({ extra: true }), record({ pid: 0 }), record({ pid: 1.5 }), record({ token: "AB".repeat(16) }), record({ token: "ab".repeat(8) }),
    record({ host: "" }), record({ created_at: -1 }), record({ version: 2 }), record({ token: "ab".repeat(16) }).replace("}", `,"pad":"${"x".repeat(600)}"}`)]) {
    assert.equal(parseLockRecord(body), null, body.slice(0, 60));
  }
}

// The probe classification: EPERM is alive, only ESRCH is dead, and anything
// else is unverifiable.  No pid or signal is chosen here.
{
  assert.equal(classifyLivenessProbe({ code: "ESRCH" }), "dead");
  assert.equal(classifyLivenessProbe({ code: "EPERM" }), "alive");
  assert.equal(classifyLivenessProbe({ code: "EACCES" }), "unverifiable");
  assert.equal(classifyLivenessProbe(new Error("no code")), "unverifiable");
  assert.equal(classifyLivenessProbe(undefined), "unverifiable");
}

// A dead owner's lock is reclaimed: the next writer acquires, writes its own
// record into a fresh inode, and releases cleanly.
withDirectory((directory) => {
  const stale = record({ pid: deadPid() });
  const target = plantLock(directory, stale);
  let held = null;
  const result = files().withWriterLock(target, () => {
    held = JSON.parse(fs.readFileSync(`${target}.lock`, "utf8"));
    return "written";
  });
  assert.equal(result, "written");
  assert.equal(held.pid, process.pid);
  assert.notEqual(held.token, JSON.parse(stale).token, "the reclaimed lock carries the new writer's own record");
  assert.equal(fs.existsSync(`${target}.lock`), false);
});

// A live owner, an EPERM owner, a foreign host, or an unidentifiable body
// fails closed and is left untouched; an unsafe lock is reported as unsafe.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  let init = null;
  try { process.kill(1, 0); } catch (error) { init = error.code; }
  assert.ok(init === null || init === "EPERM");
  for (const body of [record({}), record({ pid: 1 }), record({ pid: deadPid(), host: "elsewhere.invalid" }), "", `${deadPid()}.${"ab".repeat(16)}`]) {
    fs.writeFileSync(`${target}.lock`, body, { mode: FILE_MODE, flag: "wx" });
    throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_locked");
    assert.equal(fs.readFileSync(`${target}.lock`, "utf8"), body);
    fs.unlinkSync(`${target}.lock`);
  }
  fs.writeFileSync(`${target}.lock`, record({ pid: deadPid() }), { mode: 0o644, flag: "wx" });
  throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_unsafe");
  assert.equal(fs.existsSync(`${target}.lock`), true);
  fs.unlinkSync(`${target}.lock`);
  fs.symlinkSync(path.join(directory, "elsewhere"), `${target}.lock`);
  throwsCode(() => files().withWriterLock(target, () => assert.fail("must not acquire")), "probe_lock_unsafe");
  assert.equal(fs.lstatSync(`${target}.lock`).isSymbolicLink(), true);
});

// Replacement between judgement and unlink: a different inode is detected by
// dev+ino; the Linux inode-reuse shape (same dev+ino, forged by the stubbed
// lstat) is detected only by the exact record.  Either way the live
// replacement stays and its owner is honoured.
for (const forgeInode of [false, true]) {
  withDirectory((directory) => {
    const target = plantLock(directory, record({ pid: deadPid() }));
    const lockPath = `${target}.lock`;
    const replacement = record({});
    let inspections = 0;
    let original = null;
    const replacingFs = Object.create(fs);
    replacingFs.lstatSync = (inspected) => {
      if (inspected !== lockPath) return fs.lstatSync(inspected);
      inspections += 1;
      if (inspections === 1) {
        original = fs.lstatSync(inspected);
        return original;
      }
      if (inspections === 2) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, replacement, { mode: FILE_MODE, flag: "wx" });
      }
      const stats = fs.lstatSync(inspected);
      if (forgeInode) {
        stats.dev = original.dev;
        stats.ino = original.ino;
      }
      return stats;
    };
    assert.throws(() => files(replacingFs).withWriterLock(target, () => assert.fail("must not acquire")),
      (error) => error instanceof ProbeStoreError && error.code === "probe_locked", `forgeInode=${forgeInode}: expected probe_locked`);
    assert.equal(inspections, 2, `forgeInode=${forgeInode}`);
    assert.equal(fs.readFileSync(lockPath, "utf8"), replacement, `forgeInode=${forgeInode}: the replacement stays`);
  });
}

// A lock released between the failed create and the inspection is simply
// retried; a lock that is dead again after every reclaim is retried at most
// MAX_LOCK_ATTEMPTS times and then refused, with no waiting anywhere.
withDirectory((directory) => {
  const target = path.join(directory, "state.json");
  let opens = 0;
  const vanishingFs = Object.create(fs);
  vanishingFs.openSync = (inspected, flags, ...rest) => {
    if (inspected === `${target}.lock` && flags === "wx") {
      opens += 1;
      if (opens === 1) { const error = new Error("EEXIST"); error.code = "EEXIST"; throw error; }
    }
    return fs.openSync(inspected, flags, ...rest);
  };
  assert.equal(files(vanishingFs).withWriterLock(target, () => "written"), "written");
  assert.equal(opens, 2);
});
withDirectory((directory) => {
  const target = plantLock(directory, record({ pid: deadPid() }));
  const lockPath = `${target}.lock`;
  let opens = 0;
  let reclaimed = 0;
  const respawningFs = Object.create(fs);
  respawningFs.openSync = (inspected, flags, ...rest) => {
    if (inspected === lockPath && flags === "wx") opens += 1;
    return fs.openSync(inspected, flags, ...rest);
  };
  respawningFs.unlinkSync = (inspected) => {
    fs.unlinkSync(inspected);
    if (inspected === lockPath) {
      reclaimed += 1;
      fs.writeFileSync(lockPath, record({ pid: deadPid() }), { mode: FILE_MODE, flag: "wx" });
    }
  };
  const started = Date.now();
  throwsCode(() => files(respawningFs).withWriterLock(target, () => assert.fail("must not acquire")), "probe_locked");
  assert.equal(opens, MAX_LOCK_ATTEMPTS);
  assert.equal(reclaimed, MAX_LOCK_ATTEMPTS - 1);
  assert.ok(Date.now() - started < 1000, "bounded retries never wait");
  assert.equal(fs.existsSync(lockPath), true);
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
