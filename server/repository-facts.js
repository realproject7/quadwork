"use strict";

// #1053: read-only repository facts captured before a recovery admits a new
// generation.  The point is to make dirty work visible to the operator and
// Head BEFORE anything touches the role worktree.  Every invocation is an
// argument-array `git` query (rev-parse, symbolic-ref, rev-list, status) run
// with `--no-optional-locks`, so even `status` cannot refresh or write the
// index.  Nothing here checks out, resets, cleans, stashes, restores, commits,
// fetches, or follows a caller-selected path: the only input is the configured
// role cwd.  A capture failure is a recorded `available: false` fact, never an
// exception, so it can never block or crash a legitimate recovery.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const GIT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_STATUS_ENTRIES = 100;
const MAX_STATUS_LINE = 256;

function gitEnvironment(env) {
  const out = {};
  // Inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would redirect the
  // query away from the role worktree; drop every GIT_* override.
  for (const [key, value] of Object.entries(env)) if (!key.startsWith("GIT_")) out[key] = value;
  out.GIT_OPTIONAL_LOCKS = "0";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

function git(cwd, env, args) {
  try {
    const output = execFileSync("git", ["--no-optional-locks", ...args], {
      cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { ok: true, output: output.replace(/\n$/, "") };
  } catch (error) {
    return { ok: false, code: error && error.code === "ENOENT" ? "git_unavailable" : "git_failed" };
  }
}

function unavailable(cwd, reason, capturedAt) {
  return { captured_at: capturedAt, available: false, reason, path: cwd, worktree: null, branch: null, head: null, upstream: null, ahead: null, behind: null, status: null };
}

function captureRepositoryFacts(input = {}) {
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : null;
  const now = typeof input.now === "function" ? input.now : () => new Date();
  const capturedAt = now().toISOString();
  if (!cwd) return unavailable(cwd, "worktree_unconfigured", capturedAt);
  try {
    let stat;
    try { stat = fs.statSync(cwd); } catch { return unavailable(cwd, "worktree_missing", capturedAt); }
    if (!stat.isDirectory()) return unavailable(cwd, "worktree_missing", capturedAt);
    const env = gitEnvironment(typeof input.env === "object" && input.env ? input.env : process.env);
    const identity = git(cwd, env, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]);
    if (!identity.ok) return unavailable(cwd, identity.code === "git_unavailable" ? "git_unavailable" : "not_a_repository", capturedAt);
    const [toplevel, gitDir, commonDir] = identity.output.split("\n").map((line) => path.resolve(cwd, line.trim()));
    const branch = git(cwd, env, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const head = git(cwd, env, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const upstream = git(cwd, env, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const counts = upstream.ok && head.ok ? git(cwd, env, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]) : { ok: false };
    const [ahead, behind] = counts.ok ? counts.output.split(/\s+/).map((value) => Number.parseInt(value, 10)) : [null, null];
    const status = git(cwd, env, ["status", "--porcelain"]);
    if (!status.ok) return unavailable(cwd, "git_failed", capturedAt);
    const lines = status.output ? status.output.split("\n") : [];
    return {
      captured_at: capturedAt,
      available: true,
      reason: null,
      path: cwd,
      worktree: { toplevel, git_dir: gitDir, common_dir: commonDir, linked_worktree: gitDir !== commonDir },
      branch: branch.ok ? branch.output : null,
      head: head.ok ? head.output : null,
      upstream: upstream.ok ? upstream.output : null,
      ahead: Number.isSafeInteger(ahead) ? ahead : null,
      behind: Number.isSafeInteger(behind) ? behind : null,
      status: {
        clean: lines.length === 0,
        count: lines.length,
        truncated: lines.length > MAX_STATUS_ENTRIES,
        entries: lines.slice(0, MAX_STATUS_ENTRIES).map((line) => line.slice(0, MAX_STATUS_LINE)),
      },
    };
  } catch {
    return unavailable(cwd, "capture_failed", capturedAt);
  }
}

module.exports = { captureRepositoryFacts, MAX_STATUS_ENTRIES };
