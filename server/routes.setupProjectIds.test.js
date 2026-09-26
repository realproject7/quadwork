// #1207: POST /api/setup?step=add-config took its id straight from the body.
// It stored the id in config.json and built ~/.quadwork/<id> paths from it:
// fileChat.initProject made <id>/chat/, and the queue, GITHUB.md and Head
// playbook seeds wrote files there. path.join resolves "..", so an id such as
// "../x" wrote outside ~/.quadwork.
//
// Pinned here, on a legacy config and on an activated (V2) one:
//   - a new id must pass the project-id rule the V2 setup steps use
//     (assertProjectId);
//   - a configured id keeps the re-run path, even one that fails the rule
//     (CLI setup names a project after its folder), while it names one direct
//     directory under ~/.quadwork (#1203);
//   - on the V2 path, an id that is no longer configured under config.lock is
//     new there, so it must pass the rule too;
//   - a valid new id still sets up as before.
// Each refused request gets 400. Nothing under the test's temporary root
// changes, except in the third case: the step refuses it under config.lock,
// by which time it has changed ~/.quadwork itself. The root holds HOME, so an
// id that climbs out of ~/.quadwork or out of HOME still lands where the
// snapshot sees it.
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
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-setup-ids-")));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME);
Object.assign(process.env, { HOME, USERPROFILE: HOME });
process.on("exit", () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const CONFIG_DIR = path.join(HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR);
// Working folders are only recorded; add-config never creates them.
const WORK = path.join(ROOT, "work");

const CI_POLICY = { version: 1, mode: "ci-less", evidence_keys: ["operator"] };
// CLI setup names a project after its folder, so this configured id fails the
// project-id rule.
const LEGACY_ID = "My Project";
const LEGACY_REPO = "acme/my-project";
const CONFIGURED = {
  legacy: { id: LEGACY_ID, name: LEGACY_ID, repo: LEGACY_REPO, working_dir: path.join(WORK, LEGACY_ID), agents: {}, chat_mode: "file" },
  v2: {
    id: LEGACY_ID, name: LEGACY_ID, agents: {}, chat_mode: "file",
    repositories: [{ key: "primary", repo: LEGACY_REPO, working_dir: path.join(WORK, LEGACY_ID), primary: true }],
  },
};

function configFor(kind, projects = [CONFIGURED[kind]]) {
  return kind === "v2"
    ? { installation_id: "routes_setup_ids_installation_1", port: 1, projects }
    : { port: 1, projects };
}

// "missing" leaves no config.json.
function writeConfig(kind, projects) {
  if (kind === "missing") return fs.rmSync(CONFIG_PATH, { force: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configFor(kind, projects), null, 2), { mode: 0o600 });
}

const router = require("./routes");
const express = require("express");

let server;

function request(body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method: "POST",
      path: "/api/setup?step=add-config",
      agent: false,
      headers: { "content-type": "application/json", "content-length": payload.length },
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
    req.end(payload);
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
// removed in it moves the mtime whatever the file system's timestamp
// precision.
function baselineSnapshot() {
  fs.utimesSync(CONFIG_DIR, 0, 0);
  return snapshot();
}

// A body that would set up a project if its id were let through.
function probeBody(id) {
  return { id, name: "Probe", repo: "acme/probe", workingDir: path.join(WORK, "probe"), backends: {}, ci_policy: CI_POLICY };
}

// Refused requests: 400 invalid_project_id, nothing touched. ~/.quadwork starts
// each case at 0755. The new-project paths and the V2 path harden it to 0700
// before any other write, so that shows up too. The legacy re-run path hardens
// only ~/.quadwork/<id>. Every case runs, and a failure lists each case that
// went wrong.
async function assertRefused(cases) {
  const wrong = [];
  for (const { label, kind, projects, body } of cases) {
    writeConfig(kind, projects);
    fs.chmodSync(CONFIG_DIR, 0o755);
    const beforeSnapshot = baselineSnapshot();
    const response = await request(body);
    const actual = { status: response.status, code: response.json?.code, touched: changes(beforeSnapshot, snapshot()) };
    const expected = { status: 400, code: "invalid_project_id", touched: [] };
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

test("a new id that fails the project-id rule gets 400 and touches nothing", async () => {
  const MALFORMED = [
    ["../x", "../x"],
    ["../../x", "../../x"],
    ["a/b", "a/b"],
    [".", "."],
    ["..", ".."],
    ["empty", ""],
    // These three name one direct directory but fail the rule. None is
    // configured.
    ["Other Project", "Other Project"],
    [".hidden", ".hidden"],
    ["129 characters", "a".repeat(129)],
    ["no id", undefined],
    ["number", 7],
  ];
  await assertRefused(["legacy", "v2", "missing"].flatMap((kind) => [
    ...MALFORMED.map(([label, id]) => ({ label: `${kind} config: ${label}`, kind, body: probeBody(id) })),
    // Nothing else in the body: the check comes before the step reads workingDir.
    { label: `${kind} config: ../x alone`, kind, body: { id: "../x" } },
  ]));
});

test("a configured id that is not one direct directory under ~/.quadwork gets 400 and touches nothing", async () => {
  // A legacy config written through the config API can hold such ids.
  const EDITED = [".", "..", "../edited", "edited/sub", "", "edited\u0000nul"];
  await assertRefused(["legacy", "v2"].flatMap((kind) => {
    const projects = [CONFIGURED[kind], ...EDITED.map((id) => ({ id, chat_mode: "file" }))];
    return EDITED.map((id) => ({ label: `${kind} config: configured ${JSON.stringify(id)}`, kind, projects, body: probeBody(id) }));
  }));
});

test("a configured id that fails the project-id rule keeps its re-run path", async () => {
  for (const kind of ["legacy", "v2"]) {
    writeConfig(kind);
    fs.rmSync(path.join(CONFIG_DIR, LEGACY_ID), { recursive: true, force: true });
    const configBytes = fs.readFileSync(CONFIG_PATH, "utf8");
    const beforeSnapshot = baselineSnapshot();
    const response = await request(probeBody(LEGACY_ID));
    assert.equal(response.status, 200, `${kind}: status (${JSON.stringify(response.json)})`);
    assert.deepEqual(response.json, { ok: true, message: "Project already in config" }, `${kind}: body`);
    assert.equal(fs.readFileSync(CONFIG_PATH, "utf8"), configBytes, `${kind}: config.json is unchanged`);
    // The re-run seeds what is missing, and nothing else.
    assert.deepEqual(changes(beforeSnapshot, snapshot()), [
      "changed home/.quadwork",
      `created home/.quadwork/${LEGACY_ID}`,
      `created home/.quadwork/${LEGACY_ID}/GITHUB.md`,
      `created home/.quadwork/${LEGACY_ID}/HEAD-PO-PLAYBOOK.md`,
      `created home/.quadwork/${LEGACY_ID}/OVERNIGHT-QUEUE.md`,
    ], `${kind}: touched`);
    // From the configured project, not from the request body.
    assert.match(fs.readFileSync(path.join(CONFIG_DIR, LEGACY_ID, "OVERNIGHT-QUEUE.md"), "utf8"), /^> \*\*Repo:\*\* acme\/my-project$/m, `${kind}: queue repo`);
  }
});

test("on the V2 path, an id that is gone by the time config.lock is held is new there and must pass the rule", async () => {
  // Another writer removes "My Project" after the step's first read found it
  // configured: that read still lists it, the read under config.lock does not.
  writeConfig("v2", []);
  const configBytes = fs.readFileSync(CONFIG_PATH, "utf8");
  fs.chmodSync(CONFIG_DIR, 0o755);
  const beforeSnapshot = baselineSnapshot();
  const readFileSync = fs.readFileSync;
  let staleReads = 0;
  fs.readFileSync = function (file, ...rest) {
    if (file === CONFIG_PATH && staleReads === 0) {
      staleReads += 1;
      return JSON.stringify(configFor("v2"));
    }
    return readFileSync.call(this, file, ...rest);
  };
  let response;
  try { response = await request(probeBody(LEGACY_ID)); }
  finally { fs.readFileSync = readFileSync; }
  assert.equal(staleReads, 1, "the step's first read saw the id configured");
  assert.deepEqual({ status: response.status, code: response.json?.code }, { status: 400, code: "invalid_project_id" });
  assert.equal(fs.readFileSync(CONFIG_PATH, "utf8"), configBytes, "config.json is unchanged");
  // By then the step had hardened ~/.quadwork to 0700 and taken config.lock.
  // Nothing was created, changed or removed below it.
  assert.deepEqual(changes(beforeSnapshot, snapshot()), ["changed home/.quadwork"]);
});

test("a valid new id still sets up as before", async () => {
  for (const kind of ["legacy", "v2"]) {
    const id = `fresh-${kind}`;
    const workingDir = path.join(WORK, id);
    writeConfig(kind);
    const beforeSnapshot = baselineSnapshot();
    const response = await request({
      id, name: `Fresh ${kind}`, repo: `acme/${id}`, workingDir, backends: {},
      ...(kind === "v2" ? { ci_policy: CI_POLICY } : {}),
    });
    assert.equal(response.status, 200, `${kind}: status (${JSON.stringify(response.json)})`);
    assert.deepEqual(response.json, { ok: true }, `${kind}: body`);

    const projects = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).projects;
    assert.deepEqual(projects.map((project) => project.id), [LEGACY_ID, id], `${kind}: configured ids`);
    // The fields add-config writes. The V2 commit adds its own defaults.
    const expected = kind === "v2"
      ? { id, name: "Fresh v2", chat_mode: "file", repositories: [{ key: "primary", repo: `acme/${id}`, working_dir: workingDir, primary: true, ci_policy: CI_POLICY }] }
      : { id, name: "Fresh legacy", chat_mode: "file", repo: `acme/${id}`, working_dir: workingDir };
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, projects[1][key]])), expected, `${kind}: project record`);
    assert.deepEqual(Object.fromEntries(Object.entries(projects[1].agents).map(([role, agent]) => [role, agent.cwd])),
      Object.fromEntries(["head", "re1", "re2", "dev"].map((role) => [role, `${workingDir}-${role}`])), `${kind}: agent folders`);

    assert.deepEqual(changes(beforeSnapshot, snapshot()), [
      "changed home/.quadwork",
      "changed home/.quadwork/config.json",
      `created home/.quadwork/${id}`,
      `created home/.quadwork/${id}/GITHUB.md`,
      `created home/.quadwork/${id}/HEAD-PO-PLAYBOOK.md`,
      `created home/.quadwork/${id}/OVERNIGHT-QUEUE.md`,
      `created home/.quadwork/${id}/chat`,
      `created home/.quadwork/${id}/chat/.writer.pid`,
    ], `${kind}: touched`);
    assert.match(fs.readFileSync(path.join(CONFIG_DIR, id, "OVERNIGHT-QUEUE.md"), "utf8"), new RegExp(`^> \\*\\*Repo:\\*\\* acme/${id}$`, "m"), `${kind}: queue repo`);
  }
});
