"use strict";

// #1059 M6: durable, retry-safe bridge from a released two-reviewer round to
// the existing WorkTask pipeline's explicit verdict and reconciliation states.
// It is deliberately transport-free.  The service sees only the review
// store's verdict-anchor projection, never receipt findings, and it owns no
// build, publication, delivery, or Head/reviewer authentication authority.

const crypto = require("node:crypto");
const { assertWorkTaskRef, workTaskKey } = require("./work-task-manifest");
const { assertTaskReviewRoundRef } = require("./task-review-round");
const { planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
const { reconcileReleasedTaskReview } = require("./task-review-reconciliation");
const { reviewRoundId } = require("./work-task-independent-review-service");

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;

class WorkTaskReviewReconciliationServiceError extends Error {
  constructor(code, message = code) { super(message); this.name = "WorkTaskReviewReconciliationServiceError"; this.code = code; }
}

function fail(code, message) { throw new WorkTaskReviewReconciliationServiceError(code, message); }
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
function reference(value, code) {
  try { assertWorkTaskRef(value); }
  catch { fail(code, "work task reference is invalid"); }
  return clone(value);
}
function roundReference(value, code) {
  try { assertTaskReviewRoundRef(value); }
  catch { fail(code, "review round reference is invalid"); }
  return clone(value);
}
function digest(value, code) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "candidate digest is invalid");
  return value;
}
function request(value) {
  const code = "invalid_work_task_review_reconciliation_request";
  exact(value, ["version", "work_task_ref", "review_round_ref", "candidate_digest"], code);
  if (value.version !== VERSION) fail(code, "reconciliation version is invalid");
  const work_task_ref = reference(value.work_task_ref, code);
  const review_round_ref = roundReference(value.review_round_ref, code);
  const candidate_digest = digest(value.candidate_digest, code);
  if (workTaskKey(work_task_ref) !== workTaskKey(review_round_ref.work_task_ref)) {
    fail(code, "reconciliation identity is not exact");
  }
  return freeze({ work_task_ref, review_round_ref, candidate_digest });
}
function options(value) {
  exact(value, ["config_dir", "fs"], "invalid_work_task_review_reconciliation_service_options");
  if (typeof value.config_dir !== "string" || !value.fs) {
    fail("invalid_work_task_review_reconciliation_service_options", "service dependencies are invalid");
  }
  return value;
}
function rethrow(error, fallback) {
  if (error instanceof WorkTaskReviewReconciliationServiceError) throw error;
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code) ? error.code : fallback;
  fail(code, fallback);
}
function slotFor(pipeline, ref) {
  const matches = pipeline.tasks.filter((slot) => workTaskKey(slot.work_task_ref) === workTaskKey(ref));
  if (matches.length !== 1) fail("work_task_review_reconciliation_unavailable", "pipeline has no exact WorkTask");
  return matches[0];
}
function eventId(prefix, roundRef) {
  const identity = JSON.stringify([VERSION, prefix, roundRef.installation_id, roundRef.project_id, workTaskKey(roundRef.work_task_ref),
    roundRef.base_sha, roundRef.candidate_sha, roundRef.attempt, roundRef.round]);
  return `${prefix}_${crypto.createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 64)}`;
}
function result(outcome, input, reconciliation) {
  return freeze({
    version: VERSION,
    outcome,
    work_task_ref: clone(input.work_task_ref),
    candidate_digest: input.candidate_digest,
    verdict: reconciliation.verdict,
    resolution: reconciliation.resolution,
  });
}
function currentAssignment(slot, input) {
  if (!slot.candidate || slot.candidate.candidate_digest !== input.candidate_digest || !slot.review_assignment ||
      slot.review_assignment.candidate_digest !== input.candidate_digest ||
      slot.review_assignment.review_round_id !== reviewRoundId(input.review_round_ref)) {
    fail("stale_work_task_review_authority", "review round is not the current pipeline authority");
  }
}
function terminalMatches(slot, input, reconciliation) {
  return slot.candidate && slot.candidate.candidate_digest === input.candidate_digest &&
    ((slot.state === "accepted" && reconciliation.resolution === "accepted") ||
      (slot.state === "changes_requested" && reconciliation.resolution === "changes_requested"));
}

