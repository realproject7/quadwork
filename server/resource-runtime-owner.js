"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { readRuntimeResources } = require("./config");
const { createReadOnlyProbes } = require("./resource-preflight");
const { ResourceObservationProvider } = require("./resource-observation");
const { createResourceControllerAdapter } = require("./resource-controller-adapter");
const { createResourceRuntimeService } = require("./resource-runtime-service");
const {
  DEFAULT_TERMINAL_FACT_LIMIT,
  ResourceStateStore,
  createResourceSnapshot,
} = require("./resource-state");
const { registerResourceHttp } = require("./resource-http");

const RESOURCE_STATE_FILENAME = "resource-state.json";
const OBSERVATION_TIMEOUT_MS = 1_000;
const OWNER_STATE = new WeakMap();

class ResourceRuntimeOwnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResourceRuntimeOwnerError";
    this.code = code;
  }
}

function resourceStateFilePath(homeDir = os.homedir()) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw new TypeError("homeDir must be an absolute path");
  }
  return path.join(homeDir, ".quadwork", RESOURCE_STATE_FILENAME);
}

function unavailableExecutor() {
  throw new ResourceRuntimeOwnerError(
    "QW_RESOURCE_CANDIDATE_UNAVAILABLE",
    "resource process execution is unavailable until staging proof is pinned",
  );
}

const INERT_CONTROLLER = Object.freeze({ snapshot: () => undefined });
const INERT_OBSERVATION = Object.freeze({
  observeApiSelf: () => undefined,
  observeControlAggregate: () => undefined,
  observeWorker: () => undefined,
});

function evidenceOnly(value) {
  return createResourceSnapshot({
    last_cgroup_oom: value && value.last_cgroup_oom,
    terminal_facts: value && value.terminal_facts,
  }, { terminalFactLimit: DEFAULT_TERMINAL_FACT_LIMIT });
}

function terminalFactIdentity(fact) {
  return JSON.stringify([
    fact.project_id,
    fact.generation_id,
    fact.resource_class,
    fact.unit_name,
  ]);
}

function mergeControllerEvidence(controllerSnapshot, persistedEvidence) {
  if (!controllerSnapshot || typeof controllerSnapshot !== "object") return controllerSnapshot;
  const persisted = evidenceOnly(persistedEvidence);
  const current = evidenceOnly(controllerSnapshot);
  const merged = new Map();
  for (const fact of persisted.terminal_facts) merged.set(terminalFactIdentity(fact), fact);
  for (const fact of current.terminal_facts) {
    const identity = terminalFactIdentity(fact);
    // Reinsert current evidence so it wins both value and recency for one
    // immutable resource identity.
    merged.delete(identity);
    merged.set(identity, fact);
  }
  const terminalFacts = [...merged.values()].slice(-DEFAULT_TERMINAL_FACT_LIMIT);
  const lastCgroupOom = current.last_cgroup_oom === null
    ? persisted.last_cgroup_oom
    : current.last_cgroup_oom;
  const sanitized = createResourceSnapshot({
    last_cgroup_oom: lastCgroupOom,
    terminal_facts: terminalFacts,
  }, { terminalFactLimit: DEFAULT_TERMINAL_FACT_LIMIT });
  return {
    ...controllerSnapshot,
    last_cgroup_oom: sanitized.last_cgroup_oom,
    terminal_facts: sanitized.terminal_facts,
  };
}

function invalidPolicyService(createService) {
  return createService({
    runtimeResources: null,
    probes: Object.freeze({}),
    controllerAdapter: INERT_CONTROLLER,
    observationProvider: INERT_OBSERVATION,
  });
}

