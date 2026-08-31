"use strict";

// #791: tests for the Tier 1 read tools. Drives the handlers directly via a
// #790 context pointed at a fake QuadWork backend that records every request
// path — so we can prove unknown-project reads make NO downstream HTTP call
// (no orphan ~/.quadwork/<id>/ state), and that list_agents merges
// config ∪ runtime. (Transport/stdio is already covered by mcp-operator.test.js.)

const http = require("http");
const { createContext } = require("../context");
const read = require("./read");

const handlers = read.handlers;

const FAKE_CONFIG = {
  projects: [
    {
      id: "plotlink",
      name: "PlotLink",
      repo: "realproject7/plotlink",
      agents: { head: {}, dev: {}, re1: {}, re2: {} },
    },
    {
      id: "quadwork",
      name: "QuadWork",
      repo: "realproject7/quadwork",
      agents: { head: {}, dev: {}, re1: {}, re2: {} },
    },
  ],
};

const CHAT_MESSAGES = [
  { id: 1, sender: "head", text: "go", ts: "2026-05-30T00:00:00.000Z", type: "message", channel: "general" },
  { id: 2, sender: "dev", text: "ok", ts: "2026-05-30T00:01:00.000Z", type: "message", channel: "general" },
];

// /api/agents returns ONLY live sessions: head running, dev stopped. re1/re2
// are configured but absent → must surface as "missing".
const RUNTIME_AGENTS = {
  "plotlink/head": { state: "running", error: null },
  "plotlink/dev": { state: "stopped", error: null },
};

const WEB_REF = { repo_key: "web", repo: "owner/web", number: 42, kind: "issue" };
const API_REF = { repo_key: "api", repo: "owner/api", number: 42, kind: "issue" };
const ASSIGNMENT_ITEMS = [
  { work_item_ref: API_REF, ownership_key: "ownership-api-42" },
  { work_item_ref: WEB_REF, ownership_key: "ownership-web-42" },
];

const BATCH_IDENTITY = {
  installation_id: "123e4567-e89b-42d3-a456-426614174000",
  batch_number: 4,
  assignment_attempt: "attempt-4-owned",
  provenance: "owned",
  assignment_key: "batch-4-attempt-4-owned",
  assignment_items: ASSIGNMENT_ITEMS,
  current: true,
  owned: true,
  multi_repository: true,
  compatibility_mode: "v2",
};
const ROW_IDENTITY = {
  installation_id: BATCH_IDENTITY.installation_id,
  batch_number: BATCH_IDENTITY.batch_number,
  assignment_attempt: BATCH_IDENTITY.assignment_attempt,
  provenance: BATCH_IDENTITY.provenance,
  assignment_key: BATCH_IDENTITY.assignment_key,
  current: BATCH_IDENTITY.current,
  owned: BATCH_IDENTITY.owned,
};

