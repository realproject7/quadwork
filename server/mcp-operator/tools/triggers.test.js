"use strict";

// #794/#1031: batch-execution tools must join the two live batch endpoints
// before mutating trigger state. These tests use only a disposable fake
// backend; they never exercise the real :8400 service.

const http = require("http");
const { createContext } = require("../context");
const triggers = require("./triggers");

const handlers = triggers.handlers;

const FAKE_CONFIG = {
  projects: [{ id: "plotlink", name: "PlotLink", repo: "realproject7/plotlink", agents: { head: {}, dev: {} } }],
};

const WORK_ITEM_REF = {
  repo_key: "primary",
  repo: "realproject7/plotlink",
  number: 1031,
  kind: "issue",
};
const ASSIGNMENT_ITEMS = [{ work_item_ref: WORK_ITEM_REF, ownership_key: "owned-item-1031" }];
const ADMISSION_GENERATION = 7;
const V2_IDENTITY = {
  batch_observation_fingerprint: "v2-observation-mcp-17-a",
  installation_id: "installation-a",
  batch_number: 17,
  assignment_attempt: "attempt-a",
  provenance: "owned",
  assignment_key: "batch-assignment-a",
  assignment_items: ASSIGNMENT_ITEMS,
};

function v2LiveState(overrides = {}) {
  const active = {
    active: true,
    admission_generation: ADMISSION_GENERATION,
    compatibility_mode: "v2",
    ...V2_IDENTITY,
    current: true,
    owned: true,
    multi_repository: false,
  };
  const progress = {
    active: true,
    admission_generation: ADMISSION_GENERATION,
    compatibility_mode: "v2",
    ...V2_IDENTITY,
    current: true,
    owned: true,
    multi_repository: false,
    complete: false,
    completeConfirmed: false,
    liveActiveBatchCleared: false,
    items: [{
      ...V2_IDENTITY,
      ...WORK_ITEM_REF,
      work_item_ref: WORK_ITEM_REF,
      ownership_key: "owned-item-1031",
      current: true,
      owned: true,
    }],
  };
  return {
    active: { ...active, ...(overrides.active || {}) },
    progress: { ...progress, ...(overrides.progress || {}) },
  };
}

function v2ClearedState() {
  const clearedIdentity = {
    batch_observation_fingerprint: "v2-observation-mcp-empty",
    installation_id: null,
    batch_number: null,
    assignment_attempt: null,
    provenance: "unowned",
    assignment_key: null,
    assignment_items: [],
  };
  return {
    active: {
      active: false,
      admission_generation: ADMISSION_GENERATION,
      compatibility_mode: "v2",
      ...clearedIdentity,
      current: false,
      owned: false,
      multi_repository: false,
    },
    progress: {
      admission_generation: ADMISSION_GENERATION,
      compatibility_mode: "v2",
      ...clearedIdentity,
      active: false,
      current: false,
      owned: false,
      multi_repository: false,
      complete: false,
      completeConfirmed: false,
      liveActiveBatchCleared: true,
      items: [],
    },
  };
}

function v1LiveState() {
  const base = {
    admission_generation: ADMISSION_GENERATION,
    compatibility_mode: "v1",
    installation_id: null,
    batch_number: 4,
    assignment_attempt: null,
    provenance: "legacy_unowned",
    assignment_key: null,
    assignment_items: [],
    current: true,
    owned: false,
    multi_repository: false,
    batch_observation_fingerprint: "legacy-observation-mcp-4",
  };
  return {
    active: { ...base, active: true },
    progress: {
      ...base,
      complete: false,
      completeConfirmed: false,
      liveActiveBatchCleared: false,
      items: [{
        ...base,
        ...WORK_ITEM_REF,
        work_item_ref: WORK_ITEM_REF,
        ownership_key: null,
      }],
    },
  };
}

function v1ClearedState() {
  const state = v1LiveState();
  return {
    active: { ...state.active, active: false, batch_number: null, current: false,
      batch_observation_fingerprint: "legacy-observation-mcp-empty" },
    progress: {
      ...state.progress,
      active: false,
      batch_number: null,
      batch_observation_fingerprint: "legacy-observation-mcp-empty",
      current: false,
      complete: false,
      completeConfirmed: false,
      liveActiveBatchCleared: true,
      items: [],
    },
  };
}

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

