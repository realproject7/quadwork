"use strict";

// #1060 M6: typed final-review target for one sealed Delivery Candidate.
// This pure adapter has no cycle store, GitHub, route, chat, process, or
// publication capability. It converts only a validated manifest plus a
// server-observed PR/check-policy fact into the immutable target identity that
// the later #1048 target-union integration will admit.

const crypto = require("node:crypto");
const { assertDeliveryManifest, deliveryCandidateKey } = require("./delivery-candidate");
const { normalizeCiPolicy, deriveCiPolicyIdentity, canonicalSha } = require("./ci-evidence-policy");

const VERSION = 1;
const TARGET_KIND = "delivery_candidate_pr";
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[a-f0-9]{64}$/;

class DeliveryReviewTargetError extends Error {
  constructor(code, message = code) { super(message); this.name = "DeliveryReviewTargetError"; this.code = code; }
}
function fail(code, message) { throw new DeliveryReviewTargetError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail(code, "value has an unknown or missing field");
}
function clone(value) { return Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function canonicalRepository(value, code) { if (typeof value !== "string" || !REPOSITORY_RE.test(value)) fail(code, "repository is invalid"); return value.toLowerCase(); }
function pr(value) {
  exact(value, ["number", "exact_sha", "draft", "mergeable"], "invalid_delivery_review_target_source");
  if (!Number.isSafeInteger(value.number) || value.number < 1 || !canonicalSha(value.exact_sha) || typeof value.draft !== "boolean" || typeof value.mergeable !== "boolean") {
    fail("invalid_delivery_review_target_source", "published Delivery Candidate PR fact is invalid");
  }
  return { number: value.number, exact_sha: value.exact_sha.toLowerCase(), draft: value.draft, mergeable: value.mergeable };
}
function source(value) {
  exact(value, ["delivery_manifest", "pr", "ci_policy"], "invalid_delivery_review_target_source");
  let manifest;
  try { manifest = assertDeliveryManifest(value.delivery_manifest); }
  catch { fail("invalid_delivery_review_target_source", "delivery manifest is invalid"); }
  const policy = value.ci_policy === null ? null : (() => { try { return normalizeCiPolicy(value.ci_policy); } catch { fail("invalid_delivery_review_target_policy", "registered CI policy is invalid"); } })();
  return { manifest, pr: pr(value.pr), policy };
}
function identityFor(manifest, prFact, policy) {
  const ref = manifest.delivery_candidate_ref;
  const work_items = manifest.staged_tasks.map((stage) => ({
    repoKey: stage.work_item.repoKey,
    repo: canonicalRepository(stage.work_item.repo, "invalid_delivery_review_target_source"),
    number: stage.work_item.number,
    kind: stage.work_item.kind,
  }));
  if (work_items.length === 0 || new Set(work_items.map((item) => JSON.stringify(item))).size !== work_items.length) {
    fail("invalid_delivery_review_target_source", "Delivery Candidate work-item provenance is invalid");
  }
  const policy_identity = policy === null ? null : deriveCiPolicyIdentity(policy);
  return {
    version: VERSION,
    target_kind: TARGET_KIND,
    installation_id: ref.installation_id,
    project_id: ref.project_id,
    repo_key: ref.repository_key,
    repo: canonicalRepository(manifest.registered_repository.repository, "invalid_delivery_review_target_source"),
    delivery_candidate_ref: clone(ref),
    delivery_candidate_key: deliveryCandidateKey(ref),
    delivery_manifest_digest: manifest.delivery_manifest_digest,
    work_items,
    pr_number: prFact.number,
    exact_sha: prFact.exact_sha,
    policy_version: policy_identity === null ? null : policy_identity.version,
    policy_digest: policy_identity === null ? null : policy_identity.digest,
  };
}
function identityDigest(identity) {
  return hash({
    version: identity.version, target_kind: identity.target_kind, installation_id: identity.installation_id, project_id: identity.project_id,
    repo_key: identity.repo_key, repo: identity.repo, delivery_candidate_ref: identity.delivery_candidate_ref,
    delivery_candidate_key: identity.delivery_candidate_key, delivery_manifest_digest: identity.delivery_manifest_digest,
    work_items: identity.work_items, pr_number: identity.pr_number, exact_sha: identity.exact_sha,
    policy_version: identity.policy_version, policy_digest: identity.policy_digest,
  });
}
function slotDigest(identity) {
  return hash({ version: identity.version, target_kind: identity.target_kind, installation_id: identity.installation_id,
    project_id: identity.project_id, repo_key: identity.repo_key, repo: identity.repo, pr_number: identity.pr_number });
}
function deriveDeliveryReviewTarget(value) {
  const input = source(value);
  const identity = identityFor(input.manifest, input.pr, input.policy);
  if (!SHA_RE.test(identity.delivery_manifest_digest)) fail("invalid_delivery_review_target_source", "Delivery Candidate manifest digest is invalid");
  return freeze({ version: VERSION, target_kind: TARGET_KIND, identity: freeze(identity), target_identity_digest: identityDigest(identity), slot_digest: slotDigest(identity),
    observed: freeze({ draft: input.pr.draft, mergeable: input.pr.mergeable }) });
}

module.exports = { VERSION, TARGET_KIND, DeliveryReviewTargetError, deriveDeliveryReviewTarget, identityDigest, slotDigest };
