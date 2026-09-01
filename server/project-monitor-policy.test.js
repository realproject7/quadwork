"use strict";

const assert = require("node:assert/strict");
const {
  FIRST_PROGRESS_GRACE_MS,
  WAITING_OVERDUE_MS,
  evaluateMonitorPolicy,
  parseQualifiedChatMarker,
} = require("./project-monitor-policy");

const NOW = 1_800_000_000_000;
const assignment = {
  assignment_key: "repo:owner/repo#42",
  subject_key: "primary:issue#42",
  cycle_id: "cycle-7",
  sha: "abcdef123456",
};

function observation(extra = {}) {
  return {
    project_id: "alpha",
    mode: "enabled",
    readiness: true,
    assignment,
    ...extra,
  };
}

// Only an authenticated, start-anchored and schema-qualified marker is a
// monitor signal. Quoted/pasted prose and worker-authored lookalikes are inert.
{
  const valid = `[STATUS] ${JSON.stringify({ ...assignment, status: "WAITING", waiting_name: "operator", observed_at: NOW })}`;
  const marker = parseQualifiedChatMarker({ sender: "head", authenticated: true, type: "message", text: valid });
  assert.equal(marker.status, "WAITING");
  assert.equal(marker.waiting_name, "operator");
  assert.equal(parseQualifiedChatMarker({ sender: "dev", authenticated: true, text: valid }), null);
  assert.equal(parseQualifiedChatMarker({ sender: "head", authenticated: true, text: `quoted ${valid}` }), null);
  assert.equal(parseQualifiedChatMarker({ sender: "head", authenticated: true, text: `${valid}\nnotes` }), null);
  assert.equal(parseQualifiedChatMarker({ sender: "head", authenticated: false, text: valid }), null);
}

// The fixed red/draft/lifecycle/progression facts map to closed event kinds;
// no caller text, recipient, or interval survives policy normalization.
{
  const result = evaluateMonitorPolicy(observation({
    ci: { required_state: "red", draft: true, dev_action_pending: true },
    runtime: { process_exited: true, status_confirmed: false },
    progression: { merged_not_advanced: true, next_loaded_unassigned: true },
  }), { now: NOW });
  assert.deepEqual(result.conditions.map((item) => item.kind).sort(), [
    "merged_not_advanced",
    "next_loaded_unassigned",
    "terminal_red_check",
    "worker_exit_before_status",
  ]);
  for (const item of result.conditions) {
    assert.equal(item.anchors.project_id, "alpha");
    assert.equal(item.anchors.assignment_key, assignment.assignment_key);
    assert.equal(Object.hasOwn(item.anchors, "text"), false);
    assert.equal(Object.hasOwn(item.anchors, "recipients"), false);
  }
}

// WAITING is the one policy-owned reconciliation timer: it carries a fixed
// deadline and only becomes immediate after that deadline, never a pulse.
{
  const text = `[STATUS] ${JSON.stringify({ ...assignment, status: "WAITING", waiting_name: "operator", observed_at: NOW })}`;
  const before = evaluateMonitorPolicy(observation({
    chat_records: [{ sender: "head", authenticated: true, text }],
  }), { now: NOW + WAITING_OVERDUE_MS - 1 });
  assert.equal(before.conditions.length, 1);
  assert.equal(before.conditions[0].kind, "waiting_overdue");
  assert.equal(before.conditions[0].immediate, false);
  assert.equal(before.conditions[0].due_at, NOW + WAITING_OVERDUE_MS);
  const after = evaluateMonitorPolicy(observation({
    chat_records: [{ sender: "head", authenticated: true, text }],
  }), { now: NOW + WAITING_OVERDUE_MS });
  assert.equal(after.conditions[0].immediate, true);
}

// First-progress grace and non-terminal CI suspend stall assessment rather
// than translating either state into a generic queue wake.
{
  const grace = evaluateMonitorPolicy(observation({
    progress: { first_progress_at: NOW - FIRST_PROGRESS_GRACE_MS + 1, last_progress_at: NOW - 1 },
  }), { now: NOW });
  assert.equal(grace.stall_state, "first_progress_grace");
  assert.equal(grace.conditions.length, 0);
  const pending = evaluateMonitorPolicy(observation({
    ci: { required_state: "pending" },
    progress: { first_progress_at: NOW - FIRST_PROGRESS_GRACE_MS - 1, last_progress_at: NOW - 1 },
  }), { now: NOW });
  assert.equal(pending.stall_state, "suspended_nonterminal_ci");
  assert.equal(pending.conditions.length, 0);
}

// Readiness/mode are fail-closed. A copied marker cannot cause delivery while
// the V2 readiness gate or lifecycle state is not enabled.
{
  const disabled = evaluateMonitorPolicy(observation({ readiness: false, ci: { required_state: "red" } }), { now: NOW });
  assert.equal(disabled.conditions.length, 0);
  const archived = evaluateMonitorPolicy(observation({ mode: "archived", ci: { required_state: "red" } }), { now: NOW });
  assert.equal(archived.conditions.length, 0);
}

console.log("project-monitor-policy.test.js: all assertions passed");
