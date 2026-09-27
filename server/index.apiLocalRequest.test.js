"use strict";

// #1215: every /api route accepts a request only from the local dashboard, a
// local tool, or an operator-trusted on-box reverse proxy (#988). The rule is
// isLocalApiRequest in server/index.js, mounted ahead of the JSON body parser
// and of every /api route. A request gets 403 unless:
//   - its socket is loopback;
//   - its Host names a loopback host or a trusted_dashboard_hosts entry;
//   - its Origin, when sent, does too;
//   - its Sec-Fetch-Site, when sent, is not cross-site.
//
// The real server/index.js app runs in this process behind two listeners on
// ephemeral ports. The first hands each request to the app unchanged and
// records the Host, Origin, Sec-Fetch-Site and response status it saw. The
// second first sets the socket's remoteAddress, which the rule reads, to a
// non-loopback address.
//
// Pinned here:
//   - PUT /api/config and GET /api/batch-progress, refused on each clause, get
//     403 and change nothing under the test's temporary root;
//   - the same refusal on other /api paths: a resource route registered outside
//     server/routes.js, an index.js route, an unknown path, a case variant, and
//     a malformed JSON body (the rule runs before the parser);
//   - the allowed variants of each clause, a trusted reverse-proxy host, and
//     /api/session-token keeping its stricter rule;
//   - each in-repo caller of the HTTP API still gets through, with the Host,
//     Origin and Sec-Fetch-Site it sends: `next dev`'s /api rewrite (Next's own
//     proxy code), the MCP chat shim, the Head-control shim, the operator MCP,
//     the Telegram and Discord bridges, and the server's own loopback requests
//     (bridge stop, history restore re-post). bin/quadwork.js makes no HTTP API
//     request.
//
// Run through `npm test` (server/run-tests.js), never directly.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { isDeepStrictEqual } = require("util");

// #1188: a temporary HOME, never the real ~/.quadwork. Spawned shims inherit it.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-api-local-")));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME);
Object.assign(process.env, { HOME, USERPROFILE: HOME, QUADWORK_SKIP_LISTEN: "1" });
process.on("exit", () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const CONFIG_DIR = path.join(HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const PROJECT = "p1";
const PROJECT_DIR = path.join(CONFIG_DIR, PROJECT);
// GET /api/batch-progress on a queue with an empty Active Batch deletes this
// row cache, so a request that reaches the route shows up on disk.
const CACHE = path.join(PROJECT_DIR, "batch-progress-cache.json");
const TRUSTED = "dash.example";
const REMOTE_ADDRESS = "203.0.113.7";
const SHIM_TOKEN = "api-local-rule-shim-token";

let runtime;
let fileChat;
let server;
let remoteServer;
let PORT;
let REMOTE_PORT;
const seen = [];

// Hands the request to the real app. `remoteAddress`, when set, replaces the
// socket address the app reads.
function listener(remoteAddress) {
  return (req, res) => {
    const record = {
      method: req.method,
      path: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      site: req.headers["sec-fetch-site"],
      forwardedHost: req.headers["x-forwarded-host"],
      status: null,
    };
    seen.push(record);
    const writeHead = res.writeHead;
    res.writeHead = function (status, ...rest) {
      record.status = status;
      return writeHead.call(this, status, ...rest);
    };
    if (remoteAddress) Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress, configurable: true });
    runtime.app(req, res);
  };
}

function listen(target) {
  return new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
}

function close(target) {
  return new Promise((resolve) => target.close(() => resolve()));
}

