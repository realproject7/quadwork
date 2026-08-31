"use strict";

// Explicit disposable-host staging machinery for #1038. Requiring this module
// performs no I/O, and the default staging CLI does not import or instantiate
// it. A caller must inject the host, PTY, filesystem, and authenticated monitor
// adapters and must repeat the coordinator's exact run/acknowledgement gate.

const crypto = require("crypto");
const path = require("path");
const {
  SYSTEMD_SCOPE_CANDIDATE,
  buildWorkerScopeInvocation,
} = require("./resource-controller");
const { ACK_PREFIX, StagingProofError } = require("./resource-staging-proof");

const LIVE_MARKER_PREFIX = "__QW_RESOURCE_STAGING_V1__";
const MACHINE_ID_RE = /^[a-f0-9]{32}$/;
const QUALIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATED_WORKER_UNIT_RE = /^quadwork-worker-[a-f0-9]{40}$/;
const EXPECTED_CANDIDATE_ARGS = Object.freeze(["--user", "--scope", "--collect", "--quiet"]);
const PHASE_IDS = new Set([
  "node_pty_controlling_tty",
  "resize_signal_exit_propagation",
  "descendant_cgroup_membership",
  "effective_temp_disk_boundary",
  "bounded_worker_oom_counter",
]);
const MONITOR_PROBE_NAMES = Object.freeze([
  "apiHealth",
  "primaryChatWebSocket",
  "unrelatedWorkerHealth",
  "apiOomCounter",
  "globalOomCounter",
]);
const TMPFS_MAGIC = 0x01021994n;
const RAMFS_MAGIC = 0x858458f6n;
const DEFAULT_PHASE_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const DEFAULT_OOM_POLL_MS = 10;

const TTY_SCRIPT = `
const fs = require("fs");
const prefix = ${JSON.stringify(LIVE_MARKER_PREFIX)};
const emit = (value) => fs.writeSync(1, prefix + JSON.stringify(value) + "\\n");
const raw = fs.readFileSync("/proc/self/stat", "utf8");
const fields = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\\s+/);
emit({event:"tty",stdin:process.stdin.isTTY===true,stdout:process.stdout.isTTY===true,stderr:process.stderr.isTTY===true,tty_nr:fields[4]});
`;

const RESIZE_SCRIPT = `
const fs = require("fs");
const prefix = ${JSON.stringify(LIVE_MARKER_PREFIX)};
const emit = (value) => fs.writeSync(1, prefix + JSON.stringify(value) + "\\n");
emit({event:"ready",cols:process.stdout.columns,rows:process.stdout.rows});
process.on("SIGWINCH", () => emit({event:"resized",cols:process.stdout.columns,rows:process.stdout.rows}));
process.on("SIGTERM", () => { emit({event:"signal",signal:"SIGTERM"}); process.exit(23); });
setInterval(() => {}, 1000);
`;

const DESCENDANT_SCRIPT = `
const fs = require("fs");
const { spawn } = require("child_process");
const prefix = ${JSON.stringify(LIVE_MARKER_PREFIX)};
const emit = (value) => fs.writeSync(1, prefix + JSON.stringify(value) + "\\n");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"});
child.once("spawn", () => emit({event:"descendants",parent_pid:process.pid,child_pid:child.pid}));
process.on("SIGTERM", () => { try { child.kill("SIGTERM"); } catch {} child.once("exit", () => process.exit(0)); setTimeout(() => process.exit(1), 1000); });
setInterval(() => {}, 1000);
`;

const OOM_SCRIPT = `
const fs = require("fs");
const prefix = ${JSON.stringify(LIVE_MARKER_PREFIX)};
const emit = (value) => fs.writeSync(1, prefix + JSON.stringify(value) + "\\n");
const allocations = [];
emit({event:"oom_ready"});
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => { setInterval(() => allocations.push(Buffer.alloc(8 * 1024 * 1024, 1)), 1); });
setInterval(() => {}, 1000);
`;

function proofError(code, check) {
  return new StagingProofError(code, check);
}

function safeGet(value, key) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return value[key]; } catch { return undefined; }
}

