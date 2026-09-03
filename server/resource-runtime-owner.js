"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { readRuntimeResources } = require("./config");
const { createReadOnlyProbes } = require("./resource-preflight");
const { ResourceObservationProvider } = require("./resource-observation");
const { createResourceControllerAdapter } = require("./resource-controller-adapter");
const {
  ResourceRuntimeService,
  createResourceRuntimeService,
} = require("./resource-runtime-service");
const { parseRuntimeResources } = require("./resource-policy");
const {
  DEFAULT_TERMINAL_FACT_LIMIT,
  ResourceStateStore,
  createResourceSnapshot,
} = require("./resource-state");

const RESOURCE_STATE_FILENAME = "resource-state.json";
const OBSERVATION_TIMEOUT_MS = 1_000;
const OWNER_STATE = new WeakMap();
const OWNER_ATTESTATIONS = new WeakMap();
const SOURCE_RUNTIME_SNAPSHOT = ResourceRuntimeService.prototype.snapshot;
const SOURCE_STATE_LOAD = ResourceStateStore.prototype.load;
const SOURCE_STATE_SAVE = ResourceStateStore.prototype.save;
const SOURCE_STATE_SNAPSHOT = ResourceStateStore.prototype.snapshot;

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

function optionData(options, key, fallback) {
  if (!options || (typeof options !== "object" && typeof options !== "function")) return fallback;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(options, key);
    return descriptor && "value" in descriptor && descriptor.value !== undefined
      ? descriptor.value
      : fallback;
  } catch {
    return fallback;
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

function ownerSnapshot(state) {
  if (state.runtimeService === null) return state.fallbackSnapshot;
  try {
    return Reflect.apply(SOURCE_RUNTIME_SNAPSHOT, state.runtimeService, []);
  } catch {
    return state.fallbackSnapshot;
  }
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
    // Only low-level, read-only I/O seams remain injectable for deterministic
    // fixtures. Legacy factory options are deliberately never read or invoked;
    // they cannot become snapshot, publisher, or persistence authority.
    const fsImpl = optionData(options, "fsImpl", fs);
    const execFileSyncImpl = optionData(options, "execFileSyncImpl", execFileSync);
    const homeDir = optionData(options, "homeDir", os.homedir());

    let policy = null;
    try {
      policy = parseRuntimeResources(readRuntimeResources({ fsImpl }));
    } catch {
      policy = null;
    }

    if (policy === null) {
      OWNER_STATE.set(this, {
        fallbackSnapshot: canonicalFallbackSnapshot(false),
        runtimeService: null,
        stateStore: null,
        persistedEvidence: evidenceOnly(null),
      });
      Object.freeze(this);
      return;
    }

    let stateStore = null;
    let persistedEvidence = evidenceOnly(null);
    try {
      stateStore = new ResourceStateStore({
        filePath: resourceStateFilePath(homeDir),
        fsImpl,
        terminalFactLimit: DEFAULT_TERMINAL_FACT_LIMIT,
      });
      // Source load/save historically dispatch through `this.snapshot()`. Pin
      // that internal edge on the fresh private instance before either method
      // runs so later prototype replacement cannot inject a Promise/result.
      Object.defineProperty(stateStore, "snapshot", {
        value: () => Reflect.apply(SOURCE_STATE_SNAPSHOT, stateStore, []),
        enumerable: false,
        configurable: false,
        writable: false,
      });
      // Durable state is read exactly once during owner construction. Runtime
      // GETs never touch the state path.
      Reflect.apply(SOURCE_STATE_LOAD, stateStore, []);
      persistedEvidence = evidenceOnly(Reflect.apply(SOURCE_STATE_SNAPSHOT, stateStore, []));
    } catch {
      stateStore = null;
    }

    const fallbackSnapshot = canonicalFallbackSnapshot(true);
    const state = {
      fallbackSnapshot,
      runtimeService: null,
      stateStore,
      persistedEvidence,
    };
    try {
      const probes = createReadOnlyProbes({
        fsImpl,
        execFileSyncImpl,
        scopeProof: false,
      });
      const observationProvider = new ResourceObservationProvider({
        fsImpl,
        execFileSyncImpl,
        timeoutMs: OBSERVATION_TIMEOUT_MS,
      });
      const controller = createResourceControllerAdapter({
        policy,
        observationProvider,
        executeProcess: unavailableExecutor,
      });
      const controllerSnapshot = captureDataMethod(controller, "snapshot");
      if (controllerSnapshot === null) throw new TypeError("controller snapshot is unavailable");
      const snapshotOnlyController = Object.freeze({
        snapshot: () => mergeControllerEvidence(controllerSnapshot(), state.persistedEvidence),
      });
      state.runtimeService = createResourceRuntimeService({
        runtimeResources: policy,
        probes,
        controllerAdapter: snapshotOnlyController,
        observationProvider,
      });
    } catch {
      state.runtimeService = null;
    }
    OWNER_STATE.set(this, state);
    Object.freeze(this);
  }

  snapshot() {
    const state = OWNER_STATE.get(this);
    if (!state) throw new TypeError("ResourceRuntimeOwner receiver is invalid");
    return ownerSnapshot(state);
  }

  persist(snapshot) {
    const state = OWNER_STATE.get(this);
    if (!state) throw new TypeError("ResourceRuntimeOwner receiver is invalid");
    if (state.stateStore === null || state.runtimeService === null) {
      throw persistenceError("QW_RESOURCE_PERSISTENCE_UNAVAILABLE");
    }
    const input = arguments.length === 0 ? this.snapshot() : snapshot;
    try {
      Reflect.apply(SOURCE_STATE_SAVE, state.stateStore, [input]);
    } catch {
      throw persistenceError("QW_RESOURCE_PERSISTENCE_FAILED");
    }
    let canonical;
    try {
      const sourceSnapshot = Reflect.apply(SOURCE_STATE_SNAPSHOT, state.stateStore, []);
      canonical = createResourceSnapshot(sourceSnapshot, { terminalFactLimit: DEFAULT_TERMINAL_FACT_LIMIT });
      state.persistedEvidence = evidenceOnly(canonical);
    } catch {
      throw persistenceError("QW_RESOURCE_PERSISTENCE_FAILED");
    }
    return canonical;
  }
}

function createResourceRuntimeOwner(options) {
  return new ResourceRuntimeOwner(options);
}

function captureResourceRuntimeOwner(owner) {
  const state = OWNER_STATE.get(owner);
  if (!state) {
    throw new ResourceRuntimeOwnerError(
      "QW_RESOURCE_OWNER_INVALID",
      "resource HTTP publication requires a genuine runtime owner",
    );
  }
  let attestation = OWNER_ATTESTATIONS.get(owner);
  if (!attestation) {
    attestation = Object.freeze(Object.assign(Object.create(null), {
      snapshot: () => ownerSnapshot(state),
    }));
    OWNER_ATTESTATIONS.set(owner, attestation);
  }
  return attestation;
}

module.exports = {
  RESOURCE_STATE_FILENAME,
  OBSERVATION_TIMEOUT_MS,
  ResourceRuntimeOwnerError,
  ResourceRuntimeOwner,
  createResourceRuntimeOwner,
  captureResourceRuntimeOwner,
  resourceStateFilePath,
  mergeControllerEvidence,
};
