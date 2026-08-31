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
const { parseRuntimeResources } = require("./resource-policy");
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

function safeGet(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function captureDataMethod(receiver, name) {
  if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null) return null;
  let current = receiver;
  try {
    for (let depth = 0; current !== null && depth < 16; depth += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
        const method = descriptor.value;
        return (...args) => Reflect.apply(method, receiver, args);
      }
      current = Reflect.getPrototypeOf(current);
    }
  } catch {
    return null;
  }
  return null;
}

function canonicalFallbackSnapshot(policyConfigured) {
  const status = policyConfigured ? "unavailable" : "invalid_resource_policy";
  const reason = policyConfigured ? "preflight_report_invalid" : "policy_invalid_or_absent";
  const state = createResourceSnapshot({ status });
  return Object.freeze({
    ...state,
    pressure: Object.freeze({ status, reason }),
    effective_limits: null,
    resource_usage: null,
    scope_capacity: null,
    worker_scopes: null,
  });
}

function persistenceError(code) {
  return new ResourceRuntimeOwnerError(
    code,
    code === "QW_RESOURCE_PERSISTENCE_FAILED"
      ? "resource snapshot persistence failed"
      : "resource persistence is unavailable without a safe runtime service and state store",
  );
}

function evidenceOnly(value) {
  return createResourceSnapshot({
    last_cgroup_oom: safeGet(value, "last_cgroup_oom"),
    terminal_facts: safeGet(value, "terminal_facts"),
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
      policy = parseRuntimeResources(loadPolicy());
    } catch {
      policy = null;
    }

    if (policy === null) {
      OWNER_STATE.set(this, {
        fallbackSnapshot: canonicalFallbackSnapshot(false),
        snapshotMethod: null,
        persistMethod: null,
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
      const candidateStore = makeStore({
        filePath: resourceStateFilePath(homeDir),
        fsImpl,
        terminalFactLimit: DEFAULT_TERMINAL_FACT_LIMIT,
      });
      const loadState = captureDataMethod(candidateStore, "load");
      const saveState = captureDataMethod(candidateStore, "save");
      if (loadState === null || saveState === null) throw new TypeError("resource state store is unavailable");
      // Durable state is read exactly once during owner construction. Runtime
      // GETs never touch the state path.
      persistedEvidence = evidenceOnly(loadState());
      // Runtime persistence receives only this source-owned facade. It cannot
      // trigger a caller-owned save accessor while validating the store.
      stateStore = Object.freeze({ save: (snapshot) => saveState(snapshot) });
    } catch {
      stateStore = null;
    }

    const fallbackSnapshot = canonicalFallbackSnapshot(true);
    const state = {
      fallbackSnapshot,
      snapshotMethod: null,
      persistMethod: null,
      stateStore,
      persistedEvidence,
      registerHttp,
      registeredApp: null,
      httpHandler: null,
    };
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
      const controllerSnapshot = captureDataMethod(controller, "snapshot");
      if (controllerSnapshot === null) throw new TypeError("controller snapshot is unavailable");
      const snapshotOnlyController = Object.freeze({
        snapshot: () => mergeControllerEvidence(controllerSnapshot(), state.persistedEvidence),
      });
      const runtimeService = makeService({
        runtimeResources: policy,
        probes,
        controllerAdapter: snapshotOnlyController,
        observationProvider,
      });
      const snapshotMethod = captureDataMethod(runtimeService, "snapshot");
      if (snapshotMethod === null) throw new TypeError("runtime service snapshot is unavailable");
      state.snapshotMethod = snapshotMethod;
      state.persistMethod = captureDataMethod(runtimeService, "persist");
    } catch {
      // The source-owned fallback is already installed. Never retry a failed
      // dependency factory or expose its error through the owner boundary.
    }
    OWNER_STATE.set(this, state);
    Object.freeze(this);
  }

  snapshot() {
    const state = OWNER_STATE.get(this);
    if (!state) throw new TypeError("ResourceRuntimeOwner receiver is invalid");
    if (state.snapshotMethod === null) return state.fallbackSnapshot;
    try {
      return state.snapshotMethod();
    } catch {
      return state.fallbackSnapshot;
    }
  }

  persist(snapshot) {
    const state = OWNER_STATE.get(this);
    if (!state) throw new TypeError("ResourceRuntimeOwner receiver is invalid");
    if (state.stateStore === null || state.persistMethod === null) {
      throw persistenceError("QW_RESOURCE_PERSISTENCE_UNAVAILABLE");
    }
    const input = arguments.length === 0 ? this.snapshot() : snapshot;
    let saved;
    try {
      saved = state.persistMethod(input, state.stateStore);
    } catch {
      throw persistenceError("QW_RESOURCE_PERSISTENCE_FAILED");
    }
    let canonical;
    try {
      canonical = createResourceSnapshot(saved, { terminalFactLimit: DEFAULT_TERMINAL_FACT_LIMIT });
      state.persistedEvidence = evidenceOnly(canonical);
    } catch {
      throw persistenceError("QW_RESOURCE_PERSISTENCE_FAILED");
    }
    return canonical;
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
