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
async function registerAgent(serverPort, base, label = null, { force = false } = {}) {
  registerAgent.lastError = null;
  try {
    const r = await fetchWithTimeout(
      `http://127.0.0.1:${serverPort}/api/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base, label, force }),
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
 * token for "family" names (head/dev/re1/re2) — see
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
 * it after ~120s without a heartbeat, so without this every registered
 * QuadWork agent silently disappears from the channel one minute after
 * registration.
 *
 * `getName` and `getToken` are read on every tick (either as plain
 * values or as zero-arg functions) so the sub-D 409 recovery path can
 * swap them in place after re-registration without restarting the
 * interval. Pass an `onConflict` callback to handle 409 responses
 * (AgentChattr restart wiped the in-memory registry — re-register and
 * the next tick will use the new credentials). Other errors are
 * swallowed.
 *
 * Returns an opaque handle suitable for stopHeartbeat.
 *
 * Reference: /Users/cho/Projects/agentchattr/wrapper.py lines 715-744.
 */
function startHeartbeat(serverPort, getName, getToken, { onConflict, intervalMs = 5000 } = {}) {
  // Sub-D guard: avoid re-entering onConflict while a previous recovery
  // attempt is still in flight. Without this, a slow re-register would
  // be triggered once per 5s tick and stack up duplicate registrations.
  let recovering = false;
  const resolve = (v) => (typeof v === "function" ? v() : v);
  const tick = async () => {
    const name = resolve(getName);
    const token = resolve(getToken);
    if (!name) return;
    const url = `http://127.0.0.1:${serverPort}/api/heartbeat/${encodeURIComponent(name)}`;
    try {
      const r = await fetchWithTimeout(
        url,
        { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} },
        DEFAULT_TIMEOUT_MS,
      );
      if (r.status === 409 && typeof onConflict === "function" && !recovering) {
        recovering = true;
        try {
          await onConflict();
        } catch {
          // recovery is best-effort; next tick retries on its own
        } finally {
          recovering = false;
        }
      }
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

/**
 * Register an agent with retries and exponential backoff.
 * Returns {name, token, slot} on success, null after all attempts fail.
 * Uses registerAgent internally so registerAgent.lastError is populated.
 */
async function registerAgentWithRetry(serverPort, base, label = null, { force = false, attempts = 3, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const result = await registerAgent(serverPort, base, label, { force });
    if (result) return result;
    if (i < attempts - 1) {
      await new Promise((res) => setTimeout(res, delayMs * Math.pow(2, i)));
    }
  }
  return null;
}

module.exports = {
  waitForAgentChattrReady,
  registerAgent,
  registerAgentWithRetry,
  deregisterAgent,
  startHeartbeat,
  stopHeartbeat,
};
