"use strict";

// #1032: V2 repository provisioning is deliberately separate from the older
// single-repository setup helpers. In particular, it never prunes a worktree,
// never falls back to a detached checkout, and never deletes a path/branch to
// make a retry succeed.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeProjectRepositories } = require("./config");

const ROLE_IDS = Object.freeze(["head", "re1", "re2", "dev"]);
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

class RepositoryProvisionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RepositoryProvisionError";
    this.code = code;
    Object.assign(this, details);
  }
}

function canonicalRepositoryName(value) {
  return typeof value === "string" && REPOSITORY_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function canonicalRepositoryFromRemote(url) {
  if (typeof url !== "string") return null;
  const match = url.trim().match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/);
  return match && canonicalRepositoryName(match[1]);
}

function assertProjectId(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    throw new RepositoryProvisionError("invalid_project_id", "project id is invalid");
  }
  return projectId;
}

function normalPath(value) {
  return typeof value === "string" && path.isAbsolute(value) ? path.normalize(path.resolve(value)) : null;
}

function roleBranch(role) {
  return `worktree-${role}`;
}

function expectedWorktreePath(baseDir, role) {
  const base = normalPath(baseDir);
  if (!base || !ROLE_IDS.includes(role)) return null;
  return path.join(path.dirname(base), `${path.basename(base)}-${role}`);
}

function assertRepositoryList(repositories) {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new RepositoryProvisionError("repositories_required", "at least one repository is required");
  }
  const keys = new Set();
  const names = new Set();
  const bases = new Set();
  let primaryCount = 0;
  const normalized = repositories.map((entry) => {
    const key = typeof entry?.key === "string" ? entry.key : "";
    const repo = typeof entry?.repo === "string" ? entry.repo.trim() : "";
    const canonical = canonicalRepositoryName(repo);
    const workingDir = normalPath(entry?.working_dir);
    if (!REPOSITORY_KEY_RE.test(key)) {
      throw new RepositoryProvisionError("invalid_repository_key", "repository key is invalid", { repo_key: key || null });
    }
    if (keys.has(key)) {
      throw new RepositoryProvisionError("duplicate_repository_key", "repository key is duplicated", { repo_key: key });
    }
    keys.add(key);
    if (!canonical) {
      throw new RepositoryProvisionError("invalid_repository_name", "repository name is invalid", { repo_key: key });
    }
    if (names.has(canonical)) {
      throw new RepositoryProvisionError("duplicate_repository", "repository is duplicated", { repo_key: key });
    }
    names.add(canonical);
    if (!workingDir) {
      throw new RepositoryProvisionError("invalid_repository_working_dir", "repository working directory must be absolute", { repo_key: key });
    }
    const foldedBase = workingDir.normalize("NFC").toLowerCase();
    if (bases.has(foldedBase)) {
      throw new RepositoryProvisionError("duplicate_repository_working_dir", "repository working directory is duplicated", { repo_key: key });
    }
    bases.add(foldedBase);
    if (entry.primary === true) primaryCount += 1;
    return Object.freeze({
      key,
      repo,
      canonical_repo: canonical,
      working_dir: workingDir,
      primary: entry.primary === true,
      ...(hasOwn(entry, "ci_policy") ? { ci_policy: entry.ci_policy } : {}),
      ...(typeof entry.default_branch === "string" && entry.default_branch.trim()
        ? { default_branch: entry.default_branch.trim() }
        : {}),
    });
  });
  if (primaryCount !== 1) {
    throw new RepositoryProvisionError("invalid_primary_repository_count", "exactly one repository must be primary", { primary_count: primaryCount });
  }
  return Object.freeze(normalized);
}

