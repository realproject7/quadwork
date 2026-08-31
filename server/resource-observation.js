"use strict";

const fs = require("fs");
const path = require("path");
const {
  WORKER_UNIT_PREFIX,
  CONTROL_UNIT_PREFIX,
  createWorkerUnitBase,
  createControlUnitBase,
  scopeUnitFromBase,
} = require("./resource-unit");
const {
  DEFAULT_CONTROL_CLASS_NAME,
  validateControlClassName,
} = require("./resource-controller");

const UINT64_MAX = (1n << 64n) - 1n;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_FILE_VALUE_BYTES = 64 * 1024;
const MAX_PROC_CGROUP_BYTES = 64 * 1024;

class ObservationFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function unavailable(resourceClass, unitBase, unitName, reason, qualifiers = {}) {
  return Object.freeze({
    available: false,
    status: "unavailable",
    reason,
    resource_class: resourceClass,
    unit_base: unitBase,
    unit_name: unitName,
    ...qualifiers,
  });
}

function boundedText(value, maximumBytes, failureCode) {
  let text;
  try {
    text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  } catch {
    throw new ObservationFailure(failureCode);
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes || text.includes("\0")) {
    throw new ObservationFailure(failureCode);
  }
  return text;
}

function parseUint64Text(raw) {
  const text = boundedText(raw, 64, "cgroup_data_invalid").trim();
  if (!/^(?:0|[1-9]\d{0,19})$/.test(text)) throw new ObservationFailure("cgroup_data_invalid");
  let value;
  try {
    value = BigInt(text);
  } catch {
    throw new ObservationFailure("cgroup_data_invalid");
  }
  if (value > UINT64_MAX) throw new ObservationFailure("cgroup_data_invalid");
  return value.toString(10);
}

function parseLimit(raw) {
  const text = boundedText(raw, 64, "cgroup_data_invalid").trim();
  if (text === "max") return Object.freeze({ kind: "infinite" });
  return Object.freeze({ kind: "finite", bytes: parseUint64Text(text) });
}

function parseMemoryEvents(raw) {
  const text = boundedText(raw, MAX_FILE_VALUE_BYTES, "cgroup_data_invalid");
  const counters = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const match = line.match(/^([a-z][a-z0-9_]*) (0|[1-9]\d{0,19})$/);
    if (!match || counters.has(match[1])) throw new ObservationFailure("cgroup_data_invalid");
    counters.set(match[1], parseUint64Text(match[2]));
  }
  if (!counters.has("oom_kill")) throw new ObservationFailure("cgroup_data_invalid");
  return counters.get("oom_kill");
}

function observedAt(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw new ObservationFailure("clock_unavailable");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ObservationFailure("clock_unavailable");
  return date.toISOString();
}

function freezeObservation(observation) {
  Object.freeze(observation.usage);
  Object.freeze(observation.limits);
  Object.freeze(observation.counters);
  return Object.freeze(observation);
}

function validateAggregateControlClassName(value) {
  const validated = validateControlClassName(value);
  if (!/^quadwork-control(?:-[a-z0-9]+)*\.slice$/.test(validated)) {
    throw new TypeError("controlClassName must be a QuadWork control slice");
  }
  return validated;
}

