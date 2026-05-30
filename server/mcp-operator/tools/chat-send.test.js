"use strict";

// #792: tests for send_message. Fake backend records the POST body + headers so
// we can prove (a) NO sender header is sent (message records as "user"), and
// (b) an unknown project throws before any POST (no orphan chat file).

const http = require("http");
const { createContext } = require("../context");
const chatSend = require("./chat-send");

const handlers = chatSend.handlers;

const FAKE_CONFIG = {
  projects: [{ id: "plotlink", name: "PlotLink", repo: "realproject7/plotlink", agents: { head: {}, dev: {} } }],
};

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// Records each request: method, url, headers, parsed body. The POST handler
// mimics /api/chat — defaults sender to "user" unless an x-chat-sender header
// is present — so the test asserts on the same logic the real server uses.
function startServer() {
  const requests = [];
  let nextId = 41;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed;
        try {
          parsed = body ? JSON.parse(body) : undefined;
        } catch {
          parsed = undefined;
        }
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
        const send = (obj, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (req.method === "GET" && req.url.startsWith("/api/config")) return send(FAKE_CONFIG);
        if (req.method === "POST" && req.url.startsWith("/api/chat")) {
          const text = parsed && typeof parsed.text === "string" ? parsed.text : "";
          if (!text) return send({ error: "text required" }, 400);
          const sender = req.headers["x-chat-sender"] || req.headers["x-bridge-sender"] || "user";
          return send({
            ok: true,
            message: { id: ++nextId, sender, text, channel: "general", type: "message", ts: "2026-05-30T00:00:00.000Z" },
          });
        }
        return send({ error: "not found" }, 404);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

async function expectThrows(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function runTests() {
  console.log("\n--- MCP Operator send_message Tests (#792) ---\n");

  const { server, port, requests } = await startServer();
  const ctx = createContext(port);

  // ── send_message: known project ─────────────────────────────────────────
  requests.length = 0;
  const msg = await handlers.send_message({ project: "plotlink", text: "@head start the batch" }, ctx);
  assert(msg && typeof msg.id === "number", "send_message returns the created message with an assigned id");
  assert(msg.sender === "user", "send_message records the message as sender 'user' (operator)");
  assert(msg.text === "@head start the batch", "send_message surfaces the posted text");

  const post = requests.find((r) => r.method === "POST" && r.url.startsWith("/api/chat"));
  assert(post != null, "send_message POSTs to /api/chat");
  assert(post.url.includes("project=plotlink"), "send_message scopes the POST to the project");
  assert(post.body && post.body.text === "@head start the batch", "POST body carries { text }");
  assert(
    !("x-chat-sender" in post.headers) && !("x-bridge-sender" in post.headers),
    "send_message sends NO x-chat-sender / x-bridge-sender header (so it posts as user)"
  );

  // ── send_message: unknown project → error, NO POST ──────────────────────
  requests.length = 0;
  const badErr = await expectThrows(() => handlers.send_message({ project: "ghost", text: "hi" }, ctx));
  assert(
    badErr && badErr.message === "Unknown project: ghost. Use list_projects to see valid ids.",
    "send_message on unknown project throws the clean error"
  );
  assert(!requests.some((r) => r.method === "POST"), "send_message unknown project makes NO POST (no orphan chat file)");

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
