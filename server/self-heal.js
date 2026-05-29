"use strict";

// #797: Self-heal detector for the Opus 4.8 thinking-block API 400 that
// permanently bricks a `claude` agent. Once a session hits this state every
// subsequent turn 400s instantly and the agent does nothing while QuadWork
// still shows it "online". A bricked conversation is unrecoverable, so the
// only safe fix is to restart the session (which the agent re-seeds from chat
// on its next trigger).
//
// This module is pure decision + per-agent guard state so it is unit-testable
// without booting the server. The actual restart / message side effects are
// supplied by the caller as callbacks; this file performs no I/O of its own.

const COOLDOWN_MS = 60 * 1000;
const CIRCUIT_WINDOW_MS = 15 * 60 * 1000;
const CIRCUIT_MAX = 3;

// Per-agent guard state: key -> { lastAutoRestartAt, restarts: number[], breakerNotified }
const _state = new Map();

// Conservative, Anthropic-API-specific signature. `codex` agents never emit
// it. We require BOTH substrings so normal output that merely mentions
// "thinking" can never trip the detector.
function isThinkingBlock400(data) {
  return typeof data === "string"
    && data.includes("cannot be modified")
    && data.includes("thinking");
}

function breakerMessage(agent) {
  return `${agent} repeatedly hitting the thinking-block API error — auto-recovery paused, manual attention needed`;
}

// Observe a single PTY chunk and decide whether to auto-restart. Never throws:
// callback failures are swallowed so a self-heal bug can never break the PTY
// data pipeline. Returns the action taken for logging/tests:
//   "no-match" | "recovering" | "cooldown" | "breaker" | "restart"
//
// opts:
//   now         - current epoch ms (injected for testability)
//   recovering  - true while a restart for this agent is already in flight
//   onRestart   - (reason) => void  invoked when a restart should happen
//   onBreaker   - (message) => void invoked once when the circuit breaker trips
function observeChunk(key, data, opts = {}) {
  try {
    if (!isThinkingBlock400(data)) return "no-match";

    const now = opts.now;
    const agent = key.split("/")[1] || key;
    const st = _state.get(key) || { lastAutoRestartAt: -Infinity, restarts: [], breakerNotified: false };

    // Re-entrancy: a restart for this agent is already underway. The wedge
    // keeps printing the 400 on the dying PTY — ignore those lines.
    if (opts.recovering) return "recovering";

    // Cooldown: also absorbs the burst of repeated 400 lines from one wedge.
    if (now - st.lastAutoRestartAt < COOLDOWN_MS) return "cooldown";

    // Circuit breaker: drop restarts older than the window, then refuse if we
    // have already restarted CIRCUIT_MAX times inside it. An infinite restart
    // loop would only mask a deeper failure.
    st.restarts = st.restarts.filter((t) => now - t < CIRCUIT_WINDOW_MS);
    if (st.restarts.length >= CIRCUIT_MAX) {
      const firstTrip = !st.breakerNotified;
      st.breakerNotified = true;
      _state.set(key, st);
      if (firstTrip && typeof opts.onBreaker === "function") {
        try { opts.onBreaker(breakerMessage(agent)); } catch {}
      }
      return "breaker";
    }

    st.lastAutoRestartAt = now;
    st.restarts.push(now);
    _state.set(key, st);
    if (typeof opts.onRestart === "function") {
      try { opts.onRestart("thinking-block-400"); } catch {}
    }
    return "restart";
  } catch {
    // A detector bug must never break the PTY → xterm pipeline.
    return "no-match";
  }
}

// Drop guard state for an agent (e.g. on permanent stop).
function clearState(key) {
  _state.delete(key);
}

module.exports = {
  observeChunk,
  isThinkingBlock400,
  breakerMessage,
  clearState,
  _state,
  COOLDOWN_MS,
  CIRCUIT_WINDOW_MS,
  CIRCUIT_MAX,
};
