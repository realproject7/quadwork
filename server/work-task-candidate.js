"use strict";

// #1058 M2: local, exact WorkTask candidate capability.  This module owns
// neither a pipeline nor persistence: its only observations come from narrow,
// injected read authorities and every later mutation must consume one of the
// immutable plans produced here in a single transaction.

const crypto = require("crypto");
const { assertWorkTaskRef, workTaskKey } = require("./work-task-manifest");

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const WORKTREE_ID_RE = /^[a-z][a-z0-9_-]{2,63}$/;
const BRANCH_RE = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const RECEIPT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const RECEIPT_KINDS = new Set(["review_receipt", "validation_receipt"]);
const PUBLICATION_OPERATIONS = new Set(["push", "pull_request", "ci", "release"]);
const MAX_RECEIPTS = 128;

class WorkTaskCandidateError extends Error {
  constructor(code, message = code) { super(message); this.name = "WorkTaskCandidateError"; this.code = code; }
}

function fail(code, message) { throw new WorkTaskCandidateError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail(code, "unknown or missing field");
}
function clone(value) { return Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function safeText(value, code, max) { if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000\r\n]/.test(value)) fail(code, "text is invalid"); return value; }

function canonicalAbsolutePath(value, code) {
  if (typeof value !== "string" || value.length < 2 || value.length > 1024 || !value.startsWith("/") || value.endsWith("/") || /[\u0000\r\n]/.test(value) || value.includes("//") || value.includes("/./") || /(?:^|\/)\.\.(?:\/|$)/.test(value)) {
    fail(code, "path is not a bounded canonical absolute path");
  }
  return value;
}
function sha(value, code) { if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "exact SHA is invalid"); return value; }
function branch(value, code) { if (typeof value !== "string" || !BRANCH_RE.test(value)) fail(code, "branch is invalid"); return value; }
function worktreeRequest(value) {
  exact(value, ["repository_key", "worktree_id", "path"], "invalid_managed_worktree_request");
  if (!REPOSITORY_KEY_RE.test(value.repository_key) || !WORKTREE_ID_RE.test(value.worktree_id)) fail("invalid_managed_worktree_request", "worktree identity is invalid");
  return { repository_key: value.repository_key, worktree_id: value.worktree_id, path: canonicalAbsolutePath(value.path, "invalid_managed_worktree_request") };
}
function candidateRequest(value) {
  exact(value, ["version", "work_task_ref", "base_sha", "candidate_sha", "branch", "worktree"], "invalid_work_task_candidate_request");
  if (value.version !== VERSION) fail("invalid_work_task_candidate_request", "candidate version is invalid");
  try { assertWorkTaskRef(value.work_task_ref); } catch { fail("invalid_work_task_candidate_request", "work task reference is invalid"); }
  const worktree = worktreeRequest(value.worktree);
  if (worktree.repository_key !== value.work_task_ref.repository_key) fail("work_task_candidate_repository_mismatch", "worktree repository does not match work task");
  return {
    work_task_ref: clone(value.work_task_ref),
    base_sha: sha(value.base_sha, "invalid_work_task_candidate_request"),
    candidate_sha: sha(value.candidate_sha, "invalid_work_task_candidate_request"),
    branch: branch(value.branch, "invalid_work_task_candidate_request"),
    worktree,
  };
}
function canonicalizePath(authority, path) {
  if (typeof authority !== "function") fail("canonical_worktree_path_accessor_required", "canonical path accessor is required");
  let result;
  try { result = authority(freeze({ version: VERSION, path })); } catch { fail("canonical_worktree_path_unavailable", "canonical path accessor failed"); }
  exact(result, ["version", "canonical_path"], "canonical_worktree_path_invalid");
  if (result.version !== VERSION) fail("canonical_worktree_path_invalid", "canonical path version is invalid");
  return canonicalAbsolutePath(result.canonical_path, "canonical_worktree_path_invalid");
}
function inspectManagedWorktree(authority, request) {
  if (typeof authority !== "function") fail("managed_worktree_accessor_required", "managed worktree accessor is required");
  let result;
  try { result = authority(freeze(clone(request))); } catch { fail("managed_worktree_unavailable", "managed worktree accessor failed"); }
  exact(result, ["version", "registered", "readable", "repository_key", "worktree_id", "canonical_path", "branch", "base_sha", "head_sha", "dirty", "occupancy"], "managed_worktree_observation_invalid");
  if (result.version !== VERSION || typeof result.registered !== "boolean" || typeof result.readable !== "boolean" || typeof result.dirty !== "boolean" || !REPOSITORY_KEY_RE.test(result.repository_key) || !WORKTREE_ID_RE.test(result.worktree_id) || (result.occupancy !== "vacant" && result.occupancy !== "occupied")) {
    fail("managed_worktree_observation_invalid", "managed worktree observation is invalid");
  }
  return {
    registered: result.registered,
    readable: result.readable,
    repository_key: result.repository_key,
    worktree_id: result.worktree_id,
    canonical_path: canonicalAbsolutePath(result.canonical_path, "managed_worktree_observation_invalid"),
    branch: branch(result.branch, "managed_worktree_observation_invalid"),
    base_sha: sha(result.base_sha, "managed_worktree_observation_invalid"),
    head_sha: sha(result.head_sha, "managed_worktree_observation_invalid"),
    dirty: result.dirty,
    occupancy: result.occupancy,
  };
}
function readMigrationState(authority, identity) {
  if (typeof authority !== "function") fail("canonical_installed_state_accessor_required", "installed state accessor is required");
  let result;
  try { result = authority(freeze({ version: VERSION, installation_id: identity.installation_id, project_id: identity.project_id })); } catch { fail("canonical_installed_state_unavailable", "installed state accessor failed"); }
  exact(result, ["version", "installation_id", "project_id", "v1_state"], "canonical_installed_state_invalid");
  if (result.version !== VERSION || result.installation_id !== identity.installation_id || result.project_id !== identity.project_id || (result.v1_state !== "present" && result.v1_state !== "absent")) {
    fail("canonical_installed_state_invalid", "installed state identity is invalid");
  }
  return freeze({ source: "canonical_installed_state", v1_present: result.v1_state === "present" });
}
function publication() { return { scope: "local_worktree_only", push: false, pull_request: false, ci: false, release: false }; }
function candidatePayload(value) {
  return {
    version: VERSION,
    work_task_ref: clone(value.work_task_ref),
    base_sha: value.base_sha,
    candidate_sha: value.candidate_sha,
    branch: value.branch,
    managed_worktree: clone(value.managed_worktree),
    migration: clone(value.migration),
    publication: publication(),
  };
}
function assertPublication(value, code) {
  exact(value, ["scope", "push", "pull_request", "ci", "release"], code);
  const expected = publication();
  if (Object.keys(expected).some((key) => value[key] !== expected[key])) fail(code, "candidate publication must remain local only");
}
function assertManagedWorktree(value, reference, baseSha, candidateSha, expectedBranch, code) {
  exact(value, ["repository_key", "worktree_id", "canonical_path", "branch", "base_sha", "head_sha"], code);
  if (value.repository_key !== reference.repository_key || !WORKTREE_ID_RE.test(value.worktree_id) || value.branch !== expectedBranch || value.base_sha !== baseSha || value.head_sha !== candidateSha) fail(code, "managed worktree pin does not match candidate");
  canonicalAbsolutePath(value.canonical_path, code);
}
function assertWorkTaskCandidate(candidate) {
  exact(candidate, ["version", "candidate_digest", "work_task_ref", "base_sha", "candidate_sha", "branch", "managed_worktree", "migration", "publication"], "invalid_work_task_candidate");
  if (candidate.version !== VERSION || !SHA_RE.test(candidate.candidate_digest)) fail("invalid_work_task_candidate", "candidate identity is invalid");
  try { assertWorkTaskRef(candidate.work_task_ref); } catch { fail("invalid_work_task_candidate", "candidate work task reference is invalid"); }
  sha(candidate.base_sha, "invalid_work_task_candidate");
  sha(candidate.candidate_sha, "invalid_work_task_candidate");
  branch(candidate.branch, "invalid_work_task_candidate");
  assertManagedWorktree(candidate.managed_worktree, candidate.work_task_ref, candidate.base_sha, candidate.candidate_sha, candidate.branch, "invalid_work_task_candidate");
  exact(candidate.migration, ["source", "v1_present"], "invalid_work_task_candidate");
  if (candidate.migration.source !== "canonical_installed_state" || typeof candidate.migration.v1_present !== "boolean") fail("invalid_work_task_candidate", "candidate migration state is invalid");
  assertPublication(candidate.publication, "invalid_work_task_candidate");
  const payload = candidatePayload(candidate);
  if (candidate.candidate_digest !== hash(payload)) fail("invalid_work_task_candidate", "candidate digest mismatch");
  return candidate;
}
function workTaskCandidateKey(candidate) {
  assertWorkTaskCandidate(candidate);
  return JSON.stringify(["work-task-candidate", VERSION, workTaskKey(candidate.work_task_ref), candidate.base_sha, candidate.candidate_sha, candidate.branch, candidate.managed_worktree.worktree_id, candidate.managed_worktree.canonical_path]);
}

