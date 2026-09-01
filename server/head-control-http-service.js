"use strict";

// #1044 M4: the HTTP boundary for the fixed Head-control MCP shim.  This is
// deliberately a pure request adapter: it owns neither a listener nor a
// credential store.  The caller supplies opaque authentication context and
// the three live authorities below; this adapter proves their agreement
// before resolving, much less invoking, the Head-control service.

const API_PATH = "/api/head-control";
const VERSION = 1;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_AUDIT_RECORDS = 64;
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^head_control_[a-z0-9_]{2,95}$/;
const ACTIONS = Object.freeze([
  "get_pipeline_status",
  "put_batch_manifest",
  "freeze_batch_manifest",
  "cut_batch",
]);
const ACTION_SET = new Set(ACTIONS);
const ERROR_TYPES = Object.freeze(new Set([
  "not_found",
  "invalid_request",
  "authentication_failed",
  "binding_unavailable",
  "binding_inactive",
  "binding_mismatch",
  "service_unavailable",
]));

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, fields) {
  if (!plain(value)) throw new TypeError("object required");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError("unknown or missing field");
  }
}

function copyJson(value, depth = 0) {
  if (depth > 32) throw new TypeError("value is nested too deeply");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("number is invalid");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => copyJson(item, depth + 1));
  if (!plain(value)) throw new TypeError("value is not JSON data");
  const copied = Object.create(null);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copied, key, {
      value: copyJson(value[key], depth + 1), enumerable: true, writable: false, configurable: false,
    });
  }
  return Object.freeze(copied);
}

function boundedJson(value) {
  const copied = copyJson(value);
  if (Buffer.byteLength(JSON.stringify(copied), "utf8") > MAX_ARGUMENT_BYTES) {
    throw new TypeError("value exceeds fixed bound");
  }
  return copied;
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
    if (!Number.isFinite(value)) throw new TypeError("number is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  throw new TypeError("value is invalid");
}

function same(left, right) {
  return stable(left) === stable(right);
}

function identifier(value) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) throw new TypeError("identifier is invalid");
  return value;
}

function revision(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 1) {
    throw new TypeError("revision is invalid");
  }
  return value;
}

function digest(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new TypeError("digest is invalid");
  return value;
}

function code(value) {
  if (typeof value !== "string" || !CODE_RE.test(value)) throw new TypeError("code is invalid");
  return value;
}

function requestBinding(value) {
  exact(value, ["project_id", "actor", "generation"]);
  if (typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) ||
      typeof value.actor !== "string" || !IDENTIFIER_RE.test(value.actor) ||
      !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new TypeError("request binding is invalid");
  }
  return freeze({ project_id: value.project_id, actor: value.actor, generation: value.generation });
}

function authenticatedBinding(value) {
  // The authenticator is intentionally required to return only the public
  // binding proof, never a bearer token or the opaque auth context.
  const parsed = requestBinding(value);
  if (parsed.actor !== "head") throw new TypeError("authenticated actor is invalid");
  return parsed;
}

function liveBinding(value) {
  exact(value, ["installation_id", "project_id", "actor", "generation", "active", "archived"]);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) || value.actor !== "head" ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      typeof value.active !== "boolean" || typeof value.archived !== "boolean") {
    throw new TypeError("live binding is invalid");
  }
  return freeze({
    installation_id: value.installation_id,
    project_id: value.project_id,
    actor: "head",
    generation: value.generation,
    active: value.active,
    archived: value.archived,
  });
}

function serviceBinding(value) {
  return freeze({
    installation_id: value.installation_id,
    project_id: value.project_id,
    role: "head",
    generation: value.generation,
  });
}

function samePublicBinding(left, right) {
  return left.project_id === right.project_id && left.actor === right.actor && left.generation === right.generation;
}

function sameServiceBinding(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id &&
    left.role === right.role && left.generation === right.generation;
}

function commandArguments(tool, value) {
  if (!plain(value)) throw new TypeError("arguments must be an object");
  if (tool === "get_pipeline_status") {
    exact(value, ["idempotency_key", "correlation_id"]);
    return freeze({
      expected_revision: null,
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
      payload: null,
    });
  }
  if (tool === "freeze_batch_manifest") {
    exact(value, ["expected_revision", "idempotency_key", "correlation_id"]);
    return freeze({
      expected_revision: revision(value.expected_revision),
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
      payload: null,
    });
  }
  if (tool === "put_batch_manifest") {
    exact(value, ["expected_revision", "idempotency_key", "correlation_id", "manifest"]);
    if (!plain(value.manifest)) throw new TypeError("manifest is invalid");
    return freeze({
      expected_revision: revision(value.expected_revision),
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
      payload: freeze({ manifest: boundedJson(value.manifest) }),
    });
  }
  if (tool === "cut_batch") {
    exact(value, ["expected_revision", "idempotency_key", "correlation_id", "cut"]);
    if (!plain(value.cut)) throw new TypeError("cut is invalid");
    exact(value.cut, ["tasks"]);
    if (!Array.isArray(value.cut.tasks) || value.cut.tasks.length === 0 || value.cut.tasks.length > 64 ||
        !value.cut.tasks.every(plain)) throw new TypeError("cut is invalid");
    return freeze({
      expected_revision: revision(value.expected_revision),
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
      payload: freeze({ cut: boundedJson(value.cut) }),
    });
  }
  if (tool === "recent_head_control_audit") {
    exact(value, []);
    return null;
  }
  throw new TypeError("tool is invalid");
}

