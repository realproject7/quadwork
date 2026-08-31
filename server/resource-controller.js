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

const UNIT_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const QUALIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

function invocation(spec, resourceClass) {
  const ids = qualification(spec);
  validateCommand(spec.command, spec.args || []);
  const limits = resourceClass === "worker"
    ? normalizeWorkerLimits(spec.limits)
    : normalizeControlLimits(spec.limits);
  const properties = resourceClass === "worker"
    ? [
        `MemoryHigh=${limits.memoryHighMib}M`,
        `MemoryMax=${limits.memoryMaxMib}M`,
        `MemorySwapMax=${limits.swapMaxMib}M`,
      ]
    : [
        `MemoryMax=${limits.memoryMaxMib}M`,
        `MemorySwapMax=${limits.swapMaxMib}M`,
      ];
  const args = [
    ...SYSTEMD_SCOPE_CANDIDATE.fixedArgs,
    `--unit=${ids.unitName}`,
  ];
  for (const property of properties) args.push("-p", property);
  args.push("--", spec.command, ...(spec.args || []));
  return {
    file: SYSTEMD_SCOPE_CANDIDATE.executable,
    args,
    candidateStatus: SYSTEMD_SCOPE_CANDIDATE.status,
    resourceClass,
    ids,
    limits,
  };
}

function buildWorkerScopeInvocation(spec) {
  return invocation(spec, "worker");
}

function buildControlScopeInvocation(spec) {
  return invocation(spec, "control");
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

function terminalReason(result, scopeObservation) {
  const count = scopeObservation && scopeObservation.oomKillCount;
  if (result?.oomKilled === true || scopeObservation?.oomKilled === true ||
      (typeof count === "bigint" ? count > 0n : Number.isFinite(count) && count > 0)) return "oom_kill";
  if (normalizeSignal(result?.signal) !== null) return "signal";
  if (result?.code === 0) return "normal_exit";
  return "unknown";
}

function terminalFact({ ids, resourceClass, result, scopeObservation, now }) {
  const reason = terminalReason(result, scopeObservation);
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

class ResourceController {
  constructor({
    executeProcess,
    queryScope,
    maxControlChildren = 1,
    now = () => new Date(),
    terminalFactLimit = 100,
  } = {}) {
    if (typeof executeProcess !== "function") {
      throw invalid("executeProcess", "must be dependency-injected");
    }
    if (typeof queryScope !== "function") throw invalid("queryScope", "must be a function");
    if (!Number.isSafeInteger(terminalFactLimit) || terminalFactLimit <= 0) {
      throw invalid("terminalFactLimit", "must be a positive integer");
    }
    this.executeProcess = executeProcess;
    this.queryScope = queryScope;
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
    return this.controlLimiter.runLeaf(
      () => this._runScope(buildControlScopeInvocation(spec), spec.signal),
      spec.signal,
    );
  }

  async _runScope(built, signal) {
    const { ids, resourceClass, limits } = built;
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
      limits: resourceClass === "worker"
        ? {
            memory_high_mib: limits.memoryHighMib,
            memory_max_mib: limits.memoryMaxMib,
            swap_max_mib: limits.swapMaxMib,
          }
        : {
            memory_max_mib: limits.memoryMaxMib,
            swap_max_mib: limits.swapMaxMib,
          },
      started_at: timestamp(this.now),
    });

    let result = null;
    let executionError = null;
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
      });
    } catch (error) {
      executionError = error;
      result = {
        code: Number.isInteger(error?.exitCode) ? error.exitCode : null,
        signal: normalizeSignal(error?.signal),
        oomKilled: error?.oomKilled === true,
      };
    }

    try {
      scopeObservation = await this.queryScope({
        projectId: ids.projectId,
        generationId: ids.generationId,
        unitName: ids.unitName,
        resourceClass,
      });
    } catch {
      // Query failure is represented by an `unknown` terminal fact when exit
      // data also cannot classify the result. Never leak the query error text.
      scopeObservation = null;
    }

    let fact;
    try {
      fact = terminalFact({ ids, resourceClass, result, scopeObservation, now: this.now });
      this.terminalFacts.push(fact);
      if (this.terminalFacts.length > this.terminalFactLimit) this.terminalFacts.shift();
    } finally {
      // Observation/classification failures must not strand an active scope in
      // the redacted controller state. The control limiter releases separately
      // in its own finally block.
      this.activeScopes.delete(ids.unitName);
    }

    if (executionError) {
      executionError.resourceFact = { ...fact };
      throw executionError;
    }
    return { result, fact: { ...fact } };
  }

  snapshot() {
    return {
      protocol_status: SYSTEMD_SCOPE_CANDIDATE.status,
      control_children: {
        limit: this.controlLimiter.limit,
        active: this.controlLimiter.active,
        queued: this.controlLimiter.queued,
      },
      active_scopes: [...this.activeScopes.values()].map((entry) => ({
        ...entry,
        limits: { ...entry.limits },
      })),
      terminal_facts: this.terminalFacts.map((fact) => ({ ...fact })),
    };
  }
}

module.exports = {
  SYSTEMD_SCOPE_CANDIDATE,
  ResourceController,
  buildWorkerScopeInvocation,
  buildControlScopeInvocation,
  validateUnitName,
};
