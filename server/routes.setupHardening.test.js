// #974: setup hardening — origin-mismatch guard, repo-slug normalization, and
// re-runnable worktree creation (reuse an existing branch instead of aborting).
//
// Plain node:assert script — run with
// `node server/routes.setupHardening.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const realExecFileSync = cp.execFileSync;
const realExistsSync = fs.existsSync;
const realMkdirSync = fs.mkdirSync;
const realChmodSync = fs.chmodSync;

let existing = new Set();
let commands = [];
let originUrl = "https://github.com/owner/repo.git";

// Stub only git/gh; everything else falls through to the real impl.
cp.execFileSync = function stubExecFileSync(cmd, args, opts = {}) {
  commands.push({ cmd, args: args.slice(), cwd: opts.cwd || null });
  if (cmd !== "git" && cmd !== "gh") return realExecFileSync.apply(this, arguments);
  const joined = args.join(" ");
  if (cmd === "git" && joined === "fetch origin --prune") return "";
  if (cmd === "git" && joined === "remote get-url origin") return `${originUrl}\n`;
  if (cmd === "git" && joined === "rev-parse --verify HEAD") return "abc123\n";
  const err = new Error(`unexpected command: ${cmd} ${joined}`);
  err.stderr = Buffer.from(err.message);
  throw err;
};

fs.existsSync = (p) => existing.has(path.normalize(p));
fs.mkdirSync = () => {};
fs.chmodSync = () => {};

const routes = require("./routes");
const { ensureGitHeadForSetup, createAgentWorktree, repoSlugFromRemote } = routes;

function reset() {
  commands = [];
  existing = new Set();
  originUrl = "https://github.com/owner/repo.git";
}

let passed = 0;
try {
  // ── repoSlugFromRemote normalization ──
  reset();
  assert.equal(repoSlugFromRemote("https://github.com/owner/repo.git"), "owner/repo", "https + .git");
  assert.equal(repoSlugFromRemote("https://github.com/Owner/Repo"), "owner/repo", "https, no .git, lowercased");
  assert.equal(repoSlugFromRemote("git@github.com:owner/repo.git"), "owner/repo", "ssh scp-form");
  assert.equal(repoSlugFromRemote("ssh://git@github.com/owner/repo.git"), "owner/repo", "ssh url");
  assert.equal(repoSlugFromRemote("https://github.com/owner/repo/"), "owner/repo", "trailing slash");
  assert.equal(repoSlugFromRemote(""), "", "empty");
  console.log("  PASS: repoSlugFromRemote normalizes common remote URL forms");
  passed++;

  // ── ensureGitHeadForSetup: origin matches → proceeds to HEAD verify ──
  reset();
  existing.add(path.normalize("/tmp/proj/.git"));
  originUrl = "https://github.com/owner/repo.git";
  let result = ensureGitHeadForSetup("/tmp/proj", "owner/repo");
  assert.equal(result.ok, true, "matching origin proceeds");
  assert.ok(commands.some((c) => c.args.join(" ") === "remote get-url origin"), "origin is checked");
  assert.ok(commands.some((c) => c.args.join(" ") === "rev-parse --verify HEAD"), "HEAD verified after origin match");
  console.log("  PASS: matching origin passes the guard and verifies HEAD");
  passed++;

  // ── ensureGitHeadForSetup: origin mismatch → clear error, no HEAD work ──
  reset();
  existing.add(path.normalize("/tmp/proj/.git"));
  originUrl = "git@github.com:someone-else/other.git";
  result = ensureGitHeadForSetup("/tmp/proj", "owner/repo");
  assert.equal(result.ok, false, "mismatched origin fails");
  assert.match(result.error, /Origin mismatch/, "error names the mismatch");
  assert.match(result.error, /someone-else\/other/, "error reports the actual slug");
  assert.ok(!commands.some((c) => c.args.join(" ") === "rev-parse --verify HEAD"), "aborts before HEAD work");
  console.log("  PASS: mismatched origin fails clearly before seeding anything");
  passed++;

  // ── createAgentWorktree: fresh branch (none exists) ──
  const calls = [];
  const fakeExec = (results) => (cmd, args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    return results[key] !== undefined ? results[key] : { ok: true, output: "" };
  };

  calls.length = 0;
  let wt = createAgentWorktree("/wd", "/wd-dev", "worktree-dev", fakeExec({
    "rev-parse --verify --quiet refs/heads/worktree-dev": { ok: false, output: "" },
    "branch worktree-dev HEAD": { ok: true, output: "" },
    "worktree add /wd-dev worktree-dev": { ok: true, output: "" },
  }));
  assert.deepEqual(wt, { ok: true, detached: false }, "fresh branch created + attached");
  assert.ok(calls.includes("branch worktree-dev HEAD"), "creates the branch when absent");
  assert.ok(!calls.includes("worktree prune"), "no prune when branch is new");
  console.log("  PASS: createAgentWorktree creates a fresh branch when none exists");
  passed++;

  // ── createAgentWorktree: stale branch reuse (branch exists, dir gone) ──
  calls.length = 0;
  wt = createAgentWorktree("/wd", "/wd-dev", "worktree-dev", fakeExec({
    "rev-parse --verify --quiet refs/heads/worktree-dev": { ok: true, output: "abc\n" },
    "worktree prune": { ok: true, output: "" },
    "worktree add /wd-dev worktree-dev": { ok: true, output: "" },
  }));
  assert.deepEqual(wt, { ok: true, detached: false }, "existing branch reused");
  assert.ok(calls.includes("worktree prune"), "prunes stale registration before re-attach");
  assert.ok(!calls.includes("branch worktree-dev HEAD"), "does NOT recreate an existing branch (the old brick)");
  console.log("  PASS: createAgentWorktree reuses an existing branch (re-runnable setup)");
  passed++;

  // ── createAgentWorktree: detached fallback when add fails ──
  calls.length = 0;
  wt = createAgentWorktree("/wd", "/wd-dev", "worktree-dev", fakeExec({
    "rev-parse --verify --quiet refs/heads/worktree-dev": { ok: false, output: "" },
    "branch worktree-dev HEAD": { ok: true, output: "" },
    "worktree add /wd-dev worktree-dev": { ok: false, output: "already checked out" },
    "worktree add --detach /wd-dev HEAD": { ok: true, output: "" },
  }));
  assert.deepEqual(wt, { ok: true, detached: true }, "falls back to detached worktree");
  console.log("  PASS: createAgentWorktree falls back to a detached worktree");
  passed++;

  console.log(`\n${passed} passed, 0 failed\n`);
} catch (err) {
  console.error("test failed:", err);
  process.exitCode = 1;
} finally {
  cp.execFileSync = realExecFileSync;
  fs.existsSync = realExistsSync;
  fs.mkdirSync = realMkdirSync;
  fs.chmodSync = realChmodSync;
}
