"use strict";

// #1059 M1: a sealed, pure two-reviewer WorkTask review-round contract.
//
// It deliberately has no store, route, scheduler, chat, transport, or
// decision authority.  The later pipeline owns persistence and must supply
// the trusted reviewer context.  In particular, a receipt payload cannot
// select its reviewer role or generation.

const crypto = require("crypto");
const { assertWorkTaskRef, workTaskKey } = require("./work-task-manifest");
const { assertWorkTaskCandidate } = require("./work-task-candidate");

const VERSION = 1;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ATTEMPT_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const RECEIPT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const FINDING_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const REVIEWER_ROLES = new Set(["re1", "re2"]);
const VERDICTS = new Set(["approve", "request_changes"]);
const SEVERITIES = new Set(["blocking", "non_blocking"]);
const PROPAGATION_SCOPES = new Set(["local", "propagating"]);
const CANCELLATION_CAUSES = new Set(["candidate_invalidated", "project_archived"]);
const MAX_FINDINGS = 32;

class TaskReviewRoundError extends Error {
  constructor(code, message = code) { super(message); this.name = "TaskReviewRoundError"; this.code = code; }
}

function fail(code, message) { throw new TaskReviewRoundError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, "value has an unknown or missing field");
}
function clone(value) {
  return Array.isArray(value) ? value.map(clone) : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function stable(value) {
  return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
}
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function iso(value, code) {
  if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) fail(code, "timestamp is invalid");
  const canonical = new Date(value).toISOString();
  if (canonical !== value) fail(code, "timestamp must be canonical ISO-8601");
  return canonical;
}
function text(value, code, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000\r\n]/.test(value)) fail(code, "text is invalid");
  return value;
}
function integer(value, code, max = 1000000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(code, "positive bounded integer is required");
  return value;
}

function assertTaskReviewRoundRef(value, code = "invalid_task_review_round_ref") {
  exact(value, ["version", "installation_id", "project_id", "work_task_ref", "task_revision", "base_sha", "candidate_sha", "attempt", "round"], code);
  if (value.version !== VERSION || !SHA_RE.test(value.task_revision) || !SHA_RE.test(value.base_sha) || !SHA_RE.test(value.candidate_sha) || !ATTEMPT_RE.test(value.attempt)) {
    fail(code, "review-round identity is invalid");
  }
  integer(value.round, code);
  try { assertWorkTaskRef(value.work_task_ref); } catch { fail(code, "review-round work task is invalid"); }
  if (value.installation_id !== value.work_task_ref.installation_id || value.project_id !== value.work_task_ref.project_id ||
      value.task_revision !== value.work_task_ref.task_revision) {
    fail(code, "review-round identity is not bound to its work task");
  }
  return value;
}

function taskReviewRoundKey(ref) {
  assertTaskReviewRoundRef(ref);
  return JSON.stringify(["task-review-round", VERSION, ref.installation_id, ref.project_id, workTaskKey(ref.work_task_ref),
    ref.task_revision, ref.base_sha, ref.candidate_sha, ref.attempt, ref.round]);
}

function sameRoundRef(left, right) {
  try { return taskReviewRoundKey(left) === taskReviewRoundKey(right); } catch { return false; }
}

function reviewerAssignments(value, code = "invalid_task_review_assignments") {
  exact(value, ["version", "reviewers"], code);
  if (value.version !== VERSION || !Array.isArray(value.reviewers) || value.reviewers.length !== 2) fail(code, "two trusted reviewer assignments are required");
  const reviewers = value.reviewers.map((reviewer) => {
    exact(reviewer, ["reviewer_role", "reviewer_generation"], code);
    if (!REVIEWER_ROLES.has(reviewer.reviewer_role)) fail(code, "reviewer role is invalid");
    return { reviewer_role: reviewer.reviewer_role, reviewer_generation: integer(reviewer.reviewer_generation, code) };
  });
  if (new Set(reviewers.map((reviewer) => reviewer.reviewer_role)).size !== 2) fail(code, "reviewer role is duplicated");
  return reviewers.sort((left, right) => left.reviewer_role.localeCompare(right.reviewer_role));
}

