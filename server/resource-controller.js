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
const SIGNAL_RE = /^SIG[A-Z0-9]{1,30}$/;
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const DEFAULT_CONTROL_CLASS_NAME = "quadwork-control.slice";
const MAX_OOM_KILL_COUNT = (1n << 64n) - 1n;
const UNREADABLE = Symbol("unreadable resource process field");
const REJECTION_METADATA = new WeakMap();

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

function timestamp(now, field) {
  const normalized = normalizeObservedAt(now());
  if (normalized !== null) return normalized;
  const error = new Error(`${field} must be a valid timestamp`);
  error.code = "QW_INVALID_RESOURCE_TIMESTAMP";
  error.field = field;
  throw error;
}

function normalizeSignal(value) {
  if (value === null) return Object.freeze({ valid: true, value: null });
  if (typeof value === "string" && SIGNAL_RE.test(value)) {
    return Object.freeze({ valid: true, value });
  }
  // node-pty reports numeric signals while child_process reports names such as
  // SIGTERM. Preserve either representation for the later #1053 adapter.
  if (Number.isSafeInteger(value) && value > 0) {
    return Object.freeze({ valid: true, value });
  }
  return Object.freeze({ valid: false, value: null });
}

function normalizeExitCode(value) {
  if (value === null) return Object.freeze({ valid: true, value: null });
  if (Number.isSafeInteger(value) && value >= 0 && value <= 255) {
    return Object.freeze({ valid: true, value });
  }
  return Object.freeze({ valid: false, value: null });
}

function safeProperty(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return UNREADABLE;
  try {
    return value[key];
  } catch {
    return UNREADABLE;
  }
}

function normalizeProcessResult(value, exitCodeField = "code") {
  const exitCode = safeProperty(value, exitCodeField);
  const signal = safeProperty(value, "signal");
  return Object.freeze({
    exitCode: normalizeExitCode(exitCode === UNREADABLE ? undefined : exitCode),
    signal: normalizeSignal(signal === UNREADABLE ? undefined : signal),
  });
}

function normalizeOomKillCount(value) {
  let count;
  try {
    if (typeof value === "bigint") count = value;
    else if (Number.isSafeInteger(value) && value >= 0) count = BigInt(value);
    else if (typeof value === "string" && /^(?:0|[1-9]\d{0,19})$/.test(value)) count = BigInt(value);
    else return null;
  } catch {
    return null;
  }
  return count >= 0n && count <= MAX_OOM_KILL_COUNT ? count.toString(10) : null;
}

function normalizeObservedAt(value) {
  try {
    let millis;
    if (value instanceof Date) millis = value.getTime();
    else if (Number.isSafeInteger(value)) millis = value;
    else if (typeof value === "string" && value.length <= 64) {
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
      if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
          hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
        return null;
      }
      millis = Date.parse(value);
    }
    else return null;
    if (!Number.isFinite(millis)) return null;
    return new Date(millis).toISOString();
  } catch {
    return null;
  }
}

function normalizeScopeObservation(observation, requirePreCollectCapture = false) {
  if (!observation || typeof observation !== "object") return null;
  let capturedBeforeCollect;
  let oomKillCount;
  let observedAt;
  try {
    capturedBeforeCollect = observation.capturedBeforeCollect;
    oomKillCount = observation.oomKillCount;
    observedAt = observation.observedAt;
  } catch {
    return null;
  }
  if (requirePreCollectCapture && capturedBeforeCollect !== true) return null;
  const normalizedCount = normalizeOomKillCount(oomKillCount);
  const normalizedObservedAt = normalizeObservedAt(observedAt);
  if (normalizedCount === null || normalizedObservedAt === null) return null;
  // Retain only the counter and observation time used for classification. An
  // injected query or executor cannot smuggle paths, environment, or an
  // unverified oomKilled assertion into controller state through this object.
  return Object.freeze({ oomKillCount: normalizedCount, observedAt: normalizedObservedAt });
}

function qualifyScopeObservation(ids, resourceClass, scopeObservation) {
  if (scopeObservation === null) return null;
  return Object.freeze({
    project_id: ids.projectId,
    generation_id: ids.generationId,
    resource_class: resourceClass,
    unit_name: ids.unitName,
    oom_kill_count: scopeObservation.oomKillCount,
    observed_at: scopeObservation.observedAt,
  });
}

