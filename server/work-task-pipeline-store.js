"use strict";

// #1058 M4: durable, project-scoped persistence for an already frozen
// WorkTask manifest and its deterministic pipeline. This module has no route,
// task dispatch, worktree, candidate construction, or publication authority.
// It deliberately exposes only an explicit initial write, read-only recovery,
// and one compare-and-swap application of a pipeline plan.

const nodeFs = require("node:fs");
const path = require("node:path");
const {
  FILE_MODE,
  DIRECTORY_MODE,
  modeOf,
  createDurableStoreFiles,
} = require("./durable-store-files");
const {
  assertBatchManifest,
  workTaskKey,
} = require("./work-task-manifest");
const {
  assertWorkTaskPipeline,
  assertWorkTaskPipelinePlan,
  planWorkTaskPipelineEvent,
  applyWorkTaskPipelinePlan,
} = require("./work-task-pipeline");

const SCHEMA_VERSION = 1;
const MAX_TERMINAL_AUDIT = 64;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EVENT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const TERMINAL_KINDS = new Set(["archive", "integrated_cut", "contract_change"]);
const ACTIVE_AUTHORITY_STATES = new Set(["building", "independent_review", "reconcile"]);
const RETIRED_SUFFIX_RE = /^\.retired\.(\d{4})\.json$/;
const FILE_CODES = Object.freeze({
  options: "invalid_work_task_pipeline_store_options",
  unreadable: "work_task_pipeline_store_unreadable",
  symlink_rejected: "work_task_pipeline_store_symlink_rejected",
  insecure_permissions: "work_task_pipeline_store_insecure_permissions",
  write_failed: "work_task_pipeline_store_write_failed",
  locked: "work_task_pipeline_store_locked",
  lock_unsafe: "work_task_pipeline_store_lock_failed",
  lock_failed: "work_task_pipeline_store_lock_failed",
  lock_acquire_changed: "work_task_pipeline_store_lock_failed",
  lock_release_changed: "work_task_pipeline_store_lock_release_failed",
  lock_release_failed: "work_task_pipeline_store_lock_release_failed",
});

class WorkTaskPipelineStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "WorkTaskPipelineStoreError";
    this.code = code;
  }
}

