"use strict";

const assert = require("node:assert/strict");
const {
  normalizeCiPolicy,
  deriveCiPolicyIdentity,
  sameCiPolicyIdentity,
  normalizeGithubCheckEvidence,
  evaluateCiEvidence,
} = require("./ci-evidence-policy");

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

function policy() {
  return {
    version: 1,
    mode: "github-checks",
    registration_grace_seconds: 120,
    same_sha_retry_budget: 1,
    checks: [
      { name: "gates", required: true, kind: "product" },
      { name: "classify", required: true, kind: "control-plane" },
      { name: "e2e", required: false, kind: "product" },
    ],
  };
}

const SHA = "a".repeat(40);
const AT = "2026-08-31T00:00:00.000Z";
const FIRST = "2026-08-30T23:50:00.000Z";

function run(name, attempt, status = "completed", conclusion = "success", extra = {}) {
  return {
    id: `${name}-${attempt}`,
    attempt,
    name,
    status,
    conclusion,
    details_url: `https://ci.example/${name}/${attempt}`,
    head_sha: SHA,
    started_at: null,
    completed_at: null,
    observed_at: AT,
    ...extra,
  };
}

function evaluate(overrides = {}) {
  return evaluateCiEvidence({
    policy: policy(),
    exact_sha: SHA,
    observed_at: AT,
    first_observed_at: FIRST,
    source_status: "ok",
    now: Date.parse(AT),
    check_runs: [run("gates", 1), run("classify", 1)],
    ...overrides,
  });
}

// Strict registry validation rejects authority-affecting ambiguity.
ok(normalizeCiPolicy(policy()).checks.length === 3, "valid exact-name github policy normalizes");
for (const [label, candidate, code] of [
  ["duplicate names", { ...policy(), checks: [{ name: "gates", required: true, kind: "product" }, { name: "gates", required: true, kind: "product" }] }, "duplicate_ci_policy_check_name"],
  ["empty name", { ...policy(), checks: [{ name: "", required: true, kind: "product" }] }, "invalid_ci_policy_check_name"],
  ["unknown field", { ...policy(), authority: "guess" }, "invalid_ci_policy"],
  ["no required check", { ...policy(), checks: [{ name: "advisory", required: false, kind: "product" }] }, "ci_policy_required_check_missing"],
  ["negative grace", { ...policy(), registration_grace_seconds: -1 }, "invalid_ci_policy_registration_grace"],
  ["negative budget", { ...policy(), same_sha_retry_budget: -1 }, "invalid_ci_policy_retry_budget"],
  ["CI-less missing keys", { version: 1, mode: "ci-less", evidence_keys: [] }, "invalid_ci_policy_evidence_keys"],
  ["CI-less unknown field", { version: 1, mode: "ci-less", evidence_keys: ["unit"], checks: [] }, "invalid_ci_policy"],
]) {
  assert.throws(() => normalizeCiPolicy(candidate), (error) => error?.code === code, label);
  passed += 1;
  console.log(`  PASS: ${label} policy is rejected`);
}

assert.equal(evaluateCiEvidence({ exact_sha: SHA, observed_at: AT, source_status: "ok" }).state, "missing_policy");
ok(true, "missing policy fails closed without inferring visible checks");
assert.equal(evaluate().state, "pass");
ok(true, "all required exact-name checks passing at the same SHA passes");
assert.equal(evaluate({ source_status: "unavailable" }).state, "unknown");
ok(true, "stale or unavailable live data is unknown");
assert.equal(evaluate({ first_observed_at: null }).state, "unknown");
ok(true, "registration grace without durable first observation fails closed across restart");

const pendingRegistration = evaluate({
  check_runs: [run("gates", 1)],
  first_observed_at: AT,
  now: Date.parse(AT) + 30_000,
});
assert.equal(pendingRegistration.state, "pending");
assert.equal(pendingRegistration.checks.find((check) => check.name === "classify").state, "pending_registration");
ok(true, "a missing required check is pending only inside bounded registration grace");
assert.equal(evaluate({ check_runs: [run("gates", 1)] }).state, "missing_required");
ok(true, "a missing or renamed required check after grace is never silently not_selected");

