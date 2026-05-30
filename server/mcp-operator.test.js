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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
