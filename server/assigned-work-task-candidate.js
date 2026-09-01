"use strict";

// #1058 M6: binds a Dev candidate to the current server-read WorkTask build
// assignment. Callers supply only the task reference and observed candidate
// SHA; the assignment base, branch, and managed Dev worktree are derived from
// immutable pipeline state and server-owned read authorities.

const { workTaskKey } = require("./work-task-manifest");
const { assertWorkTaskPipeline } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;

class AssignedWorkTaskCandidateError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "AssignedWorkTaskCandidateError";
    this.code = code;
  }
}

function fail(code, message) { throw new AssignedWorkTaskCandidateError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "unknown or missing field");
  }
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]));
  return value;
}
function sha(value, code) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "SHA is invalid");
  return value;
}
function input(value) {
  exact(value, ["version", "pipeline", "work_task_ref", "candidate_sha"], "invalid_assigned_work_task_candidate_request");
  if (value.version !== VERSION) fail("invalid_assigned_work_task_candidate_request", "request version is invalid");
  try { assertWorkTaskPipeline(value.pipeline); }
  catch { fail("invalid_assigned_work_task_candidate_request", "pipeline is invalid"); }
  return {
    pipeline: value.pipeline,
    work_task_ref: copy(value.work_task_ref),
    candidate_sha: sha(value.candidate_sha, "invalid_assigned_work_task_candidate_request"),
  };
}
function authorities(value) {
  exact(value, ["managed_worktree", "read_canonical_installed_state"], "invalid_assigned_work_task_candidate_options");
  if (!plain(value.managed_worktree) || typeof value.read_canonical_installed_state !== "function") {
    fail("invalid_assigned_work_task_candidate_options", "candidate read authorities are required");
  }
  exact(value.managed_worktree, ["resolveDevWorktree", "canonicalizePath", "inspectManagedWorktree"], "invalid_assigned_work_task_candidate_options");
  for (const name of ["resolveDevWorktree", "canonicalizePath", "inspectManagedWorktree"]) {
    if (typeof value.managed_worktree[name] !== "function") {
      fail("invalid_assigned_work_task_candidate_options", "managed worktree authority is invalid");
    }
  }
  return value;
}
function allocation(value, ref) {
  exact(value, ["version", "repository_key", "worktree_id", "path", "branch"], "assigned_work_task_candidate_allocation_invalid");
  if (value.version !== VERSION || value.repository_key !== ref.repository_key ||
      typeof value.worktree_id !== "string" || typeof value.path !== "string" || typeof value.branch !== "string") {
    fail("assigned_work_task_candidate_allocation_invalid", "managed Dev allocation is invalid");
  }
  return value;
}
function activeAssignment(pipeline, requestedRef) {
  let key;
  try { key = workTaskKey(requestedRef); }
  catch { fail("work_task_candidate_assignment_unavailable", "task reference is invalid"); }
  const slot = pipeline.tasks.find((entry) => workTaskKey(entry.work_task_ref) === key);
  if (!slot || slot.state !== "building" || slot.build_assignment === null) {
    fail("work_task_candidate_assignment_unavailable", "task has no active Dev assignment");
  }
  return slot;
}

function buildAssignedWorkTaskCandidate(request, options) {
  const submitted = input(request);
  const authority = authorities(options);
  const slot = activeAssignment(submitted.pipeline, submitted.work_task_ref);
  if (submitted.candidate_sha === slot.build_assignment.base_sha) {
    fail("work_task_candidate_no_change", "candidate SHA cannot equal the assigned base");
  }
  let resolved;
  try {
    resolved = authority.managed_worktree.resolveDevWorktree(freeze({ version: VERSION, work_task_ref: copy(slot.work_task_ref) }));
  } catch {
    fail("work_task_candidate_worktree_unavailable", "managed Dev worktree cannot be resolved");
  }
  const worktree = allocation(resolved, slot.work_task_ref);
  let candidate;
  try {
    candidate = buildWorkTaskCandidate({
      version: VERSION,
      work_task_ref: copy(slot.work_task_ref),
      base_sha: slot.build_assignment.base_sha,
      candidate_sha: submitted.candidate_sha,
      branch: worktree.branch,
      worktree: {
        repository_key: worktree.repository_key,
        worktree_id: worktree.worktree_id,
        path: worktree.path,
      },
    }, {
      canonicalizePath: authority.managed_worktree.canonicalizePath,
      inspectManagedWorktree: authority.managed_worktree.inspectManagedWorktree,
      readCanonicalInstalledState: authority.read_canonical_installed_state,
    });
  } catch {
    fail("work_task_candidate_submission_rejected", "candidate read-back was rejected");
  }
  return candidate;
}

module.exports = {
  VERSION,
  AssignedWorkTaskCandidateError,
  buildAssignedWorkTaskCandidate,
};
