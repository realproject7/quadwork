"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REQUEST_LABEL } = require("./batch-request-subscription");
const { createBatchRequestStateStore } = require("./batch-request-state-store");
const {
  VERSION,
  BatchRequestRuntimeError,
  createBatchRequestRuntime,
} = require("./batch-request-runtime");

const TARGET = { installation_id: "installation_target_123456", project_id: "target-project" };
const SOURCE_INSTALLATION = "installation_source_123456";
const REQUEST_A = "550e8400-e29b-41d4-a716-446655440000";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
async function code(fn, expected) {
  await assert.rejects(fn, (error) => error instanceof BatchRequestRuntimeError && error.code === expected);
}
async function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-batch-request-runtime-"));
  try { return await run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function authority(overrides = {}) {
  return {
    schema: "quadwork-batch-request/v1",
    request_id: REQUEST_A,
    source_installation_id: SOURCE_INSTALLATION,
    source_project_id: "source-project",
    target_installation_id: TARGET.installation_id,
    target_project_id: TARGET.project_id,
    coordination_repo: "acme/coordination",
    mode: "implementation",
    work_refs: ["acme/web#42", "acme/api#9"],
    start_policy: "next-available",
    ...overrides,
  };
}
function body(value = authority()) {
  return `Ignored human-only prose.\n\n\`\`\`quadwork-batch-request\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
function environment(overrides = {}) {
  return {
    current: copy(TARGET),
    coordination_repository: { key: "coord", canonical_repository: "acme/coordination" },
    peers: [{
      installation_id: SOURCE_INSTALLATION,
      project_id: "source-project",
      label: "Source",
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
function issue(overrides = {}) {
  return {
    repository: "acme/coordination",
    issue_number: 73,
    issue_url: "https://api.github.com/repos/acme/coordination/issues/73",
    pull_request: null,
    labels: [REQUEST_LABEL],
    body: body(),
    etag: 'W/"first"',
    cursor: "issues:73:first",
    ...overrides,
  };
}
function issueResponse(request, issues = [issue()], overrides = {}) {
  return {
    version: VERSION,
    target: copy(TARGET),
    coordination_repository: "acme/coordination",
    request_label: REQUEST_LABEL,
    cache: copy(request.cache),
    issues: copy(issues),
    ...overrides,
  };
}
function input() { return { version: VERSION, target: copy(TARGET) }; }
function runtime(directory, options = {}) {
  const stateStore = options.stateStore || createBatchRequestStateStore({ config_dir: directory, fs });
  const calls = { subscription: 0, issue: 0, delivery: 0, caches: [], notifications: [] };
  const value = createBatchRequestRuntime({
    stateStore,
    resolveCanonicalSubscription(request) {
      calls.subscription += 1;
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(request, { version: VERSION, target: TARGET });
      return copy(options.subscription || subscription());
    },
    readCoordinationIssues(request) {
      calls.issue += 1;
      calls.caches.push(copy(request.cache));
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(Object.keys(request).sort(), ["cache", "coordination_repository", "request_label", "target", "version"]);
      assert.equal(request.coordination_repository, "acme/coordination");
      assert.equal(request.request_label, REQUEST_LABEL);
      if (options.onIssueRead) return options.onIssueRead(request, calls);
      return issueResponse(request, options.issues || [issue()]);
    },
    deliverHeadNotification(request) {
      calls.delivery += 1;
      calls.notifications.push(request);
      assert.equal(Object.isFrozen(request), true);
      if (options.onDelivery) return options.onDelivery(request, calls);
      return { version: VERSION, accepted: true };
    },
  });
  return { runtime: value, stateStore, calls };
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

async function main() {

// Explicit initialization and recovery bind only a project identity and
// durable counters. A recreated runtime sees the same store without a new
// notification opportunity.
await withDirectory(async (directory) => {
  const first = runtime(directory);
  const initialized = first.runtime.initialize(input());
  assert.deepEqual(initialized, {
    version: VERSION,
    snapshot: { revision: 0, record_count: 0, has_cursor: false },
    persisted: true,
    delivery: "none",
    diagnostics: [],
  });
  assert.equal(Object.isFrozen(initialized) && Object.isFrozen(initialized.snapshot), true);
  const restarted = runtime(directory);
  assert.deepEqual(restarted.runtime.recover(input()), {
    version: VERSION,
    snapshot: { revision: 0, record_count: 0, has_cursor: false },
    persisted: false,
    delivery: "none",
    diagnostics: [],
  });
  ok(true, "initialization and restart recovery expose only bounded durable progress");
});

// The Head callback receives the closed immutable plan only after the state
// store applies the exact CAS result. A duplicate reconciliation has no plan
// and therefore cannot notify Head a second time.
await withDirectory(async (directory) => {
  const lane = runtime(directory, {
    async onIssueRead(request) {
      return issueResponse(request, [issue()]);
    },
    async onDelivery(request) {
      assert.deepEqual(Object.keys(request).sort(), ["notification", "target", "version"]);
      assert.equal(request.notification.kind, "BATCH REQUEST");
      assert.deepEqual(request.notification.recipients, ["head"]);
      assert.equal(/Ignored human-only prose|W\/|issues:/.test(JSON.stringify(request)), false);
      return { version: VERSION, accepted: true };
    },
  });
  lane.runtime.initialize(input());
  const first = await lane.runtime.reconcile(input());
  assert.equal(first.snapshot.revision, 1);
  assert.equal(first.persisted, true);
  assert.equal(first.delivery, "delivered");
  assert.deepEqual(first.diagnostics, []);
  const duplicate = await lane.runtime.reconcile(input());
  assert.equal(duplicate.delivery, "none");
  assert.equal(duplicate.persisted, false);
  assert.equal(lane.calls.delivery, 1);
  ok(true, "CAS precedes one immutable exact Head-only notification and the durable record blocks a duplicate");
});

// The callback may have accepted a notification before reporting an error.
// The runtime commits first and then treats that boundary as at-most-once:
// after ambiguity it does not issue an automatic replacement notification.
await withDirectory(async (directory) => {
  const failing = runtime(directory, {
    async onDelivery() { throw new Error("transport ended after write"); },
  });
  failing.runtime.initialize(input());
  await code(() => failing.runtime.reconcile(input()), "batch_request_notification_delivery_ambiguous");
  assert.equal(failing.calls.delivery, 1);
  assert.deepEqual(failing.runtime.recover(input()).snapshot, { revision: 1, record_count: 1, has_cursor: true });
  const restarted = runtime(directory);
  const retry = await restarted.runtime.reconcile(input());
  assert.equal(retry.delivery, "none");
  assert.equal(restarted.calls.delivery, 0);
  ok(true, "a failed callback is typed as delivery ambiguity and durable state prevents automatic redelivery");
});

// Promise rejection at the Issue-read boundary happens before the CAS, while
// an invalid asynchronous delivery acknowledgement happens after it. Both are
// explicitly fail-closed, and neither path schedules a second callback.
await withDirectory(async (directory) => {
  const unavailableRead = runtime(directory, {
    async onIssueRead() { throw new Error("conditional read unavailable"); },
  });
  unavailableRead.runtime.initialize(input());
  await code(() => unavailableRead.runtime.reconcile(input()), "batch_request_runtime_issue_read_unavailable");
  assert.equal(unavailableRead.calls.issue, 1);
  assert.equal(unavailableRead.calls.delivery, 0);
  assert.deepEqual(unavailableRead.runtime.recover(input()).snapshot, { revision: 0, record_count: 0, has_cursor: false });

  const invalidDelivery = runtime(path.join(directory, "invalid-delivery"), {
    async onDelivery() { return { version: VERSION, accepted: false }; },
  });
  invalidDelivery.runtime.initialize(input());
  await code(() => invalidDelivery.runtime.reconcile(input()), "batch_request_notification_delivery_ambiguous");
  assert.equal(invalidDelivery.calls.delivery, 1);
  const afterInvalid = runtime(path.join(directory, "invalid-delivery"));
  assert.equal((await afterInvalid.runtime.reconcile(input())).delivery, "none");
  assert.equal(afterInvalid.calls.delivery, 0);
  ok(true, "async read rejection and invalid async delivery acknowledgement cannot create duplicate transport calls");
});

// A concurrent writer makes the CAS stale before notification. The callback
// does not run, and the newly durable record still prevents a later replay.
await withDirectory(async (directory) => {
  const base = createBatchRequestStateStore({ config_dir: directory, fs });
  const racingStore = {
    initialize: base.initialize,
    readRecoverySnapshot: base.readRecoverySnapshot,
    applyWatcherResult(inputValue) {
      base.applyWatcherResult(inputValue);
      return base.applyWatcherResult(inputValue);
    },
  };
  const lane = runtime(directory, { stateStore: racingStore });
  lane.runtime.initialize(input());
  await assert.rejects(() => lane.runtime.reconcile(input()), (error) => error && error.code === "stale_batch_request_state_store_revision");
  assert.equal(lane.calls.delivery, 0);
  const recovered = runtime(directory);
  assert.equal((await recovered.runtime.reconcile(input())).delivery, "none");
  assert.equal(recovered.calls.delivery, 0);
  ok(true, "stale CAS fails before any Head callback and cannot be replayed after recovery");
});

// Each pre-delivery negative is fail-closed. Archive and disabled facts avoid
// the issue read entirely; a PR-shaped record may advance only its durable
// cursor and never reaches the Head transport.
await withDirectory(async (directory) => {
  const archived = runtime(directory, { subscription: subscription({ archived: true }) });
  archived.runtime.initialize(input());
  const archivedResult = await archived.runtime.reconcile(input());
  assert.equal(archivedResult.diagnostics[0].code, "batch_request_subscription_archived");
  assert.deepEqual(archived.calls, { subscription: 1, issue: 0, delivery: 0, caches: [], notifications: [] });

  const disabled = runtime(path.join(directory, "disabled"), { subscription: subscription({ enabled: false }) });
  disabled.runtime.initialize(input());
  const disabledResult = await disabled.runtime.reconcile(input());
  assert.equal(disabledResult.diagnostics[0].code, "batch_request_subscription_disabled");
  assert.equal(disabled.calls.issue, 0);

  const pullRequest = runtime(path.join(directory, "pr"), { issues: [issue({ pull_request: { url: "https://api.github.com/repos/acme/coordination/pulls/73" } })] });
  pullRequest.runtime.initialize(input());
  const prResult = await pullRequest.runtime.reconcile(input());
  assert.equal(prResult.diagnostics[0].code, "batch_request_pull_request_unsupported");
  assert.equal(prResult.delivery, "none");
  assert.equal(pullRequest.calls.delivery, 0);
  ok(true, "archived, disabled, and PR-shaped inputs do no Head delivery");
});

// Canonical accessors cannot change the target, repository, label, or cached
// request context. The adapter strips the cache echo before the pure watcher.
await withDirectory(async (directory) => {
  const mismatchedSubscription = runtime(directory, { subscription: subscription({ target: { installation_id: TARGET.installation_id, project_id: "other-project" } }) });
  mismatchedSubscription.runtime.initialize(input());
  await assert.rejects(() => mismatchedSubscription.runtime.reconcile(input()), (error) => error && error.code === "batch_request_watcher_target_mismatch");
  assert.equal(mismatchedSubscription.calls.issue, 0);

  const malformedRead = runtime(path.join(directory, "malformed"), {
    onIssueRead(request) { return issueResponse(request, [issue()], { cache: { etag: "other", cursor: null } }); },
  });
  malformedRead.runtime.initialize(input());
  await assert.rejects(() => malformedRead.runtime.reconcile(input()), (error) => error && error.code === "invalid_batch_request_runtime_issue_read");
  assert.equal(malformedRead.calls.delivery, 0);
  ok(true, "identity and cache/context mutations fail closed before durable application or notification");
});

// An ETag/cursor-only edit is supplied through the one fixed-label issue read
// with its previous cache fact. It updates durable cursor state but retains the
// delivered authority record and cannot emit another Head notification.
await withDirectory(async (directory) => {
  let revision = 0;
  const lane = runtime(directory, {
    onIssueRead(request) {
      if (revision === 0) return issueResponse(request, [issue()]);
      assert.deepEqual(request.cache, { etag: 'W/"first"', cursor: "issues:73:first" });
      return issueResponse(request, [issue({ etag: 'W/"edited"', cursor: "issues:73:edited" })]);
    },
  });
  lane.runtime.initialize(input());
  assert.equal((await lane.runtime.reconcile(input())).delivery, "delivered");
  revision = 1;
  const contextOnly = await lane.runtime.reconcile(input());
  assert.equal(contextOnly.delivery, "none");
  assert.equal(contextOnly.persisted, true);
  assert.equal(contextOnly.diagnostics[0].code, "batch_request_duplicate");
  assert.equal(lane.calls.delivery, 1);
  ok(true, "ETag/cache-only context edits are deduplicated without a second Head notification");
});

// The request id represents immutable authority. A digest mutation becomes a
// durable terminal record; it cannot replace a notification already admitted.
await withDirectory(async (directory) => {
  let changed = false;
  const lane = runtime(directory, {
    onIssueRead(request) {
      return issueResponse(request, [changed ? issue({ body: body(authority({ mode: "verification" })), etag: 'W/"mutated"', cursor: "issues:73:mutated" }) : issue()]);
    },
  });
  lane.runtime.initialize(input());
  assert.equal((await lane.runtime.reconcile(input())).delivery, "delivered");
  changed = true;
  const mutated = await lane.runtime.reconcile(input());
  assert.equal(mutated.delivery, "none");
  assert.equal(mutated.diagnostics[0].code, "batch_request_authority_mutated_after_delivery");
  assert.equal(lane.calls.delivery, 1);
  ok(true, "mutated authority is terminal and cannot produce a replacement Head notification");
});

// This M7 adapter stays a composition boundary: no direct filesystem, route,
// chat, GitHub, monitor, transport-client, scheduler, or worker control.
{
  const source = fs.readFileSync(path.join(__dirname, "batch-request-runtime.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|child_process|net)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|file-chat|mcp-chat-shim|project-monitor|config|github)["']\s*\)/);
  assert.doesNotMatch(source, /(?:setInterval\s*\(|setTimeout\s*\(|startBatch|dispatchAgent|mutateLabel|process\.exit)/);
  ok(true, "runtime has no scheduler, direct transport, route, chat, filesystem, or worker-control dependency");
}

console.log(`\n${passed} runtime assertions passed`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
