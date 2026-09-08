"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pressureObservations, controlMarker, controlObservationReady, controlFilterSource } = require("./resource-staging-observation");
const F = require("./resource-linux-facts");
const tids = Array.from({ length: 23 }, (_, i) => i + 100), pid = tids[0], size = 8 * 1024 * 1024;
const headers = [
  { kind: "allocation_armed", pid, pool_size: 16, tids, buffers: 20, buffer_bytes: size, bytes: 20 * size },
];
const armed = pressureObservations(headers, pid, tids);
assert.equal(armed.completed_bytes, 0, "OOM may occur before any read callback");
assert.equal(armed.submitted_buffers, null, "arming does not prove that reads were submitted");
assert.equal(armed.threads_after, null, "post-dispatch threads are unproved if absent");
const after = { kind: "allocation_threads_after", pid, pool_size: 16, tids, requested_buffers: 20 };
const complete = [...headers, after, ...Array.from({ length: 20 }, (_, i) => ({ kind: "allocation", pid, index: 19-i, bytes: size, mib: (i+1)*8 })), { kind: "allocation_cap_reached", pid }];
assert.equal(pressureObservations(complete, pid, tids).completed_bytes, 160 * 1024 * 1024);
assert.equal(pressureObservations(complete, pid, tids).submitted_buffers, 20);
const partial = pressureObservations([...headers, { kind: "allocation", pid, index: 7, bytes: size, mib: 8 }], pid, tids);
assert.equal(partial.completed_bytes, size); assert.equal(partial.submitted_buffers, null, "a completion cannot invent the missing complete submission record");
assert.throws(() => pressureObservations([], pid, tids));
for (const mutate of [
  (r) => { r[0].pool_size = 17; }, (r) => { r[0].bytes++; }, (r) => { r[0].buffers++; },
  (r) => { r[0].buffer_bytes--; }, (r) => { r[0].pid++; }, (r) => { r[0].tids[2] = r[0].tids[1]; },
  (r) => { r[1].requested_buffers++; }, (r) => { r[1].tids[2] = r[1].tids[1]; },
  (r) => { r[2].index = 20; }, (r) => { r[3].index = r[2].index; },
  (r) => { r[2].bytes--; }, (r) => { r[2].pid++; }, (r) => { r[2].mib = 16; },
  (r) => { r[2].kind = "allocation_failed"; }, (r) => { r.splice(2, 1); },
  (r) => { r.splice(1, 0, r[0]); }, (r) => { r.splice(2, 0, r[1]); }, (r) => { r.push(r[1]); },
]) { const copy = structuredClone(complete); mutate(copy); assert.throws(() => pressureObservations(copy, pid, tids)); }
assert.equal(controlObservationReady(2, 1, new Set([11, 12])), true);
assert.equal(controlObservationReady(2, 0, new Set([11, 12])), false, "queue must actually be observed");
assert.equal(controlObservationReady(2, 1, new Set([11])), false, "missing second marker cannot release");
assert.throws(() => controlObservationReady(3, 1, new Set([11, 12])));
assert.throws(() => controlMarker("{}", { pid: 1 }));

(async () => {
  if (process.platform === "linux") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-control-handshake-")), release = path.join(root, "release"), markers = path.join(root, "markers"); fs.mkdirSync(markers);
    try {
      for (const doRelease of [true, false]) {
        const child = spawn(process.execPath, ["-e", controlFilterSource(markers, release)], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = ""; child.stdout.on("data", (b) => { stdout += b; }); child.stderr.on("data", (b) => { stderr += b; }); child.stdin.end("exact git input\n");
        const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
        let watchdog; const bounded = Promise.race([exit, new Promise((_, reject) => { watchdog = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("filter watchdog")); }, 18000); })]);
        try {
          const marker = path.join(markers, String(child.pid)), deadline = Date.now() + 3000;
          while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
          assert.ok(fs.existsSync(marker));
          const raw = fs.readFileSync(marker, "utf8"), observed = F.readProcess(child.pid);
          assert.throws(() => controlMarker(raw, { ...observed, startTime: "changed" }));
          assert.throws(() => controlMarker(raw, observed), "uncontained test process is rejected, never fake control PASS");
          if (doRelease) fs.writeFileSync(release, "release");
          const ended = await bounded;
          assert.deepEqual(ended, { code: doRelease ? 0 : 2, signal: null });
          assert.equal(stdout, "exact git input\n"); assert.equal(stderr, "");
        } finally { clearTimeout(watchdog); if (child.exitCode === null) child.kill("SIGKILL"); await exit; if (fs.existsSync(release)) fs.unlinkSync(release); }
      }
    } finally { fs.rmSync(root, { recursive: true }); }
  }
  console.log("resource-staging-observation: strict workload records, missing/foreign markers and real bounded control handshake passed");
})().catch((e) => { console.error(e); process.exitCode = 1; });
