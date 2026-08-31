"use strict";

const {
  RESOURCE_STATE_VERSION,
  createResourceSnapshot,
} = require("./resource-state");
const { types: utilTypes } = require("node:util");
const { captureResourceRuntimeOwner } = require("./resource-runtime-owner");

const RESOURCE_HTTP_PATH = "/api/resources";
const MAX_RESOURCE_HTTP_BYTES = 1024 * 1024;
const MAX_RESOURCE_HTTP_DEPTH = 16;
const MAX_RESOURCE_HTTP_NODES = 50_000;
const MAX_RESOURCE_HTTP_ARRAY_ITEMS = 1_000;
const INVALID = Symbol("invalid resource HTTP field");

const TOP_LEVEL_FIELDS = new Set([
  "version", "status", "counts", "limits", "usage", "temp",
  "last_cgroup_oom", "terminal_facts", "pressure", "effective_limits",
  "resource_usage", "scope_capacity", "worker_scopes",
]);
const STATE_FIELDS = Object.freeze([
  "version", "status", "counts", "limits", "usage", "temp",
  "last_cgroup_oom", "terminal_facts",
]);
const STATUS_REASONS = new Map([
  ["ready", new Set(["ok"])],
  ["degraded", new Set(["runtime_snapshot_inconsistent"])],
  ["unavailable", new Set(["preflight_report_invalid"])],
  ["invalid_resource_policy", new Set([
    "policy_invalid_or_absent", "preflight_invalid_resource_policy",
  ])],
  ["containment_unavailable", new Set([
    "preflight_containment_unavailable", "controller_snapshot_invalid",
    "controller_protocol_unavailable", "runtime_observation_inconsistent",
    "api_self_identity_unproven",
  ])],
  ["temp_unavailable", new Set(["preflight_temp_unavailable"])],
  ["capacity_exhausted", new Set(["preflight_capacity_exhausted"])],
  ["candidate_pending_staging", new Set([
    "staging_proof_pending", "proof_authority_unavailable",
  ])],
]);
const LIMIT_FIELDS = new Set([
  "memory_low", "memory_high", "memory_max", "memory_swap_max",
]);
const OBSERVATION_USAGE_FIELDS = new Set([
  "memory_current_bytes", "memory_peak_bytes", "memory_swap_current_bytes",
]);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKER_UNIT_BASE_RE = /^quadwork-worker-[a-f0-9]{40}$/;
const SYSTEMD_UNIT_RE = /^[a-z][a-z0-9.-]{0,127}\.(?:service|scope)$/;
const UINT64_RE = /^(?:0|[1-9]\d{0,19})$/;
const UINT64_MAX = (1n << 64n) - 1n;
const ASYNC_FUNCTION_PROTOTYPE = Reflect.getPrototypeOf(async function resourceHttpAsyncMarker() {});
const RESOURCE_HTTP_PUBLISHERS = new WeakMap();
const RESOURCE_HTTP_REGISTRATIONS = new WeakMap();
const RESOURCE_HTTP_APPS = new WeakMap();

const ERROR_RESPONSES = Object.freeze({
  method: Object.freeze({
    version: RESOURCE_STATE_VERSION,
    status: "unavailable",
    code: "QW_RESOURCE_HTTP_METHOD_NOT_ALLOWED",
    reason: "method_not_allowed",
  }),
  body: Object.freeze({
    version: RESOURCE_STATE_VERSION,
    status: "unavailable",
    code: "QW_RESOURCE_HTTP_BODY_NOT_ALLOWED",
    reason: "request_body_not_allowed",
  }),
  snapshot: Object.freeze({
    version: RESOURCE_STATE_VERSION,
    status: "unavailable",
    code: "QW_RESOURCE_SNAPSHOT_UNAVAILABLE",
    reason: "resource_snapshot_unavailable",
  }),
});

function safeGet(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return INVALID;
  try {
    return Reflect.get(value, key);
  } catch {
    return INVALID;
  }
}

function dataMethod(receiver, name) {
  if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null) return null;
  let current = receiver;
  try {
    for (let depth = 0; current !== null && depth < 16; depth += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
      if (descriptor) return "value" in descriptor && typeof descriptor.value === "function"
        ? descriptor.value
        : null;
      current = Reflect.getPrototypeOf(current);
    }
  } catch {
    return null;
  }
  return null;
}

function isDetectableAsyncFunction(value) {
  try {
    return utilTypes.isAsyncFunction(value)
      || Reflect.getPrototypeOf(value) === ASYNC_FUNCTION_PROTOTYPE;
  } catch {
    return true;
  }
}

