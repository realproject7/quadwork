"use strict";

// #1070-B reproduction. Archiving a project persists the durable config
// barrier and revokes admission, but the WorkTask pipeline and its open review
// rounds are separate durable authorities. Without an archive transition they
// stay `archived:false` and `current` after the barrier, so the batch still
// reads live: a review can be opened, a receipt sealed, and a correction
// queued against a project that is already archived.
//
// This test loads the real server composition (no listen) with a seeded
// pipeline store and a current review round, archives through the real
// lifecycle controller, and proves the transition happened for real.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-archive-transition-"));
const originalHomedir = os.homedir;
const originalHomeEnv = process.env.HOME;
const originalSkipListen = process.env.QUADWORK_SKIP_LISTEN;
os.homedir = () => TEST_HOME;
process.env.HOME = TEST_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";

function cleanup() {
  if (typeof originalCancelProjectBackground === "function") routes.cancelProjectBackground = originalCancelProjectBackground;
  os.homedir = originalHomedir;
  if (originalHomeEnv === undefined) delete process.env.HOME; else process.env.HOME = originalHomeEnv;
  if (originalSkipListen === undefined) delete process.env.QUADWORK_SKIP_LISTEN; else process.env.QUADWORK_SKIP_LISTEN = originalSkipListen;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
}
// Loading the real server composition leaves durable writes in flight that can
// recreate the seeded home after the run finishes, so the sandbox is also
// removed at exit. Nothing here spawns a child process.
process.on("exit", cleanup);

const configDir = path.join(TEST_HOME, ".quadwork");
const repoA = path.join(TEST_HOME, "repos", "a");
const repoB = path.join(TEST_HOME, "repos", "b");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(repoA, { recursive: true });
fs.mkdirSync(repoB, { recursive: true });

const installation_id = "installation-archive-0001";
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);
const copy = (value) => JSON.parse(JSON.stringify(value));

// Mirrors the sealed contract's stable receipt digest so a control receipt
// really seals instead of failing on its digest.
function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function stableDigest(value) {
  return require("node:crypto").createHash("sha256").update(stableValue(value), "utf8").digest("hex");
}

function project(id, repo, cwd) {
  return {
    id,
    name: id,
    archived: false,
    chat_mode: "file",
    repositories: [{ key: "primary", repo, working_dir: cwd, primary: true }],
    agents: { dev: { cwd, command: "claude" } },
  };
}
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
  installation_id,
  projects: [project("a", "Owner/A", repoA), project("b", "Owner/B", repoB)],
}));

const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
const { createWorkTaskIndependentReviewService, reviewRoundId } = require("./work-task-independent-review-service");

