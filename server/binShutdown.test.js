"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCleanExit } = require("../bin/quadwork");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-bin-shutdown-"));
const pidFile = path.join(temp, "server.pid");
const originalLog = console.log;
const originalWarn = console.warn;
const output = [];
console.log = (...args) => output.push(args.join(" "));
console.warn = (...args) => output.push(args.join(" "));

(async () => {
  for (const outcome of ["success", "unconfirmed", "rejected"]) {
    output.length = 0;
    fs.writeFileSync(pidFile, "1234");
    let resolve;
    let reject;
    const deferred = new Promise((yes, no) => { resolve = yes; reject = no; });
    let calls = 0;
    const exits = [], reports = [];
    const cleanExit = createCleanExit({ shutdown: () => { calls += 1; return deferred; } }, pidFile, (code) => exits.push(code), async (code) => {
      assert.deepEqual(exits, [], "shutdown outcome reaches the instance owner before exit");
      reports.push(code);
    });
    const completion = cleanExit();
    assert.equal(cleanExit(), completion, "repeated signals join the same CLI operation");
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.deepEqual(exits, [], "CLI cannot exit while server cleanup is pending");
    assert.equal(fs.existsSync(pidFile), true, "PID ownership is retained while cleanup is pending");
    assert.equal(output.some((line) => line.includes("Stopped.")), false);
    if (outcome === "rejected") reject(new Error("fixture cleanup failed"));
    else resolve({ ok: outcome === "success", cleanup_errors: outcome === "success" ? [] : [{ code: "pty_stop_failed" }] });
    await completion;
    assert.deepEqual(exits, [outcome === "success" ? 0 : 1]);
    assert.deepEqual(reports, exits);
    assert.equal(output.some((line) => line.includes("Stopped.")), outcome === "success");
    assert.equal(output.some((line) => line.includes("Shutdown incomplete")), outcome !== "success");
    assert.equal(fs.existsSync(pidFile), true, "only the external requester can confirm process exit and remove its exact receipt");
    assert.equal(cleanExit(), completion);
    assert.equal(calls, 1);
  }
})().then(() => originalLog("binShutdown.test.js: awaited success, failure, rejection and repeated signals passed"), (err) => {
  process.exitCode = 1;
  console.error(err);
}).finally(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  fs.rmSync(temp, { recursive: true, force: true });
});