function trustedReviewerContext(value, code = "invalid_trusted_reviewer_context") {
  // This context is intentionally a separate API parameter.  Receipts carrying
  // reviewer_role or reviewer_generation are rejected as caller role spoofing.
  exact(value, ["version", "reviewer_role", "reviewer_generation", "received_at"], code);
  if (value.version !== VERSION || !REVIEWER_ROLES.has(value.reviewer_role)) fail(code, "trusted reviewer role is invalid");
  return {
    reviewer_role: value.reviewer_role,
    reviewer_generation: integer(value.reviewer_generation, code),
    received_at: iso(value.received_at, code),
  };
}

function openingInput(value) {
  exact(value, ["version", "candidate", "attempt", "round", "opened_at"], "invalid_task_review_round_open");
  if (value.version !== VERSION || !ATTEMPT_RE.test(value.attempt)) fail("invalid_task_review_round_open", "review-round opening is invalid");
  integer(value.round, "invalid_task_review_round_open");
  iso(value.opened_at, "invalid_task_review_round_open");
  try { assertWorkTaskCandidate(value.candidate); } catch { fail("invalid_task_review_round_open", "review-round candidate is invalid"); }
  return {
    candidate: clone(value.candidate), attempt: value.attempt, round: value.round, opened_at: value.opened_at,
  };
}

function roundRefFor(input) {
  const task = input.candidate.work_task_ref;
  return {
    version: VERSION,
    installation_id: task.installation_id,
    project_id: task.project_id,
    work_task_ref: clone(task),
    task_revision: task.task_revision,
    base_sha: input.candidate.base_sha,
    candidate_sha: input.candidate.candidate_sha,
    attempt: input.attempt,
    round: input.round,
  };
}

function finding(value, code = "invalid_task_review_finding") {
  exact(value, ["finding_id", "severity", "propagation", "summary"], code);
  if (!FINDING_ID_RE.test(value.finding_id) || !SEVERITIES.has(value.severity) || !PROPAGATION_SCOPES.has(value.propagation)) {
    fail(code, "finding classification is invalid");
  }
  text(value.summary, code, 480);
  // M1 deliberately carries no overlap/agreement field.  Before both sealed
  // receipts exist, such a field would claim peer semantic equivalence.  A
  // later reconciliation seam must introduce an explicit, trusted comparison
  // contract; this module neither exposes nor infers one.
  return { finding_id: value.finding_id, severity: value.severity, propagation: value.propagation, summary: value.summary };
}

function receiptPayload(value) {
  return {
    version: VERSION,
    review_round_ref: clone(value.review_round_ref),
    receipt_id: value.receipt_id,
    verdict: value.verdict,
    findings: value.findings.map(clone),
  };
}

function receiptInput(value) {
  exact(value, ["version", "review_round_ref", "receipt_id", "verdict", "receipt_digest", "findings"], "invalid_task_review_receipt");
  if (value.version !== VERSION || !RECEIPT_ID_RE.test(value.receipt_id) || !VERDICTS.has(value.verdict) || !SHA_RE.test(value.receipt_digest) ||
      !Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
    fail("invalid_task_review_receipt", "review receipt is invalid");
  }
  assertTaskReviewRoundRef(value.review_round_ref, "invalid_task_review_receipt");
  const findings = value.findings.map((entry) => finding(entry));
  if (new Set(findings.map((entry) => entry.finding_id)).size !== findings.length) fail("duplicate_task_review_finding", "finding identity is duplicated");
  const normalized = {
    version: VERSION, review_round_ref: clone(value.review_round_ref), receipt_id: value.receipt_id,
    verdict: value.verdict, receipt_digest: value.receipt_digest, findings,
  };
  if (normalized.receipt_digest !== hash(receiptPayload(normalized))) fail("task_review_receipt_digest_mismatch", "receipt digest does not authenticate its exact contents");
  return normalized;
}

