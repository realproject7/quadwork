"use strict";

// #1044 M4: the one durable WorkTask domain behind the fixed Head-control
// plane.  This module owns no transport, route, dispatch, Git, delivery, or
// audit authority.  Its only public command surface is the plane's four
// static callbacks.  Unlike the redacted audit store, its private state keeps
// the exact manifest / cut intent needed to recover an interrupted mutation.

const crypto = require("node:crypto");
const path = require("node:path");
const {
  assertBatchManifest,
  freezeBatchManifest,
  assertManifestRegisteredCurrent,
} = require("./work-task-manifest");
const {
  assertWorkTaskPipeline,
  buildWorkTaskPipeline,
  planWorkTaskPipelineEvent,
  applyWorkTaskPipelinePlan,
} = require("./work-task-pipeline");
const {
  WorkTaskPipelineStoreError,
  createWorkTaskPipelineStore,
} = require("./work-task-pipeline-store");

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(["get_pipeline_status", "put_batch_manifest", "freeze_batch_manifest", "cut_batch"]);

class HeadControlWorkTaskDomainError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "HeadControlWorkTaskDomainError";
    this.code = code;
  }
}

function fail(code, message) { throw new HeadControlWorkTaskDomainError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has unknown or missing fields");
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
function stable(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_head_control_work_task_input", "non-finite value is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  fail("invalid_head_control_work_task_input", "unsupported value is invalid");
}
function same(left, right) { return stable(left) === stable(right); }
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function assertBoundedPayload(value) {
  if (Buffer.byteLength(stable(value), "utf8") > MAX_PAYLOAD_BYTES) {
    fail("invalid_head_control_work_task_input", "payload exceeds the fixed Head-control bound");
  }
}
function revision(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail(code, "revision is invalid");
  return value;
}
function digest(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "digest is invalid");
  return value;
}
function identifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail(code, "identifier is invalid");
  return value;
}
function binding(value, code) {
  exact(value, ["installation_id", "project_id", "role", "generation"], code);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) ||
      value.role !== "head" || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    fail(code, "Head binding is invalid");
  }
  return {
    installation_id: value.installation_id,
    project_id: value.project_id,
    role: "head",
    generation: value.generation,
  };
}
function sameBinding(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id &&
    left.role === right.role && left.generation === right.generation;
}
function ownerOf(bindingValue) {
  return { installation_id: bindingValue.installation_id, project_id: bindingValue.project_id };
}
function assertFs(fs) {
  for (const name of ["mkdirSync", "lstatSync", "fstatSync", "readFileSync", "writeFileSync", "renameSync", "chmodSync", "openSync", "closeSync", "fsyncSync", "unlinkSync"]) {
    if (!fs || typeof fs[name] !== "function") fail("invalid_head_control_work_task_domain_options", `fs.${name} is required`);
  }
  return fs;
}
function storageDirectory(configDir) {
  if (typeof configDir !== "string" || !path.isAbsolute(configDir) || configDir.length > 1024 || /[\u0000\r\n]/.test(configDir)) {
    fail("invalid_head_control_work_task_domain_options", "config_dir is invalid");
  }
  return path.join(configDir, "head-control-work-task-domain");
}
function headControlWorkTaskDomainPath(configDir, bindingValue) {
  const owner = binding(bindingValue, "invalid_head_control_work_task_domain_identity");
  return path.join(storageDirectory(configDir), `${owner.installation_id}--${owner.project_id}.json`);
}
function modeOf(stats) { return stats.mode & 0o777; }
function lstatOrNull(fs, target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error && error.code === "ENOENT") return null;
    fail("head_control_work_task_state_unreadable", "domain state cannot be statted");
  }
}
function sameFile(left, right) {
  return left && right && Number.isSafeInteger(left.dev) && Number.isSafeInteger(left.ino) && left.dev === right.dev && left.ino === right.ino;
}
function assertDirectory(fs, target, requiredMode) {
  const stats = lstatOrNull(fs, target);
  if (stats === null) return null;
  if (stats.isSymbolicLink()) fail("head_control_work_task_state_symlink_rejected", "domain storage path cannot be a symlink");
  if (!stats.isDirectory()) fail("head_control_work_task_state_unreadable", "domain storage path is not a directory");
  if (requiredMode !== undefined && modeOf(stats) !== requiredMode) {
    fail("head_control_work_task_state_insecure_permissions", "domain storage directory must be mode 0700");
  }
  return stats;
}
function ensureDirectories(fs, configDir, directory) {
  if (assertDirectory(fs, configDir, DIRECTORY_MODE) === null) {
    fs.mkdirSync(configDir, { recursive: true, mode: DIRECTORY_MODE });
    if (assertDirectory(fs, configDir, DIRECTORY_MODE) === null) fail("head_control_work_task_state_unreadable", "domain config directory cannot be created");
  }
  if (assertDirectory(fs, directory, DIRECTORY_MODE) === null) {
    fs.mkdirSync(directory, { recursive: false, mode: DIRECTORY_MODE });
    if (assertDirectory(fs, directory, DIRECTORY_MODE) === null) fail("head_control_work_task_state_unreadable", "domain storage directory cannot be created");
  }
}

