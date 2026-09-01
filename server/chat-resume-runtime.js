"use strict";

// #1047 M4: the fixed HTTP composition boundary for Head's read-only Primary
// Chat recovery feed.  It has no route, filesystem, GitHub, queue-write, PTY
// write, or lifecycle mutation capability.  All authority comes from existing
// project admission, per-role shim-token, live-session, queue, and chat seams.

const { createChatResumeService } = require("./chat-resume-service");
const { createPrimaryChatResumeSource } = require("./primary-chat-resume-source");

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
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function unavailable() { throw new TypeError("chat resume is unavailable"); }

function binding(value) {
  exact(value, ["installation_id", "project_id", "agent_id", "generation"]);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) || value.agent_id !== "head" ||
      !nonnegativeInteger(value.generation)) {
    throw new TypeError("chat resume binding is invalid");
  }
  return Object.freeze({ ...value });
}
function sameBinding(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id &&
    left.agent_id === right.agent_id && left.generation === right.generation;
}
function request(value) {
  exact(value, ["method", "path", "body"]);
  if (value.method !== "POST" || value.path !== "/api/chat-resume" || !plain(value.body)) unavailable();
  const keys = Object.keys(value.body).sort();
  if (keys.length !== 2 || keys[0] !== "cursor" || keys[1] !== "limit" ||
      (value.body.cursor !== null && (typeof value.body.cursor !== "string" || value.body.cursor.length > 2048)) ||
      !Number.isSafeInteger(value.body.limit) || value.body.limit < 1 || value.body.limit > 64) {
    unavailable();
  }
  return Object.freeze({ cursor: value.body.cursor, limit: value.body.limit });
}
function auth(value) {
  exact(value, ["token"]);
  if (typeof value.token !== "string" || !TOKEN_RE.test(value.token)) unavailable();
  return value.token;
}

