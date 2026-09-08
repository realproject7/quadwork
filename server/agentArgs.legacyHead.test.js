"use strict";

// Actual index launch/MCP composition and harmless node-pty children. The
// existing lifecycle fixture supplies capacity only; no launch-argument or
// Head-control runtime replacement, model process, or external service.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qw-legacy-head-"));
const originalHome = os.homedir;
os.homedir = () => home;
process.env.HOME = home;
process.env.QUADWORK_SKIP_LISTEN = "1";
const configDir = path.join(home, ".quadwork");
fs.mkdirSync(configDir, { mode: 0o700 });
const command = path.join(home, "claude");
const observationPath = path.join(home, "launches.jsonl");
fs.writeFileSync(command, `#!${process.execPath}
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs");
const args = process.argv.slice(2);
assert.equal(args.length, 2);
assert.equal(args[0], "--mcp-config");
const config = JSON.parse(fs.readFileSync(args[1], "utf8"));
assert.ok(config.mcpServers.chat);
const chat = config.mcpServers.chat.args;
const control = config.mcpServers.head_control;
fs.appendFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  project: chat[chat.indexOf("--project") + 1],
  role: chat[chat.indexOf("--agent") + 1],
  servers: Object.keys(config.mcpServers).sort(),
  generation: control ? Number(control.args[control.args.indexOf("--generation") + 1]) : null,
}) + "\\n");
process.stdout.write("LOCAL_MCP_FIXTURE_READY\\n");
process.stdin.resume();
`, { mode: 0o700 });
const projects = ["legacy", "v2", "invalid", "archived"].map((id) => {
  const cwd = path.join(home, id);
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(configDir, id), { mode: 0o700 });
  fs.writeFileSync(path.join(configDir, id, "OVERNIGHT-QUEUE.md"), "# Queue\n\n## Active Batch\n\n");
  return {
    id, working_dir: cwd, chat_mode: "file", archived: id === "archived",
    agents: Object.fromEntries(["head", "re1", "re2", "dev"].map((role) => [role, { cwd, command, auto_approve: false }])),
  };
});
const configPath = path.join(configDir, "config.json");
function save(extra = {}) {
  fs.writeFileSync(configPath, JSON.stringify({ projects, temp_cleanup: { enabled: false }, ...extra }), { mode: 0o600 });
}
save();
const runtime = require("./index");
const fileChat = require("./file-chat");
const fixtures = [];
const ownedKeys = [];
function mcp(project, role = "head") {
  return JSON.parse(fs.readFileSync(path.join(configDir, project, `mcp-${role}.json`), "utf8")).mcpServers;
}
function argument(entry, name) { return entry.args[entry.args.indexOf(name) + 1]; }
function controlRequest(project, generation) {
  return { method: "POST", path: "/api/head-control", body: {
    version: 1, binding: { project_id: project, actor: "head", generation },
    request: { tool: "get_pipeline_status", arguments: { idempotency_key: `idem_${project}_status`, correlation_id: `corr_${project}_status` } },
  } };
}
async function start(project) {
  fixtures.push(runtime._test.installLifecycleTestFixture(project, "head", "linux-contained"));
  ownedKeys.push(`${project}/head`);
  const result = await runtime.spawnAgentPty(project, "head", { operatorAuthorized: true, allowHeadIntake: true, suppressLifecycleMsg: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  const session = runtime.agentSessions.get(`${project}/head`);
  assert.ok(Number.isSafeInteger(session?.term?.pid) && session.term.pid > 0);
  const deadline = Date.now() + 4000;
  while (!session.scrollback.toString().includes("LOCAL_MCP_FIXTURE_READY") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(session.scrollback.toString().includes("LOCAL_MCP_FIXTURE_READY"), "real CLI accepts the ordinary MCP launch arguments");
  assert.equal(session._ptyExited, undefined);
  return session;
}

(async () => {
  try {
    fileChat.initProject("legacy");
    await start("legacy");
    let servers = mcp("legacy");
    assert.deepEqual(Object.keys(servers), ["chat"]);
    const legacyToken = argument(servers.chat, "--token");
    assert.deepEqual(fileChat.resolveShimPrincipal(legacyToken), { projectId: "legacy", agentId: "head" });
    const denied = await runtime.headControlRuntime.handle(controlRequest("legacy", 0), { token: legacyToken });
    assert.deepEqual(denied, { ok: false, error: { type: "authentication_failed" } }, "legacy chat token obtains no V2 control registration");
    assert.equal((await runtime.stopAgentSession("legacy/head", { suppressLifecycleMsg: true })).ok, true);

    save({ installation_id: "installation-legacy-launch-1096" });
    fileChat.initProject("v2");
    await start("v2");
    servers = mcp("v2");
    assert.deepEqual(Object.keys(servers).sort(), ["chat", "head_control"]);
    const token = argument(servers.chat, "--token");
    assert.equal(argument(servers.head_control, "--token"), token);
    const generation = Number(argument(servers.head_control, "--generation"));
    assert.ok(Number.isSafeInteger(generation) && generation >= 0);
    assert.equal(argument(servers.head_control, "--project"), "v2");
    assert.equal(argument(servers.head_control, "--agent"), "head");
    const accepted = await runtime.headControlRuntime.handle(controlRequest("v2", generation), { token });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const wrongGeneration = await runtime.headControlRuntime.handle(controlRequest("v2", generation + 1), { token });
    assert.equal(wrongGeneration.ok, false, "current Head token cannot choose another admission generation");
    for (const role of ["re1", "re2", "dev"]) {
      await runtime.buildAgentArgs("v2", role);
      assert.deepEqual(Object.keys(mcp("v2", role)), ["chat"]);
    }
    assert.equal((await runtime.stopAgentSession("v2/head", { suppressLifecycleMsg: true })).ok, true);

    const launches = fs.readFileSync(observationPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(launches, [
      { project: "legacy", role: "head", servers: ["chat"], generation: null },
      { project: "v2", role: "head", servers: ["chat", "head_control"], generation },
    ]);
    for (const installation_id of ["", null, "short", 123, {}, []]) {
      save({ installation_id });
      await assert.rejects(runtime.buildAgentArgs("invalid", "head"), /Head-control launch project is unavailable/);
    }
    fixtures.push(runtime._test.installLifecycleTestFixture("invalid", "head", "linux-contained"));
    const refused = await runtime.spawnAgentPty("invalid", "head", { operatorAuthorized: true, allowHeadIntake: true, suppressLifecycleMsg: true });
    assert.equal(refused.ok, false);
    assert.equal(runtime.agentSessions.get("invalid/head")?.term, null);
    assert.equal(fs.existsSync(path.join(configDir, "invalid", "mcp-head.json")), false);
    assert.equal(fs.readFileSync(observationPath, "utf8").trim().split("\n").length, 2);
    save();
    await assert.rejects(runtime.buildAgentArgs("archived", "head"), /archived/);
    assert.equal((await runtime.spawnAgentPty("archived", "head", { operatorAuthorized: true, allowHeadIntake: true })).code, "project_archived");
    console.log("agentArgs.legacyHead.test.js: real legacy/V2 CLI launches retain chat, strict control binding and archive/invalid-identity refusal");
  } finally {
    for (const key of ownedKeys) await runtime.stopAgentSession(key, { suppressLifecycleMsg: true, removeEntry: true });
    for (const release of fixtures) release();
    for (const { id } of projects) fileChat.shutdownProject(id);
    await runtime.shutdown();
    os.homedir = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
