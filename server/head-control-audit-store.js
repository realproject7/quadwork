"use strict";

// #1044 M2: project-scoped durable receipts for the closed Head-control core.
// This is intentionally not a general event log.  It stores only a fixed,
// redacted projection of an M1 Head-control audit decision, with no payload,
// command text, environment/config data, terminal output, or secret surface.

const nodeFs = require("node:fs");
const path = require("node:path");
const {
  FILE_MODE,
  DIRECTORY_MODE,
  modeOf,
  sameFile,
  createDurableStoreFiles,
} = require("./durable-store-files");
const { VERSION, ACTIONS } = require("./head-control-plane");

const SCHEMA_VERSION = 1;
const MAX_RECORDS = 64;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^head_control_[a-z0-9_]{2,95}$/;
const ACTION_SET = new Set(ACTIONS);
const DECISION_SET = new Set(["accepted", "denied"]);
const FILE_CODES = Object.freeze({
  options: "invalid_head_control_audit_store_options",
  unreadable: "head_control_audit_store_unreadable",
  symlink_rejected: "head_control_audit_store_symlink_rejected",
  insecure_permissions: "head_control_audit_store_insecure_permissions",
  write_failed: "head_control_audit_store_write_failed",
  locked: "head_control_audit_store_locked",
  lock_unsafe: "head_control_audit_store_lock_failed",
  lock_failed: "head_control_audit_store_lock_failed",
  lock_acquire_changed: "head_control_audit_store_lock_failed",
  lock_release_changed: "head_control_audit_store_lock_release_failed",
  lock_release_failed: "head_control_audit_store_lock_release_failed",
});

class HeadControlAuditStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "HeadControlAuditStoreError";
    this.code = code;
  }
}

function fail(code, message) { throw new HeadControlAuditStoreError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has unknown or missing fields");
  }
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function stable(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  fail("invalid_head_control_audit_record", "record contains an unsupported value");
}
function sameRecord(left, right) { return stable(left) === stable(right); }
function identity(value, code) {
  exact(value, ["installation_id", "project_id", "role", "generation"], code);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) ||
      value.role !== "head" || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    fail(code, "Head binding is invalid");
  }
  return {
    installation_id: value.installation_id,
    project_id: value.project_id,
    role: "head",
    generation: value.generation,
  };
}
function sameIdentity(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id &&
    left.role === right.role && left.generation === right.generation;
}
function identifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail(code, "correlation or idempotency identity is invalid");
  return value;
}
function revision(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 1) fail(code, "revision is invalid");
  return value;
}
function digest(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "digest is invalid");
  return value;
}
function assertStatus(value, code) {
  exact(value, ["revision", "archived", "manifest_digest", "pipeline_digest", "manifest_frozen", "cut_safe"], code);
  const status = {
    revision: revision(value.revision, code),
    archived: value.archived,
    manifest_digest: digest(value.manifest_digest, code, true),
    pipeline_digest: digest(value.pipeline_digest, code, true),
    manifest_frozen: value.manifest_frozen,
    cut_safe: value.cut_safe,
  };
  if (typeof status.archived !== "boolean" || typeof status.manifest_frozen !== "boolean" || typeof status.cut_safe !== "boolean") {
    fail(code, "result status flags are invalid");
  }
  if (status.manifest_digest === null && (status.pipeline_digest !== null || status.manifest_frozen || status.cut_safe)) {
    fail(code, "empty result status is inconsistent");
  }
  if (status.pipeline_digest !== null && !status.manifest_frozen) fail(code, "pipeline result precedes manifest freeze");
  if (status.cut_safe && (status.archived || !status.manifest_frozen || status.pipeline_digest === null)) {
    fail(code, "cut-safe result is inconsistent");
  }
  return status;
}
function assertResult(value, action, code) {
  if (value === null) return null;
  exact(value, ["action", "applied", "status"], code);
  if (value.action !== action || typeof value.applied !== "boolean") fail(code, "result action is invalid");
  return {
    action,
    applied: value.applied,
    status: assertStatus(value.status, code),
  };
}

