// #944: pinned_projects / sidebar_groups reset on server restart.
// Root cause: they persisted via the whole-config GET→mutate→PUT path, so any
// concurrent writer holding a stale snapshot (and a restart fires several at
// once) silently dropped them. This test proves the fix:
//   1. PUT /api/pins / PUT /api/sidebar-groups read fresh server-side and write
//      ONLY their own key (other keys untouched, input validated/sanitized).
//   2. A stale whole-config PUT (settings / idle / bridge widgets) can NEVER
//      clobber pins or groups — the server preserves the on-disk values.
//   3. Pins/groups survive the startup config-rewrite and a version-bump reseed.
//
// Plain node:assert script — run with `node server/routes.persistPins.test.js`.

const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `routes-pins-test-${process.pid}-${Date.now()}`);

// Override HOME BEFORE requiring config/routes — config.js resolves CONFIG_PATH
// from os.homedir() at module load time.
const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const CONFIG_DIR = path.join(TEST_DIR, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// Seed an initial config carrying pins/groups alongside unrelated keys, so we
// can prove the field-scoped writes leave everything else intact.
fs.mkdirSync(CONFIG_DIR, { recursive: true });
const INITIAL = {
  port: 8400,
  operator_name: "alice",
  file_chat_switchover_done: false,
  pinned_projects: ["quadwork", "plotlink"],
  sidebar_groups: [{ name: "Work", projects: ["quadwork"] }],
  projects: [{ id: "quadwork", name: "QuadWork" }],
};
fs.writeFileSync(CONFIG_PATH, JSON.stringify(INITIAL, null, 2));

const config = require("./config");
const router = require("./routes");
const express = require("express");

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

function readDisk() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function req(server, { method = "GET", urlPath, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  try {
    // --- PUT /api/pins updates ONLY pinned_projects (deduped), other keys intact
    const setPins = await req(server, { method: "PUT", urlPath: "/api/pins", body: { pinned_projects: ["a", "b", "a"] } });
    assert.equal(setPins.status, 200, "PUT /api/pins succeeds");
    let disk = readDisk();
    assert.deepEqual(disk.pinned_projects, ["a", "b"], "pins set + deduped server-side");
    assert.equal(disk.operator_name, "alice", "unrelated key preserved by pins write");
    assert.deepEqual(disk.sidebar_groups, INITIAL.sidebar_groups, "groups untouched by pins write");
    assert.equal(disk.projects.length, 1, "projects preserved by pins write");
    console.log("PASS: PUT /api/pins writes only pinned_projects, preserving everything else");

    // --- PUT /api/sidebar-groups updates ONLY sidebar_groups (sanitized)
    const setGroups = await req(server, {
      method: "PUT",
      urlPath: "/api/sidebar-groups",
      body: { sidebar_groups: [{ name: "G", projects: ["a"], extra: "drop-me" }] },
    });
    assert.equal(setGroups.status, 200, "PUT /api/sidebar-groups succeeds");
    disk = readDisk();
    assert.deepEqual(disk.sidebar_groups, [{ name: "G", projects: ["a"] }], "groups set, sanitized to { name, projects }");
    assert.deepEqual(disk.pinned_projects, ["a", "b"], "pins untouched by groups write");
    console.log("PASS: PUT /api/sidebar-groups writes only sidebar_groups, sanitized");

    // --- CORE AC: a STALE whole-config PUT must NOT clobber pins/groups ---
    // Mirror a settings/idle/bridge save that GET'd config before the writes
    // above, so its body carries stale pinned_projects/sidebar_groups values.
    const stalePut = await req(server, {
      method: "PUT",
      urlPath: "/api/config",
      body: {
        port: 8400,
        operator_name: "bob",
        file_chat_switchover_done: true,
        pinned_projects: ["STALE"],
        sidebar_groups: [{ name: "STALE", projects: [] }],
        projects: [{ id: "quadwork", name: "QuadWork" }],
      },
    });
    assert.equal(stalePut.status, 200, "stale whole-config PUT succeeds");
    disk = readDisk();
    assert.deepEqual(disk.pinned_projects, ["a", "b"], "stale full PUT did NOT clobber pins");
    assert.deepEqual(disk.sidebar_groups, [{ name: "G", projects: ["a"] }], "stale full PUT did NOT clobber groups");
    assert.equal(disk.operator_name, "bob", "the full PUT's own field still applied");
    console.log("PASS: a stale whole-config PUT cannot drop pinned_projects/sidebar_groups");

    // --- Validation: malformed shapes rejected with 400, disk unchanged ---
    assert.equal((await req(server, { method: "PUT", urlPath: "/api/pins", body: { pinned_projects: "nope" } })).status, 400, "non-array pins → 400");
    assert.equal((await req(server, { method: "PUT", urlPath: "/api/pins", body: { pinned_projects: [1, 2] } })).status, 400, "non-string pin ids → 400");
    assert.equal((await req(server, { method: "PUT", urlPath: "/api/sidebar-groups", body: { sidebar_groups: {} } })).status, 400, "non-array groups → 400");
    assert.equal((await req(server, { method: "PUT", urlPath: "/api/sidebar-groups", body: { sidebar_groups: [{ projects: [] }] } })).status, 400, "group missing name → 400");
    disk = readDisk();
    assert.deepEqual(disk.pinned_projects, ["a", "b"], "rejected writes left pins unchanged");
    assert.deepEqual(disk.sidebar_groups, [{ name: "G", projects: ["a"] }], "rejected writes left groups unchanged");
    console.log("PASS: malformed pins/groups payloads are rejected and leave config untouched");

    // --- GET /api/config reflects the field-scoped values ---
    const got = JSON.parse((await req(server, { urlPath: "/api/config" })).buf.toString());
    assert.deepEqual(got.pinned_projects, ["a", "b"], "GET reflects current pins");
    assert.deepEqual(got.sidebar_groups, [{ name: "G", projects: ["a"] }], "GET reflects current groups");
  } finally {
    server.close();
  }

  // --- BOOT TEST 1: the startup config-rewrite preserves pins/groups ---
  // Mirror server/index.js startup: readConfig() (whole file) → set a one-time
  // startup flag → writeConfig(). The freshly-read snapshot carries pins/groups,
  // so the rewrite cannot drop them.
  {
    const cfg = config.readConfig();
    assert.deepEqual(cfg.pinned_projects, ["a", "b"], "readConfig carries pins into startup");
    cfg.file_chat_switchover_done = true; // the gated one-time startup write
    config.writeConfig(cfg);
    const disk = readDisk();
    assert.deepEqual(disk.pinned_projects, ["a", "b"], "pins survive the startup config rewrite");
    assert.deepEqual(disk.sidebar_groups, [{ name: "G", projects: ["a"] }], "groups survive the startup config rewrite");
    console.log("PASS: pinned_projects/sidebar_groups survive the startup config rewrite");
  }

  // --- BOOT TEST 2: a version-bump reseed never rewrites config.json ---
  // autoReseedOnStartup persists only ~/.quadwork/reseed-state.json, so a
  // version-bump restart (the issue's reseed case) leaves config.json — and
  // therefore pins/groups — byte-identical.
  {
    const before = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = config.readConfig();
    cfg.projects = [{ id: "quadwork", name: "QuadWork", working_dir: TEST_DIR }];
    await router.autoReseedOnStartup(cfg, {
      version: "9.9.9-bump",
      statePath: path.join(CONFIG_DIR, "reseed-state.json"),
      log: () => {},
      getProgress: async () => ({ complete: true, completeConfirmed: true, items: [] }),
      isActiveFromProgress: () => false,
      performWrites: () => ({ reseeded: [], skipped: [], preserved: [] }),
    });
    const after = fs.readFileSync(CONFIG_PATH, "utf-8");
    assert.equal(after, before, "version-bump reseed left config.json byte-identical (pins/groups intact)");
    console.log("PASS: version-bump reseed does not touch config.json");
  }

  console.log("routes.persistPins.test.js: all assertions passed");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
