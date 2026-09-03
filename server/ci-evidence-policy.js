"use strict";

// #1049: pure exact-SHA CI policy/evidence evaluator.  It deliberately owns
// no configuration, persistence, GitHub read, scheduler, or delivery action.

const crypto = require("crypto");

const POLICY_VERSION = 1;
const IDENTITY_VERSION = 1;
const MODES = new Set(["github-checks", "ci-less"]);
const CHECK_KINDS = new Set(["product", "control-plane"]);
const FAILURE_CONCLUSIONS = new Set(["failure", "startup_failure", "action_required", "stale"]);
const SHA_RE = /^[a-f0-9]{40}$/;
const EVIDENCE_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CHECKS = 64;
const MAX_RUNS = 256;
const MAX_GRACE_SECONDS = 86_400;
const MAX_RETRY_BUDGET = 32;

class CiEvidencePolicyError extends Error {
  constructor(code, message = code) { super(message); this.name = "CiEvidencePolicyError"; this.code = code; }
}

function fail(code, message) { throw new CiEvidencePolicyError(code, message); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value, keys, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, "value has an unknown or missing field");
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function sha256(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function boundedInteger(value, code, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(code, `${label} is outside its safe bound`);
  return value;
}
function text(value, code, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000\r\n]/.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function canonicalSha(value) { return typeof value === "string" && SHA_RE.test(value) ? value.toLowerCase() : null; }
function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || Number.isNaN(Date.parse(value))) return null;
  try { return new Date(value).toISOString() === value ? value : null; } catch { return null; }
}

function normalizeCiPolicy(policy) {
  if (!plain(policy) || policy.version !== POLICY_VERSION || !MODES.has(policy.mode)) fail("invalid_ci_policy", "ci_policy version or mode is invalid");
  if (policy.mode === "github-checks") {
    exact(policy, ["version", "mode", "registration_grace_seconds", "same_sha_retry_budget", "checks"], "invalid_ci_policy");
    const registrationGraceSeconds = boundedInteger(policy.registration_grace_seconds, "invalid_ci_policy_registration_grace", "registration_grace_seconds", MAX_GRACE_SECONDS);
    const retryBudget = boundedInteger(policy.same_sha_retry_budget, "invalid_ci_policy_retry_budget", "same_sha_retry_budget", MAX_RETRY_BUDGET);
    if (!Array.isArray(policy.checks) || policy.checks.length === 0 || policy.checks.length > MAX_CHECKS) fail("invalid_ci_policy_checks", "github-checks requires a bounded check registry");
    const names = new Set();
    let required = 0;
    const checks = policy.checks.map((check) => {
      exact(check, ["name", "required", "kind"], "invalid_ci_policy_check");
      const name = text(check.name, "invalid_ci_policy_check_name", "check name", 200);
      if (names.has(name)) fail("duplicate_ci_policy_check_name", "check names must be exact and unique");
      names.add(name);
      if (typeof check.required !== "boolean") fail("invalid_ci_policy_check_required", "check required must be boolean");
      if (!CHECK_KINDS.has(check.kind)) fail("invalid_ci_policy_check_kind", "check kind is invalid");
      if (check.required) required += 1;
      return { name, required: check.required, kind: check.kind };
    });
    if (required === 0) fail("ci_policy_required_check_missing", "at least one check must be required");
    return freeze({ version: POLICY_VERSION, mode: "github-checks", registration_grace_seconds: registrationGraceSeconds, same_sha_retry_budget: retryBudget, checks });
  }
  exact(policy, ["version", "mode", "evidence_keys"], "invalid_ci_policy");
  if (!Array.isArray(policy.evidence_keys) || policy.evidence_keys.length === 0 || policy.evidence_keys.length > MAX_CHECKS) fail("invalid_ci_policy_evidence_keys", "ci-less requires a bounded evidence registry");
  const keys = new Set();
  const evidenceKeys = policy.evidence_keys.map((key) => {
    if (typeof key !== "string" || !EVIDENCE_KEY_RE.test(key)) fail("invalid_ci_policy_evidence_key", "evidence key is invalid");
    if (keys.has(key)) fail("duplicate_ci_policy_evidence_key", "evidence key is duplicated");
    keys.add(key);
    return key;
  });
  return freeze({ version: POLICY_VERSION, mode: "ci-less", evidence_keys: evidenceKeys });
}