function buildWorkTaskCandidate(input, options = {}) {
  const requested = candidateRequest(input);
  const canonicalPath = canonicalizePath(options.canonicalizePath, requested.worktree.path);
  const observationRequest = {
    version: VERSION,
    work_task_ref: clone(requested.work_task_ref),
    expected: {
      repository_key: requested.worktree.repository_key,
      worktree_id: requested.worktree.worktree_id,
      canonical_path: canonicalPath,
      branch: requested.branch,
      base_sha: requested.base_sha,
      candidate_sha: requested.candidate_sha,
    },
  };
  const observed = inspectManagedWorktree(options.inspectManagedWorktree, observationRequest);
  if (!observed.registered) fail("managed_worktree_unregistered", "candidate worktree is not registered");
  if (!observed.readable) fail("managed_worktree_unreadable", "candidate worktree is not readable");
  if (observed.dirty) fail("managed_worktree_dirty", "candidate worktree is dirty");
  if (observed.occupancy !== "vacant") fail("managed_worktree_occupied", "candidate worktree is occupied");
  if (observed.repository_key !== requested.worktree.repository_key || observed.worktree_id !== requested.worktree.worktree_id || observed.canonical_path !== canonicalPath || observed.branch !== requested.branch) {
    fail("managed_worktree_identity_mismatch", "candidate worktree identity changed during read-back");
  }
  if (observed.base_sha !== requested.base_sha) fail("work_task_candidate_base_mismatch", "candidate base SHA changed during read-back");
  if (observed.head_sha !== requested.candidate_sha) fail("work_task_candidate_sha_mismatch", "candidate SHA is not the clean read-back HEAD");
  const migration = readMigrationState(options.readCanonicalInstalledState, requested.work_task_ref);
  const payload = candidatePayload({
    ...requested,
    managed_worktree: {
      repository_key: observed.repository_key,
      worktree_id: observed.worktree_id,
      canonical_path: observed.canonical_path,
      branch: observed.branch,
      base_sha: observed.base_sha,
      head_sha: observed.head_sha,
    },
    migration,
  });
  const candidate = freeze({ candidate_digest: hash(payload), ...payload });
  assertWorkTaskCandidate(candidate);
  return candidate;
}