function sealedReceipt(value, code = "invalid_task_review_round") {
  exact(value, ["reviewer_role", "reviewer_generation", "received_at", "receipt"], code);
  if (!REVIEWER_ROLES.has(value.reviewer_role)) fail(code, "sealed reviewer role is invalid");
  integer(value.reviewer_generation, code);
  iso(value.received_at, code);
  const receipt = receiptInput(value.receipt);
  return {
    reviewer_role: value.reviewer_role, reviewer_generation: value.reviewer_generation,
    received_at: value.received_at, receipt,
  };
}

function receiptSame(left, right) { return stable(left) === stable(right); }
function assignmentFor(round, role) { return round.reviewer_assignments.find((entry) => entry.reviewer_role === role) || null; }
function receiptFor(round, role) { return round.receipts.find((entry) => entry.reviewer_role === role) || null; }

function releaseRecord(round, receipts, releasedAt) {
  return {
    version: VERSION,
    transaction: "two_current_sealed_receipts",
    review_round_ref: clone(round.review_round_ref),
    candidate_digest: round.candidate_digest,
    released_at: releasedAt,
    receipts: receipts.map(clone),
  };
}

function cancellation(value, code = "invalid_task_review_cancellation") {
  exact(value, ["cause", "reason", "at"], code);
  if (!CANCELLATION_CAUSES.has(value.cause)) fail(code, "cancellation cause is invalid");
  return { cause: value.cause, reason: text(value.reason, code, 160), at: iso(value.at, code) };
}

function assertAudit(round) {
  if (!Array.isArray(round.audit) || round.audit.length !== 1 + round.receipts.length + (round.release ? 1 : 0) + (round.cancellation ? 1 : 0)) {
    fail("invalid_task_review_round", "immutable audit length is invalid");
  }
  exact(round.audit[0], ["type", "at"], "invalid_task_review_round");
  if (round.audit[0].type !== "opened" || iso(round.audit[0].at, "invalid_task_review_round") !== round.opened_at) {
    fail("invalid_task_review_round", "opening audit is invalid");
  }
  let cursor = 1;
  const actualReceiptEvents = round.audit.slice(cursor, cursor + round.receipts.length);
  const expectedReceiptEvents = round.receipts.map((entry) => ({
    type: "receipt_sealed", at: entry.received_at, reviewer_role: entry.reviewer_role,
    reviewer_generation: entry.reviewer_generation, receipt_id: entry.receipt.receipt_id,
    receipt_digest: entry.receipt.receipt_digest,
  }));
  if (actualReceiptEvents.some((event) => { exact(event, ["type", "at", "reviewer_role", "reviewer_generation", "receipt_id", "receipt_digest"], "invalid_task_review_round"); return event.type !== "receipt_sealed"; }) ||
      stable([...actualReceiptEvents].sort((left, right) => left.reviewer_role.localeCompare(right.reviewer_role))) !== stable(expectedReceiptEvents)) {
    fail("invalid_task_review_round", "sealed receipt audit is invalid");
  }
  cursor += round.receipts.length;
  if (round.release) {
    exact(round.audit[cursor], ["type", "at"], "invalid_task_review_round");
    if (round.audit[cursor].type !== "released" || iso(round.audit[cursor].at, "invalid_task_review_round") !== round.release.released_at) {
      fail("invalid_task_review_round", "release audit is invalid");
    }
    cursor += 1;
  }
  if (round.cancellation) {
    exact(round.audit[cursor], ["type", "cause", "reason", "at"], "invalid_task_review_round");
    if (round.audit[cursor].type !== "cancelled" || stable({ cause: round.audit[cursor].cause, reason: round.audit[cursor].reason, at: round.audit[cursor].at }) !== stable(round.cancellation)) {
      fail("invalid_task_review_round", "cancellation audit is invalid");
    }
  }
}

