"use strict";

// #1058 M1: a deliberately closed, pure Ticket → WorkTask → frozen Batch
// Manifest contract.  This module does not read config/queue/chat/Git/GitHub,
// create candidates, or schedule work.  The sole server integration seam is
// an injected registered-identity accessor; callers cannot supply an issue
// body digest, task revision, or authority through display prose.

const crypto = require("crypto");
const { assertWorkItemRef, workItemKey } = require("./work-item-ref");

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const REPO_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TASK_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@+~=-]{1,240}$/;
const VALIDATION_RE = /^[a-z][a-z0-9_.:-]{0,95}$/;
const DELIVERY_MODES = new Set(["integrated", "isolated"]);
const TRANSITIONS = new Set(["cut", "defer", "contract_change"]);
const MAX_TASKS = 64;
const MAX_DEPENDENCIES = 32;
const MAX_HISTORY = 128;

class WorkTaskManifestError extends Error {
  constructor(code, message = code) { super(message); this.name = "WorkTaskManifestError"; this.code = code; }
}
function fail(code, message) { throw new WorkTaskManifestError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code = "invalid_work_task_manifest") {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(code, "unknown or missing field");
}
function clone(value) { return Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value) ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value); }
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function timestamp(value) { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail("invalid_work_task_timestamp", "timestamp is invalid"); return new Date(value).toISOString(); }
function text(value, code, max) { if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000\r\n]/.test(value)) fail(code, "text is invalid"); return value; }

function locator(value) {
  exact(value, ["repository_key", "work_item", "task_key"], "invalid_work_task_dependency");
  if (!REPO_KEY_RE.test(value.repository_key) || !TASK_KEY_RE.test(value.task_key)) fail("invalid_work_task_dependency", "dependency identity is invalid");
  try { assertWorkItemRef(value.work_item); } catch { fail("invalid_work_task_dependency", "dependency work item is invalid"); }
  if (value.work_item.repoKey !== value.repository_key) fail("invalid_work_task_dependency", "dependency repository does not match item");
  return { repository_key: value.repository_key, work_item: clone(value.work_item), task_key: value.task_key };
}
function locatorKey(value) { const loc = locator(value); return JSON.stringify(["work-task-locator", VERSION, loc.repository_key, workItemKey(loc.work_item), loc.task_key]); }
function taskLocator(task) {
  return { repository_key: task.repository_key, work_item: task.work_item, task_key: task.task_key };
}
function taskLocatorKey(task) { return locatorKey(taskLocator(task)); }
function assertRef(value) {
  exact(value, ["version", "installation_id", "project_id", "repository_key", "work_item", "issue_body_revision", "task_key", "task_revision"], "invalid_work_task_ref");
  if (value.version !== VERSION || !INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id) ||
      !REPO_KEY_RE.test(value.repository_key) || !SHA_RE.test(value.issue_body_revision) || !TASK_KEY_RE.test(value.task_key) || !SHA_RE.test(value.task_revision)) {
    fail("invalid_work_task_ref", "work task reference is invalid");
  }
  try { assertWorkItemRef(value.work_item); } catch { fail("invalid_work_task_ref", "work task work item is invalid"); }
  if (value.work_item.repoKey !== value.repository_key) fail("invalid_work_task_ref", "work task repository does not match item");
  return value;
}
function workTaskKey(ref) { assertRef(ref); return JSON.stringify(["work-task-ref", VERSION, ref.installation_id, ref.project_id, ref.repository_key, workItemKey(ref.work_item), ref.issue_body_revision, ref.task_key, ref.task_revision]); }

function registeredIdentity(accessor, input) {
  if (typeof accessor !== "function") fail("registered_identity_accessor_required", "server identity accessor is required");
  let value;
  try { value = accessor(freeze(clone(input))); } catch { fail("registered_identity_unavailable", "registered identity accessor failed"); }
  exact(value, ["installation_id", "project_id", "repository_key", "work_item", "issue_body_revision"], "registered_identity_invalid");
  if (value.installation_id !== input.installation_id || value.project_id !== input.project_id || value.repository_key !== input.repository_key || !SHA_RE.test(value.issue_body_revision)) {
    fail("registered_identity_mismatch", "registered identity does not match task source");
  }
  try { assertWorkItemRef(value.work_item); } catch { fail("registered_identity_invalid", "registered work item is invalid"); }
  if (workItemKey(value.work_item) !== workItemKey(input.work_item) || value.work_item.repoKey !== value.repository_key) {
    fail("registered_identity_mismatch", "registered work item does not match task source");
  }
  return { issue_body_revision: value.issue_body_revision };
}