function createResourceHttpPublisher(ownerAttestation) {
  const method = dataMethod(ownerAttestation, "snapshot");
  // HTTP is a strictly synchronous, server-owned publication boundary. An
  // AsyncFunction necessarily creates a Promise before its result can be
  // rejected. Refuse it before invocation so even a sabotaged native Promise
  // cannot escape as an unhandled rejection.
  const snapshot = method !== null && !isDetectableAsyncFunction(method) ? method : null;
  const publisher = Object.freeze(Object.create(null));
  RESOURCE_HTTP_PUBLISHERS.set(publisher, Object.freeze({ ownerAttestation, snapshot }));
  return publisher;
}

function ignoreAsyncSettlement() {}

function consumeNativePromise(value) {
  try {
    // Bypass an overridden or accessor-backed `.then` while performing the
    // platform brand check. Both branches resolve the derived promise, so the
    // raw fulfillment/rejection value never crosses this boundary.
    Reflect.apply(Promise.prototype.then, value, [
      ignoreAsyncSettlement,
      ignoreAsyncSettlement,
    ]);
    return true;
  } catch {
    return false;
  }
}

function consumeAsyncSnapshot(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  if (consumeNativePromise(value)) return true;

  // Arbitrary thenables are recognized only through a descriptor-safe data
  // method, then discarded without assimilation. Invoking caller-owned `then`
  // code could itself mutate state, launch work, or throw asynchronously.
  // Accessors, revoked proxies, and hostile prototype traps are never invoked.
  const then = dataMethod(value, "then");
  return then !== null;
}

function exactKeys(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= allowed.size
    && keys.every((key) => allowed.has(key))
    && [...required].every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJson(entry, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && sameJson(left[key], right[key]));
}

function captureJson(value, state, depth = 0) {
  if (depth > MAX_RESOURCE_HTTP_DEPTH || state.nodes >= MAX_RESOURCE_HTTP_NODES) throw INVALID;
  state.nodes += 1;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw INVALID;
    return value;
  }
  if (typeof value !== "object") throw INVALID;

  let prototype;
  let keys;
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw INVALID;
  }
  if (state.active.has(value)) throw INVALID;
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw INVALID;
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESOURCE_HTTP_ARRAY_ITEMS
        || keys.length !== length + 1 || !keys.includes("length")) throw INVALID;
      const output = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) throw INVALID;
        output.push(captureJson(descriptor.value, state, depth + 1));
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) throw INVALID;
    if (keys.length > 256) throw INVALID;
    const output = {};
    for (const key of keys) {
      if (typeof key !== "string") throw INVALID;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) throw INVALID;
      Object.defineProperty(output, key, {
        value: captureJson(descriptor.value, state, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } catch {
    throw INVALID;
  } finally {
    state.active.delete(value);
  }
}

function uint64(value) {
  if (typeof value !== "string" || !UINT64_RE.test(value)) return false;
  try {
    return BigInt(value) <= UINT64_MAX;
  } catch {
    return false;
  }
}

function canonicalTime(value) {
  if (typeof value !== "string" || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  try {
    return new Date(milliseconds).toISOString() === value;
  } catch {
    return false;
  }
}

function validLimit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.kind === "infinite") return exactKeys(value, new Set(["kind"]));
  return value.kind === "finite"
    && exactKeys(value, new Set(["kind", "bytes"]))
    && uint64(value.bytes);
}

function validLimitSet(value) {
  return exactKeys(value, LIMIT_FIELDS)
    && [...LIMIT_FIELDS].every((field) => validLimit(value[field]));
}

function validObservationUsage(value) {
  return exactKeys(value, OBSERVATION_USAGE_FIELDS)
    && [...OBSERVATION_USAGE_FIELDS].every((field) => uint64(value[field]));
}

function validEffectiveLimits(value) {
  if (value === null) return true;
  const allowed = new Set(["api", "control", "worker"]);
  const required = new Set(["control", "worker"]);
  if (!exactKeys(value, allowed, required) || !validLimitSet(value.control)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "api") && !validLimitSet(value.api)) return false;
  const worker = value.worker;
  if (!exactKeys(worker, new Set(["observed_scopes", "limits"]))) return false;
  if (!Number.isSafeInteger(worker.observed_scopes)
    || worker.observed_scopes < 0
    || worker.observed_scopes > MAX_RESOURCE_HTTP_ARRAY_ITEMS) return false;
  return worker.observed_scopes === 0
    ? worker.limits === null
    : validLimitSet(worker.limits);
}

