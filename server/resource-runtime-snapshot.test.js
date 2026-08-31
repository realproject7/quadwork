"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
} = require("./resource-policy");
const { runResourcePreflight } = require("./resource-preflight");
const { createResourceSnapshot } = require("./resource-state");
const { createWorkerUnitBase, scopeUnitFromBase } = require("./resource-unit");
const {
  MIB_BYTES,
  UINT64_MAX,
  buildResourceRuntimeSnapshot,
  persistResourceRuntimeSnapshot,
} = require("./resource-runtime-snapshot");

const OBSERVED_AT = "2026-08-31T04:00:00.000Z";
const FINISHED_AT = "2026-08-31T04:00:01.000Z";

function policy(overrides = {}) {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
    ...overrides,
  };
}

function probes(overrides = {}) {
  return {
    memory: () => ({ totalMib: 8192, availableMib: 4000, swapTotalMib: 8192, swapFreeMib: 7000 }),
    containment: () => ({ cgroupV2: true, userManager: true, systemdRun: true, scopeProof: true }),
    temp: () => ({
      exists: true,
      directory: true,
      symlink: false,
      owned: true,
      secureMode: true,
      diskBacked: true,
      freeMib: 5000,
      totalMib: 10000,
    }),
    api: () => ({ memoryLowMib: 512, memoryMaxMib: 1280, oomPolicy: "continue", separateFromWorkers: true }),
    activeScopes: () => 1,
    ...overrides,
  };
}

function finiteMib(mib) {
  return { kind: "finite", bytes: (BigInt(mib) * MIB_BYTES).toString(10) };
}

function finiteBytes(bytes) {
  return { kind: "finite", bytes: BigInt(bytes).toString(10) };
}

function infinite() {
  return { kind: "infinite" };
}

function observation({
  resourceClass,
  unitBase = null,
  unitName,
  self = false,
  aggregate = false,
  current = MIB_BYTES + 1n,
  peak = 3n * MIB_BYTES,
  swapCurrent = 0n,
  low,
  high,
  max,
  swapMax,
  oomKill = 0n,
} = {}) {
  return {
    available: true,
    status: "ready",
    reason: null,
    resource_class: resourceClass,
    unit_base: unitBase,
    unit_name: unitName,
    ...(self ? { self: true } : {}),
    ...(aggregate ? { aggregate: true } : {}),
    observed_at: OBSERVED_AT,
    usage: {
      memory_current_bytes: current.toString(10),
      memory_peak_bytes: peak.toString(10),
      memory_swap_current_bytes: swapCurrent.toString(10),
    },
    limits: {
      memory_low: low,
      memory_high: high,
      memory_max: max,
      memory_swap_max: swapMax,
    },
    counters: { oom_kill: oomKill.toString(10), source: "local" },
  };
}

function workerIdentity(projectId = "quadwork", generationId = "generation-7") {
  const unitBase = createWorkerUnitBase({ projectId, generationId });
  return { projectId, generationId, unitBase, unitName: scopeUnitFromBase(unitBase) };
}

function workerObservation(identity, configured = policy(), overrides = {}) {
  return observation({
    resourceClass: "worker",
    unitBase: identity.unitBase,
    unitName: identity.unitName,
    low: finiteBytes(0),
    high: finiteMib(configured.worker.memory_high_mib),
    max: finiteMib(configured.worker.memory_max_mib),
    swapMax: finiteMib(configured.worker.swap_max_mib),
    ...overrides,
  });
}

function apiObservation(configured = policy(), overrides = {}) {
  return observation({
    resourceClass: "api",
    unitName: "pm2-quadwork.service",
    self: true,
    low: finiteMib(configured.api.memory_low_mib),
    high: infinite(),
    max: finiteMib(configured.api.memory_max_mib),
    swapMax: infinite(),
    ...overrides,
  });
}

function controlObservation(configured = policy(), overrides = {}) {
  return observation({
    resourceClass: "control",
    unitName: "quadwork-control.slice",
    aggregate: true,
    current: 2n * MIB_BYTES,
    low: finiteBytes(0),
    high: infinite(),
    max: finiteMib(configured.control.memory_max_mib),
    swapMax: finiteMib(configured.control.swap_max_mib),
    ...overrides,
  });
}

