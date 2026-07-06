// #970: three isolated local-attack-surface guards in routes.js.
//   1. POST /api/activity/log — `project` must be a configured id, else a
//      crafted value (e.g. "../../tmp/x") is an arbitrary-path write primitive
//      (path.join(CONFIG_DIR, project, "activity.jsonl") → mkdir + append).
//   2. POST /api/chat over the X-Bridge-Sender path — a localhost bridge
//      process must not be able to post under a reserved agent identity.
//   3. _resolveReviewerTokenPath — a worktree-sourced token path (from
//      agent-writable AGENTS.md) must stay under ~/.quadwork or the worktree,
//      or the server would readFileSync an arbitrary path (existence oracle).
//
// Plain node:assert script — run with `node server/routes.securityGuards.test.js`.

const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `routes-secguards-${process.pid}-${Date.now()}`);

// Override HOME BEFORE requiring routes/config so CONFIG_DIR resolves under the
// temp dir (real fs, no stubbing).
const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const CONFIG_DIR = path.join(TEST_DIR, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const PROJECT = "secguards-project";

// A project whose re1 worktree lives under the temp dir; its AGENTS.md is
// written per-scenario in the guard-3 section.
const WT_DIR = path.join(TEST_DIR, "wt", `${PROJECT}-re1`);
fs.mkdirSync(WT_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({
    projects: [{ id: PROJECT, working_dir: path.join(TEST_DIR, "wt", PROJECT), agents: { re1: { cwd: WT_DIR } } }],
  }),
);

const fileChat = require("./file-chat");
const routes = require("./routes");
const { _resolveReviewerTokenPath, _reviewerTokenPathAllowed } = routes;
const express = require("express");

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

function req(server, { method = "GET", urlPath, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log(`  PASS: ${m}`); };

(async () => {
  fileChat.initProject(PROJECT);

  const app = express();
  app.use(express.json());
  app.use(routes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  try {
    // ── Guard 1: activity/log path traversal ────────────────────────────────
    // A valid project logs a completed session (start then end appends a row).
    let s = await req(server, {
      method: "POST", urlPath: "/api/activity/log",
      body: { project: PROJECT, agent: "dev", type: "start", timestamp: 1000 },
    });
    ok(s.status === 200, "activity/log start for a configured project → 200");
    s = await req(server, {
      method: "POST", urlPath: "/api/activity/log",
      body: { project: PROJECT, agent: "dev", type: "end", timestamp: 2000 },
    });
    ok(s.status === 200, "activity/log end for a configured project → 200");
    ok(
      fs.existsSync(path.join(CONFIG_DIR, PROJECT, "activity.jsonl")),
      "valid project session row is appended under CONFIG_DIR/<project>/",
    );

    // A traversing project is rejected on both start and end, and writes nothing.
    for (const type of ["start", "end"]) {
      const trav = await req(server, {
        method: "POST", urlPath: "/api/activity/log",
        body: { project: "../../../tmp/x", agent: "dev", type, timestamp: 3000 },
      });
      ok(trav.status === 400, `activity/log ${type} with a traversing project → 400`);
    }
    ok(
      !fs.existsSync(path.join(TEST_DIR, "tmp", "x", "activity.jsonl")) &&
        !fs.existsSync(path.join(os.tmpdir(), "x", "activity.jsonl")),
      "traversing project produced no out-of-tree write",
    );
    // An unconfigured (but non-traversing) project id is also rejected.
    const ghost = await req(server, {
      method: "POST", urlPath: "/api/activity/log",
      body: { project: "not-a-configured-project", agent: "dev", type: "start" },
    });
    ok(ghost.status === 400, "activity/log with an unconfigured project id → 400");

    // ── Guard 2: bridge reserved-sender ─────────────────────────────────────
    for (const reserved of ["head", "dev", "re1", "re2", "HEAD", "system"]) {
      const r = await req(server, {
        method: "POST", urlPath: `/api/chat?project=${PROJECT}`,
        headers: { "x-bridge-sender": reserved },
        body: { text: `posing as ${reserved}` },
      });
      ok(r.status === 403, `bridge message claiming reserved sender "${reserved}" → 403`);
    }
    // A non-reserved bridge sender is accepted and attributed to that name.
    const okBridge = await req(server, {
      method: "POST", urlPath: `/api/chat?project=${PROJECT}`,
      headers: { "x-bridge-sender": "discord-user" },
      body: { text: "hello from discord" },
    });
    ok(okBridge.status === 200, "non-reserved bridge sender → 200");
    ok(JSON.parse(okBridge.body).message.sender === "discord-user", "bridge sender attributed to the header name");

    // ── Guard 3: reviewer-token-path scoping ────────────────────────────────
    // Predicate: under ~/.quadwork or the worktree is allowed; anything else refused.
    ok(_reviewerTokenPathAllowed(path.join(CONFIG_DIR, "reviewer-token"), WT_DIR), "token under ~/.quadwork allowed");
    ok(_reviewerTokenPathAllowed(path.join(WT_DIR, "reviewer-token"), WT_DIR), "token under the worktree allowed");
    ok(!_reviewerTokenPathAllowed("/etc/passwd", WT_DIR), "token at /etc/passwd refused");
    ok(!_reviewerTokenPathAllowed(path.join(os.homedir(), ".ssh", "id_rsa"), WT_DIR), "token at ~/.ssh/id_rsa refused");
    ok(!_reviewerTokenPathAllowed(path.resolve(WT_DIR, "../../../etc/passwd"), WT_DIR), "traversal out of the worktree refused");

    // Integration: an out-of-root path in the worktree AGENTS.md is NOT used;
    // resolution falls through to the default token instead.
    fs.writeFileSync(path.join(WT_DIR, "AGENTS.md"), "export GH_TOKEN=$(cat /etc/passwd)\n");
    let resolved = _resolveReviewerTokenPath(PROJECT);
    ok(
      resolved.path !== "/etc/passwd" && resolved.source !== "worktree",
      "worktree AGENTS.md pointing at /etc/passwd is refused (falls back to default)",
    );
    ok(
      resolved.path === path.join(CONFIG_DIR, "reviewer-token") && resolved.source === "default",
      "refused worktree path → default ~/.quadwork/reviewer-token",
    );

    // An in-root worktree path IS honored.
    const inRoot = path.join(WT_DIR, "reviewer-token");
    fs.writeFileSync(path.join(WT_DIR, "AGENTS.md"), `export GH_TOKEN=$(cat ${inRoot})\n`);
    resolved = _resolveReviewerTokenPath(PROJECT);
    ok(
      resolved.path === inRoot && resolved.source === "worktree",
      "in-worktree token path is honored (source=worktree)",
    );

    console.log(`\n${passed} passed`);
    console.log("server/routes.securityGuards.test.js: all assertions passed");
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
