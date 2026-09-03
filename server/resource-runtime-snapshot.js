"use strict";

const crypto = require("crypto");
const {
  parseRuntimeResources,
  calculateStaticReservationMib,
  calculateConfiguredSwapMib,
} = require("./resource-policy");
const { createResourceSnapshot } = require("./resource-state");
const { createWorkerUnitBase, scopeUnitFromBase } = require("./resource-unit");

const MIB_BYTES = 1024n * 1024n;
const UINT64_MAX = (1n << 64n) - 1n;
const MAX_RUNTIME_ITEMS = 1_000;
const INVALID = Symbol("invalid runtime resource field");
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNIT_BASE_RE = /^quadwork-worker-[a-f0-9]{40}$/;
const SYSTEMD_UNIT_RE = /^[a-z][a-z0-9.-]{0,127}$/;
const API_UNIT_RE = /^[a-z][a-z0-9.-]{0,127}\.(?:service|scope)$/;
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const PROOF_AUTHORITIES = new WeakMap();
// Intentionally unset until a disposable-host PASS receipt and the exact
// controller source it exercised are reviewed and pinned in source together.
// A fingerprint is not a secret; authority comes from requiring receipt bytes
// whose SHA-256 matches the reviewed pin, rather than trusting a caller claim.
const PINNED_STAGING_RECEIPT_SHA256 = null;
const PINNED_CONTROLLER_SOURCE_SHA256 = null;
const PREFLIGHT_FAILURES = new Set([
  "invalid_resource_policy",
  "containment_unavailable",
  "temp_unavailable",
  "capacity_exhausted",
]);

class ResourceRuntimePersistenceError extends Error {
  constructor(code) {
    super(code === "QW_RESOURCE_PERSISTENCE_FAILED"
      ? "resource snapshot persistence failed"
      : "resource snapshot persistence store is invalid");
    this.name = "ResourceRuntimePersistenceError";
    this.code = code;
  }
}

function createResourceRuntimeProofAuthority(options = {}) {
  if (PINNED_STAGING_RECEIPT_SHA256 === null || PINNED_CONTROLLER_SOURCE_SHA256 === null) {
    const error = new Error("no reviewed staging receipt is pinned in this source");
    error.code = "QW_RESOURCE_PROOF_NOT_PINNED";
    throw error;
  }
  const receiptBytes = safeGet(options, "receiptBytes");
  if (typeof receiptBytes !== "string" || Buffer.byteLength(receiptBytes, "utf8") > 16 * 1024) {
    const error = new TypeError("staging receipt bytes are invalid");
    error.code = "QW_INVALID_RESOURCE_PROOF_AUTHORITY";
    throw error;
  }
  const digest = crypto.createHash("sha256").update(receiptBytes, "utf8").digest("hex");
  if (digest !== PINNED_STAGING_RECEIPT_SHA256) {
    const error = new TypeError("staging receipt does not match the source pin");
    error.code = "QW_INVALID_RESOURCE_PROOF_AUTHORITY";
    throw error;
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes);
  } catch {
    const error = new TypeError("staging receipt is invalid");
    error.code = "QW_INVALID_RESOURCE_PROOF_AUTHORITY";
    throw error;
  }
  if (!hasOnlyKeys(receipt, new Set(["version", "status", "controller_source_sha256", "api_unit_name"]))) {
    const error = new TypeError("staging receipt schema is invalid");
    error.code = "QW_INVALID_RESOURCE_PROOF_AUTHORITY";
    throw error;
  }
  const apiUnitName = safeGet(receipt, "api_unit_name");
  if (typeof apiUnitName !== "string"
    || !API_UNIT_RE.test(apiUnitName)
    || apiUnitName.startsWith("quadwork-worker-")
    || apiUnitName.startsWith("quadwork-control-")
    || safeGet(receipt, "version") !== 1
    || safeGet(receipt, "status") !== "proof_passed"
    || safeGet(receipt, "controller_source_sha256") !== PINNED_CONTROLLER_SOURCE_SHA256) {
    const error = new TypeError("apiUnitName must be an exact systemd service or scope unit");
    error.code = "QW_INVALID_RESOURCE_PROOF_AUTHORITY";
    throw error;
  }
  // The object deliberately carries no serializable claim. Only this module's
  // private WeakMap can recognize it; configuration, HTTP input, preflight
  // strings, and lookalike objects cannot mint staging authority.
  const authority = Object.freeze(Object.create(null));
  PROOF_AUTHORITIES.set(authority, Object.freeze({ apiUnitName }));
  return authority;
}

