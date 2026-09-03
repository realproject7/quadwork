"use strict";

// #1059 M5: pure, deterministic reconciliation of the two released review
// verdict anchors.  This module receives only the store's redacted internal
// reconciliation projection—not reviewer-facing reads, receipt findings, or
// a transport capability.  A single request for changes therefore blocks an
// acceptance; a candidate is approved only when both independent anchors do.

const { assertTaskReviewRoundRef } = require("./task-review-round");

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const RECEIPT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const REVIEWER_ROLES = new Set(["re1", "re2"]);
const VERDICTS = new Set(["approve", "request_changes"]);

class TaskReviewReconciliationError extends Error {
  constructor(code, message = code) { super(message); this.name = "TaskReviewReconciliationError"; this.code = code; }
}

function fail(code, message) { throw new TaskReviewReconciliationError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function iso(value, code) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(code, "timestamp is invalid");
  }
  return value;
}

function releasedInput(value) {
  const code = "invalid_task_review_reconciliation_input";
  exact(value, ["version", "review_round_ref", "candidate_digest", "round_digest", "released_at", "receipt_verdicts"], code);
  if (value.version !== VERSION || !SHA_RE.test(value.candidate_digest) || !SHA_RE.test(value.round_digest) ||
      !Array.isArray(value.receipt_verdicts) || value.receipt_verdicts.length !== 2) {
    fail(code, "released review projection is invalid");
  }
  try { assertTaskReviewRoundRef(value.review_round_ref); }
  catch { fail(code, "review round reference is invalid"); }
  // candidate_digest authenticates the full WorkTask candidate record, while
  // review_round_ref.candidate_sha is its Git commit SHA. They are distinct
  // immutable identities and are cross-bound by the sealed store record.
  iso(value.released_at, code);
  const receipts = value.receipt_verdicts.map((entry) => {
    exact(entry, ["reviewer_role", "reviewer_generation", "receipt_id", "receipt_digest", "verdict"], code);
    if (!REVIEWER_ROLES.has(entry.reviewer_role) || !Number.isSafeInteger(entry.reviewer_generation) || entry.reviewer_generation < 1 ||
        !RECEIPT_ID_RE.test(entry.receipt_id) || !SHA_RE.test(entry.receipt_digest) || !VERDICTS.has(entry.verdict)) {
      fail(code, "released reviewer verdict anchor is invalid");
    }
    return { reviewer_role: entry.reviewer_role, reviewer_generation: entry.reviewer_generation, receipt_id: entry.receipt_id, receipt_digest: entry.receipt_digest, verdict: entry.verdict };
  }).sort((left, right) => left.reviewer_role.localeCompare(right.reviewer_role));
  if (receipts[0].reviewer_role !== "re1" || receipts[1].reviewer_role !== "re2") {
    fail(code, "released reviewer verdict anchors are not an exact re1/re2 pair");
  }
  return { review_round_ref: value.review_round_ref, candidate_digest: value.candidate_digest, round_digest: value.round_digest, released_at: value.released_at, receipt_verdicts: receipts };
}

function reconcileReleasedTaskReview(value) {
  const released = releasedInput(value);
  const verdict = released.receipt_verdicts.every((entry) => entry.verdict === "approve") ? "approved" : "changes_requested";
  return Object.freeze({
    version: VERSION,
    review_round_ref: released.review_round_ref,
    candidate_digest: released.candidate_digest,
    round_digest: released.round_digest,
    verdict,
    resolution: verdict === "approved" ? "accepted" : "changes_requested",
  });
}

module.exports = {
  VERSION,
  TaskReviewReconciliationError,
  reconcileReleasedTaskReview,
};
