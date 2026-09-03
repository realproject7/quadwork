"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");
const { DeliveryCandidateStoreError, createDeliveryCandidateStore } = require("./delivery-candidate-store");
const {
  DeliveryCompositionServiceError,
  createDeliveryCompositionService,
} = require("./delivery-composition-service");

const VERSION = 1;
const INSTALLATION = "installation_service_1060";
const PROJECT = "quadwork";
const BINDING = Object.freeze({ installation_id: INSTALLATION, project_id: PROJECT, role: "head", generation: 17 });
const REPOSITORY = "owner/product-web";
const BASE_SHA = "a".repeat(64);
const RESULT_SHA = "b".repeat(64);
const BASE_TREE = "c".repeat(64);
const RESULT_TREE = "d".repeat(64);
const WORK_SHA = "e".repeat(64);
const WORK_TREE = "f".repeat(64);
const ISSUE = { repoKey: "web", repo: "Owner/Product-Web", number: 1060, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function stable(value) {
  return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
}
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof DeliveryCompositionServiceError && error.code === code);
}
function entry(pathName, blob_sha) { return { path: pathName, mode: "100644", blob_sha }; }
function tree(tree_sha, entries) { return { tree_sha, entries: entries.map(copy).sort((a, b) => a.path.localeCompare(b.path)) }; }
function entryMap(value) { return new Map(value.entries.map((item) => [item.path, item])); }
function sameEntry(left, right) { return left === null ? right === null : right !== null && stable(left) === stable(right); }
function changed(base, result) {
  const before = entryMap(base), after = entryMap(result);
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((pathName) => ({
    path: pathName, before: before.get(pathName) || null, after: after.get(pathName) || null,
  })).filter((item) => !sameEntry(item.before, item.after));
}
function patch(scope, base_sha, result_sha, base, result, source_worktree_path) {
  const files = changed(base, result).map((file) => ({
    ...file,
    binary_delta: `GIT binary patch\nliteral ${file.path} ${file.after ? file.after.blob_sha : "delete"}`,
  }));
  const payload = {
    version: VERSION, format: "git_full_index_binary_v1", scope, base_sha, result_sha,
    base_tree_sha: base.tree_sha, result_tree_sha: result.tree_sha, source_worktree_path, files,
  };
  return { ...payload, patch_digest: digest(payload) };
}
function frozenBatch() {
  return freezeBatchManifest(buildBatchManifest({
    version: VERSION, installation_id: INSTALLATION, project_id: PROJECT, delivery_mode: "integrated",
    tasks: [{
      task_key: "compose-1060", repository_key: "web", work_item: copy(ISSUE), goal: "compose exactly one delivery candidate",
      file_boundary: ["server/composed.js"], validation: ["node:test"], dependencies: [],
    }],
  }, {
    resolveRegisteredIdentity(request) {
      return {
        installation_id: request.installation_id, project_id: request.project_id, repository_key: request.repository_key,
        work_item: copy(request.work_item), issue_body_revision: "1".repeat(64),
      };
    },
  }), "2026-09-02T00:00:00.000Z");
}
function candidate(ref) {
  return buildWorkTaskCandidate({
    version: VERSION, work_task_ref: copy(ref), base_sha: BASE_SHA, candidate_sha: WORK_SHA,
    branch: "task/compose-1060", worktree: { repository_key: "web", worktree_id: "wt-compose", path: "/var/folders/quadwork/wt-compose" },
  }, {
    canonicalizePath(request) { return { version: VERSION, canonical_path: request.path.replace("/var/", "/private/var/") }; },
    inspectManagedWorktree() {
      return {
        version: VERSION, registered: true, readable: true, repository_key: "web", worktree_id: "wt-compose",
        canonical_path: "/private/var/folders/quadwork/wt-compose", branch: "task/compose-1060",
        base_sha: BASE_SHA, head_sha: WORK_SHA, dirty: false, occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() { return { version: VERSION, installation_id: INSTALLATION, project_id: PROJECT, v1_state: "present" }; },
  });
}
function receipt(ref, reviewer_role, generation) {
  const payload = { version: VERSION, review_round_ref: copy(ref), receipt_id: `receipt-${reviewer_role}-1060`, verdict: "approve", findings: [] };
  return { ...payload, receipt_digest: digest(payload) };
}
function releasedRound(workCandidate) {
  const opened = openTaskReviewRound({
    version: VERSION, candidate: workCandidate, attempt: "attempt-1060", round: 1, opened_at: "2026-09-02T00:01:00.000Z",
  }, { version: VERSION, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 2 }] });
  const one = submitTaskReviewReceipt(opened, receipt(opened.review_round_ref, "re1", 1), {
    version: VERSION, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T00:02:00.000Z",
  });
  return submitTaskReviewReceipt(one.round, receipt(opened.review_round_ref, "re2", 2), {
    version: VERSION, reviewer_role: "re2", reviewer_generation: 2, received_at: "2026-09-02T00:03:00.000Z",
  }).round;
}
function fixture() {
  const batch = frozenBatch();
  const work = candidate(batch.tasks[0].ref);
  const base = tree(BASE_TREE, [entry("README.md", "1".repeat(64)), entry("server/composed.js", "2".repeat(64))]);
  const workTree = tree(WORK_TREE, [entry("README.md", "1".repeat(64)), entry("server/composed.js", "3".repeat(64))]);
  const result = tree(RESULT_TREE, [entry("README.md", "1".repeat(64)), entry("server/composed.js", "3".repeat(64))]);
  const ref = {
    version: VERSION, installation_id: INSTALLATION, project_id: PROJECT, repository_key: "web",
    batch_manifest_digest: batch.manifest_digest, delivery_mode: "integrated", base_sha: BASE_SHA, result_sha: RESULT_SHA, cut_id: "cut-1060",
  };
  const workPatch = patch("candidate", BASE_SHA, WORK_SHA, base, workTree, work.managed_worktree.canonical_path);
  const deliveryPatch = patch("delivery", BASE_SHA, RESULT_SHA, base, result, null);
  const paths = ["server/composed.js"];
  const manifest = buildDeliveryManifest({
    version: VERSION, delivery_candidate_ref: ref, frozen_batch_manifest: batch,
    staged_tasks: [{ candidate: work, review_round: releasedRound(work) }], deferred_exclusions: [],
    evidence: {
      boundary: { paths, boundary_digest: digest({ version: VERSION, paths }) },
      patch: { base_sha: BASE_SHA, result_sha: RESULT_SHA, patch_digest: deliveryPatch.patch_digest },
      tree: { base_tree_sha: BASE_TREE, result_tree_sha: RESULT_TREE, tree_digest: digest({ version: VERSION, base_tree_sha: BASE_TREE, result_tree_sha: RESULT_TREE }) },
    },
  }, {
    resolveRegisteredRepository(request) {
      return { version: VERSION, installation_id: request.installation_id, project_id: request.project_id, repository_key: request.repository_key, repository: "Owner/Product-Web" };
    },
  });
  return {
    manifest,
    trees: new Map([[BASE_TREE, base], [WORK_TREE, workTree], [RESULT_TREE, result]]),
    commits: new Map([[BASE_SHA, BASE_TREE], [WORK_SHA, WORK_TREE], [RESULT_SHA, RESULT_TREE]]),
    workPatch,
    deliveryPatch,
  };
}
function operations(value, events, options = {}) {
  function object(name, callback) {
    return (request) => { events.push(`object:${name}`); return callback(request); };
  }
  return {
    readCommit: object("readCommit", (request) => ({ version: VERSION, repository: REPOSITORY, sha: request.sha, tree_sha: value.commits.get(request.sha) })),
    readTree: object("readTree", (request) => {
      const found = value.trees.get(request.tree_sha);
      return { version: VERSION, repository: REPOSITORY, tree_sha: request.tree_sha, entries: found ? copy(found.entries) : [] };
    }),
    readReviewedTask: object("readReviewedTask", (request) => {
      const stage = value.manifest.staged_tasks[request.sequence - 1];
      return {
        version: VERSION, work_task_ref: copy(stage.work_task_ref), candidate_digest: stage.candidate.candidate_digest,
        base_sha: stage.candidate.base_sha, candidate_sha: stage.candidate.candidate_sha,
        terminal_review: copy(stage.terminal_review), source_worktree_path: stage.candidate.managed_worktree.canonical_path,
      };
    }),
    readCandidatePatch: object("readCandidatePatch", () => options.bad_patch ? null : copy(value.workPatch)),
    readDeliveryPatch: object("readDeliveryPatch", () => copy(value.deliveryPatch)),
    applyPatch: object("applyPatch", (request) => ({
      version: VERSION, scope: request.scope, status: "applied", input_tree_sha: request.input_tree_sha,
      result_tree_sha: request.scope === "composition" ? request.expected_result_tree_sha : request.patch.result_tree_sha,
      applied_patch_digest: request.patch.patch_digest,
    })),
  };
}
function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-delivery-composition-"));
  fs.chmodSync(value, 0o700);
  return value;
}
function service(directoryValue, value, events, settings = {}) {
  const actual = createDeliveryCandidateStore({ config_dir: directoryValue, fs });
  const storeCalls = { read: 0, initialize: 0, record: 0 };
  const candidate_store = {
    readSnapshot(ref) { storeCalls.read += 1; events.push("store:read"); return actual.readSnapshot(ref); },
    initialize(input) { storeCalls.initialize += 1; events.push("store:initialize"); return actual.initialize(input); },
    recordComposed(input) {
      storeCalls.record += 1;
      events.push("store:record");
      if (settings.record_failure) throw new DeliveryCandidateStoreError(settings.record_failure);
      return actual.recordComposed(input);
    },
  };
  let archived = settings.archived === true;
  const core = createDeliveryCompositionService({
    binding: BINDING,
    candidate_store,
    resolve_head_authorization(request) {
      events.push(`auth:${request.operation}`);
      assert.equal(Object.isFrozen(request), true);
      return { version: VERSION, head_binding: copy(BINDING), archived };
    },
    repository_objects: operations(value, events, settings),
  });
  return { core, store: actual, storeCalls, archive(value) { archived = value; } };
}
function initializeInput(value, overrides = {}) {
  return { head_binding: copy(BINDING), delivery_candidate_ref: copy(value.manifest.delivery_candidate_ref), delivery_manifest: copy(value.manifest), ...overrides };
}
function composeInput(value, overrides = {}) {
  return {
    head_binding: copy(BINDING), delivery_candidate_ref: copy(value.manifest.delivery_candidate_ref), expected_revision: 0,
    correlation_id: "correlation-compose-1060", idempotency_key: "idempotency-compose-1060", ...overrides,
  };
}

