"use strict";

// #794: batch-execution tools (Tier 2 — act). #1036 retargeted them: they
// start/stop/evaluate the fixed Head-only Project Monitor instead of a
// repeating all-agent pulse. set_batch/append_batch (#793) DEFINE the work;
// these observe it.
//
// Validate-first: every tool calls assertKnownProject(project) BEFORE its HTTP
// call — unknown id → clean error, no request, no monitor state.

const IDLE_REJECTION = (project) =>
  new Error(`Project "${project}" is inactive (idle). Un-idle it first, then retry.`);
const AUTHORITY_REJECTION = (project) =>
  new Error(`Cannot mutate triggers for project "${project}": live batch authority is missing, stale, foreign, unowned, or malformed.`);
const LIVE_BATCH_REJECTION = (project) =>
  new Error(`Cannot start a trigger for project "${project}": a live active non-complete batch with work items is required.`);

const {
  assignmentRequestFields,
  ownedCurrentBatchSnapshot,
} = require("../../../src/lib/batchIdentity");

async function readAuthorizedBatch(project, ctx) {
  const encoded = encodeURIComponent(project);
  const [active, progress] = await Promise.all([
    ctx.httpRequest("GET", `/api/batch-active?project=${encoded}`),
    ctx.httpRequest("GET", `/api/batch-progress?project=${encoded}`),
  ]);
  // These are state-machine fields, not optional display hints. Requiring the
  // explicit booleans keeps a partially deployed/malformed producer from
  // being interpreted as a safe non-complete assignment.
  if (
    !progress || typeof progress.complete !== "boolean" ||
    typeof progress.completeConfirmed !== "boolean" ||
    typeof progress.liveActiveBatchCleared !== "boolean"
  ) throw AUTHORITY_REJECTION(project);
  const snapshot = ownedCurrentBatchSnapshot(active, progress);
  if (!snapshot) throw AUTHORITY_REJECTION(project);
  return snapshot;
}

function requireLiveBatch(project, snapshot) {
  if (
    snapshot.active !== true || snapshot.hasItems !== true ||
    snapshot.complete === true || snapshot.completeConfirmed === true ||
    snapshot.liveActiveBatchCleared === true
  ) throw LIVE_BATCH_REJECTION(project);
}

function requireStoppableBatch(project, snapshot) {
  // A non-empty accepted snapshot was proven current by the shared join. The
  // only accepted empty snapshot is the explicit current=false clear emitted
  // by both endpoints. Completion confirmation and clear are independent
  // authoritative terminal signals; the producer can clear before confirming.
  if (
    snapshot.hasItems !== true && snapshot.completeConfirmed !== true &&
    snapshot.liveActiveBatchCleared !== true
  ) throw AUTHORITY_REJECTION(project);
}

// #794/#1050: both endpoints now project only the live `## Active Batch`.
// An exact inactive/null/empty observation can authorize cleanup, but it is not
// an assignment and can never start work.
const BATCH_STATUS_NOTE =
  "Use batch_status to gauge whether work remains: both `active` and `progress` follow the live Active Batch lifecycle, and a cleared queue reports no current work.";

// #1036: the scheduled pulse is gone. These compatibility names now drive the
// fixed-policy Head-only Project Monitor; a caller-supplied message, cadence,
// duration, recipient, or mode is rejected before any HTTP call.
const REMOVED_TRIGGER_FIELDS = ["message", "interval_min", "duration_min", "interval", "duration", "recipients", "mode"];
const AUTHORING_REJECTION = (fields) =>
  new Error(`Trigger authoring was removed (#1036): ${fields.join(", ")} cannot be supplied. The Project Monitor has a fixed policy and sends structured events to @head only.`);

function assertNoTriggerAuthoring(params) {
  const supplied = REMOVED_TRIGGER_FIELDS.filter((field) => params != null && Object.prototype.hasOwnProperty.call(params, field));
  if (supplied.length > 0) throw AUTHORING_REJECTION(supplied);
}

module.exports = {
  defs: [
    {
      name: "start_batch",
      description:
        "Enable the Head-only Project Monitor for a project's live batch (compatibility name for `project_monitor start`). It creates no repeating message: the monitor observes the current qualified assignment and writes one structured `[QW-MONITOR:<kind>]` event to @head only when a fixed-policy transition is due (terminal-red CI, passing draft, worker exit before status, BLOCKED, overdue WAITING, overdue Head gate, merged-but-not-advanced, next-item-unassigned). Rejected if the project is idle, archived, not V2-ready, or has no active batch. " +
        BATCH_STATUS_NOTE + " Requires matching admission_generation and batch_observation_fingerprint from both live endpoints plus the exact current owned V2 assignment, or explicit preactivation V1 compatibility.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
    {
      name: "trigger_now",
      description:
        "Run ONE deduplicated Project Monitor evaluation now (compatibility name for `project_monitor evaluate_now`). It reads cached/live facts, records the evaluation, and writes a @head event only when a fixed-policy transition is genuinely due; unchanged state writes nothing and wakes no agent. It never sends a generic pulse to Dev/RE1/RE2. Rejected if the project is idle. " +
        BATCH_STATUS_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
    {
      name: "stop_batch",
      description:
        "Suspend a project's Project Monitor (compatibility name for `project_monitor stop`). This is an audited suspension of observation only: the batch definition, workers, and queue are untouched. Requires an authoritative current assignment, completion confirmation, or matching explicit clear from both live batch endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
        },
        required: ["project"],
        additionalProperties: false,
      },
    },
  ],

  handlers: {
    start_batch: async (params, ctx) => {
      assertNoTriggerAuthoring(params);
      const { project } = params;
      await ctx.assertKnownProject(project);
      const snapshot = await readAuthorizedBatch(project, ctx);
      requireLiveBatch(project, snapshot);
      const res = await ctx.httpRequest("POST", `/api/triggers/${encodeURIComponent(project)}/start`, assignmentRequestFields(snapshot));
      if (res && res.idle === true) throw IDLE_REJECTION(project);
      return res;
    },

    trigger_now: async (params, ctx) => {
      assertNoTriggerAuthoring(params);
      const { project } = params;
      await ctx.assertKnownProject(project);
      const snapshot = await readAuthorizedBatch(project, ctx);
      requireLiveBatch(project, snapshot);
      const res = await ctx.httpRequest(
        "POST",
        `/api/triggers/${encodeURIComponent(project)}/send-now`,
        assignmentRequestFields(snapshot),
      );
      if (res && res.idle === true) throw IDLE_REJECTION(project);
      return res;
    },

    stop_batch: async (params, ctx) => {
      assertNoTriggerAuthoring(params);
      const { project } = params;
      await ctx.assertKnownProject(project);
      const snapshot = await readAuthorizedBatch(project, ctx);
      requireStoppableBatch(project, snapshot);
      return ctx.httpRequest(
        "POST",
        `/api/triggers/${encodeURIComponent(project)}/stop`,
        assignmentRequestFields(snapshot),
      );
    },
  },
};
