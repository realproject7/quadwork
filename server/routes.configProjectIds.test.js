// #1216: PUT and PATCH /api/config stored a body project's id without checking
// it. PATCH appended any project whose id was truthy and not in the config; PUT
// wrote the body's projects as given. server/config.js validates only activated
// configs, so on a legacy config an id such as "../x" reached config.json, from
// which other routes build ~/.quadwork/<id> paths. On an activated config the
// generic topology check refused any new id, but only under config.lock.
//
// Pinned here, on a legacy config, an activated (V2) one and no config.json:
//   - a body project whose id is not in the config must pass the new-id rule
//     (assertNewProjectId, #1210), or the request gets 400 invalid_project_id
//     and nothing under the test's temporary root changes;
//   - an id already in the config is kept as it is, even one that fails that
//     rule (#1203, #1210): a PUT round-trip and a Settings save write it back
//     unchanged;
//   - an id that is gone by the time config.lock is held is new there, so it
//     must pass the rule too;
//   - a valid new id is still written.
// The snapshot covers the whole root, which holds HOME, with each entry's mode
// and mtime, so config.lock being taken shows up as a change to ~/.quadwork.
//
// #1219, also pinned here:
//   - a PUT whose projects is present and not an array gets 400
//     invalid_projects and touches nothing. On a legacy config or none, the
//     PUT used to store it as given; on a V2 config it got 409, after taking
//     config.lock. PATCH never stores the body's projects value, so it leaves
//     the config's projects as they are;
//   - a new id that matches a configured id, or another new id in the same
//     request, when letter case is ignored gets 400 invalid_project_id and
//     touches nothing, also when another writer added the configured id after
//     the route's first check. The message names the id it matches. Two
//     configured ids that differ only in case are both kept, and a configured
//     id with regex syntax characters refuses no other id.
//
// Run through `npm test` (server/run-tests.js), never directly.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");

