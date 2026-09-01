"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const {
  WorkTaskPipelineError,
  assertWorkTaskPipeline,
  assertWorkTaskPipelinePlan,
  buildWorkTaskPipeline,
  planWorkTaskPipelineEvent,
  applyWorkTaskPipelinePlan,
} = require("./work-task-pipeline");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof WorkTaskPipelineError && error.code === expected);
}
function item(repoKey, number) {
  return { repoKey, repo: `Owner/${repoKey}`, number, kind: "issue" };
}
function resolveRegisteredIdentity(input) {
  return {
    installation_id: input.installation_id,
    project_id: input.project_id,
    repository_key: input.repository_key,
    work_item: copy(input.work_item),
    issue_body_revision: ({ api: "c", web: "d", ops: "e" })[input.repository_key].repeat(64),
  };
}
function sourceTask(task_key, repository_key, number, dependencies = [], goal = `implement-${task_key}`, file_boundary = [`server/${repository_key}-${task_key}.js`]) {
  return {
    task_key,
    repository_key,
    work_item: item(repository_key, number),
    goal,
    file_boundary,
    validation: ["node:test"],
    dependencies,
  };
}
function manifest(frozen = true, coreGoal = "implement-core") {
  const core = sourceTask("core", "api", 10, [], coreGoal);
  const web = sourceTask("web", "web", 20, [{ repository_key: "api", work_item: copy(core.work_item), task_key: "core" }]);
  const api = sourceTask("api-client", "api", 11, [{ repository_key: "api", work_item: copy(core.work_item), task_key: "core" }]);
  const ops = sourceTask("ops", "ops", 30);
  const built = buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [core, web, api, ops],
  }, { resolveRegisteredIdentity });
  return frozen ? freezeBatchManifest(built, "2026-09-01T00:00:00Z") : built;
}
function manifestForTasks(tasks) {
  return freezeBatchManifest(buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks,
  }, { resolveRegisteredIdentity }), "2026-09-01T00:00:00Z");
}
function refs(manifestValue) {
  return Object.fromEntries(manifestValue.tasks.map((entry) => [entry.ref.task_key, entry.ref]));
}
function slot(pipeline, taskRef) {
  return pipeline.tasks.find((entry) => entry.work_task_ref.task_revision === taskRef.task_revision);
}
function candidateFor(taskRef, marker, candidateBase = base_sha) {
  const candidate_sha = marker.repeat(64);
  const worktree_id = `wt_${taskRef.repository_key}_${taskRef.task_key}_${marker}`;
  const worktreePath = `/private/var/tmp/quadwork-${taskRef.repository_key}-${taskRef.task_key}-${marker}`;
  return buildWorkTaskCandidate({
    version: 1,
    work_task_ref: copy(taskRef),
    base_sha: candidateBase,
    candidate_sha,
    branch: `task/${taskRef.repository_key}-${taskRef.task_key}-${marker}`,
    worktree: { repository_key: taskRef.repository_key, worktree_id, path: worktreePath },
  }, {
    canonicalizePath(request) {
      assert.equal(Object.isFrozen(request), true);
      return { version: 1, canonical_path: request.path };
    },
    inspectManagedWorktree(request) {
      return {
        version: 1,
        registered: true,
        readable: true,
        repository_key: request.expected.repository_key,
        worktree_id: request.expected.worktree_id,
        canonical_path: request.expected.canonical_path,
        branch: request.expected.branch,
        base_sha: request.expected.base_sha,
        head_sha: request.expected.candidate_sha,
        dirty: false,
        occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() {
      return { version: 1, installation_id, project_id, v1_state: "present" };
    },
  });
}
function event(kind, event_id, fields = {}) {
  return { version: 1, kind, event_id, ...(kind === "assign_build" ? { base_sha } : {}), ...fields };
}
function apply(pipeline, nextEvent) {
  const plan = planWorkTaskPipelineEvent(pipeline, nextEvent);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(assertWorkTaskPipelinePlan(plan), plan);
  const next = applyWorkTaskPipelinePlan(pipeline, plan);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(assertWorkTaskPipeline(next), next);
  return next;
}
function moveToCandidate(pipeline, taskRef, marker, prefix) {
  const candidate = candidateFor(taskRef, marker);
  let next = apply(pipeline, event("assign_build", `${prefix}_build`, { work_task_ref: copy(taskRef), assignment_id: `${prefix}_assignment` }));
  next = apply(next, event("record_candidate", `${prefix}_candidate`, { candidate }));
  return { pipeline: next, candidate };
}

// Review/build overlap is allowed only for independent tasks whose declared
// boundaries are provably disjoint in the same repository.  The one Dev lane
// is still serialized; this protects the exact candidate under review.
{
  const batch = manifestForTasks([
    sourceTask("alpha", "api", 10, [], "alpha", ["server/alpha.js"]),
    sourceTask("beta", "api", 10, [], "beta", ["server/beta.js"]),
    sourceTask("overlap", "api", 10, [], "overlap", ["server/alpha.js/helpers"]),
    sourceTask("legacy", "api", 10, [], "legacy", []),
  ]);
  const workRefs = refs(batch);
  let work = buildWorkTaskPipeline(batch);
  const alpha = candidateFor(workRefs.alpha, "b");
  work = apply(work, event("assign_build", "boundary_alpha_build", {
    work_task_ref: copy(workRefs.alpha), assignment_id: "boundary_alpha_assignment",
  }));
  work = apply(work, event("record_candidate", "boundary_alpha_candidate", { candidate: alpha }));
  work = apply(work, event("assign_independent_review", "boundary_alpha_review", {
    work_task_ref: copy(workRefs.alpha), review_round_id: "boundary_alpha_round", candidate_digest: alpha.candidate_digest,
  }));
  work = apply(work, event("assign_build", "boundary_beta_build", {
    work_task_ref: copy(workRefs.beta), assignment_id: "boundary_beta_assignment",
  }));
  assert.equal(slot(work, workRefs.beta).state, "building");

  work = apply(work, event("block", "boundary_beta_stop", {
    work_task_ref: copy(workRefs.beta), block_code: "validation",
  }));
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_build", "boundary_overlap_build", {
    work_task_ref: copy(workRefs.overlap), assignment_id: "boundary_overlap_assignment",
  })), "work_task_review_boundary_overlap");
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_build", "boundary_legacy_build", {
    work_task_ref: copy(workRefs.legacy), assignment_id: "boundary_legacy_assignment",
  })), "work_task_review_boundary_overlap");
}

