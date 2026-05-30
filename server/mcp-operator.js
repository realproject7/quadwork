#!/usr/bin/env node
"use strict";

// #790: QuadWork MCP operator server. A stdio JSON-RPC server, spawned by the
// MCP client (Claude Code / Claude Desktop), NOT by QuadWork itself:
//
//   claude mcp add quadwork -- quadwork-mcp-operator --port 8400
//
// Operator-scoped: `project` is a per-tool argument, not a launch flag. The
// transport framing mirrors server/mcp-chat-shim.js. Tools live in
// mcp-operator/tools/*.js and are auto-merged by loadTools() — adding a new
// tool means adding a new file, never editing this one.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { createContext } = require("./mcp-operator/context");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const PORT = flag("port");
if (!PORT) {
  process.stderr.write("Usage: quadwork-mcp-operator --port <port>\n");
  process.exit(1);
}

const ctx = createContext(PORT);

// Tool-module loader: merge defs (for tools/list) + handlers (for dispatch)
// from every *.js under mcp-operator/tools/. Skips *.test.js.
function loadTools() {
  const toolsDir = path.join(__dirname, "mcp-operator", "tools");
  const defs = [];
  const handlers = {};
  for (const file of fs.readdirSync(toolsDir)) {
    if (!file.endsWith(".js") || file.endsWith(".test.js")) continue;
    const mod = require(path.join(toolsDir, file));
    if (Array.isArray(mod.defs)) defs.push(...mod.defs);
    if (mod.handlers) Object.assign(handlers, mod.handlers);
  }
  return { defs, handlers };
}

const { defs: TOOL_DEFS, handlers: TOOL_HANDLERS } = loadTools();

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

// Every tools/call is wrapped so a thrown/rejected handler becomes a JSON-RPC
// error — the stdio loop must never crash on a failed call.
async function handleToolCall(id, name, params) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
  try {
    const result = await handler(params || {}, ctx);
    return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (err) {
    return jsonRpcError(id, -32000, err.message);
  }
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "quadwork-operator", version: "1.0.0" },
    });
  }

  if (method === "initialized") {
    return null;
  }

  if (method === "tools/list") {
    return jsonRpc(id, { tools: TOOL_DEFS });
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
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(jsonRpcError(null, -32700, "Parse error") + "\n");
    return;
  }
  // Belt-and-braces: even an unexpected throw in dispatch is mapped to a
  // JSON-RPC error rather than killing the loop.
  let response;
  try {
    response = await handleMessage(msg);
  } catch (err) {
    response = jsonRpcError(msg && msg.id != null ? msg.id : null, -32000, err.message);
  }
  if (response) {
    process.stdout.write(response + "\n");
  }
});

rl.on("close", () => {
  process.exit(0);
});
