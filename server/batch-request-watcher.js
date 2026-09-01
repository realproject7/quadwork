"use strict";

// #1046 M3: bounded, server-owned reconciliation around the strict Batch
// Request contract/subscription seam. This module has no transport, scheduler,
// filesystem, chat, monitor, or worker-dispatch dependency. The integration
// owner supplies two narrow synchronous canonical accessors and is solely
// responsible for later durable compare-and-swap and Head wake delivery.

const {
  VERSION: SUBSCRIPTION_VERSION,
  REQUEST_LABEL,
  BatchRequestSubscriptionError,
  normalizeSubscriptionState,
  reconcileBatchRequestSubscription,
} = require("./batch-request-subscription");

const VERSION = 1;
const MAX_FETCHED_ISSUES = 64;
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const ISSUE_NUMBER_RE = /^[1-9]\d{0,6}$/;

class BatchRequestWatcherError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "BatchRequestWatcherError";
    this.code = code;
  }
}

function fail(code, message) { throw new BatchRequestWatcherError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has unknown or missing fields");
  }
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function identity(value, code) {
  exact(value, ["installation_id", "project_id"], code);
  if (!INSTALLATION_ID_RE.test(value.installation_id) || !PROJECT_ID_RE.test(value.project_id)) {
    fail(code, "installation/project identity is invalid");
  }
  return { installation_id: value.installation_id, project_id: value.project_id };
}
function sameIdentity(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id;
}
function repository(value, code) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) fail(code, "repository is invalid");
  return value;
}
function issueNumber(value, code) {
  if (!Number.isSafeInteger(value) || !ISSUE_NUMBER_RE.test(String(value))) fail(code, "issue number is invalid");
  return value;
}
function diagnostic(code) { return freeze({ code }); }
function normalizedState(value) {
  try { return normalizeSubscriptionState(value); }
  catch (error) {
    if (error instanceof BatchRequestSubscriptionError) fail(error.code, "durable subscription state is invalid");
    throw error;
  }
}
function snapshotState(value) {
  const state = normalizedState(value);
  return freeze({
    version: SUBSCRIPTION_VERSION,
    cursor: state.cursor === null ? null : clone(state.cursor),
    records: state.records.map(clone),
  });
}
function outcome(state, headPlan = null, code = null, processed = 0) {
  if (!Number.isSafeInteger(processed) || processed < 0 || processed > MAX_FETCHED_ISSUES) {
    fail("invalid_batch_request_watcher_result", "processed count is invalid");
  }
  return freeze({
    version: VERSION,
    next_state: snapshotState(state),
    head_plan: headPlan === null ? null : freeze(clone(headPlan)),
    processed,
    internal_diagnostics: freeze(code === null ? [] : [diagnostic(code)]),
  });
}

