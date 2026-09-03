"use strict";

// #1059 M4: the fixed server-side transport boundary for a WorkTask's
// independent-review round.  It authenticates the Head/reviewer role from the
// launch-token principal, derives reviewer assignments from current server
// sessions, and rechecks the live Issue contract before touching durable
// state.  Neither request body can select a reviewer role, generation, or
// project.  Head may request the released-round reconciliation through its
// separate durable service, but delivery composition, publication, and process
// control remain elsewhere.

const { assertWorkTaskRef } = require("./work-task-manifest");
const { workItemKey } = require("./work-item-ref");
const { createLiveWorkTaskIdentityResolver } = require("./live-work-task-identity-resolver");
const { createWorkTaskIndependentReviewService } = require("./work-task-independent-review-service");
const { createWorkTaskReviewReconciliationService } = require("./work-task-review-reconciliation-service");

const VERSION = 1;
const REVIEWER_ROLES = new Set(["re1", "re2"]);

class WorkTaskReviewRuntimeError extends Error {
  constructor(code, message = code) { super(message); this.name = "WorkTaskReviewRuntimeError"; this.code = code; }
}

function fail(code, message) { throw new WorkTaskReviewRuntimeError(code, message); }
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
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code)
    ? error.code
    : fallback;
}
function reference(value, code) {
  try { assertWorkTaskRef(value); }
  catch { fail(code, "work task reference is invalid"); }
  return clone(value);
}
function token(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    fail("work_task_review_principal_unavailable", "review principal is unavailable");
  }
  return value;
}
function isoNow(now) {
  let value;
  try { value = now(); }
  catch { fail("work_task_review_clock_unavailable", "review clock is unavailable"); }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail("work_task_review_clock_unavailable", "review clock is unavailable");
  }
  return value.toISOString();
}

function options(value) {
  exact(value, [
    "config_dir", "fs", "capture_project_admission", "is_admission_current",
    "resolve_shim_principal", "agent_sessions", "read_live_batch_context",
    "read_repository_state", "read_cached_repository_snapshot", "now",
    "create_live_identity_resolver", "create_review_service", "create_reconciliation_service",
  ], "invalid_work_task_review_runtime_options");
  if (typeof value.config_dir !== "string" || !value.fs || typeof value.capture_project_admission !== "function" ||
      typeof value.is_admission_current !== "function" || typeof value.resolve_shim_principal !== "function" ||
      !value.agent_sessions || typeof value.agent_sessions.get !== "function" ||
      typeof value.read_live_batch_context !== "function" || typeof value.read_repository_state !== "function" ||
      typeof value.read_cached_repository_snapshot !== "function" || typeof value.now !== "function" ||
      typeof value.create_live_identity_resolver !== "function" || typeof value.create_review_service !== "function" ||
      typeof value.create_reconciliation_service !== "function") {
    fail("invalid_work_task_review_runtime_options", "runtime dependencies are invalid");
  }
  return value;
}

