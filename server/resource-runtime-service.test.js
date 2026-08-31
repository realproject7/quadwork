"use strict";

// All dependencies in this file are deterministic fakes. No host probe,
// command, process, filesystem mutation, or implicit persistence is used.

const assert = require("node:assert/strict");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");
const { MIB_BYTES } = require("./resource-runtime-snapshot");
const { createWorkerUnitBase, scopeUnitFromBase } = require("./resource-unit");
const {
  MAX_ACTIVE_SCOPES,
  ResourceRuntimeService,
  createResourceRuntimeService,
} = require("./resource-runtime-service");

const OBSERVED_AT = "2026-08-31T05:00:00.000Z";
const API_UNIT = "pm2-quadwork.service";
const CONTROL_UNIT = "quadwork-control.slice";

function policy() {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
  };
}

function finiteMib(value) {
  return { kind: "finite", bytes: (BigInt(value) * MIB_BYTES).toString(10) };
}

function finiteBytes(value) {
  return { kind: "finite", bytes: BigInt(value).toString(10) };
}

function infinite() {
  return { kind: "infinite" };
}

function identity(projectId, generationId) {
  const unitBase = createWorkerUnitBase({ projectId, generationId });
  return Object.freeze({ projectId, generationId, unitBase, unitName: scopeUnitFromBase(unitBase) });
}

function workerEntry(worker, configured) {
  return {
    project_id: worker.projectId,
    generation_id: worker.generationId,
    resource_class: "worker",
    unit_name: worker.unitBase,
    started_at: "2026-08-31T04:59:00.000Z",
    limits: {
      memory_high_mib: configured.worker.memory_high_mib,
      memory_max_mib: configured.worker.memory_max_mib,
      swap_max_mib: configured.worker.swap_max_mib,
    },
  };
}

function controllerSnapshot(workers, configured, overrides = {}) {
  return {
    protocol_status: "candidate_pending_staging",
    control_children: {
      limit: configured.control.max_concurrent_children,
      active: 0,
      queued: 0,
    },
    control_class: { unit_name: CONTROL_UNIT, aggregate: true },
    active_scopes: workers.map((worker) => workerEntry(worker, configured)),
    last_cgroup_oom: null,
    terminal_facts: [],
    ...overrides,
  };
}

function observation({ resourceClass, unitBase = null, unitName, currentMib = 1, limits, qualifiers = {} }) {
  return {
    available: true,
    status: "ready",
    reason: null,
    resource_class: resourceClass,
    unit_base: unitBase,
    unit_name: unitName,
    ...qualifiers,
    observed_at: OBSERVED_AT,
    usage: {
      memory_current_bytes: (BigInt(currentMib) * MIB_BYTES).toString(10),
      memory_peak_bytes: (BigInt(currentMib + 1) * MIB_BYTES).toString(10),
      memory_swap_current_bytes: "0",
    },
    limits,
    counters: { oom_kill: "0", source: "local" },
  };
}

function apiObservation(configured) {
  return observation({
    resourceClass: "api",
    unitName: API_UNIT,
    limits: {
      memory_low: finiteMib(configured.api.memory_low_mib),
      memory_high: infinite(),
      memory_max: finiteMib(configured.api.memory_max_mib),
      memory_swap_max: infinite(),
    },
    qualifiers: { self: true },
  });
}

function controlObservation(configured) {
  return observation({
    resourceClass: "control",
    unitName: CONTROL_UNIT,
    limits: {
      memory_low: finiteBytes(0),
      memory_high: infinite(),
      memory_max: finiteMib(configured.control.memory_max_mib),
      memory_swap_max: finiteMib(configured.control.swap_max_mib),
    },
    qualifiers: { aggregate: true },
  });
}

function workerObservation(worker, configured, currentMib = 1) {
  return observation({
    resourceClass: "worker",
    unitBase: worker.unitBase,
    unitName: worker.unitName,
    currentMib,
    limits: {
      memory_low: finiteBytes(0),
      memory_high: finiteMib(configured.worker.memory_high_mib),
      memory_max: finiteMib(configured.worker.memory_max_mib),
      memory_swap_max: finiteMib(configured.worker.swap_max_mib),
    },
  });
}

