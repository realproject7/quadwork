"use strict";

// #1071 substep B: the active and retired WorkTask pipeline records shared one
// flat namespace, and both identifiers were allowed to be long enough that the
// resulting single filename could not exist at all.
//
// Defect 1 (collision).  `PROJECT_RE` admits `.`, so project
// `quadwork.retired.0001` produced the active filename
// `<installation>--quadwork.retired.0001.json`, which is byte-identical to the
// retired filename project `quadwork` takes at ordinal 1.  One project's live
// record was another project's retired record: an `initialize` was refused as
// a foreign identity, and a `retire` renamed its record straight over a
// different project's live state.
//
// Defect 2 (NAME_MAX).  Both identifiers are bounded at 128 characters, so the
// flat name reached 128 + 2 + 128 + 5 = 263 bytes against a NAME_MAX of 255.
// Maximum-length identifiers could not be stored at all.
//
// Both are reproduced here against the store's public surface, together with
// the legacy-layout handling the fix has to keep fail-closed.

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
  applyWorkTaskPipelinePlan,
} = require("./work-task-pipeline");
const {
  WorkTaskPipelineStoreError,
  assertWorkTaskPipelineStoreState,
  workTaskPipelineStorePath,
  createWorkTaskPipelineStore,
} = require("./work-task-pipeline-store");

// The platform bound this module has to fit inside, spelled out rather than
// imported: `getconf NAME_MAX /` reports 255 on macOS/APFS and on Linux ext4.
const NAME_MAX = 255;
// The owner-only file mode every durable record must carry, spelled out here
// so this file can never agree with a production constant that moved.
const RECORD_MODE = 0o600;
// The identifier bounds the store's own regexes admit, also spelled out.
const MAX_INSTALLATION_ID_LENGTH = 128;
const MAX_PROJECT_ID_LENGTH = 128;

const installation_id = "installation_alpha_0001";
const issue_body_revision = "c".repeat(64);
const web42 = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof WorkTaskPipelineStoreError && error.code === expected,
    `expected ${expected}`);
}
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-worktask-ns-"));
  fs.chmodSync(directory, 0o700);
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
  const manifest = buildBatchManifest({
    version: 1,
    installation_id: options.installation_id || installation_id,
    project_id: options.project_id,
    delivery_mode: "isolated",
    tasks: [{
      task_key: options.task_key || "build",
      repository_key: "web",
      work_item: copy(web42),
      goal: "persist an exact local pipeline state",
      file_boundary: ["server/work.js"],
      validation: ["node:test"],
      dependencies: [],
    }],
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
function seed(directory, owner, options = {}) {
  const manifest = frozenManifest({ ...owner, ...options });
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs: options.fs || fs });
  const state = store.initialize({
    expected: initialExpected(manifest),
    manifest,
    pipeline: buildWorkTaskPipeline(manifest),
  });
  return { store, manifest, state };
}
function archivedRecord(owner, options = {}) {
  const manifest = frozenManifest({ ...owner, ...options });
  const pipeline = buildWorkTaskPipeline(manifest);
  const event = { version: 1, kind: "set_archived", event_id: options.event_id || "legacy_archive", archived: true };
  const archived = applyWorkTaskPipelinePlan(pipeline, planWorkTaskPipelineEvent(pipeline, event));
  const record = {
    schema_version: 1,
    identity: { installation_id: owner.installation_id, project_id: owner.project_id },
    manifest: copy(manifest),
    pipeline: copy(archived),
    terminal_audit: [{
      kind: "archive",
      event_id: event.event_id,
      archived: true,
      pipeline_digest: archived.pipeline_digest,
    }],
  };
  // The fixture is a record the store itself would accept, proven here rather
  // than assumed, so a later refusal is about the layout and never the bytes.
  assertWorkTaskPipelineStoreState(copy(record));
  return record;
}
function liveRecord(owner, options = {}) {
  const manifest = frozenManifest({ ...owner, ...options });
  const record = {
    schema_version: 1,
    identity: { installation_id: owner.installation_id, project_id: owner.project_id },
    manifest: copy(manifest),
    pipeline: copy(buildWorkTaskPipeline(manifest)),
    terminal_audit: [],
  };
  assertWorkTaskPipelineStoreState(copy(record));
  return record;
}
// The flat, pre-#1071 layout, written by hand so a migration can be exercised
// without a second checkout of the old module.
function legacyDirectory(directory) { return path.join(directory, "work-task-pipelines"); }
function legacyActivePath(directory, owner) {
  return path.join(legacyDirectory(directory), `${owner.installation_id}--${owner.project_id}.json`);
}
function legacyRetiredPath(directory, owner, ordinal) {
  return path.join(legacyDirectory(directory),
    `${owner.installation_id}--${owner.project_id}.retired.${String(ordinal).padStart(4, "0")}.json`);
}
function writeLegacy(target, record, mode = RECORD_MODE) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode, flag: "w" });
  fs.chmodSync(target, mode);
  return target;
}
function retiredNames(directory, owner) {
  const ownerDirectory = path.dirname(workTaskPipelineStorePath(directory, owner));
  let names;
  try { names = fs.readdirSync(ownerDirectory); } catch { return []; }
  return names.filter((name) => name.includes(".retired.")).sort();
}