const rerun = evaluate({ check_runs: [run("gates", 1, "completed", "success"), run("gates", 2, "completed", "failure"), run("classify", 1)] });
assert.equal(rerun.state, "product_failure");
assert.equal(rerun.checks.find((check) => check.name === "gates").run.attempt, 2);
ok(true, "newer same-name rerun failure cannot be hidden by an older success");
const skippedRequired = evaluate({ check_runs: [run("gates", 1, "completed", "skipped"), run("classify", 1)] });
assert.equal(skippedRequired.state, "missing_required");
assert.equal(skippedRequired.checks.find((check) => check.name === "gates").state, "not_success");
assert.equal(skippedRequired.retry.owner, "head");
const neutralRequired = evaluate({ check_runs: [run("gates", 1, "completed", "neutral"), run("classify", 1)] });
assert.equal(neutralRequired.state, "missing_required");
assert.equal(neutralRequired.retry.owner, "head");
ok(true, "skipped or neutral required checks never pass and use the Head-owned fail-closed resolution path");
assert.equal(evaluate({ check_runs: [run("gates", 1), run("classify", 1), run("e2e", 1, "completed", "failure")] }).state, "pass");
ok(true, "advisory E2E failure remains visible but cannot block the registry");
assert.equal(evaluate({ check_runs: [run("gates", 1, "completed", "failure"), run("classify", 1)] }).state, "product_failure");
assert.equal(evaluate({ check_runs: [run("gates", 1), run("classify", 1, "completed", "failure")] }).state, "control_plane_failure");
assert.equal(evaluate({ check_runs: [run("gates", 1, "completed", "timed_out"), run("classify", 1)] }).state, "cancelled");
ok(true, "product, control-plane, and cancellation outcomes remain typed");

const normalized = normalizeGithubCheckEvidence({ check_runs: [{ id: 99, name: "gates", run_attempt: 3, status: "completed", conclusion: "success", details_url: "https://ci.example/gates", head_sha: SHA }] }, {
  exact_sha: SHA,
  observed_at: AT,
  source_status: "ok",
});
assert.deepEqual(normalized.check_runs[0], {
  id: "99", attempt: 3, name: "gates", status: "completed", conclusion: "success",
  details_url: "https://ci.example/gates", head_sha: SHA, started_at: null, completed_at: null, observed_at: AT,
});
ok(true, "check normalization preserves exact ID, attempt, name, conclusion, URL, SHA, and observation time");

const ciLess = { version: 1, mode: "ci-less", evidence_keys: ["unit", "typecheck"] };
assert.equal(evaluateCiEvidence({ policy: ciLess, exact_sha: SHA, observed_at: AT, source_status: "ok" }).state, "ci_less_pending");
assert.equal(evaluateCiEvidence({ policy: ciLess, exact_sha: SHA, observed_at: AT, source_status: "ok", ci_less_evidence: { policy_version: 1, exact_sha: SHA, results: [{ key: "unit", outcome: "pass" }, { key: "typecheck", outcome: "pass" }] } }).state, "ci_less_pass");
assert.equal(evaluateCiEvidence({ policy: ciLess, exact_sha: SHA, observed_at: AT, source_status: "ok", ci_less_evidence: { policy_version: 1, exact_sha: SHA, results: [{ key: "unit", outcome: "fail" }, { key: "typecheck", outcome: "pass" }] } }).state, "product_failure");
ok(true, "CI-less evidence is pending, pass, or product failure only for the exact configured key set and SHA");