function assertInvocation(value, expectedAction, owner) {
  exact(value, ["version", "action", "binding", "expected_revision", "correlation_id", "idempotency_key", "payload"], "invalid_head_control_work_task_input");
  if (value.version !== 1 || value.action !== expectedAction || !ACTIONS.has(value.action)) {
    fail("invalid_head_control_work_task_input", "domain action is invalid");
  }
  const actualBinding = binding(value.binding, "invalid_head_control_work_task_input");
  if (!sameBinding(actualBinding, owner)) fail("head_control_work_task_binding_denied", "domain binding is not owned by this Head");
  const nullable = expectedAction === "get_pipeline_status";
  if (nullable ? value.expected_revision !== null : !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) {
    fail("invalid_head_control_work_task_input", "optimistic revision is invalid");
  }
  if (!nullable) revision(value.expected_revision, "invalid_head_control_work_task_input");
  identifier(value.correlation_id, "invalid_head_control_work_task_input");
  identifier(value.idempotency_key, "invalid_head_control_work_task_input");
  if (expectedAction === "get_pipeline_status" || expectedAction === "freeze_batch_manifest") {
    if (value.payload !== null) fail("invalid_head_control_work_task_input", "action does not accept payload");
  } else if (expectedAction === "put_batch_manifest") {
    exact(value.payload, ["manifest"], "invalid_head_control_work_task_input");
    if (!plain(value.payload.manifest)) fail("invalid_head_control_work_task_input", "manifest payload is invalid");
    assertBoundedPayload(value.payload.manifest);
  } else {
    exact(value.payload, ["cut"], "invalid_head_control_work_task_input");
    exact(value.payload.cut, ["tasks"], "invalid_head_control_work_task_input");
    if (!Array.isArray(value.payload.cut.tasks) || value.payload.cut.tasks.length === 0 || value.payload.cut.tasks.length > 64 || !value.payload.cut.tasks.every(plain)) {
      fail("invalid_head_control_work_task_input", "cut payload is invalid");
    }
    assertBoundedPayload(value.payload.cut);
  }
  return freeze(clone(value));
}
function assertStatusInvocation(value, owner) {
  if (!plain(value) || typeof value.action !== "string" || !ACTIONS.has(value.action)) {
    fail("invalid_head_control_work_task_input", "status invocation action is invalid");
  }
  // The plane reads status through this callback before every fixed mutation,
  // so the invocation keeps the requested action rather than being rewritten
  // to get_pipeline_status. Validate that exact original shape fail-closed.
  return assertInvocation(value, value.action, owner);
}
function invocationFingerprint(input) {
  return hash({
    action: input.action,
    binding: input.binding,
    expected_revision: input.expected_revision,
    correlation_id: input.correlation_id,
    idempotency_key: input.idempotency_key,
    payload: input.payload,
  });
}
function exactManifest(value, owner, code) {
  try { assertBatchManifest(value); } catch { fail(code, "manifest is invalid"); }
  if (value.installation_id !== owner.installation_id || value.project_id !== owner.project_id) {
    fail(code, "manifest belongs to another project");
  }
  return clone(value);
}
function assertCurrentManifest(manifest, resolver) {
  try { assertManifestRegisteredCurrent(manifest, { resolveRegisteredIdentity: resolver }); }
  catch { fail("head_control_work_task_manifest_stale", "registered WorkTask identity is stale or unavailable"); }
}
function pipelineSnapshot(value, owner, expectedManifest) {
  try {
    if (!plain(value) || !plain(value.identity) || value.identity.installation_id !== owner.installation_id || value.identity.project_id !== owner.project_id) {
      fail("head_control_work_task_pipeline_foreign", "pipeline snapshot belongs to another project");
    }
    assertBatchManifest(value.manifest);
    assertWorkTaskPipeline(value.pipeline);
    if (!value.manifest.frozen || !value.pipeline.manifest_frozen || value.manifest.manifest_digest !== expectedManifest.manifest_digest ||
        !same(value.manifest, expectedManifest) || value.pipeline.manifest_digest !== expectedManifest.manifest_digest) {
      fail("head_control_work_task_pipeline_stale", "pipeline snapshot no longer matches the frozen manifest");
    }
    return freeze(clone(value));
  } catch (error) {
    if (error instanceof HeadControlWorkTaskDomainError) throw error;
    fail("head_control_work_task_pipeline_corrupt", "pipeline snapshot is invalid");
  }
}
function statusFor(state, snapshot) {
  if (state.stage === "empty") {
    return freeze({ revision: state.revision, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  }
  if (state.stage === "manifest") {
    return freeze({ revision: state.revision, archived: false, manifest_digest: state.manifest.manifest_digest, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  }
  const pipeline = snapshot.pipeline;
  const archived = pipeline.archived;
  return freeze({
    revision: state.revision,
    archived,
    manifest_digest: state.manifest.manifest_digest,
    pipeline_digest: pipeline.pipeline_digest,
    manifest_frozen: true,
    // The pure integrated-cut planner remains the exact authority.  This is
    // only the conservative plane preflight: no accepted candidate, no cut.
    cut_safe: !archived && pipeline.tasks.some((slot) => slot.state === "accepted"),
  });
}

function pending(value, state, owner, code) {
  if (value === null) return null;
  if (!plain(value) || (value.action !== "freeze_batch_manifest" && value.action !== "cut_batch")) fail(code, "pending action is invalid");
  if (value.action === "freeze_batch_manifest") {
    exact(value, ["action", "expected_revision", "fingerprint", "frozen_manifest"], code);
    if (state.stage !== "manifest" || revision(value.expected_revision, code) !== state.revision || !SHA_RE.test(value.fingerprint)) fail(code, "pending freeze precondition is invalid");
    const frozen = exactManifest(value.frozen_manifest, owner, code);
    if (!frozen.frozen || frozen.manifest_digest !== state.manifest.manifest_digest) fail(code, "pending freeze manifest is invalid");
    return { action: value.action, expected_revision: value.expected_revision, fingerprint: value.fingerprint, frozen_manifest: frozen };
  }
  exact(value, ["action", "expected_revision", "fingerprint", "event", "expected_pipeline_digest", "next_pipeline_digest"], code);
  if (state.stage !== "frozen" || revision(value.expected_revision, code) !== state.revision || !SHA_RE.test(value.fingerprint) ||
      !SHA_RE.test(value.expected_pipeline_digest) || !SHA_RE.test(value.next_pipeline_digest) || value.expected_pipeline_digest !== state.pipeline_digest) {
    fail(code, "pending cut precondition is invalid");
  }
  exact(value.event, ["version", "kind", "event_id", "tasks"], code);
  if (value.event.version !== 1 || value.event.kind !== "integrated_cut" || !IDENTIFIER_RE.test(value.event.event_id) ||
      !Array.isArray(value.event.tasks) || value.event.tasks.length === 0 || value.event.tasks.length > 64 || !value.event.tasks.every(plain)) {
    fail(code, "pending cut event is invalid");
  }
  return {
    action: value.action,
    expected_revision: value.expected_revision,
    fingerprint: value.fingerprint,
    event: clone(value.event),
    expected_pipeline_digest: value.expected_pipeline_digest,
    next_pipeline_digest: value.next_pipeline_digest,
  };
}
function assertState(value, owner) {
  exact(value, ["schema_version", "binding", "revision", "stage", "manifest", "pipeline_digest", "pending"], "invalid_head_control_work_task_state");
  if (value.schema_version !== SCHEMA_VERSION) fail("unknown_head_control_work_task_state_schema", "domain state schema is unsupported");
  const storedBinding = binding(value.binding, "invalid_head_control_work_task_state");
  if (!sameBinding(storedBinding, owner)) fail("head_control_work_task_state_identity_mismatch", "domain state belongs to another Head generation");
  const state = {
    schema_version: SCHEMA_VERSION,
    binding: storedBinding,
    revision: revision(value.revision, "invalid_head_control_work_task_state"),
    stage: value.stage,
    manifest: value.manifest === null ? null : exactManifest(value.manifest, owner, "invalid_head_control_work_task_state"),
    pipeline_digest: digest(value.pipeline_digest, "invalid_head_control_work_task_state", true),
    pending: null,
  };
  if (!new Set(["empty", "manifest", "frozen"]).has(state.stage)) fail("invalid_head_control_work_task_state", "domain stage is invalid");
  if (state.stage === "empty" && (state.revision !== 0 || state.manifest !== null || state.pipeline_digest !== null || value.pending !== null)) {
    fail("invalid_head_control_work_task_state", "empty state is inconsistent");
  }
  if (state.stage === "manifest" && (state.revision < 1 || state.manifest === null || state.manifest.frozen !== null || state.pipeline_digest !== null)) {
    fail("invalid_head_control_work_task_state", "unfrozen manifest state is inconsistent");
  }
  if (state.stage === "frozen" && (state.revision < 2 || state.manifest === null || !state.manifest.frozen || state.pipeline_digest === null)) {
    fail("invalid_head_control_work_task_state", "frozen state is inconsistent");
  }
  state.pending = pending(value.pending, state, owner, "invalid_head_control_work_task_state");
  return state;
}
function snapshot(state, owner) { return freeze(clone(assertState(state, owner))); }

function readState(fs, statePath, owner, allowMissing) {
  let raw;
  try {
    const stats = fs.lstatSync(statePath);
    if (stats.isSymbolicLink()) fail("head_control_work_task_state_symlink_rejected", "domain state file cannot be a symlink");
    if (!stats.isFile() || modeOf(stats) !== FILE_MODE) fail("head_control_work_task_state_insecure_permissions", "domain state file must be mode 0600");
    const descriptor = fs.openSync(statePath, "r");
    try {
      const opened = fs.fstatSync(descriptor);
      if (!sameFile(stats, opened) || !opened.isFile() || modeOf(opened) !== FILE_MODE) {
        fail("head_control_work_task_state_unreadable", "domain state changed during secure read");
      }
      raw = fs.readFileSync(descriptor, "utf8");
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error instanceof HeadControlWorkTaskDomainError) throw error;
    if (error && error.code === "ENOENT") {
      if (allowMissing) return null;
      fail("head_control_work_task_state_missing", "domain state is not initialized");
    }
    fail("head_control_work_task_state_unreadable", "domain state cannot be read");
  }
  let decoded;
  try { decoded = JSON.parse(raw); } catch { fail("corrupt_head_control_work_task_state", "domain state JSON is corrupt"); }
  try { return assertState(decoded, owner); }
  catch (error) {
    if (error instanceof HeadControlWorkTaskDomainError &&
        (error.code === "unknown_head_control_work_task_state_schema" || error.code === "head_control_work_task_state_identity_mismatch")) throw error;
    fail("corrupt_head_control_work_task_state", "domain state validation failed");
  }
}
function temporaryPath(statePath) { return `${statePath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`; }
function writeState(fs, statePath, state, owner) {
  const checked = assertState(state, owner);
  const temporary = temporaryPath(statePath);
  let written = false;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(checked)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    written = true;
    fs.chmodSync(temporary, FILE_MODE);
    const descriptor = fs.openSync(temporary, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, statePath);
    written = false;
    const directoryDescriptor = fs.openSync(path.dirname(statePath), "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    const finalStats = fs.lstatSync(statePath);
    if (finalStats.isSymbolicLink() || !finalStats.isFile() || modeOf(finalStats) !== FILE_MODE) {
      fail("head_control_work_task_state_write_failed", "domain state write did not produce a secure file");
    }
  } catch (error) {
    if (written) { try { fs.unlinkSync(temporary); } catch { /* own temporary only */ } }
    if (error instanceof HeadControlWorkTaskDomainError) throw error;
    fail("head_control_work_task_state_write_failed", "domain state cannot be atomically written");
  }
}
function lockStats(fs, target) {
  const stats = lstatOrNull(fs, target);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== FILE_MODE) fail("head_control_work_task_state_lock_failed", "domain state lock is unsafe");
  return stats;
}
function withWriterLock(fs, statePath, action) {
  const lockPath = `${statePath}.lock`;
  let descriptor, own;
  try { descriptor = fs.openSync(lockPath, "wx", FILE_MODE); }
  catch (error) {
    if (error && error.code === "EEXIST") { lockStats(fs, lockPath); fail("head_control_work_task_state_locked", "domain state has an active or stale lock"); }
    fail("head_control_work_task_state_lock_failed", "domain state lock cannot be acquired");
  }
  try {
    fs.chmodSync(lockPath, FILE_MODE); fs.fsyncSync(descriptor); own = fs.fstatSync(descriptor);
    if (!sameFile(own, lockStats(fs, lockPath))) fail("head_control_work_task_state_lock_failed", "domain state lock changed during acquisition");
    return action();
  } catch (error) {
    throw error;
  } finally {
    let releaseError = null;
    try { fs.closeSync(descriptor); } catch { releaseError = new HeadControlWorkTaskDomainError("head_control_work_task_state_lock_release_failed"); }
    try {
      if (!sameFile(own, lockStats(fs, lockPath))) fail("head_control_work_task_state_lock_release_failed", "domain state lock changed before release");
      fs.unlinkSync(lockPath);
    } catch (error) { releaseError = error instanceof HeadControlWorkTaskDomainError ? error : new HeadControlWorkTaskDomainError("head_control_work_task_state_lock_release_failed"); }
    if (releaseError) throw releaseError;
  }
}

function createHeadControlWorkTaskDomain(options) {
  exact(options, ["binding", "config_dir", "fs", "resolve_registered_identity", "now"], "invalid_head_control_work_task_domain_options");
  const owner = binding(options.binding, "invalid_head_control_work_task_domain_options");
  const fs = assertFs(options.fs);
  if (typeof options.resolve_registered_identity !== "function" || typeof options.now !== "function") {
    fail("invalid_head_control_work_task_domain_options", "registered identity and clock accessors are required");
  }
  const directory = storageDirectory(options.config_dir);
  const statePath = headControlWorkTaskDomainPath(options.config_dir, owner);
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: options.config_dir, fs });

  function emptyState() {
    return { schema_version: SCHEMA_VERSION, binding: clone(owner), revision: 0, stage: "empty", manifest: null, pipeline_digest: null, pending: null };
  }
  function currentState() { return readState(fs, statePath, owner, false); }
  function readPipeline(manifest) {
    let stored;
    try { stored = pipelineStore.readRecoverySnapshot(ownerOf(owner)); }
    catch (error) {
      if (error instanceof WorkTaskPipelineStoreError) fail("head_control_work_task_pipeline_unavailable", "pipeline state cannot be recovered");
      throw error;
    }
    return pipelineSnapshot(stored, owner, manifest);
  }
  function initializePipeline(manifest, pipeline) {
    try { return pipelineSnapshot(pipelineStore.initialize({
      expected: { installation_id: owner.installation_id, project_id: owner.project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null },
      manifest,
      pipeline,
    }), owner, manifest); }
    catch (error) {
      if (error instanceof WorkTaskPipelineStoreError) fail("head_control_work_task_pipeline_unavailable", "pipeline state cannot be initialized");
      throw error;
    }
  }
  function applyCut(snapshotValue, event) {
    let plan;
    try { plan = planWorkTaskPipelineEvent(snapshotValue.pipeline, event); }
    catch { fail("head_control_work_task_cut_invalid", "cut does not match the current WorkTask pipeline"); }
    let applied;
    try {
      applied = pipelineStore.applyPlan({
        expected: {
          installation_id: owner.installation_id,
          project_id: owner.project_id,
          manifest_digest: snapshotValue.manifest.manifest_digest,
          pipeline_digest: snapshotValue.pipeline.pipeline_digest,
        },
        plan,
        terminal_disposition: { kind: "integrated_cut", event_id: event.event_id },
      });
    } catch (error) {
      if (error instanceof WorkTaskPipelineStoreError) fail("head_control_work_task_pipeline_unavailable", "cut pipeline write was rejected");
      throw error;
    }
    return pipelineSnapshot(applied, owner, snapshotValue.manifest);
  }
  function finalizePending(state, pipeline) {
    const next = clone(state);
    next.revision += 1;
    next.stage = "frozen";
    next.manifest = clone(pipeline.manifest);
    next.pipeline_digest = pipeline.pipeline.pipeline_digest;
    next.pending = null;
    writeState(fs, statePath, next, owner);
    return snapshot(next, owner);
  }
  // A pending intent was atomically committed before its second durable write.
  // It can be resumed only from its private exact manifest/cut record, never
  // from a redacted Head-control audit receipt.
  function recoverPending() {
    // Before explicit initialization there may not even be a parent directory
    // in which a writer lock could safely exist.  Report missing state rather
    // than manufacturing a lock path or treating it as a blank controller.
    if (lstatOrNull(fs, statePath) === null) currentState();
    return withWriterLock(fs, statePath, () => {
      const state = currentState();
      if (state.pending === null) return snapshot(state, owner);
      if (state.pending.action === "freeze_batch_manifest") {
        assertCurrentManifest(state.manifest, options.resolve_registered_identity);
        const frozenManifest = state.pending.frozen_manifest;
        let recovered;
        try { recovered = readPipeline(frozenManifest); }
        catch (error) {
          if (!(error instanceof HeadControlWorkTaskDomainError) || error.code !== "head_control_work_task_pipeline_unavailable") throw error;
          let initial;
          try { initial = buildWorkTaskPipeline(frozenManifest); }
          catch { fail("head_control_work_task_pipeline_corrupt", "frozen WorkTask manifest cannot build a pipeline"); }
          recovered = initializePipeline(frozenManifest, initial);
        }
        let initial;
        try { initial = buildWorkTaskPipeline(frozenManifest); }
        catch { fail("head_control_work_task_pipeline_corrupt", "frozen WorkTask manifest cannot build a pipeline"); }
        if (!same(recovered.manifest, frozenManifest) || recovered.pipeline.pipeline_digest !== initial.pipeline_digest || recovered.pipeline.archived) {
          fail("head_control_work_task_pipeline_stale", "freeze recovery found a changed pipeline");
        }
        return finalizePending(state, recovered);
      }
      const recovered = readPipeline(state.manifest);
      const intent = state.pending;
      if (recovered.pipeline.pipeline_digest === intent.expected_pipeline_digest) {
        const applied = applyCut(recovered, intent.event);
        if (applied.pipeline.pipeline_digest !== intent.next_pipeline_digest) {
          fail("head_control_work_task_pipeline_stale", "cut recovery produced an unexpected pipeline");
        }
        return finalizePending(state, applied);
      }
      const matchingEvent = recovered.pipeline.history.find((entry) => entry.event_id === intent.event.event_id && entry.kind === "integrated_cut");
      if (recovered.pipeline.pipeline_digest !== intent.next_pipeline_digest || !matchingEvent || recovered.pipeline.archived) {
        fail("head_control_work_task_pipeline_stale", "cut recovery found a changed or foreign pipeline");
      }
      return finalizePending(state, recovered);
    });
  }
  function synchronizeFrozen() {
    return withWriterLock(fs, statePath, () => {
      const state = currentState();
      if (state.pending !== null) fail("head_control_work_task_pending_recovery_required", "pending domain write was not recovered");
      if (state.stage !== "frozen") return { state: snapshot(state, owner), pipeline: null };
      const stored = readPipeline(state.manifest);
      if (stored.pipeline.pipeline_digest === state.pipeline_digest) return { state: snapshot(state, owner), pipeline: stored };
      const next = clone(state);
      next.revision += 1;
      next.pipeline_digest = stored.pipeline.pipeline_digest;
      writeState(fs, statePath, next, owner);
      return { state: snapshot(next, owner), pipeline: stored };
    });
  }
  function prepared() {
    recoverPending();
    return synchronizeFrozen();
  }
  function assertMutationState(state, input, allowedStage) {
    if (state.pending !== null) fail("head_control_work_task_pending_recovery_required", "pending domain write was not recovered");
    if (state.revision !== input.expected_revision) fail("head_control_work_task_stale_revision", "domain revision is stale");
    if (state.stage !== allowedStage) fail("head_control_work_task_invalid_transition", "domain action is not valid in this state");
  }
  function initialize() {
    ensureDirectories(fs, options.config_dir, directory);
    return withWriterLock(fs, statePath, () => {
      const existing = readState(fs, statePath, owner, true);
      if (existing !== null) return snapshot(existing, owner);
      // `readPipeline` requires a real manifest; probe the underlying durable
      // store directly so a missing store is the sole bootstrap condition.
      try {
        pipelineStore.readRecoverySnapshot(ownerOf(owner));
        fail("head_control_work_task_state_missing", "pipeline exists without its Head-control domain state");
      } catch (error) {
        if (error instanceof HeadControlWorkTaskDomainError) throw error;
        if (!(error instanceof WorkTaskPipelineStoreError) || error.code !== "work_task_pipeline_store_missing") {
          fail("head_control_work_task_pipeline_unavailable", "pipeline store cannot be checked for bootstrap");
        }
      }
      const state = emptyState();
      writeState(fs, statePath, state, owner);
      return snapshot(state, owner);
    });
  }
  function get_pipeline_status(command) {
    assertStatusInvocation(command, owner);
    const current = prepared();
    return statusFor(current.state, current.pipeline);
  }
  function put_batch_manifest(command) {
    const input = assertInvocation(command, "put_batch_manifest", owner);
    prepared();
    return withWriterLock(fs, statePath, () => {
      const state = currentState();
      assertMutationState(state, input, "empty");
      const manifest = exactManifest(input.payload.manifest, owner, "head_control_work_task_manifest_invalid");
      if (manifest.frozen !== null) fail("head_control_work_task_manifest_invalid", "put accepts only an unfrozen manifest");
      assertCurrentManifest(manifest, options.resolve_registered_identity);
      const next = clone(state);
      next.revision += 1;
      next.stage = "manifest";
      next.manifest = manifest;
      writeState(fs, statePath, next, owner);
      return statusFor(next, null);
    });
  }
  function freeze_batch_manifest(command) {
    const input = assertInvocation(command, "freeze_batch_manifest", owner);
    prepared();
    withWriterLock(fs, statePath, () => {
      const state = currentState();
      assertMutationState(state, input, "manifest");
      assertCurrentManifest(state.manifest, options.resolve_registered_identity);
      let at;
      try { at = options.now(); } catch { fail("head_control_work_task_clock_unavailable", "freeze clock is unavailable"); }
      let frozenManifest;
      try { frozenManifest = freezeBatchManifest(state.manifest, at); }
      catch { fail("head_control_work_task_manifest_invalid", "freeze timestamp or manifest is invalid"); }
      const next = clone(state);
      next.pending = {
        action: "freeze_batch_manifest",
        expected_revision: state.revision,
        fingerprint: invocationFingerprint(input),
        frozen_manifest: clone(frozenManifest),
      };
      writeState(fs, statePath, next, owner);
    });
    const state = recoverPending();
    const pipeline = readPipeline(state.manifest);
    return statusFor(state, pipeline);
  }
  function cut_batch(command) {
    const input = assertInvocation(command, "cut_batch", owner);
    const current = prepared();
    if (current.state.stage !== "frozen" || current.pipeline === null || current.pipeline.pipeline.archived) {
      fail("head_control_work_task_archived", "cut is unavailable for archived or non-frozen state");
    }
    withWriterLock(fs, statePath, () => {
      const state = currentState();
      assertMutationState(state, input, "frozen");
      assertCurrentManifest(state.manifest, options.resolve_registered_identity);
      const stored = readPipeline(state.manifest);
      if (stored.pipeline.pipeline_digest !== state.pipeline_digest || stored.pipeline.archived) {
        fail("head_control_work_task_pipeline_stale", "pipeline changed before cut preparation");
      }
      const event = {
        version: 1,
        kind: "integrated_cut",
        event_id: `hcut_${hash({ binding: owner, correlation_id: input.correlation_id, idempotency_key: input.idempotency_key, payload: input.payload }).slice(0, 64)}`,
        tasks: clone(input.payload.cut.tasks),
      };
      let plan;
      try { plan = planWorkTaskPipelineEvent(stored.pipeline, event); }
      catch { fail("head_control_work_task_cut_invalid", "cut does not match exact staged WorkTask candidates"); }
      const nextPipeline = (() => {
        try {
          // The pipeline module has no hidden state: this dry application is
          // used only to pin the durable recovery digest before the store CAS.
          return applyWorkTaskPipelinePlan(stored.pipeline, plan);
        } catch { fail("head_control_work_task_cut_invalid", "cut plan cannot be applied to the current pipeline"); }
      })();
      const next = clone(state);
      next.pending = {
        action: "cut_batch",
        expected_revision: state.revision,
        fingerprint: invocationFingerprint(input),
        event,
        expected_pipeline_digest: stored.pipeline.pipeline_digest,
        next_pipeline_digest: nextPipeline.pipeline_digest,
      };
      writeState(fs, statePath, next, owner);
    });
    const state = recoverPending();
    const pipeline = readPipeline(state.manifest);
    return statusFor(state, pipeline);
  }

  // `initialize` is deliberately non-enumerable.  The existing plane exacts
  // its domain object to these four fixed callbacks, while runtime startup
  // still has an explicit durable bootstrap with no fifth control action.
  const domain = { get_pipeline_status, put_batch_manifest, freeze_batch_manifest, cut_batch };
  Object.defineProperty(domain, "initialize", { value: initialize, enumerable: false });
  return freeze(domain);
}

module.exports = {
  SCHEMA_VERSION,
  FILE_MODE,
  DIRECTORY_MODE,
  HeadControlWorkTaskDomainError,
  headControlWorkTaskDomainPath,
  createHeadControlWorkTaskDomain,
};