function createWorkTaskReviewReconciliationService(value) {
  const deps = options(value);
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: deps.config_dir, fs: deps.fs });
  const roundStore = createTaskReviewRoundStore({ rootDir: deps.config_dir, fsImpl: deps.fs });

  function reconcileReleasedReview(value) {
    const input = request(value);
    const owner = { installation_id: input.work_task_ref.installation_id, project_id: input.work_task_ref.project_id };
    let released;
    try { released = roundStore.readReleasedForReconciliation(input.review_round_ref, input.candidate_digest); }
    catch (error) { rethrow(error, "work_task_review_release_unavailable"); }
    let reconciliation;
    try { reconciliation = reconcileReleasedTaskReview(released); }
    catch (error) { rethrow(error, "work_task_review_reconciliation_rejected"); }
    const verdictEventId = eventId("review_verdict", input.review_round_ref);
    const reconcileEventId = eventId("review_reconcile", input.review_round_ref);
    let changed = false;

    // Each leg is independently durable and its event ID is derived solely
    // from the immutable review round. A crash between the two legs therefore
    // resumes safely without asking a reviewer to re-submit a released receipt.
    for (let attempt = 0; attempt < 2; attempt++) {
      let snapshot;
      try { snapshot = pipelineStore.readRecoverySnapshot(owner); }
      catch (error) { rethrow(error, "work_task_review_pipeline_unavailable"); }
      if (snapshot.pipeline.archived) fail("work_task_archive_blocked", "archived pipeline cannot reconcile review");
      const slot = slotFor(snapshot.pipeline, input.work_task_ref);
      if (terminalMatches(slot, input, reconciliation)) return result(changed ? "reconciled" : "idempotent", input, reconciliation);
      if (slot.state === "independent_review") {
        currentAssignment(slot, input);
        let plan;
        try {
          plan = planWorkTaskPipelineEvent(snapshot.pipeline, {
            version: VERSION, kind: "record_review_verdict", event_id: verdictEventId,
            work_task_ref: input.work_task_ref, review_round_id: reviewRoundId(input.review_round_ref),
            candidate_digest: input.candidate_digest, verdict: reconciliation.verdict,
          });
          pipelineStore.applyPlan({
            expected: { ...owner, manifest_digest: snapshot.manifest.manifest_digest, pipeline_digest: snapshot.pipeline.pipeline_digest },
            plan, terminal_disposition: null,
          });
        } catch (error) { rethrow(error, "work_task_review_verdict_commit_failed"); }
        changed = true;
        continue;
      }
      if (slot.state === "reconcile") {
        currentAssignment(slot, input);
        if (slot.review_assignment.verdict !== reconciliation.verdict) {
          fail("work_task_review_verdict_conflict", "stored review verdict contradicts released receipts");
        }
        let plan;
        try {
          plan = planWorkTaskPipelineEvent(snapshot.pipeline, {
            version: VERSION, kind: "reconcile_review", event_id: reconcileEventId,
            work_task_ref: input.work_task_ref, review_round_id: reviewRoundId(input.review_round_ref),
            candidate_digest: input.candidate_digest, resolution: reconciliation.resolution,
          });
          pipelineStore.applyPlan({
            expected: { ...owner, manifest_digest: snapshot.manifest.manifest_digest, pipeline_digest: snapshot.pipeline.pipeline_digest },
            plan, terminal_disposition: null,
          });
        } catch (error) { rethrow(error, "work_task_review_reconcile_commit_failed"); }
        changed = true;
        continue;
      }
      fail("stale_work_task_review_authority", "review round is no longer reconcilable");
    }
    // The second loop iteration has just persisted one of the two finite
    // transitions. Its deterministic terminal state is visible only on a new
    // snapshot, not guessed from an in-memory plan.
    let finalSnapshot;
    try { finalSnapshot = pipelineStore.readRecoverySnapshot(owner); }
    catch (error) { rethrow(error, "work_task_review_pipeline_unavailable"); }
    const finalSlot = slotFor(finalSnapshot.pipeline, input.work_task_ref);
    if (!terminalMatches(finalSlot, input, reconciliation)) {
      fail("work_task_review_reconciliation_incomplete", "released review did not reach a terminal pipeline state");
    }
    return result(changed ? "reconciled" : "idempotent", input, reconciliation);
  }

  return freeze({ reconcileReleasedReview });
}

module.exports = {
  VERSION,
  WorkTaskReviewReconciliationServiceError,
  createWorkTaskReviewReconciliationService,
};