function fail(code, message) { throw new WorkTaskPipelineStoreError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "unknown or missing field");
  }
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function identity(value, code) {
  exact(value, ["installation_id", "project_id"], code);
  if (!INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id)) {
    fail(code, "installation or project identity is invalid");
  }
  return { installation_id: value.installation_id, project_id: value.project_id };
}
function sameIdentity(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id;
}
function expected(value, code) {
  exact(value, ["installation_id", "project_id", "manifest_digest", "pipeline_digest"], code);
  const owner = identity({ installation_id: value.installation_id, project_id: value.project_id }, code);
  if (!SHA_RE.test(value.manifest_digest) || (value.pipeline_digest !== null && !SHA_RE.test(value.pipeline_digest))) {
    fail(code, "expected state digest is invalid");
  }
  return { ...owner, manifest_digest: value.manifest_digest, pipeline_digest: value.pipeline_digest };
}
function storageDirectory(configDir) {
  if (typeof configDir !== "string" || !path.isAbsolute(configDir) || configDir.length > 1024 || /[\u0000\r\n]/.test(configDir)) {
    fail("invalid_work_task_pipeline_store_options", "config_dir must be a bounded absolute path");
  }
  return path.join(configDir, "work-task-pipelines");
}
function workTaskPipelineStorePath(configDir, owner) {
  const normalized = identity(owner, "invalid_work_task_pipeline_store_identity");
  return path.join(storageDirectory(configDir), `${normalized.installation_id}--${normalized.project_id}.json`);
}
// A retired batch keeps its full record beside the active path under an
// ordinal suffix, so provenance survives every later successor freeze.
function retiredEntries(fs, statePath) {
  const prefix = path.basename(statePath, ".json");
  let names;
  try { names = fs.readdirSync(path.dirname(statePath)); } catch { fail("work_task_pipeline_store_unreadable", "pipeline store directory cannot be listed"); }
  return names
    .filter((name) => name.startsWith(prefix) && RETIRED_SUFFIX_RE.test(name.slice(prefix.length)))
    .map((name) => ({ ordinal: Number(RETIRED_SUFFIX_RE.exec(name.slice(prefix.length))[1]), path: path.join(path.dirname(statePath), name) }))
    .sort((left, right) => left.ordinal - right.ordinal);
}
function nextRetiredPath(fs, statePath) {
  const entries = retiredEntries(fs, statePath);
  const ordinal = entries.length === 0 ? 1 : entries[entries.length - 1].ordinal + 1;
  if (ordinal > 9999) fail("work_task_pipeline_store_retired_bound", "retired batch bound reached");
  return `${statePath.slice(0, -".json".length)}.retired.${String(ordinal).padStart(4, "0")}.json`;
}
// Retirement is refused while any slot still holds build or review authority.
// #1071: the Head-control domain has to reach that same verdict before it makes
// a retirement intent durable — an intent whose recovery could never finish is
// a wedge, not a resumable retirement — so the predicate lives here, beside the
// exact states it names, instead of being restated by its caller.
function pipelineHoldsActiveAuthority(pipeline) {
  return pipeline.tasks.some((slot) => ACTIVE_AUTHORITY_STATES.has(slot.state));
}
// #1071: one retirement's own audited marker in the retired record.
//
// INVARIANT: `retire` writes exactly this entry into `terminal_audit`, durably,
// BEFORE it renames the record away — on the already-archived path too, where
// the pipeline itself does not change and no history entry is appended.  A
// retired record therefore names the retirement that ended it, not merely the
// content it held.  Content is not enough: a project archive derives its event
// from owner and manifest digest alone (server/project-archive-transition.js),
// so two same-content batches archived that way carry byte-identical pipelines
// and byte-identical pipeline digests.
//
// The existing `archive` disposition shape is reused deliberately rather than
// adding a stored `retirement` kind: a retirement IS the audited archive that
// ends that batch, the entry already carries the event id and the exact
// pipeline digest the record will keep, and a new kind would add a persisted
// schema variant that records no additional fact.  A dedicated kind would only
// be needed if a record had to distinguish an archive it survived from the
// archive that retired it — it does not, because the rename does that.
function retirementMarker(eventId, pipelineDigest) {
  return { kind: "archive", event_id: eventId, archived: true, pipeline_digest: pipelineDigest };
}
function carriesRetirementMarker(record, eventId, pipelineDigest) {
  const marker = retirementMarker(eventId, pipelineDigest);
  return record.terminal_audit.some((entry) => entry.kind === marker.kind && entry.event_id === marker.event_id &&
    entry.archived === marker.archived && entry.pipeline_digest === marker.pipeline_digest);
}
function assertTerminalDisposition(value, code) {
  if (value === null) return null;
  if (!plain(value) || !TERMINAL_KINDS.has(value.kind)) fail(code, "terminal disposition is invalid");
  if (value.kind === "archive") {
    exact(value, ["kind", "event_id", "archived"], code);
    if (typeof value.archived !== "boolean") fail(code, "archive disposition is invalid");
  } else {
    exact(value, ["kind", "event_id"], code);
  }
  if (!EVENT_ID_RE.test(value.event_id)) fail(code, "terminal disposition event is invalid");
  return clone(value);
}
function dispositionForPlan(plan) {
  switch (plan.event.kind) {
    case "set_archived": return { kind: "archive", event_id: plan.event.event_id, archived: plan.event.archived };
    case "integrated_cut": return { kind: "integrated_cut", event_id: plan.event.event_id };
    case "contract_change": return { kind: "contract_change", event_id: plan.event.event_id };
    default: return null;
  }
}
function sameDisposition(left, right) {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind || left.event_id !== right.event_id) return false;
  return left.kind !== "archive" || left.archived === right.archived;
}
function assertAuditEntry(value, code) {
  if (!plain(value)) fail(code, "terminal audit entry is invalid");
  const disposition = { ...value };
  const pipelineDigest = disposition.pipeline_digest;
  delete disposition.pipeline_digest;
  assertTerminalDisposition(disposition, code);
  if (!SHA_RE.test(pipelineDigest)) fail(code, "terminal audit digest is invalid");
  return value;
}
function assertStoredState(value) {
  exact(value, ["schema_version", "identity", "manifest", "pipeline", "terminal_audit"], "invalid_work_task_pipeline_store_state");
  if (value.schema_version !== SCHEMA_VERSION) fail("unknown_work_task_pipeline_store_schema", "pipeline store schema is unsupported");
  const owner = identity(value.identity, "invalid_work_task_pipeline_store_state");
  let manifest;
  let pipeline;
  try { assertBatchManifest(value.manifest); manifest = value.manifest; } catch { fail("invalid_work_task_pipeline_store_state", "stored manifest is invalid"); }
  try { assertWorkTaskPipeline(value.pipeline); pipeline = value.pipeline; } catch { fail("invalid_work_task_pipeline_store_state", "stored pipeline is invalid"); }
  if (!manifest.frozen || !pipeline.manifest_frozen || manifest.installation_id !== owner.installation_id || manifest.project_id !== owner.project_id || pipeline.manifest_digest !== manifest.manifest_digest) {
    fail("invalid_work_task_pipeline_store_state", "stored pipeline identity is inconsistent");
  }
  const manifestTasks = manifest.tasks.map((entry) => workTaskKey(entry.ref));
  const pipelineTasks = pipeline.tasks.map((slot) => workTaskKey(slot.work_task_ref));
  if (manifestTasks.length !== pipelineTasks.length || manifestTasks.some((key, index) => key !== pipelineTasks[index])) {
    fail("invalid_work_task_pipeline_store_state", "stored pipeline task identity is inconsistent");
  }
  for (let index = 0; index < manifest.tasks.length; index += 1) {
    const manifestDependencies = manifest.tasks[index].contract.dependencies.map(workTaskKey);
    const pipelineDependencies = pipeline.tasks[index].dependency_refs.map(workTaskKey);
    if (manifestDependencies.length !== pipelineDependencies.length || manifestDependencies.some((key, dependencyIndex) => key !== pipelineDependencies[dependencyIndex])) {
      fail("invalid_work_task_pipeline_store_state", "stored pipeline dependency identity is inconsistent");
    }
  }
  if (!Array.isArray(value.terminal_audit) || value.terminal_audit.length > MAX_TERMINAL_AUDIT) {
    fail("invalid_work_task_pipeline_store_state", "terminal audit bound is invalid");
  }
  const auditEvents = new Set();
  value.terminal_audit.forEach((entry) => {
    assertAuditEntry(entry, "invalid_work_task_pipeline_store_state");
    if (auditEvents.has(entry.event_id)) fail("invalid_work_task_pipeline_store_state", "terminal audit event is duplicated");
    auditEvents.add(entry.event_id);
  });
  return value;
}
function snapshot(state) {
  assertStoredState(state);
  return freeze(clone(state));
}
function decodeState(fs, statePath, owner, allowMissing) {
  let raw;
  let stats;
  try {
    stats = fs.lstatSync(statePath);
    if (stats.isSymbolicLink()) fail("work_task_pipeline_store_symlink_rejected", "pipeline store paths cannot be symbolic links");
    if (!stats.isFile() || modeOf(stats) !== FILE_MODE) fail("work_task_pipeline_store_insecure_permissions", "pipeline store must be a mode 0600 file");
    raw = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (error instanceof WorkTaskPipelineStoreError) throw error;
    if (error && error.code === "ENOENT") {
      if (allowMissing) return null;
      fail("work_task_pipeline_store_missing", "pipeline store is not initialized");
    }
    fail("work_task_pipeline_store_unreadable", "pipeline store cannot be read");
  }
  let value;
  try { value = JSON.parse(raw); } catch { fail("corrupt_work_task_pipeline_store", "pipeline store is corrupt"); }
  if (!plain(value) || value.schema_version !== SCHEMA_VERSION) {
    if (plain(value) && Object.prototype.hasOwnProperty.call(value, "schema_version")) fail("unknown_work_task_pipeline_store_schema", "pipeline store schema is unsupported");
    fail("corrupt_work_task_pipeline_store", "pipeline store is corrupt");
  }
  try { assertStoredState(value); } catch (error) {
    if (error instanceof WorkTaskPipelineStoreError && error.code === "unknown_work_task_pipeline_store_schema") throw error;
    fail("corrupt_work_task_pipeline_store", "pipeline store validation failed");
  }
  if (!sameIdentity(value.identity, owner)) fail("work_task_pipeline_store_identity_mismatch", "pipeline store belongs to a different project");
  return value;
}
// Fsync the containing directory so a completed retirement rename is
// recoverable across a process or machine restart. Filesystems that do not
// expose a readable directory descriptor fail closed rather than claiming it.
function fsyncDirectory(fs, directory) {
  const directoryDescriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}