function createChatResumeRuntime(options) {
  exact(options, [
    "read_config", "capture_project_admission", "is_admission_current", "is_project_archived",
    "resolve_shim_principal", "agent_sessions", "read_live_batch_context",
    "read_primary_chat_source", "find_active_batch_start", "read_cursor_secret",
  ]);
  for (const name of [
    "read_config", "capture_project_admission", "is_admission_current", "is_project_archived",
    "resolve_shim_principal", "read_live_batch_context", "read_primary_chat_source",
    "find_active_batch_start", "read_cursor_secret",
  ]) {
    if (typeof options[name] !== "function") throw new TypeError("chat resume runtime dependencies are invalid");
  }
  if (!options.agent_sessions || typeof options.agent_sessions.get !== "function") {
    throw new TypeError("chat resume runtime dependencies are invalid");
  }
  const services = new Map();

  function currentBinding(token) {
    const principal = options.resolve_shim_principal(token);
    if (!principal || principal.agentId !== "head" || typeof principal.projectId !== "string" || !PROJECT_RE.test(principal.projectId)) unavailable();
    const admission = options.capture_project_admission(principal.projectId);
    if (!admission || admission.project_id !== principal.projectId || !nonnegativeInteger(admission.generation) ||
        options.is_admission_current(admission) !== true) unavailable();
    const config = options.read_config();
    if (!plain(config) || typeof config.installation_id !== "string" || !INSTALLATION_RE.test(config.installation_id) ||
        !Array.isArray(config.projects) || options.is_project_archived(principal.projectId, config)) unavailable();
    const projects = config.projects.filter((project) => plain(project) && project.id === principal.projectId && project.archived !== true);
    if (projects.length !== 1) unavailable();
    const session = options.agent_sessions.get(`${principal.projectId}/head`);
    if (!session || session.projectId !== principal.projectId || session.agentId !== "head" ||
        session.state !== "running" || !session.term || !["spawned", "verified"].includes(session.lifecycleState)) unavailable();
    return binding({
      installation_id: config.installation_id,
      project_id: principal.projectId,
      agent_id: "head",
      generation: admission.generation,
    });
  }

  function activeBatch(owner) {
    const context = options.read_live_batch_context(owner.project_id);
    const parsed = context?.parsed;
    const active = context?.activated === true && context?.queueReadOk === true &&
      context?.installationId === owner.installation_id && plain(parsed) && parsed.provenance === "owned" &&
      Number.isSafeInteger(parsed.batchNumber) && parsed.batchNumber >= 1 && Array.isArray(parsed.errors) && parsed.errors.length === 0 &&
      Array.isArray(parsed.workItems) && parsed.workItems.length > 0;
    if (!active) return Object.freeze({ state: "idle", batch_id: null, starts_after_id: 0, head_generation: owner.generation });
    const batch_id = `batch-${parsed.batchNumber}`;
    const starts_after_id = options.find_active_batch_start(Object.freeze({
      project_id: owner.project_id,
      batch_id,
      head_generation: owner.generation,
    }));
    if (!nonnegativeInteger(starts_after_id)) unavailable();
    return Object.freeze({ state: "active", batch_id, starts_after_id, head_generation: owner.generation });
  }

  function facts(owner, token) {
    // Re-prove launch identity immediately before each immutable snapshot.
    // A Head reset/archive/token rotation in between page reads cannot reuse a
    // cached service or project selector.
    const live = currentBinding(token);
    if (!sameBinding(live, owner)) unavailable();
    return Object.freeze({
      project_id: owner.project_id,
      archived: false,
      head: Object.freeze({ agent_id: "head", generation: owner.generation }),
      batch: activeBatch(owner),
    });
  }

  function serviceFor(owner, token) {
    // The binding generation is a project-admission generation, while a Head
    // restart rotates the shim token within that same generation.  Cache only
    // per launch token so a freshly spawned Head never inherits an old
    // closure's authorization proof.
    const key = `${owner.installation_id}:${owner.project_id}:${owner.generation}:${token}`;
    const existing = services.get(key);
    if (existing) return existing;
    const source = createPrimaryChatResumeSource({
      read_records: (projectId) => {
        if (projectId !== owner.project_id) unavailable();
        return options.read_primary_chat_source(projectId);
      },
      read_cursor_secret: (projectId) => {
        if (projectId !== owner.project_id) unavailable();
        return options.read_cursor_secret(projectId);
      },
    });
    const service = createChatResumeService({
      binding: owner,
      access: {
        authorize: ({ principal, binding: requested }) => {
          const live = currentBinding(token);
          if (!sameBinding(live, owner) || !sameBinding(principal, owner) || !sameBinding(requested, owner)) unavailable();
          return Object.freeze({ ...owner });
        },
        read_facts: () => facts(owner, token),
        read_snapshot: () => source({ project_id: owner.project_id, head: { agent_id: "head", generation: owner.generation } }),
      },
    });
    services.set(key, service);
    return service;
  }

  function handle(rawRequest, rawAuth) {
    try {
      const query = request(rawRequest);
      const token = auth(rawAuth);
      const owner = currentBinding(token);
      const result = serviceFor(owner, token).resume({ principal: owner, cursor: query.cursor, limit: query.limit });
      return Object.freeze({ ok: true, ...result });
    } catch {
      // Do not disclose whether the denial was project selection, token
      // rotation, archive, stale queue cache, or Primary Chat corruption.
      return Object.freeze({ ok: false, error: Object.freeze({ type: "chat_resume_unavailable" }) });
    }
  }

  function revokeProject(projectId) {
    if (typeof projectId !== "string" || !PROJECT_RE.test(projectId)) {
      return Object.freeze({
        ok: false,
        resources: Object.freeze({}),
        cleanup_errors: Object.freeze([{ resource: "chat_resume", code: "invalid_project" }]),
      });
    }
    let removed = 0;
    for (const [key] of services) {
      if (!key.includes(`:${projectId}:`)) continue;
      services.delete(key);
      removed += 1;
    }
    return Object.freeze({
      ok: true,
      resources: Object.freeze({ chat_resume_services: removed }),
      cleanup_errors: Object.freeze([]),
    });
  }

  return Object.freeze({ handle, revokeProject });
}

module.exports = { createChatResumeRuntime };
