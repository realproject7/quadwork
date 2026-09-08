"use strict";

// #1058 M3: deterministic, server-owned WorkTask pipeline planning.  This
// module deliberately does not persist a plan, route an HTTP request, dispatch
// an agent, or publish a candidate.  Callers supply authenticated structured
// WorkTask/Candidate facts; a storage owner can atomically apply the immutable
// plan returned here.

const crypto = require("crypto");
const {
  assertBatchManifest,
  assertWorkTaskRef,
  workTaskKey,
} = require("./work-task-manifest");
const {
  assertWorkTaskCandidate,
} = require("./work-task-candidate");

const { assertDeliveryCompletionRecord } = require("./delivery-candidate");

const VERSION = 1;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EVENT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const FILE_BOUNDARY_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@+~=-]{1,240}$/;
const TASK_STATES = new Set([
  "queued",
  "building",
  "candidate_ready",
  "independent_review",
  "reconcile",
  "changes_requested",
  "accepted",
  "staged",
  "delivered",
  "blocked",
  "deferred",
]);
const REVIEW_VERDICTS = new Set(["approved", "changes_requested"]);
const RECONCILE_RESOLUTIONS = new Set(["accepted", "changes_requested"]);
const BLOCK_CODES = new Set(["dependency", "integrity", "validation"]);
const EVENT_KINDS = new Set([
  "assign_build",
  "record_candidate",
  "replace_candidate",
  "assign_independent_review",
  "record_review_verdict",
  "reconcile_review",
  "queue_local_correction",
  "stage_candidate",
  "integrated_cut",
  "set_archived",
  "block",
  "unblock",
  "propagating_finding",
  "contract_change",
]);
const DEPENDENCY_READY_STATES = new Set(["accepted", "staged", "delivered"]);
const INTERNAL_HISTORY_KINDS = new Set(["record_delivery"]);
const MAX_TASKS = 64;
const MAX_HISTORY = 512;
const MAX_CHECKPOINTS = 3;

class WorkTaskPipelineError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "WorkTaskPipelineError";
    this.code = code;
  }
}

function fail(code, message) { throw new WorkTaskPipelineError(code, message); }
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
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function identifier(value, code) {
  if (typeof value !== "string" || !EVENT_ID_RE.test(value)) fail(code, "server event id is invalid");
  return value;
}
function sha(value, code) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "digest is invalid");
  return value;
}
function ref(value, code) {
  try { assertWorkTaskRef(value); } catch { fail(code, "work task reference is invalid"); }
  return value;
}
function candidate(value, code) {
  try { assertWorkTaskCandidate(value); } catch { fail(code, "work task candidate is invalid"); }
  return value;
}
function sameRef(left, right) { return workTaskKey(left) === workTaskKey(right); }

function pipelinePayload(pipeline) {
  return {
    version: pipeline.version,
    manifest_digest: pipeline.manifest_digest,
    manifest_frozen: pipeline.manifest_frozen,
    archived: pipeline.archived,
    repository_bases: pipeline.repository_bases,
    history: pipeline.history,
    tasks: pipeline.tasks,
    ...(Object.hasOwn(pipeline, "deliveries") ? { deliveries: pipeline.deliveries } : {}),
  };
}
function pipelineDigest(pipeline) { return hash(pipelinePayload(pipeline)); }
function withDigest(pipeline) { return freeze({ ...pipeline, pipeline_digest: pipelineDigest(pipeline) }); }

