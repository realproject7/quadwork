// #947: setup wizard worktree creation must refresh stale existing clones
// before HEAD checks and initialize genuinely empty repos with inline identity.
//
// Plain node:assert script — run with
// `node server/routes.setupWorktrees.test.js`.

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
let mode = "stale";

cp.execFileSync = function stubExecFileSync(cmd, args, opts = {}) {
  commands.push({ cmd, args: args.slice(), cwd: opts.cwd || null });
  if (cmd !== "git" && cmd !== "gh") return realExecFileSync.apply(this, arguments);
  const joined = args.join(" ");
  if (cmd === "gh" && joined.startsWith("repo clone")) return "";
  if (cmd === "git" && joined === "fetch origin --prune") return "";
  if (cmd === "git" && joined === "rev-parse --verify HEAD") {
    if ((mode === "stale" || mode === "stale-no-origin-head") && commands.some((c) => c.args.join(" ") === "checkout -B main origin/main")) return "abc123\n";
    if (mode === "ready") return "abc123\n";
    const err = new Error("fatal: ambiguous argument 'HEAD'");
    err.stderr = Buffer.from("fatal: ambiguous argument 'HEAD'\n");
    throw err;
  }
  if (cmd === "git" && joined === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
    if (mode === "stale") return "origin/main\n";
    const err = new Error("fatal: ref not found");
    err.stderr = Buffer.from("fatal: ref not found\n");
    throw err;
  }
  if (cmd === "git" && joined === "rev-parse --verify origin/main") {
    if (mode === "stale-no-origin-head") return "abc123\n";
    const err = new Error("fatal: bad revision");
    err.stderr = Buffer.from("fatal: bad revision\n");
    throw err;
  }
  if (cmd === "git" && joined === "rev-parse --verify origin/master") {
    const err = new Error("fatal: bad revision");
    err.stderr = Buffer.from("fatal: bad revision\n");
    throw err;
  }
  if (cmd === "git" && joined === "checkout -B main origin/main") return "";
  if (cmd === "git" && joined.includes("-c user.name=QuadWork -c user.email=quadwork@localhost commit --allow-empty")) return "";
  if (cmd === "git" && joined === "symbolic-ref --short HEAD") return "main\n";
  if (cmd === "git" && joined === "push origin main") return "";
  const err = new Error(`unexpected command: ${cmd} ${joined}`);
  err.stderr = Buffer.from(err.message);
  throw err;
};

fs.existsSync = function stubExistsSync(p) {
  return existing.has(path.normalize(p));
};
fs.mkdirSync = () => {};
fs.chmodSync = () => {};

const { ensureGitHeadForSetup } = require("./routes");

function reset() {
  commands = [];
  existing = new Set();
  mode = "stale";
}

try {
  reset();
  existing.add(path.normalize("/tmp/proj/.git"));
  let result = ensureGitHeadForSetup("/tmp/proj", "owner/repo");
  assert.equal(result.ok, true, "stale existing clone with remote commits becomes ready");
  assert.ok(commands.some((c) => c.args.join(" ") === "fetch origin --prune"), "existing clone is fetched before HEAD handling");
  assert.ok(commands.some((c) => c.args.join(" ") === "checkout -B main origin/main"), "remote default branch is checked out when local HEAD is unborn");
  assert.ok(!commands.some((c) => c.args.includes("commit")), "stale clone with remote commits does not seed an empty commit");
  console.log("  PASS: stale empty local clone fetches/checks out remote default branch");

  reset();
  existing.add(path.normalize("/tmp/proj/.git"));
  mode = "stale-no-origin-head";
  result = ensureGitHeadForSetup("/tmp/proj", "owner/repo");
  assert.equal(result.ok, true, "stale clone without origin/HEAD checks out origin/main");
  assert.ok(commands.some((c) => c.args.join(" ") === "rev-parse --verify origin/main"), "origin/main fallback is checked");
  assert.ok(commands.some((c) => c.args.join(" ") === "checkout -B main origin/main"), "origin/main fallback is checked out");
  console.log("  PASS: stale clone falls back to origin/main when origin/HEAD is missing");

  reset();
  existing.add(path.normalize("/tmp/empty/.git"));
  mode = "empty";
  result = ensureGitHeadForSetup("/tmp/empty", "owner/repo");
  assert.equal(result.ok, true, "genuinely empty repo is initialized");
  const commit = commands.find((c) => c.args.includes("commit") && c.args.includes("--allow-empty"));
  assert.ok(commit, "empty repo path creates seed commit");
  assert.ok(commit.args.includes("user.name=QuadWork"), "seed commit uses inline user.name");
  assert.ok(commit.args.includes("user.email=quadwork@localhost"), "seed commit uses inline user.email");
  assert.ok(commands.some((c) => c.args.join(" ") === "push origin main"), "seed commit is pushed to default branch");
  console.log("  PASS: empty repo seeds with inline identity and pushes");

  reset();
  mode = "ready";
  result = ensureGitHeadForSetup("/tmp/new", "owner/repo");
  assert.equal(result.ok, true, "missing local clone is cloned and verified");
  assert.ok(commands.some((c) => c.cmd === "gh" && c.args.join(" ") === "repo clone owner/repo /tmp/new"), "missing clone is cloned via gh");
  console.log("  PASS: missing clone path still clones via gh");

  console.log("\n4 passed, 0 failed\n");
} catch (err) {
  console.error("test failed:", err);
  process.exitCode = 1;
} finally {
  cp.execFileSync = realExecFileSync;
  fs.existsSync = realExistsSync;
  fs.mkdirSync = realMkdirSync;
  fs.chmodSync = realChmodSync;
}
