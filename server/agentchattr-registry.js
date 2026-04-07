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
 * app.py:2123-2135. Pass the registration token returned by registerAgent.
 */
async function deregisterAgent(serverPort, name, token) {
  try {
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const r = await fetchWithTimeout(
      `http://127.0.0.1:${serverPort}/api/deregister/${encodeURIComponent(name)}`,
      { method: "POST", headers },
    );
    return r.ok;
  } catch {
    return false;
  }
}

module.exports = {
  waitForAgentChattrReady,
  registerAgent,
  deregisterAgent,
};
