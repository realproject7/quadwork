"use strict";

// #1038: This is a candidate invocation contract until the disposable-VPS
// staging matrix proves PTY ownership, resize/signals, exit propagation, and
// descendant containment. In particular, do not add --pipe: it does not make
// the child a TTY controller. #1053 owns the later node-pty/live-spawn wiring.
const SYSTEMD_SCOPE_CANDIDATE = Object.freeze({
  status: "candidate_pending_staging",
  executable: "systemd-run",
  fixedArgs: Object.freeze(["--user", "--scope", "--collect", "--quiet"]),
});

// The control-plane budget is host-wide, not a per-child allowance. This pure
// builder describes the separate, explicit candidate command that would set a
// shared slice's aggregate properties. Nothing in this module executes it.
const SYSTEMD_CONTROL_CLASS_CANDIDATE = Object.freeze({
  status: "candidate_pending_staging",
  executable: "systemctl",
  fixedArgs: Object.freeze(["--user", "--runtime", "set-property"]),
});

const UNIT_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const CONTROL_CLASS_NAME_RE = /^[a-z][a-z0-9-]{0,62}\.slice$/;
const QUALIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_CONTROL_CLASS_NAME = "quadwork-control.slice";

function invalid(field, detail) {
  const error = new Error(`${field} ${detail}`);
  error.code = "QW_INVALID_RESOURCE_ARGUMENT";
  error.field = field;
  return error;
}

function validateUnitName(value) {
  if (typeof value !== "string" || !UNIT_NAME_RE.test(value)) {
    throw invalid("unitName", "must match ^[a-z][a-z0-9-]{0,62}$");
  }
  return value;
}

function validateControlClassName(value) {
  if (typeof value !== "string" || !CONTROL_CLASS_NAME_RE.test(value)) {
    throw invalid("controlClassName", "must be a lowercase systemd slice unit ending in .slice");
  }
  return value;
}

function validateQualifier(value, field) {
  if (typeof value !== "string" || !QUALIFIER_RE.test(value)) {
    throw invalid(field, "must be a non-empty, path-free identifier of at most 128 characters");
  }
  return value;
}

function validateCommand(command, args) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    throw invalid("command", "must be a non-empty string without NUL bytes");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw invalid("args", "must be an array of strings without NUL bytes");
  }
}

function positiveMib(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(field, "must be a positive integer MiB value");
  }
  return value;
}

function normalizeWorkerLimits(limits) {
  const input = limits && typeof limits === "object" ? limits : {};
  const normalized = {
    memoryHighMib: positiveMib(input.memoryHighMib, "limits.memoryHighMib"),
    memoryMaxMib: positiveMib(input.memoryMaxMib, "limits.memoryMaxMib"),
    swapMaxMib: positiveMib(input.swapMaxMib, "limits.swapMaxMib"),
  };
  if (normalized.memoryHighMib > normalized.memoryMaxMib) {
    throw invalid("limits.memoryHighMib", "must be less than or equal to limits.memoryMaxMib");
  }
  return normalized;
}

function normalizeControlLimits(limits) {
  const input = limits && typeof limits === "object" ? limits : {};
  return {
    memoryMaxMib: positiveMib(input.memoryMaxMib, "limits.memoryMaxMib"),
    swapMaxMib: positiveMib(input.swapMaxMib, "limits.swapMaxMib"),
  };
}

function qualification(spec) {
  return {
    projectId: validateQualifier(spec.projectId, "projectId"),
    generationId: validateQualifier(spec.generationId, "generationId"),
    unitName: validateUnitName(spec.unitName),
  };
}

function buildWorkerScopeInvocation(spec) {
  const ids = qualification(spec);
  validateCommand(spec.command, spec.args || []);
  const limits = normalizeWorkerLimits(spec.limits);
  const args = [
    ...SYSTEMD_SCOPE_CANDIDATE.fixedArgs,
    `--unit=${ids.unitName}`,
  ];
  for (const property of [
    `MemoryHigh=${limits.memoryHighMib}M`,
    `MemoryMax=${limits.memoryMaxMib}M`,
    `MemorySwapMax=${limits.swapMaxMib}M`,
  ]) args.push("-p", property);
  args.push("--", spec.command, ...(spec.args || []));
  return {
    file: SYSTEMD_SCOPE_CANDIDATE.executable,
    args,
    candidateStatus: SYSTEMD_SCOPE_CANDIDATE.status,
    resourceClass: "worker",
    ids,
    limits,
  };
}

