"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
} = require("./resource-policy");
const { ResourceStateStore } = require("./resource-state");
const {
  OBSERVATION_TIMEOUT_MS,
  ResourceRuntimeOwnerError,
  createResourceRuntimeOwner,
  mergeControllerEvidence,
  resourceStateFilePath,
} = require("./resource-runtime-owner");

const OBSERVED_AT = "2026-08-31T00:00:00.000Z";

function policy() {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
  };
}

function finiteMib(value) {
  return { kind: "finite", bytes: String(value * 1024 * 1024) };
}

function infinite() {
  return { kind: "infinite" };
}

function observation(resourceClass, unitName, limits, qualifiers = {}) {
  return {
    available: true,
    status: "ready",
    reason: null,
    resource_class: resourceClass,
    unit_base: null,
    unit_name: unitName,
    ...qualifiers,
    observed_at: OBSERVED_AT,
    usage: {
      memory_current_bytes: "0",
      memory_peak_bytes: "0",
      memory_swap_current_bytes: "0",
    },
    limits,
    counters: { oom_kill: "0", source: "local" },
  };
}

function fakeComposition(overrides = {}) {
  let probeOptions = null;
  let providerOptions = null;
  let executeCalls = 0;
  const apiLimits = {
    memory_low: finiteMib(policy().api.memory_low_mib),
    memory_high: infinite(),
    memory_max: finiteMib(policy().api.memory_max_mib),
    memory_swap_max: infinite(),
  };
  const controlLimits = {
    memory_low: infinite(),
    memory_high: infinite(),
    memory_max: finiteMib(policy().control.memory_max_mib),
    memory_swap_max: finiteMib(policy().control.swap_max_mib),
  };
  const provider = {
    timeoutMs: OBSERVATION_TIMEOUT_MS,
    observeApiSelf() {
      return observation("api", "quadwork-api.service", apiLimits, { self: true });
    },
    observeControlAggregate() {
      return observation("control", "quadwork-control.slice", controlLimits, { aggregate: true });
    },
    observeWorker() {
      throw new Error("zero active workers must not be observed");
    },
    observeControl() {
      throw new Error("read-only owner must not run a control child");
    },
  };
  return {
    options: {
      loadRuntimeResources: () => policy(),
      createReadOnlyProbes(options) {
        probeOptions = options;
        return {
          memory: () => ({ totalMib: 8192, availableMib: 4000, swapTotalMib: 8192, swapFreeMib: 7000 }),
          // The fake represents a future proof receipt while asserting that the
          // production owner itself never passes a caller-forged true override.
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
          activeScopes: () => 0,
        };
      },
      createObservationProvider(options) {
        providerOptions = options;
        return provider;
      },
      execFileSyncImpl() {
        executeCalls += 1;
        throw new Error("owner construction must not execute a host command");
      },
      ...overrides,
    },
    facts: {
      get probeOptions() { return probeOptions; },
      get providerOptions() { return providerOptions; },
      get executeCalls() { return executeCalls; },
    },
  };
}

function fakeApp() {
  const registrations = [];
  return {
    registrations,
    get(routePath, handler) { registrations.push({ routePath, handler }); },
  };
}

function fakeResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function workerIdentity(character, generationId) {
  const unitBase = `quadwork-worker-${character.repeat(40)}`;
  return {
    project_id: "project-a",
    generation_id: generationId,
    resource_class: "worker",
    unit_name: `${unitBase}.scope`,
  };
}

function terminalFact(identity, overrides = {}) {
  return {
    ...identity,
    reason: "normal_exit",
    exit_code: 0,
    signal: null,
    finished_at: OBSERVED_AT,
    ...overrides,
  };
}

function controllerSnapshot(overrides = {}) {
  return {
    protocol_status: "candidate_pending_staging",
    control_children: { limit: 2, active: 0, queued: 0 },
    control_class: { unit_name: "quadwork-control.slice", aggregate: true },
    active_scopes: [],
    last_cgroup_oom: null,
    terminal_facts: [],
    ...overrides,
  };
}

