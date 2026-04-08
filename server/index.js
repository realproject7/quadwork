const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { spawn } = require("child_process");
const { readConfig, resolveAgentCwd, resolveAgentCommand, resolveProjectChattr, resolveChattrSpawn, syncChattrToken, CONFIG_PATH } = require("./config");
const routes = require("./routes");
const { waitForAgentChattrReady, registerAgent, deregisterAgent, startHeartbeat, stopHeartbeat } = require("./agentchattr-registry");
const { startQueueWatcher, stopQueueWatcher } = require("./queue-watcher");

const net = require("net");
const config = readConfig();
const PORT = config.port || 8400;

const app = express();
// #412 / quadwork#279: bump the global JSON body limit to 10mb so
// POST /api/project-history can accept full chat exports. The
// default ~100kb 413'd long before the route-local parser had a
// chance to apply its own 10mb cap (the global parser runs first).
// All other routes are well within 10mb in practice; this is the
// least invasive fix and matches the documented import ceiling.
app.use(express.json({ limit: "10mb" }));

// --- Mount migrated API routes (from Next.js) ---
app.use(routes);

const server = http.createServer(app);

// --- REST endpoints ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- CLI status detection ---

const { execSync } = require("child_process");

function isCliInstalled(cmd) {
  try {
    execSync(`which ${cmd}`, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

app.get("/api/cli-status", (_req, res) => {
  res.json({
    claude: isCliInstalled("claude"),
    codex: isCliInstalled("codex"),
  });
});

// --- Port availability check ---

function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => { srv.close(); resolve(true); });
    srv.listen(port, "127.0.0.1");
  });
}

app.get("/api/port-check", async (req, res) => {
  const port = parseInt(req.query.port, 10);
  if (!port || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  const free = await checkPort(port);
  res.json({ port, free });
});

app.get("/api/port-check/auto", async (req, res) => {
  const start = parseInt(req.query.start, 10) || 8300;
  const count = Math.min(parseInt(req.query.count, 10) || 3, 10);
  const results = [];
  let port = start;
  for (let i = 0; i < count; i++) {
    while (!(await checkPort(port)) && port < 65535) port++;
    results.push(port);
    port++;
  }
  res.json({ ports: results });
});

// --- Caffeinate (sleep prevention) ---

let caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };

app.post("/api/caffeinate/start", (req, res) => {
  if (process.platform !== "darwin") {
    return res.status(400).json({ ok: false, error: "Sleep prevention is only available on macOS" });
  }
  // Kill existing if running
  if (caffeinateProcess.process) {
    try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
  }
  const duration = req.body?.duration || 0; // seconds, 0 = indefinite
  const args = ["-d", "-i", "-s"];
  if (duration > 0) args.push("-t", String(duration));
  const child = spawn("caffeinate", args, { stdio: "ignore", detached: true });
  child.unref();
  child.on("exit", () => {
    if (caffeinateProcess.process === child) {
      caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
    }
  });
  caffeinateProcess = { process: child, pid: child.pid, startedAt: Date.now(), duration: duration || null };
  res.json({ ok: true, active: true, pid: child.pid, duration });
});

app.post("/api/caffeinate/stop", (_req, res) => {
  if (caffeinateProcess.process) {
    try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
  }
  caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
  res.json({ ok: true, active: false });
});

app.get("/api/caffeinate/status", (_req, res) => {
  const active = !!(caffeinateProcess.process && caffeinateProcess.pid);
  let remaining = null;
  if (active && caffeinateProcess.duration && caffeinateProcess.startedAt) {
    const elapsed = Math.floor((Date.now() - caffeinateProcess.startedAt) / 1000);
    remaining = Math.max(0, caffeinateProcess.duration - elapsed);
  }
  res.json({ active, pid: caffeinateProcess.pid, remaining, platform: process.platform });
});

// --- Unified agent sessions ---
// Single map: key = "project/agent" → { projectId, agentId, term, ws, state, error }
// PTY (term) is the source of truth for "running". WS is optional (attaches to view terminal).
const agentSessions = new Map();

// AgentChattr server processes — per-project (key = projectId)
const chattrProcesses = new Map();

// --- MCP auth proxy for Codex (can't pass headers via -c flag) ---
// Maps "project/agent" → { server, port }
const mcpProxies = new Map();

/**
 * Start a local HTTP proxy that forwards MCP requests with Bearer token.
 * Returns a Promise that resolves to the proxy URL once listening.
 */