function sourceTask(value) {
  exact(value, ["task_key", "repository_key", "work_item", "goal", "file_boundary", "validation", "dependencies"], "invalid_work_task_contract");
  if (!TASK_KEY_RE.test(value.task_key) || !REPO_KEY_RE.test(value.repository_key)) fail("invalid_work_task_contract", "task key or repository key is invalid");
  try { assertWorkItemRef(value.work_item); } catch { fail("invalid_work_task_contract", "task work item is invalid"); }
  if (value.work_item.kind !== "issue" || value.work_item.repoKey !== value.repository_key) fail("invalid_work_task_contract", "task source item is invalid");
  const goal = text(value.goal, "invalid_work_task_goal", 1000);
  if (!Array.isArray(value.file_boundary) || value.file_boundary.length > 32 || !value.file_boundary.every((entry) => typeof entry === "string" && PATH_RE.test(entry))) fail("invalid_work_task_boundary", "file boundary is invalid");
  if (new Set(value.file_boundary).size !== value.file_boundary.length) fail("duplicate_work_task_boundary", "file boundary is duplicated");
  if (!Array.isArray(value.validation) || value.validation.length > 16 || !value.validation.every((entry) => typeof entry === "string" && VALIDATION_RE.test(entry))) fail("invalid_work_task_validation", "validation is invalid");
  if (new Set(value.validation).size !== value.validation.length) fail("duplicate_work_task_validation", "validation is duplicated");
  if (!Array.isArray(value.dependencies) || value.dependencies.length > MAX_DEPENDENCIES) fail("invalid_work_task_dependency", "dependencies are invalid");
  const dependencies = value.dependencies.map(locator);
  if (new Set(dependencies.map(locatorKey)).size !== dependencies.length) fail("duplicate_work_task_dependency", "dependency is duplicated");
  return { task_key: value.task_key, repository_key: value.repository_key, work_item: clone(value.work_item), goal, file_boundary: [...value.file_boundary], validation: [...value.validation], dependencies };
}

function canonicalTaskContract(task, identity, dependencies) {
  return {
    version: VERSION, repository_key: task.repository_key, work_item: clone(task.work_item), issue_body_revision: identity.issue_body_revision,
    task_key: task.task_key, goal: task.goal, file_boundary: [...task.file_boundary], validation: [...task.validation],
    // Dependencies are exact immutable WorkTaskRefs. The source locators are
    // only a server-authored construction input and are not exposed as a
    // substitute for a qualified task identity.
    dependencies: dependencies.map(clone).sort((left, right) => workTaskKey(left).localeCompare(workTaskKey(right))),
  };
}

function validateGraph(tasks) {
  const byKey = new Map(tasks.map((task) => [taskLocatorKey(task), task]));
  for (const task of tasks) for (const dependency of task.dependencies) {
    if (!byKey.has(locatorKey(dependency))) fail("unknown_work_task_dependency", "dependency does not exist in manifest");
  }
  const visiting = new Set(), visited = new Set();
  function visit(key) {
    if (visiting.has(key)) fail("cyclic_work_task_dependency", "task dependency cycle detected");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key).dependencies) visit(locatorKey(dependency));
    visiting.delete(key); visited.add(key);
  }
  for (const key of byKey.keys()) visit(key);
  return byKey;
}

function manifestDigest(manifest) {
  return hash({ version: manifest.version, installation_id: manifest.installation_id, project_id: manifest.project_id,
    delivery_mode: manifest.delivery_mode, tasks: manifest.tasks.map((task) => task.ref), });
}

