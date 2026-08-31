"use strict";

// Production-composition tests use only injected read-only fs/exec seams. No
// service, controller, observation, probe, store, or HTTP factory is injected.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CONFIG_PATH } = require("./config");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");
const { ResourceStateStore } = require("./resource-state");
const {
  OBSERVATION_TIMEOUT_MS,
  ResourceRuntimeOwner,
  ResourceRuntimeOwnerError,
  captureResourceRuntimeOwner,
  createResourceRuntimeOwner,
  mergeControllerEvidence,
  resourceStateFilePath,
} = require("./resource-runtime-owner");

const OBSERVED_AT = "2026-08-31T00:00:00.000Z";
const MISSING = Symbol("missing config");

function canonicalTemp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function policy() {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
  };
}

function terminalFact(generationId, character = "a", overrides = {}) {
  return {
    project_id: "project-owner",
    generation_id: generationId,
    resource_class: "worker",
    unit_name: `quadwork-worker-${character.repeat(40)}.scope`,
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

function makeFs(configValue, facts = {}) {
  const wrapper = Object.create(fs);
  const configText = configValue === MISSING
    ? null
    : typeof configValue === "string"
      ? configValue
      : JSON.stringify({ runtime_resources: configValue });
  facts.configReads = 0;
  facts.stateLstats = 0;
  facts.nonConfigWrites = 0;
  let statePath = null;
  Object.defineProperties(wrapper, {
    readFileSync: {
      value(target, ...args) {
        if (String(target) === CONFIG_PATH) {
          facts.configReads += 1;
          if (configText === null) {
            const error = new Error("missing config");
            error.code = "ENOENT";
            throw error;
          }
          return configText;
        }
        return fs.readFileSync(target, ...args);
      },
    },
    lstatSync: {
      value(target, ...args) {
        if (statePath !== null && String(target) === statePath) facts.stateLstats += 1;
        return fs.lstatSync(target, ...args);
      },
    },
    writeFileSync: {
      value(target, ...args) {
        facts.nonConfigWrites += 1;
        return fs.writeFileSync(target, ...args);
      },
    },
    setStatePath: {
      value(value) { statePath = value; },
    },
  });
  return wrapper;
}

function unavailableExec(facts) {
  return function execFileSyncImpl() {
    facts.execCalls = (facts.execCalls || 0) + 1;
    const error = new Error("read-only provider unavailable");
    error.code = "ENOENT";
    throw error;
  };
}

function createConfiguredOwner(homeDir, facts = {}) {
  const fsImpl = makeFs(policy(), facts);
  fsImpl.setStatePath(resourceStateFilePath(homeDir));
  return {
    owner: createResourceRuntimeOwner({
      fsImpl,
      execFileSyncImpl: unavailableExec(facts),
      homeDir,
    }),
    fsImpl,
    facts,
  };
}

assert.equal(resourceStateFilePath("/srv/quadwork"), "/srv/quadwork/.quadwork/resource-state.json");
assert.throws(() => resourceStateFilePath("relative"), /absolute path/);
assert.equal(OBSERVATION_TIMEOUT_MS, 1_000);

// Restart evidence is bounded and current qualified facts replace persisted
// facts with the same immutable identity.
{
  const persisted = Array.from({ length: 100 }, (_, index) => terminalFact(
    `generation-${index}`,
    (index % 16).toString(16),
    { unit_name: `quadwork-worker-${index.toString(16).padStart(40, "0")}.scope` },
  ));
  const replacement = { ...persisted[99], finished_at: "2026-08-31T00:00:01.000Z" };
  const newest = terminalFact("generation-new", "f", { finished_at: "2026-08-31T00:00:02.000Z" });
  const merged = mergeControllerEvidence(
    controllerSnapshot({ terminal_facts: [replacement, newest] }),
    { terminal_facts: persisted },
  );
  assert.equal(merged.terminal_facts.length, 100);
  assert.equal(merged.terminal_facts[0].generation_id, "generation-1");
  assert.equal(merged.terminal_facts.at(-1).generation_id, "generation-new");
  assert.equal(merged.terminal_facts.filter((fact) => fact.generation_id === "generation-99").length, 1);
}

// Missing, malformed, and invalid policy perform exactly one config read and
// no state/probe/controller/service/write work. Legacy authority factories are
// ignored without even reading accessor properties.
for (const configValue of [MISSING, "{not-json", { version: 999 }]) {
  const homeDir = canonicalTemp("qw-owner-invalid-");
  const facts = {};
  const fsImpl = makeFs(configValue, facts);
  fsImpl.setStatePath(resourceStateFilePath(homeDir));
  let legacyGetterCalls = 0;
  const options = { fsImpl, execFileSyncImpl: unavailableExec(facts), homeDir };
  for (const name of [
    "loadRuntimeResources", "createReadOnlyProbes", "createObservationProvider",
    "createControllerAdapter", "createRuntimeService", "createStateStore", "registerHttp",
    "stateDirectoryHandleFactory",
  ]) {
    Object.defineProperty(options, name, {
      get() { legacyGetterCalls += 1; throw new Error(`PRIVATE ${name} /private/factory`); },
    });
  }
  const owner = createResourceRuntimeOwner(options);
  const snapshot = owner.snapshot();
  assert.equal(snapshot.status, "invalid_resource_policy");
  assert.equal(snapshot.pressure.reason, "policy_invalid_or_absent");
  assert.equal(facts.configReads, 1);
  assert.equal(facts.stateLstats, 0);
  assert.equal(facts.nonConfigWrites, 0);
  assert.equal(facts.execCalls || 0, 0);
  assert.equal(legacyGetterCalls, 0);
  assert.throws(
    () => owner.persist(snapshot),
    (error) => error instanceof ResourceRuntimeOwnerError
      && error.code === "QW_RESOURCE_PERSISTENCE_UNAVAILABLE",
  );
  fs.rmSync(homeDir, { recursive: true, force: true });
}

// A configured owner always composes the source-owned synchronous service and
// state store. Read-only host failures remain redacted non-ready facts; snapshots
// never create state, while explicit persistence is one atomic save.
{
  const homeDir = canonicalTemp("qw-owner-configured-");
  fs.mkdirSync(path.join(homeDir, ".quadwork"), { mode: 0o700 });
  const { owner, facts } = createConfiguredOwner(homeDir);
  const statePath = resourceStateFilePath(homeDir);
  assert.equal(facts.configReads, 1);
  assert.equal(fs.existsSync(statePath), false);

  const first = owner.snapshot();
  const second = owner.snapshot();
  assert.notEqual(first.status, "invalid_resource_policy");
  assert.equal(first.version, 1);
  assert.equal(typeof first.pressure.reason, "string");
  assert.equal(second.status, first.status);
  const loadLstats = facts.stateLstats;
  owner.snapshot();
  assert.equal(facts.stateLstats, loadLstats, "state is loaded only at construction");
  assert.equal(fs.existsSync(statePath), false, "snapshot has no implicit persistence");

  if (process.platform === "linux") {
    const saved = owner.persist(first);
    assert.equal(saved.status, first.status);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  } else {
    assert.throws(
      () => owner.persist(first),
      (error) => error instanceof ResourceRuntimeOwnerError
        && error.code === "QW_RESOURCE_PERSISTENCE_FAILED",
      "unsupported platforms expose a redacted refusal rather than a path fallback",
    );
    assert.equal(fs.existsSync(statePath), false);
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
}

// Evidence advances only after a successful source store commit. A failed
// second rename returns one stable typed error and leaves the first evidence.
{
  const homeDir = canonicalTemp("qw-owner-evidence-");
  fs.mkdirSync(path.join(homeDir, ".quadwork"), { mode: 0o700 });
  const { owner, facts } = createConfiguredOwner(homeDir);
  const firstFact = terminalFact("generation-first", "a");
  const secondFact = terminalFact("generation-second", "b");
  if (process.platform === "linux") {
    owner.persist({ ...owner.snapshot(), terminal_facts: [firstFact] });
    assert.equal(owner.snapshot().terminal_facts.some((fact) => fact.generation_id === "generation-first"), true);
    fs.chmodSync(path.join(homeDir, ".quadwork"), 0o755);
  }
  assert.throws(
    () => owner.persist({ ...owner.snapshot(), terminal_facts: [secondFact] }),
    (error) => error instanceof ResourceRuntimeOwnerError
      && error.code === "QW_RESOURCE_PERSISTENCE_FAILED"
      && !error.message.includes("PRIVATE"),
  );
  const afterFailure = owner.snapshot();
  assert.equal(
    afterFailure.terminal_facts.some((fact) => fact.generation_id === "generation-first"),
    process.platform === "linux",
  );
  assert.equal(afterFailure.terminal_facts.some((fact) => fact.generation_id === "generation-second"), false);
  if (process.platform === "linux") fs.chmodSync(path.join(homeDir, ".quadwork"), 0o700);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

// Durable evidence is loaded once on restart. Corrupt state is ignored without
// rewrite or repair during construction/snapshot.
if (process.platform === "linux") {
  const homeDir = canonicalTemp("qw-owner-restart-");
  fs.mkdirSync(path.join(homeDir, ".quadwork"), { mode: 0o700 });
  const first = createConfiguredOwner(homeDir);
  first.owner.persist({ ...first.owner.snapshot(), terminal_facts: [terminalFact("generation-restart", "c")] });

  const restarted = createConfiguredOwner(homeDir);
  const snapshot = restarted.owner.snapshot();
  const restartLoadLstats = restarted.facts.stateLstats;
  assert.equal(restartLoadLstats >= 1, true);
  assert.equal(snapshot.terminal_facts.some((fact) => fact.generation_id === "generation-restart"), true);
  restarted.owner.snapshot();
  assert.equal(restarted.facts.stateLstats, restartLoadLstats);

  const statePath = resourceStateFilePath(homeDir);
  fs.writeFileSync(statePath, "{not-json", { mode: 0o600 });
  const before = fs.readFileSync(statePath, "utf8");
  const corrupt = createConfiguredOwner(homeDir);
  assert.deepEqual(corrupt.owner.snapshot().terminal_facts, []);
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

// Only an exact object present in OWNER_STATE can receive attestation. Class
// lookalikes, prototype forgeries, proxies, and revoked proxies are rejected.
{
  const facts = {};
  const genuine = createResourceRuntimeOwner({
    fsImpl: makeFs(MISSING, facts),
    execFileSyncImpl: unavailableExec(facts),
    homeDir: "/tmp",
  });
  const first = captureResourceRuntimeOwner(genuine);
  const second = captureResourceRuntimeOwner(genuine);
  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.getPrototypeOf(first), null);
  assert.equal(first.snapshot().status, "invalid_resource_policy");

  const lookalike = Object.create(ResourceRuntimeOwner.prototype);
  const proxy = new Proxy(genuine, {});
  const revoked = Proxy.revocable(genuine, {});
  revoked.revoke();
  for (const candidate of [{ snapshot() {} }, function fakeOwner() {}, lookalike, proxy, revoked.proxy]) {
    assert.throws(
      () => captureResourceRuntimeOwner(candidate),
      (error) => error instanceof ResourceRuntimeOwnerError
        && error.code === "QW_RESOURCE_OWNER_INVALID",
    );
  }
}

// Hostile legacy service/store factories cannot create a Promise, intercept a
// save, or become publisher authority through a genuine owner.
(async () => {
  const homeDir = canonicalTemp("qw-owner-legacy-");
  fs.mkdirSync(path.join(homeDir, ".quadwork"), { mode: 0o700 });
  const facts = {};
  const fsImpl = makeFs(policy(), facts);
  fsImpl.setStatePath(resourceStateFilePath(homeDir));
  const calls = { service: 0, store: 0, constructor: 0, species: 0 };
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const owner = createResourceRuntimeOwner({
      fsImpl,
      execFileSyncImpl: unavailableExec(facts),
      homeDir,
      createRuntimeService() {
        calls.service += 1;
        return {
          snapshot() {
            const promise = Promise.reject(new Error("PRIVATE legacy rejection /private/service"));
            Object.defineProperty(promise, "constructor", {
              get() { calls.constructor += 1; throw new Error("PRIVATE constructor"); },
            });
            return promise;
          },
        };
      },
      createStateStore() {
        calls.store += 1;
        return {
          save() {
            const constructor = Object.defineProperty({}, Symbol.species, {
              get() { calls.species += 1; throw new Error("PRIVATE species"); },
            });
            const promise = Promise.reject(new Error("PRIVATE store rejection /private/store"));
            Object.defineProperty(promise, "constructor", { value: constructor });
            return promise;
          },
        };
      },
    });
    const snapshot = owner.snapshot();
    assert.notEqual(snapshot.status, "invalid_resource_policy");
    if (process.platform === "linux") owner.persist(snapshot);
    else assert.throws(
      () => owner.persist(snapshot),
      (error) => error.code === "QW_RESOURCE_PERSISTENCE_FAILED",
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, { service: 0, store: 0, constructor: 0, species: 0 });
    assert.deepEqual(unhandled, []);
    assert.equal(fs.existsSync(resourceStateFilePath(homeDir)), process.platform === "linux");
  } finally {
    process.removeListener("unhandledRejection", listener);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }

  // Source store methods were captured before this prototype sabotage. The
  // fresh instance pins its own source snapshot closure, so neither load nor
  // save can dispatch into these hostile replacements.
  const patchedHome = canonicalTemp("qw-owner-store-prototype-");
  fs.mkdirSync(path.join(patchedHome, ".quadwork"), { mode: 0o700 });
  const patchedFacts = {};
  const patchedFs = makeFs(policy(), patchedFacts);
  patchedFs.setStatePath(resourceStateFilePath(patchedHome));
  const originalLoad = ResourceStateStore.prototype.load;
  const originalSave = ResourceStateStore.prototype.save;
  const originalStoreSnapshot = ResourceStateStore.prototype.snapshot;
  const patchedCalls = { load: 0, save: 0, snapshot: 0 };
  const patchedUnhandled = [];
  const patchedListener = (reason) => patchedUnhandled.push(reason);
  process.on("unhandledRejection", patchedListener);
  try {
    ResourceStateStore.prototype.load = function hostileLoad() {
      patchedCalls.load += 1;
      return Promise.reject(new Error("PRIVATE patched load /private/state"));
    };
    ResourceStateStore.prototype.save = function hostileSave() {
      patchedCalls.save += 1;
      return Promise.reject(new Error("PRIVATE patched save /private/state"));
    };
    ResourceStateStore.prototype.snapshot = function hostileSnapshot() {
      patchedCalls.snapshot += 1;
      return Promise.reject(new Error("PRIVATE patched snapshot /private/state"));
    };

    const owner = createResourceRuntimeOwner({
      fsImpl: patchedFs,
      execFileSyncImpl: unavailableExec(patchedFacts),
      homeDir: patchedHome,
      createRuntimeService() { throw new Error("PRIVATE legacy service"); },
      createStateStore() { throw new Error("PRIVATE legacy store"); },
    });
    const snapshot = owner.snapshot();
    let saved = null;
    if (process.platform === "linux") saved = owner.persist(snapshot);
    else assert.throws(
      () => owner.persist(snapshot),
      (error) => error.code === "QW_RESOURCE_PERSISTENCE_FAILED",
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(patchedCalls, { load: 0, save: 0, snapshot: 0 });
    assert.deepEqual(patchedUnhandled, []);
    if (saved !== null) assert.equal(saved.status, snapshot.status);
    assert.equal(JSON.stringify(saved).includes("PRIVATE"), false);
  } finally {
    ResourceStateStore.prototype.load = originalLoad;
    ResourceStateStore.prototype.save = originalSave;
    ResourceStateStore.prototype.snapshot = originalStoreSnapshot;
    process.removeListener("unhandledRejection", patchedListener);
    fs.rmSync(patchedHome, { recursive: true, force: true });
  }

  // Production composition is owned by index: construct once, then register
  // once after JSON middleware. Owner no longer imports or mounts HTTP.
  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const ownerSource = fs.readFileSync(path.join(__dirname, "resource-runtime-owner.js"), "utf8");
  assert.equal((indexSource.match(/createResourceRuntimeOwner\(\)/g) || []).length, 1);
  assert.equal((indexSource.match(/registerResourceHttp\(app, resourceRuntimeOwner\)/g) || []).length, 1);
  assert(indexSource.indexOf('app.use(express.json({ limit: "10mb" }))')
    < indexSource.indexOf("registerResourceHttp(app, resourceRuntimeOwner)"));
  assert.equal(ownerSource.includes('require("./resource-http")'), false);
  assert.equal(ownerSource.includes("register(app)"), false);
  assert.equal(indexSource.includes("runWorkerScope"), false);
  assert.equal(indexSource.includes("runControlChild"), false);

  console.log("resource-runtime-owner.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
