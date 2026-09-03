"use strict";

// #1059 M3: durable bridge for one exact WorkTask candidate's independent
// two-reviewer round.  This is intentionally transport-free.  A future
// authenticated adapter supplies the Head reviewer assignments and the
// reviewer principal context; neither may be caller-selected by a receipt.
// The bridge seals receipts but deliberately does not infer their combined
// verdict or advance delivery state before explicit reconciliation exists.
// After reconciliation it also owns the Dev correction route (#1058 step 6 /
// #1059): one queued local correction per released change-requested round,
// and the Head-only pre-release propagation stop read.

const crypto = require("node:crypto");
const { assertWorkTaskRef, workTaskKey } = require("./work-task-manifest");
const { planWorkTaskPipelineEvent, declaredWorkTaskDependents } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
const { assertTaskReviewRoundRef, taskReviewRoundKey } = require("./task-review-round");
const { reconcileReleasedTaskReview } = require("./task-review-reconciliation");

const VERSION = 1;
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

class WorkTaskIndependentReviewServiceError extends Error {
  constructor(code, message = code) { super(message); this.name = "WorkTaskIndependentReviewServiceError"; this.code = code; }
}

function fail(code, message) { throw new WorkTaskIndependentReviewServiceError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail(code, "value has unknown or missing fields");
}
function clone(value) { return Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
function identifier(value, code) { if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail(code, "identifier is invalid"); return value; }
function sha(value, code) { if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "digest is invalid"); return value; }
function taskRef(value, code) { try { assertWorkTaskRef(value); } catch { fail(code, "work task reference is invalid"); } return clone(value); }
function roundRef(value, code) { try { assertTaskReviewRoundRef(value); } catch { fail(code, "review round reference is invalid"); } return clone(value); }
function owner(ref) { return { installation_id: ref.installation_id, project_id: ref.project_id }; }
// Identifiers derived solely from the immutable round: a retry after a crash
// re-derives the same pipeline event and cannot queue a second correction.
function derivedId(prefix, ref) { return `${prefix}_${crypto.createHash("sha256").update(taskReviewRoundKey(ref), "utf8").digest("hex").slice(0, 48)}`; }
function reviewRoundId(ref) { return derivedId("trr", ref); }
function slotFor(pipeline, ref) {
  const key = workTaskKey(ref);
  const matches = pipeline.tasks.filter((slot) => workTaskKey(slot.work_task_ref) === key);
  if (matches.length !== 1) fail("work_task_review_assignment_unavailable", "current pipeline has no exact task");
  return matches[0];
}
function openRequest(value) {
  exact(value, ["version", "event_id", "work_task_ref", "attempt", "round", "reviewers", "opened_at"], "invalid_work_task_review_open_request");
  if (value.version !== VERSION || !Number.isSafeInteger(value.round) || value.round < 1 || value.round > 1000000 ||
      typeof value.opened_at !== "string" || Number.isNaN(Date.parse(value.opened_at))) fail("invalid_work_task_review_open_request", "review opening is invalid");
  return freeze({ event_id: identifier(value.event_id, "invalid_work_task_review_open_request"), work_task_ref: taskRef(value.work_task_ref, "invalid_work_task_review_open_request"),
    attempt: identifier(value.attempt, "invalid_work_task_review_open_request"), round: value.round, reviewers: clone(value.reviewers), opened_at: value.opened_at });
}
function receiptRequest(value) {
  exact(value, ["version", "review_round_ref", "candidate_digest", "receipt"], "invalid_work_task_review_receipt_request");
  if (value.version !== VERSION) fail("invalid_work_task_review_receipt_request", "receipt version is invalid");
  return freeze({ review_round_ref: roundRef(value.review_round_ref, "invalid_work_task_review_receipt_request"), candidate_digest: sha(value.candidate_digest, "invalid_work_task_review_receipt_request"), receipt: clone(value.receipt) });
}
function correctionRequest(value) {
  const code = "invalid_work_task_correction_request";
  exact(value, ["version", "work_task_ref", "review_round_ref", "candidate_digest"], code);
  if (value.version !== VERSION) fail(code, "correction version is invalid");
  const request = freeze({ work_task_ref: taskRef(value.work_task_ref, code), review_round_ref: roundRef(value.review_round_ref, code), candidate_digest: sha(value.candidate_digest, code) });
  if (workTaskKey(request.work_task_ref) !== workTaskKey(request.review_round_ref.work_task_ref)) fail(code, "correction identity is not exact");
  return request;
}
function stopRequest(value) {
  exact(value, ["version", "work_task_ref"], "invalid_work_task_propagation_stop_request");
  if (value.version !== VERSION) fail("invalid_work_task_propagation_stop_request", "propagation stop request version is invalid");
  return freeze({ work_task_ref: taskRef(value.work_task_ref, "invalid_work_task_propagation_stop_request") });
}
function serviceOptions(value) {
  exact(value, ["config_dir", "fs"], "invalid_work_task_independent_review_service_options");
  if (typeof value.config_dir !== "string" || !value.fs) fail("invalid_work_task_independent_review_service_options", "service dependencies are invalid");
  return value;
}
function rethrow(error, fallback) {
  if (error instanceof WorkTaskIndependentReviewServiceError) throw error;
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code) ? error.code : fallback;
  fail(code, fallback);
}
function openingRef(candidate, input) {
  return {
    version: VERSION, installation_id: candidate.work_task_ref.installation_id, project_id: candidate.work_task_ref.project_id,
    work_task_ref: clone(candidate.work_task_ref), task_revision: candidate.work_task_ref.task_revision,
    base_sha: candidate.base_sha, candidate_sha: candidate.candidate_sha, attempt: input.attempt, round: input.round,
  };
}
function publicRound(outcome, ref, candidateDigest) { return freeze({ version: VERSION, outcome, review_round_ref: clone(ref), candidate_digest: candidateDigest }); }

