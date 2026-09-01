"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  LEGACY_REVIEW_TARGET_KIND,
  ReviewCycleStore,
  deriveLegacyReviewTarget,
} = require("./review-cycle");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-review-cycle-"));
const PROJECT = "project-a";
const INSTALLATION = "installation_1234567890abcdef";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const CONTRACT_A = "c".repeat(64);
const CONTRACT_B = "d".repeat(64);
let clock = 0;

function now() {
  clock += 1;
  return new Date(`2026-09-01T00:00:${String(clock).padStart(2, "0")}.000Z`);
}

function policy(extra = {}) {
  return {
    version: 1,
    mode: "github-checks",
    registration_grace_seconds: 60,
    same_sha_retry_budget: 1,
    checks: [{ name: "unit", required: true, kind: "product" }],
    ...extra,
  };
}

function source(overrides = {}) {
  const base = {
    installation_id: INSTALLATION,
    project_id: PROJECT,
    repository: { key: "web", repo: "Acme/Web", ci_policy: policy() },
    work_item: { repoKey: "web", repo: "Acme/Web", number: 42, kind: "issue" },
    pr: { number: 99, exact_sha: SHA_A, draft: false, mergeable: true },
    issue_contract: { contract_revision: CONTRACT_A },
    assignment_attempt: "attempt-a",
  };
  return {
    ...base,
    ...overrides,
    repository: { ...base.repository, ...(overrides.repository || {}) },
    work_item: { ...base.work_item, ...(overrides.work_item || {}) },
    pr: { ...base.pr, ...(overrides.pr || {}) },
    issue_contract: { ...base.issue_contract, ...(overrides.issue_contract || {}) },
  };
}

function target(overrides = {}) {
  return deriveLegacyReviewTarget(source(overrides));
}

function receipt(role, reviewId, verdict = "approved", overrides = {}) {
  return {
    reviewer_role: role,
    review_id: reviewId,
    verdict,
    submitted_at: "2026-09-01T00:10:00.000Z",
    target_identity_digest: overrides.target_identity_digest || target().target_identity_digest,
    ...overrides,
  };
}