function identityPayload(policy) {
  const normalized = normalizeCiPolicy(policy);
  return normalized.mode === "github-checks"
    ? { version: normalized.version, mode: normalized.mode, registration_grace_seconds: normalized.registration_grace_seconds,
      same_sha_retry_budget: normalized.same_sha_retry_budget, checks: [...normalized.checks].sort((left, right) => left.name.localeCompare(right.name)) }
    : { version: normalized.version, mode: normalized.mode, evidence_keys: [...normalized.evidence_keys].sort() };
}
function deriveCiPolicyIdentity(policy) {
  const payload = identityPayload(policy);
  return freeze({ version: IDENTITY_VERSION, policy_version: payload.version, mode: payload.mode, policy_digest: sha256(payload) });
}
function assertCiPolicyIdentity(value, code = "invalid_ci_policy_identity") {
  exact(value, ["version", "policy_version", "mode", "policy_digest"], code);
  if (value.version !== IDENTITY_VERSION || value.policy_version !== POLICY_VERSION || !MODES.has(value.mode) || typeof value.policy_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.policy_digest)) fail(code, "policy identity is invalid");
  return value;
}
function sameCiPolicyIdentity(left, right) {
  try {
    assertCiPolicyIdentity(left); assertCiPolicyIdentity(right);
    return left.version === right.version && left.policy_version === right.policy_version && left.mode === right.mode && left.policy_digest === right.policy_digest;
  } catch { return false; }
}

function checkRunId(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : (typeof value === "string" && ID_RE.test(value) ? value : null); }
function checkAttempt(run) {
  const candidate = own(run, "run_attempt") ? run.run_attempt : run.attempt;
  return Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 1_000_000 ? candidate : 0;
}

// A data-only adapter for an already fetched response. It retains only the
// strict fields required by exact-SHA evaluation; malformed rows are omitted.
function normalizeGithubCheckEvidence(response, options = {}) {
  const exactSha = canonicalSha(options.exact_sha);
  const observedAt = canonicalTimestamp(options.observed_at);
  if (!plain(response) || !Array.isArray(response.check_runs) || !exactSha || !observedAt) {
    return freeze({ exact_sha: exactSha, observed_at: observedAt, source_status: "unavailable", check_runs: [] });
  }
  const sourceStatus = options.source_status === "ok" ? "ok" : "unavailable";
  const checkRuns = [];
  for (const raw of response.check_runs.slice(0, MAX_RUNS)) {
    if (!plain(raw)) continue;
    const id = checkRunId(raw.id);
    const name = typeof raw.name === "string" && raw.name.length > 0 && raw.name.length <= 200 && raw.name === raw.name.trim() && !/[\u0000\r\n]/.test(raw.name) ? raw.name : null;
    const headSha = own(raw, "head_sha") ? canonicalSha(raw.head_sha) : exactSha;
    const status = typeof raw.status === "string" && raw.status.length > 0 && raw.status.length <= 64 ? raw.status : null;
    const conclusion = raw.conclusion === null || raw.conclusion === undefined ? null : (typeof raw.conclusion === "string" && raw.conclusion.length <= 64 ? raw.conclusion : null);
    const detailsUrl = raw.details_url === null || raw.details_url === undefined ? null : (typeof raw.details_url === "string" && raw.details_url.length <= 2048 && !/[\u0000\r\n]/.test(raw.details_url) ? raw.details_url : null);
    const startedAt = raw.started_at === null || raw.started_at === undefined ? null : canonicalTimestamp(raw.started_at);
    const completedAt = raw.completed_at === null || raw.completed_at === undefined ? null : canonicalTimestamp(raw.completed_at);
    if (!id || !name || !headSha || !status || (raw.conclusion !== null && raw.conclusion !== undefined && conclusion === null) ||
        (raw.details_url !== null && raw.details_url !== undefined && detailsUrl === null) ||
        (raw.started_at !== null && raw.started_at !== undefined && startedAt === null) ||
        (raw.completed_at !== null && raw.completed_at !== undefined && completedAt === null)) continue;
    checkRuns.push(freeze({ id, attempt: checkAttempt(raw), name, status, conclusion, details_url: detailsUrl, head_sha: headSha,
      started_at: startedAt, completed_at: completedAt, observed_at: observedAt }));
  }
  return freeze({ exact_sha: exactSha, observed_at: observedAt, source_status: sourceStatus, check_runs: checkRuns });
}

