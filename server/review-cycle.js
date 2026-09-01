"use strict";

// Durable, deliberately narrow foundation for #1048's exact-SHA review
// cycle.  This module does not fetch GitHub, send chat, inspect routes, or
// infer authority from prose.  Integrations provide already server-validated
// legacy target facts and use the returned correlation records with their
// trusted transport.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertWorkItemRef } = require("./work-item-ref");
const { canonicalSha, normalizeCiPolicy } = require("./ci-evidence-policy");

const REVIEW_CYCLE_STORE_VERSION = 1;
const REVIEW_CYCLE_FILENAME = "review-cycles.json";
const LEGACY_REVIEW_TARGET_KIND = "legacy_work_item_pr";

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ASSIGNMENT_ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTRACT_REVISION_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CYCLE_ID_RE = /^rc_[a-f0-9]{32}$/;
const CORRELATION_ID_RE = /^rc_evt_[a-f0-9]{40}$/;
const REVIEW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const READINESS_STATES = new Set(["draft_or_not_ready", "contract_changed", "ready"]);
const CI_STATES = new Set([
  "unknown",
  "pending",
  "pass",
  "product_failure",
  "control_plane_failure",
  "cancelled",
  "missing_required",
  "missing_policy",
  "ci_less_pending",
  "ci_less_pass",
]);
const REVIEW_STATES = new Set(["not_dispatched", "0/2", "1/2", "2/2", "changes_requested"]);
const CYCLE_STATES = new Set(["current", "invalidated", "terminal"]);
const EVENT_KINDS = new Set(["review_request", "head_gate_due", "contract_changed"]);
const REVIEWER_ROLES = new Set(["re1", "re2"]);
const VERDICTS = new Set(["approved", "changes_requested"]);
const DISPATCHABLE_CI_STATES = new Set(["pending", "pass", "ci_less_pending", "ci_less_pass"]);
const HEAD_GATE_CI_STATES = new Set(["pass", "ci_less_pass"]);

