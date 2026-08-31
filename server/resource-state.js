"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RESOURCE_STATE_VERSION = 1;
const DEFAULT_TERMINAL_FACT_LIMIT = 100;
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

function sanitizeSignal(value) {
  if (value === null || value === undefined || value === INVALID) return null;
  if (Number.isSafeInteger(value) && value > 0) return value;
  return typeof value === "string" && SIGNAL_RE.test(value) ? value : null;
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

function sanitizeTerminalFact(input) {
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
  const rawExitCode = safeGet(input, "exit_code");
  const exitCode = rawExitCode === null
    ? null
    : (Number.isSafeInteger(rawExitCode) && rawExitCode >= 0 && rawExitCode <= 255 ? rawExitCode : null);
  return Object.freeze({
    project_id: projectId,
    generation_id: generationId,
    resource_class: resourceClass,
    unit_name: unitName,
    reason,
    exit_code: exitCode,
    signal: sanitizeSignal(safeGet(input, "signal")),
    finished_at: finishedAt,
  });
}

function sanitizeTerminalFacts(input, limit) {
  if (!safeArray(input)) return [];
  const rawLength = safeGet(input, "length");
  if (!Number.isSafeInteger(rawLength) || rawLength < 0) return [];
  const facts = [];
  const start = Math.max(0, rawLength - limit);
  for (let index = start; index < rawLength; index += 1) {
    const fact = sanitizeTerminalFact(safeGet(input, index));
    if (fact) facts.push(fact);
  }
  return facts.slice(-limit);
}

function sanitizeTemp(input) {
  const diskBacked = safeGet(input, "disk_backed");
  if (typeof diskBacked !== "boolean") return null;
  const freeMib = nonNegativeInteger(safeGet(input, "free_mib"));
  const totalMib = nonNegativeInteger(safeGet(input, "total_mib"));
  if (freeMib === null || totalMib === null || freeMib > totalMib) return null;
  return Object.freeze({ disk_backed: diskBacked, free_mib: freeMib, total_mib: totalMib });
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
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("terminalFactLimit must be a positive safe integer");
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
  return freezeState({
    version: RESOURCE_STATE_VERSION,
    status: typeof rawStatus === "string" && STATUSES.has(rawStatus) ? rawStatus : "unknown",
    counts,
    limits,
    usage,
    temp: sanitizeTemp(safeGet(input, "temp")),
    terminal_facts: sanitizeTerminalFacts(safeGet(input, "terminal_facts"), limit),
  });
}

function cloneSnapshot(state, terminalFactLimit) {
  return createResourceSnapshot(state, { terminalFactLimit });
}

class ResourceStateStore {
  constructor({ filePath, fsImpl = fs, terminalFactLimit = DEFAULT_TERMINAL_FACT_LIMIT } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new TypeError("filePath must be an absolute path");
    }
    if (!Number.isSafeInteger(terminalFactLimit) || terminalFactLimit <= 0) {
      throw new TypeError("terminalFactLimit must be a positive safe integer");
    }
    this.filePath = filePath;
    this.fs = fsImpl;
    this.terminalFactLimit = terminalFactLimit;
    this.state = createResourceSnapshot({}, { terminalFactLimit });
  }

  load() {
    let parsed;
    try {
      parsed = JSON.parse(this.fs.readFileSync(this.filePath, "utf8"));
      if (safeGet(parsed, "version") !== RESOURCE_STATE_VERSION) throw new Error("unsupported state version");
    } catch {
      this.state = createResourceSnapshot({}, { terminalFactLimit: this.terminalFactLimit });
      return this.snapshot();
    }
    this.state = createResourceSnapshot(parsed, { terminalFactLimit: this.terminalFactLimit });
    return this.snapshot();
  }

  save(input) {
    const next = createResourceSnapshot(input, { terminalFactLimit: this.terminalFactLimit });
    const tmpPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`;
    try {
      this.fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, {
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
  ResourceStateStore,
  createResourceSnapshot,
};