// #1188: a temporary HOME, never the real ~/.quadwork.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-config-ids-")));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME);
Object.assign(process.env, { HOME, USERPROFILE: HOME });
process.on("exit", () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const CONFIG_DIR = path.join(HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR);
// Working folders are only recorded; the config routes never create them.
const WORK = path.join(ROOT, "work");

// CLI setup names a project after its folder, so this configured id fails the
// project-id rule.
const LEGACY_ID = "My Project";
// A configured project can also be named after a QuadWork control entry.
const ENTRY_ID = "agentchattr";

// A project record in the shape a write of that kind of config leaves it: an
// activated config's write adds the two environment settings. Its repository
// and folder are named after the id's bytes, so ids that differ only in letter
// case get their own, as an activated config requires.
function projectAs(kind, id) {
  const slug = Buffer.from(id).toString("hex");
  const repo = `acme/${slug}`;
  const workingDir = path.join(WORK, slug);
  return kind === "v2"
    ? {
      id, name: id, agents: {}, chat_mode: "file",
      repositories: [{ key: "primary", repo, working_dir: workingDir, primary: true }],
      environment_bindings: [], watch_batch_requests: false,
    }
    : { id, name: id, repo, working_dir: workingDir, agents: {}, chat_mode: "file" };
}

function configFor(kind, ids) {
  const projects = ids.map((id) => projectAs(kind, id));
  return kind === "v2"
    ? { installation_id: "routes_config_ids_installation_1", port: 1, operator_name: "user", projects }
    : { port: 1, operator_name: "user", projects };
}

// "missing" leaves no config.json. Returns the config written, if any.
function writeConfig(kind, ids = [LEGACY_ID, "alpha"]) {
  if (kind === "missing") {
    fs.rmSync(CONFIG_PATH, { force: true });
    return null;
  }
  const config = configFor(kind, ids);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

const router = require("./routes");
const express = require("express");

let server;

function request(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method,
      path: "/api/config",
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

// A "before" snapshot with ~/.quadwork's mtime set to 0, so an entry made or
// removed in it, such as config.lock, moves the mtime whatever the file
// system's timestamp precision.
function baselineSnapshot() {
  fs.utimesSync(CONFIG_DIR, 0, 0);
  return snapshot();
}

// A body that would store a project with each of these ids if the ids were let
// through: PUT sends the whole config with the projects added, PATCH sends only
// those projects. Each has a chat_mode, which a Settings save never sends: it
// sends each project's id, name and agents.
function probeBody(method, config, ids) {
  const probes = ids.map((id) => ({ id, name: "Probe", agents: {}, chat_mode: "file" }));
  if (method === "PATCH") return { projects: probes };
  return config ? { ...config, projects: [...config.projects, ...probes] } : { port: 1, operator_name: "user", projects: probes };
}

// Refused requests: 400 invalid_project_id, nothing touched, and the message
// when a case gives one. ~/.quadwork starts each case at 0755, so hardening it
// to 0700, which the PUT and config.lock both do, shows up too. Every case
// runs, and a failure lists each case that went wrong.
async function assertRefused(cases) {
  const wrong = [];
  for (const { label, kind, method, id, newIds = [id], configuredIds, error } of cases) {
    const config = writeConfig(kind, configuredIds);
    fs.chmodSync(CONFIG_DIR, 0o755);
    const beforeSnapshot = baselineSnapshot();
    const response = await request(method, probeBody(method, config, newIds));
    const actual = { status: response.status, code: response.json?.code, touched: changes(beforeSnapshot, snapshot()) };
    const expected = { status: 400, code: "invalid_project_id", touched: [] };
    if (error !== undefined) {
      actual.error = response.json?.error;
      expected.error = error;
    }
    if (!isDeepStrictEqual(actual, expected)) wrong.push({ case: label, actual, expected });
  }
  assert.deepEqual(wrong, []);
}

const KINDS = ["legacy", "v2", "missing"];
const METHODS = ["PUT", "PATCH"];

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
});

after(() => new Promise((resolve) => server.close(resolve)));

test("a new id that fails the project-id rule gets 400 and touches nothing", async () => {
  const MALFORMED = [
    ["../x", "../x"],
    ["../../x", "../../x"],
    ["a/b", "a/b"],
    [".", "."],
    ["..", ".."],
    ["NUL byte", "a\u0000b"],
    // These name one direct directory but fail the rule. None is configured.
    [".hidden", ".hidden"],
    ["Other Project", "Other Project"],
    ["129 characters", "a".repeat(129)],
    // The PATCH merge stores any project whose id is truthy.
    ["number", 7],
  ];
  // PUT stores every body project, so an empty or missing id is new there too.
  // The PATCH merge skips such a project (see the round-trip test).
  const PUT_ONLY = [["empty", ""], ["no id", undefined]];
  await assertRefused(KINDS.flatMap((kind) => METHODS.flatMap((method) =>
    [...MALFORMED, ...(method === "PUT" ? PUT_ONLY : [])].map(([label, id]) => ({ label: `${kind} config: ${method} ${label}`, kind, method, id })))));
});

test("a new id that names a QuadWork control entry gets 400 and touches nothing", async () => {
  // A file entry, a directory entry, a case variant, and a lock file. None is
  // configured here.
  const CONTROL_ENTRY_IDS = ["config.json", "Config.JSON", ENTRY_ID, "work-task-pipelines", "server.pid.lock"];
  await assertRefused(KINDS.flatMap((kind) => METHODS.flatMap((method) =>
    CONTROL_ENTRY_IDS.map((id) => ({ label: `${kind} config: ${method} ${id}`, kind, method, id })))));
});

// #1219: a configured id and a new id that matches it when letter case is
// ignored. On a case-insensitive file system, such as the macOS default, both
// projects would share one ~/.quadwork/<id>. Case is ignored as for control
// entries: LONG S folds to "s" and KELVIN SIGN to "k". "my project" also fails
// the project-id rule, for its space.
const CASE_VARIANTS = [
  ["alpha", "ALPHA"],
  ["alpha", "Alpha"],
  [LEGACY_ID, "my project"],
  ["\u017Fcout", "scout"],
  ["\u212Aite", "kite"],
];

test("a new id that matches a configured id when letter case is ignored gets 400 and touches nothing", async () => {
  const configuredIds = [...new Set(CASE_VARIANTS.map(([configured]) => configured))];
  // The message names the configured project, except for "my project", which
  // the project-id rule refuses first.
  const errorFor = (configured, id) => (id === "my project"
    ? "project id is invalid"
    : `project id matches configured project ${JSON.stringify(configured)} except for letter case`);
  await assertRefused(["legacy", "v2"].flatMap((kind) => METHODS.flatMap((method) =>
    CASE_VARIANTS.map(([configured, id]) => ({
      label: `${kind} config: ${method} ${id} (${configured} is configured)`, kind, method, id, configuredIds, error: errorFor(configured, id),
    })))));
});

test("new ids in one request that match each other when letter case is ignored get 400 and touch nothing", async () => {
  // Neither id is configured. On a legacy config, or none, both used to be
  // stored.
  const PAIRS = [
    [["beta", "BETA"], 'project id matches new project "beta" in this request except for letter case'],
    [["Beta", "bETA"], 'project id matches new project "Beta" in this request except for letter case'],
    [["beta", "beta"], 'project id "beta" appears more than once in this request'],
  ];
  await assertRefused(KINDS.flatMap((kind) => METHODS.flatMap((method) => PAIRS.map(([newIds, error]) => ({
    label: `${kind} config: ${method} ${newIds.join(" and ")}`, kind, method, newIds, error,
  })))));
});

test("a new id that matches an id another writer added before config.lock is held gets 400", async () => {
  // The route's first read has no alpha, so ALPHA passes the first check. By
  // the time config.lock is held, another writer has added alpha. A legacy
  // config, where nothing else refuses ALPHA.
  const wrong = [];
  for (const method of METHODS) {
    const stale = configFor("legacy", [LEGACY_ID]);
    writeConfig("legacy", [LEGACY_ID, "alpha"]);
    const configBytes = fs.readFileSync(CONFIG_PATH, "utf8");
    fs.chmodSync(CONFIG_DIR, 0o755);
    const beforeSnapshot = baselineSnapshot();
    const readFileSync = fs.readFileSync;
    let staleReads = 0;
    fs.readFileSync = function (file, ...rest) {
      if (file === CONFIG_PATH && staleReads === 0) {
        staleReads += 1;
        return JSON.stringify(stale);
      }
      return readFileSync.call(this, file, ...rest);
    };
    let response;
    // The body is built from the config the tab loaded before alpha was added.
    try { response = await request(method, probeBody(method, stale, ["ALPHA"])); }
    finally { fs.readFileSync = readFileSync; }
    const actual = {
      staleReads,
      status: response.status,
      code: response.json?.code,
      error: response.json?.error,
      configUnchanged: fs.readFileSync(CONFIG_PATH, "utf8") === configBytes,
      touched: changes(beforeSnapshot, snapshot()),
    };
    // By then the route had taken config.lock, which hardens ~/.quadwork to
    // 0700. Nothing was created, changed or removed below it.
    const expected = {
      staleReads: 1,
      status: 400,
      code: "invalid_project_id",
      error: 'project id matches configured project "alpha" except for letter case',
      configUnchanged: true,
      touched: ["changed home/.quadwork"],
    };
    if (!isDeepStrictEqual(actual, expected)) wrong.push({ case: method, actual, expected });
  }
  assert.deepEqual(wrong, []);
});

test("a configured id with regex syntax characters refuses no other new id", async () => {
  // The case check builds a RegExp from each configured id. Unescaped, "a.b"
  // would match "aXb", and "Proj (old" would not compile.
  const configuredIds = [LEGACY_ID, "a.b", "Proj (old"];
  for (const method of METHODS) {
    const config = writeConfig("legacy", configuredIds);
    const response = await request(method, probeBody(method, config, ["aXb", "proj-old"]));
    assert.deepEqual({ status: response.status, json: response.json }, { status: 200, json: { ok: true } }, `${method}: response`);
    assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).projects.map((project) => project.id),
      [...configuredIds, "aXb", "proj-old"], `${method}: configured ids`);
  }
  // A new id that matches "a.b" when case is ignored is still refused.
  await assertRefused(METHODS.map((method) => ({
    label: `legacy config: ${method} A.B`, kind: "legacy", method, id: "A.B", configuredIds,
    error: 'project id matches configured project "a.b" except for letter case',
  })));
});

