// #971: field-scoped per-project flag endpoint + whole-config PUT preservation.
//   - PATCH /api/projects/:id/flags merges ONLY whitelisted flags atomically, so
//     two concurrent toggles on different fields both persist (no lost update).
//   - a whole-config PUT (SettingsPage.save) can't clobber a flag or overwrite
//     the raw operator_name it only ever GET's in sanitized form.
//
// Spins up express + the real router against a temp HOME. Plain node:assert.

const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `config-flags-${process.pid}-${Date.now()}`);
const CONFIG_DIR = path.join(TMP, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const origHome = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => { os.homedir = origHome; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const writeCfg = (o) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(o, null, 2));
const readCfg = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

writeCfg({ port: 8400, operator_name: "Alice!", projects: [{ id: "lv", name: "lv" }] });

const router = require("./routes");
const express = require("express");

function req(server, { method = "GET", urlPath, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port, method, path: urlPath,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log(`  PASS: ${m}`); };
const PATCH = (server, id, flags) => req(server, { method: "PATCH", urlPath: `/api/projects/${id}/flags`, body: flags });

(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  try {
    // ── Concurrent toggles on DIFFERENT fields both persist ──────────────────
    const [a, b] = await Promise.all([
      PATCH(server, "lv", { idle: true }),
      PATCH(server, "lv", { awake_auto: true }),
    ]);
    ok(a.status === 200 && b.status === 200, "two concurrent flag PATCHes both return 200");
    let entry = readCfg().projects.find((p) => p.id === "lv");
    ok(entry.idle === true && entry.awake_auto === true, "both concurrent toggles persist (no lost update)");

    // ── More flags, multi-field, and the loop-guard delay ────────────────────
    await Promise.all([
      PATCH(server, "lv", { telegram_auto: true }),
      PATCH(server, "lv", { discord_auto: true }),
      PATCH(server, "lv", { trigger_auto: true }),
      PATCH(server, "lv", { bridge_filter_agents_only: true }),
      PATCH(server, "lv", { auto_continue_loop_guard: true, auto_continue_delay_sec: 45 }),
    ]);
    entry = readCfg().projects.find((p) => p.id === "lv");
    ok(entry.telegram_auto && entry.discord_auto && entry.trigger_auto && entry.bridge_filter_agents_only &&
       entry.auto_continue_loop_guard === true && entry.auto_continue_delay_sec === 45 && entry.idle === true,
       "five concurrent multi-field toggles all persist, none clobbered");

    // ── Validation ───────────────────────────────────────────────────────────
    ok((await PATCH(server, "lv", { bogus: true })).status === 400, "unknown flag → 400");
    ok((await PATCH(server, "lv", { idle: "yes" })).status === 400, "wrong type (string for boolean) → 400");
    ok((await PATCH(server, "lv", { auto_continue_delay_sec: -1 })).status === 400, "negative delay → 400");
    ok((await PATCH(server, "ghost", { idle: true })).status === 404, "unknown project → 404");
    ok((await req(server, { method: "PATCH", urlPath: "/api/projects/lv/flags", body: {} })).status === 400, "empty body → 400");

    // ── Whole-config PUT can't clobber a flag or the raw operator_name ────────
    // Simulate SettingsPage.save with a STALE snapshot: idle=false (stale) and
    // operator_name = the sanitized value it GET'd.
    const getCfg = JSON.parse((await req(server, { urlPath: "/api/config" })).body);
    ok(getCfg.operator_name === "Alice", "GET /api/config returns the SANITIZED operator_name");
    getCfg.projects[0].idle = false; // stale — a concurrent PATCH set it true
    const put = await req(server, { method: "PUT", urlPath: "/api/config", body: getCfg });
    ok(put.status === 200, "whole-config PUT succeeds");
    const disk = readCfg();
    ok(disk.projects[0].idle === true, "whole-config PUT did NOT clobber the field-scoped idle flag (kept disk value)");
    ok(disk.operator_name === "Alice!", "raw operator_name survives a Settings save (not overwritten with sanitized)");

    // ── PATCH /api/config: the section-merge Settings save (no whole-config PUT) ─
    // Send only owned sections (Settings strips the flags): operator_name echoed
    // sanitized, a new top-level (butler), and a project with edited agents.
    const patch = await req(server, { method: "PATCH", urlPath: "/api/config", body: {
      operator_name: "Alice", // sanitized echo — must keep raw "Alice!"
      butler: { command: "claude", model: "opus" },
      projects: [{ id: "lv", name: "Renamed", agents: { head: { command: "codex" } } }],
    }});
    ok(patch.status === 200, "PATCH /api/config (section merge) → 200");
    const d2 = readCfg();
    ok(d2.operator_name === "Alice!", "PATCH keeps the raw operator_name on a sanitized echo");
    ok(d2.butler && d2.butler.command === "claude" && d2.butler.model === "opus", "PATCH merges an owned top-level section (butler)");
    ok(d2.projects[0].name === "Renamed" && d2.projects[0].agents.head.command === "codex", "PATCH merges owned per-project fields (name, agents)");
    ok(d2.projects[0].idle === true && d2.projects[0].telegram_auto === true, "PATCH preserves the field-scoped flags from disk (no clobber)");

    // PATCH must never touch the field-scoped-owned top-level keys.
    writeCfg({ ...readCfg(), pinned_projects: ["lv"] });
    await req(server, { method: "PATCH", urlPath: "/api/config", body: { pinned_projects: [], operator_name: "Bob" } });
    ok(readCfg().pinned_projects.length === 1, "PATCH ignores field-scoped-owned top-level keys (pinned_projects untouched)");

    // A project id not on disk is appended (Settings can add a project).
    await req(server, { method: "PATCH", urlPath: "/api/config", body: { projects: [{ id: "new", name: "New" }] } });
    ok(readCfg().projects.some((p) => p.id === "new") && readCfg().projects.some((p) => p.id === "lv"),
       "PATCH appends a new project without dropping existing ones");

    // ── DELETE /api/projects/:id — Settings "Remove" persists a deletion ─────
    // (the section-merge PATCH intentionally never drops projects).
    ok(readCfg().projects.some((p) => p.id === "new"), "precondition: 'new' project exists");
    const del = await req(server, { method: "DELETE", urlPath: "/api/projects/new" });
    ok(del.status === 200, "DELETE /api/projects/new → 200");
    ok(!readCfg().projects.some((p) => p.id === "new"), "deleted project is removed from disk");
    ok(readCfg().projects.some((p) => p.id === "lv"), "DELETE leaves other projects intact");
    ok((await req(server, { method: "DELETE", urlPath: "/api/projects/nope" })).status === 404, "DELETE unknown project → 404");

    console.log(`\n${passed} passed`);
    console.log("server/configFlags.test.js: all assertions passed");
  } finally {
    server.close();
  }
  process.exit(0);
})().catch((err) => { console.error(err.message || err); process.exit(1); });