function proofAuthorityMetadata(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return null;
  return PROOF_AUTHORITIES.get(value) || null;
}

function safeGet(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return INVALID;
  try {
    return value[key];
  } catch {
    return INVALID;
  }
}

function safeArray(value, maximum = MAX_RUNTIME_ITEMS) {
  let isArray;
  try {
    isArray = Array.isArray(value);
  } catch {
    return null;
  }
  if (!isArray) return null;
  const length = safeGet(value, "length");
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const item = safeGet(value, index);
    if (item === INVALID) return null;
    output.push(item);
  }
  return output;
}

function hasOnlyKeys(value, allowed) {
  try {
    return value !== null
      && typeof value === "object"
      && Object.keys(value).every((key) => allowed.has(key));
  } catch {
    return false;
  }
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER_RE.test(value) ? value : null;
}

function unitName(value) {
  return typeof value === "string" && SYSTEMD_UNIT_RE.test(value) ? value : null;
}

function observedSystemdUnit(value) {
  const validated = unitName(value);
  return validated && /\.(?:service|scope|slice)$/.test(validated) ? validated : null;
}

function controlSliceName(value) {
  const validated = unitName(value);
  return validated && /^quadwork-control(?:-[a-z0-9]+)*\.slice$/.test(validated) ? validated : null;
}