// ---------------------------------------------------------------------------
// Defect 1: a project whose id spells another project's retired suffix.
// ---------------------------------------------------------------------------

// A retired predecessor never occupies a live successor's record. `quadwork`
// retires at ordinal 1; the project literally named `quadwork.retired.0001`
// then initializes, reads back its own identity, and leaves the predecessor's
// provenance untouched.
withDirectory((directory) => {
  const base = { installation_id, project_id: "quadwork" };
  const shadow = { installation_id, project_id: "quadwork.retired.0001" };
  const { store, state } = seed(directory, base);
  const retired = store.retire({ expected: currentExpected(state), event_id: "ns_retire_base" });
  assert.equal(retired.pipeline.archived, true);
  assert.deepEqual(retiredNames(directory, base).length, 1);

  const shadowSeed = seed(directory, shadow, { task_key: "shadow" });
  assert.equal(shadowSeed.state.identity.project_id, "quadwork.retired.0001");
  assert.deepEqual(shadowSeed.store.readRecoverySnapshot(shadow), shadowSeed.state);
  assert.equal(shadowSeed.store.readRecoverySnapshot(shadow).pipeline.archived, false);
  assert.equal(store.readRetiredSnapshots(shadow).length, 0,
    "the successor-named project owns no retired record of its own");

  const provenance = store.readRetiredSnapshots(base);
  assert.equal(provenance.length, 1);
  assert.deepEqual(provenance[0], retired, "the predecessor's retired record is untouched");
});

// The same collision in the other direction: a live project named
// `quadwork.retired.0001` is not overwritten when `quadwork` retires.
withDirectory((directory) => {
  const base = { installation_id, project_id: "quadwork" };
  const shadow = { installation_id, project_id: "quadwork.retired.0001" };
  const shadowSeed = seed(directory, shadow, { task_key: "shadow" });
  const before = shadowSeed.store.readRecoverySnapshot(shadow);

  const { store, state } = seed(directory, base);
  store.retire({ expected: currentExpected(state), event_id: "ns_retire_over_live" });

  assert.deepEqual(store.readRecoverySnapshot(shadow), before,
    "retiring one project never renames a record over another project's live state");
  assert.equal(store.readRetiredSnapshots(base).length, 1);
  assert.equal(store.readRetiredSnapshots(shadow).length, 0);
});

// ---------------------------------------------------------------------------
// Defect 2: maximum-length identifiers must be storable.
// ---------------------------------------------------------------------------

withDirectory((directory) => {
  const longInstallation = `i${"0".repeat(MAX_INSTALLATION_ID_LENGTH - 1)}`;
  const longProject = `p${"1".repeat(MAX_PROJECT_ID_LENGTH - 1)}`;
  assert.equal(longInstallation.length, 128);
  assert.equal(longProject.length, 128);
  const owner = { installation_id: longInstallation, project_id: longProject };

  const statePath = workTaskPipelineStorePath(directory, owner);
  for (const component of path.relative(directory, statePath).split(path.sep)) {
    assert.ok(Buffer.byteLength(component, "utf8") <= NAME_MAX,
      `path component ${component.length} bytes exceeds NAME_MAX ${NAME_MAX}`);
  }

  const { store, state } = seed(directory, owner);
  assert.deepEqual(store.readRecoverySnapshot(owner), state);
  const retired = store.retire({ expected: currentExpected(state), event_id: "ns_retire_long" });
  assert.equal(store.readRetiredSnapshots(owner).length, 1);
  assert.deepEqual(store.readRetiredSnapshots(owner)[0], retired);
  for (const name of retiredNames(directory, owner)) {
    assert.ok(Buffer.byteLength(name, "utf8") <= NAME_MAX);
  }
});

// ---------------------------------------------------------------------------
// Legacy layout: adopted only when it is unambiguous, otherwise fail-closed.
// ---------------------------------------------------------------------------