function terminalFact(identity, overrides = {}) {
  return {
    project_id: identity.projectId,
    generation_id: identity.generationId,
    resource_class: "worker",
    unit_name: identity.unitBase,
    reason: "oom_kill",
    exit_code: null,
    signal: "SIGKILL",
    finished_at: FINISHED_AT,
    ...overrides,
  };
}

function controller(identity, configured = policy(), overrides = {}) {
  const fact = terminalFact(identity);
  return {
    protocol_status: "supported",
    control_children: { limit: configured.control.max_concurrent_children, active: 0, queued: 0 },
    control_class: { unit_name: "quadwork-control.slice", aggregate: true },
    active_scopes: [{
      project_id: identity.projectId,
      generation_id: identity.generationId,
      resource_class: "worker",
      unit_name: identity.unitBase,
      limits: {
        memory_high_mib: configured.worker.memory_high_mib,
        memory_max_mib: configured.worker.memory_max_mib,
        swap_max_mib: configured.worker.swap_max_mib,
      },
      started_at: "2026-08-31T03:59:00.000Z",
    }],
    last_cgroup_oom: {
      project_id: identity.projectId,
      generation_id: identity.generationId,
      resource_class: "worker",
      unit_name: identity.unitBase,
      oom_kill_count: "1",
      observed_at: OBSERVED_AT,
    },
    terminal_facts: [fact],
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const configured = overrides.runtimeResources || policy();
  const identity = overrides.identity || workerIdentity();
  return {
    runtimeResources: configured,
    preflightReport: runResourcePreflight({ runtimeResources: configured, probes: probes() }),
    controllerSnapshot: controller(identity, configured),
    apiObservation: apiObservation(configured),
    controlObservation: controlObservation(configured),
    workerObservations: [workerObservation(identity, configured)],
    ...overrides,
  };
}

{
  const input = fixture();
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.pressure, { status: "ready", reason: "ok" });
  assert.deepEqual(snapshot.counts, {
    active_worker_scopes: 1,
    active_control_children: 0,
    queued_control_children: 0,
  });
  assert.equal(snapshot.limits.api_memory_low_mib, 512);
  assert.equal(snapshot.limits.api_memory_max_mib, 1280);
  assert.equal(snapshot.limits.control_memory_max_mib, 512);
  assert.equal(snapshot.limits.worker_memory_max_mib, 1200);
  assert.deepEqual(snapshot.usage, {
    host_memory_total_mib: 8192,
    host_memory_available_mib: 4000,
    swap_total_mib: 8192,
    swap_free_mib: 7000,
    worker_memory_mib: 2,
    control_memory_mib: 2,
    api_memory_mib: 2,
    static_reservation_mib: 6928,
    static_headroom_mib: 1264,
    configured_swap_mib: 1792,
    swap_headroom_mib: 6400,
  }, "non-divisible exact byte usage is summed first and conservatively ceiled");
  assert.deepEqual(snapshot.temp, { disk_backed: true, free_mib: 5000, total_mib: 10000 });
  assert.deepEqual(snapshot.scope_capacity, {
    admitted_worker_scopes: 1,
    reserved_worker_scopes: 3,
    requested_worker_scopes: 1,
  });
  assert.equal(snapshot.resource_usage.worker.memory_current_bytes, (MIB_BYTES + 1n).toString(10));
  assert.equal(snapshot.effective_limits.api.memory_low.bytes, (512n * MIB_BYTES).toString(10));
  assert.equal(snapshot.effective_limits.control.memory_high.kind, "infinite");
  assert.equal(snapshot.effective_limits.worker.observed_scopes, 1);
  assert.deepEqual(snapshot.last_cgroup_oom, input.controllerSnapshot.last_cgroup_oom);
  assert.equal(snapshot.terminal_facts[0].reason, "oom_kill");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.pressure), true);
  assert.equal(Object.isFrozen(snapshot.resource_usage), true);
  assert.equal(createResourceSnapshot(snapshot).status, "ready", "runtime output is ResourceStateStore-compatible");
  const json = JSON.stringify(snapshot);
  assert.equal(json.includes(DEFAULT_RUNTIME_RESOURCE_PROPOSAL.temp_root), false);
  assert.equal(json.includes("command"), false);
  assert.equal(json.includes("args"), false);
  assert.equal(json.includes("environment"), false);
}

