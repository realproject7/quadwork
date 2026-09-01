"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  REQUEST_LABEL,
  reconcileBatchRequestSubscription,
} = require("./batch-request-subscription");
const {
  FILE_MODE,
  BatchRequestStateStoreError,
  assertBatchRequestStateStoreState,
  batchRequestStateStorePath,
  createBatchRequestStateStore,
} = require("./batch-request-state-store");

const installation_id = "installation_target_123456";
const project_id = "target-project";
const owner = { installation_id, project_id };
const source_installation_id = "installation_source_123456";
const request_id = "550e8400-e29b-41d4-a716-446655440000";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof BatchRequestStateStoreError && error.code === expected);
}
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-batch-request-store-"));
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function authority(overrides = {}) {
  return {
    schema: "quadwork-batch-request/v1",
    request_id,
    source_installation_id,
    source_project_id: "source-project",
    target_installation_id: installation_id,
    target_project_id: project_id,
    coordination_repo: "acme/coordination",
    mode: "implementation",
    work_refs: ["acme/web#42", "acme/api#9"],
    start_policy: "next-available",
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
    body: `\`\`\`quadwork-batch-request\n${JSON.stringify(authority())}\n\`\`\``,
    etag: 'W/"first"',
    cursor: "issues:73:first",
    ...overrides,
  };
}
function environment() {
  return {
    current: copy(owner),
    coordination_repository: { key: "coord", canonical_repository: "acme/coordination" },
    peers: [{ installation_id: source_installation_id, project_id: "source-project", label: "Source", environment_class: "vps" }],
    registered_repositories: ["acme/coordination", "acme/web", "acme/api"],
  };
}
function watcherResult(state, issueFixture = issue()) {
  const result = reconcileBatchRequestSubscription({
    subscription: { enabled: true, archived: false, environment: environment() },
    state,
    issue: issueFixture,
  });
  return {
    version: 1,
    next_state: result.next_state,
    head_plan: result.event_plan,
    processed: 1,
    internal_diagnostics: result.internal_diagnostics,
  };
}
function initialized(directory, options = {}) {
  const store = createBatchRequestStateStore({ config_dir: directory, fs: options.fs || fs });
  const state = store.initialize({ expected: { ...owner, revision: null }, subscription_state: options.subscription_state || { version: 1, cursor: null, records: [] } });
  return { store, state };
}

// Initialization is explicit, persisted at 0600, and a new store gets the
// same deep-frozen state back after a restart.
withDirectory((directory) => {
  const { store, state } = initialized(directory);
  const statePath = batchRequestStateStorePath(directory, owner);
  assert.equal(fs.statSync(statePath).mode & 0o777, FILE_MODE);
  assert.equal(state.revision, 0);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.subscription_state), true);
  const restarted = createBatchRequestStateStore({ config_dir: directory, fs });
  assert.deepEqual(restarted.readRecoverySnapshot(owner), state);
  assert.throws(() => state.subscription_state.records.push({}), TypeError);
  throwsCode(() => store.initialize({ expected: { ...owner, revision: null }, subscription_state: { version: 1, cursor: null, records: [] } }), "batch_request_state_store_already_initialized");
});

// A durable transition returns its Head plan only after the backing delivered
// record is persisted. An ambiguous retry has a stale revision, and a fresh
// reconciliation from the stored record emits no duplicate plan.
withDirectory((directory) => {
  const { store, state } = initialized(directory);
  const first = watcherResult(state.subscription_state);
  assert.notEqual(first.head_plan, null);
  const applied = store.applyWatcherResult({ expected: { ...owner, revision: 0 }, result: first });
  assert.equal(applied.persisted, true);
  assert.equal(applied.snapshot.revision, 1);
  assert.equal(applied.snapshot.subscription_state.records.length, 1);
  assert.equal(applied.head_plan.correlation_key, applied.snapshot.subscription_state.records[0].dedupe_key);
  throwsCode(() => store.applyWatcherResult({ expected: { ...owner, revision: 0 }, result: first }), "stale_batch_request_state_store_revision");
  const recovered = store.readRecoverySnapshot(owner);
  const retry = watcherResult(recovered.subscription_state);
  assert.equal(retry.head_plan, null);
  const noChange = store.applyWatcherResult({ expected: { ...owner, revision: 1 }, result: retry });
  assert.equal(noChange.persisted, false);
  assert.equal(noChange.head_plan, null);
  assert.equal(noChange.snapshot.revision, 1);
});

