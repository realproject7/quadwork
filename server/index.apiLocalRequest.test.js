"use strict";

// #1215: every /api route accepts a request only from the local dashboard, a
// local tool, or an operator-trusted on-box reverse proxy (#988). The rule is
// isLocalApiRequest in server/index.js, mounted ahead of the JSON body parser
// and of every /api route. A request gets 403 unless:
//   - its socket is loopback;
//   - its Host names a loopback host or a trusted_dashboard_hosts entry;
//   - its Origin, when sent, does too;
//   - its X-Forwarded-Host, when sent, does too, for every host it lists;
//   - its Sec-Fetch-Site, when sent, is not cross-site.
//
// The real server/index.js app runs in this process behind two listeners on
// ephemeral ports. The first hands each request to the app unchanged and
// records the Host, Origin, Sec-Fetch-Site, X-Forwarded-Host and response
// status it saw. The second first sets the socket's remoteAddress, which the
// rule reads, to a non-loopback address.
//
// Pinned here:
//   - PUT /api/config, GET /api/batch-progress and GET /api/session-token,
//     refused on each clause, get 403 and change nothing under the test's
//     temporary root;
//   - the same refusal on other /api paths: a resource route registered outside
//     server/routes.js, an index.js route, an unknown path, a case variant, and
//     a malformed JSON body (the rule runs before the parser);
//   - the allowed variants of each clause, a trusted reverse-proxy host, and
//     /api/session-token keeping its own, stricter rule exactly as before;
//   - each in-repo caller of the HTTP API still gets through, with the headers
//     it sends: `next dev`'s /api rewrite (Next's own proxy code), the MCP chat
//     shim, the Head-control shim, the operator MCP, the Telegram and Discord
//     bridges, and the server's own loopback requests (bridge auto-stop and
//     auto-start, the batch polling tick, full-reset, history restore re-post).
//     bin/quadwork.js makes no HTTP API request.
//     server/resource-staging-live-adapter.js uses the same Node fetch to
//     127.0.0.1; its closed matrix runs only on a disposable Linux host and
//     refuses to start under this runner.
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
const SESSION_TOKEN = "api-local-rule-session-token";
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

