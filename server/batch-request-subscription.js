"use strict";

// #1046 M2: a deliberately narrow, pure reconciliation seam for one local
// Batch Request subscription.  It consumes an already-read Issue fixture and
// an injected Project Environments projection; it never polls, mutates a
// label, starts a batch, dispatches an agent, or performs I/O.

const {
  BatchRequestContractError,
  parseBatchRequestAuthority,
  assertBatchRequestRegistered,
} = require("./batch-request-contract");

const VERSION = 1;
// Discovery is deliberately a fixed, human-visible GitHub label.  It is not
// the authority (the fenced v1 body is), but it must still match the published
// subscription contract exactly so the narrow REST query neither misses nor
// broadens the watched set.
const REQUEST_LABEL = "quadwork:batch-request";
const MAX_RECORDS = 128;
const MAX_ETAG_LENGTH = 512;
const MAX_CURSOR_LENGTH = 512;
const SHA_RE = /^[a-f0-9]{64}$/;
const REPOSITORY_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUE_NUMBER_RE = /^[1-9]\d{0,6}$/;
const ENVIRONMENT_CLASS_SET = new Set(["local", "vps", "other"]);
const RECORD_STATUSES = new Set(["delivered", "terminal_invalid"]);

class BatchRequestSubscriptionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "BatchRequestSubscriptionError";
    this.code = code;
  }
}

function fail(code, message) { throw new BatchRequestSubscriptionError(code, message); }
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
function diagnostic(code) { return freeze({ code }); }
function diagnostics(code = null) { return freeze(code === null ? [] : [diagnostic(code)]); }

function identity(value, code) {
  exact(value, ["installation_id", "project_id"], code);
  if (typeof value.installation_id !== "string" || !INSTALLATION_ID_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_ID_RE.test(value.project_id)) {
    fail(code, "installation/project identity is invalid");
  }
  return { installation_id: value.installation_id, project_id: value.project_id };
}
function canonicalRepository(value, code) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) fail(code, "repository is invalid");
  return value;
}
function issueNumber(value, code) {
  if (!Number.isSafeInteger(value) || !ISSUE_NUMBER_RE.test(String(value))) fail(code, "issue number is invalid");
  return value;
}
function safeOpaque(value, field, code) {
  if (value === null) return null;
  const maximum = field === "etag" ? MAX_ETAG_LENGTH : MAX_CURSOR_LENGTH;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\r\n\u0000]/.test(value)) {
    fail(code, `${field} is invalid`);
  }
  return value;
}
function sameIdentity(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id;
}

function dedupeKey(coordinationRepo, number, requestId, digest) {
  return JSON.stringify(["batch-request", VERSION, coordinationRepo, number, requestId, digest]);
}
function requestIdentityKey(coordinationRepo, number, requestId) {
  return JSON.stringify(["batch-request", VERSION, coordinationRepo, number, requestId]);
}

function assertCursor(value, code) {
  if (value === null) return null;
  exact(value, ["coordination_repo", "issue_number", "etag", "cursor"], code);
  return {
    coordination_repo: canonicalRepository(value.coordination_repo, code),
    issue_number: issueNumber(value.issue_number, code),
    etag: safeOpaque(value.etag, "etag", code),
    cursor: safeOpaque(value.cursor, "cursor", code),
  };
}
function assertRecord(value, code) {
  exact(value, ["coordination_repo", "issue_number", "request_id", "authority_digest", "dedupe_key", "status", "mutated_digest"], code);
  const coordinationRepo = canonicalRepository(value.coordination_repo, code);
  const number = issueNumber(value.issue_number, code);
  if (typeof value.request_id !== "string" || !UUID_RE.test(value.request_id) ||
      !SHA_RE.test(value.authority_digest) || typeof value.dedupe_key !== "string" ||
      !RECORD_STATUSES.has(value.status)) {
    fail(code, "subscription delivery record is invalid");
  }
  if (value.dedupe_key !== dedupeKey(coordinationRepo, number, value.request_id, value.authority_digest)) {
    fail(code, "subscription delivery dedupe key is invalid");
  }
  if (value.status === "delivered" && value.mutated_digest !== null) {
    fail(code, "delivered record cannot retain a mutation");
  }
  if (value.status === "terminal_invalid" &&
      (typeof value.mutated_digest !== "string" || !SHA_RE.test(value.mutated_digest) || value.mutated_digest === value.authority_digest)) {
    fail(code, "terminal record mutation is invalid");
  }
  return {
    coordination_repo: coordinationRepo,
    issue_number: number,
    request_id: value.request_id,
    authority_digest: value.authority_digest,
    dedupe_key: value.dedupe_key,
    status: value.status,
    mutated_digest: value.mutated_digest,
  };
}
function normalizeSubscriptionState(value) {
  if (value === null || value === undefined) {
    return { version: VERSION, cursor: null, records: [] };
  }
  exact(value, ["version", "cursor", "records"], "invalid_batch_request_subscription_state");
  if (value.version !== VERSION || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) {
    fail("invalid_batch_request_subscription_state", "subscription state is invalid");
  }
  const records = value.records.map((record) => assertRecord(record, "invalid_batch_request_subscription_state"));
  const identities = new Set();
  for (const record of records) {
    const key = requestIdentityKey(record.coordination_repo, record.issue_number, record.request_id);
    if (identities.has(key)) fail("invalid_batch_request_subscription_state", "subscription delivery identity is duplicated");
    identities.add(key);
  }
  return { version: VERSION, cursor: assertCursor(value.cursor, "invalid_batch_request_subscription_state"), records };
}