function assertContractEntry(entry) {
  exact(entry, ["ref", "contract"], "invalid_batch_manifest");
  const ref = entry.ref;
  assertRef(ref);
  const contract = entry.contract;
  exact(contract, ["version", "repository_key", "work_item", "issue_body_revision", "task_key", "goal", "file_boundary", "validation", "dependencies"], "invalid_batch_manifest");
  if (contract.version !== VERSION || contract.repository_key !== ref.repository_key || contract.issue_body_revision !== ref.issue_body_revision || contract.task_key !== ref.task_key) {
    fail("invalid_batch_manifest", "task contract identity does not match reference");
  }
  try { assertWorkItemRef(contract.work_item); } catch { fail("invalid_batch_manifest", "task contract work item is invalid"); }
  if (workItemKey(contract.work_item) !== workItemKey(ref.work_item)) fail("invalid_batch_manifest", "task contract work item does not match reference");
  text(contract.goal, "invalid_batch_manifest", 1000);
  if (!Array.isArray(contract.file_boundary) || contract.file_boundary.length > 32 || !contract.file_boundary.every((entry) => typeof entry === "string" && PATH_RE.test(entry)) || new Set(contract.file_boundary).size !== contract.file_boundary.length) {
    fail("invalid_batch_manifest", "task contract boundary is invalid");
  }
  if (!Array.isArray(contract.validation) || contract.validation.length > 16 || !contract.validation.every((entry) => typeof entry === "string" && VALIDATION_RE.test(entry)) || new Set(contract.validation).size !== contract.validation.length) {
    fail("invalid_batch_manifest", "task contract validation is invalid");
  }
  if (!Array.isArray(contract.dependencies) || contract.dependencies.length > MAX_DEPENDENCIES) fail("invalid_batch_manifest", "task contract dependencies are invalid");
  for (const dependency of contract.dependencies) assertRef(dependency);
  if (new Set(contract.dependencies.map(workTaskKey)).size !== contract.dependencies.length) fail("invalid_batch_manifest", "task contract dependency is duplicated");
  if (hash(contract) !== ref.task_revision) fail("invalid_batch_manifest", "task contract revision does not match reference");
  return entry;
}
function assertHistory(manifest, tasks) {
  const taskKeys = new Set(tasks.map((task) => workTaskKey(task.ref)));
  if (manifest.history.length === 0) {
    if (manifest.frozen) fail("invalid_batch_manifest", "frozen manifest is missing freeze history");
    return;
  }
  manifest.history.forEach((entry, index) => {
    if (index === 0) {
      exact(entry, ["type", "at"], "invalid_batch_manifest");
      if (entry.type !== "freeze" || !manifest.frozen || timestamp(entry.at) !== manifest.frozen.at) fail("invalid_batch_manifest", "freeze history is invalid");
      return;
    }
    exact(entry, ["type", "at", "reason", "tasks"], "invalid_batch_manifest");
    if (!TRANSITIONS.has(entry.type) || !Array.isArray(entry.tasks) || entry.tasks.length === 0 || entry.tasks.length > MAX_TASKS) fail("invalid_batch_manifest", "transition history is invalid");
    timestamp(entry.at);
    text(entry.reason, "invalid_batch_manifest", 160);
    const keys = entry.tasks.map((ref) => { assertRef(ref); return workTaskKey(ref); });
    if (new Set(keys).size !== keys.length || keys.some((key) => !taskKeys.has(key))) fail("invalid_batch_manifest", "transition history reference is invalid");
  });
}

