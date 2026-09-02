"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");
const { DeliveryFinalReviewServiceError, createDeliveryFinalReviewService } = require("./delivery-final-review-service");

const installation_id = "installation_final_review_01", project_id = "quadwork";
const base_sha = "a".repeat(40), candidate_sha = "b".repeat(40), result_sha = "c".repeat(40);
const owner = { installation_id, project_id, role: "head", generation: 3 };
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function manifest() {
  const batch = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{ task_key: "final", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1061, kind: "issue" }, goal: "admit final review", file_boundary: ["server/final.js"], validation: ["node-test"], dependencies: [] }] }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "d".repeat(64) }; },
  }), "2026-09-02T09:00:00.000Z");
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(batch.tasks[0].ref), base_sha, candidate_sha, branch: "task/final", worktree: { repository_key: "web", worktree_id: "wt_web_final", path: "/private/var/quadwork/final" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_final", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  const opened = openTaskReviewRound({ version: 1, candidate, attempt: "attempt_final", round: 1, opened_at: "2026-09-02T09:01:00.000Z" }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
  const receipt = (role) => { const payload = { version: 1, review_round_ref: copy(opened.review_round_ref), receipt_id: `receipt_${role}_final`, verdict: "approve", findings: [] }; return { ...payload, receipt_digest: digest(payload) }; };
  const first = submitTaskReviewReceipt(opened, receipt("re1"), { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T09:02:00.000Z" });
  const released = submitTaskReviewReceipt(first.round, receipt("re2"), { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T09:03:00.000Z" }).round;
  const ref = { version: 1, installation_id, project_id, repository_key: "web", batch_manifest_digest: batch.manifest_digest, delivery_mode: "integrated", base_sha, result_sha, cut_id: "cut_final_review" };
  const paths = ["server/final.js"];
  return buildDeliveryManifest({ version: 1, delivery_candidate_ref: ref, frozen_batch_manifest: batch, staged_tasks: [{ candidate, review_round: released }], deferred_exclusions: [], evidence: { boundary: { paths, boundary_digest: digest({ version: 1, paths }) }, patch: { base_sha, result_sha, patch_digest: "e".repeat(64) }, tree: { base_tree_sha: "f".repeat(40), result_tree_sha: "1".repeat(40), tree_digest: digest({ version: 1, base_tree_sha: "f".repeat(40), result_tree_sha: "1".repeat(40) }) } } }, {
    resolveRegisteredRepository() { return { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" }; },
  });
}

function service(current, overrides = {}) {
  const calls = { snapshot: 0, pr: 0, policy: 0 };
  const value = createDeliveryFinalReviewService({
    read_candidate_snapshot(request) {
      calls.snapshot += 1; assert.equal(Object.isFrozen(request), true);
      return overrides.snapshot || { delivery_candidate_ref: copy(current.delivery_candidate_ref), lifecycle: { status: "composed" }, delivery_manifest: copy(current), composition_proof: { sealed: true } };
    },
    read_pr(request) {
      calls.pr += 1; assert.equal(Object.isFrozen(request), true);
      return overrides.pr || { number: request.pr_number, exact_sha: result_sha, draft: false, mergeable: true };
    },
    read_ci_policy(request) {
      calls.policy += 1; assert.equal(Object.isFrozen(request), true);
      return overrides.policy === undefined ? { version: 1, mode: "github-checks", registration_grace_seconds: 0, same_sha_retry_budget: 0, checks: [{ name: "unit", required: true, kind: "product" }] } : overrides.policy;
    },
  });
  return { value, calls };
}

{
  const current = manifest();
  const subject = service(current);
  const target = subject.value.open({ version: 1, head_binding: owner, delivery_candidate_ref: copy(current.delivery_candidate_ref), pr_number: 1062 });
  assert.equal(target.target_kind, "delivery_candidate_pr");
  assert.equal(target.identity.exact_sha, result_sha);
  assert.equal(target.identity.delivery_manifest_digest, current.delivery_manifest_digest);
  assert.deepEqual(subject.calls, { snapshot: 1, pr: 1, policy: 1 });
  console.log("  PASS: composed Delivery Candidate and same-SHA observed PR derive the final review target");
}

{
  const current = manifest();
  const pending = service(current, { snapshot: { delivery_candidate_ref: copy(current.delivery_candidate_ref), lifecycle: { status: "pending_composition" }, delivery_manifest: copy(current), composition_proof: null } });
  assert.throws(() => pending.value.open({ version: 1, head_binding: owner, delivery_candidate_ref: copy(current.delivery_candidate_ref), pr_number: 1062 }),
    (error) => error instanceof DeliveryFinalReviewServiceError && error.code === "delivery_final_review_snapshot_invalid");
  const retipped = service(current, { pr: { number: 1062, exact_sha: "9".repeat(40), draft: false, mergeable: true } });
  assert.throws(() => retipped.value.open({ version: 1, head_binding: owner, delivery_candidate_ref: copy(current.delivery_candidate_ref), pr_number: 1062 }),
    (error) => error instanceof DeliveryFinalReviewServiceError && error.code === "delivery_final_review_pr_invalid");
  assert.throws(() => service(current).value.open({ version: 1, head_binding: { ...owner, project_id: "other" }, delivery_candidate_ref: copy(current.delivery_candidate_ref), pr_number: 1062 }),
    (error) => error instanceof DeliveryFinalReviewServiceError && error.code === "delivery_final_review_head_denied");
  console.log("  PASS: pending, retipped, and cross-project candidates fail before final review admission");
}

{
  const source = fs.readFileSync(path.join(__dirname, "delivery-final-review-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https|net|os)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|\bpush\b|pull_request|\bmerge\b|\bdeploy\b|writeFile)/);
  console.log("  PASS: final-review admission has no process, transport, publication, or persistence authority");
}

console.log("delivery-final-review-service.test.js: all assertions passed");
