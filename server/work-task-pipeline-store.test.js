"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildBatchManifest,
  freezeBatchManifest,
} = require("./work-task-manifest");
const {
  buildWorkTaskPipeline,
  planWorkTaskPipelineEvent,
} = require("./work-task-pipeline");
const {
  buildWorkTaskCandidate,
} = require("./work-task-candidate");
const {
  FILE_MODE,
  MAX_TERMINAL_AUDIT,
  WorkTaskPipelineStoreError,
  assertWorkTaskPipelineStoreState,
  workTaskPipelineStorePath,
  createWorkTaskPipelineStore,
} = require("./work-task-pipeline-store");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const owner = { installation_id, project_id };
const issue_body_revision = "c".repeat(64);
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);
const web42 = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof WorkTaskPipelineStoreError && error.code === expected);
}
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-worktask-store-"));
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function resolveRegisteredIdentity(input) {
  return {
    installation_id: input.installation_id,
    project_id: input.project_id,
    repository_key: input.repository_key,
    work_item: copy(input.work_item),
    issue_body_revision,
  };
}
function frozenManifest(options = {}) {
  const sourceTasks = options.tasks || [{
    task_key: "build",
    repository_key: "web",
    work_item: copy(web42),
    goal: "persist an exact local pipeline state",
    file_boundary: ["server/work.js"],
    validation: ["node:test"],
    dependencies: [],
  }];
  const manifest = buildBatchManifest({
    version: 1,
    installation_id: options.installation_id || installation_id,
    project_id: options.project_id || project_id,
    delivery_mode: "isolated",
    tasks: sourceTasks,
  }, { resolveRegisteredIdentity });
  return freezeBatchManifest(manifest, "2026-09-01T00:00:00.000Z");
}
function initialExpected(manifest) {
  return {
    installation_id: manifest.installation_id,
    project_id: manifest.project_id,
    manifest_digest: manifest.manifest_digest,
    pipeline_digest: null,
  };
}
function currentExpected(state) {
  return {
    installation_id: state.identity.installation_id,
    project_id: state.identity.project_id,
    manifest_digest: state.manifest.manifest_digest,
    pipeline_digest: state.pipeline.pipeline_digest,
  };
}
function initialized(directory, options = {}) {
  const manifest = options.manifest || frozenManifest();
  const pipeline = buildWorkTaskPipeline(manifest);
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs: options.fs || fs });
  const state = store.initialize({ expected: initialExpected(manifest), manifest, pipeline });
  return { store, manifest, pipeline, state };
}
function event(kind, event_id, fields = {}) {
  return { version: 1, kind, event_id, ...(kind === "assign_build" ? { base_sha } : {}), ...fields };
}
function persist(store, state, nextEvent, terminal_disposition = null) {
  const plan = planWorkTaskPipelineEvent(state.pipeline, nextEvent);
  return store.applyPlan({ expected: currentExpected(state), plan, terminal_disposition });
}
// Mirrors the module's stable digest so a test can write a record in an older
// persisted shape whose pipeline_digest still verifies.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function redigest(pipeline) {
  const { pipeline_digest, ...payload } = pipeline;
  return { ...payload, pipeline_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") };
}
function candidateFor(ref, sha = candidate_sha) {
  return buildWorkTaskCandidate({
    version: 1,
    work_task_ref: copy(ref),
    base_sha,
    candidate_sha: sha,
    branch: "task/work-task-build",
    worktree: { repository_key: "web", worktree_id: "wt_build_01", path: "/var/folders/quadwork/task-build" },
  }, {
    canonicalizePath(request) { return { version: 1, canonical_path: request.path.replace(/^\/var\//, "/private/var/") }; },
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
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}

// Initialization is explicit (no missing-state default), is private mode 0600,
// and returns a deep-frozen recovery snapshot that survives a fresh store.
withDirectory((directory) => {
  const { store, manifest, state } = initialized(directory);
  const statePath = workTaskPipelineStorePath(directory, owner);
  assert.equal(fs.statSync(statePath).mode & 0o777, FILE_MODE);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.manifest), true);
  assert.equal(state.manifest.manifest_digest, manifest.manifest_digest);
  const restarted = createWorkTaskPipelineStore({ config_dir: directory, fs });
  assert.deepEqual(restarted.readRecoverySnapshot(owner), state);
  assert.equal(Object.isFrozen(restarted.readRecoverySnapshot(owner).pipeline), true);
});

// An apply is an exact compare-and-swap of an immutable pipeline plan. A stale
// expected digest cannot overwrite the pipeline state that won the first write.
withDirectory((directory) => {
  const { store, state } = initialized(directory);
  const ref = state.manifest.tasks[0].ref;
  const plan = planWorkTaskPipelineEvent(state.pipeline, event("assign_build", "store_build_one", {
    work_task_ref: copy(ref), assignment_id: "store_assignment_one",
  }));
  const next = store.applyPlan({ expected: currentExpected(state), plan, terminal_disposition: null });
  assert.equal(next.pipeline.tasks[0].state, "building");
  throwsCode(() => store.applyPlan({ expected: currentExpected(state), plan, terminal_disposition: null }), "stale_work_task_pipeline_store_precondition");
  assert.deepEqual(store.readRecoverySnapshot(owner), next);
});

// #1070: the per-task correction count is persisted as its own fact. It
// survives every corrected candidate (which clears the checkpoint that used to
// carry it), a process restart, and a competing writer; the fourth correction
// is refused before the store is touched, even for a plan forged past planning.
withDirectory((directory) => {
  let { store, state } = initialized(directory);
  const ref = state.manifest.tasks[0].ref;
  const statePath = workTaskPipelineStorePath(directory, owner);
  const pipelineCode = (fn, code) => assert.throws(fn, (error) => error.code === code);
  let candidate = candidateFor(ref);
  state = persist(store, state, event("assign_build", "cap_build_0", { work_task_ref: copy(ref), assignment_id: "cap_assignment_0" }));
  state = persist(store, state, event("record_candidate", "cap_candidate_0", { assignment_id: "cap_assignment_0", candidate }));
  const requestChanges = (round) => {
    const review = { work_task_ref: copy(ref), review_round_id: `cap_round_${round}`, candidate_digest: candidate.candidate_digest };
    state = persist(store, state, event("assign_independent_review", `cap_review_${round}`, review));
    state = persist(store, state, event("record_review_verdict", `cap_verdict_${round}`, { ...review, verdict: "changes_requested" }));
    state = persist(store, state, event("reconcile_review", `cap_reconcile_${round}`, { ...review, resolution: "changes_requested" }));
  };
  const correction = (round, suffix = "") => event("queue_local_correction", `cap_checkpoint_${round}${suffix}`, { work_task_ref: copy(ref), checkpoint_id: `cap_checkpoint_id_${round}${suffix}` });
  for (const round of [1, 2, 3]) {
    requestChanges(round);
    const contested = currentExpected(state);
    const winner = planWorkTaskPipelineEvent(state.pipeline, correction(round));
    const rival = planWorkTaskPipelineEvent(state.pipeline, correction(round, "_rival"));
    state = store.applyPlan({ expected: contested, plan: winner, terminal_disposition: null });
    assert.deepEqual(state.pipeline.tasks[0].correction, { checkpoint_id: `cap_checkpoint_id_${round}`, count: round });
    assert.equal(state.pipeline.tasks[0].correction_count, round);
    // The rival planned from the same snapshot loses the compare-and-swap; a
    // rival or a replay re-planned against the winner's state finds no change
    // request left to spend. The count moved by exactly one.
    throwsCode(() => store.applyPlan({ expected: contested, plan: rival, terminal_disposition: null }), "stale_work_task_pipeline_store_precondition");
    throwsCode(() => store.applyPlan({ expected: currentExpected(state), plan: rival, terminal_disposition: null }), "stale_or_invalid_work_task_pipeline_store_plan");
    throwsCode(() => store.applyPlan({ expected: contested, plan: winner, terminal_disposition: null }), "stale_work_task_pipeline_store_precondition");
    pipelineCode(() => planWorkTaskPipelineEvent(state.pipeline, correction(round)), "duplicate_work_task_pipeline_event");
    assert.deepEqual(store.readRecoverySnapshot(owner), state);
    candidate = candidateFor(ref, "cde"[round - 1].repeat(64));
    state = persist(store, state, event("assign_build", `cap_build_${round}`, { work_task_ref: copy(ref), assignment_id: `cap_assignment_${round}` }));
    state = persist(store, state, event("record_candidate", `cap_candidate_${round}`, { assignment_id: `cap_assignment_${round}`, candidate }));
    const restarted = createWorkTaskPipelineStore({ config_dir: directory, fs }).readRecoverySnapshot(owner);
    assert.deepEqual(restarted, state);
    assert.equal(restarted.pipeline.tasks[0].correction, null);
    assert.equal(restarted.pipeline.tasks[0].correction_count, round);
  }
  assert.equal(state.pipeline.history.filter((entry) => entry.kind === "queue_local_correction").length, 3);
  assert.match(fs.readFileSync(statePath, "utf8"), /"correction_count":3/);
  requestChanges(4);
  pipelineCode(() => planWorkTaskPipelineEvent(state.pipeline, correction(4)), "work_task_checkpoint_limit");
  // A plan that skipped planning is re-derived inside the writer lock and
  // refused there; no temporary file is written and no rename happens.
  const forged = {
    version: 1,
    transaction: "work_task_pipeline",
    precondition: { pipeline_digest: state.pipeline.pipeline_digest, manifest_digest: state.manifest.manifest_digest, history_length: state.pipeline.history.length, manifest_frozen: true, archived: false },
    event: correction(4),
    effects: [{ work_task_ref: copy(ref), from_state: "changes_requested", to_state: "queued" }],
  };
  const writes = [];
  const countingFs = Object.create(fs);
  // The writer lock record is written through its descriptor; only a path
  // target is a state or temporary file write.
  countingFs.writeFileSync = (target, ...rest) => { if (typeof target === "string") writes.push(target); return fs.writeFileSync(target, ...rest); };
  countingFs.renameSync = (from, to) => { writes.push(String(to)); return fs.renameSync(from, to); };
  const counting = createWorkTaskPipelineStore({ config_dir: directory, fs: countingFs });
  const bytes = fs.readFileSync(statePath);
  throwsCode(() => counting.applyPlan({ expected: currentExpected(state), plan: forged, terminal_disposition: null }), "stale_or_invalid_work_task_pipeline_store_plan");
  assert.deepEqual(writes, []);
  assert.equal(fs.readFileSync(statePath).equals(bytes), true);
  assert.deepEqual(counting.readRecoverySnapshot(owner), state);
  assert.equal(state.pipeline.tasks[0].correction_count, 3);
  // Positive control: the same wrapped fs records an admitted plan's write.
  state = persist(counting, state, event("block", "cap_block", { work_task_ref: copy(ref), block_code: "validation" }));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].startsWith(`${statePath}.`) && writes[0].endsWith(".tmp"), true);
  assert.equal(writes[1], statePath);
  assert.equal(state.pipeline.tasks[0].correction_count, 3);
});

// #1070: a record persisted before `correction_count` existed stays readable
// under its original digest. Such a slot is read with the pre-#1070 meaning
// (the active checkpoint's count, else zero) and the field is written on the
// next applied plan, so the cap continues from what the old record could prove.
withDirectory((directory) => {
  let { store, state } = initialized(directory);
  const ref = state.manifest.tasks[0].ref;
  const statePath = workTaskPipelineStorePath(directory, owner);
  let candidate = candidateFor(ref);
  state = persist(store, state, event("assign_build", "legacy_build_0", { work_task_ref: copy(ref), assignment_id: "legacy_assignment_0" }));
  state = persist(store, state, event("record_candidate", "legacy_candidate_0", { assignment_id: "legacy_assignment_0", candidate }));
  const requestChanges = (round) => {
    const review = { work_task_ref: copy(ref), review_round_id: `legacy_round_${round}`, candidate_digest: candidate.candidate_digest };
    state = persist(store, state, event("assign_independent_review", `legacy_review_${round}`, review));
    state = persist(store, state, event("record_review_verdict", `legacy_verdict_${round}`, { ...review, verdict: "changes_requested" }));
    state = persist(store, state, event("reconcile_review", `legacy_reconcile_${round}`, { ...review, resolution: "changes_requested" }));
    state = persist(store, state, event("queue_local_correction", `legacy_checkpoint_${round}`, { work_task_ref: copy(ref), checkpoint_id: `legacy_checkpoint_id_${round}` }));
  };
  const asLegacy = () => {
    const legacy = copy(state);
    delete legacy.pipeline.tasks[0].correction_count;
    legacy.pipeline = redigest(legacy.pipeline);
    fs.writeFileSync(statePath, `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: FILE_MODE });
    store = createWorkTaskPipelineStore({ config_dir: directory, fs });
    state = store.readRecoverySnapshot(owner);
    assert.equal(Object.prototype.hasOwnProperty.call(state.pipeline.tasks[0], "correction_count"), false);
    assertWorkTaskPipelineStoreState(copy(state));
  };
  requestChanges(1);
  candidate = candidateFor(ref, "c".repeat(64));
  state = persist(store, state, event("assign_build", "legacy_build_1", { work_task_ref: copy(ref), assignment_id: "legacy_assignment_1" }));
  state = persist(store, state, event("record_candidate", "legacy_candidate_1", { assignment_id: "legacy_assignment_1", candidate }));
  requestChanges(2);
  assert.deepEqual(state.pipeline.tasks[0].correction, { checkpoint_id: "legacy_checkpoint_id_2", count: 2 });
  asLegacy();
  assert.deepEqual(state.pipeline.tasks[0].correction, { checkpoint_id: "legacy_checkpoint_id_2", count: 2 });
  state = persist(store, state, event("assign_build", "legacy_build_2", { work_task_ref: copy(ref), assignment_id: "legacy_assignment_2" }));
  assert.equal(state.pipeline.tasks[0].correction_count, 2);
  assert.match(fs.readFileSync(statePath, "utf8"), /"correction_count":2/);
  candidate = candidateFor(ref, "d".repeat(64));
  state = persist(store, state, event("record_candidate", "legacy_candidate_2", { assignment_id: "legacy_assignment_2", candidate }));
  assert.equal(state.pipeline.tasks[0].correction, null);
  assert.equal(state.pipeline.tasks[0].correction_count, 2);
  requestChanges(3);
  assert.equal(state.pipeline.tasks[0].correction_count, 3);
  // An old record whose checkpoint had already cleared never persisted its
  // count anywhere; it reads as zero and the field is written as zero.
  candidate = candidateFor(ref, "e".repeat(64));
  state = persist(store, state, event("assign_build", "legacy_build_3", { work_task_ref: copy(ref), assignment_id: "legacy_assignment_3" }));
  state = persist(store, state, event("record_candidate", "legacy_candidate_3", { assignment_id: "legacy_assignment_3", candidate }));
  asLegacy();
  assert.equal(state.pipeline.tasks[0].correction, null);
  state = persist(store, state, event("block", "legacy_block", { work_task_ref: copy(ref), block_code: "validation" }));
  assert.equal(state.pipeline.tasks[0].correction_count, 0);
});

// A failed rename leaves the previously committed JSON state readable and
// unchanged; temporary material is removed without touching candidates or a
// worktree.
withDirectory((directory) => {
  const { store, state } = initialized(directory);
  const ref = state.manifest.tasks[0].ref;
  const plan = planWorkTaskPipelineEvent(state.pipeline, event("assign_build", "atomic_build", {
    work_task_ref: copy(ref), assignment_id: "atomic_assignment",
  }));
  const failingFs = Object.create(fs);
  failingFs.renameSync = (from, to) => {
    if (String(to).endsWith(".json")) {
      const error = new Error("injected rename failure");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const failingStore = createWorkTaskPipelineStore({ config_dir: directory, fs: failingFs });
  throwsCode(() => failingStore.applyPlan({ expected: currentExpected(state), plan, terminal_disposition: null }), "work_task_pipeline_store_write_failed");
  assert.deepEqual(store.readRecoverySnapshot(owner), state);
  const files = fs.readdirSync(path.dirname(workTaskPipelineStorePath(directory, owner)));
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
});

// Replacing a lock after this writer has acquired it but before release must
// not let the original writer unlink a second writer's lock. The operation
// fails closed and the replacement stays present for explicit recovery.
withDirectory((directory) => {
  const { state } = initialized(directory);
  const ref = state.manifest.tasks[0].ref;
  const plan = planWorkTaskPipelineEvent(state.pipeline, event("assign_build", "replace_lock_build", {
    work_task_ref: copy(ref), assignment_id: "replace_lock_assignment",
  }));
  const statePath = workTaskPipelineStorePath(directory, owner);
  const lockPath = `${statePath}.lock`;
  let lockPathInspections = 0;
  const replacingFs = Object.create(fs);
  replacingFs.lstatSync = (target) => {
    if (target === lockPath) {
      lockPathInspections += 1;
      if (lockPathInspections === 2) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, "replacement-writer-lock", { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      }
    }
    return fs.lstatSync(target);
  };
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs: replacingFs });
  throwsCode(() => store.applyPlan({ expected: currentExpected(state), plan, terminal_disposition: null }), "work_task_pipeline_store_lock_release_failed");
  assert.equal(lockPathInspections, 2);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement-writer-lock");
  assert.equal(fs.lstatSync(lockPath).isFile(), true);
});

// Linux reuses inode numbers eagerly, so a lock replaced after this writer
// closed its descriptor can report the original dev+ino. The stubbed lstat
// forces exactly that; only the lock token can then prove the replacement.
withDirectory((directory) => {
  const { state } = initialized(directory);
  const ref = state.manifest.tasks[0].ref;
  const plan = planWorkTaskPipelineEvent(state.pipeline, event("assign_build", "inode_reuse_build", {
    work_task_ref: copy(ref), assignment_id: "inode_reuse_assignment",
  }));
  const lockPath = `${workTaskPipelineStorePath(directory, owner)}.lock`;
  let inspections = 0;
  let original = null;
  const replacingFs = Object.create(fs);
  replacingFs.lstatSync = (target) => {
    if (target !== lockPath) return fs.lstatSync(target);
    inspections += 1;
    if (inspections === 1) {
      original = fs.lstatSync(target);
      return original;
    }
    if (inspections === 2) {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, "replacement-writer-lock", { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    }
    const stats = fs.lstatSync(target);
    stats.dev = original.dev;
    stats.ino = original.ino;
    return stats;
  };
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs: replacingFs });
  throwsCode(() => store.applyPlan({ expected: currentExpected(state), plan, terminal_disposition: null }), "work_task_pipeline_store_lock_release_failed");
  assert.equal(inspections, 2);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement-writer-lock");
});

// Missing, corrupt, and future-schema state all fail closed. In particular a
// corrupt state cannot be silently replaced by an explicit initialization.
withDirectory((directory) => {
  const manifest = frozenManifest();
  const pipeline = buildWorkTaskPipeline(manifest);
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const plan = planWorkTaskPipelineEvent(pipeline, event("assign_build", "missing_build", {
    work_task_ref: copy(manifest.tasks[0].ref), assignment_id: "missing_assignment",
  }));
  throwsCode(() => store.readRecoverySnapshot(owner), "work_task_pipeline_store_missing");
  throwsCode(() => store.applyPlan({ expected: { ...initialExpected(manifest), pipeline_digest: pipeline.pipeline_digest }, plan, terminal_disposition: null }), "work_task_pipeline_store_missing");

  const statePath = workTaskPipelineStorePath(directory, owner);
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, "{not-json", { encoding: "utf8", mode: FILE_MODE });
  throwsCode(() => store.readRecoverySnapshot(owner), "corrupt_work_task_pipeline_store");
  throwsCode(() => store.initialize({ expected: initialExpected(manifest), manifest, pipeline }), "corrupt_work_task_pipeline_store");
  assert.equal(fs.readFileSync(statePath, "utf8"), "{not-json");

  fs.writeFileSync(statePath, JSON.stringify({ schema_version: 2 }), { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  fs.chmodSync(statePath, FILE_MODE);
  throwsCode(() => store.readRecoverySnapshot(owner), "unknown_work_task_pipeline_store_schema");
});

// A path's permissions are not authority by themselves: config roots, the
// store directory, and the state file are all inspected with lstat and reject
// symlink indirection before a read or writer lock can follow it.
withDirectory((directory) => {
  const manifest = frozenManifest();
  const pipeline = buildWorkTaskPipeline(manifest);
  const realRoot = path.join(directory, "real-config-root");
  const rootLink = path.join(directory, "config-root-link");
  fs.mkdirSync(realRoot, { mode: 0o700 });
  fs.symlinkSync(realRoot, rootLink);
  const rootStore = createWorkTaskPipelineStore({ config_dir: rootLink, fs });
  throwsCode(() => rootStore.initialize({ expected: initialExpected(manifest), manifest, pipeline }), "work_task_pipeline_store_symlink_rejected");

  const storageRoot = path.join(directory, "storage-root");
  const externalStorage = path.join(directory, "outside-storage");
  fs.mkdirSync(storageRoot, { mode: 0o700 });
  fs.mkdirSync(externalStorage, { mode: 0o700 });
  fs.symlinkSync(externalStorage, path.join(storageRoot, "work-task-pipelines"));
  const directoryStore = createWorkTaskPipelineStore({ config_dir: storageRoot, fs });
  throwsCode(() => directoryStore.initialize({ expected: initialExpected(manifest), manifest, pipeline }), "work_task_pipeline_store_symlink_rejected");

  const outsideConfig = path.join(directory, "outside-config");
  const { state: outsideState } = initialized(outsideConfig);
  const outsidePath = workTaskPipelineStorePath(outsideConfig, owner);
  assert.equal(outsideState.identity.project_id, project_id);
  const fileRoot = path.join(directory, "file-root");
  const linkedStatePath = workTaskPipelineStorePath(fileRoot, owner);
  fs.mkdirSync(path.dirname(linkedStatePath), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outsidePath, linkedStatePath);
  const fileStore = createWorkTaskPipelineStore({ config_dir: fileRoot, fs });
  throwsCode(() => fileStore.readRecoverySnapshot(owner), "work_task_pipeline_store_symlink_rejected");
});

// The pathname alone is never authority: every loaded manifest/pipeline must
// agree with the requested installation/project identity.
withDirectory((directory) => {
  const otherProject = "quadwork-other";
  const manifest = frozenManifest({ project_id: otherProject });
  const pipeline = buildWorkTaskPipeline(manifest);
  const foreignState = {
    schema_version: 1,
    identity: { installation_id, project_id: otherProject },
    manifest: copy(manifest),
    pipeline: copy(pipeline),
    terminal_audit: [],
  };
  assert.equal(assertWorkTaskPipelineStoreState(foreignState), foreignState);
  const statePath = workTaskPipelineStorePath(directory, owner);
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, JSON.stringify(foreignState), { encoding: "utf8", mode: FILE_MODE });
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  throwsCode(() => store.readRecoverySnapshot(owner), "work_task_pipeline_store_identity_mismatch");
});

// Terminal dispositions are explicit and preserve the immutable frozen
// manifest plus pipeline history for archive, integrated cut, and contract
// change rather than constructing a successor task or deleting local state.
withDirectory((directory) => {
  const { store, state: initial } = initialized(directory);
  const archiveEvent = event("set_archived", "archive_store", { archived: true });
  const archivePlan = planWorkTaskPipelineEvent(initial.pipeline, archiveEvent);
  throwsCode(() => store.applyPlan({ expected: currentExpected(initial), plan: archivePlan, terminal_disposition: null }), "work_task_pipeline_terminal_disposition_required");
  const archived = store.applyPlan({
    expected: currentExpected(initial), plan: archivePlan,
    terminal_disposition: { kind: "archive", event_id: "archive_store", archived: true },
  });
  assert.equal(archived.pipeline.archived, true);
  assert.deepEqual(archived.terminal_audit[0], {
    kind: "archive", event_id: "archive_store", archived: true, pipeline_digest: archived.pipeline.pipeline_digest,
  });
  assert.deepEqual(archived.manifest, initial.manifest);
  assert.equal(archived.pipeline.history[0].kind, "set_archived");
});

withDirectory((directory) => {
  const { store, state: initial } = initialized(directory);
  const ref = initial.manifest.tasks[0].ref;
  const candidate = candidateFor(ref);
  let state = persist(store, initial, event("assign_build", "cut_build", { work_task_ref: copy(ref), assignment_id: "cut_assignment" }));
  state = persist(store, state, event("record_candidate", "cut_candidate", { assignment_id: "cut_assignment", candidate }));
  state = persist(store, state, event("assign_independent_review", "cut_review", {
    work_task_ref: copy(ref), review_round_id: "cut_round", candidate_digest: candidate.candidate_digest,
  }));
  state = persist(store, state, event("record_review_verdict", "cut_verdict", {
    work_task_ref: copy(ref), review_round_id: "cut_round", candidate_digest: candidate.candidate_digest, verdict: "approved",
  }));
  state = persist(store, state, event("reconcile_review", "cut_reconcile", {
    work_task_ref: copy(ref), review_round_id: "cut_round", candidate_digest: candidate.candidate_digest, resolution: "accepted",
  }));
  const cutEvent = event("integrated_cut", "cut_terminal", {
    tasks: [{ work_task_ref: copy(ref), candidate_digest: candidate.candidate_digest }],
  });
  const cutPlan = planWorkTaskPipelineEvent(state.pipeline, cutEvent);
  const cut = store.applyPlan({
    expected: currentExpected(state), plan: cutPlan,
    terminal_disposition: { kind: "integrated_cut", event_id: "cut_terminal" },
  });
  assert.equal(cut.pipeline.tasks[0].state, "staged");
  assert.deepEqual(cut.manifest, initial.manifest);
  assert.equal(cut.pipeline.history.at(-1).kind, "integrated_cut");
  assert.equal(cut.terminal_audit.at(-1).kind, "integrated_cut");
});

withDirectory((directory) => {
  const { store, state: initial } = initialized(directory);
  const ref = initial.manifest.tasks[0].ref;
  const changeEvent = event("contract_change", "contract_terminal", {
    work_task_ref: copy(ref), observed_issue_body_revision: "d".repeat(64),
  });
  const changePlan = planWorkTaskPipelineEvent(initial.pipeline, changeEvent);
  const changed = store.applyPlan({
    expected: currentExpected(initial), plan: changePlan,
    terminal_disposition: { kind: "contract_change", event_id: "contract_terminal" },
  });
  assert.equal(changed.pipeline.tasks[0].state, "deferred");
  assert.deepEqual(changed.manifest, initial.manifest);
  assert.equal(changed.pipeline.history.at(-1).kind, "contract_change");
  assert.equal(changed.terminal_audit.at(-1).kind, "contract_change");
});

// Audit retention has a hard bound independent of the pipeline history bound.
// Repeated archive observations retain the most recent evidence without any
// generic mutation or unbounded metadata growth.
withDirectory((directory) => {
  const { store, state: initial } = initialized(directory);
  let state = initial;
  for (let index = 0; index <= MAX_TERMINAL_AUDIT; index += 1) {
    const event_id = `archive_${index}`;
    const archived = index % 2 === 0;
    state = persist(store, state, event("set_archived", event_id, { archived }), {
      kind: "archive", event_id, archived,
    });
  }
  assert.equal(state.terminal_audit.length, MAX_TERMINAL_AUDIT);
  assert.equal(state.terminal_audit[0].event_id, "archive_1");
  assert.equal(state.terminal_audit.at(-1).event_id, `archive_${MAX_TERMINAL_AUDIT}`);
  assert.equal(state.pipeline.history.length, MAX_TERMINAL_AUDIT + 1);
});

// A completed batch retires through the explicit audited archive transition
// and moves aside intact, so a successor manifest can be initialized for the
// same project without overwriting anything. Retired records stay readable.
withDirectory((directory) => {
  const { store, state: initial } = initialized(directory);
  const ref = initial.manifest.tasks[0].ref;
  const statePath = workTaskPipelineStorePath(directory, owner);
  let state = persist(store, initial, event("assign_build", "retire_build", { work_task_ref: copy(ref), assignment_id: "retire_assignment" }));
  throwsCode(() => store.retire({ expected: currentExpected(state), event_id: "retire_active" }), "work_task_pipeline_store_batch_active");
  assert.equal(fs.existsSync(statePath), true);
  state = persist(store, state, event("record_candidate", "retire_candidate", { assignment_id: "retire_assignment", candidate: candidateFor(ref) }));
  throwsCode(() => store.retire({ expected: { ...currentExpected(state), pipeline_digest: initial.pipeline.pipeline_digest }, event_id: "retire_stale" }), "stale_work_task_pipeline_store_precondition");
  throwsCode(() => store.initialize({ expected: initialExpected(initial.manifest), manifest: initial.manifest, pipeline: initial.pipeline }), "work_task_pipeline_store_already_initialized");

  // #1071 (test quality): retirement is a rename(2), which preserves mode, so
  // asserting 0600 on the retired file only restates what the write path
  // already guaranteed -- no realistic defect makes it fail.  The load-bearing
  // property is the refusal: an active record whose mode has been loosened
  // must not be retired at all.  A rename would carry that record into the
  // retained provenance set, which nothing ever rewrites, so the one moment
  // the permissions can still be repaired is before the move.
  const ownerDirectory = path.dirname(statePath);
  const activeBytes = fs.readFileSync(statePath);
  fs.chmodSync(statePath, 0o644);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o644, "the record really is group/world readable before the refused retirement");
  throwsCode(() => store.retire({ expected: currentExpected(state), event_id: "retire_insecure" }), "work_task_pipeline_store_insecure_permissions");
  assert.deepEqual(fs.readdirSync(ownerDirectory).filter((name) => name.includes(".retired.")), [], "a refused retirement creates no retired record");
  assert.equal(fs.existsSync(statePath), true, "a refused retirement leaves the active record on its own path");
  assert.deepEqual(fs.readFileSync(statePath), activeBytes, "a refused retirement rewrites no byte of the active record");
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o644, "a refused retirement does not quietly repair the permissions it rejected");
  fs.chmodSync(statePath, 0o600);

  const retired = store.retire({ expected: currentExpected(state), event_id: "retire_first" });
  assert.equal(retired.pipeline.archived, true);
  assert.deepEqual(retired.pipeline.history.at(-1), { event_id: "retire_first", kind: "set_archived" });
  assert.deepEqual(retired.terminal_audit.at(-1), { kind: "archive", event_id: "retire_first", archived: true, pipeline_digest: retired.pipeline.pipeline_digest });
  assert.equal(fs.existsSync(statePath), false);
  throwsCode(() => store.readRecoverySnapshot(owner), "work_task_pipeline_store_missing");
  throwsCode(() => store.retire({ expected: currentExpected(retired), event_id: "retire_again" }), "work_task_pipeline_store_missing");
  const provenance = store.readRetiredSnapshots(owner);
  assert.equal(provenance.length, 1);
  assert.deepEqual(provenance[0], retired);
  assert.equal(Object.isFrozen(provenance[0]), true);
  assert.equal(provenance[0].pipeline.tasks[0].candidate.candidate_sha, candidate_sha);
  const retiredFiles = fs.readdirSync(path.dirname(statePath)).filter((name) => name.includes(".retired."));
  // #1071: the retired name carries no identity, so it can never be spelled by
  // another project's id.  Ownership is the directory the record sits in.
  assert.deepEqual(retiredFiles, ["record.retired.0001.json"]);
  assert.equal(path.basename(statePath), "record.json");
  assert.equal(path.basename(path.dirname(statePath)), project_id);
  assert.equal(path.basename(path.dirname(path.dirname(statePath))), installation_id);
  // The retired record carries the exact mode the refusal above demands, spelled
  // out as a literal rather than compared against the module's own constant.
  assert.equal(fs.statSync(path.join(ownerDirectory, retiredFiles[0])).mode & 0o777, 0o600);

  // A successor manifest for the same project now initializes cleanly and is
  // isolated from the retired record; a fresh store sees both.
  const successorManifest = frozenManifest({ tasks: [{
    task_key: "successor", repository_key: "web", work_item: copy(web42), goal: "continue after the retired batch",
    file_boundary: ["server/successor.js"], validation: ["node:test"], dependencies: [],
  }] });
  const successor = store.initialize({ expected: initialExpected(successorManifest), manifest: successorManifest, pipeline: buildWorkTaskPipeline(successorManifest) });
  assert.equal(successor.pipeline.archived, false);
  assert.equal(successor.pipeline.tasks[0].work_task_ref.task_key, "successor");
  const restarted = createWorkTaskPipelineStore({ config_dir: directory, fs });
  assert.deepEqual(restarted.readRecoverySnapshot(owner), successor);
  assert.deepEqual(restarted.readRetiredSnapshots(owner), provenance);

  // An already-archived batch (an explicit earlier archive, or a crash between
  // the archive write and the rename) retires without a second transition and
  // takes the next ordinal, so the earlier record is never replaced.
  const archivedSuccessor = persist(restarted, successor, event("set_archived", "successor_archive", { archived: true }), { kind: "archive", event_id: "successor_archive", archived: true });
  const secondRetired = restarted.retire({ expected: currentExpected(archivedSuccessor), event_id: "retire_second" });
  assert.deepEqual(secondRetired.pipeline, archivedSuccessor.pipeline, "an already-archived pipeline takes no second archive transition");
  // #1071: it still records this retirement's own marker before the rename, so
  // the retired record names the retirement that ended it and not just content.
  assert.deepEqual(secondRetired.terminal_audit, [
    { kind: "archive", event_id: "successor_archive", archived: true, pipeline_digest: archivedSuccessor.pipeline.pipeline_digest },
    { kind: "archive", event_id: "retire_second", archived: true, pipeline_digest: archivedSuccessor.pipeline.pipeline_digest },
  ], "the retirement marker is recorded even when the pipeline is already archived");
  const all = restarted.readRetiredSnapshots(owner);
  assert.deepEqual(all.map((entry) => entry.manifest.manifest_digest), [initial.manifest.manifest_digest, successorManifest.manifest_digest]);
  assert.deepEqual(all[0], retired);
  throwsCode(() => restarted.readRecoverySnapshot(owner), "work_task_pipeline_store_missing");
  throwsCode(() => restarted.retire({ expected: null, event_id: "retire_bad" }), "invalid_work_task_pipeline_store_retirement");
});

// #1071: the retirement marker is durable BEFORE the rename, and a retirement
// replayed after a crash between those two writes renames the record without
// writing the marker twice — a duplicate event id would make the record invalid.
withDirectory((directory) => {
  const { store, state: initial } = initialized(directory);
  const archived = persist(store, initial, event("set_archived", "pre_archive", { archived: true }),
    { kind: "archive", event_id: "pre_archive", archived: true });
  let armed = true;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && /\.retired\.\d{4}\.json$/.test(String(to))) {
      const error = new Error("injected crash between the marker and the retired rename");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const faulted = createWorkTaskPipelineStore({ config_dir: directory, fs: faultFs });
  throwsCode(() => faulted.retire({ expected: currentExpected(archived), event_id: "retire_marked" }), "work_task_pipeline_store_write_failed");
  const stranded = store.readRecoverySnapshot(owner);
  const audit = [
    { kind: "archive", event_id: "pre_archive", archived: true, pipeline_digest: archived.pipeline.pipeline_digest },
    { kind: "archive", event_id: "retire_marked", archived: true, pipeline_digest: archived.pipeline.pipeline_digest },
  ];
  assert.deepEqual(stranded.pipeline, archived.pipeline, "the marker write leaves the pipeline untouched");
  assert.deepEqual(stranded.terminal_audit, audit, "the marker is durable before the rename");
  assert.equal(store.readRetiredSnapshots(owner).length, 0);
  armed = false;
  const replayed = faulted.retire({ expected: currentExpected(stranded), event_id: "retire_marked" });
  assert.deepEqual(replayed.terminal_audit, audit, "the replay adds no second marker");
  const provenance = store.readRetiredSnapshots(owner);
  assert.equal(provenance.length, 1);
  assert.deepEqual(provenance[0].terminal_audit, audit);
  throwsCode(() => store.readRecoverySnapshot(owner), "work_task_pipeline_store_missing");
});

console.log("work-task-pipeline-store.test.js: all assertions passed");
