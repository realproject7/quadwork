"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { VERSION } = require("./batch-request-watcher");
const { REQUEST_LABEL } = require("./batch-request-subscription");
const {
  LiveBatchRequestSubscriptionError,
  createLiveBatchRequestSubscription,
} = require("./live-batch-request-subscription");

const installation_id = "installation_subscription_01";
const project_id = "quadwork";
const generation = 8;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function project(overrides = {}) {
  return {
    id: project_id,
    archived: false,
    repositories: [
      { key: "coord", repo: "Acme/Coordination", working_dir: "/not-exported/coord", primary: true },
      { key: "web", repo: "Acme/Web", working_dir: "/not-exported/web", primary: false },
      { key: "api", repo: "Acme/API", working_dir: "/not-exported/api", primary: false },
    ],
    coordination_repo_key: "coord",
    watch_batch_requests: true,
    environment_bindings: [{
      installation_id: "installation_peer_0000001",
      project_id: "control-plane",
      label: "  Control VPS  ",
      environment_class: "vps",
    }],
    untrusted: { path: "/secret", token: "do-not-export" },
    ...overrides,
  };
}
function config(overrides = {}) {
  return {
    installation_id,
    projects: [project()],
    unrelated: { preserve: true },
    ...overrides,
  };
}
function request(overrides = {}) {
  return { version: VERSION, target: { installation_id, project_id }, ...overrides };
}
function fixture(overrides = {}) {
  const calls = [];
  const current = overrides.config === undefined ? config() : overrides.config;
  const value = createLiveBatchRequestSubscription({
    read_config() {
      calls.push(["config"]);
      if (overrides.read_config_error) throw new Error("unavailable");
      return current;
    },
    capture_project_admission(id) {
      calls.push(["capture", id]);
      if (overrides.capture_error) throw new Error("unavailable");
      return overrides.admission === undefined ? { project_id, generation } : overrides.admission;
    },
    is_admission_current(token) {
      calls.push(["current", copy(token)]);
      return overrides.current === undefined ? true : overrides.current;
    },
    is_project_archived(id, candidate) {
      calls.push(["archived", id, candidate === current]);
      return overrides.archived === undefined ? false : overrides.archived;
    },
  });
  return { value, calls };
}
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof LiveBatchRequestSubscriptionError && error.code === code);
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// A current, multi-repository project produces exactly the closed watcher
// payload.  Paths, other config fields, and source project objects never
// escape the resolver.
{
  const live = fixture();
  const actual = live.value(request());
  assert.deepEqual(actual, {
    version: VERSION,
    target: { installation_id, project_id },
    enabled: true,
    archived: false,
    coordination_repository: "acme/coordination",
    request_label: REQUEST_LABEL,
    environment: {
      current: { installation_id, project_id },
      peers: [{
        installation_id: "installation_peer_0000001",
        project_id: "control-plane",
        label: "Control VPS",
        environment_class: "vps",
      }],
      coordination_repository: { key: "coord", canonical_repository: "acme/coordination" },
      registered_repositories: ["acme/coordination", "acme/web", "acme/api"],
    },
  });
  assert.deepEqual(Object.keys(actual).sort(), ["archived", "coordination_repository", "enabled", "environment", "request_label", "target", "version"]);
  assert.equal(Object.isFrozen(actual), true);
  assert.equal(Object.isFrozen(actual.environment.peers[0]), true);
  assert.doesNotMatch(JSON.stringify(actual), /not-exported|do-not-export|untrusted/);
  assert.deepEqual(live.calls, [
    ["capture", project_id],
    ["current", { project_id, generation }],
    ["config"],
    ["archived", project_id, true],
    ["current", { project_id, generation }],
    ["archived", project_id, true],
  ]);
  ok(true, "one current multi-repository project becomes the exact canonical watcher subscription");
}

// A bad watcher envelope cannot choose an installation/project or invoke a
// lifecycle/config reader.
for (const invalid of [
  { ...request(), extra: true },
  request({ version: 2 }),
  request({ target: { installation_id, project_id, extra: true } }),
  request({ target: { installation_id: "short", project_id } }),
]) {
  const live = fixture();
  throwsCode(() => live.value(invalid), "invalid_live_batch_request_subscription_request");
  assert.deepEqual(live.calls, []);
}
ok(true, "invalid watcher requests cannot invoke a live reader");

// Every non-current lifecycle condition is a closed stop, rather than a
// disabled subscription which could let a future caller choose a fallback.
for (const options of [
  { admission: { project_id, generation: generation + 1 }, current: false },
  { current: false },
  { archived: true },
  { config: config({ installation_id: "installation_other_000001" }) },
  { config: config({ projects: [project({ id: "other" })] }) },
  { config: config({ projects: [project(), project()] }) },
  { config: config({ projects: [project({ archived: true })] }) },
]) {
  const live = fixture(options);
  throwsCode(() => live.value(request()), "live_batch_request_subscription_unavailable");
}
ok(true, "stale, archived, duplicate, and installation/project identity failures are fail-closed");

// Project Environments and the registered-record allow-list are both live
// inputs.  Wrong/missing peer or repository data never gets widened, guessed,
// or passed through to the watcher.
for (const badProject of [
  project({ watch_batch_requests: false, coordination_repo_key: undefined }),
  project({ watch_batch_requests: true, coordination_repo_key: "missing" }),
  project({ environment_bindings: [{ installation_id, project_id, label: "self", environment_class: "local" }] }),
  project({ environment_bindings: [{ installation_id: "short", project_id: "peer", label: "peer", environment_class: "vps" }] }),
  project({ repositories: [{ key: "coord", repo: "Acme/Coordination", working_dir: "/x" }, { key: "web", repo: "acme/coordination", working_dir: "/y" }] }),
  project({ repositories: [{ key: "coord", repo: "Acme/Coordination", working_dir: "/x" }], coordination_repo_key: "missing" }),
]) {
  const live = fixture({ config: config({ projects: [badProject] }) });
  throwsCode(() => live.value(request()), "live_batch_request_subscription_unavailable");
}
ok(true, "inactive, malformed-peer, missing, and ambiguous registered repositories cannot make a subscription");

// All capabilities are synchronous and fixed at construction.  A Promise or
// an accidental factory escape hatch is rejected before it becomes authority.
for (const options of [
  { config: Promise.resolve(config()) },
  { admission: Promise.resolve({ project_id, generation }) },
  { current: Promise.resolve(true) },
  { archived: Promise.resolve(false) },
]) {
  const live = fixture(options);
  throwsCode(() => live.value(request()), "live_batch_request_subscription_unavailable");
}
throwsCode(() => createLiveBatchRequestSubscription({
  read_config() { return config(); },
  capture_project_admission() { return { project_id, generation }; },
  is_admission_current() { return true; },
  is_project_archived() { return false; },
  lookup_repository() { return null; },
}), "invalid_live_batch_request_subscription_options");
ok(true, "async readers and unknown factory options are rejected");

const source = fs.readFileSync(path.join(__dirname, "live-batch-request-subscription.js"), "utf8");
assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|net|child_process|crypto)["']\s*\)/);
assert.doesNotMatch(source, /(?:fetch\s*\(|setTimeout\s*\(|setInterval\s*\(|process\.)/);
ok(true, "the projection imports no I/O capability and starts no network or timer work");

console.log(`\n${passed} passed`);
