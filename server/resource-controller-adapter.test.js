"use strict";

const assert = require("node:assert/strict");
const {
  SYSTEMD_SCOPE_CANDIDATE,
  DEFAULT_CONTROL_CLASS_NAME,
} = require("./resource-controller");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");
const { createResourceSnapshot } = require("./resource-state");
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
  providerTimeoutMs = 250,
  extraOptions = {},
} = {}) {
  const observations = { worker: [], control: [], workerBoundaries: [], controlBoundaries: [] };
  const provider = {
    timeoutMs: providerTimeoutMs,
    async observeWorker(identity, boundary) {
      observations.worker.push(identity);
      observations.workerBoundaries.push(boundary);
      return observeWorker
        ? observeWorker(identity, boundary)
        : readyObservation("worker", identity);
    },
    async observeControl(identity, boundary) {
      observations.control.push(identity);
      observations.controlBoundaries.push(boundary);
      return observeControl
        ? observeControl(identity, boundary)
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
    assert.equal(observations.workerBoundaries.length, 1);
    assert.equal(observations.workerBoundaries[0].signal instanceof AbortSignal, true);
    assert.equal(observations.workerBoundaries[0].signal.aborted, true);
    assert.equal(observations.workerBoundaries[0].timeoutMs, 250);
    assert.equal(Number.isSafeInteger(observations.workerBoundaries[0].deadline), true);
    assert.equal(observations.workerBoundaries[0].deadline <= Date.now() + 250, true);
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
    const snapshot = adapter.snapshot();
    assert.equal(snapshot.last_cgroup_oom.oom_kill_count, max);
    assert.equal(snapshot.terminal_facts[0].oom_kill_count, max);
    assert.equal(snapshot.terminal_facts[0].oom_observed_at, OBSERVED_AT);
    const durable = createResourceSnapshot(snapshot);
    assert.equal(durable.terminal_facts[0].reason, "oom_kill");
    assert.equal(durable.terminal_facts[0].oom_kill_count, max);
    ok(durable.terminal_facts[0].oom_observed_at === OBSERVED_AT,
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
    const revokedOptions = Proxy.revocable({}, {});
    revokedOptions.revoke();
    assert.throws(() => createResourceControllerAdapter(revokedOptions.proxy), assertAdapterError);

    const { adapter } = harness();
    const revokedWorker = Proxy.revocable(workerInput(), {});
    revokedWorker.revoke();
    await assert.rejects(adapter.runWorker(revokedWorker.proxy), assertAdapterError);

    const revokedControl = Proxy.revocable(controlInput("revoked"), {});
    revokedControl.revoke();
    await assert.rejects(adapter.runControl(revokedControl.proxy), assertAdapterError);

    const revokedArgs = Proxy.revocable(["SECRET_REVOKED_ARG"], {});
    revokedArgs.revoke();
    await assert.rejects(adapter.runWorker(workerInput({ args: revokedArgs.proxy })), assertAdapterError);
    assert.equal(adapter.snapshot().active_scopes.length, 0);
    ok(true, "revoked options, run records, and argument arrays fail only with the redacted adapter error");
  }

  {
    const invalidTimes = [
      "2026-02-29T00:00:00Z",
      "2024-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-08-31T24:00:00Z",
      "2026-08-31T00:00:00+24:00",
      "2026-08-31T00:00:00+00:60",
    ];
    for (const observed_at of invalidTimes) {
      const { adapter } = harness({
        executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
        observeWorker: (identity) => readyObservation("worker", identity, {
          observed_at,
          counters: { oom_kill: "1", source: "local" },
        }),
      });
      const output = await adapter.runWorker(workerInput());
      assert.equal(output.fact.reason, "signal");
      assert.equal(output.cgroup_oom_observation, null);
    }
    const { adapter } = harness({
      executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
      observeWorker: (identity) => readyObservation("worker", identity, {
        observed_at: "2024-02-29T23:30:00-01:30",
        counters: { oom_kill: "1", source: "local" },
      }),
    });
    const output = await adapter.runWorker(workerInput());
    assert.equal(output.fact.reason, "oom_kill");
    ok(output.cgroup_oom_observation.observed_at === "2024-03-01T01:00:00.000Z",
      "observation time validation rejects calendar rollovers and canonicalizes valid offsets");
  }

  {
    let executeCount = 0;
    const { adapter } = harness({ executeProcess: async () => {
      executeCount += 1;
      return { code: 0, signal: null };
    } });
    const symbolInput = workerInput();
    symbolInput[Symbol("SECRET_AUTHORITY")] = true;
    await assert.rejects(adapter.runWorker(symbolInput), assertAdapterError);

    const hiddenInput = workerInput();
    Object.defineProperty(hiddenInput, "unitName", { value: "forged", enumerable: false });
    await assert.rejects(adapter.runWorker(hiddenInput), assertAdapterError);

    const inheritedInput = Object.create({ projectId: "project-7" });
    Object.assign(inheritedInput, {
      generationId: "generation-11",
      command: "codex",
      args: [],
    });
    await assert.rejects(adapter.runWorker(inheritedInput), assertAdapterError);

    let getterCalls = 0;
    const accessorInput = workerInput();
    Object.defineProperty(accessorInput, "command", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "SECRET_COMMAND";
      },
    });
    await assert.rejects(adapter.runWorker(accessorInput), assertAdapterError);
    assert.equal(getterCalls, 0);
    assert.equal(executeCount, 0);

    const options = {
      policy: policy(),
      observationProvider: {
        timeoutMs: 250,
        observeWorker() {},
        observeControl() {},
      },
      executeProcess() {},
    };
    options[Symbol("SECRET_FACTORY_AUTHORITY")] = true;
    assert.throws(() => createResourceControllerAdapter(options), assertAdapterError);
    const hiddenOptions = { ...options };
    delete hiddenOptions[Reflect.ownKeys(hiddenOptions).find((key) => typeof key === "symbol")];
    Object.defineProperty(hiddenOptions, "scopeProof", { value: true, enumerable: false });
    assert.throws(() => createResourceControllerAdapter(hiddenOptions), assertAdapterError);

    const inheritedOptions = Object.create({ policy: policy() });
    Object.assign(inheritedOptions, {
      observationProvider: options.observationProvider,
      executeProcess() {},
    });
    assert.throws(() => createResourceControllerAdapter(inheritedOptions), assertAdapterError);
    ok(true, "input and factory authority is accepted only from exact enumerable own data fields");
  }

  {
    let policyGetterCalls = 0;
    const hostilePolicy = policy();
    Object.defineProperty(hostilePolicy.worker, "memory_max_mib", {
      enumerable: true,
      get() {
        policyGetterCalls += 1;
        return 1;
      },
    });
    assert.throws(() => harness({ runtimePolicy: hostilePolicy }), assertAdapterError);
    assert.equal(policyGetterCalls, 0);
    const symbolPolicy = policy();
    symbolPolicy.control[Symbol("SECRET_CONTROL_POLICY")] = 1;
    assert.throws(() => harness({ runtimePolicy: symbolPolicy }), assertAdapterError);
    ok(true, "nested policy fields are snapshotted as exact data without invoking accessors");
  }

  {
    let ownKeysCalls = 0;
    let getCalls = 0;
    const descriptorCalls = new Map();
    const { adapter } = harness({
      executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
      observeWorker(identity) {
        const target = readyObservation("worker", identity, {
          counters: new Proxy({ oom_kill: "9", source: "local" }, {
            ownKeys(value) {
              ownKeysCalls += 1;
              return Reflect.ownKeys(value);
            },
            get() {
              getCalls += 1;
              throw new Error("SECRET_COUNTER_GET");
            },
            getOwnPropertyDescriptor(value, key) {
              descriptorCalls.set(`counter:${String(key)}`,
                (descriptorCalls.get(`counter:${String(key)}`) || 0) + 1);
              return Reflect.getOwnPropertyDescriptor(value, key);
            },
          }),
        });
        return new Proxy(target, {
          ownKeys(value) {
            ownKeysCalls += 1;
            return Reflect.ownKeys(value);
          },
          get(value, key) {
            // Promise resolution probes `then` before the adapter receives the
            // object; permit only that platform-level assimilation check.
            if (key === "then") return undefined;
            getCalls += 1;
            throw new Error("SECRET_OBSERVATION_GET");
          },
          getOwnPropertyDescriptor(value, key) {
            descriptorCalls.set(`observation:${String(key)}`,
              (descriptorCalls.get(`observation:${String(key)}`) || 0) + 1);
            return Reflect.getOwnPropertyDescriptor(value, key);
          },
        });
      },
    });
    const output = await adapter.runWorker(workerInput());
    assert.equal(output.fact.reason, "oom_kill");
    assert.equal(output.fact.oom_kill_count, "9");
    assert.equal(ownKeysCalls, 2);
    assert.equal(getCalls, 0);
    for (const count of descriptorCalls.values()) assert.equal(count, 1);

    const invalidCounters = [];
    const symbolCounters = { oom_kill: "1", source: "local" };
    symbolCounters[Symbol("SECRET_COUNTER_AUTHORITY")] = true;
    invalidCounters.push(symbolCounters);
    const hiddenCounters = { oom_kill: "1", source: "local" };
    Object.defineProperty(hiddenCounters, "proof", { value: true, enumerable: false });
    invalidCounters.push(hiddenCounters);
    invalidCounters.push(Object.assign(Object.create({ source: "local" }), { oom_kill: "1" }));
    for (const counters of invalidCounters) {
      const run = harness({
        executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
        observeWorker: (identity) => readyObservation("worker", identity, { counters }),
      });
      const invalid = await run.adapter.runWorker(workerInput());
      assert.equal(invalid.fact.reason, "signal");
      assert.equal(invalid.cgroup_oom_observation, null);
    }
    const invalidObservations = [];
    const symbolObservation = readyObservation("worker", workerInput());
    symbolObservation[Symbol("SECRET_OBSERVATION_AUTHORITY")] = true;
    invalidObservations.push(symbolObservation);
    const hiddenObservation = readyObservation("worker", workerInput());
    Object.defineProperty(hiddenObservation, "scopeProof", { value: true, enumerable: false });
    invalidObservations.push(hiddenObservation);
    invalidObservations.push(Object.assign(Object.create({ available: true }), {
      ...readyObservation("worker", workerInput()),
    }));
    for (const observation of invalidObservations) {
      const run = harness({
        executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
        observeWorker: () => observation,
      });
      const invalid = await run.adapter.runWorker(workerInput());
      assert.equal(invalid.fact.reason, "signal");
      assert.equal(invalid.cgroup_oom_observation, null);
    }
    ok(true, "observation authority is snapshotted once and rejects hidden, inherited, or symbolic fields");
  }

  {
    let lengthDescriptorCalls = 0;
    let ownKeysCalls = 0;
    const args = new Proxy(["one", "two"], {
      ownKeys(value) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(value, key) {
        if (key === "length") lengthDescriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });
    const calls = [];
    const { adapter } = harness({ executeProcess: async (invocation) => {
      calls.push(invocation);
      return { code: 0, signal: null };
    } });
    await adapter.runWorker(workerInput({ args }));
    assert.equal(lengthDescriptorCalls, 1);
    assert.equal(ownKeysCalls, 1);
    assert.deepEqual(calls[0].args.slice(-3), ["/opt/Quad Work/bin/codex", "one", "two"]);

    let argGetterCalls = 0;
    const accessorArgs = ["safe"];
    Object.defineProperty(accessorArgs, "0", {
      enumerable: true,
      get() {
        argGetterCalls += 1;
        return "SECRET_ARG";
      },
    });
    await assert.rejects(adapter.runWorker(workerInput({ args: accessorArgs })), assertAdapterError);
    assert.equal(argGetterCalls, 0);
    const decoratedArgs = ["safe"];
    decoratedArgs.extra = "authority";
    await assert.rejects(adapter.runWorker(workerInput({ args: decoratedArgs })), assertAdapterError);
    const symbolicArgs = ["safe"];
    symbolicArgs[Symbol("SECRET_ARG")] = "authority";
    await assert.rejects(adapter.runWorker(workerInput({ args: symbolicArgs })), assertAdapterError);
    const sparseArgs = Array(2);
    sparseArgs[1] = "safe";
    await assert.rejects(adapter.runWorker(workerInput({ args: sparseArgs })), assertAdapterError);
    const oversizedArgs = [];
    oversizedArgs.length = 10_001;
    await assert.rejects(adapter.runWorker(workerInput({ args: oversizedArgs })), assertAdapterError);
    assert.equal(calls.length, 1);
    ok(true, "argument length and entries are captured once with holes, accessors, and authority decorations rejected");
  }

  {
    const original = new AbortController();
    let hostileAbortedCalls = 0;
    let hostileAddCalls = 0;
    let hostileRemoveCalls = 0;
    Object.defineProperties(original.signal, {
      aborted: {
        configurable: true,
        get() {
          hostileAbortedCalls += 1;
          throw new Error("SECRET_ABORTED");
        },
      },
      addEventListener: {
        configurable: true,
        value() {
          hostileAddCalls += 1;
          throw new Error("SECRET_ADD");
        },
      },
      removeEventListener: {
        configurable: true,
        value() {
          hostileRemoveCalls += 1;
          throw new Error("SECRET_REMOVE");
        },
      },
    });
    let executionSignal;
    const { adapter } = harness({ executeProcess: async (invocation) => {
      executionSignal = invocation.signal;
      return { code: 0, signal: null };
    } });
    await adapter.runWorker(workerInput({ signal: original.signal }));
    assert.notEqual(executionSignal, original.signal);
    assert.equal(executionSignal instanceof AbortSignal, true);
    assert.equal(hostileAbortedCalls, 0);
    assert.equal(hostileAddCalls, 0);
    assert.equal(hostileRemoveCalls, 0);

    const activeCaller = new AbortController();
    let activeStarted;
    const started = new Promise((resolve) => { activeStarted = resolve; });
    let activeExecutionSignal;
    const activeRun = harness({
      executeProcess: (invocation) => {
        activeExecutionSignal = invocation.signal;
        activeStarted();
        return new Promise((resolve) => {
          invocation.signal.addEventListener("abort", () => {
            resolve({ code: null, signal: "SIGTERM" });
          }, { once: true });
        });
      },
    });
    const cancelled = activeRun.adapter.runWorker(workerInput({ signal: activeCaller.signal }));
    await started;
    activeCaller.abort();
    const cancelledOutput = await cancelled;
    assert.equal(activeExecutionSignal.aborted, true);
    assert.equal(cancelledOutput.fact.reason, "signal");
    assert.equal(activeRun.adapter.snapshot().active_scopes.length, 0);

    const hostileSignals = [
      { get aborted() { throw new Error("SECRET_PLAIN_SIGNAL"); } },
      new Proxy({}, { get() { throw new Error("SECRET_PROXY_SIGNAL"); } }),
    ];
    for (const signal of hostileSignals) {
      await assert.rejects(adapter.runWorker(workerInput({ signal })), assertAdapterError);
    }

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(adapter.runControl(controlInput("already-aborted", {
      signal: alreadyAborted.signal,
    })), { name: "AbortError", code: "ABORT_ERR" });
    assert.deepEqual(adapter.snapshot().control_children, { limit: 2, active: 0, queued: 0 });
    assert.equal(adapter.snapshot().active_scopes.length, 0);
    ok(true, "AbortSignal bridging ignores hostile shadow properties and rejects non-platform signals");
  }

  {
    assert.throws(() => harness({ providerTimeoutMs: 1_001 }), assertAdapterError);
    let timeoutGetterCalls = 0;
    const provider = {
      observeWorker() {},
      observeControl() {},
    };
    Object.defineProperty(provider, "timeoutMs", {
      enumerable: true,
      get() {
        timeoutGetterCalls += 1;
        return 250;
      },
    });
    assert.throws(() => createResourceControllerAdapter({
      policy: policy(),
      observationProvider: provider,
      executeProcess() {},
    }), assertAdapterError);
    assert.equal(timeoutGetterCalls, 0);
    const hiddenTimeoutProvider = {
      observeWorker() {},
      observeControl() {},
    };
    Object.defineProperty(hiddenTimeoutProvider, "timeoutMs", {
      value: 250,
      enumerable: false,
    });
    assert.throws(() => createResourceControllerAdapter({
      policy: policy(),
      observationProvider: hiddenTimeoutProvider,
      executeProcess() {},
    }), assertAdapterError);
    assert.throws(() => harness({ helper: 0 }), assertAdapterError);

    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    let providerAbortObserved = false;
    let providerBoundary;
    const caller = new AbortController();
    const { adapter } = harness({
      executeProcess: async () => ({ code: 0, signal: null }),
      observeControl(identity, boundary) {
        providerBoundary = boundary;
        providerStarted();
        return new Promise((resolve) => {
          boundary.signal.addEventListener("abort", () => {
            providerAbortObserved = true;
            resolve(null);
          }, { once: true });
        });
      },
    });
    const run = adapter.runControl(controlInput("bounded-query", { signal: caller.signal }));
    await started;
    caller.abort();
    const output = await run;
    assert.equal(output.fact.reason, "normal_exit");
    assert.equal(providerAbortObserved, true);
    assert.equal(providerBoundary.timeoutMs, 250);
    assert.equal(providerBoundary.signal instanceof AbortSignal, true);
    assert.deepEqual(adapter.snapshot().control_children, { limit: 2, active: 0, queued: 0 });
    assert.equal(adapter.snapshot().active_scopes.length, 0);
    await adapter.runControl(controlInput("bounded-query", {
      signal: new AbortController().signal,
    }));
    ok(true, "provider timeout is below the controller boundary and cancellation ends observation before identity reuse");
  }

  {
    let providerSignal;
    let providerDeadline;
    let providerCompleted = false;
    const { adapter } = harness({
      providerTimeoutMs: 20,
      executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
      async observeWorker(identity, boundary) {
        providerSignal = boundary.signal;
        providerDeadline = boundary.deadline;
        await new Promise((resolve) => setTimeout(resolve, 123));
        providerCompleted = true;
        return readyObservation("worker", identity, {
          counters: { oom_kill: "1", source: "local" },
        });
      },
    });
    const startedAt = Date.now();
    const output = await adapter.runWorker(workerInput());
    const elapsed = Date.now() - startedAt;
    assert.equal(output.fact.reason, "signal");
    assert.equal(output.cgroup_oom_observation, null);
    assert.equal(providerSignal instanceof AbortSignal, true);
    assert.equal(providerSignal.aborted, true);
    assert.equal(providerDeadline <= startedAt + 40, true);
    assert.equal(elapsed < 100, true, `provider boundary took ${elapsed}ms`);
    assert.equal(providerCompleted, false);
    assert.equal(adapter.snapshot().active_scopes.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(providerCompleted, true);
    ok(true, "a declared 20ms provider is cut off internally and cannot retain a live boundary signal");
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
