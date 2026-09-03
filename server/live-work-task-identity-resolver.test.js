"use strict";

const assert = require("node:assert/strict");
const { buildBatchManifest } = require("./work-task-manifest");
const {
  LiveWorkTaskIdentityResolverError,
  createLiveWorkTaskIdentityResolver,
} = require("./live-work-task-identity-resolver");

const installation_id = "installation_identity_0001";
const project_id = "quadwork";
const revision = "a".repeat(64);
const web = { key: "web", repo: "Acme/Web", primary: true, cache_repo: "acme/web", ci_policy: null };
const api = { key: "api", repo: "Acme/API", primary: false, cache_repo: "acme/api", ci_policy: null };
const issue = { repoKey: "web", repo: "Acme/Web", number: 42, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function context(overrides = {}) {
  return {
    activated: true,
    queueReadOk: true,
    installationId: installation_id,
    batchType: "code",
    project: { id: project_id },
    repositories: [copy(web), copy(api)],
    parsed: {
      provenance: "owned",
      installationId: installation_id,
      batchNumber: 12,
      assignmentAttempt: "attempt_identity_01",
      assignmentKey: "owned-assignment-key",
      errors: [],
      workItems: [{ ref: copy(issue), legacyUnowned: false }],
    },
    ...overrides,
  };
}
function state(binding, overrides = {}) {
  return { key: binding.key, repo: binding.repo, stale: false, status: "ok", ...overrides };
}
function snapshot(overrides = {}) {
  return { ts: 1_800_000_000_000, issues: [{ number: 42, contract_revision: revision }], ...overrides };
}
function resolver(overrides = {}) {
  const calls = [];
  const value = createLiveWorkTaskIdentityResolver({
    read_live_batch_context(project) {
      calls.push(["context", project]);
      return overrides.context === undefined ? context() : overrides.context;
    },
    read_repository_state(binding) {
      calls.push(["state", copy(binding)]);
      return overrides.state === undefined ? state(binding) : overrides.state;
    },
    read_cached_repository_snapshot(cache_repo) {
      calls.push(["snapshot", cache_repo]);
      return overrides.snapshot === undefined ? snapshot() : overrides.snapshot;
    },
  });
  return { value, calls };
}
function request(overrides = {}) {
  return {
    installation_id,
    project_id,
    repository_key: "web",
    work_item: copy(issue),
    ...overrides,
  };
}
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof LiveWorkTaskIdentityResolverError && error.code === code);
}

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// The accepted path exposes a minimal immutable identity and readers receive
// only the derived project, binding, and canonical cache key.
{
  const live = resolver();
  const actual = live.value(request());
  assert.deepEqual(actual, {
    installation_id,
    project_id,
    repository_key: "web",
    work_item: issue,
    issue_body_revision: revision,
  });
  assert.deepEqual(Object.keys(actual).sort(), ["installation_id", "issue_body_revision", "project_id", "repository_key", "work_item"]);
  assert.equal(Object.isFrozen(actual), true);
  assert.equal(Object.isFrozen(actual.work_item), true);
  assert.deepEqual(live.calls, [
    ["context", project_id],
    ["state", { key: "web", repo: "Acme/Web", cache_repo: "acme/web" }],
    ["snapshot", "acme/web"],
  ]);
  ok(true, "one owned active Issue resolves through its derived bound cache only");
}

{
  const live = resolver();
  const manifest = buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [{
      task_key: "identity",
      repository_key: "web",
      work_item: copy(issue),
      goal: "exercise the registered identity callback contract",
      file_boundary: ["server/live-work-task-identity-resolver.js"],
      validation: ["node:test"],
      dependencies: [],
    }],
  }, { resolveRegisteredIdentity: live.value });
  assert.equal(manifest.tasks[0].ref.issue_body_revision, revision);
  ok(true, "the resolver is directly compatible with the WorkTask manifest callback");
}

// The callback is synchronous and validates the WorkTask-shaped input before
// it invokes a server reader; callers cannot attach a second selector.
for (const invalid of [
  { ...request(), extra: true },
  request({ repository_key: "api" }),
  request({ work_item: { ...issue, kind: "pr" } }),
]) {
  const live = resolver();
  throwsCode(() => live.value(invalid), "invalid_live_work_task_identity_input");
  assert.deepEqual(live.calls, []);
}
ok(true, "malformed, foreign, and non-Issue WorkTask inputs cannot invoke a reader");

{
  const live = resolver();
  throwsCode(() => live.value(request({ work_item: { ...issue, repo: "Other/Repo" } })), "live_work_task_identity_unavailable");
  assert.deepEqual(live.calls, [["context", project_id]]);
  ok(true, "a structurally valid but unbound repository cannot select a cache reader");
}

// Assignment ownership is not inferred from a project name or cache row.
for (const badContext of [
  null,
  context({ activated: false }),
  context({ queueReadOk: false }),
  context({ batchType: "ticket-review" }),
  context({ installationId: "installation_identity_0002" }),
  context({ parsed: { ...context().parsed, provenance: "unowned" } }),
  context({ parsed: { ...context().parsed, errors: [{ code: "bad" }] } }),
  context({ parsed: { ...context().parsed, workItems: [{ ref: { ...issue, number: 99 }, legacyUnowned: false }] } }),
  context({ parsed: { ...context().parsed, workItems: [{ ref: copy(issue), legacyUnowned: true }] } }),
]) {
  const live = resolver({ context: badContext });
  throwsCode(() => live.value(request()), "live_work_task_identity_unavailable");
  assert.deepEqual(live.calls.slice(1), []);
}
ok(true, "only a readable activated owned V2 code assignment can authorize the exact Issue");

// Repository state and snapshot identity are independently checked. A stale,
// rebound, cold, duplicate, or body-less observation never becomes a digest.
for (const options of [
  { state: state(web, { stale: true }) },
  { state: state(web, { key: "api" }) },
  { state: state(web, { repo: "Other/Repo" }) },
  { snapshot: null },
  { snapshot: snapshot({ ts: -1 }) },
  { snapshot: snapshot({ issues: [{ number: 42 }] }) },
  { snapshot: snapshot({ issues: [{ number: 42, contract_revision: revision }, { number: 42, contract_revision: revision }] }) },
  { snapshot: snapshot({ issues: [{ number: 42, contract_revision: "A".repeat(64) }] }) },
]) {
  const live = resolver(options);
  throwsCode(() => live.value(request()), "live_work_task_identity_unavailable");
}
ok(true, "non-stale bound repository state and one valid cached Issue revision are both mandatory");

// Factory readers are a closed capability set, not an escape hatch for a
// route, filesystem, timer, or caller-selected arbitrary repository.
throwsCode(() => createLiveWorkTaskIdentityResolver({
  read_live_batch_context() { return null; },
  read_repository_state() { return null; },
  read_cached_repository_snapshot() { return null; },
  lookup_anything() { return null; },
}), "invalid_live_work_task_identity_resolver_options");
const source = require("node:fs").readFileSync(__filename.replace(/\.test\.js$/, ".js"), "utf8");
assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|http|https|net|child_process|path|crypto)["']\s*\)/);
assert.doesNotMatch(source, /(?:Date\.now|setTimeout\s*\(|setInterval\s*\(|process\.|fetch\s*\()/);
ok(true, "resolver source has only the three injected structured-read capabilities");

console.log(`\n${passed} passed`);
