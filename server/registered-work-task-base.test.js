"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest } = require("./work-task-manifest");
const {
  RegisteredWorkTaskBaseError,
  createRegisteredWorkTaskBaseObserver,
} = require("./registered-work-task-base");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);
const sha1_base = "b".repeat(40);
const repositories = [{ key: "web", repo: "Owner/Product-Web", working_dir: "/var/repos/web", primary: true }];

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof RegisteredWorkTaskBaseError && error.code === code);
}
function taskRef() {
  return buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [{
      task_key: "build", repository_key: "web",
      work_item: { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" },
      goal: "read the registered server base", file_boundary: ["server/work.js"], validation: ["node:test"], dependencies: [],
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
      "rev-parse --show-toplevel": "/var/repos/web",
      "remote get-url origin": "git@github.com:Owner/Product-Web.git",
      "status --porcelain --untracked-files=all": "",
      "rev-parse --verify HEAD": base_sha,
    }[command];
    return { ok: output !== undefined, output: output || "", ...(overrides[command] || {}) };
  };
  return { value, calls };
}
function observer(overrides = {}) {
  const git = runner(overrides.git || {});
  return {
    git,
    value: createRegisteredWorkTaskBaseObserver({
      repositories, primary_agent_cwds: {}, repository_worktrees: {},
      canonicalize_path: overrides.canonicalize_path || canonicalizePath, run_git: git.value,
    }),
  };
}

{
  const subject = observer();
  assert.deepEqual(subject.value.readRegisteredBase({ version: 1, work_task_ref: taskRef() }), {
    version: 1, repository_key: "web", base_sha,
  });
  assert.equal(subject.git.calls.length, 4);
  console.log("  PASS: registered clean base resolves a server-owned SHA");
}

{
  const subject = observer({ git: { "rev-parse --verify HEAD": { output: sha1_base } } });
  assert.equal(subject.value.readRegisteredBase({ version: 1, work_task_ref: taskRef() }).base_sha, sha1_base);
  console.log("  PASS: registered clean base accepts a native SHA-1 Git object ID");
}

for (const [label, git, code] of [
  ["dirty base", { "status --porcelain --untracked-files=all": { output: " M operator-file" } }, "registered_work_task_base_dirty"],
  ["wrong origin", { "remote get-url origin": { output: "git@github.com:Other/Product-Web.git" } }, "registered_work_task_base_origin_mismatch"],
  ["invalid head", { "rev-parse --verify HEAD": { output: "not-a-sha" } }, "registered_work_task_base_head_invalid"],
]) {
  const subject = observer({ git });
  throwsCode(() => subject.value.readRegisteredBase({ version: 1, work_task_ref: taskRef() }), code);
  console.log(`  PASS: ${label} fails closed`);
}

{
  const source = fs.readFileSync(path.join(__dirname, "registered-work-task-base.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|child_process|http|https)["']\s*\)/);
  assert.doesNotMatch(source, /(?:writeFile|rename|unlink|rm -rf|reset --hard|checkout|worktree add|\bpush\b)/);
  console.log("  PASS: registered base observer has only injected read authority");
}

console.log("registered-work-task-base.test.js: all assertions passed");
