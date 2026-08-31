"use strict";

const path = require("path");

const POLICY_VERSION = 1;
const POLICY_MODE = "systemd-user-v1";

// This is an operator-visible proposal for the measured ~8 GiB VPS. It is not
// used implicitly by parseRuntimeResources(): an absent policy stays absent.
const DEFAULT_RUNTIME_RESOURCE_PROPOSAL = deepFreeze({
  version: POLICY_VERSION,
  mode: POLICY_MODE,
  temp_root: "/home/quadwork/.quadwork/tmp",
  host_reserve_mib: 1536,
  max_worker_scopes: 3,
  api: { memory_low_mib: 512, memory_max_mib: 1280 },
  worker: { memory_high_mib: 1024, memory_max_mib: 1200, swap_max_mib: 512 },
  control: { memory_max_mib: 512, swap_max_mib: 256, max_concurrent_children: 2 },
  temp_min_free_mib: 4096,
});

const ROOT_FIELDS = new Set([
  "version",
  "mode",
  "temp_root",
  "host_reserve_mib",
  "max_worker_scopes",
  "api",
  "worker",
  "control",
  "temp_min_free_mib",
]);
const API_FIELDS = new Set(["memory_low_mib", "memory_max_mib"]);
const WORKER_FIELDS = new Set(["memory_high_mib", "memory_max_mib", "swap_max_mib"]);
const CONTROL_FIELDS = new Set(["memory_max_mib", "swap_max_mib", "max_concurrent_children"]);

class ResourcePolicyError extends Error {
  constructor(problems) {
    const safeProblems = Array.isArray(problems) ? problems.map(String) : [String(problems)];
    super(`Invalid runtime_resources policy: ${safeProblems.join("; ")}`);
    this.name = "ResourcePolicyError";
    this.code = "invalid_resource_policy";
    this.problems = safeProblems;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value, allowed, fieldPath, problems) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.push(`${fieldPath}.${key} is not supported`);
  }
}