// A candidate may only begin review from the immutable base SHA issued with
// the current Head build assignment.  Candidate validation alone cannot infer
// that authoritative assignment context.
{
  const batch = manifest();
  const workRefs = refs(batch);
  let work = buildWorkTaskPipeline(batch);
  work = apply(work, event("assign_build", "base_pin_build", {
    work_task_ref: copy(workRefs.core), assignment_id: "base_pin_assignment",
  }));
  const foreignBase = "f".repeat(64);
  const wrongBaseCandidate = candidateFor(workRefs.core, "b", foreignBase);
  throwsCode(() => planWorkTaskPipelineEvent(work, event("record_candidate", "base_pin_mismatch", {
    candidate: wrongBaseCandidate,
  })), "work_task_candidate_base_mismatch");
}
function moveToAccepted(pipeline, taskRef, marker, prefix) {
  const built = moveToCandidate(pipeline, taskRef, marker, prefix);
  let next = apply(built.pipeline, event("assign_independent_review", `${prefix}_review`, {
    work_task_ref: copy(taskRef), review_round_id: `${prefix}_round`, candidate_digest: built.candidate.candidate_digest,
  }));
  next = apply(next, event("record_review_verdict", `${prefix}_verdict`, {
    work_task_ref: copy(taskRef), review_round_id: `${prefix}_round`, candidate_digest: built.candidate.candidate_digest, verdict: "approved",
  }));
  next = apply(next, event("reconcile_review", `${prefix}_accept`, {
    work_task_ref: copy(taskRef), review_round_id: `${prefix}_round`, candidate_digest: built.candidate.candidate_digest, resolution: "accepted",
  }));
  return { pipeline: next, candidate: built.candidate };
}

// A pre-freeze manifest is intentionally representable for migration/readback,
// but no build authority can be assigned until the immutable manifest freezes.
{
  const unsealed = manifest(false);
  const work = buildWorkTaskPipeline(unsealed);
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_build", "unsealed_build", {
    work_task_ref: copy(refs(unsealed).core), assignment_id: "unsealed_assignment",
  })), "work_task_manifest_not_frozen");
}

