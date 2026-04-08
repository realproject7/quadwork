/**
 * AgentChattr registration helper (#238).
 *
 * Talks to a per-project AgentChattr instance's registration API to obtain
 * per-agent tokens for MCP auth. Each function takes serverPort explicitly
 * so the helper is project-agnostic.
 *
 * Reference: /Users/cho/Projects/agentchattr/wrapper.py _register_instance.
 */

const DEFAULT_TIMEOUT_MS = 5000;

// Tokens returned from registerAgent are cached per (port, name) so the
// two-arg deregisterAgent(serverPort, name) form from the #238 contract
// works without the caller having to thread the token through.
const _tokenCache = new Map();

function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

/**
 * Poll GET / on the AgentChattr server until it responds 200, or until
 * timeoutMs elapses. Returns true on success, false on timeout.
 */
async function waitForAgentChattrReady(serverPort, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetchWithTimeout(`http://127.0.0.1:${serverPort}/`, {}, 2000);
      if (r.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

/**
 * Register an agent with AgentChattr. Returns {name, token, slot} on
 * success, null on failure (with registerAgent.lastError populated).
 */
async function registerAgent(serverPort, base, label = null) {
  registerAgent.lastError = null;
  try {
    const r = await fetchWithTimeout(
      `http://127.0.0.1:${serverPort}/api/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base, label }),
      },
    );
    if (!r.ok) {
      registerAgent.lastError = `register ${base}: HTTP ${r.status}`;
      return null;
    }
    const data = await r.json();
    if (!data || !data.name || !data.token) {
      registerAgent.lastError = `register ${base}: malformed response`;
      return null;
    }
    _tokenCache.set(`${serverPort}:${data.name}`, data.token);
    return { name: data.name, token: data.token, slot: data.slot };
  } catch (err) {
    registerAgent.lastError = `register ${base}: ${err.message || err}`;
    return null;
  }
}
registerAgent.lastError = null;

/**
 * Best-effort deregister. Failures are non-fatal (e.g. AgentChattr already
 * shut down). Returns true on a 2xx response, false otherwise.
 *
 * AgentChattr's /api/deregister/{name} requires the agent's own bearer
 * token for "family" names (head/dev/reviewer1/reviewer2) — see
 * app.py:2123-2135. The token is looked up automatically from the cache
 * populated by registerAgent; an explicit token may be passed as a third
 * argument to override (e.g. recovering a session).
 */
async function deregisterAgent(serverPort, name, token) {
  try {
    const headers = {};
    const tok = token || _tokenCache.get(`${serverPort}:${name}`);
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    const r = await fetchWithTimeout(
      `http://127.0.0.1:${serverPort}/api/deregister/${encodeURIComponent(name)}`,
      { method: "POST", headers },
    );
    if (r.ok) _tokenCache.delete(`${serverPort}:${name}`);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Start a per-agent heartbeat that POSTs /api/heartbeat/{name} every 5s
 * with bearer auth. AgentChattr considers an agent crashed and removes
 * it after ~60s without a heartbeat, so without this every registered
 * QuadWork agent silently disappears from the channel one minute after
 * registration.
 *
 * Returns an opaque handle suitable for stopHeartbeat. Transient errors
 * (network blips, AgentChattr restart) are swallowed — the next tick
 * just tries again. The 409 "identity wiped" recovery flow is sub-D
 * (quadwork#253) and is intentionally not handled here.
 *
 * Reference: /Users/cho/Projects/agentchattr/wrapper.py lines 715-748.
 */
function startHeartbeat(serverPort, name, token, intervalMs = 5000) {
  const url = `http://127.0.0.1:${serverPort}/api/heartbeat/${encodeURIComponent(name)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const tick = async () => {
    try {
      await fetchWithTimeout(url, { method: "POST", headers }, DEFAULT_TIMEOUT_MS);
    } catch {
      // swallow — next tick will retry
    }
  };
  // Fire one immediately so a fresh agent is held alive without waiting
  // a full interval, then poll on the timer.
  tick();
  const handle = setInterval(tick, intervalMs);
  return handle;
}

/**
 * Stop a heartbeat started by startHeartbeat. Safe to call with null.
 */
function stopHeartbeat(handle) {
  if (handle) clearInterval(handle);
}

module.exports = {
  waitForAgentChattrReady,
  registerAgent,
  deregisterAgent,
  startHeartbeat,
  stopHeartbeat,
};
