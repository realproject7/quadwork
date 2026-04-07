const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { spawn } = require("child_process");
const { readConfig, resolveAgentCwd, resolveAgentCommand, resolveProjectChattr, resolveChattrSpawn, syncChattrToken } = require("./config");
const routes = require("./routes");

const net = require("net");
const config = readConfig();
const PORT = config.port || 8400;

const app = express();
app.use(express.json());

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

  return new Promise((resolve, reject) => {
    const proxyServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1`);
      const targetUrl = `${upstreamUrl}${parsedUrl.pathname}${parsedUrl.search}`;
      const headers = { ...req.headers, host: new URL(upstreamUrl).host };
      if (token) {
        headers["authorization"] = `Bearer ${token}`;
        headers["x-agent-token"] = token;
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
      mcpProxies.set(key, { server: proxyServer, port });
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
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
  if (!project) return [];

  const agentCfg = project.agents?.[agentId] || {};
  const command = agentCfg.command || "claude";
  const cliBase = command.split("/").pop().split(" ")[0]; // extract base CLI name
  const args = [];

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
    if (injectMode === "flag") {
      // Claude/Kimi: write config file, pass --mcp-config
      const mcpConfigPath = writeMcpConfigFile(projectId, agentId, mcpHttpPort, token);
      const flag = agentCfg.mcp_flag || "--mcp-config";
      args.push(flag, mcpConfigPath);
    } else if (injectMode === "proxy_flag") {
      // Codex: start local auth proxy, pass proxy URL via -c flag
      const upstreamUrl = `http://127.0.0.1:${mcpHttpPort}`;
      const proxyUrl = await startMcpProxy(projectId, agentId, upstreamUrl, token);
      if (proxyUrl) {
        args.push("-c", `mcp_servers.agentchattr.url="${proxyUrl}"`);
      }
    }
  }

  return args;
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

// Helper: spawn a PTY for a project/agent and register in agentSessions
async function spawnAgentPty(project, agent) {
  const key = `${project}/${agent}`;

  const cwd = resolveAgentCwd(project, agent);
  if (!cwd) return { ok: false, error: `Unknown agent: ${key}` };

  const command = resolveAgentCommand(project, agent) || (process.env.SHELL || "/bin/zsh");
  const args = await buildAgentArgs(project, agent);
  const extraEnv = buildAgentEnv(project, agent);

  try {
    const term = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, ...extraEnv },
    });

    const session = { projectId: project, agentId: agent, term, ws: null, state: "running", error: null };
    agentSessions.set(key, session);

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
      }
    });

    return { ok: true, pid: term.pid };
  } catch (err) {
    agentSessions.set(key, { projectId: project, agentId: agent, term: null, ws: null, state: "error", error: err.message });
    return { ok: false, error: err.message };
  }
}

// Helper: stop an agent session — kill PTY, close WS
function stopAgentSession(key) {
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

      // Stop running process before pulling
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

app.post("/api/agents/:project/:agent/stop", (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;
  stopAgentSession(key);
  res.json({ ok: true, state: "stopped" });
});

// --- Lifecycle: restart ---

app.post("/api/agents/:project/:agent/restart", async (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;

  stopAgentSession(key);

  setTimeout(async () => {
    const result = await spawnAgentPty(project, agent);
    if (result.ok) {
      res.json({ ok: true, state: "running", pid: result.pid });
    } else {
      res.status(500).json({ ok: false, state: "error", error: result.error });
    }
  }, 500);
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
  const { url: chattrUrl, token: chattrToken } = resolveProjectChattr(projectId);
  const token = chattrToken || "";
  const message = (project && project.trigger_message) || DEFAULT_MESSAGE;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-session-token"] = token;

  const info = triggers.get(projectId);
  try {
    let tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const res = await fetch(`${chattrUrl}/api/send${tokenParam}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: message, channel: "general", sender: "user" }),
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
  for (const [id, info] of triggers) {
    result[id] = {
      enabled: true,
      interval: info.interval,
      lastSent: info.lastSent,
      nextAt: info.nextAt,
      lastError: info.lastError || null,
      expiresAt: info.expiresAt || null,
    };
  }
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
  const { interval, duration } = req.body || {};
  const ms = (interval || 30) * 60 * 1000;
  const durationMs = duration ? duration * 60 * 1000 : 0; // duration in minutes, 0 = indefinite

  const existing = triggers.get(project);
  if (existing) {
    if (existing.timer) clearInterval(existing.timer);
    if (existing.durationTimer) clearTimeout(existing.durationTimer);
  }

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