class ReviewCycleError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ReviewCycleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReviewCycleError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, code) {
  if (!isPlainObject(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function canonicalRepository(repo) {
  return typeof repo === "string" && REPOSITORY_RE.test(repo) ? repo.toLowerCase() : null;
}

function validProjectId(projectId) {
  return typeof projectId === "string" && PROJECT_ID_RE.test(projectId) ? projectId : null;
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) return null;
  try { return new Date(value).toISOString(); } catch { return null; }
}

function clockIso(now) {
  let timestamp = null;
  try {
    const value = now();
    timestamp = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  } catch {}
  if (!timestamp) fail("review_cycle_clock_invalid", "review-cycle clock did not return a valid timestamp");
  return timestamp;
}

function reviewId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && REVIEW_ID_RE.test(value) ? value : null;
}

function targetDigestIdentity(identity) {
  return {
    version: identity.version,
    target_kind: identity.target_kind,
    installation_id: identity.installation_id,
    project_id: identity.project_id,
    repo_key: identity.repo_key,
    repo: canonicalRepository(identity.repo),
    work_item: {
      repo_key: identity.work_item.repo_key,
      repo: canonicalRepository(identity.work_item.repo),
      number: identity.work_item.number,
      kind: identity.work_item.kind,
    },
    pr_number: identity.pr_number,
    exact_sha: identity.exact_sha,
    contract_revision: identity.contract_revision,
    policy_version: identity.policy_version,
    policy_digest: identity.policy_digest,
    assignment_attempt: identity.assignment_attempt,
  };
}

function slotDigestIdentity(identity) {
  return {
    version: identity.version,
    target_kind: identity.target_kind,
    installation_id: identity.installation_id,
    project_id: identity.project_id,
    repo_key: identity.repo_key,
    repo: canonicalRepository(identity.repo),
    work_item: {
      repo_key: identity.work_item.repo_key,
      repo: canonicalRepository(identity.work_item.repo),
      number: identity.work_item.number,
      kind: identity.work_item.kind,
    },
    pr_number: identity.pr_number,
  };
}

function targetIdentityDigest(identity) {
  return sha256(targetDigestIdentity(identity));
}

function targetSlotDigest(identity) {
  return sha256(slotDigestIdentity(identity));
}

function assertTargetIdentity(identity, code = "invalid_review_cycle_target") {
  exactKeys(identity, [
    "version",
    "target_kind",
    "installation_id",
    "project_id",
    "repo_key",
    "repo",
    "work_item",
    "pr_number",
    "exact_sha",
    "contract_revision",
    "policy_version",
    "policy_digest",
    "assignment_attempt",
  ], code);
  if (identity.version !== 1 || identity.target_kind !== LEGACY_REVIEW_TARGET_KIND) {
    fail("unknown_review_cycle_target_kind", "only the registered legacy review target kind is accepted");
  }
  if (!INSTALLATION_ID_RE.test(identity.installation_id) || !validProjectId(identity.project_id) ||
      !REPOSITORY_KEY_RE.test(identity.repo_key) || !canonicalRepository(identity.repo) ||
      !Number.isSafeInteger(identity.pr_number) || identity.pr_number < 1 ||
      !canonicalSha(identity.exact_sha) || !CONTRACT_REVISION_RE.test(identity.contract_revision) ||
      !ASSIGNMENT_ATTEMPT_RE.test(identity.assignment_attempt)) {
    fail(code, "legacy review target identity is invalid");
  }
  if (!(identity.policy_version === null || (Number.isSafeInteger(identity.policy_version) && identity.policy_version >= 1)) ||
      !(identity.policy_digest === null || DIGEST_RE.test(identity.policy_digest))) {
    fail(code, "legacy review target policy identity is invalid");
  }
  if ((identity.policy_version === null) !== (identity.policy_digest === null)) {
    fail(code, "legacy review target policy fields must be present together");
  }
  try { assertWorkItemRef(identity.work_item); } catch { fail(code, "legacy review target item is invalid"); }
  if (identity.work_item.kind !== "issue" || identity.work_item.repoKey !== identity.repo_key ||
      canonicalRepository(identity.work_item.repo) !== canonicalRepository(identity.repo)) {
    fail(code, "legacy review target item does not match the registered repository");
  }
  return identity;
}

/**
 * Convert one server-derived V1 issue/PR observation into the only target kind
 * #1048 initially understands.  The exact input shapes intentionally reject
 * arbitrary target kinds, body text, finding text, and caller-supplied hashes.
 */
function deriveLegacyReviewTarget(source) {
  exactKeys(source, [
    "installation_id",
    "project_id",
    "repository",
    "work_item",
    "pr",
    "issue_contract",
    "assignment_attempt",
  ], "invalid_review_cycle_source");
  exactKeys(source.repository, ["key", "repo", "ci_policy"], "invalid_review_cycle_source");
  exactKeys(source.pr, ["number", "exact_sha", "draft", "mergeable"], "invalid_review_cycle_source");
  exactKeys(source.issue_contract, ["contract_revision"], "invalid_review_cycle_source");

  if (!INSTALLATION_ID_RE.test(source.installation_id) || !validProjectId(source.project_id) ||
      !REPOSITORY_KEY_RE.test(source.repository.key) || !canonicalRepository(source.repository.repo) ||
      !ASSIGNMENT_ATTEMPT_RE.test(source.assignment_attempt) ||
      !Number.isSafeInteger(source.pr.number) || source.pr.number < 1 ||
      !canonicalSha(source.pr.exact_sha) || typeof source.pr.draft !== "boolean" ||
      typeof source.pr.mergeable !== "boolean" || !CONTRACT_REVISION_RE.test(source.issue_contract.contract_revision)) {
    fail("invalid_review_cycle_source", "server-derived legacy review source is invalid");
  }

  try { assertWorkItemRef(source.work_item); } catch { fail("invalid_review_cycle_source", "server-derived work item is invalid"); }
  if (source.work_item.kind !== "issue" || source.work_item.repoKey !== source.repository.key ||
      canonicalRepository(source.work_item.repo) !== canonicalRepository(source.repository.repo)) {
    fail("invalid_review_cycle_source", "server-derived work item does not match its repository");
  }

  let policy = null;
  if (source.repository.ci_policy !== null) {
    try { policy = normalizeCiPolicy(source.repository.ci_policy); }
    catch { fail("invalid_review_cycle_policy", "registered CI policy is invalid"); }
  }
  const identity = {
    version: 1,
    target_kind: LEGACY_REVIEW_TARGET_KIND,
    installation_id: source.installation_id,
    project_id: source.project_id,
    repo_key: source.repository.key,
    repo: source.repository.repo,
    work_item: {
      repoKey: source.repository.key,
      repo: source.repository.repo,
      number: source.work_item.number,
      kind: "issue",
    },
    pr_number: source.pr.number,
    exact_sha: canonicalSha(source.pr.exact_sha),
    contract_revision: source.issue_contract.contract_revision,
    policy_version: policy ? policy.version : null,
    policy_digest: policy ? sha256(policy) : null,
    assignment_attempt: source.assignment_attempt,
  };
  assertTargetIdentity(identity, "invalid_review_cycle_source");
  return deepFreeze({
    version: 1,
    target_kind: LEGACY_REVIEW_TARGET_KIND,
    identity,
    target_identity_digest: targetIdentityDigest(identity),
    slot_digest: targetSlotDigest(identity),
    observed: {
      draft: source.pr.draft,
      mergeable: source.pr.mergeable,
    },
  });
}

function assertDerivedTarget(target) {
  exactKeys(target, ["version", "target_kind", "identity", "target_identity_digest", "slot_digest", "observed"], "invalid_review_cycle_target");
  if (target.version !== 1 || target.target_kind !== LEGACY_REVIEW_TARGET_KIND || !DIGEST_RE.test(target.target_identity_digest) ||
      !DIGEST_RE.test(target.slot_digest)) {
    fail("invalid_review_cycle_target", "review target envelope is invalid");
  }
  assertTargetIdentity(target.identity);
  exactKeys(target.observed, ["draft", "mergeable"], "invalid_review_cycle_target");
  if (typeof target.observed.draft !== "boolean" || typeof target.observed.mergeable !== "boolean" ||
      target.target_identity_digest !== targetIdentityDigest(target.identity) ||
      target.slot_digest !== targetSlotDigest(target.identity)) {
    fail("invalid_review_cycle_target", "review target digest or observation is invalid");
  }
  return target;
}

function eventCorrelation(cycleId, kind) {
  if (!CYCLE_ID_RE.test(cycleId) || !EVENT_KINDS.has(kind)) fail("invalid_review_cycle_event", "review-cycle event is invalid");
  return `rc_evt_${crypto.createHash("sha256").update(`${cycleId}:${kind}`, "utf8").digest("hex").slice(0, 40)}`;
}

function reviewState(cycle) {
  const receipts = Object.values(cycle.receipts).filter(Boolean);
  if (!cycle.events.review_request) return "not_dispatched";
  if (receipts.some((receipt) => receipt.verdict === "changes_requested")) return "changes_requested";
  if (receipts.length === 0) return "0/2";
  if (receipts.length === 1) return "1/2";
  return "2/2";
}

function headGateDue(cycle) {
  return cycle.state === "current" && cycle.readiness === "ready" &&
    HEAD_GATE_CI_STATES.has(cycle.ci_state) && reviewState(cycle) === "2/2" && cycle.mergeable === true;
}

function safeCycleSnapshot(cycle) {
  const result = clone(cycle);
  result.review_state = reviewState(cycle);
  result.head_gate_due = headGateDue(cycle);
  return deepFreeze(result);
}

function emptyDocument() {
  return { version: REVIEW_CYCLE_STORE_VERSION, cycles: {}, slots: {} };
}

function eventRecord(value, cycleId, kind) {
  if (value === null) return null;
  exactKeys(value, ["correlation_id", "created_at"], "review_cycle_store_invalid");
  if (value.correlation_id !== eventCorrelation(cycleId, kind) || !validIsoTimestamp(value.created_at)) {
    fail("review_cycle_store_invalid", "review-cycle event record is invalid");
  }
  return { correlation_id: value.correlation_id, created_at: validIsoTimestamp(value.created_at) };
}

function normalizedReceipt(value, role, digest) {
  if (value === null) return null;
  exactKeys(value, ["reviewer_role", "review_id", "verdict", "submitted_at", "target_identity_digest"], "review_cycle_store_invalid");
  const normalizedReviewId = reviewId(value.review_id);
  const submittedAt = validIsoTimestamp(value.submitted_at);
  if (value.reviewer_role !== role || !normalizedReviewId || !VERDICTS.has(value.verdict) ||
      !submittedAt || value.target_identity_digest !== digest) {
    fail("review_cycle_store_invalid", "review-cycle receipt is invalid");
  }
  return {
    reviewer_role: role,
    review_id: normalizedReviewId,
    verdict: value.verdict,
    submitted_at: submittedAt,
    target_identity_digest: digest,
  };
}

function normalizeCycle(value, expectedId) {
  exactKeys(value, [
    "version",
    "cycle_id",
    "slot_digest",
    "target",
    "target_identity_digest",
    "readiness",
    "ci_state",
    "mergeable",
    "state",
    "invalidation",
    "events",
    "receipts",
    "created_at",
    "updated_at",
  ], "review_cycle_store_invalid");
  if (value.version !== 1 || value.cycle_id !== expectedId || !CYCLE_ID_RE.test(value.cycle_id) ||
      !DIGEST_RE.test(value.slot_digest) || !DIGEST_RE.test(value.target_identity_digest) ||
      !READINESS_STATES.has(value.readiness) || !CI_STATES.has(value.ci_state) ||
      typeof value.mergeable !== "boolean" || !CYCLE_STATES.has(value.state) ||
      !validIsoTimestamp(value.created_at) || !validIsoTimestamp(value.updated_at)) {
    fail("review_cycle_store_invalid", "review-cycle record is invalid");
  }
  assertTargetIdentity(value.target, "review_cycle_store_invalid");
  if (value.target_identity_digest !== targetIdentityDigest(value.target) || value.slot_digest !== targetSlotDigest(value.target)) {
    fail("review_cycle_store_invalid", "review-cycle target digest is invalid");
  }
  exactKeys(value.events, ["review_request", "head_gate_due", "contract_changed"], "review_cycle_store_invalid");
  exactKeys(value.receipts, ["re1", "re2"], "review_cycle_store_invalid");
  let invalidation = null;
  if (value.invalidation !== null) {
    exactKeys(value.invalidation, ["reasons", "at"], "review_cycle_store_invalid");
    if (!Array.isArray(value.invalidation.reasons) || value.invalidation.reasons.length === 0 ||
        value.invalidation.reasons.length > 4 || !validIsoTimestamp(value.invalidation.at)) {
      fail("review_cycle_store_invalid", "review-cycle invalidation is invalid");
    }
    const allowed = new Set(["exact_sha_changed", "contract_changed", "policy_changed", "assignment_changed"]);
    const reasons = [...new Set(value.invalidation.reasons)];
    if (reasons.length !== value.invalidation.reasons.length || reasons.some((reason) => !allowed.has(reason))) {
      fail("review_cycle_store_invalid", "review-cycle invalidation reason is invalid");
    }
    invalidation = { reasons, at: validIsoTimestamp(value.invalidation.at) };
  }
  if (value.state === "current" && invalidation !== null) fail("review_cycle_store_invalid", "current review cycle cannot be invalidated");
  if (value.state !== "current" && invalidation === null && value.state !== "terminal") {
    fail("review_cycle_store_invalid", "invalidated review cycle requires a reason");
  }
  return {
    version: 1,
    cycle_id: value.cycle_id,
    slot_digest: value.slot_digest,
    target: clone(value.target),
    target_identity_digest: value.target_identity_digest,
    readiness: value.readiness,
    ci_state: value.ci_state,
    mergeable: value.mergeable,
    state: value.state,
    invalidation,
    events: {
      review_request: eventRecord(value.events.review_request, value.cycle_id, "review_request"),
      head_gate_due: eventRecord(value.events.head_gate_due, value.cycle_id, "head_gate_due"),
      contract_changed: eventRecord(value.events.contract_changed, value.cycle_id, "contract_changed"),
    },
    receipts: {
      re1: normalizedReceipt(value.receipts.re1, "re1", value.target_identity_digest),
      re2: normalizedReceipt(value.receipts.re2, "re2", value.target_identity_digest),
    },
    created_at: validIsoTimestamp(value.created_at),
    updated_at: validIsoTimestamp(value.updated_at),
  };
}

function normalizeDocument(value) {
  exactKeys(value, ["version", "cycles", "slots"], "review_cycle_store_invalid");
  if (value.version !== REVIEW_CYCLE_STORE_VERSION || !isPlainObject(value.cycles) || !isPlainObject(value.slots)) {
    fail("review_cycle_store_invalid", "review-cycle document is invalid");
  }
  const cycleEntries = Object.entries(value.cycles);
  if (cycleEntries.length > 128 || Object.keys(value.slots).length > 128) {
    fail("review_cycle_store_invalid", "review-cycle document exceeds the bounded retention limit");
  }
  const cycles = {};
  const usedReviewIds = new Map();
  for (const [cycleId, rawCycle] of cycleEntries) {
    if (!CYCLE_ID_RE.test(cycleId)) fail("review_cycle_store_invalid", "review-cycle identifier is invalid");
    const cycle = normalizeCycle(rawCycle, cycleId);
    for (const receipt of Object.values(cycle.receipts)) {
      if (!receipt) continue;
      if (usedReviewIds.has(receipt.review_id)) {
        fail("review_cycle_store_invalid", "review ID is bound to multiple reviewer receipts");
      }
      usedReviewIds.set(receipt.review_id, cycleId);
    }
    cycles[cycleId] = cycle;
  }
  const slots = {};
  for (const [slot, cycleId] of Object.entries(value.slots)) {
    if (!DIGEST_RE.test(slot) || !CYCLE_ID_RE.test(cycleId) || !cycles[cycleId] ||
        cycles[cycleId].state !== "current" || cycles[cycleId].slot_digest !== slot) {
      fail("review_cycle_store_invalid", "review-cycle slot index is invalid");
    }
    slots[slot] = cycleId;
  }
  for (const cycle of Object.values(cycles)) {
    if (cycle.state === "current" && slots[cycle.slot_digest] !== cycle.cycle_id) {
      fail("review_cycle_store_invalid", "current review cycle is missing from the slot index");
    }
  }
  return { version: REVIEW_CYCLE_STORE_VERSION, cycles, slots };
}

function secureDirectory(fsImpl, directory) {
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fsImpl.lstatSync(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    fail("review_cycle_store_unsafe", "review-cycle directory is unsafe");
  }
  try { fsImpl.chmodSync(directory, 0o700); } catch {}
}

function verifyDirectory(fsImpl, directory) {
  let stat;
  try { stat = fsImpl.lstatSync(directory); } catch { fail("review_cycle_store_unreadable", "review-cycle directory is unreadable"); }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    fail("review_cycle_store_unsafe", "review-cycle directory is unsafe");
  }
}

