"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RESOURCE_STATE_VERSION = 1;
const DEFAULT_TERMINAL_FACT_LIMIT = 100;
const MAX_TERMINAL_FACT_LIMIT = 1_000;
const TERMINAL_FACT_SCAN_FACTOR = 10;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_OOM_KILL_COUNT = (1n << 64n) - 1n;
const INVALID = Symbol("invalid resource state field");

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNIT_RE = /^[a-z][a-z0-9.-]{0,127}$/;
const SIGNAL_RE = /^SIG[A-Z0-9]{1,30}$/;
const RESOURCE_CLASSES = new Set(["worker", "control", "api"]);
const TERMINAL_REASONS = new Set(["normal_exit", "signal", "oom_kill", "unknown"]);
const STATUSES = new Set([
  "ready",
  "degraded",
  "unavailable",
  "unknown",
  "invalid_resource_policy",
  "containment_unavailable",
  "temp_unavailable",
  "capacity_exhausted",
  "candidate_pending_staging",
]);

const COUNT_FIELDS = Object.freeze([
  "active_worker_scopes",
  "active_control_children",
  "queued_control_children",
]);
const LIMIT_FIELDS = Object.freeze([
  "host_reserve_mib",
  "max_worker_scopes",
  "max_control_children",
  "worker_memory_high_mib",
  "worker_memory_max_mib",
  "worker_swap_max_mib",
  "control_memory_max_mib",
  "control_swap_max_mib",
  "api_memory_low_mib",
  "api_memory_max_mib",
  "temp_min_free_mib",
]);
const USAGE_FIELDS = Object.freeze([
  "host_memory_total_mib",
  "host_memory_available_mib",
  "swap_total_mib",
  "swap_free_mib",
  "worker_memory_mib",
  "control_memory_mib",
  "api_memory_mib",
  "static_reservation_mib",
  "static_headroom_mib",
  "configured_swap_mib",
  "swap_headroom_mib",
]);

function safeGet(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return INVALID;
  try {
    return value[key];
  } catch {
    return INVALID;
  }
}

function safeArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function validTerminalFactLimit(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TERMINAL_FACT_LIMIT;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizeIntegerFields(input, fields, { positive = false } = {}) {
  const output = {};
  for (const field of fields) {
    const value = nonNegativeInteger(safeGet(input, field));
    if (value !== null && (!positive || value > 0)) output[field] = value;
  }
  return output;
}

function removeContradictoryPairs(output, pairs) {
  for (const [lower, upper] of pairs) {
    if (output[lower] !== undefined && output[upper] !== undefined && output[lower] > output[upper]) {
      delete output[lower];
      delete output[upper];
    }
  }
  return output;
}

function sanitizeExitCode(value) {
  if (value === null) return { valid: true, value: null };
  if (Number.isSafeInteger(value) && value >= 0 && value <= 255) return { valid: true, value };
  return { valid: false, value: null };
}

function sanitizeSignal(value) {
  if (value === null) return { valid: true, value: null };
  if (Number.isSafeInteger(value) && value > 0) return { valid: true, value };
  if (typeof value === "string" && SIGNAL_RE.test(value)) return { valid: true, value };
  return { valid: false, value: null };
}

function sanitizeTime(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  try {
    return new Date(millis).toISOString();
  } catch {
    return null;
  }
}

function sanitizeTerminalFact(input, hasOomProvenance) {
  if (input === INVALID) return null;
  const projectId = safeGet(input, "project_id");
  const generationId = safeGet(input, "generation_id");
  const resourceClass = safeGet(input, "resource_class");
  const unitName = safeGet(input, "unit_name");
  const reason = safeGet(input, "reason");
  const finishedAt = sanitizeTime(safeGet(input, "finished_at"));
  if (typeof projectId !== "string" || !IDENTIFIER_RE.test(projectId)
    || typeof generationId !== "string" || !IDENTIFIER_RE.test(generationId)
    || typeof resourceClass !== "string" || !RESOURCE_CLASSES.has(resourceClass)
    || typeof unitName !== "string" || !UNIT_RE.test(unitName)
    || typeof reason !== "string" || !TERMINAL_REASONS.has(reason)
    || finishedAt === null) {
    return null;
  }
  const exit = sanitizeExitCode(safeGet(input, "exit_code"));
  const signal = sanitizeSignal(safeGet(input, "signal"));
  let normalizedReason = reason;
  // Terminal authority is deliberately strict. A normal exit has one exact
  // representation. Signal exits retain no competing exit code. OOM authority
  // comes from the separately validated cgroup observation below. Other
  // contradictory claims remain redacted evidence but downgrade to unknown.
  if (reason === "normal_exit"
    && (!exit.valid || exit.value !== 0 || !signal.valid || signal.value !== null)) normalizedReason = "unknown";
  if (reason === "signal"
    && (!exit.valid || exit.value !== null || !signal.valid || signal.value === null)) normalizedReason = "unknown";
  // The validated cgroup observation is the OOM authority. Wrapper exit/signal
  // metadata may be empty (for example, a descendant was killed) and cannot
  // override it, but malformed non-null metadata still fails closed.
  if (reason === "oom_kill" && (!hasOomProvenance || !exit.valid || !signal.valid)) normalizedReason = "unknown";
  return Object.freeze({
    project_id: projectId,
    generation_id: generationId,
    resource_class: resourceClass,
    unit_name: unitName,
    reason: normalizedReason,
    exit_code: exit.value,
    signal: signal.value,
    finished_at: finishedAt,
  });
}

function sanitizeTerminalFacts(input, limit, hasOomProvenance) {
  if (!safeArray(input)) return [];
  const rawLength = safeGet(input, "length");
  if (!Number.isSafeInteger(rawLength) || rawLength < 0) return [];
  const facts = [];
  const scanBudget = Math.min(rawLength, limit * TERMINAL_FACT_SCAN_FACTOR);
  const stop = rawLength - scanBudget;
  for (let index = rawLength - 1; index >= stop && facts.length < limit; index -= 1) {
    const fact = sanitizeTerminalFact(safeGet(input, index), hasOomProvenance);
    if (fact) facts.push(fact);
  }
  return facts.reverse();
}

function sanitizeTemp(input) {
  const diskBacked = safeGet(input, "disk_backed");
  if (typeof diskBacked !== "boolean") return null;
  const freeMib = nonNegativeInteger(safeGet(input, "free_mib"));
  const totalMib = nonNegativeInteger(safeGet(input, "total_mib"));
  if (freeMib === null || totalMib === null || freeMib > totalMib) return null;
  return Object.freeze({ disk_backed: diskBacked, free_mib: freeMib, total_mib: totalMib });
}

function sanitizeOomKillCount(value) {
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

function sanitizeLastCgroupOom(input) {
  const count = sanitizeOomKillCount(safeGet(input, "oom_kill_count"));
  const observedAt = sanitizeTime(safeGet(input, "observed_at"));
  if (count === null || observedAt === null) return null;
  return Object.freeze({ oom_kill_count: count, observed_at: observedAt });
}

function hasEveryField(value, fields) {
  return fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function checkedProduct(left, right) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) return null;
  const result = left * right;
  return Number.isSafeInteger(result) ? result : null;
}

function checkedSum(values) {
  let result = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(result + value)) return null;
    result += value;
  }
  return result;
}

