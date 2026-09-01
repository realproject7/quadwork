"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest } = require("./work-task-manifest");
const {
  ManagedWorktreeObserverError,
  createManagedWorktreeObserver,
  worktreeId,
} = require("./work-task-managed-worktree");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);
const repositories = [{ key: "web", repo: "Owner/Product-Web", working_dir: "/var/repos/web", primary: true }];

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ManagedWorktreeObserverError && error.code === code);
}
function taskRef() {
  return buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [{
      task_key: "build",
      repository_key: "web",
      work_item: { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" },
      goal: "observe one managed Dev worktree",
      file_boundary: ["server/work.js"],
      validation: ["node:test"],
      dependencies: [],
    }],
  }, {
    resolveRegisteredIdentity(input) {
      return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) };
    },
  }).tasks[0].ref;
}
function canonicalizePath(request) {
  assert.equal(Object.isFrozen(request), true);
  return request.path.replace(/^\/var\//, "/private/var/");
}
function runner(overrides = {}) {
  const calls = [];
  const value = (request) => {
    assert.equal(Object.isFrozen(request), true, "git request is immutable");
    assert.deepEqual(Object.keys(request).sort(), ["args", "cwd", "version"]);
    calls.push(copy(request));
    const command = request.args.join(" ");
    const output = {
      "rev-parse --show-toplevel": "/var/repos/web-dev",
      "rev-parse --git-common-dir": "../web/.git",
      "remote get-url origin": "git@github.com:Owner/Product-Web.git",
      "branch --show-current": "worktree-dev",
      "status --porcelain --untracked-files=all": "",
      "rev-parse --verify HEAD": candidate_sha,
      [`merge-base --is-ancestor ${base_sha} ${candidate_sha}`]: "",
    }[command];
    const result = { ok: output !== undefined, output: output || "" };
    return { ...result, ...(overrides[command] || {}) };
  };
  return { value, calls };
}
function expected(overrides = {}) {
  return {
    repository_key: "web",
    worktree_id: worktreeId("web"),
    canonical_path: "/private/var/repos/web-dev",
    branch: "worktree-dev",
    base_sha,
    candidate_sha,
    ...overrides,
  };
}
function observer(overrides = {}) {
  const git = runner(overrides.git || {});
  return {
    git,
    value: createManagedWorktreeObserver({
      repositories,
      primary_agent_cwds: {},
      repository_worktrees: {},
      canonicalize_path: overrides.canonicalize_path || canonicalizePath,
      run_git: git.value,
    }),
  };
}

// Candidate construction can use these two read seams, but the only accepted
// branch/path/id is the deterministic existing Dev role worktree.
{
  const subject = observer();
  assert.deepEqual(subject.value.canonicalizePath({ version: 1, path: "/var/repos/web-dev" }), {
    version: 1, canonical_path: "/private/var/repos/web-dev",
  });
  const actual = subject.value.inspectManagedWorktree({ version: 1, work_task_ref: taskRef(), expected: expected() });
  assert.equal(actual.worktree_id, "wt_web_dev");
  assert.equal(actual.head_sha, candidate_sha);
  assert.equal(actual.base_sha, base_sha);
  assert.equal(actual.occupancy, "vacant");
  assert.equal(subject.git.calls.length, 7);
}

// A caller cannot redirect a candidate into another path, branch, or worktree
// id before the observer performs a single Git command.
for (const [label, patch] of [
  ["path", { canonical_path: "/private/var/repos/other-dev" }],
  ["branch", { branch: "task/caller-chosen" }],
  ["id", { worktree_id: "wt_other_dev" }],
]) {
  const subject = observer();
  throwsCode(() => subject.value.inspectManagedWorktree({ version: 1, work_task_ref: taskRef(), expected: expected(patch) }), "managed_worktree_server_binding_mismatch");
  assert.equal(subject.git.calls.length, 0, `${label} mismatch must not invoke git`);
}

for (const [label, git, code] of [
  ["dirty", { "status --porcelain --untracked-files=all": { output: " M operator-file" } }, "managed_worktree_dirty"],
  ["wrong candidate", { "rev-parse --verify HEAD": { output: "d".repeat(64) } }, "managed_worktree_candidate_sha_mismatch"],
  ["base divergence", { [`merge-base --is-ancestor ${base_sha} ${candidate_sha}`]: { ok: false } }, "managed_worktree_base_mismatch"],
]) {
  const subject = observer({ git });
  throwsCode(() => subject.value.inspectManagedWorktree({ version: 1, work_task_ref: taskRef(), expected: expected() }), code);
  console.log(`  PASS: ${label} worktree proof fails closed`);
}

// This adapter has only injected read authority; it never obtains a process,
// filesystem mutation, or Git publication capability of its own.
{
  const source = fs.readFileSync(path.join(__dirname, "work-task-managed-worktree.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|child_process|http|https)["']\s*\)/);
  assert.doesNotMatch(source, /(?:writeFile|rename|unlink|rm -rf|reset --hard|checkout|worktree add|\bpush\b)/);
}

console.log("work-task-managed-worktree.test.js: all assertions passed");
