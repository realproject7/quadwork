"use strict";

// #1070-B unit coverage for the single project-scope archive transition:
// missing stores, the real transition, an already-archived retry, a crash
// between the pipeline archive and the round cancellation, a competing cleanup
// that loses the pipeline CAS, forged/unavailable identity, and proof that no
// candidate, worktree, receipt, or audit record is mutated.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskPipelineStore, workTaskPipelineStorePath } = require("./work-task-pipeline-store");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
const {
  ProjectArchiveTransitionError,
  archiveEventId,
  createProjectArchiveTransition,
} = require("./project-archive-transition");

const installation_id = "installation-archive-0001";
const other_installation_id = "installation-archive-0002";
const project_id = "alpha";
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);
const copy = (value) => JSON.parse(JSON.stringify(value));

// Mirrors the sealed contract's stable receipt digest, so a receipt really
// seals before the archive transition runs.
function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function stableDigest(value) {
  return require("node:crypto").createHash("sha256").update(stableValue(value), "utf8").digest("hex");
}

const directories = [];
function root(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
function removeDirectories() {
  while (directories.length) {
    const directory = directories.pop();
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
function throwsCode(run, code) {
  assert.throws(run, (error) => error && error.code === code, `expected ${code}`);
}

function frozenManifest(scopeProject = project_id, scopeInstallation = installation_id) {
  return freezeBatchManifest(buildBatchManifest({
    version: 1,
    installation_id: scopeInstallation,
    project_id: scopeProject,
    delivery_mode: "isolated",
    tasks: [{
      task_key: "archive-transition",
      repository_key: "primary",
      work_item: { repoKey: "primary", repo: "Owner/Product", number: 1070, kind: "issue" },
      goal: "prove the project archive transition",
      file_boundary: ["server/project-archive-transition.js"],
      validation: ["node:test"],
      dependencies: [],
    }],
  }, {
    resolveRegisteredIdentity: (input) => ({ ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }),
  }), "2026-09-01T00:00:00.000Z");
}

function candidateFor(manifest, worktree) {
  return buildWorkTaskCandidate({
    version: 1,
    work_task_ref: copy(manifest.tasks[0].ref),
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
    readCanonicalInstalledState: () => ({ version: 1, installation_id: manifest.installation_id, project_id: manifest.project_id, v1_state: "present" }),
  });
}

// Seeds one durable batch under review: a frozen pipeline whose single task is
// in `independent_review`, plus the matching current review round.
function seed(configDir, options = {}) {
  const scopeProject = options.project_id || project_id;
  const scopeInstallation = options.installation_id || installation_id;
  const manifest = frozenManifest(scopeProject, scopeInstallation);
  const owner = { installation_id: scopeInstallation, project_id: scopeProject };
  const ref = manifest.tasks[0].ref;
  const candidate = candidateFor(manifest, path.join(configDir, `wt-${scopeProject}`));
  const store = createWorkTaskPipelineStore({ config_dir: configDir, fs });
  let state = store.initialize({
    expected: { ...owner, manifest_digest: manifest.manifest_digest, pipeline_digest: null },
    manifest,
    pipeline: buildWorkTaskPipeline(manifest),
  });
  const apply = (current, event) => store.applyPlan({
    expected: { ...owner, manifest_digest: current.manifest.manifest_digest, pipeline_digest: current.pipeline.pipeline_digest },
    plan: planWorkTaskPipelineEvent(current.pipeline, event),
    terminal_disposition: event.kind === "set_archived" ? { kind: "archive", event_id: event.event_id, archived: event.archived } : null,
  });
  state = apply(state, { version: 1, kind: "assign_build", event_id: `evt_build_${scopeProject}`, work_task_ref: copy(ref), assignment_id: `asg_${scopeProject}`, base_sha });
  state = apply(state, { version: 1, kind: "record_candidate", event_id: `evt_candidate_${scopeProject}`, assignment_id: `asg_${scopeProject}`, candidate: copy(candidate) });
  state = apply(state, { version: 1, kind: "assign_independent_review", event_id: `evt_review_${scopeProject}`, work_task_ref: copy(ref), review_round_id: `trr_${scopeProject}`, candidate_digest: candidate.candidate_digest });

  const roundStore = createTaskReviewRoundStore({ rootDir: configDir, fsImpl: fs });
  const opened = roundStore.openRound(
    { version: 1, candidate: copy(candidate), attempt: "attempt_1070", round: 1, opened_at: "2026-09-01T06:00:00.000Z" },
    { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }] },
  );
  return { manifest, owner, ref, candidate, store, roundStore, opened, state, apply };
}

function storedRounds(seeded) {
  const document = JSON.parse(fs.readFileSync(seeded.roundStore.pathFor(seeded.opened.review_round_ref), "utf8"));
  return Object.values(document.records).map((entry) => entry.round);
}
function transitionFor(configDir, options = {}) {
  return createProjectArchiveTransition({
    config_dir: configDir,
    fs: options.fs || fs,
    resolve_installation_id: options.resolve_installation_id || (() => installation_id),
    now: options.now || (() => new Date("2026-09-02T00:00:00.000Z")),
  });
}

try {
  // Option validation: the adapter refuses an incomplete or unusable composition.
  throwsCode(() => createProjectArchiveTransition({ config_dir: "/tmp", fs }), "invalid_project_archive_transition_options");
  throwsCode(() => createProjectArchiveTransition({ config_dir: "/tmp", fs, resolve_installation_id: () => installation_id, now: "clock" }),
    "invalid_project_archive_transition_options");
  assert.ok(new ProjectArchiveTransitionError("x_code") instanceof Error);

  // 1. A project with no durable batch and no review-round document at all is
  // a clean no-op that reports zero resources and creates nothing on disk.
  {
    const configDir = root("qw-archive-transition-empty-");
    const before = fs.readdirSync(configDir);
    const result = transitionFor(configDir).archiveProjectRuntimeState(project_id);
    assert.deepEqual(result, { ok: true, resources: {}, cleanup_errors: [] },
      "a project with no pipeline or round store archives cleanly");
    assert.deepEqual(fs.readdirSync(configDir), before,
      "a no-op archive transition writes nothing to the config directory");
  }

  // 2. The real transition: the pipeline is archived through its own CAS and
  // the current round is cancelled with the fixed trusted cause.
  {
    const configDir = root("qw-archive-transition-main-");
    const seeded = seed(configDir);
    // A real on-disk worktree for the candidate under review. The transition
    // must not create, move, or remove any of it.
    const worktree = path.join(configDir, `wt-${project_id}`);
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, "candidate.txt"), "uncommitted work");
    const beforePipeline = seeded.store.readRecoverySnapshot(seeded.owner);
    assert.equal(beforePipeline.pipeline.archived, false);
    assert.equal(storedRounds(seeded)[0].status, "current");

    const result = transitionFor(configDir).archiveProjectRuntimeState(project_id);
    assert.deepEqual(result, {
      ok: true,
      resources: { work_task_pipelines_archived: 1, task_review_rounds_cancelled: 1 },
      cleanup_errors: [],
    }, "the transition archives one pipeline and cancels one round");

    const after = seeded.store.readRecoverySnapshot(seeded.owner);
    assert.equal(after.pipeline.archived, true);
    assert.equal(after.terminal_audit.length, 1, "the archive is recorded once in the terminal audit");
    assert.deepEqual(after.terminal_audit[0], {
      kind: "archive",
      event_id: archiveEventId(seeded.owner, seeded.manifest.manifest_digest),
      archived: true,
      pipeline_digest: after.pipeline.pipeline_digest,
    }, "the archive event id is derived server-side from the batch identity");

    // No candidate, worktree, task state, repository base, or manifest byte moves.
    assert.deepEqual(after.pipeline.tasks, beforePipeline.pipeline.tasks,
      "the archive transition mutates no task slot, candidate, or worktree reference");
    assert.deepEqual(after.pipeline.repository_bases, beforePipeline.pipeline.repository_bases);
    assert.deepEqual(after.manifest, beforePipeline.manifest);
    assert.equal(after.pipeline.tasks[0].state, "independent_review");
    assert.equal(after.pipeline.tasks[0].candidate.managed_worktree.worktree_id, "wt_archive_01");

    const round = storedRounds(seeded)[0];
    assert.equal(round.status, "cancelled");
    // The cause and reason are spelled out here rather than imported from the
    // adapter: comparing the module's constant to itself passes whatever the
    // constant is changed to, which is how a wrong-but-legal cause survived.
    assert.equal(round.cancellation.cause, "project_archived",
      "the adapter cancels with the archive cause, not merely some valid cause");
    assert.equal(round.cancellation.reason, "project archived by the server lifecycle controller",
      "the adapter sends the fixed server reason");
    assert.equal(round.cancellation.at, "2026-09-02T00:00:00.000Z",
      "the cancellation instant is the injected trusted clock, not a wall clock read");
    assert.equal(round.receipts.length, 0);
    assert.equal(round.release, null);
    assert.deepEqual(round.audit.map((entry) => entry.type), ["opened", "cancelled"],
      "cancellation appends to the immutable audit and erases nothing");
    assert.equal(transitionFor(configDir).archiveProjectRuntimeState(project_id).resources.task_review_rounds_cancelled,
      undefined, "a cancelled round is never re-cancelled");
    assert.deepEqual(fs.readdirSync(worktree), ["candidate.txt"], "the candidate worktree is left on disk untouched");
    assert.equal(fs.readFileSync(path.join(worktree, "candidate.txt"), "utf8"), "uncommitted work");
  }

  // 3. A sealed receipt that beat the transition stays in the immutable
  // record, and a receipt that arrives after it is rejected as cancelled.
  {
    const configDir = root("qw-archive-transition-receipt-");
    const seeded = seed(configDir);
    const payload = {
      version: 1,
      review_round_ref: copy(seeded.opened.review_round_ref),
      receipt_id: "receipt_re2_01",
      verdict: "request_changes",
      findings: [{ finding_id: "finding_re2_01", severity: "blocking", propagation: "local", summary: "sealed before archive" }],
    };
    const sealed = seeded.roundStore.submitTrustedReceipt(
      seeded.opened.review_round_ref, seeded.opened.candidate_digest,
      { ...payload, receipt_digest: stableDigest(payload) },
      { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-01T06:30:00.000Z" },
    ).outcome;
    assert.equal(sealed, "sealed");
    const before = storedRounds(seeded)[0];
    assert.equal(before.receipts.length, 1, "one receipt is sealed before the archive transition runs");
    assert.equal(before.status, "current");

    const result = transitionFor(configDir).archiveProjectRuntimeState(project_id);
    assert.equal(result.ok, true, JSON.stringify(result.cleanup_errors));
    const after = storedRounds(seeded)[0];
    assert.equal(after.status, "cancelled");
    assert.deepEqual(after.receipts, before.receipts, "an already-sealed receipt survives cancellation untouched");
    const latePayload = { ...payload, receipt_id: "receipt_re1_01", verdict: "approve", findings: [] };
    throwsCode(() => seeded.roundStore.submitTrustedReceipt(
      seeded.opened.review_round_ref, seeded.opened.candidate_digest,
      { ...latePayload, receipt_digest: stableDigest(latePayload) },
      { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T01:00:00.000Z" },
    ), "task_review_round_cancelled");
  }

  // 4. An already-archived retry is idempotent: no second pipeline transition,
  // no second cancellation, no new durable bytes.
  {
    const configDir = root("qw-archive-transition-retry-");
    const seeded = seed(configDir);
    const transition = transitionFor(configDir);
    assert.equal(transition.archiveProjectRuntimeState(project_id).ok, true);
    const afterFirst = seeded.store.readRecoverySnapshot(seeded.owner);
    const roundAfterFirst = storedRounds(seeded)[0];

    const retry = transition.archiveProjectRuntimeState(project_id);
    assert.deepEqual(retry, { ok: true, resources: {}, cleanup_errors: [] },
      "an already-archived, already-cancelled project retries to a clean no-op");
    assert.deepEqual(seeded.store.readRecoverySnapshot(seeded.owner), afterFirst,
      "the retry appends no pipeline history or audit entry");
    assert.deepEqual(storedRounds(seeded)[0], roundAfterFirst, "the retry writes no new round state");
  }

  // 5. A crash between the pipeline archive and the round cancellation leaves
  // an archived pipeline beside a still-current round. The retry completes
  // exactly the missing half.
  {
    const configDir = root("qw-archive-transition-crash-");
    const seeded = seed(configDir);
    const event_id = archiveEventId(seeded.owner, seeded.manifest.manifest_digest);
    seeded.apply(seeded.store.readRecoverySnapshot(seeded.owner), { version: 1, kind: "set_archived", event_id, archived: true });
    assert.equal(seeded.store.readRecoverySnapshot(seeded.owner).pipeline.archived, true);
    assert.equal(storedRounds(seeded)[0].status, "current", "the crash left the round live");

    const resumed = transitionFor(configDir).archiveProjectRuntimeState(project_id);
    assert.deepEqual(resumed, {
      ok: true,
      resources: { task_review_rounds_cancelled: 1 },
      cleanup_errors: [],
    }, "the retry cancels only the round the crash left behind");
    assert.equal(storedRounds(seeded)[0].status, "cancelled");
    assert.equal(seeded.store.readRecoverySnapshot(seeded.owner).terminal_audit.length, 1,
      "the resumed archive does not duplicate the terminal archive audit entry");
  }

  // 6. Competing cleanup: another writer advances the pipeline between this
  // transition's snapshot read and its compare-and-swap. The loss is typed and
  // retryable, the round sweep is held back, and a retry completes the work.
  {
    const configDir = root("qw-archive-transition-compete-");
    const seeded = seed(configDir);
    const statePath = workTaskPipelineStorePath(configDir, seeded.owner);
    let competed = false;
    const racingFs = Object.create(fs);
    racingFs.readFileSync = (target, ...rest) => {
      const body = fs.readFileSync(target, ...rest);
      if (!competed && target === statePath) {
        competed = true;
        // A competing archive commits first, under the same store CAS.
        seeded.apply(seeded.store.readRecoverySnapshot(seeded.owner), {
          version: 1, kind: "set_archived", event_id: "evt_competing_archive", archived: true,
        });
      }
      return body;
    };

    const lost = transitionFor(configDir, { fs: racingFs }).archiveProjectRuntimeState(project_id);
    assert.equal(competed, true, "the competing writer really did commit first");
    assert.equal(lost.ok, false, "losing the pipeline CAS is a truthful partial cleanup");
    assert.deepEqual(lost.resources, {}, "a lost CAS reports no archived pipeline");
    assert.equal(lost.cleanup_errors.length, 1);
    assert.equal(lost.cleanup_errors[0].resource, "work_task_pipeline");
    assert.equal(lost.cleanup_errors[0].code, "stale_work_task_pipeline_store_precondition");
    assert.equal(storedRounds(seeded)[0].status, "current",
      "a failed pipeline archive holds back the round sweep instead of half-quiescing the batch");

    const retry = transitionFor(configDir).archiveProjectRuntimeState(project_id);
    assert.deepEqual(retry, { ok: true, resources: { task_review_rounds_cancelled: 1 }, cleanup_errors: [] },
      "the retry accepts the competing archive and finishes the round sweep");
    assert.equal(storedRounds(seeded)[0].status, "cancelled");
  }

  // 7. Identity is bound server-side. A caller supplies a project id only: it
  // cannot name another installation, and an unregistered or unreadable
  // installation identity fails typed and mutates nothing.
  {
    const configDir = root("qw-archive-transition-identity-");
    const seeded = seed(configDir);
    const foreign = seed(configDir, { project_id: "beta" });

    const unreadable = transitionFor(configDir, { resolve_installation_id: () => { throw new Error("config unreadable"); } })
      .archiveProjectRuntimeState(project_id);
    assert.equal(unreadable.ok, false);
    assert.deepEqual(unreadable.cleanup_errors.map((entry) => [entry.resource, entry.code]),
      [["project", "project_archive_identity_unavailable"]]);
    const unregistered = transitionFor(configDir, { resolve_installation_id: () => "short" })
      .archiveProjectRuntimeState(project_id);
    assert.equal(unregistered.cleanup_errors[0].code, "project_archive_identity_unregistered");
    // A project on an installation that was never V2-registered cannot key
    // either durable store, so it is a clean no-op rather than a permanent
    // cleanup failure that would block unarchive forever.
    assert.deepEqual(transitionFor(configDir, { resolve_installation_id: () => undefined }).archiveProjectRuntimeState(project_id),
      { ok: true, resources: {}, cleanup_errors: [] },
      "an unregistered installation archives cleanly");
    assert.equal(seeded.store.readRecoverySnapshot(seeded.owner).pipeline.archived, false,
      "an unregistered installation touches no durable batch");
    const invalidScope = transitionFor(configDir).archiveProjectRuntimeState("../escape");
    assert.equal(invalidScope.cleanup_errors[0].code, "invalid_project_archive_scope");
    assert.equal(transitionFor(configDir).archiveProjectRuntimeState({ project_id, installation_id: other_installation_id }).cleanup_errors[0].code,
      "invalid_project_archive_scope", "a caller cannot pass a scope object in place of a project id");
    assert.equal(seeded.store.readRecoverySnapshot(seeded.owner).pipeline.archived, false,
      "a rejected identity mutates no durable batch");

    // Archiving one project leaves every other project's batch and round alone.
    assert.equal(transitionFor(configDir).archiveProjectRuntimeState(project_id).ok, true);
    assert.equal(foreign.store.readRecoverySnapshot(foreign.owner).pipeline.archived, false,
      "archiving one project cannot archive another project's pipeline");
    assert.equal(storedRounds(foreign)[0].status, "current",
      "archiving one project cannot cancel another project's review round");
    // The other project's own archive is bound to its own installation scope.
    const otherInstallation = transitionFor(configDir, { resolve_installation_id: () => other_installation_id })
      .archiveProjectRuntimeState("beta");
    assert.deepEqual(otherInstallation, { ok: true, resources: {}, cleanup_errors: [] },
      "a different installation scope sees no batch for the same project id");
    assert.equal(foreign.store.readRecoverySnapshot(foreign.owner).pipeline.archived, false);
  }

  // 8. An unreadable durable pipeline is typed and retryable, and it holds the
  // round sweep back rather than reporting a quiesced batch.
  {
    const configDir = root("qw-archive-transition-corrupt-");
    const seeded = seed(configDir);
    const statePath = workTaskPipelineStorePath(configDir, seeded.owner);
    fs.writeFileSync(statePath, "{not json", { mode: 0o600 });
    const corrupt = transitionFor(configDir).archiveProjectRuntimeState(project_id);
    assert.equal(corrupt.ok, false);
    assert.deepEqual(corrupt.cleanup_errors.map((entry) => [entry.resource, entry.code]),
      [["work_task_pipeline", "corrupt_work_task_pipeline_store"]]);
    assert.equal(storedRounds(seeded)[0].status, "current",
      "an unreadable pipeline does not let the round sweep proceed");
    assert.ok(!JSON.stringify(corrupt).includes(configDir), "typed cleanup errors never carry a filesystem path");
  }

  // 9. A clock that cannot produce a trusted instant is typed and retryable,
  // and leaves the round current after the pipeline is already archived.
  {
    const configDir = root("qw-archive-transition-clock-");
    const seeded = seed(configDir);
    const broken = transitionFor(configDir, { now: () => "not-a-time" }).archiveProjectRuntimeState(project_id);
    assert.equal(broken.ok, false);
    assert.equal(broken.resources.work_task_pipelines_archived, 1, "the pipeline archive still committed");
    assert.deepEqual(broken.cleanup_errors.map((entry) => [entry.resource, entry.code]),
      [["task_review_round", "project_archive_clock_unavailable"]]);
    assert.equal(storedRounds(seeded)[0].status, "current");
    assert.equal(transitionFor(configDir).archiveProjectRuntimeState(project_id).ok, true,
      "a retry with a working clock finishes the cancellation");
    assert.equal(storedRounds(seeded)[0].status, "cancelled");
  }

  // 10. A round that a concurrent writer leaves current after the sweep must
  // keep the cleanup partial. The post-sweep re-read is the only thing that can
  // see it, so it is driven here by opening a fresh round in the exact window
  // between the last cancellation and that re-read.
  {
    const configDir = root("qw-archive-transition-revived-");
    const seeded = seed(configDir);
    const documentPath = seeded.roundStore.pathFor(seeded.opened.review_round_ref);
    let cancellationWritten = false;
    let revived = false;
    const revivingFs = Object.create(fs);
    revivingFs.renameSync = (from, to, ...rest) => {
      const result = fs.renameSync(from, to, ...rest);
      if (to === documentPath) cancellationWritten = true;
      return result;
    };
    revivingFs.lstatSync = (target, ...rest) => {
      // Only outside the project writer lock, so the concurrent opener is a
      // real second writer rather than a self-deadlock.
      if (cancellationWritten && !revived && target === documentPath && !fs.existsSync(`${documentPath}.lock`)) {
        revived = true;
        // A concurrent writer opens a second round for the same candidate.
        seeded.roundStore.openRound(
          { version: 1, candidate: copy(seeded.candidate), attempt: "attempt_1071", round: 2, opened_at: "2026-09-01T09:00:00.000Z" },
          { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }] },
        );
      }
      return fs.lstatSync(target, ...rest);
    };

    const swept = transitionFor(configDir, { fs: revivingFs }).archiveProjectRuntimeState(project_id);
    assert.equal(revived, true, "the concurrent writer really did open a round inside the window");
    assert.equal(swept.resources.task_review_rounds_cancelled, 1, "the sweep cancelled the round it saw");
    assert.equal(swept.ok, false, "a round left current after the sweep keeps the cleanup partial");
    assert.deepEqual(swept.cleanup_errors.map((entry) => [entry.resource, entry.code]),
      [["task_review_round", "task_review_round_still_current"]]);
    const retried = transitionFor(configDir).archiveProjectRuntimeState(project_id);
    assert.deepEqual(retried, { ok: true, resources: { task_review_rounds_cancelled: 1 }, cleanup_errors: [] },
      "the retry cancels the round the concurrent writer added");
  }

  console.log("project-archive-transition.test.js: all assertions passed");
} finally {
  removeDirectories();
}
