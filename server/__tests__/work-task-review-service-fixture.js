"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("../work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("../work-task-pipeline");
const { buildWorkTaskCandidate } = require("../work-task-candidate");
const { createWorkTaskPipelineStore } = require("../work-task-pipeline-store");
const { createWorkTaskIndependentReviewService, WorkTaskIndependentReviewServiceError } = require("../work-task-independent-review-service");
const { createTaskReviewRoundStore } = require("../task-review-round-store");
const { createWorkTaskReviewReconciliationService } = require("../work-task-review-reconciliation-service");

const installation_id = "installation_review_service_0001", project_id = "quadwork";
const base_sha = "a".repeat(64), candidate_sha = "b".repeat(64);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, code) { assert.throws(fn, (error) => error instanceof WorkTaskIndependentReviewServiceError && error.code === code); }
function withDirectory(run) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-independent-review-")); try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); } }
function candidateFor(ref, sha) {
  return buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha: sha, branch: "worktree-dev", worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; }, inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_dev", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: sha, dirty: false, occupancy: "vacant" }; }, readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}
function fixture(directory) {
  const reviewItem = { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" };
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [
    { task_key: "review", repository_key: "web", work_item: copy(reviewItem), goal: "seal two independent receipts", file_boundary: ["server/review.js"], validation: ["node-test"], dependencies: [] },
    { task_key: "dependent", repository_key: "web", work_item: copy(reviewItem), goal: "build on the reviewed slice", file_boundary: ["server/dependent.js"], validation: ["node-test"], dependencies: [{ repository_key: "web", work_item: copy(reviewItem), task_key: "review" }] },
    { task_key: "unrelated", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 43, kind: "issue" }, goal: "independent slice", file_boundary: ["server/unrelated.js"], validation: ["node-test"], dependencies: [] },
  ] }, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; } }), "2026-09-02T00:00:00.000Z");
  const ref = manifest.tasks[0].ref;
  let pipeline = buildWorkTaskPipeline(manifest);
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  store.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline });
  let state = store.readRecoverySnapshot({ installation_id, project_id });
  let plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "assign_build", event_id: "review_assign_build", work_task_ref: copy(ref), assignment_id: "review_assignment", base_sha });
  store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
  state = store.readRecoverySnapshot({ installation_id, project_id });
  const candidate = candidateFor(ref, candidate_sha);
  plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "record_candidate", event_id: "review_candidate", assignment_id: "review_assignment", candidate });
  store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
  return { ref, manifest, candidate, store, service: createWorkTaskIndependentReviewService({ config_dir: directory, fs }) };
}
function receipt(round, id, verdict, findings = []) { const payload = { version: 1, review_round_ref: round, receipt_id: id, verdict, findings: copy(findings) }; const crypto = require("node:crypto"); const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v); return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") }; }
function reviewers() { return [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }]; }
function sealBoth(service, opened, verdicts, at = "00") {
  service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, `receipt_re1_${at}`, verdicts[0]) }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: `2026-09-02T01:${at}:01.000Z` });
  service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, `receipt_re2_${at}`, verdicts[1]) }, { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: `2026-09-02T01:${at}:02.000Z` });
}
function applyEvent(store, manifest, nextEvent) {
  const state = store.readRecoverySnapshot({ installation_id, project_id });
  const plan = planWorkTaskPipelineEvent(state.pipeline, nextEvent);
  return store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
}

module.exports = { fixture, candidateFor, receipt, applyEvent, installation_id, project_id, copy };
