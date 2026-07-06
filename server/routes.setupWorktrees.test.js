// #947: setup wizard worktree creation must refresh stale existing clones
// before HEAD checks and initialize genuinely empty repos with inline identity.
// #975: ensureGitHeadForSetup is now async with an injectable execFn (so setup
// shell-outs run off the event loop); this test injects a fake async exec that
// returns the exec() { ok, output } contract and awaits the function.
//
// Plain node:assert script — run with
// `node server/routes.setupWorktrees.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const realExistsSync = fs.existsSync;
const realMkdirSync = fs.mkdirSync;
const realChmodSync = fs.chmodSync;

let existing = new Set();

fs.existsSync = function stubExistsSync(p) {
  return existing.has(path.normalize(p));
};
fs.mkdirSync = () => {};
fs.chmodSync = () => {};

const { ensureGitHeadForSetup } = require("./routes");

// Fake async exec mirroring the real git/gh behavior for each mode. Records the
// joined args into `calls` and returns { ok, output } (never touches a shell).
function makeExec(mode, calls) {
  return async (cmd, args) => {
    calls.push(args.join(" "));
    const joined = args.join(" ");
    if (cmd === "gh" && joined.startsWith("repo clone")) return { ok: true, output: "" };
    if (cmd === "git" && joined === "fetch origin --prune") return { ok: true, output: "" };
    // #974: origin-match guard — return a URL matching "owner/repo" so the
    // guard passes and the HEAD-handling flow (the subject of this test) runs.
    if (cmd === "git" && joined === "remote get-url origin") {
      return { ok: true, output: "https://github.com/owner/repo.git" };
    }
    if (cmd === "git" && joined === "rev-parse --verify HEAD") {
      if ((mode === "stale" || mode === "stale-no-origin-head") && calls.includes("checkout -B main origin/main")) {
        return { ok: true, output: "abc123" };
      }
      if (mode === "ready") return { ok: true, output: "abc123" };
      return { ok: false, output: "fatal: ambiguous argument 'HEAD'" };
    }
    if (cmd === "git" && joined === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
      if (mode === "stale") return { ok: true, output: "origin/main" };
      return { ok: false, output: "fatal: ref not found" };
    }
    if (cmd === "git" && joined === "rev-parse --verify origin/main") {
      if (mode === "stale-no-origin-head") return { ok: true, output: "abc123" };
      return { ok: false, output: "fatal: bad revision" };
    }
    if (cmd === "git" && joined === "rev-parse --verify origin/master") {
      return { ok: false, output: "fatal: bad revision" };
    }
    if (cmd === "git" && joined === "checkout -B main origin/main") return { ok: true, output: "" };
    if (cmd === "git" && joined.includes("-c user.name=QuadWork -c user.email=quadwork@localhost commit --allow-empty")) {
      return { ok: true, output: "" };
    }
    if (cmd === "git" && joined === "symbolic-ref --short HEAD") return { ok: true, output: "main" };
    if (cmd === "git" && joined === "push origin main") return { ok: true, output: "" };
    return { ok: false, output: `unexpected command: ${cmd} ${joined}` };
  };
}

(async () => {
  try {
    // stale empty local clone → fetch + checkout remote default branch
    existing = new Set([path.normalize("/tmp/proj/.git")]);
    let calls = [];
    let result = await ensureGitHeadForSetup("/tmp/proj", "owner/repo", makeExec("stale", calls));
    assert.equal(result.ok, true, "stale existing clone with remote commits becomes ready");
    assert.ok(calls.includes("fetch origin --prune"), "existing clone is fetched before HEAD handling");
    assert.ok(calls.includes("checkout -B main origin/main"), "remote default branch is checked out when local HEAD is unborn");
    assert.ok(!calls.some((c) => c.includes("commit")), "stale clone with remote commits does not seed an empty commit");
    console.log("  PASS: stale empty local clone fetches/checks out remote default branch");

    // stale clone without origin/HEAD → origin/main fallback
    existing = new Set([path.normalize("/tmp/proj/.git")]);
    calls = [];
    result = await ensureGitHeadForSetup("/tmp/proj", "owner/repo", makeExec("stale-no-origin-head", calls));
    assert.equal(result.ok, true, "stale clone without origin/HEAD checks out origin/main");
    assert.ok(calls.includes("rev-parse --verify origin/main"), "origin/main fallback is checked");
    assert.ok(calls.includes("checkout -B main origin/main"), "origin/main fallback is checked out");
    console.log("  PASS: stale clone falls back to origin/main when origin/HEAD is missing");

    // genuinely empty repo → seed inline-identity commit + push
    existing = new Set([path.normalize("/tmp/empty/.git")]);
    calls = [];
    result = await ensureGitHeadForSetup("/tmp/empty", "owner/repo", makeExec("empty", calls));
    assert.equal(result.ok, true, "genuinely empty repo is initialized");
    const commit = calls.find((c) => c.includes("commit") && c.includes("--allow-empty"));
    assert.ok(commit, "empty repo path creates seed commit");
    assert.ok(commit.includes("user.name=QuadWork"), "seed commit uses inline user.name");
    assert.ok(commit.includes("user.email=quadwork@localhost"), "seed commit uses inline user.email");
    assert.ok(calls.includes("push origin main"), "seed commit is pushed to default branch");
    console.log("  PASS: empty repo seeds with inline identity and pushes");

    // missing local clone → cloned via gh
    existing = new Set();
    calls = [];
    result = await ensureGitHeadForSetup("/tmp/new", "owner/repo", makeExec("ready", calls));
    assert.equal(result.ok, true, "missing local clone is cloned and verified");
    assert.ok(calls.includes("repo clone owner/repo /tmp/new"), "missing clone is cloned via gh");
    console.log("  PASS: missing clone path still clones via gh");

    console.log("\n4 passed, 0 failed\n");
  } catch (err) {
    console.error("test failed:", err);
    process.exitCode = 1;
  } finally {
    fs.existsSync = realExistsSync;
    fs.mkdirSync = realMkdirSync;
    fs.chmodSync = realChmodSync;
  }
})();
