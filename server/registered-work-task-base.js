"use strict";

// #1058 M9: read-only proof for the registered base clone from which the
// server assigns a WorkTask build.  This is deliberately separate from the
// Dev-worktree observer: a caller never supplies a base path or SHA.

const path = require("node:path");
const { assertWorkTaskRef } = require("./work-task-manifest");
const {
  buildRepositoryWorktreePlan,
  canonicalRepositoryFromRemote,
} = require("./repository-provisioning");

const VERSION = 1;
// Git may use SHA-1 (40) or SHA-256 (64) object IDs. Durable content
// digests remain 64 hex and are still recomputed by their owning contracts.
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

class RegisteredWorkTaskBaseError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RegisteredWorkTaskBaseError";
    this.code = code;
  }
}

function fail(code, message) { throw new RegisteredWorkTaskBaseError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function canonicalPath(authority, value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 1024 || /[\u0000\r\n]/.test(value)) {
    fail(code, "path is invalid");
  }
  let result;
  try { result = authority(freeze({ version: VERSION, path: value })); }
  catch { fail("registered_work_task_base_canonical_path_unavailable", "canonical path authority failed"); }
  if (typeof result !== "string" || !path.isAbsolute(result) || result.length > 1024 || /[\u0000\r\n]/.test(result)) {
    fail("registered_work_task_base_canonical_path_invalid", "canonical path authority returned an invalid path");
  }
  const normalized = path.posix.normalize(result);
  if (normalized === "/" || normalized !== result || normalized.endsWith("/")) {
    fail("registered_work_task_base_canonical_path_invalid", "canonical path is not normalized");
  }
  return normalized;
}
function ref(value) {
  try { assertWorkTaskRef(value); }
  catch { fail("invalid_registered_work_task_base_request", "work task reference is invalid"); }
  return value;
}
function request(value) {
  exact(value, ["version", "work_task_ref"], "invalid_registered_work_task_base_request");
  if (value.version !== VERSION) fail("invalid_registered_work_task_base_request", "base request version is invalid");
  return ref(value.work_task_ref);
}
function gitResult(value, code) {
  exact(value, ["ok", "output"], code);
  if (typeof value.ok !== "boolean" || typeof value.output !== "string" || value.output.length > 4096 || /\u0000/.test(value.output)) {
    fail(code, "git observation is invalid");
  }
  return value;
}

function createRegisteredWorkTaskBaseObserver(options) {
  exact(options, ["repositories", "primary_agent_cwds", "repository_worktrees", "canonicalize_path", "run_git"], "invalid_registered_work_task_base_options");
  if (typeof options.canonicalize_path !== "function" || typeof options.run_git !== "function") {
    fail("invalid_registered_work_task_base_options", "read authorities are required");
  }
  let plan;
  try {
    plan = buildRepositoryWorktreePlan(options.repositories, {
      primaryAgentCwds: options.primary_agent_cwds,
      repositoryWorktrees: options.repository_worktrees,
    });
  } catch {
    fail("invalid_registered_work_task_base_options", "registered repository plan is invalid");
  }
  const repositories = new Map(plan.map((repository) => [repository.key, freeze({
    key: repository.key,
    canonical_repo: repository.canonical_repo,
    base_path: canonicalPath(options.canonicalize_path, repository.working_dir, "invalid_registered_work_task_base_options"),
  })]));

  function run(repository, args) {
    let result;
    try {
      result = options.run_git(freeze({ version: VERSION, cwd: repository.base_path, args: freeze([...args]) }));
    } catch {
      fail("registered_work_task_base_git_unavailable", "git observation failed");
    }
    return gitResult(result, "registered_work_task_base_git_observation_invalid");
  }
  function command(repository, args, code) {
    const result = run(repository, args);
    if (!result.ok) fail(code, "git base proof failed");
    return result.output.trim();
  }
  function readRegisteredBase(value) {
    const workTaskRef = request(value);
    const repository = repositories.get(workTaskRef.repository_key);
    if (!repository) fail("registered_work_task_base_repository_unregistered", "task repository is not registered");
    const topLevel = canonicalPath(options.canonicalize_path,
      command(repository, ["rev-parse", "--show-toplevel"], "registered_work_task_base_top_level_unavailable"),
      "registered_work_task_base_top_level_invalid");
    if (topLevel !== repository.base_path) {
      fail("registered_work_task_base_top_level_mismatch", "registered base path is not its Git worktree");
    }
    const origin = canonicalRepositoryFromRemote(command(repository, ["remote", "get-url", "origin"], "registered_work_task_base_origin_unavailable"));
    if (origin !== repository.canonical_repo) {
      fail("registered_work_task_base_origin_mismatch", "registered base origin does not match");
    }
    if (command(repository, ["status", "--porcelain", "--untracked-files=all"], "registered_work_task_base_status_unavailable") !== "") {
      fail("registered_work_task_base_dirty", "registered base has uncommitted changes");
    }
    const base_sha = command(repository, ["rev-parse", "--verify", "HEAD"], "registered_work_task_base_head_unavailable");
    if (!SHA_RE.test(base_sha)) fail("registered_work_task_base_head_invalid", "registered base HEAD is invalid");
    return freeze({ version: VERSION, repository_key: repository.key, base_sha });
  }
  return freeze({ readRegisteredBase });
}

module.exports = {
  VERSION,
  RegisteredWorkTaskBaseError,
  createRegisteredWorkTaskBaseObserver,
};
