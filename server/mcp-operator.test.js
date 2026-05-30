"use strict";

// #790: tests for the MCP operator scaffold.
//   1. list_projects over stdio proxies GET /api/config → { id, name, repo }
//      only (the internal `agents` id list is stripped from public output).
//   2. httpRequest maps ECONNREFUSED and a timeout to clean errors.
//   3. assertKnownProject / assertKnownAgent pass known ids and throw the
//      clean error for unknown ones — with no further (tool) HTTP call.

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const { createContext } = require("./mcp-operator/context");

const OPERATOR = path.join(__dirname, "mcp-operator.js");

// Config the fake backend serves. `agents` is an OBJECT (mirrors the real
// config.json) with per-agent fields that MUST NOT leak through the tools.
const FAKE_CONFIG = {
  projects: [
    {
      id: "plotlink",
      name: "PlotLink",
      repo: "realproject7/plotlink",
      agents: {
        head: { model: "claude-opus-4-8", token: "secret-head" },
        dev: { model: "claude-opus-4-8" },
        re1: {},
        re2: {},
      },
      extraField: "should-not-leak",
    },
    {
      id: "quadwork",
      name: "QuadWork",
      repo: "realproject7/quadwork",
      agents: { head: {}, dev: {}, re1: {}, re2: {} },
    },
  ],
  operator_name: "tester",
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

// A fake QuadWork backend that records every request path so we can prove
// validation short-circuits before any tool HTTP call.
function startConfigServer() {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === "GET" && req.url.startsWith("/api/config")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(FAKE_CONFIG));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

// A server that accepts the connection but never responds — to exercise the
// httpRequest timeout path quickly.
function startBlackholeServer() {
  return new Promise((resolve) => {
    const server = http.createServer(() => {
      /* never respond */
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function sendJsonRpc(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

// #796: a fake QuadWork that serves every endpoint the tools hit and records
// { method, path, url, headers } per request — for the consolidated table-driven
// cross-tool pass below.
function startFullServer() {
  const requests = [];
  const CONFIG = { projects: [{ id: "p", name: "P", repo: "o/r", agents: { dev: {} } }] };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const pathOnly = req.url.split("?")[0];
        requests.push({ method: req.method, path: pathOnly, url: req.url, headers: req.headers });
        const send = (obj, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (req.method === "GET" && pathOnly === "/api/config") return send(CONFIG);
        if (pathOnly === "/api/chat") return req.method === "GET" ? send([]) : send({ ok: true, message: { id: 1, sender: "user" } });
        if (pathOnly === "/api/batch-active") return send({ active: false });
        if (pathOnly === "/api/batch-progress") return send({ items: [] });
        if (pathOnly === "/api/queue") {
          if (req.method === "GET") return send({ ok: true, exists: true, content: "x" });
          if (req.method === "PUT") return send({ ok: true });
          if (req.method === "POST") return send({ ok: true, existed: true });
        }
        if (req.method === "GET" && pathOnly === "/api/agents") return send({});
        if (req.method === "POST" && /^\/api\/triggers\/[^/]+\/start$/.test(pathOnly)) return send({ ok: true, enabled: true });
        if (req.method === "POST" && /^\/api\/triggers\/[^/]+\/send-now$/.test(pathOnly)) return send({ ok: true, sent: true });
        if (req.method === "POST" && /^\/api\/triggers\/[^/]+\/stop$/.test(pathOnly)) return send({ ok: true, enabled: false });
        if (req.method === "POST" && /^\/api\/agents\/[^/]+\/interrupt-all$/.test(pathOnly)) return send({ ok: true, interrupted: 0 });
        if (req.method === "POST" && /^\/api\/agents\/[^/]+\/[^/]+\/(start|stop|restart|interrupt)$/.test(pathOnly)) return send({ ok: true, state: "running" });
        return send({ error: "not found" }, 404);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

// #796: serve a fixed status + body for the error-mapping cases.
function startStatusServer(status, body, contentType = "application/json") {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": contentType });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
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

async function expectThrows(fn, label) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  } finally {
    void label;
  }
}

async function runTests() {
  console.log("\n--- MCP Operator Scaffold Tests (#790) ---\n");

  // ── 1. list_projects end-to-end over stdio ──────────────────────────────
  const { server: cfgServer, port: cfgPort, requests } = await startConfigServer();

  const op = spawn("node", [OPERATOR, "--port", String(cfgPort)], { stdio: ["pipe", "pipe", "pipe"] });
  op.stderr.on("data", (d) => process.stderr.write(`[operator stderr] ${d}`));

  sendJsonRpc(op, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const initResp = await readResponse(op);
  assert(initResp.result?.protocolVersion === "2024-11-05", "initialize returns protocol version");
  assert(initResp.result?.serverInfo?.name === "quadwork-operator", "initialize identifies as quadwork-operator");

  sendJsonRpc(op, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listResp = await readResponse(op);
  const toolNames = (listResp.result?.tools || []).map((t) => t.name);
  assert(toolNames.includes("list_projects"), "tools/list includes list_projects");

  sendJsonRpc(op, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_projects", arguments: {} },
  });
  const callResp = await readResponse(op);
  assert(callResp.result?.content?.[0]?.type === "text", "list_projects returns text content");
  const projects = JSON.parse(callResp.result.content[0].text);
  assert(Array.isArray(projects) && projects.length === 2, "list_projects returns both projects");
  assert(projects[0].id === "plotlink" && projects[0].repo === "realproject7/plotlink", "list_projects id/repo correct");
  const keys = Object.keys(projects[0]).sort().join(",");
  assert(keys === "id,name,repo", `list_projects returns only id/name/repo (got ${keys})`);
  assert(!("agents" in projects[0]) && !("extraField" in projects[0]), "list_projects strips agents + extra fields");
  assert(requests.some((r) => r.startsWith("GET /api/config")), "list_projects proxied GET /api/config");

  // ── 2. unknown tool → JSON-RPC error, loop survives ─────────────────────
  sendJsonRpc(op, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "does_not_exist", arguments: {} },
  });
  const errResp = await readResponse(op);
  assert(errResp.error != null, "unknown tool returns a JSON-RPC error");
  // Loop must still be alive after the error:
  sendJsonRpc(op, { jsonrpc: "2.0", id: 5, method: "ping" });
  const pingResp = await readResponse(op);
  assert(pingResp.id === 5 && pingResp.result != null, "stdio loop survives a failed call (ping after error)");

  op.stdin.end();
  await new Promise((r) => op.on("close", r));
  cfgServer.close();

  // ── 3. httpRequest: ECONNREFUSED ────────────────────────────────────────
  // Open then immediately close a server to get a definitely-closed port.
  const { server: deadServer, port: deadPort } = await startBlackholeServer();
  await new Promise((r) => deadServer.close(r));
  const refusedCtx = createContext(deadPort);
  const refusedErr = await expectThrows(() => refusedCtx.httpRequest("GET", "/api/config"));
  assert(
    refusedErr && refusedErr.message === `QuadWork is not running on port ${deadPort}. Start it first.`,
    "httpRequest maps ECONNREFUSED to a clean error"
  );

  // ── 4. httpRequest: timeout ─────────────────────────────────────────────
  const { server: blackhole, port: bhPort } = await startBlackholeServer();
  const timeoutCtx = createContext(bhPort, { timeoutMs: 200 });
  const timeoutErr = await expectThrows(() => timeoutCtx.httpRequest("GET", "/api/config"));
  assert(
    timeoutErr && timeoutErr.message === `QuadWork did not respond within 5s (port ${bhPort}).`,
    "httpRequest maps a timeout to a clean error"
  );
  blackhole.close();

  // ── 5. assertKnownProject / assertKnownAgent ────────────────────────────
  const { server: cfg2, port: cfg2Port, requests: req2 } = await startConfigServer();
  const ctx = createContext(cfg2Port);

  // known project passes
  let okErr = await expectThrows(() => ctx.assertKnownProject("plotlink"));
  assert(okErr === null, "assertKnownProject passes a known id");

  // unknown project throws, and only /api/config was hit (no tool HTTP call)
  req2.length = 0;
  const badProjErr = await expectThrows(() => ctx.assertKnownProject("nope"));
  assert(
    badProjErr && badProjErr.message === "Unknown project: nope. Use list_projects to see valid ids.",
    "assertKnownProject throws the clean error for an unknown id"
  );
  assert(
    req2.every((r) => r.startsWith("GET /api/config")),
    "assertKnownProject makes no tool HTTP call beyond /api/config"
  );

  // known agent passes
  okErr = await expectThrows(() => ctx.assertKnownAgent("plotlink", "dev"));
  assert(okErr === null, "assertKnownAgent passes a known (project, agent)");

  // unknown agent throws
  const badAgentErr = await expectThrows(() => ctx.assertKnownAgent("plotlink", "ghost"));
  assert(
    badAgentErr && badAgentErr.message === "Unknown agent: ghost in plotlink.",
    "assertKnownAgent throws the clean error for an unknown agent"
  );

  cfg2.close();

  // ── 6. Consolidated cross-tool pass (#796) ──────────────────────────────
  // Every tool proxies to the right endpoint+method; error mapping; and every
  // ACTING tool rejects an unknown project before any acting HTTP call.
  const HANDLERS = Object.assign(
    {},
    ...["projects", "read", "chat-send", "batch", "triggers", "agents"].map((m) => require(`./mcp-operator/tools/${m}`).handlers),
  );
  const full = await startFullServer();
  const fctx = createContext(full.port);
  const reqs = full.requests;
  const actionReqs = () => reqs.filter((r) => r.path !== "/api/config"); // exclude assert*/getConfiguredProjects reads

  const CASES = [
    { tool: "list_projects", args: {}, expect: [["GET", "/api/config"]] },
    { tool: "read_chat", args: { project: "p", since_id: 1, limit: 5 }, expect: [["GET", "/api/chat"]] },
    { tool: "batch_status", args: { project: "p" }, expect: [["GET", "/api/batch-active"], ["GET", "/api/batch-progress"]] },
    { tool: "read_queue", args: { project: "p" }, expect: [["GET", "/api/queue"]] },
    { tool: "list_agents", args: { project: "p" }, expect: [["GET", "/api/agents"]] },
    { tool: "send_message", args: { project: "p", text: "hi" }, expect: [["POST", "/api/chat"]] },
    { tool: "set_batch", args: { project: "p", content: "x" }, expect: [["PUT", "/api/queue"]] },
    { tool: "append_batch", args: { project: "p", content: "x" }, expect: [["GET", "/api/queue"], ["PUT", "/api/queue"]] },
    { tool: "ensure_batch", args: { project: "p" }, expect: [["POST", "/api/queue"]] },
    { tool: "start_batch", args: { project: "p" }, expect: [["POST", "/api/triggers/p/start"]] },
    { tool: "trigger_now", args: { project: "p" }, expect: [["POST", "/api/triggers/p/send-now"]] },
    { tool: "stop_batch", args: { project: "p" }, expect: [["POST", "/api/triggers/p/stop"]] },
    { tool: "agent_control", args: { project: "p", agent: "dev", action: "restart" }, expect: [["POST", "/api/agents/p/dev/restart"]] },
    { tool: "interrupt_all", args: { project: "p" }, expect: [["POST", "/api/agents/p/interrupt-all"]] },
  ];
  for (const c of CASES) {
    reqs.length = 0;
    await HANDLERS[c.tool](c.args, fctx);
    // Full request list here — list_projects' own action IS /api/config; for
    // other tools an extra /api/config (assertKnownProject) is harmless since we
    // only assert the expected action paths are PRESENT.
    const got = reqs.map((r) => `${r.method} ${r.path}`);
    const want = c.expect.map(([m, p]) => `${m} ${p}`);
    assert(want.every((w) => got.includes(w)), `${c.tool} proxies to ${want.join(" + ")} (got: ${got.join(", ") || "none"})`);
  }

  // list_projects returns only id/name/repo (no token/other-field leakage)
  const projOut = await HANDLERS.list_projects({}, fctx);
  assert(Object.keys(projOut[0]).sort().join(",") === "id,name,repo", "list_projects returns only id/name/repo (no leakage)");

  // send_message sends no sender header (records as operator "user")
  reqs.length = 0;
  await HANDLERS.send_message({ project: "p", text: "hi" }, fctx);
  const sendReq = reqs.find((r) => r.method === "POST" && r.path === "/api/chat");
  assert(sendReq && !("x-chat-sender" in sendReq.headers) && !("x-bridge-sender" in sendReq.headers), "send_message sends no x-chat-sender / x-bridge-sender header");

  // agent_control rejects out-of-allow-list action with NO HTTP call
  reqs.length = 0;
  const badAction = await expectThrows(() => HANDLERS.agent_control({ project: "p", agent: "dev", action: "full-reset" }, fctx));
  assert(badAction && /Invalid action/.test(badAction.message), "agent_control rejects an out-of-allow-list action");
  assert(!actionReqs().some((r) => r.path.startsWith("/api/agents/p/dev")), "agent_control invalid action makes NO agent HTTP call");

  // Every acting tool rejects an unknown project (assert*) with no acting call
  const ACTING = [
    ["read_chat", { project: "ghost" }],
    ["batch_status", { project: "ghost" }],
    ["read_queue", { project: "ghost" }],
    ["send_message", { project: "ghost", text: "x" }],
    ["set_batch", { project: "ghost", content: "x" }],
    ["append_batch", { project: "ghost", content: "x" }],
    ["ensure_batch", { project: "ghost" }],
    ["start_batch", { project: "ghost" }],
    ["trigger_now", { project: "ghost" }],
    ["stop_batch", { project: "ghost" }],
    ["agent_control", { project: "ghost", agent: "dev", action: "stop" }],
    ["interrupt_all", { project: "ghost" }],
  ];
  for (const [name, args] of ACTING) {
    reqs.length = 0;
    const err = await expectThrows(() => HANDLERS[name](args, fctx));
    assert(err && /Unknown (project|agent)/.test(err.message) && actionReqs().length === 0, `${name} rejects unknown project (assert*) with NO acting HTTP call`);
  }
  full.server.close();

  // ── 7. Error mapping: non-2xx with {error} and without JSON ─────────────
  const srv404 = await startStatusServer(404, { error: "boom from server" });
  const e1 = await expectThrows(() => createContext(srv404.port).httpRequest("GET", "/x"));
  assert(e1 && e1.message === "boom from server", "non-2xx with JSON {error} surfaces the error text");
  srv404.server.close();

  const srvHtml = await startStatusServer(404, "not json", "text/plain");
  const e2 = await expectThrows(() => createContext(srvHtml.port).httpRequest("GET", "/y"));
  assert(e2 && e2.message === "GET /y failed: HTTP 404", "non-2xx without JSON maps to '<method> <path> failed: HTTP <status>'");
  srvHtml.server.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