function createHarness({
  workers = [],
  configured = policy(),
  protocolStatus = "candidate_pending_staging",
  probes: probeOverrides = {},
  controller,
  observations = {},
  proofAuthority,
} = {}) {
  const events = [];
  const workerCalls = [];
  const preflightProbes = {
    memory() {
      events.push("probe:memory");
      return { totalMib: 8192, availableMib: 5000, swapTotalMib: 8192, swapFreeMib: 7000 };
    },
    containment() {
      events.push("probe:containment");
      return { cgroupV2: true, userManager: true, systemdRun: true, scopeProof: true };
    },
    temp(tempRoot) {
      events.push(`probe:temp:${tempRoot}`);
      return {
        exists: true,
        directory: true,
        symlink: false,
        owned: true,
        secureMode: true,
        diskBacked: true,
        freeMib: 6000,
        totalMib: 12000,
      };
    },
    api() {
      events.push("probe:api");
      return {
        memoryLowMib: configured.api.memory_low_mib,
        memoryMaxMib: configured.api.memory_max_mib,
        oomPolicy: "continue",
        separateFromWorkers: true,
      };
    },
    activeScopes() {
      events.push("probe:activeScopes");
      return workers.length;
    },
    ...probeOverrides,
  };
  const snapshotValue = controller === undefined
    ? controllerSnapshot(workers, configured, { protocol_status: protocolStatus })
    : controller;
  const controllerAdapter = {
    snapshot() {
      events.push("controller:snapshot");
      if (snapshotValue instanceof Error) throw snapshotValue;
      return snapshotValue;
    },
  };
  const observationProvider = {
    observeApiSelf() {
      events.push("observe:api");
      if (observations.api instanceof Error) throw observations.api;
      return observations.api || apiObservation(configured);
    },
    observeControlAggregate() {
      events.push("observe:control");
      if (observations.control instanceof Error) throw observations.control;
      return observations.control || controlObservation(configured);
    },
    observeWorker(worker) {
      events.push(`observe:worker:${worker.projectId}:${worker.generationId}`);
      workerCalls.push(worker);
      if (observations.worker instanceof Error) throw observations.worker;
      const expected = workers.find((item) => (
        item.projectId === worker.projectId && item.generationId === worker.generationId
      ));
      return typeof observations.worker === "function"
        ? observations.worker(worker)
        : workerObservation(expected, configured, workerCalls.length);
    },
  };
  const service = createResourceRuntimeService({
    runtimeResources: configured,
    probes: preflightProbes,
    controllerAdapter,
    observationProvider,
    proofAuthority,
  });
  return { service, events, workerCalls, probes: preflightProbes, controllerAdapter, observationProvider };
}

