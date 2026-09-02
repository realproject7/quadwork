"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createWorkTaskBuildAssignmentService, WorkTaskBuildAssignmentServiceError } = require("./work-task-build-assignment-service");
const installation_id = "installation_build_service_0001", project_id = "quadwork", base_sha = "a".repeat(40);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function withDir(run) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-build-service-")); try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
function fixture(dir) {
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{ task_key: "build", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" }, goal: "assign a server base", file_boundary: ["server/build.js"], validation: ["node-test"], dependencies: [] }] }, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; } }), "2026-09-02T00:00:00.000Z");
  const store = createWorkTaskPipelineStore({ config_dir: dir, fs });
  store.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline: buildWorkTaskPipeline(manifest) });
  const calls = [];
  const service = createWorkTaskBuildAssignmentService({ config_dir: dir, fs, read_registered_base(request) { calls.push(request); return { version: 1, repository_key: "web", base_sha }; } });
  return { ref: manifest.tasks[0].ref, store, service, calls };
}
withDir((dir) => {
  const current = fixture(dir);
  const assigned = current.service.assignBuild({ version: 1, event_id: "assign_build_001", work_task_ref: copy(current.ref) });
  assert.equal(assigned.outcome, "assigned"); assert.equal(assigned.base_sha, base_sha); assert.match(assigned.assignment_id, /^build_[a-f0-9]{64}$/);
  assert.equal(current.calls.length, 1); assert.equal(Object.isFrozen(current.calls[0]), true);
  const state = current.store.readRecoverySnapshot({ installation_id, project_id });
  assert.equal(state.pipeline.tasks[0].state, "building"); assert.equal(state.pipeline.tasks[0].build_assignment.base_sha, base_sha);
  assert.equal(current.service.assignBuild({ version: 1, event_id: "assign_build_001", work_task_ref: copy(current.ref) }).outcome, "idempotent");
  console.log("  PASS: server-observed base SHA creates one idempotent exact Dev assignment");
});
withDir((dir) => {
  const current = fixture(dir);
  current.service.assignBuild({ version: 1, event_id: "assign_build_002", work_task_ref: copy(current.ref) });
  assert.throws(() => current.service.assignBuild({ version: 1, event_id: "other_build_002", work_task_ref: copy(current.ref) }), (error) => error instanceof WorkTaskBuildAssignmentServiceError && error.code === "work_task_build_assignment_unavailable");
  console.log("  PASS: a second build cannot overlap the active exact WorkTask assignment");
});
{
  const source = fs.readFileSync(path.join(__dirname, "work-task-build-assignment-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|push|pull_request|merge|deploy)/);
  console.log("  PASS: build assignment service has no transport, process, or publication authority");
}
console.log("work-task-build-assignment-service.test.js: all assertions passed");