function receiptPin(value) {
  exact(value, ["version", "receipt_kind", "receipt_id", "work_task_ref", "candidate_digest"], "invalid_downstream_receipt");
  if (value.version !== VERSION || !RECEIPT_KINDS.has(value.receipt_kind) || !RECEIPT_ID_RE.test(value.receipt_id) || !SHA_RE.test(value.candidate_digest)) fail("invalid_downstream_receipt", "receipt identity is invalid");
  try { assertWorkTaskRef(value.work_task_ref); } catch { fail("invalid_downstream_receipt", "receipt work task reference is invalid"); }
  return { version: VERSION, receipt_kind: value.receipt_kind, receipt_id: value.receipt_id, work_task_ref: clone(value.work_task_ref), candidate_digest: value.candidate_digest };
}
function receiptKey(receipt) { const pin = receiptPin(receipt); return JSON.stringify(["downstream-receipt", VERSION, pin.receipt_kind, pin.receipt_id, workTaskKey(pin.work_task_ref), pin.candidate_digest]); }
function candidatePrecondition(candidate) {
  return {
    candidate_digest: candidate.candidate_digest,
    work_task_ref: clone(candidate.work_task_ref),
    base_sha: candidate.base_sha,
    candidate_sha: candidate.candidate_sha,
    branch: candidate.branch,
    managed_worktree_id: candidate.managed_worktree.worktree_id,
    managed_worktree_path: candidate.managed_worktree.canonical_path,
  };
}
function assertCandidatePrecondition(value, code) {
  exact(value, ["candidate_digest", "work_task_ref", "base_sha", "candidate_sha", "branch", "managed_worktree_id", "managed_worktree_path"], code);
  if (!SHA_RE.test(value.candidate_digest) || !SHA_RE.test(value.base_sha) || !SHA_RE.test(value.candidate_sha) || !WORKTREE_ID_RE.test(value.managed_worktree_id)) fail(code, "candidate precondition identity is invalid");
  try { assertWorkTaskRef(value.work_task_ref); } catch { fail(code, "candidate precondition work task is invalid"); }
  branch(value.branch, code);
  canonicalAbsolutePath(value.managed_worktree_path, code);
  return value;
}
function assertSameCandidateReceipt(candidate, receipt) {
  if (receipt.candidate_digest !== candidate.candidate_digest || workTaskKey(receipt.work_task_ref) !== workTaskKey(candidate.work_task_ref)) {
    fail("downstream_receipt_candidate_mismatch", "receipt is not pinned to the invalidated candidate");
  }
}
function planCandidateInvalidation(input) {
  exact(input, ["version", "candidate", "receipts", "reason"], "invalid_candidate_invalidation_request");
  if (input.version !== VERSION || !Array.isArray(input.receipts) || input.receipts.length > MAX_RECEIPTS) fail("invalid_candidate_invalidation_request", "candidate invalidation request is invalid");
  assertWorkTaskCandidate(input.candidate);
  const reason = safeText(input.reason, "invalid_candidate_invalidation_request", 160);
  const receipts = input.receipts.map(receiptPin);
  if (new Set(receipts.map(receiptKey)).size !== receipts.length) fail("duplicate_downstream_receipt", "downstream receipt is duplicated");
  receipts.forEach((receipt) => assertSameCandidateReceipt(input.candidate, receipt));
  const orderedReceipts = receipts.sort((left, right) => receiptKey(left).localeCompare(receiptKey(right)));
  const precondition = candidatePrecondition(input.candidate);
  const plan = freeze({
    version: VERSION,
    transaction: "candidate_and_downstream_receipts",
    candidate_precondition: precondition,
    receipt_preconditions: orderedReceipts.map(clone),
    reason,
    events: [
      { type: "candidate_invalidated", candidate_digest: precondition.candidate_digest, work_task_ref: clone(precondition.work_task_ref) },
      ...orderedReceipts.map((receipt) => ({ type: "downstream_receipt_invalidated", receipt: clone(receipt) })),
    ],
  });
  assertCandidateInvalidationPlan(plan);
  return plan;
}
function assertCandidateInvalidationPlan(plan) {
  exact(plan, ["version", "transaction", "candidate_precondition", "receipt_preconditions", "reason", "events"], "invalid_candidate_invalidation_plan");
  if (plan.version !== VERSION || plan.transaction !== "candidate_and_downstream_receipts" || !Array.isArray(plan.receipt_preconditions) || plan.receipt_preconditions.length > MAX_RECEIPTS || !Array.isArray(plan.events) || plan.events.length !== plan.receipt_preconditions.length + 1) {
    fail("invalid_candidate_invalidation_plan", "candidate invalidation plan is invalid");
  }
  const precondition = assertCandidatePrecondition(plan.candidate_precondition, "invalid_candidate_invalidation_plan");
  safeText(plan.reason, "invalid_candidate_invalidation_plan", 160);
  const receipts = plan.receipt_preconditions.map(receiptPin);
  if (new Set(receipts.map(receiptKey)).size !== receipts.length) fail("invalid_candidate_invalidation_plan", "receipt precondition is duplicated");
  for (const receipt of receipts) {
    if (receipt.candidate_digest !== precondition.candidate_digest || workTaskKey(receipt.work_task_ref) !== workTaskKey(precondition.work_task_ref)) fail("invalid_candidate_invalidation_plan", "receipt precondition is not candidate pinned");
  }
  exact(plan.events[0], ["type", "candidate_digest", "work_task_ref"], "invalid_candidate_invalidation_plan");
  if (plan.events[0].type !== "candidate_invalidated" || plan.events[0].candidate_digest !== precondition.candidate_digest || workTaskKey(plan.events[0].work_task_ref) !== workTaskKey(precondition.work_task_ref)) fail("invalid_candidate_invalidation_plan", "candidate event is invalid");
  plan.events.slice(1).forEach((event, index) => {
    exact(event, ["type", "receipt"], "invalid_candidate_invalidation_plan");
    if (event.type !== "downstream_receipt_invalidated" || receiptKey(event.receipt) !== receiptKey(receipts[index])) fail("invalid_candidate_invalidation_plan", "receipt event is invalid");
  });
  return true;
}
function rejectTaskCandidatePublication(candidate, intent) {
  assertWorkTaskCandidate(candidate);
  exact(intent, ["version", "operation", "repository_key", "branch"], "invalid_task_candidate_publication");
  if (intent.version !== VERSION || !PUBLICATION_OPERATIONS.has(intent.operation) || !REPOSITORY_KEY_RE.test(intent.repository_key)) fail("invalid_task_candidate_publication", "candidate publication intent is invalid");
  branch(intent.branch, "invalid_task_candidate_publication");
  if (intent.repository_key === candidate.work_task_ref.repository_key && intent.branch === candidate.branch) {
    fail(`work_task_candidate_${intent.operation}_prohibited`, "local work task candidates cannot publish");
  }
  return true;
}

module.exports = {
  VERSION,
  WorkTaskCandidateError,
  assertWorkTaskCandidate,
  workTaskCandidateKey,
  buildWorkTaskCandidate,
  planCandidateInvalidation,
  assertCandidateInvalidationPlan,
  rejectTaskCandidatePublication,
};