// A policy identity is semantic rather than object-order based. Reusing a
// receipt/evaluation identity after even a same-version policy edit is an
// explicit invalidation, never a silent pass under the new registry.
const currentIdentity = deriveCiPolicyIdentity(policy());
assert.equal(sameCiPolicyIdentity(currentIdentity, deriveCiPolicyIdentity({ ...policy(), checks: [...policy().checks].reverse() })), true);
const changedIdentity = deriveCiPolicyIdentity({ ...policy(), registration_grace_seconds: 121 });
const changedPolicy = evaluate({ policy_identity: changedIdentity });
assert.equal(changedPolicy.state, "unknown");
assert.equal(changedPolicy.invalidation.code, "ci_policy_changed");
ok(true, "a stale current-policy identity invalidates exact-SHA evaluation even when the policy version is unchanged");

// The evaluator accepts only a closed exact-SHA evidence shape. Short SHAs,
// stray authority fields, malformed rows, ambiguous latest attempts, and a
// backwards grace clock all withhold a result rather than selecting evidence.
assert.equal(evaluate({ exact_sha: "a".repeat(7) }).state, "unknown");
assert.equal(evaluate({ external_authority: "pass" }).state, "unknown");
const malformedRun = run("gates", 1);
delete malformedRun.completed_at;
assert.equal(evaluate({ check_runs: [malformedRun, run("classify", 1)] }).state, "unknown");
assert.equal(evaluate({
  check_runs: [
    run("gates", 3, "completed", "success", { id: "gates-a", started_at: "2026-08-31T00:00:00.000Z", completed_at: "2026-08-31T00:01:00.000Z" }),
    run("gates", 3, "completed", "failure", { id: "gates-b", started_at: "2026-08-31T00:00:00.000Z", completed_at: "2026-08-31T00:01:00.000Z" }),
    run("classify", 1),
  ],
}).invalidation.code, "ambiguous_exact_sha_check_runs");
assert.equal(evaluate({ now: Date.parse(FIRST) - 1 }).invalidation.code, "invalid_registration_clock");
ok(true, "malformed, ambiguous, and time-inconsistent exact-SHA evidence fails closed");

const retryable = evaluate({ check_runs: [run("gates", 1, "completed", "failure"), run("classify", 1)] });
assert.deepEqual(retryable.retry, {
  same_sha_retry_budget: 1, retry_count: 0, retry_remaining: 1, owner: "dev", retry_eligible: true, automatic: false,
});
const exhausted = evaluate({ retry_count: 1, check_runs: [run("gates", 1, "completed", "failure"), run("classify", 1)] });
assert.equal(exhausted.retry.retry_eligible, false);
assert.equal(exhausted.retry.retry_remaining, 0);
ok(true, "same-SHA retry eligibility is bounded, explicit, and never automatic");

const fullCiLessRecord = {
  record_id: "ce_0123456789abcdef0123456789abcdef",
  record_digest: "a".repeat(64),
  identity_hash: "b".repeat(64),
  identity: { policy_version: 1, exact_sha: SHA },
  observed_at: AT,
  results: [
    { key: "unit", outcome: "pass", exit_code: 0, evidence_ref: "unit:sha256:abc" },
    { key: "typecheck", outcome: "pass", exit_code: 0, evidence_ref: "typecheck:sha256:def" },
  ],
};
assert.equal(evaluateCiEvidence({ policy: ciLess, exact_sha: SHA, observed_at: AT, source_status: "ok", ci_less_evidence: fullCiLessRecord }).state, "ci_less_pass");
assert.equal(evaluateCiEvidence({ policy: ciLess, exact_sha: SHA, observed_at: AT, source_status: "ok", ci_less_evidence: { ...fullCiLessRecord, results: [{ key: "unit", outcome: "pass" }] } }).invalidation.code, "invalid_ci_less_evidence");
ok(true, "CI-less evidence accepts only one exact current key/SHA record and rejects incomplete or malformed receipts");

console.log(`\n${passed} ci-evidence policy assertions passed`);
