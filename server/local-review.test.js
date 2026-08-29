// Local-first exact-SHA review gate regression tests.
// Plain node:assert script — run with `node server/local-review.test.js`.

"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ReviewError,
  approveCandidate,
  assertExistingPrCanPublish,
  createCandidate,
  installPrePushGuard,
  normalizeTaskId,
  prepareReviewWorktree,
  publishCandidate,
  refsFor,
  reviewStatus,
  verifyPublishedCandidate,
} = require("./local-review");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `quadwork-local-review-${process.pid}-`));
const oldHome = process.env.HOME;
const oldPath = process.env.PATH;
process.env.HOME = path.join(TMP, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on("exit", () => {
  process.env.HOME = oldHome;
  process.env.PATH = oldPath;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function run(cmd, args, cwd, options = {}) {
  return execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  }).trim();
}

function git(cwd, ...args) {
  return run("git", args, cwd);
}

function commitFile(repo, name, body, message) {
  fs.writeFileSync(path.join(repo, name), body);
  git(repo, "add", name);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function expectReviewError(fn, code, message) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof ReviewError, `${message}: expected ReviewError`);
  assert.equal(caught.code, code, `${message}: expected ${code}, got ${caught.code}`);
}

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  PASS: ${message}`);
}

const remote = path.join(TMP, "origin.git");
const repo = path.join(TMP, "sample-dev");
run("git", ["init", "--bare", remote], TMP);
run("git", ["init", "-b", "main", repo], TMP);
git(repo, "config", "user.name", "QuadWork Test");
git(repo, "config", "user.email", "quadwork-test@example.invalid");
git(repo, "remote", "add", "origin", remote);
const initial = commitFile(repo, "README.md", "base\n", "base");
git(repo, "push", "-u", "origin", "main");
run("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], TMP);
git(repo, "checkout", "-b", "task/42-local-review");
const firstCandidate = commitFile(repo, "feature.txt", "one\n", "candidate one");
fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Dev — test-only untracked role instructions\n");

ok(normalizeTaskId("#42") === "42", "normalizes an issue-style task ID");
expectReviewError(() => normalizeTaskId("../escape"), "INVALID_TASK", "rejects unsafe task IDs");
passed++;

const created = createCandidate({ repo, task: "42", base: "origin/main" });
ok(created.candidateSha === firstCandidate, "candidate pins the clean Dev HEAD");
ok(created.base.sha === initial, "candidate pins the reviewed base SHA");
ok(created.guard.installed, "candidate installs the safe pre-push guard when no hook exists");
ok(fs.existsSync(path.join(repo, "AGENTS.md")), "candidate tolerates and preserves the untracked QuadWork role instruction file");

let status = reviewStatus({ repo, task: "42" });
ok(status.approvals.re1 === null && status.approvals.re2 === null, "new candidate starts with no approvals");
ok(!status.readyToPublish, "one cannot publish an unreviewed candidate");

// The generated hook must stop a normal intermediate push from *-dev.
const blocked = spawnSync("git", ["-C", repo, "push", "-u", "origin", "task/42-local-review"], {
  env: process.env,
  encoding: "utf8",
});
ok(blocked.status !== 0 && /blocked a direct push/.test(blocked.stderr), "direct intermediate git push is blocked in the Dev worktree");

expectReviewError(
  () => approveCandidate({ repo, task: "42", role: "re1", sha: initial }),
  "STALE_APPROVAL",
  "rejects approval of a non-candidate SHA"
);
passed++;

const re1Worktree = prepareReviewWorktree({ repo, task: "42", role: "re1" });
ok(git(re1Worktree.path, "rev-parse", "HEAD") === firstCandidate, "RE1 managed worktree checks out the exact candidate");
approveCandidate({ repo: re1Worktree.path, task: "42", role: "re1", summary: "reviewed exact SHA" });
status = reviewStatus({ repo, task: "42" });
ok(status.approvals.re1 === firstCandidate && status.approvals.re2 === null, "records one exact-SHA approval across shared worktrees");

approveCandidate({ repo, task: "42", role: "re2", sha: firstCandidate, summary: "second exact review" });
status = reviewStatus({ repo, task: "42" });
ok(status.readyToPublish, "dual approvals on the same SHA open the publication gate");

// A Dev fix is local only. A new candidate must invalidate both prior approvals.
fs.writeFileSync(path.join(repo, "feature.txt"), "two\n");
git(repo, "add", "feature.txt");
git(repo, "commit", "-m", "candidate two");
const secondCandidate = git(repo, "rev-parse", "HEAD");
createCandidate({ repo, task: "42", base: "origin/main" });
status = reviewStatus({ repo, task: "42" });
ok(status.candidateSha === secondCandidate, "a revised local commit becomes the new candidate");
ok(status.approvals.re1 === null && status.approvals.re2 === null, "new candidate atomically invalidates both old approvals");
const refreshedInPlace = prepareReviewWorktree({ repo: re1Worktree.path, task: "42", role: "re1", inPlace: true });
ok(refreshedInPlace.path === re1Worktree.path && git(re1Worktree.path, "rev-parse", "HEAD") === secondCandidate, "--in-place refreshes the configured reviewer worktree without a second clone");
expectReviewError(
  () => publishCandidate({ repo, task: "42", noPr: true }),
  "MISSING_APPROVAL",
  "publish refuses a revised candidate until both reviewers re-approve"
);
passed++;

approveCandidate({ repo, task: "42", role: "re1", sha: secondCandidate });
approveCandidate({ repo, task: "42", role: "re2", sha: secondCandidate });
const dryRun = publishCandidate({ repo, task: "42", noPr: true, dryRun: true });
ok(dryRun.readyToPublish && dryRun.pushNeeded, "dry-run reports one final push is required");

const published = publishCandidate({ repo, task: "42", noPr: true });
ok(published.pushNeeded, "approved candidate is pushed once");
ok(git(repo, "ls-remote", "--heads", "origin", "refs/heads/task/42-local-review").startsWith(secondCandidate), "remote feature branch equals the reviewed SHA");
status = reviewStatus({ repo, task: "42" });
ok(status.publishedSha === secondCandidate, "publication ref records the exact pushed SHA");

const repeated = publishCandidate({ repo, task: "42", noPr: true });
ok(!repeated.pushNeeded, "re-running publish at the same SHA is idempotent and does not push again");

// The formal-review/merge gate must prove the GitHub PR still names the exact
// locally approved candidate. A fake gh executable keeps this test offline.
const fakeBin = path.join(TMP, "bin");
const fakeGhState = path.join(TMP, "gh-pr.json");
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version test"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat "$QUADWORK_TEST_GH_JSON"
  exit 0
fi
exit 1
`, { mode: 0o755 });
process.env.PATH = `${fakeBin}${path.delimiter}${oldPath}`;
process.env.QUADWORK_TEST_GH_JSON = fakeGhState;
const goodPr = {
  number: 777,
  url: "https://github.example.invalid/acme/sample/pull/777",
  headRefName: "task/42-local-review",
  headRefOid: secondCandidate,
  baseRefName: "main",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
};
fs.writeFileSync(fakeGhState, JSON.stringify(goodPr));