function assertAssignment(value, code) {
  exact(value, ["assignment_id", "base_sha"], code);
  identifier(value.assignment_id, code);
  sha(value.base_sha, code);
  return value;
}
function fileBoundary(value, code) {
  if (!Array.isArray(value) || value.length > 32 ||
      !value.every((entry) => typeof entry === "string" && FILE_BOUNDARY_PATH_RE.test(entry)) ||
      new Set(value).size !== value.length) {
    fail(code, "file boundary is invalid");
  }
  return value;
}
function assertReviewAssignment(value, currentCandidate, state, code) {
  if (value === null) {
    if (state === "independent_review" || state === "reconcile") fail(code, "review assignment is required");
    return null;
  }
  exact(value, ["review_round_id", "candidate_digest", "verdict"], code);
  identifier(value.review_round_id, code);
  sha(value.candidate_digest, code);
  if (!currentCandidate || value.candidate_digest !== currentCandidate.candidate_digest) fail(code, "review assignment candidate is stale");
  if (state === "independent_review" && value.verdict !== null) fail(code, "review verdict is premature");
  if (state === "reconcile" && !REVIEW_VERDICTS.has(value.verdict)) fail(code, "review verdict is missing");
  if (state !== "independent_review" && state !== "reconcile") fail(code, "review assignment is not active in this state");
  return value;
}
// #1070: the per-task correction count is its own durable, monotonic fact; it
// never follows the active checkpoint, which every corrected candidate clears.
// A slot persisted before the field existed reads with the pre-#1070 meaning
// (the active checkpoint's count, else zero) and gains the field on the next
// applied plan.
function correctionCount(slot) {
  if (slot.correction_count !== undefined) return slot.correction_count;
  return slot.correction ? slot.correction.count : 0;
}
function assertCorrection(value, currentCandidate, state, count, code) {
  if (value === null) return null;
  exact(value, ["checkpoint_id", "count"], code);
  identifier(value.checkpoint_id, code);
  if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > MAX_CHECKPOINTS) fail(code, "correction checkpoint is invalid");
  if (value.count !== count) fail(code, "correction checkpoint contradicts the task correction count");
  if (!currentCandidate || (state !== "queued" && state !== "building")) fail(code, "correction checkpoint is inactive");
  return value;
}
function assertSlot(slot, code) {
  const fields = ["work_task_ref", "dependency_refs", "file_boundary", "state", "candidate", "build_assignment", "review_assignment", "correction", "blocked_from", "history"];
  if (!plain(slot)) fail(code, "value must be an object");
  exact(slot, [...fields, ...["correction_count", "invalidated_candidate"].filter((field) => Object.hasOwn(slot, field))], code);
  if (Object.hasOwn(slot, "invalidated_candidate")) {
    candidate(slot.invalidated_candidate, code);
    if (!sameRef(slot.invalidated_candidate.work_task_ref, slot.work_task_ref)) fail(code, "invalidated candidate belongs to another task");
  }
  ref(slot.work_task_ref, code);
  fileBoundary(slot.file_boundary, code);
  if (!Array.isArray(slot.dependency_refs) || slot.dependency_refs.length > MAX_TASKS) fail(code, "dependency references are invalid");
  const dependencyKeys = slot.dependency_refs.map((entry) => workTaskKey(ref(entry, code)));
  if (new Set(dependencyKeys).size !== dependencyKeys.length || dependencyKeys.includes(workTaskKey(slot.work_task_ref))) fail(code, "dependency references are duplicated or self-referential");
  if (!TASK_STATES.has(slot.state)) fail(code, "work task state is invalid");
  if (slot.candidate !== null) {
    candidate(slot.candidate, code);
    if (!sameRef(slot.candidate.work_task_ref, slot.work_task_ref)) fail(code, "candidate belongs to another work task");
  }
  const requiresCandidate = new Set(["candidate_ready", "independent_review", "reconcile", "changes_requested", "accepted", "staged", "delivered"]);
  if (requiresCandidate.has(slot.state) && slot.candidate === null) fail(code, "state requires an exact candidate");
  if (slot.state === "deferred" && slot.candidate !== null) fail(code, "deferred task retains candidate authority");
  if (slot.build_assignment === null) {
    if (slot.state === "building") fail(code, "building task lacks assignment");
  } else {
    assertAssignment(slot.build_assignment, code);
    if (slot.state !== "building") fail(code, "build assignment is not active in this state");
  }
  assertReviewAssignment(slot.review_assignment, slot.candidate, slot.state, code);
  const count = correctionCount(slot);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CHECKPOINTS) fail(code, "task correction count is invalid");
  assertCorrection(slot.correction, slot.candidate, slot.state, count, code);
  if (slot.blocked_from === null) {
    if (slot.state === "blocked") fail(code, "blocked task lacks resume state");
  } else {
    if (slot.state !== "blocked" || !new Set(["queued", "candidate_ready", "changes_requested", "accepted", "staged"]).has(slot.blocked_from)) {
      fail(code, "blocked task resume state is invalid");
    }
    if (slot.build_assignment !== null || slot.review_assignment !== null || slot.correction !== null) fail(code, "blocked task retains active authority");
  }
  if (!Array.isArray(slot.history) || slot.history.length > MAX_HISTORY) fail(code, "task history is invalid");
  slot.history.forEach((entry) => {
    exact(entry, ["event_id", "kind"], code);
    identifier(entry.event_id, code);
    if (!EVENT_KINDS.has(entry.kind) && !INTERNAL_HISTORY_KINDS.has(entry.kind)) fail(code, "task history kind is invalid");
  });
  return slot;
}
function assertRepositoryBases(value, tasks, code) {
  if (!Array.isArray(value) || value.length > MAX_TASKS) fail(code, "repository base records are invalid");
  const known = new Set(tasks.map((slot) => slot.work_task_ref.repository_key));
  const parsed = value.map((entry) => {
    exact(entry, ["repository_key", "base_sha"], code);
    if (typeof entry.repository_key !== "string" || !known.has(entry.repository_key)) fail(code, "repository base repository is invalid");
    return { repository_key: entry.repository_key, base_sha: sha(entry.base_sha, code) };
  });
  if (new Set(parsed.map((entry) => entry.repository_key)).size !== parsed.length ||
      parsed.some((entry, index) => index > 0 && parsed[index - 1].repository_key.localeCompare(entry.repository_key) >= 0)) {
    fail(code, "repository base records are not canonical");
  }
  return parsed;
}

function assertWorkTaskPipeline(pipeline) {
  exact(pipeline, ["version", "manifest_digest", "manifest_frozen", "archived", "repository_bases", "history", "tasks", "pipeline_digest",
    ...(Object.hasOwn(pipeline, "deliveries") ? ["deliveries"] : [])], "invalid_work_task_pipeline");
  if (pipeline.version !== VERSION || !SHA_RE.test(pipeline.manifest_digest) || typeof pipeline.manifest_frozen !== "boolean" || typeof pipeline.archived !== "boolean" ||
      !Array.isArray(pipeline.tasks) || pipeline.tasks.length === 0 || pipeline.tasks.length > MAX_TASKS || !Array.isArray(pipeline.history) || pipeline.history.length > MAX_HISTORY || !SHA_RE.test(pipeline.pipeline_digest)) {
    fail("invalid_work_task_pipeline", "pipeline shape is invalid");
  }
  const tasks = pipeline.tasks.map((slot) => assertSlot(slot, "invalid_work_task_pipeline"));
  assertRepositoryBases(pipeline.repository_bases, tasks, "invalid_work_task_pipeline");
  const taskKeys = tasks.map((slot) => workTaskKey(slot.work_task_ref));
  if (new Set(taskKeys).size !== taskKeys.length) fail("invalid_work_task_pipeline", "pipeline task identity is duplicated");
  const known = new Set(taskKeys);
  for (const slot of tasks) {
    if (slot.dependency_refs.some((entry) => !known.has(workTaskKey(entry)))) fail("invalid_work_task_pipeline", "pipeline dependency is outside the manifest");
  }
  if (tasks.filter((slot) => slot.state === "building").length > 1) fail("invalid_work_task_pipeline", "pipeline has more than one active build task");
  const historyIds = new Set();
  pipeline.history.forEach((entry) => {
    exact(entry, ["event_id", "kind"], "invalid_work_task_pipeline");
    identifier(entry.event_id, "invalid_work_task_pipeline");
    if ((!EVENT_KINDS.has(entry.kind) && !INTERNAL_HISTORY_KINDS.has(entry.kind)) || historyIds.has(entry.event_id)) fail("invalid_work_task_pipeline", "pipeline history is invalid or duplicated");
    historyIds.add(entry.event_id);
  });
  assertDeliveryMappings(pipeline);
  if (pipeline.pipeline_digest !== pipelineDigest(pipeline)) fail("invalid_work_task_pipeline", "pipeline digest mismatch");
  return pipeline;
}

