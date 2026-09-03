"use strict";

// #1044 M5: server-owned composition for the fixed Head-control HTTP adapter.
// The MCP launch token is deliberately shared with the already established
// file-chat principal registry.  A token must therefore prove both its local
// launch binding and its current file-chat Head principal before the adapter
// can even inspect a command envelope.

const { createHeadControlHttpService } = require("./head-control-http-service");
const { createHeadControlWorkTaskDomain } = require("./head-control-work-task-domain");
const { createHeadControlAuditStore } = require("./head-control-audit-store");
const { createHeadControlService } = require("./head-control-service");
const { createLiveWorkTaskIdentityResolver } = require("./live-work-task-identity-resolver");

const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_RE = /^[^\s\r\n]{16,512}$/;

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, fields) {
  if (!plain(value)) throw new TypeError("value must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new TypeError("value has unknown or missing fields");
  }
}

function binding(value) {
  exact(value, ["installation_id", "project_id", "role", "generation"]);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) || value.role !== "head" ||
      !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new TypeError("Head-control binding is invalid");
  }
  return Object.freeze({
    installation_id: value.installation_id,
    project_id: value.project_id,
    role: "head",
    generation: value.generation,
  });
}

function publicBinding(value) {
  exact(value, ["project_id", "actor", "generation"]);
  if (typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) || value.actor !== "head" ||
      !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new TypeError("Head-control public binding is invalid");
  }
  return Object.freeze({ project_id: value.project_id, actor: "head", generation: value.generation });
}

function samePublicBinding(left, right) {
  return left.project_id === right.project_id && left.actor === right.actor && left.generation === right.generation;
}

function runtimeKey(value) {
  return `${value.installation_id}:${value.project_id}:${value.generation}`;
}

