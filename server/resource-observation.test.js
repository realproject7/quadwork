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
const PROC_SELF_CGROUP = "/test-proc/self/cgroup";
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
    "memory.low": "4096\n",
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
  controlClassName,
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
      procSelfCgroupPath: PROC_SELF_CGROUP,
      ...(controlClassName === undefined ? {} : { controlClassName }),
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
      memory_low: { kind: "finite", bytes: "4096" },
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
    args: ["--user", "--property=ControlGroup", "--value", "show", workerUnit],
    options: {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
    },
  }]);
  assert.equal(Object.hasOwn(calls.exec[0].options, "shell"), false, "systemctl never uses a shell");
  assert.equal(calls.read.length, 8);
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
    "memory.low": "0",
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
  const apiControlGroup = "/system.slice/pm2-quadwork.service";
  const apiPath = path.join(CGROUP_ROOT, apiControlGroup);
  const files = fixtureFiles(apiPath, {
    "memory.events.local": "oom_kill 0\n",
    "memory.current": "1000001",
    "memory.peak": "2000001",
    "memory.swap.current": "3000001",
    "memory.low": "4000001",
    "memory.high": "5000001",
    "memory.max": "6000001",
    "memory.swap.max": "7000001",
  });
  files.set(PROC_SELF_CGROUP, `0::${apiControlGroup}\n`);
  const { provider, calls } = createHarness({ files });
  const observation = provider.observeApiSelf();
  assert.deepEqual(observation, {
    available: true,
    status: "ready",
    reason: null,
    resource_class: "api",
    unit_base: null,
    unit_name: "pm2-quadwork.service",
    self: true,
    observed_at: NOW.toISOString(),
    usage: {
      memory_current_bytes: "1000001",
      memory_peak_bytes: "2000001",
      memory_swap_current_bytes: "3000001",
    },
    limits: {
      memory_low: { kind: "finite", bytes: "4000001" },
      memory_high: { kind: "finite", bytes: "5000001" },
      memory_max: { kind: "finite", bytes: "6000001" },
      memory_swap_max: { kind: "finite", bytes: "7000001" },
    },
    counters: { oom_kill: "0", source: "local" },
  });
  assert.equal(calls.exec.length, 0, "API self observation is resolved from injected proc data");
  assert.deepEqual(calls.read[0], { filePath: PROC_SELF_CGROUP, encoding: "utf8" });
  const serialized = JSON.stringify(observation);
  assert.equal(serialized.includes(CGROUP_ROOT), false);
  assert.equal(serialized.includes("system.slice"), false);
}