// Delivery records are written only by the store's internal completion method.
// They are not accepted by parseEvent or by the public generic plan surface.
function assertDeliveryMappings(pipeline) {
  const records = Object.hasOwn(pipeline, "deliveries") ? pipeline.deliveries : [];
  if (!Array.isArray(records) || records.length > MAX_TASKS) fail("invalid_work_task_pipeline", "delivery history bound is invalid");
  const mapped = new Set();
  const receipts = new Set();
  const lastByRepository = new Map();
  for (const record of records) {
    try { assertDeliveryCompletionRecord(record); } catch { fail("invalid_work_task_pipeline", "delivery completion record is invalid"); }
    const identity = record.candidate_ref;
    if (identity.batch_manifest_digest !== pipeline.manifest_digest || receipts.has(record.receipt_digest)) {
      fail("invalid_work_task_pipeline", "delivery history identity is inconsistent");
    }
    const previous = lastByRepository.get(identity.repository_key);
    if (previous && record.base_sha !== previous.merge_sha) fail("invalid_work_task_pipeline", "delivery repository base chain is broken");
    lastByRepository.set(identity.repository_key, record);
    receipts.add(record.receipt_digest);
    const eventId = `delivery_${record.receipt_digest}`;
    if (!pipeline.history.some((event) => event.kind === "record_delivery" && event.event_id === eventId)) {
      fail("invalid_work_task_pipeline", "delivery record lacks its internal transition");
    }
    let previousIndex = -1;
    for (const taskRef of record.work_task_refs) {
      const key = workTaskKey(taskRef);
      const index = pipeline.tasks.findIndex((slot) => sameRef(slot.work_task_ref, taskRef));
      const slot = pipeline.tasks[index];
      if (!slot || index <= previousIndex || mapped.has(key) || slot.state !== "delivered"
        || slot.work_task_ref.installation_id !== identity.installation_id || slot.work_task_ref.project_id !== identity.project_id
        || !slot.history.some((event) => event.kind === "record_delivery" && event.event_id === eventId)) {
        fail("invalid_work_task_pipeline", "delivered task mapping is inconsistent");
      }
      mapped.add(key);
      previousIndex = index;
    }
  }
  if (pipeline.history.some((event) => event.kind === "record_delivery" && !receipts.has(event.event_id.slice("delivery_".length)))) {
    fail("invalid_work_task_pipeline", "delivery transition lacks its immutable receipt");
  }
  for (const slot of pipeline.tasks) {
    if (slot.history.some((event) => event.kind === "record_delivery" && !receipts.has(event.event_id.slice("delivery_".length)))) {
      fail("invalid_work_task_pipeline", "task delivery history lacks its immutable receipt");
    }
    if ((slot.state === "delivered") !== mapped.has(workTaskKey(slot.work_task_ref))) {
      fail("invalid_work_task_pipeline", "task has no exact delivery mapping");
    }
  }
  for (const [repository, record] of lastByRepository) {
    if (assignedRepositoryBase(pipeline.repository_bases, repository)?.base_sha !== record.merge_sha) {
      fail("invalid_work_task_pipeline", "repository base is not its verified merge result");
    }
  }
}

function currentDeliveryCut(pipeline, repositoryKey, mode = "integrated") {
  assertWorkTaskPipeline(pipeline);
  const slots = pipeline.tasks.filter((slot) => slot.work_task_ref.repository_key === repositoryKey && slot.state === "staged");
  if (slots.length === 0 || (mode === "isolated" && slots.length !== 1)) fail("work_task_delivery_staging_incomplete", "no bounded staged repository cut is available");
  let cutIndex = -1;
  for (const slot of slots) {
    const staged = [...slot.history].reverse().find((entry) => entry.kind === "integrated_cut" || entry.kind === "stage_candidate");
    if (!staged || (mode === "integrated" && staged.kind !== "integrated_cut")) fail("work_task_delivery_cut_unavailable", "staged task has no recorded delivery cut");
    const index = pipeline.history.findIndex((entry) => entry.event_id === staged.event_id && entry.kind === staged.kind);
    if (index < 0) fail("work_task_delivery_cut_unavailable", "recorded cut is unavailable");
    cutIndex = Math.max(cutIndex, index);
  }
  const last = pipeline.tasks.indexOf(slots[slots.length - 1]);
  if (pipeline.tasks.slice(0, last).some((slot) => slot.work_task_ref.repository_key === repositoryKey
    && !["staged", "delivered", "deferred"].includes(slot.state))) {
    fail("work_task_delivery_staging_incomplete", "delivery cut skips unresolved repository work");
  }
  return freeze({ cut_id: pipeline.history[cutIndex].event_id, work_task_refs: slots.map((slot) => clone(slot.work_task_ref)) });
}

