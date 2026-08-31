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
const TEMP_PROOF_CONTRACT = "quadwork-effective-temp-proof-v1";
const MONITOR_PROOF_DOMAIN = "quadwork-monitor-proof-v1";
const TEMP_PROOF_DOMAIN = "quadwork-temp-proof-v1";
const TEMP_FACT_PROOF_DOMAIN = "quadwork-temp-fact-proof-v1";
const MACHINE_ID_RE = /^[a-f0-9]{32}$/;
const QUALIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHALLENGE_RE = /^[a-f0-9]{64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
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
const MAX_STAGING_MEMORY_MAX_MIB = 256;
const MAX_STAGING_SWAP_MAX_MIB = 64;
const MAX_STAGING_COMBINED_MIB = 320;
const OOM_ALLOCATION_MARGIN_MIB = 16;
const MAX_OOM_ALLOCATION_MIB = MAX_STAGING_COMBINED_MIB + OOM_ALLOCATION_MARGIN_MIB;
const ADAPTER_STATE = new WeakMap();
const INTERNAL_PHASE_TOKEN = Object.freeze({});
// Deliberately empty until the disposable staging deployment contributes
// reviewed, source-owned receipts. Runtime options cannot extend these sets;
// supplying one's own key or `verify()` function must never mint trust.
const TRUSTED_MONITOR_AUTHORITY_FINGERPRINTS = Object.freeze(Object.create(null));
const TRUSTED_TEMP_PROVIDER_FINGERPRINTS = Object.freeze(Object.create(null));
const TRUSTED_TEMP_FACT_AUTHORITY_FINGERPRINTS = Object.freeze(Object.create(null));

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

function oomScript(allocationMib) {
  return `
const fs = require("fs");
const prefix = ${JSON.stringify(LIVE_MARKER_PREFIX)};
const allocationLimitBytes = ${allocationMib} * 1024 * 1024;
const chunkBytes = 8 * 1024 * 1024;
const emit = (value) => fs.writeSync(1, prefix + JSON.stringify(value) + "\\n");
const allocations = [];
emit({event:"oom_ready"});
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  let allocated = 0;
  while (allocated < allocationLimitBytes) {
    const size = Math.min(chunkBytes, allocationLimitBytes - allocated);
    allocations.push(Buffer.alloc(size, 1));
    allocated += size;
  }
  emit({event:"allocation_complete",allocated_mib:${allocationMib}});
});
setInterval(() => {}, 1000);
`;
}

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

function signingPublicKey(value, field) {
  let key;
  try {
    key = safeGet(value, "type") === "public" ? value : crypto.createPublicKey(value);
  } catch { throw new TypeError(`${field} must be a valid public key`); }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(`${field} must be an Ed25519 public key`);
  }
  return key;
}

function publicKeyFingerprint(key) {
  try {
    const der = key.export({ type: "spki", format: "der" });
    return crypto.createHash("sha256").update(der).digest("hex");
  } catch {
    throw new TypeError("authority public key fingerprint is unavailable");
  }
}

