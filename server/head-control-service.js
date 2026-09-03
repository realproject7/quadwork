"use strict";

// #1044 M3: a deliberately narrow durable adapter for the fixed Head-control
// plane.  It neither interprets pipeline commands nor talks to a transport:
// the plane remains the only route to the four owning domain callbacks and
// the audit store remains the only persistence authority.

const {
  ACTIONS,
  VERSION,
  createHeadControlPlane,
} = require("./head-control-plane");
const { MAX_RECORDS } = require("./head-control-audit-store");

const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^head_control_[a-z0-9_]{2,95}$/;
const ACTION_SET = new Set(ACTIONS);
const DECISION_SET = new Set(["accepted", "denied"]);
const READ_ACTIONS = new Set(["get_pipeline_status", "read_propagation_stop"]);
const PAYLOADLESS_ACTIONS = new Set(["get_pipeline_status", "freeze_batch_manifest", "retire_batch"]);

class HeadControlServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "HeadControlServiceError";
    this.code = code;
  }
}

function fail(code, message) { throw new HeadControlServiceError(code, message); }
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
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("head_control_audit_unavailable", "durable audit returned an invalid record");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  fail("head_control_audit_unavailable", "durable audit returned an invalid record");
}
function same(left, right) { return stable(left) === stable(right); }
function binding(value, code) {
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
function sameBinding(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id &&
    left.role === right.role && left.generation === right.generation;
}
function identifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail(code, "audit identity is invalid");
  return value;
}
function revision(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 1) fail(code, "audit revision is invalid");
  return value;
}
function digest(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "audit digest is invalid");
  return value;
}
function auditStatus(value, code) {
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
    fail(code, "audit status flags are invalid");
  }
  if (status.manifest_digest === null && (status.pipeline_digest !== null || status.manifest_frozen || status.cut_safe)) {
    fail(code, "audit status is inconsistent");
  }
  if (status.pipeline_digest !== null && !status.manifest_frozen) fail(code, "audit pipeline precedes manifest freeze");
  if (status.cut_safe && (status.archived || !status.manifest_frozen || status.pipeline_digest === null)) {
    fail(code, "audit cut-safe status is inconsistent");
  }
  return status;
}
function auditResult(value, action, code) {
  if (value === null) return null;
  exact(value, ["action", "applied", "status"], code);
  if (value.action !== action || typeof value.applied !== "boolean") fail(code, "audit result is invalid");
  return { action, applied: value.applied, status: auditStatus(value.status, code) };
}

// `head-control-audit-store` returns this redacted disk representation.  The
// service parses it again rather than treating storage as a trusted callback.
function durableAuditRecord(value, owner, code) {
  exact(value, ["version", "binding", "action", "correlation_id", "idempotency_key", "preconditions", "decision", "code", "result"], code);
  exact(value.preconditions, ["expected_revision"], code);
  if (value.version !== VERSION || typeof value.action !== "string" || !ACTION_SET.has(value.action) ||
      typeof value.decision !== "string" || !DECISION_SET.has(value.decision) ||
      typeof value.code !== "string" || !CODE_RE.test(value.code)) {
    fail(code, "durable audit outcome is invalid");
  }
  const record = {
    version: VERSION,
    binding: binding(value.binding, code),
    action: value.action,
    correlation_id: identifier(value.correlation_id, code),
    idempotency_key: identifier(value.idempotency_key, code),
    preconditions: { expected_revision: revision(value.preconditions.expected_revision, code, true) },
    decision: value.decision,
    code: value.code,
    result: auditResult(value.result, value.action, code),
  };
  if (!sameBinding(record.binding, owner)) fail(code, "durable audit belongs to another Head");
  if (record.decision === "accepted" && record.result === null) fail(code, "accepted durable audit has no result");
  return record;
}
function durableAuditSnapshot(value, owner) {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) {
    fail("head_control_audit_unavailable", "durable audit cannot be read");
  }
  const correlations = new Set();
  const idempotencies = new Set();
  const records = value.map((entry) => {
    const record = durableAuditRecord(entry, owner, "head_control_audit_unavailable");
    if (correlations.has(record.correlation_id) || idempotencies.has(record.idempotency_key)) {
      fail("head_control_audit_unavailable", "durable audit contains duplicate identities");
    }
    correlations.add(record.correlation_id);
    idempotencies.add(record.idempotency_key);
    return record;
  });
  return freeze(records);
}
function resultAuditProjection(value, owner) {
  exact(value, ["version", "binding", "action", "correlation_id", "idempotency_key", "expected_revision", "decision", "code", "result"], "head_control_audit_unavailable");
  return durableAuditRecord({
    version: value.version,
    binding: value.binding,
    action: value.action,
    correlation_id: value.correlation_id,
    idempotency_key: value.idempotency_key,
    preconditions: { expected_revision: value.expected_revision },
    decision: value.decision,
    code: value.code,
    result: value.result,
  }, owner, "head_control_audit_unavailable");
}
function auditStore(value) {
  exact(value, ["read", "append"], "invalid_head_control_service_options");
  if (typeof value.read !== "function" || typeof value.append !== "function") {
    fail("invalid_head_control_service_options", "audit_store must expose fixed read and append operations");
  }
  return value;
}
function appendReceipt(value, expected, owner) {
  exact(value, ["record", "duplicate", "rotated", "count"], "head_control_audit_unavailable");
  if (typeof value.duplicate !== "boolean" || !Number.isSafeInteger(value.rotated) || value.rotated < 0 ||
      !Number.isSafeInteger(value.count) || value.count < 1 || value.count > MAX_RECORDS) {
    fail("head_control_audit_unavailable", "durable audit append receipt is invalid");
  }
  if (!same(durableAuditRecord(value.record, owner, "head_control_audit_unavailable"), expected)) {
    fail("head_control_audit_unavailable", "durable audit append did not retain the control decision");
  }
}
function originalAudit(record) {
  return freeze({
    version: VERSION,
    binding: freeze(clone(record.binding)),
    action: record.action,
    correlation_id: record.correlation_id,
    idempotency_key: record.idempotency_key,
    expected_revision: record.preconditions.expected_revision,
    decision: record.decision,
    code: record.code,
    result: record.result === null ? null : freeze(clone(record.result)),
  });
}
function replay(record, detail = null) {
  const audit = originalAudit(record);
  // The durable receipt is redacted: a replay proven from it alone carries the
  // fixed result and no detail.  Only this process's own exact receipt can
  // restore the detail the plane returned.
  return freeze({
    version: VERSION,
    decision: freeze({ kind: "replayed", code: "head_control_duplicate_retry" }),
    result: audit.result === null ? null : freeze(clone(audit.result)),
    audit,
    detail: detail === null ? null : freeze(clone(detail)),
  });
}
function commandFingerprint(value) {
  try { return stable(value); } catch { return null; }
}
function commandMatchesDurablePayloadlessRecord(command, record, owner) {
  const code = "head_control_durable_replay_ambiguous";
  exact(command, ["version", "action", "principal", "expected_revision", "idempotency_key", "correlation_id", "payload"], code);
  if (command.version !== VERSION || command.action !== record.action || !PAYLOADLESS_ACTIONS.has(command.action) ||
      command.payload !== null || record.decision !== "accepted") {
    return false;
  }
  const commandBinding = binding(command.principal, code);
  const expectedRevision = revision(command.expected_revision, code, READ_ACTIONS.has(command.action));
  const idempotencyKey = identifier(command.idempotency_key, code);
  const correlationId = identifier(command.correlation_id, code);
  return sameBinding(commandBinding, owner) &&
    expectedRevision === record.preconditions.expected_revision &&
    idempotencyKey === record.idempotency_key && correlationId === record.correlation_id;
}