function createWorkTaskIndependentReviewService(value) {
  const options = serviceOptions(value);
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: options.config_dir, fs: options.fs });
  const roundStore = createTaskReviewRoundStore({ rootDir: options.config_dir, fsImpl: options.fs });

  function openIndependentReview(value) {
    const input = openRequest(value);
    const project = owner(input.work_task_ref);
    let snapshot;
    try { snapshot = pipelineStore.readRecoverySnapshot(project); } catch (error) { rethrow(error, "work_task_review_pipeline_unavailable"); }
    if (snapshot.pipeline.archived) fail("work_task_archive_blocked", "archived pipeline cannot open a review round");
    const slot = slotFor(snapshot.pipeline, input.work_task_ref);
    if (slot.candidate === null) fail("work_task_review_candidate_unavailable", "review requires an exact candidate");
    const ref = openingRef(slot.candidate, input);
    const id = reviewRoundId(ref);
    const prior = snapshot.pipeline.history.find((entry) => entry.event_id === input.event_id) || null;
    if (prior !== null) {
      if (prior.kind === "assign_independent_review" && slot.state === "independent_review" && slot.review_assignment !== null &&
          slot.review_assignment.review_round_id === id && slot.review_assignment.candidate_digest === slot.candidate.candidate_digest) {
        return publicRound("idempotent", ref, slot.candidate.candidate_digest);
      }
      fail("work_task_review_event_conflict", "event identity is already bound to another pipeline transition");
    }
    if (slot.state !== "candidate_ready") fail("work_task_review_assignment_unavailable", "candidate is not awaiting independent review");
    try {
      roundStore.openRound({ version: VERSION, candidate: slot.candidate, attempt: input.attempt, round: input.round, opened_at: input.opened_at },
        { version: VERSION, reviewers: input.reviewers });
    } catch (error) { rethrow(error, "work_task_review_open_failed"); }
    let plan;
    try {
      plan = planWorkTaskPipelineEvent(snapshot.pipeline, { version: VERSION, kind: "assign_independent_review", event_id: input.event_id,
        work_task_ref: input.work_task_ref, review_round_id: id, candidate_digest: slot.candidate.candidate_digest });
      pipelineStore.applyPlan({ expected: { ...project, manifest_digest: snapshot.manifest.manifest_digest, pipeline_digest: snapshot.pipeline.pipeline_digest }, plan, terminal_disposition: null });
    } catch (error) { rethrow(error, "work_task_review_assignment_failed"); }
    return publicRound("opened", ref, slot.candidate.candidate_digest);
  }

  function submitTrustedReceipt(value, trustedReviewerContext) {
    const input = receiptRequest(value);
    const project = owner(input.review_round_ref.work_task_ref);
    let snapshot;
    try { snapshot = pipelineStore.readRecoverySnapshot(project); } catch (error) { rethrow(error, "work_task_review_pipeline_unavailable"); }
    const slot = slotFor(snapshot.pipeline, input.review_round_ref.work_task_ref);
    if (snapshot.pipeline.archived || slot.state !== "independent_review" || slot.candidate === null || slot.review_assignment === null ||
        slot.candidate.candidate_digest !== input.candidate_digest || slot.review_assignment.candidate_digest !== input.candidate_digest ||
        slot.review_assignment.review_round_id !== reviewRoundId(input.review_round_ref)) {
      fail("stale_work_task_review_authority", "review receipt is not bound to the current candidate assignment");
    }
    try {
      const saved = roundStore.submitTrustedReceipt(input.review_round_ref, input.candidate_digest, input.receipt, trustedReviewerContext);
      return freeze({ version: VERSION, outcome: saved.outcome, view: clone(saved.view) });
    } catch (error) { rethrow(error, "work_task_review_receipt_failed"); }
  }

  // A released change-requested round returns its exact candidate to Dev as
  // one bounded local correction.  The sealed first-pass receipts stay in the
  // round store untouched; the corrected candidate gets a new digest, so every
  // later review binds to the new SHA and this round can never be reused.
  function queueLocalCorrection(value) {
    const input = correctionRequest(value);
    const project = owner(input.work_task_ref);
    let released;
    try { released = roundStore.readReleasedForReconciliation(input.review_round_ref, input.candidate_digest); }
    catch (error) { rethrow(error, "work_task_review_release_unavailable"); }
    let reconciliation;
    try { reconciliation = reconcileReleasedTaskReview(released); }
    catch (error) { rethrow(error, "work_task_review_reconciliation_rejected"); }
    if (reconciliation.resolution !== "changes_requested") fail("work_task_correction_not_requested", "released round did not request changes");
    let snapshot;
    try { snapshot = pipelineStore.readRecoverySnapshot(project); } catch (error) { rethrow(error, "work_task_review_pipeline_unavailable"); }
    if (snapshot.pipeline.archived) fail("work_task_archive_blocked", "archived pipeline cannot queue a correction");
    const slot = slotFor(snapshot.pipeline, input.work_task_ref);
    const event_id = derivedId("local_correction", input.review_round_ref);
    const checkpoint_id = derivedId("checkpoint", input.review_round_ref);
    const result = (outcome) => freeze({ version: VERSION, outcome, work_task_ref: clone(input.work_task_ref), candidate_digest: input.candidate_digest, checkpoint_id });
    if (snapshot.pipeline.history.some((entry) => entry.event_id === event_id)) return result("idempotent");
    if (slot.state !== "changes_requested" || slot.candidate === null || slot.candidate.candidate_digest !== input.candidate_digest) {
      fail("stale_work_task_review_authority", "candidate is not awaiting a local correction for this round");
    }
    try {
      const plan = planWorkTaskPipelineEvent(snapshot.pipeline, { version: VERSION, kind: "queue_local_correction", event_id, work_task_ref: input.work_task_ref, checkpoint_id });
      pipelineStore.applyPlan({ expected: { ...project, manifest_digest: snapshot.manifest.manifest_digest, pipeline_digest: snapshot.pipeline.pipeline_digest }, plan, terminal_disposition: null });
    } catch (error) { rethrow(error, "work_task_correction_commit_failed"); }
    return result("queued");
  }

  // Head-only.  Reports the redacted `propagation_stop_pending` event for the
  // task's current sealed round, or null.  The dependency chain is the
  // server-derived declared dependents; no reviewer role, verdict, or finding
  // leaves this read, and the reviewer submit/read paths above are untouched.
  function readPropagationStopPending(value) {
    const input = stopRequest(value);
    let snapshot;
    try { snapshot = pipelineStore.readRecoverySnapshot(owner(input.work_task_ref)); } catch (error) { rethrow(error, "work_task_review_pipeline_unavailable"); }
    const slot = slotFor(snapshot.pipeline, input.work_task_ref);
    if (slot.state !== "independent_review" || slot.candidate === null || slot.review_assignment === null) return null;
    let stop;
    try {
      stop = roundStore.readSealedPropagationStop({ version: VERSION, work_task_ref: input.work_task_ref, candidate_digest: slot.candidate.candidate_digest },
        { version: VERSION, target: "head_private", dependency_chain: declaredWorkTaskDependents(snapshot.pipeline, input.work_task_ref) });
    } catch (error) { rethrow(error, "work_task_propagation_stop_unavailable"); }
    if (stop === null) return null;
    if (reviewRoundId(stop.review_round_ref) !== slot.review_assignment.review_round_id || stop.candidate_digest !== slot.review_assignment.candidate_digest) {
      fail("stale_work_task_review_authority", "sealed round is not the current pipeline review assignment");
    }
    return stop;
  }

  return freeze({ openIndependentReview, submitTrustedReceipt, queueLocalCorrection, readPropagationStopPending });
}

module.exports = { VERSION, WorkTaskIndependentReviewServiceError, reviewRoundId, createWorkTaskIndependentReviewService };