let passed = 0;
function ok(value, message) { assert.ok(value, message); passed += 1; console.log(`  PASS: ${message}`); }

// Head authorization comes before all durable and repository-object access;
// every individual object read is re-authorized, then one CAS persists the
// exact proof from the pending revision-zero manifest.
{
  const value = fixture(), events = [], config = directory();
  try {
    const runtime = service(config, value, events);
    const initialized = runtime.core.initializeCandidate(initializeInput(value));
    assert.equal(initialized.kind, "delivery_candidate_initialized");
    assert.equal(initialized.replayed, false);
    assert.deepEqual(events.slice(0, 4), ["auth:initialize_candidate", "store:read", "auth:initialize_candidate", "store:initialize"]);
    events.length = 0;
    const composed = runtime.core.composeCandidate(composeInput(value));
    assert.equal(composed.kind, "delivery_candidate_composed");
    assert.equal(composed.replayed, false);
    assert.equal(composed.record.revision, 1);
    assert.equal(composed.record.lifecycle, "composed");
    assert.equal(runtime.storeCalls.record, 1);
    assert.equal(events[0], "auth:compose_candidate");
    assert.equal(events[1], "store:read");
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].startsWith("object:")) assert.equal(events[index - 1], "auth:compose_candidate");
    }
    assert.equal(events.at(-2), "auth:compose_candidate");
    assert.equal(events.at(-1), "store:record");
    assert.equal(Object.isFrozen(composed), true);
    assert.equal(Object.isFrozen(composed.record), true);
    assert.equal(Object.hasOwn(composed.record, "delivery_manifest"), false);
    assert.equal(Object.hasOwn(composed.record, "composition_proof"), false);
    assert.equal(Object.hasOwn(composed.record, "correlation_id"), false);
    ok(true, "Head facts gate every object observation and service results retain only a redacted immutable record");
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
}

