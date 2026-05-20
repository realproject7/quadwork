#!/usr/bin/env node
"use strict";

const http = require("http");
const readline = require("readline");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const PROJECT = flag("project");
const AGENT = flag("agent");
const PORT = flag("port");
const TOKEN = flag("token");

if (!PROJECT || !AGENT || !PORT) {
  process.stderr.write("Usage: node mcp-chat-shim.js --project <id> --agent <id> --port <port> [--token <token>]\n");
  process.exit(1);
}

const BASE = `http://127.0.0.1:${PORT}`;

const TOOLS = [
  {
    name: "chat_send",
    description: "Send a message to the project chat",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", default: "general" },
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
  {
    name: "chat_read",
    description: "Read recent messages from project chat",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", default: "general" },
        limit: { type: "number", default: 50 },
        since_id: { type: "number" },
      },
    },
  },
];

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function httpRequest(method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function handleToolCall(id, name, params) {
  try {
    if (name === "chat_send") {
      const res = await httpRequest("POST", `/api/chat?project=${encodeURIComponent(PROJECT)}`, {
        text: params.message || "",
        channel: params.channel || "general",
      }, { "X-Chat-Sender": AGENT, ...(TOKEN ? { "X-Chat-Token": TOKEN } : {}) });
      if (res.status >= 400) {
        return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      }
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(res.body) }] });
    }

    if (name === "chat_read") {
      const qs = new URLSearchParams({ project: PROJECT });
      if (params.channel) qs.set("channel", params.channel);
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.since_id) qs.set("since_id", String(params.since_id));
      const res = await httpRequest("GET", `/api/chat?${qs.toString()}`);
      if (res.status >= 400) {
        return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      }
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(res.body) }] });
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
  } catch (err) {
    return jsonRpcError(id, -32000, err.message);
  }
}

// --- MCP stdio protocol ---

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "quadwork-chat", version: "1.0.0" },
    });
  }

  if (method === "initialized") {
    return null;
  }

  if (method === "tools/list") {
    return jsonRpc(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    return handleToolCall(id, params?.name, params?.arguments || {});
  }

  if (method === "ping") {
    return jsonRpc(id, {});
  }

  if (id != null) {
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
  return null;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(jsonRpcError(null, -32700, "Parse error") + "\n");
    return;
  }
  const response = await handleMessage(msg);
  if (response) {
    process.stdout.write(response + "\n");
  }
});

rl.on("close", () => {
  process.exit(0);
});
