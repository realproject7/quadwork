"use strict";

// #795: tests for the agent-control tools. Fake backend records method/path so
// we can assert each valid action hits the right path, destructive actions are
// rejected before any HTTP call, and unknown agent/project make NO request.
// (Per the ticket's safety note: NEVER the live :8400 — these mutate live agent
// state; the fake server is disposable.)

const http = require("http");
const { createContext } = require("../context");
const agents = require("./agents");

const handlers = agents.handlers;

const FAKE_CONFIG = {
  projects: [{ id: "plotlink", name: "PlotLink", repo: "realproject7/plotlink", agents: { head: {}, dev: {}, re1: {}, re2: {} } }],
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

function startServer() {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, raw });
        const send = (obj, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (req.method === "GET" && req.url.startsWith("/api/config")) return send(FAKE_CONFIG);
        if (req.method === "POST" && /^\/api\/agents\/[^/]+\/[^/]+\/(start|restart)$/.test(req.url)) {
          return send({ ok: true, state: "running", pid: 4242 });
        }
        if (req.method === "POST" && /^\/api\/agents\/[^/]+\/[^/]+\/stop$/.test(req.url)) {
          return send({ ok: true, state: "stopped" });
        }
        if (req.method === "POST" && /^\/api\/agents\/[^/]+\/[^/]+\/interrupt$/.test(req.url)) {
          return send({ ok: true });
        }
        if (req.method === "POST" && /^\/api\/agents\/[^/]+\/interrupt-all$/.test(req.url)) {
          return send({ ok: true, interrupted: 3 });
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
  console.log("\n--- MCP Operator Agent-Control Tests (#795) ---\n");

  const { server, port, requests } = await startServer();
  const ctx = createContext(port);

  // ── agent_control: each valid action hits the right path ────────────────
  for (const action of ["start", "stop", "restart", "interrupt"]) {
    requests.length = 0;
    const res = await handlers.agent_control({ project: "plotlink", agent: "dev", action }, ctx);
    const post = requests.find((r) => r.method === "POST" && r.url.includes("/api/agents/"));
    assert(post && post.url === `/api/agents/plotlink/dev/${action}`, `agent_control '${action}' POSTs to /api/agents/plotlink/dev/${action}`);
    assert(res && res.ok === true, `agent_control '${action}' returns the endpoint response`);
  }

  // An Operator can forward the two server-observed circuit anchors for a
  // one-at-a-time start/restart trial; the tool never invents either value.
  {
    requests.length = 0;
    await handlers.agent_control({
      project: "plotlink", agent: "dev", action: "start",
      expected_generation: "generation-observed", loss_correlation: "loss-observed",
    }, ctx);
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/start"));
    assert(post && post.raw === JSON.stringify({ expected_generation: "generation-observed", loss_correlation: "loss-observed" }), "circuit-open start forwards only observed generation and loss correlation");
  }

  // ── invalid action → rejected BEFORE any HTTP call ──────────────────────
  for (const bad of ["full-reset", "reset", "write", "destroy", ""]) {
    requests.length = 0;
    const err = await expectThrows(() => handlers.agent_control({ project: "plotlink", agent: "dev", action: bad }, ctx));
    assert(err && /Invalid action/.test(err.message), `invalid action '${bad}' → tool error`);
    assert(!requests.some((r) => r.method === "POST"), `invalid action '${bad}' → NO HTTP call (destructive endpoint unreachable)`);
  }

  // ── unknown agent (valid project) → rejected via assertKnownAgent, NO call ─
  {
    requests.length = 0;
    const err = await expectThrows(() => handlers.agent_control({ project: "plotlink", agent: "ghost", action: "stop" }, ctx));
    assert(err && err.message === "Unknown agent: ghost in plotlink.", "unknown agent → clean assertKnownAgent error");
    assert(!requests.some((r) => r.method === "POST"), "unknown agent → NO HTTP call");
  }

  // ── unknown project → rejected, NO call ─────────────────────────────────
  {
    requests.length = 0;
    const err = await expectThrows(() => handlers.agent_control({ project: "ghost", agent: "dev", action: "stop" }, ctx));
    assert(err && err.message === "Unknown project: ghost. Use list_projects to see valid ids.", "unknown project → clean error");
    assert(!requests.some((r) => r.method === "POST"), "unknown project → NO HTTP call");
  }

  // ── interrupt_all ───────────────────────────────────────────────────────
  {
    requests.length = 0;
    const res = await handlers.interrupt_all({ project: "plotlink" }, ctx);
    assert(res && res.interrupted === 3, "interrupt_all returns { ok, interrupted }");
    assert(requests.some((r) => r.method === "POST" && r.url === "/api/agents/plotlink/interrupt-all"), "interrupt_all POSTs to /api/agents/<project>/interrupt-all");

    requests.length = 0;
    const err = await expectThrows(() => handlers.interrupt_all({ project: "ghost" }, ctx));
    assert(err && /Unknown project/.test(err.message), "interrupt_all unknown project → error");
    assert(!requests.some((r) => r.method === "POST"), "interrupt_all unknown project → NO HTTP call");
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
