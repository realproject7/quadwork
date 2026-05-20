"use strict";

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { ensureSecureDir } = require("./config");
const fileChat = require("./file-chat");

const crypto = require("crypto");

const PROJECT = "__mcp_shim_test__";
const AGENT = "test-agent";
const TEST_TOKEN = crypto.randomBytes(16).toString("hex");
const SHIM = path.join(__dirname, "mcp-chat-shim.js");

let server;
let serverPort;

function sendJsonRpc(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function readResponse(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for response")), 5000);
    const handler = (data) => {
      clearTimeout(timeout);
      proc.stdout.removeListener("data", handler);
      try {
        resolve(JSON.parse(data.toString().trim().split("\n").pop()));
      } catch (e) {
        reject(e);
      }
    };
    proc.stdout.on("data", handler);
  });
}

function startTestServer() {
  return new Promise((resolve) => {
    const express = require("express");
    const app = express();
    app.use(express.json());

    app.get("/api/chat", (req, res) => {
      const msgs = fileChat.readMessages(PROJECT, {
        since_id: Number(req.query.since_id) || 0,
        limit: Number(req.query.limit) || 50,
      });
      res.json(msgs);
    });

    app.post("/api/chat", (req, res) => {
      const shimSender = req.headers["x-chat-sender"];
      const shimToken = req.headers["x-chat-token"];
      let sender = "user";
      if (shimSender && shimToken) {
        if (!fileChat.validateShimToken(PROJECT, shimSender, shimToken)) {
          return res.status(403).json({ error: "Invalid shim token" });
        }
        sender = shimSender;
      }
      const msg = fileChat.appendMessage(PROJECT, {
        sender,
        text: req.body.text || "",
        channel: req.body.channel || "general",
        type: "message",
      });
      res.json({ ok: true, message: msg });
    });

    server = app.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      passed++;
      console.log(`  PASS: ${msg}`);
    } else {
      failed++;
      console.error(`  FAIL: ${msg}`);
    }
  }

  // Setup
  fileChat.initProject(PROJECT);
  fileChat.registerShimToken(PROJECT, AGENT, TEST_TOKEN);
  await startTestServer();

  const shim = spawn("node", [SHIM, "--project", PROJECT, "--agent", AGENT, "--port", String(serverPort), "--token", TEST_TOKEN], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  shim.stderr.on("data", (d) => process.stderr.write(`[shim stderr] ${d}`));

  // Test 1: initialize
  console.log("\n--- MCP Shim Conformance Tests ---\n");
  sendJsonRpc(shim, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const initResp = await readResponse(shim);
  assert(initResp.result?.protocolVersion === "2024-11-05", "initialize returns protocol version");
  assert(initResp.result?.capabilities?.tools != null, "initialize returns tools capability");

  // Send initialized notification
  sendJsonRpc(shim, { jsonrpc: "2.0", method: "initialized" });
  await new Promise((r) => setTimeout(r, 100));

  // Test 2: tools/list
  sendJsonRpc(shim, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listResp = await readResponse(shim);
  const toolNames = (listResp.result?.tools || []).map((t) => t.name);
  assert(toolNames.includes("chat_send"), "tools/list includes chat_send");
  assert(toolNames.includes("chat_read"), "tools/list includes chat_read");

  // Test 3: chat_send
  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "chat_send", arguments: { message: "hello from shim @user" } },
  });
  const sendResp = await readResponse(shim);
  assert(sendResp.result?.content?.[0]?.type === "text", "chat_send returns text content");
  const sendBody = JSON.parse(sendResp.result.content[0].text);
  assert(sendBody.ok === true, "chat_send returns ok: true");
  assert(sendBody.message?.sender === AGENT, "chat_send uses agent sender from X-Chat-Sender header");

  // Test 4: chat_read
  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "chat_read", arguments: {} },
  });
  const readResp = await readResponse(shim);
  assert(readResp.result?.content?.[0]?.type === "text", "chat_read returns text content");
  const messages = JSON.parse(readResp.result.content[0].text);
  assert(Array.isArray(messages), "chat_read returns array");
  assert(messages.length >= 1, "chat_read contains the sent message");
  assert(messages[messages.length - 1]?.text === "hello from shim @user", "chat_read message text matches");

  // Test 5: chat_read with since_id
  const lastId = messages[messages.length - 1].id;
  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "chat_send", arguments: { message: "second message" } },
  });
  await readResponse(shim);

  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "chat_read", arguments: { since_id: lastId } },
  });
  const sinceResp = await readResponse(shim);
  const sinceMessages = JSON.parse(sinceResp.result.content[0].text);
  assert(sinceMessages.length === 1, "chat_read with since_id returns only new messages");
  assert(sinceMessages[0]?.text === "second message", "since_id filtered message matches");

  // Test 6: ping
  sendJsonRpc(shim, { jsonrpc: "2.0", id: 7, method: "ping" });
  const pingResp = await readResponse(shim);
  assert(pingResp.id === 7 && pingResp.result != null, "ping responds");

  // Cleanup
  shim.stdin.end();
  await new Promise((r) => shim.on("close", r));
  server.close();
  fileChat.shutdownProject(PROJECT);

  // Clean up test files
  const testDir = path.join(os.homedir(), ".quadwork", PROJECT);
  try { fs.rmSync(testDir, { recursive: true }); } catch {}

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
