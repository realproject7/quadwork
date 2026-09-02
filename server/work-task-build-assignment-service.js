"use strict";

// #1058 M9: the narrow durable bridge that turns one current queued WorkTask
// into a Dev build assignment.  The Head transport/authentication and the
// registered base-SHA observation remain injected boundaries.  Callers cannot
// choose an assignment id or base SHA.

const crypto = require("node:crypto");
const { assertWorkTaskRef, workTaskKey } = require("./work-task-manifest");
const { planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");

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
function assignmentId(task) {
  return `build_${crypto.createHash("sha256").update(workTaskKey(task), "utf8").digest("hex").slice(0, 64)}`;
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
  function assignBuild(value) {
    const request = input(value);
    const owner = { installation_id: request.work_task_ref.installation_id, project_id: request.work_task_ref.project_id };
    let snapshot;
    try { snapshot = store.readRecoverySnapshot(owner); } catch (error) { rethrow(error, "work_task_build_pipeline_unavailable"); }
    if (snapshot.pipeline.archived) fail("work_task_archive_blocked", "archived pipeline cannot assign a build");
    const slot = slotFor(snapshot.pipeline, request.work_task_ref);
    const assignment_id = assignmentId(request.work_task_ref);
    const prior = snapshot.pipeline.history.find((entry) => entry.event_id === request.event_id) || null;
    if (prior !== null) {
      if (prior.kind === "assign_build" && slot.state === "building" && slot.build_assignment?.assignment_id === assignment_id) {
        return result("idempotent", request.work_task_ref, assignment_id, slot.build_assignment.base_sha);
      }
      fail("work_task_build_event_conflict", "event identity is bound to another transition");
    }
    if (slot.state !== "queued") fail("work_task_build_assignment_unavailable", "WorkTask is not ready for a build assignment");
    let base_sha;
    try { base_sha = base(deps.read_registered_base(freeze({ version: VERSION, work_task_ref: clone(request.work_task_ref) })), request.work_task_ref); }
    catch (error) { rethrow(error, "work_task_build_base_unavailable"); }
    let plan;
    try {
      plan = planWorkTaskPipelineEvent(snapshot.pipeline, {
        version: VERSION, kind: "assign_build", event_id: request.event_id, work_task_ref: request.work_task_ref, assignment_id, base_sha,
      });
      store.applyPlan({ expected: { ...owner, manifest_digest: snapshot.manifest.manifest_digest, pipeline_digest: snapshot.pipeline.pipeline_digest }, plan, terminal_disposition: null });
    } catch (error) { rethrow(error, "work_task_build_assignment_commit_failed"); }
    return result("assigned", request.work_task_ref, assignment_id, base_sha);
  }
  return freeze({ assignBuild });
}

module.exports = { VERSION, WorkTaskBuildAssignmentServiceError, createWorkTaskBuildAssignmentService };
