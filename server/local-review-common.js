"use strict";

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_VERSION = 1;
const REVIEW_REF_ROOT = "refs/quadwork/reviews";
const REVIEW_ROLES = new Set(["re1", "re2"]);
const HOOK_MARKER = "quadwork-local-review-guard-v2";
const LEGACY_HOOK_MARKERS = ["quadwork-local-review-guard-v1"];
const UNTRACKED_CONTROL_FILES = new Set(["AGENTS.md", "CLAUDE.md", "DESIGN-GUIDE.md"]);

class ReviewError extends Error {
  constructor(message, code = "REVIEW_ERROR") {
    super(message);
    this.name = "ReviewError";
    this.code = code;
  }
}

function exec(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input: options.input,
      timeout: options.timeout || 120000,
    }).trim();
  } catch (error) {
    const stderr = String(error.stderr || "").trim();
    const stdout = String(error.stdout || "").trim();
    const detail = stderr || stdout || error.message || "command failed";
    throw new ReviewError(`${cmd} ${args.join(" ")} failed: ${detail}`, "COMMAND_FAILED");
  }
}

function tryExec(cmd, args, options = {}) {
  try {
    return { ok: true, output: exec(cmd, args, options) };
  } catch (error) {
    return { ok: false, output: error.message, error };
  }
}

function git(repo, args, options = {}) {
  return exec("git", ["-C", repo, ...args], options);
}

function tryGit(repo, args, options = {}) {
  return tryExec("git", ["-C", repo, ...args], options);
}

function normalizeTaskId(value) {
  const task = String(value || "").trim().replace(/^#/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(task) || task.includes("..")) {
    throw new ReviewError(
      "Task ID must be 1-80 characters using letters, numbers, '.', '_' or '-' (optionally prefixed with '#').",
      "INVALID_TASK"
    );
  }
  return task;
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!REVIEW_ROLES.has(role)) {
    throw new ReviewError("Reviewer role must be 're1' or 're2'.", "INVALID_ROLE");
  }
  return role;
}

function resolveRepository(input = process.cwd()) {
  const requested = path.resolve(input);
  const result = tryGit(requested, ["rev-parse", "--show-toplevel"]);
  if (!result.ok || !result.output) {
    throw new ReviewError(`${requested} is not inside a Git worktree.`, "NOT_A_REPOSITORY");
  }
  return path.resolve(result.output);
}

function resolveCommit(repo, value) {
  const result = tryGit(repo, ["rev-parse", "--verify", `${value}^{commit}`]);
  if (!result.ok || !/^[0-9a-f]{40}$/i.test(result.output)) {
    throw new ReviewError(`Cannot resolve commit '${value}'.`, "UNKNOWN_COMMIT");
  }
  return result.output.toLowerCase();
}

function currentHead(repo) {
  return resolveCommit(repo, "HEAD");
}

function currentBranch(repo) {
  const result = tryGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!result.ok || !result.output) {
    throw new ReviewError("A named feature branch is required; detached HEAD cannot become a review candidate.", "DETACHED_HEAD");
  }
  return result.output;
}

function statusLines(repo) {
  const raw = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).filter((line) => {
    if (!line.startsWith("?? ")) return true;
    const relative = line.slice(3).replace(/^"|"$/g, "");
    return !UNTRACKED_CONTROL_FILES.has(relative);
  });
}

function assertClean(repo) {
  const dirty = statusLines(repo);
  if (dirty.length) {
    const first = dirty.slice(0, 8).join("\n");
    throw new ReviewError(
      `Worktree is not clean. Commit or remove every change before creating/publishing an exact-SHA candidate:\n${first}`,
      "DIRTY_WORKTREE"
    );
  }
}

function gitCommonDir(repo) {
  let result = tryGit(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.ok && result.output) return path.resolve(result.output);
  result = tryGit(repo, ["rev-parse", "--git-common-dir"]);
  if (!result.ok || !result.output) {
    throw new ReviewError("Unable to resolve the shared Git directory.", "NO_COMMON_GIT_DIR");
  }
  return path.resolve(repo, result.output);
}