function completeReadySnapshot({ counts, limits, usage, temp }) {
  if (!hasEveryField(counts, COUNT_FIELDS)
    || !hasEveryField(limits, LIMIT_FIELDS)
    || !hasEveryField(usage, USAGE_FIELDS)
    || !temp
    || temp.disk_backed !== true
    || temp.free_mib < limits.temp_min_free_mib
    || counts.active_worker_scopes > limits.max_worker_scopes
    || counts.active_control_children > limits.max_control_children
    || usage.control_memory_mib > limits.control_memory_max_mib
    || usage.api_memory_mib > limits.api_memory_max_mib) {
    return false;
  }
  const workerCapacity = checkedProduct(limits.max_worker_scopes, limits.worker_memory_max_mib);
  const expectedStatic = checkedSum([
    limits.host_reserve_mib,
    limits.api_memory_max_mib,
    limits.control_memory_max_mib,
    workerCapacity,
  ]);
  const expectedSwap = checkedSum([
    limits.control_swap_max_mib,
    checkedProduct(limits.max_worker_scopes, limits.worker_swap_max_mib),
  ]);
  const observedMemory = checkedSum([
    usage.worker_memory_mib,
    usage.control_memory_mib,
    usage.api_memory_mib,
  ]);
  return workerCapacity !== null
    && usage.worker_memory_mib <= workerCapacity
    && expectedStatic !== null
    && usage.static_reservation_mib === expectedStatic
    && checkedSum([usage.static_reservation_mib, usage.static_headroom_mib]) === usage.host_memory_total_mib
    && expectedSwap !== null
    && usage.configured_swap_mib === expectedSwap
    && checkedSum([usage.configured_swap_mib, usage.swap_headroom_mib]) === usage.swap_total_mib
    && observedMemory !== null
    && observedMemory <= usage.host_memory_total_mib;
}

function freezeState(state) {
  Object.freeze(state.counts);
  Object.freeze(state.limits);
  Object.freeze(state.usage);
  Object.freeze(state.terminal_facts);
  return Object.freeze(state);
}