function buildBatchManifest(input, options = {}) {
  exact(input, ["version", "installation_id", "project_id", "delivery_mode", "tasks"], "invalid_batch_manifest");
  if (input.version !== VERSION || !INSTALLATION_RE.test(input.installation_id) || !PROJECT_RE.test(input.project_id) || !DELIVERY_MODES.has(input.delivery_mode) ||
      !Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > MAX_TASKS) fail("invalid_batch_manifest", "batch manifest source is invalid");
  const tasks = input.tasks.map(sourceTask);
  const taskKeys = new Set();
  for (const task of tasks) { const key = taskLocatorKey(task); if (taskKeys.has(key)) fail("duplicate_work_task_key", "task key is duplicated within source work item"); taskKeys.add(key); }
  const byLocator = validateGraph(tasks);
  const identities = new Map(tasks.map((task) => [taskLocatorKey(task), registeredIdentity(options.resolveRegisteredIdentity, {
    installation_id: input.installation_id, project_id: input.project_id, repository_key: task.repository_key, work_item: task.work_item,
  })]));
  const resolved = new Map();
  function resolveTask(task) {
    const key = taskLocatorKey(task);
    if (resolved.has(key)) return resolved.get(key);
    const dependencyRefs = task.dependencies.map((dependency) => resolveTask(byLocator.get(locatorKey(dependency))).ref);
    const identity = identities.get(key);
    const contract = canonicalTaskContract(task, identity, dependencyRefs);
    const entry = {
      task,
      identity,
      ref: {
        version: VERSION,
        installation_id: input.installation_id,
        project_id: input.project_id,
        repository_key: task.repository_key,
        work_item: clone(task.work_item),
        issue_body_revision: identity.issue_body_revision,
        task_key: task.task_key,
        task_revision: hash(contract),
      },
      contract,
    };
    resolved.set(key, entry);
    return entry;
  }
  const ordered = tasks.map(resolveTask);
  const manifest = {
    version: VERSION, installation_id: input.installation_id, project_id: input.project_id, delivery_mode: input.delivery_mode,
    frozen: null, history: [], tasks: ordered.map((entry) => freeze({ ref: entry.ref, contract: entry.contract })),
  };
  return freeze({ ...manifest, manifest_digest: manifestDigest(manifest) });
}