function freshStore() {
  return new ReviewCycleStore({ rootDir: ROOT, now });
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// The adapter is a closed, server-derived target union.  It does not accept a
// caller target kind, prose/body field, or a PR/issue that is not one canonical
// repository-qualified issue WorkItemRef.
const canonical = target();
assert.equal(canonical.target_kind, LEGACY_REVIEW_TARGET_KIND);
assert.match(canonical.target_identity_digest, /^[a-f0-9]{64}$/);
assert.match(canonical.slot_digest, /^[a-f0-9]{64}$/);
ok(true, "canonical legacy target binds installation/repository/item/PR/SHA/contract/policy identity");
for (const [label, candidate] of [
  ["unknown target kind", source({ target_kind: "delivery_candidate" })],
  ["untrusted prose", source({ prose: "@re1 @re2 REVIEW REQUEST" })],
  ["PR item", source({ work_item: { kind: "pr" } })],
  ["foreign repo item", source({ work_item: { repoKey: "api", repo: "Acme/API" } })],
]) {
  assert.throws(
    () => deriveLegacyReviewTarget(candidate),
    (error) => error.code === "invalid_review_cycle_source",
  );
  ok(true, `${label} cannot enter the closed legacy target adapter`);
}

const store = freshStore();
let cycle = store.reconcile(PROJECT, canonical).cycle;
assert.equal(cycle.readiness, "ready");
assert.equal(cycle.ci_state, "unknown");
assert.equal(cycle.review_state, "not_dispatched");
ok(true, "new cycle starts with orthogonal ready/unknown/not-dispatched facts");

assert.equal(store.planReviewRequest(PROJECT, canonical), null);
cycle = store.setCiState(PROJECT, canonical, "pending");
assert.equal(cycle.ci_state, "pending");
const dispatch = store.planReviewRequest(PROJECT, canonical);
assert.equal(dispatch.kind, "review_request");
assert.equal(dispatch.created, true);
assert.match(dispatch.correlation_id, /^rc_evt_[a-f0-9]{40}$/);
assert.equal(store.planReviewRequest(PROJECT, canonical).correlation_id, dispatch.correlation_id);
assert.equal(store.planReviewRequest(PROJECT, canonical).created, false);
ok(true, "ready plus pending CI records one stable server-transport correlation without sending prose");

// Shared GitHub principals cannot claim each other's review object: each role
// gets a private one-time cycle nonce, which is consumed against one review id.
const nonceRe1 = store.issueReviewNonce(PROJECT, canonical, "re1");
assert.equal(store.issueReviewNonce(PROJECT, canonical, "re1").nonce, nonceRe1.nonce);
const nonceRe2 = store.issueReviewNonce(PROJECT, canonical, "re2");
assert.notEqual(nonceRe1.nonce, nonceRe2.nonce);
assert.throws(
  () => store.recordReviewReceiptWithNonce(PROJECT, canonical, receipt("re2", 101, "approved", { target_identity_digest: canonical.target_identity_digest }), nonceRe1.nonce),
  (error) => error.code === "review_cycle_nonce_invalid",
);
assert.throws(
  () => store.recordReviewReceiptWithNonce(PROJECT, canonical, receipt("re1", 101, "approved", { target_identity_digest: canonical.target_identity_digest }), "qwrc_" + "0".repeat(32)),
  (error) => error.code === "review_cycle_nonce_invalid",
);
store.recordReviewReceiptWithNonce(PROJECT, canonical, receipt("re1", 101, "approved", { target_identity_digest: canonical.target_identity_digest }), nonceRe1.nonce);
assert.equal(store.recordReviewReceiptWithNonce(PROJECT, canonical, receipt("re1", 101, "approved", { target_identity_digest: canonical.target_identity_digest }), nonceRe1.nonce).review_state, "1/2");
assert.throws(
  () => store.recordReviewReceiptWithNonce(PROJECT, canonical, receipt("re1", 102, "approved", { target_identity_digest: canonical.target_identity_digest }), nonceRe1.nonce),
  (error) => error.code === "review_cycle_nonce_consumed",
);
ok(true, "private reviewer nonces reject cross-role, missing/wrong, and reused-review claims");

// A crash/failing atomic replace cannot burn a valid nonce before its receipt
// exists. The old document remains fully retryable (nonce unconsumed, no role
// receipt) because the combined operation has exactly one durable write.
const failingFs = new Proxy(fs, {
  get(targetFs, property) {
    if (property === "renameSync") return () => { throw new Error("simulated crash before replace"); };
    return targetFs[property];
  },
});
const failingStore = new ReviewCycleStore({ rootDir: ROOT, now, fsImpl: failingFs });
assert.throws(
  () => failingStore.recordReviewReceiptWithNonce(PROJECT, canonical, receipt("re2", 202, "approved", { target_identity_digest: canonical.target_identity_digest }), nonceRe2.nonce),
  (error) => error.code === "review_cycle_store_write_failed",
);
const afterFailedWrite = freshStore().current(PROJECT, canonical);
assert.equal(afterFailedWrite.receipts.re2, null);
assert.equal(afterFailedWrite.review_nonces.re2.consumed_at, null);
ok(true, "failed receipt write preserves nonce and receipt together for retry");

cycle = store.recordReviewReceipt(PROJECT, canonical, receipt("re1", 101, "approved", {
  target_identity_digest: canonical.target_identity_digest,
}));
assert.equal(cycle.review_state, "1/2");
assert.equal(store.planHeadGate(PROJECT, canonical), null);
ok(true, "one role-bound receipt is 1/2 while CI pending and cannot mint a Head gate");

cycle = store.setCiState(PROJECT, canonical, "product_failure");
assert.equal(cycle.review_state, "1/2");
assert.equal(store.planReviewRequest(PROJECT, canonical).correlation_id, dispatch.correlation_id);
assert.equal(store.planHeadGate(PROJECT, canonical), null);
ok(true, "terminal-red CI preserves already recorded review facts but suppresses a Head gate");

// A distinct role may not claim a shared GitHub review object, and a role may
// not replace its receipt without a new exact-SHA cycle.
assert.throws(
  () => store.recordReviewReceipt(PROJECT, canonical, receipt("re2", 101, "approved", {
    target_identity_digest: canonical.target_identity_digest,
  })),
  (error) => error.code === "review_cycle_review_id_already_bound",
);
assert.throws(
  () => store.recordReviewReceipt(PROJECT, canonical, receipt("re1", 102, "approved", {
    target_identity_digest: canonical.target_identity_digest,
  })),
  (error) => error.code === "review_cycle_role_already_receipted",
);
assert.throws(
  () => store.recordReviewReceipt(PROJECT, canonical, {
    ...receipt("re2", 202, "approved", { target_identity_digest: canonical.target_identity_digest }),
    body: "looks approved",
  }),
  (error) => error.code === "invalid_review_cycle_receipt",
);
ok(true, "shared review IDs, duplicate role claims, and review prose cannot spoof target-role receipts");

// A retip invalidates the old cycle with its events and receipts.  The old
// target becomes stale even though it names the same project/repository/PR.
const retip = target({ pr: { exact_sha: SHA_B } });
const retipped = store.reconcile(PROJECT, retip);
assert.deepEqual(retipped.invalidated.reasons, ["exact_sha_changed"]);
assert.equal(retipped.cycle.review_state, "not_dispatched");
assert.throws(
  () => store.setCiState(PROJECT, canonical, "pass"),
  (error) => error.code === "review_cycle_stale_target",
);
assert.throws(
  () => store.current("project-b", retip),
  (error) => error.code === "review_cycle_cross_project",
);
ok(true, "a new exact SHA invalidates old review authority and cross-project access fails closed");

store.setCiState(PROJECT, retip, "pass");
const retipDispatch = store.planReviewRequest(PROJECT, retip);
store.recordReviewReceipt(PROJECT, retip, receipt("re1", 201, "approved", {
  target_identity_digest: retip.target_identity_digest,
}));
cycle = store.recordReviewReceipt(PROJECT, retip, receipt("re2", 202, "approved", {
  target_identity_digest: retip.target_identity_digest,
}));
assert.equal(cycle.review_state, "2/2");
assert.equal(cycle.head_gate_due, true);
const gate = store.planHeadGate(PROJECT, retip);
assert.equal(gate.kind, "head_gate_due");
assert.equal(gate.created, true);
assert.equal(store.planHeadGate(PROJECT, retip).correlation_id, gate.correlation_id);
assert.equal(store.planHeadGate(PROJECT, retip).created, false);
ok(true, "two independent current-SHA approvals plus pass CI create one derived Head-gate correlation only");

// A changed contract sets a Head-only contract-change correlation, removes all
// current receipt eligibility, and remains blocked until a new assignment
// attempt names the new contract revision.
const changedContract = target({
  pr: { exact_sha: SHA_B },
  issue_contract: { contract_revision: CONTRACT_B },
});
const contractResult = store.reconcile(PROJECT, changedContract);
assert.deepEqual(contractResult.invalidated.reasons, ["contract_changed"]);
assert.equal(contractResult.invalidated.contract_change.kind, "contract_changed");
assert.equal(contractResult.cycle.readiness, "contract_changed");
assert.equal(store.planReviewRequest(PROJECT, changedContract), null);
assert.throws(
  () => store.setReadiness(PROJECT, changedContract, "ready"),
  (error) => error.code === "review_cycle_fresh_assignment_required",
);
const freshAttempt = target({
  pr: { exact_sha: SHA_B },
  issue_contract: { contract_revision: CONTRACT_B },
  assignment_attempt: "attempt-b",
});
const refreshed = store.reconcile(PROJECT, freshAttempt).cycle;
assert.equal(refreshed.readiness, "ready");
assert.equal(refreshed.review_state, "not_dispatched");
ok(true, "contract revision invalidates review authority and needs a fresh digest-bound assignment attempt");

// A policy change, including a semantic change under the same version, has a
// new target digest and no inherited CI/review record.
const policyChanged = target({
  pr: { exact_sha: SHA_B },
  issue_contract: { contract_revision: CONTRACT_B },
  assignment_attempt: "attempt-b",
  repository: { ci_policy: policy({ checks: [{ name: "typecheck", required: true, kind: "product" }] }) },
});
const policyResult = store.reconcile(PROJECT, policyChanged);
assert.deepEqual(policyResult.invalidated.reasons, ["policy_changed"]);
assert.equal(policyResult.cycle.ci_state, "unknown");
ok(true, "same-version policy semantics are identity-bound and invalidate stale evidence");

// Missing policy is explicit and cannot be upgraded by a caller-selected CI
// state.  CI-less pass is an independently permitted registered evidence mode.
const missingPolicy = target({ repository: { ci_policy: null }, pr: { number: 100, exact_sha: SHA_A } });
const missing = store.reconcile(PROJECT, missingPolicy).cycle;
assert.equal(missing.ci_state, "missing_policy");
assert.equal(store.planReviewRequest(PROJECT, missingPolicy), null);
assert.throws(
  () => store.setCiState(PROJECT, missingPolicy, "pass"),
  (error) => error.code === "review_cycle_missing_policy",
);
const ciLess = target({
  repository: { ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["unit"] } },
  pr: { number: 101, exact_sha: SHA_A },
});
store.reconcile(PROJECT, ciLess);
store.setCiState(PROJECT, ciLess, "ci_less_pending");
assert.equal(store.planReviewRequest(PROJECT, ciLess).kind, "review_request");
store.setCiState(PROJECT, ciLess, "ci_less_pass");
store.recordReviewReceipt(PROJECT, ciLess, receipt("re1", 301, "approved", { target_identity_digest: ciLess.target_identity_digest }));
cycle = store.recordReviewReceipt(PROJECT, ciLess, receipt("re2", 302, "changes_requested", { target_identity_digest: ciLess.target_identity_digest }));
assert.equal(cycle.review_state, "changes_requested");
assert.equal(cycle.head_gate_due, false);
ok(true, "missing-policy and CI-less states remain explicit; changes requested preserves receipts but blocks Head gate");

