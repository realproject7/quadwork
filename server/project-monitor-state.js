"use strict";

// Durable, deliberately redacted state for the V2 Project Monitor.  This is
// not a queue or chat transcript: it holds only mode, condition identity and
// trusted-delivery recovery facts.  Keeping the store separate from config
// prevents arbitrary configuration writers from minting monitor authority.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MONITOR_EVENT_KINDS } = require("./project-monitor-policy");

const MONITOR_STATE_VERSION = 1;
const MONITOR_STATE_FILENAME = "monitor-state.json";
const MODE_SET = new Set(["enabled", "suspended", "archived"]);
const PHASE_SET = new Set(["recorded", "appended", "woken"]);
const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,191}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,255}$/;
const MONITOR_EVENT_KIND_SET = new Set(MONITOR_EVENT_KINDS);

class ProjectMonitorStateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function identifier(value, pattern = ID_RE) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function finiteEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function statePath(homeDir, projectId) {
  const project = identifier(projectId, PROJECT_ID_RE);
  if (!project) throw new ProjectMonitorStateError("monitor_project_invalid");
  return path.join(homeDir, ".quadwork", project, MONITOR_STATE_FILENAME);
}

function initialMonitorState(mode = "suspended") {
  return {
    version: MONITOR_STATE_VERSION,
    mode: MODE_SET.has(mode) ? mode : "suspended",
    observation_hash: null,
    unresolved: Object.create(null),
    deliveries: Object.create(null),
  };
}

function safeAnchors(value, projectId) {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length < 4 || entries.length > 16) return null;
  const out = Object.create(null);
  for (const [key, raw] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !identifier(raw)) return null;
    out[key] = raw;
  }
  if (out.project_id !== projectId || !out.assignment_key || !out.subject_key || !out.event_generation) return null;
  return out;
}

function safeCondition(value, projectId) {
  if (!isPlainObject(value)) return null;
  const key = identifier(value.key, EVENT_ID_RE);
  const kind = identifier(value.kind, KIND_RE);
  const anchors = safeAnchors(value.anchors, projectId);
  const dueAt = finiteEpoch(value.due_at);
  if (!key || !kind || !MONITOR_EVENT_KIND_SET.has(kind) || !anchors || dueAt === null) return null;
  return { key, kind, anchors, due_at: dueAt };
}

function safeDelivery(value, projectId) {
  if (!isPlainObject(value)) return null;
  const kind = identifier(value.kind, KIND_RE);
  const phase = typeof value.phase === "string" && PHASE_SET.has(value.phase) ? value.phase : null;
  const anchors = safeAnchors(value.anchors, projectId);
  const anchorHash = typeof value.anchor_hash === "string" && HASH_RE.test(value.anchor_hash) ? value.anchor_hash : null;
  const eventId = value.chat_event_id === null || value.chat_event_id === undefined ? null : identifier(value.chat_event_id, EVENT_ID_RE);
  const deliveryGeneration = value.delivery_generation === null || value.delivery_generation === undefined
    ? null : identifier(value.delivery_generation, EVENT_ID_RE);
  if (!kind || !MONITOR_EVENT_KIND_SET.has(kind) || !phase || !anchors || !anchorHash || (value.chat_event_id !== null && value.chat_event_id !== undefined && !eventId)
    || (value.delivery_generation !== null && value.delivery_generation !== undefined && !deliveryGeneration)) return null;
  return {
    kind,
    phase,
    anchors,
    anchor_hash: anchorHash,
    chat_event_id: eventId,
    delivery_generation: deliveryGeneration,
  };
}

function normalizeState(value, projectId) {
  if (!isPlainObject(value) || value.version !== MONITOR_STATE_VERSION || !MODE_SET.has(value.mode)
    || (value.observation_hash !== null && (typeof value.observation_hash !== "string" || !HASH_RE.test(value.observation_hash)))
    || !isPlainObject(value.unresolved) || !isPlainObject(value.deliveries)) {
    throw new ProjectMonitorStateError("monitor_state_invalid");
  }
  const unresolvedEntries = Object.entries(value.unresolved);
  const deliveryEntries = Object.entries(value.deliveries);
  if (unresolvedEntries.length > 128 || deliveryEntries.length > 256) throw new ProjectMonitorStateError("monitor_state_invalid");
  const out = initialMonitorState(value.mode);
  out.observation_hash = value.observation_hash;
  for (const [key, raw] of unresolvedEntries) {
    if (!identifier(key, EVENT_ID_RE)) throw new ProjectMonitorStateError("monitor_state_invalid");
    const condition = safeCondition(raw, projectId);
    if (!condition || condition.key !== key) throw new ProjectMonitorStateError("monitor_state_invalid");
    out.unresolved[key] = condition;
  }
  for (const [correlation, raw] of deliveryEntries) {
    if (!HASH_RE.test(correlation)) throw new ProjectMonitorStateError("monitor_state_invalid");
    const delivery = safeDelivery(raw, projectId);
    if (!delivery) throw new ProjectMonitorStateError("monitor_state_invalid");
    out.deliveries[correlation] = delivery;
  }
  if (out.mode === "archived") {
    // An archived project retains no pending monitor work to replay after a
    // later restore.  Unarchive requires a fresh, explicit monitor start.
    out.unresolved = Object.create(null);
    out.deliveries = Object.create(null);
  }
  return out;
}

