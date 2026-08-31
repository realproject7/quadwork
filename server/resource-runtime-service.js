"use strict";

const { parseRuntimeResources } = require("./resource-policy");
const { runResourcePreflight } = require("./resource-preflight");
const { createWorkerUnitBase } = require("./resource-unit");
const {
  buildResourceRuntimeSnapshot,
  persistResourceRuntimeSnapshot,
} = require("./resource-runtime-snapshot");

const MAX_ACTIVE_SCOPES = 1_000;
const PROBE_NAMES = Object.freeze([
  "memory",
  "containment",
  "temp",
  "api",
  "activeScopes",
]);
const SERVICE_STATE = new WeakMap();
const UNREADABLE = Symbol("unreadable runtime service field");

function safeGet(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return UNREADABLE;
  try {
    return value[key];
  } catch {
    return UNREADABLE;
  }
}

function captureMethod(receiver, name, { required = false } = {}) {
  const method = safeGet(receiver, name);
  if (typeof method !== "function") {
    if (!required) return null;
    throw new TypeError(`${name} must be dependency-injected as a function`);
  }
  return (...args) => Reflect.apply(method, receiver, args);
}

function captureProbes(probes) {
  const captured = Object.create(null);
  for (const name of PROBE_NAMES) {
    const method = captureMethod(probes, name);
    if (method !== null) captured[name] = method;
  }
  return Object.freeze(captured);
}

function safeCall(method, ...args) {
  try {
    return method(...args);
  } catch {
    // Runtime dependencies may expose command output, host paths, or secrets in
    // their errors. The snapshot builder receives absence, never raw failures.
    return undefined;
  }
}

function canonicalPolicy(runtimeResources) {
  try {
    return parseRuntimeResources(runtimeResources);
  } catch {
    return null;
  }
}

function safeArray(value, maximum) {
  let array;
  try {
    array = Array.isArray(value);
  } catch {
    return null;
  }
  if (!array) return null;
  const length = safeGet(value, "length");
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const entry = safeGet(value, index);
    if (entry === UNREADABLE) return null;
    output.push(entry);
  }
  return output;
}

function activeWorkerIdentities(controllerSnapshot, policy) {
  if (policy === null) return null;
  const maximum = Math.min(MAX_ACTIVE_SCOPES, policy.max_worker_scopes);
  const active = safeArray(safeGet(controllerSnapshot, "active_scopes"), MAX_ACTIVE_SCOPES);
  if (active === null) return null;

  const workers = [];
  const seen = new Set();
  for (const entry of active) {
    const resourceClass = safeGet(entry, "resource_class");
    if (resourceClass !== "worker" && resourceClass !== "control") return null;
    if (resourceClass === "control") continue;

    const projectId = safeGet(entry, "project_id");
    const generationId = safeGet(entry, "generation_id");
    const suppliedUnit = safeGet(entry, "unit_name");
    let expectedUnit;
    try {
      expectedUnit = createWorkerUnitBase({ projectId, generationId });
    } catch {
      return null;
    }
    // Never probe a computed unit unless that exact unit is present in the
    // controller's own active snapshot. The provider receives no caller-owned
    // unit string and derives the scope identity again from the qualifiers.
    if (suppliedUnit !== expectedUnit || seen.has(expectedUnit) || workers.length >= maximum) return null;
    seen.add(expectedUnit);
    workers.push(Object.freeze({ projectId, generationId }));
  }
  return Object.freeze(workers);
}

function collectPreflight(runtimeResources, probes) {
  try {
    return runResourcePreflight({
      runtimeResources,
      probes,
      requestedWorkerScopes: 0,
    });
  } catch {
    return undefined;
  }
}

class ResourceRuntimeService {
  constructor({
    runtimeResources,
    probes,
    controllerAdapter,
    observationProvider,
    proofAuthority,
  } = {}) {
    const controllerSnapshot = captureMethod(controllerAdapter, "snapshot", { required: true });
    const observeApiSelf = captureMethod(observationProvider, "observeApiSelf", { required: true });
    const observeControlAggregate = captureMethod(observationProvider, "observeControlAggregate", { required: true });
    const observeWorker = captureMethod(observationProvider, "observeWorker", { required: true });
    SERVICE_STATE.set(this, Object.freeze({
      runtimeResources,
      probes: captureProbes(probes),
      controllerSnapshot,
      observeApiSelf,
      observeControlAggregate,
      observeWorker,
      proofAuthority,
    }));
    Object.freeze(this);
  }

  snapshot() {
    const dependencies = SERVICE_STATE.get(this);
    if (!dependencies) throw new TypeError("ResourceRuntimeService receiver is invalid");

    const policy = canonicalPolicy(dependencies.runtimeResources);
    const preflightReport = collectPreflight(policy, dependencies.probes);
    const controllerSnapshot = safeCall(dependencies.controllerSnapshot);
    const apiObservation = safeCall(dependencies.observeApiSelf);
    const controlObservation = safeCall(dependencies.observeControlAggregate);
    const identities = activeWorkerIdentities(controllerSnapshot, policy);
    const controllerForBuilder = identities === null ? undefined : controllerSnapshot;
    const workerObservations = identities === null
      ? []
      : identities.map((identity) => safeCall(dependencies.observeWorker, identity));

    try {
      return buildResourceRuntimeSnapshot({
        runtimeResources: policy,
        preflightReport,
        controllerSnapshot: controllerForBuilder,
        apiObservation,
        controlObservation,
        workerObservations,
        proofAuthority: dependencies.proofAuthority,
      });
    } catch {
      // A hostile dependency result must not escape through the service. The
      // canonical policy still lets the shared builder return a typed,
      // redacted non-ready snapshot without re-running any probe.
      return buildResourceRuntimeSnapshot({ runtimeResources: policy });
    }
  }

  persist(snapshot, store) {
    return persistResourceRuntimeSnapshot(store, snapshot);
  }
}

function createResourceRuntimeService(options) {
  return new ResourceRuntimeService(options);
}

module.exports = {
  MAX_ACTIVE_SCOPES,
  ResourceRuntimeService,
  createResourceRuntimeService,
};