function refsFor(taskInput) {
  const task = normalizeTaskId(taskInput);
  const root = `${REVIEW_REF_ROOT}/${task}`;
  return {
    task,
    root,
    candidate: `${root}/candidate`,
    base: `${root}/base`,
    re1: `${root}/approvals/re1`,
    re2: `${root}/approvals/re2`,
    published: `${root}/published`,
  };
}

function readRef(repo, ref) {
  const result = tryGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return result.ok && /^[0-9a-f]{40}$/i.test(result.output)
    ? result.output.toLowerCase()
    : null;
}

function statePath(repo, taskInput) {
  const task = normalizeTaskId(taskInput);
  return path.join(gitCommonDir(repo), "quadwork", "reviews", `${task}.json`);
}

function readMetadata(repo, taskInput) {
  const file = statePath(repo, taskInput);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new ReviewError(`Cannot read local-review state ${file}: ${error.message}`, "STATE_READ_FAILED");
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function writeMetadata(repo, task, value) {
  atomicWriteJson(statePath(repo, task), value);
}

function updateRefsTransaction(repo, commands) {
  const input = ["start", ...commands, "prepare", "commit", ""].join("\n");
  exec("git", ["-C", repo, "update-ref", "--stdin"], { input });
}

function detectDefaultBase(repo) {
  const remoteHead = tryGit(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.ok && remoteHead.output) return remoteHead.output;
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    if (tryGit(repo, ["rev-parse", "--verify", `${candidate}^{commit}`]).ok) return candidate;
  }
  throw new ReviewError("Cannot infer the base branch. Pass --base <ref> (for example --base origin/main).", "NO_BASE");
}

function baseDescriptor(baseRef) {
  const raw = String(baseRef || "").trim();
  const remoteMatch = raw.match(/^([^/]+)\/(.+)$/);
  if (remoteMatch && !raw.startsWith("refs/")) {
    return { ref: raw, remote: remoteMatch[1], branch: remoteMatch[2], refreshable: true };
  }
  if (/^[A-Za-z0-9._/-]+$/.test(raw) && !raw.startsWith("refs/") && !/^[0-9a-f]{40}$/i.test(raw)) {
    return { ref: raw, remote: null, branch: raw, refreshable: true };
  }
  return { ref: raw, remote: null, branch: null, refreshable: false };
}

function isAncestor(repo, ancestor, descendant) {
  return tryGit(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

function repoIdentity(repo) {
  const common = gitCommonDir(repo);
  return crypto.createHash("sha256").update(common).digest("hex").slice(0, 16);
}

function managedReviewPath(repo, taskInput, roleInput) {
  const task = normalizeTaskId(taskInput);
  const role = normalizeRole(roleInput);
  return path.join(os.homedir(), ".quadwork", "review-worktrees", repoIdentity(repo), task, role);
}

function listWorktrees(repo) {
  const raw = git(repo, ["worktree", "list", "--porcelain"]);
  const blocks = raw.split(/\n\n+/).filter(Boolean);
  return blocks.map((block) => {
    const result = {};
    for (const line of block.split("\n")) {
      const index = line.indexOf(" ");
      if (index === -1) result[line] = true;
      else result[line.slice(0, index)] = line.slice(index + 1);
    }
    return result;
  });
}

module.exports = {
  STATE_VERSION, REVIEW_REF_ROOT, REVIEW_ROLES, HOOK_MARKER, LEGACY_HOOK_MARKERS,
  ReviewError, exec, tryExec, git, tryGit, normalizeTaskId, normalizeRole,
  resolveRepository, resolveCommit, currentHead, currentBranch, statusLines,
  assertClean, gitCommonDir, refsFor, readRef, statePath, readMetadata,
  atomicWriteJson, writeMetadata, updateRefsTransaction, detectDefaultBase,
  baseDescriptor, isAncestor, repoIdentity, managedReviewPath, listWorktrees,
};
