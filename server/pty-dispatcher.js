/**
 * #730: PTY injection dispatcher — deliver chat messages to agents via
 * terminal stdin when they are @mentioned. Primary delivery mechanism
 * for file-chat mode; agents treat injected text as user prompts.
 */

const IDLE_THRESHOLD_MS = 5000;
const COALESCE_WINDOW_MS = 1000;
const ACTIVE_SUPPRESSION_MS = 30000;

// #1010: bounded deferred-wake deadline — an escape hatch for the starvation
// below, for the backends whose TUI never goes quiet. The Claude Code TUI
// repaints its status line ~5x/sec even when idle, so the drain's idle timer
// (reset on every onData) never sees the IDLE_THRESHOLD_MS gap and a deferred
// wake is starved indefinitely. This deadline is NOT postponed by output.
//
// #1023: grok is in the same class — measured under node-pty over a 40 s idle
// window, its TUI emitted 195 output events with a max quiet gap of 2551 ms,
// never the 5 s the drain needs (codex control: 0 events / 40000 ms). It is
// still NOT all backends: codex and gemini TUIs do go quiet between turns, so
// their defers already drain on genuine quiescence, and a wall-clock deadline
// would instead barge into a legitimately long streaming turn (build/test
// output). Idle-gap delivery stays the preferred path for every backend; the
// cap only breaks the starvation.
const MAX_DEFER_MS = 10000;

// #1010: after a CAP-driven injection we have no evidence the agent's turn
// ended — unlike an idle-gap drain, which proves quiescence. So a further cap
// delivery for that key is held for the same window we already treat an agent's
// own chat post as "probably still mid-turn" (#736). Held wakes are DEFERRED,
// never dropped, so repeated mentions during one long turn cannot become a wake
// storm — which matters because the loop guard pauses the whole project after 30
// agent-to-agent messages and a paused guard stops wake dispatch entirely.
const CAP_COOLDOWN_MS = ACTIVE_SUPPRESSION_MS;

// #1010: the timings above are read through this indirection so the dispatcher
// tests can run the repaint/cap/cooldown regressions at millisecond scale
// instead of real seconds. Production never calls the setter.
const DEFAULT_TIMINGS = {
  idleThresholdMs: IDLE_THRESHOLD_MS,
  maxDeferMs: MAX_DEFER_MS,
  capCooldownMs: CAP_COOLDOWN_MS,
  activeSuppressionMs: ACTIVE_SUPPRESSION_MS,
};
let _timings = { ...DEFAULT_TIMINGS };

// Per-agent coalescing timers: key = "project/agent" → timeout handle
const _coalesceTimers = new Map();

// Per-agent last chat send timestamp: key = "project/agent" → epoch ms
const _lastChatSentAt = new Map();

// Per-agent pending wake flag: key = "project/agent" → true
const _pendingWake = new Map();

// Per-agent deferred-wake cycle state: key = "project/agent" →
// { disposable, idleHandle, capHandle, capRearmed }. #1010: one object owns the
// whole cycle (listener + both timers) so every terminal path disposes all of
// it, and a timer that outlives its own cycle can be recognized as stale.
const _drainListeners = new Map();

// #1010: last CAP-driven injection per key = "project/agent" → epoch ms.
// Idle-gap deliveries are NOT recorded — they prove the turn ended, so they are
// not rate-limited.
const _lastCapInjectedAt = new Map();

// #1010: the delayed submit ("\r") timer per key = "project/agent" → handle.
// Previously unowned, so stopping a session inside the submit delay left a
// pending write against a dead term.
const _submitTimers = new Map();

/**
 * Dispatch a chat message to mentioned agents' PTYs.
 *
 * @param {string} projectId
 * @param {object} msg - The appended message record (has .mentions, .sender, .text, .id, .type)
 * @param {Map} agentSessions - The global agentSessions map
 * @param {object} deps - { isLoopGuardPaused, safeWrite }
 */