class ResourceObservationProvider {
  constructor({
    fsImpl = fs,
    execFileSyncImpl,
    clock = () => new Date(),
    cgroupRoot = "/sys/fs/cgroup",
    procSelfCgroupPath = "/proc/self/cgroup",
    controlClassName = DEFAULT_CONTROL_CLASS_NAME,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {}) {
    if (!fsImpl || typeof fsImpl.readFileSync !== "function") {
      throw new TypeError("fsImpl.readFileSync must be a function");
    }
    if (typeof execFileSyncImpl !== "function") {
      throw new TypeError("execFileSyncImpl must be dependency-injected");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof cgroupRoot !== "string" || !path.isAbsolute(cgroupRoot)) {
      throw new TypeError("cgroupRoot must be an absolute path");
    }
    if (typeof procSelfCgroupPath !== "string" || !path.isAbsolute(procSelfCgroupPath)) {
      throw new TypeError("procSelfCgroupPath must be an absolute path");
    }
    const resolvedRoot = path.resolve(cgroupRoot);
    if (path.parse(resolvedRoot).root === resolvedRoot) {
      throw new TypeError("cgroupRoot cannot be a filesystem root");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new TypeError("timeoutMs must be an integer from 1 to 60000");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 64 || maxOutputBytes > 1024 * 1024) {
      throw new TypeError("maxOutputBytes must be an integer from 64 to 1048576");
    }
    this.fs = fsImpl;
    this.execFileSync = execFileSyncImpl;
    this.clock = clock;
    this.cgroupRoot = resolvedRoot;
    this.procSelfCgroupPath = path.resolve(procSelfCgroupPath);
    this.controlClassName = validateAggregateControlClassName(controlClassName);
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  observeWorker(identity) {
    const unitBase = createWorkerUnitBase(identity);
    return this._observe("worker", unitBase, WORKER_UNIT_PREFIX);
  }

  observeControl(identity) {
    const unitBase = createControlUnitBase(identity);
    return this._observe("control", unitBase, CONTROL_UNIT_PREFIX);
  }

  observeApiSelf() {
    let resolved;
    try {
      resolved = this._resolveSelfControlGroup();
    } catch (error) {
      const reason = error instanceof ObservationFailure ? error.code : "observation_unavailable";
      return unavailable("api", null, null, reason, { self: true });
    }
    return this._observeCgroup("api", null, resolved.unitName, resolved.cgroupPath, { self: true });
  }

  observeControlAggregate() {
    return this._observeUnit("control", null, this.controlClassName, { aggregate: true });
  }

  _resolveCgroupPath(controlGroup, expectedUnitName = null) {
    if (!controlGroup.startsWith("/")
      || controlGroup === "/"
      || controlGroup.includes("\0")
      || controlGroup.includes("\r")
      || controlGroup.includes("\n")
      || controlGroup.endsWith("/")
      || path.posix.normalize(controlGroup) !== controlGroup) {
      throw new ObservationFailure("control_group_invalid");
    }
    const unitName = path.posix.basename(controlGroup);
    if ((expectedUnitName !== null && unitName !== expectedUnitName)
      || unitName === "."
      || unitName === ".."
      || unitName.length > 255
      || /[\u0000-\u001f\u007f]/.test(unitName)
      || !/\.(?:service|scope|slice)$/.test(unitName)) {
      throw new ObservationFailure("control_group_invalid");
    }
    const resolved = path.resolve(this.cgroupRoot, `.${controlGroup}`);
    if (!resolved.startsWith(`${this.cgroupRoot}${path.sep}`)) {
      throw new ObservationFailure("control_group_invalid");
    }
    return { cgroupPath: resolved, unitName };
  }

  _resolveSelfControlGroup() {
    let raw;
    try {
      raw = this.fs.readFileSync(this.procSelfCgroupPath, "utf8");
    } catch {
      throw new ObservationFailure("self_cgroup_unavailable");
    }
    const text = boundedText(raw, MAX_PROC_CGROUP_BYTES, "self_cgroup_invalid");
    const line = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (line.length === 0 || line.includes("\r") || line.includes("\n")) {
      throw new ObservationFailure("self_cgroup_invalid");
    }
    const match = line.match(/^0::(\/.+)$/);
    if (!match) throw new ObservationFailure("self_cgroup_invalid");
    try {
      return this._resolveCgroupPath(match[1]);
    } catch (error) {
      if (error instanceof ObservationFailure) {
        throw new ObservationFailure("self_cgroup_invalid");
      }
      throw error;
    }
  }

  _resolveControlGroup(unitName) {
    let output;
    try {
      output = this.execFileSync("systemctl", [
        "--user",
        "--property=ControlGroup",
        "--value",
        "show",
        unitName,
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.timeoutMs,
        maxBuffer: this.maxOutputBytes,
      });
    } catch {
      throw new ObservationFailure("unit_unavailable");
    }
    const text = boundedText(output, this.maxOutputBytes, "unit_unavailable");
    const controlGroup = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (controlGroup.length === 0 || controlGroup.includes("\r") || controlGroup.includes("\n")) {
      throw new ObservationFailure("control_group_invalid");
    }
    return this._resolveCgroupPath(controlGroup, unitName).cgroupPath;
  }

  _read(cgroupPath, name) {
    try {
      return boundedText(
        this.fs.readFileSync(path.join(cgroupPath, name), "utf8"),
        MAX_FILE_VALUE_BYTES,
        "cgroup_data_invalid",
      );
    } catch (error) {
      if (error instanceof ObservationFailure) throw error;
      throw new ObservationFailure("cgroup_unavailable");
    }
  }

  _readOomCounter(cgroupPath) {
    try {
      return {
        count: parseMemoryEvents(this._read(cgroupPath, "memory.events.local")),
        source: "local",
      };
    } catch (error) {
      if (!(error instanceof ObservationFailure) || error.code !== "cgroup_unavailable") throw error;
      return {
        count: parseMemoryEvents(this._read(cgroupPath, "memory.events")),
        source: "hierarchical",
      };
    }
  }

  _observe(resourceClass, unitBase, expectedPrefix) {
    const unitName = scopeUnitFromBase(unitBase);
    if (!unitBase.startsWith(expectedPrefix)) {
      return unavailable(resourceClass, unitBase, unitName, "unit_identity_invalid");
    }
    return this._observeUnit(resourceClass, unitBase, unitName);
  }

  _observeUnit(resourceClass, unitBase, unitName, qualifiers = {}) {
    let cgroupPath;
    try {
      cgroupPath = this._resolveControlGroup(unitName);
    } catch (error) {
      const reason = error instanceof ObservationFailure ? error.code : "observation_unavailable";
      return unavailable(resourceClass, unitBase, unitName, reason, qualifiers);
    }
    return this._observeCgroup(resourceClass, unitBase, unitName, cgroupPath, qualifiers);
  }

  _observeCgroup(resourceClass, unitBase, unitName, cgroupPath, qualifiers = {}) {
    try {
      const oom = this._readOomCounter(cgroupPath);
      return freezeObservation({
        available: true,
        status: "ready",
        reason: null,
        resource_class: resourceClass,
        unit_base: unitBase,
        unit_name: unitName,
        ...qualifiers,
        observed_at: observedAt(this.clock),
        usage: {
          memory_current_bytes: parseUint64Text(this._read(cgroupPath, "memory.current")),
          memory_peak_bytes: parseUint64Text(this._read(cgroupPath, "memory.peak")),
          memory_swap_current_bytes: parseUint64Text(this._read(cgroupPath, "memory.swap.current")),
        },
        limits: {
          memory_low: parseLimit(this._read(cgroupPath, "memory.low")),
          memory_high: parseLimit(this._read(cgroupPath, "memory.high")),
          memory_max: parseLimit(this._read(cgroupPath, "memory.max")),
          memory_swap_max: parseLimit(this._read(cgroupPath, "memory.swap.max")),
        },
        counters: {
          oom_kill: oom.count,
          source: oom.source,
        },
      });
    } catch (error) {
      const reason = error instanceof ObservationFailure ? error.code : "observation_unavailable";
      return unavailable(resourceClass, unitBase, unitName, reason, qualifiers);
    }
  }
}

module.exports = {
  UINT64_MAX,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  ResourceObservationProvider,
};