// This is intentionally congruent with `head-control-plane`'s fixed audit
// output.  The allow-list is the redaction boundary: request payloads and
// arbitrary outcome text cannot become durable audit data.
function normalizeAuditRecord(value) {
  exact(value, ["version", "binding", "action", "correlation_id", "idempotency_key", "expected_revision", "decision", "code", "result"], "invalid_head_control_audit_record");
  if (value.version !== VERSION || typeof value.action !== "string" || !ACTION_SET.has(value.action) ||
      typeof value.decision !== "string" || !DECISION_SET.has(value.decision) ||
      typeof value.code !== "string" || !CODE_RE.test(value.code)) {
    fail("invalid_head_control_audit_record", "audit action or outcome is invalid");
  }
  const record = {
    version: VERSION,
    binding: identity(value.binding, "invalid_head_control_audit_record"),
    action: value.action,
    correlation_id: identifier(value.correlation_id, "invalid_head_control_audit_record"),
    idempotency_key: identifier(value.idempotency_key, "invalid_head_control_audit_record"),
    preconditions: { expected_revision: revision(value.expected_revision, "invalid_head_control_audit_record", true) },
    decision: value.decision,
    code: value.code,
    result: assertResult(value.result, value.action, "invalid_head_control_audit_record"),
  };
  if (record.decision === "accepted" && record.result === null) {
    fail("invalid_head_control_audit_record", "accepted audit requires a fixed result");
  }
  return record;
}
function assertStoredRecord(value, owner, code) {
  exact(value, ["version", "binding", "action", "correlation_id", "idempotency_key", "preconditions", "decision", "code", "result"], code);
  exact(value.preconditions, ["expected_revision"], code);
  const expanded = {
    version: value.version,
    binding: value.binding,
    action: value.action,
    correlation_id: value.correlation_id,
    idempotency_key: value.idempotency_key,
    expected_revision: value.preconditions.expected_revision,
    decision: value.decision,
    code: value.code,
    result: value.result,
  };
  const normalized = normalizeAuditRecord(expanded);
  if (!sameIdentity(normalized.binding, owner)) fail(code, "audit record belongs to another Head binding");
  return normalized;
}
function assertState(value, owner) {
  exact(value, ["schema_version", "binding", "records"], "invalid_head_control_audit_store_state");
  if (value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) {
    fail("invalid_head_control_audit_store_state", "audit store state is invalid");
  }
  const binding = identity(value.binding, "invalid_head_control_audit_store_state");
  if (!sameIdentity(binding, owner)) fail("head_control_audit_store_identity_mismatch", "audit store belongs to another Head binding");
  const correlations = new Set();
  const idempotencies = new Set();
  const records = value.records.map((entry) => {
    const normalized = assertStoredRecord(entry, owner, "invalid_head_control_audit_store_state");
    if (correlations.has(normalized.correlation_id) || idempotencies.has(normalized.idempotency_key)) {
      fail("invalid_head_control_audit_store_state", "audit identity is duplicated");
    }
    correlations.add(normalized.correlation_id);
    idempotencies.add(normalized.idempotency_key);
    return normalized;
  });
  return { schema_version: SCHEMA_VERSION, binding, records };
}
function snapshot(state, owner) {
  const normalized = assertState(state, owner);
  return freeze(clone(normalized));
}