function normalizeEvaluationRun(value) {
  exact(value, ["id", "attempt", "name", "status", "conclusion", "details_url", "head_sha", "started_at", "completed_at", "observed_at"], "invalid_ci_evidence_run");
  const id = checkRunId(value.id);
  const name = typeof value.name === "string" && value.name.length > 0 && value.name.length <= 200 && value.name === value.name.trim() && !/[\u0000\r\n]/.test(value.name) ? value.name : null;
  const status = typeof value.status === "string" && value.status.length > 0 && value.status.length <= 64 ? value.status : null;
  const conclusion = value.conclusion === null || (typeof value.conclusion === "string" && value.conclusion.length <= 64) ? value.conclusion : null;
  const detailsUrl = value.details_url === null || (typeof value.details_url === "string" && value.details_url.length <= 2048 && !/[\u0000\r\n]/.test(value.details_url)) ? value.details_url : null;
  const startedAt = value.started_at === null ? null : canonicalTimestamp(value.started_at);
  const completedAt = value.completed_at === null ? null : canonicalTimestamp(value.completed_at);
  const observedAt = canonicalTimestamp(value.observed_at);
  if (!id || !name || !status || (value.conclusion !== null && conclusion === null) || (value.details_url !== null && detailsUrl === null) ||
      (value.started_at !== null && startedAt === null) || (value.completed_at !== null && completedAt === null) || !observedAt || !canonicalSha(value.head_sha)) fail("invalid_ci_evidence_run", "exact-SHA check run is invalid");
  return freeze({ id, attempt: boundedInteger(value.attempt, "invalid_ci_evidence_run", "attempt", 1_000_000), name, status, conclusion,
    details_url: detailsUrl, head_sha: canonicalSha(value.head_sha), started_at: startedAt, completed_at: completedAt, observed_at: observedAt });
}

function timeValue(value) { return value === null ? -1 : Date.parse(value); }
function rank(run) { return [run.attempt, timeValue(run.completed_at), timeValue(run.started_at)]; }
function sameRank(left, right) { return left.every((value, index) => value === right[index]); }
function selectRun(runs, name, exactSha) {
  const candidates = runs.filter((run) => run.name === name && run.head_sha === exactSha);
  if (candidates.length === 0) return { run: null, ambiguous: false };
  candidates.sort((left, right) => {
    const a = rank(left), b = rank(right);
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return left.id.localeCompare(right.id);
  });
  const selected = candidates.at(-1);
  return { run: selected, ambiguous: candidates.filter((run) => sameRank(rank(run), rank(selected))).length > 1 };
}
function runOutcome(run) {
  if (run.status.toLowerCase() !== "completed") return "pending";
  const conclusion = (run.conclusion || "").toLowerCase();
  if (conclusion === "success") return "pass";
  if (conclusion === "cancelled" || conclusion === "timed_out") return "cancelled";
  if (FAILURE_CONCLUSIONS.has(conclusion)) return "failure";
  return "not_success";
}

function retryShape(policy, state, retryCount) {
  const budget = policy?.mode === "github-checks" ? policy.same_sha_retry_budget : 0;
  const remaining = Math.max(0, budget - retryCount);
  const owner = state === "product_failure" ? "dev" : (["control_plane_failure", "cancelled", "missing_required"].includes(state) ? "head" : null);
  return freeze({ same_sha_retry_budget: budget, retry_count: retryCount, retry_remaining: remaining, owner,
    retry_eligible: state === "product_failure" && remaining > 0, automatic: false });
}
function result(policy, identity, exactSha, observedAt, state, checks, retryCount, invalidation = freeze({ state: "current" })) {
  return freeze({ state, policy_version: policy?.version || null, policy_identity: identity, exact_sha: exactSha, observed_at: observedAt,
    checks, retry: retryShape(policy, state, retryCount), invalidation });
}
function invalidResult(policy, identity, input, code) {
  return result(policy, identity, canonicalSha(input?.exact_sha), canonicalTimestamp(input?.observed_at), "unknown", [], 0, freeze({ state: "invalidated", code }));
}

function normalizeEvaluationInput(input) {
  if (!plain(input)) return null;
  const allowed = new Set(["policy", "policy_identity", "exact_sha", "observed_at", "first_observed_at", "source_status", "check_runs", "ci_less_evidence", "retry_count", "now"]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || !own(input, "exact_sha") || !own(input, "observed_at") || !own(input, "source_status") ||
      !canonicalSha(input.exact_sha) || !canonicalTimestamp(input.observed_at) || !["ok", "unavailable"].includes(input.source_status)) return null;
  if (own(input, "first_observed_at") && input.first_observed_at !== null && !canonicalTimestamp(input.first_observed_at)) return null;
  if (own(input, "retry_count") && (!Number.isSafeInteger(input.retry_count) || input.retry_count < 0 || input.retry_count > MAX_RETRY_BUDGET)) return null;
  if (own(input, "now") && (!Number.isSafeInteger(input.now) || input.now < 0)) return null;
  if (own(input, "policy_identity")) try { assertCiPolicyIdentity(input.policy_identity); } catch { return null; }
  return input;
}