{
  const input = fixture();
  input.controllerSnapshot = { ...input.controllerSnapshot, protocol_status: "candidate_pending_staging" };
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "candidate_pending_staging");
  assert.deepEqual(snapshot.pressure, {
    status: "candidate_pending_staging",
    reason: "staging_proof_pending",
  });
  assert.notEqual(snapshot.status, "ready", "read-only staging evidence never flips the controller candidate");
}

{
  const input = fixture();
  input.preflightReport = runResourcePreflight({
    runtimeResources: input.runtimeResources,
    probes: probes({ containment: () => ({ cgroupV2: true, userManager: true, systemdRun: true, scopeProof: false }) }),
  });
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "containment_unavailable");
  assert.equal(snapshot.pressure.reason, "preflight_containment_unavailable");
}

{
  const input = fixture();
  input.preflightReport = runResourcePreflight({
    runtimeResources: input.runtimeResources,
    probes: probes({
      memory: () => ({ totalMib: 8192, availableMib: 2735, swapTotalMib: 8192, swapFreeMib: 7000 }),
    }),
  });
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "capacity_exhausted");
  assert.equal(snapshot.usage.host_memory_available_mib, 2735, "non-ready snapshots retain redacted host facts");
  assert.equal(Object.hasOwn(snapshot.usage, "static_headroom_mib"), false);
}

for (const [index, mutate] of [
  (input) => { input.apiObservation = { ...input.apiObservation, available: false, reason: "secret /path" }; },
  (input) => { input.controlObservation = { ...input.controlObservation, aggregate: false }; },
  (input) => {
    input.workerObservations[0] = {
      ...input.workerObservations[0],
      limits: { ...input.workerObservations[0].limits, memory_max: finiteMib(1199) },
    };
  },
  (input) => {
    const other = workerIdentity("quadwork", "other-generation");
    input.workerObservations[0] = workerObservation(other);
  },
  (input) => { input.controllerSnapshot.active_scopes[0].unit_name = "quadwork-worker-" + "a".repeat(40); },
  (input) => { input.apiObservation = { ...input.apiObservation, unit_name: ".service" }; },
  (input) => { input.apiObservation = { ...input.apiObservation, unit_name: "no-systemd-suffix" }; },
  (input) => {
    input.controllerSnapshot = {
      ...input.controllerSnapshot,
      control_class: { unit_name: "other.slice", aggregate: true },
    };
  },
].entries()) {
  const input = fixture();
  mutate(input);
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "containment_unavailable");
  assert.equal(snapshot.pressure.reason, index === 4 || index === 7
    ? "controller_snapshot_invalid"
    : "runtime_observation_inconsistent");
  assert.equal(JSON.stringify(snapshot).includes("secret /path"), false);
}

{
  const input = fixture();
  const secret = "HOSTILE-GETTER-SECRET";
  Object.defineProperty(input.apiObservation, "usage", { get() { throw new Error(secret); } });
  const hostileWorkers = new Proxy([], { get(target, key, receiver) {
    if (key === "length") throw new Error(secret);
    return Reflect.get(target, key, receiver);
  } });
  input.workerObservations = hostileWorkers;
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "containment_unavailable");
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(snapshot.resource_usage, null);
}

{
  const input = fixture();
  input.preflightReport = { ...input.preflightReport, private_path: "/private/secret" };
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "containment_unavailable", "unknown preflight fields cannot retain ready authority");
  assert.equal(JSON.stringify(snapshot).includes("private/secret"), false);
}

{
  const input = fixture();
  input.runtimeResources = Object.defineProperty({}, "version", {
    enumerable: true,
    get() { throw new Error("POLICY-SECRET"); },
  });
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "invalid_resource_policy");
  assert.equal(snapshot.pressure.reason, "policy_invalid_or_absent");
  assert.equal(JSON.stringify(snapshot).includes("POLICY-SECRET"), false);
}

