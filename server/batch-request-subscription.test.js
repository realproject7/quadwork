"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  VERSION,
  REQUEST_LABEL,
  reconcileBatchRequestSubscription,
} = require("./batch-request-subscription");

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE_INSTALLATION = "installation_source_123456";
const TARGET_INSTALLATION = "installation_target_123456";

function authority(overrides = {}) {
  return {
    schema: "quadwork-batch-request/v1",
    request_id: REQUEST_ID,
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
function body(value = authority(), prose = "Human-only context must not become authority.") {
  return `${prose}\n\n\`\`\`quadwork-batch-request\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n## Completion\nUntrusted completion context.`;
}
function environment(overrides = {}) {
  return {
    current: { installation_id: TARGET_INSTALLATION, project_id: "target-project" },
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
function issue(overrides = {}) {
  return {
    repository: "acme/coordination",
    issue_number: 73,
    issue_url: "https://api.github.com/repos/acme/coordination/issues/73",
    pull_request: null,
    labels: [REQUEST_LABEL, "operator-visible"],
    body: body(),
    etag: 'W/"first"',
    cursor: "issues:73:first",
    ...overrides,
  };
}
function input(overrides = {}) {
  return {
    subscription: { enabled: true, archived: false, environment: environment() },
    state: null,
    issue: issue(),
    ...overrides,
  };
}
function diagnostic(result) {
  return result.internal_diagnostics[0]?.code || null;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// A fully admitted Issue produces one closed, Head-only BATCH REQUEST plan.
// The plan carries the canonical contract but never the Issue's prose, URL,
// cursor, ETag, labels, or any private decision diagnostics.
{
  const result = reconcileBatchRequestSubscription(input());
  assert.equal(result.version, VERSION);
  assert.equal(result.event_plan.kind, "BATCH REQUEST");
  assert.deepEqual(result.event_plan.recipients, ["head"]);
  assert.equal(result.event_plan.authority.request_id, REQUEST_ID);
  assert.equal(result.event_plan.anchors.coordination_repo, "acme/coordination");
  assert.equal(result.next_state.records.length, 1);
  assert.equal(result.next_state.records[0].status, "delivered");
  ok(result.event_plan.correlation_key === result.next_state.records[0].dedupe_key,
    "delivery dedupe key pins canonical repository, Issue, request_id, and authority digest");
  ok(Object.isFrozen(result) && Object.isFrozen(result.next_state) && Object.isFrozen(result.event_plan) &&
     Object.isFrozen(result.event_plan.authority), "reconciliation output and its closed event plan are deeply frozen");
  assert.throws(() => result.next_state.records.push({}), TypeError);
  const serializedPlan = JSON.stringify(result.event_plan);
  ok(!/Human-only context|Untrusted completion|api\.github|issues:73:first|first|operator-visible|internal_diagnostics/.test(serializedPlan),
    "event plan retains no Issue prose, URL, label, ETag/cursor, or diagnostics");
}

// PR-shaped fixtures and unlabeled Issues are never interpreted as a batch
// request, even when their body has an otherwise valid authority fence.
{
  const pullRequest = reconcileBatchRequestSubscription(input({ issue: issue({ pull_request: { url: "https://example.invalid/pr/73" } }) }));
  assert.equal(pullRequest.event_plan, null);
  ok(diagnostic(pullRequest) === "batch_request_pull_request_unsupported", "pull request fixture cannot create a batch-request delivery");

  const unlabeled = reconcileBatchRequestSubscription(input({ issue: issue({ labels: ["triage"] }) }));
  assert.equal(unlabeled.event_plan, null);
  ok(diagnostic(unlabeled) === "batch_request_label_missing", "missing exact request label cannot create a delivery");
}

// Current route facts are re-proven for every new authority: the canonical
// repository, exact target identity, active source binding, and all work refs
// must still be registered locally.
{
  const missingRepository = reconcileBatchRequestSubscription(input({
    subscription: { enabled: true, archived: false, environment: environment({ registered_repositories: ["acme/coordination", "acme/web"] }) },
  }));
  assert.equal(missingRepository.event_plan, null);
  ok(diagnostic(missingRepository) === "batch_request_unregistered_repository", "removed registered work-ref repository fails closed");

  const targetMismatch = reconcileBatchRequestSubscription(input({
    subscription: { enabled: true, archived: false, environment: environment({ current: { installation_id: TARGET_INSTALLATION, project_id: "other-project" } }) },
  }));
  assert.equal(targetMismatch.event_plan, null);
  ok(diagnostic(targetMismatch) === "batch_request_target_identity_mismatch", "authority target must exactly match the current installation/project");

  const removedPeer = reconcileBatchRequestSubscription(input({
    subscription: { enabled: true, archived: false, environment: environment({ peers: [] }) },
  }));
  assert.equal(removedPeer.event_plan, null);
  ok(diagnostic(removedPeer) === "batch_request_source_peer_mismatch", "removed environment binding cannot authorize a source request");

  const wrongRepository = reconcileBatchRequestSubscription(input({
    subscription: { enabled: true, archived: false, environment: environment({ coordination_repository: { key: "coord", canonical_repository: "acme/other" }, registered_repositories: ["acme/other", "acme/web", "acme/api"] }) },
  }));
  assert.equal(wrongRepository.event_plan, null);
  ok(diagnostic(wrongRepository) === "batch_request_subscription_repository_mismatch", "subscription only admits its selected canonical coordination repository");
}

// Archive and explicit disable are pre-admission stops.  They do not parse or
// retain Issue body content and cannot re-enable a dormant local subscription.
{
  const archived = reconcileBatchRequestSubscription(input({
    subscription: { enabled: true, archived: true, environment: environment() },
  }));
  const disabled = reconcileBatchRequestSubscription(input({
    subscription: { enabled: false, archived: false, environment: environment() },
  }));
  assert.equal(archived.event_plan, null);
  assert.equal(disabled.event_plan, null);
  ok(diagnostic(archived) === "batch_request_subscription_archived" && diagnostic(disabled) === "batch_request_subscription_disabled",
    "archive and disabled subscription return typed private diagnostics with no plan");
}

// Restarting from durable state, ETag changes, and any edit outside the strict
// authority fence (including a completion append) do not create another Head
// wake-up.  The cursor can progress but the delivery record remains exact.
{
  const first = reconcileBatchRequestSubscription(input());
  const restarted = reconcileBatchRequestSubscription(input({
    state: clone(first.next_state),
    issue: issue({
      body: body(authority(), "Entirely different non-authoritative context"),
      etag: 'W/"second"',
      cursor: "issues:73:second",
    }),
  }));
  assert.equal(restarted.event_plan, null);
  assert.equal(restarted.next_state.records.length, 1);
  assert.equal(restarted.next_cursor.etag, 'W/"second"');
  ok(diagnostic(restarted) === "batch_request_duplicate", "restart, ETag, context, and completion-only edits deduplicate exactly");
}

// The request id is immutable after its first delivery.  A valid new digest
// for the same canonical repository/Issue/request id becomes terminal; even
// a later restoration of the original authority may not re-announce it.
{
  const first = reconcileBatchRequestSubscription(input());
  const mutated = reconcileBatchRequestSubscription(input({
    state: clone(first.next_state),
    issue: issue({ body: body(authority({ mode: "verification" })), etag: 'W/"mutated"', cursor: "issues:73:mutated" }),
  }));
  assert.equal(mutated.event_plan, null);
  assert.equal(mutated.next_state.records[0].status, "terminal_invalid");
  assert.notEqual(mutated.next_state.records[0].authority_digest, mutated.next_state.records[0].mutated_digest);
  ok(diagnostic(mutated) === "batch_request_authority_mutated_after_delivery", "post-delivery authority digest mutation is terminal and cannot dispatch");

  const restored = reconcileBatchRequestSubscription(input({
    state: clone(mutated.next_state),
    issue: issue({ etag: 'W/"restored"', cursor: "issues:73:restored" }),
  }));
  assert.equal(restored.event_plan, null);
  ok(diagnostic(restored) === "batch_request_authority_terminal_invalid", "terminal request id stays non-deliverable after an authority is restored");
}

// M2 purity guard: this is an injected-facts reconciliation seam, not a
// watcher/transport/router/client/filesystem implementation.
{
  const source = fs.readFileSync(path.join(__dirname, "batch-request-subscription.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|child_process|net)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|file-chat|project-monitor|config|github)["']\s*\)/);
  assert.doesNotMatch(source, /(?:fetch\s*\(|setInterval\s*\(|setTimeout\s*\(|startBatch|dispatchAgent|mutateLabel)/);
  ok(true, "module has no polling, transport, route, client, or filesystem dependency");
}

console.log(`\n${passed} passed`);