function keyListEquals(actual, expected) { return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function ciLessRecord(record, policy, exactSha) {
  if (record === null || record === undefined) return { kind: "absent" };
  if (!plain(record)) return { kind: "invalid" };
  const recordKeys = Object.keys(record).sort();
  let policyVersion, recordSha, records;
  if (keyListEquals(recordKeys, ["exact_sha", "policy_version", "results"])) {
    policyVersion = record.policy_version; recordSha = canonicalSha(record.exact_sha); records = record.results;
  } else if (keyListEquals(recordKeys, ["identity", "identity_hash", "observed_at", "record_digest", "record_id", "results"]) && plain(record.identity)) {
    policyVersion = record.identity.policy_version; recordSha = canonicalSha(record.identity.exact_sha); records = record.results;
  } else return { kind: "invalid" };
  if (policyVersion !== policy.version || recordSha !== exactSha || !Array.isArray(records) || records.length !== policy.evidence_keys.length) return { kind: "invalid" };
  const outcomes = new Map();
  for (const entry of records) {
    if (!plain(entry)) return { kind: "invalid" };
    const keys = Object.keys(entry).sort();
    const small = keyListEquals(keys, ["key", "outcome"]);
    const stored = keyListEquals(keys, ["evidence_ref", "exit_code", "key", "outcome"]);
    if ((!small && !stored) || !policy.evidence_keys.includes(entry.key) || !["pass", "fail"].includes(entry.outcome) || outcomes.has(entry.key)) return { kind: "invalid" };
    if (stored && (!Number.isSafeInteger(entry.exit_code) || entry.exit_code < 0 || entry.exit_code > 255 || typeof entry.evidence_ref !== "string" || entry.evidence_ref.length === 0 || entry.evidence_ref.length > 512 || /[\u0000\r\n]/.test(entry.evidence_ref))) return { kind: "invalid" };
    outcomes.set(entry.key, entry.outcome);
  }
  return policy.evidence_keys.every((key) => outcomes.has(key)) ? { kind: "current", outcomes } : { kind: "invalid" };
}
function evaluateCiLess(policy, identity, input, exactSha, observedAt, retryCount) {
  const record = ciLessRecord(input.ci_less_evidence, policy, exactSha);
  if (record.kind === "absent") return result(policy, identity, exactSha, observedAt, "ci_less_pending", [], retryCount);
  if (record.kind === "invalid") return result(policy, identity, exactSha, observedAt, "unknown", [], retryCount, freeze({ state: "invalidated", code: "invalid_ci_less_evidence" }));
  const checks = policy.evidence_keys.map((key) => freeze({ name: key, required: true, kind: "product", state: record.outcomes.get(key), source: "ci_less_evidence" }));
  return result(policy, identity, exactSha, observedAt, checks.some((check) => check.state === "fail") ? "product_failure" : "ci_less_pass", checks, retryCount);
}

function evaluateCiEvidence(input = {}) {
  const source = normalizeEvaluationInput(input);
  if (!source) return invalidResult(null, null, input, "invalid_ci_evidence_input");
  const exactSha = canonicalSha(source.exact_sha), observedAt = canonicalTimestamp(source.observed_at);
  if (!own(source, "policy") || source.policy === null) return result(null, null, exactSha, observedAt, "missing_policy", [], 0, freeze({ state: "invalidated", code: "missing_policy" }));
  let policy;
  try { policy = normalizeCiPolicy(source.policy); } catch { return invalidResult(null, null, source, "invalid_ci_policy"); }
  const identity = deriveCiPolicyIdentity(policy);
  if (own(source, "policy_identity") && !sameCiPolicyIdentity(source.policy_identity, identity)) {
    return result(policy, identity, exactSha, observedAt, "unknown", [], 0, freeze({ state: "invalidated", code: "ci_policy_changed" }));
  }
  const retryCount = own(source, "retry_count") ? source.retry_count : 0;
  if (source.source_status !== "ok") return result(policy, identity, exactSha, observedAt, "unknown", [], retryCount, freeze({ state: "invalidated", code: "ci_evidence_unavailable" }));
  if (policy.mode === "ci-less") return evaluateCiLess(policy, identity, source, exactSha, observedAt, retryCount);
  if (!own(source, "first_observed_at") || source.first_observed_at === null || !own(source, "check_runs") || !Array.isArray(source.check_runs) || source.check_runs.length > MAX_RUNS) {
    return result(policy, identity, exactSha, observedAt, "unknown", [], retryCount, freeze({ state: "invalidated", code: "incomplete_exact_sha_evidence" }));
  }
  let runs;
  try {
    runs = source.check_runs.map(normalizeEvaluationRun);
    if (new Set(runs.map((run) => run.id)).size !== runs.length) fail("invalid_ci_evidence_run", "check run IDs are ambiguous");
  } catch {
    return result(policy, identity, exactSha, observedAt, "unknown", [], retryCount, freeze({ state: "invalidated", code: "invalid_exact_sha_evidence" }));
  }
  const now = own(source, "now") ? source.now : Date.parse(observedAt);
  const elapsed = now - Date.parse(source.first_observed_at);
  if (elapsed < 0) return result(policy, identity, exactSha, observedAt, "unknown", [], retryCount, freeze({ state: "invalidated", code: "invalid_registration_clock" }));
  const withinGrace = elapsed <= policy.registration_grace_seconds * 1000;
  let ambiguous = false;
  const configured = new Set(policy.checks.map((check) => check.name));
  const checks = policy.checks.map((check) => {
    const selected = selectRun(runs, check.name, exactSha);
    ambiguous ||= selected.ambiguous;
    if (!selected.run) return freeze({ name: check.name, required: check.required, kind: check.kind, state: check.required ? (withinGrace ? "pending_registration" : "missing_required") : "missing_advisory", run: null });
    const run = selected.run;
    return freeze({ name: check.name, required: check.required, kind: check.kind, state: runOutcome(run), run: freeze({ id: run.id, attempt: run.attempt, status: run.status, conclusion: run.conclusion, details_url: run.details_url, head_sha: run.head_sha, observed_at: run.observed_at }) });
  });
  if (ambiguous) return result(policy, identity, exactSha, observedAt, "unknown", checks, retryCount, freeze({ state: "invalidated", code: "ambiguous_exact_sha_check_runs" }));
  const advisory = runs.filter((run) => run.head_sha === exactSha && !configured.has(run.name)).map((run) => freeze({ name: run.name, id: run.id, attempt: run.attempt, state: runOutcome(run), required: false, kind: "advisory", unregistered: true }));
  const required = checks.filter((check) => check.required);
  let state = "pass";
  if (required.some((check) => check.state === "failure" && check.kind === "product")) state = "product_failure";
  else if (required.some((check) => check.state === "failure" && check.kind === "control-plane")) state = "control_plane_failure";
  else if (required.some((check) => check.state === "cancelled")) state = "cancelled";
  else if (required.some((check) => ["missing_required", "not_success"].includes(check.state))) state = "missing_required";
  else if (required.some((check) => ["pending", "pending_registration"].includes(check.state))) state = "pending";
  return result(policy, identity, exactSha, observedAt, state, [...checks, ...advisory], retryCount);
}

function redactedCiPolicy(policy) {
  if (policy === null || policy === undefined) return freeze({ state: "missing_policy" });
  const normalized = normalizeCiPolicy(policy);
  return normalized.mode === "github-checks"
    ? freeze({ version: normalized.version, mode: normalized.mode, registration_grace_seconds: normalized.registration_grace_seconds, same_sha_retry_budget: normalized.same_sha_retry_budget, checks: normalized.checks, policy_identity: deriveCiPolicyIdentity(normalized) })
    : freeze({ version: normalized.version, mode: normalized.mode, evidence_keys: normalized.evidence_keys, policy_identity: deriveCiPolicyIdentity(normalized) });
}

function ciEvidenceRecordDigest(value) { return sha256(value); }

module.exports = {
  POLICY_VERSION,
  CiEvidencePolicyError,
  normalizeCiPolicy,
  deriveCiPolicyIdentity,
  assertCiPolicyIdentity,
  sameCiPolicyIdentity,
  normalizeGithubCheckEvidence,
  evaluateCiEvidence,
  redactedCiPolicy,
  canonicalSha,
  ciEvidenceRecordDigest,
};
