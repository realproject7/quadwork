"use strict";

const assert = require("node:assert/strict");
const {
  SYSTEMD_SCOPE_CANDIDATE,
  DEFAULT_CONTROL_CLASS_NAME,
} = require("./resource-controller");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");
const unitHelper = require("./resource-unit");
const {
  ResourceControllerAdapterError,
  createResourceControllerAdapter,
} = require("./resource-controller-adapter");

const OBSERVED_AT = "2026-08-31T04:05:06.789Z";
const NOW = new Date("2026-08-31T05:06:07.890Z");
let passed = 0;

function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

function policy(overrides = {}) {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    ...overrides,
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api, ...overrides.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker, ...overrides.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control, ...overrides.control },
  };
}

function readyObservation(resourceClass, identity, overrides = {}) {
  const unitBase = resourceClass === "worker"
    ? unitHelper.createWorkerUnitBase(identity)
    : unitHelper.createControlUnitBase(identity);
  return {
    available: true,
    status: "ready",
    reason: null,
    resource_class: resourceClass,
    unit_base: unitBase,
    unit_name: unitHelper.scopeUnitFromBase(unitBase),
    observed_at: OBSERVED_AT,
    counters: { oom_kill: "0", source: "local" },
    ...overrides,
  };
}

function harness({
  runtimePolicy = policy(),
  helper = unitHelper,
  executeProcess = async () => ({ code: 0, signal: null }),
  observeWorker,
  observeControl,
  extraOptions = {},
} = {}) {
  const observations = { worker: [], control: [] };
  const provider = {
    async observeWorker(identity) {
      observations.worker.push(identity);
      return observeWorker
        ? observeWorker(identity)
        : readyObservation("worker", identity);
    },
    async observeControl(identity) {
      observations.control.push(identity);
      return observeControl
        ? observeControl(identity)
        : readyObservation("control", identity);
    },
  };
  return {
    observations,
    adapter: createResourceControllerAdapter({
      policy: runtimePolicy,
      unitHelper: helper,
      observationProvider: provider,
      executeProcess,
      now: () => NOW,
      ...extraOptions,
    }),
  };
}

function workerInput(overrides = {}) {
  return {
    projectId: "project-7",
    generationId: "generation-11",
    command: "/opt/Quad Work/bin/codex",
    args: ["exec", "ticket; still-not-a-shell"],
    ...overrides,
  };
}

