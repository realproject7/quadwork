// #972: shutdown() must actually tear down the orchestrator and file-chat.
// This boots the real server in-process on a THROWAWAY port (temp
// config, one bash-backed project, never port 8400), starts agent PTYs through
// the authenticated lifecycle API, then calls exported shutdown() and asserts
// clean exit, escalation of a READY-confirmed HUP-resistant child, and admission
// cancellation at the real await before spawn. Every exit path reaps only the
// children created by this test.
//
// (caffeinate is macOS-only, so its kill can't run here; it uses the same
// process.kill("SIGTERM") path. Unix PTYs instead receive node-pty's SIGHUP.)
//
// Run in its own child process by the test runner, so requiring index.js — which
// starts the server + pollers — is isolated. Plain node:assert script. Linux
// containment uses index.js's server-owned deterministic test fixture only;
// it is not reachable from an HTTP/config/environment input.

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
const post = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers }, (r) => {
    const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString() }));
  });
  req.on("error", reject);
  req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let idx;
const ownedTerms = new Set();
const exitedTerms = new WeakSet();
const fixtures = [];
let releaseArgs;

function ownTerm(term) {
  ownedTerms.add(term);
  term.onExit(() => exitedTerms.add(term));
  return term;
}

async function startOwned(port, agent, token) {
  fixtures.push(idx._test.installLifecycleTestFixture("lv", agent, "linux-contained"));
  const response = await post(port, `/api/agents/lv/${agent}/start`, { "X-Session-Token": token });
  assert.equal(response.status, 200, response.body);
  const term = idx.agentSessions.get(`lv/${agent}`)?.term;
  assert.ok(term?.pid);
  return ownTerm(term);
}

async function readyCommand(term, command, marker) {
  let output = "";
  let timer;
  let subscription;
  try {
    await new Promise((resolve, reject) => {
      subscription = term.onData((chunk) => {
        output += chunk;
        if (output.includes(marker)) resolve();
      });
      timer = setTimeout(() => reject(new Error(`PTY readiness timed out: ${marker}`)), 4000);
      term.write(command);
    });
  } finally {
    clearTimeout(timer);
    subscription?.dispose();
  }
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log(`  PASS: ${m}`); };