function dispatchToAgentPTY(projectId, msg, agentSessions, deps) {
  if (!projectAdmitted(deps, projectId)) return;
  if (!msg || msg.type === "system") return;
  if (deps.isLoopGuardPaused(projectId)) return;
  if (!msg.mentions || msg.mentions.length === 0) return;

  // Track when this sender last posted (for active-agent suppression)
  const senderKey = `${projectId}/${msg.sender}`;
  if (agentSessions.has(senderKey)) {
    _lastChatSentAt.set(senderKey, Date.now());
  }

  for (const agentId of msg.mentions) {
    const key = `${projectId}/${agentId}`;
    const session = agentSessions.get(key);
    if (!session || !session.term || session.state !== "running") continue;
    if (msg.sender === agentId) continue;

    // An agent is "active" if it is producing PTY output right now (mid-turn)
    // OR it sent a chat message very recently (#736 — it's likely still in the
    // turn it sent from and will re-read chat itself). Either way we must not
    // inject mid-activity.
    //
    // #923: but we must NOT drop the mention either. The old code `continue`d
    // on the recent-send case, so a mention that landed within the suppression
    // window was lost — stranding a standing-by agent (whose turn had actually
    // ENDED after it posted) on stale chat until the next scheduled-trigger
    // pulse re-dispatched it (up to ~15 min). Instead DEFER via a pending wake
    // that drains once the agent goes quiet, so the mention reliably starts a
    // new turn within seconds. The scheduled trigger is now only a periodic
    // backstop, not the primary wake mechanism for direct assignments.
    const lastSent = _lastChatSentAt.get(key);
    const recentlySent = lastSent && (Date.now() - lastSent < _timings.activeSuppressionMs);
    if (isAgentBusy(session) || recentlySent) {
      queuePendingWake(key, session, agentSessions, deps);
      continue;
    }

    scheduleCoalescedInjection(key, projectId, agentId, msg, agentSessions, deps);
  }
}

// #1034: delayed dispatcher work must consult the same server-owned archive
// authority as the immediate mention path. Treat a missing callback as admitted
// for backwards-compatible unit callers; production always supplies it.
function projectAdmitted(deps, projectId) {
  if (!deps || typeof deps.isProjectAdmitted !== "function") return true;
  try { return deps.isProjectAdmitted(projectId) === true; }
  catch { return false; }
}

function isAgentBusy(session) {
  return session.lastOutputAt && (Date.now() - session.lastOutputAt < _timings.idleThresholdMs);
}

/**
 * #1010: may this session's deferred wake use the bounded cap?
 *
 * The continuously-repainting backends only — claude (#1010) and grok (#1023).
 * `session.backend` is the CLI base name stamped on the session at spawn
 * (server/index.js). A session without it — an older object, an error
 * placeholder — is treated as NOT eligible, so the fail-safe direction is the
 * pre-#1010 behavior (genuine-quiescence-only) rather than a barge-in.
 */
const CAP_ELIGIBLE_BACKENDS = new Set(["claude", "grok"]);

function capEligible(session) {
  return !!session && CAP_ELIGIBLE_BACKENDS.has(session.backend);
}

/**
 * Queue a pending wake for a busy/recently-active agent (#923: defer, never
 * drop). One cycle per key: `term.onData` resets an idle timer, so the wake
 * drains once the agent has been quiet for the idle window. For claude and grok
 * a second timer — the #1010 cap — bounds the wait, because a continuously
 * repainting TUI means the idle gap never arrives.
 *
 * @param {string} key - "project/agent"
 * @param {object} session - the session that armed the cycle (for backend + term)
 * @param {Map} agentSessions - re-resolved at fire time; the armed session may be dead by then
 * @param {object} deps - { isLoopGuardPaused, safeWrite }
 */
