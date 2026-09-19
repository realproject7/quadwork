#!/usr/bin/env node
"use strict";

// This is a local replay contract test. It uses V2's manifest, pipeline, and
// candidate primitives plus real temporary Git worktrees. It does not start a
// server, call an MCP tool, launch a model, use GitHub, or mutate a remote.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { buildWorkTaskCandidate } = require("../server/work-task-candidate");
const { planWorkTaskPipelineEvent, applyWorkTaskPipelinePlan } = require("../server/work-task-pipeline");
const { createV2FixtureBatch, V2WorkloadAdapterError } = require("./v2-workload-adapter.cjs");

const ROOT = path.join(__dirname, "fixtures", "catalog");
const copy = (value) => JSON.parse(JSON.stringify(value));
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
const workload = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name, "WORKLOAD.json"), "utf8"));

function identity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "b".repeat(64) }; }
function build(name) {
  return createV2FixtureBatch({
    version: 1, workload: workload(name),
    ticket_bindings: [
      { ticket: "ticket_a", repository_key: "catalog", repo: "Example/Catalog", number: 101, kind: "issue" },
      { ticket: "ticket_b", repository_key: "catalog", repo: "Example/Catalog", number: 102, kind: "issue" },
    ],
    installation_id: "benchmark_installation_0001", project_id: "benchmark-local", delivery_mode: "integrated",
    frozen_at: "2026-09-19T00:00:00.000Z", resolve_registered_identity: identity,
  });
}
function apply(pipeline, event) { return applyWorkTaskPipelinePlan(pipeline, planWorkTaskPipelineEvent(pipeline, event)); }
function task(batch, id) { return batch.manifest.tasks.find((entry) => entry.ref.task_key === id).ref; }

