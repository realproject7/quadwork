"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const {
  WorkTaskDevCandidateServiceError,
  createWorkTaskDevCandidateService,
} = require("./work-task-dev-candidate-service");

const installation_id = "installation_candidate_service_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof WorkTaskDevCandidateServiceError && error.code === code);
}
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-dev-candidate-service-"));
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function fixture(directory) {
  const manifest = freezeBatchManifest(buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [{
      task_key: "build",
      repository_key: "web",
      work_item: { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" },
      goal: "persist an exact Dev candidate",
      file_boundary: ["server/work-task-dev-candidate-service.js"],
      validation: ["node-test"],
      dependencies: [],
    }],
  }, {
    resolveRegisteredIdentity(input) {
      return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) };
    },
  }), "2026-09-02T00:00:00.000Z");
  let pipeline = buildWorkTaskPipeline(manifest);
  const ref = manifest.tasks[0].ref;
  const assignment = planWorkTaskPipelineEvent(pipeline, {
    version: 1,
    kind: "assign_build",
    event_id: "service_assign_build",
    work_task_ref: copy(ref),
    assignment_id: "service_assignment",
    base_sha,
  });
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  store.initialize({
    expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null },
    manifest,
    pipeline,
  });
  const initial = store.readRecoverySnapshot({ installation_id, project_id });
  store.applyPlan({ expected: initial.pipeline.pipeline_digest ? {
    installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: initial.pipeline.pipeline_digest,
  } : assignment.precondition, plan: assignment, terminal_disposition: null });
  let inspections = 0;
  const managed_worktree = {
    // The composed server observer exposes this extra reader; the service
    // must forward only the three authorities the candidate builder exacts.
    worktreeId(repositoryKey) { return `wt_${repositoryKey}_dev`; },
    resolveDevWorktree(request) {
      assert.deepEqual(request, { version: 1, work_task_ref: ref });
      return { version: 1, repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev", branch: "worktree-dev" };
    },
    canonicalizePath(request) {
      return { version: 1, canonical_path: request.path };
    },
    inspectManagedWorktree(request) {
      inspections += 1;
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
  const service = createWorkTaskDevCandidateService({
    config_dir: directory,
    fs,
    managed_worktree,
    read_canonical_installed_state(identity) {
      return { version: 1, installation_id: identity.installation_id, project_id: identity.project_id, v1_state: "present" };
    },
  });
  return { ref, store, service, inspections: () => inspections };
}

withDirectory((directory) => {
  const current = fixture(directory);
  const submitted = current.service.submitDevCandidate({
    version: 1,
    event_id: "service_record_candidate",
    work_task_ref: copy(current.ref),
    candidate_sha,
  });
  assert.equal(submitted.outcome, "recorded");
  assert.equal(submitted.work_task_ref.task_key, "build");
  assert.match(submitted.candidate_digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(submitted), /worktree|canonical_path|branch|candidate_sha/);
  const persisted = current.store.readRecoverySnapshot({ installation_id, project_id });
  assert.equal(persisted.pipeline.tasks[0].state, "candidate_ready");
  assert.equal(persisted.pipeline.tasks[0].candidate.candidate_digest, submitted.candidate_digest);
  assert.equal(persisted.pipeline.tasks[0].build_assignment, null);
  assert.equal(current.inspections(), 1);
  console.log("  PASS: a server-observed Dev candidate is CAS-recorded without returning worktree authority");

  const retry = current.service.submitDevCandidate({
    version: 1,
    event_id: "service_record_candidate",
    work_task_ref: copy(current.ref),
    candidate_sha,
  });
  assert.equal(retry.outcome, "idempotent");
  assert.equal(retry.candidate_digest, submitted.candidate_digest);
  assert.equal(current.inspections(), 1, "an exact retry does not re-observe or recreate candidate authority");
  console.log("  PASS: exact candidate retries acknowledge the durable event without a second worktree read");
});

withDirectory((directory) => {
  const current = fixture(directory);
  throwsCode(() => current.service.submitDevCandidate({
    version: 1,
    event_id: "service_record_candidate",
    work_task_ref: copy(current.ref),
    candidate_sha,
    base_sha,
  }), "invalid_work_task_dev_candidate_request");
  throwsCode(() => current.service.submitDevCandidate({
    version: 1,
    event_id: "service_bad_candidate",
    work_task_ref: copy(current.ref),
    candidate_sha: base_sha,
  }), "work_task_candidate_no_change");
  assert.equal(current.inspections(), 0);
  console.log("  PASS: Dev cannot select base/assignment authority and unchanged candidates fail before worktree observation");
});

{
  const source = fs.readFileSync(path.join(__dirname, "work-task-dev-candidate-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|mcp|file-chat|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:push|pull_request|merge|deploy|execFile|spawn|worktree add|reset --hard)/);
  console.log("  PASS: candidate persistence remains transport-free and local-only");
}

console.log("work-task-dev-candidate-service.test.js: all assertions passed");
