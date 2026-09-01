"use strict";

const assert = require("node:assert/strict");
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
function candidateFor(ref) {
  return buildWorkTaskCandidate({
    version: 1,
    work_task_ref: copy(ref),
    base_sha,
    candidate_sha,
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
  state = persist(store, state, event("record_candidate", "cut_candidate", { candidate }));
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

console.log("work-task-pipeline-store.test.js: all assertions passed");
