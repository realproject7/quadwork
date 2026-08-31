"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {
  createWorkerUnitBase,
  createControlUnitBase,
  scopeUnitFromBase,
} = require("./resource-unit");
const {
  UINT64_MAX,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  ResourceObservationProvider,
} = require("./resource-observation");

const CGROUP_ROOT = "/test-cgroup-v2";
const NOW = new Date("2026-08-31T01:02:03.456Z");
const workerIdentity = { projectId: "project-one", generationId: "generation-7" };
const workerBase = createWorkerUnitBase(workerIdentity);
const workerUnit = scopeUnitFromBase(workerBase);
const workerControlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${workerUnit}`;
const workerPath = path.join(CGROUP_ROOT, workerControlGroup);

function fixtureFiles(cgroupPath = workerPath, overrides = {}) {
  const values = {
    "memory.events.local": "low 0\nhigh 1\nmax 2\noom 3\noom_kill 4\noom_group_kill 0\n",
    "memory.current": "1048577\n",
    "memory.peak": "2097153\n",
    "memory.swap.current": "17\n",
    "memory.high": "max\n",
    "memory.max": `${UINT64_MAX}\n`,
    "memory.swap.max": "max\n",
    ...overrides,
  };
  return new Map(Object.entries(values).map(([name, value]) => [path.join(cgroupPath, name), value]));
}

function enoent(filePath) {
  const error = new Error(`missing SECRET_PATH ${filePath}`);
  error.code = "ENOENT";
  return error;
}

function createHarness({
  controlGroup = workerControlGroup,
  files = fixtureFiles(),
  execError = null,
  execOutput,
  clock = () => NOW,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  const calls = { exec: [], read: [] };
  const fsImpl = {
    readFileSync(filePath, encoding) {
      calls.read.push({ filePath, encoding });
      if (!files.has(filePath)) throw enoent(filePath);
      const value = files.get(filePath);
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const execFileSyncImpl = (command, args, options) => {
    calls.exec.push({ command, args, options });
    if (execError) throw execError;
    return execOutput === undefined ? `${controlGroup}\n` : execOutput;
  };
  return {
    calls,
    provider: new ResourceObservationProvider({
      fsImpl,
      execFileSyncImpl,
      clock,
      cgroupRoot: CGROUP_ROOT,
      timeoutMs,
      maxOutputBytes,
    }),
  };
}

{
  const { provider, calls } = createHarness();
  const observation = provider.observeWorker(workerIdentity);
  assert.deepEqual(observation, {
    available: true,
    status: "ready",
    reason: null,
    resource_class: "worker",
    unit_base: workerBase,
    unit_name: workerUnit,
    observed_at: NOW.toISOString(),
    usage: {
      memory_current_bytes: "1048577",
      memory_peak_bytes: "2097153",
      memory_swap_current_bytes: "17",
    },
    limits: {
      memory_high: { kind: "infinite" },
      memory_max: { kind: "finite", bytes: UINT64_MAX.toString(10) },
      memory_swap_max: { kind: "infinite" },
    },
    counters: { oom_kill: "4", source: "local" },
  });
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.usage), true);
  assert.equal(Object.isFrozen(observation.limits.memory_max), true);
  assert.deepEqual(calls.exec, [{
    command: "systemctl",
    args: ["--user", "show", workerUnit, "--property=ControlGroup", "--value"],
    options: {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
    },
  }]);
  assert.equal(Object.hasOwn(calls.exec[0].options, "shell"), false, "systemctl never uses a shell");
  assert.equal(calls.read.length, 7);
  assert.equal(JSON.stringify(observation).includes(CGROUP_ROOT), false);
  assert.equal(JSON.stringify(observation).includes("user.slice"), false);
}

{
  const identity = { projectId: "project-one", generationId: "generation-7", operationId: "refresh-3" };
  const base = createControlUnitBase(identity);
  const unit = scopeUnitFromBase(base);
  const controlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
  const files = fixtureFiles(path.join(CGROUP_ROOT, controlGroup), {
    "memory.events.local": "oom_kill 0\n",
    "memory.current": "1",
    "memory.peak": "2",
    "memory.swap.current": "3",
    "memory.high": "4",
    "memory.max": "5",
    "memory.swap.max": "6",
  });
  const { provider } = createHarness({ controlGroup, files });
  const observation = provider.observeControl(identity);
  assert.equal(observation.resource_class, "control");
  assert.equal(observation.unit_base, base);
  assert.equal(observation.unit_name, unit);
  assert.deepEqual(observation.limits.memory_high, { kind: "finite", bytes: "4" });
}

{
  const files = fixtureFiles();
  files.delete(path.join(workerPath, "memory.events.local"));
  files.set(path.join(workerPath, "memory.events"), "oom 9\noom_kill 8\n");
  const observation = createHarness({ files }).provider.observeWorker(workerIdentity);
  assert.deepEqual(observation.counters, { oom_kill: "8", source: "hierarchical" });
}

for (const controlGroup of [
  `/../../etc/${workerUnit}`,
  "/user.slice/other.scope",
  "/",
  "relative/path",
  `${workerControlGroup}\n/second/${workerUnit}`,
]) {
  const { provider, calls } = createHarness({ controlGroup });
  const observation = provider.observeWorker(workerIdentity);
  assert.equal(observation.available, false);
  assert.equal(observation.reason, "control_group_invalid");
  assert.equal(calls.read.length, 0, `invalid ControlGroup ${JSON.stringify(controlGroup)} is never read`);
}

for (const execOutput of ["", Buffer.alloc(DEFAULT_MAX_OUTPUT_BYTES + 1, "a"), "\0secret"] ) {
  const observation = createHarness({ execOutput }).provider.observeWorker(workerIdentity);
  assert.equal(observation.available, false);
  assert.match(observation.reason, /^(?:unit_unavailable|control_group_invalid)$/);
}

{
  const { provider } = createHarness({ execError: new Error("token=VERY_SECRET /private/path") });
  const observation = provider.observeWorker(workerIdentity);
  assert.equal(observation.reason, "unit_unavailable");
  const serialized = JSON.stringify(observation);
  assert.equal(serialized.includes("VERY_SECRET"), false);
  assert.equal(serialized.includes("private/path"), false);
  assert.deepEqual(Object.keys(observation).sort(), [
    "available", "reason", "resource_class", "status", "unit_base", "unit_name",
  ]);
}

{
  const files = fixtureFiles();
  files.delete(path.join(workerPath, "memory.current"));
  const observation = createHarness({ files }).provider.observeWorker(workerIdentity);
  assert.equal(observation.reason, "cgroup_unavailable");
  assert.equal(JSON.stringify(observation).includes("SECRET_PATH"), false);
  assert.equal(JSON.stringify(observation).includes(CGROUP_ROOT), false);
}

for (const value of ["01", "-1", "18446744073709551616", "max", "1.5", ""]) {
  const files = fixtureFiles(workerPath, { "memory.current": value });
  const observation = createHarness({ files }).provider.observeWorker(workerIdentity);
  assert.equal(observation.reason, "cgroup_data_invalid", `invalid current value ${JSON.stringify(value)}`);
}

for (const value of ["infinity", "18446744073709551616", "MAX", "01"]) {
  const files = fixtureFiles(workerPath, { "memory.high": value });
  const observation = createHarness({ files }).provider.observeWorker(workerIdentity);
  assert.equal(observation.reason, "cgroup_data_invalid", `invalid limit value ${JSON.stringify(value)}`);
}

for (const value of [
  "oom 1\n",
  "oom_kill -1\n",
  "oom_kill 1\noom_kill 2\n",
  "oom_kill 18446744073709551616\n",
  "oom_kill 01\n",
]) {
  const files = fixtureFiles(workerPath, { "memory.events.local": value });
  const observation = createHarness({ files }).provider.observeWorker(workerIdentity);
  assert.equal(observation.reason, "cgroup_data_invalid", `invalid events value ${JSON.stringify(value)}`);
}

for (const clock of [() => new Date("invalid"), () => { throw new Error("clock secret"); }]) {
  const observation = createHarness({ clock }).provider.observeWorker(workerIdentity);
  assert.equal(observation.reason, "clock_unavailable");
}

assert.throws(() => new ResourceObservationProvider(), /dependency-injected/);
assert.throws(() => new ResourceObservationProvider({ execFileSyncImpl() {}, cgroupRoot: "/" }), /filesystem root/);
assert.throws(
  () => new ResourceObservationProvider({ execFileSyncImpl() {}, timeoutMs: 60_001 }),
  /timeoutMs/,
);
assert.throws(
  () => new ResourceObservationProvider({ execFileSyncImpl() {}, maxOutputBytes: 63 }),
  /maxOutputBytes/,
);

console.log("resource-observation.test.js: all assertions passed");
