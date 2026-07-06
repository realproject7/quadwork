// #974: setup hardening — origin-mismatch guard, repo-slug normalization, and
// re-runnable worktree creation (reuse an existing branch instead of aborting).
// #975: the setup functions are now async (execFn injected) so the setup route
// never blocks the event loop; tests inject a fake async exec and await.
//
// Plain node:assert script — run with
// `node server/routes.setupHardening.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const realExistsSync = fs.existsSync;
const realMkdirSync = fs.mkdirSync;
const realChmodSync = fs.chmodSync;

let existing = new Set();
fs.existsSync = (p) => existing.has(path.normalize(p));
fs.mkdirSync = () => {};
fs.chmodSync = () => {};

const routes = require("./routes");
const { ensureGitHeadForSetup, createAgentWorktree, repoSlugFromRemote } = routes;

// A fake async exec: records calls, returns { ok, output } from a lookup keyed
// on the joined args (default { ok: true, output: "" }). Mirrors the exec()
// contract without touching a real shell.
function recordingExec(results, calls) {
  return async (cmd, args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    return results[key] !== undefined ? results[key] : { ok: true, output: "" };
  };
}

let passed = 0;

(async () => {
  try {
    // ── repoSlugFromRemote normalization ──
    assert.equal(repoSlugFromRemote("https://github.com/owner/repo.git"), "owner/repo", "https + .git");
    assert.equal(repoSlugFromRemote("https://github.com/Owner/Repo"), "owner/repo", "https, no .git, lowercased");
    assert.equal(repoSlugFromRemote("git@github.com:owner/repo.git"), "owner/repo", "ssh scp-form");
    assert.equal(repoSlugFromRemote("ssh://git@github.com/owner/repo.git"), "owner/repo", "ssh url");
    assert.equal(repoSlugFromRemote("https://github.com/owner/repo/"), "owner/repo", "trailing slash");
    assert.equal(repoSlugFromRemote(""), "", "empty");
    console.log("  PASS: repoSlugFromRemote normalizes common remote URL forms");
    passed++;

    // ── ensureGitHeadForSetup: origin matches → proceeds to HEAD verify ──
    existing = new Set([path.normalize("/tmp/proj/.git")]);
    let calls = [];
    let result = await ensureGitHeadForSetup("/tmp/proj", "owner/repo", recordingExec({
      "fetch origin --prune": { ok: true, output: "" },
      "remote get-url origin": { ok: true, output: "https://github.com/owner/repo.git" },
      "rev-parse --verify HEAD": { ok: true, output: "abc123" },
    }, calls));
    assert.equal(result.ok, true, "matching origin proceeds");
    assert.ok(calls.includes("remote get-url origin"), "origin is checked");
    assert.ok(calls.includes("rev-parse --verify HEAD"), "HEAD verified after origin match");
    console.log("  PASS: matching origin passes the guard and verifies HEAD");
    passed++;

    // ── ensureGitHeadForSetup: origin mismatch → clear error, no HEAD work ──
    existing = new Set([path.normalize("/tmp/proj/.git")]);
    calls = [];
    result = await ensureGitHeadForSetup("/tmp/proj", "owner/repo", recordingExec({
      "fetch origin --prune": { ok: true, output: "" },
      "remote get-url origin": { ok: true, output: "git@github.com:someone-else/other.git" },
    }, calls));
    assert.equal(result.ok, false, "mismatched origin fails");
    assert.match(result.error, /Origin mismatch/, "error names the mismatch");
    assert.match(result.error, /someone-else\/other/, "error reports the actual slug");
    assert.ok(!calls.includes("rev-parse --verify HEAD"), "aborts before HEAD work");
    console.log("  PASS: mismatched origin fails clearly before seeding anything");
    passed++;

    // ── createAgentWorktree: fresh branch (none exists) ──
    calls = [];
    let wt = await createAgentWorktree("/wd", "/wd-dev", "worktree-dev", recordingExec({
      "rev-parse --verify --quiet refs/heads/worktree-dev": { ok: false, output: "" },
      "branch worktree-dev HEAD": { ok: true, output: "" },
      "worktree add /wd-dev worktree-dev": { ok: true, output: "" },
    }, calls));
    assert.deepEqual(wt, { ok: true, detached: false }, "fresh branch created + attached");
    assert.ok(calls.includes("branch worktree-dev HEAD"), "creates the branch when absent");
    assert.ok(!calls.includes("worktree prune"), "no prune when branch is new");
    console.log("  PASS: createAgentWorktree creates a fresh branch when none exists");
    passed++;

    // ── createAgentWorktree: stale branch reuse (branch exists, dir gone) ──
    calls = [];
    wt = await createAgentWorktree("/wd", "/wd-dev", "worktree-dev", recordingExec({
      "rev-parse --verify --quiet refs/heads/worktree-dev": { ok: true, output: "abc" },
      "worktree prune": { ok: true, output: "" },
      "worktree add /wd-dev worktree-dev": { ok: true, output: "" },
    }, calls));
    assert.deepEqual(wt, { ok: true, detached: false }, "existing branch reused");
    assert.ok(calls.includes("worktree prune"), "prunes stale registration before re-attach");
    assert.ok(!calls.includes("branch worktree-dev HEAD"), "does NOT recreate an existing branch (the old brick)");
    console.log("  PASS: createAgentWorktree reuses an existing branch (re-runnable setup)");
    passed++;

    // ── createAgentWorktree: detached fallback when add fails ──
    calls = [];
    wt = await createAgentWorktree("/wd", "/wd-dev", "worktree-dev", recordingExec({
      "rev-parse --verify --quiet refs/heads/worktree-dev": { ok: false, output: "" },
      "branch worktree-dev HEAD": { ok: true, output: "" },
      "worktree add /wd-dev worktree-dev": { ok: false, output: "already checked out" },
      "worktree add --detach /wd-dev HEAD": { ok: true, output: "" },
    }, calls));
    assert.deepEqual(wt, { ok: true, detached: true }, "falls back to detached worktree");
    console.log("  PASS: createAgentWorktree falls back to a detached worktree");
    passed++;

    console.log(`\n${passed} passed, 0 failed\n`);
  } catch (err) {
    console.error("test failed:", err);
    process.exitCode = 1;
  } finally {
    fs.existsSync = realExistsSync;
    fs.mkdirSync = realMkdirSync;
    fs.chmodSync = realChmodSync;
  }
})();
