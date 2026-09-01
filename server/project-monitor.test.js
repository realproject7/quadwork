"use strict";

const assert = require("node:assert/strict");
const { initialMonitorState, cloneMonitorState } = require("./project-monitor-state");
const { createProjectMonitorController } = require("./project-monitor");
const { WAITING_OVERDUE_MS } = require("./project-monitor-policy");

let now = 1_800_000_000_000;
const assignment = { assignment_key: "repo:owner/repo#42", subject_key: "primary:issue#42", cycle_id: "cycle-7", sha: "abcdef123456" };

function fixture() {
  let state = initialMonitorState("suspended");
  let loads = 0;
  let saves = 0;
  const timers = [];
  const deliveries = [];
  const store = {
    load(projectId) { assert.equal(projectId, "alpha"); loads += 1; return cloneMonitorState(state); },
    save(projectId, next) { assert.equal(projectId, "alpha"); saves += 1; state = cloneMonitorState(next); return cloneMonitorState(state); },
  };
  const transport = {
    async publish(input) { deliveries.push(input); return { ok: true, state: input.state }; },
    async resume(projectId, inputState) { return { ok: true, resumed: 0, state: inputState }; },
  };
  const controller = createProjectMonitorController({
    stateStore: store,
    transport,
    now: () => now,
    setTimeout: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cancelled = true; },
  });
  return {
    controller, timers, deliveries,
    get loads() { return loads; }, get saves() { return saves; }, get state() { return cloneMonitorState(state); },
  };
}

function observation(extra = {}) {
  return { project_id: "alpha", readiness: true, assignment, ...extra };
}

(async () => {
  // Only explicit lifecycle start enables monitoring. An observation cannot
  // smuggle mode=enabled into a suspended controller.
  {
    const f = fixture();
    await f.controller.observe({ ...observation({ ci: { required_state: "red" } }), mode: "enabled" });
    assert.equal(f.deliveries.length, 0);
    f.controller.start("alpha");
    const first = await f.controller.observe(observation({ ci: { required_state: "red" } }));
    assert.equal(first.changed, true);
    assert.equal(f.deliveries.length, 1);
    const before = { loads: f.loads, saves: f.saves, deliveries: f.deliveries.length, timers: f.timers.length };
    const repeated = await f.controller.observe(observation({ ci: { required_state: "red" } }));
    assert.equal(repeated.changed, false);
    assert.deepEqual({ loads: f.loads, saves: f.saves, deliveries: f.deliveries.length, timers: f.timers.length }, before,
      "unchanged observations are zero state I/O and zero transport/timer activity");
  }

  // A named WAITING condition is the sole scheduled reconciliation. Nothing
  // wakes before its fixed deadline; the deadline uses its persisted anchors.
  {
    const f = fixture();
    f.controller.start("alpha");
    const text = `[STATUS] ${JSON.stringify({ ...assignment, status: "WAITING", waiting_name: "operator", observed_at: now })}`;
    await f.controller.observe(observation({ chat_records: [{ sender: "head", authenticated: true, text }] }));
    assert.equal(f.deliveries.length, 0);
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].delay, WAITING_OVERDUE_MS);
    now += WAITING_OVERDUE_MS;
    await f.controller._onDeadline("alpha", Object.keys(f.state.unresolved)[0], now);
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].kind, "waiting_overdue");
  }

  // Archive synchronously removes condition timers and subsequent observations
  // stay inert until a new explicit start.
  {
    const f = fixture();
    f.controller.start("alpha");
    await f.controller.observe(observation({ ci: { required_state: "red" } }));
    f.controller.archive("alpha");
    await f.controller.observe(observation({ ci: { required_state: "red" } }));
    assert.equal(f.state.mode, "archived");
    assert.equal(f.deliveries.length, 1);
  }

  // Restoring an archive remains suspended; an explicit start is required.
  // Terminal batch cleanup likewise retires pending receipts without a wake.
  {
    const f = fixture();
    f.controller.start("alpha");
    const text = `[STATUS] ${JSON.stringify({ ...assignment, status: "WAITING", waiting_name: "operator", observed_at: now })}`;
    await f.controller.observe(observation({ chat_records: [{ sender: "head", authenticated: true, text }] }));
    assert.equal(Object.keys(f.state.unresolved).length, 1);
    f.controller.clearTerminal("alpha");
    assert.equal(Object.keys(f.state.unresolved).length, 0);
    f.controller.archive("alpha");
    assert.throws(() => f.controller.start("alpha"), /monitor_unarchive_required/);
    assert.equal(f.controller.unarchive("alpha").mode, "suspended");
    await f.controller.observe(observation({ ci: { required_state: "red" } }));
    assert.equal(f.deliveries.length, 0);
    f.controller.start("alpha");
    await f.controller.observe(observation({ ci: { required_state: "red" } }));
    assert.equal(f.deliveries.length, 1);
  }

  console.log("project-monitor.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
