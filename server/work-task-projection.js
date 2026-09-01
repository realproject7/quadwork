"use strict";

// #1058 M7: deterministic, read-only projection for the nested Current Batch
// surface. It receives already-validated durable manifest/pipeline state and
// emits display data only; it cannot infer tasks, alter queue state, disclose
// local worktree paths, or create a delivery/publication action.

const { assertBatchManifest, workTaskKey } = require("./work-task-manifest");
const { assertWorkTaskPipeline } = require("./work-task-pipeline");

const VERSION = 1;

class WorkTaskProjectionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "WorkTaskProjectionError";
    this.code = code;
  }
}

function fail(code, message) { throw new WorkTaskProjectionError(code, message); }
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
function workItemKey(value) {
  return JSON.stringify([value.repoKey, value.repo, value.number, value.kind]);
}
function candidateProjection(candidate) {
  if (candidate === null) return null;
  return {
    candidate_digest: candidate.candidate_digest,
    base_sha: candidate.base_sha,
    candidate_sha: candidate.candidate_sha,
  };
}
function taskProjection(entry, slot) {
  return {
    work_task_ref: clone(entry.ref),
    task_key: entry.contract.task_key,
    goal: entry.contract.goal,
    file_boundary: [...entry.contract.file_boundary],
    validation: [...entry.contract.validation],
    state: slot.state,
    candidate: candidateProjection(slot.candidate),
  };
}

function projectWorkTaskBatch(input) {
  exact(input, ["version", "manifest", "pipeline"], "invalid_work_task_projection_request");
  if (input.version !== VERSION) fail("invalid_work_task_projection_request", "projection version is invalid");
  let manifest;
  let pipeline;
  try { assertBatchManifest(input.manifest); manifest = input.manifest; }
  catch { fail("invalid_work_task_projection_request", "manifest is invalid"); }
  try { pipeline = assertWorkTaskPipeline(input.pipeline); }
  catch { fail("invalid_work_task_projection_request", "pipeline is invalid"); }
  if (pipeline.manifest_digest !== manifest.manifest_digest || pipeline.manifest_frozen !== (manifest.frozen !== null)) {
    fail("work_task_projection_manifest_mismatch", "pipeline does not belong to this exact manifest");
  }
  const slots = new Map(pipeline.tasks.map((slot) => [workTaskKey(slot.work_task_ref), slot]));
  if (slots.size !== manifest.tasks.length || manifest.tasks.some((entry) => !slots.has(workTaskKey(entry.ref)))) {
    fail("work_task_projection_manifest_mismatch", "manifest and pipeline task identities differ");
  }
  const bases = new Map(pipeline.repository_bases.map((entry) => [entry.repository_key, entry.base_sha]));
  const repositories = [];
  const repositoriesByKey = new Map();
  for (const entry of manifest.tasks) {
    const repositoryKey = entry.ref.repository_key;
    let repository = repositoriesByKey.get(repositoryKey);
    if (!repository) {
      repository = { repository_key: repositoryKey, base_sha: bases.get(repositoryKey) || null, work_items: [] };
      repositoriesByKey.set(repositoryKey, repository);
      repositories.push(repository);
    }
    const itemKey = workItemKey(entry.ref.work_item);
    let item = repository.work_items.find((candidate) => candidate._key === itemKey);
    if (!item) {
      item = {
        _key: itemKey,
        work_item: clone(entry.ref.work_item),
        issue_body_revision: entry.ref.issue_body_revision,
        tasks: [],
      };
      repository.work_items.push(item);
    }
    item.tasks.push(taskProjection(entry, slots.get(workTaskKey(entry.ref))));
  }
  const projection = {
    version: VERSION,
    batch_manifest_digest: manifest.manifest_digest,
    delivery_mode: manifest.delivery_mode,
    frozen: manifest.frozen !== null,
    repositories: repositories.map((repository) => ({
      repository_key: repository.repository_key,
      base_sha: repository.base_sha,
      work_items: repository.work_items.map((item) => ({
        work_item: item.work_item,
        issue_body_revision: item.issue_body_revision,
        tasks: item.tasks,
      })),
    })),
  };
  return freeze(projection);
}

module.exports = {
  VERSION,
  WorkTaskProjectionError,
  projectWorkTaskBatch,
};
