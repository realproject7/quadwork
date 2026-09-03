"use strict";

const assert = require("node:assert/strict");
const { initialMonitorState, cloneMonitorState } = require("./project-monitor-state");
const { createTrustedEventTransport, TrustedEventTransportError } = require("./trusted-event-transport");

const anchors = {
  project_id: "alpha",
  assignment_key: "repo:owner/repo#42",
  subject_key: "primary:issue#42",
  event_generation: "abcdef1234567890",
};

function memoryStore(initial, options = {}) {
  let state = cloneMonitorState(initial);
  let saves = 0;
  return {
    get state() { return cloneMonitorState(state); },
    get saves() { return saves; },
    save(projectId, next) {
      assert.equal(projectId, "alpha");
      saves += 1;
      if (options.failSaveAt === saves) throw new Error("simulated durable write cut");
      state = cloneMonitorState(next);
      return cloneMonitorState(state);
    },
  };
}

(async () => {
// The public transport input contains only project/kind/anchors/state.  Text,
// recipient and arbitrary kinds are rejected rather than silently accepted.
{
  const store = memoryStore(initialMonitorState("enabled"));
  const transport = createTrustedEventTransport({ stateStore: store });
  await assert.rejects(() => transport.publish({ project_id: "alpha", kind: "terminal_red_check", anchors, state: store.state, text: "wake everyone" }),
    (error) => error instanceof TrustedEventTransportError && error.code === "trusted_event_input_invalid");
  await assert.rejects(() => transport.publish({ project_id: "alpha", kind: "reviewer_request", anchors, state: store.state }),
    (error) => error instanceof TrustedEventTransportError && error.code === "trusted_event_kind_invalid");
}

// A closed event becomes a durable receipt before append, has exactly one fixed
// Head recipient, and a repeated correlation causes neither a second chat row
// nor a second wake.
{
  const store = memoryStore(initialMonitorState("enabled"));
  const events = new Map();
  const wakes = [];
  const transport = createTrustedEventTransport({
    stateStore: store,
    isProjectAdmitted: () => true,
    appendTrustedEventOnce: async (event) => {
      assert.deepEqual(event.recipients, ["head"]);
      assert.equal(event.text.startsWith("@head [QW-MONITOR:terminal_red_check]"), true);
      if (!events.has(event.correlation_id)) events.set(event.correlation_id, { id: "chat-1", event });
      return { ok: true, id: events.get(event.correlation_id).id };
    },
    wakeTrustedRecipient: async (request) => {
      wakes.push(request);
      assert.equal(request.recipient, "head");
      return { ok: true, session_generation: "head-gen-2" };
    },
  });
  const first = await transport.publish({ project_id: "alpha", kind: "terminal_red_check", anchors, state: store.state });
  assert.equal(first.ok, true);
  assert.equal(events.size, 1);
  assert.equal(wakes.length, 1);
  assert.equal(first.state.deliveries[first.envelope.correlation_id].phase, "woken");
  const second = await transport.publish({ project_id: "alpha", kind: "terminal_red_check", anchors, state: first.state });
  assert.equal(second.duplicate, true);
  assert.equal(events.size, 1);
  assert.equal(wakes.length, 1);
}

// Several immediate Monitor conditions may be prepared together.  Their
// receipt authorities are one durable state write before the first external
// append/wake, so a cut between siblings cannot lose a later condition.
{
  const store = memoryStore(initialMonitorState("enabled"));
  const rows = new Map();
  const transport = createTrustedEventTransport({
    stateStore: store,
    isProjectAdmitted: () => true,
    appendTrustedEventOnce: async (event) => {
      if (!rows.has(event.correlation_id)) rows.set(event.correlation_id, `chat-${rows.size + 1}`);
      return { ok: true, id: rows.get(event.correlation_id) };
    },
    wakeTrustedRecipient: async () => ({ ok: true, session_generation: "head-gen-recorded" }),
  });
  const prepared = transport.recordAll({
    project_id: "alpha",
    events: [
      { kind: "terminal_red_check", anchors },
      { kind: "blocked", anchors },
    ],
    state: store.state,
  });
  assert.equal(Object.keys(prepared.state.deliveries).length, 2);
  assert.equal(rows.size, 0, "preparation performs no external append");
  assert.equal(store.saves, 1, "all delivery authorities share one durable write");

  const first = await transport.publish({ project_id: "alpha", kind: "terminal_red_check", anchors, state: prepared.state });
  const second = await transport.publish({ project_id: "alpha", kind: "blocked", anchors, state: first.state });
  assert.equal(second.ok, true);
  assert.equal(rows.size, 2);
}

// Crash cut: append succeeded but the following durable phase write failed.
// Restarting from the recorded receipt invokes append-once with the identical
// correlation; it recovers the original row rather than writing another one.
{
  const store = memoryStore(initialMonitorState("enabled"), { failSaveAt: 2 });
  const rows = new Map();
  let appendCalls = 0;
  let wakeCalls = 0;
  const makeTransport = () => createTrustedEventTransport({
    stateStore: store,
    isProjectAdmitted: () => true,
    appendTrustedEventOnce: async (event) => {
      appendCalls += 1;
      if (!rows.has(event.correlation_id)) rows.set(event.correlation_id, "chat-7");
      return { ok: true, id: rows.get(event.correlation_id) };
    },
    wakeTrustedRecipient: async () => { wakeCalls += 1; return { ok: true, session_generation: "head-gen-3" }; },
  });
  await assert.rejects(() => makeTransport().publish({ project_id: "alpha", kind: "blocked", anchors, state: store.state }));
  assert.equal(rows.size, 1);
  const recovered = await makeTransport().resume("alpha", store.state);
  assert.equal(recovered.resumed, 1);
  assert.equal(rows.size, 1);
  assert.equal(appendCalls, 2, "the second call is an idempotent append lookup, not a second row");
  assert.equal(wakeCalls, 1);
}

// A dispatcher queue acknowledgement is not a PTY-write receipt. It remains
// appended, but its target generation prevents duplicate resumes for the same
// Head. Once that Head is gone, the next verified generation gets one retry of
// the same correlation and the append-once boundary still has one JSONL row.
{
  const store = memoryStore(initialMonitorState("enabled"));
  const rows = new Map();
  let headGeneration = "head-gen-old";
  let wakeCalls = 0;
  const transport = createTrustedEventTransport({
    stateStore: store,
    isProjectAdmitted: () => true,
    currentTrustedRecipientGeneration: () => headGeneration,
    appendTrustedEventOnce: async (event) => {
      if (!rows.has(event.correlation_id)) rows.set(event.correlation_id, "chat-queued-1");
      return { ok: true, id: rows.get(event.correlation_id) };
    },
    wakeTrustedRecipient: async () => {
      wakeCalls += 1;
      return { ok: true, deferred: true, delivery_generation: headGeneration };
    },
  });
  const first = await transport.publish({ project_id: "alpha", kind: "terminal_red_check", anchors, state: store.state });
  assert.equal(first.queued, true);
  assert.equal(first.state.deliveries[first.envelope.correlation_id].phase, "appended");
  assert.equal(first.state.deliveries[first.envelope.correlation_id].delivery_generation, "head-gen-old");
  assert.equal(rows.size, 1);
  assert.equal(wakeCalls, 1);

  const sameGeneration = await transport.resume("alpha", first.state);
  assert.equal(sameGeneration.resumed, 0);
  assert.equal(wakeCalls, 1, "same verified generation is not queued twice");
  assert.equal(rows.size, 1);

  headGeneration = "head-gen-new";
  const nextGeneration = await transport.resume("alpha", sameGeneration.state);
  assert.equal(nextGeneration.resumed, 1);
  assert.equal(nextGeneration.state.deliveries[first.envelope.correlation_id].phase, "appended");
  assert.equal(nextGeneration.state.deliveries[first.envelope.correlation_id].delivery_generation, "head-gen-new");
  assert.equal(wakeCalls, 2, "new verified Head generation receives one retry");
  assert.equal(rows.size, 1, "retry reuses the one JSONL event");

  const duplicateNewGeneration = await transport.resume("alpha", nextGeneration.state);
  assert.equal(duplicateNewGeneration.resumed, 0);
  assert.equal(wakeCalls, 2);
  assert.equal(rows.size, 1);
}

console.log("trusted-event-transport.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
