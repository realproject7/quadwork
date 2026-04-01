const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { spawn } = require("child_process");
const { readConfig, resolveAgentCwd, resolveAgentCommand } = require("./config");
const routes = require("./routes");

const config = readConfig();
const PORT = config.port || 8400;

const app = express();
app.use(express.json());

// --- Mount migrated API routes (from Next.js) ---
app.use(routes);

const server = http.createServer(app);

// --- REST endpoints (original backend) ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Agent lifecycle ---

const agentProcesses = new Map();
let chattrProcess = { process: null, state: "stopped", error: null };

app.get("/api/agents", (_req, res) => {
  const agents = {};
  for (const [key, info] of agentProcesses) {
    agents[key] = { state: info.state, error: info.error || null };
  }
  agents["_agentchattr"] = { state: chattrProcess.state, error: chattrProcess.error };
  res.json(agents);
});

app.post("/api/agentchattr/:action", (req, res) => {
  const { action } = req.params;
  const cfg = readConfig();
  const chattrUrl = cfg.agentchattr_url || "http://127.0.0.1:8300";
  const chattrPort = new URL(chattrUrl).port || "8300";

  if (action === "start") {
    if (chattrProcess.state === "running" && chattrProcess.process) {
      return res.json({ ok: true, state: "running", message: "Already running" });
    }
    try {
      const child = spawn("agentchattr", ["--port", chattrPort], {
        env: process.env,
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.on("error", (err) => {
        chattrProcess = { process: null, state: "error", error: err.message };
      });
      child.on("exit", (code) => {
        if (chattrProcess.process === child) {
          chattrProcess = { process: null, state: "stopped", error: code ? `exit:${code}` : null };
        }
      });
      chattrProcess = { process: child, state: "running", error: null };
      res.json({ ok: true, state: "running", pid: child.pid });
    } catch (err) {
      chattrProcess = { process: null, state: "error", error: err.message };
      res.status(500).json({ ok: false, state: "error", error: err.message });
    }
  } else if (action === "stop") {
    if (chattrProcess.process) {
      try { chattrProcess.process.kill("SIGTERM"); } catch {}
    }
    chattrProcess = { process: null, state: "stopped", error: null };
    res.json({ ok: true, state: "stopped" });
  } else if (action === "restart") {
    if (chattrProcess.process) {
      try { chattrProcess.process.kill("SIGTERM"); } catch {}
    }
    chattrProcess = { process: null, state: "stopped", error: null };
    setTimeout(() => {
      try {
        const child = spawn("agentchattr", ["--port", chattrPort], {
          env: process.env,
          stdio: "ignore",
          detached: true,
        });
        child.unref();
        child.on("error", (err) => {
          chattrProcess = { process: null, state: "error", error: err.message };
        });
        child.on("exit", (code) => {
          if (chattrProcess.process === child) {
            chattrProcess = { process: null, state: "stopped", error: code ? `exit:${code}` : null };
          }
        });
        chattrProcess = { process: child, state: "running", error: null };
        res.json({ ok: true, state: "running", pid: child.pid });
      } catch (err) {
        chattrProcess = { process: null, state: "error", error: err.message };
        res.status(500).json({ ok: false, state: "error", error: err.message });
      }
    }, 500);
  } else {
    res.status(400).json({ error: "Unknown action" });
  }
});

app.post("/api/agents/:project/:agent/start", (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;

  if (agentProcesses.has(key) && agentProcesses.get(key).state === "running") {
    return res.json({ ok: true, state: "running", message: "Already running" });
  }

  const cfg = readConfig();
  const proj = cfg.projects && cfg.projects.find((p) => p.id === project);
  if (!proj || !proj.agents || !proj.agents[agent]) {
    return res.status(400).json({ ok: false, error: `Unknown agent: ${key}` });
  }

  const agentCfg = proj.agents[agent];
  const cwd = agentCfg.cwd || proj.working_dir || process.env.HOME;
  const command = agentCfg.command || "claude";

  try {
    const child = spawn(command, [], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    child.on("error", (err) => {
      agentProcesses.set(key, { process: null, state: "error", error: err.message });
    });

    child.on("exit", (code) => {
      const existing = agentProcesses.get(key);
      if (existing && existing.process === child) {
        agentProcesses.set(key, { process: null, state: "stopped", error: code ? `exit:${code}` : null });
      }
    });

    agentProcesses.set(key, { process: child, state: "running", error: null });
    res.json({ ok: true, state: "running", pid: child.pid });
  } catch (err) {
    agentProcesses.set(key, { process: null, state: "error", error: err.message });
    res.status(500).json({ ok: false, state: "error", error: err.message });
  }
});

app.post("/api/agents/:project/:agent/stop", (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;
  const info = agentProcesses.get(key);

  if (!info || !info.process) {
    agentProcesses.set(key, { process: null, state: "stopped", error: null });
    return res.json({ ok: true, state: "stopped" });
  }

  try {
    info.process.kill("SIGTERM");
    agentProcesses.set(key, { process: null, state: "stopped", error: null });
    res.json({ ok: true, state: "stopped" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/agents/:project/:agent/restart", (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;
  const info = agentProcesses.get(key);

  if (info && info.process) {
    try { info.process.kill("SIGTERM"); } catch {}
  }
  agentProcesses.set(key, { process: null, state: "stopped", error: null });

  setTimeout(() => {
    const cfg = readConfig();
    const proj = cfg.projects && cfg.projects.find((p) => p.id === project);
    if (!proj || !proj.agents || !proj.agents[agent]) {
      return res.status(400).json({ ok: false, error: `Unknown agent: ${key}` });
    }
    const agentCfg = proj.agents[agent];
    const cwd = agentCfg.cwd || proj.working_dir || process.env.HOME;
    const command = agentCfg.command || "claude";

    try {
      const child = spawn(command, [], {
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.on("error", (err) => {
        agentProcesses.set(key, { process: null, state: "error", error: err.message });
      });
      child.on("exit", (code) => {
        const existing = agentProcesses.get(key);
        if (existing && existing.process === child) {
          agentProcesses.set(key, { process: null, state: "stopped", error: code ? `exit:${code}` : null });
        }
      });
      agentProcesses.set(key, { process: child, state: "running", error: null });
      res.json({ ok: true, state: "running", pid: child.pid });
    } catch (err) {
      agentProcesses.set(key, { process: null, state: "error", error: err.message });
      res.status(500).json({ ok: false, state: "error", error: err.message });
    }
  }, 500);
});

// --- Active sessions tracking ---

const activeSessions = new Map();

// Expose activeSessions to migrated routes (for /api/projects)
app.set("activeSessions", activeSessions);

app.get("/api/sessions", (_req, res) => {
  const sessions = [];
  for (const [, info] of activeSessions) {
    sessions.push({ projectId: info.projectId, agentId: info.agentId });
  }
  res.json(sessions);
});

app.post("/api/agents/:project/:agent/write", (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;
  const session = activeSessions.get(key);

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

const DEFAULT_MESSAGE = `@t1 @t2a @t2b @t3 — Queue check.
T1: Merge any PR with both approvals, assign next from queue.
T3: Work on assigned ticket or address review feedback.
T2a/T2b: Review open PRs. If T3 pushed fixes, re-review. Post verdict on PR AND notify here.
ALL: Communicate via this chat by tagging agents. Your terminal is NOT visible.`;

async function sendTriggerMessage(projectId) {
  const cfg = readConfig();
  const project = cfg.projects && cfg.projects.find((p) => p.id === projectId);
  const chattrUrl = cfg.agentchattr_url || "http://127.0.0.1:8300";
  const token = cfg.agentchattr_token || "";
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
    };
  }
  res.json(result);
});

app.post("/api/triggers/:project/start", (req, res) => {
  const { project } = req.params;
  const { interval } = req.body || {};
  const ms = (interval || 30) * 60 * 1000;

  const existing = triggers.get(project);
  if (existing && existing.timer) clearInterval(existing.timer);

  const timer = setInterval(() => sendTriggerMessage(project), ms);
  triggers.set(project, { interval: ms, timer, lastSent: null, nextAt: Date.now() + ms });
  res.json({ ok: true, enabled: true, interval: ms, nextAt: Date.now() + ms });
});

app.post("/api/triggers/:project/stop", (req, res) => {
  const { project } = req.params;
  const existing = triggers.get(project);
  if (existing && existing.timer) clearInterval(existing.timer);
  triggers.delete(project);
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

// --- Serve static frontend (built Next.js export) ---

const outDir = path.join(__dirname, "..", "out");
if (fs.existsSync(outDir)) {
  app.use(express.static(outDir));
}

// SPA fallback: serve index.html for all non-API, non-WS routes
app.get("*", (req, res) => {
  // Don't intercept API routes (already handled above)
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  const indexPath = path.join(outDir, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(503).send("Frontend not built. Run: npm run build");
  }
});

// --- WebSocket + PTY ---

const wss = new WebSocketServer({ server, path: "/ws/terminal" });

wss.on("connection", (ws, req) => {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const projectId = params.get("project");
  const agentId = params.get("agent");
  const defaultShell = process.env.SHELL || "/bin/zsh";

  if (!projectId || !agentId) {
    ws.close(1008, "missing project or agent query params");
    return;
  }

  const cwd = resolveAgentCwd(projectId, agentId);
  if (!cwd) {
    ws.close(1008, `unknown project/agent: ${projectId}/${agentId}`);
    return;
  }

  const command = resolveAgentCommand(projectId, agentId) || defaultShell;
  const sessionKey = `${projectId}/${agentId}`;

  let term;
  try {
    term = pty.spawn(command, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: process.env,
    });
  } catch (err) {
    console.error("Failed to spawn PTY:", err.message);
    ws.close(1011, "pty-spawn-failed");
    return;
  }

  activeSessions.set(sessionKey, { projectId, agentId, term });

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, `exited:${exitCode}`);
    }
  });

  ws.on("message", (msg) => {
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        term.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {}
    term.write(str);
  });

  ws.on("close", () => {
    activeSessions.delete(sessionKey);
    term.kill();
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
      triggers.delete(id);
    }
  }
}

// --- Start ---

server.listen(PORT, "127.0.0.1", () => {
  console.log(`QuadWork server listening on http://127.0.0.1:${PORT}`);
  syncTriggersFromConfig();
});