// `body` is JSON-encoded; `rawBody` is sent as is.
function send({ method = "GET", path: urlPath, headers = {}, body, rawBody, port = PORT }) {
  return new Promise((resolve, reject) => {
    const text = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : null;
    const payload = text === null ? null : Buffer.from(text);
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: urlPath,
      agent: false,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function plantCache() {
  fs.writeFileSync(CACHE, "{}\n", { mode: 0o600 });
}

// Every path under ROOT with its type, size, mode and mtime: a file or
// directory created, changed (even by chmod alone) or removed anywhere under
// the root shows up in changes().
function snapshot(dir = ROOT, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const stat = fs.lstatSync(full);
    out.set(path.relative(ROOT, full), `${entry.isDirectory() ? "dir" : "file"}:${stat.size}:${stat.mode.toString(8)}:${stat.mtimeMs}`);
    if (entry.isDirectory()) snapshot(full, out);
  }
  return out;
}

function changes(beforeSnapshot, afterSnapshot) {
  const out = [];
  for (const [p, value] of afterSnapshot) {
    if (!beforeSnapshot.has(p)) out.push(`created ${p}`);
    else if (beforeSnapshot.get(p) !== value) out.push(`changed ${p}`);
  }
  for (const p of beforeSnapshot.keys()) if (!afterSnapshot.has(p)) out.push(`removed ${p}`);
  return out.sort();
}

// A "before" snapshot with the mtimes of ~/.quadwork and ~/.quadwork/p1 set to
// 0, so an entry made or removed in either moves its mtime whatever the file
// system's timestamp precision.
function baselineSnapshot() {
  fs.utimesSync(CONFIG_DIR, 0, 0);
  fs.utimesSync(PROJECT_DIR, 0, 0);
  return snapshot();
}

// The two routes with side effects. PUT /api/config would rewrite config.json;
// GET /api/batch-progress would delete the planted row cache.
function sideEffectRequests() {
  return [
    { route: "PUT /api/config", method: "PUT", path: "/api/config", body: { ...readConfig(), operator_name: "changedByRequest" } },
    { route: "GET /api/batch-progress", method: "GET", path: `/api/batch-progress?project=${PROJECT}` },
  ];
}

const loopbackHost = () => `127.0.0.1:${PORT}`;

// Runs each request against each case; every one must get the rule's 403 and
// leave the root untouched. A failure lists each case that went wrong.
async function assertRefused(requests, cases) {
  const wrong = [];
  for (const request of requests) {
    for (const { label, headers, remote } of cases) {
      plantCache();
      const beforeSnapshot = baselineSnapshot();
      const response = await send({ ...request, headers, port: remote ? REMOTE_PORT : PORT });
      const actual = { status: response.status, error: response.json?.error, touched: changes(beforeSnapshot, snapshot()) };
      const expected = { status: 403, error: "Local access only", touched: [] };
      if (!isDeepStrictEqual(actual, expected)) wrong.push({ request: request.route, case: label, actual, expected });
    }
  }
  assert.deepEqual(wrong, []);
}

// A stdio JSON-RPC child (an MCP shim or the operator MCP).
function startStdio(args) {
  const proc = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  const waiters = new Map();
  let buffered = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter(message); }
    }
  });
  proc.stderr.resume();
  return {
    call(id, name, args) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply to ${name}`)), 10000);
        waiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
    },
    stop() {
      proc.stdin.end();
      return new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) resolve();
        else proc.once("close", resolve);
      });
    },
  };
}

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function chatMessages() {
  return fileChat.readMessages(PROJECT, { limit: 500 });
}

// The Host, Origin and Sec-Fetch-Site of each recorded request to a path.
function sent(prefix) {
  return seen
    .filter((record) => record.path.startsWith(prefix))
    .map(({ method, host, origin, site, status }) => ({ method, host, origin, site, status }));
}

// What a Node HTTP client (http.request or fetch) to 127.0.0.1 sends.
const nodeClient = (method, status) => ({ method, host: loopbackHost(), origin: undefined, site: undefined, status });

// A bridge polls GET /api/chat on a timer, so how many GETs it sent varies,
// and one in flight at stop may have no status. Every request carries the Node
// client's headers, none is refused, a GET succeeded, and the one inbound
// message was posted.
function assertBridgeRequests() {
  const requests = sent("/api/chat");
  assert.deepEqual(
    requests.map(({ method, host, origin, site }) => ({ method, host, origin, site })),
    requests.map(({ method }) => ({ method, host: loopbackHost(), origin: undefined, site: undefined })),
  );
  assert.ok(requests.every((r) => r.status !== 403));
  assert.ok(requests.some((r) => r.method === "GET" && r.status === 200));
  assert.deepEqual(requests.filter((r) => r.method === "POST"), [nodeClient("POST", 200)]);
}

before(async () => {
  server = http.createServer(listener(null));
  remoteServer = http.createServer(listener(REMOTE_ADDRESS));
  await listen(server);
  await listen(remoteServer);
  PORT = server.address().port;
  REMOTE_PORT = remoteServer.address().port;

  fs.mkdirSync(PROJECT_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CONFIG_DIR, 0o700);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    // The server's own loopback requests (history restore) go to this port.
    port: PORT,
    session_token: "api-local-rule-session-token",
    trusted_dashboard_hosts: [TRUSTED],
    operator_name: "operator",
    projects: [{ id: PROJECT, name: PROJECT, repo: "acme/p1", working_dir: path.join(ROOT, "work", PROJECT), agents: {}, chat_mode: "file" }],
  }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(PROJECT_DIR, "OVERNIGHT-QUEUE.md"), "# Queue\n\n## Active Batch\n\n", { mode: 0o600 });

  runtime = require("./index");
  fileChat = require("./file-chat");
  fileChat.initProject(PROJECT);
});

after(async () => {
  if (runtime) await runtime.shutdown();
  if (server) await close(server);
  if (remoteServer) await close(remoteServer);
});

test("PUT /api/config and GET /api/batch-progress, refused on each clause, get 403 and change nothing", async () => {
  await assertRefused(sideEffectRequests(), [
    { label: "a foreign Host", headers: { host: "evil.example" } },
    { label: "a foreign Host with a port", headers: { host: "evil.example:8400" } },
    { label: "a foreign Origin", headers: { host: loopbackHost(), origin: "http://evil.example" } },
    { label: "Origin: null", headers: { host: loopbackHost(), origin: "null" } },
    { label: "a foreign Origin behind a trusted Host", headers: { host: TRUSTED, origin: "http://evil.example" } },
    // A no-cors request from another site's page, e.g. an <img>: no Origin.
    { label: "Sec-Fetch-Site: cross-site", headers: { host: loopbackHost(), "sec-fetch-site": "cross-site" } },
    { label: "Sec-Fetch-Site: cross-site from a loopback Origin", headers: { host: `localhost:${PORT}`, origin: "http://localhost:3001", "sec-fetch-site": "cross-site" } },
    { label: "a non-loopback socket", remote: true, headers: { host: loopbackHost() } },
    { label: "a non-loopback socket with a trusted Host", remote: true, headers: { host: TRUSTED, origin: `https://${TRUSTED}` } },
  ]);
});