function buildControlClassConfiguration(spec = {}) {
  const controlClassName = validateControlClassName(spec.controlClassName);
  const limits = normalizeControlLimits(spec.limits);
  return {
    file: SYSTEMD_CONTROL_CLASS_CANDIDATE.executable,
    args: [
      ...SYSTEMD_CONTROL_CLASS_CANDIDATE.fixedArgs,
      controlClassName,
      `MemoryMax=${limits.memoryMaxMib}M`,
      `MemorySwapMax=${limits.swapMaxMib}M`,
    ],
    candidateStatus: SYSTEMD_CONTROL_CLASS_CANDIDATE.status,
    resourceClass: "control",
    controlClassName,
    limits,
  };
}

function buildControlScopeInvocation(spec) {
  const ids = qualification(spec);
  validateCommand(spec.command, spec.args || []);
  if (Object.prototype.hasOwnProperty.call(spec, "limits")) {
    throw invalid("limits", "must be configured once on the shared control class, not on a child");
  }
  const controlClassName = validateControlClassName(spec.controlClassName);
  return {
    file: SYSTEMD_SCOPE_CANDIDATE.executable,
    args: [
      ...SYSTEMD_SCOPE_CANDIDATE.fixedArgs,
      `--unit=${ids.unitName}`,
      `--slice=${controlClassName}`,
      "--",
      spec.command,
      ...(spec.args || []),
    ],
    candidateStatus: SYSTEMD_SCOPE_CANDIDATE.status,
    resourceClass: "control",
    controlClassName,
    ids,
  };
}

function abortError() {
  const error = new Error("Control child cancelled before launch");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

// Permits exist only at the actual child-process leaf. High-level repository,
// PR, and verification fan-out must call runControlChild at its leaves instead
// of holding a permit around orchestration that can recursively schedule more
// children. The limiter deliberately exposes no public acquire/withPermit API.
class LeafChildLimiter {
  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw invalid("maxControlChildren", "must be a positive integer");
    }
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  get queued() {
    return this.queue.length;
  }

  async runLeaf(task, signal) {
    const release = await this._acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  _acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this._releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError());
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  _releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this._drain();
    };
  }

  _drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (waiter.signal) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this._releaseOnce());
    }
  }
}

function timestamp(now) {
  const value = now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return String(value);
}

function normalizeSignal(value) {
  if (typeof value === "string" && value) return value;
  // node-pty reports numeric signals while child_process reports names such as
  // SIGTERM. Preserve either representation for the later #1053 adapter.
  if (Number.isSafeInteger(value) && value > 0) return value;
  return null;
}

function validOomKillCount(value) {
  return (typeof value === "bigint" && value >= 0n) ||
    (Number.isSafeInteger(value) && value >= 0);
}

function normalizeScopeObservation(observation, requirePreCollectCapture = false) {
  if (!observation || typeof observation !== "object") return null;
  let capturedBeforeCollect;
  let oomKillCount;
  try {
    capturedBeforeCollect = observation.capturedBeforeCollect;
    oomKillCount = observation.oomKillCount;
  } catch {
    return null;
  }
  if (requirePreCollectCapture && capturedBeforeCollect !== true) return null;
  if (!validOomKillCount(oomKillCount)) return null;
  // Retain only the counter used for classification. An injected query or
  // executor cannot smuggle paths, environment, or an unverified oomKilled
  // assertion into controller state through an observation object.
  return Object.freeze({ oomKillCount });
}

function terminalReason(result, scopeObservation, executionRejected = false) {
  const count = scopeObservation && scopeObservation.oomKillCount;
  if (validOomKillCount(count) && (typeof count === "bigint" ? count > 0n : count > 0)) {
    return "oom_kill";
  }
  if (normalizeSignal(result?.signal) !== null) return "signal";
  if (!executionRejected && result?.code === 0) return "normal_exit";
  return "unknown";
}