function roundDigestPayload(round) {
  return {
    version: VERSION, review_round_ref: clone(round.review_round_ref), candidate_digest: round.candidate_digest,
    opened_at: round.opened_at, reviewer_assignments: round.reviewer_assignments.map(clone), status: round.status,
    receipts: round.receipts.map(clone), release: round.release === null ? null : clone(round.release),
    cancellation: round.cancellation === null ? null : clone(round.cancellation), audit: round.audit.map(clone),
  };
}

function assertRelease(round) {
  const release = round.release;
  exact(release, ["version", "transaction", "review_round_ref", "candidate_digest", "released_at", "receipts"], "invalid_task_review_round");
  if (release.version !== VERSION || release.transaction !== "two_current_sealed_receipts" || !sameRoundRef(release.review_round_ref, round.review_round_ref) ||
      release.candidate_digest !== round.candidate_digest || !Array.isArray(release.receipts) || release.receipts.length !== 2 ||
      !iso(release.released_at, "invalid_task_review_round")) {
    fail("invalid_task_review_round", "combined release record is invalid");
  }
  const receipts = release.receipts.map((entry) => sealedReceipt(entry));
  if (stable(receipts) !== stable(round.receipts)) fail("invalid_task_review_round", "combined release does not atomically contain current sealed receipts");
}

function assertTaskReviewRound(round) {
  exact(round, ["version", "round_digest", "review_round_ref", "candidate_digest", "opened_at", "reviewer_assignments", "status", "receipts", "release", "cancellation", "audit"], "invalid_task_review_round");
  if (round.version !== VERSION || !SHA_RE.test(round.round_digest) || !SHA_RE.test(round.candidate_digest) ||
      !(round.status === "current" || round.status === "released" || round.status === "cancelled") ||
      !Array.isArray(round.receipts) || round.receipts.length > 2 || !Array.isArray(round.audit)) {
    fail("invalid_task_review_round", "review round is invalid");
  }
  assertTaskReviewRoundRef(round.review_round_ref, "invalid_task_review_round");
  iso(round.opened_at, "invalid_task_review_round");
  const assignments = reviewerAssignments({ version: VERSION, reviewers: round.reviewer_assignments }, "invalid_task_review_round");
  if (stable(assignments) !== stable(round.reviewer_assignments)) fail("invalid_task_review_round", "reviewer assignments are not canonical");
  const receipts = round.receipts.map((entry) => sealedReceipt(entry));
  if (new Set(receipts.map((entry) => entry.reviewer_role)).size !== receipts.length ||
      receipts.some((entry) => !sameRoundRef(entry.receipt.review_round_ref, round.review_round_ref) ||
        entry.receipt.review_round_ref.candidate_sha !== round.review_round_ref.candidate_sha ||
        assignmentFor(round, entry.reviewer_role).reviewer_generation !== entry.reviewer_generation)) {
    fail("invalid_task_review_round", "sealed receipt does not match the assigned current round");
  }
  const ordered = [...receipts].sort((left, right) => left.reviewer_role.localeCompare(right.reviewer_role));
  if (stable(ordered) !== stable(receipts)) fail("invalid_task_review_round", "sealed receipts are not canonical");
  if (round.status === "current" && (receipts.length > 1 || round.release !== null || round.cancellation !== null)) fail("invalid_task_review_round", "current review round state is invalid");
  if (round.status === "released" && (receipts.length !== 2 || round.release === null || round.cancellation !== null)) fail("invalid_task_review_round", "released review round state is invalid");
  if (round.status === "cancelled" && (round.cancellation === null || (receipts.length === 2 && round.release === null) || (receipts.length < 2 && round.release !== null))) fail("invalid_task_review_round", "cancelled review round state is invalid");
  if (round.release !== null) assertRelease(round);
  if (round.cancellation !== null) cancellation(round.cancellation, "invalid_task_review_round");
  assertAudit(round);
  if (round.round_digest !== hash(roundDigestPayload(round))) fail("invalid_task_review_round", "review round digest mismatch");
  return round;
}