test("the rule runs before every /api route and before the JSON body parser", async () => {
  const foreign = { label: "a foreign Host", headers: { host: "evil.example" } };
  await assertRefused([
    { route: "GET /api/resources (server/resource-http.js)", method: "GET", path: "/api/resources" },
    { route: "GET /api/health (server/index.js)", method: "GET", path: "/api/health" },
    { route: "GET /api/config (server/routes.js)", method: "GET", path: "/api/config" },
    { route: "GET an unknown /api path", method: "GET", path: "/api/no-such-route" },
    { route: "GET /API/config (a case variant)", method: "GET", path: "/API/config" },
    { route: "PUT /api/config/ (a trailing slash)", method: "PUT", path: "/api/config/", body: { ...readConfig(), operator_name: "changedByRequest" } },
    { route: "PUT /api/config with a malformed JSON body", method: "PUT", path: "/api/config", rawBody: "{not json" },
  ], [foreign]);
  // The case variant reaches the route when the request is allowed, so the
  // refusal above is the rule's.
  const allowed = await send({ path: "/API/config" });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.projects[0].id, PROJECT);
});

test("allowed variants of each clause pass and reach the route", async () => {
  const cases = [
    { label: "the dashboard on 127.0.0.1", headers: { host: loopbackHost(), origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" } },
    { label: "the dashboard on localhost", headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, "sec-fetch-site": "same-origin" } },
    { label: "a typed URL (Sec-Fetch-Site: none)", headers: { host: loopbackHost(), "sec-fetch-site": "none" } },
    { label: "a local page on another port (Sec-Fetch-Site: same-site)", headers: { host: `localhost:${PORT}`, origin: "http://localhost:3000", "sec-fetch-site": "same-site" } },
    { label: "a local tool (no Origin, no Sec-Fetch-Site)", headers: { host: loopbackHost() } },
    { label: "a trusted reverse-proxy host", headers: { host: TRUSTED, origin: `https://${TRUSTED}`, "sec-fetch-site": "same-origin" } },
    { label: "a trusted reverse-proxy host with a port", headers: { host: `${TRUSTED}:443`, origin: `https://${TRUSTED}`, "sec-fetch-site": "same-origin" } },
  ];
  const wrong = [];
  for (const [index, { label, headers }] of cases.entries()) {
    const name = `allowed${index}`;
    const write = await send({ method: "PUT", path: "/api/config", headers, body: { ...readConfig(), operator_name: name } });
    const written = readConfig().operator_name;
    plantCache();
    const read = await send({ path: `/api/batch-progress?project=${PROJECT}`, headers });
    const actual = { write: write.status, written, read: read.status, cacheLeft: fs.existsSync(CACHE) };
    const expected = { write: 200, written: name, read: 200, cacheLeft: false };
    if (!isDeepStrictEqual(actual, expected)) wrong.push({ case: label, actual, expected });
  }
  assert.deepEqual(wrong, []);
});

test("/api/session-token keeps its stricter rule on top", async () => {
  // A loopback Host with a trusted proxy's Origin passes the API rule, but
  // neither isLocalTokenRequest nor isTrustedProxyRequest.
  const mixed = { host: loopbackHost(), origin: `https://${TRUSTED}` };
  assert.equal((await send({ path: "/api/config", headers: mixed })).status, 200);
  assert.equal((await send({ path: "/api/session-token", headers: mixed })).status, 403);
  assert.equal((await send({ path: "/api/session-token", headers: { host: loopbackHost() } })).status, 200);
  assert.equal((await send({ path: "/api/session-token", headers: { host: TRUSTED, origin: `https://${TRUSTED}` } })).status, 200);
});

test("`next dev`'s /api rewrite sends a loopback Host and the browser's Origin and Sec-Fetch-Site", async () => {
  // Next's own rewrite proxy (node_modules/next): http-proxy with
  // changeOrigin, so the Host becomes the destination's, plus
  // x-forwarded-host. The destination is next.config.ts's rewrite with this
  // test's port in place of 8400.
  const { proxyRequest } = require("next/dist/server/lib/router-utils/proxy-request");
  const { parseUrl } = require("next/dist/shared/lib/router/utils/parse-url");
  const front = http.createServer((req, res) => {
    proxyRequest(req, res, parseUrl(`http://127.0.0.1:${PORT}${req.url}`)).catch(() => {});
  });
  await listen(front);
  const frontPort = front.address().port;
  try {
    seen.length = 0;
    const page = { host: `localhost:${frontPort}`, "sec-fetch-site": "same-origin" };
    const read = await send({ port: frontPort, path: "/api/config", headers: page });
    assert.equal(read.status, 200);
    assert.equal(read.json.projects[0].id, PROJECT);
    const write = await send({
      port: frontPort, method: "PUT", path: "/api/config",
      headers: { ...page, origin: `http://localhost:${frontPort}` },
      body: { ...readConfig(), operator_name: "viaNextDev" },
    });
    assert.equal(write.status, 200);
    assert.equal(readConfig().operator_name, "viaNextDev");
    assert.deepEqual(seen.map(({ method, host, origin, site, forwardedHost, status }) => ({ method, host, origin, site, forwardedHost, status })), [
      { method: "GET", host: loopbackHost(), origin: undefined, site: "same-origin", forwardedHost: `localhost:${frontPort}`, status: 200 },
      { method: "PUT", host: loopbackHost(), origin: `http://localhost:${frontPort}`, site: "same-origin", forwardedHost: `localhost:${frontPort}`, status: 200 },
    ]);
  } finally {
    await close(front);
  }
});

test("the MCP chat shim gets through", async () => {
  fileChat.registerShimToken(PROJECT, "dev", SHIM_TOKEN);
  const shim = startStdio([path.join(__dirname, "mcp-chat-shim.js"), "--project", PROJECT, "--agent", "dev", "--port", String(PORT), "--token", SHIM_TOKEN]);
  try {
    seen.length = 0;
    const read = await shim.call(1, "chat_read", {});
    assert.equal(read.error, undefined, JSON.stringify(read.error));
    assert.ok(Array.isArray(JSON.parse(read.result.content[0].text).messages));
    const write = await shim.call(2, "chat_send", { message: "hello from the chat shim" });
    assert.equal(write.error, undefined, JSON.stringify(write.error));
    assert.ok(chatMessages().some((m) => m.sender === "dev" && m.text === "hello from the chat shim"));
    assert.deepEqual(sent("/api/chat"), [nodeClient("GET", 200), nodeClient("POST", 200)]);
  } finally {
    await shim.stop();
  }
});

test("the Head-control shim gets through to its route", async () => {
  const shim = startStdio([
    path.join(__dirname, "mcp-head-control-shim.js"),
    "--project", PROJECT, "--agent", "head", "--generation", "0", "--port", String(PORT), "--token", "t".repeat(32),
  ]);
  try {
    seen.length = 0;
    await shim.call(1, "get_pipeline_status", { idempotency_key: "idem_status_001", correlation_id: "corr_status_001" });
    // The route itself answers the unregistered launch token with 401.
    assert.deepEqual(sent("/api/head-control"), [nodeClient("POST", 401)]);
  } finally {
    await shim.stop();
  }
});

test("the operator MCP gets through", async () => {
  const operator = startStdio([path.join(__dirname, "mcp-operator.js"), "--port", String(PORT)]);
  try {
    seen.length = 0;
    const reply = await operator.call(1, "list_projects", {});
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.deepEqual(JSON.parse(reply.result.content[0].text).map((p) => p.id), [PROJECT]);
    assert.deepEqual(sent("/api/config"), [nodeClient("GET", 200)]);
  } finally {
    await operator.stop();
  }
});

test("the Telegram bridge gets through", async () => {
  const telegramBridge = require("./bridges/telegram");
  const realFetch = global.fetch;
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  let updateServed = false;
  // Only the Telegram Bot API is stubbed; the bridge's requests to QuadWork go
  // through Node's fetch unchanged.
  global.fetch = (input, init) => {
    const target = String(input);
    if (!target.startsWith("https://api.telegram.org/")) return realFetch(input, init);
    if (target.includes("/getUpdates") && !updateServed) {
      updateServed = true;
      return Promise.resolve(reply({ ok: true, result: [{ update_id: 1, message: { text: "hello from telegram", from: { username: "operator" }, chat: { id: "chat-1" } } }] }));
    }
    return Promise.resolve(reply({ ok: true, result: [] }));
  };
  try {
    seen.length = 0;
    await telegramBridge.start(PROJECT, "test-bot-token", "chat-1", PORT, { isAuthorityCurrent: () => true });
    await waitFor(() => chatMessages().some((m) => m.sender === "tg:operator" && m.text === "hello from telegram"), "the Telegram message");
    await telegramBridge.stop(PROJECT);
  } finally {
    global.fetch = realFetch;
  }
  assertBridgeRequests();
});

test("the Discord bridge gets through", async () => {
  const discordBridge = require("./bridges/discord");
  let onMessage = null;
  class FakeClient {
    constructor() { this.channels = { fetch: async () => ({ send: async () => {} }) }; }
    login() { return Promise.resolve("ok"); }
    on(event, handler) { if (event === "messageCreate") onMessage = handler; }
    async destroy() {}
  }
  discordBridge._setDiscordLibForTest({ Client: FakeClient, GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 } });
  seen.length = 0;
  await discordBridge.start(PROJECT, "test-bot-token", "channel-1", PORT, { isAuthorityCurrent: () => true });
  await onMessage({ author: { bot: false, username: "operator" }, channel: { id: "channel-1" }, content: "hello from discord" });
  assert.ok(chatMessages().some((m) => m.sender === "dc:operator" && m.text === "hello from discord"));
  await discordBridge.stop(PROJECT);
  assertBridgeRequests();
});

