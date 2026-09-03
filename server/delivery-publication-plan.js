"use strict";

// #1060 M9: turn one composed Delivery Candidate into an operator-readable
// publication plan. This module deliberately has no Git, network, process,
// persistence, or publication capability. The later operator-gated executor
// must re-prove this exact plan immediately before any remote publication.

const crypto = require("node:crypto");
const { assertDeliveryCandidateRef, deliveryCandidateKey, assertDeliveryManifest } = require("./delivery-candidate");

const VERSION = 1;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

class DeliveryPublicationPlanError extends Error {
  constructor(code, message = code) { super(message); this.name = "DeliveryPublicationPlanError"; this.code = code; }
}
function fail(code, message) { throw new DeliveryPublicationPlanError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail(code, "value has an unknown or missing field");
}
function clone(value) { return Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function binding(value, code) {
  exact(value, ["installation_id", "project_id", "role", "generation"], code);
  if (!INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id) || value.role !== "head" || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    fail(code, "Head binding is invalid");
  }
  return { installation_id: value.installation_id, project_id: value.project_id, role: "head", generation: value.generation };
}
function reference(value, code) {
  try { return clone(assertDeliveryCandidateRef(value, code)); }
  catch { fail(code, "Delivery Candidate reference is invalid"); }
}
function snapshot(value, ref) {
  exact(value, ["delivery_candidate_ref", "lifecycle", "delivery_manifest", "composition_proof"], "delivery_publication_snapshot_invalid");
  if (deliveryCandidateKey(value.delivery_candidate_ref) !== deliveryCandidateKey(ref) || !plain(value.lifecycle) ||
      value.lifecycle.status !== "composed" || value.composition_proof === null) {
    fail("delivery_publication_snapshot_invalid", "Delivery Candidate is not composed");
  }
  let manifest;
  try { manifest = assertDeliveryManifest(value.delivery_manifest); }
  catch { fail("delivery_publication_snapshot_invalid", "Delivery Candidate manifest is invalid"); }
  if (deliveryCandidateKey(manifest.delivery_candidate_ref) !== deliveryCandidateKey(ref)) {
    fail("delivery_publication_snapshot_invalid", "Delivery Candidate manifest changed");
  }
  return manifest;
}
function options(value) {
  exact(value, ["read_candidate_snapshot"], "invalid_delivery_publication_plan_options");
  if (typeof value.read_candidate_snapshot !== "function") fail("invalid_delivery_publication_plan_options", "candidate snapshot reader is required");
  return value;
}

function createDeliveryPublicationPlanService(value) {
  const deps = options(value);
  function plan(request) {
    exact(request, ["version", "head_binding", "delivery_candidate_ref"], "invalid_delivery_publication_plan_request");
    if (request.version !== VERSION) fail("invalid_delivery_publication_plan_request", "publication plan request is invalid");
    const owner = binding(request.head_binding, "invalid_delivery_publication_plan_request");
    const ref = reference(request.delivery_candidate_ref, "invalid_delivery_publication_plan_request");
    if (ref.installation_id !== owner.installation_id || ref.project_id !== owner.project_id) {
      fail("delivery_publication_head_denied", "Head does not own this Delivery Candidate");
    }
    let manifest;
    try { manifest = snapshot(deps.read_candidate_snapshot(freeze({ version: VERSION, delivery_candidate_ref: clone(ref) })), ref); }
    catch (error) {
      if (error instanceof DeliveryPublicationPlanError) throw error;
      fail("delivery_publication_snapshot_unavailable", "Delivery Candidate snapshot is unavailable");
    }
    const repository = manifest.registered_repository.repository;
    if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) fail("delivery_publication_plan_invalid", "registered repository is invalid");
    const branch = `quadwork/delivery-${hash({ delivery_candidate_key: deliveryCandidateKey(ref), delivery_manifest_digest: manifest.delivery_manifest_digest }).slice(0, 32)}`;
    const workItems = manifest.staged_tasks.map((stage) => ({ repo: stage.work_item.repo, number: stage.work_item.number, kind: stage.work_item.kind }));
    const title = `[QuadWork] Delivery ${ref.cut_id}`;
    const body = [
      "<!-- quadwork-delivery-candidate -->",
      `Delivery manifest: ${manifest.delivery_manifest_digest}`,
      `Delivery candidate: ${deliveryCandidateKey(ref)}`,
      "Included work items:",
      ...workItems.map((item) => `- ${item.repo}#${item.number} (${item.kind})`),
    ].join("\n");
    return freeze({
      version: VERSION,
      kind: "delivery_publication_operator_gate",
      operator_approval_required: true,
      delivery_candidate_ref: clone(ref),
      delivery_manifest_digest: manifest.delivery_manifest_digest,
      repository: repository.toLowerCase(),
      branch,
      exact_sha: ref.result_sha,
      title,
      body,
      work_items: workItems,
    });
  }
  return freeze({ plan });
}

module.exports = { VERSION, DeliveryPublicationPlanError, createDeliveryPublicationPlanService };
