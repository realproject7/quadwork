"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { createDurableStoreFiles } = require("./durable-store-files");
class Failure extends Error { constructor(code) { super(code); this.code = code; } }
const codes = Object.fromEntries(["options", "unreadable", "symlink_rejected", "insecure_permissions", "write_failed", "locked", "lock_unsafe", "lock_failed", "lock_acquire_changed", "lock_release_changed", "lock_release_failed"].map((key) => [key, key]));
function message(child, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off("message", listener); reject(new Error(`child did not report ${kind}`)); }, 5000);
    const listener = (value) => { if (value === kind) { clearTimeout(timer); child.off("message", listener); resolve(); } };
    child.on("message", listener);
  });
}
async function childMain(target) {
  const files = createDurableStoreFiles({ fs, error: Failure, codes });
  process.send("ready");
  const timer = setTimeout(() => process.send("heartbeat"), 50);
  await files.withAsyncWriterLock(target, async () => {
    process.send("acquired"); await once(process, "message");
  });
  clearTimeout(timer); process.disconnect();
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-async-lock-")), target = path.join(root, "record");
  try {
    const files = createDurableStoreFiles({ fs, error: Failure, codes });
    for (const value of [undefined, null, false, 0, ""]) {
      let threw = false;
      try { await files.withAsyncWriterLock(target, async () => { throw value; }); } catch (error) { threw = true; assert.equal(error, value); }
      assert.equal(threw, true);
      assert.equal(files.withWriterLock(target, () => true), true);
    }
    let release, entered = false, ticked = false;
    const pending = files.withAsyncWriterLock(target, async () => { entered = true; await new Promise((resolve) => { release = resolve; }); return 7; });
    assert.equal(entered, true);
    assert.throws(() => files.withWriterLock(target, () => {}), (e) => e.code === "locked");
    const second = files.withAsyncWriterLock(target, async () => 8);
    setImmediate(() => { ticked = true; release(); });
    assert.equal(await pending, 7); assert.equal(await second, 8); assert.equal(ticked, true);
    for (const deadline of [NaN, Infinity, -1, "200"]) await assert.rejects(() => files.withAsyncWriterLock(target, async () => {}, deadline), (e) => e.code === "options");
    const replacement = createDurableStoreFiles({ fs, error: Failure, codes, advisory_lock: { tryLock: () => true, unlock: () => { throw new Failure("release_failure"); } } });
    let failed = false;
    try { await replacement.withAsyncWriterLock(target, async () => { throw null; }); } catch (error) { failed = true; assert.equal(error, null); }
    assert.equal(failed, true);
    // The same permanent guard must remain owned over await in another
    // process, and kernel ownership must release on process death.
    let releaseParent;
    const held = files.withAsyncWriterLock(target, async () => new Promise((resolve) => { releaseParent = resolve; }));
    const child = fork(__filename, ["--lock-child", target], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    try {
      let acquired = false;
      child.on("message", (value) => { if (value === "acquired") acquired = true; });
      await message(child, "heartbeat"); assert.equal(acquired, false);
      const acquisition = message(child, "acquired"); releaseParent(); await held; await acquisition;
      assert.throws(() => files.withWriterLock(target, () => {}), (e) => e.code === "locked");
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      assert.equal(await files.withAsyncWriterLock(target, async () => "recovered"), "recovered");
    } finally { releaseParent(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    console.log("PASS async advisory lifetime, real two-process contention/crash recovery, falsey rejection and release precedence");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
(process.argv[2] === "--lock-child" ? childMain(process.argv[3]) : main()).catch((error) => { console.error(error); process.exitCode = 1; });
