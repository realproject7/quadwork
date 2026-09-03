"use strict";

// #1044 M1: bounded Head control for the WorkTask pipeline only.  This is a
// domain command boundary, not a general control framework: it has one bound
// Head/project/generation, four named actions, and delegates each mutation to
// the owning pipeline domain action.  It has no HTTP, MCP, process, monitor,
// filesystem, delivery, or dynamic-handler authority.

const crypto = require("node:crypto");

const VERSION = 1;
const MAX_AUDIT_RECORDS = 128;
const MAX_IDEMPOTENCY_RECORDS = 64;
const MAX_CUT_TASKS = 64;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ACTIONS = Object.freeze([
  "get_pipeline_status",
  "put_batch_manifest",
  "freeze_batch_manifest",
  "cut_batch",
]);
const ACTION_SET = new Set(ACTIONS);

class HeadControlPlaneError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "HeadControlPlaneError";
    this.code = code;
  }
}

function fail(code, message) { throw new HeadControlPlaneError(code, message); }
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
    if (!Number.isFinite(value)) fail("invalid_head_control_request", "request contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  fail("invalid_head_control_request", "request contains an unsupported value");
}
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function assertBoundedPayload(value) {
  if (Buffer.byteLength(stable(value), "utf8") > MAX_PAYLOAD_BYTES) {
    fail("invalid_head_control_request", "request payload exceeds the M1 bound");
  }
}

function principal(value, code) {
  exact(value, ["installation_id", "project_id", "role", "generation"], code);
  if (!INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id) ||
      typeof value.role !== "string" || !ROLE_RE.test(value.role) ||
      !Number.isSafeInteger(value.generation) || value.generation < 0) {
    fail(code, "control principal is invalid");
  }
  return {
    installation_id: value.installation_id,
    project_id: value.project_id,
    role: value.role,
    generation: value.generation,
  };
}
function binding(value, code) {
  const parsed = principal(value, code);
  if (parsed.role !== "head") fail(code, "Head binding is invalid");
  return parsed;
}
function identifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail(code, "idempotency or correlation identifier is invalid");
  return value;
}
function revision(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 1) fail(code, "optimistic revision is invalid");
  return value;
}
function digest(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "digest is invalid");
  return value;
}
function assertPipelineStatus(value, code) {
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
    fail(code, "pipeline status flags are invalid");
  }
  if (status.manifest_digest === null && (status.pipeline_digest !== null || status.manifest_frozen || status.cut_safe)) {
    fail(code, "empty pipeline status is inconsistent");
  }
  if (status.pipeline_digest !== null && !status.manifest_frozen) {
    fail(code, "pipeline cannot exist before manifest freeze");
  }
  if (status.cut_safe && (status.archived || !status.manifest_frozen || status.pipeline_digest === null)) {
    fail(code, "cut-safe status is inconsistent");
  }
  return status;
}
function summary(status) {
  return status === null ? null : {
    revision: status.revision,
    archived: status.archived,
    manifest_digest: status.manifest_digest,
    pipeline_digest: status.pipeline_digest,
    manifest_frozen: status.manifest_frozen,
    cut_safe: status.cut_safe,
  };
}
function assertPutPayload(value) {
  exact(value, ["manifest"], "invalid_head_control_request");
  if (!plain(value.manifest)) fail("invalid_head_control_request", "batch manifest payload is invalid");
  assertBoundedPayload(value.manifest);
  return { manifest: clone(value.manifest) };
}
function assertCutPayload(value) {
  exact(value, ["cut"], "invalid_head_control_request");
  if (!plain(value.cut) || !Array.isArray(value.cut.tasks) || value.cut.tasks.length === 0 || value.cut.tasks.length > MAX_CUT_TASKS ||
      !value.cut.tasks.every(plain)) {
    fail("invalid_head_control_request", "cut payload is invalid");
  }
  assertBoundedPayload(value.cut);
  // The owning WorkTask pipeline validates the exact refs/candidates and owns
  // the cut semantics.  This core only rejects an empty/unbounded request.
  return { cut: clone(value.cut) };
}
function request(value) {
  exact(value, ["version", "action", "principal", "expected_revision", "idempotency_key", "correlation_id", "payload"], "invalid_head_control_request");
  if (value.version !== VERSION || typeof value.action !== "string" || !ACTION_SET.has(value.action)) {
    fail(value.action && !ACTION_SET.has(value.action) ? "head_control_action_unsupported" : "invalid_head_control_request", "action is invalid");
  }
  const parsed = {
    version: VERSION,
    action: value.action,
    principal: principal(value.principal, "invalid_head_control_request"),
    expected_revision: revision(value.expected_revision, "invalid_head_control_request", value.action === "get_pipeline_status"),
    idempotency_key: identifier(value.idempotency_key, "invalid_head_control_request"),
    correlation_id: identifier(value.correlation_id, "invalid_head_control_request"),
    payload: null,
  };
  if (value.action === "get_pipeline_status" || value.action === "freeze_batch_manifest") {
    if (value.payload !== null) fail("invalid_head_control_request", "action does not accept payload");
  } else if (value.action === "put_batch_manifest") {
    parsed.payload = assertPutPayload(value.payload);
  } else {
    parsed.payload = assertCutPayload(value.payload);
  }
  if (value.action === "get_pipeline_status") {
    if (parsed.expected_revision !== null) fail("invalid_head_control_request", "status action cannot pin a write revision");
  } else if (parsed.expected_revision === null) {
    fail("invalid_head_control_request", "mutating action requires an optimistic revision");
  }
  return parsed;
}
function requestFingerprint(value) {
  return hash({
    action: value.action,
    principal: value.principal,
    expected_revision: value.expected_revision,
    idempotency_key: value.idempotency_key,
    correlation_id: value.correlation_id,
    payload: value.payload,
  });
}
function invocation(value) {
  return freeze({
    version: VERSION,
    action: value.action,
    binding: freeze(clone(value.principal)),
    expected_revision: value.expected_revision,
    correlation_id: value.correlation_id,
    idempotency_key: value.idempotency_key,
    payload: value.payload === null ? null : freeze(clone(value.payload)),
  });
}