// A failed atomic rename cannot manufacture a delivery: the old revision is
// still readable and an ordinary retry is the only way to obtain a plan.
withDirectory((directory) => {
  const { store, state } = initialized(directory);
  const result = watcherResult(state.subscription_state);
  const failingFs = Object.create(fs);
  failingFs.renameSync = (from, to) => {
    if (String(to).endsWith(".json")) {
      const error = new Error("injected rename failure");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const failingStore = createBatchRequestStateStore({ config_dir: directory, fs: failingFs });
  throwsCode(() => failingStore.applyWatcherResult({ expected: { ...owner, revision: 0 }, result }), "batch_request_state_store_write_failed");
  assert.deepEqual(store.readRecoverySnapshot(owner), state);
  const files = fs.readdirSync(path.dirname(batchRequestStateStorePath(directory, owner)));
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
  assert.equal(store.applyWatcherResult({ expected: { ...owner, revision: 0 }, result }).head_plan.kind, "BATCH REQUEST");
});

// The store validates the complete watcher result before writing. A generic
// caller cannot replay a Head plan without the one new delivered record that
// binds its canonical authority and correlation key.
withDirectory((directory) => {
  const { store, state } = initialized(directory);
  const result = watcherResult(state.subscription_state);
  const malformed = copy(result);
  malformed.head_plan.recipients = ["worker"];
  throwsCode(() => store.applyWatcherResult({ expected: { ...owner, revision: 0 }, result: malformed }), "invalid_batch_request_state_store_result");
  const replay = copy(result);
  replay.next_state = copy(state.subscription_state);
  throwsCode(() => store.applyWatcherResult({ expected: { ...owner, revision: 0 }, result: replay }), "invalid_batch_request_state_store_result");
  assert.deepEqual(store.readRecoverySnapshot(owner), state);
});

// Missing, corrupt, unknown-schema, foreign, insecure, and over-bound state
// all fail closed; none is treated as a permission to reset a subscription.
withDirectory((directory) => {
  const store = createBatchRequestStateStore({ config_dir: directory, fs });
  const clean = { version: 1, cursor: null, records: [] };
  throwsCode(() => store.readRecoverySnapshot(owner), "batch_request_state_store_missing");
  throwsCode(() => store.applyWatcherResult({ expected: { ...owner, revision: 0 }, result: watcherResult(clean) }), "batch_request_state_store_missing");
  const statePath = batchRequestStateStorePath(directory, owner);
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, "{not-json", { encoding: "utf8", mode: FILE_MODE });
  throwsCode(() => store.readRecoverySnapshot(owner), "corrupt_batch_request_state_store");
  throwsCode(() => store.initialize({ expected: { ...owner, revision: null }, subscription_state: clean }), "corrupt_batch_request_state_store");
  assert.equal(fs.readFileSync(statePath, "utf8"), "{not-json");
  fs.writeFileSync(statePath, JSON.stringify({ schema_version: 2 }), { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  fs.chmodSync(statePath, FILE_MODE);
  throwsCode(() => store.readRecoverySnapshot(owner), "unknown_batch_request_state_store_schema");
  fs.chmodSync(statePath, 0o644);
  throwsCode(() => store.readRecoverySnapshot(owner), "batch_request_state_store_insecure_permissions");
});

withDirectory((directory) => {
  const foreign = {
    schema_version: 1,
    identity: { installation_id, project_id: "other-project" },
    revision: 0,
    subscription_state: { version: 1, cursor: null, records: [] },
  };
  assert.equal(assertBatchRequestStateStoreState(foreign), foreign);
  const statePath = batchRequestStateStorePath(directory, owner);
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, JSON.stringify(foreign), { encoding: "utf8", mode: FILE_MODE });
  throwsCode(() => createBatchRequestStateStore({ config_dir: directory, fs }).readRecoverySnapshot(owner), "batch_request_state_store_identity_mismatch");

  const boundedRoot = path.join(directory, "bounded");
  const excessive = { version: 1, cursor: null, records: Array.from({ length: 129 }, () => ({})) };
  throwsCode(() => createBatchRequestStateStore({ config_dir: boundedRoot, fs }).initialize({ expected: { ...owner, revision: null }, subscription_state: excessive }), "invalid_batch_request_state_store_initialization");
});

// lstat, rather than stat, protects every trusted pathname from redirection.
withDirectory((directory) => {
  const clean = { version: 1, cursor: null, records: [] };
  const realRoot = path.join(directory, "real-root");
  const rootLink = path.join(directory, "root-link");
  fs.mkdirSync(realRoot, { mode: 0o700 });
  fs.symlinkSync(realRoot, rootLink);
  throwsCode(() => createBatchRequestStateStore({ config_dir: rootLink, fs }).initialize({ expected: { ...owner, revision: null }, subscription_state: clean }), "batch_request_state_store_symlink_rejected");

  const storageRoot = path.join(directory, "storage-root");
  const outsideStorage = path.join(directory, "outside-storage");
  fs.mkdirSync(storageRoot, { mode: 0o700 });
  fs.mkdirSync(outsideStorage, { mode: 0o700 });
  fs.symlinkSync(outsideStorage, path.join(storageRoot, "batch-request-watchers"));
  throwsCode(() => createBatchRequestStateStore({ config_dir: storageRoot, fs }).initialize({ expected: { ...owner, revision: null }, subscription_state: clean }), "batch_request_state_store_symlink_rejected");

  const outsideRoot = path.join(directory, "outside-root");
  initialized(outsideRoot);
  const outsidePath = batchRequestStateStorePath(outsideRoot, owner);
  const linkedRoot = path.join(directory, "linked-file-root");
  const linkedPath = batchRequestStateStorePath(linkedRoot, owner);
  fs.mkdirSync(path.dirname(linkedPath), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outsidePath, linkedPath);
  throwsCode(() => createBatchRequestStateStore({ config_dir: linkedRoot, fs }).readRecoverySnapshot(owner), "batch_request_state_store_symlink_rejected");
});

// A swap in the lstat/open gap is also rejected: recovery reads from the
// checked descriptor and re-proves the pathname still names that same file.
withDirectory((directory) => {
  initialized(directory);
  const outsideRoot = path.join(directory, "outside-root");
  initialized(outsideRoot);
  const statePath = batchRequestStateStorePath(directory, owner);
  const outsidePath = batchRequestStateStorePath(outsideRoot, owner);
  let replaced = false;
  const racingFs = Object.create(fs);
  racingFs.openSync = (target, flags, ...rest) => {
    if (!replaced && target === statePath && flags === "r") {
      replaced = true;
      fs.unlinkSync(statePath);
      fs.symlinkSync(outsidePath, statePath);
    }
    return fs.openSync(target, flags, ...rest);
  };
  throwsCode(() => createBatchRequestStateStore({ config_dir: directory, fs: racingFs }).readRecoverySnapshot(owner), "batch_request_state_store_symlink_rejected");
  assert.equal(replaced, true);
  assert.equal(fs.lstatSync(statePath).isSymbolicLink(), true);
});

// A lock that is replaced before release remains in place. The first writer
// fails closed instead of unlinking a different writer's lock inode.
withDirectory((directory) => {
  const { state } = initialized(directory);
  const result = watcherResult(state.subscription_state);
  const statePath = batchRequestStateStorePath(directory, owner);
  const lockPath = `${statePath}.lock`;
  let inspections = 0;
  const replacingFs = Object.create(fs);
  replacingFs.lstatSync = (target) => {
    if (target === lockPath) {
      inspections += 1;
      if (inspections === 2) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, "replacement-writer-lock", { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      }
    }
    return fs.lstatSync(target);
  };
  const store = createBatchRequestStateStore({ config_dir: directory, fs: replacingFs });
  throwsCode(() => store.applyWatcherResult({ expected: { ...owner, revision: 0 }, result }), "batch_request_state_store_lock_release_failed");
  assert.equal(inspections, 2);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement-writer-lock");
});

console.log("batch-request-state-store tests passed");
