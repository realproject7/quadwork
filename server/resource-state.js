"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  SecureResourceDirectoryError,
  createLinuxSecureDirectoryHandle,
  hasSingleLink,
  modeOf,
  normalizeRecoveryEntries,
  sameOwnedNode,
  sameRegularNode,
  validateCanonicalDirectory,
  validateEntryName,
} = require("./resource-secure-directory");

const RESOURCE_STATE_VERSION = 1;
const DEFAULT_TERMINAL_FACT_LIMIT = 100;
const MAX_TERMINAL_FACT_LIMIT = 1_000;
const TERMINAL_FACT_SCAN_FACTOR = 10;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_OOM_KILL_COUNT = (1n << 64n) - 1n;
const INVALID = Symbol("invalid resource state field");
const UNOBSERVED_IDENTITY = Symbol("unobserved resource state identity");
const UNTRUSTED_IDENTITY = Symbol("untrusted resource state identity");
const STORE_STATE = new WeakMap();

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNIT_RE = /^[a-z][a-z0-9.-]{0,127}$/;
const SIGNAL_RE = /^SIG[A-Z0-9]{1,30}$/;
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
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

function safeHasOwn(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return INVALID;
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return INVALID;
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

function sanitizeInlineOom(input) {
  const hasCount = safeHasOwn(input, "oom_kill_count");
  const hasObservedAt = safeHasOwn(input, "oom_observed_at");
  if (hasCount === false && hasObservedAt === false) return { present: false, value: null };
  if (hasCount !== true || hasObservedAt !== true) return { present: true, value: null };
  const count = sanitizeOomKillCount(safeGet(input, "oom_kill_count"));
  const observedAt = sanitizeTime(safeGet(input, "oom_observed_at"));
  if (count === null || BigInt(count) === 0n || observedAt === null) {
    return { present: true, value: null };
  }
  return {
    present: true,
    value: Object.freeze({ oom_kill_count: count, oom_observed_at: observedAt }),
  };
}

function legacyOomForFact(oomProvenance, { projectId, generationId, resourceClass, unitName }) {
  if (oomProvenance === null
    || oomProvenance.project_id !== projectId
    || oomProvenance.generation_id !== generationId
    || oomProvenance.resource_class !== resourceClass
    || oomProvenance.unit_name !== unitName
    || BigInt(oomProvenance.oom_kill_count) === 0n) return null;
  return Object.freeze({
    oom_kill_count: oomProvenance.oom_kill_count,
    oom_observed_at: oomProvenance.observed_at,
  });
}

function sanitizeTerminalFact(input, oomProvenance) {
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
  // New snapshots bind positive cgroup evidence to each OOM fact so multiple
  // generations survive independently. A v1 fact with no inline fields may
  // still use the exact matching positive global observation; sanitization
  // upgrades that legacy pair into the inline representation on its next save.
  const inlineOom = sanitizeInlineOom(input);
  const oomEvidence = inlineOom.present
    ? inlineOom.value
    : legacyOomForFact(oomProvenance, { projectId, generationId, resourceClass, unitName });
  if (reason === "oom_kill"
    && (oomEvidence === null
      || !exit.valid
      || !signal.valid
      || (exit.value !== null && signal.value !== null))) {
    normalizedReason = "unknown";
  }
  return Object.freeze({
    project_id: projectId,
    generation_id: generationId,
    resource_class: resourceClass,
    unit_name: unitName,
    reason: normalizedReason,
    exit_code: exit.value,
    signal: signal.value,
    finished_at: finishedAt,
    ...(normalizedReason === "oom_kill" ? oomEvidence : {}),
  });
}

function sanitizeTerminalFacts(input, limit, oomProvenance) {
  if (!safeArray(input)) return [];
  const rawLength = safeGet(input, "length");
  if (!Number.isSafeInteger(rawLength) || rawLength < 0) return [];
  const facts = [];
  const scanBudget = Math.min(rawLength, limit * TERMINAL_FACT_SCAN_FACTOR);
  const stop = rawLength - scanBudget;
  for (let index = rawLength - 1; index >= stop && facts.length < limit; index -= 1) {
    const fact = sanitizeTerminalFact(safeGet(input, index), oomProvenance);
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
  const projectId = safeGet(input, "project_id");
  const generationId = safeGet(input, "generation_id");
  const resourceClass = safeGet(input, "resource_class");
  const unitName = safeGet(input, "unit_name");
  const count = sanitizeOomKillCount(safeGet(input, "oom_kill_count"));
  const observedAt = sanitizeTime(safeGet(input, "observed_at"));
  if (typeof projectId !== "string" || !IDENTIFIER_RE.test(projectId)
    || typeof generationId !== "string" || !IDENTIFIER_RE.test(generationId)
    || typeof resourceClass !== "string" || !RESOURCE_CLASSES.has(resourceClass)
    || typeof unitName !== "string" || !UNIT_RE.test(unitName)
    || count === null || observedAt === null) {
    return null;
  }
  return Object.freeze({
    project_id: projectId,
    generation_id: generationId,
    resource_class: resourceClass,
    unit_name: unitName,
    oom_kill_count: count,
    observed_at: observedAt,
  });
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
  const state = {
    version: RESOURCE_STATE_VERSION,
    status: typeof rawStatus === "string" && STATUSES.has(rawStatus) ? rawStatus : "unknown",
    counts,
    limits,
    usage,
    temp,
    last_cgroup_oom: lastCgroupOom,
    terminal_facts: sanitizeTerminalFacts(safeGet(input, "terminal_facts"), limit, lastCgroupOom),
  };
  if (state.status === "ready" && !completeReadySnapshot(state)) state.status = "unknown";
  return freezeState(state);
}

function cloneSnapshot(state, terminalFactLimit) {
  return createResourceSnapshot(state, { terminalFactLimit });
}

class ResourceStatePersistenceError extends Error {
  constructor(code, message, recoveryEntries = []) {
    super(message);
    this.name = "ResourceStatePersistenceError";
    this.code = code;
    Object.defineProperty(this, "recoveryEntries", {
      configurable: false,
      enumerable: false,
      value: normalizeRecoveryEntries(recoveryEntries),
      writable: false,
    });
  }
}

function stateFailure(code, message, recoveryEntries = []) {
  throw new ResourceStatePersistenceError(code, message, recoveryEntries);
}

function isMissing(error) {
  return Boolean(error && error.code === "ENOENT");
}

function trustedRegular(stat, state) {
  return stat
    && !stat.isSymbolicLink()
    && stat.isFile()
    && hasSingleLink(stat)
    && modeOf(stat) === 0o600
    && (state.expectedUid === null || Number(stat.uid) === state.expectedUid);
}

function identityMatches(expected, observed) {
  return expected !== null
    && observed !== null
    && sameRegularNode(expected, observed)
    && Number(expected.size) === Number(observed.size);
}

function translateDirectoryFailure(error, recoveryEntries = []) {
  if (error instanceof ResourceStatePersistenceError) throw error;
  if (error instanceof SecureResourceDirectoryError) {
    if (error.code === "descriptor_anchor_unavailable" || error.code === "rename_unavailable") {
      stateFailure(
        "QW_RESOURCE_STATE_PERSISTENCE_UNAVAILABLE",
        "secure resource state persistence is unavailable",
        recoveryEntries,
      );
    }
    stateFailure(
      "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
      "resource state persistence requires explicit recovery",
      [...recoveryEntries, ...error.recoveryEntries],
    );
  }
  if (recoveryEntries.length > 0) {
    stateFailure(
      "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
      "resource state persistence requires explicit recovery",
      recoveryEntries,
    );
  }
  stateFailure(
    "QW_RESOURCE_STATE_PERSISTENCE_FAILED",
    "resource state persistence failed",
    recoveryEntries,
  );
}

function namedParentMatches(state) {
  const named = validateCanonicalDirectory(state.parent, {
    fsImpl: state.fs,
    expectedUid: state.expectedUid,
  });
  return sameOwnedNode(named, state.parentIdentity);
}

function openStoreDirectory(state, { requireRename = false } = {}) {
  if (typeof state.directoryHandleFactory !== "function") {
    stateFailure(
      "QW_RESOURCE_STATE_PERSISTENCE_UNAVAILABLE",
      "secure resource state persistence is unavailable",
    );
  }
  let handle;
  try {
    handle = state.directoryHandleFactory({
      directory: state.parent,
      directoryIdentity: state.parentIdentity,
      fsImpl: state.fs,
      execFileSyncImpl: state.execFileSyncImpl,
      platform: state.platform,
    });
    if (!handle
      || typeof handle.stat !== "function"
      || typeof handle.path !== "function"
      || typeof handle.fsync !== "function"
      || typeof handle.close !== "function"
      || (requireRename && (typeof handle.assertAvailable !== "function"
        || typeof handle.commit !== "function"))) {
      throw new SecureResourceDirectoryError(
        "descriptor_anchor_unavailable",
        "secure resource state directory handle is incomplete",
      );
    }
    const anchored = handle.stat();
    if (!anchored.isDirectory()
      || modeOf(anchored) !== 0o700
      || (state.expectedUid !== null && Number(anchored.uid) !== state.expectedUid)
      || !sameOwnedNode(anchored, state.parentIdentity)
      || !namedParentMatches(state)) {
      throw new SecureResourceDirectoryError(
        "descriptor_anchor_changed",
        "secure resource state parent changed",
      );
    }
    if (requireRename) handle.assertAvailable();
    return handle;
  } catch (error) {
    if (handle) {
      try { handle.close(); } catch {}
    }
    return translateDirectoryFailure(error);
  }
}

function pathStat(state, handle, name) {
  try {
    const stat = state.fs.lstatSync(handle.path(name));
    if (!trustedRegular(stat, state)) {
      stateFailure(
        "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
        "resource state entry is not a trusted private file",
        [name],
      );
    }
    return stat;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function openNamedLeaf(state, handle, { writable = false } = {}) {
  const before = pathStat(state, handle, state.basename);
  if (before === null) return null;
  const constants = state.fs.constants || fs.constants;
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    stateFailure(
      "QW_RESOURCE_STATE_PERSISTENCE_UNAVAILABLE",
      "secure resource state leaf flags are unavailable",
    );
  }
  let fd;
  try {
    fd = state.fs.openSync(
      handle.path(state.basename),
      (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW,
    );
    const opened = state.fs.fstatSync(fd);
    const named = pathStat(state, handle, state.basename);
    if (!trustedRegular(opened, state)
      || !identityMatches(before, opened)
      || !identityMatches(opened, named)) {
      stateFailure(
        "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
        "resource state identity changed while opening",
        [state.basename],
      );
    }
    return { fd, identity: opened };
  } catch (error) {
    if (fd !== undefined) {
      try { state.fs.closeSync(fd); } catch {}
    }
    throw error;
  }
}

function closeFd(state, fd) {
  if (fd === null || fd === undefined) return;
  try { state.fs.closeSync(fd); } catch {}
}

function expectedDestination(state, observed) {
  if (state.namedIdentity === UNTRUSTED_IDENTITY) {
    stateFailure(
      "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
      "resource state destination is untrusted",
      [state.basename],
    );
  }
  if (state.namedIdentity === UNOBSERVED_IDENTITY) return;
  if (state.namedIdentity === null && observed === null) return;
  if (state.namedIdentity !== null && observed !== null
    && identityMatches(state.namedIdentity, observed.identity)) return;
  stateFailure(
    "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
    "resource state destination changed",
    [state.basename],
  );
}

function acquireCandidate(state, handle, destination) {
  const name = state.recoveryName;
  const before = pathStat(state, handle, name);
  if (destination === null && before !== null) {
    stateFailure(
      "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
      "a previous resource state candidate requires explicit recovery",
      [name],
    );
  }
  const constants = state.fs.constants || fs.constants;
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    stateFailure(
      "QW_RESOURCE_STATE_PERSISTENCE_UNAVAILABLE",
      "secure resource state leaf flags are unavailable",
    );
  }
  let fd;
  try {
    if (before !== null) {
      fd = state.fs.openSync(handle.path(name), constants.O_RDWR | constants.O_NOFOLLOW);
      const opened = state.fs.fstatSync(fd);
      const named = pathStat(state, handle, name);
      if (!trustedRegular(opened, state)
        || !identityMatches(before, opened)
        || !identityMatches(opened, named)
        || (destination !== null && identityMatches(destination.identity, opened))) {
        stateFailure(
          "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
          "resource state recovery entry identity changed",
          [name],
        );
      }
      return { name, fd, identity: opened, reused: true };
    }
    fd = state.fs.openSync(
      handle.path(name),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    return { name, fd, identity: null, reused: false };
  } catch (error) {
    if (fd !== undefined) closeFd(state, fd);
    stateFailure(
      "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
      "resource state candidate requires explicit recovery",
      [name],
    );
  }
}

function writeCandidate(state, handle, candidate, serialized) {
  try {
    if (candidate.reused) state.fs.ftruncateSync(candidate.fd, 0);
    state.fs.writeFileSync(candidate.fd, serialized, { encoding: "utf8" });
    state.fs.fsyncSync(candidate.fd);
    const opened = state.fs.fstatSync(candidate.fd);
    const named = pathStat(state, handle, candidate.name);
    if (!trustedRegular(opened, state)
      || Number(opened.size) !== Buffer.byteLength(serialized, "utf8")
      || !identityMatches(opened, named)) {
      stateFailure(
        "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
        "resource state candidate identity changed",
        [candidate.name],
      );
    }
    candidate.identity = opened;
  } catch (error) {
    if (error instanceof ResourceStatePersistenceError) throw error;
    stateFailure(
      "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
      "resource state candidate requires explicit recovery",
      [candidate.name],
    );
  }
}

function verifyDestinationBeforeCommit(state, handle, expected) {
  const named = pathStat(state, handle, state.basename);
  if (expected === null && named === null) return;
  if (expected !== null && named !== null && identityMatches(expected, named)) return;
  stateFailure(
    "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
    "resource state destination changed before commit",
    [state.basename],
  );
}

class ResourceStateStore {
  constructor({
    filePath,
    fsImpl = fs,
    terminalFactLimit = DEFAULT_TERMINAL_FACT_LIMIT,
    expectedUid = typeof process.getuid === "function" ? process.getuid() : null,
    directoryHandleFactory,
    execFileSyncImpl = execFileSync,
    platform = process.platform,
  } = {}) {
    if (typeof filePath !== "string"
      || !path.isAbsolute(filePath)
      || path.normalize(filePath) !== filePath) {
      throw new TypeError("filePath must be a normalized absolute path");
    }
    if (!validTerminalFactLimit(terminalFactLimit)) {
      throw new TypeError(`terminalFactLimit must be an integer from 1 to ${MAX_TERMINAL_FACT_LIMIT}`);
    }
    if (expectedUid !== null && (!Number.isSafeInteger(expectedUid) || expectedUid < 0)) {
      throw new TypeError("expectedUid must be a non-negative safe integer or null");
    }
    const parent = path.dirname(filePath);
    const basename = validateEntryName(path.basename(filePath));
    let parentIdentity;
    try {
      parentIdentity = validateCanonicalDirectory(parent, { fsImpl, expectedUid });
    } catch {
      stateFailure(
        "QW_RESOURCE_STATE_PARENT_UNSAFE",
        "resource state parent must be a canonical owner-only directory",
      );
    }
    STORE_STATE.set(this, {
      basename,
      directoryHandleFactory: directoryHandleFactory
        || (platform === "linux" ? createLinuxSecureDirectoryHandle : null),
      execFileSyncImpl,
      expectedUid,
      fs: fsImpl,
      namedIdentity: UNOBSERVED_IDENTITY,
      parent,
      parentIdentity,
      platform,
      recoveryName: validateEntryName(`.${basename}.previous`),
      state: createResourceSnapshot({}, { terminalFactLimit }),
      terminalFactLimit,
    });
  }

  load() {
    const state = STORE_STATE.get(this);
    if (!state) throw new TypeError("ResourceStateStore receiver is invalid");
    let handle = null;
    let leaf = null;
    try {
      handle = openStoreDirectory(state);
      leaf = openNamedLeaf(state, handle);
      if (leaf === null) {
        state.namedIdentity = null;
        state.state = createResourceSnapshot({}, { terminalFactLimit: state.terminalFactLimit });
        return this.snapshot();
      }
      if (!Number.isSafeInteger(leaf.identity.size)
        || leaf.identity.size < 0
        || leaf.identity.size > MAX_STATE_BYTES) {
        throw new Error("state file size is unsupported");
      }
      const raw = state.fs.readFileSync(leaf.fd, "utf8");
      const after = state.fs.fstatSync(leaf.fd);
      const named = pathStat(state, handle, state.basename);
      if (!identityMatches(leaf.identity, after)
        || !identityMatches(after, named)
        || Buffer.byteLength(raw, "utf8") !== Number(after.size)
        || !namedParentMatches(state)) {
        throw new Error("state file identity changed");
      }
      state.namedIdentity = after;
      const parsed = JSON.parse(raw);
      if (safeGet(parsed, "version") !== RESOURCE_STATE_VERSION) {
        throw new Error("unsupported state version");
      }
      state.state = createResourceSnapshot(parsed, { terminalFactLimit: state.terminalFactLimit });
    } catch {
      // A failed reload never leaves an older pathname identity authoritative.
      // Even a same-inode/same-size malformed rewrite is not a trusted commit.
      state.namedIdentity = UNTRUSTED_IDENTITY;
      state.state = createResourceSnapshot({}, { terminalFactLimit: state.terminalFactLimit });
      return this.snapshot();
    } finally {
      if (leaf) closeFd(state, leaf.fd);
      if (handle) {
        try { handle.close(); } catch {}
      }
    }
    return this.snapshot();
  }

  save(input) {
    const state = STORE_STATE.get(this);
    if (!state) throw new TypeError("ResourceStateStore receiver is invalid");
    const next = createResourceSnapshot(input, { terminalFactLimit: state.terminalFactLimit });
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new RangeError("resource state exceeds the maximum serialized size");
    }
    let handle = null;
    let destination = null;
    let candidate = null;
    let commitAttempted = false;
    try {
      handle = openStoreDirectory(state, { requireRename: true });
      destination = openNamedLeaf(state, handle);
      expectedDestination(state, destination);
      candidate = acquireCandidate(state, handle, destination);
      writeCandidate(state, handle, candidate, serialized);
      verifyDestinationBeforeCommit(state, handle, destination && destination.identity);
      if (!namedParentMatches(state)) {
        stateFailure(
          "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
          "resource state parent changed before commit",
          [candidate.name],
        );
      }
      commitAttempted = true;
      handle.commit({
        mode: destination === null ? "noreplace" : "exchange",
        source: candidate.name,
        destination: state.basename,
        sourceIdentity: candidate.identity,
        destinationIdentity: destination && destination.identity,
        expectedUid: state.expectedUid === null
          ? Number(candidate.identity.uid)
          : state.expectedUid,
      });

      let installed = pathStat(state, handle, state.basename);
      if (!identityMatches(candidate.identity, installed)) {
        stateFailure(
          "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
          "installed resource state identity is uncertain",
          [state.basename, candidate.name],
        );
      }
      if (destination === null) {
        if (pathStat(state, handle, candidate.name) !== null) {
          stateFailure(
            "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
            "first resource state commit left an uncertain candidate",
            [state.basename, candidate.name],
          );
        }
      } else {
        const displaced = pathStat(state, handle, candidate.name);
        if (!identityMatches(destination.identity, displaced)) {
          stateFailure(
            "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
            "displaced resource state identity is uncertain",
            [state.basename, candidate.name],
          );
        }
      }
      handle.fsync();
      installed = pathStat(state, handle, state.basename);
      if (!identityMatches(candidate.identity, installed)
        || !namedParentMatches(state)
        || (destination !== null
          && !identityMatches(destination.identity, pathStat(state, handle, candidate.name)))) {
        stateFailure(
          "QW_RESOURCE_STATE_RECOVERY_REQUIRED",
          "resource state commit requires explicit recovery",
          [state.basename, candidate.name],
        );
      }
      state.state = next;
      state.namedIdentity = installed;
    } catch (error) {
      const recoveryEntries = candidate === null
        ? []
        : commitAttempted
          ? [state.basename, candidate.name]
          : [candidate.name];
      if (commitAttempted) state.namedIdentity = UNTRUSTED_IDENTITY;
      return translateDirectoryFailure(error, recoveryEntries);
    } finally {
      if (candidate) closeFd(state, candidate.fd);
      if (destination) closeFd(state, destination.fd);
      if (handle) {
        try { handle.close(); } catch {}
      }
    }
    return this.snapshot();
  }

  snapshot() {
    const state = STORE_STATE.get(this);
    if (!state) throw new TypeError("ResourceStateStore receiver is invalid");
    return cloneSnapshot(state.state, state.terminalFactLimit);
  }
}

module.exports = {
  RESOURCE_STATE_VERSION,
  DEFAULT_TERMINAL_FACT_LIMIT,
  MAX_TERMINAL_FACT_LIMIT,
  MAX_STATE_BYTES,
  ResourceStatePersistenceError,
  ResourceStateStore,
  createResourceSnapshot,
};
