"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  VERSION,
  BatchRequestWatcherError,
  createBatchRequestWatcher,
} = require("./batch-request-watcher");
const { REQUEST_LABEL } = require("./batch-request-subscription");

const TARGET_INSTALLATION = "installation_target_123456";
const SOURCE_INSTALLATION = "installation_source_123456";
const TARGET = { installation_id: TARGET_INSTALLATION, project_id: "target-project" };
const REQUEST_A = "550e8400-e29b-41d4-a716-446655440000";
const REQUEST_B = "650e8400-e29b-41d4-a716-446655440000";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function authority(overrides = {}) {
  return {
    schema: "quadwork-batch-request/v1",
    request_id: REQUEST_A,
    source_installation_id: SOURCE_INSTALLATION,
    source_project_id: "source-project",
    target_installation_id: TARGET_INSTALLATION,
    target_project_id: "target-project",
    coordination_repo: "acme/coordination",
    mode: "implementation",
    work_refs: ["acme/web#42", "acme/api#9"],
    start_policy: "next-available",
    ...overrides,
  };
}
function body(value = authority()) {
  return `Human-only prose must never become watcher authority.\n\n\`\`\`quadwork-batch-request\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
function environment(overrides = {}) {
  return {
    current: copy(TARGET),
    coordination_repository: { key: "coord", canonical_repository: "acme/coordination" },
    peers: [{
      installation_id: SOURCE_INSTALLATION,
      project_id: "source-project",
      label: "Source peer",
      environment_class: "vps",
    }],
    registered_repositories: ["acme/coordination", "acme/web", "acme/api"],
    ...overrides,
  };
}
function subscription(overrides = {}) {
  return {
    version: VERSION,
    target: copy(TARGET),
    enabled: true,
    archived: false,
    coordination_repository: "acme/coordination",
    request_label: REQUEST_LABEL,
    environment: environment(),
    ...overrides,
  };
}
function issue(number, overrides = {}) {
  return {
    repository: "acme/coordination",
    issue_number: number,
    issue_url: `https://api.github.com/repos/acme/coordination/issues/${number}`,
    pull_request: null,
    labels: [REQUEST_LABEL, "operator-visible"],
    body: body(),
    etag: `W/"issue-${number}"`,
    cursor: `issues:${number}`,
    ...overrides,
  };
}
function fetchResponse(issues, overrides = {}) {
  return {
    version: VERSION,
    target: copy(TARGET),
    coordination_repository: "acme/coordination",
    request_label: REQUEST_LABEL,
    issues,
    ...overrides,
  };
}
function input(state = null) { return { version: VERSION, target: copy(TARGET), state }; }
function code(fn, expected) {
  assert.throws(fn, (error) => error instanceof BatchRequestWatcherError && error.code === expected);
}
function diagnostic(result) { return result.internal_diagnostics[0]?.code || null; }
function watcher({ resolved = subscription(), fetched = fetchResponse([issue(73)]), onResolve, onFetch } = {}) {
  let resolveCalls = 0;
  let fetchCalls = 0;
  const value = createBatchRequestWatcher({
    resolveCanonicalSubscription(request) {
      resolveCalls += 1;
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(request, { version: VERSION, target: TARGET });
      if (onResolve) onResolve(request);
      return copy(resolved);
    },
    fetchIssueRecords(request) {
      fetchCalls += 1;
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(request, {
        version: VERSION,
        target: TARGET,
        coordination_repository: "acme/coordination",
        request_label: REQUEST_LABEL,
      });
      if (onFetch) onFetch(request);
      return copy(fetched);
    },
  });
  return { watcher: value, calls: () => ({ resolve: resolveCalls, fetch: fetchCalls }) };
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// Canonical accessors receive only the exact target/route request. One valid
// Issue creates one closed Head-only plan, with no source issue prose or
// transport capability carried into the result.
{
  const lane = watcher();
  const result = lane.watcher.reconcile(input());
  assert.deepEqual(lane.calls(), { resolve: 1, fetch: 1 });
  assert.equal(result.head_plan.kind, "BATCH REQUEST");
  assert.deepEqual(result.head_plan.recipients, ["head"]);
  assert.equal(result.processed, 1);
  assert.equal(result.next_state.records.length, 1);
  assert.deepEqual(Object.keys(result).sort(), ["head_plan", "internal_diagnostics", "next_state", "processed", "version"]);
  assert.equal(Object.isFrozen(result) && Object.isFrozen(result.head_plan) && Object.isFrozen(result.next_state), true);
  assert.throws(() => result.next_state.records.push({}), TypeError);
  const serialized = JSON.stringify(result.head_plan);
  assert.equal(/Human-only prose|operator-visible|issue-73|issues:73/.test(serialized), false);
  ok(true, "canonical accessors yield one immutable Head-only Batch Request payload with no worker dispatch data");
}

// Fetched order never chooses delivery order. The watcher uses canonical issue
// number order and stops at the first newly admitted Head plan, so a later
// valid request remains eligible for a deterministic next reconciliation.
{
  const firstIssue = issue(73, { body: body(authority({ request_id: REQUEST_A })) });
  const secondIssue = issue(74, { body: body(authority({ request_id: REQUEST_B })) });
  const lane = watcher({ fetched: fetchResponse([secondIssue, firstIssue]) });
  const first = lane.watcher.reconcile(input());
  assert.equal(first.head_plan.anchors.issue_number, 73);
  assert.equal(first.next_state.records.length, 1);
  const second = lane.watcher.reconcile(input(copy(first.next_state)));
  assert.equal(second.head_plan.anchors.issue_number, 74);
  assert.equal(second.next_state.records.length, 2);
  assert.equal(second.processed, 2);
  ok(true, "bounded reconciliation deduplicates the first durable request before emitting exactly one later Head plan");
}

// PR-shaped and unlabeled records are filtered through the existing strict
// subscription seam; they never prevent a later canonical Issue from being
// the sole emitted Head payload.
{
  const pullRequest = issue(70, { pull_request: { url: "https://api.github.com/repos/acme/coordination/pulls/70" } });
  const unlabeled = issue(71, { labels: ["triage"] });
  const admitted = issue(72);
  const result = watcher({ fetched: fetchResponse([admitted, pullRequest, unlabeled]) }).watcher.reconcile(input());
  assert.equal(result.head_plan.anchors.issue_number, 72);
  assert.equal(result.processed, 3);
  assert.equal(result.next_state.records.length, 1);
  ok(true, "PR-shaped and non-request-label records are ignored without worker routing while a later exact Issue remains eligible");
}

// Disabled or archived durable subscriptions are a pre-fetch barrier. A
// malformed/mismatched canonical accessor response cannot create a plan.
{
  const disabled = watcher({ resolved: subscription({ enabled: false }) });
  const disabledResult = disabled.watcher.reconcile(input());
  assert.equal(disabledResult.head_plan, null);
  assert.equal(diagnostic(disabledResult), "batch_request_subscription_disabled");
  assert.deepEqual(disabled.calls(), { resolve: 1, fetch: 0 });

  const archived = watcher({ resolved: subscription({ archived: true }) });
  const archivedResult = archived.watcher.reconcile(input());
  assert.equal(archivedResult.head_plan, null);
  assert.equal(diagnostic(archivedResult), "batch_request_subscription_archived");
  assert.deepEqual(archived.calls(), { resolve: 1, fetch: 0 });

  code(() => watcher({ resolved: subscription({ target: { installation_id: TARGET_INSTALLATION, project_id: "other-project" } }) }).watcher.reconcile(input()), "batch_request_watcher_target_mismatch");
  code(() => watcher({ resolved: subscription({ request_label: "other-label" }) }).watcher.reconcile(input()), "invalid_batch_request_watcher_subscription");
  ok(true, "disabled/archive and malformed canonical subscription inputs fail closed before a fetch or Head plan");
}

// Source peers, target identity, and every source repository are re-proven by
// the strict durable subscription state for each fetched authority.
{
  const removedPeer = watcher({ resolved: subscription({ environment: environment({ peers: [] }) }) }).watcher.reconcile(input());
  assert.equal(removedPeer.head_plan, null);
  assert.equal(diagnostic(removedPeer), "batch_request_source_peer_mismatch");

  const targetMismatch = watcher({ resolved: subscription({ environment: environment({ current: { installation_id: TARGET_INSTALLATION, project_id: "other-project" } }) }) }).watcher.reconcile(input());
  assert.equal(targetMismatch.head_plan, null);
  assert.equal(diagnostic(targetMismatch), "batch_request_target_identity_mismatch");

  const unregisteredRepository = watcher({ resolved: subscription({ environment: environment({ registered_repositories: ["acme/coordination", "acme/web"] }) }) }).watcher.reconcile(input());
  assert.equal(unregisteredRepository.head_plan, null);
  assert.equal(diagnostic(unregisteredRepository), "batch_request_unregistered_repository");
  ok(true, "exact target and active source-peer/registered-repository admission are re-proven for every watcher record");
}

// The underlying durable request identity is immutable. A valid-but-mutated
// authority for the same Issue/request id becomes terminal and cannot emit a
// replacement plan through this watcher.
{
  const lane = watcher();
  const first = lane.watcher.reconcile(input());
  const mutatedIssue = issue(73, { body: body(authority({ mode: "verification" })) });
  const mutatedLane = watcher({ fetched: fetchResponse([mutatedIssue]) });
  const mutated = mutatedLane.watcher.reconcile(input(copy(first.next_state)));
  assert.equal(mutated.head_plan, null);
  assert.equal(diagnostic(mutated), "batch_request_authority_mutated_after_delivery");
  assert.equal(mutated.next_state.records[0].status, "terminal_invalid");
  ok(true, "canonical digest mutation remains terminal in durable state and cannot create a second Head plan");
}

// Accessor output is bounded and tied to the one resolved coordination repo.
// A mismatch/unavailable accessor fails closed before a subscription mutation.
{
  code(() => watcher({ fetched: fetchResponse([issue(73, { repository: "acme/other" })]) }).watcher.reconcile(input()), "batch_request_watcher_repository_mismatch");
  code(() => watcher({ fetched: fetchResponse([], { request_label: "other-label" }) }).watcher.reconcile(input()), "invalid_batch_request_watcher_fetch");
  const unavailable = createBatchRequestWatcher({
    resolveCanonicalSubscription() { throw new Error("offline"); },
    fetchIssueRecords() { throw new Error("must not be called"); },
  });
  code(() => unavailable.reconcile(input()), "batch_request_watcher_subscription_unavailable");
  ok(true, "mismatched or unavailable accessor facts fail closed without GitHub, chat, monitor, or worker calls");
}

// M3 is a pure one-shot reconciliation boundary. It imports only the strict
// contract/subscription seam and contains no transport, filesystem, polling,
// route, scheduler, or worker-dispatch implementation.
{
  const source = fs.readFileSync(path.join(__dirname, "batch-request-watcher.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|child_process|net)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|file-chat|project-monitor|config|github)["']\s*\)/);
  assert.doesNotMatch(source, /(?:fetch\s*\(|setInterval\s*\(|setTimeout\s*\(|startBatch|dispatchAgent|mutateLabel)/);
  ok(true, "watcher core has no polling, transport, route, scheduler, or worker-dispatch dependency");
}

console.log(`\n${passed} watcher assertions passed`);
