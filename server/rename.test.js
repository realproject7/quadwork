// POST /api/rename after the scheduled trigger's removal: a retained legacy
// `trigger_message` is disabled data, so a project or agent rename must leave
// it untouched and report no `trigger_message` change.
//
// Spins up express + the real router against a temp HOME. Plain node:assert.

const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `rename-${process.pid}-${Date.now()}`);
const CONFIG_DIR = path.join(TMP, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const origHome = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => { os.homedir = origHome; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const readCfg = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const LEGACY_MESSAGE = "@head @dev Queue check for OldName";
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  port: 8400,
  projects: [{ id: "lv", name: "OldName", trigger_message: LEGACY_MESSAGE, agents: { dev: { display_name: "Dev", agents_md: "You are Dev" } } }],
}, null, 2));

const router = require("./routes");
const express = require("express");

function post(server, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/rename",
      headers: { "content-type": "application/json", "content-length": payload.length } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString()) })); });
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log(`  PASS: ${m}`); };

(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const project = await post(server, { type: "project", projectId: "lv", oldName: "OldName", newName: "NewName" });
    ok(project.status === 200 && project.body.ok === true, "project rename succeeds");
    ok(readCfg().projects[0].name === "NewName", "project rename updates the name");
    ok(!project.body.changes.includes("trigger_message"), "project rename reports no trigger_message change");
    ok(readCfg().projects[0].trigger_message === LEGACY_MESSAGE, "project rename leaves the retained legacy trigger_message untouched");

    const agent = await post(server, { type: "agent", projectId: "lv", agentId: "dev", oldName: "Dev", newName: "Builder" });
    ok(agent.status === 200 && agent.body.changes.includes("agents_md"), "agent rename still rewrites agents_md");
    ok(!agent.body.changes.includes("trigger_message"), "agent rename reports no trigger_message change");
    ok(readCfg().projects[0].trigger_message === LEGACY_MESSAGE, "agent rename leaves the retained legacy trigger_message untouched");
  } finally {
    await new Promise((r) => server.close(r));
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