function qualifier(value, field) {
  if (typeof value !== "string" || !QUALIFIER_RE.test(value)) {
    throw new TypeError(`${field} must be a path-free identifier of at most 128 characters`);
  }
  return value;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} is outside its supported integer range`);
  }
  return value;
}

function boundedString(value, field, maximumBytes = 16 * 1024) {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new TypeError(`${field} must be a bounded NUL-free string`);
  }
  return value;
}

function commandSpec(value, field) {
  const file = boundedString(safeGet(value, "file"), `${field}.file`, 4096);
  if (!path.isAbsolute(file)) throw new TypeError(`${field}.file must be absolute`);
  const rawArgs = safeGet(value, "args");
  const rawLength = safeGet(rawArgs, "length");
  if (!Array.isArray(rawArgs) || !Number.isSafeInteger(rawLength) || rawLength < 0 || rawLength > 128) {
    throw new TypeError(`${field}.args must be a bounded array`);
  }
  const args = [];
  for (let index = 0; index < rawLength; index += 1) {
    args.push(boundedString(safeGet(rawArgs, index), `${field}.args[${index}]`));
  }
  return Object.freeze({ file, args: Object.freeze(args) });
}

function normalizeEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("spawnEnv must be an explicitly supplied object");
  }
  const output = Object.create(null);
  let totalBytes = 0;
  let keys;
  try { keys = Object.keys(value); } catch { throw new TypeError("spawnEnv is unreadable"); }
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
      || ["TMPDIR", "__proto__", "constructor", "prototype"].includes(key)) {
      throw new TypeError("spawnEnv contains an unsupported key");
    }
    if (/^(?:NODE_OPTIONS|NODE_PATH|NODE_CHANNEL_FD|NODE_UNIQUE_ID|NODE_V8_COVERAGE|LD_.+|DYLD_.+)$/.test(key)) {
      throw new TypeError("spawnEnv may not alter the staging probe runtime");
    }
    const item = boundedString(safeGet(value, key), `spawnEnv.${key}`);
    totalBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(item, "utf8");
    if (totalBytes > 64 * 1024) throw new TypeError("spawnEnv exceeds its size bound");
    output[key] = item;
  }
  if (typeof output.PATH !== "string" || output.PATH.length === 0) {
    throw new TypeError("spawnEnv.PATH is required");
  }
  return Object.freeze(output);
}

function normalizeTarget(value) {
  if (!value || typeof value !== "object") throw new TypeError("target is required");
  const projectId = qualifier(safeGet(value, "projectId"), "target.projectId");
  const generationId = qualifier(safeGet(value, "generationId"), "target.generationId");
  const nodeExecutable = boundedString(safeGet(value, "nodeExecutable"), "target.nodeExecutable", 4096);
  const cwd = boundedString(safeGet(value, "cwd"), "target.cwd", 4096);
  const generationTempRoot = boundedString(
    safeGet(value, "generationTempRoot"),
    "target.generationTempRoot",
    4096,
  );
  if (!path.isAbsolute(nodeExecutable) || !path.isAbsolute(cwd) || !path.isAbsolute(generationTempRoot)) {
    throw new TypeError("target executable, cwd, and generation temp root must be absolute");
  }
  const limits = safeGet(value, "workerLimits");
  if (!limits || typeof limits !== "object") throw new TypeError("target.workerLimits is required");
  const workerLimits = Object.freeze({
    memoryHighMib: boundedInteger(safeGet(limits, "memoryHighMib"), "memoryHighMib", 1, 1024 * 1024),
    memoryMaxMib: boundedInteger(safeGet(limits, "memoryMaxMib"), "memoryMaxMib", 1, 1024 * 1024),
    swapMaxMib: boundedInteger(safeGet(limits, "swapMaxMib"), "swapMaxMib", 1, 1024 * 1024),
  });
  if (workerLimits.memoryHighMib > workerLimits.memoryMaxMib) {
    throw new TypeError("worker memory high exceeds max");
  }
  // tempProbe is deliberately target-specific: it must invoke the actual
  // provider/client under test and emit one bounded marker shaped as
  // {event:"effective_temp",path:"<its effective temp directory>"}. A generic
  // Node echo would not prove that Claude/Gemini preserves the boundary.
  const rawTempProbe = safeGet(value, "tempProbe");
  return Object.freeze({
    projectId,
    generationId,
    nodeExecutable,
    cwd,
    generationTempRoot,
    workerLimits,
    spawnEnv: normalizeEnvironment(safeGet(value, "spawnEnv")),
    tempProbe: rawTempProbe === undefined ? null : commandSpec(rawTempProbe, "target.tempProbe"),
  });
}

function createGeneratedWorkerUnitBase(projectId, generationId) {
  const project = qualifier(projectId, "projectId");
  const generation = qualifier(generationId, "generationId");
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify(["worker", project, generation]), "utf8")
    .digest("hex")
    .slice(0, 40);
  return `quadwork-worker-${digest}`;
}

function phaseIdentity(target, phaseId) {
  const generationId = `staging-${crypto.createHash("sha256")
    .update(JSON.stringify(["staging-phase", target.generationId, phaseId]), "utf8")
    .digest("hex")
    .slice(0, 40)}`;
  const unitBase = createGeneratedWorkerUnitBase(target.projectId, generationId);
  if (!GENERATED_WORKER_UNIT_RE.test(unitBase)) throw proofError("proof_unavailable", "unit_identity_invalid");
  return Object.freeze({ projectId: target.projectId, generationId, unitBase, unitName: `${unitBase}.scope` });
}

function candidateMatches(candidate) {
  try {
    const args = safeGet(candidate, "fixed_args");
    return safeGet(candidate, "status") === "candidate_pending_staging"
      && safeGet(candidate, "executable") === "systemd-run"
      && Array.isArray(args)
      && args.length === EXPECTED_CANDIDATE_ARGS.length
      && args.every((arg, index) => arg === EXPECTED_CANDIDATE_ARGS[index])
      && SYSTEMD_SCOPE_CANDIDATE.status === "candidate_pending_staging"
      && SYSTEMD_SCOPE_CANDIDATE.executable === "systemd-run"
      && SYSTEMD_SCOPE_CANDIDATE.fixedArgs.length === EXPECTED_CANDIDATE_ARGS.length
      && SYSTEMD_SCOPE_CANDIDATE.fixedArgs.every((arg, index) => arg === EXPECTED_CANDIDATE_ARGS[index]);
  } catch {
    return false;
  }
}

function normalizeGateFacts(value) {
  const machineId = safeGet(value, "machineId");
  return Object.freeze({
    linux: safeGet(value, "linux") === true,
    cgroupV2: safeGet(value, "cgroupV2") === true,
    userManager: safeGet(value, "userManager") === true,
    machineId: typeof machineId === "string" && MACHINE_ID_RE.test(machineId) ? machineId : null,
  });
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedText(value, maximumBytes, check) {
  let text;
  try { text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value); } catch {
    throw proofError("proof_unavailable", check);
  }
  if (text.includes("\0") || Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw proofError("proof_unavailable", check);
  }
  return text;
}

async function callBounded(operation, timeoutMs, check) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(proofError("proof_unavailable", check));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(Object.freeze({ signal: controller.signal }))),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof StagingProofError) throw error;
    throw proofError("proof_unavailable", check);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

class PtySession {
  constructor(term, maximumBytes) {
    const onData = safeGet(term, "onData");
    const onExit = safeGet(term, "onExit");
    const kill = safeGet(term, "kill");
    if (typeof onData !== "function" || typeof onExit !== "function" || typeof kill !== "function") {
      throw proofError("proof_unavailable", "pty_contract_unavailable");
    }
    this.term = term;
    this.killFunction = kill;
    this.maximumBytes = maximumBytes;
    this.bytes = 0;
    this.pending = "";
    this.markers = [];
    this.waiters = [];
    this.exited = false;
    this.exitValue = null;
    this.failure = null;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.dataDisposable = null;
    this.exitDisposable = null;
    try {
      this.dataDisposable = onData.call(term, (data) => this._data(data));
      this.exitDisposable = onExit.call(term, (event) => this._exit(event));
      if (typeof safeGet(this.dataDisposable, "dispose") !== "function"
        || typeof safeGet(this.exitDisposable, "dispose") !== "function") {
        throw new Error("PTY listeners are not disposable");
      }
    } catch {
      for (const disposable of [this.dataDisposable, this.exitDisposable]) {
        try {
          const dispose = safeGet(disposable, "dispose");
          if (typeof dispose === "function") dispose.call(disposable);
        } catch {}
      }
      try { kill.call(term, "SIGKILL"); } catch {}
      throw proofError("proof_unavailable", "pty_contract_unavailable");
    }
  }

  _data(value) {
    if (this.failure) return;
    let text;
    try { text = String(value); } catch {
      this.abort(proofError("proof_unavailable", "pty_output_invalid"));
      return;
    }
    this.bytes += Buffer.byteLength(text, "utf8");
    if (this.bytes > this.maximumBytes || text.includes("\0")) {
      this.abort(proofError("proof_unavailable", "pty_output_invalid"));
      return;
    }
    this.pending += text;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop();
    for (const line of lines) {
      const markerIndex = line.indexOf(LIVE_MARKER_PREFIX);
      if (markerIndex < 0) continue;
      try {
        const marker = JSON.parse(line.slice(markerIndex + LIVE_MARKER_PREFIX.length));
        if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw new Error("invalid");
        this.markers.push(marker);
      } catch {
        this.abort(proofError("proof_unavailable", "pty_marker_invalid"));
        return;
      }
    }
    this._drain();
  }

  _exit(event) {
    if (this.exited) return;
    this.exited = true;
    const exitCode = safeCount(safeGet(event, "exitCode"));
    const signal = safeCount(safeGet(event, "signal"));
    this.exitValue = Object.freeze({ exitCode, signal });
    this.resolveExit(this.exitValue);
    this._drain();
  }

  _drain() {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      const marker = this.markers.find(waiter.predicate);
      if (marker) {
        this.waiters.splice(index, 1);
        waiter.resolve(marker);
      } else if (this.failure) {
        this.waiters.splice(index, 1);
        waiter.reject(this.failure);
      } else if (this.exited) {
        this.waiters.splice(index, 1);
        waiter.reject(proofError("proof_unavailable", "pty_marker_missing"));
      }
    }
  }

  marker(eventName) {
    if (this.failure) return Promise.reject(this.failure);
    const predicate = (marker) => safeGet(marker, "event") === eventName;
    const existing = this.markers.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.exited) return Promise.reject(proofError("proof_unavailable", "pty_marker_missing"));
    return new Promise((resolve, reject) => this.waiters.push({ predicate, resolve, reject }));
  }

  exit() {
    return this.exitPromise;
  }

  resize(cols, rows) {
    const resize = safeGet(this.term, "resize");
    if (typeof resize !== "function") throw proofError("proof_unavailable", "pty_resize_unavailable");
    try { resize.call(this.term, cols, rows); } catch { throw proofError("proof_unavailable", "pty_resize_unavailable"); }
  }

  write(value) {
    const write = safeGet(this.term, "write");
    if (typeof write !== "function") throw proofError("proof_unavailable", "pty_write_unavailable");
    try { write.call(this.term, value); } catch { throw proofError("proof_unavailable", "pty_write_unavailable"); }
  }

  kill(signal) {
    try { this.killFunction.call(this.term, signal); } catch { throw proofError("proof_unavailable", "pty_kill_unavailable"); }
  }

  abort(error) {
    if (this.failure) return;
    this.failure = error;
    this._drain();
  }

  async cleanup(timeoutMs) {
    let clean = true;
    if (!this.exited) {
      try { this.killFunction.call(this.term, "SIGKILL"); } catch { clean = false; }
      if (clean) {
        let timer;
        const completed = await Promise.race([
          this.exitPromise.then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
        clearTimeout(timer);
        clean = completed;
      }
    }
    for (const disposable of [this.dataDisposable, this.exitDisposable]) {
      try {
        const dispose = safeGet(disposable, "dispose");
        if (typeof dispose === "function") dispose.call(disposable);
        else clean = false;
      } catch { clean = false; }
    }
    this.abort(proofError("proof_unavailable", "pty_session_closed"));
    return clean;
  }
}

function parseCgroupPath(raw, cgroupRoot, unitName, maximumBytes) {
  const text = boundedText(raw, maximumBytes, "control_group_invalid");
  if (!text.endsWith("\n") && text.includes("\n")) throw proofError("proof_unavailable", "control_group_invalid");
  const controlGroup = text.trim();
  if (!controlGroup.startsWith("/") || controlGroup === "/"
    || controlGroup.includes("\r") || controlGroup.includes("\n")
    || path.posix.normalize(controlGroup) !== controlGroup
    || path.posix.basename(controlGroup) !== unitName) {
    throw proofError("proof_unavailable", "control_group_invalid");
  }
  const resolved = path.resolve(cgroupRoot, `.${controlGroup}`);
  if (!resolved.startsWith(`${cgroupRoot}${path.sep}`)) throw proofError("proof_unavailable", "control_group_invalid");
  return resolved;
}

function parseCgroupProcs(raw, maximumBytes) {
  const text = boundedText(raw, maximumBytes, "cgroup_data_invalid");
  const result = new Set();
  for (const line of text.trim().split(/\r?\n/)) {
    if (!/^[1-9]\d*$/.test(line)) throw proofError("proof_unavailable", "cgroup_data_invalid");
    const value = Number(line);
    if (!Number.isSafeInteger(value)) throw proofError("proof_unavailable", "cgroup_data_invalid");
    result.add(value);
  }
  return result;
}

function parseOomCounter(raw, maximumBytes) {
  const text = boundedText(raw, maximumBytes, "cgroup_data_invalid");
  const counters = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const match = line.match(/^([a-z][a-z0-9_]*) (0|[1-9]\d{0,19})$/);
    if (!match || counters.has(match[1])) throw proofError("proof_unavailable", "cgroup_data_invalid");
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count < 0) throw proofError("proof_unavailable", "cgroup_data_invalid");
    counters.set(match[1], count);
  }
  if (!counters.has("oom_kill")) throw proofError("proof_unavailable", "cgroup_data_invalid");
  return counters.get("oom_kill");
}

function filesystemType(statfs) {
  const raw = safeGet(statfs, "type");
  try {
    if (typeof raw === "bigint") return BigInt.asUintN(32, raw);
    if (Number.isSafeInteger(raw)) return BigInt.asUintN(32, BigInt(raw));
  } catch {}
  throw proofError("proof_unavailable", "temp_filesystem_invalid");
}

class LiveStagingAdapter {
  constructor(options) {
    this.runPressure = safeGet(options, "runPressure") === true;
    this.acknowledgement = safeGet(options, "acknowledgement");
    this.gateProbe = safeGet(options, "gateProbe");
    this.monitorProbes = safeGet(options, "monitorProbes");
    this.ptySpawn = safeGet(options, "ptySpawn");
    this.execFileSync = safeGet(options, "execFileSyncImpl");
    this.fs = safeGet(options, "fsImpl");
    this.target = normalizeTarget(safeGet(options, "target"));
    this.phaseTimeoutMs = boundedInteger(
      safeGet(options, "phaseTimeoutMs") ?? DEFAULT_PHASE_TIMEOUT_MS,
      "phaseTimeoutMs",
      10,
      120_000,
    );
    this.probeTimeoutMs = boundedInteger(
      safeGet(options, "probeTimeoutMs") ?? DEFAULT_PROBE_TIMEOUT_MS,
      "probeTimeoutMs",
      10,
      60_000,
    );
    this.cleanupTimeoutMs = boundedInteger(
      safeGet(options, "cleanupTimeoutMs") ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      "cleanupTimeoutMs",
      10,
      10_000,
    );
    this.oomPollMs = boundedInteger(
      safeGet(options, "oomPollMs") ?? DEFAULT_OOM_POLL_MS,
      "oomPollMs",
      1,
      1_000,
    );
    this.maximumOutputBytes = boundedInteger(
      safeGet(options, "maximumOutputBytes") ?? DEFAULT_OUTPUT_BYTES,
      "maximumOutputBytes",
      1024,
      1024 * 1024,
    );
    const cgroupRoot = safeGet(options, "cgroupRoot") ?? "/sys/fs/cgroup";
    if (typeof cgroupRoot !== "string" || !path.isAbsolute(cgroupRoot)) {
      throw new TypeError("cgroupRoot must be absolute");
    }
    this.cgroupRoot = path.resolve(cgroupRoot);
    if (path.parse(this.cgroupRoot).root === this.cgroupRoot) throw new TypeError("cgroupRoot cannot be root");
    this.gates = null;
  }

  async inspectGates() {
    if (typeof this.gateProbe !== "function") throw proofError("proof_unavailable", "live_gate_probe_required");
    let raw;
    try {
      raw = await callBounded(
        ({ signal }) => this.gateProbe(Object.freeze({ signal })),
        this.probeTimeoutMs,
        "live_gate_probe_unavailable",
      );
    } catch {
      throw proofError("proof_unavailable", "live_gate_probe_unavailable");
    }
    this.gates = normalizeGateFacts(raw);
    return this.gates;
  }

  _authorize(context) {
    const gates = this.gates;
    if (!this.runPressure || !gates || !gates.machineId
      || !gates.linux || !gates.cgroupV2 || !gates.userManager
      || this.acknowledgement !== `${ACK_PREFIX}${gates.machineId}`) {
      throw proofError("proof_refused", "disposable_gate_required");
    }
    if (!candidateMatches(safeGet(context, "candidate"))) {
      throw proofError("proof_unavailable", "candidate_contract_mismatch");
    }
  }

  async startContinuousMonitoring(context) {
    this._authorize(context);
    // Health probes are target-owned continuous observers. At each checkpoint
    // they return {authenticated:true,healthy:boolean,continuous:boolean}, where
    // continuous covers the interval since their previous sample. OOM probes
    // return {authenticated:true,count:<non-negative safe integer>}. The live
    // adapter never guesses credentials or interprets raw HTTP/WebSocket data.
    const probes = this.monitorProbes;
    const probeFunctions = probes && MONITOR_PROBE_NAMES.map((name) => safeGet(probes, name));
    if (!probeFunctions || probeFunctions.some((probe) => typeof probe !== "function")) {
      throw proofError("proof_unavailable", "authenticated_monitor_probes_required");
    }
    let stopped = false;
    const samples = [];
    const checkpoint = async (label) => {
      if (stopped) throw proofError("proof_unavailable", "monitor_stopped");
      const results = await Promise.all(MONITOR_PROBE_NAMES.map((name, index) => callBounded(
        ({ signal }) => probeFunctions[index](Object.freeze({ signal, label })),
        this.probeTimeoutMs,
        `monitor_${name}_unavailable`,
      )));
      const health = results.slice(0, 3).map((result) => {
        const authenticated = safeGet(result, "authenticated");
        const healthy = safeGet(result, "healthy");
        const continuous = safeGet(result, "continuous");
        if (authenticated !== true || typeof healthy !== "boolean" || typeof continuous !== "boolean") {
          throw proofError("proof_unavailable", "authenticated_monitor_result_invalid");
        }
        return healthy && continuous;
      });
      const counters = results.slice(3).map((result) => {
        const count = safeCount(safeGet(result, "count"));
        if (safeGet(result, "authenticated") !== true || count === null) {
          throw proofError("proof_unavailable", "authenticated_monitor_result_invalid");
        }
        return count;
      });
      samples.push(Object.freeze({ health: Object.freeze(health), counters: Object.freeze(counters) }));
      return Object.freeze({ healthy: health.every(Boolean) });
    };
    const stop = async () => {
      if (stopped) throw proofError("proof_unavailable", "monitor_already_stopped");
      stopped = true;
      const first = samples[0] || { counters: [null, null] };
      const last = samples[samples.length - 1] || first;
      return Object.freeze({
        sample_count: samples.length,
        api_continuously_healthy: samples.length > 0 && samples.every((sample) => sample.health[0]),
        primary_chat_websocket_continuously_healthy: samples.length > 0 && samples.every((sample) => sample.health[1]),
        unrelated_worker_continuously_healthy: samples.length > 0 && samples.every((sample) => sample.health[2]),
        api_oom_counter_before: first.counters[0],
        api_oom_counter_after: last.counters[0],
        global_oom_counter_before: first.counters[1],
        global_oom_counter_after: last.counters[1],
      });
    };
    return Object.freeze({ checkpoint, stop });
  }

  _requirePhaseDependencies() {
    if (typeof this.ptySpawn !== "function" || typeof this.execFileSync !== "function"
      || typeof safeGet(this.fs, "readFileSync") !== "function") {
      throw proofError("proof_unavailable", "live_phase_dependencies_required");
    }
  }

  _invocation(phaseId, command, envExtra = {}) {
    const identity = phaseIdentity(this.target, phaseId);
    const invocation = buildWorkerScopeInvocation({
      projectId: identity.projectId,
      generationId: identity.generationId,
      unitName: identity.unitBase,
      command: command.file,
      args: command.args,
      limits: this.target.workerLimits,
    });
    if (invocation.candidateStatus !== "candidate_pending_staging"
      || invocation.file !== "systemd-run") {
      throw proofError("proof_unavailable", "candidate_contract_mismatch");
    }
    return Object.freeze({
      identity,
      invocation,
      env: Object.freeze({ ...this.target.spawnEnv, ...envExtra }),
    });
  }

  async _withPty(phaseId, command, handler, envExtra = {}) {
    const built = this._invocation(phaseId, command, envExtra);
    let term;
    try {
      term = this.ptySpawn(built.invocation.file, [...built.invocation.args], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: this.target.cwd,
        env: { ...built.env },
      });
    } catch {
      const clean = await this._cleanupScope(built.identity.unitName);
      if (!clean) throw proofError("proof_unavailable", `${phaseId}_cleanup_failed`);
      throw proofError("proof_unavailable", "pty_spawn_unavailable");
    }
    let session;
    try {
      session = new PtySession(term, this.maximumOutputBytes);
    } catch (error) {
      const scopeClean = await this._cleanupScope(built.identity.unitName);
      if (!scopeClean) throw proofError("proof_unavailable", `${phaseId}_cleanup_failed`);
      throw error;
    }
    let timer;
    let outcome;
    let failure = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = proofError("proof_unavailable", `${phaseId}_timeout`);
        session.abort(error);
        reject(error);
      }, this.phaseTimeoutMs);
    });
    try {
      outcome = await Promise.race([handler(session, built.identity), timeout]);
    } catch (error) {
      failure = error instanceof StagingProofError ? error : proofError("proof_unavailable", `${phaseId}_unavailable`);
    } finally {
      clearTimeout(timer);
    }
    const ptyClean = await session.cleanup(this.cleanupTimeoutMs);
    const scopeClean = await this._cleanupScope(built.identity.unitName);
    if (!ptyClean || !scopeClean) throw proofError("proof_unavailable", `${phaseId}_cleanup_failed`);
    if (failure) throw failure;
    return outcome;
  }

  _resolveCgroup(unitName) {
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
        timeout: this.probeTimeoutMs,
        maxBuffer: this.maximumOutputBytes,
      });
    } catch {
      throw proofError("proof_unavailable", "unit_unavailable");
    }
    return parseCgroupPath(output, this.cgroupRoot, unitName, this.maximumOutputBytes);
  }

  async _cleanupScope(unitName) {
    try {
      this.execFileSync("systemctl", ["--user", "stop", unitName], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.cleanupTimeoutMs,
        maxBuffer: this.maximumOutputBytes,
      });
      return true;
    } catch {}
    try {
      const output = this.execFileSync("systemctl", [
        "--user",
        "--property=LoadState",
        "--property=ActiveState",
        "--value",
        "show",
        unitName,
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.cleanupTimeoutMs,
        maxBuffer: this.maximumOutputBytes,
      });
      const states = boundedText(output, this.maximumOutputBytes, "scope_cleanup_unavailable")
        .trim()
        .split(/\r?\n/);
      return states.includes("not-found") && states.includes("inactive");
    } catch {
      return false;
    }
  }

  _readCgroup(cgroupPath, name) {
    try {
      return boundedText(
        this.fs.readFileSync(path.join(cgroupPath, name), "utf8"),
        this.maximumOutputBytes,
        "cgroup_data_invalid",
      );
    } catch (error) {
      if (error instanceof StagingProofError) throw error;
      throw proofError("proof_unavailable", "cgroup_unavailable");
    }
  }

  _readOom(cgroupPath) {
    try {
      return parseOomCounter(this._readCgroup(cgroupPath, "memory.events.local"), this.maximumOutputBytes);
    } catch (error) {
      if (!(error instanceof StagingProofError) || error.check !== "cgroup_unavailable") throw error;
      return parseOomCounter(this._readCgroup(cgroupPath, "memory.events"), this.maximumOutputBytes);
    }
  }

  async _pollOomIncrease(cgroupPath, before, session) {
    const deadline = Date.now() + this.phaseTimeoutMs;
    while (Date.now() < deadline) {
      if (session.failure) throw session.failure;
      const after = this._readOom(cgroupPath);
      if (after > before) return after;
      if (session.exited) throw proofError("proof_unavailable", "oom_counter_not_observed_before_collect");
      await new Promise((resolve) => setTimeout(resolve, this.oomPollMs));
    }
    throw proofError("proof_unavailable", "oom_counter_not_observed_before_collect");
  }

  async runPhase(phaseId, context) {
    this._authorize(context);
    if (!PHASE_IDS.has(phaseId)) throw proofError("proof_unavailable", "unknown_live_phase");
    this._requirePhaseDependencies();
    if (phaseId === "node_pty_controlling_tty") return this._ttyPhase(phaseId);
    if (phaseId === "resize_signal_exit_propagation") return this._resizePhase(phaseId);
    if (phaseId === "descendant_cgroup_membership") return this._descendantPhase(phaseId);
    if (phaseId === "effective_temp_disk_boundary") return this._tempPhase(phaseId);
    return this._oomPhase(phaseId);
  }

  _ttyPhase(phaseId) {
    return this._withPty(phaseId, { file: this.target.nodeExecutable, args: ["-e", TTY_SCRIPT] }, async (session) => {
      const marker = await session.marker("tty");
      const exit = await session.exit();
      const passed = safeGet(marker, "stdin") === true
        && safeGet(marker, "stdout") === true
        && safeGet(marker, "stderr") === true
        && /^-?[1-9]\d*$/.test(safeGet(marker, "tty_nr"))
        && exit.exitCode === 0
        && (exit.signal === 0 || exit.signal === null);
      return Object.freeze({ status: passed ? "passed" : "failed", controlling_tty: passed });
    });
  }

  _resizePhase(phaseId) {
    return this._withPty(phaseId, { file: this.target.nodeExecutable, args: ["-e", RESIZE_SCRIPT] }, async (session) => {
      await session.marker("ready");
      session.resize(97, 31);
      const resized = await session.marker("resized");
      session.kill("SIGTERM");
      const signaled = await session.marker("signal");
      const exit = await session.exit();
      const resizePropagated = safeGet(resized, "cols") === 97 && safeGet(resized, "rows") === 31;
      const signalPropagated = safeGet(signaled, "signal") === "SIGTERM";
      const exitPropagated = exit.exitCode === 23;
      return Object.freeze({
        status: resizePropagated && signalPropagated && exitPropagated ? "passed" : "failed",
        resize_propagated: resizePropagated,
        signal_propagated: signalPropagated,
        exit_propagated: exitPropagated,
      });
    });
  }

  _descendantPhase(phaseId) {
    return this._withPty(phaseId, { file: this.target.nodeExecutable, args: ["-e", DESCENDANT_SCRIPT] }, async (session, identity) => {
      const marker = await session.marker("descendants");
      const parentPid = safeCount(safeGet(marker, "parent_pid"));
      const childPid = safeCount(safeGet(marker, "child_pid"));
      if (!parentPid || !childPid) throw proofError("proof_unavailable", "descendant_marker_invalid");
      const cgroupPath = this._resolveCgroup(identity.unitName);
      const processes = parseCgroupProcs(this._readCgroup(cgroupPath, "cgroup.procs"), this.maximumOutputBytes);
      const contained = processes.has(parentPid) && processes.has(childPid);
      session.kill("SIGTERM");
      await session.exit();
      return Object.freeze({
        status: contained ? "passed" : "failed",
        all_descendants_in_worker_cgroup: contained,
        descendant_count: contained ? 2 : 0,
      });
    });
  }

  _tempPhase(phaseId) {
    if (!this.target.tempProbe || typeof safeGet(this.fs, "realpathSync") !== "function"
      || typeof safeGet(this.fs, "statfsSync") !== "function") {
      throw proofError("proof_unavailable", "target_effective_temp_probe_required");
    }
    return this._withPty(phaseId, this.target.tempProbe, async (session) => {
      const marker = await session.marker("effective_temp");
      const effective = safeGet(marker, "path");
      if (typeof effective !== "string" || !path.isAbsolute(effective)
        || effective.includes("\0") || Buffer.byteLength(effective, "utf8") > 4096) {
        throw proofError("proof_unavailable", "effective_temp_result_invalid");
      }
      let expectedReal;
      let effectiveReal;
      let statfs;
      try {
        expectedReal = this.fs.realpathSync(this.target.generationTempRoot);
        effectiveReal = this.fs.realpathSync(effective);
        if (typeof expectedReal !== "string" || !path.isAbsolute(expectedReal)
          || typeof effectiveReal !== "string" || !path.isAbsolute(effectiveReal)) {
          throw new Error("canonical temp path is invalid");
        }
        statfs = this.fs.statfsSync(effectiveReal, { bigint: true });
      } catch {
        throw proofError("proof_unavailable", "effective_temp_unavailable");
      }
      const type = filesystemType(statfs);
      const within = expectedReal === effectiveReal;
      const diskBacked = type !== TMPFS_MAGIC && type !== RAMFS_MAGIC;
      const exit = await session.exit();
      const exited = exit.exitCode === 0 && (exit.signal === 0 || exit.signal === null);
      return Object.freeze({
        status: within && diskBacked && exited ? "passed" : "failed",
        effective_temp_disk_backed: diskBacked,
        effective_temp_within_generation_root: within,
      });
    }, { TMPDIR: this.target.generationTempRoot });
  }

  _oomPhase(phaseId) {
    return this._withPty(phaseId, { file: this.target.nodeExecutable, args: ["-e", OOM_SCRIPT] }, async (session, identity) => {
      await session.marker("oom_ready");
      const cgroupPath = this._resolveCgroup(identity.unitName);
      const before = this._readOom(cgroupPath);
      session.write("go\n");
      const after = await this._pollOomIncrease(cgroupPath, before, session);
      const exit = await session.exit();
      const bounded = after > before && (exit.exitCode !== 0 || (exit.signal !== 0 && exit.signal !== null));
      return Object.freeze({
        status: bounded ? "passed" : "failed",
        worker_scope_bounded: bounded,
        worker_oom_counter_before: before,
        worker_oom_counter_after: after,
      });
    });
  }
}

function createLiveStagingAdapter(options = {}) {
  return new LiveStagingAdapter(options);
}

module.exports = {
  LIVE_MARKER_PREFIX,
  createGeneratedWorkerUnitBase,
  createLiveStagingAdapter,
};
