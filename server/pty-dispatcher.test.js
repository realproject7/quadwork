"use strict";

const {
  dispatchToAgentPTY,
  cleanupSession,
  capEligible,
  _coalesceTimers,
  _pendingWake,
  _drainListeners,
  _lastChatSentAt,
  _lastCapInjectedAt,
  _submitTimers,
  _setTimingsForTest,
  IDLE_THRESHOLD_MS,
  COALESCE_WINDOW_MS,
  ACTIVE_SUPPRESSION_MS,
  MAX_DEFER_MS,
  CAP_COOLDOWN_MS,
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
        // #1010: a real node-pty disposable detaches the listener. Modelling that
        // lets the tests assert the drain listener was actually disposed (and
        // stops a disposed cycle from being driven by a repaint loop).
        return {
          dispose: () => {
            const i = onDataCallbacks.indexOf(cb);
            if (i >= 0) onDataCallbacks.splice(i, 1);
          },
        };
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

  // --- Test 10: #923 — a recently-active agent's mention is DEFERRED, not
  //     dropped. It must not inject mid-activity, but it must still wake once
  //     the agent goes quiet (the old behavior dropped it, stranding a
  //     standing-by agent until the next scheduled-trigger pulse). ---
  {
    const { sessions, written } = makeSessions({ lastOutputAt: 0 });
    const deps = makeDeps();
    // Simulate dev having sent a message recently (then its turn ended → idle).
    _lastChatSentAt.set("proj/dev", Date.now());
    dispatchToAgentPTY("proj", makeMsg({ sender: "head", mentions: ["dev"] }), sessions, deps);
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length === 0, "recently-active agent is not injected immediately (no mid-activity barge-in)");
    assert(_pendingWake.has("proj/dev"), "#923: recently-active mention is QUEUED as a pending wake, not dropped");
    // Fallback drain fires after the idle window with no further PTY output.
    await new Promise((r) => setTimeout(r, IDLE_THRESHOLD_MS + 100));
    assert(written.length >= 1, "#923: deferred wake drains once the agent is quiet — no scheduled-trigger pulse needed");
    assert(written[0].includes("You are @dev"), "drained wake uses the identity prompt");
    assert(!_pendingWake.has("proj/dev"), "pending wake cleared after drain");
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

  // --- Test 13: re1 on #923 — the idle decision can go STALE during the 1s
  //     coalesce window. If the target posts a message (becomes recently-sent)
  //     before the timer fires, the wake must be DEFERRED (pending wake), not
  //     injected mid-activity (#736) and not lost (#923). ---
  {
    const { sessions, written } = makeSessions({ lastOutputAt: 0 });
    const deps = makeDeps();
    // Idle + not-recently-active at dispatch → takes the coalesce path.
    dispatchToAgentPTY("proj", makeMsg({ sender: "head", mentions: ["dev"] }), sessions, deps);
    // Agent posts a chat message DURING the coalesce window → now recently-sent.
    _lastChatSentAt.set("proj/dev", Date.now());
    await new Promise((r) => setTimeout(r, COALESCE_WINDOW_MS + 50));
    assert(written.length === 0, "stale-coalesce: now-active agent is NOT injected mid-activity (#736 preserved)");
    assert(_pendingWake.has("proj/dev"), "stale-coalesce: wake is DEFERRED to a pending wake, not dropped (#923)");
    // Drains once the agent is quiet (no further PTY output).
    await new Promise((r) => setTimeout(r, IDLE_THRESHOLD_MS + 100));
    assert(written.length >= 1, "stale-coalesce: deferred wake still fires once the agent goes quiet — not lost");
    assert(!_pendingWake.has("proj/dev"), "stale-coalesce: pending wake cleared after drain");
    cleanupSession("proj/dev");
  }

  // --- Test 9: cleanupSession clears all state ---
  {
    _coalesceTimers.set("proj/dev", { timer: setTimeout(() => {}, 10000), messages: [] });
    _pendingWake.set("proj/dev", true);
    cleanupSession("proj/dev");
    assert(!_coalesceTimers.has("proj/dev"), "cleanupSession clears coalesce timer");
    assert(!_pendingWake.has("proj/dev"), "cleanupSession clears pending wake");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // #1010: bounded deferred-wake cap under continuous TUI repaint.
  //
  // The bug these cover was invisible to the suite above because NO test ever
  // invoked the captured onData callbacks — the `resetIdleTimer()` path was
  // unreachable, so a repainting TUI could starve wake delivery forever and the
  // suite stayed green. Every case below drives onData on a sub-idle-threshold
  // interval, which is what makes it a real regression test.
  //
  // Timings are overridden to millisecond scale via _setTimingsForTest so these
  // run in ~6 s rather than ~2 min at the shipped 10 s cap / 30 s cooldown.
  // ══════════════════════════════════════════════════════════════════════════
  const KEY = "proj/dev";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const prompts = (written) => written.filter((w) => w.includes("You are @dev")).length;

  // Drive the captured onData callbacks like the Claude TUI's ~200 ms status-line
  // repaint: fast enough that the idle timer is reset before it can ever fire.
  function startRepaint(onDataCallbacks, intervalMs) {
    const handle = setInterval(() => {
      for (const cb of [...onDataCallbacks]) cb("\x1b[2K\x1b[1G· idle spinner");
    }, intervalMs);
    return () => clearInterval(handle);
  }

  // --- Test 14: #1010 core regression — a repainting Claude TUI still gets its
  //     wake, exactly once, at the cap. FAILS before the fix (0 injections:
  //     onData resets the only drain timer every 40 ms, so the idle gap never
  //     arrives and the wake is starved indefinitely). ---
  {
    _setTimingsForTest({ idleThresholdMs: 250, maxDeferMs: 300, capCooldownMs: 1000, activeSuppressionMs: 800 });
    const { sessions, written, onDataCallbacks } = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), sessions, deps);
    const stopRepaint = startRepaint(onDataCallbacks, 40);
    await sleep(150);
    assert(prompts(written) === 0, "#1010: repainting Claude agent is not injected before the cap");
    await sleep(400);
    assert(prompts(written) === 1, "#1010 REGRESSION: a continuously repainting Claude TUI receives its wake at the cap (pre-fix: never)");
    await sleep(300);
    assert(prompts(written) === 1, "#1010: the cap delivers exactly once — the same cycle's idle timer cannot double-inject");
    stopRepaint();
    cleanupSession(KEY);
  }

  // --- Test 15: #1010 — codex/gemini keep genuine-idleness-only delivery. No
  //     cap-driven text may land in an actively streaming turn; the wake must
  //     still be DEFERRED (not dropped) and land once the stream stops. ---
  for (const backend of ["codex", "gemini"]) {
    _setTimingsForTest({ idleThresholdMs: 250, maxDeferMs: 300, capCooldownMs: 1000, activeSuppressionMs: 800 });
    const { sessions, written, onDataCallbacks } = makeSessions({ backend, lastOutputAt: Date.now() });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), sessions, deps);
    const stopRepaint = startRepaint(onDataCallbacks, 40);
    await sleep(700); // well past the cap
    assert(prompts(written) === 0, `#1010: ${backend} is NOT cap-injected during a continuously streaming turn`);
    assert(_pendingWake.has(KEY), `#1010: ${backend}'s wake is still DEFERRED, not dropped`);
    stopRepaint(); // the turn ends → genuine quiescence
    await sleep(350);
    assert(prompts(written) === 1, `#1010: ${backend} still wakes on a genuine idle gap (pre-#1010 behavior preserved)`);
    cleanupSession(KEY);
  }

  // --- Test 16: #1010 — a cap armed from the recent-send path must not preempt
  //     the active-send suppression window (#736). It re-arms once for the
  //     remainder instead of barging in. ---
  {
    _setTimingsForTest({ idleThresholdMs: 250, maxDeferMs: 200, capCooldownMs: 3000, activeSuppressionMs: 800 });
    const { sessions, written, onDataCallbacks } = makeSessions({ backend: "claude", lastOutputAt: 0 });
    const deps = makeDeps();
    _lastChatSentAt.set(KEY, Date.now()); // agent posted just now → presumed mid-turn
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), sessions, deps);
    // The recent-send branch defers at dispatch time, so the cycle (and its cap)
    // is already armed here. Start the repaint immediately: without it the idle
    // timer would win and deliver on genuine quiescence (#923), which is correct
    // behavior but not the path under test.
    const stopRepaint = startRepaint(onDataCallbacks, 40);
    assert(_pendingWake.has(KEY), "#1010: recent-send mention is deferred into a pending wake");
    await sleep(400); // past maxDeferMs, still inside activeSuppressionMs
    assert(prompts(written) === 0, "#1010: the cap does NOT fire inside the active-send suppression window (#736 preserved)");
    await sleep(700); // suppression window has now closed
    assert(prompts(written) === 1, "#1010: the re-armed cap delivers once the suppression window closes");
    stopRepaint();
    cleanupSession(KEY);
  }

  // --- Test 17: #1010 — repeated deferred mentions during one long repainting
  //     turn yield one injection per cooldown window, and the next pending wake
  //     is deferred rather than discarded (no wake storm → no loop-guard trip). ---
  {
    _setTimingsForTest({ idleThresholdMs: 400, maxDeferMs: 150, capCooldownMs: 700, activeSuppressionMs: 0 });
    const { sessions, written, onDataCallbacks } = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ id: 1, sender: "head" }), sessions, deps);
    const stopRepaint = startRepaint(onDataCallbacks, 40);
    await sleep(250);
    assert(prompts(written) === 1, "#1010 cooldown: the first cap delivery lands");
    // Second mention arrives while the same long turn is still repainting.
    dispatchToAgentPTY("proj", makeMsg({ id: 2, sender: "re1" }), sessions, deps);
    await sleep(300); // past a second cap interval, still inside the cooldown
    assert(prompts(written) === 1, "#1010 cooldown: a second cap injection is withheld inside the cooldown window");
    assert(_pendingWake.has(KEY), "#1010 cooldown: the withheld wake is DEFERRED, not dropped");
    await sleep(500); // cooldown closes
    assert(prompts(written) === 2, "#1010 cooldown: the deferred wake is delivered when the cooldown expires");
    stopRepaint();
    cleanupSession(KEY);
  }

  // --- Test 18: #1010 — one lifecycle. After an idle drain, a cap drain, and
  //     cleanupSession, no pending wake, listener, timer handle or delayed-submit
  //     handle remains, and a delivered cycle's stale callbacks cannot affect the
  //     next cycle. ---
  {
    // 18a: idle drain disposes listener + handles, and the submit timer is
    // released once it fires.
    _setTimingsForTest({ idleThresholdMs: 150, maxDeferMs: 5000, capCooldownMs: 1000, activeSuppressionMs: 0 });
    const { sessions, written, onDataCallbacks } = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), sessions, deps);
    assert(onDataCallbacks.length === 1, "#1010 lifecycle: the deferred-wake cycle hooks exactly one onData listener");
    await sleep(250);
    assert(prompts(written) === 1, "#1010 lifecycle: idle drain delivers");
    assert(!_pendingWake.has(KEY), "#1010 lifecycle: idle drain clears the pending wake");
    assert(!_drainListeners.has(KEY), "#1010 lifecycle: idle drain clears the cycle state (both timer handles)");
    assert(onDataCallbacks.length === 0, "#1010 lifecycle: idle drain disposes the onData listener");
    assert(_submitTimers.has(KEY), "#1010 lifecycle: the delayed submit timer is owned while pending");
    await sleep(400);
    assert(!_submitTimers.has(KEY), "#1010 lifecycle: the delayed submit timer releases itself after firing");
    assert(deps._writes.includes("\r"), "#1010 lifecycle: the submit CR is still written on the normal path");
    cleanupSession(KEY);

    // 18b: cap drain leaves nothing behind, and the delivered cycle's surviving
    // idle timer cannot inject into the NEXT cycle (cross-cycle staleness).
    _setTimingsForTest({ idleThresholdMs: 400, maxDeferMs: 150, capCooldownMs: 0, activeSuppressionMs: 0 });
    const b = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const depsB = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ id: 1, sender: "head" }), b.sessions, depsB);
    const stopRepaint = startRepaint(b.onDataCallbacks, 40);
    await sleep(250);
    assert(prompts(b.written) === 1, "#1010 lifecycle: cap drain delivers");
    assert(!_pendingWake.has(KEY) && !_drainListeners.has(KEY), "#1010 lifecycle: cap drain clears pending wake + cycle state");
    assert(b.onDataCallbacks.length === 0, "#1010 lifecycle: cap drain disposes the onData listener");
    dispatchToAgentPTY("proj", makeMsg({ id: 2, sender: "re1" }), b.sessions, depsB);
    const stopRepaint2 = startRepaint(b.onDataCallbacks, 40);
    await sleep(600); // past the new cap AND past the previous cycle's idle deadline
    assert(prompts(b.written) === 2, "#1010 lifecycle: the next cycle delivers exactly once — no stale timer from the delivered cycle fires into it");
    stopRepaint();
    stopRepaint2();
    cleanupSession(KEY);

    // 18c: cleanupSession during the submit delay cancels the CR write, so a
    // stopped session's dead term is never written to.
    _setTimingsForTest({ idleThresholdMs: 150, maxDeferMs: 5000, capCooldownMs: 0, activeSuppressionMs: 0 });
    const c = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const depsC = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), c.sessions, depsC);
    await sleep(250);
    assert(prompts(c.written) === 1 && _submitTimers.has(KEY), "#1010 lifecycle: injection wrote the prompt and armed the submit timer");
    cleanupSession(KEY); // operator stops the agent inside the submit delay
    assert(!_submitTimers.has(KEY), "#1010 lifecycle: cleanupSession cancels the pending delayed-submit timer");
    await sleep(400);
    assert(!depsC._writes.includes("\r"), "#1010 lifecycle: no CR is written to a term whose session was stopped mid-delay");
  }

  // --- Test 19: #1010 — a cap that fires after the session is gone performs no
  //     write. The armed session object is stale by then; delivery must
  //     re-resolve by key and require a running session with a live term. ---
  {
    _setTimingsForTest({ idleThresholdMs: 400, maxDeferMs: 150, capCooldownMs: 0, activeSuppressionMs: 0 });
    const { sessions, session, written, onDataCallbacks } = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), sessions, deps);
    const stopRepaint = startRepaint(onDataCallbacks, 40);
    session.state = "stopped"; // agent exits before the cap deadline
    await sleep(300);
    assert(prompts(written) === 0, "#1010: a cap firing on a no-longer-running session performs no write");
    assert(!_pendingWake.has(KEY) && !_drainListeners.has(KEY), "#1010: that cycle stands down cleanly instead of leaking");
    stopRepaint();
    cleanupSession(KEY);

    // #1010: eligibility is re-checked against the LIVE session. If the agent was
    // respawned onto another backend after the cycle was armed, the cap must
    // stand down — but the wake stays deferred and the idle path still delivers.
    const r = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const depsR = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), r.sessions, depsR);
    const stopRepaintR = startRepaint(r.onDataCallbacks, 40);
    r.sessions.set(KEY, { ...r.session, backend: "codex" }); // respawned onto codex
    await sleep(300);
    assert(prompts(r.written) === 0, "#1010: a cap armed on Claude does not inject after the session is respawned onto codex");
    assert(_pendingWake.has(KEY), "#1010: that wake stays deferred for the idle-gap path rather than being dropped");
    stopRepaintR();
    await sleep(500); // stream stops → genuine quiescence
    assert(prompts(r.written) === 1, "#1010: the respawned codex session still wakes on a genuine idle gap");
    cleanupSession(KEY);

    // Same guard for a running session whose term was torn down.
    const d = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const depsD = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), d.sessions, depsD);
    const stopRepaintD = startRepaint(d.onDataCallbacks, 40);
    d.session.term = null;
    await sleep(300);
    assert(depsD._writes.length === 0, "#1010: a cap firing on a session with no live term performs no write");
    stopRepaintD();
    cleanupSession(KEY);
  }

  // --- Test 20: #1010 — the per-cycle identity guard is load-bearing. A timer
  //     that outlived its own cycle must not inject, must not dispose the cycle
  //     that superseded it, and must not consume that cycle's pending wake.
  //
  //     @re2 on PR #1020: test 18b asserted this property but could not
  //     discriminate it — by the time the cap drain returns, cleanupDrainListener
  //     has already cleared both handles, so no stale timer ever exists and
  //     replacing the guard with `() => true` left the suite green. This case
  //     constructs the stale timer explicitly: arm a cycle, supersede it in
  //     `_drainListeners` while its cap is still pending, then let that cap fire.
  {
    _setTimingsForTest({ idleThresholdMs: 800, maxDeferMs: 200, capCooldownMs: 0, activeSuppressionMs: 0 });
    const { sessions, written, onDataCallbacks } = makeSessions({ backend: "claude", lastOutputAt: Date.now() });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), sessions, deps);
    const stopRepaint = startRepaint(onDataCallbacks, 40);

    // Supersede the armed cycle. Its cap timer is still pending and WILL fire.
    let sentinelDisposed = false;
    const sentinel = {
      disposable: { dispose: () => { sentinelDisposed = true; } },
      idleHandle: null,
      capHandle: null,
      capRearmed: false,
    };
    _drainListeners.set(KEY, sentinel);

    await sleep(400); // past the superseded cycle's cap deadline
    assert(prompts(written) === 0, "#1010 stale-cycle: a cap timer that outlived its cycle performs no injection");
    assert(_drainListeners.get(KEY) === sentinel && !sentinelDisposed, "#1010 stale-cycle: it does not dispose the cycle that superseded it");
    assert(_pendingWake.has(KEY), "#1010 stale-cycle: it does not consume the superseding cycle's pending wake");

    stopRepaint();
    _drainListeners.delete(KEY);
    cleanupSession(KEY);
  }

  // --- Test 21: #1023 — grok is the second continuously-repainting backend.
  //     Measured under node-pty, its TUI emitted 195 output events over a 40 s
  //     idle window with a max quiet gap of 2551 ms, so the drain's idle gap
  //     never arrives and EVERY mention to a grok agent takes the defer path.
  //     Without the cap a grok agent is inert in production while the whole
  //     suite stays green — the same starvation #1010 fixed for Claude. ---
  {
    _setTimingsForTest({ idleThresholdMs: 250, maxDeferMs: 300, capCooldownMs: 1000, activeSuppressionMs: 800 });
    const { sessions, written, onDataCallbacks } = makeSessions({ backend: "grok", lastOutputAt: Date.now() });
    const deps = makeDeps();
    dispatchToAgentPTY("proj", makeMsg({ sender: "head" }), sessions, deps);
    const stopRepaint = startRepaint(onDataCallbacks, 40);
    await sleep(150);
    assert(prompts(written) === 0, "#1023: a repainting grok agent is not injected before the cap");
    await sleep(400);
    assert(prompts(written) === 1, "#1023 REGRESSION: a continuously repainting grok TUI receives its wake at the cap (without the grok arm: never)");
    await sleep(300);
    assert(prompts(written) === 1, "#1023: the cap delivers exactly once for grok too");
    stopRepaint();
    cleanupSession(KEY);
  }

  // --- Test 22: #1023 — the eligibility predicate itself. Test 15 already
  //     pins codex/gemini behaviorally; this adds the fail-safe direction,
  //     which no repaint test can reach: a session with no backend stamp (an
  //     older object, an error placeholder) must stay ineligible rather than
  //     barge in. ---
  {
    assert(capEligible({ backend: "grok" }) === true, "#1023 AC: capEligible({backend:'grok'}) is true");
    assert(capEligible({ backend: "claude" }) === true, "#1023: claude stays eligible (#1010 preserved)");
    assert(capEligible({ backend: "codex" }) === false, "#1023 AC: capEligible({backend:'codex'}) stays false");
    assert(capEligible({ backend: "gemini" }) === false, "#1023: gemini stays false — its TUI goes quiet between turns");
    assert(capEligible({}) === false, "#1023 AC: an unstamped session stays INELIGIBLE (fail-safe direction preserved)");
    assert(capEligible(null) === false, "#1023: a missing session is ineligible, not a crash");
  }

  // Restore the shipped timings so nothing after this block runs on test values.
  _setTimingsForTest();
  assert(MAX_DEFER_MS === 10000 && CAP_COOLDOWN_MS === ACTIVE_SUPPRESSION_MS, "#1010: shipped cap is 10s and the cap cooldown matches the active-suppression window");
  assert(!_lastCapInjectedAt.has(KEY), "#1010: cleanupSession clears the per-key cap cooldown");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// Wrap in async IIFE for await support
(async () => { await runTests(); })().catch((err) => {
  console.error(err);
  process.exit(1);
});