{
  const input = fixture();
  const old = workerIdentity("quadwork", "old-generation");
  input.controllerSnapshot = {
    ...input.controllerSnapshot,
    last_cgroup_oom: {
      project_id: old.projectId,
      generation_id: old.generationId,
      resource_class: "worker",
      unit_name: old.unitBase,
      oom_kill_count: "2",
      observed_at: "2026-08-31T03:00:00.000Z",
    },
    terminal_facts: [
      terminalFact(old, { finished_at: "2026-08-31T03:00:01.000Z" }),
      terminalFact(workerIdentity(), { reason: "normal_exit", exit_code: 0, signal: null }),
    ],
  };
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.last_cgroup_oom, null, "stale provenance cannot remain the qualified latest observation");
  assert.equal(snapshot.terminal_facts[0].reason, "unknown", "stale global provenance cannot authorize an old OOM fact");
  assert.equal(snapshot.terminal_facts[1].reason, "normal_exit");

  input.controllerSnapshot.last_cgroup_oom = { oom_kill_count: "7", observed_at: OBSERVED_AT };
  const legacy = buildResourceRuntimeSnapshot(input);
  assert.equal(legacy.last_cgroup_oom, null, "legacy unqualified OOM data is rejected");
}

{
  const configured = policy({
    host_reserve_mib: 1,
    max_worker_scopes: 2,
    api: { memory_low_mib: 1, memory_max_mib: 1 },
    worker: { memory_high_mib: 8_796_093_022_206, memory_max_mib: 8_796_093_022_207, swap_max_mib: 1 },
    control: { memory_max_mib: 1, swap_max_mib: 1, max_concurrent_children: 1 },
    temp_min_free_mib: 1,
  });
  const first = workerIdentity("p", "g1");
  const second = workerIdentity("p", "g2");
  const hugeBytes = UINT64_MAX / 2n + 1n;
  const hugeProbes = probes({
    memory: () => ({
      totalMib: 17_592_186_044_417,
      availableMib: 17_592_186_044_417,
      swapTotalMib: 3,
      swapFreeMib: 3,
    }),
    api: () => ({ memoryLowMib: 1, memoryMaxMib: 1, oomPolicy: "continue", separateFromWorkers: true }),
    temp: () => ({ exists: true, directory: true, symlink: false, owned: true, secureMode: true, diskBacked: true, freeMib: 2, totalMib: 3 }),
    activeScopes: () => 2,
  });
  const controllerSnapshot = controller(first, configured, {
    control_children: { limit: 1, active: 0, queued: 0 },
    active_scopes: [first, second].map((identity) => ({
      project_id: identity.projectId,
      generation_id: identity.generationId,
      resource_class: "worker",
      unit_name: identity.unitBase,
      limits: {
        memory_high_mib: configured.worker.memory_high_mib,
        memory_max_mib: configured.worker.memory_max_mib,
        swap_max_mib: configured.worker.swap_max_mib,
      },
    })),
    last_cgroup_oom: null,
    terminal_facts: [],
  });
  const input = {
    runtimeResources: configured,
    preflightReport: runResourcePreflight({ runtimeResources: configured, probes: hugeProbes, requestedWorkerScopes: 0 }),
    controllerSnapshot,
    apiObservation: apiObservation(configured, { current: 0n, peak: 0n }),
    controlObservation: controlObservation(configured, { current: 0n, peak: 0n }),
    workerObservations: [first, second].map((identity) => workerObservation(identity, configured, {
      current: hugeBytes,
      peak: hugeBytes,
    })),
  };
  const snapshot = buildResourceRuntimeSnapshot(input);
  assert.equal(snapshot.status, "containment_unavailable");
  assert.equal(snapshot.resource_usage, null, "checked BigInt addition rejects an aggregate above uint64");
}

{
  let saves = 0;
  let savedValue = null;
  const store = { save(value) { saves += 1; savedValue = value; return createResourceSnapshot(value); } };
  const snapshot = buildResourceRuntimeSnapshot(fixture());
  assert.equal(saves, 0, "pure collection never persists implicitly");
  const persisted = persistResourceRuntimeSnapshot(store, snapshot);
  assert.equal(saves, 1);
  assert.equal(savedValue, snapshot);
  assert.equal(persisted.status, "ready");
  assert.equal(Object.hasOwn(persisted, "pressure"), false, "state persistence keeps only its allowlist");
  assert.throws(() => persistResourceRuntimeSnapshot({}, snapshot), /store\.save/);
  const hostileStore = Object.defineProperty({}, "save", { get() { throw new Error("STORE-SECRET"); } });
  assert.throws(() => persistResourceRuntimeSnapshot(hostileStore, snapshot), /store\.save/);
}

console.log("resource-runtime-snapshot.test.js: all assertions passed");
