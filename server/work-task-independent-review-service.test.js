"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createWorkTaskIndependentReviewService, WorkTaskIndependentReviewServiceError } = require("./work-task-independent-review-service");

const installation_id = "installation_review_service_0001", project_id = "quadwork";
const base_sha = "a".repeat(64), candidate_sha = "b".repeat(64);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, code) { assert.throws(fn, (error) => error instanceof WorkTaskIndependentReviewServiceError && error.code === code); }
function withDirectory(run) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-independent-review-")); try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); } }
function fixture(directory) {
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{
    task_key: "review", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" }, goal: "seal two independent receipts", file_boundary: ["server/review.js"], validation: ["node-test"], dependencies: [],
  }] }, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; } }), "2026-09-02T00:00:00.000Z");
  const ref = manifest.tasks[0].ref;
  let pipeline = buildWorkTaskPipeline(manifest);
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  store.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline });
  let state = store.readRecoverySnapshot({ installation_id, project_id });
  let plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "assign_build", event_id: "review_assign_build", work_task_ref: copy(ref), assignment_id: "review_assignment", base_sha });
  store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
  state = store.readRecoverySnapshot({ installation_id, project_id });
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: "worktree-dev", worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; }, inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_dev", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; }, readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "record_candidate", event_id: "review_candidate", assignment_id: "review_assignment", candidate });
  store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
  return { ref, candidate, store, service: createWorkTaskIndependentReviewService({ config_dir: directory, fs }) };
}
function receipt(round, id, verdict) { const payload = { version: 1, review_round_ref: round, receipt_id: id, verdict, findings: [] }; const crypto = require("node:crypto"); const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v); return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") }; }

withDirectory((directory) => {
  const current = fixture(directory);
  const opened = current.service.openIndependentReview({ version: 1, event_id: "review_round_open", work_task_ref: copy(current.ref), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }], opened_at: "2026-09-02T00:01:00.000Z" });
  assert.equal(opened.outcome, "opened");
  assert.match(opened.review_round_ref.candidate_sha, /^[a-f0-9]{64}$/);
  const state = current.store.readRecoverySnapshot({ installation_id, project_id });
  assert.equal(state.pipeline.tasks[0].state, "independent_review");
  const retry = current.service.openIndependentReview({ version: 1, event_id: "review_round_open", work_task_ref: copy(current.ref), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }], opened_at: "2026-09-02T00:01:00.000Z" });
  assert.equal(retry.outcome, "idempotent");
  console.log("  PASS: an exact candidate opens one idempotent two-reviewer pipeline assignment");
  const re1 = current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re1_01", "approve") }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T00:02:00.000Z" });
  assert.equal(re1.outcome, "sealed"); assert.equal(re1.view.status, "sealed"); assert.equal(re1.view.own_receipt.receipt_id, "receipt_re1_01");
  const re2 = current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re2_01", "request_changes") }, { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-02T00:03:00.000Z" });
  assert.equal(re2.outcome, "released"); assert.equal(re2.view.status, "released"); assert.doesNotMatch(JSON.stringify(re2.view), /receipt_re1_01/);
  assert.equal(current.store.readRecoverySnapshot({ installation_id, project_id }).pipeline.tasks[0].state, "independent_review");
  console.log("  PASS: reviewers receive only their sealed view; release does not prematurely infer a delivery verdict");
  throwsCode(() => current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: "d".repeat(64), receipt: receipt(opened.review_round_ref, "receipt_bad_01", "approve") }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T00:04:00.000Z" }), "stale_work_task_review_authority");
  console.log("  PASS: stale candidate receipts cannot cross the pipeline review assignment");
});

{
  const source = fs.readFileSync(path.join(__dirname, "work-task-independent-review-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|mcp|file-chat|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:record_review_verdict|reconcile_review|push|pull_request|merge|deploy|execFile|spawn)/);
  console.log("  PASS: receipt sealing has no transport, publication, or premature verdict-reconciliation authority");
}

console.log("work-task-independent-review-service.test.js: all assertions passed");