const preflightStatus = {
  branch: "task/42-local-review",
  candidateSha: secondCandidate,
};
expectReviewError(
  () => assertExistingPrCanPublish({ ...goodPr, state: "CLOSED" }, preflightStatus, "main"),
  "PR_NOT_OPEN",
  "publish preflight rejects a closed existing PR before any remote mutation"
);
passed++;
expectReviewError(
  () => assertExistingPrCanPublish({ ...goodPr, baseRefName: "release" }, preflightStatus, "main"),
  "PR_BASE_MISMATCH",
  "publish preflight rejects an existing PR targeting the wrong base before any remote mutation"
);
passed++;

const verified = verifyPublishedCandidate({ repo, task: "42", pr: 777 });
ok(verified.pr.number === 777 && verified.candidateSha === secondCandidate, "verify binds local approvals, published ref, remote branch and PR head to one SHA");

fs.writeFileSync(fakeGhState, JSON.stringify({ ...goodPr, headRefOid: initial }));
expectReviewError(
  () => verifyPublishedCandidate({ repo, task: "42", pr: 777 }),
  "PR_HEAD_MISMATCH",
  "verify rejects a PR whose remote head moved away from the approved candidate"
);
passed++;

fs.writeFileSync(fakeGhState, JSON.stringify({ ...goodPr, isDraft: true }));
expectReviewError(
  () => verifyPublishedCandidate({ repo, task: "42", pr: 777 }),
  "PR_NOT_READY",
  "verify rejects a draft before formal GitHub approval or merge"
);
passed++;
fs.writeFileSync(fakeGhState, JSON.stringify(goodPr));

// Verify base drift protection on a second task. Move origin/main after local approval.
git(repo, "checkout", "main");
commitFile(repo, "base-two.txt", "base two\n", "base two");
git(repo, "push", "origin", "main");
git(repo, "checkout", "-b", "task/43-base-drift");
const driftCandidate = commitFile(repo, "drift.txt", "candidate\n", "drift candidate");
createCandidate({ repo, task: "43", base: "origin/main" });
approveCandidate({ repo, task: "43", role: "re1", sha: driftCandidate });
approveCandidate({ repo, task: "43", role: "re2", sha: driftCandidate });

const baseUpdater = path.join(TMP, "base-updater");
run("git", ["clone", remote, baseUpdater], TMP);
git(baseUpdater, "config", "user.name", "Base Updater");
git(baseUpdater, "config", "user.email", "base-updater@example.invalid");
git(baseUpdater, "checkout", "main");
commitFile(baseUpdater, "remote-main.txt", "moved\n", "move remote main");
git(baseUpdater, "push", "origin", "main");

expectReviewError(
  () => publishCandidate({ repo, task: "43", noPr: true, dryRun: true }),
  "BASE_MOVED",
  "publish refuses stale approvals when the protected base moved"
);
passed++;

const guard = installPrePushGuard(repo);
ok(guard.installed && guard.alreadyInstalled, "pre-push guard installation is idempotent");
ok(refsFor("42").candidate === "refs/quadwork/reviews/42/candidate", "review refs use a private, non-remote namespace");

console.log(`\n${passed} passed`);
console.log("server/local-review.test.js: all assertions passed");