function finalizeRound(value) {
  const next = { ...value, audit: value.audit.map(clone) };
  next.round_digest = hash(roundDigestPayload(next));
  const frozen = freeze(next);
  assertTaskReviewRound(frozen);
  return frozen;
}

function openTaskReviewRound(input, trustedAssignments) {
  const opened = openingInput(input);
  const assignments = reviewerAssignments(trustedAssignments);
  const review_round_ref = roundRefFor(opened);
  assertTaskReviewRoundRef(review_round_ref);
  return finalizeRound({
    version: VERSION,
    review_round_ref,
    candidate_digest: opened.candidate.candidate_digest,
    opened_at: opened.opened_at,
    reviewer_assignments: assignments,
    status: "current",
    receipts: [],
    release: null,
    cancellation: null,
    audit: [{ type: "opened", at: opened.opened_at }],
  });
}

function submitTaskReviewReceipt(round, input, trustedContext) {
  assertTaskReviewRound(round);
  const receipt = receiptInput(input);
  const context = trustedReviewerContext(trustedContext);
  if (!sameRoundRef(receipt.review_round_ref, round.review_round_ref)) fail("task_review_round_stale", "receipt is not for the current exact review round");
  if (round.status === "cancelled") fail("task_review_round_cancelled", "cancelled review rounds cannot receive receipts");
  if (round.status === "released") fail("task_review_round_released", "released review rounds cannot receive another receipt");
  const assignment = assignmentFor(round, context.reviewer_role);
  if (!assignment) fail("task_review_reviewer_role_invalid", "trusted reviewer has no assignment");
  if (assignment.reviewer_generation !== context.reviewer_generation) fail("task_review_reviewer_generation_mismatch", "trusted reviewer generation is stale");
  const sealed = {
    reviewer_role: context.reviewer_role,
    reviewer_generation: context.reviewer_generation,
    received_at: context.received_at,
    receipt,
  };
  const prior = receiptFor(round, context.reviewer_role);
  if (prior) {
    if (receiptSame(prior, sealed)) return freeze({ round: clone(round), outcome: "idempotent", release: null });
    fail("task_review_receipt_conflict", "reviewer already sealed a different receipt for this round");
  }
  const receipts = [...round.receipts.map(clone), sealed].sort((left, right) => left.reviewer_role.localeCompare(right.reviewer_role));
  const complete = receipts.length === 2;
  const release = complete ? releaseRecord(round, receipts, context.received_at) : null;
  const next = finalizeRound({
    ...clone(round),
    status: complete ? "released" : "current",
    receipts,
    release,
    audit: [
      ...round.audit.map(clone),
      { type: "receipt_sealed", at: context.received_at, reviewer_role: context.reviewer_role,
        reviewer_generation: context.reviewer_generation, receipt_id: receipt.receipt_id, receipt_digest: receipt.receipt_digest },
      ...(complete ? [{ type: "released", at: context.received_at }] : []),
    ],
  });
  // A caller can acknowledge only its own sealed receipt before the round is
  // released.  The combined record appears once both current receipts exist.
  return freeze({
    round: next,
    outcome: complete ? "released" : "sealed",
    release: complete ? clone(next.release) : null,
  });
}