// Restart merging is bounded to the state contract, deduplicates immutable
// identities, and retains the current copy at the newest position.
{
  const persistedFacts = Array.from({ length: 100 }, (_, index) => {
    const unitBase = `quadwork-worker-${index.toString(16).padStart(40, "0")}`;
    return terminalFact({
      project_id: "project-bounded",
      generation_id: `generation-${index}`,
      resource_class: "worker",
      unit_name: `${unitBase}.scope`,
    }, { finished_at: `2026-08-31T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z` });
  });
  const replacement = { ...persistedFacts[99], finished_at: "2026-08-31T01:59:59.000Z" };
  const newest = terminalFact({
    project_id: "project-bounded",
    generation_id: "generation-new",
    resource_class: "worker",
    unit_name: `quadwork-worker-${"f".repeat(40)}.scope`,
  }, { finished_at: "2026-08-31T02:00:00.000Z" });
  const merged = mergeControllerEvidence(
    controllerSnapshot({ terminal_facts: [replacement, newest] }),
    { terminal_facts: persistedFacts },
  );
  assert.equal(merged.terminal_facts.length, 100);
  assert.equal(merged.terminal_facts[0].generation_id, "generation-1", "oldest overflow fact is pruned");
  assert.equal(merged.terminal_facts.at(-1).generation_id, "generation-new");
  assert.equal(merged.terminal_facts.filter((fact) => fact.generation_id === "generation-99").length, 1);
  assert.equal(
    merged.terminal_facts.find((fact) => fact.generation_id === "generation-99").finished_at,
    replacement.finished_at,
  );
}

// Missing or invalid resource policy never constructs probes, providers,
// controllers, state stores, or writers. The read endpoint remains typed.
for (const loadRuntimeResources of [() => null, () => { throw new Error("SECRET config failure"); }]) {
  const calls = { probes: 0, provider: 0, controller: 0, store: 0 };
  const owner = createResourceRuntimeOwner({
    loadRuntimeResources,
    createReadOnlyProbes() { calls.probes += 1; throw new Error("unexpected probe"); },
    createObservationProvider() { calls.provider += 1; throw new Error("unexpected provider"); },
    createControllerAdapter() { calls.controller += 1; throw new Error("unexpected controller"); },
    createStateStore() { calls.store += 1; throw new Error("unexpected state"); },
  });
  assert.equal(owner.snapshot().status, "invalid_resource_policy");
  assert.deepEqual(calls, { probes: 0, provider: 0, controller: 0, store: 0 });
  assert.equal(owner.runWorker, undefined);
  assert.equal(owner.runControl, undefined);
  assert.throws(
    () => owner.persist(owner.snapshot()),
    (error) => error instanceof ResourceRuntimeOwnerError
      && error.code === "QW_RESOURCE_PERSISTENCE_UNAVAILABLE",
  );

  const app = fakeApp();
  const first = owner.register(app);
  assert.equal(owner.register(app), first, "same-app registration is idempotent");
  assert.equal(app.registrations.length, 1, "resource HTTP route registers exactly once");
  assert.equal(app.registrations[0].routePath, "/api/resources");
  const response = fakeResponse();
  app.registrations[0].handler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "invalid_resource_policy");
  assert.ok(!JSON.stringify(response.body).includes("SECRET"));
}

// Configured composition is read-only, pins scopeProof=false at its factory
// boundary, uses an observation timeout accepted by the adapter, and exposes a
// candidate snapshot without exposing or invoking controller run methods.
{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-owner-candidate-"));
  fs.mkdirSync(path.join(homeDir, ".quadwork"), { mode: 0o700 });
  const composition = fakeComposition({ homeDir });
  const owner = createResourceRuntimeOwner(composition.options);
  assert.equal(composition.facts.probeOptions.scopeProof, false);
  assert.equal(composition.facts.providerOptions.timeoutMs, OBSERVATION_TIMEOUT_MS);
  assert.ok(composition.facts.providerOptions.timeoutMs <= 1_000);
  assert.equal(composition.facts.executeCalls, 0);
  assert.equal(owner.runWorker, undefined);
  assert.equal(owner.runControl, undefined);

  const statePath = resourceStateFilePath(homeDir);
  assert.equal(fs.existsSync(statePath), false, "startup load and GET do not create state");
  const app = fakeApp();
  owner.register(app);
  const response = fakeResponse();
  app.registrations[0].handler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "candidate_pending_staging");
  assert.equal(fs.existsSync(statePath), false, "GET has no implicit persistence");
  assert.equal(composition.facts.executeCalls, 0);

  const saved = owner.persist(response.body);
  assert.equal(saved.status, "candidate_pending_staging");
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