function configuredRepositoryOwnership(config, targetProjectId, repositories) {
  const targets = assertRepositoryList(repositories);
  const projects = Array.isArray(config?.projects) ? config.projects : [];
  for (const project of projects) {
    if (!project || project.id === targetProjectId || project.archived === true) continue;
    for (const existing of normalizeProjectRepositories(project)) {
      const canonical = canonicalRepositoryName(existing?.repo);
      const workingDir = normalPath(existing?.working_dir);
      for (const target of targets) {
        if (canonical && canonical === target.canonical_repo) {
          return Object.freeze({
            ok: false,
            code: "repository_owned_by_active_project",
            project_id: typeof project.id === "string" ? project.id : "unknown",
            state: "active_repository_owner",
            repo_key: target.key,
          });
        }
        if (workingDir && workingDir.normalize("NFC").toLowerCase() === target.working_dir.normalize("NFC").toLowerCase()) {
          return Object.freeze({
            ok: false,
            code: "repository_working_dir_owned_by_active_project",
            project_id: typeof project.id === "string" ? project.id : "unknown",
            state: "active_base_owner",
            repo_key: target.key,
          });
        }
      }
    }
  }
  return Object.freeze({ ok: true });
}

function buildRepositoryWorktreePlan(repositories, options = {}) {
  const entries = assertRepositoryList(repositories);
  const preserve = options.primaryAgentCwds && typeof options.primaryAgentCwds === "object"
    ? options.primaryAgentCwds
    : {};
  const registeredWorktrees = options.repositoryWorktrees && typeof options.repositoryWorktrees === "object"
    ? options.repositoryWorktrees
    : {};
  return Object.freeze(entries.map((repository) => {
    const worktrees = Object.fromEntries(ROLE_IDS.map((role) => {
      const registered = normalPath(registeredWorktrees[repository.key]?.[role]);
      const preserved = repository.primary && typeof preserve[role] === "string" && path.isAbsolute(preserve[role])
        ? path.normalize(path.resolve(preserve[role]))
        : null;
      return [role, registered || preserved || expectedWorktreePath(repository.working_dir, role)];
    }));
    return Object.freeze({ ...repository, worktrees: Object.freeze(worktrees) });
  }));
}

async function command(runner, cmd, args, options = {}) {
  const result = await runner(cmd, args, options);
  return result && typeof result === "object" ? result : { ok: false, output: "invalid command response" };
}

function output(result) {
  return typeof result?.output === "string" ? result.output.trim() : "";
}

