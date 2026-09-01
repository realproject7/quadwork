"use strict";

const assert = require("node:assert/strict");
const { initialMonitorState, cloneMonitorState } = require("./project-monitor-state");
const { createProjectMonitorController } = require("./project-monitor");
const { WAITING_OVERDUE_MS } = require("./project-monitor-policy");
const { createTrustedEventTransport } = require("./trusted-event-transport");

let now = 1_800_000_000_000;
const assignment = { assignment_key: "repo:owner/repo#42", subject_key: "primary:issue#42", cycle_id: "cycle-7", sha: "abcdef123456" };

function fixture() {
  let state = initialMonitorState("suspended");
  let loads = 0;
  let saves = 0;
  const timers = [];
  const deliveries = [];
  const preparations = [];
  const store = {
    load(projectId) { assert.equal(projectId, "alpha"); loads += 1; return cloneMonitorState(state); },
    save(projectId, next) { assert.equal(projectId, "alpha"); saves += 1; state = cloneMonitorState(next); return cloneMonitorState(state); },
  };
  const transport = {
    async recordAll(input) {
      preparations.push(input);
      state = cloneMonitorState(input.state);
      return { ok: true, state: cloneMonitorState(state), envelopes: Object.freeze([]) };
    },
    async publish(input) {
      deliveries.push(input);
      state = cloneMonitorState(input.state);
      return { ok: true, state: cloneMonitorState(state) };
    },
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
    controller, timers, deliveries, preparations,
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

  // Immediate conditions are prepared as one closed, durable batch before
  // either event is appended or a Head recipient is woken.
  {
    const f = fixture();
    f.controller.start("alpha");
    await f.controller.observe(observation({
      ci: { required_state: "red" },
      runtime: { process_exited: true, status_confirmed: false },
    }));
    assert.equal(f.preparations.length, 1);
    assert.equal(f.preparations[0].events.length, 2);
    assert.deepEqual(f.preparations[0].events.map((event) => event.kind).sort(),
      ["terminal_red_check", "worker_exit_before_status"]);
    assert.equal(f.deliveries.length, 2);
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

  // A process cut before TrustedEventTransport can make its first durable
  // receipt write must leave the original deadline intact.  On restart an
  // unchanged observation remains a no-op, but explicit Monitor recovery
  // recreates the overdue timer and routes one server-owned receipt.  This
  // uses only injected timers/microtasks: no wall-clock sleep is involved.
  {
    let crashState = initialMonitorState("suspended");
    const crashStore = {
      load(projectId) { assert.equal(projectId, "alpha"); return cloneMonitorState(crashState); },
      save(projectId, next) {
        assert.equal(projectId, "alpha");
        crashState = cloneMonitorState(next);
        return cloneMonitorState(crashState);
      },
    };
    const crashing = createProjectMonitorController({
      stateStore: crashStore,
      transport: {
        async recordAll() { throw new Error("simulated_process_cut_before_delivery_record"); },
        async publish() { throw new Error("publish_must_not_run_after_record_cut"); },
        async resume(projectId, state) { return { ok: true, resumed: 0, state }; },
      },
      now: () => now,
    });
    crashing.start("alpha");
    const text = `[STATUS] ${JSON.stringify({ ...assignment, status: "WAITING", waiting_name: "operator", observed_at: now })}`;
    await crashing.observe(observation({ chat_records: [{ sender: "head", authenticated: true, text }] }));
    const condition = Object.values(crashState.unresolved)[0];
    now = condition.due_at;
    await assert.rejects(() => crashing._onDeadline("alpha", condition.key, condition.due_at),
      /simulated_process_cut_before_delivery_record/);
    assert.equal(Object.keys(crashState.unresolved).length, 1,
      "a crash before the receipt write cannot durably retire the deadline");
    assert.equal(Object.keys(crashState.deliveries).length, 0);

    const timers = [];
    const rows = new Map();
    const wakes = [];
    const recoveryTransport = createTrustedEventTransport({
      stateStore: crashStore,
      isProjectAdmitted: () => true,
      appendTrustedEventOnce: async (envelope) => {
        if (!rows.has(envelope.correlation_id)) rows.set(envelope.correlation_id, "chat-recovered-1");
        return { ok: true, id: rows.get(envelope.correlation_id) };
      },
      wakeTrustedRecipient: async ({ envelope }) => {
        wakes.push(envelope.correlation_id);
        return { ok: true, session_generation: "head-recovered-1" };
      },
    });
    const recovered = createProjectMonitorController({
      stateStore: crashStore,
      transport: recoveryTransport,
      now: () => now,
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cancelled = true; },
    });
    const unchanged = await recovered.observe(observation({ chat_records: [{ sender: "head", authenticated: true, text }] }));
    assert.equal(unchanged.changed, false, "restart observation must not manufacture a second condition");
    const resumed = await recovered.resumePending("alpha");
    assert.equal(resumed.resumed, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 0);
    timers[0].callback();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    assert.equal(rows.size, 1, "restart reconciliation appends exactly one durable chat receipt");
    assert.equal(wakes.length, 1);
    assert.equal(Object.keys(crashState.unresolved).length, 0);

    const duplicateRecovery = await recovered.resumePending("alpha");
    assert.equal(duplicateRecovery.resumed, 0);
    assert.equal(rows.size, 1, "a completed receipt is never appended twice");
    assert.equal(wakes.length, 1, "the same verified recipient generation is never woken twice");
  }

  console.log("project-monitor.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