// The persisted accepted identity is sufficient for a restart-safe replay.
// It reads the durable receipt but never invokes the composer object surface.
{
  const value = fixture(), config = directory();
  try {
    const firstEvents = [], first = service(config, value, firstEvents);
    first.core.initializeCandidate(initializeInput(value));
    first.core.composeCandidate(composeInput(value));
    const replayEvents = [], second = service(config, value, replayEvents);
    const replay = second.core.composeCandidate(composeInput(value));
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.composition_proof_digest.length, 64);
    assert.deepEqual(replayEvents, ["auth:compose_candidate", "store:read"]);
    assert.equal(second.storeCalls.record, 0);
    ok(true, "restart replay uses the persisted candidate receipt without a second object composition");
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
}

// An archived project or a different Head cannot read state or touch an
// injected repository object.  A stale CAS is stopped with the same rule.
{
  const value = fixture(), events = [], config = directory();
  try {
    const archived = service(config, value, events, { archived: true });
    throwsCode(() => archived.core.initializeCandidate(initializeInput(value)), "delivery_composition_archived");
    assert.deepEqual(events, ["auth:initialize_candidate"]);
    events.length = 0;
    const active = service(config, value, events);
    throwsCode(() => active.core.initializeCandidate(initializeInput(value, { head_binding: { ...BINDING, generation: 16 } })), "delivery_composition_head_denied");
    assert.deepEqual(events, []);
    active.core.initializeCandidate(initializeInput(value));
    events.length = 0;
    throwsCode(() => active.core.composeCandidate(composeInput(value, { expected_revision: 1 })), "stale_delivery_candidate_revision");
    assert.deepEqual(events, ["auth:compose_candidate", "store:read"]);
    ok(true, "archive, Head, and revision preconditions fail closed before object composition");
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
}

// A rejected base/result/review/patch proof never reaches recordComposed, and
// an identity collision after a committed candidate cannot trigger a replay.
{
  const value = fixture(), events = [], config = directory();
  try {
    const bad = service(config, value, events, { bad_patch: true });
    bad.core.initializeCandidate(initializeInput(value));
    throwsCode(() => bad.core.composeCandidate(composeInput(value)), "delivery_composition_rejected");
    assert.equal(bad.storeCalls.record, 0);
    assert.equal(bad.store.readSnapshot(value.manifest.delivery_candidate_ref).revision, 0);
    const cleanEvents = [], clean = service(config, value, cleanEvents);
    clean.core.composeCandidate(composeInput(value));
    const before = cleanEvents.filter((entry) => entry.startsWith("object:")).length;
    throwsCode(() => clean.core.composeCandidate(composeInput(value, { idempotency_key: "other-idempotency-1060" })), "delivery_composition_identity_collision");
    const after = cleanEvents.filter((entry) => entry.startsWith("object:")).length;
    assert.equal(after, before);
    const collisionConfig = directory();
    const collisionEvents = [], collision = service(collisionConfig, value, collisionEvents, {
      record_failure: "delivery_candidate_store_idempotency_collision",
    });
    try {
      collision.core.initializeCandidate(initializeInput(value));
      throwsCode(() => collision.core.composeCandidate(composeInput(value)), "delivery_composition_identity_collision");
      assert.equal(collision.storeCalls.record, 1);
      assert.equal(collision.store.readSnapshot(value.manifest.delivery_candidate_ref).revision, 0);
    } finally { fs.rmSync(collisionConfig, { recursive: true, force: true }); }
    ok(true, "invalid composition evidence and identity collisions cannot create a second persisted transition");
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
}

// Closed construction rejects new capabilities and this source never imports
// local runtime surfaces or Node process/network/filesystem modules.
{
  const value = fixture(), config = directory();
  try {
    const actual = createDeliveryCandidateStore({ config_dir: config, fs });
    assert.throws(() => createDeliveryCompositionService({
      binding: BINDING, candidate_store: actual, resolve_head_authorization() {},
      repository_objects: { ...operations(value, []), publish() {} },
    }), (error) => error instanceof DeliveryCompositionServiceError && error.code === "invalid_delivery_composition_service_options");
    const source = fs.readFileSync(path.join(__dirname, "delivery-composition-service.js"), "utf8");
    assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|child_process|net|process)["']\s*\)/);
    assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|mcp-chat-shim|file-chat|project-monitor)["']\s*\)/);
    assert.doesNotMatch(source, /(?:setInterval\s*\(|setTimeout\s*\(|execSync|spawnSync|registerAction)/);
    ok(true, "the service remains a fixed local composition bridge with no runtime or dynamic-action capability");
  } finally { fs.rmSync(config, { recursive: true, force: true }); }
}

console.log(`\n${passed} passed`);
