"use strict";

// #793: tests for batch-definition tools. Fake backend models /api/queue
// (GET/PUT/POST) with an in-memory file so we can assert the exact bytes
// written — including the append combine rule (no leading newline on an empty
// queue) — and prove unknown projects write nothing.

const http = require("http");
const { createContext } = require("../context");
const batch = require("./batch");

const handlers = batch.handlers;

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

// In-memory queue file. `queue.content === null` means the file does not exist.
function startServer(initial = null) {
  const requests = [];
  const queue = { content: initial };
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
        requests.push({ method: req.method, url: req.url, body: parsed });
        const send = (obj, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (req.method === "GET" && req.url.startsWith("/api/config")) return send(FAKE_CONFIG);
        if (req.url.startsWith("/api/queue")) {
          if (req.method === "GET") {
            return queue.content === null
              ? send({ ok: true, exists: false, content: "" })
              : send({ ok: true, exists: true, content: queue.content });
          }
          if (req.method === "PUT") {
            if (typeof (parsed && parsed.content) !== "string") return send({ error: "Missing content" }, 400);
            queue.content = parsed.content;
            return send({ ok: true });
          }
          if (req.method === "POST") {
            const existed = queue.content !== null;
            if (!existed) queue.content = "<<template>>";
            return send({ ok: true, existed });
          }
        }
        return send({ error: "not found" }, 404);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, queue }));
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
  console.log("\n--- MCP Operator Batch Management Tests (#793) ---\n");

  // ── set_batch: full replace ─────────────────────────────────────────────
  {
    const { server, port, requests, queue } = await startServer("## OLD\n- stale\n");
    const ctx = createContext(port);
    const r = await handlers.set_batch({ project: "plotlink", content: "## Batch 11\n- #800\n" }, ctx);
    assert(r && r.ok === true, "set_batch returns { ok: true }");
    assert(queue.content === "## Batch 11\n- #800\n", "set_batch fully replaces queue content via PUT");
    const put = requests.find((x) => x.method === "PUT");
    assert(put && put.body.content === "## Batch 11\n- #800\n", "set_batch PUT body equals input content");
    server.close();
  }

  // ── set_batch: empty/invalid content rejected (no write) ────────────────
  {
    const { server, port, requests } = await startServer("## keep\n");
    const ctx = createContext(port);
    const emptyErr = await expectThrows(() => handlers.set_batch({ project: "plotlink", content: "" }, ctx));
    assert(emptyErr && /non-empty string/.test(emptyErr.message), "set_batch rejects empty content");
    assert(!requests.some((x) => x.method === "PUT"), "set_batch with empty content makes NO PUT");
    server.close();
  }

  // ── append_batch: existing content → existing + new ─────────────────────
  {
    const { server, port, queue } = await startServer("## Batch 11\n- #800\n"); // note trailing newline
    const ctx = createContext(port);
    await handlers.append_batch({ project: "plotlink", content: "- #801\n" }, ctx);
    assert(
      queue.content === "## Batch 11\n- #800\n- #801\n",
      "append_batch appends new content after trimmed existing (single newline join, no blank line)"
    );
    server.close();
  }

  // ── append_batch: no existing file → only the new content (no leading \n) ─
  {
    const { server, port, requests, queue } = await startServer(null);
    const ctx = createContext(port);
    await handlers.append_batch({ project: "plotlink", content: "## Fresh\n- #802\n" }, ctx);
    assert(queue.content === "## Fresh\n- #802\n", "append_batch on empty queue PUTs only the new content (no leading newline)");
    const get = requests.find((x) => x.method === "GET" && x.url.startsWith("/api/queue"));
    assert(get != null, "append_batch reads the queue before writing (read-then-PUT, not POST-append)");
    server.close();
  }

  // ── ensure_batch: creates when absent, idempotent when present ───────────
  {
    const { server, port } = await startServer(null);
    const ctx = createContext(port);
    const created = await handlers.ensure_batch({ project: "plotlink" }, ctx);
    assert(created.ok === true && created.existed === false, "ensure_batch creates the queue when absent (existed:false)");
    const again = await handlers.ensure_batch({ project: "plotlink" }, ctx);
    assert(again.ok === true && again.existed === true, "ensure_batch is idempotent when present (existed:true)");
    server.close();
  }

  // ── unknown project → error, no write (across all three tools) ──────────
  {
    const { server, port, requests } = await startServer("## keep\n");
    const ctx = createContext(port);
    for (const [name, fn] of [
      ["set_batch", () => handlers.set_batch({ project: "ghost", content: "x" }, ctx)],
      ["append_batch", () => handlers.append_batch({ project: "ghost", content: "x" }, ctx)],
      ["ensure_batch", () => handlers.ensure_batch({ project: "ghost" }, ctx)],
    ]) {
      requests.length = 0;
      const err = await expectThrows(fn);
      assert(
        err && err.message === "Unknown project: ghost. Use list_projects to see valid ids.",
        `${name} on unknown project throws the clean error`
      );
      assert(
        !requests.some((x) => x.method === "PUT" || x.method === "POST"),
        `${name} on unknown project makes NO write`
      );
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
