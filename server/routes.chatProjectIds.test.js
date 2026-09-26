// #1203: GET /api/chat passed any request id to fileChat.readMessages, which
// created <id>/chat/general.jsonl under ~/.quadwork when it was missing (or
// outside ~/.quadwork for an id like "../x"). A dashboard tab still polling a
// removed project re-created its deleted folder that way.
//
// Pinned here:
//   - a chat read never creates files or directories;
//   - every chat route in CHAT_ROUTES accepts only a configured project's id,
//     matched exactly (archived included, removed not), that names one direct
//     directory under ~/.quadwork. A configured id may fail the project-id
//     rule (assertProjectId), since CLI setup names a project after its
//     folder. An id that is not configured gets 404 if it passes the rule,
//     else 400. A config.json that is missing or cannot be parsed gets 503.
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
const { isDeepStrictEqual } = require("util");

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

const PROJECTS = [
  { id: "alpha", chat_mode: "file" },
  { id: "beta", chat_mode: "file" },
  { id: "arch", chat_mode: "file", archived: true },
  // CLI setup names a project after its folder, so these configured ids fail
  // the project-id rule.
  { id: ".dotfiles", chat_mode: "file" },
  { id: "My Project", chat_mode: "file" },
];
const LEGACY_IDS = [".dotfiles", "My Project"];

// The restore route re-posts to 127.0.0.1:<config.port>, 8400 when unset. The
// port is 1 (nothing listens) until this test's server does, then its port.
// "gone" and "kept" are configured until removeProject() removes them.
let configPort = 1;
let configured = [...PROJECTS, { id: "gone", chat_mode: "file" }, { id: "kept", chat_mode: "file" }];
let tombstones = {};
function writeConfig(projects = configured) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    port: configPort, projects, project_admission_generations: tombstones,
  }), { mode: 0o600 });
}
writeConfig();

const fileChat = require("./file-chat");
const router = require("./routes");
const express = require("express");

// Settings > Remove as the lifecycle leaves it: chat stopped, no config entry,
// an admission tombstone.
function removeProject(id) {
  fileChat.shutdownProject(id);
  configured = configured.filter((project) => project.id !== id);
  tombstones = { ...tombstones, [id]: 2 };
  writeConfig();
}

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

// Refused requests: exact status (and error code when given), nothing touched.
// Every case runs, and a failure lists each case that went wrong.
async function assertRefused(cases) {
  const wrong = [];
  for (const { route, query, status, code, label, body = route.body } of cases) {
    const beforeSnapshot = snapshot();
    const response = await request(route.method, route.url(query), body);
    const actual = { status: response.status, touched: changes(beforeSnapshot, snapshot()) };
    const expected = { status, touched: [] };
    if (code) {
      actual.code = response.json?.code;
      expected.code = code;
    }
    if (!isDeepStrictEqual(actual, expected)) wrong.push({ case: `${route.name} ${label}`, actual, expected });
  }
  assert.deepEqual(wrong, []);
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  configPort = server.address().port;
  writeConfig();

  // alpha and the legacy ids have history and a snapshot; beta is running with
  // no message yet (its chat folder exists, general.jsonl does not); arch never
  // got a folder.
  for (const id of ["alpha", "beta", ...LEGACY_IDS, "gone", "kept"]) fileChat.initProject(id);
  for (const id of ["alpha", ...LEGACY_IDS, "gone", "kept"]) {
    fileChat.appendMessage(id, { sender: "user", text: `hello from ${id}` });
  }
  for (const id of ["alpha", ...LEGACY_IDS]) {
    fs.mkdirSync(path.join(CONFIG_DIR, id, "history-snapshots"));
    fs.writeFileSync(path.join(CONFIG_DIR, id, "history-snapshots", "snap.json"), JSON.stringify({
      version: 1, project_id: id, messages: [{ sender: "user", text: "restored line" }],
    }));
  }

  // The #1203 report: "gone" was removed and the operator deleted its folder
  // before a dashboard tab polled it again.
  removeProject("gone");
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
  await assertRefused(CHAT_ROUTES.map((route) => ({ route, query: "project=nope", status: 404, code: "unknown_project", label: "unknown id" })));
});

test("a removed project's id gets 404 on every chat route and touches nothing", async () => {
  // kept is served while it is configured and removed only now, so a project
  // list read once and kept cannot hide the removal.
  const served = await request("GET", "/api/chat?project=kept");
  assert.equal(served.status, 200, "GET /api/chat kept while configured");
  assert.ok(served.json.some((m) => m.text === "hello from kept"), "kept's history is served while configured");
  removeProject("kept");

  await assertRefused(CHAT_ROUTES.flatMap((route) => [
    { route, query: "project=gone", status: 404, code: "unknown_project", label: "removed id, folder deleted" },
    { route, query: "project=kept", status: 404, code: "unknown_project", label: "removed id, folder kept" },
  ]));
});