function applyWorkTaskPipelineDelivery(pipeline, delivery) {
  assertWorkTaskPipeline(pipeline);
  assertDeliveryCompletionRecord(delivery);
  if (pipeline.archived || !pipeline.manifest_frozen) fail("work_task_archive_blocked", "delivery requires the active frozen pipeline");
  if (pipeline.history.length >= MAX_HISTORY || (pipeline.deliveries || []).length >= MAX_TASKS) fail("work_task_pipeline_history_full", "delivery history bound reached");
  const ref = delivery.candidate_ref;
  if (ref.batch_manifest_digest !== pipeline.manifest_digest) fail("work_task_delivery_identity_mismatch", "delivery belongs to another batch");
  const base = assignedRepositoryBase(pipeline.repository_bases, ref.repository_key);
  if (!base || base.base_sha !== delivery.base_sha) fail("work_task_delivery_base_mismatch", "delivery does not advance the current repository base");
  if (pipeline.tasks.some((slot) => slot.work_task_ref.repository_key === ref.repository_key
    && ["building", "independent_review", "reconcile"].includes(slot.state))) {
    fail("work_task_delivery_active_authority", "resolve active repository builds and reviews before advancing the base");
  }
  const cut = currentDeliveryCut(pipeline, ref.repository_key, ref.delivery_mode);
  if (cut.cut_id !== ref.cut_id || stable(cut.work_task_refs) !== stable(delivery.work_task_refs)) {
    fail("work_task_delivery_cut_mismatch", "completion must map the exact recorded repository cut");
  }
  const selected = new Set(delivery.work_task_refs.map(workTaskKey));
  for (const slot of pipeline.tasks.filter((slot) => selected.has(workTaskKey(slot.work_task_ref)))) {
    if (slot.dependency_refs.some((dependency) => !selected.has(workTaskKey(dependency))
      && slotFor(pipeline.tasks, dependency, "work_task_delivery_dependency_unavailable").state !== "delivered")) {
      fail("work_task_delivery_dependency_unavailable", "completion lacks a delivered or included predecessor");
    }
  }
  const event = { event_id: `delivery_${delivery.receipt_digest}`, kind: "record_delivery" };
  const tasks = clone(pipeline.tasks);
  for (const slot of tasks) {
    if (slot.work_task_ref.repository_key !== ref.repository_key || slot.state === "delivered") continue;
    if (slot.work_task_ref.installation_id !== ref.installation_id || slot.work_task_ref.project_id !== ref.project_id) {
      fail("work_task_delivery_identity_mismatch", "delivery belongs to another owner");
    }
    if (selected.has(workTaskKey(slot.work_task_ref))) {
      slot.state = "delivered";
      slot.history.push(clone(event));
    } else if (slot.candidate !== null) {
      // Keep the old local identity for diagnosis; its task-review store and
      // managed worktree stay untouched. New assignment must use the new base.
      slot.invalidated_candidate = clone(slot.candidate);
      slot.candidate = null;
      clearAuthority(slot);
      if (slot.state === "blocked") slot.blocked_from = "queued";
      else { slot.state = "queued"; slot.blocked_from = null; }
      slot.history.push(clone(event));
    }
  }
  const next = withDigest({ ...pipeline, tasks,
    repository_bases: pipeline.repository_bases.map((entry) => entry.repository_key === ref.repository_key
      ? { ...entry, base_sha: delivery.merge_sha } : clone(entry)),
    deliveries: [...(pipeline.deliveries || []).map(clone), clone(delivery)],
    history: [...pipeline.history, event],
  });
  assertWorkTaskPipeline(next);
  return next;
}

function buildWorkTaskPipeline(manifest, options) {
  const normalizedOptions = options === undefined ? { archived: false } : options;
  exact(normalizedOptions, ["archived"], "invalid_work_task_pipeline_options");
  if (typeof normalizedOptions.archived !== "boolean") fail("invalid_work_task_pipeline_options", "archive state is invalid");
  let entries;
  try { entries = assertBatchManifest(manifest); } catch { fail("invalid_work_task_manifest", "work task manifest is invalid"); }
  const tasks = entries.map((entry) => ({
    work_task_ref: clone(entry.ref),
    dependency_refs: entry.contract.dependencies.map(clone),
    file_boundary: clone(entry.contract.file_boundary),
    state: "queued",
    candidate: null,
    build_assignment: null,
    review_assignment: null,
    correction: null,
    correction_count: 0,
    blocked_from: null,
    history: [],
  }));
  return withDigest({
    version: VERSION,
    manifest_digest: manifest.manifest_digest,
    manifest_frozen: manifest.frozen !== null,
    archived: normalizedOptions.archived,
    repository_bases: [],
    history: [],
    tasks,
  });
}

function slotFor(tasks, taskRef, code) {
  ref(taskRef, code);
  const found = tasks.find((slot) => sameRef(slot.work_task_ref, taskRef));
  if (!found) fail("unknown_work_task_ref", "task reference is absent from this pipeline");
  return found;
}
function canonicalTaskRef(pipeline, taskRef, code) { return clone(slotFor(pipeline.tasks, taskRef, code).work_task_ref); }
function canonicalCutTask(pipeline, value, code) {
  exact(value, ["work_task_ref", "candidate_digest"], code);
  sha(value.candidate_digest, code);
  return { work_task_ref: canonicalTaskRef(pipeline, value.work_task_ref, code), candidate_digest: value.candidate_digest };
}

