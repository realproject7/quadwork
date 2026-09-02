"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createWorkTaskIndependentReviewService } = require("./work-task-independent-review-service");
const { createWorkTaskReviewReconciliationService } = require("./work-task-review-reconciliation-service");
const { createWorkTaskDeliverySource, WorkTaskDeliverySourceError } = require("./work-task-delivery-source");

const installation_id = "installation_delivery_source_01", project_id = "quadwork";
const base_sha = "a".repeat(64), candidate_sha = "b".repeat(64);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function receipt(round, receipt_id) {
  const payload = { version: 1, review_round_ref: copy(round), receipt_id, verdict: "approve", findings: [] };
  return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") };
}
function withDirectory(run) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-delivery-source-")); try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
function candidate(ref, index) {
  const sha = index === 0 ? candidate_sha : "c".repeat(64);
  return buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha: sha, branch: "worktree-dev", worktree: { repository_key: ref.repository_key, worktree_id: `wt_${ref.repository_key}_dev`, path: `/private/var/quadwork/${ref.repository_key}-dev` } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: ref.repository_key, worktree_id: `wt_${ref.repository_key}_dev`, canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}
function apply(store, state, event, terminal_disposition = null) {
  const plan = planWorkTaskPipelineEvent(state.pipeline, event);
  return store.applyPlan({ expected: { installation_id, project_id, manifest_digest: state.manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition });
}
function fixture(dir) {
  const tasks = [
    { task_key: "web", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" }, goal: "stage web", file_boundary: ["server/web.js"], validation: ["node-test"], dependencies: [] },
    { task_key: "api", repository_key: "api", work_item: { repoKey: "api", repo: "Owner/Api", number: 43, kind: "issue" }, goal: "stage api", file_boundary: ["server/api.js"], validation: ["node-test"], dependencies: [] },
  ];
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "d".repeat(64) }; },
  }), "2026-09-02T01:00:00.000Z");
  const store = createWorkTaskPipelineStore({ config_dir: dir, fs });
  store.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline: buildWorkTaskPipeline(manifest) });
  const review = createWorkTaskIndependentReviewService({ config_dir: dir, fs });
  const reconciliation = createWorkTaskReviewReconciliationService({ config_dir: dir, fs });
  let state = store.readRecoverySnapshot({ installation_id, project_id });
  const candidates = [];
  const opened = [];
  for (const [index, entry] of manifest.tasks.entries()) {
    const ref = entry.ref, assignment_id = `assignment_${entry.ref.repository_key}_01`;
    state = apply(store, state, { version: 1, kind: "assign_build", event_id: `assign_${entry.ref.repository_key}_01`, work_task_ref: copy(ref), assignment_id, base_sha });
    const local = candidate(ref, index); candidates.push(local);
    state = apply(store, state, { version: 1, kind: "record_candidate", event_id: `candidate_${entry.ref.repository_key}_01`, assignment_id, candidate: local });
    const round = review.openIndependentReview({ version: 1, event_id: `open_${entry.ref.repository_key}_01`, work_task_ref: copy(ref), attempt: `attempt_${entry.ref.repository_key}`, round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }], opened_at: "2026-09-02T01:01:00.000Z" });
    opened.push(round);
    review.submitTrustedReceipt({ version: 1, review_round_ref: round.review_round_ref, candidate_digest: round.candidate_digest, receipt: receipt(round.review_round_ref, `receipt_re1_${entry.ref.repository_key}`) }, { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T01:02:00.000Z" });
    review.submitTrustedReceipt({ version: 1, review_round_ref: round.review_round_ref, candidate_digest: round.candidate_digest, receipt: receipt(round.review_round_ref, `receipt_re2_${entry.ref.repository_key}`) }, { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T01:03:00.000Z" });
    reconciliation.reconcileReleasedReview({ version: 1, work_task_ref: copy(ref), review_round_ref: round.review_round_ref, candidate_digest: round.candidate_digest });
    state = store.readRecoverySnapshot({ installation_id, project_id });
  }
  state = apply(store, state, { version: 1, kind: "integrated_cut", event_id: "cut_delivery_source_01", tasks: manifest.tasks.map((entry, index) => ({ work_task_ref: copy(entry.ref), candidate_digest: candidates[index].candidate_digest })) }, { kind: "integrated_cut", event_id: "cut_delivery_source_01" });
  const source = createWorkTaskDeliverySource({ config_dir: dir, fs, read_registered_repository(request) {
    const entry = request.repository_key === "web" ? "Owner/Web" : request.repository_key === "api" ? "Owner/Api" : null;
    return entry ? { version: 1, installation_id, project_id, repository_key: request.repository_key, repository: entry } : null;
  } });
  return { source, manifest, candidates, store };
}

withDirectory((dir) => {
  const current = fixture(dir);
  const source = current.source.readStagedSource({ version: 1, installation_id, project_id, repository_key: "web" });
  assert.equal(source.cut_id, "cut_delivery_source_01");
  assert.equal(source.base_sha, base_sha);
  assert.equal(source.staged_tasks.length, 1);
  assert.equal(source.staged_tasks[0].candidate.candidate_digest, current.candidates[0].candidate_digest);
  assert.deepEqual(source.staged_tasks[0].terminal_review.receipt_anchors.map((item) => item.reviewer_role), ["re1", "re2"]);
  assert.equal(source.deferred_exclusions.length, 1);
  assert.equal(source.deferred_exclusions[0].work_task_ref.repository_key, "api");
  assert.doesNotMatch(JSON.stringify(source), /"findings"|finding_/, "delivery source has anchors but no reviewer receipt bodies or findings");
  console.log("  PASS: staged repository delivery source is derived from exact pipeline and sealed review state");
});

withDirectory((dir) => {
  const current = fixture(dir);
  let state = current.store.readRecoverySnapshot({ installation_id, project_id });
  const api = state.manifest.tasks.find((entry) => entry.ref.repository_key === "api");
  // A terminal state alone is insufficient: all repository tasks must be in
  // the same explicit integrated cut before the source reader exposes them.
  state = apply(current.store, state, { version: 1, kind: "block", event_id: "block_api_01", work_task_ref: copy(api.ref), block_code: "integrity" });
  assert.throws(() => current.source.readStagedSource({ version: 1, installation_id, project_id, repository_key: "api" }),
    (error) => error instanceof WorkTaskDeliverySourceError && error.code === "work_task_delivery_staging_incomplete");
  console.log("  PASS: an incomplete staged repository slice fails closed");
});

{
  const source = fs.readFileSync(path.join(__dirname, "work-task-delivery-source.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp|pty-dispatcher|delivery-composer)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|push|pull_request|merge|deploy|writeFile|applyPatch)/);
  console.log("  PASS: delivery source reader has no transport, process, persistence, or publication authority");
}

console.log("work-task-delivery-source.test.js: all assertions passed");
