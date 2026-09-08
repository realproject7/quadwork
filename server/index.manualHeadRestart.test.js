"use strict";

// Real authenticated HTTP and native PTY launch/stop, with ordinary MCP args.
// The existing lifecycle fixture supplies capacity, never launch admission.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "qw-manual-restart-"));
const originalHome = os.homedir;
os.homedir = () => home;
process.env.HOME = home;
process.env.QUADWORK_SKIP_LISTEN = "1";
const configDir = path.join(home, ".quadwork");
fs.mkdirSync(configDir, { mode: 0o700 });
const command = path.join(home, "claude");
const launchesPath = path.join(home, "launches.jsonl");
fs.writeFileSync(command, `#!${process.execPath}
const assert = require("node:assert/strict"), fs = require("node:fs");
const args = process.argv.slice(2);
assert.equal(args.length, 2);
assert.equal(args[0], "--mcp-config");
const mcp = JSON.parse(fs.readFileSync(args[1], "utf8")).mcpServers;
assert.ok(mcp.chat && mcp.head_control);
fs.appendFileSync(${JSON.stringify(launchesPath)}, JSON.stringify({ pid: process.pid }) + "\\n");
process.stdout.write("MANUAL_RESTART_FIXTURE_READY\\n");
process.stdin.resume();
`, { mode: 0o700 });
const projects = ["manual", "automatic", "archived", "invalid"].map((id) => {
  const cwd = path.join(home, id);
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(configDir, id), { mode: 0o700 });
  fs.writeFileSync(path.join(configDir, id, "OVERNIGHT-QUEUE.md"), "# Queue\n\n## Active Batch\n\n");
  return {
    id, archived: id === "archived",
    repositories: [{ key: "primary", repo: `fixture/${id}`, working_dir: cwd, primary: true, ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["unit", "typecheck", "build"] } }],
    agents: { head: { cwd, command, auto_approve: false } },
  };
});
const configPath = path.join(configDir, "config.json");
function save(installation_id = "installation-manual-restart-1098") {
  fs.writeFileSync(configPath, JSON.stringify({ installation_id, projects, temp_cleanup: { enabled: false } }), { mode: 0o600 });
}
save();
const runtime = require("./index");
const fileChat = require("./file-chat");
const fixtures = projects.map(({ id }) => runtime._test.installLifecycleTestFixture(id, "head", "linux-contained"));
let server;
function request(method, url, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: url, headers: token ? { "X-Session-Token": token } : {} }, (res) => {
      let data = "";
      res.setEncoding("utf8"); res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end();
  });
}
async function ready() {
  const session = runtime.agentSessions.get("manual/head");
  assert.ok(session?.term?.pid);
  const deadline = Date.now() + 4000;
  while (!session.scrollback.toString().includes("MANUAL_RESTART_FIXTURE_READY") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(session.scrollback.toString().includes("MANUAL_RESTART_FIXTURE_READY"));
  assert.notEqual(session._ptyExited, true);
  return session;
}
function launches() { return fs.readFileSync(launchesPath, "utf8").trim().split("\n").map(JSON.parse); }

(async () => {
  try {
    fileChat.initProject("manual");
    server = runtime.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const token = (await request("GET", "/api/session-token")).body.token;
    assert.equal(typeof token, "string");
    let response = await request("POST", "/api/agents/manual/head/start", token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const first = await ready(), firstPid = first.term.pid, firstGeneration = first.generationId;
    assert.equal(typeof firstGeneration, "string");
    assert.deepEqual(launches(), [{ pid: firstPid }]);

    response = await request("POST", "/api/agents/manual/head/restart");
    assert.equal(response.status, 401);
    assert.equal(runtime.agentSessions.get("manual/head"), first);
    assert.notEqual(first._ptyExited, true);
    assert.deepEqual(launches(), [{ pid: firstPid }], "unauthenticated restart neither stops nor replaces the process");

    response = await request("POST", "/api/agents/manual/head/restart", token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    const second = await ready(), secondPid = second.term.pid;
    assert.notEqual(secondPid, firstPid);
    assert.notEqual(second.generationId, firstGeneration);
    assert.equal(first._ptyExited, true, "the old native PTY exited before replacement");
    assert.equal(runtime.isPtyAlive({ pid: firstPid }), false);
    assert.deepEqual(launches(), [{ pid: firstPid }, { pid: secondPid }], "one manual restart creates exactly one replacement");
    response = await request("POST", "/api/agents/manual/head/stop", token);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    assert.equal(second._ptyExited, true);
    assert.equal(second.term, null);
    assert.equal(runtime.isPtyAlive({ pid: secondPid }), false);

    const automatic = await runtime.restartAgentSession("automatic/head", { reason: "thinking-block-400", lifecycleSource: "self_heal" });
    assert.equal(automatic.ok, false);
    assert.equal(automatic.code, "no_current_assignment");
    assert.ok(!runtime.agentSessions.get("automatic/head")?.term);
    const noIntake = await runtime.restartAgentSession("automatic/head", { reason: "default-intake-check", operatorAuthorized: true });
    assert.equal(noIntake.ok, false);
    assert.equal(noIntake.code, "no_current_assignment", "the shared helper keeps Head intake false by default");

    response = await request("POST", "/api/agents/archived/head/restart", token);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "project_archived");
    save(null);
    response = await request("POST", "/api/agents/invalid/head/restart", token);
    assert.equal(response.body.ok, false);
    assert.ok(response.status >= 400);
    assert.ok(!runtime.agentSessions.get("invalid/head")?.term);
    assert.equal(fs.existsSync(path.join(configDir, "invalid", "mcp-head.json")), false);
    assert.deepEqual(launches(), [{ pid: firstPid }, { pid: secondPid }]);
    console.log("index.manualHeadRestart.test.js: authenticated idle Head restart replaces one real process/generation; unauthorized, automatic, archived and invalid-V2 paths refuse");
  } finally {
    for (const { id } of projects) await runtime.stopAgentSession(`${id}/head`, { suppressLifecycleMsg: true, removeEntry: true });
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const release of fixtures) release();
    await runtime.shutdown();
    os.homedir = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