function validResourceUsage(value) {
  if (value === null) return true;
  const allowed = new Set(["api", "control", "worker"]);
  const required = new Set(["control", "worker"]);
  if (!exactKeys(value, allowed, required) || !validObservationUsage(value.control)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "api")) {
    const api = value.api;
    if (!exactKeys(api, new Set(["unit_name", ...OBSERVATION_USAGE_FIELDS]))
      || typeof api.unit_name !== "string"
      || !SYSTEMD_UNIT_RE.test(api.unit_name)
      || ![...OBSERVATION_USAGE_FIELDS].every((field) => uint64(api[field]))) return false;
  }
  const worker = value.worker;
  return exactKeys(worker, new Set([
    "observed_scopes", "memory_current_bytes", "sum_of_scope_peaks_bytes",
    "memory_swap_current_bytes",
  ]))
    && Number.isSafeInteger(worker.observed_scopes)
    && worker.observed_scopes >= 0
    && worker.observed_scopes <= MAX_RESOURCE_HTTP_ARRAY_ITEMS
    && uint64(worker.memory_current_bytes)
    && uint64(worker.sum_of_scope_peaks_bytes)
    && uint64(worker.memory_swap_current_bytes);
}

function validScopeCapacity(value) {
  if (value === null) return true;
  const fields = new Set([
    "admitted_worker_scopes", "reserved_worker_scopes", "requested_worker_scopes",
  ]);
  return exactKeys(value, fields)
    && [...fields].every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0);
}

function validWorkerScopes(value) {
  if (value === null) return true;
  if (!Array.isArray(value) || value.length > MAX_RESOURCE_HTTP_ARRAY_ITEMS) return false;
  const fields = new Set([
    "project_id", "generation_id", "unit_base", "unit_name", "observed_at",
    "usage", "effective_limits",
  ]);
  const seen = new Set();
  for (const worker of value) {
    if (!exactKeys(worker, fields)
      || typeof worker.project_id !== "string" || !IDENTIFIER_RE.test(worker.project_id)
      || typeof worker.generation_id !== "string" || !IDENTIFIER_RE.test(worker.generation_id)
      || typeof worker.unit_base !== "string" || !WORKER_UNIT_BASE_RE.test(worker.unit_base)
      || worker.unit_name !== `${worker.unit_base}.scope`
      || !canonicalTime(worker.observed_at)
      || !validObservationUsage(worker.usage)
      || !validLimitSet(worker.effective_limits)
      || seen.has(worker.unit_base)) return false;
    seen.add(worker.unit_base);
  }
  return true;
}

function validRuntimeSnapshot(snapshot) {
  if (!exactKeys(snapshot, TOP_LEVEL_FIELDS)
    || snapshot.version !== RESOURCE_STATE_VERSION
    || !STATUS_REASONS.has(snapshot.status)) return false;
  const stateInput = Object.create(null);
  for (const field of STATE_FIELDS) stateInput[field] = snapshot[field];
  let sanitized;
  try {
    sanitized = createResourceSnapshot(stateInput);
  } catch {
    return false;
  }
  if (!sameJson(stateInput, sanitized)) return false;
  if (!exactKeys(snapshot.pressure, new Set(["status", "reason"]))
    || snapshot.pressure.status !== snapshot.status
    || typeof snapshot.pressure.reason !== "string"
    || !STATUS_REASONS.get(snapshot.status).has(snapshot.pressure.reason)
    || !validEffectiveLimits(snapshot.effective_limits)
    || !validResourceUsage(snapshot.resource_usage)
    || !validScopeCapacity(snapshot.scope_capacity)
    || !validWorkerScopes(snapshot.worker_scopes)) return false;
  if (snapshot.worker_scopes !== null && snapshot.effective_limits !== null
    && snapshot.worker_scopes.length !== snapshot.effective_limits.worker.observed_scopes) return false;
  if (snapshot.worker_scopes !== null && snapshot.resource_usage !== null
    && snapshot.worker_scopes.length !== snapshot.resource_usage.worker.observed_scopes) return false;
  if (snapshot.status === "ready" && (snapshot.effective_limits === null
    || snapshot.resource_usage === null
    || snapshot.scope_capacity === null
    || snapshot.worker_scopes === null
    || !Object.prototype.hasOwnProperty.call(snapshot.effective_limits, "api")
    || !Object.prototype.hasOwnProperty.call(snapshot.resource_usage, "api"))) return false;
  return true;
}

function boundedRuntimeSnapshot(value) {
  let captured;
  let serialized;
  try {
    captured = captureJson(value, { active: new WeakSet(), nodes: 0 });
    serialized = JSON.stringify(captured);
  } catch {
    return null;
  }
  if (typeof serialized !== "string"
    || Buffer.byteLength(serialized, "utf8") > MAX_RESOURCE_HTTP_BYTES
    || !validRuntimeSnapshot(captured)) return null;
  return captured;
}