function queuePendingWake(key, session, agentSessions, deps) {
  _pendingWake.set(key, true);

  // A cycle is already armed for this key — the pending flag above is all a
  // repeat mention needs. Do NOT arm a second listener or a second cap.
  if (_drainListeners.has(key)) return;

  const state = { disposable: null, idleHandle: null, capHandle: null, capRearmed: false };

  // #1010: only the cycle currently registered under this key may drain. A
  // timer that outlived its own cycle (replaced, cleaned up, or already
  // delivered) holds a stale `state`, so it can never consume or dispose a
  // later cycle's pending wake.
  const isCurrentCycle = () => _drainListeners.get(key) === state;

  // #1010: the session captured at arm time may have exited or been respawned
  // before a timer fires. Re-resolve by key and require a live, running term —
  // the same check the coalesce path already makes at fire time.
  const resolveLive = () => {
    const live = agentSessions.get(key);
    return live && live.state === "running" && live.term ? live : null;
  };

  const deliver = (live) => {
    _pendingWake.delete(key);
    cleanupDrainListener(key);
    injectIntoTerm(key, live.term, buildInjectionPrompt(live.agentId), deps);
  };

  // Shared preamble for both timers: returns the live session, or null if this
  // cycle should simply stand down.
  const claimCycle = () => {
    if (!isCurrentCycle()) return null;
    const projectId = key.split("/")[0];
    if (!projectAdmitted(deps, projectId)) {
      _pendingWake.delete(key);
      cleanupDrainListener(key);
      return null;
    }
    if (!_pendingWake.get(key)) {
      cleanupDrainListener(key);
      return null;
    }
    const live = resolveLive();
    if (!live) {
      _pendingWake.delete(key);
      cleanupDrainListener(key);
      return null;
    }
    return live;
  };

  const idleDrain = () => {
    const live = claimCycle();
    if (!live) return;

    // #923: fire unconditionally once the agent has been quiet for the idle
    // window. Do NOT re-suppress on a recent send here — a standing-by agent
    // that just posted (then ended its turn) would otherwise be stranded again,
    // which is the exact stall this path removes. The quiet gap IS the evidence
    // the turn ended, so this delivery is not cooldown-limited either.
    deliver(live);
  };

  const capDrain = () => {
    const live = claimCycle();
    if (!live) return;

    // #1010: re-check eligibility against the LIVE session, not just the one
    // that armed the cycle. If the agent was respawned onto another backend in
    // the meantime, stand down and leave the wake to the idle-gap path — a cap
    // must never inject into a codex/gemini turn. The cycle stays armed, so the
    // pending wake is still delivered on genuine quiescence.
    if (!capEligible(live)) return;

    // #736: the cap must not preempt the deliberate active-send suppression
    // window. If the agent posted recently it is probably still mid-turn, so
    // re-arm ONCE for whatever remains of that window instead of barging in.
    //
    // `capRearmed` is per-cycle and spent on first use, so total deferral is
    // bounded by MAX_DEFER_MS + ACTIVE_SUPPRESSION_MS for a single post. An
    // agent that posts AGAIN during the re-arm window is injected inside a fresh
    // suppression window — deliberate: the alternative is re-arming per post,
    // which a chatty agent could extend indefinitely, recreating the starvation
    // this cap exists to bound.
    //
    // That bounded barge-in is only acceptable because a cap-eligible TUI QUEUES
    // input received mid-turn rather than interrupting on it — otherwise the cap
    // would trade a starvation bug for turn corruption. This must be established
    // per backend, not inherited: it is why the predicate is an explicit set and
    // not "every backend that repaints".
    //   - claude (#1010): queues.
    //   - grok (#1023): queues. Verified by the PO against the CLI's own bundled
    //     docs, `~/.grok/docs/user-guide/03-keyboard-shortcuts.md:182-183` — a
    //     plain Enter WITH text in the composer queues a follow-up that runs
    //     after the current turn ends; only a BARE Enter on an EMPTY composer
    //     force-sends the top queued item, and cancel-and-send is a separate
    //     chord. injectIntoTerm (:348-359) always writes the text before its
    //     single "\r", so the composer is never empty when the CR lands and an
    //     injection cannot cancel a running grok turn.
    const lastSent = _lastChatSentAt.get(key);
    const remainingSuppression = lastSent
      ? _timings.activeSuppressionMs - (Date.now() - lastSent)
      : 0;
    if (!state.capRearmed && remainingSuppression > 0) {
      state.capRearmed = true;
      state.capHandle = setTimeout(capDrain, remainingSuppression);
      return;
    }

    // #1010: hold — not drop — a cap delivery inside the cooldown window left
    // by the previous cap injection. The pending flag stays set, so the wake is
    // delivered when the window closes (or earlier, if the agent goes genuinely
    // quiet and the idle timer wins).
    const lastCap = _lastCapInjectedAt.get(key);
    const remainingCooldown = lastCap ? _timings.capCooldownMs - (Date.now() - lastCap) : 0;
    if (remainingCooldown > 0) {
      state.capHandle = setTimeout(capDrain, remainingCooldown);
      return;
    }

    _lastCapInjectedAt.set(key, Date.now());
    deliver(live);
  };

  function resetIdleTimer() {
    if (state.idleHandle) clearTimeout(state.idleHandle);
    state.idleHandle = setTimeout(idleDrain, _timings.idleThresholdMs);
  }

  // Start the idle timer immediately so the drain fires even if no further PTY
  // output arrives at all.
  resetIdleTimer();

  // #1010: the cap deadline. Armed once per cycle, never reset by onData.
  if (capEligible(session)) {
    state.capHandle = setTimeout(capDrain, _timings.maxDeferMs);
  }

  state.disposable = session.term.onData(() => {
    resetIdleTimer();
  });

  _drainListeners.set(key, state);
}

