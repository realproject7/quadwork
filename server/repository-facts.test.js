"use strict";

// #1053: the read-only repository-facts capture is exercised against real git
// repositories, including a linked worktree with an upstream, dirty work, and
// every degraded input.  The strongest assertion is that the capture leaves
// every byte of the worktree and its index untouched.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { captureRepositoryFacts, MAX_STATUS_ENTRIES } = require("./repository-facts");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-repository-facts-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1", HOME: TMP };
function sh(cwd, args) { return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

// Every file under a directory (contents), plus the linked worktree's own
// git dir, so a capture that refreshed the index or touched a ref would show.
function fingerprint(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      hash.update(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

(async () => {
  const base = path.join(TMP, "base");
  const remote = path.join(TMP, "origin.git");
  const worktree = path.join(TMP, "role-dev");
  fs.mkdirSync(base);
  sh(base, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(base, "README.md"), "base\n");
  sh(base, ["add", "README.md"]);
  sh(base, ["commit", "-q", "-m", "base"]);
  sh(TMP, ["init", "-q", "--bare", remote]);
  sh(base, ["remote", "add", "origin", remote]);
  sh(base, ["push", "-q", "-u", "origin", "main"]);
  sh(base, ["worktree", "add", "-q", "-b", "task/42-facts", worktree, "main"]);
  sh(worktree, ["push", "-q", "-u", "origin", "task/42-facts"]);
  // One local commit ahead, then dirty work: a modified tracked file and an untracked one.
  fs.writeFileSync(path.join(worktree, "feature.txt"), "wip\n");
  sh(worktree, ["add", "feature.txt"]);
  sh(worktree, ["commit", "-q", "-m", "feature"]);
  const head = sh(worktree, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(worktree, "README.md"), "dirty\n");
  fs.writeFileSync(path.join(worktree, "untracked.txt"), "never committed\n");
  const gitDir = sh(worktree, ["rev-parse", "--absolute-git-dir"]);
  const beforeStatus = sh(worktree, ["status", "--porcelain"]);
  // Make the index's cached stat data stale for a clean tracked file.  A
  // `git status` that still holds the optional index lock would rewrite the
  // index to refresh it; the read-only capture must not.
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(worktree, "feature.txt"), stale, stale);
  const beforeWorktree = fingerprint(worktree);
  const beforeGitDir = fingerprint(gitDir);

  {
    const facts = await captureRepositoryFacts({ cwd: worktree, now: () => new Date("2026-09-03T00:00:00.000Z") });
    assert.equal(facts.available, true);
    assert.equal(facts.reason, null);
    assert.equal(facts.captured_at, "2026-09-03T00:00:00.000Z");
    assert.equal(facts.path, worktree);
    assert.equal(fs.realpathSync(facts.worktree.toplevel), fs.realpathSync(worktree));
    assert.equal(facts.worktree.linked_worktree, true, "a role worktree made by `git worktree add` is linked to the base clone");
    assert.equal(fs.realpathSync(facts.worktree.common_dir), fs.realpathSync(path.join(base, ".git")));
    assert.equal(facts.branch, "task/42-facts");
    assert.equal(facts.head, head);
    assert.equal(facts.upstream, "origin/task/42-facts");
    assert.equal(facts.ahead, 1);
    assert.equal(facts.behind, 0);
    assert.equal(facts.status.clean, false);
    assert.equal(facts.status.count, 2);
    assert.equal(facts.status.truncated, false);
    assert.deepEqual(facts.status.entries, [" M README.md", "?? untracked.txt"]);
    assert.equal(JSON.stringify(facts).includes("undefined"), false);
    assert.equal(fingerprint(worktree), beforeWorktree, "capture changed a byte of the worktree");
    assert.equal(fingerprint(gitDir), beforeGitDir, "capture wrote the index or a ref of the linked worktree");
    assert.equal(sh(worktree, ["status", "--porcelain"]), beforeStatus, "dirty work survived the capture byte-unchanged");
    console.log("  PASS: a dirty linked worktree reports identity, branch/upstream, ahead/behind, HEAD and status, and is left untouched");
  }

  {
    // Behind the upstream: a commit pushed to that branch from elsewhere.
    const elsewhere = path.join(TMP, "elsewhere");
    sh(TMP, ["clone", "-q", "-b", "task/42-facts", remote, elsewhere]);
    fs.writeFileSync(path.join(elsewhere, "remote.txt"), "remote\n");
    sh(elsewhere, ["add", "remote.txt"]);
    sh(elsewhere, ["commit", "-q", "-m", "remote"]);
    sh(elsewhere, ["push", "-q", "origin", "task/42-facts"]);
    sh(worktree, ["fetch", "-q", "origin"]);
    const facts = await captureRepositoryFacts({ cwd: worktree });
    assert.equal(facts.ahead, 1);
    assert.equal(facts.behind, 1);
    console.log("  PASS: HEAD-to-origin relation counts both directions");
  }

  {
    // Detached HEAD and no upstream degrade to nulls, not failure.
    const detached = path.join(TMP, "detached");
    sh(TMP, ["clone", "-q", "-b", "main", remote, detached]);
    sh(detached, ["checkout", "-q", "--detach"]);
    const facts = await captureRepositoryFacts({ cwd: detached });
    assert.equal(facts.available, true);
    assert.equal(facts.branch, null);
    assert.equal(typeof facts.head, "string");
    assert.equal(facts.upstream, null);
    assert.equal(facts.ahead, null);
    assert.equal(facts.behind, null);
    assert.equal(facts.status.clean, true);
    console.log("  PASS: detached HEAD without upstream is reported truthfully");
  }

  {
    // A status list is bounded; the count and truncation are still exact.
    const many = path.join(TMP, "many");
    fs.mkdirSync(many);
    sh(many, ["init", "-q"]);
    for (let index = 0; index < MAX_STATUS_ENTRIES + 5; index += 1) fs.writeFileSync(path.join(many, `f${String(index).padStart(4, "0")}.txt`), "x");
    const facts = await captureRepositoryFacts({ cwd: many });
    assert.equal(facts.status.count, MAX_STATUS_ENTRIES + 5);
    assert.equal(facts.status.truncated, true);
    assert.equal(facts.status.entries.length, MAX_STATUS_ENTRIES);
    assert.equal(facts.head, null, "an unborn branch has no HEAD commit");
    assert.equal(facts.branch, sh(many, ["symbolic-ref", "--short", "HEAD"]));
    console.log("  PASS: status output is bounded with an exact count");
  }

  {
    // Degraded inputs are recorded facts, never exceptions.
    assert.deepEqual((await captureRepositoryFacts({ cwd: null })).reason, "worktree_unconfigured");
    assert.deepEqual((await captureRepositoryFacts({})).reason, "worktree_unconfigured");
    const missing = await captureRepositoryFacts({ cwd: path.join(TMP, "does-not-exist") });
    assert.equal(missing.available, false);
    assert.equal(missing.reason, "worktree_missing");
    assert.equal(missing.status, null);
    const file = path.join(TMP, "a-file");
    fs.writeFileSync(file, "x");
    assert.equal((await captureRepositoryFacts({ cwd: file })).reason, "worktree_missing");
    const plain = path.join(TMP, "plain");
    fs.mkdirSync(plain);
    const notRepo = await captureRepositoryFacts({ cwd: plain, env: { PATH: process.env.PATH, HOME: TMP } });
    assert.equal(notRepo.available, false);
    assert.equal(notRepo.reason, "not_a_repository");
    // A `.git` pointer file to a gitdir that no longer exists: git fails, the
    // capture records that and returns.
    const broken = path.join(TMP, "broken");
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, ".git"), `gitdir: ${path.join(TMP, "gone", ".git", "worktrees", "broken")}\n`);
    const brokenFacts = await captureRepositoryFacts({ cwd: broken });
    assert.equal(brokenFacts.available, false);
    assert.equal(brokenFacts.reason, "not_a_repository");
    // An inherited GIT_DIR must not redirect the query away from the role cwd.
    const redirected = await captureRepositoryFacts({ cwd: plain, env: { ...process.env, GIT_DIR: path.join(base, ".git"), GIT_WORK_TREE: base } });
    assert.equal(redirected.available, false);
    assert.equal(redirected.reason, "not_a_repository");
    // A git binary that cannot be found is also just a fact.
    const noGit = await captureRepositoryFacts({ cwd: worktree, env: { PATH: path.join(TMP, "empty-path") } });
    assert.equal(noGit.available, false);
    assert.equal(noGit.reason, "git_unavailable");
    console.log("  PASS: unconfigured, missing, non-repository, broken, env-redirected and git-less captures degrade to recorded facts");
  }

  {
    // A repository-configured `core.fsmonitor` hook is executable code the
    // server does not control; plain `git status` runs it, the capture must not.
    const hooked = path.join(TMP, "hooked");
    sh(TMP, ["clone", "-q", "-b", "main", remote, hooked]);
    const marker = path.join(TMP, "fsmonitor-ran");
    const hook = path.join(TMP, "fsmonitor-hook.sh");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    sh(hooked, ["config", "core.fsmonitor", hook]);
    execFileSync("git", ["status", "--porcelain"], { cwd: hooked, env: ENV, stdio: "ignore" });
    assert.equal(fs.existsSync(marker), true, "control: plain git status executes the configured fsmonitor hook");
    fs.rmSync(marker);
    const facts = await captureRepositoryFacts({ cwd: hooked });
    assert.equal(facts.available, true);
    assert.equal(facts.status.clean, true);
    assert.equal(fs.existsSync(marker), false, "the capture executed the repository's fsmonitor hook");
    console.log("  PASS: a repository-configured fsmonitor hook runs under plain git status but never under the capture");
  }

  {
    // #1072: the mirror of the fsmonitor case, and the residual the module
    // contract pins.  `git status` must re-read a tracked file whose stat data
    // no longer matches its index entry, and re-reading runs the
    // `filter.<driver>.clean` command the tracked `.gitattributes` selects:
    // operator-owned code executing under the server's own user.  Unlike
    // fsmonitor this cannot be switched off, because suppressing it would mean
    // hiding `.gitattributes` / `.git/info/attributes` from git and making
    // `status` report something untrue.  So the assertion is the inverse of
    // the fsmonitor one: the capture DOES run the filter, and its facts are
    // STILL true, in both the clean and the dirty direction.
    const filtered = path.join(TMP, "filtered");
    const marker = path.join(TMP, "clean-filter-ran");
    const clean = path.join(TMP, "clean-filter.sh");
    const tracked = path.join(filtered, "tracked.txt");
    // Stat-stale without touching content: mtime/ctime no longer match the
    // index entry, so status cannot answer from its cache and must re-read.
    const stale = (seconds) => { const when = new Date(Date.now() - seconds * 1000); fs.utimesSync(tracked, when, when); };
    try {
      fs.mkdirSync(filtered);
      sh(filtered, ["init", "-q", "-b", "main"]);
      // Passes stdin through unchanged, so the filter cannot itself alter what
      // status sees: dirtiness reported below is real dirtiness.
      fs.writeFileSync(clean, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
      sh(filtered, ["config", "filter.marker.clean", `'${clean}'`]);
      fs.writeFileSync(path.join(filtered, ".gitattributes"), "tracked.txt filter=marker\n");
      fs.writeFileSync(tracked, "content\n");
      sh(filtered, ["add", ".gitattributes", "tracked.txt"]);
      sh(filtered, ["commit", "-q", "-m", "filtered"]);
      // Settle the index first.  The entry `git add` just wrote is "racily
      // clean" (its mtime is not older than the index's own mtime), so git
      // re-reads content whatever the cache says; backdating the file and
      // letting one plain status rewrite the entry makes the cache-hit control
      // below deterministic instead of a sub-second coin flip.
      stale(300);
      sh(filtered, ["status", "--porcelain"]);
      // Control, both directions: a settled stat-fresh entry needs no filter
      // (which is what proves the absence check can ever be false), and the
      // same file once stat-stale does run it under plain `git status`.
      fs.rmSync(marker, { force: true });
      sh(filtered, ["status", "--porcelain"]);
      assert.equal(fs.existsSync(marker), false, "control: a settled stat-fresh tracked file is answered from the index, no filter");
      stale(120);
      sh(filtered, ["status", "--porcelain"]);
      assert.equal(fs.existsSync(marker), true, "control: plain git status runs the configured clean filter on a stat-stale tracked file");
      // Setup itself runs the filter (`git add`, and the control status above),
      // so the marker is removed HERE: after all setup, immediately before the
      // capture.  A marker seen below was dropped BY THE CAPTURE and can never
      // be a setup artefact.  The control status refreshed the index, so the
      // file is re-staled first or status would answer from the cache again.
      stale(240);
      fs.rmSync(marker, { force: true });
      const facts = await captureRepositoryFacts({ cwd: filtered, env: ENV });
      assert.equal(fs.existsSync(marker), true, "ACCEPTED EXPOSURE (#1072): the capture ran the repository-configured clean filter");
      // ...and the facts are still true: unchanged content is reported clean.
      assert.equal(facts.available, true);
      assert.equal(facts.status.clean, true);
      assert.deepEqual(facts.status.entries, []);
      assert.equal(facts.status.count, 0);
      // True the other way too: a real content change is still reported dirty,
      // so `clean: true` above is a fact and not a filter-shaped blind spot.
      fs.writeFileSync(tracked, "changed\n");
      stale(360);
      fs.rmSync(marker, { force: true });
      const dirty = await captureRepositoryFacts({ cwd: filtered, env: ENV });
      assert.equal(fs.existsSync(marker), true, "ACCEPTED EXPOSURE (#1072): the capture ran the clean filter on the modified file too");
      assert.equal(dirty.available, true);
      assert.equal(dirty.status.clean, false);
      assert.deepEqual(dirty.status.entries, [" M tracked.txt"]);
      console.log("  PASS: the capture runs a repository-configured clean filter (accepted, unsuppressable exposure) and still reports truthful status");
    } finally {
      fs.rmSync(filtered, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
      fs.rmSync(clean, { force: true });
    }
  }

  {
    // A slow git never stalls the event loop: timers keep firing while the
    // capture waits on its child processes.
    const slowBin = path.join(TMP, "slow-bin");
    fs.mkdirSync(slowBin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(slowBin, "git"), `#!/bin/sh\nsleep 0.2\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const facts = await captureRepositoryFacts({ cwd: worktree, env: { ...process.env, PATH: `${slowBin}${path.delimiter}${process.env.PATH}` } });
    clearInterval(timer);
    assert.equal(facts.available, true);
    assert.equal(facts.branch, "task/42-facts");
    assert.ok(ticks > 0, "the event loop was blocked for the whole capture");
    console.log("  PASS: the capture runs its git queries off the event loop");
  }

  console.log("repository-facts.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
