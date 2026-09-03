"use strict";

// #1044 M5: a synchronous, fail-closed bridge from one current V2 assignment
// to the registered-identity callback consumed by the durable Head WorkTask
// domain.  This is intentionally a capability boundary: it receives only
// three server-owned readers and never imports routes, config, GitHub, clocks,
// filesystems, tokens, or a general repository lookup.

const { assertWorkItemRef, workItemKey } = require("./work-item-ref");

const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const MAX_ACTIVE_ITEMS = 64;

class LiveWorkTaskIdentityResolverError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "LiveWorkTaskIdentityResolverError";
    this.code = code;
  }
}

function fail(code, message) { throw new LiveWorkTaskIdentityResolverError(code, message); }
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
function canonicalRepository(value) {
  return typeof value === "string" && REPOSITORY_RE.test(value) ? value.toLowerCase() : null;
}
function unavailable() { fail("live_work_task_identity_unavailable", "current WorkTask identity is unavailable"); }
function workItem(value, code) {
  try { assertWorkItemRef(value); }
  catch { fail(code, "work item is invalid"); }
  return {
    repoKey: value.repoKey,
    repo: value.repo,
    number: value.number,
    kind: value.kind,
  };
}
function input(value) {
  exact(value, ["installation_id", "project_id", "repository_key", "work_item"], "invalid_live_work_task_identity_input");
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) ||
      typeof value.repository_key !== "string" || !REPOSITORY_KEY_RE.test(value.repository_key)) {
    fail("invalid_live_work_task_identity_input", "WorkTask identity is invalid");
  }
  const requested = workItem(value.work_item, "invalid_live_work_task_identity_input");
  if (requested.kind !== "issue" || requested.repoKey !== value.repository_key) {
    fail("invalid_live_work_task_identity_input", "WorkTask source must be its repository-bound Issue");
  }
  return freeze({
    installation_id: value.installation_id,
    project_id: value.project_id,
    repository_key: value.repository_key,
    work_item: requested,
  });
}
function call(reader, args) {
  try { return reader(...args); }
  catch { unavailable(); }
}
function binding(value) {
  if (!plain(value) || typeof value.key !== "string" || !REPOSITORY_KEY_RE.test(value.key) ||
      typeof value.repo !== "string" || typeof value.cache_repo !== "string") unavailable();
  const canonical = canonicalRepository(value.repo);
  if (!canonical || value.cache_repo !== canonical) unavailable();
  return freeze({ key: value.key, repo: value.repo, cache_repo: value.cache_repo });
}
function activeContext(value, requested) {
  if (!plain(value) || value.activated !== true || value.queueReadOk !== true ||
      value.installationId !== requested.installation_id || value.batchType !== "code" ||
      !plain(value.project) || value.project.id !== requested.project_id || !plain(value.parsed)) {
    unavailable();
  }
  const parsed = value.parsed;
  if (parsed.provenance !== "owned" || parsed.installationId !== requested.installation_id ||
      !Number.isSafeInteger(parsed.batchNumber) || parsed.batchNumber < 1 ||
      typeof parsed.assignmentAttempt !== "string" || !ATTEMPT_RE.test(parsed.assignmentAttempt) ||
      typeof parsed.assignmentKey !== "string" || parsed.assignmentKey.length === 0 || parsed.assignmentKey.length > 8192 ||
      /[\u0000\r\n]/.test(parsed.assignmentKey) || !Array.isArray(parsed.errors) || parsed.errors.length !== 0 ||
      !Array.isArray(parsed.workItems) || parsed.workItems.length === 0 || parsed.workItems.length > MAX_ACTIVE_ITEMS ||
      !Array.isArray(value.repositories) || value.repositories.length === 0 || value.repositories.length > MAX_ACTIVE_ITEMS) {
    unavailable();
  }

  const bindings = value.repositories.map(binding);
  if (new Set(bindings.map((entry) => entry.key)).size !== bindings.length ||
      new Set(bindings.map((entry) => entry.cache_repo)).size !== bindings.length) unavailable();
  const selected = bindings.filter((entry) => entry.key === requested.repository_key);
  if (selected.length !== 1) unavailable();

  const active = [];
  for (const row of parsed.workItems) {
    if (!plain(row) || row.legacyUnowned === true) unavailable();
    const source = Object.prototype.hasOwnProperty.call(row, "ref") ? row.ref : row;
    const ref = workItem(source, "live_work_task_identity_unavailable");
    const registered = bindings.filter((entry) => entry.key === ref.repoKey && canonicalRepository(ref.repo) === entry.cache_repo);
    if (registered.length !== 1 || ref.kind !== "issue") unavailable();
    active.push(freeze(ref));
  }
  if (new Set(active.map(workItemKey)).size !== active.length) unavailable();
  const matches = active.filter((ref) => workItemKey(ref) === workItemKey(requested.work_item) &&
    ref.repoKey === selected[0].key && canonicalRepository(ref.repo) === selected[0].cache_repo);
  if (matches.length !== 1) unavailable();
  return { binding: selected[0], work_item: matches[0] };
}
function currentRepositoryState(value, selected) {
  if (!plain(value) || value.key !== selected.key || canonicalRepository(value.repo) !== selected.cache_repo || value.stale !== false) {
    unavailable();
  }
}
function currentRevision(snapshot, issueNumber) {
  if (!plain(snapshot) || !Number.isSafeInteger(snapshot.ts) || snapshot.ts < 0 || !Array.isArray(snapshot.issues)) unavailable();
  const matches = snapshot.issues.filter((entry) => plain(entry) && entry.number === issueNumber);
  if (matches.length !== 1 || !REVISION_RE.test(matches[0].contract_revision)) unavailable();
  return matches[0].contract_revision;
}

// Factory API intentionally mirrors the three existing routes.js seams:
//   read_live_batch_context(project_id) -> routes.readLiveBatchContext(project_id)
//   read_repository_state(binding) -> routes.repositoryState(binding)
//   read_cached_repository_snapshot(cache_repo) -> routes._graphqlCache.get(cache_repo)
// The selected binding/cache key is derived only after the requested WorkTask
// input has been validated against the active assignment.
function createLiveWorkTaskIdentityResolver(options) {
  exact(options, ["read_live_batch_context", "read_repository_state", "read_cached_repository_snapshot"], "invalid_live_work_task_identity_resolver_options");
  for (const name of ["read_live_batch_context", "read_repository_state", "read_cached_repository_snapshot"]) {
    if (typeof options[name] !== "function") {
      fail("invalid_live_work_task_identity_resolver_options", `${name} must be a function`);
    }
  }
  return function resolve_registered_identity(value) {
    const requested = input(value);
    const selected = activeContext(call(options.read_live_batch_context, [requested.project_id]), requested);
    currentRepositoryState(call(options.read_repository_state, [freeze(clone(selected.binding))]), selected.binding);
    const issue_body_revision = currentRevision(
      call(options.read_cached_repository_snapshot, [selected.binding.cache_repo]),
      selected.work_item.number,
    );
    return freeze({
      installation_id: requested.installation_id,
      project_id: requested.project_id,
      repository_key: selected.binding.key,
      work_item: clone(selected.work_item),
      issue_body_revision,
    });
  };
}

module.exports = {
  LiveWorkTaskIdentityResolverError,
  createLiveWorkTaskIdentityResolver,
};