function parseEvent(pipeline, event) {
  if (!plain(event) || typeof event.kind !== "string" || !EVENT_KINDS.has(event.kind)) fail("invalid_work_task_pipeline_event", "event kind is invalid");
  const code = "invalid_work_task_pipeline_event";
  switch (event.kind) {
    case "assign_build":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "assignment_id", "base_sha"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), assignment_id: identifier(event.assignment_id, code), base_sha: sha(event.base_sha, code) };
    case "record_candidate": {
      exact(event, ["version", "kind", "event_id", "assignment_id", "candidate"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      candidate(event.candidate, code);
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), assignment_id: identifier(event.assignment_id, code), candidate: clone(event.candidate) };
    }
    case "replace_candidate": {
      exact(event, ["version", "kind", "event_id", "candidate"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      candidate(event.candidate, code);
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), candidate: clone(event.candidate) };
    }
    case "assign_independent_review":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "review_round_id", "candidate_digest"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), review_round_id: identifier(event.review_round_id, code), candidate_digest: sha(event.candidate_digest, code) };
    case "record_review_verdict":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "review_round_id", "candidate_digest", "verdict"], code);
      if (event.version !== VERSION || !REVIEW_VERDICTS.has(event.verdict)) fail(code, "review verdict event is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), review_round_id: identifier(event.review_round_id, code), candidate_digest: sha(event.candidate_digest, code), verdict: event.verdict };
    case "reconcile_review":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "review_round_id", "candidate_digest", "resolution"], code);
      if (event.version !== VERSION || !RECONCILE_RESOLUTIONS.has(event.resolution)) fail(code, "review reconciliation event is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), review_round_id: identifier(event.review_round_id, code), candidate_digest: sha(event.candidate_digest, code), resolution: event.resolution };
    case "queue_local_correction":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "checkpoint_id"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), checkpoint_id: identifier(event.checkpoint_id, code) };
    case "stage_candidate":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "candidate_digest"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), candidate_digest: sha(event.candidate_digest, code) };
    case "integrated_cut": {
      exact(event, ["version", "kind", "event_id", "tasks"], code);
      if (event.version !== VERSION || !Array.isArray(event.tasks) || event.tasks.length === 0 || event.tasks.length > MAX_TASKS) fail(code, "integrated cut event is invalid");
      const tasks = event.tasks.map((entry) => canonicalCutTask(pipeline, entry, code));
      if (new Set(tasks.map((entry) => workTaskKey(entry.work_task_ref))).size !== tasks.length) fail(code, "integrated cut task is duplicated");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), tasks };
    }
    case "set_archived":
      exact(event, ["version", "kind", "event_id", "archived"], code);
      if (event.version !== VERSION || typeof event.archived !== "boolean") fail(code, "archive event is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), archived: event.archived };
    case "block":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "block_code"], code);
      if (event.version !== VERSION || !BLOCK_CODES.has(event.block_code)) fail(code, "block event is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), block_code: event.block_code };
    case "unblock":
      exact(event, ["version", "kind", "event_id", "work_task_ref"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code) };
    case "propagating_finding":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "candidate_digest", "finding_id"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), candidate_digest: sha(event.candidate_digest, code), finding_id: identifier(event.finding_id, code) };
    case "contract_change":
      exact(event, ["version", "kind", "event_id", "work_task_ref", "observed_issue_body_revision"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), work_task_ref: canonicalTaskRef(pipeline, event.work_task_ref, code), observed_issue_body_revision: sha(event.observed_issue_body_revision, code) };
    default:
      fail(code, "event kind is unsupported");
  }
}

function dependencyKeys(slot) { return slot.dependency_refs.map(workTaskKey); }
function dependentKeys(tasks, sourceRef) {
  const source = workTaskKey(sourceRef);
  const reverse = new Map(tasks.map((slot) => [workTaskKey(slot.work_task_ref), []]));
  for (const slot of tasks) for (const dependency of dependencyKeys(slot)) reverse.get(dependency).push(workTaskKey(slot.work_task_ref));
  const found = new Set([source]);
  const queue = [source];
  while (queue.length) {
    for (const dependent of reverse.get(queue.shift())) {
      if (!found.has(dependent)) { found.add(dependent); queue.push(dependent); }
    }
  }
  return found;
}
function eventEffect(slot, fromState) {
  return { work_task_ref: clone(slot.work_task_ref), from_state: fromState, to_state: slot.state };
}
function requireState(slot, state) {
  if (slot.state !== state) fail("invalid_work_task_pipeline_state", `task is ${slot.state}, not ${state}`);
}
function clearAuthority(slot) {
  slot.build_assignment = null;
  slot.review_assignment = null;
  slot.correction = null;
}
function blockSlot(slot) {
  if (slot.state === "blocked") return false;
  if (slot.state === "deferred" || slot.state === "delivered") return false;
  const from = slot.state;
  const resume = from === "building" ? "queued" :
    (from === "independent_review" || from === "reconcile" ? "candidate_ready" : from);
  clearAuthority(slot);
  slot.state = "blocked";
  slot.blocked_from = resume;
  return true;
}
function ensureCandidate(slot, digest) {
  if (!slot.candidate || slot.candidate.candidate_digest !== digest) fail("stale_work_task_candidate", "candidate is not current for this task");
}
function ensureNoCorrectionAuthority(slot) {
  if (slot.correction !== null) fail("unresolved_work_task_correction", "candidate retains local correction authority");
}
function assertDependenciesReady(tasks, slot) {
  for (const dependency of slot.dependency_refs) {
    const parent = slotFor(tasks, dependency, "invalid_work_task_pipeline_state");
    if (!DEPENDENCY_READY_STATES.has(parent.state)) fail("work_task_dependencies_not_ready", "declared dependency is not ready");
  }
}
function assignedRepositoryBase(repositoryBases, repositoryKey) {
  return repositoryBases.find((entry) => entry.repository_key === repositoryKey) || null;
}
function expectedBuildBase(tasks, repositoryBases, slot) {
  // A bounded correction keeps the original task base. It cannot quietly
  // absorb a later unrelated integration tip.
  if (slot.candidate !== null) return slot.candidate.base_sha;
  const sameRepositoryDependencies = slot.dependency_refs
    .map((dependency) => slotFor(tasks, dependency, "invalid_work_task_pipeline_state"))
    .filter((dependency) => dependency.work_task_ref.repository_key === slot.work_task_ref.repository_key && dependency.state !== "delivered");
  if (sameRepositoryDependencies.length > 1) {
    fail("work_task_dependency_base_ambiguous", "task has multiple same-repository predecessor bases");
  }
  if (sameRepositoryDependencies.length === 1) {
    const predecessor = sameRepositoryDependencies[0];
    if (!predecessor.candidate || !DEPENDENCY_READY_STATES.has(predecessor.state)) {
      fail("work_task_dependencies_not_ready", "same-repository predecessor has no accepted exact candidate");
    }
    return predecessor.candidate.candidate_sha;
  }
  return assignedRepositoryBase(repositoryBases, slot.work_task_ref.repository_key)?.base_sha || null;
}
function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function assertReviewBoundariesDisjoint(tasks, next) {
  // A legacy task has no declared boundary, so it cannot prove safe overlap.
  // Boundaries from different repositories are never comparable.
  for (const active of tasks) {
    if (active === next || active.work_task_ref.repository_key !== next.work_task_ref.repository_key ||
        !new Set(["independent_review", "reconcile"]).has(active.state)) continue;
    if (active.file_boundary.length === 0 || next.file_boundary.length === 0 ||
        active.file_boundary.some((left) => next.file_boundary.some((right) => pathsOverlap(left, right)))) {
      fail("work_task_review_boundary_overlap", "new build boundary overlaps a candidate under review");
    }
  }
}

