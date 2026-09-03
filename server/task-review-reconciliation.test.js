"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { reconcileReleasedTaskReview, TaskReviewReconciliationError } = require("./task-review-reconciliation");

const ref = {
  version: 1, installation_id: "installation_review_reconcile_0001", project_id: "quadwork",
  repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" },
  issue_body_revision: "c".repeat(64), task_key: "reconcile", task_revision: "d".repeat(64),
};
const review_round_ref = {
  version: 1, installation_id: ref.installation_id, project_id: ref.project_id, work_task_ref: ref,
  task_revision: ref.task_revision, base_sha: "a".repeat(64), candidate_sha: "b".repeat(64), attempt: "attempt_001", round: 1,
};
function input(verdicts) {
  return {
    version: 1, review_round_ref, candidate_digest: "b".repeat(64), round_digest: "e".repeat(64),
    released_at: "2026-09-02T00:02:00.000Z",
    receipt_verdicts: [
      { reviewer_role: "re1", reviewer_generation: 1, receipt_id: "receipt_re1_01", receipt_digest: "f".repeat(64), verdict: verdicts[0] },
      { reviewer_role: "re2", reviewer_generation: 1, receipt_id: "receipt_re2_01", receipt_digest: "1".repeat(64), verdict: verdicts[1] },
    ],
  };
}
function throwsCode(run, code) { assert.throws(run, (error) => error instanceof TaskReviewReconciliationError && error.code === code); }

{
  const approved = reconcileReleasedTaskReview(input(["approve", "approve"]));
  assert.equal(approved.verdict, "approved");
  assert.equal(approved.resolution, "accepted");
  const changes = reconcileReleasedTaskReview(input(["approve", "request_changes"]));
  assert.equal(changes.verdict, "changes_requested");
  assert.equal(changes.resolution, "changes_requested");
  assert.deepEqual(Object.keys(changes).sort(), ["candidate_digest", "resolution", "review_round_ref", "round_digest", "verdict", "version"]);
  console.log("  PASS: two approvals accept; any independently requested change blocks acceptance");
}

{
  const duplicate = input(["approve", "approve"]);
  duplicate.receipt_verdicts[1].reviewer_role = "re1";
  throwsCode(() => reconcileReleasedTaskReview(duplicate), "invalid_task_review_reconciliation_input");
  const malformed = input(["approve", "approve"]);
  malformed.candidate_digest = "not-a-digest";
  throwsCode(() => reconcileReleasedTaskReview(malformed), "invalid_task_review_reconciliation_input");
  console.log("  PASS: malformed candidate and duplicate reviewer anchors are rejected");
}

{
  const source = fs.readFileSync(path.join(__dirname, "task-review-reconciliation.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp|task-review-round-store|work-task-pipeline-store)["']\s*\)/);
  assert.doesNotMatch(source, /(?:push|pull_request|merge|deploy|execFile|spawn|receipt\.findings)/);
  console.log("  PASS: reconciliation is pure and cannot expose findings or publish work");
}

console.log("task-review-reconciliation.test.js: all assertions passed");
