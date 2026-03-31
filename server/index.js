const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { spawn } = require("child_process");
const { readConfig, resolveAgentCwd } = require("./config");

const config = readConfig();
const PORT = config.port || 3001;

const app = express();
app.use(express.json());
const server = http.createServer(app);

// --- REST endpoints ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/config", (_req, res) => {
  const cfg = readConfig();
  res.json(cfg);
});

// --- Agent lifecycle ---

// In-memory process state: key = "project/agent" → { process, state, error }
const agentProcesses = new Map();

// AgentChattr server process
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

  // Stop first
  if (info && info.process) {
    try { info.process.kill("SIGTERM"); } catch {}
  }
  agentProcesses.set(key, { process: null, state: "stopped", error: null });

  // Then start (delegate to start handler by forwarding)
  req.params.project = project;
  req.params.agent = agent;
  // Small delay to let process die
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

const activeSessions = new Map(); // key: "project/agent" → { projectId, agentId }

app.get("/api/sessions", (_req, res) => {
  const sessions = [];
  for (const [, info] of activeSessions) {
    sessions.push(info);
  }
  res.json(sessions);
});

// Write to an active PTY session
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

const triggers = new Map(); // projectId → { interval, timer, lastSent, nextAt }

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
    // Try with session token header
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

  // Clear existing
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

// --- WebSocket + PTY ---

const wss = new WebSocketServer({ server, path: "/ws/terminal" });

wss.on("connection", (ws, req) => {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const projectId = params.get("project");
  const agentId = params.get("agent");
  const shell = process.env.SHELL || "/bin/zsh";

  if (!projectId || !agentId) {
    ws.close(1008, "missing project or agent query params");
    return;
  }

  const cwd = resolveAgentCwd(projectId, agentId);
  if (!cwd) {
    ws.close(1008, `unknown project/agent: ${projectId}/${agentId}`);
    return;
  }

  const sessionKey = `${projectId}/${agentId}`;

  let term;
  try {
    term = pty.spawn(shell, [], {
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

  // Register session only after successful PTY spawn (include term for write access)
  activeSessions.set(sessionKey, { projectId, agentId, term });

  // PTY → client
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

  // Client → PTY
  ws.on("message", (msg) => {
    const str = msg.toString();

    // Handle resize messages: JSON { type: "resize", cols, rows }
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        term.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON — treat as terminal input
    }

    term.write(str);
  });

  ws.on("close", () => {
    activeSessions.delete(sessionKey);
    term.kill();
  });
});

// --- Start ---

server.listen(PORT, () => {
  console.log(`QuadWork server listening on http://localhost:${PORT}`);
});
