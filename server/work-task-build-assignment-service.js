"use strict";

// #1058 M9: the narrow durable bridge that turns one current queued WorkTask
// into a Dev build assignment.  The Head transport/authentication and the
// registered base-SHA observation remain injected boundaries.  Callers cannot
// choose an assignment id or base SHA.  A task inside a pending pre-release
// propagation stop's declared chain is refused here, before the base is even
// observed; the pipeline's own readiness gate stays the authority behind it.

const crypto = require("node:crypto");
const { assertWorkTaskRef, workTaskKey } = require("./work-task-manifest");
const { planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createWorkTaskIndependentReviewService } = require("./work-task-independent-review-service");

const VERSION = 1;
const EVENT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

class WorkTaskBuildAssignmentServiceError extends Error {
  constructor(code, message = code) { super(message); this.name = "WorkTaskBuildAssignmentServiceError"; this.code = code; }
}
function fail(code, message) { throw new WorkTaskBuildAssignmentServiceError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail(code, "value has an unknown or missing field");
}
function clone(value) { return Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
function ref(value, code) { try { assertWorkTaskRef(value); } catch { fail(code, "work task reference is invalid"); } return clone(value); }
function input(value) {
  const code = "invalid_work_task_build_assignment_request";
  exact(value, ["version", "event_id", "work_task_ref"], code);
  if (value.version !== VERSION || typeof value.event_id !== "string" || !EVENT_ID_RE.test(value.event_id)) fail(code, "build assignment request is invalid");
  return freeze({ event_id: value.event_id, work_task_ref: ref(value.work_task_ref, code) });
}
function recoveryInput(value) {
  const code = "invalid_work_task_build_recovery_request";
  exact(value, ["version", "event_id", "work_task_ref", "expected_pipeline_digest"], code);
  if (value.version !== VERSION || typeof value.event_id !== "string" || !EVENT_ID_RE.test(value.event_id) ||
      typeof value.expected_pipeline_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.expected_pipeline_digest)) {
    fail(code, "build recovery request is invalid");
  }
  return freeze({ event_id: value.event_id, work_task_ref: ref(value.work_task_ref, code),
    expected_pipeline_digest: value.expected_pipeline_digest });
}
function options(value) {
  exact(value, ["config_dir", "fs", "read_registered_base"], "invalid_work_task_build_assignment_service_options");
  if (typeof value.config_dir !== "string" || !value.fs || typeof value.read_registered_base !== "function") {
    fail("invalid_work_task_build_assignment_service_options", "build assignment dependencies are invalid");
  }
  return value;
}
function base(value, task) {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "base_sha,repository_key,version" || value.version !== VERSION ||
      value.repository_key !== task.repository_key || !SHA_RE.test(value.base_sha)) {
    fail("work_task_build_base_unavailable", "registered repository base is unavailable");
  }
  return value.base_sha;
}
function assignmentId(task, eventId) {
  return "build_" + crypto.createHash("sha256").update(workTaskKey(task) + "\n" + eventId, "utf8").digest("hex").slice(0, 64);
}
function slotFor(pipeline, task) {
  const matches = pipeline.tasks.filter((slot) => workTaskKey(slot.work_task_ref) === workTaskKey(task));
  if (matches.length !== 1) fail("work_task_build_assignment_unavailable", "pipeline has no exact WorkTask");
  return matches[0];
}
function result(outcome, task, assignment, base_sha) {
  return freeze({ version: VERSION, outcome, work_task_ref: clone(task), assignment_id: assignment, base_sha });
}
function rethrow(error, fallback) {
  if (error instanceof WorkTaskBuildAssignmentServiceError) throw error;
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code) ? error.code : fallback;
  fail(code, fallback);
}