// A review of one candidate can overlap a build in another repository, while
// both the single-Dev limit and the declared dependency gate remain closed.
{
  const batch = manifest();
  const workRefs = refs(batch);
  let work = buildWorkTaskPipeline(batch);
  const coreCandidate = candidateFor(workRefs.core, "b");
  work = apply(work, event("assign_build", "overlap_core_build", { work_task_ref: copy(workRefs.core), assignment_id: "overlap_core_assignment" }));
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_build", "overlap_ops_too_soon", {
    work_task_ref: copy(workRefs.ops), assignment_id: "overlap_ops_assignment",
  })), "active_build_task_exists");
  work = apply(work, event("record_candidate", "overlap_core_candidate", { candidate: coreCandidate }));
  work = apply(work, event("assign_independent_review", "overlap_core_review", {
    work_task_ref: copy(workRefs.core), review_round_id: "overlap_core_round", candidate_digest: coreCandidate.candidate_digest,
  }));
  work = apply(work, event("assign_build", "overlap_ops_build", { work_task_ref: copy(workRefs.ops), assignment_id: "overlap_ops_assignment" }));
  assert.equal(slot(work, workRefs.core).state, "independent_review");
  assert.equal(slot(work, workRefs.ops).state, "building");
  const opsCandidate = candidateFor(workRefs.ops, "c");
  work = apply(work, event("record_candidate", "overlap_ops_candidate", { candidate: opsCandidate }));
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_build", "dependent_before_ready", {
    work_task_ref: copy(workRefs["api-client"]), assignment_id: "dependent_assignment",
  })), "work_task_dependencies_not_ready");
  work = apply(work, event("record_review_verdict", "overlap_core_verdict", {
    work_task_ref: copy(workRefs.core), review_round_id: "overlap_core_round", candidate_digest: coreCandidate.candidate_digest, verdict: "approved",
  }));
  work = apply(work, event("reconcile_review", "overlap_core_accept", {
    work_task_ref: copy(workRefs.core), review_round_id: "overlap_core_round", candidate_digest: coreCandidate.candidate_digest, resolution: "accepted",
  }));
  work = apply(work, event("assign_build", "dependent_after_ready", {
    work_task_ref: copy(workRefs["api-client"]), assignment_id: "dependent_assignment",
  }));
  assert.equal(slot(work, workRefs["api-client"]).state, "building");
}

// A corrected exact candidate retires the bounded correction authority. The
// prior review round cannot submit evidence against the new candidate.
{
  const batch = manifest();
  const workRefs = refs(batch);
  const first = candidateFor(workRefs.core, "b");
  const second = candidateFor(workRefs.core, "c");
  let work = buildWorkTaskPipeline(batch);
  work = apply(work, event("assign_build", "replace_build_one", { work_task_ref: copy(workRefs.core), assignment_id: "replace_assignment_one" }));
  work = apply(work, event("record_candidate", "replace_candidate_one", { candidate: first }));
  work = apply(work, event("assign_independent_review", "replace_review_one", {
    work_task_ref: copy(workRefs.core), review_round_id: "replace_round_one", candidate_digest: first.candidate_digest,
  }));
  work = apply(work, event("record_review_verdict", "replace_verdict_one", {
    work_task_ref: copy(workRefs.core), review_round_id: "replace_round_one", candidate_digest: first.candidate_digest, verdict: "changes_requested",
  }));
  work = apply(work, event("reconcile_review", "replace_reconcile_one", {
    work_task_ref: copy(workRefs.core), review_round_id: "replace_round_one", candidate_digest: first.candidate_digest, resolution: "changes_requested",
  }));
  work = apply(work, event("queue_local_correction", "replace_checkpoint", { work_task_ref: copy(workRefs.core), checkpoint_id: "replace_checkpoint_one" }));
  assert.deepEqual(slot(work, workRefs.core).correction, { checkpoint_id: "replace_checkpoint_one", count: 1 });
  work = apply(work, event("assign_build", "replace_build_two", { work_task_ref: copy(workRefs.core), assignment_id: "replace_assignment_two" }));
  work = apply(work, event("record_candidate", "replace_candidate_two", { candidate: second }));
  assert.equal(slot(work, workRefs.core).candidate.candidate_digest, second.candidate_digest);
  assert.equal(slot(work, workRefs.core).correction, null);
  throwsCode(() => planWorkTaskPipelineEvent(work, event("record_review_verdict", "replace_stale_verdict", {
    work_task_ref: copy(workRefs.core), review_round_id: "replace_round_one", candidate_digest: first.candidate_digest, verdict: "approved",
  })), "invalid_work_task_pipeline_state");
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_independent_review", "replace_stale_assignment", {
    work_task_ref: copy(workRefs.core), review_round_id: "replace_round_two", candidate_digest: first.candidate_digest,
  })), "stale_work_task_candidate");
}