// The persisted project admission generation starts at zero, whereas the
// sealed review contract intentionally accepts positive generations only.
// This one-to-one (+1) encoding is server-owned and changes on every
// admission revocation; role identity remains a separate exact field.
function reviewerGeneration(admission) {
  if (!admission || !Number.isSafeInteger(admission.generation) || admission.generation < 0 || admission.generation >= 1000000) {
    fail("work_task_review_principal_unavailable", "review principal generation is unavailable");
  }
  return admission.generation + 1;
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

function createWorkTaskReviewRuntime(value) {
  const deps = options(value);

  function activePrincipal(rawToken, allowedRoles) {
    let principal;
    try { principal = deps.resolve_shim_principal(token(rawToken)); }
    catch { fail("work_task_review_principal_unavailable", "review principal is unavailable"); }
    if (!principal || typeof principal.projectId !== "string" || !allowedRoles.has(principal.agentId)) {
      fail("work_task_review_principal_unavailable", "review principal is unavailable");
    }
    let admission;
    try { admission = deps.capture_project_admission(principal.projectId); }
    catch { fail("work_task_review_principal_unavailable", "review principal is unavailable"); }
    let current = false;
    try { current = deps.is_admission_current(admission) === true; }
    catch { current = false; }
    const session = deps.agent_sessions.get(`${principal.projectId}/${principal.agentId}`);
    if (!current || !session || session.projectId !== principal.projectId || session.agentId !== principal.agentId ||
        session.state !== "running" || !session.term || session.lifecycleState !== "verified") {
      fail("work_task_review_principal_unavailable", "review principal is unavailable");
    }
    return freeze({ project_id: principal.projectId, agent_id: principal.agentId, admission, reviewer_generation: reviewerGeneration(admission) });
  }

  function reviewersFor(principal) {
    const reviewers = [];
    for (const role of ["re1", "re2"]) {
      const session = deps.agent_sessions.get(`${principal.project_id}/${role}`);
      if (!session || session.projectId !== principal.project_id || session.agentId !== role || session.state !== "running" ||
          !session.term || session.lifecycleState !== "verified") {
        fail("work_task_reviewer_assignment_unavailable", "both independent reviewers must be verified");
      }
      reviewers.push({ reviewer_role: role, reviewer_generation: principal.reviewer_generation });
    }
    return reviewers;
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
        installation_id: ref.installation_id,
        project_id: ref.project_id,
        repository_key: ref.repository_key,
        work_item: clone(ref.work_item),
      });
    } catch (error) {
      fail(safeCode(error, "live_work_task_identity_unavailable"), "live WorkTask identity is unavailable");
    }
    if (!sameLiveIdentity(ref, identity)) {
      fail("stale_work_task_review_authority", "WorkTask contract is no longer current");
    }
  }

  function service() {
    try { return deps.create_review_service({ config_dir: deps.config_dir, fs: deps.fs }); }
    catch (error) { fail(safeCode(error, "work_task_review_service_unavailable"), "review service is unavailable"); }
  }

  function reconciliationService() {
    try { return deps.create_reconciliation_service({ config_dir: deps.config_dir, fs: deps.fs }); }
    catch (error) { fail(safeCode(error, "work_task_review_reconciliation_unavailable"), "review reconciliation is unavailable"); }
  }

  function open(rawRequest) {
    if (!plain(rawRequest)) fail("invalid_work_task_review_runtime_request", "review request is invalid");
    const principal = activePrincipal(rawRequest.token, new Set(["head"]));
    const body = rawRequest.body;
    const ref = reference(body?.work_task_ref, "invalid_work_task_review_open_request");
    if (ref.project_id !== principal.project_id) fail("stale_work_task_review_authority", "WorkTask project is not current");
    assertLiveCurrent(ref);
    const request = {
      version: VERSION,
      event_id: body?.event_id,
      work_task_ref: ref,
      attempt: body?.attempt,
      round: body?.round,
      reviewers: reviewersFor(principal),
      opened_at: isoNow(deps.now),
    };
    try { return service().openIndependentReview(request); }
    catch (error) { fail(safeCode(error, "work_task_review_open_failed"), "review opening failed"); }
  }

  function submit(rawRequest) {
    if (!plain(rawRequest)) fail("invalid_work_task_review_runtime_request", "review request is invalid");
    const principal = activePrincipal(rawRequest.token, REVIEWER_ROLES);
    const body = rawRequest.body;
    const ref = reference(body?.review_round_ref?.work_task_ref, "invalid_work_task_review_receipt_request");
    if (ref.project_id !== principal.project_id) fail("stale_work_task_review_authority", "WorkTask project is not current");
    assertLiveCurrent(ref);
    try {
      return service().submitTrustedReceipt({
        version: VERSION,
        review_round_ref: clone(body?.review_round_ref),
        candidate_digest: body?.candidate_digest,
        receipt: clone(body?.receipt),
      }, {
        version: VERSION,
        reviewer_role: principal.agent_id,
        reviewer_generation: principal.reviewer_generation,
        received_at: isoNow(deps.now),
      });
    } catch (error) {
      fail(safeCode(error, "work_task_review_receipt_failed"), "review receipt failed");
    }
  }

  function reconcile(rawRequest) {
    if (!plain(rawRequest)) fail("invalid_work_task_review_runtime_request", "review request is invalid");
    const principal = activePrincipal(rawRequest.token, new Set(["head"]));
    const body = rawRequest.body;
    const ref = reference(body?.work_task_ref, "invalid_work_task_review_reconciliation_request");
    const round = body?.review_round_ref;
    if (ref.project_id !== principal.project_id || !round || round.project_id !== ref.project_id ||
        round.installation_id !== ref.installation_id) {
      fail("stale_work_task_review_authority", "WorkTask project is not current");
    }
    assertLiveCurrent(ref);
    try {
      return reconciliationService().reconcileReleasedReview({
        version: VERSION,
        work_task_ref: ref,
        review_round_ref: clone(round),
        candidate_digest: body?.candidate_digest,
      });
    } catch (error) {
      fail(safeCode(error, "work_task_review_reconciliation_failed"), "review reconciliation failed");
    }
  }

  return freeze({ open, submit, reconcile });
}

module.exports = {
  VERSION,
  WorkTaskReviewRuntimeError,
  createWorkTaskReviewRuntime,
};
