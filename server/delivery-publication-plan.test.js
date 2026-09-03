"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");
const { DeliveryPublicationPlanError, createDeliveryPublicationPlanService } = require("./delivery-publication-plan");

const installation_id = "installation_publication_plan", project_id = "quadwork";
const base_sha = "a".repeat(40), candidate_sha = "b".repeat(40), result_sha = "c".repeat(40);
const owner = { installation_id, project_id, role: "head", generation: 4 };
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function manifest() {
  const batch = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{ task_key: "publish", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1060, kind: "issue" }, goal: "plan publication", file_boundary: ["server/publish.js"], validation: ["node-test"], dependencies: [] }] }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "d".repeat(64) }; },
  }), "2026-09-02T10:00:00.000Z");
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(batch.tasks[0].ref), base_sha, candidate_sha, branch: "task/publish", worktree: { repository_key: "web", worktree_id: "wt_publish", path: "/private/var/quadwork/publish" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_publish", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  const opened = openTaskReviewRound({ version: 1, candidate, attempt: "attempt_publish", round: 1, opened_at: "2026-09-02T10:01:00.000Z" }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
  const receipt = (role) => { const input = { version: 1, review_round_ref: copy(opened.review_round_ref), receipt_id: `receipt_${role}_publish`, verdict: "approve", findings: [] }; return { ...input, receipt_digest: digest(input) }; };
  const first = submitTaskReviewReceipt(opened, receipt("re1"), { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T10:02:00.000Z" });
  const released = submitTaskReviewReceipt(first.round, receipt("re2"), { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T10:03:00.000Z" }).round;
  const ref = { version: 1, installation_id, project_id, repository_key: "web", batch_manifest_digest: batch.manifest_digest, delivery_mode: "integrated", base_sha, result_sha, cut_id: "cut_publication" };
  const paths = ["server/publish.js"];
  return buildDeliveryManifest({ version: 1, delivery_candidate_ref: ref, frozen_batch_manifest: batch, staged_tasks: [{ candidate, review_round: released }], deferred_exclusions: [], evidence: { boundary: { paths, boundary_digest: digest({ version: 1, paths }) }, patch: { base_sha, result_sha, patch_digest: "e".repeat(64) }, tree: { base_tree_sha: "f".repeat(40), result_tree_sha: "1".repeat(40), tree_digest: digest({ version: 1, base_tree_sha: "f".repeat(40), result_tree_sha: "1".repeat(40) }) } } }, {
    resolveRegisteredRepository() { return { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" }; },
  });
}

{
  const current = manifest();
  const service = createDeliveryPublicationPlanService({
    read_candidate_snapshot(request) {
      assert.equal(Object.isFrozen(request), true);
      return { delivery_candidate_ref: copy(current.delivery_candidate_ref), lifecycle: { status: "composed" }, delivery_manifest: copy(current), composition_proof: { sealed: true } };
    },
  });
  const first = service.plan({ version: 1, head_binding: owner, delivery_candidate_ref: copy(current.delivery_candidate_ref) });
  const replay = service.plan({ version: 1, head_binding: owner, delivery_candidate_ref: copy(current.delivery_candidate_ref) });
  assert.equal(first.kind, "delivery_publication_operator_gate");
  assert.equal(first.operator_approval_required, true);
  assert.equal(first.repository, "owner/web");
  assert.equal(first.exact_sha, result_sha);
  assert.match(first.branch, /^quadwork\/delivery-[a-f0-9]{32}$/);
  assert.match(first.body, new RegExp(current.delivery_manifest_digest));
  assert.deepEqual(first, replay);
  console.log("  PASS: composed Delivery Candidate yields one deterministic operator-gated publication plan");
}

{
  const current = manifest();
  const pending = createDeliveryPublicationPlanService({ read_candidate_snapshot() { return { delivery_candidate_ref: copy(current.delivery_candidate_ref), lifecycle: { status: "pending_composition" }, delivery_manifest: copy(current), composition_proof: null }; } });
  assert.throws(() => pending.plan({ version: 1, head_binding: owner, delivery_candidate_ref: copy(current.delivery_candidate_ref) }),
    (error) => error instanceof DeliveryPublicationPlanError && error.code === "delivery_publication_snapshot_invalid");
  assert.throws(() => createDeliveryPublicationPlanService({ read_candidate_snapshot() { throw new Error("nope"); } }).plan({ version: 1, head_binding: { ...owner, project_id: "other" }, delivery_candidate_ref: copy(current.delivery_candidate_ref) }),
    (error) => error instanceof DeliveryPublicationPlanError && error.code === "delivery_publication_head_denied");
  console.log("  PASS: uncomposed and cross-project candidates cannot mint an operator publication plan");
}

{
  const source = fs.readFileSync(path.join(__dirname, "delivery-publication-plan.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https|net|os)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|\bpush\b|pull_request|\bmerge\b|\bdeploy\b|writeFile)/);
  console.log("  PASS: publication planning has no transport, process, persistence, or external-write authority");
}

console.log("delivery-publication-plan.test.js: all assertions passed");