function envelope(value) {
  exact(value, ["version", "binding", "request"]);
  if (value.version !== VERSION) throw new TypeError("version is invalid");
  exact(value.request, ["tool", "arguments"]);
  if (typeof value.request.tool !== "string" ||
      !ACTION_SET.has(value.request.tool) && value.request.tool !== "recent_head_control_audit") {
    throw new TypeError("tool is invalid");
  }
  return freeze({
    binding: requestBinding(value.binding),
    tool: value.request.tool,
    arguments: commandArguments(value.request.tool, value.request.arguments),
  });
}

function status(value) {
  exact(value, ["revision", "archived", "manifest_digest", "pipeline_digest", "manifest_frozen", "cut_safe"]);
  const parsed = {
    revision: revision(value.revision),
    archived: value.archived,
    manifest_digest: digest(value.manifest_digest, true),
    pipeline_digest: digest(value.pipeline_digest, true),
    manifest_frozen: value.manifest_frozen,
    cut_safe: value.cut_safe,
  };
  if (typeof parsed.archived !== "boolean" || typeof parsed.manifest_frozen !== "boolean" || typeof parsed.cut_safe !== "boolean" ||
      (parsed.manifest_digest === null && (parsed.pipeline_digest !== null || parsed.manifest_frozen || parsed.cut_safe)) ||
      (parsed.pipeline_digest !== null && !parsed.manifest_frozen) ||
      (parsed.cut_safe && (parsed.archived || !parsed.manifest_frozen || parsed.pipeline_digest === null))) {
    throw new TypeError("status is invalid");
  }
  return freeze(parsed);
}

function actionResult(value, action) {
  if (value === null) return null;
  exact(value, ["action", "applied", "status"]);
  if (value.action !== action || typeof value.applied !== "boolean") throw new TypeError("result is invalid");
  return freeze({ action, applied: value.applied, status: status(value.status) });
}

function planeAudit(value, owner, action) {
  exact(value, ["version", "binding", "action", "correlation_id", "idempotency_key", "expected_revision", "decision", "code", "result"]);
  if (value.version !== VERSION || value.action !== action || value.decision !== "accepted" && value.decision !== "denied") {
    throw new TypeError("audit is invalid");
  }
  const parsedBinding = parseServiceBinding(value.binding);
  if (!sameServiceBinding(parsedBinding, owner)) throw new TypeError("audit binding is invalid");
  return freeze({
    version: VERSION,
    binding: parsedBinding,
    action,
    correlation_id: identifier(value.correlation_id),
    idempotency_key: identifier(value.idempotency_key),
    expected_revision: revision(value.expected_revision, action === "get_pipeline_status"),
    decision: value.decision,
    code: code(value.code),
    result: actionResult(value.result, action),
  });
}

function parseServiceBinding(value) {
  exact(value, ["installation_id", "project_id", "role", "generation"]);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) || value.role !== "head" ||
      !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new TypeError("service binding is invalid");
  }
  return freeze({
    installation_id: value.installation_id,
    project_id: value.project_id,
    role: "head",
    generation: value.generation,
  });
}

function commandResult(value, owner, action) {
  exact(value, ["version", "decision", "result", "audit"]);
  exact(value.decision, ["kind", "code"]);
  if (value.version !== VERSION || !["accepted", "denied", "replayed"].includes(value.decision.kind)) {
    throw new TypeError("command result is invalid");
  }
  const audit = planeAudit(value.audit, owner, action);
  const result = actionResult(value.result, action);
  const decision = freeze({ kind: value.decision.kind, code: code(value.decision.code) });
  if (!same(result, audit.result) ||
      (decision.kind === "replayed" && decision.code !== "head_control_duplicate_retry") ||
      (decision.kind !== "replayed" && (decision.kind !== audit.decision || decision.code !== audit.code))) {
    throw new TypeError("command receipt is invalid");
  }
  return freeze({ version: VERSION, decision, result, audit });
}