// A flat legacy active record and its retired predecessors are migrated intact,
// in place of nothing, with their ordinals and their order preserved.
withDirectory((directory) => {
  const owner = { installation_id, project_id: "quadwork" };
  const active = liveRecord(owner, { task_key: "legacy_active" });
  const first = archivedRecord(owner, { task_key: "legacy_first", event_id: "legacy_archive_one" });
  const second = archivedRecord(owner, { task_key: "legacy_second", event_id: "legacy_archive_two" });
  writeLegacy(legacyActivePath(directory, owner), active);
  writeLegacy(legacyRetiredPath(directory, owner, 1), first);
  writeLegacy(legacyRetiredPath(directory, owner, 2), second);

  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const recovered = store.readRecoverySnapshot(owner);
  assert.equal(recovered.manifest.manifest_digest, active.manifest.manifest_digest);
  const provenance = store.readRetiredSnapshots(owner);
  assert.deepEqual(provenance.map((entry) => entry.manifest.manifest_digest),
    [first.manifest.manifest_digest, second.manifest.manifest_digest],
    "retired ordinal order survives the migration");

  assert.equal(fs.existsSync(legacyActivePath(directory, owner)), false);
  assert.equal(fs.existsSync(legacyRetiredPath(directory, owner, 1)), false);
  assert.equal(fs.existsSync(legacyRetiredPath(directory, owner, 2)), false);
  assert.equal(fs.existsSync(workTaskPipelineStorePath(directory, owner)), true);
  assert.deepEqual(retiredNames(directory, owner).length, 2);
  assert.equal(fs.statSync(workTaskPipelineStorePath(directory, owner)).mode & 0o777, RECORD_MODE);

  // The migrated store keeps working: a new retirement takes the next ordinal.
  const retired = store.retire({ expected: currentExpected(recovered), event_id: "legacy_retire_next" });
  assert.equal(retired.pipeline.archived, true);
  assert.equal(store.readRetiredSnapshots(owner).length, 3);
});

// A legacy name that two identities can both spell is resolved by the record's
// own stored identity and by nothing else. The file below is the live record of
// `quadwork.retired.0001`; `quadwork` must not adopt it as its retired ordinal.
withDirectory((directory) => {
  const base = { installation_id, project_id: "quadwork" };
  const shadow = { installation_id, project_id: "quadwork.retired.0001" };
  const aliased = legacyActivePath(directory, shadow);
  assert.equal(aliased, legacyRetiredPath(directory, base, 1),
    "the fixture really is the one filename both identities spell");
  writeLegacy(aliased, liveRecord(shadow, { task_key: "aliased" }));

  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  assert.deepEqual(store.readRetiredSnapshots(base), [],
    "a record belonging to another identity is never adopted as retired provenance");
  assert.equal(fs.existsSync(aliased), true, "and it is left exactly where it is");

  const recovered = store.readRecoverySnapshot(shadow);
  assert.equal(recovered.identity.project_id, "quadwork.retired.0001");
  assert.equal(fs.existsSync(aliased), false, "its real owner migrates it");
  assert.equal(fs.existsSync(workTaskPipelineStorePath(directory, shadow)), true);
  assert.deepEqual(store.readRetiredSnapshots(base), []);
});

// A migrated record and a legacy record for the same identity cannot both be
// authoritative, so neither is read and neither is touched.
withDirectory((directory) => {
  const owner = { installation_id, project_id: "quadwork" };
  const { state } = seed(directory, owner);
  const current = workTaskPipelineStorePath(directory, owner);
  const currentBytes = fs.readFileSync(current, "utf8");
  const stale = writeLegacy(legacyActivePath(directory, owner), liveRecord(owner, { task_key: "stale_legacy" }));
  const staleBytes = fs.readFileSync(stale, "utf8");

  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  throwsCode(() => store.readRecoverySnapshot(owner), "work_task_pipeline_store_legacy_conflict");
  throwsCode(() => store.readRetiredSnapshots(owner), "work_task_pipeline_store_legacy_conflict");
  assert.equal(fs.readFileSync(current, "utf8"), currentBytes, "the migrated record is untouched");
  assert.equal(fs.readFileSync(stale, "utf8"), staleBytes, "the legacy record is untouched");
  assert.equal(state.identity.project_id, owner.project_id);
});

// Unsafe or undecidable legacy candidates are refused rather than guessed at.
withDirectory((directory) => {
  const owner = { installation_id, project_id: "quadwork" };
  const outside = path.join(directory, "outside-record.json");
  fs.writeFileSync(outside, `${JSON.stringify(liveRecord(owner))}\n`, { encoding: "utf8", mode: RECORD_MODE });
  fs.mkdirSync(legacyDirectory(directory), { recursive: true, mode: 0o700 });
  const linked = legacyActivePath(directory, owner);
  fs.symlinkSync(outside, linked);
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  throwsCode(() => store.readRecoverySnapshot(owner), "work_task_pipeline_store_symlink_rejected");
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, "the symbolic link is never followed or replaced");
  fs.unlinkSync(linked);

  writeLegacy(linked, liveRecord(owner), 0o644);
  throwsCode(() => store.readRecoverySnapshot(owner), "work_task_pipeline_store_insecure_permissions");
  assert.equal(fs.statSync(linked).mode & 0o777, 0o644);
  fs.unlinkSync(linked);

  fs.writeFileSync(linked, "{not-json", { encoding: "utf8", mode: RECORD_MODE, flag: "w" });
  throwsCode(() => store.readRecoverySnapshot(owner), "corrupt_work_task_pipeline_store");
  assert.equal(fs.readFileSync(linked, "utf8"), "{not-json", "an undecidable candidate is left in place");
});

