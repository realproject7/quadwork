"use strict";

// #794: batch-execution tools (Tier 2 — act). start/stop the scheduled trigger
// that drives a batch, and fire a single pulse on demand. set_batch/append_batch
// (#793) DEFINE the work; these RUN it. New file under tools/ — additive,
// auto-merged by #790's loader, no edits to existing modules.
//
// Validate-first: POST /api/triggers/:project/start creates a setInterval for
// ANY :project string (the backend doesn't reject unknown ids), and send-now
// can create a stray ~/.quadwork/<id>/ chat file. So every tool calls
// assertKnownProject(project) BEFORE its HTTP call — unknown id → clean error,
// no request, no timer.

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

// #794/#880: post-#864, batch-active is authoritative — it follows the live
// `## Active Batch` lifecycle (once Head clears the queue it reads not-active);
// batch-progress may still render a just-completed batch (sticky display). Use
// batch_status to gauge whether work remains before starting/stopping.
const BATCH_STATUS_NOTE =
  "Use batch_status to gauge whether work remains: `active` follows the live Active Batch lifecycle (cleared queue → not active) and is authoritative; `progress` may still show a just-completed batch (sticky display).";

module.exports = {
  defs: [
    {
      name: "start_batch",
      description:
        "Start the SCHEDULED trigger that drives a project's batch — fires a trigger message every `interval_min` minutes (default 30), optionally auto-stopping after `duration_min` minutes (default 0 = run indefinitely). The first pulse is at T+interval, not immediately (use trigger_now for an immediate one). Define the batch first with set_batch/append_batch (#793). Only the fields you pass are persisted to the project: an omitted interval/duration/message is NOT saved — later pulses reuse the project's existing trigger_message / interval. Rejected if the project is idle (un-idle it first). " +
        BATCH_STATUS_NOTE + " Requires the exact current owned V2 assignment, or explicit preactivation V1 compatibility with matching batch_observation_fingerprint, from both live batch endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
          interval_min: { type: "number", description: "Minutes between trigger pulses (default 30)." },
          duration_min: { type: "number", description: "Auto-stop after this many minutes (default 0 = indefinite)." },
          message: { type: "string", description: "Trigger message to send each pulse (persisted; defaults to the project's existing message)." },
        },
        required: ["project"],
      },
    },
    {
      name: "trigger_now",
      description:
        "Fire ONE trigger pulse immediately for a project (a single send-now, separate from the scheduled cadence). Use after defining a batch when you want to kick it off right away instead of waiting for start_batch's first interval. Rejected if the project is idle. " +
        BATCH_STATUS_NOTE + " Requires the exact current owned V2 assignment, or explicit preactivation V1 compatibility with matching batch_observation_fingerprint, from both live batch endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
        },
        required: ["project"],
      },
    },
    {
      name: "stop_batch",
      description:
        "Stop a project's scheduled trigger (clears the interval timer). The batch definition in the queue is untouched — only the cadence stops. Requires an authoritative current assignment, completion confirmation, or matching explicit clear from both live batch endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
        },
        required: ["project"],
      },
    },
  ],

  handlers: {
    start_batch: async (params, ctx) => {
      const { project, interval_min, duration_min, message } = params;
      await ctx.assertKnownProject(project);
      const snapshot = await readAuthorizedBatch(project, ctx);
      requireLiveBatch(project, snapshot);
      // Map tool field names → endpoint body fields (the endpoint expects
      // interval/duration/message, NOT *_min). Send only provided fields.
      const body = {};
      if (interval_min != null) body.interval = interval_min;
      if (duration_min != null) body.duration = duration_min;
      if (message != null) body.message = message;
      Object.assign(body, assignmentRequestFields(snapshot));
      const res = await ctx.httpRequest("POST", `/api/triggers/${encodeURIComponent(project)}/start`, body);
      if (res && res.idle === true) throw IDLE_REJECTION(project);
      return res;
    },

    trigger_now: async (params, ctx) => {
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
