// #988: reverse-proxy dashboard allowlist — trusted_dashboard_hosts lets an
// on-box AUTHENTICATED reverse proxy (nginx: p7.quadwork.xyz -> 127.0.0.1:8400,
// proxy_set_header Host $host) fetch /api/session-token and open the terminal
// WS, WITHOUT weakening #968's DNS-rebinding protection for any host NOT in the
// allowlist. Regression guard for the v2.5.1 hotfix.
//
// Boots the REAL server as a subprocess on a THROWAWAY port with a temp HOME
// whose config.json sets `trusted_dashboard_hosts: ["p7.quadwork.xyz"]`, then
// drives the actual server.on("upgrade") handler + /api/session-token over the
// wire. Security invariants proven here:
//   (a) trusted host in allowlist   → token 200 + WS opens
//   (b) foreign host not in allowlist → token 403 + WS upgrade rejected
//   (c) plain loopback              → unchanged (token 200, local dashboard OK)
//   (d) partial spoof (only Host OR only Origin trusted) → rejected
//
// A companion (case c with NO allowlist at all) is covered by wsPtyAuth.test.js,
// which boots with an empty config and asserts loopback-only behavior.
//
// Plain node:assert script — run with `node server/proxyDashboardAllowlist.test.js`.

const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const TRUSTED = "p7.quadwork.xyz";
const TMP_HOME = path.join(os.tmpdir(), `proxy-allowlist-${process.pid}-${Date.now()}`);
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

// Drive the WS with explicit Host/Origin headers so we can simulate what nginx
// forwards (and what an attacker page could try). `ws` lets options.headers
// override the auto-computed Host.
function tryWs(port, query, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${query}`, { headers, handshakeTimeout: 5000 });
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
  fs.writeFileSync(
    path.join(CONFIG_DIR, "config.json"),
    JSON.stringify({ port: PORT, projects: [], trusted_dashboard_hosts: [TRUSTED] }),
  );

  child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // drain

  await waitForListen(child, PORT);
  const wsPath = `/ws/terminal?project=x&agent=head`;

  // ── (a) Trusted reverse-proxy host: token fetch succeeds ─────────────────
  // nginx forwards Host: p7.quadwork.xyz, browser sends Origin: https://p7...
  const proxyHeaders = { host: TRUSTED, origin: `https://${TRUSTED}` };
  const tokRes = await httpReq(PORT, { path: "/api/session-token", headers: proxyHeaders });
  ok(tokRes.status === 200, "(a) GET /api/session-token via trusted proxy Host+Origin → 200");
  const token = JSON.parse(tokRes.body).token;
  ok(typeof token === "string" && token.length >= 32, "(a) trusted proxy receives the real session token");

  // Bare Host (no Origin, e.g. a non-CORS fetch through the proxy) also OK.
  const tokHostOnly = await httpReq(PORT, { path: "/api/session-token", headers: { host: `${TRUSTED}:443` } });
  ok(tokHostOnly.status === 200, "(a) GET /api/session-token via trusted Host:port, no Origin → 200");

  // ── (c) Plain loopback still works with an allowlist configured ──────────
  const tokLoop = await httpReq(PORT, { path: "/api/session-token", headers: { host: `localhost:${PORT}` } });
  ok(tokLoop.status === 200, "(c) GET /api/session-token from loopback (local dashboard) → 200, unchanged");
  ok(JSON.parse(tokLoop.body).token === token, "(c) loopback dashboard gets the same token");

  // ── (b) Foreign host NOT in the allowlist: token 403 (DNS-rebind intact) ─
  const foreignHost = await httpReq(PORT, { path: "/api/session-token", headers: { host: "evil.example" } });
  ok(foreignHost.status === 403, "(b) GET /api/session-token with a foreign Host (not allowlisted) → 403");
  const foreignOrigin = await httpReq(PORT, { path: "/api/session-token", headers: { host: `localhost:${PORT}`, origin: "https://evil.example" } });
  ok(foreignOrigin.status === 403, "(b) GET /api/session-token with a foreign Origin (not allowlisted) → 403");

  // ── (d) Partial spoof: only ONE of Host/Origin is trusted → 403 ──────────
  const spoofOrigin = await httpReq(PORT, { path: "/api/session-token", headers: { host: TRUSTED, origin: "https://evil.example" } });
  ok(spoofOrigin.status === 403, "(d) trusted Host but foreign Origin → 403 (both must be allowlisted)");
  const spoofHost = await httpReq(PORT, { path: "/api/session-token", headers: { host: "evil.example", origin: `https://${TRUSTED}` } });
  ok(spoofHost.status === 403, "(d) foreign Host but trusted Origin → 403");

  // ── (a) WS: trusted proxy Origin + Host + token → upgrade accepted ───────
  const wsGood = await tryWs(PORT, `${wsPath}&token=${token}`, proxyHeaders);
  ok(wsGood.open === true, "(a) WS via trusted proxy Origin+Host + token → opens");

  // ── (a) WS: trusted proxy, no token → 401 (origin OK, token still required) ─
  const wsNoTok = await tryWs(PORT, wsPath, proxyHeaders);
  ok(wsNoTok.open === false && wsNoTok.status === 401, "(a) WS via trusted proxy but no token → 401");

  // ── (b) WS: foreign Origin (realistic browser: Host stays loopback) → 403 ─
  const wsForeign = await tryWs(PORT, `${wsPath}&token=${token}`, { origin: "https://evil.example" });
  ok(wsForeign.open === false && wsForeign.status === 403, "(b) WS with a foreign Origin (not allowlisted) → 403, not opened");

  // ── (d) WS: partial spoof (trusted Host, foreign Origin) → 403 ───────────
  const wsSpoof = await tryWs(PORT, `${wsPath}&token=${token}`, { host: TRUSTED, origin: "https://evil.example" });
  ok(wsSpoof.open === false && wsSpoof.status === 403, "(d) WS with trusted Host but foreign Origin → 403, not opened");

  // ── (b) WS: MATCHED foreign Host+Origin (both evil.example) + VALID token ──
  // The #968 same-host fallback must NOT open the WS here: the socket is loopback
  // (an on-box/DNS-rebound proxy), the host is not allowlisted, so the forged pair
  // is rejected despite a valid token. Regression guard for the #988 invariant.
  const wsForgedMatch = await tryWs(PORT, `${wsPath}&token=${token}`, { host: "evil.example", origin: "http://evil.example" });
  ok(wsForgedMatch.open === false && wsForgedMatch.status === 403,
    "(b) WS with matched foreign Host+Origin (not allowlisted) + valid token → 403, not opened");

  console.log(`\n${passed} passed`);
  console.log("server/proxyDashboardAllowlist.test.js: all assertions passed");
  process.exit(0);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
