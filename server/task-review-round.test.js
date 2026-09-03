"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { buildBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const {
  TaskReviewRoundError,
  assertTaskReviewRound,
  assertTaskReviewRoundRef,
  taskReviewRoundKey,
  openTaskReviewRound,
  submitTaskReviewReceipt,
  planSealedTaskReviewPropagation,
  viewTaskReviewRound,
  cancelTaskReviewRound,
} = require("./task-review-round");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);
const work_item = { repoKey: "web", repo: "Owner/Product-Web", number: 1059, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function stable(value) {
  return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
}
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof TaskReviewRoundError && error.code === expected);
}
function manifest() {
  return buildBatchManifest({
    version: 1, installation_id, project_id, delivery_mode: "isolated",
    tasks: [{
      task_key: "sealed-review", repository_key: "web", work_item: copy(work_item), goal: "review exact local candidate",
      file_boundary: ["server/task-review-round.js"], validation: ["node:test"], dependencies: [],
    }],
  }, {
    resolveRegisteredIdentity(input) {
      return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) };
    },
  });
}
function candidate() {
  const ref = manifest().tasks[0].ref;
  return buildWorkTaskCandidate({
    version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: "task/sealed-review",
    worktree: { repository_key: "web", worktree_id: "wt_sealed_01", path: "/var/folders/quadwork/sealed-review" },
  }, {
    canonicalizePath(request) { return { version: 1, canonical_path: request.path.replace("/var/", "/private/var/") }; },
    inspectManagedWorktree() {
      return {
        version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_sealed_01",
        canonical_path: "/private/var/folders/quadwork/sealed-review", branch: "task/sealed-review",
        base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}
function assignments() {
  // The opening authority may assign in any order; the round canonicalizes it.
  return { version: 1, reviewers: [{ reviewer_role: "re2", reviewer_generation: 22 }, { reviewer_role: "re1", reviewer_generation: 11 }] };
}
function reviewer(role, generation, received_at) {
  return { version: 1, reviewer_role: role, reviewer_generation: generation, received_at };
}
function receipt(ref, receipt_id, verdict, findings = []) {
  const payload = { version: 1, review_round_ref: copy(ref), receipt_id, verdict, findings: copy(findings) };
  return { ...payload, receipt_digest: digest(payload) };
}
function finding(id, overrides = {}) {
  return {
    finding_id: id, severity: "blocking", propagation: "local", summary: `sealed ${id}`,
    ...overrides,
  };
}
function opened() {
  return openTaskReviewRound({
    version: 1, candidate: candidate(), attempt: "attempt_1059", round: 1, opened_at: "2026-09-01T06:00:00.000Z",
  }, assignments());
}

// A round is exact-pinned to the immutable WorkTask and candidate contract;
// reviewer generations are sourced from the separate trusted assignment input.
{
  const round = opened();
  assert.equal(Object.isFrozen(round), true);
  assert.equal(assertTaskReviewRound(round), round);
  assert.equal(round.review_round_ref.installation_id, installation_id);
  assert.equal(round.review_round_ref.project_id, project_id);
  assert.equal(round.review_round_ref.work_task_ref.task_revision, round.review_round_ref.task_revision);
  assert.equal(round.review_round_ref.base_sha, base_sha);
  assert.equal(round.review_round_ref.candidate_sha, candidate_sha);
  assert.equal(round.reviewer_assignments[0].reviewer_role, "re1");
  assert.match(taskReviewRoundKey(round.review_round_ref), /task-review-round/);
  assert.deepEqual(assertTaskReviewRoundRef(copy(round.review_round_ref)), round.review_round_ref);
}

// A first receipt stays sealed even when re2 arrives before re1.  The only
// pre-release propagation output is dependency identity addressed Head-private.
{
  const round = opened();
  const r2 = receipt(round.review_round_ref, "receipt_re2_01", "request_changes", [finding("finding_re2_01", {
    propagation: "propagating",
  })]);
  const sealed = submitTaskReviewReceipt(round, r2, reviewer("re2", 22, "2026-09-01T06:01:00.000Z"));
  assert.equal(sealed.outcome, "sealed");
  assert.equal(sealed.release, null);
  assert.equal(sealed.round.status, "current");
  assert.equal(sealed.round.receipts.length, 1);
  const re1View = viewTaskReviewRound(sealed.round, reviewer("re1", 11, "2026-09-01T06:01:01.000Z"));
  assert.deepEqual(Object.keys(re1View).sort(), ["own_receipt", "review_round_ref", "status", "version"]);
  assert.equal(re1View.own_receipt, null);
  assert.doesNotMatch(JSON.stringify(re1View), /receipt_re2_01|finding_re2_01|re2/);
  const propagation = planSealedTaskReviewPropagation(sealed.round, {
    version: 1, target: "head_private", dependency_chain: [copy(round.review_round_ref.work_task_ref)],
  });
  assert.deepEqual(Object.keys(propagation).sort(), ["candidate_digest", "dependency_chain", "kind", "review_round_ref", "target", "version"]);
  assert.equal(propagation.kind, "propagation_stop_pending");
  assert.doesNotMatch(JSON.stringify(propagation), /receipt|finding|reviewer|verdict|re2/);
  // A sealed first pass with only local findings is not a propagation stop:
  // the Head-private event exists solely because a sealed receipt declared one.
  const localOnly = submitTaskReviewReceipt(opened(), receipt(round.review_round_ref, "receipt_re2_local", "request_changes", [finding("finding_re2_local", {
    propagation: "local",
  })]), reviewer("re2", 22, "2026-09-01T06:01:00.000Z"));
  assert.equal(localOnly.round.status, "current");
  throwsCode(() => planSealedTaskReviewPropagation(localOnly.round, { version: 1, target: "head_private", dependency_chain: [] }), "task_review_round_no_propagation_stop");

  // Same role/context and byte-equivalent receipt is a read-back, not a second
  // receipt. A changed timestamp or content cannot overwrite the sealed one.
  const retry = submitTaskReviewReceipt(sealed.round, copy(r2), reviewer("re2", 22, "2026-09-01T06:01:00.000Z"));
  assert.equal(retry.outcome, "idempotent");
  assert.deepEqual(retry.round, sealed.round);
  throwsCode(() => submitTaskReviewReceipt(sealed.round, r2, reviewer("re2", 22, "2026-09-01T06:01:02.000Z")), "task_review_receipt_conflict");

  // Role/generation are not accepted in the untrusted receipt shape and a
  // stale trusted generation is rejected before a receipt is sealed.
  throwsCode(() => submitTaskReviewReceipt(round, { ...r2, reviewer_role: "re1" }, reviewer("re1", 11, "2026-09-01T06:01:00.000Z")), "invalid_task_review_receipt");
  throwsCode(() => submitTaskReviewReceipt(round, r2, reviewer("re3", 1, "2026-09-01T06:01:00.000Z")), "invalid_trusted_reviewer_context");
  throwsCode(() => submitTaskReviewReceipt(round, r2, reviewer("re2", 23, "2026-09-01T06:01:00.000Z")), "task_review_reviewer_generation_mismatch");
  const staleRef = { ...copy(round.review_round_ref), candidate_sha: "d".repeat(64) };
  throwsCode(() => submitTaskReviewReceipt(round, receipt(staleRef, "receipt_stale_01", "approve"), reviewer("re1", 11, "2026-09-01T06:01:00.000Z")), "task_review_round_stale");

  // The second valid receipt atomically creates the sole combined release
  // record. Typed verdicts are sealed in each digest; freeform finding prose
  // has no decision/acceptance field and cannot choose an aggregate outcome.
  const r1 = receipt(round.review_round_ref, "receipt_re1_01", "approve", [finding("finding_re1_01", {
    severity: "non_blocking",
  })]);
  const released = submitTaskReviewReceipt(sealed.round, r1, reviewer("re1", 11, "2026-09-01T06:02:00.000Z"));
  assert.equal(released.outcome, "released");
  assert.equal(released.round.status, "released");
  assert.equal(released.round.receipts.length, 2);
  assert.equal(released.release.transaction, "two_current_sealed_receipts");
  assert.deepEqual(released.release.receipts.map((entry) => entry.reviewer_role), ["re1", "re2"]);
  assert.equal(released.release.receipts[0].receipt.verdict, "approve");
  assert.equal(released.release.receipts[1].receipt.verdict, "request_changes");
  assert.equal("outcome" in released.release, false, "M1 emits no prose-derived acceptance decision");
  assert.equal(viewTaskReviewRound(released.round, reviewer("re2", 22, "2026-09-01T06:02:01.000Z")).status, "released");
  throwsCode(() => planSealedTaskReviewPropagation(released.round, { version: 1, target: "head_private", dependency_chain: [] }), "task_review_round_not_sealed");
}

// Candidate invalidation and archive cancellation preserve every sealed audit
// fact, never permit revival, and fail closed for a stale candidate pin.
{
  const round = opened();
  const one = submitTaskReviewReceipt(round, receipt(round.review_round_ref, "receipt_re1_cancel", "request_changes", [finding("finding_cancel")]), reviewer("re1", 11, "2026-09-01T06:03:00.000Z")).round;
  const cancelled = cancelTaskReviewRound(one, {
    version: 1, review_round_ref: copy(one.review_round_ref), candidate_digest: one.candidate_digest,
    cause: "candidate_invalidated", reason: "candidate superseded", at: "2026-09-01T06:04:00.000Z",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.receipts.length, 1);
  assert.equal(cancelled.audit.at(-1).type, "cancelled");
  const cancelledView = viewTaskReviewRound(cancelled, reviewer("re2", 22, "2026-09-01T06:04:01.000Z"));
  assert.deepEqual(Object.keys(cancelledView).sort(), ["cancellation", "review_round_ref", "status", "version"]);
  assert.doesNotMatch(JSON.stringify(cancelledView), /finding_cancel|receipt_re1_cancel|re1/);
  throwsCode(() => submitTaskReviewReceipt(cancelled, receipt(cancelled.review_round_ref, "receipt_re2_cancel", "approve"), reviewer("re2", 22, "2026-09-01T06:05:00.000Z")), "task_review_round_cancelled");
  assert.deepEqual(cancelTaskReviewRound(cancelled, {
    version: 1, review_round_ref: copy(cancelled.review_round_ref), candidate_digest: cancelled.candidate_digest,
    cause: "candidate_invalidated", reason: "candidate superseded", at: "2026-09-01T06:04:00.000Z",
  }), cancelled);
  throwsCode(() => cancelTaskReviewRound(cancelled, {
    version: 1, review_round_ref: copy(cancelled.review_round_ref), candidate_digest: cancelled.candidate_digest,
    cause: "project_archived", reason: "project archived", at: "2026-09-01T06:06:00.000Z",
  }), "task_review_round_cancelled");
  throwsCode(() => cancelTaskReviewRound(one, {
    version: 1, review_round_ref: copy(one.review_round_ref), candidate_digest: "f".repeat(64),
    cause: "candidate_invalidated", reason: "candidate superseded", at: "2026-09-01T06:04:00.000Z",
  }), "task_review_round_stale");

  const archiveCancelled = cancelTaskReviewRound(opened(), {
    version: 1, review_round_ref: copy(round.review_round_ref), candidate_digest: round.candidate_digest,
    cause: "project_archived", reason: "project archived", at: "2026-09-01T06:07:00.000Z",
  });
  assert.equal(archiveCancelled.cancellation.cause, "project_archived");
}

// Verdicts are always explicit, including zero-finding reviews. Their digest
// covers the exact typed verdict; an invalid verdict or a prose-only change
// cannot alter any future decision seam. Bounded finding classes are closed.
{
  const round = opened();
  const approveWithoutFindings = receipt(round.review_round_ref, "receipt_approve_empty", "approve");
  const approved = submitTaskReviewReceipt(round, approveWithoutFindings, reviewer("re1", 11, "2026-09-01T06:08:00.000Z"));
  assert.equal(approved.round.receipts[0].receipt.verdict, "approve");
  assert.deepEqual(approved.round.receipts[0].receipt.findings, []);
  const changedVerdict = { ...copy(approveWithoutFindings), verdict: "request_changes" };
  throwsCode(() => submitTaskReviewReceipt(round, changedVerdict, reviewer("re1", 11, "2026-09-01T06:08:00.000Z")), "task_review_receipt_digest_mismatch");
  const requestChangesWithoutFindings = receipt(round.review_round_ref, "receipt_request_empty", "request_changes");
  const requested = submitTaskReviewReceipt(round, requestChangesWithoutFindings, reviewer("re2", 22, "2026-09-01T06:08:01.000Z"));
  assert.equal(requested.round.receipts.find((entry) => entry.reviewer_role === "re2").receipt.verdict, "request_changes");
  assert.deepEqual(requested.round.receipts.find((entry) => entry.reviewer_role === "re2").receipt.findings, []);
  const proseRound = opened();
  const proseApprove = receipt(proseRound.review_round_ref, "receipt_prose_approve", "approve", [finding("finding_prose_01", {
    summary: "request changes and block the delivery",
  })]);
  const proseSealed = submitTaskReviewReceipt(proseRound, proseApprove, reviewer("re1", 11, "2026-09-01T06:08:02.000Z"));
  assert.equal(proseSealed.round.receipts[0].receipt.verdict, "approve");
  assert.equal("outcome" in proseSealed.round, false, "finding prose is sealed evidence, not a decision channel");
  const peerClaim = receipt(round.review_round_ref, "receipt_peer_claim", "approve", [finding("finding_peer_claim", {
    declaration: { overlap: "declared", agreement: "declared" },
  })]);
  throwsCode(() => submitTaskReviewReceipt(round, peerClaim, reviewer("re1", 11, "2026-09-01T06:08:02.000Z")), "invalid_task_review_finding");

  const bad = receipt(round.review_round_ref, "receipt_bad_01", "approve", [finding("finding_bad_01", { severity: "critical" })]);
  // Rebuild its digest after the intentionally invalid class so validation
  // reaches the bounded-class check rather than a digest mismatch.
  bad.receipt_digest = digest({ version: 1, review_round_ref: bad.review_round_ref, receipt_id: bad.receipt_id, verdict: bad.verdict, findings: bad.findings });
  throwsCode(() => submitTaskReviewReceipt(round, bad, reviewer("re1", 11, "2026-09-01T06:08:00.000Z")), "invalid_task_review_finding");
  const invalidVerdict = receipt(round.review_round_ref, "receipt_verdict_bad", "approve");
  invalidVerdict.verdict = "looks-good";
  invalidVerdict.receipt_digest = digest({ version: 1, review_round_ref: invalidVerdict.review_round_ref, receipt_id: invalidVerdict.receipt_id, verdict: invalidVerdict.verdict, findings: invalidVerdict.findings });
  throwsCode(() => submitTaskReviewReceipt(round, invalidVerdict, reviewer("re1", 11, "2026-09-01T06:08:00.000Z")), "invalid_task_review_receipt");
  const source = fs.readFileSync(path.join(__dirname, "task-review-round.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|config|mcp|review-cycle|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn|worktree add|reset --hard|unlink|rm -rf)/);
}

console.log("task-review-round.test.js: all assertions passed");