test("a configured id matches exactly, so another case of it is not configured", async () => {
  await assertRefused(CHAT_ROUTES.flatMap((route) => [
    { route, query: "project=ALPHA", status: 404, code: "unknown_project", label: "ALPHA (alpha is configured)" },
    // Not configured and, with its space, not a plain project id either.
    { route, query: "project=my%20project", status: 400, code: "invalid_project_id", label: "my project (My Project is configured)" },
  ]));
});

test("an id that is not configured and not a plain project id gets 400 on every chat route and touches nothing", async () => {
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
  await assertRefused([
    ...CHAT_ROUTES.flatMap((route) => [
      ...MALFORMED.map(([label, query]) => ({ route, query, status: 400, code: "invalid_project_id", label })),
      // The project-history routes answer a missing id before the id check runs.
      { route, query: "project=", status: 400, label: "empty id" },
      { route, query: "", status: 400, label: "no id" },
    ]),
    // POST /api/chat and the import also take the id from the body.
    { route: CHAT_ROUTES[1], query: "", status: 400, code: "invalid_project_id", label: "body id ../x", body: { project: "../x", text: "hello" } },
    {
      route: CHAT_ROUTES[3], query: "", status: 400, code: "invalid_project_id", label: "body id ../x",
      body: { project_id: "../x", messages: [{ sender: "user", text: "imported line" }] },
    },
  ]);
});

test("a configured id that fails the project-id rule still reads and writes chat on every chat route", async () => {
  for (const id of LEGACY_IDS) {
    const query = `project=${encodeURIComponent(id)}`;
    const chatFile = [`changed home/.quadwork/${id}/chat/general.jsonl`];
    // Each route's body check, and all it may touch: reads nothing, writes
    // only this project's chat file.
    const served = [
      [CHAT_ROUTES[0], (json) => Array.isArray(json) && json.some((m) => m.text === `hello from ${id}`), []],
      [CHAT_ROUTES[1], (json) => json?.message?.text === "hello", chatFile],
      [CHAT_ROUTES[2], (json) => json?.message_count === 2, []],
      [CHAT_ROUTES[3], (json) => json?.imported === 1, chatFile],
      [CHAT_ROUTES[4], (json) => json?.imported === 1, chatFile],
    ];
    for (const [route, bodyOk, touched] of served) {
      const beforeSnapshot = snapshot();
      const response = await request(route.method, route.url(query), route.body);
      assert.equal(response.status, 200, `${route.name} ${id}: status (${JSON.stringify(response.json)})`);
      assert.ok(bodyOk(response.json), `${route.name} ${id}: body ${JSON.stringify(response.json)}`);
      assert.deepEqual(changes(beforeSnapshot, snapshot()), touched, `${route.name} ${id}: touched`);
    }
  }
});

test("a configured id that is not one direct directory under ~/.quadwork gets 400 on every chat route and touches nothing", async () => {
  // A hand-edited config can hold such ids, and so can one written by the
  // legacy add-config setup step before #1207 checked its id. Startup would
  // start chat for "../edited" (unarchived, file chat), so it has a chat folder
  // outside ~/.quadwork.
  const EDITED = [".", "..", "../edited", "edited/sub", "edited\u0000nul"];
  writeConfig([...configured, ...[...EDITED, ""].map((id) => ({ id, chat_mode: "file" }))]);
  fileChat.initProject("../edited");
  try {
    await assertRefused([
      ...CHAT_ROUTES.flatMap((route) => EDITED.map((id) => ({
        route, query: `project=${encodeURIComponent(id)}`, status: 400, code: "invalid_project_id", label: `configured ${JSON.stringify(id)}`,
      }))),
      // Only GET /api/chat hands an empty id to the check. The other routes
      // treat it as missing, as the unconfigured-id test shows.
      { route: CHAT_ROUTES[0], query: "project=", status: 400, code: "invalid_project_id", label: 'configured ""' },
    ]);
  } finally {
    fileChat.shutdownProject("../edited");
    writeConfig();
  }
});

// A configured id and a legacy one, on every chat route.
const BROKEN_CONFIG_CASES = CHAT_ROUTES.flatMap((route) => ["alpha", "My Project"].map((id) => ({
  route, query: `project=${encodeURIComponent(id)}`, status: 503, code: "project_config_unavailable", label: id,
})));

test("a config.json that cannot be parsed gets 503 on every chat route and touches nothing", async () => {
  fs.writeFileSync(CONFIG_PATH, "{ not json", { mode: 0o600 });
  try {
    await assertRefused(BROKEN_CONFIG_CASES);
  } finally {
    writeConfig();
  }
});

test("a missing config.json gets 503 on every chat route and is not created", async () => {
  fs.rmSync(CONFIG_PATH);
  try {
    await assertRefused(BROKEN_CONFIG_CASES);
  } finally {
    writeConfig();
  }
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

  await assertRefused([{ route: CHAT_ROUTES[1], query: "project=arch", status: 409, code: "project_archived", label: "archived project" }]);
});