function requireObject(value, fieldPath, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${fieldPath} must be an object`);
    return false;
  }
  return true;
}

function requirePositiveInteger(value, fieldPath, problems) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    problems.push(`${fieldPath} must be a positive integer`);
    return false;
  }
  return true;
}

function checkedSum(terms, label) {
  let total = 0;
  for (const term of terms) {
    if (!Number.isSafeInteger(term) || term < 0 || !Number.isSafeInteger(total + term)) {
      throw new ResourcePolicyError(`${label} exceeds the supported integer range`);
    }
    total += term;
  }
  return total;
}

function calculateStaticReservationMib(policy) {
  const workers = policy.max_worker_scopes * policy.worker.memory_max_mib;
  if (!Number.isSafeInteger(workers)) {
    throw new ResourcePolicyError("static RAM reservation exceeds the supported integer range");
  }
  return checkedSum([
    policy.host_reserve_mib,
    policy.api.memory_max_mib,
    policy.control.memory_max_mib,
    workers,
  ], "static RAM reservation");
}

function calculateConfiguredSwapMib(policy) {
  // The approved v1 shape has no API swap field. Do not fabricate one here.
  const workers = policy.max_worker_scopes * policy.worker.swap_max_mib;
  if (!Number.isSafeInteger(workers)) {
    throw new ResourcePolicyError("configured swap reservation exceeds the supported integer range");
  }
  return checkedSum([policy.control.swap_max_mib, workers], "configured swap reservation");
}

function parseRuntimeResources(raw) {
  // Absence is meaningful: setup has not been explicitly accepted. Never
  // inject or persist DEFAULT_RUNTIME_RESOURCE_PROPOSAL from this function.
  if (raw === undefined || raw === null) return null;

  const problems = [];
  if (!requireObject(raw, "runtime_resources", problems)) {
    throw new ResourcePolicyError(problems);
  }
  rejectUnknownFields(raw, ROOT_FIELDS, "runtime_resources", problems);

  if (raw.version !== POLICY_VERSION) {
    problems.push(`runtime_resources.version must be ${POLICY_VERSION}`);
  }
  if (raw.mode !== POLICY_MODE) {
    problems.push(`runtime_resources.mode must be ${POLICY_MODE}`);
  }
  if (typeof raw.temp_root !== "string" || raw.temp_root.length === 0 || raw.temp_root.includes("\0") || !path.posix.isAbsolute(raw.temp_root)) {
    problems.push("runtime_resources.temp_root must be a non-empty absolute path");
  } else if (path.posix.parse(path.posix.normalize(raw.temp_root)).root === path.posix.normalize(raw.temp_root)) {
    problems.push("runtime_resources.temp_root cannot be a filesystem root");
  }

  requirePositiveInteger(raw.host_reserve_mib, "runtime_resources.host_reserve_mib", problems);
  requirePositiveInteger(raw.max_worker_scopes, "runtime_resources.max_worker_scopes", problems);
  requirePositiveInteger(raw.temp_min_free_mib, "runtime_resources.temp_min_free_mib", problems);

  if (requireObject(raw.api, "runtime_resources.api", problems)) {
    rejectUnknownFields(raw.api, API_FIELDS, "runtime_resources.api", problems);
    requirePositiveInteger(raw.api.memory_low_mib, "runtime_resources.api.memory_low_mib", problems);
    requirePositiveInteger(raw.api.memory_max_mib, "runtime_resources.api.memory_max_mib", problems);
    if (Number.isSafeInteger(raw.api.memory_low_mib)
      && Number.isSafeInteger(raw.api.memory_max_mib)
      && raw.api.memory_low_mib > raw.api.memory_max_mib) {
      problems.push("runtime_resources.api.memory_low_mib must be <= memory_max_mib");
    }
  }

  if (requireObject(raw.worker, "runtime_resources.worker", problems)) {
    rejectUnknownFields(raw.worker, WORKER_FIELDS, "runtime_resources.worker", problems);
    requirePositiveInteger(raw.worker.memory_high_mib, "runtime_resources.worker.memory_high_mib", problems);
    requirePositiveInteger(raw.worker.memory_max_mib, "runtime_resources.worker.memory_max_mib", problems);
    requirePositiveInteger(raw.worker.swap_max_mib, "runtime_resources.worker.swap_max_mib", problems);
    if (Number.isSafeInteger(raw.worker.memory_high_mib)
      && Number.isSafeInteger(raw.worker.memory_max_mib)
      && raw.worker.memory_high_mib > raw.worker.memory_max_mib) {
      problems.push("runtime_resources.worker.memory_high_mib must be <= memory_max_mib");
    }
  }

  if (requireObject(raw.control, "runtime_resources.control", problems)) {
    rejectUnknownFields(raw.control, CONTROL_FIELDS, "runtime_resources.control", problems);
    requirePositiveInteger(raw.control.memory_max_mib, "runtime_resources.control.memory_max_mib", problems);
    requirePositiveInteger(raw.control.swap_max_mib, "runtime_resources.control.swap_max_mib", problems);
    requirePositiveInteger(raw.control.max_concurrent_children, "runtime_resources.control.max_concurrent_children", problems);
  }

  if (problems.length > 0) throw new ResourcePolicyError(problems);

  const policy = {
    version: raw.version,
    mode: raw.mode,
    temp_root: path.posix.normalize(raw.temp_root),
    host_reserve_mib: raw.host_reserve_mib,
    max_worker_scopes: raw.max_worker_scopes,
    api: {
      memory_low_mib: raw.api.memory_low_mib,
      memory_max_mib: raw.api.memory_max_mib,
    },
    worker: {
      memory_high_mib: raw.worker.memory_high_mib,
      memory_max_mib: raw.worker.memory_max_mib,
      swap_max_mib: raw.worker.swap_max_mib,
    },
    control: {
      memory_max_mib: raw.control.memory_max_mib,
      swap_max_mib: raw.control.swap_max_mib,
      max_concurrent_children: raw.control.max_concurrent_children,
    },
    temp_min_free_mib: raw.temp_min_free_mib,
  };

  // Force overflow checks at parse time rather than much later at admission.
  calculateStaticReservationMib(policy);
  calculateConfiguredSwapMib(policy);
  return deepFreeze(policy);
}

function validatePolicyCapacity(policy, { physicalRamMib, swapTotalMib } = {}) {
  const staticReservationMib = calculateStaticReservationMib(policy);
  const configuredSwapMib = calculateConfiguredSwapMib(policy);
  const problems = [];

  if (!Number.isSafeInteger(physicalRamMib) || physicalRamMib <= 0) {
    problems.push("physical RAM must be a positive integer MiB value");
  } else if (staticReservationMib > physicalRamMib) {
    problems.push("static RAM reservation exceeds physical RAM");
  }

  if (!Number.isSafeInteger(swapTotalMib) || swapTotalMib < 0) {
    problems.push("total swap must be a non-negative integer MiB value");
  } else if (configuredSwapMib > swapTotalMib) {
    problems.push("configured aggregate swap exceeds total swap");
  }

  if (problems.length > 0) throw new ResourcePolicyError(problems);
  return Object.freeze({
    staticReservationMib,
    staticHeadroomMib: physicalRamMib - staticReservationMib,
    configuredSwapMib,
    swapHeadroomMib: swapTotalMib - configuredSwapMib,
  });
}

module.exports = {
  POLICY_VERSION,
  POLICY_MODE,
  DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
  ResourcePolicyError,
  parseRuntimeResources,
  calculateStaticReservationMib,
  calculateConfiguredSwapMib,
  validatePolicyCapacity,
};