(async () => {
  const PORT = await freePort();
  fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({
    port: PORT,
    temp_cleanup: { enabled: false },
    projects: [{ id: "lv", name: "lv", working_dir: WORKDIR,
      agents: Object.fromEntries(["head", "dev", "re1"].map((role) => [role,
        { command: "/bin/bash", cwd: WORKDIR, mcp_inject: "none", auto_approve: false }])) }],
  }));

  // Boot the real server in-process (temp config → throwaway port).
  idx = require("./index");

  // Wait for listen.
  for (let i = 0; i < 60; i++) {
    try { const h = await get(PORT, "/api/health"); if (h.status === 200) break; } catch {}
    await sleep(100);
  }

  const origin = `http://127.0.0.1:${PORT}`;
  const token = JSON.parse((await get(PORT, "/api/session-token")).body).token;

  // A terminal viewer must remain attachment-only: its connection observes the
  // stopped lifecycle but cannot create an agent process.
  const stoppedViewer = await new Promise((resolve, reject) => {
    let opened = false;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?project=lv&agent=head&token=${token}`, { headers: { origin } });
    ws.on("open", () => { opened = true; });
    ws.on("close", (code) => resolve({ opened, code }));
    ws.on("unexpected-response", (_q, r) => reject(new Error(`WS refused ${r.statusCode}`)));
    ws.on("error", reject);
  });
  ok(stoppedViewer.opened && stoppedViewer.code === 1008, "terminal WS reports the stopped lifecycle without spawning");
  ok(!idx.agentSessions.get("lv/head")?.term, "terminal WS connection created no PTY");

  // F2: force the Linux admission branch without granting any proof. A normal
  // route start remains rejected while containedLaunch is false.
  const releaseUncontained = idx._test.installLifecycleTestFixture("lv", "head", "linux-uncontained");
  try {
    const rejected = await post(PORT, "/api/agents/lv/head/start", { "X-Session-Token": token });
    const rejectedBody = JSON.parse(rejected.body);
    assert.equal(rejected.status, 409, rejected.body);
    assert.equal(rejectedBody.code, "containment_unavailable");
    ok(!idx.agentSessions.get("lv/head")?.term, "normal Linux API start remains containment-unavailable");
  } finally {
    releaseUncontained();
  }

  // The authenticated lifecycle API, rather than the dashboard viewer, starts
  // the disposable bash PTY that this shutdown test owns through the scoped
  // test fixture. This exercises shutdown ownership, not production authority.
  const resistantTerm = await startOwned(PORT, "head", token);
  const cleanTerm = await startOwned(PORT, "re1", token);

  // Attach the terminal WS to the already-running PTY.
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
  ok(pid != null, "agent PTY spawned via the authenticated lifecycle API");
  ok(alive(pid), `agent PTY child (pid ${pid}) is running before shutdown`);

  // Split the marker in the command so terminal echo cannot satisfy readiness.
  await readyCommand(resistantTerm, 'trap "" HUP; printf "QW_%s\\n" RESISTANT_READY\r', "QW_RESISTANT_READY");
  await readyCommand(cleanTerm, 'printf "QW_%s\\n" CLEAN_READY\r', "QW_CLEAN_READY");
  let resistantExit;
  let cleanExit;
  resistantTerm.onExit((event) => { resistantExit = event; });
  cleanTerm.onExit((event) => { cleanExit = event; });
  ok(alive(resistantTerm.pid) && alive(cleanTerm.pid), "both owned children are ready and live before shutdown");

  // Pause an admitted launch at the same asynchronous boundary as production
  // argument construction. Resuming it after shutdown must never call spawn.
  fixtures.push(idx._test.installLifecycleTestFixture("lv", "dev", "linux-contained"));
  let entered;
  const atArgs = new Promise((resolve) => { entered = resolve; });
  const args = new Promise((resolve) => { releaseArgs = resolve; });
  let pendingSpawns = 0;
  const pendingStart = idx.spawnAgentPty("lv", "dev", {
    operatorAuthorized: true,
    explicitRole: true,
    buildAgentArgs: async () => { entered(); return args; },
    ptySpawn: (...options) => {
      pendingSpawns += 1;
      const term = require("node-pty").spawn(...options);
      return ownTerm(term);
    },
  });
  let barrierTimeout;
  try {
    await Promise.race([
      atArgs,
      pendingStart.then((result) => { throw new Error(`Launch never reached barrier: ${JSON.stringify(result)}`); }),
      new Promise((_, reject) => { barrierTimeout = setTimeout(() => reject(new Error("Launch barrier timed out")), 4000); }),
    ]);
  } finally { clearTimeout(barrierTimeout); }
  assert.equal(idx.agentSessions.get("lv/dev")?.term, undefined);

  const completion = idx.shutdown();
  assert.ok(completion instanceof Promise);
  assert.equal(idx.shutdown(), completion, "repeated shutdown joins the same completion");
  const lateStart = await idx.spawnAgentPty("lv", "dev", { operatorAuthorized: true, explicitRole: true });
  assert.equal(lateStart.code, "server_shutting_down");
  releaseArgs({ args: [] });
  const cancelled = await pendingStart;
  assert.equal(cancelled.code, "server_shutting_down");
  assert.equal(cancelled.lifecycle.state, "launch_failed", "reservation is released into a terminal lifecycle state");
  assert.equal(pendingSpawns, 0, "resumed admission never reaches the PTY constructor");
  ok(true, "shutdown fences new and already-admitted launches");

  const result = await completion;
  assert.equal(result.ok, true, JSON.stringify(result));
  // PID disappearance, not a sleep or lifecycle label, proves the child died.
  ok(!alive(pid), `shutdown() killed the HUP-resistant PTY child (pid ${pid})`);
  ok(!alive(cleanTerm.pid), `shutdown() killed the ordinary PTY child (pid ${cleanTerm.pid})`);
  for (let i = 0; i < 40 && (!resistantExit || !cleanExit); i++) await sleep(25);
  assert.equal(resistantExit?.signal, 9, "resistant child required SIGKILL escalation");
  assert.equal(cleanExit?.signal, 1, "ordinary child exited through graceful SIGHUP");
  assert.equal(idx.agentSessions.get("lv/head").lifecycleState, "stopped");
  assert.equal(idx.agentSessions.get("lv/head").exitedUnexpectedly, false);
  assert.equal(idx.agentSessions.get("lv/head").viewers.size, 0);

  assert.equal(idx.shutdown(), completion, "completed shutdown remains idempotent");
  assert.equal(await idx.shutdown(), result);
  ok(true, "shutdown has one truthful, idempotent completion");

  console.log(`\n${passed} passed`);
  console.log("server/shutdownCleanup.test.js: all assertions passed");
})().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
}).finally(async () => {
  releaseArgs?.({ args: [] });
  // Even a failed assertion owns its children. Observe each exact PTY's exit
  // and reap it before exiting the test process, without broad process kills.
  if (idx) for (const session of idx.agentSessions.values()) if (session.term && !ownedTerms.has(session.term)) ownTerm(session.term);
  for (const term of ownedTerms) {
    if (!exitedTerms.has(term) && alive(term.pid)) term.kill("SIGKILL");
    for (let i = 0; i < 100 && !exitedTerms.has(term) && alive(term.pid); i++) await sleep(25);
    if (!exitedTerms.has(term) && alive(term.pid)) { console.error(`Owned child cleanup failed: ${term.pid}`); process.exitCode = 1; }
  }
  if (idx) await idx.shutdown();
  for (const release of fixtures) release();
  process.exit(process.exitCode || 0);
});
