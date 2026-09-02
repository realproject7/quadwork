"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");
const { DeliveryReviewTargetError, TARGET_KIND, deriveDeliveryReviewTarget } = require("./delivery-review-target");

const installation_id = "installation_delivery_target_01", project_id = "quadwork";
const base_sha = "a".repeat(64), candidate_sha = "b".repeat(64), result_sha = "c".repeat(64);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function releasedRound(candidate) {
  const opened = openTaskReviewRound({ version: 1, candidate, attempt: "attempt_target", round: 1, opened_at: "2026-09-02T02:00:00.000Z" }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
  const receipt = (role) => { const payload = { version: 1, review_round_ref: copy(opened.review_round_ref), receipt_id: `receipt_${role}_target`, verdict: "approve", findings: [] }; return { ...payload, receipt_digest: digest(payload) }; };
  const one = submitTaskReviewReceipt(opened, receipt("re1"), { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T02:01:00.000Z" });
  return submitTaskReviewReceipt(one.round, receipt("re2"), { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T02:02:00.000Z" }).round;
}
function manifest() {
  const batch = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{ task_key: "target", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" }, goal: "review delivery", file_boundary: ["server/target.js"], validation: ["node-test"], dependencies: [] }] }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "d".repeat(64) }; },
  }), "2026-09-02T02:00:00.000Z");
  const ref = batch.tasks[0].ref;
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: "worktree-dev", worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_dev", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  const deliveryRef = { version: 1, installation_id, project_id, repository_key: "web", batch_manifest_digest: batch.manifest_digest, delivery_mode: "integrated", base_sha, result_sha, cut_id: "cut_delivery_target" };
  const paths = ["server/target.js"];
  return buildDeliveryManifest({ version: 1, delivery_candidate_ref: deliveryRef, frozen_batch_manifest: batch, staged_tasks: [{ candidate, review_round: releasedRound(candidate) }], deferred_exclusions: [], evidence: { boundary: { paths, boundary_digest: digest({ version: 1, paths }) }, patch: { base_sha, result_sha, patch_digest: "e".repeat(64) }, tree: { base_tree_sha: "f".repeat(64), result_tree_sha: "1".repeat(64), tree_digest: digest({ version: 1, base_tree_sha: "f".repeat(64), result_tree_sha: "1".repeat(64) }) } } }, {
    resolveRegisteredRepository() { return { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" }; },
  });
}

{
  const target = deriveDeliveryReviewTarget({ delivery_manifest: manifest(), pr: { number: 88, exact_sha: "2".repeat(40), draft: false, mergeable: true }, ci_policy: { version: 1, mode: "github-checks", registration_grace_seconds: 60, same_sha_retry_budget: 1, checks: [{ name: "test", required: true, kind: "product" }] } });
  assert.equal(target.target_kind, TARGET_KIND);
  assert.equal(target.identity.delivery_manifest_digest.length, 64);
  assert.equal(target.identity.work_items.length, 1);
  assert.equal(target.identity.work_items[0].number, 42);
  assert.equal(target.observed.mergeable, true);
  assert.match(target.target_identity_digest, /^[a-f0-9]{64}$/);
  console.log("  PASS: sealed Delivery Candidate final target binds manifest, PR tip, policy, and all included items");
}

{
  const value = { delivery_manifest: manifest(), pr: { number: 88, exact_sha: "2".repeat(40), draft: false, mergeable: true }, ci_policy: null };
  const first = deriveDeliveryReviewTarget(value);
  const retip = deriveDeliveryReviewTarget({ ...value, pr: { ...value.pr, exact_sha: "3".repeat(40) } });
  assert.notEqual(first.target_identity_digest, retip.target_identity_digest);
  assert.equal(first.slot_digest, retip.slot_digest);
  assert.throws(() => deriveDeliveryReviewTarget({ ...value, pr: { ...value.pr, exact_sha: "nope" } }), (error) => error instanceof DeliveryReviewTargetError && error.code === "invalid_delivery_review_target_source");
  console.log("  PASS: tip changes invalidate final target identity without changing its PR slot");
}

{
  const source = fs.readFileSync(path.join(__dirname, "delivery-review-target.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp|review-cycle)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|\bpush\b|pull_request|\bmerge\b|\bdeploy\b|writeFile)/);
  console.log("  PASS: Delivery Candidate target adapter has no transport, cycle-store, or publication authority");
}

console.log("delivery-review-target.test.js: all assertions passed");