function writeStateAtomically(files, statePath, state) {
  files.writeFileAtomically(statePath, `${JSON.stringify(state)}\n`);
}
function assertInitialState(input) {
  exact(input, ["expected", "manifest", "pipeline"], "invalid_work_task_pipeline_store_initialization");
  const precondition = expected(input.expected, "invalid_work_task_pipeline_store_initialization");
  if (precondition.pipeline_digest !== null) fail("invalid_work_task_pipeline_store_initialization", "initial pipeline digest must be null");
  let manifest;
  let pipeline;
  try { assertBatchManifest(input.manifest); manifest = input.manifest; } catch { fail("invalid_work_task_pipeline_store_initialization", "initial manifest is invalid"); }
  try { assertWorkTaskPipeline(input.pipeline); pipeline = input.pipeline; } catch { fail("invalid_work_task_pipeline_store_initialization", "initial pipeline is invalid"); }
  if (!manifest.frozen || !pipeline.manifest_frozen || manifest.installation_id !== precondition.installation_id || manifest.project_id !== precondition.project_id ||
      manifest.manifest_digest !== precondition.manifest_digest || pipeline.manifest_digest !== manifest.manifest_digest) {
    fail("invalid_work_task_pipeline_store_initialization", "initial pipeline identity is inconsistent");
  }
  return { precondition, manifest, pipeline };
}
function assertRetirement(input) {
  exact(input, ["expected", "event_id"], "invalid_work_task_pipeline_store_retirement");
  const precondition = expected(input.expected, "invalid_work_task_pipeline_store_retirement");
  if (precondition.pipeline_digest === null) fail("invalid_work_task_pipeline_store_retirement", "retirement requires an exact current pipeline digest");
  if (!EVENT_ID_RE.test(input.event_id)) fail("invalid_work_task_pipeline_store_retirement", "retirement event is invalid");
  return { precondition, event_id: input.event_id };
}
function assertPlanApplication(input) {
  exact(input, ["expected", "plan", "terminal_disposition"], "invalid_work_task_pipeline_store_apply");
  const precondition = expected(input.expected, "invalid_work_task_pipeline_store_apply");
  if (precondition.pipeline_digest === null) fail("invalid_work_task_pipeline_store_apply", "application requires an exact current pipeline digest");
  try { assertWorkTaskPipelinePlan(input.plan); } catch { fail("invalid_work_task_pipeline_store_apply", "pipeline plan is invalid"); }
  const disposition = assertTerminalDisposition(input.terminal_disposition, "invalid_work_task_pipeline_store_apply");
  const requiredDisposition = dispositionForPlan(input.plan);
  if (!sameDisposition(disposition, requiredDisposition)) {
    fail("work_task_pipeline_terminal_disposition_required", "archive, cut, and contract-change plans require their exact disposition");
  }
  return { precondition, plan: input.plan, disposition };
}