function storageDirectory(configDir) {
  if (typeof configDir !== "string" || !path.isAbsolute(configDir) || configDir.length > 1024 || /[\u0000\r\n]/.test(configDir)) {
    fail("invalid_head_control_audit_store_options", "config_dir must be a bounded absolute path");
  }
  return path.join(configDir, "head-control-audit");
}
function headControlAuditStorePath(configDir, bindingValue) {
  const owner = identity(bindingValue, "invalid_head_control_audit_store_identity");
  return path.join(storageDirectory(configDir), `${owner.installation_id}--${owner.project_id}.json`);
}
function readState(fs, statePath, owner, allowMissing) {
  let raw;
  try {
    const stats = fs.lstatSync(statePath);
    if (stats.isSymbolicLink()) fail("head_control_audit_store_symlink_rejected", "audit store file cannot be a symbolic link");
    if (!stats.isFile() || modeOf(stats) !== FILE_MODE) {
      fail("head_control_audit_store_insecure_permissions", "audit store file must be a mode 0600 regular file");
    }
    const descriptor = fs.openSync(statePath, "r");
    try {
      const opened = fs.fstatSync(descriptor);
      if (!sameFile(stats, opened) || !opened.isFile() || modeOf(opened) !== FILE_MODE) {
        fail("head_control_audit_store_unreadable", "audit store changed during secure read");
      }
      raw = fs.readFileSync(descriptor, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof HeadControlAuditStoreError) throw error;
    if (error && error.code === "ENOENT") {
      if (allowMissing) return null;
      fail("head_control_audit_store_missing", "audit store is not initialized");
    }
    fail("head_control_audit_store_unreadable", "audit store cannot be read");
  }
  let decoded;
  try { decoded = JSON.parse(raw); } catch { fail("corrupt_head_control_audit_store", "audit store JSON is corrupt"); }
  try { return assertState(decoded, owner); }
  catch (error) {
    if (error instanceof HeadControlAuditStoreError && error.code === "head_control_audit_store_identity_mismatch") throw error;
    fail("corrupt_head_control_audit_store", "audit store validation failed");
  }
}
function writeStateAtomically(files, statePath, state, owner) {
  const checked = assertState(state, owner);
  files.writeFileAtomically(statePath, `${JSON.stringify(checked)}\n`);
}

function createHeadControlAuditStore(options) {
  exact(options, ["config_dir", "fs"], "invalid_head_control_audit_store_options");
  const files = createDurableStoreFiles({ fs: options.fs || nodeFs, error: HeadControlAuditStoreError, codes: FILE_CODES });
  const fs = files.fs;
  const directory = storageDirectory(options.config_dir);
  const directories = [{ path: options.config_dir, mode: DIRECTORY_MODE }, { path: directory, mode: DIRECTORY_MODE }];

  function statePath(bindingValue) {
    return headControlAuditStorePath(options.config_dir, bindingValue);
  }
  function read(bindingValue) {
    const owner = identity(bindingValue, "invalid_head_control_audit_store_identity");
    if (!files.storageExists(directories)) return freeze([]);
    const state = readState(fs, statePath(owner), owner, true);
    return state === null ? freeze([]) : freeze(state.records.map(clone));
  }
  function append(input) {
    exact(input, ["binding", "audit"], "invalid_head_control_audit_append");
    const owner = identity(input.binding, "invalid_head_control_audit_append");
    const record = normalizeAuditRecord(input.audit);
    if (!sameIdentity(record.binding, owner)) fail("head_control_audit_append_identity_mismatch", "audit binding does not match project store");
    files.ensureDirectories(directories);
    const target = statePath(owner);
    return files.withWriterLock(target, () => {
      const current = readState(fs, target, owner, true) || {
        schema_version: SCHEMA_VERSION,
        binding: clone(owner),
        records: [],
      };
      const byCorrelation = current.records.find((entry) => entry.correlation_id === record.correlation_id);
      const byIdempotency = current.records.find((entry) => entry.idempotency_key === record.idempotency_key);
      if (byCorrelation || byIdempotency) {
        if (byCorrelation && byIdempotency && byCorrelation === byIdempotency && sameRecord(byCorrelation, record)) {
          return freeze({ record: freeze(clone(byCorrelation)), duplicate: true, rotated: 0, count: current.records.length });
        }
        if (byCorrelation) fail("head_control_audit_correlation_conflict", "correlation identity is already bound to another audit decision");
        fail("head_control_audit_idempotency_conflict", "idempotency identity is already bound to another audit decision");
      }
      const rotated = Math.max(0, current.records.length - MAX_RECORDS + 1);
      const records = rotated > 0 ? current.records.slice(rotated) : current.records.slice();
      records.push(record);
      const next = { schema_version: SCHEMA_VERSION, binding: clone(owner), records };
      writeStateAtomically(files, target, next, owner);
      return freeze({ record: freeze(clone(record)), duplicate: false, rotated, count: records.length });
    });
  }

  return freeze({ read, append });
}

module.exports = {
  SCHEMA_VERSION,
  FILE_MODE,
  DIRECTORY_MODE,
  MAX_RECORDS,
  HeadControlAuditStoreError,
  headControlAuditStorePath,
  createHeadControlAuditStore,
};