// A migration interrupted partway through is resumable: every record is in
// exactly one place, and the retry finishes the move without renumbering.
withDirectory((directory) => {
  const owner = { installation_id, project_id: "quadwork" };
  writeLegacy(legacyActivePath(directory, owner), liveRecord(owner, { task_key: "resume_active" }));
  writeLegacy(legacyRetiredPath(directory, owner, 1), archivedRecord(owner, { task_key: "resume_one", event_id: "resume_archive_one" }));
  writeLegacy(legacyRetiredPath(directory, owner, 2), archivedRecord(owner, { task_key: "resume_two", event_id: "resume_archive_two" }));

  let moved = 0;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (String(from).includes("--") && moved >= 1) {
      const error = new Error("injected crash during the legacy migration");
      error.code = "EIO";
      throw error;
    }
    const result = fs.renameSync(from, to);
    if (String(from).includes("--")) moved += 1;
    return result;
  };
  const faulted = createWorkTaskPipelineStore({ config_dir: directory, fs: faultFs });
  throwsCode(() => faulted.readRecoverySnapshot(owner), "work_task_pipeline_store_write_failed");
  assert.equal(moved, 1, "exactly one record moved before the crash");
  assert.equal(fs.existsSync(legacyRetiredPath(directory, owner, 1)), false);
  assert.equal(fs.existsSync(legacyRetiredPath(directory, owner, 2)), true);
  assert.equal(fs.existsSync(legacyActivePath(directory, owner)), true,
    "the active record is migrated last, so an interrupted store still has one");

  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const recovered = store.readRecoverySnapshot(owner);
  assert.equal(recovered.identity.project_id, owner.project_id);
  assert.deepEqual(store.readRetiredSnapshots(owner).map((entry) => entry.pipeline.archived), [true, true]);
  assert.deepEqual(retiredNames(directory, owner).length, 2, "no record is duplicated by the resume");
  assert.equal(fs.readdirSync(legacyDirectory(directory)).filter((name) => name.includes("--")).length, 0);
});

// ---------------------------------------------------------------------------
// The retired ordinal bound survives the new layout, and refusing it leaves the
// active record exactly where it was.
// ---------------------------------------------------------------------------

withDirectory((directory) => {
  const owner = { installation_id, project_id: "quadwork" };
  const ownerDirectory = path.dirname(workTaskPipelineStorePath(directory, owner));
  const retireOnceAs = (ordinal, event_id, task_key) => {
    const { store, state } = seed(directory, owner, { task_key });
    const result = store.retire({ expected: currentExpected(state), event_id });
    const names = retiredNames(directory, owner);
    const latest = names[names.length - 1];
    fs.renameSync(path.join(ownerDirectory, latest), path.join(ownerDirectory, `record.retired.${ordinal}.json`));
    return { store, result };
  };
  retireOnceAs("9998", "bound_first", "bound_one");
  assert.deepEqual(retiredNames(directory, owner), ["record.retired.9998.json"]);

  const { store, state } = seed(directory, owner, { task_key: "bound_two" });
  store.retire({ expected: currentExpected(state), event_id: "bound_second" });
  assert.deepEqual(retiredNames(directory, owner), ["record.retired.9998.json", "record.retired.9999.json"]);

  const third = seed(directory, owner, { task_key: "bound_three" });
  const activePath = workTaskPipelineStorePath(directory, owner);
  const activeBytes = fs.readFileSync(activePath, "utf8");
  throwsCode(() => third.store.retire({ expected: currentExpected(third.state), event_id: "bound_third" }),
    "work_task_pipeline_store_retired_bound");
  assert.equal(fs.existsSync(activePath), true, "a refused retirement leaves the active record in place");
  assert.deepEqual(retiredNames(directory, owner), ["record.retired.9998.json", "record.retired.9999.json"]);
  assert.notEqual(fs.readFileSync(activePath, "utf8"), activeBytes,
    "the archive transition before the refused rename is still durable");
});

console.log("work-task-pipeline-store-namespace.test.js: all assertions passed");
