const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { readConfig, resolveAgentCwd } = require("./config");

const config = readConfig();
const PORT = config.port || 3001;

const app = express();
const server = http.createServer(app);

// --- REST endpoints ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/config", (_req, res) => {
  const cfg = readConfig();
  res.json(cfg);
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
    term.kill();
  });
});

// --- Start ---

server.listen(PORT, () => {
  console.log(`QuadWork server listening on http://localhost:${PORT}`);
});