// The persisted store is owner-only and restart-stable.  Corruption fails
// closed rather than replacing trusted identity/receipt state.
const restarted = freshStore();
const restartedCurrent = restarted.current(PROJECT, ciLess);
assert.equal(restartedCurrent.events.review_request.correlation_id, store.current(PROJECT, ciLess).events.review_request.correlation_id);
const file = restarted.pathFor(PROJECT);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
ok(true, "atomic owner-only cycle state survives a fresh store instance with stable correlations");

const corruptProject = "project-corrupt";
const corruptPath = restarted.pathFor(corruptProject);
fs.mkdirSync(path.dirname(corruptPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(corruptPath, "{not-json", { mode: 0o600 });
assert.throws(
  () => restarted.load(corruptProject),
  (error) => error.code === "review_cycle_store_invalid",
);
ok(true, "corrupt cycle state is rejected without a recovery overwrite");

const terminal = restarted.markTerminal(PROJECT, ciLess);
assert.equal(terminal.state, "terminal");
const retained = restarted.load(PROJECT);
assert.equal(retained.cycles[terminal.cycle_id].state, "terminal");
assert.equal(
  Object.values(retained.cycles).some((entry) => entry.state === "invalidated"),
  true,
);
ok(true, "M1 retains terminal and invalidated receipt history until a later queue-owned retention authority exists");

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
console.log(`\n${passed} review-cycle assertions passed`);
