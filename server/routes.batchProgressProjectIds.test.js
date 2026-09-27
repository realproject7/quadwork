// #1216: GET /api/batch-progress passed req.query.project straight to the batch
// snapshot helpers. They build ~/.quadwork/<id> paths, and they treat an id
// that is not configured as archived, so a poll for such an id removed
// <id>/batch-progress-cache.json, outside ~/.quadwork for an id like "../x".
// With config.json missing, the admission check on that path also wrote a
// default config.json.
//
// Pinned here: the route checks its id with the chat routes' rule (#1203,
// assertChatProject) before any file operation. The rule accepts a configured
// project's id, matched exactly (archived included, removed not), that names
// one direct directory under ~/.quadwork; such an id may fail the project-id
// rule. An id that is not configured gets 404 if it passes that rule, else 400.
// A configured id that is not one direct directory there gets 400, and a
// config.json that is missing or cannot be parsed gets 503. Each refused
// request asserts its status and that nothing under the test's temporary root
// changed. Every id the old path would have touched has a queue and a snapshot
// file planted where it points, and the root holds HOME, so an id that climbs
// out of ~/.quadwork or out of HOME still lands where the snapshot sees it.
// Configured projects, archived included, are served as before.
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
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-batch-progress-ids-")));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME);
Object.assign(process.env, { HOME, USERPROFILE: HOME });
process.on("exit", () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const CONFIG_DIR = path.join(HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { mode: 0o700 });
const WORK = path.join(ROOT, "work");

// A legacy project record with a repository, named after its id.
function project(id, extra = {}) {
  const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "dot";
  return { id, name: id, repo: `acme/${slug}`, working_dir: path.join(WORK, slug), agents: {}, chat_mode: "file", ...extra };
}

// CLI setup names a project after its folder, so this configured id fails the
// project-id rule.
const LEGACY_ID = "My Project";
// "gone" was removed: no config entry, an admission tombstone, its folder kept.
const PROJECTS = [
  project("alpha"),
  project("arch", { archived: true, admission_generation: 1 }),
  project(LEGACY_ID),
  { id: "norepo", name: "norepo", agents: {}, chat_mode: "file" },
];
function writeConfig(projects = PROJECTS) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    port: 1, operator_name: "user", projects, project_admission_generations: { arch: 1, gone: 2 },
  }, null, 2), { mode: 0o600 });
}
writeConfig();

// A hand-edited config can hold these ids, and so can one written through the
// config routes before #1216 checked their ids. Each has a repo, so the old
// path reached its snapshot file.
const EDITED = ["../edited", "edited/sub", ".", ".."];

// A queue with an empty Active Batch: for a configured project the route
// retires the snapshot file, as it did before #1216.
const QUEUE = "# Overnight Queue\n\n## Active Batch\n\n(none)\n";
const SNAPSHOT = JSON.stringify({ schema_version: 2, batchNumber: 1, terminalItems: {} });
const PLANTED = [
  "alpha", "arch", LEGACY_ID, "gone", "nope", ...EDITED,
  "../x", "../../x", "a/b", "/tmp/x", "a\\b", ".hidden", "a b", "__proto__", "a".repeat(129),
];
// (Re)writes each id's queue and snapshot file where path.join puts them.
function plant() {
  for (const id of PLANTED) {
    const dir = path.join(CONFIG_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "OVERNIGHT-QUEUE.md"), QUEUE);
    fs.writeFileSync(path.join(dir, "batch-progress-cache.json"), SNAPSHOT);
  }
}

const router = require("./routes");
const express = require("express");

let server;

function request(query) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method: "GET",
      path: `/api/batch-progress?${query}`,
      agent: false,
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

// A "before" snapshot with ~/.quadwork's mtime set to 0, so an entry made or
// removed in it, such as config.lock, moves the mtime whatever the file
// system's timestamp precision.
function baselineSnapshot() {
  fs.utimesSync(CONFIG_DIR, 0, 0);
  return snapshot();
}

// Refused requests: exact status (and error code when given), nothing touched.
// Every case runs, and a failure lists each case that went wrong.
async function assertRefused(cases) {
  const wrong = [];
  for (const { query, status, code, label } of cases) {
    plant();
    const beforeSnapshot = baselineSnapshot();
    const response = await request(query);
    const actual = { status: response.status, touched: changes(beforeSnapshot, snapshot()) };
    const expected = { status, touched: [] };
    if (code) {
      actual.code = response.json?.code;
      expected.code = code;
    }
    if (!isDeepStrictEqual(actual, expected)) wrong.push({ case: label, actual, expected });
  }
  assert.deepEqual(wrong, []);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
});