function durableAudit(value, owner) {
  exact(value, ["version", "binding", "action", "correlation_id", "idempotency_key", "preconditions", "decision", "code", "result"]);
  exact(value.preconditions, ["expected_revision"]);
  if (value.version !== VERSION || !ACTION_SET.has(value.action) || value.decision !== "accepted" && value.decision !== "denied") {
    throw new TypeError("durable audit is invalid");
  }
  const auditBinding = parseServiceBinding(value.binding);
  if (!sameServiceBinding(auditBinding, owner)) throw new TypeError("durable audit binding is invalid");
  return freeze({
    version: VERSION,
    binding: auditBinding,
    action: value.action,
    correlation_id: identifier(value.correlation_id),
    idempotency_key: identifier(value.idempotency_key),
    preconditions: freeze({ expected_revision: revision(value.preconditions.expected_revision, value.action === "get_pipeline_status") }),
    decision: value.decision,
    code: code(value.code),
    result: actionResult(value.result, value.action),
  });
}

function recentAudit(value, owner) {
  if (!Array.isArray(value) || value.length > MAX_AUDIT_RECORDS) throw new TypeError("recent audit is invalid");
  const correlations = new Set();
  const idempotencies = new Set();
  const records = value.map((record) => {
    const parsed = durableAudit(record, owner);
    if (correlations.has(parsed.correlation_id) || idempotencies.has(parsed.idempotency_key)) {
      throw new TypeError("recent audit is ambiguous");
    }
    correlations.add(parsed.correlation_id);
    idempotencies.add(parsed.idempotency_key);
    return parsed;
  });
  return freeze(records);
}

function service(value, owner) {
  exact(value, ["execute", "recentAudit", "binding"]);
  if (typeof value.execute !== "function" || typeof value.recentAudit !== "function" ||
      !sameServiceBinding(parseServiceBinding(value.binding), owner)) {
    throw new TypeError("service is invalid");
  }
  return value;
}

function failure(type) {
  if (!ERROR_TYPES.has(type)) throw new TypeError("error type is invalid");
  return freeze({ ok: false, error: freeze({ type }) });
}

function success(result) {
  return freeze({ ok: true, result });
}

function createHeadControlHttpService(options) {
  exact(options, ["authenticateToken", "resolveLaunchBinding", "resolveHeadControlService"]);
  if (typeof options.authenticateToken !== "function" || typeof options.resolveLaunchBinding !== "function" ||
      typeof options.resolveHeadControlService !== "function") {
    throw new TypeError("Head-control HTTP dependencies are required");
  }

  function handle(request, authContext) {
    let parsedRequest;
    try {
      exact(request, ["method", "path", "body"]);
      if (request.method !== "POST" || request.path !== API_PATH) return failure("not_found");
      parsedRequest = envelope(request.body);
    } catch {
      return failure("invalid_request");
    }

    let authenticated;
    try { authenticated = authenticatedBinding(options.authenticateToken(authContext)); }
    catch { return failure("authentication_failed"); }
    // Reject a user-supplied project, actor, or generation before consulting
    // the live resolver.  It must never be able to steer the service lookup.
    if (!samePublicBinding(authenticated, parsedRequest.binding)) return failure("binding_mismatch");

    let live;
    try { live = liveBinding(options.resolveLaunchBinding(authenticated)); }
    catch { return failure("binding_unavailable"); }
    if (!live.active || live.archived) return failure("binding_inactive");
    if (!samePublicBinding(live, authenticated) || !samePublicBinding(live, parsedRequest.binding)) {
      return failure("binding_mismatch");
    }
    const owner = serviceBinding(live);

    let resolved;
    try { resolved = service(options.resolveHeadControlService(owner), owner); }
    catch { return failure("service_unavailable"); }
    try {
      if (parsedRequest.tool === "recent_head_control_audit") {
        return success(recentAudit(resolved.recentAudit(), owner));
      }
      const command = freeze({
        version: VERSION,
        action: parsedRequest.tool,
        principal: owner,
        expected_revision: parsedRequest.arguments.expected_revision,
        idempotency_key: parsedRequest.arguments.idempotency_key,
        correlation_id: parsedRequest.arguments.correlation_id,
        payload: parsedRequest.arguments.payload,
      });
      return success(commandResult(resolved.execute(command), owner, parsedRequest.tool));
    } catch {
      // Error objects can contain token, path, or backend diagnostics.  The
      // boundary intentionally emits one fixed type instead of forwarding any
      // untrusted detail.
      return failure("service_unavailable");
    }
  }

  return freeze({ handle });
}

module.exports = {
  API_PATH,
  VERSION,
  ACTIONS,
  ERROR_TYPES,
  createHeadControlHttpService,
};