// This function clones in-memory values only; it does not mutate the supplied
// pipeline.  Planning discards `tasks`; application uses it only after proving
// the exact plan can be recreated from the current pipeline state.
function deriveTransition(pipeline, event) {
  const tasks = clone(pipeline.tasks);
  for (const slot of tasks) slot.correction_count = correctionCount(slot);
  const repositoryBases = clone(pipeline.repository_bases);
  const effects = [];
  let archived = pipeline.archived;
  const effect = (slot, fromState) => effects.push(eventEffect(slot, fromState));
  const locate = (taskRef) => slotFor(tasks, taskRef, "unknown_work_task_ref");

  switch (event.kind) {
    case "assign_build": { // The only transition that creates active Dev authority.
      if (archived) fail("work_task_archive_blocked", "archive blocks build assignment");
      if (!pipeline.manifest_frozen) fail("work_task_manifest_not_frozen", "build assignment requires frozen manifest");
      if (tasks.some((slot) => slot.state === "building")) fail("active_build_task_exists", "only one active build task is allowed");
      const slot = locate(event.work_task_ref);
      requireState(slot, "queued");
      assertDependenciesReady(tasks, slot);
      assertReviewBoundariesDisjoint(tasks, slot);
      const requiredBase = expectedBuildBase(tasks, repositoryBases, slot);
      if (requiredBase !== null && event.base_sha !== requiredBase) {
        fail("work_task_assigned_base_mismatch", "build base does not match the frozen repository/task predecessor base");
      }
      if (requiredBase === null) {
        repositoryBases.push({ repository_key: slot.work_task_ref.repository_key, base_sha: event.base_sha });
        repositoryBases.sort((left, right) => left.repository_key.localeCompare(right.repository_key));
      }
      const from = slot.state;
      slot.state = "building";
      slot.blocked_from = null;
      slot.build_assignment = { assignment_id: event.assignment_id, base_sha: event.base_sha };
      effect(slot, from);
      break;
    }
    case "record_candidate": {
      const slot = locate(event.candidate.work_task_ref);
      requireState(slot, "building");
      if (!slot.build_assignment || slot.build_assignment.assignment_id !== event.assignment_id) {
        fail("work_task_candidate_assignment_mismatch", "candidate is not bound to the active Dev assignment");
      }
      if (!slot.build_assignment || slot.build_assignment.base_sha !== event.candidate.base_sha) {
        fail("work_task_candidate_base_mismatch", "candidate base is not the server-issued assignment base");
      }
      if (slot.candidate && slot.candidate.candidate_digest === event.candidate.candidate_digest) {
        fail("work_task_candidate_not_changed", "replacement candidate must be exact and new");
      }
      const from = slot.state;
      slot.candidate = clone(event.candidate);
      slot.state = "candidate_ready";
      slot.build_assignment = null;
      slot.review_assignment = null;
      // A replacement exact candidate retires any bounded local correction
      // authority.  Old review authority cannot survive because review is only
      // assigned from candidate_ready and is pinned to this digest.
      slot.correction = null;
      slot.blocked_from = null;
      effect(slot, from);
      break;
    }
    case "replace_candidate": {
      const slot = locate(event.candidate.work_task_ref);
      if (!slot.candidate || !new Set(["candidate_ready", "independent_review", "reconcile", "changes_requested", "accepted", "staged"]).has(slot.state)) {
        fail("invalid_work_task_pipeline_state", "candidate replacement is not valid in this state");
      }
      if (slot.candidate.base_sha !== event.candidate.base_sha) {
        fail("work_task_candidate_base_mismatch", "replacement candidate base is not the existing task base");
      }
      if (slot.candidate.candidate_digest === event.candidate.candidate_digest) fail("work_task_candidate_not_changed", "replacement candidate must be exact and new");
      const from = slot.state;
      slot.candidate = clone(event.candidate);
      slot.state = "candidate_ready";
      // An independently observed exact-candidate change atomically revokes
      // the prior review/correction authority before a new review may start.
      clearAuthority(slot);
      slot.blocked_from = null;
      effect(slot, from);
      break;
    }
    case "assign_independent_review": {
      if (archived) fail("work_task_archive_blocked", "archive blocks review assignment");
      if (!pipeline.manifest_frozen) fail("work_task_manifest_not_frozen", "review assignment requires frozen manifest");
      const slot = locate(event.work_task_ref);
      requireState(slot, "candidate_ready");
      ensureCandidate(slot, event.candidate_digest);
      const from = slot.state;
      slot.state = "independent_review";
      slot.review_assignment = { review_round_id: event.review_round_id, candidate_digest: event.candidate_digest, verdict: null };
      effect(slot, from);
      break;
    }
    case "record_review_verdict": {
      const slot = locate(event.work_task_ref);
      requireState(slot, "independent_review");
      ensureCandidate(slot, event.candidate_digest);
      if (!slot.review_assignment || slot.review_assignment.review_round_id !== event.review_round_id || slot.review_assignment.candidate_digest !== event.candidate_digest) {
        fail("stale_work_task_review_authority", "review round is not current");
      }
      const from = slot.state;
      slot.state = "reconcile";
      slot.review_assignment.verdict = event.verdict;
      effect(slot, from);
      break;
    }
    case "reconcile_review": {
      const slot = locate(event.work_task_ref);
      requireState(slot, "reconcile");
      ensureCandidate(slot, event.candidate_digest);
      if (!slot.review_assignment || slot.review_assignment.review_round_id !== event.review_round_id || slot.review_assignment.candidate_digest !== event.candidate_digest) {
        fail("stale_work_task_review_authority", "review round is not current");
      }
      const expected = slot.review_assignment.verdict === "approved" ? "accepted" : "changes_requested";
      if (event.resolution !== expected) fail("invalid_work_task_review_reconciliation", "resolution contradicts independent review verdict");
      const from = slot.state;
      slot.state = event.resolution;
      slot.review_assignment = null;
      effect(slot, from);
      break;
    }
    case "queue_local_correction": {
      const slot = locate(event.work_task_ref);
      requireState(slot, "changes_requested");
      if (slot.correction_count >= MAX_CHECKPOINTS) fail("work_task_checkpoint_limit", "local correction checkpoint limit reached");
      const from = slot.state;
      slot.state = "queued";
      slot.correction_count += 1;
      slot.correction = { checkpoint_id: event.checkpoint_id, count: slot.correction_count };
      effect(slot, from);
      break;
    }
    case "stage_candidate": {
      const slot = locate(event.work_task_ref);
      requireState(slot, "accepted");
      ensureCandidate(slot, event.candidate_digest);
      ensureNoCorrectionAuthority(slot);
      const from = slot.state;
      slot.state = "staged";
      effect(slot, from);
      break;
    }
    case "integrated_cut": {
      const indexByKey = new Map(tasks.map((slot, index) => [workTaskKey(slot.work_task_ref), index]));
      const selected = new Set();
      const cutByKey = new Map();
      let previousIndex = -1;
      for (const cut of event.tasks) {
        const slot = locate(cut.work_task_ref);
        const key = workTaskKey(slot.work_task_ref);
        const index = indexByKey.get(key);
        if (index <= previousIndex || selected.has(key)) fail("integrated_cut_order_invalid", "integrated cut must preserve manifest order");
        previousIndex = index;
        selected.add(key);
        cutByKey.set(key, cut);
      }
      // A cut advances the declared integrated sequence only through the last
      // accepted compatible task. Every earlier task must be included, already
      // cut, or explicitly deferred; a queued/reviewing task cannot be jumped.
      for (let index = 0; index <= previousIndex; index++) {
        const slot = tasks[index];
        const key = workTaskKey(slot.work_task_ref);
        const cut = cutByKey.get(key);
        if (!cut) {
          if (slot.state !== "staged" && slot.state !== "deferred" && slot.state !== "delivered") {
            fail("integrated_cut_prefix_incomplete", "cut skips an unresolved earlier manifest task");
          }
          continue;
        }
        requireState(slot, "accepted");
        ensureCandidate(slot, cut.candidate_digest);
        ensureNoCorrectionAuthority(slot);
      }
      for (const cut of event.tasks) {
        const slot = locate(cut.work_task_ref);
        for (const dependency of dependencyKeys(slot)) {
          const parent = tasks[indexByKey.get(dependency)];
          if (parent.state !== "staged" && parent.state !== "delivered" && !selected.has(dependency)) fail("integrated_cut_dependency_not_ready", "cut omits an un-staged dependency");
        }
        const from = slot.state;
        slot.state = "staged";
        effect(slot, from);
      }
      break;
    }
    case "set_archived":
      archived = event.archived;
      break;
    case "block": {
      const slot = locate(event.work_task_ref);
      const from = slot.state;
      if (!blockSlot(slot)) fail("invalid_work_task_pipeline_state", "task cannot be blocked from its current state");
      effect(slot, from);
      break;
    }
    case "unblock": {
      const slot = locate(event.work_task_ref);
      requireState(slot, "blocked");
      const from = slot.state;
      slot.state = slot.blocked_from;
      slot.blocked_from = null;
      effect(slot, from);
      break;
    }
    case "propagating_finding": {
      const source = locate(event.work_task_ref);
      if (!source.candidate || source.state === "blocked" || source.state === "deferred" || source.state === "delivered") fail("invalid_work_task_pipeline_state", "finding source is not an active candidate task");
      ensureCandidate(source, event.candidate_digest);
      const sourceFrom = source.state;
      source.state = "changes_requested";
      clearAuthority(source);
      source.blocked_from = null;
      effect(source, sourceFrom);
      const affected = dependentKeys(tasks, source.work_task_ref);
      affected.delete(workTaskKey(source.work_task_ref));
      // Iterate the declared manifest order. Only reverse-graph descendants are
      // paused; an unrelated task in another repository remains eligible.
      for (const slot of tasks) {
        if (!affected.has(workTaskKey(slot.work_task_ref))) continue;
        const from = slot.state;
        if (blockSlot(slot)) effect(slot, from);
      }
      break;
    }
    case "contract_change": {
      const source = locate(event.work_task_ref);
      if (source.work_task_ref.issue_body_revision === event.observed_issue_body_revision) {
        fail("work_task_contract_not_changed", "observed contract revision is still current");
      }
      const affected = dependentKeys(tasks, source.work_task_ref);
      // Contract changes do not create successors. They issue an immutable
      // defer/revocation plan for exactly the source and declared dependents.
      for (const slot of tasks) {
        if (!affected.has(workTaskKey(slot.work_task_ref)) || slot.state === "delivered") continue;
        const from = slot.state;
        slot.state = "deferred";
        slot.candidate = null;
        clearAuthority(slot);
        slot.blocked_from = null;
        effect(slot, from);
      }
      break;
    }
    default:
      fail("invalid_work_task_pipeline_event", "event kind is unsupported");
  }
  return { tasks, repositoryBases, archived, effects };
}