function assertManifest(manifest) {
  exact(manifest, ["version", "installation_id", "project_id", "delivery_mode", "frozen", "history", "tasks", "manifest_digest"], "invalid_batch_manifest");
  if (manifest.version !== VERSION || !INSTALLATION_RE.test(manifest.installation_id) || !PROJECT_RE.test(manifest.project_id) || !DELIVERY_MODES.has(manifest.delivery_mode) ||
      !Array.isArray(manifest.tasks) || manifest.tasks.length === 0 || manifest.tasks.length > MAX_TASKS || !Array.isArray(manifest.history) || manifest.history.length > MAX_HISTORY || !SHA_RE.test(manifest.manifest_digest)) fail("invalid_batch_manifest", "manifest is invalid");
  if (manifest.frozen !== null) { exact(manifest.frozen, ["at"], "invalid_batch_manifest"); timestamp(manifest.frozen.at); }
  const tasks = manifest.tasks.map(assertContractEntry);
  const taskKeys = new Set(tasks.map((entry) => workTaskKey(entry.ref)));
  if (taskKeys.size !== tasks.length) fail("invalid_batch_manifest", "manifest task is duplicated");
  for (const entry of tasks) {
    for (const dependency of entry.contract.dependencies) {
      if (!taskKeys.has(workTaskKey(dependency))) fail("invalid_batch_manifest", "task dependency is absent from manifest");
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(key) {
    if (visiting.has(key)) fail("invalid_batch_manifest", "task dependency cycle is invalid");
    if (visited.has(key)) return;
    visiting.add(key);
    const task = tasks.find((entry) => workTaskKey(entry.ref) === key);
    for (const dependency of task.contract.dependencies) visit(workTaskKey(dependency));
    visiting.delete(key); visited.add(key);
  }
  for (const key of taskKeys) visit(key);
  assertHistory(manifest, tasks);
  if (manifest.manifest_digest !== manifestDigest(manifest)) fail("invalid_batch_manifest", "manifest digest mismatch");
  return tasks;
}
function freezeBatchManifest(manifest, at) {
  assertManifest(manifest); if (manifest.frozen) return freeze(clone(manifest));
  const next = clone(manifest); next.frozen = { at: timestamp(at) }; next.history.push({ type: "freeze", at: next.frozen.at });
  return freeze(next);
}
function assertManifestRegisteredCurrent(manifest, options = {}) {
  const tasks = assertManifest(manifest);
  for (const entry of tasks) {
    const current = registeredIdentity(options.resolveRegisteredIdentity, {
      installation_id: entry.ref.installation_id,
      project_id: entry.ref.project_id,
      repository_key: entry.ref.repository_key,
      work_item: entry.ref.work_item,
    });
    if (current.issue_body_revision !== entry.ref.issue_body_revision) {
      fail("stale_work_task_contract", "registered issue contract revision changed");
    }
  }
  return true;
}
function taskRefFor(manifest, reference) {
  assertRef(reference);
  const key = workTaskKey(reference);
  const entry = assertManifest(manifest).find((task) => workTaskKey(task.ref) === key);
  if (!entry) fail("unknown_work_task_ref", "work task reference is not in manifest");
  return entry.ref;
}
function planManifestTransition(manifest, request) {
  assertManifest(manifest);
  exact(request, ["type", "tasks", "reason", "archived"], "invalid_work_task_transition");
  if (!TRANSITIONS.has(request.type) || typeof request.archived !== "boolean" || !Array.isArray(request.tasks) || request.tasks.length === 0 || request.tasks.length > MAX_TASKS || typeof request.reason !== "string" || request.reason.length === 0 || request.reason.length > 160 || /[\r\n\u0000]/.test(request.reason)) fail("invalid_work_task_transition", "transition is invalid");
  if (request.archived) fail("work_task_archive_blocked", "archive blocks task transition planning");
  if (!manifest.frozen) fail("work_task_manifest_not_frozen", "transitions require a frozen manifest");
  const refs = request.tasks.map((entry) => clone(taskRefFor(manifest, entry)));
  if (new Set(refs.map(workTaskKey)).size !== refs.length) fail("duplicate_work_task_transition", "transition task is duplicated");
  return freeze({ version: VERSION, type: request.type, manifest_digest: manifest.manifest_digest, tasks: refs, reason: request.reason, history_index: manifest.history.length });
}
function applyManifestTransition(manifest, plan, at) {
  assertManifest(manifest); exact(plan, ["version", "type", "manifest_digest", "tasks", "reason", "history_index"], "invalid_work_task_transition");
  if (plan.version !== VERSION || !TRANSITIONS.has(plan.type) || plan.manifest_digest !== manifest.manifest_digest || !Number.isSafeInteger(plan.history_index) || plan.history_index !== manifest.history.length || !Array.isArray(plan.tasks) || plan.tasks.length === 0 || plan.tasks.length > MAX_TASKS || typeof plan.reason !== "string" || plan.reason.length === 0 || plan.reason.length > 160 || /[\r\n\u0000]/.test(plan.reason)) fail("invalid_work_task_transition", "transition plan is stale or invalid");
  if (manifest.history.length >= MAX_HISTORY) fail("work_task_history_full", "manifest history bound reached");
  const keys = plan.tasks.map((ref) => workTaskKey(taskRefFor(manifest, ref)));
  if (new Set(keys).size !== keys.length) fail("duplicate_work_task_transition", "transition task is duplicated");
  const next = clone(manifest); next.history.push({ type: plan.type, at: timestamp(at), reason: plan.reason, tasks: plan.tasks.map(clone) });
  return freeze(next);
}
function adaptLegacyFlatCodeBatch(input, options = {}) {
  exact(input, ["version", "installation_id", "project_id", "delivery_mode", "work_items"], "invalid_legacy_code_batch");
  if (input.version !== VERSION || !Array.isArray(input.work_items) || input.work_items.length === 0 || input.work_items.length > MAX_TASKS) fail("invalid_legacy_code_batch", "legacy code batch is invalid");
  const seen = new Set();
  const tasks = input.work_items.map((work_item) => {
    try { assertWorkItemRef(work_item); } catch { fail("invalid_legacy_code_batch", "legacy work item is invalid"); }
    if (work_item.kind !== "issue" || seen.has(workItemKey(work_item))) fail("invalid_legacy_code_batch", "legacy work item is duplicated or unsupported");
    seen.add(workItemKey(work_item));
    return { task_key: "legacy", repository_key: work_item.repoKey, work_item: clone(work_item), goal: "legacy_flat_code_batch", file_boundary: [], validation: [], dependencies: [] };
  });
  return buildBatchManifest({ version: VERSION, installation_id: input.installation_id, project_id: input.project_id, delivery_mode: input.delivery_mode, tasks }, options);
}

module.exports = { VERSION, WorkTaskManifestError, assertWorkTaskRef: assertRef, assertBatchManifest: assertManifest, workTaskKey, buildBatchManifest, freezeBatchManifest, assertManifestRegisteredCurrent, planManifestTransition, applyManifestTransition, adaptLegacyFlatCodeBatch };
