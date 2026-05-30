"use strict";

// #790: shared per-tool context for the MCP operator server. Every tool
// handler receives the object returned by `createContext(port)` as its second
// argument. Centralizing `httpRequest` + the project/agent validators here
// (rather than inlining them in mcp-operator.js) keeps them unit-testable and
// gives the conflict-free tool modules (#791–#795) a single import surface.

const http = require("http");

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Build the context handed to every tool handler.
 * @param {string|number} port  QuadWork backend port (base is 127.0.0.1).
 * @param {{timeoutMs?: number}} [opts]  timeoutMs overrides the 5s request
 *   abort — used by tests to fire the timeout path fast. The user-facing
 *   timeout message is fixed at "within 5s" regardless (#790 contract).
 */
function createContext(port, opts = {}) {
  const PORT = String(port);
  const BASE = `http://127.0.0.1:${PORT}`;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  // Request hardening (moved here from #796 — every tool depends on it).
  // Attaches a 5s abort, and maps ECONNREFUSED / timeout / non-2xx into clean
  // tool errors. No raw "API error ..." dumps leak to the operator.
  function httpRequest(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, BASE);
      const reqOpts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      };
      const req = http.request(reqOpts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const status = res.statusCode;
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : undefined;
          } catch {
            parsed = undefined;
          }
          if (status >= 200 && status < 300) {
            resolve(parsed === undefined ? data : parsed);
            return;
          }
          if (parsed && typeof parsed.error === "string") {
            reject(new Error(parsed.error));
          } else {
            reject(new Error(`${method} ${url.pathname} failed: HTTP ${status}`));
          }
        });
      });
      req.on("error", (err) => {
        // AbortSignal.timeout fires a TimeoutError (code ABORT_ERR).
        if (err.code === "ABORT_ERR" || err.name === "AbortError" || err.name === "TimeoutError") {
          reject(new Error(`QuadWork did not respond within 5s (port ${PORT}).`));
        } else if (err.code === "ECONNREFUSED") {
          reject(new Error(`QuadWork is not running on port ${PORT}. Start it first.`));
        } else {
          reject(err);
        }
      });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // Internal: authoritative project list for validation. Returns the agent id
  // list only (head/dev/re1/re2) — never the per-agent model/token/reasoning
  // fields. This is the source for both assertKnownProject and the public
  // list_projects (which strips `agents` again before returning).
  async function getConfiguredProjects() {
    const cfg = await httpRequest("GET", "/api/config");
    const projects = Array.isArray(cfg && cfg.projects) ? cfg.projects : [];
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      repo: p.repo,
      agents: p.agents ? Object.keys(p.agents) : [],
    }));
  }

  // Every project-scoped tool (#791–#795) MUST call this before its HTTP call —
  // read OR write — except list_agents, which validates only when `project` is
  // supplied. Backend trigger/chat/queue endpoints accept unknown ids and
  // strand state (live timers, stray ~/.quadwork/<id>/ files), so the guard
  // lives client-side here.
  async function assertKnownProject(id) {
    const projects = await getConfiguredProjects();
    if (!projects.some((p) => p.id === id)) {
      throw new Error(`Unknown project: ${id}. Use list_projects to see valid ids.`);
    }
  }

  // Used by agent_control (#795) so an unknown agent is rejected with NO HTTP
  // control call — backend stop accepts any :agent string and returns ok:true.
  async function assertKnownAgent(project, agent) {
    const projects = await getConfiguredProjects();
    const p = projects.find((x) => x.id === project);
    if (!p) {
      throw new Error(`Unknown project: ${project}. Use list_projects to see valid ids.`);
    }
    if (!p.agents.includes(agent)) {
      throw new Error(`Unknown agent: ${agent} in ${project}.`);
    }
  }

  return { port: PORT, base: BASE, httpRequest, getConfiguredProjects, assertKnownProject, assertKnownAgent };
}

module.exports = { createContext, DEFAULT_TIMEOUT_MS };
