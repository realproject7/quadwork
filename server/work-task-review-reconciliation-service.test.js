"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createWorkTaskIndependentReviewService } = require("./work-task-independent-review-service");
const { createWorkTaskReviewReconciliationService, WorkTaskReviewReconciliationServiceError } = require("./work-task-review-reconciliation-service");

const installation_id = "installation_reconcile_service_0001", project_id = "quadwork";
const base_sha = "a".repeat(64), candidate_sha = "b".repeat(64);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function receipt(round, receipt_id, verdict) {
  const payload = { version: 1, review_round_ref: copy(round), receipt_id, verdict, findings: [] };
  return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") };
}
function withDirectory(run) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-review-reconcile-")); try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); } }
function fixture(directory, verdicts) {
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{
    task_key: "reconcile", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" },
    goal: "reconcile released independent review", file_boundary: ["server/reconcile.js"], validation: ["node-test"], dependencies: [],
  }] }, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; } }), "2026-09-02T00:00:00.000Z");
  const ref = manifest.tasks[0].ref;
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: directory, fs });
  pipelineStore.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline: buildWorkTaskPipeline(manifest) });
  let state = pipelineStore.readRecoverySnapshot({ installation_id, project_id });
  let plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "assign_build", event_id: "assign_reconcile", work_task_ref: copy(ref), assignment_id: "assignment_reconcile", base_sha });
  pipelineStore.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
  state = pipelineStore.readRecoverySnapshot({ installation_id, project_id });
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: "worktree-dev", worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_dev", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "record_candidate", event_id: "candidate_reconcile", assignment_id: "assignment_reconcile", candidate });
  pipelineStore.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
  const review = createWorkTaskIndependentReviewService({ config_dir: directory, fs });
  const opened = review.openIndependentReview({ version: 1, event_id: "open_reconcile", work_task_ref: copy(ref), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }], opened_at: "2026-09-02T00:01:00.000Z" });
  review.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re1_01", verdicts[0]) }, { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T00:02:00.000Z" });
  review.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re2_01", verdicts[1]) }, { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T00:03:00.000Z" });
  return { ref, opened, pipelineStore, service: createWorkTaskReviewReconciliationService({ config_dir: directory, fs }) };
}

withDirectory((directory) => {
  const current = fixture(directory, ["approve", "request_changes"]);
  const reconciled = current.service.reconcileReleasedReview({ version: 1, work_task_ref: copy(current.ref), review_round_ref: copy(current.opened.review_round_ref), candidate_digest: current.opened.candidate_digest });
  assert.deepEqual({ verdict: reconciled.verdict, resolution: reconciled.resolution, outcome: reconciled.outcome }, { verdict: "changes_requested", resolution: "changes_requested", outcome: "reconciled" });
  const state = current.pipelineStore.readRecoverySnapshot({ installation_id, project_id });
  assert.equal(state.pipeline.tasks[0].state, "changes_requested");
  assert.deepEqual(state.pipeline.tasks[0].history.slice(-2).map((entry) => entry.kind), ["record_review_verdict", "reconcile_review"]);
  assert.equal(current.service.reconcileReleasedReview({ version: 1, work_task_ref: copy(current.ref), review_round_ref: copy(current.opened.review_round_ref), candidate_digest: current.opened.candidate_digest }).outcome, "idempotent");
  console.log("  PASS: released change request advances through durable verdict and reconciliation exactly once");
});

withDirectory((directory) => {
  const current = fixture(directory, ["approve", "approve"]);
  const reconciled = current.service.reconcileReleasedReview({ version: 1, work_task_ref: copy(current.ref), review_round_ref: copy(current.opened.review_round_ref), candidate_digest: current.opened.candidate_digest });
  assert.equal(reconciled.resolution, "accepted");
  assert.equal(current.pipelineStore.readRecoverySnapshot({ installation_id, project_id }).pipeline.tasks[0].state, "accepted");
  console.log("  PASS: only two approvals advance an exact candidate to accepted");
});

{
  const source = fs.readFileSync(path.join(__dirname, "work-task-review-reconciliation-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:push|pull_request|merge|deploy|execFile|spawn\s*\(|receipt\.findings)/);
  assert.throws(() => createWorkTaskReviewReconciliationService({ config_dir: null, fs }), (error) => error instanceof WorkTaskReviewReconciliationServiceError);
  console.log("  PASS: reconciliation service remains transport-free and never receives review findings");
}

console.log("work-task-review-reconciliation-service.test.js: all assertions passed");
