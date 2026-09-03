"use strict";

const {
  DEFAULT_CONTROL_CLASS_NAME,
  ResourceController,
} = require("./resource-controller");
const { parseRuntimeResources } = require("./resource-policy");
const canonicalUnitHelper = require("./resource-unit");

const FACTORY_FIELDS = new Set([
  "policy",
  "unitHelper",
  "observationProvider",
  "executeProcess",
  "now",
]);
const WORKER_FIELDS = new Set([
  "projectId",
  "generationId",
  "command",
  "args",
  "signal",
]);
const CONTROL_FIELDS = new Set([
  "projectId",
  "generationId",
  "operationId",
  "command",
  "args",
  "signal",
]);
const POLICY_FIELDS = new Set([
  "version", "mode", "temp_root", "host_reserve_mib", "max_worker_scopes",
  "api", "worker", "control", "temp_min_free_mib",
]);
const API_POLICY_FIELDS = new Set(["memory_low_mib", "memory_max_mib"]);
const WORKER_POLICY_FIELDS = new Set(["memory_high_mib", "memory_max_mib", "swap_max_mib"]);
const CONTROL_POLICY_FIELDS = new Set(["memory_max_mib", "swap_max_mib", "max_concurrent_children"]);
const OBSERVATION_FIELDS = new Set([
  "available", "status", "reason", "resource_class", "unit_base", "unit_name",
  "observed_at", "usage", "limits", "counters", "self", "aggregate",
]);
const OBSERVATION_REQUIRED_FIELDS = new Set([
  "available", "status", "reason", "resource_class", "unit_base", "unit_name",
  "observed_at", "counters",
]);
const COUNTER_FIELDS = new Set(["oom_kill", "source"]);
const UINT64_MAX = (1n << 64n) - 1n;
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const MAX_PROCESS_ARGS = 10_000;
const CONTROLLER_QUERY_TIMEOUT_MS = 1_000;
const PROVIDER_UNAVAILABLE = Symbol("resource observation provider unavailable");

class ResourceControllerAdapterError extends Error {
  constructor(field) {
    super(`${field} is invalid for the resource controller adapter`);
    this.name = "ResourceControllerAdapterError";
    this.code = "QW_INVALID_RESOURCE_CONTROLLER_ADAPTER";
    this.field = field;
  }
}

function invalid(field) {
  return new ResourceControllerAdapterError(field);
}

function exactDataRecord(value, allowed, required, field) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(field);
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid(field);
    const keys = Reflect.ownKeys(value);
    const output = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string" || !allowed.has(key)) throw invalid(field);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) throw invalid(field);
      output[key] = descriptor.value;
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) throw invalid(field);
    }
    return Object.freeze(output);
  } catch {
    throw invalid(field);
  }
}

async function observeWithBoundary(method, receiver, identity, requestSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let onRequestAbort = null;
  let finishBoundary = null;
  try {
    const abortedGetter = Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
    abortedGetter.call(requestSignal);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(deadline)) return PROVIDER_UNAVAILABLE;

    const boundary = new Promise((resolve) => {
      finishBoundary = resolve;
      timer = setTimeout(() => {
        controller.abort();
        resolve(PROVIDER_UNAVAILABLE);
      }, timeoutMs);
      onRequestAbort = () => {
        controller.abort();
        resolve(PROVIDER_UNAVAILABLE);
      };
      EventTarget.prototype.addEventListener.call(requestSignal, "abort", onRequestAbort, { once: true });
      // Close the race where the controller request aborts between the first
      // brand check and listener installation.
      if (abortedGetter.call(requestSignal)) onRequestAbort();
    });
    if (controller.signal.aborted) return PROVIDER_UNAVAILABLE;
    const queryBoundary = Object.freeze({
      signal: controller.signal,
      deadline,
      timeoutMs,
    });
    const provider = Promise.resolve()
      .then(() => Reflect.apply(method, receiver, [identity, queryBoundary]))
      .catch(() => PROVIDER_UNAVAILABLE);
    return await Promise.race([provider, boundary]);
  } catch {
    return PROVIDER_UNAVAILABLE;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onRequestAbort !== null) {
      try {
        EventTarget.prototype.removeEventListener.call(requestSignal, "abort", onRequestAbort);
      } catch {}
    }
    controller.abort();
    if (finishBoundary !== null) finishBoundary(PROVIDER_UNAVAILABLE);
  }
}

function ownDataValue(value, key, field) {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) throw invalid(field);
    return descriptor.value;
  } catch {
    throw invalid(field);
  }
}

function dataMethod(value, key, field) {
  let current = value;
  try {
    for (let depth = 0; current !== null && depth < 16; depth += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") throw invalid(field);
        return descriptor.value;
      }
      current = Reflect.getPrototypeOf(current);
    }
  } catch {
    throw invalid(field);
  }
  throw invalid(field);
}

