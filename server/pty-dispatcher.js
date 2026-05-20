/**
 * #730: PTY injection dispatcher — deliver chat messages to agents via
 * terminal stdin when they are @mentioned. Primary delivery mechanism
 * for file-chat mode; agents treat injected text as user prompts.
 */

const IDLE_THRESHOLD_MS = 5000;
const COALESCE_WINDOW_MS = 1000;

// Per-agent coalescing timers: key = "project/agent" → timeout handle
const _coalesceTimers = new Map();

// Per-agent pending since_id for drain: key = "project/agent" → oldest undelivered msg id
const _pendingSinceId = new Map();

// Per-agent drain listeners: key = "project/agent" → { disposable, timeout }
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

  for (const agentId of msg.mentions) {
    const key = `${projectId}/${agentId}`;
    const session = agentSessions.get(key);
    if (!session || !session.term || session.state !== "running") continue;
    // Don't inject a message back into the agent that sent it
    if (msg.sender === agentId) continue;

    if (isAgentBusy(session)) {
      queuePendingWake(key, msg.id, session, deps);
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
 * Hooks term.onData to drain after idle period.
 */
function queuePendingWake(key, msgId, session, deps) {
  const existing = _pendingSinceId.get(key);
  if (!existing || msgId < existing) {
    _pendingSinceId.set(key, msgId);
  }

  if (_drainListeners.has(key)) return;

  let idleTimeout = null;
  const disposable = session.term.onData(() => {
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      const sinceId = _pendingSinceId.get(key);
      if (sinceId == null) {
        cleanupDrainListener(key);
        return;
      }
      _pendingSinceId.delete(key);
      cleanupDrainListener(key);

      const formatted = buildDrainPrompt(session.agentId, sinceId);
      injectIntoTerm(session.term, formatted, deps);
    }, IDLE_THRESHOLD_MS);
  });

  _drainListeners.set(key, { disposable, timeout: idleTimeout });
}

function cleanupDrainListener(key) {
  const listener = _drainListeners.get(key);
  if (!listener) return;
  if (listener.disposable && typeof listener.disposable.dispose === "function") {
    listener.disposable.dispose();
  }
  if (listener.timeout) clearTimeout(listener.timeout);
  _drainListeners.delete(key);
}

function buildDrainPrompt(agentId, sinceId) {
  return (
    `You are @${agentId} in this AgentChattr instance. ` +
    `mcp read #general with sender: "${agentId}" — ` +
    `look for @${agentId} mentions (NOT @claude). ` +
    `You were mentioned while busy, take appropriate action.`
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

    const msgs = state.messages;
    let formatted;
    if (msgs.length === 1) {
      const m = msgs[0];
      formatted = `[chat @${m.sender}]: ${m.text}`;
    } else {
      const latest = msgs[msgs.length - 1];
      formatted =
        `[chat] ${msgs.length} new messages mentioning @${agentId}. ` +
        `Latest from @${latest.sender}: ${latest.text}`;
    }

    injectIntoTerm(session.term, formatted, deps);
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
  _pendingSinceId.delete(key);
  cleanupDrainListener(key);
}

module.exports = {
  dispatchToAgentPTY,
  cleanupSession,
  // Exported for testing
  _coalesceTimers,
  _pendingSinceId,
  _drainListeners,
  IDLE_THRESHOLD_MS,
  COALESCE_WINDOW_MS,
};
