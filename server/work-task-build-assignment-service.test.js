"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskIndependentReviewService } = require("./work-task-independent-review-service");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createWorkTaskBuildAssignmentService, WorkTaskBuildAssignmentServiceError } = require("./work-task-build-assignment-service");
const installation_id = "installation_build_service_0001", project_id = "quadwork", base_sha = "a".repeat(40);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function withDir(run) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-build-service-")); try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
function fixture(dir) {
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [
    { task_key: "build", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" }, goal: "assign a server base", file_boundary: ["server/build.js"], validation: ["node-test"], dependencies: [] },
    { task_key: "other", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 43, kind: "issue" }, goal: "keep another task queued", file_boundary: ["server/other.js"], validation: ["node-test"], dependencies: [] },
  ] }, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; } }), "2026-09-02T00:00:00.000Z");
  const store = createWorkTaskPipelineStore({ config_dir: dir, fs });
  store.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline: buildWorkTaskPipeline(manifest) });
  const calls = [];
  const observed = { sha: base_sha };
  const service = createWorkTaskBuildAssignmentService({ config_dir: dir, fs, read_registered_base(request) { calls.push(request); return { version: 1, repository_key: "web", base_sha: observed.sha }; } });
  return { ref: manifest.tasks[0].ref, store, service, calls, observed };
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
withDir((dir) => {
  const current = fixture(dir);
  const first = current.service.assignBuild({ version: 1, event_id: "assign_before_drift", work_task_ref: copy(current.ref) });
  const before = current.store.readRecoverySnapshot({ installation_id, project_id }).pipeline;
  current.observed.sha = "b".repeat(40);
  const request = { version: 1, event_id: "recover_before_candidate", work_task_ref: copy(current.ref), expected_pipeline_digest: before.pipeline_digest };
  const recovered = current.service.recoverStaleBase(request);
  assert.equal(recovered.outcome, "recovered");
  assert.equal(current.service.recoverStaleBase(request).outcome, "idempotent", "interrupted retry does not create another recovery");
  const state = current.store.readRecoverySnapshot({ installation_id, project_id }).pipeline;
  assert.equal(state.tasks[0].state, "queued");
  assert.deepEqual(state.tasks[1], before.tasks[1], "other task remains unchanged");
  assert.equal(state.tasks[0].build_assignment, null);
  assert.equal(state.tasks[0].retired_builds[0].assignment.assignment_id, first.assignment_id);
  assert.equal(state.repository_bases[0].base_sha, current.observed.sha);
  assert.throws(() => current.service.recoverStaleBase({ ...request, event_id: "recover_stale_revision" }),
    (error) => error instanceof WorkTaskBuildAssignmentServiceError && error.code === "work_task_stale_base_recovery_stale");
  const second = current.service.assignBuild({ version: 1, event_id: "assign_after_drift", work_task_ref: copy(current.ref) });
  assert.equal(second.base_sha, current.observed.sha);
  assert.notEqual(second.assignment_id, first.assignment_id, "retired Dev authority is never reused");
  assert.throws(() => current.service.assignBuild({ version: 1, event_id: "assign_before_drift", work_task_ref: copy(current.ref) }),
    (error) => error instanceof WorkTaskBuildAssignmentServiceError && error.code === "work_task_build_event_conflict",
    "retrying the old assignment cannot return the new Dev authority");
  console.log("  PASS: stale-base recovery retires an active build once and pins the new observed base on reassignment");
});
withDir((dir) => {
  const current = fixture(dir);
  const first = current.service.assignBuild({ version: 1, event_id: "assign_candidate_drift", work_task_ref: copy(current.ref) });
  const candidateSha = "c".repeat(40);
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(current.ref), base_sha, candidate_sha: candidateSha,
    branch: "worktree-dev", worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_dev",
      canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: candidateSha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  let state = current.store.readRecoverySnapshot({ installation_id, project_id });
  const plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "record_candidate", event_id: "candidate_before_drift",
    assignment_id: first.assignment_id, candidate });
  current.store.applyPlan({ expected: { installation_id, project_id, manifest_digest: state.manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest },
    plan, terminal_disposition: null });
  state = current.store.readRecoverySnapshot({ installation_id, project_id });
  current.observed.sha = "b".repeat(40);
  const recovered = current.service.recoverStaleBase({ version: 1, event_id: "recover_after_candidate",
    work_task_ref: copy(current.ref), expected_pipeline_digest: state.pipeline.pipeline_digest });
  assert.equal(recovered.outcome, "recovered");
  const after = current.store.readRecoverySnapshot({ installation_id, project_id }).pipeline;
  assert.equal(after.tasks[0].state, "queued");
  assert.equal(after.tasks[0].candidate, null);
  assert.equal(after.tasks[0].retired_builds[0].candidate.candidate_digest, candidate.candidate_digest);
  assert.equal(after.tasks[0].retired_builds[0].assignment.assignment_id, first.assignment_id);
  const second = current.service.assignBuild({ version: 1, event_id: "assign_candidate_again", work_task_ref: copy(current.ref) });
  assert.notEqual(second.assignment_id, first.assignment_id);
  assert.throws(() => planWorkTaskPipelineEvent(current.store.readRecoverySnapshot({ installation_id, project_id }).pipeline,
    { version: 1, kind: "record_candidate", event_id: "old_candidate_retry", assignment_id: first.assignment_id, candidate }),
  (error) => error.code === "work_task_candidate_assignment_mismatch");
  console.log("  PASS: recovery archives a submitted candidate and rejects its old Dev assignment after reassignment");
});
// A task inside a pending pre-release propagation stop's declared chain is
// refused before the registered base is observed; once the round releases,
// the pipeline's own readiness gate is the only authority again.
withDir((dir) => {
  const installation = "installation_build_stop_0001", chainBase = "a".repeat(64), candidateSha = "b".repeat(64);
  const item = { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" };
  const resolveRegisteredIdentity = (input) => ({ ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) });
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id: installation, project_id, delivery_mode: "integrated", tasks: [
    { task_key: "review", repository_key: "web", work_item: copy(item), goal: "seal two independent receipts", file_boundary: ["server/review.js"], validation: ["node-test"], dependencies: [] },
    { task_key: "dependent", repository_key: "web", work_item: copy(item), goal: "build on the reviewed slice", file_boundary: ["server/dependent.js"], validation: ["node-test"], dependencies: [{ repository_key: "web", work_item: copy(item), task_key: "review" }] },
    { task_key: "unrelated", repository_key: "web", work_item: { ...item, number: 43 }, goal: "independent slice", file_boundary: ["server/unrelated.js"], validation: ["node-test"], dependencies: [] },
  ] }, { resolveRegisteredIdentity }), "2026-09-02T00:00:00.000Z");
  const owner = { installation_id: installation, project_id };
  const store = createWorkTaskPipelineStore({ config_dir: dir, fs });
  store.initialize({ expected: { ...owner, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline: buildWorkTaskPipeline(manifest) });
  const apply = (event) => {
    const state = store.readRecoverySnapshot(owner);
    store.applyPlan({ expected: { ...owner, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan: planWorkTaskPipelineEvent(state.pipeline, event), terminal_disposition: null });
  };
  const [reviewRef, dependentRef, unrelatedRef] = manifest.tasks.map((task) => task.ref);
  apply({ version: 1, kind: "assign_build", event_id: "stop_review_build", work_task_ref: copy(reviewRef), assignment_id: "stop_review_assignment", base_sha: chainBase });
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(reviewRef), base_sha: chainBase, candidate_sha: candidateSha, branch: "worktree-dev", worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_dev", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha: chainBase, head_sha: candidateSha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id: installation, project_id, v1_state: "present" }; },
  });
  apply({ version: 1, kind: "record_candidate", event_id: "stop_review_candidate", assignment_id: "stop_review_assignment", candidate });
  const review = createWorkTaskIndependentReviewService({ config_dir: dir, fs });
  const opened = review.openIndependentReview({ version: 1, event_id: "stop_review_open", work_task_ref: copy(reviewRef), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }], opened_at: "2026-09-02T00:01:00.000Z" });
  const receipt = (id, verdict, findings = []) => {
    const crypto = require("node:crypto");
    const payload = { version: 1, review_round_ref: opened.review_round_ref, receipt_id: id, verdict, findings };
    const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
    return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") };
  };
  review.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt("receipt_re2_stop", "request_changes", [{ finding_id: "finding_shared_base", severity: "blocking", propagation: "propagating", summary: "shared base drift" }]) }, { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-02T00:02:00.000Z" });
  assert.equal(review.readPropagationStopPending({ version: 1, work_task_ref: copy(reviewRef) }).dependency_chain.length, 1);

  const calls = [];
  const service = createWorkTaskBuildAssignmentService({ config_dir: dir, fs, read_registered_base(request) { calls.push(request); return { version: 1, repository_key: "web", base_sha: chainBase }; } });
  assert.throws(() => service.assignBuild({ version: 1, event_id: "assign_dependent_stopped", work_task_ref: copy(dependentRef) }),
    (error) => error instanceof WorkTaskBuildAssignmentServiceError && error.code === "work_task_build_propagation_stop_pending");
  assert.equal(calls.length, 0, "the registered base is not observed for a task inside a pending stop");
  assert.equal(store.readRecoverySnapshot(owner).pipeline.tasks[1].state, "queued");
  console.log("  PASS: Head cannot hand Dev a task inside a pending propagation stop's declared chain");

  review.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt("receipt_re1_stop", "approve") }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T00:03:00.000Z" });
  assert.equal(review.readPropagationStopPending({ version: 1, work_task_ref: copy(reviewRef) }), null);
  assert.throws(() => service.assignBuild({ version: 1, event_id: "assign_dependent_released", work_task_ref: copy(dependentRef) }),
    (error) => error instanceof WorkTaskBuildAssignmentServiceError && error.code === "work_task_dependencies_not_ready");
  assert.equal(calls.length, 1, "after release only the pipeline readiness gate refuses the declared dependent");
  assert.equal(service.assignBuild({ version: 1, event_id: "assign_unrelated", work_task_ref: copy(unrelatedRef) }).outcome, "assigned");
  console.log("  PASS: the scheduling-side check defers to the pipeline gate and never widens beyond the declared chain");
});
{
  const source = fs.readFileSync(path.join(__dirname, "work-task-build-assignment-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|push|pull_request|merge|deploy)/);
  console.log("  PASS: build assignment service has no transport, process, or publication authority");
}
console.log("work-task-build-assignment-service.test.js: all assertions passed");