{
  const controlUnit = "quadwork-control.slice";
  const controlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${controlUnit}`;
  const controlPath = path.join(CGROUP_ROOT, controlGroup);
  const files = fixtureFiles(controlPath, {
    "memory.events.local": "oom_kill 11\n",
    "memory.low": "max",
  });
  const { provider, calls } = createHarness({ controlGroup, files });
  const observation = provider.observeControlAggregate();
  assert.equal(observation.resource_class, "control");
  assert.equal(observation.aggregate, true);
  assert.equal(observation.unit_base, null);
  assert.equal(observation.unit_name, controlUnit);
  assert.deepEqual(observation.limits.memory_low, { kind: "infinite" });
  assert.deepEqual(observation.counters, { oom_kill: "11", source: "local" });
  assert.deepEqual(calls.exec, [{
    command: "systemctl",
    args: ["--user", "--property=ControlGroup", "--value", "show", controlUnit],
    options: {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
    },
  }], "aggregate observation pins canonical options-before-command argv");
  assert.equal(Object.hasOwn(calls.exec[0].options, "shell"), false);
  assert.notEqual(observation.unit_name, workerUnit, "aggregate control is not inferred from a child");
}

{
  const controlUnit = "quadwork-control-refresh.slice";
  const controlGroup = `/user.slice/app.slice/${controlUnit}`;
  const files = fixtureFiles(path.join(CGROUP_ROOT, controlGroup));
  const { provider } = createHarness({ controlGroup, files, controlClassName: controlUnit });
  assert.equal(provider.observeControlAggregate().unit_name, controlUnit);
}

{
  const files = fixtureFiles();
  files.delete(path.join(workerPath, "memory.events.local"));
  files.set(path.join(workerPath, "memory.events"), "oom 9\noom_kill 8\n");
  const observation = createHarness({ files }).provider.observeWorker(workerIdentity);
  assert.deepEqual(observation.counters, { oom_kill: "8", source: "hierarchical" });
}

{
  const apiControlGroup = "/system.slice/pm2-quadwork.service";
  const apiPath = path.join(CGROUP_ROOT, apiControlGroup);
  const files = fixtureFiles(apiPath);
  files.set(PROC_SELF_CGROUP, `0::${apiControlGroup}\n`);
  files.delete(path.join(apiPath, "memory.events.local"));
  files.set(path.join(apiPath, "memory.events"), "oom 2\noom_kill 1\n");
  const observation = createHarness({ files }).provider.observeApiSelf();
  assert.deepEqual(observation.counters, { oom_kill: "1", source: "hierarchical" });
}

for (const procValue of [
  "",
  "0::/",
  "0::relative",
  "0:://system.slice/pm2-quadwork.service",
  "0::/system.slice/./pm2-quadwork.service",
  "0::/system.slice/child/../pm2-quadwork.service",
  "0::/system.slice/pm2-quadwork.service/",
  "0::/system.slice/not-a-unit",
  "0::/system.slice/.service",
  "0::/system.slice/.scope",
  "0::/system.slice/.slice",
  "0::/system.slice/bad\tname.service",
  " 0::/system.slice/pm2-quadwork.service",
  "0::/system.slice/pm2-quadwork.service ",
  "0::/system.slice/pm2-quadwork.service\n\n",
  "0::/system.slice/pm2-quadwork.service\n0::/other.slice/other.service",
  "1:name=/system.slice/legacy.service\n0::/system.slice/pm2-quadwork.service",
]) {
  const files = new Map([[PROC_SELF_CGROUP, procValue]]);
  const { provider, calls } = createHarness({ files });
  const observation = provider.observeApiSelf();
  assert.equal(observation.available, false);
  assert.equal(observation.reason, "self_cgroup_invalid", `invalid proc value ${JSON.stringify(procValue)}`);
  assert.equal(observation.self, true);
  assert.equal(observation.unit_name, null);
  assert.equal(calls.exec.length, 0);
  assert.equal(calls.read.length, 1, "invalid lexical self path is never used for cgroup reads");
  assert.equal(JSON.stringify(observation).includes("system.slice"), false);
}

{
  const escapedUnit = "quadwork\\x2dapi@blue.service";
  const escapedControlGroup = `/system.slice/${escapedUnit}`;
  const escapedPath = path.join(CGROUP_ROOT, escapedControlGroup);
  const files = fixtureFiles(escapedPath, { "memory.events.local": "oom_kill 0\n" });
  files.set(PROC_SELF_CGROUP, `0::${escapedControlGroup}\n`);
  const observation = createHarness({ files }).provider.observeApiSelf();
  assert.equal(observation.available, true);
  assert.equal(observation.unit_name, escapedUnit);
}

{
  const { provider } = createHarness({ files: new Map() });
  const observation = provider.observeApiSelf();
  assert.equal(observation.reason, "self_cgroup_unavailable");
  assert.equal(JSON.stringify(observation).includes("SECRET_PATH"), false);
}

{
  const apiControlGroup = "/system.slice/pm2-quadwork.service";
  const apiPath = path.join(CGROUP_ROOT, apiControlGroup);
  const files = fixtureFiles(apiPath);
  files.set(PROC_SELF_CGROUP, `0::${apiControlGroup}\n`);
  files.delete(path.join(apiPath, "memory.low"));
  const observation = createHarness({ files }).provider.observeApiSelf();
  assert.equal(observation.reason, "cgroup_unavailable");
  assert.equal(observation.unit_name, "pm2-quadwork.service");
  assert.equal(JSON.stringify(observation).includes(apiControlGroup), false);
}

{
  const hostile = { toString() { throw new Error("secret hostile proc value"); } };
  const files = new Map([[PROC_SELF_CGROUP, hostile]]);
  const observation = createHarness({ files }).provider.observeApiSelf();
  assert.equal(observation.reason, "self_cgroup_invalid");
  assert.equal(JSON.stringify(observation).includes("secret"), false);
}

for (const controlGroup of [
  `/../../etc/${workerUnit}`,
  "/user.slice/other.scope",
  "/",
  "relative/path",
  ` ${workerControlGroup}`,
  `${workerControlGroup} `,
  `${workerControlGroup}\n`,
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
for (const controlClassName of [
  "other.slice",
  "quadwork-control.service",
  "quadwork-control/escape.slice",
  "QuadWork-control.slice",
]) {
  assert.throws(
    () => new ResourceObservationProvider({ execFileSyncImpl() {}, controlClassName }),
    /controlClassName/,
  );
}

console.log("resource-observation.test.js: all assertions passed");
