"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDurableStoreFiles } = require("./durable-store-files");
const { getSharedResourceRuntimeOwner, createResourceRuntimeOwner } = require("./resource-runtime-owner");
class LockError extends Error { constructor(code, message) { super(message); this.code = code; } }
const codes = Object.fromEntries(["options", "unreadable", "symlink_rejected", "insecure_permissions", "write_failed", "locked", "lock_unsafe", "lock_failed", "lock_acquire_changed", "lock_release_changed", "lock_release_failed"].map((key) => [key, key]));
(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-lock-")));
  const files = createDurableStoreFiles({ fs, error: LockError, codes });
  let release, entered;
  const hold = new Promise((resolve) => { release = resolve; });
  const entry = new Promise((resolve) => { entered = resolve; });
  const target = path.join(root, "admission");
  const first = files.withAsyncWriterLock(target, async () => { entered(); await hold; });
  await entry;
  try {
    assert.throws(() => files.withWriterLock(target, () => assert.fail("second writer entered during awaited setup")), (e) => e.code === "locked");
    release(); await first;
    assert.equal(files.withWriterLock(target, () => "next admission"), "next admission");
  } finally { release(); await first; fs.rmSync(root, { recursive: true }); }
  assert.equal(getSharedResourceRuntimeOwner(), getSharedResourceRuntimeOwner());
  const owner = createResourceRuntimeOwner();
  assert.equal(owner.ownsWorkerGeneration("foreign"), false);
  assert.equal((await owner.stopWorkerGeneration("foreign")).owned, false);
  if (process.platform !== "linux") {
    const result = await owner.runControlChild(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "tree-input\n", encoding: "utf8", timeout: 3000 });
    assert.equal(result.stdout, "tree-input\n");
    assert.equal(owner.runControlChildSync(process.execPath, ["-e", "process.stdout.write('sync')"], { encoding: "utf8", timeout: 3000 }), "sync");
    await assert.rejects(owner.runControlChild(process.execPath, ["-e", "process.exit(17)"], { timeout: 3000 }), (e) => e.code === 17);
  }
  console.log("resource-linux-launcher: awaited host lock, singleton, ownership refusal and native stdin/error behavior passed");
})().catch((e) => { console.error(e); process.exitCode = 1; });