function createWorkTaskPipelineStore(options) {
  exact(options, ["config_dir", "fs"], "invalid_work_task_pipeline_store_options");
  const files = createDurableStoreFiles({ fs: options.fs || nodeFs, error: WorkTaskPipelineStoreError, codes: FILE_CODES });
  const fs = files.fs;
  if (typeof fs.readdirSync !== "function") fail("invalid_work_task_pipeline_store_options", "fs.readdirSync is required");
  const directory = storageDirectory(options.config_dir);
  const directories = [{ path: options.config_dir }, { path: directory, mode: DIRECTORY_MODE }];

  function statePath(owner) {
    return workTaskPipelineStorePath(options.config_dir, {
      installation_id: owner.installation_id,
      project_id: owner.project_id,
    });
  }
  function readRecoverySnapshot(owner) {
    const normalized = identity(owner, "invalid_work_task_pipeline_store_identity");
    if (!files.storageExists(directories)) fail("work_task_pipeline_store_missing", "pipeline store is not initialized");
    return snapshot(decodeState(fs, statePath(normalized), normalized, false));
  }
  function initialize(input) {
    const initial = assertInitialState(input);
    const target = statePath(initial.precondition);
    files.ensureDirectories(directories);
    return files.withWriterLock(target, () => {
      const existing = decodeState(fs, target, initial.precondition, true);
      if (existing !== null) fail("work_task_pipeline_store_already_initialized", "pipeline store already exists");
      const state = {
        schema_version: SCHEMA_VERSION,
        identity: { installation_id: initial.precondition.installation_id, project_id: initial.precondition.project_id },
        manifest: clone(initial.manifest),
        pipeline: clone(initial.pipeline),
        terminal_audit: [],
      };
      assertStoredState(state);
      writeStateAtomically(files, target, state);
      return snapshot(state);
    });
  }
  function applyPlan(input) {
    const application = assertPlanApplication(input);
    const target = statePath(application.precondition);
    if (!files.storageExists(directories)) {
      fail("work_task_pipeline_store_missing", "pipeline store is not initialized");
    }
    return files.withWriterLock(target, () => {
      const current = readCurrent(target, application.precondition);
      let nextPipeline;
      try { nextPipeline = applyWorkTaskPipelinePlan(current.pipeline, application.plan); } catch {
        fail("stale_or_invalid_work_task_pipeline_store_plan", "stored pipeline no longer accepts this plan");
      }
      return snapshot(commit(target, current, nextPipeline, application.disposition));
    });
  }
  function readCurrent(target, precondition) {
    const current = decodeState(fs, target, precondition, false);
    if (current.identity.installation_id !== precondition.installation_id || current.identity.project_id !== precondition.project_id ||
        current.manifest.manifest_digest !== precondition.manifest_digest || current.pipeline.pipeline_digest !== precondition.pipeline_digest) {
      fail("stale_work_task_pipeline_store_precondition", "stored pipeline changed before plan application");
    }
    return current;
  }
  function commit(target, current, nextPipeline, disposition) {
    const terminalAudit = disposition === null ? current.terminal_audit : [
      ...current.terminal_audit,
      { ...disposition, pipeline_digest: nextPipeline.pipeline_digest },
    ].slice(-MAX_TERMINAL_AUDIT);
    const next = {
      schema_version: SCHEMA_VERSION,
      identity: clone(current.identity),
      // The manifest is frozen, validated, and retained byte-for-value
      // across archive, cut, and contract-change pipeline transitions.
      manifest: clone(current.manifest),
      pipeline: clone(nextPipeline),
      terminal_audit: clone(terminalAudit),
    };
    assertStoredState(next);
    writeStateAtomically(files, target, next);
    return next;
  }
  // Retirement is the explicit, durable end of one batch: the pipeline takes
  // its audited `set_archived` transition and the whole record moves to a
  // retired path.  Nothing is overwritten, the active path becomes free for a
  // successor manifest, and a crash between the two steps resumes by retrying
  // the already-archived record.
  function retire(input) {
    const retirement = assertRetirement(input);
    const target = statePath(retirement.precondition);
    if (!files.storageExists(directories)) {
      fail("work_task_pipeline_store_missing", "pipeline store is not initialized");
    }
    return files.withWriterLock(target, () => {
      const current = readCurrent(target, retirement.precondition);
      let state = current;
      if (!current.pipeline.archived) {
        if (pipelineHoldsActiveAuthority(current.pipeline)) {
          fail("work_task_pipeline_store_batch_active", "batch retains active build or review authority");
        }
        let nextPipeline;
        try {
          const plan = planWorkTaskPipelineEvent(current.pipeline, { version: 1, kind: "set_archived", event_id: retirement.event_id, archived: true });
          nextPipeline = applyWorkTaskPipelinePlan(current.pipeline, plan);
        } catch {
          fail("stale_or_invalid_work_task_pipeline_store_plan", "stored pipeline no longer accepts the archive transition");
        }
        state = commit(target, current, nextPipeline, { kind: "archive", event_id: retirement.event_id, archived: true });
      } else if (!carriesRetirementMarker(current, retirement.event_id, current.pipeline.pipeline_digest)) {
        // Already archived by an earlier transition: the pipeline takes no
        // second archive event, but this retirement still records its own
        // marker durably before the rename.  Replay finds the marker already
        // there and writes nothing — a duplicate event id is rejected outright
        // by `assertStoredState`, so skipping is the only correct resume.
        state = commit(target, current, current.pipeline, { kind: "archive", event_id: retirement.event_id, archived: true });
      }
      const retiredPath = nextRetiredPath(fs, target);
      try {
        fs.renameSync(target, retiredPath);
        fsyncDirectory(fs, path.dirname(target));
      } catch { fail("work_task_pipeline_store_write_failed", "pipeline store retirement rename failed"); }
      return snapshot(state);
    });
  }
  function readRetiredSnapshots(owner) {
    const normalized = identity(owner, "invalid_work_task_pipeline_store_identity");
    if (!files.storageExists(directories)) fail("work_task_pipeline_store_missing", "pipeline store is not initialized");
    return freeze(retiredEntries(fs, statePath(normalized)).map((entry) => snapshot(decodeState(fs, entry.path, normalized, false))));
  }

  return freeze({
    readRecoverySnapshot,
    readRetiredSnapshots,
    initialize,
    applyPlan,
    retire,
  });
}

module.exports = {
  SCHEMA_VERSION,
  FILE_MODE,
  DIRECTORY_MODE,
  MAX_TERMINAL_AUDIT,
  WorkTaskPipelineStoreError,
  assertWorkTaskPipelineStoreState: assertStoredState,
  workTaskPipelineHoldsActiveAuthority: pipelineHoldsActiveAuthority,
  workTaskPipelineStoreCarriesRetirementMarker: carriesRetirementMarker,
  workTaskPipelineStorePath,
  createWorkTaskPipelineStore,
};