function createResourceSnapshot(input = {}, options = {}) {
  const limit = options.terminalFactLimit === undefined
    ? DEFAULT_TERMINAL_FACT_LIMIT
    : options.terminalFactLimit;
  if (!validTerminalFactLimit(limit)) {
    throw new TypeError(`terminalFactLimit must be an integer from 1 to ${MAX_TERMINAL_FACT_LIMIT}`);
  }
  const rawStatus = safeGet(input, "status");
  const counts = sanitizeIntegerFields(safeGet(input, "counts"), COUNT_FIELDS);
  const limits = removeContradictoryPairs(
    sanitizeIntegerFields(safeGet(input, "limits"), LIMIT_FIELDS, { positive: true }),
    [["worker_memory_high_mib", "worker_memory_max_mib"], ["api_memory_low_mib", "api_memory_max_mib"]],
  );
  const usage = removeContradictoryPairs(
    sanitizeIntegerFields(safeGet(input, "usage"), USAGE_FIELDS),
    [["host_memory_available_mib", "host_memory_total_mib"], ["swap_free_mib", "swap_total_mib"]],
  );
  const temp = sanitizeTemp(safeGet(input, "temp"));
  const lastCgroupOom = sanitizeLastCgroupOom(safeGet(input, "last_cgroup_oom"));
  const hasOomProvenance = lastCgroupOom !== null && BigInt(lastCgroupOom.oom_kill_count) > 0n;
  const state = {
    version: RESOURCE_STATE_VERSION,
    status: typeof rawStatus === "string" && STATUSES.has(rawStatus) ? rawStatus : "unknown",
    counts,
    limits,
    usage,
    temp,
    last_cgroup_oom: lastCgroupOom,
    terminal_facts: sanitizeTerminalFacts(safeGet(input, "terminal_facts"), limit, hasOomProvenance),
  };
  if (state.status === "ready" && !completeReadySnapshot(state)) state.status = "unknown";
  return freezeState(state);
}

function cloneSnapshot(state, terminalFactLimit) {
  return createResourceSnapshot(state, { terminalFactLimit });
}

class ResourceStateStore {
  constructor({
    filePath,
    fsImpl = fs,
    terminalFactLimit = DEFAULT_TERMINAL_FACT_LIMIT,
    expectedUid = typeof process.getuid === "function" ? process.getuid() : null,
  } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("filePath must be an absolute path");
    }
    if (!validTerminalFactLimit(terminalFactLimit)) {
      throw new TypeError(`terminalFactLimit must be an integer from 1 to ${MAX_TERMINAL_FACT_LIMIT}`);
    }
    if (expectedUid !== null && (!Number.isSafeInteger(expectedUid) || expectedUid < 0)) {
      throw new TypeError("expectedUid must be a non-negative safe integer or null");
    }
    this.filePath = filePath;
    this.fs = fsImpl;
    this.terminalFactLimit = terminalFactLimit;
    this.expectedUid = expectedUid;
    this.state = createResourceSnapshot({}, { terminalFactLimit });
  }

  load() {
    let parsed;
    let fd = null;
    try {
      const before = this.fs.lstatSync(this.filePath);
      if (before.isSymbolicLink()
        || !before.isFile()
        || (Number(before.mode) & 0o7777) !== 0o600
        || (this.expectedUid !== null && Number(before.uid) !== this.expectedUid)
        || !Number.isInteger(this.fs.constants.O_NOFOLLOW)) {
        throw new Error("untrusted state file");
      }
      fd = this.fs.openSync(this.filePath, this.fs.constants.O_RDONLY | this.fs.constants.O_NOFOLLOW);
      const opened = this.fs.fstatSync(fd);
      if (!opened.isFile()
        || (Number(opened.mode) & 0o7777) !== 0o600
        || (this.expectedUid !== null && Number(opened.uid) !== this.expectedUid)
        || String(before.dev) !== String(opened.dev)
        || String(before.ino) !== String(opened.ino)) {
        throw new Error("state file identity changed");
      }
      if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > MAX_STATE_BYTES) {
        throw new Error("state file size is unsupported");
      }
      parsed = JSON.parse(this.fs.readFileSync(fd, "utf8"));
      if (safeGet(parsed, "version") !== RESOURCE_STATE_VERSION) throw new Error("unsupported state version");
    } catch {
      this.state = createResourceSnapshot({}, { terminalFactLimit: this.terminalFactLimit });
      return this.snapshot();
    } finally {
      if (fd !== null) {
        try { this.fs.closeSync(fd); } catch {}
      }
    }
    this.state = createResourceSnapshot(parsed, { terminalFactLimit: this.terminalFactLimit });
    return this.snapshot();
  }

  save(input) {
    const next = createResourceSnapshot(input, { terminalFactLimit: this.terminalFactLimit });
    const tmpPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`;
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new RangeError("resource state exceeds the maximum serialized size");
    }
    try {
      this.fs.writeFileSync(tmpPath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      this.fs.chmodSync(tmpPath, 0o600);
      this.fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      try { this.fs.unlinkSync(tmpPath); } catch {}
      throw error;
    }
    this.state = next;
    return this.snapshot();
  }

  snapshot() {
    return cloneSnapshot(this.state, this.terminalFactLimit);
  }
}

module.exports = {
  RESOURCE_STATE_VERSION,
  DEFAULT_TERMINAL_FACT_LIMIT,
  MAX_TERMINAL_FACT_LIMIT,
  MAX_STATE_BYTES,
  ResourceStateStore,
  createResourceSnapshot,
};