const BATCH_ACTIVE = { active: true, batch_type: "code", ...BATCH_IDENTITY };
const BATCH_PROGRESS = {
  complete: false,
  total: 2,
  done: 0,
  multi_repository: true,
  ...BATCH_IDENTITY,
  items: [
    {
      ...ROW_IDENTITY,
      repo_key: "web",
      repo: "owner/web",
      number: 42,
      kind: "issue",
      work_item_ref: { repo_key: "web", repo: "owner/web", number: 42, kind: "issue" },
      ownership_key: "ownership-web-42",
      issue_number: 42,
      live_pr: { number: 101, url: "https://github.com/owner/web/pull/101", state: "OPEN", tip: "a".repeat(40) },
    },
    {
      ...ROW_IDENTITY,
      repo_key: "api",
      repo: "owner/api",
      number: 42,
      kind: "issue",
      work_item_ref: { repo_key: "api", repo: "owner/api", number: 42, kind: "issue" },
      ownership_key: "ownership-api-42",
      issue_number: 42,
      live_pr: null,
      historical_pr: { number: 99, url: "https://github.com/owner/api/pull/99", state: "MERGED", tip: "b".repeat(40) },
    },
  ],
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
      requests.push(`${req.method} ${req.url}`);
      const send = (obj, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const url = req.url;
      if (url.startsWith("/api/config")) return send(FAKE_CONFIG);
      if (url.startsWith("/api/chat")) return send(CHAT_MESSAGES);
      if (url.startsWith("/api/batch-active")) return send(BATCH_ACTIVE);
      if (url.startsWith("/api/batch-progress")) return send(BATCH_PROGRESS);
      if (url.startsWith("/api/queue")) return send({ ok: true, exists: true, content: "## Active Batch\n- #791\n" });
      if (url.startsWith("/api/agents")) return send(RUNTIME_AGENTS);
      return send({ error: "not found" }, 404);
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
  console.log("\n--- MCP Operator Tier 1 Read Tools Tests (#791) ---\n");

  const { server, port, requests } = await startServer();
  const ctx = createContext(port);

  // ── read_chat: known project, paging ────────────────────────────────────
  requests.length = 0;
  const chat = await handlers.read_chat({ project: "plotlink", since_id: 1, limit: 25 }, ctx);
  assert(Array.isArray(chat) && chat.length === 2, "read_chat returns the message array");
  assert(chat[0].sender === "head" && chat[0].ts === "2026-05-30T00:00:00.000Z", "read_chat passes ts through raw (ISO)");
  const chatReq = requests.find((r) => r.includes("/api/chat"));
  assert(chatReq && chatReq.includes("since_id=1") && chatReq.includes("limit=25"), "read_chat honors since_id + limit");

  // ── read_chat: unknown project → throws, NO /api/chat request ────────────
  requests.length = 0;
  const badChatErr = await expectThrows(() => handlers.read_chat({ project: "ghost" }, ctx));
  assert(
    badChatErr && badChatErr.message === "Unknown project: ghost. Use list_projects to see valid ids.",
    "read_chat on unknown project throws the clean error"
  );
  assert(!requests.some((r) => r.includes("/api/chat")), "read_chat unknown project makes NO /api/chat request (no orphan file)");

  // ── batch_status: merge active + progress ───────────────────────────────
  const batch = await handlers.batch_status({ project: "plotlink" }, ctx);
  assert(batch && batch.active && batch.active.active === true, "batch_status includes active");
  assert(batch && batch.progress && batch.progress.total === 2, "batch_status includes progress (merged)");
  assert(
    batch.active.assignment_attempt === "attempt-4-owned" && batch.progress.assignment_key === BATCH_IDENTITY.assignment_key,
    "batch_status preserves the opaque assignment identity without rewriting it",
  );
  assert(
    JSON.stringify(batch.active.assignment_items) === JSON.stringify(ASSIGNMENT_ITEMS) &&
      JSON.stringify(batch.progress.assignment_items) === JSON.stringify(ASSIGNMENT_ITEMS),
    "batch_status preserves ordered aggregate assignment_items",
  );
  assert(
    batch.progress.items.length === 2 &&
      batch.progress.items[0].issue_number === 42 && batch.progress.items[1].issue_number === 42 &&
      batch.progress.items[0].repo === "owner/web" && batch.progress.items[1].repo === "owner/api",
    "batch_status keeps same-number work items distinct by repository",
  );
  assert(
    batch.progress.items[0].ownership_key === "ownership-web-42" &&
      batch.progress.items[1].ownership_key === "ownership-api-42",
    "batch_status preserves distinct per-item ownership keys",
  );
  assert(
    batch.progress.items[0].live_pr.state === "OPEN" && batch.progress.items[0].live_pr.tip === "a".repeat(40),
    "batch_status preserves the explicit OPEN live PR reference",
  );
  assert(
    batch.progress.items[1].live_pr === null && batch.progress.items[1].historical_pr.state === "MERGED",
    "batch_status does not promote a merged historical PR to live_pr",
  );

  // ── read_queue: returns markdown ────────────────────────────────────────
  const queue = await handlers.read_queue({ project: "plotlink" }, ctx);
  assert(queue.exists === true && queue.content.includes("## Active Batch"), "read_queue returns { exists, content }");

  // ── list_agents: no project → all projects, no validation throw ─────────
  const allAgents = await handlers.list_agents({}, ctx);
  assert(Array.isArray(allAgents) && allAgents.length === 8, "list_agents (no project) returns all configured agents across projects");

  // ── list_agents: bogus project → validation error, NO /api/agents call ──
  requests.length = 0;
  const badAgentErr = await expectThrows(() => handlers.list_agents({ project: "ghost" }, ctx));
  assert(
    badAgentErr && badAgentErr.message === "Unknown project: ghost. Use list_projects to see valid ids.",
    "list_agents with bogus project throws the validation error"
  );
  assert(!requests.some((r) => r.includes("/api/agents")), "list_agents bogus project makes NO /api/agents call");

  // ── list_agents: config ∪ runtime merge + per-agent state ───────────────
  const plAgents = await handlers.list_agents({ project: "plotlink" }, ctx);
  const byAgent = Object.fromEntries(plAgents.map((a) => [a.agent, a.state]));
  assert(plAgents.length === 4, "list_agents (filtered) returns all 4 configured agents");
  assert(byAgent.head === "running", "list_agents shows runtime state for a live agent (head=running)");
  assert(byAgent.dev === "stopped", "list_agents shows runtime state for a stopped agent (dev=stopped)");
  assert(byAgent.re1 === "missing" && byAgent.re2 === "missing", "list_agents includes configured-but-untracked agents as 'missing'");
  assert(plAgents.every((a) => a.project === "plotlink"), "list_agents filters to the requested project");

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