function canonicalSubscription(value, target) {
  exact(value, [
    "version",
    "target",
    "enabled",
    "archived",
    "coordination_repository",
    "request_label",
    "environment",
  ], "invalid_batch_request_watcher_subscription");
  if (value.version !== VERSION || typeof value.enabled !== "boolean" || typeof value.archived !== "boolean") {
    fail("invalid_batch_request_watcher_subscription", "subscription state is invalid");
  }
  const resolvedTarget = identity(value.target, "invalid_batch_request_watcher_subscription");
  if (!sameIdentity(resolvedTarget, target)) {
    fail("batch_request_watcher_target_mismatch", "subscription target does not match the requested project");
  }
  const coordinationRepository = repository(value.coordination_repository, "invalid_batch_request_watcher_subscription");
  if (value.request_label !== REQUEST_LABEL || !plain(value.environment)) {
    fail("invalid_batch_request_watcher_subscription", "subscription watch route is invalid");
  }
  return {
    enabled: value.enabled,
    archived: value.archived,
    coordination_repository: coordinationRepository,
    request_label: REQUEST_LABEL,
    // The existing subscription reconciler owns the complete strict validation
    // of the Project Environments projection before it can admit authority.
    subscription: { enabled: value.enabled, archived: value.archived, environment: clone(value.environment) },
  };
}
function resolveSubscription(accessor, target) {
  if (typeof accessor !== "function") {
    fail("batch_request_watcher_subscription_accessor_required", "canonical subscription accessor is required");
  }
  let value;
  try {
    value = accessor(freeze({ version: VERSION, target: freeze(clone(target)) }));
  } catch {
    fail("batch_request_watcher_subscription_unavailable", "canonical subscription accessor failed");
  }
  return canonicalSubscription(value, target);
}
function issueEnvelope(value, coordinationRepository) {
  exact(value, ["repository", "issue_number", "issue_url", "pull_request", "labels", "body", "etag", "cursor"], "invalid_batch_request_watcher_issue");
  const issueRepository = repository(value.repository, "invalid_batch_request_watcher_issue");
  if (issueRepository !== coordinationRepository) {
    fail("batch_request_watcher_repository_mismatch", "fetched issue belongs to another repository");
  }
  issueNumber(value.issue_number, "invalid_batch_request_watcher_issue");
  return clone(value);
}
function fetchedIssues(value, target, coordinationRepository) {
  exact(value, ["version", "target", "coordination_repository", "request_label", "issues"], "invalid_batch_request_watcher_fetch");
  if (value.version !== VERSION || value.request_label !== REQUEST_LABEL ||
      repository(value.coordination_repository, "invalid_batch_request_watcher_fetch") !== coordinationRepository ||
      !sameIdentity(identity(value.target, "invalid_batch_request_watcher_fetch"), target) ||
      !Array.isArray(value.issues) || value.issues.length > MAX_FETCHED_ISSUES) {
    fail("invalid_batch_request_watcher_fetch", "fetched issue response is invalid");
  }
  const issues = value.issues.map((issue) => issueEnvelope(issue, coordinationRepository));
  const identities = new Set();
  for (const issue of issues) {
    const key = `${issue.repository}\u0000${issue.issue_number}`;
    if (identities.has(key)) fail("invalid_batch_request_watcher_fetch", "fetched issue identity is duplicated");
    identities.add(key);
  }
  return issues.sort((left, right) => left.issue_number - right.issue_number);
}
function fetchIssues(accessor, target, coordinationRepository) {
  if (typeof accessor !== "function") {
    fail("batch_request_watcher_fetch_accessor_required", "fetched issue accessor is required");
  }
  const request = freeze({
    version: VERSION,
    target: freeze(clone(target)),
    coordination_repository: coordinationRepository,
    request_label: REQUEST_LABEL,
  });
  let value;
  try { value = accessor(request); }
  catch { fail("batch_request_watcher_fetch_unavailable", "fetched issue accessor failed"); }
  return fetchedIssues(value, target, coordinationRepository);
}
function assertHeadPlan(value) {
  if (!plain(value)) fail("invalid_batch_request_watcher_plan", "subscription emitted an invalid plan");
  exact(value, ["version", "kind", "recipients", "correlation_key", "issue_url", "anchors", "authority"], "invalid_batch_request_watcher_plan");
  if (value.version !== SUBSCRIPTION_VERSION || value.kind !== "BATCH REQUEST" ||
      !Array.isArray(value.recipients) || value.recipients.length !== 1 || value.recipients[0] !== "head") {
    fail("invalid_batch_request_watcher_plan", "subscription plan is not Head-only");
  }
  return value;
}

class BatchRequestWatcher {
  constructor(options) {
    exact(options, ["resolveCanonicalSubscription", "fetchIssueRecords"], "invalid_batch_request_watcher_options");
    if (typeof options.resolveCanonicalSubscription !== "function" || typeof options.fetchIssueRecords !== "function") {
      fail("invalid_batch_request_watcher_options", "watcher accessors must be functions");
    }
    this.resolveCanonicalSubscription = options.resolveCanonicalSubscription;
    this.fetchIssueRecords = options.fetchIssueRecords;
  }

  // One reconciliation run never polls or sends anything. It first processes
  // deterministic no-plan records (including subscription dedupe/mutation
  // facts), then stops on the first newly admitted Head plan. A later run can
  // continue from the durable state, so no second authority is acknowledged
  // without its own durable Head-only delivery.
  reconcile(input) {
    exact(input, ["version", "target", "state"], "invalid_batch_request_watcher_input");
    if (input.version !== VERSION) fail("invalid_batch_request_watcher_input", "watcher input version is invalid");
    const target = identity(input.target, "invalid_batch_request_watcher_input");
    let state = normalizedState(input.state);
    const subscription = resolveSubscription(this.resolveCanonicalSubscription, target);
    if (subscription.archived) return outcome(state, null, "batch_request_subscription_archived");
    if (!subscription.enabled) return outcome(state, null, "batch_request_subscription_disabled");
    const issues = fetchIssues(this.fetchIssueRecords, target, subscription.coordination_repository);
    let processed = 0;
    let lastCode = null;
    for (const issue of issues) {
      let result;
      try {
        result = reconcileBatchRequestSubscription({ subscription: subscription.subscription, state, issue });
      } catch (error) {
        if (error instanceof BatchRequestSubscriptionError) {
          return outcome(state, null, error.code, processed);
        }
        throw error;
      }
      state = normalizedState(result.next_state);
      processed += 1;
      lastCode = result.internal_diagnostics[0]?.code || null;
      if (result.event_plan !== null) {
        return outcome(state, assertHeadPlan(result.event_plan), null, processed);
      }
    }
    return outcome(state, null, lastCode, processed);
  }
}

function createBatchRequestWatcher(options) {
  return new BatchRequestWatcher(options);
}

module.exports = {
  VERSION,
  MAX_FETCHED_ISSUES,
  BatchRequestWatcherError,
  BatchRequestWatcher,
  createBatchRequestWatcher,
};