function terminalFact({ ids, resourceClass, result, scopeObservation, executionRejected, now }) {
  const reason = terminalReason(result, scopeObservation, executionRejected);
  return {
    project_id: ids.projectId,
    generation_id: ids.generationId,
    resource_class: resourceClass,
    unit_name: ids.unitName,
    reason,
    exit_code: Number.isInteger(result?.code) ? result.code : null,
    signal: normalizeSignal(result?.signal),
    finished_at: timestamp(now),
  };
}

function durableScopeObservation(value) {
  let observation;
  try {
    observation = value && value.scopeObservation;
  } catch {
    return null;
  }
  return normalizeScopeObservation(observation, true);
}

function executionRejectionError(value) {
  if (value instanceof Error) return value;
  const error = new Error("resource process execution rejected with a non-Error value");
  error.name = "ResourceExecutionError";
  error.code = "QW_RESOURCE_EXECUTION_REJECTED";
  return error;
}

// systemd --collect may unload a scope before a post-exit query can observe it.
// Executors can therefore return a durable scopeObservation captured while the
// scope still existed. This bounded query is only the fallback, and its derived
// signal lets an injected query implementation stop its own I/O on timeout or
// caller cancellation. Promise.race still bounds callers that ignore signals.
async function queryScopeBounded(queryScope, request, { timeoutMs, signal }) {
  if (signal?.aborted) return null;

  const controller = new AbortController();
  let timer = null;
  let onAbort = null;
  let finishBoundary;
  const boundary = new Promise((resolve) => {
    finishBoundary = resolve;
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        controller.abort();
        resolve(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const query = Promise.resolve()
    .then(() => queryScope({ ...request, signal: controller.signal }))
    .catch(() => null);

  try {
    return await Promise.race([query, boundary]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    finishBoundary(null);
  }
}

class ResourceController {
  constructor({
    executeProcess,
    queryScope,
    maxControlChildren = 1,
    controlClassName = DEFAULT_CONTROL_CLASS_NAME,
    scopeQueryTimeoutMs = 1_000,
    now = () => new Date(),
    terminalFactLimit = 100,
  } = {}) {
    if (typeof executeProcess !== "function") {
      throw invalid("executeProcess", "must be dependency-injected");
    }
    if (typeof queryScope !== "function") throw invalid("queryScope", "must be a function");
    if (!Number.isSafeInteger(scopeQueryTimeoutMs) || scopeQueryTimeoutMs <= 0) {
      throw invalid("scopeQueryTimeoutMs", "must be a positive integer number of milliseconds");
    }
    if (!Number.isSafeInteger(terminalFactLimit) || terminalFactLimit <= 0) {
      throw invalid("terminalFactLimit", "must be a positive integer");
    }
    this.executeProcess = executeProcess;
    this.queryScope = queryScope;
    this.controlClassName = validateControlClassName(controlClassName);
    this.scopeQueryTimeoutMs = scopeQueryTimeoutMs;
    this.now = now;
    this.terminalFactLimit = terminalFactLimit;
    this.controlLimiter = new LeafChildLimiter(maxControlChildren);
    this.activeScopes = new Map();
    this.terminalFacts = [];
  }

  runWorkerScope(spec) {
    return this._runScope(buildWorkerScopeInvocation(spec), spec.signal);
  }

  runControlChild(spec) {
    // Only this leaf method owns a control permit. Orchestrators remain outside
    // the semaphore, so nested repository/PR fan-out cannot consume permits
    // while waiting for the child calls it still needs to schedule.
    if (Object.prototype.hasOwnProperty.call(spec, "controlClassName") &&
        spec.controlClassName !== this.controlClassName) {
      throw invalid("controlClassName", "must match the controller's host-wide control class");
    }
    return this.controlLimiter.runLeaf(
      () => this._runScope(buildControlScopeInvocation({
        ...spec,
        controlClassName: this.controlClassName,
      }), spec.signal),
      spec.signal,
    );
  }

  async _runScope(built, signal) {
    const { ids, resourceClass, limits, controlClassName } = built;
    if (this.activeScopes.has(ids.unitName)) {
      const error = new Error(`resource scope is already active: ${ids.unitName}`);
      error.code = "QW_RESOURCE_SCOPE_ACTIVE";
      throw error;
    }
    this.activeScopes.set(ids.unitName, {
      project_id: ids.projectId,
      generation_id: ids.generationId,
      resource_class: resourceClass,
      unit_name: ids.unitName,
      ...(resourceClass === "worker"
        ? { limits: {
            memory_high_mib: limits.memoryHighMib,
            memory_max_mib: limits.memoryMaxMib,
            swap_max_mib: limits.swapMaxMib,
          } }
        : { control_class: controlClassName }),
      started_at: timestamp(this.now),
    });

    try {
      let result = null;
      let executionError = null;
      let executionRejected = false;
      let scopeObservation = null;
      try {
        result = await this.executeProcess({
          file: built.file,
          args: [...built.args],
          signal,
          projectId: ids.projectId,
          generationId: ids.generationId,
          unitName: ids.unitName,
          resourceClass,
          controlClassName: resourceClass === "control" ? controlClassName : null,
        });
        scopeObservation = durableScopeObservation(result);
      } catch (rejectedValue) {
        executionRejected = true;
        executionError = executionRejectionError(rejectedValue);
        if (rejectedValue instanceof Error) {
          result = {
            code: Number.isInteger(rejectedValue.exitCode) ? rejectedValue.exitCode : null,
            signal: normalizeSignal(rejectedValue.signal),
          };
          scopeObservation = durableScopeObservation(rejectedValue);
        } else {
          // Do not inspect, stringify, retain, or expose arbitrary rejected
          // values. They may contain credentials or terminal/process output.
          result = { code: null, signal: null };
          scopeObservation = null;
        }
      }

      if (scopeObservation === null) {
        const fallbackObservation = await queryScopeBounded(this.queryScope, {
          projectId: ids.projectId,
          generationId: ids.generationId,
          unitName: ids.unitName,
          resourceClass,
        }, {
          timeoutMs: this.scopeQueryTimeoutMs,
          signal,
        });
        scopeObservation = normalizeScopeObservation(fallbackObservation);
      }

      const fact = terminalFact({
        ids,
        resourceClass,
        result,
        scopeObservation,
        executionRejected,
        now: this.now,
      });
      this.terminalFacts.push(fact);
      if (this.terminalFacts.length > this.terminalFactLimit) this.terminalFacts.shift();

      if (executionRejected) {
        executionError.resourceFact = { ...fact };
        throw executionError;
      }
      return { result, fact: { ...fact } };
    } finally {
      // Execute, observation, normalization, and terminal-fact failures all
      // converge here. runControlChild's leaf limiter has its own outer finally,
      // so a thrown controller dependency cannot retain either state or permit.
      this.activeScopes.delete(ids.unitName);
    }
  }

  snapshot() {
    return {
      protocol_status: SYSTEMD_SCOPE_CANDIDATE.status,
      control_children: {
        limit: this.controlLimiter.limit,
        active: this.controlLimiter.active,
        queued: this.controlLimiter.queued,
      },
      control_class: {
        unit_name: this.controlClassName,
        aggregate: true,
      },
      active_scopes: [...this.activeScopes.values()].map((entry) => ({
        ...entry,
        ...(entry.limits ? { limits: { ...entry.limits } } : {}),
      })),
      terminal_facts: this.terminalFacts.map((fact) => ({ ...fact })),
    };
  }
}

module.exports = {
  SYSTEMD_SCOPE_CANDIDATE,
  SYSTEMD_CONTROL_CLASS_CANDIDATE,
  DEFAULT_CONTROL_CLASS_NAME,
  ResourceController,
  buildWorkerScopeInvocation,
  buildControlClassConfiguration,
  buildControlScopeInvocation,
  validateUnitName,
  validateControlClassName,
};