function localCandidate(ref, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-benchmark-v2-adapter-"));
  const repo = path.join(root, "repo"), worktree = path.join(root, "worktree");
  try {
    fs.mkdirSync(repo); git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "QuadWork benchmark fixture"]); git(repo, ["config", "user.email", "benchmark@example.test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]); git(repo, ["worktree", "add", "-b", `candidate-${label}`, worktree, base]);
    fs.writeFileSync(path.join(worktree, `${label}.txt`), `${label}\n`); git(worktree, ["add", "."]); git(worktree, ["commit", "-m", `candidate ${label}`]);
    const candidateSha = git(worktree, ["rev-parse", "HEAD"]), canonical = fs.realpathSync(worktree);
    const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: ref, base_sha: base, candidate_sha: candidateSha, branch: `candidate-${label}`,
      worktree: { repository_key: "catalog", worktree_id: `wt_${label}`, path: canonical } }, {
      canonicalizePath(input) { return { version: 1, canonical_path: fs.realpathSync(input.path) }; },
      inspectManagedWorktree() { return { version: 1, registered: true, readable: true, repository_key: "catalog", worktree_id: `wt_${label}`, canonical_path: canonical,
        branch: `candidate-${label}`, base_sha: base, head_sha: candidateSha, dirty: false, occupancy: "vacant" }; },
      readCanonicalInstalledState() { return { version: 1, installation_id: ref.installation_id, project_id: ref.project_id, v1_state: "present" }; },
    });
    return { candidate, base, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

test("pipeline fixture maps to a frozen V2 batch and permits a disjoint build while A1 is under review", () => {
  const batch = build("pipeline");
  assert.equal(batch.workload_class, "pipeline_eligible");
  assert.equal(batch.manifest.frozen !== null, true); assert.equal(batch.pipeline.manifest_frozen, true);
  assert.deepEqual(batch.manifest.tasks.map((entry) => entry.ref.task_key), ["a1", "a2", "b1"]);
  assert.equal(task(batch, "a2").work_item.number, 101); assert.equal(task(batch, "b1").work_item.number, 102);
  let pipeline = batch.pipeline; const a1 = task(batch, "a1"), b1 = task(batch, "b1");
  const local = localCandidate(a1, "a1");
  try {
    pipeline = apply(pipeline, { version: 1, kind: "assign_build", event_id: "bench_a1_build", work_task_ref: copy(a1), assignment_id: "bench_a1_assignment", base_sha: local.base });
    pipeline = apply(pipeline, { version: 1, kind: "record_candidate", event_id: "bench_a1_candidate", assignment_id: "bench_a1_assignment", candidate: local.candidate });
    pipeline = apply(pipeline, { version: 1, kind: "assign_independent_review", event_id: "bench_a1_review", work_task_ref: copy(a1), review_round_id: "bench_a1_round", candidate_digest: local.candidate.candidate_digest });
    pipeline = apply(pipeline, { version: 1, kind: "assign_build", event_id: "bench_b1_build", work_task_ref: copy(b1), assignment_id: "bench_b1_assignment", base_sha: local.base });
    assert.equal(pipeline.tasks.find((slot) => slot.work_task_ref.task_key === "a1").state, "independent_review");
    assert.equal(pipeline.tasks.find((slot) => slot.work_task_ref.task_key === "b1").state, "building");
  } finally { local.cleanup(); }
});

test("overlap fixture uses the same V2 contract but refuses the declared dependent before A1 is accepted", () => {
  const batch = build("overlap"); let pipeline = batch.pipeline; const a1 = task(batch, "a1"), a2 = task(batch, "a2");
  const local = localCandidate(a1, "overlap_a1");
  try {
    pipeline = apply(pipeline, { version: 1, kind: "assign_build", event_id: "overlap_a1_build", work_task_ref: copy(a1), assignment_id: "overlap_a1_assignment", base_sha: local.base });
    pipeline = apply(pipeline, { version: 1, kind: "record_candidate", event_id: "overlap_a1_candidate", assignment_id: "overlap_a1_assignment", candidate: local.candidate });
    pipeline = apply(pipeline, { version: 1, kind: "assign_independent_review", event_id: "overlap_a1_review", work_task_ref: copy(a1), review_round_id: "overlap_a1_round", candidate_digest: local.candidate.candidate_digest });
    assert.throws(() => planWorkTaskPipelineEvent(pipeline, { version: 1, kind: "assign_build", event_id: "overlap_a2_early", work_task_ref: copy(a2), assignment_id: "overlap_a2_assignment", base_sha: local.candidate.candidate_sha }), error => error?.code === "work_task_dependencies_not_ready");
  } finally { local.cleanup(); }
});

test("adapter requires observed disposable ticket bindings and rejects malformed workload inputs", () => {
  const input = {
    version: 1, workload: workload("pipeline"), ticket_bindings: [{ ticket: "ticket_a", repository_key: "catalog", repo: "Example/Catalog", number: 101, kind: "issue" }],
    installation_id: "benchmark_installation_0001", project_id: "benchmark-local", delivery_mode: "integrated", frozen_at: "2026-09-19T00:00:00.000Z", resolve_registered_identity: identity,
  };
  assert.throws(() => createV2FixtureBatch(input), error => error instanceof V2WorkloadAdapterError && error.code === "missing_benchmark_ticket_binding");
  const invalid = workload("pipeline"); invalid.tasks[1].depends_on = ["unknown"];
  assert.throws(() => createV2FixtureBatch({ ...input, workload: invalid, ticket_bindings: [...input.ticket_bindings, { ticket: "ticket_b", repository_key: "catalog", repo: "Example/Catalog", number: 102, kind: "issue" }] }), error => error instanceof V2WorkloadAdapterError && error.code === "unknown_benchmark_workload_dependency");
  const protectedPath = workload("pipeline"); protectedPath.tasks[0].path = "WORKLOAD.json";
  assert.throws(() => createV2FixtureBatch({ ...input, workload: protectedPath, ticket_bindings: [...input.ticket_bindings, { ticket: "ticket_b", repository_key: "catalog", repo: "Example/Catalog", number: 102, kind: "issue" }] }), error => error instanceof V2WorkloadAdapterError && error.code === "benchmark_workload_task_path_read_only");
});
