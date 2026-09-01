"use strict";

const assert = require("node:assert/strict");
const {
  dispatchTrustedMonitorEvent,
  cancelProject,
  _pendingWake,
} = require("./pty-dispatcher");
const { envelopeFor } = require("./trusted-event-transport");

const envelope = envelopeFor("alpha", "blocked", {
  project_id: "alpha",
  assignment_key: "repo:owner/repo#42",
  subject_key: "primary:issue#42",
  event_generation: "abcdef1234567890",
});
const writes = [];
const term = {
  write: (text) => writes.push(text),
  onData: () => ({ dispose() {} }),
};
const sessions = new Map([["alpha/head", {
  projectId: "alpha",
  agentId: "head",
  term,
  state: "running",
  lifecycleState: "verified",
  generationId: "head-generation-7",
  lastOutputAt: Date.now(), // force shared busy/defer path with no wall-clock wait
}]]);
const deps = {
  isProjectAdmitted: () => true,
  isTrustedEventCurrent: (event, session) => event.correlation_id === envelope.correlation_id
    && session.generationId === "head-generation-7",
  safeWrite: (target, text) => { target.write(text); return true; },
};

// Only a verified current Head is accepted, and its busy PTY enters the
// shared pending-wake map rather than receiving a direct terminal write.
const accepted = dispatchTrustedMonitorEvent("alpha", envelope, sessions, deps);
assert.deepEqual(accepted, { ok: true, deferred: true, delivery_generation: "head-generation-7" });
assert.equal(writes.length, 0);
assert.equal(_pendingWake.has("alpha/head"), true);
const cancelled = cancelProject("alpha");
assert.equal(cancelled.ok, true);
assert.equal(_pendingWake.has("alpha/head"), false);

// A stale/unknown generation and a forged recipient are both fail-closed.
sessions.get("alpha/head").lifecycleState = "spawned";
assert.equal(dispatchTrustedMonitorEvent("alpha", envelope, sessions, deps).code, "trusted_event_not_current");
sessions.get("alpha/head").lifecycleState = "verified";
assert.equal(dispatchTrustedMonitorEvent("alpha", { ...envelope, recipients: ["dev"] }, sessions, deps).code, "trusted_event_invalid");
assert.equal(writes.length, 0);

console.log("pty-dispatcher.trusted-monitor.test.js: all assertions passed");
