// #1203: GET /api/chat passed any request id to fileChat.readMessages, which
// created <id>/chat/general.jsonl under ~/.quadwork when it was missing (or
// outside ~/.quadwork for an id like "../x"). A dashboard tab still polling a
// removed project re-created its deleted folder that way.
//
// Pinned here:
//   - a chat read never creates files or directories;
//   - every chat route (GET/POST /api/chat, the history export and import, and
//     snapshot restore) accepts only the id of a configured project that
//     passes the project-id rule (assertProjectId). Archived projects are
//     still configured; removed ones are not.
// Every refused request asserts its status and that nothing under the test's
// temporary root changed. The root holds HOME, so an id that climbs out of
// ~/.quadwork or out of HOME still lands where the snapshot sees it.
//
// Run through `npm test` (server/run-tests.js), never directly.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// #1188: a temporary HOME, never the real ~/.quadwork. It sits one level inside
// ROOT so "../../x" still lands inside ROOT.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-chat-ids-")));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME);
Object.assign(process.env, { HOME, USERPROFILE: HOME });
process.on("exit", () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const CONFIG_DIR = path.join(HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { mode: 0o700 });

// "gone" and "kept" are removed below: both leave config, as Settings > Remove
// does, and "gone" also loses its folder (the #1203 report).
const PROJECTS = [
  { id: "alpha", chat_mode: "file" },
  { id: "beta", chat_mode: "file" },
  { id: "arch", chat_mode: "file", archived: true },
  { id: "gone", chat_mode: "file" },
  { id: "kept", chat_mode: "file" },
];
// The restore route re-posts to 127.0.0.1:<config.port>, 8400 when unset. The
// port is 1 (nothing listens) until this test's server does, then its port.
function writeConfig(projects, extra = {}) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ port: 1, projects, ...extra }), { mode: 0o600 });
}
writeConfig(PROJECTS);

const fileChat = require("./file-chat");
const router = require("./routes");
const express = require("express");

let server;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method,
      path: urlPath,
      agent: false,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Every path under ROOT with its type, size and mtime: a file or directory
// created, changed or removed anywhere under the root shows up in changes().
function snapshot(dir = ROOT, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const stat = fs.lstatSync(full);
    out.set(path.relative(ROOT, full), `${entry.isDirectory() ? "dir" : "file"}:${stat.size}:${stat.mtimeMs}`);
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

const CHAT_ROUTES = [
  { name: "GET /api/chat", method: "GET", url: (q) => `/api/chat?${q}` },
  { name: "POST /api/chat", method: "POST", url: (q) => `/api/chat?${q}`, body: { text: "hello" } },
  { name: "GET /api/project-history", method: "GET", url: (q) => `/api/project-history?${q}` },
  {
    name: "POST /api/project-history", method: "POST", url: (q) => `/api/project-history?${q}`,
    body: { messages: [{ sender: "user", text: "imported line" }] },
  },
  { name: "POST /api/project-history/restore", method: "POST", url: (q) => `/api/project-history/restore?${q}&name=snap.json`, body: {} },
];

// A refused request: exact status (and error code when given), nothing touched.
async function assertRefused(route, query, status, code, label, body = route.body) {
  const beforeSnapshot = snapshot();
  const response = await request(route.method, route.url(query), body);
  const actual = { status: response.status, touched: changes(beforeSnapshot, snapshot()) };
  const expected = { status, touched: [] };
  if (code) {
    actual.code = response.json?.code;
    expected.code = code;
  }
  assert.deepEqual(actual, expected, `${route.name} ${label}`);
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  writeConfig(PROJECTS, { port: server.address().port });

  // alpha has history and a snapshot; beta is running with no message yet (its
  // chat folder exists, general.jsonl does not); arch never got a folder.
  for (const id of ["alpha", "beta", "gone", "kept"]) fileChat.initProject(id);
  fileChat.appendMessage("alpha", { sender: "user", text: "hello from alpha" });
  fileChat.appendMessage("gone", { sender: "user", text: "before removal" });
  fileChat.appendMessage("kept", { sender: "user", text: "before removal" });
  fs.mkdirSync(path.join(CONFIG_DIR, "alpha", "history-snapshots"));
  fs.writeFileSync(path.join(CONFIG_DIR, "alpha", "history-snapshots", "snap.json"), JSON.stringify({
    version: 1, project_id: "alpha", exported_at: "2026-09-26T00:00:00.000Z",
    messages: [{ sender: "user", text: "restored line" }],
  }));

  // Remove "gone" and "kept" the way the lifecycle leaves them: chat stopped,
  // no config entry, an admission tombstone. The operator deleted gone's folder.
  fileChat.shutdownProject("gone");
  fileChat.shutdownProject("kept");
  writeConfig(PROJECTS.filter((p) => p.id !== "gone" && p.id !== "kept"), {
    port: server.address().port,
    project_admission_generations: { gone: 2, kept: 2 },
  });
  fs.rmSync(path.join(CONFIG_DIR, "gone"), { recursive: true, force: true });
});

after(() => new Promise((resolve) => server.close(resolve)));

