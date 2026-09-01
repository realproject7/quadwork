"use strict";

// #1046 M7: a deliberately one-shot composition boundary for Batch Request
// reconciliation. The caller supplies canonical project facts, the one
// coordination-repository read, and the exact Head notification transport.
// This module owns neither a trigger nor a retry policy: after the durable CAS
// admits a request, a transport uncertainty is surfaced as terminal ambiguity
// rather than risking a second Head notification.

const {
  VERSION: WATCHER_VERSION,
  createBatchRequestWatcher,
} = require("./batch-request-watcher");

const VERSION = 1;
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const DIAGNOSTIC_RE = /^[a-z][a-z0-9_]{2,127}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ISSUE_NUMBER_RE = /^[1-9]\d{0,6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class BatchRequestRuntimeError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "BatchRequestRuntimeError";
    this.code = code;
    this.details = details === null ? null : freeze(clone(details));
  }
}

function fail(code, message, details) { throw new BatchRequestRuntimeError(code, message, details); }
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
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function identity(value, code) {
  exact(value, ["installation_id", "project_id"], code);
  if (typeof value.installation_id !== "string" || !INSTALLATION_ID_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_ID_RE.test(value.project_id)) {
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
function diagnostic(code) {
  if (typeof code !== "string" || !DIAGNOSTIC_RE.test(code)) {
    fail("invalid_batch_request_runtime_diagnostic", "diagnostic is invalid");
  }
  return freeze({ code });
}
function compactSnapshot(value, target) {
  exact(value, ["schema_version", "identity", "revision", "subscription_state"], "invalid_batch_request_runtime_snapshot");
  if (!sameIdentity(identity(value.identity, "invalid_batch_request_runtime_snapshot"), target) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !plain(value.subscription_state) || !Array.isArray(value.subscription_state.records)) {
    fail("invalid_batch_request_runtime_snapshot", "durable snapshot is invalid");
  }
  return freeze({
    revision: value.revision,
    record_count: value.subscription_state.records.length,
    has_cursor: value.subscription_state.cursor !== null,
  });
}
function initialState() { return freeze({ version: WATCHER_VERSION, cursor: null, records: [] }); }
function runtimeInput(value, code) {
  exact(value, ["version", "target"], code);
  if (value.version !== VERSION) fail(code, "runtime version is invalid");
  return identity(value.target, code);
}
function cacheFact(snapshot, coordinationRepository) {
  const state = snapshot.subscription_state;
  const cursor = state.cursor;
  if (cursor === null) return freeze({ etag: null, cursor: null });
  exact(cursor, ["coordination_repo", "issue_number", "etag", "cursor"], "invalid_batch_request_runtime_snapshot");
  if (repository(cursor.coordination_repo, "invalid_batch_request_runtime_snapshot") !== coordinationRepository) {
    fail("batch_request_runtime_cache_repository_mismatch", "durable cache belongs to another repository");
  }
  return freeze({ etag: cursor.etag, cursor: cursor.cursor });
}
function assertIssueReadResponse(value, request) {
  exact(value, ["version", "target", "coordination_repository", "request_label", "cache", "issues"], "invalid_batch_request_runtime_issue_read");
  if (value.version !== VERSION || !sameIdentity(identity(value.target, "invalid_batch_request_runtime_issue_read"), request.target) ||
      repository(value.coordination_repository, "invalid_batch_request_runtime_issue_read") !== request.coordination_repository ||
      value.request_label !== request.request_label || !sameJson(value.cache, request.cache) || !Array.isArray(value.issues)) {
    fail("invalid_batch_request_runtime_issue_read", "issue read response does not bind the requested context");
  }
  return freeze({
    version: WATCHER_VERSION,
    target: clone(request.target),
    coordination_repository: request.coordination_repository,
    request_label: request.request_label,
    issues: clone(value.issues),
  });
}
function assertHeadNotification(value, target) {
  exact(value, ["version", "kind", "recipients", "correlation_key", "issue_url", "anchors", "authority"], "invalid_batch_request_runtime_head_plan");
  if (value.version !== WATCHER_VERSION || value.kind !== "BATCH REQUEST" || !Array.isArray(value.recipients) ||
      value.recipients.length !== 1 || value.recipients[0] !== "head" ||
      !plain(value.anchors) || !plain(value.authority) ||
      value.authority.target_installation_id !== target.installation_id || value.authority.target_project_id !== target.project_id) {
    fail("invalid_batch_request_runtime_head_plan", "notification is not one exact Head-only request");
  }
  exact(value.anchors, ["coordination_repo", "issue_number", "request_id", "authority_digest"], "invalid_batch_request_runtime_head_plan");
  exact(value.authority, [
    "schema", "request_id", "source_installation_id", "source_project_id", "target_installation_id", "target_project_id",
    "coordination_repo", "mode", "work_refs", "start_policy",
  ], "invalid_batch_request_runtime_head_plan");
  const coordinationRepository = repository(value.anchors.coordination_repo, "invalid_batch_request_runtime_head_plan");
  if (!Number.isSafeInteger(value.anchors.issue_number) || !ISSUE_NUMBER_RE.test(String(value.anchors.issue_number)) ||
      typeof value.anchors.request_id !== "string" || !UUID_RE.test(value.anchors.request_id) ||
      typeof value.anchors.authority_digest !== "string" || !SHA_RE.test(value.anchors.authority_digest) ||
      value.authority.request_id !== value.anchors.request_id || value.authority.coordination_repo !== coordinationRepository ||
      typeof value.correlation_key !== "string" || value.correlation_key.length === 0 || value.correlation_key.length > 1024) {
    fail("invalid_batch_request_runtime_head_plan", "notification anchors are invalid");
  }
  let parsed;
  try { parsed = new URL(value.issue_url); }
  catch { fail("invalid_batch_request_runtime_head_plan", "notification issue URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.host !== "api.github.com" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== `/repos/${coordinationRepository}/issues/${value.anchors.issue_number}` ||
      parsed.toString() !== value.issue_url) {
    fail("invalid_batch_request_runtime_head_plan", "notification issue URL is invalid");
  }
  return freeze(clone(value));
}
function assertDeliveryReceipt(value) {
  exact(value, ["version", "accepted"], "invalid_batch_request_runtime_delivery_receipt");
  if (value.version !== VERSION || value.accepted !== true) {
    fail("invalid_batch_request_runtime_delivery_receipt", "notification callback did not accept the exact request");
  }
}
function result(snapshot, target, persisted, delivery, codes) {
  if (typeof persisted !== "boolean" || !["none", "delivered"].includes(delivery) || !Array.isArray(codes) || codes.length > 1) {
    fail("invalid_batch_request_runtime_result", "runtime result is invalid");
  }
  return freeze({
    version: VERSION,
    snapshot: compactSnapshot(snapshot, target),
    persisted,
    delivery,
    diagnostics: freeze(codes.map(diagnostic)),
  });
}
function assertStore(value) {
  if (!plain(value)) fail("invalid_batch_request_runtime_options", "state store is required");
  for (const name of ["initialize", "readRecoverySnapshot", "applyWatcherResult"]) {
    if (typeof value[name] !== "function") fail("invalid_batch_request_runtime_options", "state store interface is invalid");
  }
  return value;
}

class BatchRequestRuntime {
  constructor(options) {
    exact(options, ["stateStore", "resolveCanonicalSubscription", "readCoordinationIssues", "deliverHeadNotification"], "invalid_batch_request_runtime_options");
    if (typeof options.resolveCanonicalSubscription !== "function" ||
        typeof options.readCoordinationIssues !== "function" ||
        typeof options.deliverHeadNotification !== "function") {
      fail("invalid_batch_request_runtime_options", "runtime accessors must be functions");
    }
    this.stateStore = assertStore(options.stateStore);
    this.resolveCanonicalSubscription = options.resolveCanonicalSubscription;
    this.readCoordinationIssues = options.readCoordinationIssues;
    this.deliverHeadNotification = options.deliverHeadNotification;
  }

  // Explicit initialization is the only state-creation path. A missing or
  // malformed durable state never grants the runtime permission to reset it.
  initialize(input) {
    const target = runtimeInput(input, "invalid_batch_request_runtime_initialization");
    const snapshot = this.stateStore.initialize({
      expected: freeze({ ...target, revision: null }),
      subscription_state: initialState(),
    });
    return result(snapshot, target, true, "none", []);
  }

  // This reports only durable progress counters. It deliberately does not
  // expose request prose, credentials, transport tokens, or store paths.
  recover(input) {
    const target = runtimeInput(input, "invalid_batch_request_runtime_recovery");
    const snapshot = this.stateStore.readRecoverySnapshot(target);
    return result(snapshot, target, false, "none", []);
  }

  // One caller-controlled attempt: recover, read canonical facts, reconcile,
  // durably apply the exact result, then deliver at most one closed Head note.
  // There is no retry after a callback uncertainty because the committed
  // delivery record makes attempting it again indistinguishable from a
  // duplicate external delivery.
  reconcile(input) {
    const target = runtimeInput(input, "invalid_batch_request_runtime_reconcile");
    const recovered = this.stateStore.readRecoverySnapshot(target);
    const watcher = createBatchRequestWatcher({
      resolveCanonicalSubscription: this.resolveCanonicalSubscription,
      fetchIssueRecords: (watcherRequest) => {
        const request = freeze({
          version: VERSION,
          target: freeze(clone(target)),
          coordination_repository: repository(watcherRequest.coordination_repository, "invalid_batch_request_runtime_watcher_request"),
          request_label: watcherRequest.request_label,
          cache: cacheFact(recovered, watcherRequest.coordination_repository),
        });
        let response;
        try { response = this.readCoordinationIssues(request); }
        catch { fail("batch_request_runtime_issue_read_unavailable", "canonical issue read failed"); }
        return assertIssueReadResponse(response, request);
      },
    });
    const reconciled = watcher.reconcile({
      version: WATCHER_VERSION,
      target: clone(target),
      state: recovered.subscription_state,
    });
    const applied = this.stateStore.applyWatcherResult({
      expected: freeze({ ...target, revision: recovered.revision }),
      result: reconciled,
    });
    const codes = reconciled.internal_diagnostics.map((entry) => entry.code);
    if (applied.head_plan === null) return result(applied.snapshot, target, applied.persisted, "none", codes);

    const notification = assertHeadNotification(applied.head_plan, target);
    const request = freeze({ version: VERSION, target: freeze(clone(target)), notification });
    try {
      const receipt = this.deliverHeadNotification(request);
      assertDeliveryReceipt(receipt);
    } catch (error) {
      if (error instanceof BatchRequestRuntimeError && error.code === "invalid_batch_request_runtime_delivery_receipt") {
        fail("batch_request_notification_delivery_ambiguous", "notification delivery acknowledgement is ambiguous", { revision: applied.snapshot.revision });
      }
      fail("batch_request_notification_delivery_ambiguous", "notification delivery outcome is ambiguous", { revision: applied.snapshot.revision });
    }
    return result(applied.snapshot, target, applied.persisted, "delivered", codes);
  }
}

function createBatchRequestRuntime(options) { return new BatchRequestRuntime(options); }

module.exports = {
  VERSION,
  BatchRequestRuntimeError,
  BatchRequestRuntime,
  createBatchRequestRuntime,
};