// Authority-free schema capture for diagnostics and boundary tests. This does
// not publish, invoke a provider, or mint a RESOURCE_HTTP_PUBLISHERS entry.
function captureResourceHttpSnapshot(value) {
  return boundedRuntimeSnapshot(value);
}

function requestHasBody(request) {
  const body = safeGet(request, "body");
  if (body === INVALID) return true;
  if (body !== undefined && body !== null) return true;
  const headers = safeGet(request, "headers");
  if (headers === INVALID) return true;
  if (headers === undefined || headers === null) return false;
  const contentLength = safeGet(headers, "content-length");
  const transferEncoding = safeGet(headers, "transfer-encoding");
  if (contentLength === INVALID || transferEncoding === INVALID) return true;
  if (transferEncoding !== undefined) return true;
  return contentLength !== undefined && contentLength !== "0" && contentLength !== 0;
}

function setNoCacheHeaders(response) {
  const setHeader = dataMethod(response, "setHeader");
  if (setHeader === null) throw new TypeError("response.setHeader must be a function");
  Reflect.apply(setHeader, response, ["Cache-Control", "no-store, no-cache, must-revalidate"]);
  Reflect.apply(setHeader, response, ["Pragma", "no-cache"]);
  Reflect.apply(setHeader, response, ["Expires", "0"]);
}

function sendJson(response, statusCode, body, { allowGet = false } = {}) {
  setNoCacheHeaders(response);
  const setHeader = dataMethod(response, "setHeader");
  if (allowGet) Reflect.apply(setHeader, response, ["Allow", "GET"]);
  const status = dataMethod(response, "status");
  const json = dataMethod(response, "json");
  if (status === null || json === null) throw new TypeError("response status/json methods are required");
  const selected = Reflect.apply(status, response, [statusCode]);
  const target = selected === undefined ? response : selected;
  const targetJson = dataMethod(target, "json");
  if (targetJson === null) throw new TypeError("response.json must be a function");
  return Reflect.apply(targetJson, target, [body]);
}

function createResourceHttpHandler(resourcePublisher) {
  const publisher = RESOURCE_HTTP_PUBLISHERS.get(resourcePublisher) || null;
  return function resourceHttpHandler(request, response) {
    const method = safeGet(request, "method");
    if (method !== "GET") return sendJson(response, 405, ERROR_RESPONSES.method, { allowGet: true });
    if (requestHasBody(request)) return sendJson(response, 400, ERROR_RESPONSES.body);
    let result;
    try {
      result = publisher === null || publisher.snapshot === null
        ? null
        : Reflect.apply(publisher.snapshot, publisher.ownerAttestation, []);
    } catch {
      result = null;
    }
    if (consumeAsyncSnapshot(result)) result = null;
    const bounded = boundedRuntimeSnapshot(result);
    return bounded === null
      ? sendJson(response, 503, ERROR_RESPONSES.snapshot)
      : sendJson(response, 200, bounded);
  };
}

function registrationError() {
  const error = new Error("resource HTTP endpoint is already registered");
  error.name = "ResourceHttpRegistrationError";
  error.code = "QW_RESOURCE_HTTP_ALREADY_REGISTERED";
  return error;
}

function registerResourceHttp(app, runtimeOwner) {
  const get = dataMethod(app, "get");
  if (get === null) throw new TypeError("app.get must be a function");
  // Owner attestation is minted only after the owner module recognizes its
  // private WeakMap state. Plain lookalikes, functions, and proxies cannot turn
  // the exported registrar into a publisher-brand oracle.
  const ownerAttestation = captureResourceRuntimeOwner(runtimeOwner);
  const existing = RESOURCE_HTTP_REGISTRATIONS.get(runtimeOwner);
  if (existing) {
    if (existing.app !== app) throw registrationError();
    return existing.handler;
  }
  const appOwner = RESOURCE_HTTP_APPS.get(app);
  if (appOwner && appOwner !== runtimeOwner) throw registrationError();

  const publisher = createResourceHttpPublisher(ownerAttestation);
  const handler = createResourceHttpHandler(publisher);
  Reflect.apply(get, app, [RESOURCE_HTTP_PATH, handler]);
  RESOURCE_HTTP_REGISTRATIONS.set(runtimeOwner, Object.freeze({ app, handler }));
  RESOURCE_HTTP_APPS.set(app, runtimeOwner);
  return handler;
}

module.exports = {
  RESOURCE_HTTP_PATH,
  MAX_RESOURCE_HTTP_BYTES,
  captureResourceHttpSnapshot,
  createResourceHttpHandler,
  registerResourceHttp,
};
