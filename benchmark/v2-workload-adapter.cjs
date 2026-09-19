"use strict";

// #1037 Unit B: map the non-shipping benchmark fixture into the same frozen
// WorkTask manifest and in-memory pipeline primitives that V2 uses. This is
// deliberately not a server launcher or a provider transport. A future live
// runner must obtain the repository and ticket bindings from its disposable
// instance, then use the authenticated HTTP/MCP routes for every mutation.

const { buildBatchManifest, freezeBatchManifest } = require("../server/work-task-manifest");
const { buildWorkTaskPipeline } = require("../server/work-task-pipeline");

const CLASSES = new Set(["pipeline_eligible", "dependency_overlap_bound"]);
const ID = /^[a-z][a-z0-9_]{0,63}$/;
const REPOSITORY_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@+~=-]{1,240}$/;

class V2WorkloadAdapterError extends Error {
  constructor(code, message = code) { super(message); this.name = "V2WorkloadAdapterError"; this.code = code; }
}
function fail(code, message) { throw new V2WorkloadAdapterError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, "unknown or missing field");
}
function copy(value) { return Array.isArray(value) ? value.map(copy) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

function workload(value) {
  exact(value, ["schema_version", "class", "tasks", "read_only_paths"], "invalid_benchmark_workload");
  if (value.schema_version !== 1 || !CLASSES.has(value.class) || !Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > 64 ||
      !Array.isArray(value.read_only_paths) || value.read_only_paths.length === 0 || value.read_only_paths.length > 64 ||
      value.read_only_paths.some((entry) => typeof entry !== "string" || !PATH.test(entry)) || new Set(value.read_only_paths).size !== value.read_only_paths.length) {
    fail("invalid_benchmark_workload", "workload shape is invalid");
  }
  const tasks = value.tasks.map((task) => {
    exact(task, ["id", "ticket", "path", "depends_on"], "invalid_benchmark_workload_task");
    if (!ID.test(task.id) || !ID.test(task.ticket) || typeof task.path !== "string" || !PATH.test(task.path) || !Array.isArray(task.depends_on) ||
        task.depends_on.length > 32 || task.depends_on.some((dependency) => !ID.test(dependency)) || new Set(task.depends_on).size !== task.depends_on.length) {
      fail("invalid_benchmark_workload_task", "workload task is invalid");
    }
    return freeze({ id: task.id, ticket: task.ticket, path: task.path, depends_on: [...task.depends_on] });
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) fail("duplicate_benchmark_workload_task", "workload task id is duplicated");
  const protectedPaths = new Set(value.read_only_paths);
  if (tasks.some((task) => protectedPaths.has(task.path))) fail("benchmark_workload_task_path_read_only", "workload task path is read-only");
  const known = new Set(tasks.map((task) => task.id));
  if (tasks.some((task) => task.depends_on.some((dependency) => !known.has(dependency)))) fail("unknown_benchmark_workload_dependency", "workload dependency is unknown");
  return freeze({ schema_version: 1, class: value.class, tasks, read_only_paths: [...value.read_only_paths] });
}

function bindings(value, tasks) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail("invalid_benchmark_ticket_bindings", "ticket bindings are invalid");
  const parsed = value.map((binding) => {
    exact(binding, ["ticket", "repository_key", "repo", "number", "kind"], "invalid_benchmark_ticket_binding");
    if (!ID.test(binding.ticket) || !REPOSITORY_KEY.test(binding.repository_key) || typeof binding.repo !== "string" || binding.repo.length === 0 || binding.repo.length > 200 ||
        !Number.isSafeInteger(binding.number) || binding.number < 1 || binding.kind !== "issue") {
      fail("invalid_benchmark_ticket_binding", "ticket binding is invalid");
    }
    return freeze({ ticket: binding.ticket, repository_key: binding.repository_key, repo: binding.repo, number: binding.number, kind: "issue" });
  });
  if (new Set(parsed.map((binding) => binding.ticket)).size !== parsed.length) fail("duplicate_benchmark_ticket_binding", "ticket binding is duplicated");
  const byTicket = new Map(parsed.map((binding) => [binding.ticket, binding]));
  if (tasks.some((task) => !byTicket.has(task.ticket))) fail("missing_benchmark_ticket_binding", "workload ticket has no binding");
  if (parsed.some((binding) => !tasks.some((task) => task.ticket === binding.ticket))) fail("unused_benchmark_ticket_binding", "ticket binding is unused");
  return byTicket;
}

function dependencyLocators(task, taskById, ticketBindings) {
  return task.depends_on.map((dependency) => {
    const source = taskById.get(dependency), binding = ticketBindings.get(source.ticket);
    return { repository_key: binding.repository_key, work_item: { repoKey: binding.repository_key, repo: binding.repo, number: binding.number, kind: "issue" }, task_key: source.id };
  });
}

function createV2FixtureBatch(input) {
  exact(input, ["version", "workload", "ticket_bindings", "installation_id", "project_id", "delivery_mode", "frozen_at", "resolve_registered_identity"], "invalid_v2_workload_adapter_input");
  if (input.version !== 1 || typeof input.installation_id !== "string" || typeof input.project_id !== "string" ||
      (input.delivery_mode !== "integrated" && input.delivery_mode !== "isolated") || typeof input.frozen_at !== "string" || typeof input.resolve_registered_identity !== "function") {
    fail("invalid_v2_workload_adapter_input", "adapter input is invalid");
  }
  const parsed = workload(input.workload), taskById = new Map(parsed.tasks.map((task) => [task.id, task]));
  const byTicket = bindings(input.ticket_bindings, parsed.tasks);
  const tasks = parsed.tasks.map((task) => {
    const binding = byTicket.get(task.ticket);
    return {
      task_key: task.id,
      repository_key: binding.repository_key,
      work_item: { repoKey: binding.repository_key, repo: binding.repo, number: binding.number, kind: "issue" },
      goal: `Implement benchmark task ${task.id}`,
      file_boundary: [task.path], validation: ["node-test"], dependencies: dependencyLocators(task, taskById, byTicket),
    };
  });
  let manifest;
  try {
    manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id: input.installation_id, project_id: input.project_id,
      delivery_mode: input.delivery_mode, tasks }, { resolveRegisteredIdentity: input.resolve_registered_identity }), input.frozen_at);
  } catch (error) { fail("v2_fixture_batch_unavailable", error?.code || "V2 manifest creation failed"); }
  let pipeline;
  try { pipeline = buildWorkTaskPipeline(manifest); }
  catch (error) { fail("v2_fixture_pipeline_unavailable", error?.code || "V2 pipeline creation failed"); }
  return freeze({ version: 1, workload_class: parsed.class, read_only_paths: copy(parsed.read_only_paths), manifest, pipeline });
}

module.exports = { V2WorkloadAdapterError, createV2FixtureBatch };
