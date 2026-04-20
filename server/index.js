const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { spawn } = require("child_process");
const { readConfig, resolveAgentCwd, resolveAgentCommand, resolveProjectChattr, resolveChattrSpawn, syncChattrToken, CONFIG_PATH, ensureSecureDir, writeSecureFile, writeConfig } = require("./config");
const routes = require("./routes");
const {
  patchAgentchattrConfigForDiscordBridge,
  patchAgentchattrConfigForTelegramBridge,
  projectAgentchattrConfigPath,
} = routes;
const { waitForAgentChattrReady, registerAgent, deregisterAgent, startHeartbeat, stopHeartbeat } = require("./agentchattr-registry");
const { patchAgentchattrCss } = require("./install-agentchattr");
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

const { execFileSync } = require("child_process");

function isCliInstalled(cmd) {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8", stdio: "pipe" });
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
    ensureSecureDir(configDir);
    writeSecureFile(_agentTokenPath(projectId, agentId), token);
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
  ensureSecureDir(configDir);
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
  writeSecureFile(filePath, JSON.stringify(config, null, 2));
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

  // #343: per-agent model + reasoning effort overrides. Persist in
  // project.agents[agentId].{model,reasoning_effort} via the
  // dashboard Agent Models widget. When unset, fall back to the
  // CLI's own default so existing projects without overrides keep
  // their current behavior.
  //
  // Codex: -c model="<slug>" / -c model_reasoning_effort="<level>"
  //   reasoning levels: minimal | low | medium | high (xhigh is
  //   deliberately NOT offered — it's the capacity-failure hot
  //   spot #343 was filed for).
  // Claude: --model <slug>
  //   reasoning_effort is not wired for Claude — Anthropic's CLI
  //   doesn't expose an equivalent flag.
  if (cliBase === "codex") {
    if (agentCfg.model && typeof agentCfg.model === "string") {
      args.push("-c", `model="${agentCfg.model}"`);
    }
    if (agentCfg.reasoning_effort && typeof agentCfg.reasoning_effort === "string") {
      args.push("-c", `model_reasoning_effort="${agentCfg.reasoning_effort}"`);
    }
  } else if (cliBase === "claude") {
    if (agentCfg.model && typeof agentCfg.model === "string") {
      args.push("--model", agentCfg.model);
    }
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
      // head-2 / re2-2. We need the previous agent's bearer
      // token because app.py:2123 requires authenticated agent
      // session for family names — load it from disk (persisted
      // across restarts). Failures are non-fatal.
      const stalePersistedToken = readPersistedAgentToken(projectId, agentId);
      if (stalePersistedToken) {
        await deregisterAgent(acServerPort, agentId, stalePersistedToken).catch(() => {});
        clearPersistedAgentToken(projectId, agentId);
      }
      // #478: force-replace so AC expires any ghost slots for this base
      const registration = await registerAgent(acServerPort, agentId, agentCfg.display_name || null, { force: true });
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
      // #478: force-replace so AC expires any ghost slots for this base
      const registration = await registerAgent(acServerPort, agentId, agentCfg.display_name || null, { force: true });
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
    ensureSecureDir(configDir);
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
    writeSecureFile(settingsPath, JSON.stringify(settings, null, 2));
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

  // #478: force-replace so AC expires any ghost slots for this base
  const replacement = await registerAgent(session.acServerPort, agentId, agentCfg.display_name || null, { force: true });
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
      // #418: ring buffer of recent PTY output so reconnecting WS
      // clients see the terminal state instead of a blank panel.
      // #538: scrollback is scrubbed of likely secrets before replay.
      scrollback: Buffer.alloc(0),
    };
    agentSessions.set(key, session);

    // #418: capture PTY output into the scrollback ring buffer (64KB).
    // This runs independently of WS — even when no client is connected,
    // the buffer accumulates so the next connect gets replay.
    const SCROLLBACK_SIZE = 64 * 1024;
    term.onData((data) => {
      const chunk = Buffer.from(data);
      session.scrollback = Buffer.concat([session.scrollback, chunk]);
      if (session.scrollback.length > SCROLLBACK_SIZE) {
        session.scrollback = session.scrollback.slice(-SCROLLBACK_SIZE);
      }
    });

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
    ensureSecureDir(snapDir);
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
      writeSecureFile(projectConfigToml, content);
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
    // #394: backfill sender-overflow CSS/JS patch on every spawn so
    // existing installs receive the fix without manual update.
    patchAgentchattrCss(acDir);
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

  // #386: Kill any process listening on the AC port. Handles orphaned
  // processes that survive QuadWork restarts (detached + unref'd spawns
  // lose their tracked reference when the Node process recycles).
  function killProcessOnPort(port) {
    try {
      const pids = execFileSync("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (!pids) return;
      for (const line of pids.split("\n")) {
        const pid = parseInt(line, 10);
        if (pid > 0) {
          try { process.kill(pid, "SIGTERM"); } catch {}
        }
      }
    } catch {
      // lsof exits non-zero when no matching process — expected
    }
  }

  // #386: Poll until the port is free or timeout expires.
  function waitForPortFree(port, timeoutMs = 3000) {
    const start = Date.now();
    return new Promise((resolve) => {
      function check() {
        try {
          execFileSync("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], {
            encoding: "utf-8",
            timeout: 2000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          // Still occupied — retry if within budget
          if (Date.now() - start < timeoutMs) {
            setTimeout(check, 200);
          } else {
            resolve(false);
          }
        } catch {
          // lsof found nothing — port is free
          resolve(true);
        }
      }
      check();
    });
  }

  if (action === "start") {
    const proc = getProc();
    if (proc.state === "running" && proc.process) {
      return res.json({ ok: true, state: "running", message: "Already running" });
    }
    // #401: validate AgentChattr is installed BEFORE killing anything on
    // the port. Without this guard, clicking Start when AC is missing
    // kills an unrelated process then fails with "not installed".
    const { dir: acDir } = resolveProjectChattr(projectId);
    const acSpawn = resolveChattrSpawn(acDir);
    if (!acSpawn) {
      const errMsg = `AgentChattr not installed. Clone it: git clone https://github.com/bcurts/agentchattr.git ${acDir}`;
      setProc({ process: null, state: "error", error: errMsg });
      return res.status(500).json({ ok: false, state: "error", error: errMsg });
    }

    // #393: kill any orphaned process on the port before spawning
    // (same pattern as restart/stop from #386).
    killProcessOnPort(chattrPort);
    const portFree = await waitForPortFree(chattrPort, 3000);
    if (!portFree) {
      console.warn(`[agentchattr] ${projectId} port ${chattrPort} still occupied after 3s — spawning anyway`);
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
    // #386: also kill any orphaned process holding the port
    killProcessOnPort(chattrPort);
    setProc({ process: null, state: "stopped", error: null });
    res.json({ ok: true, state: "stopped" });
  } else if (action === "restart") {
    // #424 / quadwork#304: snapshot history before killing the
    // process. Best-effort and non-blocking-on-failure so a flaky
    // snapshot doesn't leave the operator unable to restart AC.
    await snapshotProjectHistory(projectId).catch(() => {});
    // #424 / quadwork#304 Phase 3: latch the opt-in BEFORE the
    // spawn so a restart that itself clears the flag can't starve
    // the auto-restore. We capture the snapshot filename we just
    // wrote + the project's auto_restore_after_restart flag and
    // replay it in the post-spawn tick below if both are set.
    const preRestartCfg = readConfig();
    const preRestartProject = preRestartCfg.projects?.find((p) => p.id === projectId);
    const shouldAutoRestore = !!(preRestartProject && preRestartProject.auto_restore_after_restart);
    const proc = getProc();
    if (proc.process) {
      try { proc.process.kill("SIGTERM"); } catch {}
    }
    // #386: also kill any orphaned process holding the port (handles
    // detached processes that survived a QuadWork restart).
    killProcessOnPort(chattrPort);
    setProc({ process: null, state: "stopped", error: null });
    // #386: wait for the port to actually be free before spawning,
    // instead of a fixed 500ms that may race the old process.
    const portFree = await waitForPortFree(chattrPort, 3000);
    if (!portFree) {
      console.warn(`[agentchattr] ${projectId} port ${chattrPort} still occupied after 3s — spawning anyway`);
    }
    try {
      const child = spawnChattr();
      if (!child) {
        const errProc = getProc();
        return res.status(500).json({ ok: false, state: "error", error: errProc.error || "Failed to start AgentChattr" });
      }
      // Sync token after AgentChattr restarts
      setTimeout(() => syncChattrToken(projectId), 2000);
      // #424 / quadwork#304 Phase 3: optional auto-restore.
      // Fire the restore 3s after spawn so AC's ws is ready.
      // Best-effort: never blocks the restart response or
      // rolls back on error.
      if (shouldAutoRestore) {
        setTimeout(async () => {
          try {
            const snapDir = path.join(require("os").homedir(), ".quadwork", projectId, "history-snapshots");
            if (!fs.existsSync(snapDir)) return;
            const newest = fs.readdirSync(snapDir)
              .filter((f) => f.endsWith(".json"))
              .map((f) => ({ f, t: fs.statSync(path.join(snapDir, f)).mtimeMs }))
              .sort((a, b) => b.t - a.t)[0];
            if (!newest) return;
            const r = await fetch(`http://127.0.0.1:${PORT}/api/project-history/restore?project=${encodeURIComponent(projectId)}&name=${encodeURIComponent(newest.f)}`, {
              method: "POST",
            });
            if (r.ok) console.log(`[snapshot] ${projectId} auto-restored ${newest.f}`);
            else console.warn(`[snapshot] ${projectId} auto-restore returned ${r.status}`);
          } catch (err) {
            console.warn(`[snapshot] ${projectId} auto-restore failed: ${err.message || err}`);
          }
        }, 3000);
      }
      res.json({ ok: true, state: "running", pid: child.pid });
      // #447: auto-reset all agents after AC restart so they get
      // fresh MCP tokens. buildAgentArgs → waitForAgentChattrReady
      // handles the AC-readiness wait internally; the 2s delay here
      // just lets the AC process finish binding its port before we
      // start polling.
      setTimeout(async () => {
        try {
          const resetResp = await fetch(`http://127.0.0.1:${PORT}/api/agents/${encodeURIComponent(projectId)}/reset`, {
            method: "POST",
          });
          if (resetResp.ok) {
            const resetData = await resetResp.json();
            console.log(`[agentchattr] ${projectId} auto-reset ${resetData.restarted} agent(s) after AC restart`);
          } else {
            console.warn(`[agentchattr] ${projectId} agent reset after AC restart returned ${resetResp.status}`);
          }
        } catch (err) {
          console.warn(`[agentchattr] ${projectId} agent reset after AC restart failed: ${err.message || err}`);
        }
      }, 2000);
    } catch (err) {
      setProc({ process: null, state: "error", error: err.message });
      res.status(500).json({ ok: false, state: "error", error: err.message });
    }
  } else if (action === "update") {
    // Update AgentChattr: stop → git pull → pip install → restart
    const { dir: acDir } = resolveProjectChattr(projectId);
    if (!acDir || !fs.existsSync(path.join(acDir, "run.py"))) {
      return res.status(400).json({ ok: false, error: "AgentChattr not installed at " + (acDir || "unknown") });
    }
    try {
      // Stop running process before pulling. Snapshot first so a
      // botched git pull can still be rolled back from disk.
      // #424 / quadwork#304: best-effort.
      await snapshotProjectHistory(projectId).catch(() => {});
      // Latch the auto-restore opt-in BEFORE stop, same as the
      // explicit restart branch above — a config mutation during
      // the git pull shouldn't starve the replay.
      const updateCfgPre = readConfig();
      const updateProjectPre = updateCfgPre.projects?.find((p) => p.id === projectId);
      const updateShouldAutoRestore = !!(updateProjectPre && updateProjectPre.auto_restore_after_restart);
      const proc = getProc();
      const wasRunning = proc.process && proc.state === "running";
      if (wasRunning) {
        try { proc.process.kill("SIGTERM"); } catch {}
      }
      // #386: kill orphaned processes on the port too
      killProcessOnPort(chattrPort);
      if (wasRunning) {
        setProc({ process: null, state: "stopped", error: null });
        // Wait for the port to be released before pulling/restarting
        await waitForPortFree(chattrPort, 3000);
      }

      const pullResult = execFileSync("git", ["pull"], { cwd: acDir, encoding: "utf-8", timeout: 30000, stdio: "pipe" }).trim();
      // #388: re-apply sender-overflow CSS patch after git pull
      patchAgentchattrCss(acDir);
      const venvPython = path.join(acDir, ".venv", "bin", "python");
      let pipResult = "";
      const reqFile = path.join(acDir, "requirements.txt");
      if (fs.existsSync(venvPython) && fs.existsSync(reqFile)) {
        pipResult = execFileSync(venvPython, ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: acDir, encoding: "utf-8", timeout: 120000, stdio: "pipe" }).trim();
      }

      // Restart if it was running before the update
      let restarted = false;
      if (wasRunning) {
        const child = spawnChattr();
        restarted = !!child;
        if (child) {
          setTimeout(() => syncChattrToken(projectId).catch(() => {}), 2000);
          // #424 / quadwork#304 Phase 3: auto-restore after an
          // update-triggered restart too (t2a re-review). Same
          //3s wait + newest-snapshot-by-mtime path as the explicit
          // restart branch, using the pre-stop latched opt-in.
          if (updateShouldAutoRestore) {
            setTimeout(async () => {
              try {
                const snapDir = path.join(require("os").homedir(), ".quadwork", projectId, "history-snapshots");
                if (!fs.existsSync(snapDir)) return;
                const newest = fs.readdirSync(snapDir)
                  .filter((f) => f.endsWith(".json"))
                  .map((f) => ({ f, t: fs.statSync(path.join(snapDir, f)).mtimeMs }))
                  .sort((a, b) => b.t - a.t)[0];
                if (!newest) return;
                const r = await fetch(`http://127.0.0.1:${PORT}/api/project-history/restore?project=${encodeURIComponent(projectId)}&name=${encodeURIComponent(newest.f)}`, {
                  method: "POST",
                });
                if (r.ok) console.log(`[snapshot] ${projectId} auto-restored ${newest.f} after update`);
                else console.warn(`[snapshot] ${projectId} post-update auto-restore returned ${r.status}`);
              } catch (err) {
                console.warn(`[snapshot] ${projectId} post-update auto-restore failed: ${err.message || err}`);
              }
            }, 3000);
          }
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

// #416: AC health status endpoint — returns the health monitor state
// for a project so the dashboard can surface auto-restart events.
app.get("/api/agentchattr/:project/health", (req, res) => {
  const projectId = req.params.project;
  const proc = chattrProcesses.get(projectId);
  const health = _acHealth.state.get(projectId) || { lastRestart: 0, consecutiveFailures: 0 };
  res.json({
    state: proc?.state || "unknown",
    error: proc?.error || null,
    autoRestart: {
      lastRestart: health.lastRestart || null,
      consecutiveFailures: health.consecutiveFailures,
      gaveUp: health.consecutiveFailures >= 3,
    },
  });
});

app.post("/api/agents/:project/reset", async (req, res) => {
  const projectId = req.params.project;

  // #417: Reset Agents now stops and respawns all agent sessions for
  // the project. Uses the configured agent list from config.json so
  // agents missing from agentSessions (e.g. after a crash or prior
  // stop) are still brought back. The old implementation only
  // deregistered AC slots, which fails with stale tokens after an AC
  // crash and doesn't restart the agent processes.
  try {
    // Build the full agent set: start with configured agents, then
    // merge any tracked sessions that might use a different key.
    const cfg = readConfig();
    const project = cfg.projects?.find((p) => p.id === projectId);
    const configuredAgents = project?.agents ? Object.keys(project.agents) : [];

    // Also include any live sessions not in the config (defensive)
    const sessionAgentIds = new Set();
    for (const [key] of agentSessions) {
      if (key.startsWith(`${projectId}/`)) {
        sessionAgentIds.add(key.split("/")[1]);
      }
    }
    const allAgentIds = [...new Set([...configuredAgents, ...sessionAgentIds])];

    if (allAgentIds.length === 0) {
      return res.json({ ok: true, restarted: 0, total: 0, message: "No agents configured" });
    }

    // Stop all agents first (handles deregistration best-effort)
    for (const agentId of allAgentIds) {
      await stopAgentSession(`${projectId}/${agentId}`);
    }

    // Respawn all agents with fresh MCP tokens
    let restarted = 0;
    const errors = [];
    for (const agentId of allAgentIds) {
      const result = await spawnAgentPty(projectId, agentId);
      if (result.ok) {
        restarted++;
      } else {
        errors.push(`${agentId}: ${result.error}`);
      }
    }

    res.json({
      ok: restarted > 0,
      restarted,
      total: allAgentIds.length,
      ...(errors.length > 0 ? { errors } : {}),
    });
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

const DEFAULT_MESSAGE = `@head @re1 @re2 @dev — Queue check.
Head: Merge any PR with both approvals, assign next from queue.
Dev: Work on assigned ticket or address review feedback.
RE1/RE2: Review open PRs. If Dev pushed fixes, re-review. Post verdict on PR AND notify here.
ALL: Communicate via this chat by tagging agents. Your terminal is NOT visible.`;

// #518: server-side bridge lifecycle helpers. Stop and start Telegram +
// Discord bridges so they respond to batch transitions even when the
// operator is on a different project page.

async function autoStopBridges(projectId, project, qwPort) {
  if (project?.telegram_auto) {
    try {
      await fetch(`http://127.0.0.1:${qwPort}/api/telegram?action=stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[auto-bridge] ${projectId}: telegram bridge auto-stopped`);
    } catch { /* non-fatal */ }
  }
  if (project?.discord_auto) {
    try {
      await fetch(`http://127.0.0.1:${qwPort}/api/discord?action=stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[auto-bridge] ${projectId}: discord bridge auto-stopped`);
    } catch { /* non-fatal */ }
  }
}

async function autoStartBridges(projectId, project, qwPort) {
  if (project?.telegram_auto) {
    try {
      // Check if already running before starting
      const st = await fetch(
        `http://127.0.0.1:${qwPort}/api/telegram?project=${encodeURIComponent(projectId)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (st.ok) {
        const data = await st.json();
        if (data.running) return; // already running
        if (!data.configured) return; // not configured — can't start
      }
      await fetch(`http://127.0.0.1:${qwPort}/api/telegram?action=start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[auto-bridge] ${projectId}: telegram bridge auto-started`);
    } catch { /* non-fatal */ }
  }
  if (project?.discord_auto) {
    try {
      const st = await fetch(
        `http://127.0.0.1:${qwPort}/api/discord?project=${encodeURIComponent(projectId)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (st.ok) {
        const data = await st.json();
        if (data.running) return;
        if (!data.configured) return;
      }
      await fetch(`http://127.0.0.1:${qwPort}/api/discord?action=start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[auto-bridge] ${projectId}: discord bridge auto-started`);
    } catch { /* non-fatal */ }
  }
}

// Track previous batch state per project for bridge auto-start detection
const _bridgeBatchPrev = new Map();

async function sendTriggerMessage(projectId) {
  const cfg = readConfig();
  const project = cfg.projects && cfg.projects.find((p) => p.id === projectId);

  // #516: server-side auto-stop — check batch progress before sending.
  // When trigger_auto is enabled, skip the message and stop the trigger
  // (plus caffeinate) if the batch is already complete. This covers the
  // case where the operator is on a different page and the client-side
  // ScheduledTriggerWidget is not mounted to detect completion.
  if (project && project.trigger_auto) {
    const qwPort = cfg.port || 8400;
    try {
      const bpRes = await fetch(
        `http://127.0.0.1:${qwPort}/api/batch-progress?project=${encodeURIComponent(projectId)}`
      );
      if (bpRes.ok) {
        const bp = await bpRes.json();
        if (bp && bp.complete) {
          console.log(`[auto-trigger] ${projectId}: batch complete, auto-stopped`);
          stopTrigger(projectId);
          // Also stop caffeinate if no other triggers remain running
          // (#441 companion fix). caffeinateProcess is global (not
          // project-scoped), so only kill it when all work is done.
          if (caffeinateProcess.process && triggers.size === 0) {
            try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
            caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
            console.log(`[auto-trigger] ${projectId}: caffeinate auto-stopped (no active triggers remain)`);
          }
          // #518: also stop bridges when batch completes
          await autoStopBridges(projectId, project, qwPort);
          return;
        }
      }
    } catch (err) {
      // Non-fatal — if batch-progress fails, proceed with the message
      console.error(`[auto-trigger] ${projectId}: batch-progress check failed:`, err.message);
    }
  }

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
  // send-and-start flag from the original #210 button; operators
  // asked for a pure scheduler (the button is now just "Start
  // Trigger" — wait for the first interval). The field is
  // ignored here; the send-now endpoint below still exists for
  // the explicit one-shot path.
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
      writeConfig(cfg);
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
    ensureSecureDir(path.dirname(p));
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
    ensureSecureDir(path.dirname(p));
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
    // #445: memory route removed (agent-memory integration deprecated)
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

// --- #538: PTY output secret scrubbing ---
// Redact likely secrets from both live PTY streaming and scrollback
// replay so echoed credentials are not exposed to dashboard clients.
//
// Threat model: QuadWork binds to 127.0.0.1 only. The scrub is
// defense-in-depth — it reduces exposure if a secret is accidentally
// echoed, but cannot catch every possible format. Operators who handle
// highly sensitive credentials should avoid echoing them in agent
// terminals.
//
// Live chunks from term.onData() are typically line-aligned (shell
// flushes on newline), so per-chunk scrubbing catches the vast majority
// of secrets. A secret split across two chunks is a theoretical edge
// case that the scrollback scrub (which sees the full buffer) covers
// on reconnect.

// Patterns that indicate a line contains a secret value.
const _SECRET_NAME_RE = /\b\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASSPHRASE|AUTH)\w*\s*[=:]/i;
// Known API key prefixes (Anthropic, GitHub, OpenAI, etc.).
const _API_KEY_PREFIX_RE = /\b(sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|ghu_[A-Za-z0-9]{36,}|ghs_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9-]{20,}|xoxp-[A-Za-z0-9-]{20,})\b/;
// Bearer authorization headers.
const _BEARER_RE = /\bBearer\s+[A-Za-z0-9_.+/=-]{20,}/i;
const _REDACTED = "[REDACTED]";

function scrubSecrets(text) {
  if (!text) return text;
  return text.split("\n").map((line) => {
    // Strip ANSI escape codes for pattern matching, but redact the
    // original line (preserves terminal formatting around non-secret
    // lines while ensuring secrets inside styled output are caught).
    const plain = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    if (_SECRET_NAME_RE.test(plain)) {
      // Redact the value portion after the = or : delimiter.
      return line.replace(/([=:])\s*\S.*/, `$1 ${_REDACTED}`);
    }
    if (_API_KEY_PREFIX_RE.test(plain)) {
      return line.replace(_API_KEY_PREFIX_RE, _REDACTED);
    }
    if (_BEARER_RE.test(plain)) {
      return line.replace(/\bBearer\s+[A-Za-z0-9_.+/=-]{20,}/gi, `Bearer ${_REDACTED}`);
    }
    return line;
  }).join("\n");
}

function scrubScrollback(buf) {
  if (!buf || buf.length === 0) return buf;
  return Buffer.from(scrubSecrets(buf.toString("utf-8")), "utf-8");
}

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

  // #418/#461: scrollback replay is now client-initiated via
  // {"type":"replay"} to avoid the timing race where eager replay
  // arrived before the client's onmessage handler was registered.

  // PTY → client (#538: scrub secrets from live output)
  const dataHandler = session.term.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(scrubSecrets(data));
    }
  });

  // Client → PTY
  ws.on("message", (msg) => {
    if (!session.term) return;
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize") {
        // #541: validate resize payload — type-check and clamp to sane
        // bounds before passing to PTY. Prevents NaN, negative, or
        // absurdly large values from reaching node-pty.
        const cols = typeof parsed.cols === "number" ? parsed.cols : parseInt(parsed.cols, 10);
        const rows = typeof parsed.rows === "number" ? parsed.rows : parseInt(parsed.rows, 10);
        if (Number.isFinite(cols) && Number.isFinite(rows) &&
            cols >= 1 && cols <= 500 && rows >= 1 && rows <= 500) {
          session.term.resize(cols, rows);
        }
        return;
      }
      // #461: client requests scrollback replay after xterm is fully
      // initialized. This eliminates the timing race where the server
      // sends scrollback before the client's onmessage handler is ready.
      // If the buffer is empty (idle agent with no output yet), send a
      // synthetic status line so the terminal isn't completely blank.
      if (parsed.type === "replay") {
        if (session.scrollback && session.scrollback.length > 0) {
          // #538: scrub likely secrets before replaying accumulated output.
          ws.send(scrubScrollback(session.scrollback));
        } else {
          ws.send(`\x1b[2m[agent online — waiting for input]\x1b[0m\r\n`);
        }
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

// #516: server-side batch-completion poller. Checks every 30s whether
// any trigger_auto project's batch is complete, and auto-stops the
// trigger (plus caffeinate when no triggers remain). This runs
// independently of the trigger tick interval, so completion is
// detected within 30s even if the operator is on a different page.
// #518: also handles telegram_auto / discord_auto bridge lifecycle
// (both start and stop) so bridges respond to batch transitions
// even when the operator is viewing a different project page.

const AUTO_STOP_POLL_INTERVAL_MS = 30_000;

async function autoStopPollingTick() {
  const cfg = readConfig();
  if (!cfg.projects) return;

  for (const project of cfg.projects) {
    const hasTriggerAuto = project.trigger_auto && triggers.has(project.id);
    const hasBridgeAuto = project.telegram_auto || project.discord_auto;
    if (!hasTriggerAuto && !hasBridgeAuto) continue;
    const qwPort = cfg.port || 8400;
    try {
      const res = await fetch(
        `http://127.0.0.1:${qwPort}/api/batch-progress?project=${encodeURIComponent(project.id)}`
      );
      if (!res.ok) continue;
      const bp = await res.json();
      const hasItems = bp.items && bp.items.length > 0;
      const prev = _bridgeBatchPrev.get(project.id);
      _bridgeBatchPrev.set(project.id, { complete: bp.complete, hasItems });

      if (bp && bp.complete) {
        if (hasTriggerAuto) {
          console.log(`[auto-trigger] ${project.id}: batch complete, auto-stopped (poller)`);
          stopTrigger(project.id);
          if (caffeinateProcess.process && triggers.size === 0) {
            try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
            caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
            console.log(`[auto-trigger] ${project.id}: caffeinate auto-stopped (no active triggers remain)`);
          }
        }
        // #518: also stop bridges when batch completes
        if (hasBridgeAuto) {
          await autoStopBridges(project.id, project, qwPort);
        }
      }

      // #518: detect batch-start transition → auto-start bridges
      if (hasBridgeAuto && hasItems && !bp.complete) {
        const isNewBatch = !prev || prev.complete || !prev.hasItems;
        if (isNewBatch) {
          await autoStartBridges(project.id, project, qwPort);
        }
      }
    } catch {
      // Non-fatal — retry on next tick
    }
  }
}

setInterval(autoStopPollingTick, AUTO_STOP_POLL_INTERVAL_MS);

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

// ---------------------------------------------------------------------------
// #416: AC health monitor — auto-restart AgentChattr on crash detection.
// Runs a TCP connect probe every 30s for each project with a "running" AC
// process. If the port is dead, auto-restarts (reusing the existing restart
// logic). Rate-limited to one restart per 60s per project; gives up after
// 3 consecutive failures and surfaces a persistent error.
// ---------------------------------------------------------------------------
const _acHealth = {
  // Per-project: { lastRestart: timestamp, consecutiveFailures: number }
  state: new Map(),
  intervalHandle: null,
};

function isPortAlive(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

async function acHealthCheck() {
  const cfg = readConfig();
  for (const project of (cfg.projects || [])) {
    const proc = chattrProcesses.get(project.id);
    // Only monitor projects that were explicitly started (state === "running"
    // or had a process). Skip intentionally stopped projects.
    if (!proc || proc.state === "stopped") continue;

    const { url } = resolveProjectChattr(project.id);
    const portMatch = url.match(/:(\d+)/);
    const port = portMatch ? parseInt(portMatch[1], 10) : 8300;

    const alive = await isPortAlive(port);
    const health = _acHealth.state.get(project.id) || { lastRestart: 0, consecutiveFailures: 0 };

    if (alive) {
      // Healthy — reset failure counter
      if (health.consecutiveFailures > 0) {
        console.log(`[health] AC for ${project.id} recovered (port ${port} alive)`);
      }
      health.consecutiveFailures = 0;
      _acHealth.state.set(project.id, health);
      continue;
    }

    // Port is dead — check rate limits
    if (health.consecutiveFailures >= 3) {
      // Already gave up — don't spam restarts. The error state persists
      // in chattrProcesses for the dashboard to surface.
      continue;
    }

    const now = Date.now();
    if (now - health.lastRestart < 60_000) {
      // Too soon since last restart attempt
      continue;
    }

    health.consecutiveFailures++;
    health.lastRestart = now;
    _acHealth.state.set(project.id, health);

    console.warn(`[health] AC for ${project.id} on port ${port} is down (failure ${health.consecutiveFailures}/3) — auto-restarting`);

    // Call the existing restart endpoint internally so we reuse the
    // hardened path (killProcessOnPort, waitForPortFree, snapshot,
    // auto-restore) instead of reimplementing spawn logic inline.
    try {
      const resp = await fetch(`http://127.0.0.1:${PORT}/api/agentchattr/${encodeURIComponent(project.id)}/restart`, {
        method: "POST",
        timeout: 15000,
      });
      if (resp.ok) {
        const data = await resp.json();
        console.log(`[health] AC for ${project.id} auto-restarted (PID: ${data.pid})`);
        // #447: agent reset is now chained inside the restart endpoint
        // itself (fires on a 2s timer), so no separate call needed here.
      } else {
        const body = await resp.text().catch(() => "");
        console.error(`[health] AC auto-restart failed for ${project.id}: ${resp.status} ${body.slice(0, 120)}`);
        chattrProcesses.set(project.id, { process: null, state: "error", error: `Auto-restart failed: ${resp.status}` });
      }
    } catch (err) {
      console.error(`[health] AC auto-restart failed for ${project.id}:`, err.message);
      chattrProcesses.set(project.id, { process: null, state: "error", error: `Auto-restart failed: ${err.message}` });
    }
  }
}

function startAcHealthMonitor() {
  if (_acHealth.intervalHandle) return;
  _acHealth.intervalHandle = setInterval(acHealthCheck, 30_000);
  console.log("[health] AC health monitor started (30s interval)");
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`QuadWork server listening on http://127.0.0.1:${PORT}`);
  syncTriggersFromConfig();
  // Sync AgentChattr tokens for all projects on startup and backfill
  // the sender-overflow CSS/JS patch (#402) so already-running AC
  // instances receive the fix without requiring a restart.
  // #448: retry after 5s for projects where AC isn't up yet at boot.
  const startupCfg = readConfig();
  for (const p of (startupCfg.projects || [])) {
    syncChattrToken(p.id).catch(() => {
      setTimeout(() => syncChattrToken(p.id).catch(() => {}), 5000);
    });
    const { dir: acDir } = resolveProjectChattr(p.id);
    if (acDir) patchAgentchattrCss(acDir);
  }
  // #457: migrate bridge slugs in AC configs on startup.
  // Renames [agents.discord-bridge] → [agents.dc] and
  // [agents.telegram-bridge] → [agents.tg] so bridges register
  // under the short slug. Restarts AC for projects whose config changed.
  for (const p of (startupCfg.projects || [])) {
    const acPath = projectAgentchattrConfigPath(p.id);
    if (!fs.existsSync(acPath)) continue;
    try {
      const before = fs.readFileSync(acPath, "utf-8");
      const dc = patchAgentchattrConfigForDiscordBridge(before);
      const tg = patchAgentchattrConfigForTelegramBridge(dc.text);
      if (dc.changed || tg.changed) {
        fs.writeFileSync(acPath, tg.text);
        console.log(`[bridge-migrate] ${p.id}: migrated AC config slugs`);
        // Restart AC so it loads the new agent slugs
        setTimeout(async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${PORT}/api/agentchattr/${encodeURIComponent(p.id)}/restart`, {
              method: "POST",
            });
            if (r.ok) console.log(`[bridge-migrate] ${p.id}: restarted AC`);
            else console.warn(`[bridge-migrate] ${p.id}: AC restart returned ${r.status}`);
          } catch (err) {
            console.warn(`[bridge-migrate] ${p.id}: AC restart failed: ${err.message || err}`);
          }
        }, 3000);
      }
    } catch {}
  }
  // #506: refresh Discord bridge script from the npm package on startup.
  // The Telegram bridge uses git-fetch + pin, but Discord uses a file-copy
  // pattern. Without this, upgrading QuadWork leaves a stale on-disk script
  // missing fixes shipped in newer versions.
  const DISCORD_BRIDGE_SRC = path.join(__dirname, "..", "bridges", "discord", "discord_bridge.py");
  const DISCORD_BRIDGE_DEST = path.join(os.homedir(), ".quadwork", "agentchattr-discord", "discord_bridge.py");
  if (fs.existsSync(DISCORD_BRIDGE_SRC) && fs.existsSync(path.dirname(DISCORD_BRIDGE_DEST))) {
    try {
      fs.copyFileSync(DISCORD_BRIDGE_SRC, DISCORD_BRIDGE_DEST);
      console.log("[bridge-refresh] refreshed Discord bridge script from package");
    } catch (err) {
      console.warn(`[bridge-refresh] failed to refresh Discord bridge script: ${err.message || err}`);
    }
  }
  // #470: patch stale bridge_sender defaults in on-disk bridge scripts.
  // The AC config migration (#457) renames the agent sections, but the
  // bridge scripts themselves may still have old defaults if the operator
  // upgraded QuadWork without re-installing the bridges.
  const BRIDGE_SLUG_PATCHES = [
    { file: path.join(os.homedir(), ".quadwork", "agentchattr-telegram", "telegram_bridge.py"), old: '"telegram-bridge"', replacement: '"tg"' },
    { file: path.join(os.homedir(), ".quadwork", "agentchattr-discord", "discord_bridge.py"), old: '"discord-bridge"', replacement: '"dc"' },
  ];
  for (const { file, old, replacement } of BRIDGE_SLUG_PATCHES) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf-8");
      if (!content.includes(old)) continue;
      fs.writeFileSync(file, content.replaceAll(old, replacement));
      console.log(`[bridge-migrate] patched stale bridge_sender in ${path.basename(file)}`);
    } catch {}
  }
  // #479: fix stale agent slugs in worktree AGENTS.md and CLAUDE.md on startup.
  // Uses in-place replacement (not full template overwrite) to preserve
  // reviewer auth credentials and other site-specific customisations.
  const SLUG_FIXES = [
    [/@reviewer1/g, "@re1"],
    [/@reviewer2/g, "@re2"],
    [/@t2a/g, "@re1"],
    [/@t2b/g, "@re2"],
    [/@t1\b/g, "@head"],
    [/@t3\b/g, "@dev"],
    [/\breviewer1\b/g, "re1"],
    [/\breviewer2\b/g, "re2"],
  ];
  for (const p of (startupCfg.projects || [])) {
    if (!p.agents) continue;
    for (const [agentId, agentCfg] of Object.entries(p.agents)) {
      const wtDir = agentCfg.cwd;
      if (!wtDir || !fs.existsSync(wtDir)) continue;
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
        const filePath = path.join(wtDir, filename);
        if (!fs.existsSync(filePath)) continue;
        try {
          let content = fs.readFileSync(filePath, "utf-8");
          let changed = false;
          for (const [pattern, replacement] of SLUG_FIXES) {
            const before = content;
            content = content.replace(pattern, replacement);
            if (content !== before) changed = true;
          }
          if (changed) {
            fs.writeFileSync(filePath, content);
            console.log(`[reseed] ${p.id}/${agentId}: fixed stale slugs in ${filename}`);
          }
        } catch (err) {
          console.warn(`[reseed] ${p.id}/${agentId}: failed to patch ${filename}: ${err.message}`);
        }
      }
    }
  }
  // #478 + #502: patch deployed AgentChattr instances to support force-replace
  // on register and fix idle-agent crash timeout.
  for (const p of (startupCfg.projects || [])) {
    const acDir = resolveProjectChattr(p.id).dir;
    // Patch registry.py: add force parameter to register()
    const regPath = path.join(acDir, "registry.py");
    if (fs.existsSync(regPath)) {
      try {
        let reg = fs.readFileSync(regPath, "utf-8");
        if (!reg.includes("force: bool")) {
          // Add force parameter to register() signature
          reg = reg.replace(
            /def register\(self, base: str, label: str \| None = None\) -> dict \| None:/,
            "def register(self, base: str, label: str | None = None, force: bool = False) -> dict | None:",
          );
          // Add force-replace logic after _expire_reserved()
          reg = reg.replace(
            "            self._expire_reserved()\n\n            # Find next free slot",
            "            self._expire_reserved()\n\n" +
            "            # quadwork#478 + #502: force-replace — expire all existing slots\n" +
            "            # for this base so the new registration always lands at slot 1.\n" +
            "            # Also clear _reserved entries: after a crash-timeout the old name\n" +
            "            # lives only in _reserved, so without this the grace period still\n" +
            "            # blocks slot 1 and the agent gets a -2 suffix.\n" +
            "            if force:\n" +
            "                ghosts = [n for n, i in self._instances.items() if i.base == base]\n" +
            "                for name in ghosts:\n" +
            "                    del self._instances[name]\n" +
            "                stale_reserved = [rn for rn in self._reserved\n" +
            "                                  if self._parse_name(rn)[0] == base]\n" +
            "                for rn in stale_reserved:\n" +
            "                    del self._reserved[rn]\n\n" +
            "            # Find next free slot",
          );
          fs.writeFileSync(regPath, reg);
          console.log(`[ghost-fix] ${p.id}: patched registry.py with force-replace support`);
        } else if (!reg.includes("stale_reserved")) {
          // #502: upgrade existing force-replace patch to also clear _reserved
          reg = reg.replace(
            /( +)for name in ghosts:\n\1    del self\._instances\[name\]\n\1    self\._reserved\[name\] = time\.time\(\)/,
            "$1for name in ghosts:\n$1    del self._instances[name]\n" +
            "$1stale_reserved = [rn for rn in self._reserved\n" +
            "$1                  if self._parse_name(rn)[0] == base]\n" +
            "$1for rn in stale_reserved:\n" +
            "$1    del self._reserved[rn]",
          );
          fs.writeFileSync(regPath, reg);
          console.log(`[ghost-fix] ${p.id}: upgraded registry.py force-replace to clear _reserved (#502)`);
        }
      } catch (err) {
        console.warn(`[ghost-fix] ${p.id}: failed to patch registry.py: ${err.message}`);
      }
    }
    // Patch app.py: pass force from request body to registry.register()
    const appPath = path.join(acDir, "app.py");
    if (fs.existsSync(appPath)) {
      try {
        let app = fs.readFileSync(appPath, "utf-8");
        if (!app.includes("force = bool(body.get(\"force\"")) {
          app = app.replace(
            "    result = registry.register(base, label)\n",
            "    force = bool(body.get(\"force\", False))\n    result = registry.register(base, label, force=force)\n",
          );
          fs.writeFileSync(appPath, app);
          console.log(`[ghost-fix] ${p.id}: patched app.py with force-replace support`);
        }
      } catch (err) {
        console.warn(`[ghost-fix] ${p.id}: failed to patch app.py: ${err.message}`);
      }
    }
    // #502: increase crash timeout from 15s to 120s for idle agent tolerance
    if (fs.existsSync(appPath)) {
      try {
        let app = fs.readFileSync(appPath, "utf-8");
        if (app.includes("_CRASH_TIMEOUT = 15")) {
          app = app.replace(
            "_CRASH_TIMEOUT = 15",
            "_CRASH_TIMEOUT = 120",
          );
          // Fix the misleading comment too
          app = app.replace(
            "# Crash timeout: if a wrapper hasn't heartbeated for 60s,\n",
            "# Crash timeout: if a wrapper hasn't heartbeated for 120s,\n",
          );
          fs.writeFileSync(appPath, app);
          console.log(`[idle-fix] ${p.id}: increased crash timeout to 120s (#502)`);
        }
      } catch (err) {
        console.warn(`[idle-fix] ${p.id}: failed to patch app.py crash timeout: ${err.message}`);
      }
    }
  }
  // #416: start the AC health monitor
  startAcHealthMonitor();
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