class ResourceRuntimeOwner {
  constructor(options = {}) {
    const loadPolicy = options.loadRuntimeResources || readRuntimeResources;
    const makeProbes = options.createReadOnlyProbes || createReadOnlyProbes;
    const makeObservationProvider = options.createObservationProvider
      || ((providerOptions) => new ResourceObservationProvider(providerOptions));
    const makeControllerAdapter = options.createControllerAdapter || createResourceControllerAdapter;
    const makeService = options.createRuntimeService || createResourceRuntimeService;
    const makeStore = options.createStateStore
      || ((storeOptions) => new ResourceStateStore(storeOptions));
    const registerHttp = options.registerHttp || registerResourceHttp;
    const fsImpl = options.fsImpl || fs;
    const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
    const homeDir = options.homeDir || os.homedir();

    let policy = null;
    try {
      policy = loadPolicy();
    } catch {
      policy = null;
    }

    if (policy === null) {
      OWNER_STATE.set(this, {
        runtimeService: invalidPolicyService(makeService),
        stateStore: null,
        persistedEvidence: evidenceOnly(null),
        registerHttp,
        registeredApp: null,
        httpHandler: null,
      });
      Object.freeze(this);
      return;
    }

    let stateStore = null;
    let persistedEvidence = evidenceOnly(null);
    try {
      stateStore = makeStore({
        filePath: resourceStateFilePath(homeDir),
        fsImpl,
        terminalFactLimit: DEFAULT_TERMINAL_FACT_LIMIT,
      });
      // Durable state is read exactly once during owner construction. Runtime
      // GETs never touch the state path.
      persistedEvidence = evidenceOnly(stateStore.load());
    } catch {
      stateStore = null;
    }

    let runtimeService;
    try {
      const probes = makeProbes({
        fsImpl,
        execFileSyncImpl,
        scopeProof: false,
      });
      const observationProvider = makeObservationProvider({
        fsImpl,
        execFileSyncImpl,
        timeoutMs: OBSERVATION_TIMEOUT_MS,
      });
      const controller = makeControllerAdapter({
        policy,
        observationProvider,
        executeProcess: unavailableExecutor,
      });
      const controllerSnapshot = controller.snapshot.bind(controller);
      const state = {
        runtimeService: null,
        stateStore,
        persistedEvidence,
        registerHttp,
        registeredApp: null,
        httpHandler: null,
      };
      const snapshotOnlyController = Object.freeze({
        snapshot: () => mergeControllerEvidence(controllerSnapshot(), state.persistedEvidence),
      });
      runtimeService = makeService({
        runtimeResources: policy,
        probes,
        controllerAdapter: snapshotOnlyController,
        observationProvider,
      });
      state.runtimeService = runtimeService;
      OWNER_STATE.set(this, state);
    } catch {
      // Composition failure is a typed, redacted non-ready snapshot. Do not
      // fall back to a launcher or surface a dependency error.
      runtimeService = makeService({
        runtimeResources: policy,
        probes: Object.freeze({}),
        controllerAdapter: INERT_CONTROLLER,
        observationProvider: INERT_OBSERVATION,
      });
      OWNER_STATE.set(this, {
        runtimeService,
        stateStore,
        persistedEvidence,
        registerHttp,
        registeredApp: null,
        httpHandler: null,
      });
    }
    Object.freeze(this);
  }

  snapshot() {
    const state = OWNER_STATE.get(this);
    if (!state) throw new TypeError("ResourceRuntimeOwner receiver is invalid");
    return state.runtimeService.snapshot();
  }

  persist(snapshot = this.snapshot()) {
    const state = OWNER_STATE.get(this);
    if (!state) throw new TypeError("ResourceRuntimeOwner receiver is invalid");
    if (state.stateStore === null) {
      throw new ResourceRuntimeOwnerError(
        "QW_RESOURCE_PERSISTENCE_UNAVAILABLE",
        "resource persistence is unavailable without a configured state store",
      );
    }
    const saved = state.runtimeService.persist(snapshot, state.stateStore);
    state.persistedEvidence = evidenceOnly(saved);
    return saved;
  }

  register(app) {
    const state = OWNER_STATE.get(this);
    if (!state) throw new TypeError("ResourceRuntimeOwner receiver is invalid");
    if (state.registeredApp !== null) {
      if (state.registeredApp !== app) {
        throw new ResourceRuntimeOwnerError(
          "QW_RESOURCE_HTTP_ALREADY_REGISTERED",
          "resource HTTP endpoint is already registered",
        );
      }
      return state.httpHandler;
    }
    const handler = state.registerHttp(app, this);
    state.registeredApp = app;
    state.httpHandler = handler;
    return handler;
  }
}

function createResourceRuntimeOwner(options) {
  return new ResourceRuntimeOwner(options);
}

module.exports = {
  RESOURCE_STATE_FILENAME,
  OBSERVATION_TIMEOUT_MS,
  ResourceRuntimeOwnerError,
  ResourceRuntimeOwner,
  createResourceRuntimeOwner,
  resourceStateFilePath,
  mergeControllerEvidence,
};