// #1010: one lifecycle for the whole deferred-wake cycle — the onData listener
// and BOTH timers. Leaving the cap timer armed is not a benign leak: the drain
// only checks the pending flag, so a survivor would consume a later cycle's
// wake and dispose its listener.
function cleanupDrainListener(key) {
  const state = _drainListeners.get(key);
  if (!state) return;
  if (state.disposable && typeof state.disposable.dispose === "function") {
    state.disposable.dispose();
  }
  if (state.idleHandle) clearTimeout(state.idleHandle);
  if (state.capHandle) clearTimeout(state.capHandle);
  _drainListeners.delete(key);
}

function buildInjectionPrompt(agentId) {
  return (
    `You are @${agentId}. New messages may be addressed to you in the project chat. ` +
    `Call the chat_read MCP tool to read recent messages. ` +
    `Act only on messages that explicitly mention @${agentId}. ` +
    `Ignore messages addressed to other agents.`
  );
}

/**
 * Coalesce burst mentions within a 1s window per agent.
 */
function scheduleCoalescedInjection(key, projectId, agentId, msg, agentSessions, deps) {
  const existing = _coalesceTimers.get(key);
  if (existing) {
    existing.messages.push(msg);
    return;
  }

  const state = { messages: [msg] };
  const timer = setTimeout(() => {
    _coalesceTimers.delete(key);
    if (!projectAdmitted(deps, projectId)) return;
    const session = agentSessions.get(key);
    if (!session || !session.term || session.state !== "running") return;

    // re1 on #923: the idle / not-recently-active decision was made at dispatch
    // time, but it can go stale during the 1s coalesce window — the agent may
    // have started a turn or posted a message in the meantime. Re-check at fire
    // time: if it is now active, DEFER via a pending wake (which drains once it
    // goes quiet) rather than injecting mid-activity (#736). Crucially this
    // defers, it does NOT drop (#923) — the drain still delivers the wake.
    const lastSent = _lastChatSentAt.get(key);
    const recentlySent = lastSent && (Date.now() - lastSent < _timings.activeSuppressionMs);
    if (isAgentBusy(session) || recentlySent) {
      queuePendingWake(key, session, agentSessions, deps);
      return;
    }

    injectIntoTerm(key, session.term, buildInjectionPrompt(agentId), deps);
  }, COALESCE_WINDOW_MS);

  state.timer = timer;
  _coalesceTimers.set(key, state);
}

