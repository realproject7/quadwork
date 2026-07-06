// #972: shutdown() must actually tear down the orchestrator, not just butler +
// file-chat. This boots the real server in-process on a THROWAWAY port (temp
// HOME, one bash-backed project, never port 8400), spawns an agent PTY through
// the authed terminal WebSocket, then calls the exported shutdown() and asserts:
//   - the agent PTY child process is killed (no orphan holding a worktree lock),
//   - shutdown() is idempotent (a second call doesn't throw).
//
// (caffeinate is macOS-only, so its kill can't run here; it uses the same
// process.kill("SIGTERM") path exercised by the PTY teardown below.)
//
// Run in its own child process by the test runner, so requiring index.js — which
// starts the server + pollers — is isolated. Plain node:assert script.

const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const TMP = path.join(os.tmpdir(), `shutdown-cleanup-${process.pid}-${Date.now()}`);
const CONFIG_DIR = path.join(TMP, ".quadwork");
const WORKDIR = path.join(TMP, "work");
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(WORKDIR, { recursive: true });

const origHome = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => { os.homedir = origHome; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: p }, (r) => {
    const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString() }));
  }).on("error", reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log(`  PASS: ${m}`); };

(async () => {
  const PORT = await freePort();
  fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({
    port: PORT,
    projects: [{ id: "lv", name: "lv", working_dir: WORKDIR,
      agents: { head: { command: "/bin/bash", cwd: WORKDIR, mcp_inject: "none", auto_approve: false } } }],
  }));

  // Boot the real server in-process (temp config → throwaway port).
  const idx = require("./index");

  // Wait for listen.
  for (let i = 0; i < 60; i++) {
    try { const h = await get(PORT, "/api/health"); if (h.status === 200) break; } catch {}
    await sleep(100);
  }

  const origin = `http://127.0.0.1:${PORT}`;
  const token = JSON.parse((await get(PORT, "/api/session-token")).body).token;

  // Attach the terminal WS → spawns the bash agent PTY.
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?project=lv&agent=head&token=${token}`, { headers: { origin } });
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (_q, r) => reject(new Error(`WS refused ${r.statusCode}`)));
    ws.on("error", reject);
  });

  // Poll until the PTY exists, then capture the child pid.
  let pid = null;
  for (let i = 0; i < 40; i++) {
    const s = idx.agentSessions.get("lv/head");
    if (s && s.term && s.term.pid) { pid = s.term.pid; break; }
    await sleep(100);
  }
  ok(pid != null, "agent PTY spawned via the authed terminal WS");
  ok(alive(pid), `agent PTY child (pid ${pid}) is running before shutdown`);

  // The fix under test.
  idx.shutdown();

  // Give the SIGTERM time to reap the child.
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(100);
  ok(!alive(pid), `shutdown() killed the agent PTY child (pid ${pid}) — no orphan`);

  // Idempotent: a second shutdown() (SIGINT then SIGTERM, or full-reset) is safe.
  assert.doesNotThrow(() => idx.shutdown(), "shutdown() is idempotent");
  ok(true, "shutdown() is idempotent (second call does not throw)");

  console.log(`\n${passed} passed`);
  console.log("server/shutdownCleanup.test.js: all assertions passed");
  process.exit(0);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
