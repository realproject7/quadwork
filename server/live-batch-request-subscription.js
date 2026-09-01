"use strict";

// #1046 M8: the synchronous server-owned subscription projection used by the
// bounded Batch Request runtime.  This is deliberately a small capability
// bridge: it reads only the current config and lifecycle facts supplied by the
// integration owner.  It does not retain a config snapshot, discover remote
// state, poll, or make a disabled/stale project look routable.

const { allRepositories } = require("./config");
const { normalizeProjectEnvironmentSettings } = require("./project-environment-bindings");
const { VERSION } = require("./batch-request-watcher");
const { REQUEST_LABEL } = require("./batch-request-subscription");

const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;

class LiveBatchRequestSubscriptionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "LiveBatchRequestSubscriptionError";
    this.code = code;
  }
}

function fail(code, message) { throw new LiveBatchRequestSubscriptionError(code, message); }
function unavailable() {
  fail("live_batch_request_subscription_unavailable", "current Batch Request subscription is unavailable");
}
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
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
function thenable(value) {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}
function call(reader, args) {
  try {
    const value = reader(...args);
    if (thenable(value)) unavailable();
    return value;
  } catch (error) {
    if (error instanceof LiveBatchRequestSubscriptionError) throw error;
    unavailable();
  }
}
function canonicalRepository(value) {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toLowerCase();
  return REPOSITORY_RE.test(canonical) ? canonical : null;
}
function target(value) {
  exact(value, ["version", "target"], "invalid_live_batch_request_subscription_request");
  if (value.version !== VERSION) {
    fail("invalid_live_batch_request_subscription_request", "Batch Request watcher version is invalid");
  }
  exact(value.target, ["installation_id", "project_id"], "invalid_live_batch_request_subscription_request");
  if (typeof value.target.installation_id !== "string" || !INSTALLATION_RE.test(value.target.installation_id) ||
      typeof value.target.project_id !== "string" || !PROJECT_RE.test(value.target.project_id)) {
    fail("invalid_live_batch_request_subscription_request", "Batch Request target is invalid");
  }
  return freeze({
    installation_id: value.target.installation_id,
    project_id: value.target.project_id,
  });
}
function projectFromCurrentConfig(config, requested) {
  if (!plain(config) || typeof config.installation_id !== "string" || !INSTALLATION_RE.test(config.installation_id) ||
      config.installation_id !== requested.installation_id || !Array.isArray(config.projects)) {
    unavailable();
  }
  const projects = config.projects.filter((entry) => plain(entry) && entry.id === requested.project_id);
  if (projects.length !== 1 || projects[0].archived === true) unavailable();
  return projects[0];
}
function admission(value, requested) {
  exact(value, ["project_id", "generation"], "live_batch_request_subscription_unavailable");
  if (value.project_id !== requested.project_id || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    unavailable();
  }
  return freeze({ project_id: value.project_id, generation: value.generation });
}

// All repositories in the returned watcher environment are derived from the
// one selected project's registered records.  Invalid, duplicated, or
// case-colliding records are not silently filtered: doing so could make an
// authority valid against a narrower set than its persisted project state.
function registeredRepositories(project) {
  let entries;
  try { entries = allRepositories(project); }
  catch { unavailable(); }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 128) unavailable();
  const byKey = new Map();
  const repositories = [];
  for (const entry of entries) {
    if (!plain(entry) || typeof entry.key !== "string" || !REPOSITORY_KEY_RE.test(entry.key)) unavailable();
    const repository = canonicalRepository(entry.repo);
    if (!repository || byKey.has(entry.key) || repositories.includes(repository)) unavailable();
    byKey.set(entry.key, repository);
    repositories.push(repository);
  }
  return freeze({ by_key: byKey, repositories: freeze(repositories) });
}
function normalizedEnvironment(config, project, registered) {
  let value;
  try {
    value = normalizeProjectEnvironmentSettings({
      installation_id: config.installation_id,
      project,
      resolveCanonicalRepository(candidate, key) {
        // The normalizer defensively clones the project before invoking this
        // accessor, so object identity is not stable here. Its immutable id
        // remains the only selector and the repository map below was derived
        // from this exact current project record.
        if (!plain(candidate) || candidate.id !== project.id || typeof key !== "string") return null;
        return registered.by_key.get(key) || null;
      },
    });
  } catch {
    unavailable();
  }
  if (!value || value.project.watch_batch_requests !== true || value.coordination_repository === null) unavailable();
  const coordination = canonicalRepository(value.coordination_repository.canonical_repository);
  if (!coordination || registered.by_key.get(value.coordination_repository.key) !== coordination ||
      !registered.repositories.includes(coordination)) {
    unavailable();
  }
  return freeze({
    current: freeze({
      installation_id: value.current_identity.installation_id,
      project_id: value.current_identity.project_id,
    }),
    peers: freeze(value.project.environment_bindings.map((peer) => freeze({
      installation_id: peer.installation_id,
      project_id: peer.project_id,
      label: peer.label,
      environment_class: peer.environment_class,
    }))),
    coordination_repository: freeze({
      key: value.coordination_repository.key,
      canonical_repository: coordination,
    }),
    registered_repositories: registered.repositories,
  });
}

function createLiveBatchRequestSubscription(options) {
  exact(options, ["read_config", "capture_project_admission", "is_admission_current", "is_project_archived"], "invalid_live_batch_request_subscription_options");
  for (const name of ["read_config", "capture_project_admission", "is_admission_current", "is_project_archived"]) {
    if (typeof options[name] !== "function") {
      fail("invalid_live_batch_request_subscription_options", `${name} must be a function`);
    }
  }

  return function resolve_canonical_subscription(request) {
    const requested = target(request);
    const current = admission(call(options.capture_project_admission, [requested.project_id]), requested);
    if (call(options.is_admission_current, [current]) !== true) unavailable();
    const config = call(options.read_config, []);
    const project = projectFromCurrentConfig(config, requested);
    if (call(options.is_project_archived, [requested.project_id, config]) !== false) unavailable();
    const registered = registeredRepositories(project);
    const environment = normalizedEnvironment(config, project, registered);
    // A lifecycle transition during the synchronous projection must never
    // produce a stale subscription. The second check also makes the lease a
    // final guard immediately before the immutable response leaves this seam.
    if (call(options.is_admission_current, [current]) !== true ||
        call(options.is_project_archived, [requested.project_id, config]) !== false) unavailable();
    return freeze({
      version: VERSION,
      target: freeze(clone(requested)),
      enabled: true,
      archived: false,
      coordination_repository: environment.coordination_repository.canonical_repository,
      request_label: REQUEST_LABEL,
      environment,
    });
  };
}

module.exports = {
  LiveBatchRequestSubscriptionError,
  createLiveBatchRequestSubscription,
};
