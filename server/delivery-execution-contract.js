"use strict";

// The four closed Head delivery commands and their immutable receipts. These
// validators contain no credential, transport, policy decision or actor source.
const crypto = require("node:crypto");
const { assertDeliveryCandidateRef } = require("./delivery-candidate");
const { assertWorkTaskRef } = require("./work-task-manifest");
const ACTIONS = Object.freeze(["form_delivery", "publish_delivery", "inspect_delivery", "complete_delivery"]);
const ISOLATION_REASONS = Object.freeze(["urgent_hotfix", "security_boundary", "schema_migration", "breaking_api", "destructive_change", "deployment_infrastructure", "unbounded_review"]);
const OPERATOR_REASONS = Object.freeze(["credentials", "payment", "code_signing", "registry_publication", "production_deployment", "destructive_operation", "explicit_issue_hold"]);
class DeliveryExecutionError extends Error {
  constructor(code, message = code) { super(message); this.name = "DeliveryExecutionError"; this.code = code; }
}
function fail(code) { throw new DeliveryExecutionError(code); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function exact(value, keys) { if (!plain(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail("delivery_input_invalid"); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  fail("delivery_input_invalid");
}
function digest(value) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function bounded(value) { if (Buffer.byteLength(stable(value)) > 384 * 1024) fail("delivery_record_too_large"); return value; }
function sha(value) { if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail("delivery_sha_invalid"); return value; }
function hash(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("delivery_digest_invalid"); return value; }
function text(value, max = 160) { if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) fail("delivery_input_invalid"); return value; }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0) fail("delivery_revision_invalid"); return value; }
function list(value, allowed) { if (!Array.isArray(value) || value.length > allowed.length || new Set(value).size !== value.length || value.some((x) => !allowed.includes(x))) fail("delivery_classification_invalid"); return value; }
function assertPayload(action, value) {
  if (action === "form_delivery") {
    exact(value, ["delivery_candidate_ref", "classification", "release_intent", "rollback_group", "isolation_reasons", "operator_reasons"]);
    if (!["ordinary", "operator_gated"].includes(value.classification)) fail("delivery_classification_invalid");
    text(value.release_intent); text(value.rollback_group); list(value.isolation_reasons, ISOLATION_REASONS); list(value.operator_reasons, OPERATOR_REASONS);
    if (value.classification === "ordinary" && value.operator_reasons.length) fail("operator_gate_required");
  } else if (action === "publish_delivery") {
    exact(value, ["delivery_candidate_ref", "expected_candidate_revision", "plan_digest"]);
    revision(value.expected_candidate_revision); hash(value.plan_digest);
  } else if (action === "inspect_delivery") {
    exact(value, ["delivery_candidate_ref", "expected_candidate_revision", "phase", "judgment", "complete_scope_tasks"]);
    revision(value.expected_candidate_revision);
    if (!["before_merge", "after_merge"].includes(value.phase) || value.judgment !== "approved" || !Array.isArray(value.complete_scope_tasks) || value.complete_scope_tasks.length > 64) fail("delivery_inspection_invalid");
    for (const ref of value.complete_scope_tasks) assertWorkTaskRef(ref);
    if (value.phase === "before_merge" && value.complete_scope_tasks.length) fail("delivery_inspection_invalid");
  } else if (action === "complete_delivery") {
    exact(value, ["delivery_candidate_ref", "expected_candidate_revision", "inspection_digest"]);
    revision(value.expected_candidate_revision); hash(value.inspection_digest);
  } else fail("delivery_action_unsupported");
  assertDeliveryCandidateRef(value.delivery_candidate_ref);
  return bounded(clone(value));
}
function sealed(value) { return { ...clone(value), digest: digest(value) }; }
function assertSeal(value) { if (!plain(value)) fail("delivery_seal_invalid"); const { digest: expected, ...content } = value; if (hash(expected) !== digest(content)) fail("delivery_seal_invalid"); bounded(content); return value; }
function initialDelivery() { return { version: 1, operations: [], publication: null, premerge_seals: [], inspection: null, completion: null }; }
function assertDelivery(value) {
  exact(value, ["version", "operations", "publication", "premerge_seals", "inspection", "completion"]);
  if (value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > 64 || !Array.isArray(value.premerge_seals) || value.premerge_seals.length > 16) fail("delivery_record_invalid");
  const keys = new Set(), correlations = new Set();
  for (const op of value.operations) {
    exact(op, ["action", "idempotency_key", "correlation_id", "fingerprint", "step", "checkpoint", "result", "failure"]);
    if (!ACTIONS.includes(op.action) || keys.has(op.idempotency_key) || correlations.has(op.correlation_id)) fail("delivery_operation_invalid");
    text(op.idempotency_key); text(op.correlation_id); hash(op.fingerprint); text(op.step); keys.add(op.idempotency_key); correlations.add(op.correlation_id);
    if (op.checkpoint !== null) assertSeal(op.checkpoint);
    if (op.result !== null) assertSeal(op.result);
    if (op.failure !== null && !/^[a-z][a-z0-9_]{2,127}$/.test(op.failure)) fail("delivery_operation_invalid");
  }
  if (value.publication !== null) assertSeal(value.publication);
  value.premerge_seals.forEach(assertSeal);
  if (value.inspection !== null) assertSeal(value.inspection);
  if (value.completion !== null) assertSeal(value.completion);
  bounded(value); return value;
}
function actionSchema(action) {
  const ref = { type: "object", properties: { version: { const: 1 }, installation_id: { type: "string" }, project_id: { type: "string" }, repository_key: { type: "string" }, batch_manifest_digest: { type: "string" }, delivery_mode: { enum: ["integrated", "isolated"] }, base_sha: { type: "string" }, result_sha: { type: "string" }, cut_id: { type: "string" } }, required: ["version", "installation_id", "project_id", "repository_key", "batch_manifest_digest", "delivery_mode", "base_sha", "result_sha", "cut_id"], additionalProperties: false };
  const properties = { delivery_candidate_ref: ref };
  if (action === "form_delivery") Object.assign(properties, { classification: { enum: ["ordinary", "operator_gated"] }, release_intent: { type: "string", maxLength: 160 }, rollback_group: { type: "string", maxLength: 160 }, isolation_reasons: { type: "array", items: { enum: ISOLATION_REASONS }, uniqueItems: true }, operator_reasons: { type: "array", items: { enum: OPERATOR_REASONS }, uniqueItems: true } });
  else {
    properties.expected_candidate_revision = { type: "integer", minimum: 0 };
    if (action === "publish_delivery") properties.plan_digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
    else if (action === "inspect_delivery") Object.assign(properties, { phase: { enum: ["before_merge", "after_merge"] }, judgment: { const: "approved" }, complete_scope_tasks: { type: "array", maxItems: 64, items: { type: "object" }, description: "Exact frozen WorkTaskRefs which Head attests cover their entire approved ticket scope; empty before merge." } });
    else if (action === "complete_delivery") properties.inspection_digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
    else fail("delivery_action_unsupported");
  }
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
module.exports = { ACTIONS, ISOLATION_REASONS, OPERATOR_REASONS, DeliveryExecutionError, fail, plain, exact, stable, digest, clone, bounded, sha, hash, text, revision, assertPayload, actionSchema, sealed, assertSeal, initialDelivery, assertDelivery };