// A server-observed candidate replacement can occur while a review is active;
// it atomically revokes that review authority before the new exact candidate
// becomes eligible for another independent round.
{
  const batch = manifest();
  const workRefs = refs(batch);
  const first = candidateFor(workRefs.core, "b");
  const second = candidateFor(workRefs.core, "c");
  let work = buildWorkTaskPipeline(batch);
  work = apply(work, event("assign_build", "direct_replace_build", { work_task_ref: copy(workRefs.core), assignment_id: "direct_replace_assignment" }));
  work = apply(work, event("record_candidate", "direct_replace_first", { candidate: first }));
  work = apply(work, event("assign_independent_review", "direct_replace_review", {
    work_task_ref: copy(workRefs.core), review_round_id: "direct_replace_round", candidate_digest: first.candidate_digest,
  }));
  const wrongBase = candidateFor(workRefs.core, "d", "f".repeat(64));
  throwsCode(() => planWorkTaskPipelineEvent(work, event("replace_candidate", "direct_replace_wrong_base", {
    candidate: wrongBase,
  })), "work_task_candidate_base_mismatch");
  work = apply(work, event("replace_candidate", "direct_replace_second", { candidate: second }));
  assert.equal(slot(work, workRefs.core).state, "candidate_ready");
  assert.equal(slot(work, workRefs.core).review_assignment, null);
  throwsCode(() => planWorkTaskPipelineEvent(work, event("record_review_verdict", "direct_replace_stale_verdict", {
    work_task_ref: copy(workRefs.core), review_round_id: "direct_replace_round", candidate_digest: first.candidate_digest, verdict: "approved",
  })), "invalid_work_task_pipeline_state");
}

// A propagating finding pauses only reverse-graph descendants. The unrelated
// repository task remains eligible for a new build assignment.
{
  const batch = manifest();
  const workRefs = refs(batch);
  let work = buildWorkTaskPipeline(batch);
  const core = moveToAccepted(work, workRefs.core, "b", "prop_core");
  work = core.pipeline;
  const web = moveToCandidate(work, workRefs.web, "c", "prop_web");
  work = web.pipeline;
  work = apply(work, event("propagating_finding", "prop_finding", {
    work_task_ref: copy(workRefs.core), candidate_digest: core.candidate.candidate_digest, finding_id: "prop_finding_one",
  }));
  assert.equal(slot(work, workRefs.core).state, "changes_requested");
  assert.equal(slot(work, workRefs.web).state, "blocked");
  assert.equal(slot(work, workRefs["api-client"]).state, "blocked");
  assert.equal(slot(work, workRefs.ops).state, "queued");
  work = apply(work, event("assign_build", "prop_unrelated_build", { work_task_ref: copy(workRefs.ops), assignment_id: "prop_unrelated_assignment" }));
  assert.equal(slot(work, workRefs.ops).state, "building");
}

// Archiving is a global admission barrier for new builds and reviews, without
// rewriting task identities. Blocking/unblocking likewise revokes authority
// rather than recreating a task.
{
  const batch = manifest();
  const workRefs = refs(batch);
  let work = buildWorkTaskPipeline(batch, { archived: true });
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_build", "archive_build", {
    work_task_ref: copy(workRefs.core), assignment_id: "archive_assignment",
  })), "work_task_archive_blocked");
  work = apply(work, event("set_archived", "archive_clear", { archived: false }));
  work = apply(work, event("block", "block_core", { work_task_ref: copy(workRefs.core), block_code: "integrity" }));
  assert.equal(slot(work, workRefs.core).state, "blocked");
  work = apply(work, event("unblock", "unblock_core", { work_task_ref: copy(workRefs.core) }));
  assert.equal(slot(work, workRefs.core).state, "queued");
  const ready = moveToCandidate(work, workRefs.core, "b", "archive_ready");
  work = ready.pipeline;
  work = apply(work, event("set_archived", "archive_set", { archived: true }));
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_independent_review", "archive_review", {
    work_task_ref: copy(workRefs.core), review_round_id: "archive_round", candidate_digest: ready.candidate.candidate_digest,
  })), "work_task_archive_blocked");
}

