// #968: WS/PTY auth — Origin allowlist + shared session token on the
// terminal WebSocket and the PTY-write REST endpoints (EPIC #967 Phase 1).
//
// Boots the REAL server as a subprocess on a THROWAWAY port with a temp HOME
// (empty config, no projects, never port 8400 / the live orchestrator) and
// drives the actual server.on("upgrade") handler + routes over the wire:
//   - GET /api/session-token (localhost) hands out the auto-provisioned token.
//   - WS upgrade with a foreign Origin        → 403 (no open).
//   - WS upgrade with a valid Origin, no token → 401 (no open).
//   - WS upgrade with valid Origin + token     → 101 (opens).
//   - POST /write, /interrupt without a token  → 401.
//   - POST /write with a token, no session     → 404 (token accepted).
//
// Plain node:assert script — run with `node server/wsPtyAuth.test.js`.

const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const TMP_HOME = path.join(os.tmpdir(), `ws-pty-auth-${process.pid}-${Date.now()}`);
const CONFIG_DIR = path.join(TMP_HOME, ".quadwork");

let child;
function cleanup() {
  try { if (child && !child.killed) child.kill("SIGKILL"); } catch {}
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForListen(proc, port) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in time")), 15000);
    const onData = (buf) => {
      if (buf.toString().includes(`listening on http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code})`)); });
  });
}

function httpReq(port, { method = "GET", path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function tryWs(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 5000 });
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { ws.terminate(); } catch {} resolve(r); } };
    ws.on("open", () => done({ open: true }));
    ws.on("unexpected-response", (_req, res) => done({ open: false, status: res.statusCode }));
    ws.on("error", (err) => done({ open: false, error: String(err.message || err) }));
  });
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log(`  PASS: ${m}`); };

(async () => {
  const PORT = await freePort();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({ port: PORT, projects: [] }));

  child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // drain

  await waitForListen(child, PORT);
  const origin = `http://127.0.0.1:${PORT}`;

  // Token is auto-provisioned and handed to the local dashboard.
  const tokRes = await httpReq(PORT, { path: "/api/session-token" });
  ok(tokRes.status === 200, "GET /api/session-token (localhost) → 200");
  const token = JSON.parse(tokRes.body).token;
  ok(typeof token === "string" && token.length >= 32, "session token is a non-trivial secret");

  // ── WS upgrade auth ──────────────────────────────────────────────────────
  const wsPath = `/ws/terminal?project=x&agent=head`;
  const foreign = await tryWs(`ws://127.0.0.1:${PORT}${wsPath}&token=${token}`, { origin: "http://evil.example" });
  ok(foreign.open === false && foreign.status === 403, "WS with a foreign Origin → 403, not opened");

  const noOrigin = await tryWs(`ws://127.0.0.1:${PORT}${wsPath}&token=${token}`, {});
  ok(noOrigin.open === false && noOrigin.status === 403, "WS with absent Origin → 403, not opened");

  const noToken = await tryWs(`ws://127.0.0.1:${PORT}${wsPath}`, { origin });
  ok(noToken.open === false && noToken.status === 401, "WS with valid Origin but no token → 401, not opened");

  const badToken = await tryWs(`ws://127.0.0.1:${PORT}${wsPath}&token=wrong`, { origin });
  ok(badToken.open === false && badToken.status === 401, "WS with a wrong token → 401, not opened");

  const good = await tryWs(`ws://127.0.0.1:${PORT}${wsPath}&token=${token}`, { origin });
  ok(good.open === true, "WS with valid Origin + token → upgrade accepted (opens)");

  // ── REST PTY-write auth ──────────────────────────────────────────────────
  const writeNoTok = await httpReq(PORT, { method: "POST", path: "/api/agents/x/head/write", body: JSON.stringify({ text: "hi\n" }) });
  ok(writeNoTok.status === 401, "POST /write without a token → 401");

  const writeBadTok = await httpReq(PORT, { method: "POST", path: "/api/agents/x/head/write", headers: { "x-session-token": "wrong" }, body: JSON.stringify({ text: "hi\n" }) });
  ok(writeBadTok.status === 401, "POST /write with a wrong token → 401");

  const writeTok = await httpReq(PORT, { method: "POST", path: "/api/agents/x/head/write", headers: { "x-session-token": token }, body: JSON.stringify({ text: "hi\n" }) });
  ok(writeTok.status === 404, "POST /write with a valid token but no session → 404 (token accepted, then no session)");

  const interruptNoTok = await httpReq(PORT, { method: "POST", path: "/api/agents/x/head/interrupt" });
  ok(interruptNoTok.status === 401, "POST /interrupt without a token → 401");

  const interruptTok = await httpReq(PORT, { method: "POST", path: "/api/agents/x/head/interrupt", headers: { "x-session-token": token } });
  ok(interruptTok.status === 200, "POST /interrupt with a valid token → 200 (token accepted)");

  // ── The token must never leak through GET /api/config ────────────────────
  const cfgGet = await httpReq(PORT, { path: "/api/config" });
  const cfgObj = JSON.parse(cfgGet.body);
  ok(!("session_token" in cfgObj), "GET /api/config does NOT expose session_token");

  // ── A whole-config PUT (which never carries the redacted token) preserves it ─
  const putRes = await httpReq(PORT, { method: "PUT", path: "/api/config", body: JSON.stringify(cfgObj) });
  ok(putRes.status === 200, "PUT /api/config (redacted snapshot) → 200");
  const tokAfter = await httpReq(PORT, { path: "/api/session-token" });
  ok(JSON.parse(tokAfter.body).token === token, "session_token survives a whole-config PUT (not clobbered)");

  console.log(`\n${passed} passed`);
  console.log("server/wsPtyAuth.test.js: all assertions passed");
  process.exit(0);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
