"use strict";

// #1058 M9: fixed Head-token transport for the server-owned build assignment.
// The request can name only an exact current WorkTask and event id.  Principal,
// project, Dev readiness, live Issue contract, base observer, and persistence
// service are composed by the server.

const { assertWorkTaskRef } = require("./work-task-manifest");
const { workItemKey } = require("./work-item-ref");

const VERSION = 1;

class WorkTaskBuildRuntimeError extends Error {
  constructor(code, message = code) { super(message); this.name = "WorkTaskBuildRuntimeError"; this.code = code; }
}
function fail(code, message) { throw new WorkTaskBuildRuntimeError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function clone(value) {
  return Array.isArray(value) ? value.map(clone) : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function safeCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code) ? error.code : fallback;
}
function reference(value) {
  try { assertWorkTaskRef(value); }
  catch { fail("invalid_work_task_build_request", "work task reference is invalid"); }
  return clone(value);
}
function token(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    fail("work_task_build_principal_unavailable", "build principal is unavailable");
  }
  return value;
}
function options(value) {
  exact(value, [
    "config_dir", "fs", "capture_project_admission", "is_admission_current", "resolve_shim_principal", "agent_sessions",
    "read_live_batch_context", "read_repository_state", "read_cached_repository_snapshot", "create_live_identity_resolver",
    "create_assignment_service", "read_registered_base",
  ], "invalid_work_task_build_runtime_options");
  if (typeof value.config_dir !== "string" || !value.fs || typeof value.capture_project_admission !== "function" ||
      typeof value.is_admission_current !== "function" || typeof value.resolve_shim_principal !== "function" ||
      !value.agent_sessions || typeof value.agent_sessions.get !== "function" || typeof value.read_live_batch_context !== "function" ||
      typeof value.read_repository_state !== "function" || typeof value.read_cached_repository_snapshot !== "function" ||
      typeof value.create_live_identity_resolver !== "function" || typeof value.create_assignment_service !== "function" ||
      typeof value.read_registered_base !== "function") {
    fail("invalid_work_task_build_runtime_options", "runtime dependencies are invalid");
  }
  return value;
}
function sameLiveIdentity(ref, identity) {
  try {
    return identity && identity.installation_id === ref.installation_id && identity.project_id === ref.project_id &&
      identity.repository_key === ref.repository_key && identity.issue_body_revision === ref.issue_body_revision &&
      identity.work_item && workItemKey(identity.work_item) === workItemKey(ref.work_item);
  } catch {
    return false;
  }
}

function createWorkTaskBuildRuntime(value) {
  const deps = options(value);
  function activeHead(rawToken) {
    let principal;
    try { principal = deps.resolve_shim_principal(token(rawToken)); }
    catch { fail("work_task_build_principal_unavailable", "build principal is unavailable"); }
    if (!principal || typeof principal.projectId !== "string" || principal.agentId !== "head") {
      fail("work_task_build_principal_unavailable", "build principal is unavailable");
    }
    let admission;
    try { admission = deps.capture_project_admission(principal.projectId); }
    catch { fail("work_task_build_principal_unavailable", "build principal is unavailable"); }
    let current = false;
    try { current = deps.is_admission_current(admission) === true; }
    catch { current = false; }
    const head = deps.agent_sessions.get(`${principal.projectId}/head`);
    const dev = deps.agent_sessions.get(`${principal.projectId}/dev`);
    const verified = (session, role) => session && session.projectId === principal.projectId && session.agentId === role &&
      session.state === "running" && !!session.term && session.lifecycleState === "verified";
    if (!current || !verified(head, "head") || !verified(dev, "dev")) {
      fail("work_task_build_principal_unavailable", "Head and Dev must both be verified");
    }
    return freeze({ project_id: principal.projectId });
  }
  function assertLiveCurrent(ref) {
    let resolve;
    try {
      resolve = deps.create_live_identity_resolver({
        read_live_batch_context: deps.read_live_batch_context,
        read_repository_state: deps.read_repository_state,
        read_cached_repository_snapshot: deps.read_cached_repository_snapshot,
      });
    } catch (error) {
      fail(safeCode(error, "live_work_task_identity_unavailable"), "live WorkTask identity is unavailable");
    }
    let identity;
    try {
      identity = resolve({
        installation_id: ref.installation_id, project_id: ref.project_id, repository_key: ref.repository_key,
        work_item: clone(ref.work_item),
      });
    } catch (error) {
      fail(safeCode(error, "live_work_task_identity_unavailable"), "live WorkTask identity is unavailable");
    }
    if (!sameLiveIdentity(ref, identity)) fail("stale_work_task_build_authority", "WorkTask contract is no longer current");
  }
  function assign(rawRequest) {
    if (!plain(rawRequest)) fail("invalid_work_task_build_runtime_request", "build request is invalid");
    const principal = activeHead(rawRequest.token);
    const ref = reference(rawRequest.body?.work_task_ref);
    if (ref.project_id !== principal.project_id) fail("stale_work_task_build_authority", "WorkTask project is not current");
    assertLiveCurrent(ref);
    let service;
    try {
      service = deps.create_assignment_service({
        config_dir: deps.config_dir,
        fs: deps.fs,
        read_registered_base: (request) => deps.read_registered_base(principal.project_id, request),
      });
    } catch (error) {
      fail(safeCode(error, "work_task_build_service_unavailable"), "build assignment service is unavailable");
    }
    try {
      return service.assignBuild({ version: VERSION, event_id: rawRequest.body?.event_id, work_task_ref: ref });
    } catch (error) {
      fail(safeCode(error, "work_task_build_assignment_unavailable"), "build assignment is unavailable");
    }
  }
  return freeze({ assign });
}

module.exports = {
  VERSION,
  WorkTaskBuildRuntimeError,
  createWorkTaskBuildRuntime,
};
