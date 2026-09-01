"use strict";

// #1058 M5: server-owned observation for the one existing Dev worktree per
// registered repository. This is intentionally read-only. It converts neither
// a caller path nor a branch name into authority, and it never creates,
// switches, cleans, resets, pushes, or removes a worktree.

const path = require("node:path");
const { assertWorkTaskRef } = require("./work-task-manifest");
const {
  buildRepositoryWorktreePlan,
  roleBranch,
} = require("./repository-provisioning");

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const WORKTREE_ID_RE = /^[a-z][a-z0-9_-]{2,63}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const BRANCH_RE = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

class ManagedWorktreeObserverError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ManagedWorktreeObserverError";
    this.code = code;
  }
}

function fail(code, message) { throw new ManagedWorktreeObserverError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "unknown or missing field");
  }
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function sha(value, code) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "SHA is invalid");
  return value;
}
function worktreeId(repositoryKey, role = "dev") {
  if (!REPOSITORY_KEY_RE.test(repositoryKey) || role !== "dev") fail("invalid_managed_worktree_identity", "worktree identity is invalid");
  const value = `wt_${repositoryKey}_${role}`;
  if (!WORKTREE_ID_RE.test(value)) fail("invalid_managed_worktree_identity", "worktree identity is invalid");
  return value;
}
function canonicalRepository(value) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value.trim())) return null;
  return value.trim().toLowerCase();
}
function canonicalRepositoryFromRemote(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/);
  return match ? canonicalRepository(match[1]) : null;
}
function canonicalPath(authority, value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 1024 || /[\u0000\r\n]/.test(value)) {
    fail(code, "path is invalid");
  }
  let result;
  try { result = authority(freeze({ version: VERSION, path: value })); }
  catch { fail("managed_worktree_canonical_path_unavailable", "canonical path authority failed"); }
  if (typeof result !== "string" || !path.isAbsolute(result) || result.length > 1024 || /[\u0000\r\n]/.test(result)) {
    fail("managed_worktree_canonical_path_invalid", "canonical path authority returned an invalid path");
  }
  const normalized = path.posix.normalize(result);
  if (normalized === "/" || normalized !== result || normalized.endsWith("/")) {
    fail("managed_worktree_canonical_path_invalid", "canonical path is not normalized");
  }
  return normalized;
}
function taskRef(value, code) {
  try { assertWorkTaskRef(value); } catch { fail(code, "work task reference is invalid"); }
  return value;
}
function expected(value) {
  exact(value, ["repository_key", "worktree_id", "canonical_path", "branch", "base_sha", "candidate_sha"], "invalid_managed_worktree_expectation");
  if (!REPOSITORY_KEY_RE.test(value.repository_key) || !WORKTREE_ID_RE.test(value.worktree_id) ||
      typeof value.canonical_path !== "string" || !path.isAbsolute(value.canonical_path) ||
      !BRANCH_RE.test(value.branch)) {
    fail("invalid_managed_worktree_expectation", "managed worktree expectation is invalid");
  }
  return {
    repository_key: value.repository_key,
    worktree_id: value.worktree_id,
    canonical_path: value.canonical_path,
    branch: value.branch,
    base_sha: sha(value.base_sha, "invalid_managed_worktree_expectation"),
    candidate_sha: sha(value.candidate_sha, "invalid_managed_worktree_expectation"),
  };
}
function observationRequest(value) {
  exact(value, ["version", "work_task_ref", "expected"], "invalid_managed_worktree_observation_request");
  if (value.version !== VERSION) fail("invalid_managed_worktree_observation_request", "observation version is invalid");
  return { work_task_ref: taskRef(value.work_task_ref, "invalid_managed_worktree_observation_request"), expected: expected(value.expected) };
}
function gitResult(value, code) {
  exact(value, ["ok", "output"], code);
  if (typeof value.ok !== "boolean" || typeof value.output !== "string" || value.output.length > 4096 || /\u0000/.test(value.output)) {
    fail(code, "git observation is invalid");
  }
  return value;
}

