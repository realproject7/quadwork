"use strict";

// The CI policy is deliberately data-only.  This module has no filesystem,
// process, or GitHub dependency: #1036 supplies live observations and #1048
// consumes the typed result.  Keeping the evaluator pure prevents a configured
// label from ever becoming an executable instruction.

const crypto = require("crypto");

const POLICY_VERSION = 1;
const MODES = new Set(["github-checks", "ci-less"]);
const CHECK_KINDS = new Set(["product", "control-plane"]);
const SUCCESS_CONCLUSION = "success";
const EVIDENCE_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{7,128}$/i;

class CiEvidencePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CiEvidencePolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CiEvidencePolicyError(code, message);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "CI policy value must be an object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, "CI policy contains an unknown or missing authority field");
  }
}

function nonnegativeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${label} must be a safe nonnegative integer`);
  return value;
}

function exactName(value, code, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value !== value.trim()) {
    fail(code, `${label} must be a nonempty exact name`);
  }
  return value;
}

/**
 * Strict, non-mutating policy normalizer.  Absence is intentionally handled by
 * the caller: it remains an explicit missing_policy state rather than being
 * guessed from visible GitHub checks.
 */
function normalizeCiPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("invalid_ci_policy", "ci_policy must be an object");
  }
  if (policy.version !== POLICY_VERSION || !MODES.has(policy.mode)) {
    fail("invalid_ci_policy", "ci_policy version or mode is invalid");
  }

  if (policy.mode === "github-checks") {
    exactKeys(policy, ["version", "mode", "registration_grace_seconds", "same_sha_retry_budget", "checks"], "invalid_ci_policy");
    const registrationGraceSeconds = nonnegativeInteger(
      policy.registration_grace_seconds,
      "invalid_ci_policy_registration_grace",
      "registration_grace_seconds",
    );
    const retryBudget = nonnegativeInteger(
      policy.same_sha_retry_budget,
      "invalid_ci_policy_retry_budget",
      "same_sha_retry_budget",
    );
    if (!Array.isArray(policy.checks) || policy.checks.length === 0) {
      fail("invalid_ci_policy_checks", "github-checks policy must contain checks");
    }
    const names = new Set();
    let required = 0;
    const checks = policy.checks.map((check) => {
      exactKeys(check, ["name", "required", "kind"], "invalid_ci_policy_check");
      const name = exactName(check.name, "invalid_ci_policy_check_name", "check name");
      if (names.has(name)) fail("duplicate_ci_policy_check_name", "ci_policy check names must be unique and case-sensitive");
      names.add(name);
      if (typeof check.required !== "boolean") fail("invalid_ci_policy_check_required", "check required must be boolean");
      if (!CHECK_KINDS.has(check.kind)) fail("invalid_ci_policy_check_kind", "check kind must be product or control-plane");
      if (check.required) required += 1;
      return Object.freeze({ name, required: check.required, kind: check.kind });
    });
    if (required === 0) fail("ci_policy_required_check_missing", "github-checks policy requires at least one required check");
    return Object.freeze({
      version: POLICY_VERSION,
      mode: "github-checks",
      registration_grace_seconds: registrationGraceSeconds,
      same_sha_retry_budget: retryBudget,
      checks: Object.freeze(checks),
    });
  }

  exactKeys(policy, ["version", "mode", "evidence_keys"], "invalid_ci_policy");
  if (!Array.isArray(policy.evidence_keys) || policy.evidence_keys.length === 0) {
    fail("invalid_ci_policy_evidence_keys", "ci-less policy requires evidence_keys");
  }
  const keys = new Set();
  const evidenceKeys = policy.evidence_keys.map((key) => {
    if (typeof key !== "string" || !EVIDENCE_KEY_RE.test(key)) {
      fail("invalid_ci_policy_evidence_key", "evidence key must be a bounded data identifier");
    }
    if (keys.has(key)) fail("duplicate_ci_policy_evidence_key", "ci-less evidence keys must be unique");
    keys.add(key);
    return key;
  });
  return Object.freeze({ version: POLICY_VERSION, mode: "ci-less", evidence_keys: Object.freeze(evidenceKeys) });
}

function canonicalSha(value) {
  return typeof value === "string" && SHA_RE.test(value) ? value.toLowerCase() : null;
}

function canonicalTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function checkRunId(value) {
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function checkAttempt(run) {
  for (const value of [run?.run_attempt, run?.attempt]) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return 0;
}

/**
 * Preserve the check-level evidence required for an exact-name registry.  The
 * old scalar `statusCheckRollup` remains a UI compatibility projection only;
 * combined statuses and workflow conclusions are deliberately excluded here.
 */
function normalizeGithubCheckEvidence(response, options = {}) {
  const exactSha = canonicalSha(options.exact_sha);
  const observedAt = canonicalTimestamp(options.observed_at);
  const sourceStatus = options.source_status === "ok" ? "ok" : "unavailable";
  const rawRuns = Array.isArray(response?.check_runs) ? response.check_runs : [];
  const checkRuns = rawRuns.map((run) => {
    if (!run || typeof run !== "object" || Array.isArray(run)) return null;
    const id = checkRunId(run.id);
    const name = typeof run.name === "string" && run.name.length > 0 && run.name.length <= 200 ? run.name : null;
    const headSha = canonicalSha(run.head_sha) || exactSha;
    if (!id || !name || !headSha) return null;
    return Object.freeze({
      id,
      attempt: checkAttempt(run),
      name,
      status: typeof run.status === "string" ? run.status : null,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      details_url: typeof run.details_url === "string" ? run.details_url : null,
      head_sha: headSha,
      started_at: canonicalTimestamp(run.started_at),
      completed_at: canonicalTimestamp(run.completed_at),
      observed_at: observedAt,
    });
  }).filter(Boolean);
  return Object.freeze({
    exact_sha: exactSha,
    observed_at: observedAt,
    source_status: sourceStatus,
    check_runs: Object.freeze(checkRuns),
  });
}

function timeValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? -1 : parsed;
}

function laterAttempt(left, right) {
  if (left.attempt !== right.attempt) return left.attempt - right.attempt;
  const completed = timeValue(left.completed_at) - timeValue(right.completed_at);
  if (completed !== 0) return completed;
  const started = timeValue(left.started_at) - timeValue(right.started_at);
  if (started !== 0) return started;
  return String(left.id).localeCompare(String(right.id));
}

function selectedRun(runs, name, exactSha) {
  const candidates = runs.filter((run) => run.name === name && run.head_sha === exactSha);
  if (candidates.length === 0) return null;
  return candidates.slice().sort(laterAttempt).at(-1);
}

function runOutcome(run) {
  if (!run || String(run.status || "").toLowerCase() !== "completed") return "pending";
  const conclusion = String(run.conclusion || "").toLowerCase();
  if (conclusion === SUCCESS_CONCLUSION) return "pass";
  if (conclusion === "cancelled" || conclusion === "timed_out") return "cancelled";
  if (["failure", "startup_failure", "action_required", "stale"].includes(conclusion)) return "failure";
  // GitHub's neutral/skipped/SKIPPING conclusions are deliberately not success
  // and not a product failure.  They leave a required gate non-passing.
  return "not_success";
}

function retryShape(policy, state, retryCount) {
  const budget = policy.mode === "github-checks" ? policy.same_sha_retry_budget : 0;
  const used = Number.isSafeInteger(retryCount) && retryCount >= 0 ? retryCount : 0;
  const owner = state === "product_failure"
    ? "dev"
    : (["control_plane_failure", "cancelled", "missing_required"].includes(state) ? "head" : null);
  return Object.freeze({
    same_sha_retry_budget: budget,
    retry_count: used,
    retry_remaining: Math.max(0, budget - used),
    owner,
    automatic: false,
  });
}

function evaluationBase(policy, exactSha, observedAt, state, checks, retryCount) {
  return Object.freeze({
    state,
    policy_version: policy?.version || null,
    exact_sha: exactSha,
    observed_at: observedAt,
    checks: Object.freeze(checks),
    retry: policy ? retryShape(policy, state, retryCount) : Object.freeze({ same_sha_retry_budget: 0, retry_count: 0, retry_remaining: 0, owner: "head", automatic: false }),
  });
}

function ciLessEvaluation(policy, input, exactSha, observedAt) {
  const record = input?.ci_less_evidence;
  if (!record || typeof record !== "object" || record.policy_version !== policy.version ||
      canonicalSha(record.exact_sha) !== exactSha || !Array.isArray(record.results)) {
    return evaluationBase(policy, exactSha, observedAt, "ci_less_pending", [], input?.retry_count);
  }
  const results = new Map();
  for (const result of record.results) {
    if (!result || typeof result !== "object" || typeof result.key !== "string" ||
        !["pass", "fail"].includes(result.outcome) || results.has(result.key)) {
      return evaluationBase(policy, exactSha, observedAt, "ci_less_pending", [], input?.retry_count);
    }
    results.set(result.key, result.outcome);
  }
  const keys = policy.evidence_keys;
  if (results.size !== keys.length || keys.some((key) => !results.has(key))) {
    return evaluationBase(policy, exactSha, observedAt, "ci_less_pending", [], input?.retry_count);
  }
  const checks = keys.map((key) => Object.freeze({ name: key, required: true, kind: "product", state: results.get(key), source: "ci_less_evidence" }));
  const state = checks.some((check) => check.state === "fail") ? "product_failure" : "ci_less_pass";
  return evaluationBase(policy, exactSha, observedAt, state, checks, input?.retry_count);
}

/**
 * Evaluate one repository policy against exactly one SHA.  Callers must keep
 * first_observed_at durably for a SHA/policy identity; without it the bounded
 * registration grace cannot safely survive a restart, so this fails closed.
 */
function evaluateCiEvidence(input = {}) {
  let policy;
  if (input.policy === null || input.policy === undefined) {
    return evaluationBase(null, canonicalSha(input.exact_sha), canonicalTimestamp(input.observed_at), "missing_policy", [], 0);
  }
  try {
    policy = normalizeCiPolicy(input.policy);
  } catch {
    return evaluationBase(null, canonicalSha(input.exact_sha), canonicalTimestamp(input.observed_at), "unknown", [], 0);
  }
  const exactSha = canonicalSha(input.exact_sha);
  const observedAt = canonicalTimestamp(input.observed_at);
  if (!exactSha || !observedAt || input.source_status !== "ok") {
    return evaluationBase(policy, exactSha, observedAt, "unknown", [], input.retry_count);
  }
  if (policy.mode === "ci-less") return ciLessEvaluation(policy, input, exactSha, observedAt);

  const firstObservedAt = canonicalTimestamp(input.first_observed_at);
  if (!firstObservedAt) return evaluationBase(policy, exactSha, observedAt, "unknown", [], input.retry_count);
  const runs = Array.isArray(input.check_runs) ? input.check_runs : [];
  const now = Number.isFinite(input.now) ? input.now : Date.parse(observedAt);
  const elapsed = now - Date.parse(firstObservedAt);
  const withinGrace = elapsed >= 0 && elapsed <= policy.registration_grace_seconds * 1000;
  const configured = new Set(policy.checks.map((check) => check.name));
  const checks = policy.checks.map((check) => {
    const run = selectedRun(runs, check.name, exactSha);
    if (!run) return Object.freeze({
      name: check.name,
      required: check.required,
      kind: check.kind,
      state: check.required ? (withinGrace ? "pending_registration" : "missing_required") : "missing_advisory",
      run: null,
    });
    return Object.freeze({
      name: check.name,
      required: check.required,
      kind: check.kind,
      state: runOutcome(run),
      run: Object.freeze({
        id: run.id,
        attempt: run.attempt,
        status: run.status,
        conclusion: run.conclusion,
        details_url: run.details_url,
        head_sha: run.head_sha,
        observed_at: run.observed_at || observedAt,
      }),
    });
  });
  const unregistered = runs
    .filter((run) => run?.head_sha === exactSha && !configured.has(run.name))
    .map((run) => Object.freeze({ name: run.name, id: run.id, attempt: run.attempt, state: runOutcome(run) }));
  const evidence = [...checks, ...unregistered.map((run) => Object.freeze({ ...run, required: false, kind: "advisory", unregistered: true }))];
  const required = checks.filter((check) => check.required);
  let state = "pass";
  if (required.some((check) => check.state === "failure" && check.kind === "product")) state = "product_failure";
  else if (required.some((check) => check.state === "failure" && check.kind === "control-plane")) state = "control_plane_failure";
  else if (required.some((check) => check.state === "cancelled")) state = "cancelled";
  else if (required.some((check) => check.state === "missing_required")) state = "missing_required";
  else if (required.some((check) => ["pending", "pending_registration", "not_success"].includes(check.state))) state = "pending";
  return evaluationBase(policy, exactSha, observedAt, state, evidence, input.retry_count);
}

function redactedCiPolicy(policy) {
  if (!policy) return Object.freeze({ state: "missing_policy" });
  const normalized = normalizeCiPolicy(policy);
  return normalized.mode === "github-checks"
    ? Object.freeze({ version: normalized.version, mode: normalized.mode, registration_grace_seconds: normalized.registration_grace_seconds, same_sha_retry_budget: normalized.same_sha_retry_budget, checks: normalized.checks })
    : Object.freeze({ version: normalized.version, mode: normalized.mode, evidence_keys: normalized.evidence_keys });
}

function ciEvidenceRecordDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

module.exports = {
  POLICY_VERSION,
  CiEvidencePolicyError,
  normalizeCiPolicy,
  normalizeGithubCheckEvidence,
  evaluateCiEvidence,
  redactedCiPolicy,
  canonicalSha,
  ciEvidenceRecordDigest,
};
