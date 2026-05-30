"use strict";

// #794: tests for the batch-execution tools. Fake backend records method/path/
// body so we can assert the renamed fields (interval/duration, not *_min), that
// unknown projects make NO request (no timer/orphan), and that idle responses
// surface a clear rejection. (Per the ticket's safety note: NEVER exercise the
// real :8400 — these mutate live state; the fake server is disposable.)

const http = require("http");
const { createContext } = require("../context");
const triggers = require("./triggers");

const handlers = triggers.handlers;

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

// `idleProjects` is a set of project ids the fake backend treats as idle.
function startServer(idleProjects = new Set()) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = undefined;
        }
        requests.push({ method: req.method, url: req.url, body });
        const send = (obj, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (req.method === "GET" && req.url.startsWith("/api/config")) return send(FAKE_CONFIG);
        const m = req.url.match(/^\/api\/triggers\/([^/]+)\/(start|send-now|stop)$/);
        if (req.method === "POST" && m) {
          const project = decodeURIComponent(m[1]);
          const action = m[2];
          const idle = idleProjects.has(project);
          if (action === "start") {
            if (idle) return send({ ok: false, idle: true, enabled: false });
            return send({ ok: true, enabled: true, interval: 1800000, nextAt: 1, expiresAt: null });
          }
          if (action === "send-now") {
            if (idle) return send({ ok: false, idle: true, sent: false });
            return send({ ok: true, sent: true });
          }
          if (action === "stop") return send({ ok: true, enabled: false });
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
  console.log("\n--- MCP Operator Batch-Execution Tests (#794) ---\n");

  // ── start_batch: field rename + only-provided fields ────────────────────
  {
    const { server, port, requests } = await startServer();
    const ctx = createContext(port);
    requests.length = 0;
    const res = await handlers.start_batch({ project: "plotlink", interval_min: 15, duration_min: 180 }, ctx);
    assert(res && res.enabled === true, "start_batch returns the enabled trigger info");
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/start"));
    assert(post && post.url === "/api/triggers/plotlink/start", "start_batch POSTs to /api/triggers/<project>/start");
    assert(post.body.interval === 15 && post.body.duration === 180, "start_batch maps interval_min→interval, duration_min→duration");
    assert(!("interval_min" in post.body) && !("duration_min" in post.body), "start_batch does NOT send *_min keys");
    assert(!("message" in post.body), "start_batch omits absent fields (no message key)");
    server.close();
  }

  // ── start_batch: only message provided → body has message only ──────────
  {
    const { server, port, requests } = await startServer();
    const ctx = createContext(port);
    requests.length = 0;
    await handlers.start_batch({ project: "plotlink", message: "@head go" }, ctx);
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/start"));
    assert(post.body.message === "@head go" && !("interval" in post.body) && !("duration" in post.body), "start_batch sends only the provided message field");
    server.close();
  }

  // ── trigger_now + stop_batch happy paths ────────────────────────────────
  {
    const { server, port, requests } = await startServer();
    const ctx = createContext(port);
    requests.length = 0;
    const fired = await handlers.trigger_now({ project: "plotlink" }, ctx);
    assert(fired && fired.sent === true, "trigger_now fires a pulse (sent:true)");
    assert(requests.some((r) => r.method === "POST" && r.url === "/api/triggers/plotlink/send-now"), "trigger_now POSTs to /send-now");

    const stopped = await handlers.stop_batch({ project: "plotlink" }, ctx);
    assert(stopped && stopped.enabled === false, "stop_batch returns enabled:false");
    assert(requests.some((r) => r.method === "POST" && r.url === "/api/triggers/plotlink/stop"), "stop_batch POSTs to /stop");
    server.close();
  }

  // ── idle handling: start_batch + trigger_now surface a clear rejection ──
  {
    const { server, port } = await startServer(new Set(["plotlink"]));
    const ctx = createContext(port);
    const startErr = await expectThrows(() => handlers.start_batch({ project: "plotlink" }, ctx));
    assert(startErr && /inactive \(idle\)/i.test(startErr.message), "start_batch on idle project throws the inactive rejection");
    const fireErr = await expectThrows(() => handlers.trigger_now({ project: "plotlink" }, ctx));
    assert(fireErr && /inactive \(idle\)/i.test(fireErr.message), "trigger_now on idle project throws the inactive rejection");
    server.close();
  }

  // ── unknown project → error, NO request (no timer / orphan) ──────────────
  {
    const { server, port, requests } = await startServer();
    const ctx = createContext(port);
    for (const [name, fn] of [
      ["start_batch", () => handlers.start_batch({ project: "ghost" }, ctx)],
      ["trigger_now", () => handlers.trigger_now({ project: "ghost" }, ctx)],
      ["stop_batch", () => handlers.stop_batch({ project: "ghost" }, ctx)],
    ]) {
      requests.length = 0;
      const err = await expectThrows(fn);
      assert(
        err && err.message === "Unknown project: ghost. Use list_projects to see valid ids.",
        `${name} on unknown project throws the clean error`
      );
      assert(!requests.some((r) => r.url.includes("/triggers/")), `${name} on unknown project makes NO trigger request (no timer)`);
    }
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