function eventPlan(cycle, kind, created) {
  const event = cycle.events[kind];
  return deepFreeze({
    kind,
    cycle_id: cycle.cycle_id,
    target_identity_digest: cycle.target_identity_digest,
    correlation_id: event.correlation_id,
    created,
  });
}

function initialReadiness(target, requiresFreshAttempt) {
  if (requiresFreshAttempt) return "contract_changed";
  return target.observed.draft ? "draft_or_not_ready" : "ready";
}

function invalidationReasons(previous, next) {
  const reasons = [];
  if (previous.target.exact_sha !== next.identity.exact_sha) reasons.push("exact_sha_changed");
  if (previous.target.contract_revision !== next.identity.contract_revision) reasons.push("contract_changed");
  if (previous.target.policy_version !== next.identity.policy_version || previous.target.policy_digest !== next.identity.policy_digest) {
    reasons.push("policy_changed");
  }
  if (previous.target.assignment_attempt !== next.identity.assignment_attempt) reasons.push("assignment_changed");
  return reasons;
}

class ReviewCycleStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(os.homedir(), ".quadwork");
    this.fs = options.fsImpl || fs;
    this.now = options.now || (() => new Date());
    this.randomBytes = options.randomBytes || crypto.randomBytes;
  }

  pathFor(projectId) {
    const project = validProjectId(projectId);
    if (!project) fail("invalid_review_cycle_project", "project identity is invalid");
    return path.join(this.rootDir, project, REVIEW_CYCLE_FILENAME);
  }

  _read(projectId) {
    const destination = this.pathFor(projectId);
    let stat;
    try { stat = this.fs.lstatSync(destination); }
    catch (error) {
      if (error?.code === "ENOENT") return emptyDocument();
      fail("review_cycle_store_unreadable", "review-cycle store cannot be read");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid)) {
      fail("review_cycle_store_unsafe", "review-cycle store is unsafe");
    }
    verifyDirectory(this.fs, this.rootDir);
    verifyDirectory(this.fs, path.dirname(destination));
    let value;
    try { value = JSON.parse(this.fs.readFileSync(destination, "utf8")); }
    catch { fail("review_cycle_store_invalid", "review-cycle store is corrupt"); }
    return normalizeDocument(value);
  }

  _write(projectId, document) {
    const normalized = normalizeDocument(document);
    const destination = this.pathFor(projectId);
    const projectDir = path.dirname(destination);
    let temporary = null;
    try {
      secureDirectory(this.fs, this.rootDir);
      secureDirectory(this.fs, projectDir);
      const entropy = this.randomBytes(16);
      if (!Buffer.isBuffer(entropy) || entropy.length < 16) fail("review_cycle_store_write_failed", "review-cycle entropy is unavailable");
      temporary = `${destination}.${process.pid}.${entropy.toString("hex")}.tmp`;
      const fd = this.fs.openSync(temporary, "wx", 0o600);
      try {
        this.fs.writeFileSync(fd, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
        this.fs.fsyncSync(fd);
      } finally {
        this.fs.closeSync(fd);
      }
      this.fs.renameSync(temporary, destination);
      temporary = null;
      try { this.fs.chmodSync(destination, 0o600); } catch {}
      return normalized;
    } catch (error) {
      if (temporary) {
        try { this.fs.unlinkSync(temporary); } catch {}
      }
      if (error instanceof ReviewCycleError) throw error;
      fail("review_cycle_store_write_failed", "review-cycle store could not be atomically persisted");
    }
  }

  _newCycle(target, readiness) {
    const entropy = this.randomBytes(16);
    if (!Buffer.isBuffer(entropy) || entropy.length < 16) fail("review_cycle_store_write_failed", "review-cycle entropy is unavailable");
    const now = clockIso(this.now);
    return {
      version: 1,
      cycle_id: `rc_${entropy.subarray(0, 16).toString("hex")}`,
      slot_digest: target.slot_digest,
      target: clone(target.identity),
      target_identity_digest: target.target_identity_digest,
      readiness,
      ci_state: target.identity.policy_version === null ? "missing_policy" : "unknown",
      mergeable: target.observed.mergeable,
      state: "current",
      invalidation: null,
      events: { review_request: null, head_gate_due: null, contract_changed: null },
      receipts: { re1: null, re2: null },
      created_at: now,
      updated_at: now,
    };
  }

  _current(document, target) {
    const cycleId = document.slots[target.slot_digest];
    return cycleId ? document.cycles[cycleId] || null : null;
  }

  _assertProjectTarget(projectId, target) {
    assertDerivedTarget(target);
    if (target.identity.project_id !== projectId) {
      fail("review_cycle_cross_project", "review target does not belong to this project");
    }
  }

  _requireCurrent(document, projectId, target) {
    this._assertProjectTarget(projectId, target);
    const cycle = this._current(document, target);
    if (!cycle) fail("review_cycle_not_found", "current review cycle does not exist");
    if (cycle.target_identity_digest !== target.target_identity_digest) {
      fail("review_cycle_stale_target", "review target no longer matches the current exact-SHA cycle");
    }
    return cycle;
  }

  load(projectId) {
    return deepFreeze(clone(this._read(projectId)));
  }

  current(projectId, target) {
    const document = this._read(projectId);
    const cycle = this._requireCurrent(document, projectId, target);
    return safeCycleSnapshot(cycle);
  }

  /**
   * Reconcile a server-derived observation.  A retip, contract revision,
   * policy revision, or assignment attempt never carries receipts/events into
   * the replacement cycle.  A changed contract additionally waits for a fresh
   * assignment attempt before becoming review-ready.
   */
  reconcile(projectId, target) {
    this._assertProjectTarget(projectId, target);
    const document = this._read(projectId);
    const current = this._current(document, target);
    if (current && current.target_identity_digest === target.target_identity_digest) {
      const desiredReadiness = current.readiness === "contract_changed"
        ? "contract_changed"
        : initialReadiness(target, false);
      let changed = false;
      if (current.readiness !== desiredReadiness) {
        current.readiness = desiredReadiness;
        changed = true;
      }
      if (current.mergeable !== target.observed.mergeable) {
        current.mergeable = target.observed.mergeable;
        changed = true;
      }
      if (changed) {
        current.updated_at = clockIso(this.now);
        this._write(projectId, document);
      }
      return deepFreeze({ cycle: safeCycleSnapshot(current), invalidated: null, created: false });
    }

    let invalidated = null;
    let requiresFreshAttempt = false;
    if (current) {
      const reasons = invalidationReasons(current, target);
      // A same-slot target digest cannot differ without one of these authority
      // components changing.  Treat an impossible difference as corrupt input
      // rather than silently preserving an old receipt.
      if (reasons.length === 0) fail("review_cycle_target_collision", "review-cycle target changed outside its registered identity");
      const at = clockIso(this.now);
      current.state = "invalidated";
      current.invalidation = { reasons, at };
      if (reasons.includes("contract_changed")) {
        current.readiness = "contract_changed";
        current.events.contract_changed = {
          correlation_id: eventCorrelation(current.cycle_id, "contract_changed"),
          created_at: at,
        };
        requiresFreshAttempt = current.target.assignment_attempt === target.identity.assignment_attempt;
      }
      current.updated_at = at;
      delete document.slots[current.slot_digest];
      invalidated = {
        cycle_id: current.cycle_id,
        reasons: [...reasons],
        contract_change: current.events.contract_changed ? eventPlan(current, "contract_changed", true) : null,
      };
    }
    const cycle = this._newCycle(target, initialReadiness(target, requiresFreshAttempt));
    document.cycles[cycle.cycle_id] = cycle;
    document.slots[cycle.slot_digest] = cycle.cycle_id;
    this._write(projectId, document);
    return deepFreeze({ cycle: safeCycleSnapshot(cycle), invalidated, created: true });
  }

  setReadiness(projectId, target, readiness) {
    if (!new Set(["draft_or_not_ready", "ready"]).has(readiness)) {
      fail("invalid_review_cycle_readiness", "readiness must be draft_or_not_ready or ready");
    }
    const document = this._read(projectId);
    const cycle = this._requireCurrent(document, projectId, target);
    if (cycle.readiness === "contract_changed") {
      fail("review_cycle_fresh_assignment_required", "a contract change requires a fresh assignment attempt");
    }
    if (cycle.readiness !== readiness) {
      cycle.readiness = readiness;
      cycle.updated_at = clockIso(this.now);
      this._write(projectId, document);
    }
    return safeCycleSnapshot(cycle);
  }

  setCiState(projectId, target, ciState) {
    if (!CI_STATES.has(ciState)) fail("invalid_review_cycle_ci_state", "CI state is invalid");
    const document = this._read(projectId);
    const cycle = this._requireCurrent(document, projectId, target);
    if (cycle.target.policy_version === null && ciState !== "missing_policy") {
      fail("review_cycle_missing_policy", "a missing policy cannot be upgraded by an unbound CI state");
    }
    if (cycle.target.policy_version !== null && ciState === "missing_policy") {
      fail("invalid_review_cycle_ci_state", "registered policy cannot become missing without target invalidation");
    }
    if (cycle.ci_state !== ciState) {
      cycle.ci_state = ciState;
      cycle.updated_at = clockIso(this.now);
      this._write(projectId, document);
    }
    return safeCycleSnapshot(cycle);
  }

  setMergeability(projectId, target, mergeable) {
    if (typeof mergeable !== "boolean") fail("invalid_review_cycle_mergeability", "mergeability must be a boolean");
    const document = this._read(projectId);
    const cycle = this._requireCurrent(document, projectId, target);
    if (cycle.mergeable !== mergeable) {
      cycle.mergeable = mergeable;
      cycle.updated_at = clockIso(this.now);
      this._write(projectId, document);
    }
    return safeCycleSnapshot(cycle);
  }

  planReviewRequest(projectId, target) {
    const document = this._read(projectId);
    const cycle = this._requireCurrent(document, projectId, target);
    if (cycle.events.review_request) return eventPlan(cycle, "review_request", false);
    if (cycle.readiness !== "ready" || !DISPATCHABLE_CI_STATES.has(cycle.ci_state)) return null;
    const at = clockIso(this.now);
    cycle.events.review_request = {
      correlation_id: eventCorrelation(cycle.cycle_id, "review_request"),
      created_at: at,
    };
    cycle.updated_at = at;
    this._write(projectId, document);
    return eventPlan(cycle, "review_request", true);
  }

  recordReviewReceipt(projectId, target, receipt) {
    exactKeys(receipt, ["reviewer_role", "review_id", "verdict", "submitted_at", "target_identity_digest"], "invalid_review_cycle_receipt");
    const role = receipt.reviewer_role;
    const normalizedId = reviewId(receipt.review_id);
    const submittedAt = validIsoTimestamp(receipt.submitted_at);
    if (!REVIEWER_ROLES.has(role) || !normalizedId || !VERDICTS.has(receipt.verdict) || !submittedAt ||
        !DIGEST_RE.test(receipt.target_identity_digest)) {
      fail("invalid_review_cycle_receipt", "review receipt is invalid");
    }
    const document = this._read(projectId);
    const cycle = this._requireCurrent(document, projectId, target);
    if (receipt.target_identity_digest !== cycle.target_identity_digest) {
      fail("review_cycle_stale_target", "review receipt does not bind the current cycle identity");
    }
    if (cycle.readiness !== "ready" || !cycle.events.review_request) {
      fail("review_cycle_review_not_admitted", "review receipt is not admitted for this cycle");
    }
    const normalized = {
      reviewer_role: role,
      review_id: normalizedId,
      verdict: receipt.verdict,
      submitted_at: submittedAt,
      target_identity_digest: cycle.target_identity_digest,
    };
    const existing = cycle.receipts[role];
    if (existing) {
      if (stableJson(existing) === stableJson(normalized)) return safeCycleSnapshot(cycle);
      fail("review_cycle_role_already_receipted", "reviewer role already has a distinct receipt for this cycle");
    }
    for (const priorCycle of Object.values(document.cycles)) {
      for (const priorReceipt of Object.values(priorCycle.receipts)) {
        if (priorReceipt?.review_id === normalizedId) {
          fail("review_cycle_review_id_already_bound", "review ID is already bound to another role or cycle");
        }
      }
    }
    cycle.receipts[role] = normalized;
    cycle.updated_at = clockIso(this.now);
    this._write(projectId, document);
    return safeCycleSnapshot(cycle);
  }

  planHeadGate(projectId, target) {
    const document = this._read(projectId);
    const cycle = this._requireCurrent(document, projectId, target);
    if (!headGateDue(cycle)) return null;
    if (cycle.events.head_gate_due) return eventPlan(cycle, "head_gate_due", false);
    const at = clockIso(this.now);
    cycle.events.head_gate_due = {
      correlation_id: eventCorrelation(cycle.cycle_id, "head_gate_due"),
      created_at: at,
    };
    cycle.updated_at = at;
    this._write(projectId, document);
    return eventPlan(cycle, "head_gate_due", true);
  }

  markTerminal(projectId, target) {
    const document = this._read(projectId);
    const cycle = this._requireCurrent(document, projectId, target);
    cycle.state = "terminal";
    cycle.updated_at = clockIso(this.now);
    delete document.slots[cycle.slot_digest];
    this._write(projectId, document);
    return safeCycleSnapshot(cycle);
  }
}

function createReviewCycleStore(options) {
  return new ReviewCycleStore(options);
}

module.exports = {
  REVIEW_CYCLE_STORE_VERSION,
  REVIEW_CYCLE_FILENAME,
  LEGACY_REVIEW_TARGET_KIND,
  ReviewCycleError,
  ReviewCycleStore,
  createReviewCycleStore,
  deriveLegacyReviewTarget,
  assertDerivedTarget,
  targetIdentityDigest,
  targetSlotDigest,
  reviewState,
  headGateDue,
};