function createHeadControlPlane(options) {
  exact(options, ["binding", "domain"], "invalid_head_control_options");
  const bound = binding(options.binding, "invalid_head_control_options");
  exact(options.domain, ACTIONS, "invalid_head_control_options");
  for (const action of ACTIONS) {
    if (typeof options.domain[action] !== "function") fail("invalid_head_control_options", `${action} domain action is required`);
  }
  const domain = options.domain;
  const idempotency = new Map();
  const correlations = new Map();
  const audit = [];

  function appendAudit(record) {
    if (audit.length >= MAX_AUDIT_RECORDS) audit.shift();
    audit.push(freeze(clone(record)));
  }
  function response(input, decision, code, status, applied) {
    const result = status === null ? null : freeze({
      action: input.action,
      applied,
      status: freeze(summary(status)),
    });
    const auditRecord = freeze({
      version: VERSION,
      binding: freeze(clone(bound)),
      action: input.action,
      correlation_id: input.correlation_id,
      idempotency_key: input.idempotency_key,
      expected_revision: input.expected_revision,
      decision,
      code,
      result: result === null ? null : clone(result),
    });
    appendAudit(auditRecord);
    return freeze({
      version: VERSION,
      decision: freeze({ kind: decision, code }),
      result,
      audit: auditRecord,
    });
  }
  function deny(input, code, status = null) {
    return response(input, "denied", code, status, false);
  }
  function replay(cached) {
    return freeze({
      version: VERSION,
      decision: freeze({ kind: "replayed", code: "head_control_duplicate_retry" }),
      result: cached.result === null ? null : freeze(clone(cached.result)),
      // The original immutable audit is the durable record of the one domain
      // invocation.  A replay intentionally creates no second mutation/audit.
      audit: cached.audit,
    });
  }
  function cache(input, fingerprint, result) {
    // Bounded oldest-first window: both maps hold the same record, so the
    // evicted idempotency entry drops its correlation entry with it.
    if (idempotency.size >= MAX_IDEMPOTENCY_RECORDS) {
      const oldestKey = idempotency.keys().next().value;
      correlations.delete(idempotency.get(oldestKey).correlation_id);
      idempotency.delete(oldestKey);
    }
    const record = freeze({ fingerprint, correlation_id: input.correlation_id, result });
    idempotency.set(input.idempotency_key, record);
    correlations.set(input.correlation_id, record);
  }
  function preflightBinding(input) {
    if (input.principal.role !== "head") return "head_control_role_denied";
    if (input.principal.installation_id !== bound.installation_id || input.principal.project_id !== bound.project_id) return "head_control_project_denied";
    if (input.principal.generation !== bound.generation) return "head_control_generation_stale";
    return null;
  }
  function ownedStatus(input) {
    let observed;
    try { observed = domain.get_pipeline_status(invocation(input)); }
    catch { return { error: "head_control_domain_unavailable" }; }
    try { return { status: assertPipelineStatus(observed, "head_control_domain_invalid_status") }; }
    catch { return { error: "head_control_domain_invalid_status" }; }
  }
  function invokeMutation(input, prior) {
    let observed;
    try { observed = domain[input.action](invocation(input)); }
    catch { return { error: input.action === "cut_batch" ? "head_control_unsafe_cut" : "head_control_domain_rejected" }; }
    try {
      const status = assertPipelineStatus(observed, "head_control_domain_invalid_status");
      if (status.revision !== prior.revision + 1) return { error: "head_control_domain_invalid_status" };
      if (status.archived) return { error: "head_control_domain_invalid_transition" };
      if (input.action === "put_batch_manifest" &&
          (status.manifest_digest === null || status.manifest_frozen || status.pipeline_digest !== null || status.cut_safe)) {
        return { error: "head_control_domain_invalid_transition" };
      }
      if (input.action === "freeze_batch_manifest" &&
          (!status.manifest_frozen || status.pipeline_digest === null)) {
        return { error: "head_control_domain_invalid_transition" };
      }
      if (input.action === "cut_batch" &&
          (!status.manifest_frozen || status.pipeline_digest === null || status.pipeline_digest === prior.pipeline_digest)) {
        return { error: "head_control_domain_invalid_transition" };
      }
      return { status };
    } catch { return { error: "head_control_domain_invalid_status" }; }
  }

  function execute(command) {
    const input = request(command);
    const bindingDenial = preflightBinding(input);
    if (bindingDenial !== null) return deny(input, bindingDenial);

    const fingerprint = requestFingerprint(input);
    const byIdempotency = idempotency.get(input.idempotency_key);
    const byCorrelation = correlations.get(input.correlation_id);
    if (byIdempotency || byCorrelation) {
      if (byIdempotency && byCorrelation && byIdempotency === byCorrelation && byIdempotency.fingerprint === fingerprint) {
        return replay(byIdempotency.result);
      }
      if (byIdempotency) return deny(input, "head_control_idempotency_reused");
      return deny(input, "head_control_correlation_reused");
    }
    const observed = ownedStatus(input);
    if (observed.error) {
      const result = deny(input, observed.error);
      cache(input, fingerprint, result);
      return result;
    }
    const status = observed.status;
    if (input.action === "get_pipeline_status") {
      const result = response(input, "accepted", "head_control_status_observed", status, false);
      cache(input, fingerprint, result);
      return result;
    }
    if (status.archived) {
      const result = deny(input, "head_control_archived", status);
      cache(input, fingerprint, result);
      return result;
    }
    if (input.expected_revision !== status.revision) {
      const result = deny(input, "head_control_stale_revision", status);
      cache(input, fingerprint, result);
      return result;
    }
    if (input.action === "put_batch_manifest" && status.manifest_digest !== null) {
      const result = deny(input, "head_control_manifest_already_present", status);
      cache(input, fingerprint, result);
      return result;
    }
    if (input.action === "freeze_batch_manifest" && (status.manifest_digest === null || status.manifest_frozen)) {
      const result = deny(input, "head_control_freeze_unsafe", status);
      cache(input, fingerprint, result);
      return result;
    }
    if (input.action === "cut_batch" && (!status.manifest_frozen || status.pipeline_digest === null || !status.cut_safe)) {
      const result = deny(input, "head_control_unsafe_cut", status);
      cache(input, fingerprint, result);
      return result;
    }
    const mutation = invokeMutation(input, status);
    const result = mutation.error
      ? deny(input, mutation.error, status)
      : response(input, "accepted", "head_control_applied", mutation.status, true);
    cache(input, fingerprint, result);
    return result;
  }

  return freeze({
    execute,
    auditSnapshot() { return freeze(audit.map(clone)); },
    binding: freeze(clone(bound)),
  });
}

module.exports = {
  VERSION,
  ACTIONS,
  MAX_AUDIT_RECORDS,
  MAX_IDEMPOTENCY_RECORDS,
  MAX_PAYLOAD_BYTES,
  HeadControlPlaneError,
  createHeadControlPlane,
};