async function inspectBaseClone(repository, runner, fsImpl) {
  const base = repository.working_dir;
  if (!fsImpl.existsSync(base)) return { ok: true, action: "clone", repository };
  if (!fsImpl.existsSync(path.join(base, ".git"))) {
    return { ok: false, code: "base_not_git", repo_key: repository.key, message: "repository base path is not a git clone" };
  }
  const topLevel = await command(runner, "git", ["-C", base, "rev-parse", "--show-toplevel"]);
  if (!topLevel.ok || normalPath(output(topLevel)) !== base) {
    return { ok: false, code: "base_identity_mismatch", repo_key: repository.key, message: "repository base path does not identify the expected git clone" };
  }
  const origin = await command(runner, "git", ["-C", base, "remote", "get-url", "origin"]);
  if (!origin.ok || canonicalRepositoryFromRemote(output(origin)) !== repository.canonical_repo) {
    return { ok: false, code: "base_remote_mismatch", repo_key: repository.key, message: "repository base origin does not match the registered repository" };
  }
  const head = await command(runner, "git", ["-C", base, "rev-parse", "--verify", "HEAD"]);
  if (!head.ok) {
    return { ok: false, code: "base_head_unavailable", repo_key: repository.key, message: "repository base has no verified HEAD" };
  }
  const remoteHead = await command(runner, "git", ["-C", base, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const remoteRef = output(remoteHead);
  const branch = remoteHead.ok && remoteRef.startsWith("origin/")
    ? remoteRef.slice("origin/".length)
    : "";
  if (!branch) {
    return { ok: false, code: "default_branch_unavailable", repo_key: repository.key, message: "repository default branch could not be verified" };
  }
  return { ok: true, action: "existing", repository, default_branch: branch };
}

async function inspectReservedWorktree(repository, role, worktreePath, runner, fsImpl) {
  const branch = roleBranch(role);
  if (!fsImpl.existsSync(worktreePath)) {
    const branchExists = await command(runner, "git", ["-C", repository.working_dir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (branchExists.ok) {
      return { ok: false, code: "reserved_branch_exists", repo_key: repository.key, role, message: "reserved role branch exists without its expected worktree" };
    }
    return { ok: true, action: "create", repo_key: repository.key, role, worktree_path: worktreePath, branch };
  }
  const topLevel = await command(runner, "git", ["-C", worktreePath, "rev-parse", "--show-toplevel"]);
  if (!topLevel.ok || normalPath(output(topLevel)) !== normalPath(worktreePath)) {
    return { ok: false, code: "reserved_worktree_mismatch", repo_key: repository.key, role, message: "reserved role path is not its expected worktree" };
  }
  const commonDir = await command(runner, "git", ["-C", worktreePath, "rev-parse", "--git-common-dir"]);
  const commonPath = commonDir.ok
    ? normalPath(path.isAbsolute(output(commonDir)) ? output(commonDir) : path.join(worktreePath, output(commonDir)))
    : null;
  if (!commonPath || commonPath !== normalPath(path.join(repository.working_dir, ".git"))) {
    return { ok: false, code: "reserved_worktree_base_mismatch", repo_key: repository.key, role, message: "reserved role worktree belongs to another base clone" };
  }
  const origin = await command(runner, "git", ["-C", worktreePath, "remote", "get-url", "origin"]);
  if (!origin.ok || canonicalRepositoryFromRemote(output(origin)) !== repository.canonical_repo) {
    return { ok: false, code: "reserved_worktree_remote_mismatch", repo_key: repository.key, role, message: "reserved role worktree origin does not match" };
  }
  const currentBranch = await command(runner, "git", ["-C", worktreePath, "branch", "--show-current"]);
  if (!currentBranch.ok || output(currentBranch) !== branch) {
    return { ok: false, code: "reserved_worktree_role_mismatch", repo_key: repository.key, role, message: "reserved role worktree is not on its expected role branch" };
  }
  const status = await command(runner, "git", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]);
  if (!status.ok || output(status)) {
    return { ok: false, code: "reserved_worktree_dirty", repo_key: repository.key, role, message: "reserved role worktree has uncommitted changes" };
  }
  return { ok: true, action: "reuse", repo_key: repository.key, role, worktree_path: worktreePath, branch };
}

/**
 * Provision only the missing role worktrees. Every existing reserved path is
 * first proven clean, role-correct, and tied to the expected base clone. A
 * failure never prunes, moves, overwrites, or deletes an existing path.
 */
async function provisionRepositoryWorktrees({ projectId, repositories, config, runner, fsImpl = fs, primaryAgentCwds } = {}) {
  assertProjectId(projectId);
  if (typeof runner !== "function") throw new TypeError("runner must be a function");
  const ownership = configuredRepositoryOwnership(config, projectId, repositories);
  if (!ownership.ok) return { ok: false, ...ownership, created: [], reused: [] };
  const plan = buildRepositoryWorktreePlan(repositories, { primaryAgentCwds });
  const created = [];
  const reused = [];
  const baseStates = new Map();

  for (const repository of plan) {
    let state = await inspectBaseClone(repository, runner, fsImpl);
    if (!state.ok) return { ok: false, code: state.code, repo_key: state.repo_key, error: state.message, created, reused };
    if (state.action === "clone") {
      const clone = await command(runner, "gh", ["repo", "clone", repository.repo, repository.working_dir]);
      if (!clone.ok) return { ok: false, code: "clone_failed", repo_key: repository.key, error: output(clone), created, reused };
      created.push({ repo_key: repository.key, kind: "base_clone", path: repository.working_dir });
      state = await inspectBaseClone(repository, runner, fsImpl);
      if (!state.ok) return { ok: false, code: state.code, repo_key: state.repo_key, error: state.message, created, reused };
    }
    baseStates.set(repository.key, state);
  }

  const worktreeChecks = [];
  for (const repository of plan) {
    for (const role of ROLE_IDS) {
      const check = await inspectReservedWorktree(repository, role, repository.worktrees[role], runner, fsImpl);
      if (!check.ok) return { ok: false, code: check.code, repo_key: check.repo_key, role: check.role, error: check.message, created, reused };
      worktreeChecks.push({ repository, ...check });
    }
  }

  for (const check of worktreeChecks) {
    if (check.action === "reuse") {
      reused.push({ repo_key: check.repo_key, role: check.role, path: check.worktree_path });
      continue;
    }
    const result = await command(runner, "git", [
      "-C", check.repository.working_dir,
      "worktree", "add", "-b", check.branch, check.worktree_path, "HEAD",
    ]);
    if (!result.ok) {
      return { ok: false, code: "worktree_create_failed", repo_key: check.repo_key, role: check.role, error: output(result), created, reused };
    }
    created.push({ repo_key: check.repo_key, role: check.role, path: check.worktree_path });
  }

  return {
    ok: true,
    created,
    reused,
    repositories: plan.map((repository) => ({
      ...repository,
      default_branch: baseStates.get(repository.key).default_branch,
    })),
  };
}

function renderProjectRepositoryMap({ projectId, repositories } = {}) {
  assertProjectId(projectId);
  const source = Array.isArray(repositories) ? repositories : [];
  const repositoryWorktrees = Object.fromEntries(source.map((repository) => [
    repository?.key,
    repository?.worktrees,
  ]));
  const plan = buildRepositoryWorktreePlan(repositories, { repositoryWorktrees });
  const lines = [
    "# QuadWork Project Repository Map",
    "",
    `Project: ${projectId}`,
    "",
    "This generated map contains no credentials. Each role must use only its own role row for every repository.",
  ];
  for (const repository of plan) {
    lines.push(
      "",
      `## ${repository.key}`,
      "",
      `- Canonical repository: ${repository.repo}`,
      `- Primary: ${repository.primary ? "yes" : "no"}`,
      `- Default branch: ${repository.default_branch || "unverified"}`,
      `- Base clone: ${repository.working_dir}`,
      "- Role worktrees:",
      ...ROLE_IDS.map((role) => `  - ${role}: ${repository.worktrees[role]}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function projectRepositoryMapPath(configDir, projectId) {
  assertProjectId(projectId);
  if (typeof configDir !== "string" || !path.isAbsolute(configDir)) {
    throw new RepositoryProvisionError("invalid_config_directory", "config directory must be absolute");
  }
  return path.join(path.resolve(configDir), projectId, "PROJECT-REPOS.md");
}

function writeProjectRepositoryMap({ configDir, projectId, content, fsImpl = fs } = {}) {
  const target = projectRepositoryMapPath(configDir, projectId);
  if (typeof content !== "string") throw new TypeError("map content must be a string");
  const directory = path.dirname(target);
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(directory, 0o700); } catch {}
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fsImpl.openSync(temporary, "w", 0o600);
    fsImpl.writeFileSync(fd, content, "utf8");
    try { fsImpl.fsyncSync(fd); } catch {}
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
  try { fsImpl.chmodSync(temporary, 0o600); } catch {}
  try {
    fsImpl.renameSync(temporary, target);
  } catch (error) {
    try { fsImpl.unlinkSync(temporary); } catch {}
    throw error;
  }
  return target;
}

module.exports = {
  ROLE_IDS,
  RepositoryProvisionError,
  assertProjectId,
  canonicalRepositoryName,
  canonicalRepositoryFromRemote,
  expectedWorktreePath,
  roleBranch,
  assertRepositoryList,
  configuredRepositoryOwnership,
  buildRepositoryWorktreePlan,
  provisionRepositoryWorktrees,
  renderProjectRepositoryMap,
  projectRepositoryMapPath,
  writeProjectRepositoryMap,
};
