"use strict";

// #1060 M5: collect the exact server-held local provenance for one
// repository's staged Delivery Candidate.  This is deliberately a read-only
// seam: it does not select a result SHA, create an integration worktree,
// compose a tree, persist a Delivery Candidate, or publish anything.

const { workTaskKey } = require("./work-task-manifest");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
const { expectedCandidateBase } = require("./delivery-candidate");
const { currentDeliveryCut } = require("./work-task-pipeline");

const VERSION = 1;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;

class WorkTaskDeliverySourceError extends Error {
  constructor(code, message = code) { super(message); this.name = "WorkTaskDeliverySourceError"; this.code = code; }
}
function fail(code, message) { throw new WorkTaskDeliverySourceError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function clone(value) {
  return Array.isArray(value) ? value.map(clone) : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function request(value) {
  exact(value, ["version", "installation_id", "project_id", "repository_key"], "invalid_work_task_delivery_source_request");
  if (value.version !== VERSION || typeof value.installation_id !== "string" || typeof value.project_id !== "string" ||
      !REPOSITORY_KEY_RE.test(value.repository_key)) {
    fail("invalid_work_task_delivery_source_request", "delivery source request is invalid");
  }
  return freeze({ installation_id: value.installation_id, project_id: value.project_id, repository_key: value.repository_key });
}
function options(value) {
  exact(value, ["config_dir", "fs", "read_registered_repository"], "invalid_work_task_delivery_source_options");
  if (typeof value.config_dir !== "string" || !value.fs || typeof value.read_registered_repository !== "function") {
    fail("invalid_work_task_delivery_source_options", "delivery source dependencies are invalid");
  }
  return value;
}
function repository(value, owner) {
  exact(value, ["version", "installation_id", "project_id", "repository_key", "repository"], "work_task_delivery_repository_unavailable");
  if (value.version !== VERSION || value.installation_id !== owner.installation_id || value.project_id !== owner.project_id ||
      !REPOSITORY_KEY_RE.test(value.repository_key) || typeof value.repository !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.repository)) {
    fail("work_task_delivery_repository_unavailable", "registered delivery repository is unavailable");
  }
  return freeze(clone(value));
}
function selectedEntries(snapshot, key) {
  const slots = new Map(snapshot.pipeline.tasks.map((slot) => [workTaskKey(slot.work_task_ref), slot]));
  if (!snapshot.manifest.tasks.some((entry) => entry.ref.repository_key === key)) fail("work_task_delivery_repository_unavailable", "batch has no task for this registered repository");
  let cut;
  try { cut = currentDeliveryCut(snapshot.pipeline, key, snapshot.manifest.delivery_mode); }
  catch (error) { rethrow(error, "work_task_delivery_cut_unavailable"); }
  const selected = cut.work_task_refs.map((taskRef) => ({ work_task_ref: clone(taskRef), candidate: clone(slots.get(workTaskKey(taskRef)).candidate) }));
  const selectedKeys = new Set(selected.map((entry) => workTaskKey(entry.work_task_ref)));
  const deliveries = snapshot.pipeline.deliveries || [];
  const delivered = new Map(deliveries.flatMap((record) => record.work_task_refs.map((taskRef) => [workTaskKey(taskRef), record])));
  for (const entry of selected) {
    const slot = slots.get(workTaskKey(entry.work_task_ref));
    if (slot.dependency_refs.some((dependency) => !selectedKeys.has(workTaskKey(dependency)) && !delivered.has(workTaskKey(dependency)))) {
      fail("work_task_delivery_dependency_unavailable", "staged dependency lacks current-cut or delivered provenance");
    }
  }
  const root = snapshot.pipeline.repository_bases.find((entry) => entry.repository_key === key);
  const candidates = selected.map((entry) => entry.candidate);
  if (!root || selected.some((entry) => entry.candidate.base_sha !== expectedCandidateBase(snapshot.manifest.tasks, candidates, entry.candidate, root.base_sha, deliveries))) {
    fail("work_task_delivery_base_mismatch", "staged repository candidates do not chain from the current repository base");
  }
  const deferred_exclusions = snapshot.manifest.tasks.filter((entry) => !selectedKeys.has(workTaskKey(entry.ref))).map((entry) => {
    const slot = slots.get(workTaskKey(entry.ref));
    const record = delivered.get(workTaskKey(entry.ref));
    if (record) return { work_task_ref: clone(entry.ref), reason: "already_delivered", delivery: clone(record) };
    return { work_task_ref: clone(entry.ref), reason: entry.ref.repository_key !== key ? "separate_repository_delivery_candidate"
      : slot.state === "deferred" ? "explicitly_deferred" : "safe_cut_deferred" };
  });
  return { selected, base_sha: root.base_sha, cut_id: cut.cut_id, deferred_exclusions };
}

function rethrow(error, fallback) {
  if (error instanceof WorkTaskDeliverySourceError) throw error;
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code) ? error.code : fallback;
  fail(code, fallback);
}

function createWorkTaskDeliverySource(value) {
  const deps = options(value);
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: deps.config_dir, fs: deps.fs });
  const roundStore = createTaskReviewRoundStore({ rootDir: deps.config_dir, fsImpl: deps.fs });
  function readStagedSource(value) {
    const input = request(value);
    const owner = { installation_id: input.installation_id, project_id: input.project_id };
    let snapshot;
    try { snapshot = pipelineStore.readRecoverySnapshot(owner); }
    catch (error) { rethrow(error, "work_task_delivery_pipeline_unavailable"); }
    if (snapshot.pipeline.archived) fail("work_task_archive_blocked", "archived pipeline cannot prepare delivery");
    if (!snapshot.manifest.frozen || snapshot.pipeline.manifest_frozen !== true) {
      fail("work_task_delivery_batch_not_frozen", "delivery requires a frozen WorkTask batch");
    }
    const { selected, base_sha, cut_id, deferred_exclusions } = selectedEntries(snapshot, input.repository_key);
    let registered;
    try {
      registered = repository(deps.read_registered_repository(freeze({ version: VERSION, ...owner, repository_key: input.repository_key })), owner);
    } catch (error) { rethrow(error, "work_task_delivery_repository_unavailable"); }
    if (registered.repository_key !== input.repository_key) fail("work_task_delivery_repository_unavailable", "registered repository identity is mismatched");
    const staged_tasks = selected.map((entry) => {
      let terminal_review;
      try {
        terminal_review = roundStore.readReleasedForDelivery({
          version: VERSION, work_task_ref: clone(entry.work_task_ref), candidate_digest: entry.candidate.candidate_digest,
        });
      } catch (error) { rethrow(error, "work_task_delivery_review_unavailable"); }
      return { candidate: clone(entry.candidate), terminal_review: clone(terminal_review) };
    });
    return freeze({
      version: VERSION,
      registered_repository: registered,
      frozen_batch_manifest: clone(snapshot.manifest),
      delivery_mode: snapshot.manifest.delivery_mode,
      cut_id,
      base_sha,
      staged_tasks,
      deferred_exclusions,
    });
  }
  return freeze({ readStagedSource });
}

module.exports = {
  VERSION,
  WorkTaskDeliverySourceError,
  createWorkTaskDeliverySource,
};