test("a PUT whose projects is present and not an array gets 400 and touches nothing", async () => {
  const NOT_ARRAYS = [["null", null], ["object", {}], ["project", { id: "fresh" }], ["string", "fresh"], ["number", 7], ["true", true], ["false", false]];
  const wrong = [];
  for (const kind of KINDS) {
    for (const [label, projects] of NOT_ARRAYS) {
      const config = writeConfig(kind);
      fs.chmodSync(CONFIG_DIR, 0o755);
      const beforeSnapshot = baselineSnapshot();
      const response = await request("PUT", { ...(config || { port: 1, operator_name: "user" }), projects });
      const actual = { status: response.status, json: response.json, touched: changes(beforeSnapshot, snapshot()) };
      const expected = { status: 400, json: { ok: false, error: "projects must be an array", code: "invalid_projects" }, touched: [] };
      if (!isDeepStrictEqual(actual, expected)) wrong.push({ case: `${kind} config: ${label}`, actual, expected });
    }
  }
  assert.deepEqual(wrong, []);
});

test("a PATCH whose projects is not an array leaves the config's projects as they are", async () => {
  // The merge never assigns the body's projects value, and it merges projects
  // only from an array.
  const wrong = [];
  for (const kind of ["legacy", "v2"]) {
    for (const projects of [null, {}, { id: "fresh" }, "fresh", 7, true, false]) {
      const config = writeConfig(kind);
      const response = await request("PATCH", { projects });
      const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).projects;
      if (!isDeepStrictEqual(stored, config.projects)) wrong.push({ case: `${kind} config: ${JSON.stringify(projects)}`, status: response.status, stored });
    }
  }
  assert.deepEqual(wrong, []);
});

