"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createDurableStoreFiles } = require("./durable-store-files");
class Failure extends Error { constructor(code) { super(code); this.code = code; } }
const codes = Object.fromEntries(["options", "unreadable", "symlink_rejected", "insecure_permissions", "write_failed", "locked", "lock_unsafe", "lock_failed", "lock_acquire_changed", "lock_release_changed", "lock_release_failed"].map((key) => [key, key]));
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
    console.log("PASS async advisory lifetime, nonblocking contention, falsey rejection and release precedence");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
