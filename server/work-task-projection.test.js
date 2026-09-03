"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent, applyWorkTaskPipelinePlan } = require("./work-task-pipeline");
const {
  WorkTaskProjectionError,
  projectWorkTaskBatch,
} = require("./work-task-projection");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof WorkTaskProjectionError && error.code === code);
}
function manifest() {
  return freezeBatchManifest(buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [
      {
        task_key: "api-one",
        repository_key: "api",
        work_item: { repoKey: "api", repo: "Owner/API", number: 42, kind: "issue" },
        goal: "first same-number API task",
        file_boundary: ["server/api-one.js"], validation: ["node:test"], dependencies: [],
      },
      {
        task_key: "api-two",
        repository_key: "api",
        work_item: { repoKey: "api", repo: "Owner/API", number: 42, kind: "issue" },
        goal: "second nested API task",
        file_boundary: ["server/api-two.js"], validation: ["node:test"], dependencies: [],
      },
      {
        task_key: "web-one",
        repository_key: "web",
        work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" },
        goal: "same number in another repository",
        file_boundary: ["src/web-one.tsx"], validation: ["npm:test"], dependencies: [],
      },
    ],
  }, {
    resolveRegisteredIdentity(input) {
      return { ...input, work_item: copy(input.work_item), issue_body_revision: (input.repository_key === "api" ? "c" : "d").repeat(64) };
    },
  }), "2026-09-02T00:00:00.000Z");
}

// Repository-qualified item grouping preserves both task order inside one
// ticket and same-number cross-repository identity without local path leakage.
{
  const batch = manifest();
  let pipeline = buildWorkTaskPipeline(batch);
  pipeline = applyWorkTaskPipelinePlan(pipeline, planWorkTaskPipelineEvent(pipeline, {
    version: 1,
    kind: "assign_build",
    event_id: "projection_api_build",
    work_task_ref: copy(batch.tasks[0].ref),
    assignment_id: "projection_assignment",
    base_sha,
  }));
  const projection = projectWorkTaskBatch({ version: 1, manifest: batch, pipeline });
  assert.equal(Object.isFrozen(projection), true);
  assert.deepEqual(projection.repositories.map((entry) => entry.repository_key), ["api", "web"]);
  assert.equal(projection.repositories[0].base_sha, base_sha);
  assert.equal(projection.repositories[0].work_items.length, 1);
  assert.deepEqual(projection.repositories[0].work_items[0].tasks.map((task) => [task.task_key, task.state]), [
    ["api-one", "building"],
    ["api-two", "queued"],
  ]);
  assert.equal(projection.repositories[1].work_items[0].work_item.number, 42);
  assert.equal(projection.repositories[1].work_items[0].tasks[0].work_task_ref.repository_key, "web");
  assert.doesNotMatch(JSON.stringify(projection), /managed_worktree|canonical_path|worktree-dev/);
}

{
  const left = manifest();
  const right = manifest();
  const pipeline = buildWorkTaskPipeline(left);
  const tampered = { ...pipeline, manifest_digest: right.manifest_digest.replace(/^./, "f") };
  throwsCode(() => projectWorkTaskBatch({ version: 1, manifest: left, pipeline: tampered }), "invalid_work_task_projection_request");
}

// Projection has no route/queue/filesystem authority and cannot become a
// second execution state machine.
{
  const source = fs.readFileSync(path.join(__dirname, "work-task-projection.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|config|mcp|file-chat|queue)["']\s*\)/);
  assert.doesNotMatch(source, /(?:writeFile|rename|unlink|execFile|spawn|worktree add|pull_request|\bmerge\b|deploy)/);
}

console.log("work-task-projection.test.js: all assertions passed");
