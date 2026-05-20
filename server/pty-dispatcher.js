/**
 * #730: PTY injection dispatcher — deliver chat messages to agents via
 * terminal stdin when they are @mentioned. Primary delivery mechanism
 * for file-chat mode; agents treat injected text as user prompts.
 */

const IDLE_THRESHOLD_MS = 5000;
const COALESCE_WINDOW_MS = 1000;
const ACTIVE_SUPPRESSION_MS = 30000;

// Per-agent coalescing timers: key = "project/agent" → timeout handle
const _coalesceTimers = new Map();

// Per-agent last chat send timestamp: key = "project/agent" → epoch ms
const _lastChatSentAt = new Map();

// Per-agent pending wake flag: key = "project/agent" → true
const _pendingWake = new Map();

// Per-agent drain listeners: key = "project/agent" → { disposable, timeoutHandle }
const _drainListeners = new Map();

/**
 * Dispatch a chat message to mentioned agents' PTYs.
 *
 * @param {string} projectId
 * @param {object} msg - The appended message record (has .mentions, .sender, .text, .id, .type)
 * @param {Map} agentSessions - The global agentSessions map
 * @param {object} deps - { isLoopGuardPaused, safeWrite }
 */
function dispatchToAgentPTY(projectId, msg, agentSessions, deps) {
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

    // #736: skip injection if agent recently sent a message — they're
    // already active and will read chat via chat_read
    const lastSent = _lastChatSentAt.get(key);
    if (lastSent && (Date.now() - lastSent < ACTIVE_SUPPRESSION_MS)) continue;

    if (isAgentBusy(session)) {
      queuePendingWake(key, session, deps);
      continue;
    }

    scheduleCoalescedInjection(key, projectId, agentId, msg, agentSessions, deps);
  }
}

function isAgentBusy(session) {
  return session.lastOutputAt && (Date.now() - session.lastOutputAt < IDLE_THRESHOLD_MS);
}

/**
 * Queue a pending wake using high-water mark (since_id).
 * Hooks term.onData to drain after idle period, with a fallback
 * timer so the wake fires even if no further PTY output arrives.
 */
function queuePendingWake(key, session, deps) {
  _pendingWake.set(key, true);

  const drainFn = () => {
    if (!_pendingWake.get(key)) {
      cleanupDrainListener(key);
      return;
    }
    _pendingWake.delete(key);
    cleanupDrainListener(key);

    const lastSent = _lastChatSentAt.get(key);
    if (lastSent && (Date.now() - lastSent < ACTIVE_SUPPRESSION_MS)) return;

    injectIntoTerm(session.term, buildInjectionPrompt(session.agentId), deps);
  };

  if (_drainListeners.has(key)) return;

  const state = { timeoutHandle: null };

  function resetIdleTimer() {
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
    state.timeoutHandle = setTimeout(drainFn, IDLE_THRESHOLD_MS);
  }

  // Start fallback timer immediately so drain fires even without further output
  resetIdleTimer();

  const disposable = session.term.onData(() => {
    resetIdleTimer();
  });

  _drainListeners.set(key, { disposable, state });
}

function cleanupDrainListener(key) {
  const listener = _drainListeners.get(key);
  if (!listener) return;
  if (listener.disposable && typeof listener.disposable.dispose === "function") {
    listener.disposable.dispose();
  }
  if (listener.state && listener.state.timeoutHandle) {
    clearTimeout(listener.state.timeoutHandle);
  }
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
    const session = agentSessions.get(key);
    if (!session || !session.term || session.state !== "running") return;

    const lastSent = _lastChatSentAt.get(key);
    if (lastSent && (Date.now() - lastSent < ACTIVE_SUPPRESSION_MS)) return;

    injectIntoTerm(session.term, buildInjectionPrompt(agentId), deps);
  }, COALESCE_WINDOW_MS);

  state.timer = timer;
  _coalesceTimers.set(key, state);
}

function injectIntoTerm(term, text, deps) {
  const flat = text.replace(/\n/g, " ");
  deps.safeWrite(term, flat);
  const submitDelayMs = Math.max(300, flat.length);
  setTimeout(() => {
    try { deps.safeWrite(term, "\r"); } catch {}
  }, submitDelayMs);
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
}

module.exports = {
  dispatchToAgentPTY,
  cleanupSession,
  // Exported for testing
  _coalesceTimers,
  _pendingWake,
  _drainListeners,
  _lastChatSentAt,
  IDLE_THRESHOLD_MS,
  COALESCE_WINDOW_MS,
  ACTIVE_SUPPRESSION_MS,
};