function normalizePolicy(value) {
  try {
    const root = exactDataRecord(value, POLICY_FIELDS, POLICY_FIELDS, "policy");
    const policyInput = {
      ...root,
      api: { ...exactDataRecord(root.api, API_POLICY_FIELDS, API_POLICY_FIELDS, "policy.api") },
      worker: { ...exactDataRecord(root.worker, WORKER_POLICY_FIELDS, WORKER_POLICY_FIELDS, "policy.worker") },
      control: { ...exactDataRecord(root.control, CONTROL_POLICY_FIELDS, CONTROL_POLICY_FIELDS, "policy.control") },
    };
    const policy = parseRuntimeResources(policyInput);
    if (policy === null) throw invalid("policy");
    return policy;
  } catch {
    throw invalid("policy");
  }
}

function copyArgs(value) {
  try {
    if (!Array.isArray(value)) throw invalid("run.args");
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROCESS_ARGS) {
      throw invalid("run.args");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) throw invalid("run.args");
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw invalid("run.args");
      }
      const argument = descriptor.value;
      if (typeof argument !== "string" || argument.includes("\0")) throw invalid("run.args");
      copy.push(argument);
    }
    return copy;
  } catch (error) {
    if (error instanceof ResourceControllerAdapterError) throw error;
    throw invalid("run.args");
  }
}

function normalizeAbortSignal(value) {
  if (value === undefined) return Object.freeze({ signal: undefined, cleanup() {} });
  let abortedGetter;
  let bridge;
  let onAbort;
  let listenerAdded = false;
  try {
    abortedGetter = Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
    // Calling the platform getter directly performs its internal brand check
    // without touching a hostile own `aborted` property or Proxy get trap.
    abortedGetter.call(value);
    bridge = new AbortController();
    onAbort = () => bridge.abort();
    EventTarget.prototype.addEventListener.call(value, "abort", onAbort, { once: true });
    listenerAdded = true;
    if (abortedGetter.call(value)) bridge.abort();
  } catch {
    if (listenerAdded) {
      try { EventTarget.prototype.removeEventListener.call(value, "abort", onAbort); } catch {}
    }
    throw invalid("run.signal");
  }
  let cleaned = false;
  return Object.freeze({
    signal: bridge.signal,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { EventTarget.prototype.removeEventListener.call(value, "abort", onAbort); } catch {}
    },
  });
}

function normalizeRunInput(value, allowed, resourceClass) {
  const required = resourceClass === "control"
    ? new Set(["projectId", "generationId", "operationId", "command", "args"])
    : new Set(["projectId", "generationId", "command", "args"]);
  const record = exactDataRecord(value, allowed, required, `${resourceClass}Run`);
  const projectId = record.projectId;
  const generationId = record.generationId;
  const command = record.command;
  const args = copyArgs(record.args);
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    throw invalid("run.command");
  }
  const signalBoundary = normalizeAbortSignal(record.signal);
  return {
    projectId,
    generationId,
    ...(resourceClass === "control"
      ? { operationId: record.operationId }
      : {}),
    command,
    args,
    signal: signalBoundary.signal,
    cleanupSignal: signalBoundary.cleanup,
  };
}

function normalizeUint64(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/.test(value)) return null;
  try {
    const count = BigInt(value);
    return count <= UINT64_MAX ? count.toString(10) : null;
  } catch {
    return null;
  }
}