function seedProject(projectId, workDir) {
  const manifest = freezeBatchManifest(buildBatchManifest({
    version: 1,
    installation_id,
    project_id: projectId,
    delivery_mode: "isolated",
    tasks: [{
      task_key: `archive-transition-${projectId}`,
      repository_key: "primary",
      work_item: { repoKey: "primary", repo: `Owner/${projectId.toUpperCase()}`, number: 1070, kind: "issue" },
      goal: "prove the project archive transition",
      file_boundary: ["server/project-archive-transition.js"],
      validation: ["node:test"],
      dependencies: [],
    }],
  }, {
    resolveRegisteredIdentity: (input) => ({ ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }),
  }), "2026-09-01T00:00:00.000Z");

  const ref = manifest.tasks[0].ref;
  const worktree = path.join(workDir, "wt");
  const candidate = buildWorkTaskCandidate({
    version: 1,
    work_task_ref: copy(ref),
    base_sha,
    candidate_sha,
    branch: "task/archive-transition",
    worktree: { repository_key: "primary", worktree_id: "wt_archive_01", path: worktree },
  }, {
    canonicalizePath: (request) => ({ version: 1, canonical_path: request.path }),
    inspectManagedWorktree: () => ({
      version: 1, registered: true, readable: true, repository_key: "primary", worktree_id: "wt_archive_01",
      canonical_path: worktree, branch: "task/archive-transition", base_sha, head_sha: candidate_sha,
      dirty: false, occupancy: "vacant",
    }),
    readCanonicalInstalledState: () => ({ version: 1, installation_id, project_id: projectId, v1_state: "present" }),
  });

  const store = createWorkTaskPipelineStore({ config_dir: configDir, fs });
  let state = store.initialize({
    expected: { installation_id, project_id: projectId, manifest_digest: manifest.manifest_digest, pipeline_digest: null },
    manifest,
    pipeline: buildWorkTaskPipeline(manifest),
  });
  const apply = (current, event) => store.applyPlan({
    expected: {
      installation_id,
      project_id: projectId,
      manifest_digest: current.manifest.manifest_digest,
      pipeline_digest: current.pipeline.pipeline_digest,
    },
    plan: planWorkTaskPipelineEvent(current.pipeline, event),
    terminal_disposition: null,
  });
  state = apply(state, { version: 1, kind: "assign_build", event_id: `evt_build_${projectId}`, work_task_ref: copy(ref), assignment_id: `asg_${projectId}_01`, base_sha });
  state = apply(state, { version: 1, kind: "record_candidate", event_id: `evt_candidate_${projectId}`, assignment_id: `asg_${projectId}_01`, candidate: copy(candidate) });

  // The round is opened first so the pipeline's review assignment can carry the
  // exact server-derived round id the review service re-derives on every call.
  const roundStore = createTaskReviewRoundStore({ rootDir: configDir, fsImpl: fs });
  const opened = roundStore.openRound(
    { version: 1, candidate: copy(candidate), attempt: "attempt_1070", round: 1, opened_at: "2026-09-01T06:00:00.000Z" },
    { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }] },
  );
  state = apply(state, { version: 1, kind: "assign_independent_review", event_id: `evt_review_${projectId}`, work_task_ref: copy(ref), review_round_id: reviewRoundId(opened.review_round_ref), candidate_digest: candidate.candidate_digest });

  // A second, already-released round for the same candidate. It is terminal
  // sealed audit: the archive transition must leave it byte-for-byte alone
  // while it cancels the current round above.
  const released = roundStore.openRound(
    { version: 1, candidate: copy(candidate), attempt: "attempt_1069", round: 2, opened_at: "2026-09-01T05:00:00.000Z" },
    { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }] },
  );
  for (const [role, generation, receipt_id] of [["re2", 22, "receipt_re2_seal"], ["re1", 11, "receipt_re1_seal"]]) {
    const payload = {
      version: 1,
      review_round_ref: copy(released.review_round_ref),
      receipt_id,
      verdict: "request_changes",
      findings: [{ finding_id: `${receipt_id}_finding`, severity: "blocking", propagation: "local", summary: "sealed before archive" }],
    };
    roundStore.submitTrustedReceipt(released.review_round_ref, released.candidate_digest,
      { ...payload, receipt_digest: stableDigest(payload) },
      { version: 1, reviewer_role: role, reviewer_generation: generation, received_at: "2026-09-01T05:30:00.000Z" });
  }
  assert.equal(opened.status, "current");
  assert.equal(state.pipeline.tasks[0].state, "independent_review");
  assert.equal(state.pipeline.archived, false);
  return { manifest, ref, candidate, store, roundStore, opened, released, owner: { installation_id, project_id: projectId } };
}

const seedA = seedProject("a", repoA);
const seedB = seedProject("b", repoB);

function storedRounds(seed) {
  const document = JSON.parse(fs.readFileSync(seed.roundStore.pathFor(seed.opened.review_round_ref), "utf8"));
  return Object.values(document.records).map((entry) => entry.round);
}
function storedRound(seed) {
  const match = storedRounds(seed).filter((round) => round.review_round_ref.round === 1);
  assert.equal(match.length, 1);
  return match[0];
}
function storedReleasedRound(seed) {
  const match = storedRounds(seed).filter((round) => round.review_round_ref.round === 2);
  assert.equal(match.length, 1);
  return match[0];
}