test("a chat read never creates the chat file or its directories", () => {
  for (const id of ["beta", "arch", "gone", "nope", "../x", "..", ""]) {
    const beforeSnapshot = snapshot();
    assert.deepEqual(fileChat.readMessages(id, { limit: 10 }), [], `readMessages(${JSON.stringify(id)}) returns no messages`);
    assert.deepEqual(changes(beforeSnapshot, snapshot()), [], `readMessages(${JSON.stringify(id)}) touched the disk`);
  }
});

test("reading a configured project with no chat file returns nothing and creates nothing", async () => {
  // beta is running without a first message; arch is archived and still
  // configured, so its history stays readable.
  for (const id of ["beta", "arch"]) {
    let beforeSnapshot = snapshot();
    let response = await request("GET", `/api/chat?project=${id}`);
    assert.equal(response.status, 200, `GET /api/chat ${id}: status`);
    assert.deepEqual(response.json, [], `GET /api/chat ${id}: no messages`);
    assert.deepEqual(changes(beforeSnapshot, snapshot()), [], `GET /api/chat ${id}: touched the disk`);

    beforeSnapshot = snapshot();
    response = await request("GET", `/api/project-history?project=${id}`);
    assert.equal(response.status, 200, `GET /api/project-history ${id}: status`);
    assert.equal(response.json?.message_count, 0, `GET /api/project-history ${id}: no messages`);
    assert.deepEqual(changes(beforeSnapshot, snapshot()), [], `GET /api/project-history ${id}: touched the disk`);
  }
});

test("an unknown project id gets 404 on every chat route and touches nothing", async () => {
  for (const route of CHAT_ROUTES) await assertRefused(route, "project=nope", 404, "unknown_project", "unknown id");
});

test("a removed project's id gets 404 on every chat route and touches nothing", async () => {
  for (const route of CHAT_ROUTES) {
    await assertRefused(route, "project=gone", 404, "unknown_project", "removed id, folder deleted");
    await assertRefused(route, "project=kept", 404, "unknown_project", "removed id, folder kept");
  }
});

test("an id that is not a plain project id gets 400 on every chat route and touches nothing", async () => {
  // Raw query values; the server's query parser decodes them.
  const MALFORMED = [
    ["../x", "project=../x"],
    ["../../x", "project=../../x"],
    ["a/b", "project=a/b"],
    ["..", "project=.."],
    [".", "project=."],
    ["encoded ../x", "project=%2e%2e%2fx"],
    ["encoded ../../x", "project=..%2F..%2Fx"],
    ["encoded ..", "project=%2e%2e"],
    ["double-encoded ../x", "project=%252e%252e%252fx"],
    ["absolute path", "project=%2Ftmp%2Fx"],
    ["backslash", "project=a%5Cb"],
    ["leading dot", "project=.hidden"],
    ["leading dash", "project=-x"],
    ["__proto__", "project=__proto__"],
    ["space", "project=a%20b"],
    ["NUL byte", "project=a%00b"],
    ["trailing newline", "project=alpha%0A"],
    ["non-ASCII", "project=%C3%A9t%C3%A9"],
    ["129 characters", `project=${"a".repeat(129)}`],
    ["repeated parameter", "project=alpha&project=alpha"],
  ];
  for (const route of CHAT_ROUTES) {
    for (const [label, query] of MALFORMED) await assertRefused(route, query, 400, "invalid_project_id", label);
    // The project-history routes answer a missing id before the id rule runs.
    await assertRefused(route, "project=", 400, null, "empty id");
    await assertRefused(route, "", 400, null, "no id");
  }
  // The POST routes also take the id from the body.
  await assertRefused(CHAT_ROUTES[1], "", 400, "invalid_project_id", "body id ../x", { project: "../x", text: "hello" });
  await assertRefused(CHAT_ROUTES[3], "", 400, "invalid_project_id", "body id ../x", {
    project_id: "../x", messages: [{ sender: "user", text: "imported line" }],
  });
});

test("configured projects still pass: alpha reads and writes, archived writes keep their 409", async () => {
  let response = await request("GET", "/api/chat?project=alpha");
  assert.equal(response.status, 200);
  assert.ok(response.json.some((m) => m.text === "hello from alpha"), "GET /api/chat alpha returns its history");
  response = await request("POST", "/api/chat?project=alpha", { text: "control post" });
  assert.equal(response.status, 200, "POST /api/chat alpha");
  response = await request("GET", "/api/project-history?project=alpha");
  assert.equal(response.status, 200, "GET /api/project-history alpha");
  assert.ok(response.json.message_count >= 2, "the export carries alpha's messages");
  response = await request("POST", "/api/project-history?project=alpha", { messages: [{ sender: "user", text: "imported line" }] });
  assert.equal(response.status, 200, "POST /api/project-history alpha");
  assert.equal(response.json.imported, 1);
  response = await request("POST", "/api/project-history/restore?project=alpha&name=snap.json", {});
  assert.equal(response.status, 200, `POST /api/project-history/restore alpha (${JSON.stringify(response.json)})`);
  assert.equal(response.json.imported, 1);

  await assertRefused(CHAT_ROUTES[1], "project=arch", 409, "project_archived", "archived project");
});