// Zero workers still performs the read-only host/API/control collection. The
// preflight capacity request is exactly zero and snapshot() never persists.
{
  const { service, events, workerCalls } = createHarness();
  let saves = 0;
  const store = { save(value) { saves += 1; return value; } };
  const snapshot = service.snapshot();
  assert.equal(snapshot.status, "candidate_pending_staging");
  assert.equal(snapshot.pressure.reason, "staging_proof_pending");
  assert.deepEqual(snapshot.scope_capacity, {
    admitted_worker_scopes: 0,
    reserved_worker_scopes: 3,
    requested_worker_scopes: 0,
  });
  assert.deepEqual(snapshot.worker_scopes, []);
  assert.equal(snapshot.effective_limits.worker.observed_scopes, 0);
  assert.equal(snapshot.effective_limits.worker.limits, null);
  assert.deepEqual(workerCalls, []);
  assert.deepEqual(events, [
    "probe:memory",
    "probe:containment",
    `probe:temp:${DEFAULT_RUNTIME_RESOURCE_PROPOSAL.temp_root}`,
    "probe:api",
    "probe:activeScopes",
    "controller:snapshot",
    "observe:api",
    "observe:control",
  ]);
  assert.equal(saves, 0);
  assert.equal(Object.isFrozen(service), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(service.persist(snapshot, store), snapshot);
  assert.equal(saves, 1, "persistence occurs only through the explicit method");
}

// Multiple workers are observed once, in controller order. Only their exact
// project/generation identity crosses the provider boundary; no supplied unit
// string is accepted as an observation target.
{
  const workers = [identity("quadwork", "generation-a"), identity("other-project", "generation-b")];
  const { service, events, workerCalls } = createHarness({ workers });
  const snapshot = service.snapshot();
  assert.equal(snapshot.status, "candidate_pending_staging");
  assert.equal(snapshot.counts.active_worker_scopes, 2);
  assert.deepEqual(workerCalls.map((value) => Object.keys(value)), [
    ["projectId", "generationId"],
    ["projectId", "generationId"],
  ]);
  assert(workerCalls.every(Object.isFrozen));
  assert.deepEqual(workerCalls, workers.map(({ projectId, generationId }) => ({ projectId, generationId })));
  assert.deepEqual(snapshot.worker_scopes.map((value) => [value.project_id, value.generation_id]), [
    ["quadwork", "generation-a"],
    ["other-project", "generation-b"],
  ]);
  assert.deepEqual(events.slice(-4), [
    "observe:api",
    "observe:control",
    "observe:worker:quadwork:generation-a",
    "observe:worker:other-project:generation-b",
  ]);
}

// A supported-looking controller cannot mint ready authority while the source
// has no pinned proof receipt. Caller-provided lookalikes remain non-authority.
{
  const worker = identity("quadwork", "generation-proof");
  const { service } = createHarness({ workers: [worker], protocolStatus: "supported", proofAuthority: {} });
  const snapshot = service.snapshot();
  assert.equal(snapshot.status, "candidate_pending_staging");
  assert.equal(snapshot.pressure.reason, "proof_authority_unavailable");
}

// A failed preflight probe is reduced to typed absence. Remaining collection
// continues, and neither raw error text nor paths cross the output boundary.
{
  const secret = "PREFLIGHT-SECRET /private/host/path";
  const { service, events } = createHarness({
    probes: { memory() { throw new Error(secret); } },
  });
  const snapshot = service.snapshot();
  assert.equal(snapshot.status, "capacity_exhausted");
  assert.equal(snapshot.pressure.reason, "preflight_capacity_exhausted");
  assert.equal(events.includes("controller:snapshot"), true);
  assert.equal(events.includes("observe:api"), true);
  assert.equal(events.includes("observe:control"), true);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(JSON.stringify(snapshot).includes("/private/host/path"), false);
}

// Thrown and hostile controller facts cannot select a worker target. Independent
// API/control probes remain bounded and the returned snapshot stays redacted.
{
  const secret = "CONTROLLER-SECRET /private/controller";
  const thrown = createHarness({ controller: new Error(secret) });
  const thrownSnapshot = thrown.service.snapshot();
  assert.equal(thrownSnapshot.status, "containment_unavailable");
  assert.equal(thrownSnapshot.pressure.reason, "controller_snapshot_invalid");
  assert.deepEqual(thrown.workerCalls, []);
  assert.equal(thrown.events.includes("observe:api"), true);
  assert.equal(thrown.events.includes("observe:control"), true);
  assert.equal(JSON.stringify(thrownSnapshot).includes(secret), false);

  const hostile = controllerSnapshot([], policy());
  Object.defineProperty(hostile, "active_scopes", { get() { throw new Error(secret); } });
  const hostileHarness = createHarness({ controller: hostile });
  const hostileSnapshot = hostileHarness.service.snapshot();
  assert.equal(hostileSnapshot.status, "containment_unavailable");
  assert.deepEqual(hostileHarness.workerCalls, []);
  assert.equal(JSON.stringify(hostileSnapshot).includes(secret), false);
}

// Observation failures are absence, never exceptions or serialized provider
// reasons. A supported controller therefore remains explicitly non-ready.
{
  const worker = identity("quadwork", "generation-hostile-observation");
  const secret = "OBSERVATION-SECRET /sys/fs/cgroup/private";
  const { service, events } = createHarness({
    workers: [worker],
    protocolStatus: "supported",
    observations: {
      api: new Error(secret),
      control: new Error(secret),
      worker: new Error(secret),
    },
  });
  const snapshot = service.snapshot();
  assert.equal(snapshot.status, "containment_unavailable");
  assert.equal(snapshot.pressure.reason, "runtime_observation_inconsistent");
  assert.equal(events.includes("observe:worker:quadwork:generation-hostile-observation"), true);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(JSON.stringify(snapshot).includes("/sys/fs/cgroup"), false);
}

// A controller-supplied unit mismatch, duplicate, or oversized active list is
// rejected before any worker observation call. The service never probes a unit
// inferred from an entry the controller did not name exactly.
{
  const configured = policy();
  const worker = identity("quadwork", "generation-mismatch");
  const mismatched = controllerSnapshot([worker], configured);
  mismatched.active_scopes[0].unit_name = createWorkerUnitBase({
    projectId: "quadwork",
    generationId: "different-generation",
  });
  const mismatchHarness = createHarness({ workers: [worker], configured, controller: mismatched });
  const mismatch = mismatchHarness.service.snapshot();
  assert.equal(mismatch.status, "containment_unavailable");
  assert.equal(mismatch.pressure.reason, "controller_snapshot_invalid");
  assert.deepEqual(mismatchHarness.workerCalls, []);

  const duplicate = controllerSnapshot([worker, worker], configured);
  const duplicateHarness = createHarness({ workers: [worker, worker], configured, controller: duplicate });
  assert.equal(duplicateHarness.service.snapshot().status, "containment_unavailable");
  assert.deepEqual(duplicateHarness.workerCalls, []);

  const oversized = controllerSnapshot([], configured);
  oversized.active_scopes = new Array(MAX_ACTIVE_SCOPES + 1);
  const oversizedHarness = createHarness({ controller: oversized });
  assert.equal(oversizedHarness.service.snapshot().status, "containment_unavailable");
  assert.deepEqual(oversizedHarness.workerCalls, []);
}

// Known dependency methods are captured once. Hostile getters become absent
// probes, while required service boundaries fail construction generically.
{
  const secret = "DEPENDENCY-GETTER-SECRET";
  const hostileProbes = {};
  Object.defineProperty(hostileProbes, "memory", { get() { throw new Error(secret); } });
  const configured = policy();
  const base = createHarness({ configured });
  const service = new ResourceRuntimeService({
    runtimeResources: configured,
    probes: hostileProbes,
    controllerAdapter: base.controllerAdapter,
    observationProvider: base.observationProvider,
  });
  const snapshot = service.snapshot();
  assert.equal(snapshot.status, "containment_unavailable");
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.throws(() => new ResourceRuntimeService({}), /snapshot must be dependency-injected/);
  assert.throws(() => new ResourceRuntimeService({
    controllerAdapter: { snapshot() {} },
    observationProvider: {},
  }), /observeApiSelf must be dependency-injected/);
}

console.log("resource-runtime-service.test.js: all assertions passed");