function controlInput(operationId, overrides = {}) {
  return {
    projectId: "project-7",
    generationId: "generation-11",
    operationId,
    command: "gh",
    args: ["api", "repos/realproject7/quadwork/pulls/1"],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

function assertAdapterError(error) {
  return error instanceof ResourceControllerAdapterError
    && error.code === "QW_INVALID_RESOURCE_CONTROLLER_ADAPTER"
    && !error.message.includes("SECRET");
}

async function main() {
  {
    const calls = [];
    const { adapter, observations } = harness({
      runtimePolicy: policy({
        worker: { memory_high_mib: 321, memory_max_mib: 654, swap_max_mib: 87 },
      }),
      executeProcess: async (invocation) => {
        calls.push(invocation);
        return { code: 0, signal: null };
      },
    });
    const output = await adapter.runWorker(workerInput());
    const expectedBase = unitHelper.createWorkerUnitBase(workerInput());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "systemd-run");
    assert.deepEqual(calls[0].args, [
      "--user", "--scope", "--collect", "--quiet",
      `--unit=${expectedBase}`,
      "-p", "MemoryHigh=321M",
      "-p", "MemoryMax=654M",
      "-p", "MemorySwapMax=87M",
      "--", "/opt/Quad Work/bin/codex", "exec", "ticket; still-not-a-shell",
    ]);
    assert.equal(calls[0].unitName, expectedBase);
    assert.equal(calls[0].resourceClass, "worker");
    assert.equal(calls[0].controlClassName, null);
    assert.equal(calls[0].shell, undefined);
    assert.deepEqual(observations.worker, [{
      projectId: "project-7",
      generationId: "generation-11",
    }]);
    assert.equal(output.fact.reason, "normal_exit");
    assert.equal(output.cgroup_oom_observation.oom_kill_count, "0");
    ok(!calls[0].args.includes("--pipe"),
      "worker execution uses only the candidate argument-array contract and policy limits");

    const snapshot = adapter.snapshot();
    assert.equal(snapshot.protocol_status, SYSTEMD_SCOPE_CANDIDATE.status);
    assert.equal(snapshot.protocol_status, "candidate_pending_staging");
    assert.deepEqual(snapshot.control_children, { limit: 2, active: 0, queued: 0 });
    assert.deepEqual(snapshot.control_class, {
      unit_name: DEFAULT_CONTROL_CLASS_NAME,
      aggregate: true,
    });
    ok(snapshot.active_scopes.length === 0,
      "snapshot preserves candidate status and the fixed aggregate control slice");
  }

  {
    const calls = [];
    const controls = new Map();
    const { adapter, observations } = harness({
      runtimePolicy: policy({ control: { max_concurrent_children: 2 } }),
      executeProcess: async (invocation) => {
        calls.push(invocation);
        const gate = deferred();
        controls.set(invocation.unitName, gate);
        return gate.promise;
      },
    });
    const runs = ["fetch-a", "fetch-b", "fetch-c"].map((operationId) =>
      adapter.runControl(controlInput(operationId)));
    await tick();
    assert.equal(calls.length, 2);
    assert.deepEqual(adapter.snapshot().control_children, { limit: 2, active: 2, queued: 1 });
    const expected = ["fetch-a", "fetch-b", "fetch-c"].map((operationId) =>
      unitHelper.createControlUnitBase({
        projectId: "project-7", generationId: "generation-11", operationId,
      }));
    assert.notEqual(expected[0], expected[1]);
    for (const invocation of calls) {
      assert.ok(invocation.args.includes("--slice=quadwork-control.slice"));
      assert.ok(!invocation.args.some((arg) => arg.startsWith("Memory")));
      assert.equal(invocation.controlClassName, DEFAULT_CONTROL_CLASS_NAME);
    }
    controls.get(expected[0]).resolve({ code: 0, signal: null });
    await tick();
    await tick();
    assert.equal(calls.length, 3);
    controls.get(expected[1]).resolve({ code: 0, signal: null });
    controls.get(expected[2]).resolve({ code: 0, signal: null });
    await Promise.all(runs);
    assert.deepEqual(observations.control.map((identity) => identity.operationId).sort(),
      ["fetch-a", "fetch-b", "fetch-c"]);
    assert.deepEqual(adapter.snapshot().control_children, { limit: 2, active: 0, queued: 0 });
    ok(calls.every((call) => !call.args.some((arg) => arg === "MemoryMax=512M")),
      "control operations are identity-qualified leaves under one aggregate policy class");
  }

  {
    let invocation;
    const max = "18446744073709551615";
    const { adapter } = harness({
      executeProcess: async (value) => {
        invocation = value;
        return { code: null, signal: "SIGKILL" };
      },
      observeWorker: (identity) => readyObservation("worker", identity, {
        counters: { oom_kill: max, source: "hierarchical" },
      }),
    });
    const output = await adapter.runWorker(workerInput());
    assert.equal(output.fact.reason, "oom_kill");
    assert.equal(output.cgroup_oom_observation.oom_kill_count, max);
    assert.equal(output.cgroup_oom_observation.observed_at, OBSERVED_AT);
    assert.equal(output.cgroup_oom_observation.unit_name, invocation.unitName);
    ok(adapter.snapshot().last_cgroup_oom.oom_kill_count === max,
      "exact uint64 observation count and timestamp map into qualified controller facts");
  }

  {
    let executeCount = 0;
    const { adapter } = harness({
      executeProcess: async () => {
        executeCount += 1;
        return { code: 0, signal: null };
      },
    });
    for (const [field, value] of [
      ["unitName", "quadwork-worker-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["limits", { memoryMaxMib: 1 }],
      ["controlClassName", "attacker.slice"],
      ["resourceClass", "control"],
    ]) {
      await assert.rejects(adapter.runWorker(workerInput({ [field]: value })), assertAdapterError);
    }
    await assert.rejects(adapter.runControl(controlInput("op-1", {
      controlClassName: "attacker.slice",
    })), assertAdapterError);
    assert.equal(executeCount, 0);
    ok(true, "caller unit, limit, resource-class, and control-slice overrides never cross the seam");
  }

  {
    const base = unitHelper.createWorkerUnitBase(workerInput());
    const hostileHelper = {
      ...unitHelper,
      createWorkerUnitBase() {
        return base.replace(/.$/, base.endsWith("0") ? "1" : "0");
      },
    };
    const { adapter } = harness({ helper: hostileHelper });
    await assert.rejects(adapter.runWorker(workerInput()), assertAdapterError);
    ok(true, "an injected unit helper cannot substitute another syntactically valid generated unit");
  }

  {
    const invalidObservations = [
      (identity) => ({ ...readyObservation("worker", identity), resource_class: "control" }),
      (identity) => ({ ...readyObservation("worker", identity), unit_base: unitHelper.createControlUnitBase({
        ...identity, operationId: "forged",
      }) }),
      (identity) => ({ ...readyObservation("worker", identity), unit_name: "quadwork-worker-.scope" }),
      (identity) => ({ ...readyObservation("worker", identity), available: false, status: "unavailable" }),
      (identity) => ({ ...readyObservation("worker", identity), counters: { oom_kill: "18446744073709551616", source: "local" } }),
      (identity) => ({ ...readyObservation("worker", identity), counters: { oom_kill: "1", source: "forged" } }),
      (identity) => ({ ...readyObservation("worker", identity), observed_at: "not-a-time" }),
      (identity) => {
        const observation = readyObservation("worker", identity);
        Object.defineProperty(observation, "counters", {
          get() { throw new Error("SECRET_PROVIDER_PATH=/tmp/secret"); },
        });
        return observation;
      },
    ];
    for (const observeWorker of invalidObservations) {
      const { adapter } = harness({
        executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
        observeWorker,
      });
      const output = await adapter.runWorker(workerInput());
      assert.equal(output.fact.reason, "signal");
      assert.equal(output.cgroup_oom_observation, null);
    }
    ok(true, "unavailable, mismatched, overflowed, stale, or hostile observations cannot claim OOM");
  }

  {
    const { adapter } = harness({
      executeProcess: async () => ({ code: 0, signal: null }),
      observeControl() {
        throw new Error("SECRET_CONTROL_PATH=/run/user/1000/systemd/private");
      },
    });
    const output = await adapter.runControl(controlInput("no-observation"));
    assert.equal(output.fact.reason, "normal_exit");
    assert.equal(output.cgroup_oom_observation, null);
    assert.equal(JSON.stringify(adapter.snapshot()).includes("SECRET"), false);
    ok(true, "observation failures are typed absence and never create an uncontained execution fallback");
  }

  {
    const hostile = workerInput();
    Object.defineProperty(hostile, "command", {
      enumerable: true,
      get() { throw new Error("SECRET_TOKEN=abc"); },
    });
    const { adapter } = harness();
    await assert.rejects(adapter.runWorker(hostile), assertAdapterError);

    const hostileOptions = new Proxy({}, {
      ownKeys() { throw new Error("SECRET_OPTIONS"); },
    });
    assert.throws(() => createResourceControllerAdapter(hostileOptions), assertAdapterError);
    assert.throws(() => createResourceControllerAdapter({
      policy: { ...policy(), SECRET_OVERRIDE: true },
      observationProvider: { observeWorker() {}, observeControl() {} },
      executeProcess() {},
    }), assertAdapterError);
    assert.throws(() => createResourceControllerAdapter({
      policy: policy(),
      observationProvider: { observeWorker() {}, observeControl() {} },
      executeProcess() {},
      maxControlChildren: 999,
    }), assertAdapterError);
    ok(true, "hostile accessors and factory-level authority overrides fail with redacted stable errors");
  }

  {
    const gates = [];
    const { adapter } = harness({
      executeProcess: async () => {
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
    });
    const first = adapter.runWorker(workerInput());
    await tick();
    await assert.rejects(adapter.runWorker(workerInput()), assertAdapterError);
    gates[0].resolve({ code: 0, signal: null });
    await first;
    const reused = adapter.runWorker(workerInput());
    await tick();
    gates[1].resolve({ code: 0, signal: null });
    await reused;
    ok(adapter.snapshot().active_scopes.length === 0,
      "duplicate generated identity is rejected while active and reusable after cleanup");
  }

  console.log(`resource-controller-adapter: ${passed} contract groups passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