after(() => new Promise((resolve) => server.close(resolve)));

test("an unknown id and a removed project's id get 404 and touch nothing", async () => {
  await assertRefused([
    { query: "project=nope", status: 404, code: "unknown_project", label: "unknown id" },
    { query: "project=gone", status: 404, code: "unknown_project", label: "removed id, folder kept" },
    // alpha is configured. On a case-insensitive file system ALPHA/ is alpha/.
    { query: "project=ALPHA", status: 404, code: "unknown_project", label: "ALPHA (alpha is configured)" },
  ]);
});

test("an id that is not configured and not a plain project id gets 400 and touches nothing", async () => {
  // Raw query values; the server's query parser decodes them.
  const MALFORMED = [
    ["../x", "project=../x"],
    ["../../x", "project=../../x"],
    ["a/b", "project=a/b"],
    ["..", "project=.."],
    [".", "project=."],
    ["encoded ../x", "project=%2e%2e%2fx"],
    ["double-encoded ../x", "project=%252e%252e%252fx"],
    ["absolute path", "project=%2Ftmp%2Fx"],
    ["backslash", "project=a%5Cb"],
    ["leading dot", "project=.hidden"],
    ["space", "project=a%20b"],
    ["__proto__", "project=__proto__"],
    ["NUL byte", "project=a%00b"],
    ["129 characters", `project=${"a".repeat(129)}`],
    ["my project (My Project is configured)", "project=my%20project"],
    ["repeated parameter", "project=alpha&project=alpha"],
  ];
  await assertRefused([
    ...MALFORMED.map(([label, query]) => ({ query, status: 400, code: "invalid_project_id", label })),
    // The route answers a missing id before the id check, as before.
    { query: "project=", status: 400, label: "empty id" },
    { query: "", status: 400, label: "no id" },
  ]);
});

test("a configured id that is not one direct directory under ~/.quadwork gets 400 and touches nothing", async () => {
  writeConfig([...PROJECTS, ...EDITED.map((id) => project(id)), project("edited\u0000nul")]);
  try {
    await assertRefused([...EDITED, "edited\u0000nul"].map((id) => ({
      query: `project=${encodeURIComponent(id)}`, status: 400, code: "invalid_project_id", label: `configured ${JSON.stringify(id)}`,
    })));
  } finally {
    writeConfig();
  }
});

// A configured project, its legacy counterpart, and an unknown id.
const BROKEN_CONFIG_CASES = ["alpha", LEGACY_ID, "nope"].map((id) => ({
  query: `project=${encodeURIComponent(id)}`, status: 503, code: "project_config_unavailable", label: id,
}));

test("a config.json that cannot be parsed gets 503 and touches nothing", async () => {
  fs.writeFileSync(CONFIG_PATH, "{ not json", { mode: 0o600 });
  try {
    await assertRefused(BROKEN_CONFIG_CASES);
  } finally {
    writeConfig();
  }
});

test("a missing config.json gets 503 and is not created", async () => {
  fs.rmSync(CONFIG_PATH);
  try {
    await assertRefused(BROKEN_CONFIG_CASES);
  } finally {
    writeConfig();
  }
});

test("configured projects are served as before, archived included", async () => {
  const retired = (id) => [`changed home/.quadwork/${id}`, `removed home/.quadwork/${id}/batch-progress-cache.json`];
  const CASES = [
    // An empty Active Batch retires the snapshot file.
    { id: "alpha", status: 200, fields: { active: false, liveActiveBatchCleared: true, _archived: undefined }, touched: retired("alpha") },
    { id: LEGACY_ID, status: 200, fields: { active: false, liveActiveBatchCleared: true, _archived: undefined }, touched: retired(LEGACY_ID) },
    // An archived project is served read-only, and its snapshot is retired.
    { id: "arch", status: 200, fields: { active: false, liveActiveBatchCleared: false, _archived: true, _readonly: true }, touched: retired("arch") },
    // A configured project with no repository.
    { id: "norepo", status: 400, fields: { error: "No repo configured for project" }, touched: [] },
  ];
  const wrong = [];
  for (const { id, status, fields, touched } of CASES) {
    plant();
    const beforeSnapshot = baselineSnapshot();
    const response = await request(`project=${encodeURIComponent(id)}`);
    const actual = {
      status: response.status,
      fields: Object.fromEntries(Object.keys(fields).map((key) => [key, response.json?.[key]])),
      touched: changes(beforeSnapshot, snapshot()),
    };
    const expected = { status, fields, touched };
    if (!isDeepStrictEqual(actual, expected)) wrong.push({ case: id, actual, expected });
  }
  assert.deepEqual(wrong, []);
});