function precondition(pipeline) {
  return {
    pipeline_digest: pipeline.pipeline_digest,
    manifest_digest: pipeline.manifest_digest,
    history_length: pipeline.history.length,
    manifest_frozen: pipeline.manifest_frozen,
    archived: pipeline.archived,
  };
}
function assertPrecondition(value, code) {
  exact(value, ["pipeline_digest", "manifest_digest", "history_length", "manifest_frozen", "archived"], code);
  if (!SHA_RE.test(value.pipeline_digest) || !SHA_RE.test(value.manifest_digest) || !Number.isSafeInteger(value.history_length) || value.history_length < 0 || value.history_length > MAX_HISTORY || typeof value.manifest_frozen !== "boolean" || typeof value.archived !== "boolean") {
    fail(code, "plan precondition is invalid");
  }
  return value;
}
function assertEffects(effects, code) {
  if (!Array.isArray(effects) || effects.length > MAX_TASKS) fail(code, "plan effects are invalid");
  const seen = new Set();
  effects.forEach((entry) => {
    exact(entry, ["work_task_ref", "from_state", "to_state"], code);
    ref(entry.work_task_ref, code);
    if (!TASK_STATES.has(entry.from_state) || !TASK_STATES.has(entry.to_state)) fail(code, "plan effect state is invalid");
    const key = workTaskKey(entry.work_task_ref);
    if (seen.has(key)) fail(code, "plan effect task is duplicated");
    seen.add(key);
  });
  return effects;
}
function assertWorkTaskPipelinePlan(plan) {
  exact(plan, ["version", "transaction", "precondition", "event", "effects"], "invalid_work_task_pipeline_plan");
  if (plan.version !== VERSION || plan.transaction !== "work_task_pipeline") fail("invalid_work_task_pipeline_plan", "plan identity is invalid");
  assertPrecondition(plan.precondition, "invalid_work_task_pipeline_plan");
  if (!plain(plan.event)) fail("invalid_work_task_pipeline_plan", "plan event is invalid");
  assertEffects(plan.effects, "invalid_work_task_pipeline_plan");
  return plan;
}