function terminalReason(processResult, scopeObservation, executionRejected = false) {
  const count = scopeObservation && scopeObservation.oomKillCount;
  if (!processResult.exitCode.valid || !processResult.signal.valid) return "unknown";
  // A process cannot authoritatively terminate from both an exit status and a
  // signal. Retain the normalized pair as evidence, but make the reason
  // state-compatible and fail closed before considering OOM provenance.
  if (processResult.exitCode.value !== null && processResult.signal.value !== null) return "unknown";
  if (typeof count === "string" && BigInt(count) > 0n) return "oom_kill";
  if (processResult.signal.value !== null) return "signal";
  if (!executionRejected && processResult.exitCode.value === 0) return "normal_exit";
  return "unknown";
}

function terminalFact({
  ids,
  resourceClass,
  processResult,
  scopeObservation,
  oomProvenance,
  executionRejected,
  now,
}) {
  const reason = terminalReason(processResult, scopeObservation, executionRejected);
  const fact = {
    project_id: ids.projectId,
    generation_id: ids.generationId,
    resource_class: resourceClass,
    unit_name: ids.unitName,
    reason,
    exit_code: processResult.exitCode.value,
    signal: processResult.signal.value,
    finished_at: timestamp(now, "finished_at"),
  };
  // Snapshot-level last_cgroup_oom is the latest observation and can advance
  // to another generation (including a zero counter). Bind positive OOM
  // authority to its own terminal fact so earlier generations survive that
  // advance and a state store can validate every retained fact independently.
  if (reason === "oom_kill" && oomProvenance !== null &&
      BigInt(oomProvenance.oom_kill_count) > 0n) {
    fact.oom_kill_count = oomProvenance.oom_kill_count;
    fact.oom_observed_at = oomProvenance.observed_at;
  }
  return fact;
}

function durableScopeObservation(value) {
  const observation = safeProperty(value, "scopeObservation");
  if (observation === UNREADABLE) return null;
  return normalizeScopeObservation(observation, true);
}

function isError(value) {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function executionRejectionError(value, valueIsError) {
  if (valueIsError) return value;
  const error = new Error("resource process execution rejected with a non-Error value");
  error.name = "ResourceExecutionError";
  error.code = "QW_RESOURCE_EXECUTION_REJECTED";
  return error;
}

function rememberResourceRejection(error, fact, oomProvenance) {
  const metadata = Object.freeze({
    resourceFact: Object.freeze({ ...fact }),
    cgroup_oom_observation: oomProvenance === null
      ? null
      : Object.freeze({ ...oomProvenance }),
  });
  // Never write controller metadata onto an executor-owned Error. Assignment
  // can invoke inherited setters or Proxy traps, and fails for frozen or
  // non-extensible errors. WeakMap preserves the exact rejection identity
  // without inspecting or mutating it.
  REJECTION_METADATA.set(error, metadata);
}

function getResourceRejectionMetadata(error) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
  return REJECTION_METADATA.get(error) || null;
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
    this.lastCgroupOom = null;
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
      started_at: timestamp(this.now, "started_at"),
    });

    try {
      let result = null;
      let executionError = null;
      let executionRejected = false;
      let scopeObservation = null;
      let processResult;
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
        processResult = normalizeProcessResult(result);
        scopeObservation = durableScopeObservation(result);
      } catch (rejectedValue) {
        executionRejected = true;
        const rejectedValueIsError = isError(rejectedValue);
        executionError = executionRejectionError(rejectedValue, rejectedValueIsError);
        if (rejectedValueIsError) {
          processResult = normalizeProcessResult(rejectedValue, "exitCode");
          scopeObservation = durableScopeObservation(rejectedValue);
        } else {
          // Do not inspect, stringify, retain, or expose arbitrary rejected
          // values. They may contain credentials or terminal/process output.
          result = { code: null, signal: null };
          processResult = normalizeProcessResult(result);
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

      const oomProvenance = qualifyScopeObservation(ids, resourceClass, scopeObservation);
      const fact = terminalFact({
        ids,
        resourceClass,
        processResult,
        scopeObservation,
        oomProvenance,
        executionRejected,
        now: this.now,
      });
      this.terminalFacts.push(fact);
      if (this.terminalFacts.length > this.terminalFactLimit) this.terminalFacts.shift();
      if (oomProvenance !== null) this.lastCgroupOom = oomProvenance;

      if (executionRejected) {
        rememberResourceRejection(executionError, fact, oomProvenance);
        throw executionError;
      }
      return {
        result,
        fact: { ...fact },
        cgroup_oom_observation: oomProvenance === null ? null : { ...oomProvenance },
      };
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
      // This shape is intentionally identical to resource-state's
      // last_cgroup_oom input. The controller supplies immutable identity; the
      // injected observation supplies only its validated uint64/time pair.
      last_cgroup_oom: this.lastCgroupOom === null ? null : { ...this.lastCgroupOom },
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
  getResourceRejectionMetadata,
};