function signatureBytes(value) {
  if (typeof value !== "string" || !SIGNATURE_RE.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

function proofChallenge() {
  try {
    const value = crypto.randomBytes(32).toString("hex");
    if (!CHALLENGE_RE.test(value)) throw new Error("invalid challenge");
    return value;
  } catch {
    throw proofError("proof_unavailable", "live_challenge_unavailable");
  }
}

function challengeValue(value, field) {
  if (typeof value !== "string" || !CHALLENGE_RE.test(value)) {
    throw new TypeError(`${field} must be a 256-bit lowercase hex challenge`);
  }
  return value;
}

function buildMonitorProofPayload(value = {}) {
  const probeName = safeGet(value, "probeName");
  const kind = safeGet(value, "kind");
  if (!MONITOR_PROBE_NAMES.includes(probeName) || !["health", "counter"].includes(kind)) {
    throw new TypeError("monitor proof probe or kind is invalid");
  }
  const adapterId = qualifier(safeGet(value, "adapterId"), "adapterId");
  const label = boundedString(safeGet(value, "label"), "label", 512);
  const healthy = kind === "health" ? safeGet(value, "healthy") : null;
  const continuous = kind === "health" ? safeGet(value, "continuous") : null;
  const count = kind === "counter" ? safeCount(safeGet(value, "count")) : null;
  if ((kind === "health" && (typeof healthy !== "boolean" || typeof continuous !== "boolean"))
    || (kind === "counter" && count === null)) {
    throw new TypeError("monitor proof facts are invalid");
  }
  return Buffer.from(JSON.stringify([
    MONITOR_PROOF_DOMAIN,
    challengeValue(safeGet(value, "runChallenge"), "runChallenge"),
    challengeValue(safeGet(value, "probeChallenge"), "probeChallenge"),
    adapterId,
    probeName,
    label,
    kind,
    healthy,
    continuous,
    count,
  ]), "utf8");
}

function buildTempProofPayload(value = {}) {
  const contract = safeGet(value, "contract");
  if (contract !== TEMP_PROOF_CONTRACT) throw new TypeError("temp proof contract is invalid");
  const fields = [
    TEMP_PROOF_DOMAIN,
    challengeValue(safeGet(value, "runChallenge"), "runChallenge"),
    challengeValue(safeGet(value, "phaseChallenge"), "phaseChallenge"),
    qualifier(safeGet(value, "projectId"), "projectId"),
    qualifier(safeGet(value, "generationId"), "generationId"),
    qualifier(safeGet(value, "providerId"), "providerId"),
    contract,
    boundedString(safeGet(value, "canonicalRoot"), "canonicalRoot", 4096),
    boundedString(safeGet(value, "generationTempRoot"), "generationTempRoot", 4096),
    boundedString(safeGet(value, "effectivePath"), "effectivePath", 4096),
  ];
  if (fields.slice(7).some((item) => !path.isAbsolute(item))) {
    throw new TypeError("temp proof paths must be absolute");
  }
  return Buffer.from(JSON.stringify(fields), "utf8");
}

function buildTempFactProofPayload(value = {}) {
  const fields = [
    TEMP_FACT_PROOF_DOMAIN,
    challengeValue(safeGet(value, "runChallenge"), "runChallenge"),
    qualifier(safeGet(value, "authorityId"), "authorityId"),
    qualifier(safeGet(value, "projectId"), "projectId"),
    qualifier(safeGet(value, "generationId"), "generationId"),
    boundedString(safeGet(value, "canonicalRoot"), "canonicalRoot", 4096),
    boundedString(safeGet(value, "generationTempRoot"), "generationTempRoot", 4096),
    safeGet(value, "available"),
    safeGet(value, "code"),
    safeGet(value, "diskBacked"),
  ];
  if (fields[7] !== true || fields[8] !== "ready" || fields[9] !== true
    || !path.isAbsolute(fields[5]) || !path.isAbsolute(fields[6])) {
    throw new TypeError("resource temp fact proof is invalid");
  }
  return Buffer.from(JSON.stringify(fields), "utf8");
}

function verifySignature(publicKey, payload, signature) {
  const bytes = signatureBytes(signature);
  if (bytes === null) return false;
  try { return crypto.verify(null, payload, publicKey, bytes); } catch { return false; }
}

function normalizeMonitorAuthority(value) {
  if (!value || typeof value !== "object") return null;
  const adapterId = qualifier(safeGet(value, "adapterId"), "monitorAuthority.adapterId");
  const publicKey = signingPublicKey(safeGet(value, "publicKey"), "monitorAuthority.publicKey");
  const fingerprint = publicKeyFingerprint(publicKey);
  return Object.freeze({
    adapterId,
    publicKey,
    trusted: safeGet(TRUSTED_MONITOR_AUTHORITY_FINGERPRINTS, adapterId) === fingerprint,
  });
}

function normalizeTempFactAuthority(value) {
  if (!value || typeof value !== "object") return null;
  const verify = safeGet(value, "verify");
  if (typeof verify !== "function") throw new TypeError("tempFactAuthority.verify must be a function");
  const authorityId = qualifier(safeGet(value, "authorityId"), "tempFactAuthority.authorityId");
  const publicKey = signingPublicKey(safeGet(value, "publicKey"), "tempFactAuthority.publicKey");
  const fingerprint = publicKeyFingerprint(publicKey);
  return Object.freeze({
    authorityId,
    publicKey,
    verify,
    receiver: value,
    trusted: safeGet(TRUSTED_TEMP_FACT_AUTHORITY_FINGERPRINTS, authorityId) === fingerprint,
  });
}

function normalizeTempProbe(value) {
  if (value === undefined) return null;
  const command = commandSpec(value, "target.tempProbe");
  if (command.args.length > 125) throw new TypeError("target.tempProbe.args leaves no room for proof binding");
  const providerId = qualifier(safeGet(value, "providerId"), "target.tempProbe.providerId");
  if (safeGet(value, "contract") !== TEMP_PROOF_CONTRACT) {
    throw new TypeError(`target.tempProbe.contract must be ${TEMP_PROOF_CONTRACT}`);
  }
  const publicKey = signingPublicKey(safeGet(value, "publicKey"), "target.tempProbe.publicKey");
  const fingerprint = publicKeyFingerprint(publicKey);
  return Object.freeze({
    ...command,
    providerId,
    contract: TEMP_PROOF_CONTRACT,
    publicKey,
    trusted: safeGet(TRUSTED_TEMP_PROVIDER_FINGERPRINTS, providerId) === fingerprint,
  });
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
  const resolvedGenerationTempRoot = path.resolve(generationTempRoot);
  if (resolvedGenerationTempRoot !== generationTempRoot
    || path.parse(resolvedGenerationTempRoot).root === resolvedGenerationTempRoot) {
    throw new TypeError("target.generationTempRoot must be a normalized non-root path");
  }
  const limits = safeGet(value, "workerLimits");
  if (!limits || typeof limits !== "object") throw new TypeError("target.workerLimits is required");
  const workerLimits = Object.freeze({
    memoryHighMib: boundedInteger(
      safeGet(limits, "memoryHighMib"),
      "memoryHighMib",
      1,
      MAX_STAGING_MEMORY_MAX_MIB,
    ),
    memoryMaxMib: boundedInteger(
      safeGet(limits, "memoryMaxMib"),
      "memoryMaxMib",
      1,
      MAX_STAGING_MEMORY_MAX_MIB,
    ),
    swapMaxMib: boundedInteger(
      safeGet(limits, "swapMaxMib"),
      "swapMaxMib",
      1,
      MAX_STAGING_SWAP_MAX_MIB,
    ),
  });
  if (workerLimits.memoryHighMib > workerLimits.memoryMaxMib) {
    throw new TypeError("worker memory high exceeds max");
  }
  if (!Number.isSafeInteger(workerLimits.memoryMaxMib + workerLimits.swapMaxMib)
    || workerLimits.memoryMaxMib + workerLimits.swapMaxMib > MAX_STAGING_COMBINED_MIB) {
    throw new TypeError("worker memory and swap exceed the staging safety envelope");
  }
  // tempProbe is deliberately target-specific: it must invoke the actual
  // provider/client under test and emit one bounded marker shaped as
  // {event:"effective_temp",path:"<its effective temp directory>"}. A generic
  // Node echo would not prove that Claude/Gemini preserves the boundary.
  return Object.freeze({
    projectId,
    generationId,
    nodeExecutable,
    cwd,
    generationTempRoot: resolvedGenerationTempRoot,
    workerLimits,
    spawnEnv: normalizeEnvironment(safeGet(value, "spawnEnv")),
    tempProbe: normalizeTempProbe(safeGet(value, "tempProbe")),
    tempFact: safeGet(value, "tempFact"),
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

function phaseIdentity(target, phaseId, runChallenge, sequence) {
  const generationId = `staging-${crypto.createHash("sha256")
    .update(JSON.stringify(["staging-phase", target.generationId, phaseId, runChallenge, sequence]), "utf8")
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

function internalState(adapter) {
  const state = ADAPTER_STATE.get(adapter);
  if (!state) throw proofError("proof_unavailable", "live_adapter_state_unavailable");
  return state;
}

function requireInternalPhaseToken(token) {
  if (token !== INTERNAL_PHASE_TOKEN) throw proofError("proof_refused", "internal_phase_boundary_required");
}

function registerScope(adapter, unitName) {
  const state = internalState(adapter);
  if (typeof unitName !== "string" || !GENERATED_WORKER_UNIT_RE.test(unitName.slice(0, -".scope".length))
    || !unitName.endsWith(".scope") || state.registeredUnits.has(unitName)) {
    throw proofError("proof_unavailable", "scope_registration_invalid");
  }
  state.registeredUnits.add(unitName);
}

async function cleanupRegisteredScope(adapter, unitName) {
  const state = internalState(adapter);
  if (!state.registeredUnits.has(unitName)) return false;
  let clean = false;
  try {
    adapter.execFileSync("systemctl", ["--user", "stop", unitName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: adapter.cleanupTimeoutMs,
      maxBuffer: adapter.maximumOutputBytes,
    });
    clean = true;
  } catch {}
  if (!clean) {
    try {
      const output = adapter.execFileSync("systemctl", [
        "--user",
        "--property=LoadState",
        "--property=ActiveState",
        "--value",
        "show",
        unitName,
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: adapter.cleanupTimeoutMs,
        maxBuffer: adapter.maximumOutputBytes,
      });
      const states = boundedText(output, adapter.maximumOutputBytes, "scope_cleanup_unavailable")
        .trim()
        .split(/\r?\n/);
      clean = states.includes("not-found") && states.includes("inactive");
    } catch {}
  }
  if (clean) state.registeredUnits.delete(unitName);
  return clean;
}

function redactedIdentity(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

class LiveStagingAdapter {
  constructor(options) {
    this.runPressure = safeGet(options, "runPressure") === true;
    this.acknowledgement = safeGet(options, "acknowledgement");
    this.gateProbe = safeGet(options, "gateProbe");
    this.monitorProbes = safeGet(options, "monitorProbes");
    this.monitorAuthority = normalizeMonitorAuthority(safeGet(options, "monitorAuthority"));
    this.tempFactAuthority = normalizeTempFactAuthority(safeGet(options, "tempFactAuthority"));
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
    ADAPTER_STATE.set(this, {
      runChallenge: null,
      nextSequence: 0,
      registeredUnits: new Set(),
    });
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
    const state = internalState(this);
    if (state.registeredUnits.size !== 0) {
      throw proofError("proof_unavailable", "prior_scope_cleanup_required");
    }
    state.runChallenge = proofChallenge();
    state.nextSequence = 0;
    return this.gates;
  }

  _authorize(context) {
    const gates = this.gates;
    if (!this.runPressure || !gates || !gates.machineId
      || !gates.linux || !gates.cgroupV2 || !gates.userManager
      || this.acknowledgement !== `${ACK_PREFIX}${gates.machineId}`) {
      throw proofError("proof_refused", "disposable_gate_required");
    }
    if (!CHALLENGE_RE.test(internalState(this).runChallenge || "")) {
      throw proofError("proof_unavailable", "live_challenge_unavailable");
    }
    if (!candidateMatches(safeGet(context, "candidate"))) {
      throw proofError("proof_unavailable", "candidate_contract_mismatch");
    }
  }

  async startContinuousMonitoring(context) {
    this._authorize(context);
    // Each target-owned probe signs its exact checkpoint facts. The configured
    // Ed25519 public key is the independently trusted adapter capability;
    // `authenticated:true` or an echoed challenge has no authority by itself.
    const probes = this.monitorProbes;
    const probeFunctions = probes && MONITOR_PROBE_NAMES.map((name) => safeGet(probes, name));
    const authority = this.monitorAuthority;
    if (!authority || !probeFunctions || probeFunctions.some((probe) => typeof probe !== "function")) {
      throw proofError("proof_unavailable", "authenticated_monitor_probes_required");
    }
    if (authority.trusted !== true) {
      throw proofError("proof_unavailable", "staging_monitor_authority_unpinned");
    }
    const runChallenge = internalState(this).runChallenge;
    let stopped = false;
    const samples = [];
    const checkpoint = async (label) => {
      if (stopped) throw proofError("proof_unavailable", "monitor_stopped");
      const boundedLabel = boundedString(label, "monitor label", 512);
      const challenges = MONITOR_PROBE_NAMES.map(() => proofChallenge());
      const results = await Promise.all(MONITOR_PROBE_NAMES.map((name, index) => callBounded(
        ({ signal }) => probeFunctions[index](Object.freeze({
          signal,
          label: boundedLabel,
          probeName: name,
          runChallenge,
          probeChallenge: challenges[index],
        })),
        this.probeTimeoutMs,
        `monitor_${name}_unavailable`,
      )));
      const health = results.slice(0, 3).map((result, index) => {
        const healthy = safeGet(result, "healthy");
        const continuous = safeGet(result, "continuous");
        const signature = safeGet(result, "signature");
        const bound = safeGet(result, "adapterId") === authority.adapterId
          && safeGet(result, "runChallenge") === runChallenge
          && safeGet(result, "probeChallenge") === challenges[index]
          && typeof healthy === "boolean"
          && typeof continuous === "boolean";
        if (!bound || !verifySignature(authority.publicKey, buildMonitorProofPayload({
          runChallenge,
          probeChallenge: challenges[index],
          adapterId: authority.adapterId,
          probeName: MONITOR_PROBE_NAMES[index],
          label: boundedLabel,
          kind: "health",
          healthy,
          continuous,
        }), signature)) {
          throw proofError("proof_unavailable", "authenticated_monitor_result_invalid");
        }
        return healthy && continuous;
      });
      const counters = results.slice(3).map((result, offset) => {
        const index = offset + 3;
        const count = safeCount(safeGet(result, "count"));
        const signature = safeGet(result, "signature");
        const bound = safeGet(result, "adapterId") === authority.adapterId
          && safeGet(result, "runChallenge") === runChallenge
          && safeGet(result, "probeChallenge") === challenges[index]
          && count !== null;
        if (!bound || !verifySignature(authority.publicKey, buildMonitorProofPayload({
          runChallenge,
          probeChallenge: challenges[index],
          adapterId: authority.adapterId,
          probeName: MONITOR_PROBE_NAMES[index],
          label: boundedLabel,
          kind: "counter",
          count,
        }), signature)) {
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
        monitor_identity: redactedIdentity(authority.adapterId),
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
    const state = internalState(this);
    state.nextSequence += 1;
    const identity = phaseIdentity(this.target, phaseId, state.runChallenge, state.nextSequence);
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

  async _withPty(phaseId, command, handler, envExtra = {}, internalToken) {
    requireInternalPhaseToken(internalToken);
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
      // A spawn adapter that throws has not returned ownership evidence. Never
      // issue a stop for a merely predicted name; only returned launches enter
      // the private cleanup registry below.
      throw proofError("proof_unavailable", "pty_spawn_unavailable");
    }
    registerScope(this, built.identity.unitName);
    let session;
    try {
      session = new PtySession(term, this.maximumOutputBytes);
    } catch (error) {
      const scopeClean = await cleanupRegisteredScope(this, built.identity.unitName);
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
    const scopeClean = await cleanupRegisteredScope(this, built.identity.unitName);
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
    if (phaseId === "node_pty_controlling_tty") return this._ttyPhase(phaseId, INTERNAL_PHASE_TOKEN);
    if (phaseId === "resize_signal_exit_propagation") return this._resizePhase(phaseId, INTERNAL_PHASE_TOKEN);
    if (phaseId === "descendant_cgroup_membership") return this._descendantPhase(phaseId, INTERNAL_PHASE_TOKEN);
    if (phaseId === "effective_temp_disk_boundary") return this._tempPhase(phaseId, INTERNAL_PHASE_TOKEN);
    return this._oomPhase(phaseId, INTERNAL_PHASE_TOKEN);
  }

  _ttyPhase(phaseId, internalToken) {
    requireInternalPhaseToken(internalToken);
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
    }, {}, internalToken);
  }

  _resizePhase(phaseId, internalToken) {
    requireInternalPhaseToken(internalToken);
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
    }, {}, internalToken);
  }

  _descendantPhase(phaseId, internalToken) {
    requireInternalPhaseToken(internalToken);
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
    }, {}, internalToken);
  }

  async _validatedTempBoundary() {
    const fact = this.target.tempFact;
    const authority = this.tempFactAuthority;
    if (!authority) throw proofError("proof_unavailable", "validated_resource_temp_fact_required");
    const canonicalRoot = safeGet(fact, "canonicalRoot");
    if (safeGet(fact, "available") !== true || safeGet(fact, "code") !== "ready"
      || safeGet(fact, "diskBacked") !== true || typeof canonicalRoot !== "string"
      || !path.isAbsolute(canonicalRoot) || path.resolve(canonicalRoot) !== canonicalRoot
      || path.parse(canonicalRoot).root === canonicalRoot) {
      throw proofError("proof_unavailable", "resource_temp_fact_invalid");
    }
    let canonicalRootReal;
    let generationReal;
    try {
      canonicalRootReal = this.fs.realpathSync(canonicalRoot);
      generationReal = this.fs.realpathSync(this.target.generationTempRoot);
    } catch {
      throw proofError("proof_unavailable", "effective_temp_unavailable");
    }
    const relative = path.relative(canonicalRootReal, generationReal);
    if (canonicalRootReal !== canonicalRoot || generationReal !== this.target.generationTempRoot
      || relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
      throw proofError("proof_unavailable", "generation_temp_boundary_invalid");
    }
    if (authority.trusted !== true) {
      throw proofError("proof_unavailable", "resource_temp_fact_authority_unpinned");
    }
    const receipt = await callBounded(
      ({ signal }) => authority.verify.call(authority.receiver, Object.freeze({
        signal,
        runChallenge: internalState(this).runChallenge,
        fact,
        projectId: this.target.projectId,
        generationId: this.target.generationId,
        generationTempRoot: this.target.generationTempRoot,
      })),
      this.probeTimeoutMs,
      "resource_temp_fact_unavailable",
    );
    const factPayload = buildTempFactProofPayload({
      runChallenge: internalState(this).runChallenge,
      authorityId: authority.authorityId,
      projectId: this.target.projectId,
      generationId: this.target.generationId,
      canonicalRoot,
      generationTempRoot: generationReal,
      available: true,
      code: "ready",
      diskBacked: true,
    });
    if (safeGet(receipt, "valid") !== true
      || safeGet(receipt, "authorityId") !== authority.authorityId
      || safeGet(receipt, "runChallenge") !== internalState(this).runChallenge
      || !verifySignature(authority.publicKey, factPayload, safeGet(receipt, "signature"))) {
      throw proofError("proof_unavailable", "resource_temp_fact_invalid");
    }
    return Object.freeze({ canonicalRoot, generationTempRoot: generationReal });
  }

  async _tempPhase(phaseId, internalToken) {
    requireInternalPhaseToken(internalToken);
    if (!this.target.tempProbe || typeof safeGet(this.fs, "realpathSync") !== "function"
      || typeof safeGet(this.fs, "statfsSync") !== "function") {
      throw proofError("proof_unavailable", "target_effective_temp_probe_required");
    }
    const boundary = await this._validatedTempBoundary();
    if (this.target.tempProbe.trusted !== true) {
      throw proofError("proof_unavailable", "temp_provider_authority_unpinned");
    }
    const state = internalState(this);
    const phaseChallenge = proofChallenge();
    const command = Object.freeze({
      file: this.target.tempProbe.file,
      args: Object.freeze([
        ...this.target.tempProbe.args,
        `--quadwork-proof-contract=${TEMP_PROOF_CONTRACT}`,
        `--quadwork-run-challenge=${state.runChallenge}`,
        `--quadwork-phase-challenge=${phaseChallenge}`,
      ]),
    });
    return this._withPty(phaseId, command, async (session) => {
      const marker = await session.marker("effective_temp");
      const effective = safeGet(marker, "path");
      if (typeof effective !== "string" || !path.isAbsolute(effective)
        || path.resolve(effective) !== effective || effective.includes("\0")
        || Buffer.byteLength(effective, "utf8") > 4096
        || safeGet(marker, "provider_id") !== this.target.tempProbe.providerId
        || safeGet(marker, "contract") !== TEMP_PROOF_CONTRACT
        || safeGet(marker, "run_challenge") !== state.runChallenge
        || safeGet(marker, "phase_challenge") !== phaseChallenge) {
        throw proofError("proof_unavailable", "effective_temp_result_invalid");
      }
      let effectiveReal;
      let statfs;
      try {
        effectiveReal = this.fs.realpathSync(effective);
        if (typeof effectiveReal !== "string" || !path.isAbsolute(effectiveReal)
          || effectiveReal !== effective) {
          throw new Error("canonical temp path is invalid");
        }
        statfs = this.fs.statfsSync(effectiveReal, { bigint: true });
      } catch {
        throw proofError("proof_unavailable", "effective_temp_unavailable");
      }
      const payload = buildTempProofPayload({
        runChallenge: state.runChallenge,
        phaseChallenge,
        projectId: this.target.projectId,
        generationId: this.target.generationId,
        providerId: this.target.tempProbe.providerId,
        contract: TEMP_PROOF_CONTRACT,
        canonicalRoot: boundary.canonicalRoot,
        generationTempRoot: boundary.generationTempRoot,
        effectivePath: effectiveReal,
      });
      if (!verifySignature(this.target.tempProbe.publicKey, payload, safeGet(marker, "signature"))) {
        throw proofError("proof_unavailable", "effective_temp_provider_unverified");
      }
      const type = filesystemType(statfs);
      const within = boundary.generationTempRoot === effectiveReal;
      const diskBacked = type !== TMPFS_MAGIC && type !== RAMFS_MAGIC;
      const exit = await session.exit();
      const exited = exit.exitCode === 0 && (exit.signal === 0 || exit.signal === null);
      return Object.freeze({
        status: within && diskBacked && exited ? "passed" : "failed",
        effective_temp_disk_backed: diskBacked,
        effective_temp_within_generation_root: within,
      });
    }, { TMPDIR: this.target.generationTempRoot }, internalToken);
  }

  _oomPhase(phaseId, internalToken) {
    requireInternalPhaseToken(internalToken);
    const testedLimitMib = this.target.workerLimits.memoryMaxMib + this.target.workerLimits.swapMaxMib;
    const allocationMib = testedLimitMib + OOM_ALLOCATION_MARGIN_MIB;
    if (!Number.isSafeInteger(allocationMib) || allocationMib <= testedLimitMib
      || allocationMib > MAX_OOM_ALLOCATION_MIB) {
      throw proofError("proof_unavailable", "oom_safety_envelope_invalid");
    }
    return this._withPty(phaseId, { file: this.target.nodeExecutable, args: ["-e", oomScript(allocationMib)] }, async (session, identity) => {
      await session.marker("oom_ready");
      const cgroupPath = this._resolveCgroup(identity.unitName);
      const before = this._readOom(cgroupPath);
      session.write("go\n");
      const after = await Promise.race([
        this._pollOomIncrease(cgroupPath, before, session),
        session.marker("allocation_complete").then(() => {
          throw proofError("proof_unavailable", "bounded_allocator_survived_without_oom");
        }),
      ]);
      const exit = await session.exit();
      const bounded = after > before && (exit.exitCode !== 0 || (exit.signal !== 0 && exit.signal !== null));
      return Object.freeze({
        status: bounded ? "passed" : "failed",
        worker_scope_bounded: bounded,
        worker_oom_counter_before: before,
        worker_oom_counter_after: after,
      });
    }, {}, internalToken);
  }
}

function createLiveStagingAdapter(options = {}) {
  return new LiveStagingAdapter(options);
}

module.exports = {
  LIVE_MARKER_PREFIX,
  TEMP_PROOF_CONTRACT,
  MAX_STAGING_MEMORY_MAX_MIB,
  MAX_STAGING_SWAP_MAX_MIB,
  MAX_OOM_ALLOCATION_MIB,
  buildMonitorProofPayload,
  buildTempProofPayload,
  buildTempFactProofPayload,
  createGeneratedWorkerUnitBase,
  createLiveStagingAdapter,
};