function createHeadControlRuntime(options) {
  exact(options, [
    "config_dir", "fs", "read_config", "capture_project_admission", "is_project_archived",
    "resolve_shim_principal", "agent_sessions", "read_live_batch_context", "read_repository_state",
    "read_cached_repository_snapshot", "now",
  ]);
  if (typeof options.config_dir !== "string" || !options.config_dir || !options.fs ||
      typeof options.read_config !== "function" || typeof options.capture_project_admission !== "function" ||
      typeof options.is_project_archived !== "function" || typeof options.resolve_shim_principal !== "function" ||
      !options.agent_sessions || typeof options.agent_sessions.get !== "function" ||
      typeof options.read_live_batch_context !== "function" || typeof options.read_repository_state !== "function" ||
      typeof options.read_cached_repository_snapshot !== "function" || typeof options.now !== "function") {
    throw new TypeError("Head-control runtime dependencies are invalid");
  }

  // Each project has one active Head launch credential.  The separate map is
  // intentionally not a general token registry; registration replaces the
  // preceding Head token just as file-chat's per-agent registry does.
  const tokens = new Map();
  const tokenByProject = new Map();
  const services = new Map();

  function currentReadBinding(projectId) {
    if (typeof projectId !== "string" || !PROJECT_RE.test(projectId)) {
      throw new TypeError("Current Batch project is invalid");
    }
    // Read admission both sides of config inspection. This is a local read
    // capability for the operator surface, not a Head launch capability, but
    // it must still fail closed across archive/recreate transitions.
    const before = options.capture_project_admission(projectId);
    const config = options.read_config();
    const after = options.capture_project_admission(projectId);
    if (!plain(before) || !plain(after) || before.project_id !== projectId || after.project_id !== projectId ||
        !Number.isSafeInteger(before.generation) || before.generation < 0 || before.generation !== after.generation ||
        !plain(config) || typeof config.installation_id !== "string" || !INSTALLATION_RE.test(config.installation_id) ||
        !Array.isArray(config.projects) || options.is_project_archived(projectId, config) ||
        config.projects.filter((entry) => plain(entry) && entry.id === projectId && entry.archived !== true).length !== 1) {
      throw new TypeError("Current Batch project is unavailable");
    }
    return binding({
      installation_id: config.installation_id,
      project_id: projectId,
      role: "head",
      generation: before.generation,
    });
  }

  function resolveOwnedDomain(owner) {
    const resolver = createLiveWorkTaskIdentityResolver({
      read_live_batch_context: options.read_live_batch_context,
      read_repository_state: options.read_repository_state,
      read_cached_repository_snapshot: options.read_cached_repository_snapshot,
    });
    return createHeadControlWorkTaskDomain({
      binding: owner,
      config_dir: options.config_dir,
      fs: options.fs,
      resolve_registered_identity: resolver,
      now: options.now,
    });
  }

  function registerHeadToken(value) {
    exact(value, ["project_id", "generation", "token"]);
    if (typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) ||
        !Number.isSafeInteger(value.generation) || value.generation < 0 ||
        typeof value.token !== "string" || !TOKEN_RE.test(value.token)) {
      throw new TypeError("Head-control launch token is invalid");
    }
    const config = options.read_config();
    if (!plain(config) || typeof config.installation_id !== "string" || !INSTALLATION_RE.test(config.installation_id) ||
        !Array.isArray(config.projects) || options.is_project_archived(value.project_id, config) ||
        config.projects.filter((entry) => plain(entry) && entry.id === value.project_id && entry.archived !== true).length !== 1) {
      throw new TypeError("Head-control launch project is unavailable");
    }
    const old = tokenByProject.get(value.project_id);
    if (old) tokens.delete(old);
    tokens.set(value.token, Object.freeze({
      installation_id: config.installation_id,
      project_id: value.project_id,
      actor: "head",
      generation: value.generation,
    }));
    tokenByProject.set(value.project_id, value.token);
    return Object.freeze({ project_id: value.project_id, actor: "head", generation: value.generation });
  }

  function authenticateToken(authContext) {
    exact(authContext, ["token"]);
    if (typeof authContext.token !== "string") throw new TypeError("Head-control token is absent");
    const registered = tokens.get(authContext.token);
    if (!registered) throw new TypeError("Head-control token is unknown");
    const principal = options.resolve_shim_principal(authContext.token);
    if (!principal || principal.projectId !== registered.project_id || principal.agentId !== "head") {
      throw new TypeError("Head-control token no longer has its file-chat principal");
    }
    return publicBinding({ project_id: registered.project_id, actor: "head", generation: registered.generation });
  }

  function resolveLaunchBinding(authenticated) {
    const requested = publicBinding(authenticated);
    const currentToken = tokenByProject.get(requested.project_id);
    const registered = currentToken ? tokens.get(currentToken) : null;
    if (!registered || registered.project_id !== requested.project_id || registered.generation !== requested.generation) {
      throw new TypeError("Head-control launch token is stale");
    }
    const admission = options.capture_project_admission(requested.project_id);
    if (!admission || admission.project_id !== requested.project_id || admission.generation !== requested.generation) {
      throw new TypeError("Head-control admission is stale");
    }
    const config = options.read_config();
    if (!plain(config) || typeof config.installation_id !== "string" || !INSTALLATION_RE.test(config.installation_id) ||
        config.installation_id !== registered.installation_id || !Array.isArray(config.projects) ||
        options.is_project_archived(requested.project_id, config)) {
      throw new TypeError("Head-control project is unavailable");
    }
    const project = config.projects.filter((entry) => plain(entry) && entry.id === requested.project_id);
    if (project.length !== 1 || project[0].archived === true) throw new TypeError("Head-control project is unavailable");
    const session = options.agent_sessions.get(`${requested.project_id}/head`);
    const active = !!session && session.projectId === requested.project_id && session.agentId === "head" &&
      session.state === "running" && !!session.term && session.lifecycleState === "verified";
    return Object.freeze({
      installation_id: config.installation_id,
      project_id: requested.project_id,
      actor: "head",
      generation: requested.generation,
      active,
      archived: false,
    });
  }

  function resolveHeadControlService(value) {
    const owner = binding(value);
    const key = runtimeKey(owner);
    const existing = services.get(key);
    if (existing) return existing;
    const domain = resolveOwnedDomain(owner);
    // Bootstrap is private runtime composition, never a fifth MCP operation.
    domain.initialize();
    const audit_store = createHeadControlAuditStore({ config_dir: options.config_dir, fs: options.fs });
    const service = createHeadControlService({ binding: owner, domain, audit_store });
    services.set(key, service);
    return service;
  }

  // This is intentionally a fixed, read-only runtime seam for the local
  // operator surface. It does not require a running Head or a launch token,
  // cannot initialize missing state, and exposes only the redacted nested
  // projection owned by the durable Head domain.
  function readCurrentBatchProjection(value) {
    exact(value, ["project_id"]);
    const owner = currentReadBinding(value.project_id);
    const domain = resolveOwnedDomain(owner);
    try {
      const projection = domain.project_current_batch();
      return Object.freeze({ active: projection !== null, projection });
    } catch (error) {
      // A state file left by a superseded generation reads as "no current
      // batch" here, exactly like a missing one.  Adoption is `initialize()`'s
      // job and happens on the new Head's first command; until then this
      // read-only operator surface must stay quiet rather than throw, or the
      // Current Batch panel breaks for the whole window between an unarchive
      // and that first command.
      if (error && (error.code === "head_control_work_task_state_missing" ||
                    error.code === "head_control_work_task_state_identity_mismatch")) {
        return Object.freeze({ active: false, projection: null });
      }
      throw error;
    }
  }

  function revokeProject(projectId) {
    if (typeof projectId !== "string" || !PROJECT_RE.test(projectId)) {
      return Object.freeze({ ok: false, resources: Object.freeze({}), cleanup_errors: Object.freeze([{ resource: "head_control", code: "invalid_project" }]) });
    }
    const token = tokenByProject.get(projectId);
    let removed = 0;
    if (token) {
      tokenByProject.delete(projectId);
      if (tokens.delete(token)) removed += 1;
    }
    for (const [key] of services) {
      if (!key.includes(`:${projectId}:`)) continue;
      services.delete(key);
      removed += 1;
    }
    return Object.freeze({ ok: true, resources: Object.freeze({ head_control_bindings: removed }), cleanup_errors: Object.freeze([]) });
  }

  const http = createHeadControlHttpService({ authenticateToken, resolveLaunchBinding, resolveHeadControlService });
  return Object.freeze({ registerHeadToken, revokeProject, readCurrentBatchProjection, handle: http.handle });
}

module.exports = { createHeadControlRuntime };