function planSealedTaskReviewPropagation(round, trustedHeadContext) {
  assertTaskReviewRound(round);
  exact(trustedHeadContext, ["version", "target", "dependency_chain"], "invalid_trusted_head_context");
  if (trustedHeadContext.version !== VERSION || trustedHeadContext.target !== "head_private" || !Array.isArray(trustedHeadContext.dependency_chain) || trustedHeadContext.dependency_chain.length > 32) {
    fail("invalid_trusted_head_context", "head-private propagation context is invalid");
  }
  if (round.status !== "current") fail("task_review_round_not_sealed", "only an incomplete current round may emit a sealed propagation plan");
  if (!round.receipts.some((entry) => entry.receipt.findings.some((item) => item.propagation === "propagating"))) {
    fail("task_review_round_no_propagation_stop", "no sealed receipt declares a propagating finding");
  }
  const chain = trustedHeadContext.dependency_chain.map((ref) => {
    try { assertWorkTaskRef(ref); } catch { fail("invalid_trusted_head_context", "dependency-chain reference is invalid"); }
    if (ref.installation_id !== round.review_round_ref.installation_id || ref.project_id !== round.review_round_ref.project_id) {
      fail("invalid_trusted_head_context", "dependency-chain reference crosses the review-round identity boundary");
    }
    return clone(ref);
  });
  if (new Set(chain.map(workTaskKey)).size !== chain.length) fail("invalid_trusted_head_context", "dependency chain is duplicated");
  // This output is intentionally limited to identity and the trusted
  // dependency chain.  It has no receipt, reviewer, finding, or detail field.
  return freeze({
    version: VERSION,
    kind: "propagation_stop_pending",
    target: "head_private",
    review_round_ref: clone(round.review_round_ref),
    candidate_digest: round.candidate_digest,
    dependency_chain: chain,
  });
}

function viewTaskReviewRound(round, trustedContext) {
  assertTaskReviewRound(round);
  const context = trustedReviewerContext(trustedContext, "invalid_trusted_reviewer_context");
  const assignment = assignmentFor(round, context.reviewer_role);
  if (!assignment || assignment.reviewer_generation !== context.reviewer_generation) fail("task_review_reviewer_generation_mismatch", "trusted reviewer is not assigned to this round generation");
  if (round.status === "cancelled") return freeze({ version: VERSION, status: "cancelled", review_round_ref: clone(round.review_round_ref), cancellation: clone(round.cancellation) });
  if (round.status === "released") return freeze({ version: VERSION, status: "released", review_round_ref: clone(round.review_round_ref), release: clone(round.release) });
  const own = receiptFor(round, context.reviewer_role);
  return freeze({
    version: VERSION,
    status: "sealed",
    review_round_ref: clone(round.review_round_ref),
    own_receipt: own === null ? null : clone(own.receipt),
  });
}

function cancelTaskReviewRound(round, input) {
  assertTaskReviewRound(round);
  exact(input, ["version", "review_round_ref", "candidate_digest", "cause", "reason", "at"], "invalid_task_review_cancellation");
  if (input.version !== VERSION || !SHA_RE.test(input.candidate_digest)) fail("invalid_task_review_cancellation", "cancellation candidate identity is invalid");
  assertTaskReviewRoundRef(input.review_round_ref, "invalid_task_review_cancellation");
  if (!sameRoundRef(input.review_round_ref, round.review_round_ref) || input.candidate_digest !== round.candidate_digest) {
    fail("task_review_round_stale", "cancellation is not for the current exact review round");
  }
  const requested = cancellation({ cause: input.cause, reason: input.reason, at: input.at });
  if (round.status === "cancelled") {
    if (stable(requested) === stable(round.cancellation)) return freeze(clone(round));
    fail("task_review_round_cancelled", "cancelled review rounds cannot be revived or recancelled differently");
  }
  return finalizeRound({
    ...clone(round),
    status: "cancelled",
    cancellation: requested,
    audit: [...round.audit.map(clone), { type: "cancelled", ...clone(requested) }],
  });
}

module.exports = {
  VERSION,
  TaskReviewRoundError,
  assertTaskReviewRoundRef,
  taskReviewRoundKey,
  assertTaskReviewRound,
  openTaskReviewRound,
  submitTaskReviewReceipt,
  planSealedTaskReviewPropagation,
  viewTaskReviewRound,
  cancelTaskReviewRound,
};