function secureDirectory(fsImpl, directory) {
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fsImpl.lstatSync(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    throw new ProjectMonitorStateError("monitor_state_unsafe");
  }
  try { fsImpl.chmodSync(directory, 0o700); } catch {}
}

function secureStateDirectories(fsImpl, homeDir, projectId) {
  const root = path.join(homeDir, ".quadwork");
  secureDirectory(fsImpl, root);
  secureDirectory(fsImpl, path.join(root, projectId));
}

function verifyExistingSecureDirectory(fsImpl, directory) {
  let stat;
  try { stat = fsImpl.lstatSync(directory); }
  catch { throw new ProjectMonitorStateError("monitor_state_unreadable"); }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    throw new ProjectMonitorStateError("monitor_state_unsafe");
  }
}

function readState(fsImpl, homeDir, projectId) {
  const filePath = statePath(homeDir, projectId);
  let stat;
  try { stat = fsImpl.lstatSync(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return initialMonitorState();
    throw new ProjectMonitorStateError("monitor_state_unreadable");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid)) {
    throw new ProjectMonitorStateError("monitor_state_unsafe");
  }
  const root = path.join(homeDir, ".quadwork");
  verifyExistingSecureDirectory(fsImpl, root);
  verifyExistingSecureDirectory(fsImpl, path.join(root, projectId));
  let parsed;
  try { parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8")); }
  catch { throw new ProjectMonitorStateError("monitor_state_invalid"); }
  return normalizeState(parsed, projectId);
}

function writeState(fsImpl, homeDir, projectId, value, randomBytes = crypto.randomBytes) {
  const safeProject = identifier(projectId, PROJECT_ID_RE);
  if (!safeProject) throw new ProjectMonitorStateError("monitor_project_invalid");
  const state = normalizeState(value, safeProject);
  const filePath = statePath(homeDir, safeProject);
  const data = JSON.stringify(state);
  let temporary = null;
  try {
    secureStateDirectories(fsImpl, homeDir, safeProject);
    const entropy = randomBytes(12);
    if (!Buffer.isBuffer(entropy)) throw new Error("invalid random bytes");
    temporary = `${filePath}.${process.pid}.${entropy.toString("hex")}.tmp`;
    const fd = fsImpl.openSync(temporary, "wx", 0o600);
    try {
      fsImpl.writeFileSync(fd, data, "utf8");
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    fsImpl.renameSync(temporary, filePath);
    temporary = null;
    try { fsImpl.chmodSync(filePath, 0o600); } catch {}
    return clone(state);
  } catch (error) {
    if (temporary) {
      try { fsImpl.unlinkSync(temporary); } catch {}
    }
    if (error instanceof ProjectMonitorStateError) throw error;
    throw new ProjectMonitorStateError("monitor_state_persist_failed");
  }
}

class ProjectMonitorStateStore {
  constructor(options = {}) {
    this.fs = options.fsImpl || fs;
    this.homeDir = options.homeDir || os.homedir();
    this.randomBytes = options.randomBytes || crypto.randomBytes;
  }

  pathFor(projectId) {
    return statePath(this.homeDir, projectId);
  }

  load(projectId) {
    return deepFreeze(clone(readState(this.fs, this.homeDir, projectId)));
  }

  save(projectId, state) {
    return deepFreeze(clone(writeState(this.fs, this.homeDir, projectId, state, this.randomBytes)));
  }
}

function createProjectMonitorStateStore(options) {
  return new ProjectMonitorStateStore(options);
}

module.exports = {
  MONITOR_STATE_VERSION,
  MONITOR_STATE_FILENAME,
  ProjectMonitorStateError,
  ProjectMonitorStateStore,
  createProjectMonitorStateStore,
  initialMonitorState,
  cloneMonitorState: clone,
  statePath,
};
