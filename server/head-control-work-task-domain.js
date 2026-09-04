"use strict";

// #1044 M4: the one durable WorkTask domain behind the fixed Head-control
// plane.  This module owns no transport, route, dispatch, Git, delivery, or
// audit authority.  Its only public command surface is the plane's fixed
// static callbacks.  Unlike the redacted audit store, its private state keeps
// the exact manifest / cut intent needed to recover an interrupted mutation.
// #1058: the batch lifecycle closes with `retire_batch`, and the released
// correction route plus the Head-private propagation-stop read reach their
// owning review service only through this bound domain.
// #1069: `abandon_batch_manifest` is the one exit for a manifest that was put
// but never frozen; it is refused the moment a freeze intent or a pipeline
// exists and never touches frozen, cut, or retired records.
// #1071: `retire_batch` is likewise two-phase.  Its intent is durable before
// the store retirement and names that one transition exactly, and recovery
// finishes only the transition the intent names.  A missing active pipeline
// with no such intent is a fact this domain cannot explain, so it fails closed
// rather than matching a retired record by content.

const crypto = require("node:crypto");
const path = require("node:path");
const {
  FILE_MODE,
  DIRECTORY_MODE,
  modeOf,
  sameFile,
  createDurableStoreFiles,
} = require("./durable-store-files");
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
  workTaskPipelineHoldsActiveAuthority,
  workTaskPipelineStoreCarriesRetirementMarker,
  createWorkTaskPipelineStore,
} = require("./work-task-pipeline-store");
const { projectWorkTaskBatch } = require("./work-task-projection");
const {
  WorkTaskIndependentReviewServiceError,
  createWorkTaskIndependentReviewService,
} = require("./work-task-independent-review-service");

const SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ACTIONS = new Set([
  "get_pipeline_status", "put_batch_manifest", "freeze_batch_manifest", "cut_batch",
  "retire_batch", "abandon_batch_manifest", "queue_local_correction", "read_propagation_stop",
]);
const READ_ACTIONS = new Set(["get_pipeline_status", "read_propagation_stop"]);
const PENDING_ACTIONS = new Set(["freeze_batch_manifest", "cut_batch", "retire_batch", "abandon_batch_manifest"]);
const FILE_CODES = Object.freeze({
  options: "invalid_head_control_work_task_domain_options",
  unreadable: "head_control_work_task_state_unreadable",
  symlink_rejected: "head_control_work_task_state_symlink_rejected",
  insecure_permissions: "head_control_work_task_state_insecure_permissions",
  write_failed: "head_control_work_task_state_write_failed",
  locked: "head_control_work_task_state_locked",
  lock_unsafe: "head_control_work_task_state_lock_failed",
  lock_failed: "head_control_work_task_state_lock_failed",
  lock_acquire_changed: "head_control_work_task_state_lock_failed",
  lock_release_changed: "head_control_work_task_state_lock_release_failed",
  lock_release_failed: "head_control_work_task_state_lock_release_failed",
});

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
function sameOwner(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id && left.role === right.role;
}
function sameBinding(left, right) {
  return sameOwner(left, right) && left.generation === right.generation;
}
function ownerOf(bindingValue) {
  return { installation_id: bindingValue.installation_id, project_id: bindingValue.project_id };
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

function assertInvocation(value, expectedAction, owner) {
  exact(value, ["version", "action", "binding", "expected_revision", "correlation_id", "idempotency_key", "payload"], "invalid_head_control_work_task_input");
  if (value.version !== 1 || value.action !== expectedAction || !ACTIONS.has(value.action)) {
    fail("invalid_head_control_work_task_input", "domain action is invalid");
  }
  const actualBinding = binding(value.binding, "invalid_head_control_work_task_input");
  if (!sameBinding(actualBinding, owner)) fail("head_control_work_task_binding_denied", "domain binding is not owned by this Head");
  const nullable = READ_ACTIONS.has(expectedAction);
  if (nullable ? value.expected_revision !== null : !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) {
    fail("invalid_head_control_work_task_input", "optimistic revision is invalid");
  }
  if (!nullable) revision(value.expected_revision, "invalid_head_control_work_task_input");
  identifier(value.correlation_id, "invalid_head_control_work_task_input");
  identifier(value.idempotency_key, "invalid_head_control_work_task_input");
  if (expectedAction === "get_pipeline_status" || expectedAction === "freeze_batch_manifest" || expectedAction === "retire_batch" ||
      expectedAction === "abandon_batch_manifest") {
    if (value.payload !== null) fail("invalid_head_control_work_task_input", "action does not accept payload");
  } else if (expectedAction === "put_batch_manifest") {
    exact(value.payload, ["manifest"], "invalid_head_control_work_task_input");
    if (!plain(value.payload.manifest)) fail("invalid_head_control_work_task_input", "manifest payload is invalid");
    assertBoundedPayload(value.payload.manifest);
  } else if (expectedAction === "queue_local_correction") {
    exact(value.payload, ["correction"], "invalid_head_control_work_task_input");
    exact(value.payload.correction, ["work_task_ref", "review_round_ref", "candidate_digest"], "invalid_head_control_work_task_input");
    if (!plain(value.payload.correction.work_task_ref) || !plain(value.payload.correction.review_round_ref)) {
      fail("invalid_head_control_work_task_input", "correction payload is invalid");
    }
    assertBoundedPayload(value.payload.correction);
  } else if (expectedAction === "read_propagation_stop") {
    exact(value.payload, ["work_task_ref"], "invalid_head_control_work_task_input");
    if (!plain(value.payload.work_task_ref)) fail("invalid_head_control_work_task_input", "propagation stop payload is invalid");
    assertBoundedPayload(value.payload.work_task_ref);
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
  if (!plain(value) || !PENDING_ACTIONS.has(value.action)) {
    fail(code, "pending action is invalid");
  }
  if (value.action === "retire_batch") {
    exact(value, ["action", "expected_revision", "fingerprint", "manifest_digest", "expected_pipeline_digest", "archived_pipeline_digest", "retirement_event_id"], code);
    // The intent names the exact transition it is finishing: this revision,
    // this manifest, the pipeline digest it is retiring, the digest the
    // retired record will carry once the store has archived it, and its own
    // deterministic retirement event.  A same-content successor repeats its
    // predecessor's manifest digest at a later revision, so a digest alone can
    // never say which batch an interrupted retirement was ending; an intent
    // that fails this check is corrupt, never resumed.
    if (state.stage !== "frozen" || revision(value.expected_revision, code) !== state.revision || !SHA_RE.test(value.fingerprint) ||
        digest(value.manifest_digest, code) !== state.manifest.manifest_digest ||
        digest(value.expected_pipeline_digest, code) !== state.pipeline_digest ||
        !SHA_RE.test(value.archived_pipeline_digest) || !IDENTIFIER_RE.test(value.retirement_event_id)) {
      fail(code, "pending retire precondition is invalid");
    }
    return {
      action: value.action,
      expected_revision: value.expected_revision,
      fingerprint: value.fingerprint,
      manifest_digest: value.manifest_digest,
      expected_pipeline_digest: value.expected_pipeline_digest,
      archived_pipeline_digest: value.archived_pipeline_digest,
      retirement_event_id: value.retirement_event_id,
    };
  }
  if (value.action === "abandon_batch_manifest") {
    exact(value, ["action", "expected_revision", "fingerprint", "manifest_digest"], code);
    // The intent names the exact manifest it is clearing by revision and
    // digest together.  A same-content successor is put at a later revision,
    // so a digest alone can never say which put an interrupted abandon was
    // acting on; an intent that fails this check is corrupt, never resumed.
    if (state.stage !== "manifest" || revision(value.expected_revision, code) !== state.revision || !SHA_RE.test(value.fingerprint) ||
        digest(value.manifest_digest, code) !== state.manifest.manifest_digest) {
      fail(code, "pending abandon precondition is invalid");
    }
    return { action: value.action, expected_revision: value.expected_revision, fingerprint: value.fingerprint, manifest_digest: value.manifest_digest };
  }
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
function assertState(value, owner, adoptGeneration = false) {
  exact(value, ["schema_version", "binding", "revision", "stage", "manifest", "pipeline_digest", "pending"], "invalid_head_control_work_task_state");
  if (value.schema_version !== SCHEMA_VERSION) fail("unknown_head_control_work_task_state_schema", "domain state schema is unsupported");
  const storedBinding = binding(value.binding, "invalid_head_control_work_task_state");
  // Only the explicit initialize() transition may read state left by an
  // earlier Head generation of the same project; every other read requires
  // the exact stored binding, and a stale generation can never adopt.
  const adoptable = adoptGeneration && sameOwner(storedBinding, owner) && storedBinding.generation < owner.generation;
  if (!sameBinding(storedBinding, owner) && !adoptable) fail("head_control_work_task_state_identity_mismatch", "domain state belongs to another Head generation");
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
  // An empty stage is revision 0 before the first manifest and revision N+1
  // after a retirement; either way it carries no manifest, pipeline, or intent.
  if (state.stage === "empty" && (state.manifest !== null || state.pipeline_digest !== null || value.pending !== null)) {
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

function readState(fs, statePath, owner, allowMissing, adoptGeneration = false) {
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
  try { return assertState(decoded, owner, adoptGeneration); }
  catch (error) {
    if (error instanceof HeadControlWorkTaskDomainError &&
        (error.code === "unknown_head_control_work_task_state_schema" || error.code === "head_control_work_task_state_identity_mismatch")) throw error;
    fail("corrupt_head_control_work_task_state", "domain state validation failed");
  }
}
function writeState(files, statePath, state, owner) {
  const checked = assertState(state, owner);
  files.writeFileAtomically(statePath, `${JSON.stringify(checked)}\n`);
}

function createHeadControlWorkTaskDomain(options) {
  exact(options, ["binding", "config_dir", "fs", "resolve_registered_identity", "now"], "invalid_head_control_work_task_domain_options");
  const owner = binding(options.binding, "invalid_head_control_work_task_domain_options");
  const files = createDurableStoreFiles({ fs: options.fs, error: HeadControlWorkTaskDomainError, codes: FILE_CODES });
  const fs = files.fs;
  if (typeof options.resolve_registered_identity !== "function" || typeof options.now !== "function") {
    fail("invalid_head_control_work_task_domain_options", "registered identity and clock accessors are required");
  }
  const directory = storageDirectory(options.config_dir);
  const directories = [{ path: options.config_dir, mode: DIRECTORY_MODE }, { path: directory, mode: DIRECTORY_MODE }];
  const statePath = headControlWorkTaskDomainPath(options.config_dir, owner);
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: options.config_dir, fs });
  const reviewService = createWorkTaskIndependentReviewService({ config_dir: options.config_dir, fs });

  function emptyState(revisionValue = 0) {
    return { schema_version: SCHEMA_VERSION, binding: clone(owner), revision: revisionValue, stage: "empty", manifest: null, pipeline_digest: null, pending: null };
  }
  function currentState() { return readState(fs, statePath, owner, false); }
  function readPipeline(manifest) {
    let stored;
    try { stored = pipelineStore.readRecoverySnapshot(ownerOf(owner)); }
    catch (error) {
      if (error instanceof WorkTaskPipelineStoreError) {
        fail(error.code === "work_task_pipeline_store_missing" ? "head_control_work_task_pipeline_missing" : "head_control_work_task_pipeline_unavailable",
          "pipeline state cannot be recovered");
      }
      throw error;
    }
    return pipelineSnapshot(stored, owner, manifest);
  }
  // The deterministic name of one retirement.  The same invocation at the same
  // revision always produces the same event, so an intent can be replayed
  // against the store without inventing a second archive event for the same
  // batch.  The revision is part of that name: a same-content successor is
  // retired at a strictly later revision, and without it an identical
  // invocation would name its predecessor's retirement as well as its own.
  function retirementEventId(input, revisionValue) {
    return `hretire_${hash({ binding: owner, revision: revisionValue, correlation_id: input.correlation_id, idempotency_key: input.idempotency_key }).slice(0, 64)}`;
  }
  // The digest the retired record will carry.  The store archives under its own
  // CAS before it renames the record away, so pinning the post-archive digest
  // in the intent names that record exactly, the way a cut intent pins its next
  // pipeline digest.  An already-archived pipeline — a project archive can
  // archive a frozen batch the Head then retires — is renamed untouched, so its
  // retired digest is the one it already has.
  function archivedPipelineDigest(pipeline, eventId) {
    if (pipeline.archived) return pipeline.pipeline_digest;
    try {
      return applyWorkTaskPipelinePlan(pipeline, planWorkTaskPipelineEvent(pipeline, {
        version: 1, kind: "set_archived", event_id: eventId, archived: true,
      })).pipeline_digest;
    } catch { fail("head_control_work_task_pipeline_stale", "the frozen pipeline cannot take its archive transition"); }
  }
  // A retirement is durable in the store before this domain records it.  A
  // frozen state whose active store is gone is proven retired only by the one
  // retired record the pending intent pinned, and that proof needs BOTH halves.
  //
  // The pinned pipeline digest is not sufficient on its own.  It covers the
  // whole pipeline payload, history included, so it does name one record
  // whenever this retirement is what archived the batch — its revision-bound
  // event is in that history.  But a batch already archived by the project
  // archive takes no archive event from the retirement at all, and that
  // transition derives its event from owner and manifest digest alone, with no
  // revision: two same-content batches archived that way are byte-identical,
  // digest included.  The store therefore writes this retirement's own marker
  // into `terminal_audit` before it renames, and both are required here.
  function retiredRecordHolds(intent) {
    let retired;
    try { retired = pipelineStore.readRetiredSnapshots(ownerOf(owner)); }
    catch (error) {
      if (error instanceof WorkTaskPipelineStoreError) return false;
      throw error;
    }
    return retired.some((entry) => entry.pipeline.pipeline_digest === intent.archived_pipeline_digest &&
      workTaskPipelineStoreCarriesRetirementMarker(entry, intent.retirement_event_id, intent.archived_pipeline_digest));
  }
  function retirePipeline(manifestDigest, pipelineDigest, eventId) {
    try {
      pipelineStore.retire({
        expected: {
          installation_id: owner.installation_id,
          project_id: owner.project_id,
          manifest_digest: manifestDigest,
          pipeline_digest: pipelineDigest,
        },
        event_id: eventId,
      });
    } catch (error) {
      if (error instanceof WorkTaskPipelineStoreError) {
        fail(error.code === "work_task_pipeline_store_batch_active" ? "head_control_work_task_batch_active" : "head_control_work_task_pipeline_unavailable",
          "batch retirement was rejected");
      }
      throw error;
    }
  }
  // An active pipeline is build, review, and candidate authority.  A manifest
  // may be abandoned only while none exists for this project; the retired
  // records beside it are never consulted or touched.
  function assertNoPipelineAuthority() {
    try { pipelineStore.readRecoverySnapshot(ownerOf(owner)); }
    catch (error) {
      if (error instanceof WorkTaskPipelineStoreError && error.code === "work_task_pipeline_store_missing") return;
      if (error instanceof WorkTaskPipelineStoreError) fail("head_control_work_task_pipeline_unavailable", "pipeline store cannot be checked before abandonment");
      throw error;
    }
    fail("head_control_work_task_batch_active", "a pipeline already holds authority over this project");
  }
  function ownedTaskRef(value, code) {
    if (!plain(value) || value.installation_id !== owner.installation_id || value.project_id !== owner.project_id) {
      fail(code, "work task belongs to another project");
    }
    return clone(value);
  }
  function reviewCall(run, code) {
    try { return run(); }
    catch (error) {
      if (error instanceof WorkTaskIndependentReviewServiceError) fail(code, "review service rejected the request");
      throw error;
    }
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
    writeState(files, statePath, next, owner);
    return snapshot(next, owner);
  }
  // A pending intent was atomically committed before its second durable write.
  // It can be resumed only from its private exact manifest/cut record, never
  // from a redacted Head-control audit receipt.
  function recoverPending() {
    // Before explicit initialization there may not even be a parent directory
    // in which a writer lock could safely exist.  Report missing state rather
    // than manufacturing a lock path or treating it as a blank controller.
    if (files.lstatOrNull(statePath) === null) currentState();
    return files.withWriterLock(statePath, () => {
      const state = currentState();
      if (state.pending === null) return snapshot(state, owner);
      if (state.pending.action === "abandon_batch_manifest") {
        // `assertState` already proved the intent names this exact revision
        // and manifest digest; only the absence of pipeline authority can
        // still have changed since the intent was written.
        assertNoPipelineAuthority();
        const abandoned = emptyState(state.revision + 1);
        writeState(files, statePath, abandoned, owner);
        return snapshot(abandoned, owner);
      }
      if (state.pending.action === "retire_batch") {
        // `assertState` already proved the intent names this exact revision,
        // manifest, and pre-retirement pipeline digest.  Only the store side of
        // that one transition can still be unfinished.
        const intent = state.pending;
        let stored = null;
        try { stored = readPipeline(state.manifest); }
        catch (error) {
          if (!(error instanceof HeadControlWorkTaskDomainError) || error.code !== "head_control_work_task_pipeline_missing") throw error;
        }
        if (stored !== null) {
          // The active record survived: either the store retirement never ran,
          // or it archived under CAS and had not yet renamed the record away.
          // Any other pipeline is a different batch's, never retired from here.
          const current = stored.pipeline.pipeline_digest;
          if (current !== intent.expected_pipeline_digest && !(stored.pipeline.archived && current === intent.archived_pipeline_digest)) {
            fail("head_control_work_task_pipeline_stale", "retirement recovery found a changed or foreign pipeline");
          }
          retirePipeline(intent.manifest_digest, current, intent.retirement_event_id);
        } else if (!retiredRecordHolds(intent)) {
          fail("head_control_work_task_pipeline_missing", "the retirement named by the pending intent is absent from the pipeline store");
        }
        const retired = emptyState(state.revision + 1);
        writeState(files, statePath, retired, owner);
        return snapshot(retired, owner);
      }
      if (state.pending.action === "freeze_batch_manifest") {
        assertCurrentManifest(state.manifest, options.resolve_registered_identity);
        const frozenManifest = state.pending.frozen_manifest;
        let recovered;
        try { recovered = readPipeline(frozenManifest); }
        catch (error) {
          if (!(error instanceof HeadControlWorkTaskDomainError) || error.code !== "head_control_work_task_pipeline_missing") throw error;
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
    return files.withWriterLock(statePath, () => {
      const state = currentState();
      if (state.pending !== null) fail("head_control_work_task_pending_recovery_required", "pending domain write was not recovered");
      if (state.stage !== "frozen") return { state: snapshot(state, owner), pipeline: null };
      // A frozen batch whose active pipeline is gone is never healed from
      // retired content: only the pending intent above names a retirement, and
      // it was already recovered.  Without one this is an unexplained loss, so
      // the missing pipeline is reported rather than emptied.
      const stored = readPipeline(state.manifest);
      if (stored.pipeline.pipeline_digest === state.pipeline_digest) return { state: snapshot(state, owner), pipeline: stored };
      const next = clone(state);
      next.revision += 1;
      next.pipeline_digest = stored.pipeline.pipeline_digest;
      writeState(files, statePath, next, owner);
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
    files.ensureDirectories(directories);
    return files.withWriterLock(statePath, () => {
      const existing = readState(fs, statePath, owner, true, true);
      if (existing !== null) {
        if (existing.binding.generation === owner.generation) return snapshot(existing, owner);
        // An archive/unarchive generation bump rebinds the durable state to
        // the new Head generation here, as one explicit recorded transition,
        // instead of leaving the file permanently unreadable.
        const rebound = { ...existing, binding: clone(owner) };
        writeState(files, statePath, rebound, owner);
        return snapshot(rebound, owner);
      }
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
      writeState(files, statePath, state, owner);
      return snapshot(state, owner);
    });
  }
  function get_pipeline_status(command) {
    assertStatusInvocation(command, owner);
    const current = prepared();
    return statusFor(current.state, current.pipeline);
  }
  // Private runtime read for the operator's nested Current Batch surface. It
  // is intentionally not a plane callback: it accepts no caller-selected
  // project, role, path, or state transition. The fixed public Head plane
  // remains four callbacks, while runtime composition can derive a redacted
  // projection from this domain's already-owned durable state.
  function project_current_batch() {
    const current = prepared();
    if (current.state.stage === "empty") return null;
    let pipeline;
    try {
      pipeline = current.pipeline === null
        ? buildWorkTaskPipeline(current.state.manifest)
        : current.pipeline.pipeline;
    } catch {
      fail("head_control_work_task_pipeline_corrupt", "Current Batch projection pipeline is invalid");
    }
    try {
      return projectWorkTaskBatch({ version: 1, manifest: current.state.manifest, pipeline });
    } catch {
      fail("head_control_work_task_projection_unavailable", "Current Batch projection is unavailable");
    }
  }
  function put_batch_manifest(command) {
    const input = assertInvocation(command, "put_batch_manifest", owner);
    prepared();
    return files.withWriterLock(statePath, () => {
      const state = currentState();
      assertMutationState(state, input, "empty");
      const manifest = exactManifest(input.payload.manifest, owner, "head_control_work_task_manifest_invalid");
      if (manifest.frozen !== null) fail("head_control_work_task_manifest_invalid", "put accepts only an unfrozen manifest");
      assertCurrentManifest(manifest, options.resolve_registered_identity);
      const next = clone(state);
      next.revision += 1;
      next.stage = "manifest";
      next.manifest = manifest;
      writeState(files, statePath, next, owner);
      return statusFor(next, null);
    });
  }
  function freeze_batch_manifest(command) {
    const input = assertInvocation(command, "freeze_batch_manifest", owner);
    prepared();
    files.withWriterLock(statePath, () => {
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
      writeState(files, statePath, next, owner);
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
    files.withWriterLock(statePath, () => {
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
      writeState(files, statePath, next, owner);
    });
    const state = recoverPending();
    const pipeline = readPipeline(state.manifest);
    return statusFor(state, pipeline);
  }
  // Retirement ends one frozen batch: the store archives and renames the
  // record under CAS, then this domain returns to `empty` at the next revision
  // so a successor manifest can be put.  The intent is durable before either
  // store write and names that exact transition, so a crash anywhere between
  // them is finished by `recoverPending` — and only ever that transition.
  function retire_batch(command) {
    const input = assertInvocation(command, "retire_batch", owner);
    prepared();
    files.withWriterLock(statePath, () => {
      const state = currentState();
      assertMutationState(state, input, "frozen");
      const stored = readPipeline(state.manifest);
      if (stored.pipeline.pipeline_digest !== state.pipeline_digest) fail("head_control_work_task_pipeline_stale", "pipeline changed before retirement");
      // The store refuses a batch that still holds build or review authority.
      // Reach that verdict before the intent is durable: an intent whose
      // recovery could never finish would wedge every later domain read.
      if (workTaskPipelineHoldsActiveAuthority(stored.pipeline)) {
        fail("head_control_work_task_batch_active", "batch retains active build or review authority");
      }
      const eventId = retirementEventId(input, state.revision);
      const next = clone(state);
      next.pending = {
        action: "retire_batch",
        expected_revision: state.revision,
        fingerprint: invocationFingerprint(input),
        manifest_digest: state.manifest.manifest_digest,
        expected_pipeline_digest: state.pipeline_digest,
        archived_pipeline_digest: archivedPipelineDigest(stored.pipeline, eventId),
        retirement_event_id: eventId,
      };
      writeState(files, statePath, next, owner);
    });
    return statusFor(recoverPending(), null);
  }
  // Abandonment ends one never-frozen manifest: Head walks away from a
  // manifest it decided against so a successor can be put.  The intent is
  // durable before the empty write and names the manifest by revision and
  // digest; it is refused once a freeze has begun (a pending freeze is
  // recovered first and leaves `frozen`) or a pipeline exists, and it never
  // reaches the pipeline store, so frozen, cut, and retired records stay put.
  function abandon_batch_manifest(command) {
    const input = assertInvocation(command, "abandon_batch_manifest", owner);
    prepared();
    files.withWriterLock(statePath, () => {
      const state = currentState();
      assertMutationState(state, input, "manifest");
      assertNoPipelineAuthority();
      const next = clone(state);
      next.pending = {
        action: "abandon_batch_manifest",
        expected_revision: state.revision,
        fingerprint: invocationFingerprint(input),
        manifest_digest: state.manifest.manifest_digest,
      };
      writeState(files, statePath, next, owner);
    });
    // Whatever the recovery found is reported exactly, including a successor
    // a competing writer froze meanwhile; the plane rejects anything but empty.
    const state = recoverPending();
    return statusFor(state, state.stage === "frozen" ? readPipeline(state.manifest) : null);
  }
  // A released change-requested round returns its exact candidate to Dev.  The
  // review service owns the round/pipeline transition; this domain binds the
  // task to the owning project and frozen batch and records the new revision.
  function queue_local_correction(command) {
    const input = assertInvocation(command, "queue_local_correction", owner);
    prepared();
    return files.withWriterLock(statePath, () => {
      const state = currentState();
      assertMutationState(state, input, "frozen");
      assertCurrentManifest(state.manifest, options.resolve_registered_identity);
      const stored = readPipeline(state.manifest);
      if (stored.pipeline.pipeline_digest !== state.pipeline_digest || stored.pipeline.archived) {
        fail("head_control_work_task_pipeline_stale", "pipeline changed before correction queueing");
      }
      const correction = input.payload.correction;
      const queued = reviewCall(() => reviewService.queueLocalCorrection({
        version: 1,
        work_task_ref: ownedTaskRef(correction.work_task_ref, "head_control_work_task_binding_denied"),
        review_round_ref: clone(correction.review_round_ref),
        candidate_digest: correction.candidate_digest,
      }), "head_control_work_task_correction_rejected");
      const applied = readPipeline(state.manifest);
      const next = clone(state);
      next.revision += 1;
      next.pipeline_digest = applied.pipeline.pipeline_digest;
      writeState(files, statePath, next, owner);
      return freeze({
        status: statusFor(next, applied),
        detail: { outcome: queued.outcome, work_task_ref: clone(queued.work_task_ref), candidate_digest: queued.candidate_digest, checkpoint_id: queued.checkpoint_id },
      });
    });
  }
  // Head-private read of one task's pending pre-release propagation stop.  It
  // is a read: the status it reports is the current one, and the redacted stop
  // (or null) travels beside it without becoming durable audit data.
  function read_propagation_stop(command) {
    const input = assertInvocation(command, "read_propagation_stop", owner);
    const current = prepared();
    if (current.state.stage !== "frozen" || current.pipeline === null) {
      fail("head_control_work_task_invalid_transition", "propagation stop read requires a frozen batch");
    }
    const stop = reviewCall(() => reviewService.readPropagationStopPending({
      version: 1,
      work_task_ref: ownedTaskRef(input.payload.work_task_ref, "head_control_work_task_binding_denied"),
    }), "head_control_work_task_stop_unavailable");
    return freeze({ status: statusFor(current.state, current.pipeline), detail: stop === null ? null : clone(stop) });
  }

  // `initialize` is deliberately non-enumerable.  The existing plane exacts
  // its domain object to these fixed callbacks, while runtime startup still
  // has an explicit durable bootstrap with no extra control action.
  const domain = { get_pipeline_status, put_batch_manifest, freeze_batch_manifest, cut_batch, retire_batch, abandon_batch_manifest, queue_local_correction, read_propagation_stop };
  Object.defineProperty(domain, "initialize", { value: initialize, enumerable: false });
  Object.defineProperty(domain, "project_current_batch", { value: project_current_batch, enumerable: false });
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
