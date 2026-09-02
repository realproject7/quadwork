"use strict";

// The service owns final-review admission semantics; this narrow source guard
// keeps the HTTP integration on its deliberately local, revalidated path
// without booting the full server and its pollers in a unit test.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "routes.js"), "utf8");
let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

ok(/createDeliveryFinalReviewService/.test(source) &&
  /function deliveryFinalReviewContext\(projectId, deliveryCandidateRef, prNumber\)[\s\S]*?createDeliveryCandidateStore\(\{ config_dir: CONFIG_DIR, fs \}\)\.readSnapshot\(request\.delivery_candidate_ref\)[\s\S]*?_graphqlCache\.get\(binding\.cache_repo\)[\s\S]*?cached\.ts > REVIEW_CONTRACT_MAX_AGE_MS[\s\S]*?canonicalSha\(row\.tip\)[\s\S]*?exact_sha: canonicalSha\(row\.tip\)/.test(source),
  "final Delivery Candidate admission derives snapshot, PR, and exact SHA from registered server readers only");

ok(/router\.post\("\/api\/delivery-candidate\/final-review",[\s\S]*?principal\.agentId !== "head"[\s\S]*?captureProjectAdmission\(principal\.projectId\)[\s\S]*?deliveryFinalReviewContext\(principal\.projectId, body\.delivery_candidate_ref, body\.pr_number\)[\s\S]*?_reviewCycleDispatcher\.observe\([\s\S]*?appendTrustedReviewCycleEventOnce/.test(source),
  "the fixed Head route admits an existing candidate into a trusted reviewer handoff without publication inputs");

ok(/function currentReviewCycleForPrincipal\(principal, digest\)[\s\S]*?cycle\.target\.target_kind === DELIVERY_REVIEW_TARGET_KIND[\s\S]*?deliveryFinalReviewContext\(principal\.projectId, cycle\.target\.delivery_candidate_ref, cycle\.target\.pr_number\)\.target[\s\S]*?current\.target_identity_digest === cycle\.target_identity_digest/.test(source) &&
  /async function verifyCurrentReviewCycleContract\(principal, digest, cycle\)[\s\S]*?cycle\?\.target\?\.target_kind === DELIVERY_REVIEW_TARGET_KIND[\s\S]*?return currentReviewCycleForPrincipal\(principal, digest\)/.test(source),
  "Delivery Candidate nonce and receipt operations revalidate the composed candidate and current PR target");

ok(/router\.post\("\/api\/review-cycle-nonce",[\s\S]*?cycle\.target\.target_kind !== DELIVERY_REVIEW_TARGET_KIND[\s\S]*?verifyCurrentReviewCycleContract[\s\S]*?issueReviewNonce/.test(source) &&
  /router\.post\("\/api\/review-cycle-receipt",[\s\S]*?cycle\.target\.target_kind !== DELIVERY_REVIEW_TARGET_KIND[\s\S]*?verifyCurrentReviewCycleContract[\s\S]*?recordReviewReceiptWithNonce/.test(source),
  "legacy contract reads are bypassed only for the separately revalidated Delivery Candidate target kind");

ok(/router\.post\("\/api\/delivery-candidate\/ci-evidence",[\s\S]*?createDeliveryCandidateCiLessEvidenceSubmitHandler[\s\S]*?resolveCurrentTarget: resolveCurrentDeliveryCandidateCiEvidenceTarget[\s\S]*?store: _ciEvidenceStore/.test(source) &&
  /function deliveryCandidateCiEvidenceTarget\(current\)[\s\S]*?delivery_candidate_ref: current\.target\.identity\.delivery_candidate_ref[\s\S]*?delivery_manifest_digest: current\.target\.identity\.delivery_manifest_digest/.test(source) &&
  /policy\?\.mode === "ci-less"[\s\S]*?_ciEvidenceStore\.readByIdentity\(deliveryCandidateCiEvidenceTarget\(current\)\)/.test(source),
  "Delivery Candidate CI-less evidence uses the existing atomic receipt store and only the current composed PR identity");

ok(/router\.post\("\/api\/delivery-candidate\/publication-plan",[\s\S]*?principal\.agentId !== "head"[\s\S]*?captureProjectAdmission\(principal\.projectId\)[\s\S]*?deliveryPublicationPlanContext\(principal\.projectId, body\.delivery_candidate_ref\)[\s\S]*?return res\.json\(\{ ok: true, plan \}\)/.test(source) &&
  /function deliveryPublicationPlanContext\(projectId, deliveryCandidateRef\)[\s\S]*?createDeliveryPublicationPlanService[\s\S]*?createDeliveryCandidateStore\(\{ config_dir: CONFIG_DIR, fs \}\)\.readSnapshot/.test(source),
  "the Head can derive a composed Delivery Candidate publication plan without a branch or PR write path");

console.log(`routes.deliveryFinalReview.test.js: ${passed} assertions passed`);
