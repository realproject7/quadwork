"use strict";

// #1048's counterpart to the Monitor's #1036 transport envelope.  This is a
// deliberately closed serializer: callers supply a durable cycle + event plan,
// never message text, a recipient list, or arbitrary metadata.

const { eventCorrelation } = require("./review-cycle");

const VERSION = 1;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CYCLE_RE = /^rc_[a-f0-9]{32}$/;
const CORRELATION_RE = /^rc_evt_[a-f0-9]{40}$/;
const KINDS = new Set(["review_request", "review_reminder", "head_gate_due", "contract_changed"]);
const ROLE_RECIPIENTS = Object.freeze(["re1", "re2"]);

class ReviewCycleEventError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) { throw new ReviewCycleEventError(code); }
function isPlainObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  if (!isPlainObject(value)) fail("review_cycle_event_invalid");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("review_cycle_event_invalid");
}

function cycleAnchors(projectId, cycle) {
  if (!PROJECT_ID_RE.test(projectId) || !isPlainObject(cycle) || !isPlainObject(cycle.target)) fail("review_cycle_event_invalid");
  const target = cycle.target;
  if (!REPO_KEY_RE.test(target.repo_key) || !Number.isSafeInteger(target.work_item?.number) || target.work_item.number < 1 ||
      !Number.isSafeInteger(target.pr_number) || target.pr_number < 1 || !SHA_RE.test(target.exact_sha) ||
      !DIGEST_RE.test(target.contract_revision) || !CYCLE_RE.test(cycle.cycle_id) ||
      !DIGEST_RE.test(cycle.target_identity_digest) || target.project_id !== projectId) {
    fail("review_cycle_event_invalid");
  }
  return Object.freeze({
    project_id: projectId,
    repo_key: target.repo_key,
    issue: String(target.work_item.number),
    contract_revision: target.contract_revision,
    pr: String(target.pr_number),
    sha: target.exact_sha,
    cycle_id: cycle.cycle_id,
    target_identity_digest: cycle.target_identity_digest,
  });
}

function eventRecipient(kind, plan) {
  if (kind === "review_request") return Object.freeze(["re1", "re2"]);
  if (kind === "review_reminder") {
    if (!ROLE_RECIPIENTS.includes(plan.recipient)) fail("review_cycle_event_invalid");
    return Object.freeze([plan.recipient]);
  }
  return Object.freeze(["head"]);
}

function fixedText(kind, anchors, recipients) {
  const base = `repo=${anchors.repo_key} issue=${anchors.issue} contract=${anchors.contract_revision} pr=${anchors.pr} sha=${anchors.sha} cycle=${anchors.cycle_id}`;
  if (kind === "review_request") return `@re1 @re2 [REVIEW REQUEST] ${base}`;
  if (kind === "review_reminder") return `@${recipients[0]} [REVIEW REMINDER] ${base}`;
  if (kind === "head_gate_due") return `@head [MERGE GATE DUE] ${base}`;
  return `@head [CONTRACT CHANGED] ${base}`;
}

function envelopeFor(projectId, cycle, plan) {
  const isReminder = plan?.kind === "review_reminder";
  exactKeys(plan, ["kind", "cycle_id", "target_identity_digest", "correlation_id", "created", ...(isReminder ? ["recipient"] : [])]);
  if (!KINDS.has(plan.kind) || !CYCLE_RE.test(plan.cycle_id) || !DIGEST_RE.test(plan.target_identity_digest) ||
      !CORRELATION_RE.test(plan.correlation_id) || typeof plan.created !== "boolean") fail("review_cycle_event_invalid");
  if (plan.cycle_id !== cycle?.cycle_id || plan.target_identity_digest !== cycle?.target_identity_digest) {
    fail("review_cycle_event_stale");
  }
  const recipient = isReminder ? plan.recipient : null;
  if (plan.correlation_id !== eventCorrelation(plan.cycle_id, plan.kind, recipient)) fail("review_cycle_event_invalid");
  const anchors = cycleAnchors(projectId, cycle);
  const recipients = eventRecipient(plan.kind, plan);
  return Object.freeze({
    version: VERSION,
    correlation_id: plan.correlation_id,
    kind: plan.kind,
    project_id: projectId,
    recipients,
    anchors: Object.freeze({ ...anchors, recipient: recipient || "all" }),
    sender: "system",
    // This matches the durable Primary Chat record type. Authority is the
    // sealed `trusted_event.scope/anchors`, never an alternate type string.
    type: "system",
    text: fixedText(plan.kind, anchors, recipients),
  });
}

module.exports = {
  VERSION,
  ReviewCycleEventError,
  envelopeFor,
};