// close() waits for every open connection to end, and a Node fetch client can
// leave one open that never sent a request; closeIdleConnections() does not
// end it. Nothing is in flight when a test closes a listener.
function close(target) {
  return new Promise((resolve) => {
    target.close(() => resolve());
    target.closeAllConnections();
  });
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

// Rewrites p1's entry in config.json for one test, then restores the file.
async function withProject(fields, run) {
  const original = fs.readFileSync(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(original);
  cfg.projects = cfg.projects.map((p) => (p.id === PROJECT ? { ...p, ...fields } : p));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    return await run();
  } finally {
    fs.writeFileSync(CONFIG_PATH, original, { mode: 0o600 });
  }
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

// The two routes with side effects, and the token endpoint. Let through,
// PUT /api/config would rewrite config.json, GET /api/batch-progress would
// delete the planted row cache, and GET /api/session-token would return the
// token.
function guardedRequests() {
  return [
    { route: "PUT /api/config", method: "PUT", path: "/api/config", body: { ...readConfig(), operator_name: "changedByRequest" } },
    { route: "GET /api/batch-progress", method: "GET", path: `/api/batch-progress?project=${PROJECT}` },
    { route: "GET /api/session-token", method: "GET", path: "/api/session-token" },
  ];
}

const loopbackHost = () => `127.0.0.1:${PORT}`;
// A request from the dashboard page served by the server itself.
const dashboardPage = () => ({ host: loopbackHost(), origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" });

// Sends one request and reports its status, error and what it changed under
// the root.
async function refusalOf(request, headers, port) {
  plantCache();
  const beforeSnapshot = baselineSnapshot();
  const response = await send({ ...request, headers, port });
  return { status: response.status, error: response.json?.error, touched: changes(beforeSnapshot, snapshot()) };
}

const REFUSED = { status: 403, error: "Local access only", touched: [] };

// Runs each request against each case; every one must get the rule's 403 and
// leave the root untouched. A failure lists each case that went wrong.
async function assertRefused(requests, cases) {
  const wrong = [];
  for (const request of requests) {
    for (const { label, headers, remote } of cases) {
      const actual = await refusalOf(request, headers, remote ? REMOTE_PORT : PORT);
      if (!isDeepStrictEqual(actual, REFUSED)) wrong.push({ request: request.route, case: label, actual, expected: REFUSED });
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

// Stands in for the Telegram Bot API only. Every other request, including the
// bridge's requests to QuadWork, goes through Node's fetch unchanged. The first
// getUpdates returns `updates`.
function telegramApiStub(realFetch, updates = []) {
  let served = false;
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return (input, init) => {
    const target = String(input);
    if (!target.startsWith("https://api.telegram.org/")) return realFetch(input, init);
    if (target.includes("/getUpdates") && !served) {
      served = true;
      return Promise.resolve(reply({ ok: true, result: updates }));
    }
    return Promise.resolve(reply({ ok: true, result: [] }));
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

// The headers and status of each recorded request to a path.
function sent(prefix) {
  return seen
    .filter((record) => record.path.startsWith(prefix))
    .map(({ method, host, origin, site, forwardedHost, status }) => ({ method, host, origin, site, forwardedHost, status }));
}

// What a Node HTTP client (http.request or fetch) to 127.0.0.1 sends.
const nodeClient = (method, status) => ({ method, host: loopbackHost(), origin: undefined, site: undefined, forwardedHost: undefined, status });

// A bridge polls GET /api/chat on a timer, so how many GETs it sent varies,
// and one in flight at stop may have no status. Every request carries the Node
// client's headers, none is refused, a GET succeeded, and the one inbound
// message was posted.
function assertBridgeRequests() {
  const requests = sent("/api/chat");
  assert.deepEqual(
    requests.map(({ status, ...headers }) => headers),
    requests.map(({ method }) => ({ method, host: loopbackHost(), origin: undefined, site: undefined, forwardedHost: undefined })),
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
    // The server's own loopback requests go to this port.
    port: PORT,
    session_token: SESSION_TOKEN,
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

test("PUT /api/config, GET /api/batch-progress and GET /api/session-token, refused on each clause, get 403 and change nothing", async () => {
  await assertRefused(guardedRequests(), [
    { label: "a foreign Host", headers: { host: "evil.example" } },
    { label: "a foreign Host with a port", headers: { host: "evil.example:8400" } },
    { label: "a foreign Origin", headers: { host: loopbackHost(), origin: "http://evil.example" } },
    { label: "Origin: null", headers: { host: loopbackHost(), origin: "null" } },
    { label: "a foreign Origin behind a trusted Host", headers: { host: TRUSTED, origin: "http://evil.example" } },
    // `next dev` rewrites Host to its destination and sends the browser's host
    // in X-Forwarded-Host.
    { label: "a loopback Host with a foreign X-Forwarded-Host", headers: { host: loopbackHost(), "x-forwarded-host": "evil.example:3000" } },
    { label: "an X-Forwarded-Host list with one foreign host", headers: { host: loopbackHost(), "x-forwarded-host": "localhost:3000, evil.example" } },
    { label: "a trusted Host with a foreign X-Forwarded-Host", headers: { host: TRUSTED, "x-forwarded-host": "evil.example" } },
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
    { label: "the dashboard on 127.0.0.1", headers: dashboardPage() },
    { label: "the dashboard on localhost", headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, "sec-fetch-site": "same-origin" } },
    { label: "a typed URL (Sec-Fetch-Site: none)", headers: { host: loopbackHost(), "sec-fetch-site": "none" } },
    { label: "a local page on another port (Sec-Fetch-Site: same-site)", headers: { host: `localhost:${PORT}`, origin: "http://localhost:3000", "sec-fetch-site": "same-site" } },
    { label: "a local tool (no Origin, no Sec-Fetch-Site)", headers: { host: loopbackHost() } },
    { label: "`next dev` from a loopback page", headers: { host: loopbackHost(), origin: "http://localhost:3000", "x-forwarded-host": "localhost:3000", "sec-fetch-site": "same-origin" } },
    { label: "a trusted reverse-proxy host", headers: { host: TRUSTED, origin: `https://${TRUSTED}`, "sec-fetch-site": "same-origin" } },
    { label: "a trusted reverse-proxy host with a port", headers: { host: `${TRUSTED}:443`, origin: `https://${TRUSTED}`, "sec-fetch-site": "same-origin" } },
    { label: "a trusted proxy that sets Host and X-Forwarded-Host", headers: { host: TRUSTED, origin: `https://${TRUSTED}`, "x-forwarded-host": TRUSTED, "sec-fetch-site": "same-origin" } },
    { label: "an X-Forwarded-Host list of trusted and loopback hosts", headers: { host: loopbackHost(), "x-forwarded-host": `${TRUSTED}, 127.0.0.1:${PORT}` } },
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

test("/api/session-token keeps its own, stricter rule exactly as before", async () => {
  // Each of these passes the API rule but neither isLocalTokenRequest nor
  // isTrustedProxyRequest: a loopback Host with a trusted proxy's Origin, a
  // trusted Host with a loopback Origin, and a non-http Origin whose host the
  // URL parser keeps uppercase. The token rule compares that host as parsed.
  const wrong = [];
  for (const headers of [
    { host: loopbackHost(), origin: `https://${TRUSTED}` },
    { host: TRUSTED, origin: `http://localhost:${PORT}` },
    { host: loopbackHost(), origin: "x://LOCALHOST" },
  ]) {
    const actual = {
      config: (await send({ path: "/api/config", headers })).status,
      token: (await send({ path: "/api/session-token", headers })).status,
    };
    if (!isDeepStrictEqual(actual, { config: 200, token: 403 })) wrong.push({ headers, actual });
  }
  assert.deepEqual(wrong, []);
  assert.equal((await send({ path: "/api/session-token", headers: { host: loopbackHost() } })).json?.token, SESSION_TOKEN);
  assert.equal((await send({ path: "/api/session-token", headers: { host: TRUSTED, origin: `https://${TRUSTED}` } })).json?.token, SESSION_TOKEN);
});

test("`next dev`'s /api rewrite: a loopback page gets through, a page under another name does not", async () => {
  // Next's own rewrite proxy (node_modules/next): http-proxy with
  // changeOrigin, so the Host becomes the destination's, and
  // `x-forwarded-host` set to the browser's Host. The destination is
  // next.config.ts's rewrite with this test's port in place of 8400.
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
    const other = await send({ port: frontPort, path: "/api/config", headers: { host: `127.0.0.1:${frontPort}`, "sec-fetch-site": "same-origin" } });
    assert.equal(other.status, 200);
    assert.deepEqual(sent("/api/"), [
      { method: "GET", host: loopbackHost(), origin: undefined, site: "same-origin", forwardedHost: `localhost:${frontPort}`, status: 200 },
      { method: "PUT", host: loopbackHost(), origin: `http://localhost:${frontPort}`, site: "same-origin", forwardedHost: `localhost:${frontPort}`, status: 200 },
      { method: "GET", host: loopbackHost(), origin: undefined, site: "same-origin", forwardedHost: `127.0.0.1:${frontPort}`, status: 200 },
    ]);

    // A page served under a name that resolves to this machine, through the
    // same proxy: the Host is still the destination's, and the page's name
    // arrives in X-Forwarded-Host.
    seen.length = 0;
    const named = { host: `evil.example:${frontPort}`, "sec-fetch-site": "same-origin" };
    const wrong = [];
    for (const request of guardedRequests()) {
      const headers = request.method === "GET" ? named : { ...named, origin: `http://evil.example:${frontPort}` };
      const actual = await refusalOf(request, headers, frontPort);
      if (!isDeepStrictEqual(actual, REFUSED)) wrong.push({ request: request.route, actual });
    }
    assert.deepEqual(wrong, []);
    assert.deepEqual(sent("/api/").map(({ host, forwardedHost, status }) => ({ host, forwardedHost, status })),
      guardedRequests().map(() => ({ host: loopbackHost(), forwardedHost: `evil.example:${frontPort}`, status: 403 })));
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
  global.fetch = telegramApiStub(realFetch, [
    { update_id: 1, message: { text: "hello from telegram", from: { username: "operator" }, chat: { id: "chat-1" } } },
  ]);
  try {
    seen.length = 0;
    await telegramBridge.start(PROJECT, "test-bot-token", "chat-1", PORT, { isAuthorityCurrent: () => true });
    await waitFor(() => chatMessages().some((m) => m.sender === "tg:operator" && m.text === "hello from telegram"), "the Telegram message");
  } finally {
    // Stop first: the bridge must never reach the real fetch.
    await telegramBridge.stop(PROJECT);
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
  try {
    seen.length = 0;
    await discordBridge.start(PROJECT, "test-bot-token", "channel-1", PORT, { isAuthorityCurrent: () => true });
    await onMessage({ author: { bot: false, username: "operator" }, channel: { id: "channel-1" }, content: "hello from discord" });
  } finally {
    await discordBridge.stop(PROJECT);
  }
  assert.ok(chatMessages().some((m) => m.sender === "dc:operator" && m.text === "hello from discord"));
  assertBridgeRequests();
});

test("the server's bridge auto-stop requests get through", async () => {
  seen.length = 0;
  assert.equal(await runtime.autoStopBridges(PROJECT, { telegram_auto: true, discord_auto: true }, PORT), true);
  assert.deepEqual(sent("/api/telegram"), [nodeClient("POST", 200)]);
  assert.deepEqual(sent("/api/discord"), [nodeClient("POST", 200)]);
});

test("the server's batch polling tick and bridge auto-start requests get through", async () => {
  // A V1 queue with one active item and a configured Telegram bridge on auto.
  // The tick reads batch progress and batch activity; for the new batch it
  // calls autoStartBridges with that batch's identity, which reads the bridge
  // status and then starts the bridge through the route.
  const queue = path.join(PROJECT_DIR, "OVERNIGHT-QUEUE.md");
  const emptyQueue = fs.readFileSync(queue, "utf8");
  fs.writeFileSync(queue, "# Queue\n\n## Active Batch\n\n**Batch:** 7\n\n- [ ] #101 — Probe item\n\n## Backlog\n", { mode: 0o600 });
  const telegramBridge = require("./bridges/telegram");
  const realFetch = global.fetch;
  global.fetch = telegramApiStub(realFetch);
  let running;
  try {
    await withProject({ telegram_auto: true, telegram: { bot_token: "test-bot-token", chat_id: "chat-1", bot_username: "qw_test_bot" } }, async () => {
      seen.length = 0;
      await runtime.autoStopPollingTick();
      running = telegramBridge.isRunning(PROJECT);
    });
  } finally {
    await telegramBridge.stop(PROJECT);
    global.fetch = realFetch;
    fs.writeFileSync(queue, emptyQueue, { mode: 0o600 });
  }
  assert.deepEqual({
    running,
    progress: sent("/api/batch-progress"),
    active: sent("/api/batch-active"),
    telegram: sent("/api/telegram"),
  }, {
    running: true,
    progress: [nodeClient("GET", 200)],
    active: [nodeClient("GET", 200)],
    telegram: [nodeClient("GET", 200), nodeClient("POST", 200)],
  });
});

test("full-reset's own request gets through", async () => {
  seen.length = 0;
  const reset = await send({ method: "POST", path: "/api/full-reset", headers: { ...dashboardPage(), "x-session-token": SESSION_TOKEN }, body: {} });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal(reset.json.ok, true, JSON.stringify(reset.json));
  assert.equal(reset.json.projects, 1);
  assert.deepEqual(sent(`/api/agents/${PROJECT}/reset`), [nodeClient("POST", 200)]);
});

test("the history restore re-post gets through", async () => {
  const snapshots = path.join(PROJECT_DIR, "history-snapshots");
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, "restore-probe.json"), JSON.stringify({
    version: 1, project_id: PROJECT, exported_at: "2026-09-27T00:00:00.000Z",
    messages: [{ id: 1, sender: "head", text: "restored line", channel: "general" }],
  }));
  seen.length = 0;
  const restored = await send({
    method: "POST", path: `/api/project-history/restore?project=${PROJECT}&name=restore-probe.json`,
    headers: dashboardPage(),
    body: {},
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.imported, 1);
  assert.ok(chatMessages().some((m) => m.sender === "head" && m.text === "restored line"));
  assert.deepEqual(sent("/api/project-history?"), [nodeClient("POST", 200)]);
});