function createManagedWorktreeObserver(options) {
  exact(options, ["repositories", "primary_agent_cwds", "repository_worktrees", "canonicalize_path", "run_git"], "invalid_managed_worktree_observer_options");
  if (typeof options.canonicalize_path !== "function" || typeof options.run_git !== "function") {
    fail("invalid_managed_worktree_observer_options", "read authorities are required");
  }
  let planned;
  try {
    planned = buildRepositoryWorktreePlan(options.repositories, {
      primaryAgentCwds: options.primary_agent_cwds,
      repositoryWorktrees: options.repository_worktrees,
    });
  } catch {
    fail("invalid_managed_worktree_observer_options", "registered repository plan is invalid");
  }
  const repositories = new Map(planned.map((repository) => [repository.key, freeze({
    key: repository.key,
    canonical_repo: repository.canonical_repo,
    base_path: canonicalPath(options.canonicalize_path, repository.working_dir, "invalid_managed_worktree_observer_options"),
    dev_path: canonicalPath(options.canonicalize_path, repository.worktrees.dev, "invalid_managed_worktree_observer_options"),
  })]));

  function run(repository, args) {
    let result;
    try {
      result = options.run_git(freeze({ version: VERSION, cwd: repository.dev_path, args: freeze([...args]) }));
    } catch {
      fail("managed_worktree_git_unavailable", "git observation failed");
    }
    return gitResult(result, "managed_worktree_git_observation_invalid");
  }
  function command(repository, args, code) {
    const result = run(repository, args);
    if (!result.ok) fail(code, "git worktree proof failed");
    return result.output.trim();
  }
  function assertServerBinding(requested, repository) {
    const expectedId = worktreeId(repository.key);
    const expectedBranch = roleBranch("dev");
    if (requested.expected.repository_key !== repository.key || requested.expected.worktree_id !== expectedId ||
        requested.expected.canonical_path !== repository.dev_path || requested.expected.branch !== expectedBranch) {
      fail("managed_worktree_server_binding_mismatch", "caller expectation does not match the registered Dev worktree");
    }
  }
  function canonicalizePath(request) {
    exact(request, ["version", "path"], "invalid_managed_worktree_canonical_request");
    if (request.version !== VERSION) fail("invalid_managed_worktree_canonical_request", "canonical request version is invalid");
    return freeze({ version: VERSION, canonical_path: canonicalPath(options.canonicalize_path, request.path, "invalid_managed_worktree_canonical_request") });
  }
  function inspectManagedWorktree(request) {
    const requested = observationRequest(request);
    const repository = repositories.get(requested.work_task_ref.repository_key);
    if (!repository) fail("managed_worktree_repository_unregistered", "task repository is not registered");
    assertServerBinding(requested, repository);

    const topLevel = canonicalPath(options.canonicalize_path, command(repository, ["rev-parse", "--show-toplevel"], "managed_worktree_top_level_unavailable"), "managed_worktree_top_level_invalid");
    if (topLevel !== repository.dev_path) fail("managed_worktree_top_level_mismatch", "registered Dev path is not a Git worktree");
    const commonRaw = command(repository, ["rev-parse", "--git-common-dir"], "managed_worktree_common_dir_unavailable");
    const commonPath = canonicalPath(options.canonicalize_path,
      path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repository.dev_path, commonRaw), "managed_worktree_common_dir_invalid");
    if (commonPath !== `${repository.base_path}/.git`) fail("managed_worktree_base_mismatch", "Dev worktree belongs to another base clone");
    const origin = canonicalRepositoryFromRemote(command(repository, ["remote", "get-url", "origin"], "managed_worktree_origin_unavailable"));
    if (origin !== repository.canonical_repo) fail("managed_worktree_origin_mismatch", "Dev worktree origin is not registered");
    if (command(repository, ["branch", "--show-current"], "managed_worktree_branch_unavailable") !== requested.expected.branch) {
      fail("managed_worktree_branch_mismatch", "Dev worktree branch changed");
    }
    if (command(repository, ["status", "--porcelain", "--untracked-files=all"], "managed_worktree_status_unavailable") !== "") {
      fail("managed_worktree_dirty", "Dev worktree has uncommitted changes");
    }
    if (command(repository, ["rev-parse", "--verify", "HEAD"], "managed_worktree_head_unavailable") !== requested.expected.candidate_sha) {
      fail("managed_worktree_candidate_sha_mismatch", "Dev worktree HEAD is not the submitted candidate");
    }
    const base = run(repository, ["merge-base", "--is-ancestor", requested.expected.base_sha, requested.expected.candidate_sha]);
    if (!base.ok) fail("managed_worktree_base_mismatch", "assigned base is not an ancestor of candidate");
    return freeze({
      version: VERSION,
      registered: true,
      readable: true,
      repository_key: repository.key,
      worktree_id: requested.expected.worktree_id,
      canonical_path: repository.dev_path,
      branch: requested.expected.branch,
      base_sha: requested.expected.base_sha,
      head_sha: requested.expected.candidate_sha,
      dirty: false,
      occupancy: "vacant",
    });
  }

  return freeze({ canonicalizePath, inspectManagedWorktree, worktreeId });
}

module.exports = {
  VERSION,
  ManagedWorktreeObserverError,
  createManagedWorktreeObserver,
  worktreeId,
};
