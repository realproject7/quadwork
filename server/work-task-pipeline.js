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

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
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
const DEPENDENCY_READY_STATES = new Set(["accepted", "staged"]);
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
    history: pipeline.history,
    tasks: pipeline.tasks,
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
function assertCorrection(value, currentCandidate, state, code) {
  if (value === null) return null;
  exact(value, ["checkpoint_id", "count"], code);
  identifier(value.checkpoint_id, code);
  if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > MAX_CHECKPOINTS) fail(code, "correction checkpoint is invalid");
  if (!currentCandidate || (state !== "queued" && state !== "building")) fail(code, "correction checkpoint is inactive");
  return value;
}
function assertSlot(slot, code) {
  exact(slot, ["work_task_ref", "dependency_refs", "file_boundary", "state", "candidate", "build_assignment", "review_assignment", "correction", "blocked_from", "history"], code);
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
  const requiresCandidate = new Set(["candidate_ready", "independent_review", "reconcile", "changes_requested", "accepted", "staged"]);
  if (requiresCandidate.has(slot.state) && slot.candidate === null) fail(code, "state requires an exact candidate");
  if (slot.state === "deferred" && slot.candidate !== null) fail(code, "deferred task retains candidate authority");
  if (slot.build_assignment === null) {
    if (slot.state === "building") fail(code, "building task lacks assignment");
  } else {
    assertAssignment(slot.build_assignment, code);
    if (slot.state !== "building") fail(code, "build assignment is not active in this state");
  }
  assertReviewAssignment(slot.review_assignment, slot.candidate, slot.state, code);
  assertCorrection(slot.correction, slot.candidate, slot.state, code);
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
    if (!EVENT_KINDS.has(entry.kind)) fail(code, "task history kind is invalid");
  });
  return slot;
}

function assertWorkTaskPipeline(pipeline) {
  exact(pipeline, ["version", "manifest_digest", "manifest_frozen", "archived", "history", "tasks", "pipeline_digest"], "invalid_work_task_pipeline");
  if (pipeline.version !== VERSION || !SHA_RE.test(pipeline.manifest_digest) || typeof pipeline.manifest_frozen !== "boolean" || typeof pipeline.archived !== "boolean" ||
      !Array.isArray(pipeline.tasks) || pipeline.tasks.length === 0 || pipeline.tasks.length > MAX_TASKS || !Array.isArray(pipeline.history) || pipeline.history.length > MAX_HISTORY || !SHA_RE.test(pipeline.pipeline_digest)) {
    fail("invalid_work_task_pipeline", "pipeline shape is invalid");
  }
  const tasks = pipeline.tasks.map((slot) => assertSlot(slot, "invalid_work_task_pipeline"));
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
    if (!EVENT_KINDS.has(entry.kind) || historyIds.has(entry.event_id)) fail("invalid_work_task_pipeline", "pipeline history is invalid or duplicated");
    historyIds.add(entry.event_id);
  });
  if (pipeline.pipeline_digest !== pipelineDigest(pipeline)) fail("invalid_work_task_pipeline", "pipeline digest mismatch");
  return pipeline;
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
    blocked_from: null,
    history: [],
  }));
  return withDigest({
    version: VERSION,
    manifest_digest: manifest.manifest_digest,
    manifest_frozen: manifest.frozen !== null,
    archived: normalizedOptions.archived,
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
      exact(event, ["version", "kind", "event_id", "candidate"], code);
      if (event.version !== VERSION) fail(code, "event version is invalid");
      candidate(event.candidate, code);
      return { version: VERSION, kind: event.kind, event_id: identifier(event.event_id, code), candidate: clone(event.candidate) };
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
  if (slot.state === "deferred") return false;
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
      const previous = slot.correction ? slot.correction.count : 0;
      if (previous >= MAX_CHECKPOINTS) fail("work_task_checkpoint_limit", "local correction checkpoint limit reached");
      const from = slot.state;
      slot.state = "queued";
      slot.correction = { checkpoint_id: event.checkpoint_id, count: previous + 1 };
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
          if (slot.state !== "staged" && slot.state !== "deferred") {
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
          if (parent.state !== "staged" && !selected.has(dependency)) fail("integrated_cut_dependency_not_ready", "cut omits an un-staged dependency");
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
      if (!source.candidate || source.state === "blocked" || source.state === "deferred") fail("invalid_work_task_pipeline_state", "finding source is not an active candidate task");
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
        if (!affected.has(workTaskKey(slot.work_task_ref))) continue;
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
  return { tasks, archived, effects };
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
    history: [...pipeline.history, { event_id: expected.event.event_id, kind: expected.event.kind }],
    tasks,
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
  planWorkTaskPipelineEvent,
  applyWorkTaskPipelinePlan,
};