function startServer({ idleProjects = new Set(), state = v2LiveState() } = {}) {
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
        if (req.method === "GET" && req.url.startsWith("/api/batch-active")) return send(state.active);
        if (req.method === "GET" && req.url.startsWith("/api/batch-progress")) return send(state.progress);
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

function triggerPosts(requests) {
  return requests.filter((request) => request.method === "POST" && request.url.startsWith("/api/triggers/"));
}

function batchReads(requests) {
  return requests.filter((request) => request.method === "GET" && request.url.startsWith("/api/batch-"));
}

function hasExactV2Identity(body, expectedItems = ASSIGNMENT_ITEMS) {
  return body && body.admission_generation === ADMISSION_GENERATION &&
    body.batch_observation_fingerprint === V2_IDENTITY.batch_observation_fingerprint &&
    body.installation_id === V2_IDENTITY.installation_id &&
    body.batch_number === V2_IDENTITY.batch_number &&
    body.assignment_attempt === V2_IDENTITY.assignment_attempt &&
    body.provenance === "owned" &&
    body.assignment_key === V2_IDENTITY.assignment_key &&
    JSON.stringify(body.assignment_items) === JSON.stringify(expectedItems) &&
    !("compatibility_mode" in body);
}

async function runTests() {
  console.log("\n--- MCP Operator Batch-Execution Tests (#794/#1031) ---\n");

  {
    const { server, port, requests } = await startServer();
    const ctx = createContext(port);
    requests.length = 0;
    const res = await handlers.start_batch({ project: "plotlink", interval_min: 15, duration_min: 180 }, ctx);
    assert(res && res.enabled === true, "start_batch returns the enabled trigger info");
    assert(batchReads(requests).length === 2, "start_batch joins batch-active and batch-progress");
    const post = triggerPosts(requests)[0];
    assert(post && post.url === "/api/triggers/plotlink/start", "start_batch POSTs to /api/triggers/<project>/start");
    assert(post.body.interval === 15 && post.body.duration === 180, "start_batch maps interval_min→interval, duration_min→duration");
    assert(!("interval_min" in post.body) && !("duration_min" in post.body), "start_batch does NOT send *_min keys");
    assert(!("message" in post.body), "start_batch omits absent fields (no message key)");
    assert(hasExactV2Identity(post.body), "start_batch carries the exact V2 owned assignment identity");
    server.close();
  }

  {
    const { server, port, requests } = await startServer();
    const ctx = createContext(port);
    requests.length = 0;
    const fired = await handlers.trigger_now({ project: "plotlink" }, ctx);
    assert(fired && fired.sent === true, "trigger_now fires a pulse (sent:true)");
    const firePost = triggerPosts(requests)[0];
    assert(firePost && firePost.url.endsWith("/send-now") && hasExactV2Identity(firePost.body), "trigger_now carries exact V2 authority");

    requests.length = 0;
    const stopped = await handlers.stop_batch({ project: "plotlink" }, ctx);
    assert(stopped && stopped.enabled === false, "stop_batch returns enabled:false");
    const stopPost = triggerPosts(requests)[0];
    assert(stopPost && stopPost.url.endsWith("/stop") && hasExactV2Identity(stopPost.body), "stop_batch accepts a current V2 assignment and carries exact authority");
    server.close();
  }

  {
    const { server, port, requests } = await startServer({ state: v2ClearedState() });
    const ctx = createContext(port);
    requests.length = 0;
    await handlers.stop_batch({ project: "plotlink" }, ctx);
    const post = triggerPosts(requests)[0];
    assert(JSON.stringify(post?.body) === JSON.stringify({
      admission_generation: ADMISSION_GENERATION,
      compatibility_mode: "v2",
      batch_observation_fingerprint: "v2-observation-mcp-empty",
      current_batch_empty: true,
    }), "stop_batch forwards only the authoritative V2 empty-observation receipt");
    server.close();
  }

  {
    const { server, port, requests } = await startServer({ state: v1ClearedState() });
    const ctx = createContext(port);
    await handlers.stop_batch({ project: "plotlink" }, ctx);
    assert(JSON.stringify(triggerPosts(requests)[0].body) === JSON.stringify({
      admission_generation: ADMISSION_GENERATION,
      compatibility_mode: "v1",
      batch_observation_fingerprint: "legacy-observation-mcp-empty",
      current_batch_empty: true,
    }), "legacy stop_batch carries its empty-observation lease without inventing assignment authority");
    server.close();
  }

  {
    const { server, port, requests } = await startServer({ state: v1LiveState() });
    const ctx = createContext(port);
    requests.length = 0;
    await handlers.start_batch({ project: "plotlink", message: "@head go" }, ctx);
    const post = triggerPosts(requests)[0];
    assert(post.body.message === "@head go" && !("interval" in post.body) && !("duration" in post.body), "start_batch sends only the provided trigger option");
    assert(JSON.stringify(post.body) === JSON.stringify({
      message: "@head go",
      admission_generation: ADMISSION_GENERATION,
      compatibility_mode: "v1",
      batch_observation_fingerprint: "legacy-observation-mcp-4",
    }), "legacy start sends explicit V1 authority plus its observation lease");

    requests.length = 0;
    await handlers.trigger_now({ project: "plotlink" }, ctx);
    assert(JSON.stringify(triggerPosts(requests)[0].body) === JSON.stringify({
      admission_generation: ADMISSION_GENERATION,
      compatibility_mode: "v1",
      batch_observation_fingerprint: "legacy-observation-mcp-4",
    }), "legacy trigger_now carries the exact V1 observation lease");

    requests.length = 0;
    await handlers.stop_batch({ project: "plotlink" }, ctx);
    assert(JSON.stringify(triggerPosts(requests)[0].body) === JSON.stringify({
      admission_generation: ADMISSION_GENERATION,
      compatibility_mode: "v1",
      batch_observation_fingerprint: "legacy-observation-mcp-4",
    }), "legacy stop_batch carries the exact V1 observation lease");
    server.close();
  }

  for (const [label, state] of [
    ["inactive", v2LiveState({ active: { active: false } })],
    ["complete", v2LiveState({ progress: { complete: true, completeConfirmed: true } })],
  ]) {
    const { server, port, requests } = await startServer({ state });
    const ctx = createContext(port);
    for (const [name, invoke] of [
      ["start_batch", () => handlers.start_batch({ project: "plotlink" }, ctx)],
      ["trigger_now", () => handlers.trigger_now({ project: "plotlink" }, ctx)],
    ]) {
      requests.length = 0;
      const err = await expectThrows(invoke);
      assert(err && /live active non-complete batch/i.test(err.message), `${name} visibly rejects ${label} batch state`);
      assert(triggerPosts(requests).length === 0, `${name} ${label} rejection makes NO mutation POST`);
    }
    server.close();
  }

  const rejectedStates = [
    ["foreign", v2LiveState({ active: { provenance: "foreign", owned: false }, progress: { provenance: "foreign", owned: false } })],
    ["unowned", v2LiveState({ active: { provenance: "unowned", owned: false }, progress: { provenance: "unowned", owned: false } })],
    ["stale", v2LiveState({ progress: { assignment_attempt: "attempt-stale" } })],
    ["malformed", v2LiveState({ progress: { assignment_items: [] } })],
  ];
  for (const [label, state] of rejectedStates) {
    const { server, port, requests } = await startServer({ state });
    const ctx = createContext(port);
    for (const [name, invoke] of [
      ["start_batch", () => handlers.start_batch({ project: "plotlink" }, ctx)],
      ["trigger_now", () => handlers.trigger_now({ project: "plotlink" }, ctx)],
      ["stop_batch", () => handlers.stop_batch({ project: "plotlink" }, ctx)],
    ]) {
      requests.length = 0;
      const err = await expectThrows(invoke);
      assert(err && /authority is missing, stale, foreign, unowned, or malformed/i.test(err.message), `${name} visibly rejects ${label} authority`);
      assert(batchReads(requests).length === 2, `${name} ${label} rejection still joins both authority endpoints`);
      assert(triggerPosts(requests).length === 0, `${name} ${label} rejection makes NO mutation POST`);
    }
    server.close();
  }

  {
    const { server, port } = await startServer({ idleProjects: new Set(["plotlink"]) });
    const ctx = createContext(port);
    const startErr = await expectThrows(() => handlers.start_batch({ project: "plotlink" }, ctx));
    assert(startErr && /inactive \(idle\)/i.test(startErr.message), "start_batch on idle project throws the inactive rejection");
    const fireErr = await expectThrows(() => handlers.trigger_now({ project: "plotlink" }, ctx));
    assert(fireErr && /inactive \(idle\)/i.test(fireErr.message), "trigger_now on idle project throws the inactive rejection");
    server.close();
  }

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
      assert(err && err.message === "Unknown project: ghost. Use list_projects to see valid ids.", `${name} on unknown project throws the clean error`);
      assert(batchReads(requests).length === 0 && triggerPosts(requests).length === 0, `${name} on unknown project makes NO authority or mutation request`);
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
