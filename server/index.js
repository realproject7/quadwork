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

// --- REST endpoints ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Unified agent sessions ---
// Single map: key = "project/agent" → { projectId, agentId, term, ws, state, error }
// PTY (term) is the source of truth for "running". WS is optional (attaches to view terminal).
const agentSessions = new Map();

// AgentChattr server process (separate — not a PTY agent)
let chattrProcess = { process: null, state: "stopped", error: null };

// Helper: spawn a PTY for a project/agent and register in agentSessions
function spawnAgentPty(project, agent) {
  const key = `${project}/${agent}`;

  const cwd = resolveAgentCwd(project, agent);
  if (!cwd) return { ok: false, error: `Unknown agent: ${key}` };

  const command = resolveAgentCommand(project, agent) || (process.env.SHELL || "/bin/zsh");

  try {
    const term = pty.spawn(command, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: process.env,
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
}

app.get("/api/agents", (_req, res) => {
  const agents = {};
  for (const [key, session] of agentSessions) {
    agents[key] = { state: session.state, error: session.error || null };
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

// --- Lifecycle: start spawns PTY (visible in terminal panel) ---

app.post("/api/agents/:project/:agent/start", (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;

  const existing = agentSessions.get(key);
  if (existing && existing.state === "running" && existing.term) {
    return res.json({ ok: true, state: "running", message: "Already running" });
  }

  const result = spawnAgentPty(project, agent);
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

app.post("/api/agents/:project/:agent/restart", (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;

  stopAgentSession(key);

  setTimeout(() => {
    const result = spawnAgentPty(project, agent);
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

// SPA fallback: serve the correct pre-rendered HTML for dynamic routes.
// Static export only generates templates for placeholder params (e.g. /project/_),
// so we map real dynamic segments back to those template files.
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) {
    return next();
  }

  // Map dynamic routes to their pre-rendered template HTML
  const dynamicRoutes = [
    { pattern: /^\/project\/[^/]+\/memory\/?$/, template: "project/_/memory.html" },
    { pattern: /^\/project\/[^/]+\/queue\/?$/, template: "project/_/queue.html" },
    { pattern: /^\/project\/[^/]+\/?$/, template: "project/_.html" },
  ];

  for (const route of dynamicRoutes) {
    if (route.pattern.test(req.path)) {
      const templatePath = path.join(outDir, route.template);
      if (fs.existsSync(templatePath)) {
        return res.sendFile(templatePath);
      }
    }
  }

  // Default fallback to index.html
  const indexPath = path.join(outDir, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(503).send("Frontend not built. Run: npm run build");
  }
});

// --- WebSocket + PTY ---
// WS connects to an existing PTY session (started via lifecycle API)
// or spawns a new one if none exists.

const wss = new WebSocketServer({ server, path: "/ws/terminal" });

wss.on("connection", (ws, req) => {
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
    const result = spawnAgentPty(projectId, agentId);
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
      triggers.delete(id);
    }
  }
}

// --- Start ---

server.listen(PORT, "127.0.0.1", () => {
  console.log(`QuadWork server listening on http://127.0.0.1:${PORT}`);
  syncTriggersFromConfig();
});