const routes = require("./routes");
const runtime = require("./index");

// Ordering probe: `routes.cancelProjectBackground` is the first asynchronous
// teardown the runtime cleanup starts. The batch must already be archived by
// the time it runs, so the transition cannot sit behind an await where a late
// build, review, or receipt could still win.
const originalCancelProjectBackground = routes.cancelProjectBackground;
let pipelineArchivedBeforeAsyncTeardown = null;
routes.cancelProjectBackground = (projectId) => {
  if (projectId === "a" && pipelineArchivedBeforeAsyncTeardown === null) {
    pipelineArchivedBeforeAsyncTeardown = seedA.store.readRecoverySnapshot(seedA.owner).pipeline.archived;
  }
  return originalCancelProjectBackground(projectId);
};

(async () => {
  const archived = await runtime.projectLifecycle.archiveProject("a");
  assert.equal(archived.archived, true, "archive commits the durable config barrier");
  assert.equal(archived.ok, true, `archive cleanup must complete: ${JSON.stringify(archived.cleanup_errors)}`);

  assert.equal(pipelineArchivedBeforeAsyncTeardown, true,
    "the pipeline is archived before the first asynchronous teardown is started");

  // The defect: without the archive transition the pipeline stays live.
  const pipelineAfter = seedA.store.readRecoverySnapshot(seedA.owner);
  assert.equal(pipelineAfter.pipeline.archived, true,
    "archiving the project must archive its active WorkTask pipeline");
  assert.equal(archived.resources.work_task_pipelines_archived, 1,
    "the archive transition reports the pipeline it archived");

  // The defect: without the archive transition the review round stays current.
  const roundAfter = storedRound(seedA);
  assert.equal(roundAfter.status, "cancelled",
    "archiving the project must cancel its current review round");
  assert.equal(roundAfter.cancellation.cause, "project_archived",
    "cancellation carries the fixed trusted archive cause");
  assert.equal(archived.resources.task_review_rounds_cancelled, 1,
    "the archive transition cancels exactly the one current round, not the released one");

  // Neither candidate nor worktree is touched: the transition flips authority
  // state only, and every receipt/audit record survives byte-for-byte.
  assert.deepEqual(pipelineAfter.pipeline.tasks[0].candidate, JSON.parse(JSON.stringify(seedA.candidate)),
    "the archive transition never mutates the recorded candidate");
  assert.equal(pipelineAfter.pipeline.tasks[0].state, "independent_review",
    "the archive transition never rewrites task state");
  assert.deepEqual(pipelineAfter.manifest, JSON.parse(JSON.stringify(seedA.manifest)),
    "the frozen manifest survives the archive transition");
  assert.equal(roundAfter.receipts.length, 0);
  assert.equal(roundAfter.audit.length, 2, "cancellation appends to the immutable audit");
  assert.equal(roundAfter.audit[0].type, "opened");
  assert.equal(roundAfter.audit[1].type, "cancelled");
  const releasedAfter = storedReleasedRound(seedA);
  assert.equal(releasedAfter.status, "released", "an already-released round is never cancelled by the archive");
  assert.equal(releasedAfter.receipts.length, 2, "sealed receipts survive the archive transition");
  assert.equal(releasedAfter.cancellation, null);

  // Another project's durable batch is untouched.
  assert.equal(seedB.store.readRecoverySnapshot(seedB.owner).pipeline.archived, false,
    "archiving one project cannot archive another project's pipeline");
  assert.equal(storedRound(seedB).status, "current",
    "archiving one project cannot cancel another project's review round");
  assert.equal(storedReleasedRound(seedB).status, "released");

  // A late review/receipt/correction cannot win after the barrier. Each check
  // is paired with the same call against the un-archived project B, so a
  // rejection can only be the archive and never a malformed request.
  const reviewService = createWorkTaskIndependentReviewService({ config_dir: configDir, fs });
  const receiptFor = (seed, receipt_id) => {
    const payload = { version: 1, review_round_ref: copy(seed.opened.review_round_ref), receipt_id, verdict: "approve", findings: [] };
    return { ...payload, receipt_digest: stableDigest(payload) };
  };
  const submit = (seed, receipt_id) => reviewService.submitTrustedReceipt({
    version: 1,
    review_round_ref: copy(seed.opened.review_round_ref),
    candidate_digest: seed.opened.candidate_digest,
    receipt: receiptFor(seed, receipt_id),
  }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-01T07:00:00.000Z" });
  assert.equal(submit(seedB, "receipt_control_01").outcome, "sealed",
    "negative control: the identical receipt seals against the un-archived project");
  assert.throws(() => submit(seedA, "receipt_late_01"),
    (error) => error && error.code === "stale_work_task_review_authority",
    "a late receipt is rejected because the archived pipeline holds no live review authority");

  const correct = (seed) => reviewService.queueLocalCorrection({
    version: 1,
    work_task_ref: copy(seed.ref),
    review_round_ref: copy(seed.released.review_round_ref),
    candidate_digest: seed.released.candidate_digest,
  });
  assert.throws(() => correct(seedB),
    (error) => error && error.code === "stale_work_task_review_authority",
    "negative control: the un-archived project rejects the same correction for a non-archive reason");
  assert.throws(() => correct(seedA),
    (error) => error && error.code === "work_task_archive_blocked",
    "a late correction is rejected by the archived pipeline");

  // An already-archived retry is idempotent and stays truthful.
  const retry = await runtime.projectLifecycle.archiveProject("a");
  assert.equal(retry.ok, true, `archive retry must complete: ${JSON.stringify(retry.cleanup_errors)}`);
  assert.equal(retry.already_archived, true);
  assert.equal(retry.resources.work_task_pipelines_archived ?? 0, 0,
    "an already-archived pipeline is not archived twice");
  assert.equal(retry.resources.task_review_rounds_cancelled ?? 0, 0,
    "an already-cancelled round is not cancelled twice");
  assert.equal(seedA.store.readRecoverySnapshot(seedA.owner).pipeline.pipeline_digest, pipelineAfter.pipeline.pipeline_digest,
    "the retry writes no new pipeline transition");
  assert.deepEqual(storedRound(seedA), roundAfter, "the retry writes no new round state");

  // Unarchive restores admission only. It must not revive the old pipeline or
  // its cancelled round; resuming work requires an explicit retirement plus a
  // new frozen batch.
  const restored = await runtime.projectLifecycle.unarchiveProject("a");
  assert.equal(restored.ok, true, `unarchive must complete: ${JSON.stringify(restored.cleanup_errors)}`);
  assert.equal(restored.archived, false);
  assert.equal(seedA.store.readRecoverySnapshot(seedA.owner).pipeline.archived, true,
    "unarchive does not silently reactivate the archived pipeline");
  assert.equal(storedRound(seedA).status, "cancelled",
    "unarchive does not silently revive a cancelled review round");
  assert.throws(() => reviewService.openIndependentReview({
    version: 1,
    event_id: "evt_post_unarchive",
    work_task_ref: copy(seedA.ref),
    attempt: "attempt_1071",
    round: 2,
    reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }],
    opened_at: "2026-09-01T08:00:00.000Z",
  }),
  (error) => error && error.code === "work_task_archive_blocked",
  "an unarchived project cannot reopen review on the archived batch");

  console.log("projectArchiveTransitionRuntime.test.js: all assertions passed");
})().then(cleanup, (error) => {
  console.error(error);
  cleanup();
  process.exitCode = 1;
});