function startMcpProxy(projectId, agentId, upstreamUrl, token) {
  const key = `${projectId}/${agentId}`;
  const existing = mcpProxies.get(key);
  if (existing) return Promise.resolve(`http://127.0.0.1:${existing.port}/mcp`);

  // #394 / quadwork#253: token is mutable so the 409 recovery path can
  // swap it via updateMcpProxyToken without rebinding the listener —
  // Codex was launched with a fixed proxy URL on an ephemeral port and
  // can't be told to use a new one mid-flight.
  const tokenRef = { current: token };
  return new Promise((resolve, reject) => {
    const proxyServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1`);
      const targetUrl = `${upstreamUrl}${parsedUrl.pathname}${parsedUrl.search}`;
      const headers = { ...req.headers, host: new URL(upstreamUrl).host };
      const tok = tokenRef.current;
      if (tok) {
        headers["authorization"] = `Bearer ${tok}`;
        headers["x-agent-token"] = tok;
      }
      delete headers["content-length"];

      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const proxyReq = (upstreamUrl.startsWith("https") ? require("https") : http).request(
          targetUrl,
          { method: req.method, headers: { ...headers, "content-length": body.length } },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        proxyReq.on("error", (err) => {
          res.writeHead(502);
          res.end(`Proxy error: ${err.message}`);
        });
        proxyReq.end(body);
      });
    });

    proxyServer.on("error", (err) => reject(err));
    proxyServer.listen(0, "127.0.0.1", () => {
      const port = proxyServer.address().port;
      mcpProxies.set(key, { server: proxyServer, port, tokenRef });
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

/**
 * Swap the bearer token of a running MCP proxy in place. Used by the
 * sub-D 409 recovery path: rebinding the listener would change the
 * ephemeral port and the running Codex process is pinned to the
 * original URL, so we mutate the closure-captured tokenRef instead.
 * Returns true if a proxy existed and was updated.
 */
function updateMcpProxyToken(projectId, agentId, newToken) {
  const key = `${projectId}/${agentId}`;
  const proxy = mcpProxies.get(key);
  if (!proxy || !proxy.tokenRef) return false;
  proxy.tokenRef.current = newToken;
  return true;
}

function stopMcpProxy(projectId, agentId) {
  const key = `${projectId}/${agentId}`;
  const proxy = mcpProxies.get(key);
  if (proxy) {
    try { proxy.server.close(); } catch {}
    mcpProxies.delete(key);
  }
}

// --- Permission bypass flags per CLI ---
const PERMISSION_FLAGS = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--yolo"],
};

// --- MCP config generation & agent launch args ---

/**
 * Generate a per-agent MCP config file for Claude (--mcp-config).
 * Returns the absolute path to the written JSON file.
 */
/**
 * Per-agent registration tokens persisted across QuadWork restarts so
 * #242 stale-slot reclaim works after a crash. Without this the
 * in-memory _tokenCache is empty on startup and the family-name
 * deregister returns 403 (app.py:2123-2135).
 */
function _agentTokenPath(projectId, agentId) {
  const configDir = path.join(os.homedir(), ".quadwork", projectId);
  return path.join(configDir, `agent-token-${agentId}.txt`);
}

function readPersistedAgentToken(projectId, agentId) {
  try {
    return fs.readFileSync(_agentTokenPath(projectId, agentId), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writePersistedAgentToken(projectId, agentId, token) {
  try {
    const configDir = path.join(os.homedir(), ".quadwork", projectId);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(_agentTokenPath(projectId, agentId), token, { mode: 0o600 });
  } catch {
    // non-fatal — stale-slot reclaim will degrade but registration still works
  }
}

function clearPersistedAgentToken(projectId, agentId) {
  try { fs.unlinkSync(_agentTokenPath(projectId, agentId)); } catch {}
}

function writeMcpConfigFile(projectId, agentId, mcpHttpPort, token) {
  const os = require("os");
  const configDir = path.join(os.homedir(), ".quadwork", projectId);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, `mcp-${agentId}.json`);
  const url = `http://127.0.0.1:${mcpHttpPort}/mcp`;
  const config = {
    mcpServers: {
      agentchattr: {
        type: "http",
        url,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

/**
 * Build extra launch args for an agent (permission flags + MCP injection).
 * Async because Codex proxy_flag mode needs to await proxy startup.
 */
async function buildAgentArgs(projectId, agentId) {
  const cfg = readConfig();
  const project = cfg.projects?.find((p) => p.id === projectId);
  if (!project) return { args: [], acRegistrationName: null, acServerPort: null, acRegistrationToken: null, acInjectMode: null, acMcpHttpPort: null };

  const agentCfg = project.agents?.[agentId] || {};
  const command = agentCfg.command || "claude";
  const cliBase = command.split("/").pop().split(" ")[0]; // extract base CLI name
  const args = [];
  let acRegistrationName = null;
  let acServerPort = null;
  let acRegistrationToken = null;
  let acInjectMode = null;

  // Permission bypass flags
  if (agentCfg.auto_approve !== false) {
    const flags = PERMISSION_FLAGS[cliBase];
    if (flags) args.push(...flags);
  }

  // MCP config injection
  const mcpHttpPort = project.mcp_http_port;
  const token = project.agentchattr_token;
  if (mcpHttpPort) {
    const injectMode = agentCfg.mcp_inject || (cliBase === "codex" ? "proxy_flag" : cliBase === "gemini" ? "env" : "flag");
    acInjectMode = injectMode;
    if (injectMode === "flag") {
      // Claude/Kimi: register with AgentChattr to obtain a per-agent
      // token (#239 — session_token is browser auth, not MCP auth) and
      // write that into the per-agent MCP config file.
      const chattrInfo = resolveProjectChattr(projectId);
      acServerPort = Number(new URL(chattrInfo.url).port) || 8300;
      await waitForAgentChattrReady(acServerPort);
      // #242: best-effort deregister any stale registration of the
      // canonical name (left over by a crashed previous QuadWork
      // session) so the fresh register lands at slot 1 instead of
      // head-2 / reviewer2-2. We need the previous agent's bearer
      // token because app.py:2123 requires authenticated agent
      // session for family names — load it from disk (persisted
      // across restarts). Failures are non-fatal.
      const stalePersistedToken = readPersistedAgentToken(projectId, agentId);
      if (stalePersistedToken) {
        await deregisterAgent(acServerPort, agentId, stalePersistedToken).catch(() => {});
        clearPersistedAgentToken(projectId, agentId);
      }
      const registration = await registerAgent(acServerPort, agentId, agentCfg.display_name || null);
      if (!registration) {
        throw new Error(`Failed to register ${agentId}: ${registerAgent.lastError}`);
      }
      acRegistrationName = registration.name;
      acRegistrationToken = registration.token;
      writePersistedAgentToken(projectId, agentId, registration.token);
      const mcpConfigPath = writeMcpConfigFile(projectId, agentId, mcpHttpPort, registration.token);
      const flag = agentCfg.mcp_flag || "--mcp-config";
      args.push(flag, mcpConfigPath);
    } else if (injectMode === "proxy_flag") {
      // Codex: register with AgentChattr first (#240) so the proxy
      // injects a real per-agent token, not the global session token.
      // Resolve via resolveProjectChattr so legacy/global-config
      // projects without a per-project agentchattr_url still work.
      const chattrInfo = resolveProjectChattr(projectId);
      acServerPort = Number(new URL(chattrInfo.url).port) || 8300;
      await waitForAgentChattrReady(acServerPort);
      // #242: best-effort deregister stale canonical name first using
      // the persisted bearer token from a previous session.
      const stalePersistedToken = readPersistedAgentToken(projectId, agentId);
      if (stalePersistedToken) {
        await deregisterAgent(acServerPort, agentId, stalePersistedToken).catch(() => {});
        clearPersistedAgentToken(projectId, agentId);
      }
      const registration = await registerAgent(acServerPort, agentId, agentCfg.display_name || null);
      if (!registration) {
        throw new Error(`Failed to register ${agentId}: ${registerAgent.lastError}`);
      }
      acRegistrationName = registration.name;
      acRegistrationToken = registration.token;
      writePersistedAgentToken(projectId, agentId, registration.token);
      const upstreamUrl = `http://127.0.0.1:${mcpHttpPort}`;
      const proxyUrl = await startMcpProxy(projectId, agentId, upstreamUrl, registration.token);
      if (proxyUrl) {
        args.push("-c", `mcp_servers.agentchattr.url="${proxyUrl}"`);
      }
    }
  }

  return { args, acRegistrationName, acServerPort, acRegistrationToken, acInjectMode, acMcpHttpPort: mcpHttpPort || null };
}

/**
 * Build extra env vars for an agent (MCP injection via env for Gemini).
 */
function buildAgentEnv(projectId, agentId) {
  const cfg = readConfig();
  const project = cfg.projects?.find((p) => p.id === projectId);
  if (!project) return {};

  const agentCfg = project.agents?.[agentId] || {};
  const command = agentCfg.command || "claude";
  const cliBase = command.split("/").pop().split(" ")[0];
  const env = {};

  // Gemini: inject MCP via env var
  if (cliBase === "gemini" && project.mcp_http_port) {
    const os = require("os");
    const configDir = path.join(os.homedir(), ".quadwork", projectId);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const settingsPath = path.join(configDir, `mcp-${agentId}-settings.json`);
    const url = `http://127.0.0.1:${project.mcp_http_port}/mcp`;
    const settings = {
      mcpServers: {
        agentchattr: {
          type: "http",
          url,
          ...(project.agentchattr_token ? { headers: { Authorization: `Bearer ${project.agentchattr_token}` } } : {}),
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
  }

  return env;
}

/**
 * #394 / quadwork#253: recover from a heartbeat 409 (AgentChattr was
 * restarted, in-memory registry wiped, our token is now stale). Mirrors
 * wrapper.py:732-741. Re-registers the running agent, swaps the
 * tracked name/token on the live session so the heartbeat interval
 * picks up the new credentials on its next tick, refreshes whichever
 * MCP transport this agent uses (Claude config file vs Codex proxy),
 * and restarts the queue watcher in case the assigned name changed
 * (multi-instance slot bump).
 *
 * Best-effort: any failure here just means the next 5s heartbeat will
 * fail again and we'll re-enter recovery — no tight retry loop because
 * startHeartbeat guards re-entry with `recovering`.
 */
async function recoverFrom409(projectId, agentId, session) {
  if (!session.acServerPort) return;
  const cfg = readConfig();
  const project = cfg.projects?.find((p) => p.id === projectId);
  const agentCfg = project?.agents?.[agentId] || {};
  // AC may need a moment to come back up after a restart — wait briefly.
  await waitForAgentChattrReady(session.acServerPort, 10000);

  // Best-effort cleanup of the stale registration on disk so the
  // fresh register isn't shoved into a slot 2 by leftover state.
  const stale = readPersistedAgentToken(projectId, agentId);
  if (stale) {
    await deregisterAgent(session.acServerPort, agentId, stale).catch(() => {});
    clearPersistedAgentToken(projectId, agentId);
  }

  const replacement = await registerAgent(session.acServerPort, agentId, agentCfg.display_name || null);
  if (!replacement) return;

  const previousName = session.acRegistrationName;
  session.acRegistrationName = replacement.name;
  session.acRegistrationToken = replacement.token;
  writePersistedAgentToken(projectId, agentId, replacement.token);

  // Refresh whichever MCP transport this agent uses so subsequent
  // tool calls (and the queue-watcher's `mcp read` injections) hit
  // AC with the new bearer token instead of the now-rejected one.
  if (session.acInjectMode === "flag" && session.acMcpHttpPort) {
    try { writeMcpConfigFile(projectId, agentId, session.acMcpHttpPort, replacement.token); } catch {}
  } else if (session.acInjectMode === "proxy_flag") {
    // Codex is pinned to the original ephemeral proxy URL, so we
    // can't tear the listener down — mutate the token in place.
    try { updateMcpProxyToken(projectId, agentId, replacement.token); } catch {}
  }

  // If the assigned name changed (e.g. multi-instance slot collision)
  // the queue watcher is now polling the wrong file. Restart it
  // against the new name so chat reaches the right agent.
  if (replacement.name !== previousName && session.term) {
    if (session.queueWatcherHandle) {
      stopQueueWatcher(session.queueWatcherHandle);
      session.queueWatcherHandle = null;
    }
    try {
      const { dir: acDir } = resolveProjectChattr(projectId);
      if (acDir) {
        const dataDir = path.join(acDir, "data");
        session.queueWatcherHandle = startQueueWatcher(dataDir, replacement.name, session.term);
      }
    } catch {}
  }
}

// Helper: spawn a PTY for a project/agent and register in agentSessions
async function spawnAgentPty(project, agent) {
  const key = `${project}/${agent}`;

  const cwd = resolveAgentCwd(project, agent);
  if (!cwd) return { ok: false, error: `Unknown agent: ${key}` };

  const command = resolveAgentCommand(project, agent) || (process.env.SHELL || "/bin/zsh");
  const built = await buildAgentArgs(project, agent);
  const args = built.args;
  const extraEnv = buildAgentEnv(project, agent);

  try {
    const term = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, ...extraEnv },
    });

    const session = {
      projectId: project,
      agentId: agent,
      term,
      ws: null,
      state: "running",
      error: null,
      acRegistrationName: built.acRegistrationName,
      acServerPort: built.acServerPort,
      acRegistrationToken: built.acRegistrationToken,
      acInjectMode: built.acInjectMode,
      acMcpHttpPort: built.acMcpHttpPort,
      acHeartbeatHandle: null,
      queueWatcherHandle: null,
    };
    agentSessions.set(key, session);

    // #391 / quadwork#250: keep this agent alive in AgentChattr by
    // POSTing /api/heartbeat/{name} every 5s. Without it, AC's 60s
    // crash-detection window deregisters the agent and chat messages
    // never reach it. Mirrors wrapper.py:_heartbeat (lines 715-748).
    if (session.acRegistrationName && session.acServerPort && session.acRegistrationToken) {
      // #394 / quadwork#253: pass getters (not raw values) so the 409
      // recovery path below can swap acRegistrationName/Token in place
      // and the very next heartbeat tick uses the replacement
      // credentials without us having to tear down + restart the
      // interval.
      session.acHeartbeatHandle = startHeartbeat(
        session.acServerPort,
        () => session.acRegistrationName,
        () => session.acRegistrationToken,
        { onConflict: () => recoverFrom409(project, agent, session) },
      );
    }

    // #393 / quadwork#251: queue watcher — the actual mechanism by
    // which agents pick up chat. Without this an agent can be
    // registered + heartbeating yet still never respond, because
    // AgentChattr only writes to {data_dir}/{name}_queue.jsonl and
    // expects the agent side to poll + inject `mcp read`.
    if (session.acRegistrationName && session.term) {
      try {
        const { dir: acDir } = resolveProjectChattr(project);
        if (acDir) {
          const dataDir = path.join(acDir, "data");
          session.queueWatcherHandle = startQueueWatcher(
            dataDir,
            session.acRegistrationName,
            session.term,
          );
        }
      } catch {
        // best-effort — failure here just means no chat injection
      }
    }

    term.onExit(({ exitCode }) => {
      const current = agentSessions.get(key);
      if (current && current.term === term) {
        current.state = "stopped";
        current.error = exitCode ? `exit:${exitCode}` : null;
        current.term = null;
        // Close WS if attached
        if (current.ws && current.ws.readyState <= 1) {
          current.ws.close(1000, `exited:${exitCode}`);
        }
        current.ws = null;
        // #391 / quadwork#250: a crashed PTY must also clear its
        // heartbeat interval (otherwise it leaks and a later /start
        // double-registers) and free the AgentChattr slot (otherwise
        // the agent stays falsely `active` forever and the next
        // register lands at slot 2). Deregister is best-effort.
        if (current.acHeartbeatHandle) {
          stopHeartbeat(current.acHeartbeatHandle);
          current.acHeartbeatHandle = null;
        }
        if (current.queueWatcherHandle) {
          stopQueueWatcher(current.queueWatcherHandle);
          current.queueWatcherHandle = null;
        }
        if (current.acRegistrationName && current.acServerPort) {
          deregisterAgent(current.acServerPort, current.acRegistrationName).catch(() => {});
          if (current.projectId && current.agentId) {
            try { clearPersistedAgentToken(current.projectId, current.agentId); } catch {}
          }
          current.acRegistrationName = null;
          current.acRegistrationToken = null;
        }
      }
    });

    return { ok: true, pid: term.pid };
  } catch (err) {
    agentSessions.set(key, { projectId: project, agentId: agent, term: null, ws: null, state: "error", error: err.message });
    return { ok: false, error: err.message };
  }
}

// Helper: stop an agent session — kill PTY, close WS, deregister.
// Async because deregister must complete before a restart re-registers,
// otherwise the old slot stays occupied and a fresh register lands at
// head-2 instead of slot 1 (#241).
async function stopAgentSession(key) {
  const session = agentSessions.get(key);
  if (!session) {
    agentSessions.set(key, { projectId: null, agentId: null, term: null, ws: null, state: "stopped", error: null });
    return;
  }
  if (session.term) {
    try { session.term.kill(); } catch {}
    session.term = null;
  }
  if (session.ws && session.ws.readyState <= 1) {
    session.ws.close(1000, "stopped");
  }
  session.ws = null;
  session.state = "stopped";
  session.error = null;
  // Stop heartbeat before deregister so we don't race a final POST
  // against AgentChattr removing the name (#391 / quadwork#250).
  if (session.acHeartbeatHandle) {
    stopHeartbeat(session.acHeartbeatHandle);
    session.acHeartbeatHandle = null;
  }
  // Stop queue watcher (#393 / quadwork#251) — the PTY is gone,
  // injecting into a dead term would throw on the next tick.
  if (session.queueWatcherHandle) {
    stopQueueWatcher(session.queueWatcherHandle);
    session.queueWatcherHandle = null;
  }
  // Best-effort deregister from AgentChattr (#241) so the slot frees
  // and the next register lands at slot 1 instead of head-2.
  if (session.acRegistrationName && session.acServerPort) {
    try {
      await deregisterAgent(session.acServerPort, session.acRegistrationName);
    } catch {
      // best-effort — failures are non-fatal
    }
    if (session.projectId && session.agentId) {
      clearPersistedAgentToken(session.projectId, session.agentId);
    }
    session.acRegistrationName = null;
    session.acRegistrationToken = null;
  }
  // Clean up MCP auth proxy if running
  const [projectId, agentId] = key.split("/");
  if (projectId && agentId) stopMcpProxy(projectId, agentId);
}

app.get("/api/agents", (_req, res) => {
  const agents = {};
  for (const [key, session] of agentSessions) {
    agents[key] = { state: session.state, error: session.error || null };
  }
  for (const [pid, proc] of chattrProcesses) {
    agents[`_agentchattr/${pid}`] = { state: proc.state, error: proc.error };
  }
  res.json(agents);
});

// #424 / quadwork#304: best-effort auto-snapshot of chat history
// before any AgentChattr restart. Defense-in-depth against
// destructive ops like /clear that rewrite AC's JSONL log in place
// — per #303 the log itself IS persistent across normal restarts,
// so the snapshot's job is to give the operator a point-in-time
// rollback if the log gets clobbered, not to prevent history loss
// on ordinary lifecycle events.
//
// Snapshot contents = the same envelope GET /api/project-history
// returns, so an operator (or a future "restore" button) can feed
// the file straight into POST /api/project-history for replay.
const HISTORY_SNAPSHOT_LIMIT = 5;

async function snapshotProjectHistory(projectId) {
  try {
    const snapDir = path.join(require("os").homedir(), ".quadwork", projectId, "history-snapshots");
    if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/project-history?project=${encodeURIComponent(projectId)}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`[snapshot] ${projectId} history fetch returned ${res.status}; skipping snapshot`);
      return false;
    }
    const text = await res.text();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(snapDir, `${stamp}.json`);
    fs.writeFileSync(outPath, text);
    console.log(`[snapshot] ${projectId} → ${outPath}`);
    // Prune to the newest HISTORY_SNAPSHOT_LIMIT files so the
    // directory can't grow unbounded across weeks of restarts.
    try {
      const entries = fs.readdirSync(snapDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({ f, t: fs.statSync(path.join(snapDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const old of entries.slice(HISTORY_SNAPSHOT_LIMIT)) {
        try { fs.unlinkSync(path.join(snapDir, old.f)); } catch {}
      }
    } catch {
      // non-fatal — stale snapshots just linger
    }
    return true;
  } catch (err) {
    console.warn(`[snapshot] ${projectId} snapshot failed: ${err.message || err}`);
    return false;
  }
}

// Per-project AgentChattr lifecycle: /api/agentchattr/:project/:action
// Backward compat: /api/agentchattr/:action uses first project
async function handleAgentChattr(req, res) {
  let projectId, action;
  if (req.params.action) {
    projectId = req.params.projectOrAction;
    action = req.params.action;
  } else {
    // Backward compat: single-param = action, use first project
    action = req.params.projectOrAction;
    const cfg = readConfig();
    projectId = cfg.projects?.[0]?.id || "_default";
  }

  const { url: chattrUrl } = resolveProjectChattr(projectId);
  const chattrPort = new URL(chattrUrl).port || "8300";

  // Find per-project config.toml. Phase 2E / #181: prefer the
  // per-project AgentChattr clone ROOT (where the web/CLI wizards now
  // write it as of #184/#185 — and where run.py actually reads it from).
  // Fall back to the legacy <working_dir>/agentchattr/config.toml for
  // v1 setups that haven't been migrated yet (#188).
  const cfg = readConfig();
  const project = cfg.projects?.find((p) => p.id === projectId);
  const { dir: resolvedAcDir } = resolveProjectChattr(projectId);
  let projectConfigToml = null;
  if (resolvedAcDir && fs.existsSync(path.join(resolvedAcDir, "config.toml"))) {
    projectConfigToml = path.join(resolvedAcDir, "config.toml");
  } else if (project?.working_dir) {
    const legacyToml = path.join(project.working_dir, "agentchattr", "config.toml");
    if (fs.existsSync(legacyToml)) projectConfigToml = legacyToml;
  }

  function getProc() {
    return chattrProcesses.get(projectId) || { process: null, state: "stopped", error: null };
  }
  function setProc(val) {
    chattrProcesses.set(projectId, val);
  }

  function regenerateConfigToml() {
    // If project has a config.toml, update the port to match current config
    if (!projectConfigToml || !fs.existsSync(projectConfigToml)) return;
    try {
      let content = fs.readFileSync(projectConfigToml, "utf-8");
      content = content.replace(/^port = \d+/m, `port = ${chattrPort}`);
      fs.writeFileSync(projectConfigToml, content);
    } catch {}
  }

  function spawnChattr() {
    // Sync config.toml port before starting
    regenerateConfigToml();

    // Use project config.toml if available (isolated data dir + ports), otherwise fall back to --port
    const extraArgs = (projectConfigToml && fs.existsSync(projectConfigToml))
      ? ["--config", projectConfigToml]
      : ["--port", chattrPort];

    // Resolve AgentChattr from its cloned directory
    const { dir: acDir } = resolveProjectChattr(projectId);
    const acSpawn = resolveChattrSpawn(acDir);
    if (!acSpawn) {
      setProc({ process: null, state: "error", error: `AgentChattr not installed. Clone it: git clone https://github.com/bcurts/agentchattr.git ${acDir}` });
      return null;
    }

    const child = spawn(acSpawn.command, [...acSpawn.args, ...extraArgs], {
      cwd: acSpawn.cwd,
      env: process.env,
      stdio: "ignore",
      detached: true,
    });

    // If pid is undefined, spawn failed
    if (!child.pid) {
      setProc({ process: null, state: "error", error: "Failed to start AgentChattr — check that Python venv is set up in " + acDir });
      child.on("error", () => {});
      return null;
    }

    child.unref();
    child.on("error", (err) => {
      setProc({ process: null, state: "error", error: err.message });
    });
    child.on("exit", (code) => {
      const cur = getProc();
      if (cur.process === child) {
        setProc({ process: null, state: "stopped", error: code ? `exit:${code}` : null });
      }
    });
    setProc({ process: child, state: "running", error: null });
    return child;
  }

  if (action === "start") {
    const proc = getProc();
    if (proc.state === "running" && proc.process) {
      return res.json({ ok: true, state: "running", message: "Already running" });
    }
    try {
      const child = spawnChattr();
      if (!child) {
        const errProc = getProc();
        return res.status(500).json({ ok: false, state: "error", error: errProc.error || "Failed to start AgentChattr" });
      }
      // Sync token after AgentChattr starts (it generates its own)
      setTimeout(() => syncChattrToken(projectId), 2000);
      res.json({ ok: true, state: "running", pid: child.pid });
    } catch (err) {
      setProc({ process: null, state: "error", error: err.message });
      res.status(500).json({ ok: false, state: "error", error: err.message });
    }
  } else if (action === "stop") {
    const proc = getProc();
    if (proc.process) {
      try { proc.process.kill("SIGTERM"); } catch {}
    }
    setProc({ process: null, state: "stopped", error: null });
    res.json({ ok: true, state: "stopped" });
  } else if (action === "restart") {
    // #424 / quadwork#304: snapshot history before killing the
    // process. Best-effort and non-blocking-on-failure so a flaky
    // snapshot doesn't leave the operator unable to restart AC.
    await snapshotProjectHistory(projectId).catch(() => {});
    const proc = getProc();
    if (proc.process) {
      try { proc.process.kill("SIGTERM"); } catch {}
    }
    setProc({ process: null, state: "stopped", error: null });
    setTimeout(() => {
      try {
        const child = spawnChattr();
        if (!child) {
          const errProc = getProc();
          return res.status(500).json({ ok: false, state: "error", error: errProc.error || "Failed to start AgentChattr" });
        }
        // Sync token after AgentChattr restarts
        setTimeout(() => syncChattrToken(projectId), 2000);
        res.json({ ok: true, state: "running", pid: child.pid });
      } catch (err) {
        setProc({ process: null, state: "error", error: err.message });
        res.status(500).json({ ok: false, state: "error", error: err.message });
      }
    }, 500);
  } else if (action === "update") {
    // Update AgentChattr: stop → git pull → pip install → restart
    const { dir: acDir } = resolveProjectChattr(projectId);
    if (!acDir || !fs.existsSync(path.join(acDir, "run.py"))) {
      return res.status(400).json({ ok: false, error: "AgentChattr not installed at " + (acDir || "unknown") });
    }
    try {
      const { execSync } = require("child_process");

      // Stop running process before pulling. Snapshot first so a
      // botched git pull can still be rolled back from disk.
      // #424 / quadwork#304: best-effort.
      await snapshotProjectHistory(projectId).catch(() => {});
      const proc = getProc();
      const wasRunning = proc.process && proc.state === "running";
      if (wasRunning) {
        try { proc.process.kill("SIGTERM"); } catch {}
        setProc({ process: null, state: "stopped", error: null });
        // Brief wait for process to release files
        await new Promise(r => setTimeout(r, 1000));
      }

      const pullResult = execSync("git pull 2>&1", { cwd: acDir, encoding: "utf-8", timeout: 30000 }).trim();
      const venvPython = path.join(acDir, ".venv", "bin", "python");
      let pipResult = "";
      const reqFile = path.join(acDir, "requirements.txt");
      if (fs.existsSync(venvPython) && fs.existsSync(reqFile)) {
        pipResult = execSync(`"${venvPython}" -m pip install -r requirements.txt 2>&1`, { cwd: acDir, encoding: "utf-8", timeout: 120000 }).trim();
      }

      // Restart if it was running before the update
      let restarted = false;
      if (wasRunning) {
        const child = spawnChattr();
        restarted = !!child;
        if (child) {
          setTimeout(() => syncChattrToken(projectId).catch(() => {}), 2000);
        }
      }

      res.json({ ok: true, pull: pullResult, pip: pipResult, restarted });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  } else {
    res.status(400).json({ error: "Unknown action" });
  }
}
app.post("/api/agentchattr/:projectOrAction/:action", handleAgentChattr);
app.post("/api/agentchattr/:projectOrAction", handleAgentChattr);

// --- Reset agents: deregister all registered slots ---
// AgentChattr doesn't expose staleness metadata, so this clears all slots.
// Agents' wrapper heartbeat will auto-re-register with clean names.

app.post("/api/agents/:project/reset", async (req, res) => {
  const projectId = req.params.project;
  const { url: chattrUrl, token: chattrToken } = resolveProjectChattr(projectId);
  const headers = {};
  if (chattrToken) headers["x-session-token"] = chattrToken;

  try {
    // Fetch current agent status from AgentChattr
    const statusRes = await fetch(`${chattrUrl}/api/status`, { headers });
    if (!statusRes.ok) {
      return res.status(statusRes.status).json({ ok: false, error: `AgentChattr status failed: ${statusRes.status}` });
    }
    const status = await statusRes.json();
    const slots = status.agents || status.slots || [];

    let cleared = 0;
    for (const agent of slots) {
      const name = typeof agent === "string" ? agent : agent.name || agent.sender;
      if (!name) continue;
      try {
        const dereg = await fetch(`${chattrUrl}/api/deregister/${encodeURIComponent(name)}`, {
          method: "POST",
          headers,
        });
        if (dereg.ok) cleared++;
      } catch {}
    }

    res.json({ ok: true, cleared, total: slots.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Lifecycle: start spawns PTY (visible in terminal panel) ---

app.post("/api/agents/:project/:agent/start", async (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;

  const existing = agentSessions.get(key);
  if (existing && existing.state === "running" && existing.term) {
    return res.json({ ok: true, state: "running", message: "Already running" });
  }

  const result = await spawnAgentPty(project, agent);
  if (result.ok) {
    res.json({ ok: true, state: "running", pid: result.pid });
  } else {
    res.status(result.error?.includes("Unknown") ? 400 : 500).json({ ok: false, state: "error", error: result.error });
  }
});

// --- Lifecycle: stop kills PTY + closes WS ---

app.post("/api/agents/:project/:agent/stop", async (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;
  await stopAgentSession(key);
  res.json({ ok: true, state: "stopped" });
});

// --- Lifecycle: restart ---

app.post("/api/agents/:project/:agent/restart", async (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;

  // #241: must await deregister before respawn so the slot frees and
  // the fresh register lands at slot 1 instead of head-2.
  await stopAgentSession(key);

  const result = await spawnAgentPty(project, agent);
  if (result.ok) {
    res.json({ ok: true, state: "running", pid: result.pid });
  } else {
    res.status(500).json({ ok: false, state: "error", error: result.error });
  }
});

// --- Sessions tracking (for /api/projects dashboard) ---

// Expose agentSessions to migrated routes
app.set("activeSessions", agentSessions);

app.get("/api/sessions", (_req, res) => {
  const sessions = [];
  for (const [, info] of agentSessions) {
    if (info.state === "running") {
      sessions.push({ projectId: info.projectId, agentId: info.agentId });
    }
  }
  res.json(sessions);
});

// --- Write to active PTY session ---

app.post("/api/agents/:project/:agent/write", (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;
  const session = agentSessions.get(key);

  if (!session || !session.term) {
    return res.status(404).json({ ok: false, error: "No active terminal session" });
  }

  const { text } = req.body || {};
  if (!text) {
    return res.status(400).json({ ok: false, error: "Missing text" });
  }

  try {
    session.term.write(text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Scheduled Triggers ---

const triggers = new Map();

const DEFAULT_MESSAGE = `@head @reviewer1 @reviewer2 @dev — Queue check.
Head: Merge any PR with both approvals, assign next from queue.
Dev: Work on assigned ticket or address review feedback.
Reviewer1/Reviewer2: Review open PRs. If Dev pushed fixes, re-review. Post verdict on PR AND notify here.
ALL: Communicate via this chat by tagging agents. Your terminal is NOT visible.`;

async function sendTriggerMessage(projectId) {
  const cfg = readConfig();
  const project = cfg.projects && cfg.projects.find((p) => p.id === projectId);
  const message = (project && project.trigger_message) || DEFAULT_MESSAGE;

  // #401 / quadwork#277: route trigger sends through the local
  // /api/chat path that already works for the chat panel. The old
  // direct /api/send call required a registration token (not the
  // session token we have on hand) and 401'd silently — agents never
  // saw the queue-check pulse. /api/chat opens the AC ws with the
  // session token and inherits the #230 token-resync-on-401 retry,
  // so the trigger now gets the same proven path as the chat panel.
  const qwPort = cfg.port || 8400;
  const url = `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}`;

  const info = triggers.get(projectId);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, channel: "general" }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error(`Trigger send failed for ${projectId}: ${res.status} ${err}`);
      if (info) info.lastError = `${res.status}: ${err.slice(0, 100)}`;
    } else {
      if (info) info.lastError = null;
    }
  } catch (err) {
    console.error(`Trigger send error for ${projectId}:`, err.message);
    if (info) info.lastError = err.message;
  }

  if (info) {
    info.lastSent = Date.now();
    info.nextAt = Date.now() + info.interval;
  }
}

app.get("/api/triggers", (_req, res) => {
  const result = {};
  // Include active runtime triggers first.
  for (const [id, info] of triggers) {
    result[id] = {
      enabled: true,
      interval: info.interval,
      lastSent: info.lastSent,
      nextAt: info.nextAt,
      lastError: info.lastError || null,
      expiresAt: info.expiresAt || null,
      message: null,        // filled in below from config
      intervalMin: null,    // filled in below — last-used interval in minutes
      durationMin: null,    // filled in below — last-used duration in minutes
    };
  }
  // Enrich with the persisted message AND last-used interval/duration
  // for every project in config.json — even projects that don't
  // currently have a running trigger. The Scheduled Trigger widget
  // (#210) hydrates all three controls from this on page reload.
  try {
    const cfg = readConfig();
    for (const p of (cfg.projects || [])) {
      const msg = typeof p.trigger_message === "string" ? p.trigger_message : null;
      const intervalMin = Number.isFinite(p.trigger_interval_min) ? p.trigger_interval_min : null;
      const durationMin = Number.isFinite(p.trigger_duration_min) ? p.trigger_duration_min : null;
      const existing = result[p.id];
      if (existing) {
        existing.message = msg;
        existing.intervalMin = intervalMin;
        existing.durationMin = durationMin;
      } else if (msg !== null || intervalMin !== null || durationMin !== null) {
        result[p.id] = {
          enabled: false,
          interval: intervalMin !== null ? intervalMin * 60 * 1000 : 0,
          lastSent: null,
          nextAt: null,
          lastError: null,
          expiresAt: null,
          message: msg,
          intervalMin,
          durationMin,
        };
      }
    }
  } catch { /* non-fatal */ }
  res.json(result);
});

function stopTrigger(project) {
  const existing = triggers.get(project);
  if (existing) {
    if (existing.timer) clearInterval(existing.timer);
    if (existing.durationTimer) clearTimeout(existing.durationTimer);
  }
  triggers.delete(project);
}

app.post("/api/triggers/:project/start", (req, res) => {
  const { project } = req.params;
  // #418 / quadwork#306: sendImmediately was an always-true
  // "Send Message and Start Trigger" flag from #210; operators
  // asked for a pure scheduler ("Start Trigger" — wait for the
  // first interval). The field is ignored here; the send-now
  // endpoint below still exists for the explicit one-shot path.
  const { interval, duration, message } = req.body || {};
  const ms = (interval || 30) * 60 * 1000;
  const durationMs = duration ? duration * 60 * 1000 : 0; // duration in minutes, 0 = indefinite

  // #210: persist the custom message AND the last-used interval +
  // duration on the project entry so reopening an idle project
  // pre-fills all three controls from the saved state (not just the
  // message). Without persisting interval/duration, the widget
  // would snap back to its defaults (15 min / 3 hr) after every
  // reload even if the operator had picked something else.
  try {
    const cfg = readConfig();
    const entry = (cfg.projects || []).find((p) => p.id === project);
    if (entry) {
      if (typeof message === "string" && message.length > 0) entry.trigger_message = message;
      if (Number.isFinite(interval) && interval > 0) entry.trigger_interval_min = interval;
      if (Number.isFinite(duration) && duration >= 0) entry.trigger_duration_min = duration;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    }
  } catch (e) { /* non-fatal — timer still runs with its in-memory values */ }

  const existing = triggers.get(project);
  if (existing) {
    if (existing.timer) clearInterval(existing.timer);
    if (existing.durationTimer) clearTimeout(existing.durationTimer);
  }

  // #418 / quadwork#306: no immediate fire — the first send happens
  // at T + interval via the setInterval below. Operators set the
  // trigger up in advance of going afk and don't want it interrupting
  // whatever agents are currently mid-task. The explicit "send now"
  // path still lives at /api/triggers/:project/send-now for the
  // rare case an operator actually wants to kick things off.
  const timer = setInterval(() => sendTriggerMessage(project), ms);
  const expiresAt = durationMs > 0 ? Date.now() + durationMs : null;

  const triggerInfo = {
    interval: ms,
    timer,
    lastSent: null,
    nextAt: Date.now() + ms,
    lastError: null,
    expiresAt,
    durationTimer: null,
  };

  // Auto-stop after duration
  if (durationMs > 0) {
    triggerInfo.durationTimer = setTimeout(() => {
      stopTrigger(project);
    }, durationMs);
  }

  triggers.set(project, triggerInfo);
  res.json({ ok: true, enabled: true, interval: ms, nextAt: Date.now() + ms, expiresAt });
});

app.post("/api/triggers/:project/stop", (req, res) => {
  const { project } = req.params;
  stopTrigger(project);
  res.json({ ok: true, enabled: false });
});

app.post("/api/triggers/:project/send-now", (req, res) => {
  const { project } = req.params;
  sendTriggerMessage(project);
  res.json({ ok: true, sent: true });
});

app.post("/api/triggers/sync", (_req, res) => {
  syncTriggersFromConfig();
  res.json({ ok: true });
});

// Expose syncTriggers for migrated routes (config PUT, rename)
app.set("syncTriggers", syncTriggersFromConfig);

// --- OVERNIGHT-QUEUE.md viewer/editor (#209) ---------------------------------
// Read/write the per-project ~/.quadwork/{id}/OVERNIGHT-QUEUE.md file from
// the operator panel. The id must resolve to a project already saved in
// config.json — we never touch an arbitrary path on disk.
function resolveQueueProject(projectId) {
  if (!projectId || typeof projectId !== "string") return null;
  if (projectId.includes("/") || projectId.includes("\\") || projectId.includes("..")) return null;
  const cfg = readConfig();
  return (cfg.projects || []).find((p) => p.id === projectId) || null;
}
function queuePathFor(projectId) {
  return path.join(os.homedir(), ".quadwork", projectId, "OVERNIGHT-QUEUE.md");
}
const OVERNIGHT_TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");

app.get("/api/queue", (req, res) => {
  const projectId = String(req.query.project || "");
  if (!resolveQueueProject(projectId)) return res.status(404).json({ error: "Unknown project" });
  const p = queuePathFor(projectId);
  if (!fs.existsSync(p)) return res.json({ ok: true, exists: false, content: "" });
  try { return res.json({ ok: true, exists: true, content: fs.readFileSync(p, "utf-8") }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

app.put("/api/queue", express.json({ limit: "512kb" }), (req, res) => {
  const projectId = String(req.query.project || "");
  if (!resolveQueueProject(projectId)) return res.status(404).json({ error: "Unknown project" });
  const content = typeof req.body?.content === "string" ? req.body.content : null;
  if (content === null) return res.status(400).json({ error: "Missing content" });
  const p = queuePathFor(projectId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/api/queue", (req, res) => {
  const projectId = String(req.query.project || "");
  const project = resolveQueueProject(projectId);
  if (!project) return res.status(404).json({ error: "Unknown project" });
  const p = queuePathFor(projectId);
  if (fs.existsSync(p)) return res.json({ ok: true, existed: true });
  const tpl = path.join(OVERNIGHT_TEMPLATES_DIR, "OVERNIGHT-QUEUE.md");
  if (!fs.existsSync(tpl)) return res.status(500).json({ error: "Template missing" });
  try {
    let content = fs.readFileSync(tpl, "utf-8");
    content = content.replace(/\{\{project_name\}\}/g, project.name || projectId);
    content = content.replace(/\{\{repo\}\}/g, project.repo || "");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return res.json({ ok: true, existed: false });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// --- Serve static frontend (built Next.js export) ---

// Strip trailing slashes (redirect /settings/ → /settings, /setup/ → /setup)
app.use((req, res, next) => {
  if (req.path !== "/" && req.path.endsWith("/")) {
    const clean = req.path.slice(0, -1);
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return res.redirect(301, clean + query);
  }
  next();
});

const outDir = path.resolve(__dirname, "..", "out");

// Resolve extensionless requests to .html files before express.static.
// Next.js static export creates both /setup.html and /setup/ directory —
// express.static finds the directory first and returns NotFoundError.
app.use((req, res, next) => {
  if (req.path === "/" || req.path.startsWith("/api/") || req.path.startsWith("/_next/") || path.extname(req.path)) {
    return next();
  }
  const htmlFile = req.path.slice(1) + ".html";
  const htmlPath = path.join(outDir, htmlFile);
  if (fs.existsSync(htmlPath)) {
    return res.sendFile(htmlFile, { root: outDir }, (err) => {
      if (err) next();
    });
  }
  next();
});

if (fs.existsSync(outDir)) {
  app.use(express.static(outDir, { redirect: false, extensions: ["html"] }));
}

// SPA fallback: serve the pre-rendered template for dynamic routes,
// fall back to index.html for everything else.
app.use((req, res, next) => {
  if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api/")) {
    return next();
  }

  // Dynamic routes → serve their pre-rendered template (has the right JS chunks).
  // Hydration #418 is cosmetic — dashboard renders and functions correctly.
  // NOTE: app-shell.html does NOT work — it has no route JS chunks and renders blank.
  const dynamicRoutes = [
    { pattern: /^\/project\/[^/]+\/memory\/?$/, template: "project/_/memory.html" },
    { pattern: /^\/project\/[^/]+\/queue\/?$/, template: "project/_/queue.html" },
    { pattern: /^\/project\/[^/]+\/?$/, template: "project/_.html" },
  ];

  for (const route of dynamicRoutes) {
    if (route.pattern.test(req.path)) {
      if (fs.existsSync(path.join(outDir, route.template))) {
        return res.sendFile(route.template, { root: outDir }, (err) => {
          if (err) next();
        });
      }
    }
  }

  // Everything else → index.html
  if (fs.existsSync(path.join(outDir, "index.html"))) {
    res.sendFile("index.html", { root: outDir }, (err) => {
      if (err) next();
    });
  } else {
    res.status(503).send("Frontend not built. Run: npm run build");
  }
});

// --- WebSocket + PTY ---
// WS connects to an existing PTY session (started via lifecycle API)
// or spawns a new one if none exists.

const wss = new WebSocketServer({ server, path: "/ws/terminal" });

wss.on("connection", async (ws, req) => {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const projectId = params.get("project");
  const agentId = params.get("agent");

  if (!projectId || !agentId) {
    ws.close(1008, "missing project or agent query params");
    return;
  }

  const sessionKey = `${projectId}/${agentId}`;
  let session = agentSessions.get(sessionKey);

  // If no active PTY, spawn one
  if (!session || !session.term) {
    const result = await spawnAgentPty(projectId, agentId);
    if (!result.ok) {
      ws.close(1011, "pty-spawn-failed");
      return;
    }
    session = agentSessions.get(sessionKey);
  }

  // Close previous WS if one was attached
  if (session.ws && session.ws !== ws && session.ws.readyState <= 1) {
    session.ws.close(1000, "replaced");
  }

  // Attach WS to session
  session.ws = ws;

  // PTY → client
  const dataHandler = session.term.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  // Client → PTY
  ws.on("message", (msg) => {
    if (!session.term) return;
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        session.term.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {}
    session.term.write(str);
  });

  ws.on("close", () => {
    dataHandler.dispose();
    // Only clear ws reference, don't kill PTY (it stays running for reconnect)
    if (session.ws === ws) {
      session.ws = null;
    }
  });
});

// --- Trigger auto-start from config ---

function syncTriggersFromConfig() {
  const cfg = readConfig();
  const activeIds = new Set();

  if (cfg.projects) {
    for (const project of cfg.projects) {
      if (project.trigger_enabled) {
        activeIds.add(project.id);
        const ms = (project.trigger_interval || 30) * 60 * 1000;
        const existing = triggers.get(project.id);
        if (!existing || existing.interval !== ms) {
          if (existing && existing.timer) clearInterval(existing.timer);
          const timer = setInterval(() => sendTriggerMessage(project.id), ms);
          triggers.set(project.id, { interval: ms, timer, lastSent: null, nextAt: Date.now() + ms, lastError: null });
        }
      }
    }
  }

  for (const [id, info] of triggers) {
    if (!activeIds.has(id)) {
      if (info.timer) clearInterval(info.timer);
      if (info.durationTimer) clearTimeout(info.durationTimer);
      triggers.delete(id);
    }
  }
}

// #422 / quadwork#310: auto-continue after loop guard.
//
// Per opted-in project, poll AC's /api/status every 10s. When we see
// a false → true transition on `paused`, wait the configured delay
// (default 30s) and POST /continue to /api/chat — same path the
// operator would use manually. The delay gives a human a chance to
// intervene on an actually-runaway loop, and acts as a soft rate
// limit against pathological loops that would otherwise just loop
// forever under an auto-continue.
//
// Detection is deliberately polling rather than a long-lived ws:
// a ws subscription per project would complicate lifecycle and
// reconnection, and 10s polling latency is acceptable when the
// delay is tens of seconds. Skipping projects without the opt-in
// keeps the poller cheap for single-project setups.

const _loopGuardPausedState = new Map(); // projectId -> { paused: bool, scheduled: Timeout? }
const LOOP_GUARD_POLL_INTERVAL_MS = 10000;

async function checkLoopGuardPause(project) {
  if (!project || !project.auto_continue_loop_guard) return;
  const { url: base, token: sessionToken } = resolveProjectChattr(project.id);
  if (!base) return;
  let paused = false;
  try {
    const r = await fetch(`${base}/api/status`, {
      headers: sessionToken ? { "x-session-token": sessionToken } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return;
    const data = await r.json();
    paused = !!(data && data.paused);
  } catch {
    return;
  }
  const state = _loopGuardPausedState.get(project.id) || { paused: false, scheduled: null };
  // Transition false → true: schedule an auto-continue after the delay.
  if (paused && !state.paused && !state.scheduled) {
    const delaySec = Number.isFinite(project.auto_continue_delay_sec) && project.auto_continue_delay_sec >= 5
      ? project.auto_continue_delay_sec
      : 30;
    console.log(`[loop-guard] ${project.id} paused — auto-continue in ${delaySec}s`);
    state.scheduled = setTimeout(async () => {
      try {
        // Re-check the opt-in at fire time so a checkbox disable
        // mid-wait actually stops the auto-continue.
        const freshCfg = readConfig();
        const fresh = freshCfg.projects?.find((p) => p.id === project.id);
        if (!fresh || !fresh.auto_continue_loop_guard) {
          console.log(`[loop-guard] ${project.id} auto-continue cancelled (opt-in disabled during wait)`);
        } else {
          // Re-check the router's pause state at fire time too. The
          // 10s status poller may not have seen a manual operator
          // /continue yet when the delay window (5–9s) is shorter
          // than the poll interval — without this, a manual resume
          // inside a 5s wait would be followed by a stale auto
          // /continue that clobbers hop_count on an already-running
          // chain (router.continue_routing resets the counter
          // unconditionally). The re-check closes the race.
          let stillPaused = false;
          try {
            const { url: freshBase, token: freshToken } = resolveProjectChattr(project.id);
            if (freshBase) {
              const sr = await fetch(`${freshBase}/api/status`, {
                headers: freshToken ? { "x-session-token": freshToken } : {},
                signal: AbortSignal.timeout(5000),
              });
              if (sr.ok) {
                const sd = await sr.json();
                stillPaused = !!(sd && sd.paused);
              }
            }
          } catch {
            // Status re-check failed — fall back to "don't fire".
            // Stuck pause will still be caught on the next 10s tick.
          }
          if (!stillPaused) {
            console.log(`[loop-guard] ${project.id} auto-continue cancelled (router already resumed)`);
          } else {
            const res = await fetch(`http://127.0.0.1:${PORT}/api/chat?project=${encodeURIComponent(project.id)}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: "/continue", channel: "general" }),
            });
            if (res.ok) console.log(`[loop-guard] ${project.id} auto-continued`);
            else console.warn(`[loop-guard] ${project.id} auto-continue POST returned ${res.status}`);
          }
        }
      } catch (err) {
        console.warn(`[loop-guard] ${project.id} auto-continue failed: ${err.message || err}`);
      }
      const s2 = _loopGuardPausedState.get(project.id);
      if (s2) s2.scheduled = null;
    }, delaySec * 1000);
  }
  // Transition true → false: clear any pending timer.
  if (!paused && state.paused && state.scheduled) {
    clearTimeout(state.scheduled);
    state.scheduled = null;
  }
  state.paused = paused;
  _loopGuardPausedState.set(project.id, state);
}

function runLoopGuardPollingTick() {
  try {
    const cfg = readConfig();
    for (const p of (cfg.projects || [])) {
      if (p && p.auto_continue_loop_guard) checkLoopGuardPause(p);
    }
  } catch {
    // config unreadable — next tick will retry
  }
}

setInterval(runLoopGuardPollingTick, LOOP_GUARD_POLL_INTERVAL_MS);

// --- Start ---

server.listen(PORT, "127.0.0.1", () => {
  console.log(`QuadWork server listening on http://127.0.0.1:${PORT}`);
  syncTriggersFromConfig();
  // Sync AgentChattr tokens for all projects on startup
  const startupCfg = readConfig();
  for (const p of (startupCfg.projects || [])) {
    syncChattrToken(p.id);
  }
});

/**
 * Send SIGTERM to every AgentChattr child currently tracked by the
 * server. Exported so bin/quadwork.js (`cmdInit` / `cmdStart`) can
 * call it from its own SIGINT handler — AgentChattr children spawned
 * by the dashboard's /api/agentchattr/{id}/start endpoint live in
 * this process's in-memory `chattrProcesses` Map and are otherwise
 * invisible to the CLI. Without this, a Ctrl+C in the foreground
 * quadwork terminal would exit the Node process and orphan every
 * dashboard-started python run.py. See review on quadwork#213.
 */
function shutdownChattrProcesses() {
  for (const [, proc] of chattrProcesses) {
    if (proc && proc.process) {
      try { proc.process.kill("SIGTERM"); } catch {}
    }
  }
  chattrProcesses.clear();
}

module.exports = { shutdownChattrProcesses };