test("the server's own loopback requests get through", async () => {
  // Bridge auto-stop: POST /api/telegram and /api/discord through Node's fetch.
  seen.length = 0;
  assert.equal(await runtime.autoStopBridges(PROJECT, { telegram_auto: true, discord_auto: true }, PORT), true);
  assert.deepEqual(sent("/api/telegram"), [nodeClient("POST", 200)]);
  assert.deepEqual(sent("/api/discord"), [nodeClient("POST", 200)]);

  // History restore re-posts the snapshot to POST /api/project-history.
  const snapshots = path.join(PROJECT_DIR, "history-snapshots");
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, "restore-probe.json"), JSON.stringify({
    version: 1, project_id: PROJECT, exported_at: "2026-09-27T00:00:00.000Z",
    messages: [{ id: 1, sender: "head", text: "restored line", channel: "general" }],
  }));
  seen.length = 0;
  const restored = await send({
    method: "POST", path: `/api/project-history/restore?project=${PROJECT}&name=restore-probe.json`,
    headers: { host: loopbackHost(), origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" },
    body: {},
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.imported, 1);
  assert.ok(chatMessages().some((m) => m.sender === "head" && m.text === "restored line"));
  assert.deepEqual(sent("/api/project-history?"), [nodeClient("POST", 200)]);
});