// This validates the #1045 M1 Project Environments projection at the input
// edge.  Its display fields are revalidated even though this module uses only
// the peer identity, preventing a future caller from treating arbitrary peer
// metadata as subscription routing authority.
function normalizeEnvironment(value) {
  exact(value, ["current", "peers", "coordination_repository", "registered_repositories"], "invalid_batch_request_environment");
  const current = identity(value.current, "invalid_batch_request_environment");
  exact(value.coordination_repository, ["key", "canonical_repository"], "invalid_batch_request_environment");
  if (typeof value.coordination_repository.key !== "string" || !REPOSITORY_KEY_RE.test(value.coordination_repository.key)) {
    fail("invalid_batch_request_environment", "coordination repository key is invalid");
  }
  const coordinationRepo = canonicalRepository(value.coordination_repository.canonical_repository, "invalid_batch_request_environment");
  if (!Array.isArray(value.peers) || !Array.isArray(value.registered_repositories) || value.peers.length > MAX_RECORDS || value.registered_repositories.length === 0 || value.registered_repositories.length > MAX_RECORDS) {
    fail("invalid_batch_request_environment", "environment routes are invalid");
  }
  const peerKeys = new Set();
  const peers = value.peers.map((peer) => {
    exact(peer, ["installation_id", "project_id", "label", "environment_class"], "invalid_batch_request_environment");
    const normalized = identity({ installation_id: peer.installation_id, project_id: peer.project_id }, "invalid_batch_request_environment");
    if (sameIdentity(normalized, current) || typeof peer.label !== "string" || peer.label.trim().length === 0 || peer.label.length > 120 ||
        /[\r\n\u0000]/.test(peer.label) || !ENVIRONMENT_CLASS_SET.has(peer.environment_class)) {
      fail("invalid_batch_request_environment", "environment peer is invalid");
    }
    const key = `${normalized.installation_id}\u0000${normalized.project_id}`;
    if (peerKeys.has(key)) fail("invalid_batch_request_environment", "environment peer is duplicated");
    peerKeys.add(key);
    return normalized;
  });
  const repositories = value.registered_repositories.map((repository) => canonicalRepository(repository, "invalid_batch_request_environment"));
  if (new Set(repositories).size !== repositories.length || !repositories.includes(coordinationRepo)) {
    fail("invalid_batch_request_environment", "registered repositories are invalid");
  }
  return { current, coordination_repo: coordinationRepo, peers, registered_repositories: repositories };
}

function normalizeSubscription(value) {
  exact(value, ["enabled", "archived", "environment"], "invalid_batch_request_subscription");
  if (typeof value.enabled !== "boolean" || typeof value.archived !== "boolean") {
    fail("invalid_batch_request_subscription", "subscription state is invalid");
  }
  return { enabled: value.enabled, archived: value.archived, environment: value.environment };
}