function planWorkTaskPipelineEvent(pipeline, event) {
  assertWorkTaskPipeline(pipeline);
  const canonical = parseEvent(pipeline, event);
  if (pipeline.history.some((entry) => entry.event_id === canonical.event_id)) fail("duplicate_work_task_pipeline_event", "event was already applied");
  if (pipeline.history.length >= MAX_HISTORY) fail("work_task_pipeline_history_full", "pipeline history bound reached");
  const transition = deriveTransition(pipeline, canonical);
  return freeze({
    version: VERSION,
    transaction: "work_task_pipeline",
    precondition: precondition(pipeline),
    event: canonical,
    effects: transition.effects,
  });
}

// Declared transitive dependents of one task, in manifest order and without
// the source.  This is the server-derived dependency chain a pre-release
// propagation stop may pause; callers cannot widen or narrow it.
function declaredWorkTaskDependents(pipeline, taskRef) {
  assertWorkTaskPipeline(pipeline);
  const source = slotFor(pipeline.tasks, taskRef, "unknown_work_task_ref");
  const affected = dependentKeys(pipeline.tasks, source.work_task_ref);
  return freeze(pipeline.tasks
    .filter((slot) => slot !== source && affected.has(workTaskKey(slot.work_task_ref)))
    .map((slot) => clone(slot.work_task_ref)));
}

function samePlan(left, right) { return stable(left) === stable(right); }
function applyWorkTaskPipelinePlan(pipeline, plan) {
  assertWorkTaskPipeline(pipeline);
  assertWorkTaskPipelinePlan(plan);
  const expected = planWorkTaskPipelineEvent(pipeline, plan.event);
  if (!samePlan(expected, plan)) fail("stale_or_tampered_work_task_pipeline_plan", "plan is not valid for the current pipeline");
  const transition = deriveTransition(pipeline, expected.event);
  const tasks = transition.tasks;
  const byKey = new Map(tasks.map((slot) => [workTaskKey(slot.work_task_ref), slot]));
  for (const effect of expected.effects) {
    byKey.get(workTaskKey(effect.work_task_ref)).history.push({ event_id: expected.event.event_id, kind: expected.event.kind });
  }
  const next = withDigest({
    version: VERSION,
    manifest_digest: pipeline.manifest_digest,
    manifest_frozen: pipeline.manifest_frozen,
    archived: transition.archived,
    repository_bases: transition.repositoryBases,
    history: [...pipeline.history, { event_id: expected.event.event_id, kind: expected.event.kind }],
    tasks,
    ...(Object.hasOwn(pipeline, "deliveries") ? { deliveries: clone(pipeline.deliveries) } : {}),
  });
  assertWorkTaskPipeline(next);
  return next;
}

module.exports = {
  VERSION,
  WorkTaskPipelineError,
  TASK_STATES: freeze([...TASK_STATES]),
  assertWorkTaskPipeline,
  assertWorkTaskPipelinePlan,
  buildWorkTaskPipeline,
  declaredWorkTaskDependents,
  currentDeliveryCut,
  applyWorkTaskPipelineDelivery,
  planWorkTaskPipelineEvent,
  applyWorkTaskPipelinePlan,
};