// Persisted restart evidence is loaded once. Only terminal/OOM evidence is
// retained; current controller facts replace matching persisted identities and
// current counts remain authoritative.
{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-owner-restart-"));
  const stateDir = path.join(homeDir, ".quadwork");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const statePath = resourceStateFilePath(homeDir);
  const replacedIdentity = workerIdentity("a", "generation-replaced");
  const retainedIdentity = workerIdentity("b", "generation-retained");
  const persistedOom = {
    ...replacedIdentity,
    oom_kill_count: "4",
    observed_at: "2026-08-31T00:00:01.000Z",
  };
  new ResourceStateStore({ filePath: statePath }).save({
    status: "candidate_pending_staging",
    counts: { active_worker_scopes: 99, active_control_children: 99, queued_control_children: 99 },
    last_cgroup_oom: persistedOom,
    terminal_facts: [
      terminalFact(retainedIdentity, { finished_at: "2026-08-31T00:00:02.000Z" }),
      terminalFact(replacedIdentity, {
        reason: "oom_kill",
        exit_code: null,
        signal: "SIGKILL",
        finished_at: "2026-08-31T00:00:03.000Z",
        oom_kill_count: "4",
        oom_observed_at: "2026-08-31T00:00:01.000Z",
      }),
    ],
  });

  let loads = 0;
  const replacement = terminalFact(replacedIdentity, {
    finished_at: "2026-08-31T00:00:04.000Z",
  });
  const currentOom = {
    ...replacedIdentity,
    oom_kill_count: "0",
    observed_at: "2026-08-31T00:00:05.000Z",
  };
  const composition = fakeComposition({
    homeDir,
    createStateStore(options) {
      const store = new ResourceStateStore(options);
      const load = store.load.bind(store);
      store.load = () => { loads += 1; return load(); };
      return store;
    },
    createControllerAdapter() {
      return Object.freeze({
        runWorker() { throw new Error("run method must remain private"); },
        runControl() { throw new Error("run method must remain private"); },
        snapshot: () => controllerSnapshot({
          last_cgroup_oom: currentOom,
          terminal_facts: [replacement],
        }),
      });
    },
  });
  const owner = createResourceRuntimeOwner(composition.options);
  const first = owner.snapshot();
  const second = owner.snapshot();
  assert.equal(loads, 1, "durable state is loaded only at startup");
  assert.equal(first.counts.active_worker_scopes, 0, "stale persisted counts are never merged");
  assert.deepEqual(first.terminal_facts.map((fact) => fact.generation_id), [
    retainedIdentity.generation_id,
    replacedIdentity.generation_id,
  ]);
  assert.equal(first.terminal_facts[1].reason, "normal_exit", "current fact replaces persisted duplicate");
  assert.equal(first.last_cgroup_oom.oom_kill_count, "0", "current qualified OOM observation wins");
  assert.deepEqual(second.terminal_facts, first.terminal_facts);
  assert.equal(owner.runWorker, undefined);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

// Absent and corrupt state fail closed without creation, repair, or repeated
// reads. Corrupt bytes are not rewritten by startup or GET.
for (const corrupt of [false, true]) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-owner-state-"));
  const stateDir = path.join(homeDir, ".quadwork");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const statePath = resourceStateFilePath(homeDir);
  if (corrupt) fs.writeFileSync(statePath, "{not-json", { mode: 0o600 });
  const before = corrupt ? fs.readFileSync(statePath, "utf8") : null;
  const composition = fakeComposition({ homeDir });
  const owner = createResourceRuntimeOwner(composition.options);
  const snapshot = owner.snapshot();
  assert.deepEqual(snapshot.terminal_facts, []);
  if (corrupt) assert.equal(fs.readFileSync(statePath, "utf8"), before);
  else assert.equal(fs.existsSync(statePath), false);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

// The production server owns exactly one owner construction and one mount; it
// never imports the HTTP registrar or resource run methods directly.
{
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.equal((source.match(/createResourceRuntimeOwner\(\)/g) || []).length, 1);
  assert.equal((source.match(/resourceRuntimeOwner\.register\(app\)/g) || []).length, 1);
  assert.equal(source.includes("registerResourceHttp"), false);
  assert.equal(source.includes("runWorkerScope"), false);
  assert.equal(source.includes("runControlChild"), false);
}

console.log("resource-runtime-owner.test.js: all assertions passed");
