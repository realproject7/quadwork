"use strict";

// #1060 M8: admit only an already-published, server-observed PR into the
// final Delivery Candidate review cycle. This service cannot publish or read
// a remote itself. Its caller supplies three narrow server authorities: the
// durable candidate snapshot, the cached PR fact, and registered CI policy.

const { assertDeliveryCandidateRef, deliveryCandidateKey, assertDeliveryManifest } = require("./delivery-candidate");
const { deriveDeliveryReviewTarget } = require("./delivery-review-target");

const VERSION = 1;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

class DeliveryFinalReviewServiceError extends Error {
  constructor(code, message = code) { super(message); this.name = "DeliveryFinalReviewServiceError"; this.code = code; }
}
function fail(code, message) { throw new DeliveryFinalReviewServiceError(code, message); }
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
function sameRef(left, right) {
  try { return deliveryCandidateKey(left) === deliveryCandidateKey(right); }
  catch { return false; }
}
function binding(value, code) {
  exact(value, ["installation_id", "project_id", "role", "generation"], code);
  if (!INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id) || value.role !== "head" ||
      !Number.isSafeInteger(value.generation) || value.generation < 0) {
    fail(code, "Head binding is invalid");
  }
  return { installation_id: value.installation_id, project_id: value.project_id, role: "head", generation: value.generation };
}
function reference(value, code) {
  try { return clone(assertDeliveryCandidateRef(value, code)); }
  catch { fail(code, "Delivery Candidate reference is invalid"); }
}
function options(value) {
  exact(value, ["read_candidate_snapshot", "read_pr", "read_ci_policy"], "invalid_delivery_final_review_service_options");
  for (const key of ["read_candidate_snapshot", "read_pr", "read_ci_policy"]) {
    if (typeof value[key] !== "function") fail("invalid_delivery_final_review_service_options", "server read authority is required");
  }
  return value;
}
function snapshot(value, ref) {
  exact(value, ["delivery_candidate_ref", "lifecycle", "delivery_manifest", "composition_proof"], "delivery_final_review_snapshot_invalid");
  if (!sameRef(value.delivery_candidate_ref, ref) || !plain(value.lifecycle) || value.lifecycle.status !== "composed" || value.composition_proof === null) {
    fail("delivery_final_review_snapshot_invalid", "Delivery Candidate is not composed");
  }
  let manifest;
  try { manifest = assertDeliveryManifest(value.delivery_manifest); }
  catch { fail("delivery_final_review_snapshot_invalid", "Delivery Candidate manifest is invalid"); }
  if (!sameRef(manifest.delivery_candidate_ref, ref)) fail("delivery_final_review_snapshot_invalid", "Delivery Candidate manifest changed");
  return { delivery_manifest: clone(manifest) };
}
function pr(value, ref, expectedNumber) {
  exact(value, ["number", "exact_sha", "draft", "mergeable"], "delivery_final_review_pr_invalid");
  if (value.number !== expectedNumber || !SHA_RE.test(value.exact_sha) || value.exact_sha !== ref.result_sha ||
      typeof value.draft !== "boolean" || typeof value.mergeable !== "boolean") {
    fail("delivery_final_review_pr_invalid", "published PR does not match the composed Delivery Candidate");
  }
  return { number: value.number, exact_sha: value.exact_sha, draft: value.draft, mergeable: value.mergeable };
}

function createDeliveryFinalReviewService(value) {
  const deps = options(value);
  function open(request) {
    exact(request, ["version", "head_binding", "delivery_candidate_ref", "pr_number"], "invalid_delivery_final_review_request");
    if (request.version !== VERSION || !Number.isSafeInteger(request.pr_number) || request.pr_number < 1) {
      fail("invalid_delivery_final_review_request", "final review request is invalid");
    }
    const owner = binding(request.head_binding, "invalid_delivery_final_review_request");
    const ref = reference(request.delivery_candidate_ref, "invalid_delivery_final_review_request");
    if (ref.installation_id !== owner.installation_id || ref.project_id !== owner.project_id || !REPOSITORY_KEY_RE.test(ref.repository_key)) {
      fail("delivery_final_review_head_denied", "Head does not own this Delivery Candidate");
    }
    let stored;
    try { stored = snapshot(deps.read_candidate_snapshot(freeze({ version: VERSION, delivery_candidate_ref: clone(ref) })), ref); }
    catch (error) {
      if (error instanceof DeliveryFinalReviewServiceError) throw error;
      fail("delivery_final_review_candidate_unavailable", "Delivery Candidate snapshot is unavailable");
    }
    let observedPr;
    try {
      observedPr = pr(deps.read_pr(freeze({
        version: VERSION,
        head_binding: clone(owner),
        delivery_candidate_ref: clone(ref),
        pr_number: request.pr_number,
      })), ref, request.pr_number);
    } catch (error) {
      if (error instanceof DeliveryFinalReviewServiceError) throw error;
      fail("delivery_final_review_pr_unavailable", "published Delivery Candidate PR is unavailable");
    }
    let policy;
    try {
      policy = deps.read_ci_policy(freeze({
        version: VERSION,
        installation_id: owner.installation_id,
        project_id: owner.project_id,
        repository_key: ref.repository_key,
      }));
    } catch {
      fail("delivery_final_review_policy_unavailable", "registered CI policy is unavailable");
    }
    try {
      return freeze(deriveDeliveryReviewTarget({
        delivery_manifest: stored.delivery_manifest,
        pr: observedPr,
        ci_policy: policy === undefined ? null : policy,
      }));
    } catch (error) {
      const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code)
        ? error.code : "delivery_final_review_target_invalid";
      fail(code, "Delivery Candidate final review target is invalid");
    }
  }
  return freeze({ open });
}

module.exports = { VERSION, DeliveryFinalReviewServiceError, createDeliveryFinalReviewService };