function uint64(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= UINT64_MAX ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedTime(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  try {
    return new Date(millis).toISOString();
  } catch {
    return null;
  }
}

function normalizeLimit(value) {
  const kind = safeGet(value, "kind");
  if (kind === "infinite") return Object.freeze({ kind, numeric: null, output: Object.freeze({ kind }) });
  if (kind !== "finite") return null;
  const numeric = uint64(safeGet(value, "bytes"));
  if (numeric === null) return null;
  return Object.freeze({
    kind,
    numeric,
    output: Object.freeze({ kind, bytes: numeric.toString(10) }),
  });
}

function compareLimits(lower, upper) {
  if (lower.kind === "infinite") return upper.kind === "infinite";
  if (upper.kind === "infinite") return true;
  return lower.numeric <= upper.numeric;
}

function addUint64(left, right) {
  const result = left + right;
  return result <= UINT64_MAX ? result : null;
}

function ceilMib(bytes) {
  const value = (bytes + MIB_BYTES - 1n) / MIB_BYTES;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function mibBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const bytes = BigInt(value) * MIB_BYTES;
  return bytes <= UINT64_MAX ? bytes : null;
}

function sameLimit(left, right) {
  return left.kind === right.kind && left.numeric === right.numeric;
}

function finiteLimitEquals(limit, expectedMib) {
  const expected = mibBytes(expectedMib);
  return expected !== null && limit.kind === "finite" && limit.numeric === expected;
}

function infiniteLimit(limit) {
  return limit.kind === "infinite";
}

function zeroLimit(limit) {
  return limit.kind === "finite" && limit.numeric === 0n;
}

function normalizeObservation(raw, expected) {
  if (safeGet(raw, "available") !== true
    || safeGet(raw, "status") !== "ready"
    || safeGet(raw, "reason") !== null) return null;
  if (safeGet(raw, "resource_class") !== expected.resourceClass
    || safeGet(raw, "unit_base") !== expected.unitBase
    || safeGet(raw, "unit_name") !== expected.unitName) return null;
  if (expected.aggregate === true && safeGet(raw, "aggregate") !== true) return null;
  const observedAt = normalizedTime(safeGet(raw, "observed_at"));
  if (observedAt === null) return null;

  const usageRaw = safeGet(raw, "usage");
  const current = uint64(safeGet(usageRaw, "memory_current_bytes"));
  const peak = uint64(safeGet(usageRaw, "memory_peak_bytes"));
  const swapCurrent = uint64(safeGet(usageRaw, "memory_swap_current_bytes"));
  if (current === null || peak === null || swapCurrent === null || peak < current) return null;

  const limitsRaw = safeGet(raw, "limits");
  const low = normalizeLimit(safeGet(limitsRaw, "memory_low"));
  const high = normalizeLimit(safeGet(limitsRaw, "memory_high"));
  const max = normalizeLimit(safeGet(limitsRaw, "memory_max"));
  const swapMax = normalizeLimit(safeGet(limitsRaw, "memory_swap_max"));
  if (!low || !high || !max || !swapMax
    || !compareLimits(low, high)
    || !compareLimits(low, max)
    || (high.kind !== "infinite" && !compareLimits(high, max))
    || (max.kind === "finite" && current > max.numeric)
    || (swapMax.kind === "finite" && swapCurrent > swapMax.numeric)) return null;

  const countersRaw = safeGet(raw, "counters");
  const oomKill = uint64(safeGet(countersRaw, "oom_kill"));
  const counterSource = safeGet(countersRaw, "source");
  if (oomKill === null || (counterSource !== "local" && counterSource !== "hierarchical")) return null;

  return Object.freeze({
    current,
    peak,
    swapCurrent,
    observedAt,
    limits: Object.freeze({ low, high, max, swapMax }),
    outputLimits: Object.freeze({
      memory_low: low.output,
      memory_high: high.output,
      memory_max: max.output,
      memory_swap_max: swapMax.output,
    }),
  });
}

function policyReportMatches(report, policy) {
  return safeGet(report, "configured") === true
    && safeGet(report, "version") === policy.version
    && safeGet(report, "mode") === policy.mode
    && safeGet(report, "hostReserveMib") === policy.host_reserve_mib
    && safeGet(report, "maxWorkerScopes") === policy.max_worker_scopes
    && safeGet(report, "apiMemoryLowMib") === policy.api.memory_low_mib
    && safeGet(report, "apiMemoryMaxMib") === policy.api.memory_max_mib
    && safeGet(report, "workerMemoryHighMib") === policy.worker.memory_high_mib
    && safeGet(report, "workerMemoryMaxMib") === policy.worker.memory_max_mib
    && safeGet(report, "workerSwapMaxMib") === policy.worker.swap_max_mib
    && safeGet(report, "controlMemoryMaxMib") === policy.control.memory_max_mib
    && safeGet(report, "controlSwapMaxMib") === policy.control.swap_max_mib
    && safeGet(report, "maxConcurrentChildren") === policy.control.max_concurrent_children
    && safeGet(report, "tempMinFreeMib") === policy.temp_min_free_mib;
}

function mibRecord(value, fields) {
  const output = {};
  for (const [source, target] of fields) {
    const item = nonNegativeInteger(safeGet(value, source));
    if (item === null) return null;
    output[target] = item;
  }
  return output;
}

function signedSafeInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function normalizePreflight(report, policy) {
  const ok = safeGet(report, "ok");
  const reason = safeGet(report, "reason");
  const host = mibRecord(safeGet(report, "host"), [
    ["totalMib", "total"],
    ["availableMib", "available"],
    ["swapTotalMib", "swapTotal"],
    ["swapFreeMib", "swapFree"],
  ]);
  if (host && (host.available > host.total || host.swapFree > host.swapTotal)) return null;

  const tempRaw = safeGet(report, "temp");
  const tempCapacity = mibRecord(tempRaw, [["freeMib", "free"], ["totalMib", "total"]]);
  const temp = tempCapacity && tempCapacity.free <= tempCapacity.total ? {
    diskBacked: safeGet(tempRaw, "diskBacked") === true,
    free: tempCapacity.free,
    total: tempCapacity.total,
    safe: safeGet(tempRaw, "exists") === true
      && safeGet(tempRaw, "directory") === true
      && safeGet(tempRaw, "symlink") === false
      && safeGet(tempRaw, "owned") === true
      && safeGet(tempRaw, "secureMode") === true,
  } : null;

  const scopesRaw = safeGet(report, "scopes");
  const scopes = mibRecord(scopesRaw, [
    ["admitted", "admitted"],
    ["staticCeiling", "staticCeiling"],
    ["requested", "requested"],
  ]);
  const capacityRaw = safeGet(report, "capacity");
  const capacityBase = mibRecord(capacityRaw, [
    ["staticReservationMib", "staticReservation"],
    ["staticHeadroomMib", "staticHeadroom"],
    ["configuredSwapMib", "configuredSwap"],
    ["swapHeadroomMib", "swapHeadroom"],
    ["requestedWorkerScopes", "requestedWorkerScopes"],
    ["requestedMemoryMib", "requestedMemory"],
    ["requestedSwapMib", "requestedSwap"],
    ["liveRequiredMib", "liveRequired"],
  ]);
  const liveHeadroom = signedSafeInteger(safeGet(capacityRaw, "liveHeadroomMib"));
  const liveSwapHeadroom = signedSafeInteger(safeGet(capacityRaw, "liveSwapHeadroomMib"));
  const capacity = capacityBase !== null && liveHeadroom !== null && liveSwapHeadroom !== null
    ? { ...capacityBase, liveHeadroom, liveSwapHeadroom }
    : null;
  const containment = safeGet(report, "containment");
  const api = safeGet(report, "api");
  const expectedStatic = calculateStaticReservationMib(policy);
  const expectedSwap = calculateConfiguredSwapMib(policy);
  const readyReasons = safeArray(safeGet(report, "reasons"));
  const capacityKeysValid = hasOnlyKeys(capacityRaw, new Set([
    "staticReservationMib", "staticHeadroomMib", "configuredSwapMib", "swapHeadroomMib",
    "requestedWorkerScopes", "requestedMemoryMib", "requestedSwapMib", "liveRequiredMib", "liveHeadroomMib",
    "liveSwapHeadroomMib",
  ]));
  const capacityConsistent = capacity !== null
    && capacityKeysValid
    && host !== null
    && scopes !== null
    && capacity.staticReservation === expectedStatic
    && capacity.staticHeadroom === host.total - expectedStatic
    && capacity.configuredSwap === expectedSwap
    && capacity.swapHeadroom === host.swapTotal - expectedSwap
    && capacity.requestedWorkerScopes === scopes.requested
    && capacity.requestedMemory === scopes.requested * policy.worker.memory_max_mib
    && capacity.requestedSwap === scopes.requested * policy.worker.swap_max_mib
    && capacity.liveRequired === policy.host_reserve_mib + capacity.requestedMemory
    && capacity.liveHeadroom === host.available - capacity.liveRequired
    && capacity.liveSwapHeadroom === host.swapFree - capacity.requestedSwap;
  const normalizedCapacity = capacityConsistent ? capacity : null;

  const validForReady = ok === true
    && reason === "ok"
    && hasOnlyKeys(report, new Set(["ok", "reason", "reasons", "policy", "host", "containment", "temp", "api", "scopes", "capacity"]))
    && hasOnlyKeys(safeGet(report, "policy"), new Set([
      "configured", "version", "mode", "hostReserveMib", "maxWorkerScopes",
      "apiMemoryLowMib", "apiMemoryMaxMib", "workerMemoryHighMib", "workerMemoryMaxMib",
      "workerSwapMaxMib", "controlMemoryMaxMib", "controlSwapMaxMib",
      "maxConcurrentChildren", "tempMinFreeMib",
    ]))
    && hasOnlyKeys(safeGet(report, "host"), new Set(["totalMib", "availableMib", "swapTotalMib", "swapFreeMib"]))
    && hasOnlyKeys(containment, new Set(["cgroupV2", "userManager", "systemdRun", "scopeProof"]))
    && hasOnlyKeys(tempRaw, new Set(["exists", "directory", "symlink", "owned", "secureMode", "diskBacked", "freeMib", "totalMib"]))
    && hasOnlyKeys(api, new Set(["memoryLowMib", "memoryMaxMib", "oomPolicy", "separateFromWorkers"]))
    && hasOnlyKeys(scopesRaw, new Set(["admitted", "staticCeiling", "requested"]))
    && capacityKeysValid
    && readyReasons !== null && readyReasons.length === 0
    && policyReportMatches(safeGet(report, "policy"), policy)
    && host !== null
    && temp !== null && temp.safe && temp.diskBacked && temp.free >= policy.temp_min_free_mib
    && scopes !== null
    && scopes.staticCeiling === policy.max_worker_scopes
    && scopes.admitted <= scopes.staticCeiling
    && scopes.requested <= scopes.staticCeiling
    && capacityConsistent
    && safeGet(containment, "cgroupV2") === true
    && safeGet(containment, "userManager") === true
    && safeGet(containment, "systemdRun") === true
    && safeGet(containment, "scopeProof") === true
    && safeGet(api, "memoryLowMib") === policy.api.memory_low_mib
    && safeGet(api, "memoryMaxMib") === policy.api.memory_max_mib
    && safeGet(api, "oomPolicy") === "continue"
    && safeGet(api, "separateFromWorkers") === true;

  const failure = ok === false && PREFLIGHT_FAILURES.has(reason) ? reason : null;
  return { ok, reason, failure, host, temp, scopes, capacity: normalizedCapacity, validForReady };
}

function normalizeController(snapshot, policy) {
  const controlChildrenRaw = safeGet(snapshot, "control_children");
  const controlChildren = mibRecord(controlChildrenRaw, [
    ["limit", "limit"],
    ["active", "active"],
    ["queued", "queued"],
  ]);
  const controlClassRaw = safeGet(snapshot, "control_class");
  const controlClassName = controlSliceName(safeGet(controlClassRaw, "unit_name"));
  const active = safeArray(safeGet(snapshot, "active_scopes"));
  if (!controlChildren || controlChildren.active > controlChildren.limit
    || controlClassName === null || safeGet(controlClassRaw, "aggregate") !== true || active === null) return null;

  const workers = [];
  let activeControlScopes = 0;
  for (const entry of active) {
    const resourceClass = safeGet(entry, "resource_class");
    const projectId = identifier(safeGet(entry, "project_id"));
    const generationId = identifier(safeGet(entry, "generation_id"));
    const observedUnit = unitName(safeGet(entry, "unit_name"));
    const startedAt = normalizedTime(safeGet(entry, "started_at"));
    if (!projectId || !generationId || !observedUnit || startedAt === null) return null;
    if (resourceClass === "worker") {
      let expectedBase;
      try {
        expectedBase = createWorkerUnitBase({ projectId, generationId });
      } catch {
        return null;
      }
      const limits = safeGet(entry, "limits");
      if (observedUnit !== expectedBase
        || safeGet(limits, "memory_high_mib") !== policy.worker.memory_high_mib
        || safeGet(limits, "memory_max_mib") !== policy.worker.memory_max_mib
        || safeGet(limits, "swap_max_mib") !== policy.worker.swap_max_mib) return null;
      workers.push(Object.freeze({
        projectId,
        generationId,
        unitBase: expectedBase,
        unitName: scopeUnitFromBase(expectedBase),
      }));
    } else if (resourceClass === "control") {
      if (safeGet(entry, "control_class") !== controlClassName) return null;
      activeControlScopes += 1;
    } else {
      return null;
    }
  }
  if (workers.length > policy.max_worker_scopes || activeControlScopes !== controlChildren.active) return null;
  return {
    protocolStatus: safeGet(snapshot, "protocol_status"),
    controlChildren,
    controlClassName,
    workers,
    terminalFacts: safeGet(snapshot, "terminal_facts"),
    lastCgroupOom: safeGet(snapshot, "last_cgroup_oom"),
  };
}

function normalizeWorkers(raw, workers, policy) {
  const list = safeArray(raw, Math.min(MAX_RUNTIME_ITEMS, policy.max_worker_scopes));
  if (!list || list.length !== workers.length) return null;
  const expected = new Map(workers.map((worker) => [worker.unitBase, worker]));
  const observations = new Map();
  for (const rawObservation of list) {
    const base = safeGet(rawObservation, "unit_base");
    if (typeof base !== "string" || !UNIT_BASE_RE.test(base) || !expected.has(base)) return null;
    const worker = expected.get(base);
    expected.delete(base);
    const observation = normalizeObservation(rawObservation, {
      resourceClass: "worker",
      unitBase: worker.unitBase,
      unitName: worker.unitName,
    });
    if (!observation) return null;
    observations.set(base, Object.freeze({ ...worker, ...observation }));
  }
  return expected.size === 0 ? workers.map((worker) => observations.get(worker.unitBase)) : null;
}

function workerTotals(workers) {
  let current = 0n;
  let sumOfScopePeaks = 0n;
  let swapCurrent = 0n;
  for (const worker of workers) {
    current = addUint64(current, worker.current);
    sumOfScopePeaks = addUint64(sumOfScopePeaks, worker.peak);
    swapCurrent = addUint64(swapCurrent, worker.swapCurrent);
    if (current === null || sumOfScopePeaks === null || swapCurrent === null) return null;
  }
  return { current, sumOfScopePeaks, swapCurrent };
}

function limitsMatchPolicy(api, control, workers, policy) {
  if ((api !== null && (!finiteLimitEquals(api.limits.low, policy.api.memory_low_mib)
    || !infiniteLimit(api.limits.high)
    || !finiteLimitEquals(api.limits.max, policy.api.memory_max_mib)
    || !infiniteLimit(api.limits.swapMax)))
    || !zeroLimit(control.limits.low)
    || !infiniteLimit(control.limits.high)
    || !finiteLimitEquals(control.limits.max, policy.control.memory_max_mib)
    || !finiteLimitEquals(control.limits.swapMax, policy.control.swap_max_mib)) return false;
  for (const worker of workers) {
    if (!zeroLimit(worker.limits.low)
      || !finiteLimitEquals(worker.limits.high, policy.worker.memory_high_mib)
      || !finiteLimitEquals(worker.limits.max, policy.worker.memory_max_mib)
      || !finiteLimitEquals(worker.limits.swapMax, policy.worker.swap_max_mib)) return false;
  }
  return workers.length < 2 || workers.slice(1).every((worker) => (
    sameLimit(worker.limits.low, workers[0].limits.low)
    && sameLimit(worker.limits.high, workers[0].limits.high)
    && sameLimit(worker.limits.max, workers[0].limits.max)
    && sameLimit(worker.limits.swapMax, workers[0].limits.swapMax)
  ));
}

function sanitizeControllerEvidence(controller) {
  const sanitized = createResourceSnapshot({
    status: "unknown",
    last_cgroup_oom: controller.lastCgroupOom,
    terminal_facts: controller.terminalFacts,
  });
  return {
    lastCgroupOom: sanitized.last_cgroup_oom,
    terminalFacts: sanitized.terminal_facts,
  };
}

function frozenObservationOutput(observation) {
  return Object.freeze({
    memory_current_bytes: observation.current.toString(10),
    memory_peak_bytes: observation.peak.toString(10),
    memory_swap_current_bytes: observation.swapCurrent.toString(10),
  });
}

function frozenWorkerScopeOutput(worker) {
  return Object.freeze({
    project_id: worker.projectId,
    generation_id: worker.generationId,
    unit_base: worker.unitBase,
    unit_name: worker.unitName,
    observed_at: worker.observedAt,
    usage: frozenObservationOutput(worker),
    effective_limits: worker.outputLimits,
  });
}

function buildResourceRuntimeSnapshot({
  runtimeResources,
  preflightReport,
  controllerSnapshot,
  apiObservation,
  controlObservation,
  workerObservations = [],
  proofAuthority,
} = {}) {
  let policy;
  try {
    policy = parseRuntimeResources(runtimeResources);
  } catch {
    policy = null;
  }

  if (!policy) {
    const state = createResourceSnapshot({ status: "invalid_resource_policy" });
    return Object.freeze({
      ...state,
      pressure: Object.freeze({ status: state.status, reason: "policy_invalid_or_absent" }),
      effective_limits: null,
      resource_usage: null,
      scope_capacity: null,
      worker_scopes: null,
    });
  }

  let preflight = null;
  try {
    preflight = normalizePreflight(preflightReport, policy);
  } catch {
    preflight = null;
  }
  const controller = normalizeController(controllerSnapshot, policy);
  const proof = proofAuthorityMetadata(proofAuthority);
  const apiObservedUnit = observedSystemdUnit(safeGet(apiObservation, "unit_name"));
  const api = proof === null || apiObservedUnit !== proof.apiUnitName ? null : normalizeObservation(apiObservation, {
    resourceClass: "api",
    unitBase: null,
    unitName: proof.apiUnitName,
  });
  const control = controller ? normalizeObservation(controlObservation, {
    resourceClass: "control",
    unitBase: null,
    unitName: controller.controlClassName,
    aggregate: true,
  }) : null;
  const workers = controller ? normalizeWorkers(workerObservations, controller.workers, policy) : null;
  const totals = workers ? workerTotals(workers) : null;
  const evidence = controller ? sanitizeControllerEvidence(controller) : { lastCgroupOom: null, terminalFacts: [] };

  const workerControlConsistent = control && workers && totals
    && limitsMatchPolicy(null, control, workers, policy);
  const effectiveConsistent = api && workerControlConsistent
    && limitsMatchPolicy(api, control, workers, policy);
  const workerMemoryMib = totals ? ceilMib(totals.current) : null;
  const controlMemoryMib = control ? ceilMib(control.current) : null;
  const apiMemoryMib = api ? ceilMib(api.current) : null;
  const countsConsistent = controller && preflight && preflight.scopes
    && controller.controlChildren.limit === policy.control.max_concurrent_children
    && controller.workers.length === preflight.scopes.admitted;

  let status;
  let reason;
  if (!preflight) {
    status = "unavailable";
    reason = "preflight_report_invalid";
  } else if (preflight.ok === false) {
    status = preflight.failure || "unavailable";
    reason = preflight.failure ? `preflight_${preflight.failure}` : "preflight_report_invalid";
  } else if (!controller) {
    status = "containment_unavailable";
    reason = "controller_snapshot_invalid";
  } else if (controller.protocolStatus === "candidate_pending_staging") {
    status = "candidate_pending_staging";
    reason = "staging_proof_pending";
  } else if (controller.protocolStatus !== "supported") {
    status = "containment_unavailable";
    reason = "controller_protocol_unavailable";
  } else if (!preflight.validForReady || !countsConsistent || !workerControlConsistent
    || workerMemoryMib === null || controlMemoryMib === null) {
    status = "containment_unavailable";
    reason = "runtime_observation_inconsistent";
  } else if (apiObservedUnit === null) {
    status = "containment_unavailable";
    reason = "api_self_identity_unproven";
  } else if (proof === null) {
    status = "candidate_pending_staging";
    reason = "proof_authority_unavailable";
  } else if (apiObservedUnit !== proof.apiUnitName) {
    status = "containment_unavailable";
    reason = "api_self_identity_unproven";
  } else if (!effectiveConsistent || apiMemoryMib === null) {
    status = "containment_unavailable";
    reason = "runtime_observation_inconsistent";
  } else {
    status = "ready";
    reason = "ok";
  }

  const limits = {
    host_reserve_mib: policy.host_reserve_mib,
    max_worker_scopes: policy.max_worker_scopes,
    max_control_children: policy.control.max_concurrent_children,
    worker_memory_high_mib: policy.worker.memory_high_mib,
    worker_memory_max_mib: policy.worker.memory_max_mib,
    worker_swap_max_mib: policy.worker.swap_max_mib,
    control_memory_max_mib: policy.control.memory_max_mib,
    control_swap_max_mib: policy.control.swap_max_mib,
    api_memory_low_mib: policy.api.memory_low_mib,
    api_memory_max_mib: policy.api.memory_max_mib,
    temp_min_free_mib: policy.temp_min_free_mib,
  };
  const counts = controller ? {
    active_worker_scopes: controller.workers.length,
    active_control_children: controller.controlChildren.active,
    queued_control_children: controller.controlChildren.queued,
  } : {};
  const usage = preflight && preflight.host ? {
    host_memory_total_mib: preflight.host.total,
    host_memory_available_mib: preflight.host.available,
    swap_total_mib: preflight.host.swapTotal,
    swap_free_mib: preflight.host.swapFree,
    ...(workerMemoryMib === null ? {} : { worker_memory_mib: workerMemoryMib }),
    ...(controlMemoryMib === null ? {} : { control_memory_mib: controlMemoryMib }),
    ...(apiMemoryMib === null ? {} : { api_memory_mib: apiMemoryMib }),
    ...(preflight.capacity ? {
      static_reservation_mib: preflight.capacity.staticReservation,
      static_headroom_mib: preflight.capacity.staticHeadroom,
      configured_swap_mib: preflight.capacity.configuredSwap,
      swap_headroom_mib: preflight.capacity.swapHeadroom,
    } : {}),
  } : {};
  const temp = preflight && preflight.temp ? {
    disk_backed: preflight.temp.diskBacked,
    free_mib: preflight.temp.free,
    total_mib: preflight.temp.total,
  } : null;

  const state = createResourceSnapshot({
    status,
    counts,
    limits,
    usage,
    temp,
    last_cgroup_oom: evidence.lastCgroupOom,
    terminal_facts: evidence.terminalFacts,
  });
  if (status === "ready" && state.status !== "ready") reason = "runtime_snapshot_inconsistent";
  const effectiveLimits = control && workers ? Object.freeze({
    ...(api ? { api: api.outputLimits } : {}),
    control: control.outputLimits,
    worker: Object.freeze({
      observed_scopes: workers.length,
      limits: workers.length === 0 ? null : workers[0].outputLimits,
    }),
  }) : null;
  const resourceUsage = control && totals ? Object.freeze({
    ...(api ? { api: Object.freeze({
      unit_name: proof.apiUnitName,
      ...frozenObservationOutput(api),
    }) } : {}),
    control: frozenObservationOutput(control),
    worker: Object.freeze({
      observed_scopes: workers.length,
      memory_current_bytes: totals.current.toString(10),
      sum_of_scope_peaks_bytes: totals.sumOfScopePeaks.toString(10),
      memory_swap_current_bytes: totals.swapCurrent.toString(10),
    }),
  }) : null;
  const workerScopes = workers === null
    ? null
    : Object.freeze(workers.map(frozenWorkerScopeOutput));
  const scopeCapacity = preflight && preflight.scopes && preflight.capacity ? Object.freeze({
    admitted_worker_scopes: preflight.scopes.admitted,
    reserved_worker_scopes: policy.max_worker_scopes,
    requested_worker_scopes: preflight.scopes.requested,
    live_swap_headroom_mib: preflight.capacity.liveSwapHeadroom,
  }) : null;

  return Object.freeze({
    ...state,
    pressure: Object.freeze({ status: state.status, reason }),
    effective_limits: effectiveLimits,
    resource_usage: resourceUsage,
    scope_capacity: scopeCapacity,
    worker_scopes: workerScopes,
  });
}

function persistResourceRuntimeSnapshot(store, snapshot) {
  const save = safeGet(store, "save");
  if (typeof save !== "function") {
    throw new ResourceRuntimePersistenceError("QW_RESOURCE_PERSISTENCE_INVALID_STORE");
  }
  try {
    return Reflect.apply(save, store, [snapshot]);
  } catch {
    throw new ResourceRuntimePersistenceError("QW_RESOURCE_PERSISTENCE_FAILED");
  }
}

module.exports = {
  MIB_BYTES,
  UINT64_MAX,
  ResourceRuntimePersistenceError,
  createResourceRuntimeProofAuthority,
  buildResourceRuntimeSnapshot,
  persistResourceRuntimeSnapshot,
};
