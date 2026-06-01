"use strict";

const selfHeal = require("./self-heal");
const { observeChunk, isThinkingBlock400, breakerMessage, clearState, _state, COOLDOWN_MS } = selfHeal;

// The real thinking-block 400 line emitted by claude on Opus 4.8.
const SIGNATURE =
  "API Error: 400 messages.3.content.1: 'thinking' or 'redacted_thinking' " +
  "blocks in the latest assistant message cannot be modified. These blocks " +
  "must remain as they were in the original response.";

function runTests() {
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

  const KEY = "proj/dev";

  // --- Test 1: signature match is conservative ---
  {
    assert(isThinkingBlock400(SIGNATURE), "matches the real 400 signature");
    assert(!isThinkingBlock400("I am thinking about the problem"), "does NOT match prose containing 'thinking'");
    assert(!isThinkingBlock400("this file cannot be modified"), "does NOT match 'cannot be modified' without 'thinking'");
    assert(!isThinkingBlock400(""), "does NOT match empty output");
    assert(!isThinkingBlock400(undefined), "does NOT match non-string input");
  }

  // --- Test 2: detection restarts once; second chunk within cooldown does not ---
  {
    _state.clear();
    let restarts = 0;
    const opts = { now: 1000, recovering: false, onRestart: () => { restarts++; } };

    const r1 = observeChunk(KEY, SIGNATURE, opts);
    assert(r1 === "restart" && restarts === 1, "first signature chunk triggers exactly one restart");

    // Second identical line 5s later (same wedge burst) — within 60s cooldown.
    const r2 = observeChunk(KEY, SIGNATURE, { ...opts, now: 6000 });
    assert(r2 === "cooldown" && restarts === 1, "second chunk within 60s is suppressed by cooldown");
  }

  // --- Test 3: normal output never triggers ---
  {
    _state.clear();
    let restarts = 0;
    const r = observeChunk(KEY, "● Done. The agent is thinking through next steps.", {
      now: 1000, recovering: false, onRestart: () => { restarts++; },
    });
    assert(r === "no-match" && restarts === 0, "normal output containing 'thinking' never restarts");
  }

  // --- Test 4: re-entrancy guard ---
  {
    _state.clear();
    let restarts = 0;
    const r = observeChunk(KEY, SIGNATURE, {
      now: 1000, recovering: true, onRestart: () => { restarts++; },
    });
    assert(r === "recovering" && restarts === 0, "no restart while a restart is already in flight");
  }

  // --- Test 5: circuit breaker after 3 restarts in 15 min ---
  {
    _state.clear();
    let restarts = 0;
    let breakerMsgs = [];
    const mk = (now) => observeChunk(KEY, SIGNATURE, {
      now, recovering: false,
      onRestart: () => { restarts++; },
      onBreaker: (m) => { breakerMsgs.push(m); },
    });

    // Four detections each spaced > 60s apart (defeating cooldown) but inside
    // the 15-min window.
    const step = COOLDOWN_MS + 1000;
    mk(step);          // restart 1
    mk(step * 2);      // restart 2
    mk(step * 3);      // restart 3
    const r4 = mk(step * 4); // suppressed by breaker

    assert(restarts === 3, "exactly 3 auto-restarts before the breaker trips");
    assert(r4 === "breaker", "4th detection is suppressed by the circuit breaker");
    assert(breakerMsgs.length === 1, "breaker emits the manual-attention message exactly once");
    assert(breakerMsgs[0] === breakerMessage("dev"), "breaker message names the agent and the pause");

    // Further detections stay suppressed and do NOT re-emit the message.
    const r5 = mk(step * 5);
    assert(r5 === "breaker" && breakerMsgs.length === 1, "breaker stays tripped without re-spamming the message");
  }

  // --- Test 6: a throwing callback cannot propagate out of the detector ---
  {
    _state.clear();
    let threw = false;
    let result;
    try {
      result = observeChunk(KEY, SIGNATURE, {
        now: 1000, recovering: false,
        onRestart: () => { throw new Error("boom"); },
      });
    } catch {
      threw = true;
    }
    assert(!threw, "detector swallows a throwing callback (PTY pipeline stays intact)");
    assert(result === "restart", "detection decision is still reported despite the callback throw");
  }

  // --- Test 7 (#825): clearState resets a tripped breaker, so a manual
  //     stop+restart re-enables auto-recovery. stopAgentSession(key,
  //     {clearSelfHeal:true}) calls clearState on every manual stop/restart/
  //     reset; this asserts the module behaviour that makes that effective. ---
  {
    _state.clear();
    let restarts = 0;
    let breakerMsgs = [];
    const mk = (now) => observeChunk(KEY, SIGNATURE, {
      now, recovering: false,
      onRestart: () => { restarts++; },
      onBreaker: (m) => { breakerMsgs.push(m); },
    });
    const step = COOLDOWN_MS + 1000;
    mk(step); mk(step * 2); mk(step * 3);          // 3 restarts → breaker trips
    assert(restarts === 3 && mk(step * 4) === "breaker", "precondition: breaker tripped after 3 restarts");

    // Operator manually stops the agent → stopAgentSession calls clearState.
    clearState(KEY);
    assert(!_state.has(KEY), "clearState drops the per-agent breaker/cooldown state");

    // The fresh manual session's first thinking-block 400 auto-restarts again —
    // NOT suppressed by the stale tripped window.
    const after = mk(step * 5);
    assert(after === "restart" && restarts === 4, "after clearState, auto-recovery works again (window reset, breaker no longer suppressing)");
    assert(breakerMsgs.length === 1, "the reset did not re-emit the breaker message");
  }

  // --- Test 8 (#910): respawn breaker allows up to RESPAWN_MAX in-window, then trips ---
  {
    selfHeal._respawnState.clear();
    const { shouldRespawn, respawnBreakerMessage, RESPAWN_MAX, RESPAWN_WINDOW_MS } = selfHeal;
    let breakerMsgs = [];
    const onBreaker = (m) => breakerMsgs.push(m);

    // First RESPAWN_MAX exits in the window each get a respawn.
    let respawns = 0;
    for (let i = 0; i < RESPAWN_MAX; i++) {
      if (shouldRespawn(KEY, { now: 1000 + i * 1000, onBreaker }) === "respawn") respawns++;
    }
    assert(respawns === RESPAWN_MAX, `respawns up to RESPAWN_MAX (${RESPAWN_MAX}) within the window`);

    // The next exit inside the window trips the breaker.
    const tripped = shouldRespawn(KEY, { now: 1000 + RESPAWN_MAX * 1000, onBreaker });
    assert(tripped === "breaker", "exit beyond RESPAWN_MAX in-window → breaker");
    assert(breakerMsgs.length === 1 && breakerMsgs[0] === respawnBreakerMessage("dev"), "respawn breaker notifies once, names the agent");

    // Still tripped, no re-spam, while inside the window.
    const again = shouldRespawn(KEY, { now: 1000 + (RESPAWN_MAX + 1) * 1000, onBreaker });
    assert(again === "breaker" && breakerMsgs.length === 1, "respawn breaker stays tripped without re-spamming");

    // After the window passes, attempts age out and respawn is allowed again.
    const later = shouldRespawn(KEY, { now: 1000 + RESPAWN_WINDOW_MS + 10_000, onBreaker });
    assert(later === "respawn", "after the window, old attempts age out → respawn allowed again");
  }

  // --- Test 9 (#910): clearState resets the respawn breaker too (manual stop) ---
  {
    selfHeal._respawnState.clear();
    const { shouldRespawn, RESPAWN_MAX } = selfHeal;
    // Trip the breaker: RESPAWN_MAX allowed, then the next refuses.
    for (let i = 0; i < RESPAWN_MAX; i++) shouldRespawn(KEY, { now: 1000 + i * 1000 });
    assert(shouldRespawn(KEY, { now: 1000 + RESPAWN_MAX * 1000 }) === "breaker", "precondition: respawn breaker tripped");
    clearState(KEY);
    assert(!selfHeal._respawnState.has(KEY), "clearState drops the respawn-breaker state");
    assert(shouldRespawn(KEY, { now: 1000 + RESPAWN_MAX * 1000 + 1 }) === "respawn", "after clearState, respawn allowed again (manual stop re-enables)");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
