"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent, applyWorkTaskPipelinePlan } = require("./work-task-pipeline");
const {
  AssignedWorkTaskCandidateError,
  buildAssignedWorkTaskCandidate,
} = require("./assigned-work-task-candidate");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof AssignedWorkTaskCandidateError && error.code === code);
}
function pipeline(building = true) {
  const manifest = freezeBatchManifest(buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [{
      task_key: "build",
      repository_key: "web",
      work_item: { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" },
      goal: "submit a server-bound local candidate",
      file_boundary: ["server/work.js"],
      validation: ["node:test"],
      dependencies: [],
    }],
  }, {
    resolveRegisteredIdentity(input) {
      return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) };
    },
  }), "2026-09-02T00:00:00.000Z");
  let value = buildWorkTaskPipeline(manifest);
  if (building) {
    value = applyWorkTaskPipelinePlan(value, planWorkTaskPipelineEvent(value, {
      version: 1,
      kind: "assign_build",
      event_id: "candidate_build_assignment",
      work_task_ref: copy(manifest.tasks[0].ref),
      assignment_id: "candidate_assignment",
      base_sha,
    }));
  }
  return { pipeline: value, ref: manifest.tasks[0].ref };
}
function managed(ref) {
  return {
    resolveDevWorktree(request) {
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(request, { version: 1, work_task_ref: ref });
      return { version: 1, repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/repos/web-dev", branch: "worktree-dev" };
    },
    canonicalizePath(request) {
      assert.equal(Object.isFrozen(request), true);
      return { version: 1, canonical_path: request.path };
    },
    inspectManagedWorktree(request) {
      assert.equal(Object.isFrozen(request), true);
      return {
        version: 1,
        registered: true,
        readable: true,
        repository_key: request.expected.repository_key,
        worktree_id: request.expected.worktree_id,
        canonical_path: request.expected.canonical_path,
        branch: request.expected.branch,
        base_sha: request.expected.base_sha,
        head_sha: request.expected.candidate_sha,
        dirty: false,
        occupancy: "vacant",
      };
    },
  };
}
function options(ref) {
  return {
    managed_worktree: managed(ref),
    read_canonical_installed_state(identity) {
      assert.equal(Object.isFrozen(identity), true);
      return { version: 1, installation_id: identity.installation_id, project_id: identity.project_id, v1_state: "present" };
    },
  };
}

// The pipeline-owned base and server-owned Dev worktree are the only inputs
// that reach the candidate builder; Dev cannot submit a branch, path, or base.
{
  const current = pipeline();
  const candidate = buildAssignedWorkTaskCandidate({
    version: 1,
    pipeline: current.pipeline,
    work_task_ref: copy(current.ref),
    candidate_sha,
  }, options(current.ref));
  assert.equal(candidate.base_sha, base_sha);
  assert.equal(candidate.candidate_sha, candidate_sha);
  assert.equal(candidate.branch, "worktree-dev");
  assert.deepEqual(candidate.managed_worktree, {
    repository_key: "web",
    worktree_id: "wt_web_dev",
    canonical_path: "/private/var/repos/web-dev",
    branch: "worktree-dev",
    base_sha,
    head_sha: candidate_sha,
  });
}

{
  const current = pipeline();
  throwsCode(() => buildAssignedWorkTaskCandidate({
    version: 1,
    pipeline: current.pipeline,
    work_task_ref: copy(current.ref),
    candidate_sha,
    branch: "task/caller-chosen",
  }, options(current.ref)), "invalid_assigned_work_task_candidate_request");
  throwsCode(() => buildAssignedWorkTaskCandidate({
    version: 1,
    pipeline: current.pipeline,
    work_task_ref: copy(current.ref),
    candidate_sha: base_sha,
  }, options(current.ref)), "work_task_candidate_no_change");
  const idle = pipeline(false);
  throwsCode(() => buildAssignedWorkTaskCandidate({
    version: 1,
    pipeline: idle.pipeline,
    work_task_ref: copy(idle.ref),
    candidate_sha,
  }, options(idle.ref)), "work_task_candidate_assignment_unavailable");
}

// The command wrapper owns no config, route, transport, Git, or publication
// capability. Those authority seams must be composed by the server runtime.
{
  const source = fs.readFileSync(path.join(__dirname, "assigned-work-task-candidate.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|config|mcp|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn|worktree add|reset --hard|\bpush\b|pull_request|\bmerge\b|deploy)/);
}

console.log("assigned-work-task-candidate.test.js: all assertions passed");