test("ids already in the config are kept as they are, even ones that fail the new-id rule", async () => {
  // #1219: alpha and ALPHA differ only in letter case. Both are configured, so
  // neither is new.
  const IDS = [LEGACY_ID, ENTRY_ID, "alpha", "ALPHA"];
  for (const kind of ["legacy", "v2"]) {
    for (const method of METHODS) {
      writeConfig(kind, IDS);
      const configBytes = fs.readFileSync(CONFIG_PATH, "utf8");
      const got = await request("GET");
      assert.equal(got.status, 200, `${kind} ${method}: GET`);
      // PUT sends back what GET returned. PATCH sends what the Settings save
      // sends: each project's id, name and agents. Its merge skips a project
      // whose id is falsy, as before.
      const body = method === "PUT" ? got.json : {
        port: got.json.port,
        operator_name: got.json.operator_name,
        projects: [
          ...got.json.projects.map(({ id, name, agents }) => ({ id, name, agents })),
          { name: "no id", agents: {} },
          { id: "", name: "empty id", agents: {} },
        ],
      };
      const response = await request(method, body);
      assert.deepEqual({ status: response.status, json: response.json }, { status: 200, json: { ok: true } }, `${kind} ${method}: response`);
      assert.equal(fs.readFileSync(CONFIG_PATH, "utf8"), configBytes, `${kind} ${method}: config.json is written back unchanged`);
    }
  }
});

test("an id that is gone by the time config.lock is held is new there and must pass the new-id rule", async () => {
  // Another writer removes the project after the route's first check found it
  // configured: that read still lists it, the read under config.lock does not.
  // "My Project" fails the project-id rule; agentchattr passes it but names a
  // QuadWork control entry. A legacy config, where nothing else refuses it.
  const wrong = [];
  for (const method of METHODS) {
    for (const id of [LEGACY_ID, ENTRY_ID]) {
      const stale = configFor("legacy", ["alpha", id]);
      writeConfig("legacy", ["alpha"]);
      const configBytes = fs.readFileSync(CONFIG_PATH, "utf8");
      fs.chmodSync(CONFIG_DIR, 0o755);
      const beforeSnapshot = baselineSnapshot();
      const readFileSync = fs.readFileSync;
      let staleReads = 0;
      fs.readFileSync = function (file, ...rest) {
        if (file === CONFIG_PATH && staleReads === 0) {
          staleReads += 1;
          return JSON.stringify(stale);
        }
        return readFileSync.call(this, file, ...rest);
      };
      let response;
      // The body keeps the project, as a tab that loaded the config before the
      // removal would.
      try { response = await request(method, method === "PUT" ? stale : { projects: [projectAs("legacy", id)] }); }
      finally { fs.readFileSync = readFileSync; }
      const actual = {
        staleReads,
        status: response.status,
        code: response.json?.code,
        configUnchanged: fs.readFileSync(CONFIG_PATH, "utf8") === configBytes,
        touched: changes(beforeSnapshot, snapshot()),
      };
      // By then the route had taken config.lock, which hardens ~/.quadwork to
      // 0700. Nothing was created, changed or removed below it.
      const expected = { staleReads: 1, status: 400, code: "invalid_project_id", configUnchanged: true, touched: ["changed home/.quadwork"] };
      if (!isDeepStrictEqual(actual, expected)) wrong.push({ case: `${method} ${id}`, actual, expected });
    }
  }
  assert.deepEqual(wrong, []);
});

test("a valid new id is still written", async () => {
  for (const method of METHODS) {
    for (const kind of ["legacy", "missing"]) {
      const config = writeConfig(kind);
      const id = `fresh-${method.toLowerCase()}-${kind}`;
      const beforeSnapshot = baselineSnapshot();
      const response = await request(method, probeBody(method, config, [id]));
      assert.deepEqual({ status: response.status, json: response.json }, { status: 200, json: { ok: true } }, `${method} ${kind}: response`);
      const projects = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).projects;
      assert.deepEqual(projects.map((project) => project.id), [...(config ? [LEGACY_ID, "alpha"] : []), id], `${method} ${kind}: configured ids`);
      // config.json is written, and nothing else: no project folder.
      assert.deepEqual(changes(beforeSnapshot, snapshot()), [
        "changed home/.quadwork",
        `${config ? "changed" : "created"} home/.quadwork/config.json`,
      ], `${method} ${kind}: touched`);
    }
  }
});
