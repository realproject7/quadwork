"use strict";

// #1058 M7: the one narrow composition seam that commits a Dev's locally
// observed WorkTask candidate into the durable pipeline.  It intentionally
// owns neither authentication nor transport: its caller must already have
// authenticated the Dev principal.  In particular, the Dev supplies no base,
// branch, worktree, assignment, or delivery/publication instruction.

const { assertWorkTaskRef, workTaskKey } = require("./work-task-manifest");
const { planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { buildAssignedWorkTaskCandidate } = require("./assigned-work-task-candidate");

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const EVENT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;

class WorkTaskDevCandidateServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "WorkTaskDevCandidateServiceError";
    this.code = code;
  }
}

function fail(code, message) { throw new WorkTaskDevCandidateServiceError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
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
function reference(value, code) {
  try { assertWorkTaskRef(value); } catch { fail(code, "work task reference is invalid"); }
  return clone(value);
}
function candidateSha(value, code) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "candidate SHA is invalid");
  return value;
}
function eventId(value, code) {
  if (typeof value !== "string" || !EVENT_ID_RE.test(value)) fail(code, "event identity is invalid");
  return value;
}
function request(value) {
  exact(value, ["version", "event_id", "work_task_ref", "candidate_sha"], "invalid_work_task_dev_candidate_request");
  if (value.version !== VERSION) fail("invalid_work_task_dev_candidate_request", "request version is invalid");
  return freeze({
    event_id: eventId(value.event_id, "invalid_work_task_dev_candidate_request"),
    work_task_ref: reference(value.work_task_ref, "invalid_work_task_dev_candidate_request"),
    candidate_sha: candidateSha(value.candidate_sha, "invalid_work_task_dev_candidate_request"),
  });
}
function options(value) {
  exact(value, ["config_dir", "fs", "managed_worktree", "read_canonical_installed_state"], "invalid_work_task_dev_candidate_service_options");
  if (typeof value.config_dir !== "string" || !value.fs || !plain(value.managed_worktree) ||
      typeof value.read_canonical_installed_state !== "function") {
    fail("invalid_work_task_dev_candidate_service_options", "candidate service dependencies are invalid");
  }
  for (const name of ["resolveDevWorktree", "canonicalizePath", "inspectManagedWorktree"]) {
    if (typeof value.managed_worktree[name] !== "function") {
      fail("invalid_work_task_dev_candidate_service_options", "managed worktree authority is invalid");
    }
  }
  return value;
}
function slotFor(pipeline, ref) {
  const key = workTaskKey(ref);
  const matches = pipeline.tasks.filter((slot) => workTaskKey(slot.work_task_ref) === key);
  if (matches.length !== 1) fail("work_task_candidate_assignment_unavailable", "current pipeline has no exact work task");
  return matches[0];
}
function result(outcome, candidate) {
  return freeze({
    version: VERSION,
    outcome,
    candidate_digest: candidate.candidate_digest,
    work_task_ref: clone(candidate.work_task_ref),
  });
}
function rethrow(error, fallback) {
  if (error instanceof WorkTaskDevCandidateServiceError) throw error;
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code)
    ? error.code
    : fallback;
  fail(code, fallback);
}

function createWorkTaskDevCandidateService(value) {
  const serviceOptions = options(value);
  const store = createWorkTaskPipelineStore({ config_dir: serviceOptions.config_dir, fs: serviceOptions.fs });

  function submitDevCandidate(value) {
    const submitted = request(value);
    const owner = {
      installation_id: submitted.work_task_ref.installation_id,
      project_id: submitted.work_task_ref.project_id,
    };
    let snapshot;
    try { snapshot = store.readRecoverySnapshot(owner); }
    catch (error) { rethrow(error, "work_task_candidate_pipeline_unavailable"); }
    if (snapshot.pipeline.archived) fail("work_task_archive_blocked", "archived pipeline cannot accept a candidate");
    const slot = slotFor(snapshot.pipeline, submitted.work_task_ref);
    const existing = snapshot.pipeline.history.find((entry) => entry.event_id === submitted.event_id) || null;
    if (existing !== null) {
      if (existing.kind === "record_candidate" && slot.history.some((entry) => entry.event_id === submitted.event_id && entry.kind === "record_candidate") &&
          slot.candidate !== null && slot.candidate.candidate_sha === submitted.candidate_sha) {
        return result("idempotent", slot.candidate);
      }
      fail("work_task_candidate_event_conflict", "event identity is already bound to another pipeline transition");
    }
    let candidate;
    try {
      candidate = buildAssignedWorkTaskCandidate({
        version: VERSION,
        pipeline: snapshot.pipeline,
        work_task_ref: submitted.work_task_ref,
        candidate_sha: submitted.candidate_sha,
      }, {
        managed_worktree: serviceOptions.managed_worktree,
        read_canonical_installed_state: serviceOptions.read_canonical_installed_state,
      });
    } catch (error) { rethrow(error, "work_task_candidate_submission_rejected"); }
    let plan;
    try {
      plan = planWorkTaskPipelineEvent(snapshot.pipeline, {
        version: VERSION,
        kind: "record_candidate",
        event_id: submitted.event_id,
        assignment_id: slot.build_assignment.assignment_id,
        candidate,
      });
    } catch (error) { rethrow(error, "work_task_candidate_submission_rejected"); }
    try {
      store.applyPlan({
        expected: {
          installation_id: owner.installation_id,
          project_id: owner.project_id,
          manifest_digest: snapshot.manifest.manifest_digest,
          pipeline_digest: snapshot.pipeline.pipeline_digest,
        },
        plan,
        terminal_disposition: null,
      });
    } catch (error) { rethrow(error, "work_task_candidate_commit_failed"); }
    return result("recorded", candidate);
  }

  return freeze({ submitDevCandidate });
}

module.exports = {
  VERSION,
  WorkTaskDevCandidateServiceError,
  createWorkTaskDevCandidateService,
};
