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
const UINT64_MAX = (1n << 64n) - 1n;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

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

function safeKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(field);
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    throw invalid(field);
  }
  if (keys.some((key) => !allowed.has(key))) throw invalid(field);
  return keys;
}

function safeGet(value, key, field) {
  try {
    return value[key];
  } catch {
    throw invalid(field);
  }
}

function safeMethod(value, key, field) {
  const method = safeGet(value, key, field);
  if (typeof method !== "function") throw invalid(field);
  return method;
}

function normalizePolicy(value) {
  try {
    const policy = parseRuntimeResources(value);
    if (policy === null) throw invalid("policy");
    return policy;
  } catch {
    throw invalid("policy");
  }
}

function copyArgs(value) {
  if (!Array.isArray(value) || value.length > 10_000) throw invalid("run.args");
  const copy = [];
  try {
    for (let index = 0; index < value.length; index += 1) {
      const argument = value[index];
      if (typeof argument !== "string" || argument.includes("\0")) throw invalid("run.args");
      copy.push(argument);
    }
  } catch (error) {
    if (error instanceof ResourceControllerAdapterError) throw error;
    throw invalid("run.args");
  }
  return copy;
}

function normalizeRunInput(value, allowed, resourceClass) {
  safeKeys(value, allowed, `${resourceClass}Run`);
  const projectId = safeGet(value, "projectId", `${resourceClass}Run`);
  const generationId = safeGet(value, "generationId", `${resourceClass}Run`);
  const command = safeGet(value, "command", `${resourceClass}Run`);
  const args = copyArgs(safeGet(value, "args", `${resourceClass}Run`));
  const signal = safeGet(value, "signal", `${resourceClass}Run`);
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    throw invalid("run.command");
  }
  return {
    projectId,
    generationId,
    ...(resourceClass === "control"
      ? { operationId: safeGet(value, "operationId", "controlRun") }
      : {}),
    command,
    args,
    signal,
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
  if (typeof value !== "string" || value.length > 64 || !ISO_TIMESTAMP_RE.test(value)) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

function mapObservation(value, context) {
  if (!value || typeof value !== "object") return null;
  try {
    if (value.available !== true || value.status !== "ready" || value.reason !== null) return null;
    if (value.resource_class !== context.resourceClass
      || value.unit_base !== context.unitBase
      || value.unit_name !== context.scopeUnit) return null;
    if (!value.counters || typeof value.counters !== "object") return null;
    if (value.counters.source !== "local" && value.counters.source !== "hierarchical") return null;
    const oomKillCount = normalizeUint64(value.counters.oom_kill);
    const observedAt = normalizeObservedAt(value.observed_at);
    if (oomKillCount === null || observedAt === null) return null;
    return Object.freeze({ oomKillCount, observedAt });
  } catch {
    return null;
  }
}

function createResourceControllerAdapter(options = {}) {
  safeKeys(options, FACTORY_FIELDS, "options");
  const policy = normalizePolicy(safeGet(options, "policy", "options"));
  const unitHelper = safeGet(options, "unitHelper", "options") || canonicalUnitHelper;
  const observationProvider = safeGet(options, "observationProvider", "options");
  const executeProcess = safeGet(options, "executeProcess", "options");
  const now = safeGet(options, "now", "options");

  if (!unitHelper || typeof unitHelper !== "object") throw invalid("unitHelper");
  const makeWorkerBase = safeMethod(unitHelper, "createWorkerUnitBase", "unitHelper");
  const makeControlBase = safeMethod(unitHelper, "createControlUnitBase", "unitHelper");
  const makeScopeUnit = safeMethod(unitHelper, "scopeUnitFromBase", "unitHelper");
  if (!observationProvider || typeof observationProvider !== "object") {
    throw invalid("observationProvider");
  }
  const observeWorker = safeMethod(observationProvider, "observeWorker", "observationProvider");
  const observeControl = safeMethod(observationProvider, "observeControl", "observationProvider");
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
      const observation = context.resourceClass === "worker"
        ? await observeWorker.call(observationProvider, identity)
        : await observeControl.call(observationProvider, identity);
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
    const context = generatedContext("worker", {
      projectId: input.projectId,
      generationId: input.generationId,
    });
    return runWithContext(context, () => controller.runWorkerScope({
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
  }

  async function runControl(value) {
    const input = normalizeRunInput(value, CONTROL_FIELDS, "control");
    const context = generatedContext("control", {
      projectId: input.projectId,
      generationId: input.generationId,
      operationId: input.operationId,
    });
    return runWithContext(context, () => controller.runControlChild({
      projectId: context.projectId,
      generationId: context.generationId,
      unitName: context.unitBase,
      command: input.command,
      args: input.args,
      signal: input.signal,
    }));
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