function createWorkTaskBuildAssignmentService(value) {
  const deps = options(value);
  const store = createWorkTaskPipelineStore({ config_dir: deps.config_dir, fs: deps.fs });
  const review = createWorkTaskIndependentReviewService({ config_dir: deps.config_dir, fs: deps.fs });
  function assertNoPendingStop(pipeline, task) {
    const key = workTaskKey(task);
    for (const slot of pipeline.tasks) {
      if (slot.state !== "independent_review") continue;
      let stop;
      try { stop = review.readPropagationStopPending(freeze({ version: VERSION, work_task_ref: clone(slot.work_task_ref) })); }
      catch (error) { rethrow(error, "work_task_build_propagation_stop_unavailable"); }
      if (stop !== null && stop.dependency_chain.some((ref) => workTaskKey(ref) === key)) {
        fail("work_task_build_propagation_stop_pending", "WorkTask is inside a pending propagation stop");
      }
    }
  }
  function assignBuild(value) {
    const request = input(value);
    const owner = { installation_id: request.work_task_ref.installation_id, project_id: request.work_task_ref.project_id };
    let snapshot;
    try { snapshot = store.readRecoverySnapshot(owner); } catch (error) { rethrow(error, "work_task_build_pipeline_unavailable"); }
    if (snapshot.pipeline.archived) fail("work_task_archive_blocked", "archived pipeline cannot assign a build");
    const slot = slotFor(snapshot.pipeline, request.work_task_ref);
    const prior = snapshot.pipeline.history.find((entry) => entry.event_id === request.event_id) || null;
    if (prior !== null) {
      if (prior.kind === "assign_build" && slot.state === "building" &&
          slot.history.filter((entry) => entry.kind === "assign_build").at(-1)?.event_id === request.event_id) {
        return result("idempotent", request.work_task_ref, slot.build_assignment.assignment_id, slot.build_assignment.base_sha);
      }
      fail("work_task_build_event_conflict", "event identity is bound to another transition");
    }
    if (slot.state !== "queued") fail("work_task_build_assignment_unavailable", "WorkTask is not ready for a build assignment");
    assertNoPendingStop(snapshot.pipeline, request.work_task_ref);
    let base_sha;
    try { base_sha = base(deps.read_registered_base(freeze({ version: VERSION, work_task_ref: clone(request.work_task_ref) })), request.work_task_ref); }
    catch (error) { rethrow(error, "work_task_build_base_unavailable"); }
    let plan;
    try {
      const assignment_id = assignmentId(request.work_task_ref, request.event_id);
      plan = planWorkTaskPipelineEvent(snapshot.pipeline, {
        version: VERSION, kind: "assign_build", event_id: request.event_id, work_task_ref: request.work_task_ref, assignment_id, base_sha,
      });
      store.applyPlan({ expected: { ...owner, manifest_digest: snapshot.manifest.manifest_digest, pipeline_digest: snapshot.pipeline.pipeline_digest }, plan, terminal_disposition: null });
      return result("assigned", request.work_task_ref, assignment_id, base_sha);
    } catch (error) { rethrow(error, "work_task_build_assignment_commit_failed"); }
  }
  function recoverStaleBase(value) {
    const request = recoveryInput(value);
    const owner = { installation_id: request.work_task_ref.installation_id, project_id: request.work_task_ref.project_id };
    let snapshot;
    try { snapshot = store.readRecoverySnapshot(owner); } catch (error) { rethrow(error, "work_task_build_pipeline_unavailable"); }
    if (snapshot.pipeline.archived) fail("work_task_archive_blocked", "archived pipeline cannot recover a build");
    const slot = slotFor(snapshot.pipeline, request.work_task_ref);
    const prior = snapshot.pipeline.history.find((entry) => entry.event_id === request.event_id);
    if (prior) {
      const retired = slot.retired_builds?.find((entry) => entry.event_id === request.event_id);
      if (prior.kind === "recover_stale_base" && retired?.precondition_digest === request.expected_pipeline_digest) {
        return freeze({ version: VERSION, outcome: "idempotent", work_task_ref: clone(request.work_task_ref),
          retired_assignment_id: retired.assignment.assignment_id, base_sha: retired.new_base_sha });
      }
      fail("work_task_build_event_conflict", "event identity is bound to another transition");
    }
    if (snapshot.pipeline.pipeline_digest !== request.expected_pipeline_digest) {
      fail("work_task_stale_base_recovery_stale", "pipeline changed before recovery");
    }
    if (slot.state !== "building" && slot.state !== "candidate_ready") {
      fail("work_task_stale_base_recovery_unavailable", "task has no recoverable build");
    }
    const assignment = slot.build_assignment || slot.last_build_assignment ||
      (slot.candidate === null ? null : { assignment_id: "build_" + crypto.createHash("sha256").update(workTaskKey(request.work_task_ref), "utf8").digest("hex").slice(0, 64),
        base_sha: slot.candidate.base_sha });
    if (!assignment) fail("work_task_stale_base_recovery_unavailable", "task assignment identity is missing");
    let newBase;
    try { newBase = base(deps.read_registered_base(freeze({ version: VERSION, work_task_ref: clone(request.work_task_ref) })), request.work_task_ref); }
    catch (error) { rethrow(error, "work_task_build_base_unavailable"); }
    if (newBase === assignment.base_sha) fail("work_task_stale_base_recovery_unavailable", "registered base has not moved");
    try {
      const plan = planWorkTaskPipelineEvent(snapshot.pipeline, {
        version: VERSION, kind: "recover_stale_base", event_id: request.event_id, work_task_ref: request.work_task_ref,
        precondition_digest: request.expected_pipeline_digest, expected_assignment_id: assignment.assignment_id,
        expected_base_sha: assignment.base_sha, expected_candidate_digest: slot.candidate?.candidate_digest || null,
        new_base_sha: newBase,
      });
      store.applyPlan({ expected: { ...owner, manifest_digest: snapshot.manifest.manifest_digest, pipeline_digest: snapshot.pipeline.pipeline_digest },
        plan, terminal_disposition: null });
    } catch (error) { rethrow(error, "work_task_stale_base_recovery_commit_failed"); }
    return freeze({ version: VERSION, outcome: "recovered", work_task_ref: clone(request.work_task_ref),
      retired_assignment_id: assignment.assignment_id, base_sha: newBase });
  }
  return freeze({ assignBuild, recoverStaleBase });
}

module.exports = { VERSION, WorkTaskBuildAssignmentServiceError, createWorkTaskBuildAssignmentService };
