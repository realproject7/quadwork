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

ok(/createDeliveryFinalReviewService/.test(source) && /function deliveryFinalReviewContext/.test(source) &&
  /createDeliveryCandidateStore\(\{ config_dir: CONFIG_DIR, fs \}\)\.readSnapshot/.test(source),
  "final Delivery Candidate admission uses the registered candidate store and existing final-review service");

ok(/router\.post\("\/api\/delivery-candidate\/final-review", async/.test(source) &&
  /freshDeliveryFinalReviewContext/.test(source) && /observeDeliveryReview/.test(source),
  "Head final review and evidence submission share the current delivery observer");

ok(/async function verifyCurrentReviewCycleContract[\s\S]*?await freshDeliveryFinalReviewContext[\s\S]*?currentReviewCycleForPrincipal/.test(source),
  "Delivery Candidate nonce and receipt mutations require a fresh PR and candidate read plus current-cycle reload");

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