// A contract revision change produces only a frozen plan for the source and
// declared dependents. Applying it defers/revokes those tasks in manifest order
// and leaves an unrelated repository's candidate intact.
{
  const batch = manifest();
  const workRefs = refs(batch);
  let work = buildWorkTaskPipeline(batch);
  const core = moveToAccepted(work, workRefs.core, "b", "contract_core");
  work = core.pipeline;
  const web = moveToCandidate(work, workRefs.web, "c", "contract_web");
  work = web.pipeline;
  const ops = moveToCandidate(work, workRefs.ops, "d", "contract_ops");
  work = ops.pipeline;
  const beforeOrder = work.tasks.map((entry) => entry.work_task_ref.task_revision);
  const beforeDigest = work.pipeline_digest;
  const plan = planWorkTaskPipelineEvent(work, event("contract_change", "contract_changed", {
    work_task_ref: copy(workRefs.core), observed_issue_body_revision: "f".repeat(64),
  }));
  assert.equal(Object.isFrozen(plan), true);
  assert.deepEqual(plan.effects.map((entry) => entry.work_task_ref.task_key), ["core", "web", "api-client"]);
  assert.equal(work.pipeline_digest, beforeDigest, "planning did not mutate the pipeline");
  work = applyWorkTaskPipelinePlan(work, plan);
  assert.deepEqual(work.tasks.map((entry) => entry.work_task_ref.task_revision), beforeOrder);
  for (const taskKey of ["core", "web", "api-client"]) {
    assert.equal(slot(work, workRefs[taskKey]).state, "deferred");
    assert.equal(slot(work, workRefs[taskKey]).candidate, null);
  }
  assert.equal(slot(work, workRefs.ops).state, "candidate_ready");
  assert.equal(slot(work, workRefs.ops).candidate.candidate_digest, ops.candidate.candidate_digest);
}

// An integrated cut reaches only the last accepted compatible prefix. It carries
// exact candidates, retains prior defer/cut dispositions, and appends history
// without replacing task identity.
{
  const batch = manifest();
  const workRefs = refs(batch);
  let work = buildWorkTaskPipeline(batch);
  const core = moveToAccepted(work, workRefs.core, "b", "cut_core");
  work = core.pipeline;
  const ops = moveToAccepted(work, workRefs.ops, "c", "cut_ops");
  work = ops.pipeline;
  const identityOrder = work.tasks.map((entry) => entry.work_task_ref.task_revision);
  const historyBefore = slot(work, workRefs.core).history.length;
  throwsCode(() => planWorkTaskPipelineEvent(work, event("integrated_cut", "cut_wrong_order", {
    tasks: [
      { work_task_ref: copy(workRefs.ops), candidate_digest: ops.candidate.candidate_digest },
      { work_task_ref: copy(workRefs.core), candidate_digest: core.candidate.candidate_digest },
    ],
  })), "integrated_cut_order_invalid");
  throwsCode(() => planWorkTaskPipelineEvent(work, event("integrated_cut", "cut_prefix_skip", {
    tasks: [
      { work_task_ref: copy(workRefs.core), candidate_digest: core.candidate.candidate_digest },
      { work_task_ref: copy(workRefs.ops), candidate_digest: ops.candidate.candidate_digest },
    ],
  })), "integrated_cut_prefix_incomplete");
  // `accepted`/`staged` slots can never retain correction authority, so even a
  // forged object is rejected before it could enter a delivery cut.
  const malformed = copy(work);
  slot(malformed, workRefs.core).correction = { checkpoint_id: "forged_checkpoint", count: 1 };
  throwsCode(() => assertWorkTaskPipeline(malformed), "invalid_work_task_pipeline");
  work = apply(work, event("integrated_cut", "cut_right_order", {
    tasks: [
      { work_task_ref: copy(workRefs.core), candidate_digest: core.candidate.candidate_digest },
    ],
  }));
  assert.deepEqual(work.tasks.map((entry) => entry.work_task_ref.task_revision), identityOrder);
  assert.equal(slot(work, workRefs.core).state, "staged");
  assert.equal(slot(work, workRefs.ops).state, "accepted");
  assert.equal(slot(work, workRefs.core).history.length, historyBefore + 1);
  assert.deepEqual(slot(work, workRefs.core).history.at(-1), { event_id: "cut_right_order", kind: "integrated_cut" });
}

// Cross-manifest references and unrecognized fields are never reinterpreted
// from title/chat/branch prose; they fail before a state plan exists.
{
  const current = manifest();
  const foreign = manifest(true, "a distinct contract body");
  const work = buildWorkTaskPipeline(current);
  throwsCode(() => planWorkTaskPipelineEvent(work, event("assign_build", "foreign_build", {
    work_task_ref: copy(refs(foreign).core), assignment_id: "foreign_assignment",
  })), "unknown_work_task_ref");
  const invalid = event("assign_build", "unknown_field", {
    work_task_ref: copy(refs(current).core), assignment_id: "unknown_assignment", title: "untrusted prose",
  });
  throwsCode(() => planWorkTaskPipelineEvent(work, invalid), "invalid_work_task_pipeline_event");
}

// Purity guard: M3 owns only deterministic state and plans. Persistence,
// transport, process execution, routes, config, and publication stay outside.
{
  const source = fs.readFileSync(path.join(__dirname, "work-task-pipeline.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|config|mcp|review-cycle|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn|worktree add|reset --hard|unlink|rm -rf|fetch\()/);
}

console.log("work-task-pipeline.test.js: all assertions passed");