function expectedIssuePath(repository, number) {
  return `/repos/${repository}/issues/${number}`;
}
function normalizeIssueUrl(value, repository, number) {
  if (typeof value !== "string" || value.length > 1024) fail("invalid_batch_request_issue_url", "issue URL is invalid");
  let parsed;
  try { parsed = new URL(value); }
  catch { fail("invalid_batch_request_issue_url", "issue URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== expectedIssuePath(repository, number)) {
    fail("invalid_batch_request_issue_url", "issue URL does not identify the exact repository issue");
  }
  // Preserve the exact Issue identity while normalizing the URL representation
  // itself.  Query/hash/user-info are rejected above, so this cannot carry
  // context or a worker-directed instruction into the closed Head plan.
  return parsed.toString();
}
function normalizeIssueFixture(value) {
  exact(value, ["repository", "issue_number", "issue_url", "pull_request", "labels", "body", "etag", "cursor"], "invalid_batch_request_issue_fixture");
  const repository = canonicalRepository(value.repository, "invalid_batch_request_issue_fixture");
  const number = issueNumber(value.issue_number, "invalid_batch_request_issue_fixture");
  const issueUrl = normalizeIssueUrl(value.issue_url, repository, number);
  if ((value.pull_request !== null && !plain(value.pull_request)) || !Array.isArray(value.labels) || value.labels.length > 32 ||
      !value.labels.every((label) => typeof label === "string" && label.length > 0 && label.length <= 100 && !/[\r\n\u0000]/.test(label))) {
    fail("invalid_batch_request_issue_fixture", "issue fixture shape is invalid");
  }
  if (typeof value.body !== "string" && !Buffer.isBuffer(value.body)) {
    fail("invalid_batch_request_issue_fixture", "issue body is invalid");
  }
  return {
    repository,
    issue_number: number,
    issue_url: issueUrl,
    body: value.body,
    is_pull_request: value.pull_request !== null,
    has_request_label: value.labels.includes(REQUEST_LABEL),
    cursor: {
      coordination_repo: repository,
      issue_number: number,
      etag: safeOpaque(value.etag, "etag", "invalid_batch_request_issue_fixture"),
      cursor: safeOpaque(value.cursor, "cursor", "invalid_batch_request_issue_fixture"),
    },
  };
}

function result(state, cursor, eventPlan = null, code = null) {
  const nextState = freeze({ version: VERSION, cursor: cursor === null ? null : clone(cursor), records: state.records.map(clone) });
  return freeze({
    version: VERSION,
    next_cursor: nextState.cursor,
    next_state: nextState,
    event_plan: eventPlan,
    internal_diagnostics: diagnostics(code),
  });
}
function replaceRecord(state, index, record) {
  const records = state.records.map(clone);
  records[index] = record;
  return { version: VERSION, cursor: state.cursor === null ? null : clone(state.cursor), records };
}
function withCursor(state, cursor) {
  return { version: VERSION, cursor: clone(cursor), records: state.records.map(clone) };
}
function findRecord(state, repository, number, requestId) {
  const key = requestIdentityKey(repository, number, requestId);
  return state.records.findIndex((record) =>
    requestIdentityKey(record.coordination_repo, record.issue_number, record.request_id) === key);
}
function eventPlanFor(contract, fixture) {
  const authority = contract.authority;
  const anchors = {
    coordination_repo: fixture.repository,
    issue_number: fixture.issue_number,
    request_id: authority.request_id,
    authority_digest: contract.digest,
  };
  // This is deliberately a closed Head wake-up plan.  It contains only the
  // strict authority schema, exact canonical Issue URL, and correlation
  // anchors.  It never contains Issue prose, title, ETag/cursor, labels, or
  // any worker-facing diagnostics.
  return freeze({
    version: VERSION,
    kind: "BATCH REQUEST",
    recipients: ["head"],
    correlation_key: dedupeKey(fixture.repository, fixture.issue_number, authority.request_id, contract.digest),
    issue_url: fixture.issue_url,
    anchors,
    authority: clone(authority),
  });
}
function admission(contract, environment) {
  const source = {
    installation_id: contract.authority.source_installation_id,
    project_id: contract.authority.source_project_id,
  };
  if (!environment.peers.some((peer) => sameIdentity(peer, source))) {
    fail("batch_request_source_peer_mismatch", "source is not an active environment binding");
  }
  return assertBatchRequestRegistered(contract, {
    resolveRegisteredRoute() {
      return {
        coordination_repo: environment.coordination_repo,
        source,
        target: environment.current,
        registered_repositories: environment.registered_repositories,
      };
    },
  });
}

// One deterministic reconciliation for one already-fetched Issue fixture.
// The caller owns durable compare-and-swap application of next_state and the
// single closed plan; this pure layer intentionally cannot deliver it itself.
function reconcileBatchRequestSubscription(input) {
  if (!plain(input)) fail("invalid_batch_request_subscription_input", "subscription input is invalid");
  exact(input, ["subscription", "state", "issue"], "invalid_batch_request_subscription_input");
  const state = normalizeSubscriptionState(input.state);
  let subscription;
  try { subscription = normalizeSubscription(input.subscription); }
  catch (error) {
    if (error instanceof BatchRequestSubscriptionError) return result(state, state.cursor, null, error.code);
    throw error;
  }
  if (subscription.archived) return result(state, state.cursor, null, "batch_request_subscription_archived");
  if (!subscription.enabled) return result(state, state.cursor, null, "batch_request_subscription_disabled");

  let fixture;
  try { fixture = normalizeIssueFixture(input.issue); }
  catch (error) {
    if (error instanceof BatchRequestSubscriptionError) return result(state, state.cursor, null, error.code);
    throw error;
  }
  let next = withCursor(state, fixture.cursor);
  if (fixture.is_pull_request) return result(next, fixture.cursor, null, "batch_request_pull_request_unsupported");
  if (!fixture.has_request_label) return result(next, fixture.cursor, null, "batch_request_label_missing");

  let environment;
  try { environment = normalizeEnvironment(subscription.environment); }
  catch (error) {
    if (error instanceof BatchRequestSubscriptionError) return result(next, fixture.cursor, null, error.code);
    throw error;
  }
  if (environment.coordination_repo !== fixture.repository) {
    return result(next, fixture.cursor, null, "batch_request_subscription_repository_mismatch");
  }

  let contract;
  try { contract = parseBatchRequestAuthority(fixture.body); }
  catch (error) {
    if (error instanceof BatchRequestContractError) return result(next, fixture.cursor, null, error.code);
    throw error;
  }
  const recordIndex = findRecord(next, fixture.repository, fixture.issue_number, contract.authority.request_id);
  if (recordIndex !== -1) {
    const previous = next.records[recordIndex];
    if (previous.status === "terminal_invalid") {
      return result(next, fixture.cursor, null, "batch_request_authority_terminal_invalid");
    }
    if (previous.authority_digest === contract.digest) {
      return result(next, fixture.cursor, null, "batch_request_duplicate");
    }
    // A request_id identifies one immutable authority.  Once its exact digest
    // was delivered, a later valid-but-different authority is terminal rather
    // than a second instruction, even if it subsequently changes back.
    next = replaceRecord(next, recordIndex, {
      ...previous,
      status: "terminal_invalid",
      mutated_digest: contract.digest,
    });
    return result(next, fixture.cursor, null, "batch_request_authority_mutated_after_delivery");
  }

  try { admission(contract, environment); }
  catch (error) {
    if (error instanceof BatchRequestContractError || error instanceof BatchRequestSubscriptionError) {
      return result(next, fixture.cursor, null, error.code);
    }
    throw error;
  }
  if (next.records.length >= MAX_RECORDS) {
    // Do not evict a durable idempotency record: losing one could re-announce
    // an old authority after restart.  A future explicit compaction policy may
    // define a safe terminal boundary, but this foundation fails closed.
    return result(next, fixture.cursor, null, "batch_request_subscription_capacity_exhausted");
  }
  const record = {
    coordination_repo: fixture.repository,
    issue_number: fixture.issue_number,
    request_id: contract.authority.request_id,
    authority_digest: contract.digest,
    dedupe_key: dedupeKey(fixture.repository, fixture.issue_number, contract.authority.request_id, contract.digest),
    status: "delivered",
    mutated_digest: null,
  };
  next = { version: VERSION, cursor: clone(fixture.cursor), records: [...next.records.map(clone), record] };
  return result(next, fixture.cursor, eventPlanFor(contract, fixture));
}

module.exports = {
  VERSION,
  REQUEST_LABEL,
  MAX_RECORDS,
  BatchRequestSubscriptionError,
  dedupeKey,
  normalizeSubscriptionState,
  reconcileBatchRequestSubscription,
};
