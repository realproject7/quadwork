"use strict";

// #1046 M10: server-owned composition for one local Batch Request
// subscription.  The watcher stays a bounded conditional GitHub reader and
// emits at most one durable Head notice; this owner deliberately owns no
// scheduler, public route, cross-host control, or work execution authority.

const { createBatchRequestStateStore } = require("./batch-request-state-store");
const { createBatchRequestRuntime } = require("./batch-request-runtime");
const { createLiveBatchRequestSubscription } = require("./live-batch-request-subscription");

const VERSION = 1;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields) {
  if (!plain(value)) throw new TypeError("value must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError("value has unknown or missing fields");
  }
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function target(value) {
  exact(value, ["installation_id", "project_id"]);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id)) {
    throw new TypeError("Batch Request target is invalid");
  }
  return freeze({ installation_id: value.installation_id, project_id: value.project_id });
}
function runtimeKey(value) { return `${value.installation_id}:${value.project_id}`; }
function isMissingState(error) { return error && error.code === "batch_request_state_store_missing"; }

function createBatchRequestRuntimeOwner(options) {
  exact(options, [
    "config_dir", "fs", "read_config", "capture_project_admission", "is_admission_current", "is_project_archived",
    "read_coordination_issues", "append_trusted_batch_request_once", "wake_trusted_batch_request",
  ]);
  if (typeof options.config_dir !== "string" || !options.config_dir || !options.fs ||
      typeof options.read_config !== "function" || typeof options.capture_project_admission !== "function" ||
      typeof options.is_admission_current !== "function" || typeof options.is_project_archived !== "function" ||
      typeof options.read_coordination_issues !== "function" || typeof options.append_trusted_batch_request_once !== "function" ||
      typeof options.wake_trusted_batch_request !== "function") {
    throw new TypeError("Batch Request runtime owner dependencies are invalid");
  }

  const runtimes = new Map();
  const subscription = createLiveBatchRequestSubscription({
    read_config: options.read_config,
    capture_project_admission: options.capture_project_admission,
    is_admission_current: options.is_admission_current,
    is_project_archived: options.is_project_archived,
  });

  function currentTarget(projectId) {
    if (typeof projectId !== "string" || !PROJECT_RE.test(projectId)) return null;
    let admission;
    let config;
    try {
      admission = options.capture_project_admission(projectId);
      config = options.read_config();
    } catch { return null; }
    if (!admission || admission.project_id !== projectId || options.is_admission_current(admission) !== true ||
        !plain(config) || typeof config.installation_id !== "string" || !INSTALLATION_RE.test(config.installation_id) ||
        options.is_project_archived(projectId, config) !== false) return null;
    const projects = Array.isArray(config.projects) ? config.projects.filter((entry) => plain(entry) && entry.id === projectId && entry.archived !== true) : [];
    if (projects.length !== 1) return null;
    return target({ installation_id: config.installation_id, project_id: projectId });
  }

  function resolveCanonicalSubscription(request) {
    return subscription(request);
  }

  function deliveryFor(targetValue) {
    return async (request) => {
      // Re-acquire current lifecycle authority after the one GitHub read and
      // immediately before the irreversible durable chat append.
      const current = currentTarget(targetValue.project_id);
      if (!current || current.installation_id !== targetValue.installation_id) {
        throw new TypeError("Batch Request target is no longer admitted");
      }
      const admission = options.capture_project_admission(targetValue.project_id);
      if (!admission || admission.project_id !== targetValue.project_id || options.is_admission_current(admission) !== true) {
        throw new TypeError("Batch Request admission is stale");
      }
      const candidate = freeze({
        project_id: targetValue.project_id,
        head_generation: admission.generation,
        notification: request.notification,
      });
      const appended = options.append_trusted_batch_request_once(candidate);
      if (!appended || appended.ok !== true || !Number.isSafeInteger(appended.id) || appended.id <= 0) {
        throw new TypeError("Batch Request notice append was not accepted");
      }
      // A fresh Head may not yet have a verified PTY. The durable Primary Chat
      // notice is still the delivery; wake is only an immediate best-effort
      // acceleration and can never trigger a retry/new chat event.
      try { await options.wake_trusted_batch_request(candidate); } catch { /* retained chat notice is recoverable */ }
      return freeze({ version: VERSION, accepted: true });
    };
  }

  function runtimeFor(targetValue) {
    const key = runtimeKey(targetValue);
    const existing = runtimes.get(key);
    if (existing) return existing;
    const runtime = createBatchRequestRuntime({
      stateStore: createBatchRequestStateStore({ config_dir: options.config_dir, fs: options.fs }),
      resolveCanonicalSubscription,
      readCoordinationIssues: options.read_coordination_issues,
      deliverHeadNotification: deliveryFor(targetValue),
    });
    runtimes.set(key, runtime);
    return runtime;
  }

  async function reconcileProject(projectId) {
    const current = currentTarget(projectId);
    if (!current) return freeze({ ok: true, skipped: true, code: "batch_request_target_unavailable" });
    // Enablement is checked before initialising a state file. A project with a
    // disabled/malformed/removed subscription does not acquire watcher state
    // merely because the ordinary GitHub refresh loop observed it.
    try {
      const fact = resolveCanonicalSubscription(freeze({ version: VERSION, target: current }));
      if (!fact || fact.enabled !== true || fact.archived !== false) {
        return freeze({ ok: true, skipped: true, code: "batch_request_subscription_unavailable" });
      }
    } catch {
      return freeze({ ok: true, skipped: true, code: "batch_request_subscription_unavailable" });
    }
    const runtime = runtimeFor(current);
    try {
      runtime.recover(freeze({ version: VERSION, target: current }));
    } catch (error) {
      if (!isMissingState(error)) throw error;
      runtime.initialize(freeze({ version: VERSION, target: current }));
    }
    const result = await runtime.reconcile(freeze({ version: VERSION, target: current }));
    return freeze({ ok: true, skipped: false, result });
  }

  function revokeProject(projectId) {
    if (typeof projectId !== "string" || !PROJECT_RE.test(projectId)) {
      return freeze({ ok: false, resources: freeze({}), cleanup_errors: freeze([{ resource: "batch_request", code: "invalid_project" }]) });
    }
    let removed = 0;
    for (const [key] of runtimes) {
      if (!key.endsWith(`:${projectId}`)) continue;
      runtimes.delete(key);
      removed += 1;
    }
    return freeze({ ok: true, resources: freeze({ batch_request_runtimes: removed }), cleanup_errors: freeze([]) });
  }

  return freeze({ reconcileProject, revokeProject });
}

module.exports = { createBatchRequestRuntimeOwner };
