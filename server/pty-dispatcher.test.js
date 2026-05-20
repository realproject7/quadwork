"use strict";

const {
  dispatchToAgentPTY,
  cleanupSession,
  _coalesceTimers,
  _pendingWake,
  _drainListeners,
  _lastChatSentAt,
  IDLE_THRESHOLD_MS,
  COALESCE_WINDOW_MS,
  ACTIVE_SUPPRESSION_MS,
} = require("./pty-dispatcher");

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      passed++;
      console.log(`  PASS: ${msg}`);
    } else {
      failed++;
      console.error(`  FAIL: ${msg}`);
    }
  }

  function makeSessions(overrides = {}) {
    const written = [];
    const onDataCallbacks = [];
    const term = {
      write: (data) => written.push(data),
      onData: (cb) => {
        onDataCallbacks.push(cb);
        return { dispose: () => {} };
      },
    };
    const session = {
      projectId: "proj",
      agentId: "dev",
      term,
      state: "running",
      lastOutputAt: 0,
      ...overrides,
    };
    const sessions = new Map();
    sessions.set("proj/dev", session);
    return { sessions, session, term, written, onDataCallbacks };
  }

  function makeDeps(loopPaused = false) {
    const writes = [];
    return {
      isLoopGuardPaused: () => loopPaused,
      safeWrite: (term, data) => {
        term.write(data);
        writes.push(data);
        return true;
      },
      _writes: writes,
    };
  }

  function makeMsg(overrides = {}) {
    return {
      id: 1,
      sender: "user",
      text: "hello @dev",
      type: "message",
      mentions: ["dev"],
      ...overrides,
    };
  }

  // --- Test 1: system messages are not injected ---
  {
    const { sessions, written } = makeSessions();
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ type: "system" }), sessions, deps);
    assert(written.length === 0, "system messages not injected");
    cleanupSession("proj/dev");
  }

  // --- Test 2: loop guard paused — no injection ---
  {
    const { sessions, written } = makeSessions();
    const deps = makeDeps(true);
    dispatchToAgentPTY("proj", makeMsg(), sessions, deps);
    assert(written.length === 0, "no injection when loop guard paused");
    cleanupSession("proj/dev");
  }

  // --- Test 3: message without mentions — no injection ---
  {
    const { sessions, written } = makeSessions();
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ mentions: [] }), sessions, deps);
    assert(written.length === 0, "no injection without mentions");
    cleanupSession("proj/dev");
  }

  // --- Test 4: idle agent receives injection ---
  {
    const { sessions, written } = makeSessions({ lastOutputAt: 0 });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg(), sessions, deps);
    // Coalesce timer is pending — wait for it
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length >= 1, "idle agent receives injected message");
    assert(written[0].includes("You are @dev"), "injection includes agent identity");
    assert(written[0].includes("chat_read"), "injection instructs agent to call chat_read");
    assert(!written[0].includes("hello @dev"), "injection does NOT include raw message content");
    cleanupSession("proj/dev");
  }

  // --- Test 5: busy agent queues pending wake, fallback timer drains it ---
  {
    const { sessions, written } = makeSessions({ lastOutputAt: Date.now() });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ id: 42, text: "check PR #99" }), sessions, deps);
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length === 0, "busy agent does not get immediate injection");
    assert(_pendingWake.has("proj/dev"), "pending wake is set for busy agent");
    // Wait for fallback drain timer (IDLE_THRESHOLD_MS)
    await new Promise((r) => setTimeout(r, IDLE_THRESHOLD_MS + 100));
    assert(written.length >= 1, "fallback drain fires without further PTY output");
    assert(written[0].includes("You are @dev"), "drain prompt includes agent identity");
    assert(written[0].includes("chat_read"), "drain prompt instructs chat_read");
    assert(!_pendingWake.has("proj/dev"), "pending wake cleared after drain");
    cleanupSession("proj/dev");
  }

  // --- Test 6: burst coalescing — multiple mentions produce one injection ---
  {
    const { sessions, written } = makeSessions({ lastOutputAt: 0 });
    const deps = makeDeps();
    for (let i = 0; i < 5; i++) {
      dispatchToAgentPTY("proj", makeMsg({ id: i + 1, sender: `agent${i}`, text: `msg ${i}` }), sessions, deps);
    }
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length >= 1, "coalesced injection fires");
    assert(written[0].includes("You are @dev"), "coalesced injection uses identity prompt");
    cleanupSession("proj/dev");
  }

  // --- Test 7: agent does not inject message to itself ---
  {
    const { sessions, written } = makeSessions({ lastOutputAt: 0 });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "dev", mentions: ["dev"] }), sessions, deps);
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length === 0, "agent does not inject its own message");
    cleanupSession("proj/dev");
  }

  // --- Test 8: stopped agent session — no injection ---
  {
    const { sessions, written } = makeSessions({ state: "stopped", lastOutputAt: 0 });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg(), sessions, deps);
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length === 0, "stopped agent does not receive injection");
    cleanupSession("proj/dev");
  }

  // --- Test 10: active agent suppression — recently sent message skips injection ---
  {
    const { sessions, written } = makeSessions({ lastOutputAt: 0 });
    const deps = makeDeps();
    // Simulate dev having sent a message recently
    _lastChatSentAt.set("proj/dev", Date.now());
    dispatchToAgentPTY("proj", makeMsg({ sender: "head", mentions: ["dev"] }), sessions, deps);
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length === 0, "recently active agent is not injected");
    cleanupSession("proj/dev");
  }

  // --- Test 11: active suppression expires — agent receives injection after cooldown ---
  {
    const { sessions, written } = makeSessions({ lastOutputAt: 0 });
    const deps = makeDeps();
    // Set lastChatSentAt to well past the suppression window
    _lastChatSentAt.set("proj/dev", Date.now() - ACTIVE_SUPPRESSION_MS - 1000);
    dispatchToAgentPTY("proj", makeMsg({ sender: "head", mentions: ["dev"] }), sessions, deps);
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length >= 1, "agent receives injection after suppression window expires");
    cleanupSession("proj/dev");
  }

  // --- Test 12: sender's lastChatSentAt is tracked ---
  {
    const { sessions } = makeSessions({ lastOutputAt: 0 });
    // Add a "head" session so the sender is recognized as an agent
    sessions.set("proj/head", { projectId: "proj", agentId: "head", term: null, state: "stopped" });
    const deps = makeDeps();
    _lastChatSentAt.delete("proj/head");
    dispatchToAgentPTY("proj", makeMsg({ sender: "head", mentions: ["dev"] }), sessions, deps);
    assert(_lastChatSentAt.has("proj/head"), "sender's lastChatSentAt is tracked");
    cleanupSession("proj/dev");
    cleanupSession("proj/head");
  }

  // --- Test 9: cleanupSession clears all state ---
  {
    _coalesceTimers.set("proj/dev", { timer: setTimeout(() => {}, 10000), messages: [] });
    _pendingWake.set("proj/dev", true);
    cleanupSession("proj/dev");
    assert(!_coalesceTimers.has("proj/dev"), "cleanupSession clears coalesce timer");
    assert(!_pendingWake.has("proj/dev"), "cleanupSession clears pending wake");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// Wrap in async IIFE for await support
(async () => { await runTests(); })().catch((err) => {
  console.error(err);
  process.exit(1);
});
