"use strict";
// Unit-only proc/cgroup dependency facts. The source verifier itself performs
// each read and rejects changed facts; no actual staging PASS is asserted.
const assert = require("node:assert/strict");
const Module = require("node:module");
const F = require("./resource-linux-facts");
const target = require.resolve("./resource-staging-observation");
const pid = 100, tids = Array.from({ length: 23 }, (_, i) => pid + i);
const group = "/fixture/worker-group.slice/exact.scope", protectedGroups = ["/fixture/api", "/fixture/survivor"];
const main = { pid, startTime: "123", cgroup: group };
let variation = null, processReads = 0, capsReads = 0;
const fixtureFacts = {
  ...F,
  readProcess(id) {
    processReads++;
    if (variation === "exited") F.fail("process_identity_changed");
    return { pid: id, startTime: variation === "pid-reused" && id === pid ? "456" : "123",
      cgroup: variation === "foreign-thread" && id === pid + 1 ? "/foreign" : group };
  },
  verifyWorkerGroup(actualGroup, limits, protectedPaths) {
    capsReads++;
    assert.equal(actualGroup, group); assert.deepEqual(protectedPaths, protectedGroups);
    assert.deepEqual(limits, { memoryHighMib: 96, memoryMaxMib: 128, swapMaxMib: 16 });
    if (variation === "caps") F.fail("worker_limits_mismatch");
  },
  readGroup(actualGroup) {
    assert.equal(actualGroup, "/fixture/worker-group.slice");
    return { pids: variation === "foreign-parent" ? [999] : [], events: { oom_kill: variation === "prior-oom" ? 1 : 0 } };
  },
  text(file) {
    const match = /^\/proc\/100\/task\/(\d+)\/comm$/.exec(file); assert.ok(match);
    const id = Number(match[1]);
    return id > pid && id <= pid + (variation === "pool-size" ? 15 : 16) ? "libuv-worker\n" : "node\n";
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, mainModule) {
  if (parent?.filename === target) {
    if (request === "./resource-linux-facts") return fixtureFacts;
    if (request === "node:fs") return { readdirSync(file) { assert.equal(file, "/proc/100/task"); return (variation === "thread-set" ? [...tids, 124] : tids).map(String); } };
  }
  return originalLoad.call(this, request, parent, mainModule);
};
let verifyPressureRelease;
try { ({ verifyPressureRelease } = require(target)); } finally { Module._load = originalLoad; }
const armed = { kind: "allocation_armed", pid, pool_size: 16, tids, buffers: 20, buffer_bytes: 8388608, bytes: 167772160 };
const pressure = (records = [armed]) => ({ main, group, threadIds: tids, stream: { records } });
const observed = verifyPressureRelease(pressure(), protectedGroups, 0);
assert.equal(observed.reserved_bytes, 167772160); assert.equal(observed.submitted_buffers, null);
assert.equal(observed.completed_bytes, 0); assert.equal(capsReads, 1); assert.equal(processReads, tids.length + 2);
for (const [mode, check] of [
  ["prior-oom", "oom_before_release"], ["foreign-parent", "parent_slice_has_foreign_process"],
  ["pid-reused", "process_identity_changed"], ["exited", "process_identity_changed"],
  ["foreign-thread", "allocation_thread_uncontained"], ["pool-size", "allocation_pool_unproven"],
  ["thread-set", "allocation_pool_unproven"], ["caps", "worker_limits_mismatch"],
]) {
  variation = mode;
  assert.throws(() => verifyPressureRelease(pressure(), protectedGroups, 0), (e) => e.check === check, mode);
}
variation = null;
for (const records of [[], [{ ...armed, pid: 999 }], [{ ...armed, bytes: 1 }], [armed, armed]]) {
  processReads = 0;
  assert.throws(() => verifyPressureRelease(pressure(records), protectedGroups, 0), (e) => e.check === "allocation_observation_invalid");
  assert.equal(processReads, 0, "missing/foreign/malformed/duplicate armed facts cannot reach release verification");
}
for (const row of [
  { kind: "allocation_threads_after", pid, pool_size: 16, tids, requested_buffers: 20 },
  { kind: "allocation", pid, index: 0, bytes: 8388608, mib: 8 },
]) assert.throws(() => verifyPressureRelease(pressure([armed, row]), protectedGroups, 0), (e) => e.check === "allocation_before_release");
console.log("resource-pressure-release: actual source rereads and pre-release OOM/identity/caps/thread/record refusals passed (unit OS facts only)");