function normalizeObservedAt(value) {
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

function mapObservation(value, context) {
  try {
    const observation = exactDataRecord(
      value,
      OBSERVATION_FIELDS,
      OBSERVATION_REQUIRED_FIELDS,
      "observation",
    );
    const counters = exactDataRecord(observation.counters, COUNTER_FIELDS, COUNTER_FIELDS, "observation.counters");
    if (observation.available !== true || observation.status !== "ready" || observation.reason !== null) return null;
    if (observation.resource_class !== context.resourceClass
      || observation.unit_base !== context.unitBase
      || observation.unit_name !== context.scopeUnit) return null;
    if (counters.source !== "local" && counters.source !== "hierarchical") return null;
    const oomKillCount = normalizeUint64(counters.oom_kill);
    const observedAt = normalizeObservedAt(observation.observed_at);
    if (oomKillCount === null || observedAt === null) return null;
    return Object.freeze({ oomKillCount, observedAt });
  } catch {
    return null;
  }
}

function createResourceControllerAdapter(options = {}) {
  const capturedOptions = exactDataRecord(
    options,
    FACTORY_FIELDS,
    new Set(["policy", "observationProvider", "executeProcess"]),
    "options",
  );
  const policy = normalizePolicy(capturedOptions.policy);
  const unitHelper = capturedOptions.unitHelper === undefined
    ? canonicalUnitHelper
    : capturedOptions.unitHelper;
  const observationProvider = capturedOptions.observationProvider;
  const executeProcess = capturedOptions.executeProcess;
  const now = capturedOptions.now;

  if (!unitHelper || typeof unitHelper !== "object") throw invalid("unitHelper");
  const makeWorkerBase = dataMethod(unitHelper, "createWorkerUnitBase", "unitHelper");
  const makeControlBase = dataMethod(unitHelper, "createControlUnitBase", "unitHelper");
  const makeScopeUnit = dataMethod(unitHelper, "scopeUnitFromBase", "unitHelper");
  if (!observationProvider || typeof observationProvider !== "object") {
    throw invalid("observationProvider");
  }
  const observeWorker = dataMethod(observationProvider, "observeWorker", "observationProvider");
  const observeControl = dataMethod(observationProvider, "observeControl", "observationProvider");
  const providerTimeoutMs = ownDataValue(observationProvider, "timeoutMs", "observationProvider.timeoutMs");
  if (!Number.isSafeInteger(providerTimeoutMs)
    || providerTimeoutMs <= 0
    || providerTimeoutMs > CONTROLLER_QUERY_TIMEOUT_MS) {
    throw invalid("observationProvider.timeoutMs");
  }
  if (typeof executeProcess !== "function") throw invalid("executeProcess");
  if (now !== undefined && typeof now !== "function") throw invalid("now");

  const contexts = new Map();

  function generatedContext(resourceClass, identity) {
    let canonicalBase;
    let suppliedBase;
    let suppliedScope;
    try {
      const frozenIdentity = Object.freeze({ ...identity });
      canonicalBase = resourceClass === "worker"
        ? canonicalUnitHelper.createWorkerUnitBase(frozenIdentity)
        : canonicalUnitHelper.createControlUnitBase(frozenIdentity);
      suppliedBase = resourceClass === "worker"
        ? makeWorkerBase.call(unitHelper, frozenIdentity)
        : makeControlBase.call(unitHelper, frozenIdentity);
      suppliedScope = makeScopeUnit.call(unitHelper, suppliedBase);
    } catch {
      throw invalid(`${resourceClass}Identity`);
    }
    const canonicalScope = canonicalUnitHelper.scopeUnitFromBase(canonicalBase);
    if (suppliedBase !== canonicalBase || suppliedScope !== canonicalScope) {
      throw invalid("unitHelper");
    }
    return Object.freeze({
      resourceClass,
      ...identity,
      unitBase: canonicalBase,
      scopeUnit: canonicalScope,
    });
  }

  async function queryScope(request) {
    let context;
    try {
      context = contexts.get(request.unitName);
      if (!context
        || request.projectId !== context.projectId
        || request.generationId !== context.generationId
        || request.resourceClass !== context.resourceClass) return null;
      const identity = context.resourceClass === "worker"
        ? Object.freeze({ projectId: context.projectId, generationId: context.generationId })
        : Object.freeze({
            projectId: context.projectId,
            generationId: context.generationId,
            operationId: context.operationId,
          });
      const observation = await observeWithBoundary(
        context.resourceClass === "worker" ? observeWorker : observeControl,
        observationProvider,
        identity,
        request.signal,
        providerTimeoutMs,
      );
      if (observation === PROVIDER_UNAVAILABLE) return null;
      return mapObservation(observation, context);
    } catch {
      return null;
    }
  }

  const controller = new ResourceController({
    executeProcess,
    queryScope,
    maxControlChildren: policy.control.max_concurrent_children,
    controlClassName: DEFAULT_CONTROL_CLASS_NAME,
    scopeQueryTimeoutMs: CONTROLLER_QUERY_TIMEOUT_MS,
    ...(now === undefined ? {} : { now }),
  });

  async function runWithContext(context, operation) {
    if (contexts.has(context.unitBase)) throw invalid("run.identity");
    contexts.set(context.unitBase, context);
    try {
      return await operation();
    } finally {
      if (contexts.get(context.unitBase) === context) contexts.delete(context.unitBase);
    }
  }

  async function runWorker(value) {
    const input = normalizeRunInput(value, WORKER_FIELDS, "worker");
    try {
      const context = generatedContext("worker", {
        projectId: input.projectId,
        generationId: input.generationId,
      });
      return await runWithContext(context, () => controller.runWorkerScope({
        projectId: context.projectId,
        generationId: context.generationId,
        unitName: context.unitBase,
        command: input.command,
        args: input.args,
        limits: {
          memoryHighMib: policy.worker.memory_high_mib,
          memoryMaxMib: policy.worker.memory_max_mib,
          swapMaxMib: policy.worker.swap_max_mib,
        },
        signal: input.signal,
      }));
    } finally {
      input.cleanupSignal();
    }
  }

  async function runControl(value) {
    const input = normalizeRunInput(value, CONTROL_FIELDS, "control");
    try {
      const context = generatedContext("control", {
        projectId: input.projectId,
        generationId: input.generationId,
        operationId: input.operationId,
      });
      return await runWithContext(context, () => controller.runControlChild({
        projectId: context.projectId,
        generationId: context.generationId,
        unitName: context.unitBase,
        command: input.command,
        args: input.args,
        signal: input.signal,
      }));
    } finally {
      input.cleanupSignal();
    }
  }

  function snapshot() {
    return controller.snapshot();
  }

  return Object.freeze({ runWorker, runControl, snapshot });
}

module.exports = {
  ResourceControllerAdapterError,
  createResourceControllerAdapter,
};
