"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { DeliveryCandidateRuntimeError, createDeliveryCandidateRuntime } = require("./delivery-candidate-runtime");

const installation_id = "installation_runtime_1060", project_id = "quadwork", base_sha = "a".repeat(40), candidate_sha = "b".repeat(40), result_sha = "c".repeat(40);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function candidate(ref) {
  return buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: "task/runtime", worktree: { repository_key: "web", worktree_id: "wt_runtime", path: "/var/quadwork/runtime" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path.replace("/var/", "/private/var/") }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_runtime", canonical_path: input.expected.canonical_path, branch: "task/runtime", base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}
function released(work) {
  const opened = openTaskReviewRound({ version: 1, candidate: work, attempt: "attempt_runtime", round: 1, opened_at: "2026-09-02T05:00:00.000Z" }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
  const receipt = (role) => { const input = { version: 1, review_round_ref: copy(opened.review_round_ref), receipt_id: `receipt_${role}_runtime`, verdict: "approve", findings: [] }; return { ...input, receipt_digest: digest(input) }; };
  const first = submitTaskReviewReceipt(opened, receipt("re1"), { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T05:01:00.000Z" });
  return submitTaskReviewReceipt(first.round, receipt("re2"), { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T05:02:00.000Z" }).round;
}
function fixture() {
  const batch = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{ task_key: "runtime", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1060, kind: "issue" }, goal: "prepare a server-owned delivery candidate", file_boundary: ["server/runtime.js"], validation: ["node-test"], dependencies: [] }] }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "d".repeat(64) }; },
  }), "2026-09-02T05:00:00.000Z");
  const work = candidate(batch.tasks[0].ref);
  return { version: 1, registered_repository: { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" }, frozen_batch_manifest: batch, delivery_mode: "integrated", cut_id: "cut_runtime_1060", base_sha, staged_tasks: [{ candidate: work, review_round: released(work) }], deferred_exclusions: [] };
}
function evidence() {
  const paths = ["server/runtime.js"], base_tree_sha = "e".repeat(40), result_tree_sha = "f".repeat(40);
  return { version: 1, installation_id, project_id, repository_key: "web", result_sha, evidence: { boundary: { paths, boundary_digest: digest({ version: 1, paths }) }, patch: { base_sha, result_sha, patch_digest: "1".repeat(64) }, tree: { base_tree_sha, result_tree_sha, tree_digest: digest({ version: 1, base_tree_sha, result_tree_sha }) } } };
}
function runtime(overrides = {}) {
  const calls = { source: 0, evidence: 0, initialize: [], compose: [] };
  const sessions = new Map([[`${project_id}/head`, { projectId: project_id, agentId: "head", state: "running", term: {}, lifecycleState: "verified" }]]);
  const value = createDeliveryCandidateRuntime({
    config_dir: "/private/var/quadwork", fs, read_config() { return { installation_id, projects: [{ id: project_id, archived: false }] }; },
    capture_project_admission() { return { project_id, generation: 7 }; }, is_admission_current() { return true; },
    resolve_shim_principal(token) { return token === "head-token" ? { projectId: project_id, agentId: "head" } : null; }, agent_sessions: sessions,
    read_delivery_source(request) { calls.source += 1; assert.equal(Object.isFrozen(request), true); return overrides.source || fixture(); },
    read_delivery_evidence(request) { calls.evidence += 1; assert.equal(Object.isFrozen(request), true); return overrides.evidence || evidence(); },
    create_candidate_store() { return {}; }, repository_objects_for() { return {}; },
    create_composition_service(options) { return { initializeCandidate(input) { calls.initialize.push(copy(input)); return { kind: "delivery_candidate_initialized", record: { delivery_candidate_ref: input.delivery_candidate_ref, delivery_manifest_digest: input.delivery_manifest.delivery_manifest_digest } }; }, composeCandidate(input) { calls.compose.push(copy(input)); return { kind: "delivery_candidate_composed", record: { delivery_candidate_ref: input.delivery_candidate_ref } }; } }; },
  });
  return { value, calls };
}

{
  const subject = runtime();
  const prepared = subject.value.prepare({ token: "head-token", body: { repository_key: "web" } });
  assert.equal(prepared.kind, "delivery_candidate_initialized");
  assert.equal(subject.calls.source, 1); assert.equal(subject.calls.evidence, 1);
  assert.equal(subject.calls.initialize[0].delivery_manifest.delivery_candidate_ref.result_sha, result_sha);
  assert.equal(subject.calls.initialize[0].delivery_manifest.staged_tasks.length, 1);
  const composed = subject.value.compose({ token: "head-token", body: { delivery_candidate_ref: prepared.record.delivery_candidate_ref, expected_revision: 0, correlation_id: "compose-runtime-1060", idempotency_key: "compose-runtime-1060" } });
  assert.equal(composed.kind, "delivery_candidate_composed");
  assert.equal(subject.calls.compose[0].head_binding.generation, 7);
  console.log("  PASS: authenticated Head derives Delivery Candidate provenance and evidence without caller paths, bases, reviews, or patches");
}

{
  const subject = runtime();
  assert.throws(() => subject.value.prepare({ token: "other", body: { repository_key: "web" } }), (error) => error instanceof DeliveryCandidateRuntimeError && error.code === "delivery_candidate_principal_unavailable");
  assert.throws(() => subject.value.prepare({ token: "head-token", body: { repository_key: "web", result_sha } }), (error) => error instanceof DeliveryCandidateRuntimeError && error.code === "invalid_delivery_candidate_prepare_request");
  assert.equal(subject.calls.source, 0);
  console.log("  PASS: caller cannot select result SHA or bypass the verified Head principal");
}

{
  const source = fs.readFileSync(path.join(__dirname, "delivery-candidate-runtime.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:child_process|http|https|net|os)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp-chat-shim)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|push|pull_request|\bmerge\b|deploy|writeFile)/);
  console.log("  PASS: Delivery Candidate runtime is a fixed Head bridge with no process, transport, or publication authority");
}

console.log("delivery-candidate-runtime.test.js: all assertions passed");