function createHeadControlService(options) {
  exact(options, ["binding", "domain", "audit_store"], "invalid_head_control_service_options");
  const owner = freeze(binding(options.binding, "invalid_head_control_service_options"));
  const store = auditStore(options.audit_store);
  // The closed M1 plane validates the exact domain callback keys and is the
  // only component that can invoke them.
  const plane = createHeadControlPlane({ binding: owner, domain: options.domain });
  const localIdempotencies = new Map();
  const localCorrelations = new Map();

  function readAuditOrFail() {
    try { return durableAuditSnapshot(store.read(owner), owner); }
    catch { fail("head_control_audit_unavailable", "durable Head-control audit is unavailable"); }
  }
  function remember(command, record, detail) {
    const fingerprint = commandFingerprint(command);
    if (fingerprint === null) return;
    const local = freeze({ fingerprint, record: freeze(clone(record)), detail: detail === null ? null : freeze(clone(detail)) });
    localIdempotencies.set(record.idempotency_key, local);
    localCorrelations.set(record.correlation_id, local);
  }
  function persistOrFail(result, command) {
    const expected = resultAuditProjection(result.audit, owner);
    try {
      const receipt = store.append({ binding: owner, audit: result.audit });
      appendReceipt(receipt, expected, owner);
      remember(command, expected, result.detail);
    } catch {
      // The domain result is intentionally not returned without its required
      // receipt. A later exact retry can re-read the plane receipt and append
      // it without a second owning-domain invocation.
      fail("head_control_audit_unavailable", "durable Head-control audit is unavailable");
    }
  }
  function durableReplayOrFail(command, records) {
    if (!plain(command)) return null;
    const byCorrelation = records.find((record) => record.correlation_id === command.correlation_id) || null;
    const byIdempotency = records.find((record) => record.idempotency_key === command.idempotency_key) || null;
    if (byCorrelation === null && byIdempotency === null) return null;
    if (byCorrelation === null || byIdempotency === null || byCorrelation !== byIdempotency) {
      fail("head_control_durable_identity_collision", "durable Head-control identity is already used");
    }
    const record = byCorrelation;
    const localByCorrelation = localCorrelations.get(record.correlation_id);
    const localByIdempotency = localIdempotencies.get(record.idempotency_key);
    const fingerprint = commandFingerprint(command);
    if (localByCorrelation && localByCorrelation === localByIdempotency &&
        same(localByCorrelation.record, record) && fingerprint !== null && localByCorrelation.fingerprint === fingerprint) {
      return replay(record, localByCorrelation.detail);
    }
    if (commandMatchesDurablePayloadlessRecord(command, record, owner)) return replay(record);
    // The durable format deliberately omits payloads.  Any request that is
    // not exactly provable from the fixed receipt, including put/cut after a
    // restart, remains ambiguous and must not reach the domain.
    fail("head_control_durable_replay_ambiguous", "durable Head-control receipt cannot prove this retry");
  }
  function execute(command) {
    // This preflight happens before the plane can reach a domain callback.
    // It also rejects corrupt, substituted, or unavailable durable state.
    const records = readAuditOrFail();
    const durableReplay = durableReplayOrFail(command, records);
    if (durableReplay !== null) return durableReplay;
    const result = plane.execute(command);
    persistOrFail(result, command);
    return result;
  }
  function recentAudit() {
    // A re-read is side-effect free and returns only the bounded redacted
    // receipt representation, in stable on-disk order.
    return readAuditOrFail();
  }

  return freeze({
    execute,
    recentAudit,
    binding: freeze(clone(owner)),
  });
}

module.exports = {
  HeadControlServiceError,
  createHeadControlService,
};