// #1010: the delayed submit is owned per key so `cleanupSession` can cancel it.
// Without an owner, stopping a session inside the submit delay left a pending
// "\r" write against a term that was already killed.
function injectIntoTerm(key, term, text, deps) {
  const projectId = key.split("/")[0];
  const flat = text.replace(/\n/g, " ");
  if (!projectAdmitted(deps, projectId)) return;
  deps.safeWrite(term, flat);
  const submitDelayMs = Math.max(300, flat.length);
  const previous = _submitTimers.get(key);
  if (previous) clearTimeout(previous);
  const handle = setTimeout(() => {
    _submitTimers.delete(key);
    if (!projectAdmitted(deps, projectId)) return;
    try { deps.safeWrite(term, "\r"); } catch {}
  }, submitDelayMs);
  _submitTimers.set(key, handle);
}

/**
 * Cleanup all timers for a session (call on stop/exit).
 */
function cleanupSession(key) {
  const coalesce = _coalesceTimers.get(key);
  if (coalesce) {
    clearTimeout(coalesce.timer);
    _coalesceTimers.delete(key);
  }
  _pendingWake.delete(key);
  _lastChatSentAt.delete(key);
  cleanupDrainListener(key);
  // #1010: the delayed submit timer and the cap cooldown are part of this
  // session's state — a stopped/respawned session must not inherit either.
  const submit = _submitTimers.get(key);
  if (submit) {
    clearTimeout(submit);
    _submitTimers.delete(key);
  }
  _lastCapInjectedAt.delete(key);
}

/**
 * Cancel every deferred dispatcher owner for one project. This is deliberately
 * prefix-scoped and synchronous: archive persists the barrier, then calls this
 * before its first async teardown so no pending timer can inject in the gap.
 */
function cancelProject(projectId) {
  const prefix = `${projectId}/`;
  const keys = new Set();
  for (const map of [
    _coalesceTimers,
    _pendingWake,
    _drainListeners,
    _lastChatSentAt,
    _lastCapInjectedAt,
    _submitTimers,
  ]) {
    for (const key of map.keys()) if (key.startsWith(prefix)) keys.add(key);
  }
  let removed = 0;
  for (const key of keys) {
    for (const map of [
      _coalesceTimers,
      _pendingWake,
      _drainListeners,
      _lastChatSentAt,
      _lastCapInjectedAt,
      _submitTimers,
    ]) {
      if (map.has(key)) removed += 1;
    }
    cleanupSession(key);
  }
  return {
    ok: true,
    resources: { deferred_dispatches: removed },
    cleanup_errors: [],
  };
}

module.exports = {
  dispatchToAgentPTY,
  cleanupSession,
  cancelProject,
  // Exported for testing
  capEligible, // #1023: the eligibility predicate is pinned directly, not only
               // through the repaint regressions, so the fail-safe direction
               // (an unstamped session stays ineligible) has its own assertion.
  _coalesceTimers,
  _pendingWake,
  _drainListeners,
  _lastChatSentAt,
  _lastCapInjectedAt,
  _submitTimers,
  IDLE_THRESHOLD_MS,
  COALESCE_WINDOW_MS,
  ACTIVE_SUPPRESSION_MS,
  MAX_DEFER_MS,
  CAP_COOLDOWN_MS,
  // #1010: lets the dispatcher tests run the repaint/cap/cooldown regressions at
  // millisecond scale. Call with no argument to restore the shipped timings.
  _setTimingsForTest: (overrides) => {
    _timings = { ...DEFAULT_TIMINGS, ...(overrides || {}) };
  },
};
