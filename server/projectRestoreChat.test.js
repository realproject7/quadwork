"use strict";

// #1183: a restored project's chat works at once, with no server restart.
// index.js is loaded without listening against an isolated HOME. Archive and
// restore go through the real HTTP route, lifecycle controller and runtime
// cleanup; the chat post goes through the real chat route and the lifecycle
// lines through the real agent launch path. The project is active, V2-ready
// with an owned Active Batch and has both bridges configured, and its Monitor
// and bridges really run before archive, so a restore that started any of them
// again would be seen. A lost lifecycle line and a chat that cannot restart
// are logged and reported, and a shutdown that overlaps a restore leaves no
// chat behind. Nothing leaves the process: the agent PTY is an in-memory
// stand-in, fetch and discord.js are doubles, and batch progress is served
// without GitHub. Plain node:assert.

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-restore-chat-"));
const originalHome = os.homedir;
os.homedir = () => TEST_HOME;
process.env.HOME = TEST_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";

const INSTALLATION = "installation_restore_chat_1183";
const configDir = path.join(TEST_HOME, ".quadwork");
const configPath = path.join(configDir, "config.json");
const repo = path.join(TEST_HOME, "repo");
fs.mkdirSync(path.join(configDir, "rc"), { recursive: true });
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({
  installation_id: INSTALLATION,
  temp_cleanup: { enabled: false },
  projects: [{
    id: "rc",
    name: "rc",
    archived: false,
    chat_mode: "file",
    repositories: [{
      key: "primary",
      repo: "Owner/RestoreChat",
      working_dir: repo,
      primary: true,
      ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["operator"] },
    }],
    agents: {
      head: { cwd: repo, command: "/bin/sh", mcp_inject: "none" },
      dev: { cwd: repo, command: "/bin/sh", mcp_inject: "none" },
    },
    telegram: { bot_token: "1183:restore-chat-fixture", chat_id: "1183" },
    discord: { bot_token: "restore-chat-fixture", channel_id: "1183" },
    telegram_auto: true,
    discord_auto: true,
  }],
}), { mode: 0o600 });
fs.writeFileSync(path.join(configDir, "rc", "OVERNIGHT-QUEUE.md"), [
  "## Active Batch",
  "**Batch:** 7",
  "**Batch type:** code",
  `**Installation ID:** ${INSTALLATION}`,
  "**Assignment attempt:** attempt_a",
  "- Owner/RestoreChat#42 active",
].join("\n"));

const fileChat = require("./file-chat");
const routes = require("./routes");
const telegramBridge = require("./bridges/telegram");
const discordBridge = require("./bridges/discord");
const runtime = require("./index");

const chatFile = path.join(configDir, "rc", "chat", "general.jsonl");
const writerLock = path.join(configDir, "rc", "chat", ".writer.pid");
let server;

// Offline doubles. Every fetch is recorded and answered here (local chat reads
// get an empty list, the Telegram API an empty update list), discord.js logs
// in to nothing, and batch progress never reaches GitHub.
const fetches = [];
const originalFetch = global.fetch;
global.fetch = async (url) => {
  const target = String(url);
  fetches.push(target);
  const body = target.startsWith("https://api.telegram.org/") ? { ok: true, result: [] } : [];
  return { ok: true, status: 200, json: async () => body };
};
const discordLogins = [];
class FakeDiscordClient {
  constructor() { this.channels = { fetch: async () => ({ send: async () => {} }) }; }
  async login(token) { discordLogins.push(token); }
  on() {}
  async destroy() {}
}
discordBridge._setDiscordLibForTest({
  Client: FakeDiscordClient,
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
});
const originalBatchProgress = routes.getOrComputeBatchProgress;
routes.getOrComputeBatchProgress = async () => null;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method,
      path: urlPath,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

function chatRecords() {
  if (!fs.existsSync(chatFile)) return [];
  return fs.readFileSync(chatFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function projectSessions() {
  return [...runtime.agentSessions.keys()].filter((key) => key.startsWith("rc/"));
}

async function monitorMode() {
  return (await runtime.readHeadProjectStatus("rc")).monitor.mode;
}

// The same operator start the /api/agents/:project/:agent/start route makes,
// with an in-memory PTY in place of a real process.
function launch(agent) {
  return runtime.spawnAgentPty("rc", agent, {
    lifecycleSource: "operator_start",
    operatorAuthorized: true,
    allowHeadIntake: true,
    explicitRole: true,
    buildAgentArgs: async () => ({ args: [] }),
    ptySpawn: () => ({
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write() {},
      resize() {},
      kill() {},
    }),
  });
}

async function stopAgents() {
  for (const agent of ["head", "dev"]) {
    const result = await runtime.stopAgentSession(`rc/${agent}`, { suppressLifecycleMsg: true, removeEntry: true });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
}

(async () => {
  const fixtures = ["head", "dev"].map((agent) => runtime._test.installLifecycleTestFixture("rc", agent, "linux-contained"));
  const originalConsoleError = console.error;
  try {
    // QUADWORK_SKIP_LISTEN skips the startup hook that initializes every
    // admitted project's chat, so do what startup does.
    fileChat.initProject("rc");
    server = runtime.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    // Bridge routes address the configured port; point it at this server.
    const liveConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...liveConfig, port: server.address().port }), { mode: 0o600 });

    let response = await request("POST", "/api/chat?project=rc", { text: "before archive" });
    assert.equal(response.status, 200, response.text);

    // Controls: in this fixture the Monitor and both bridges really run, so the
    // AC 5 checks after restore can see them if restore starts them again.
    const monitorStarted = await runtime.startProjectMonitor("rc");
    assert.equal(monitorStarted.applied, true, JSON.stringify(monitorStarted));
    assert.equal(await monitorMode(), "enabled", "fixture: the Monitor really runs before archive");
    for (const kind of ["telegram", "discord"]) {
      response = await request("POST", `/api/${kind}?action=start`, { project_id: "rc" });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.running, true, response.text);
    }
    assert.equal(telegramBridge.isRunning("rc"), true, "fixture: the Telegram bridge really runs before archive");
    assert.equal(discordBridge.isRunning("rc"), true, "fixture: the Discord bridge really runs before archive");
    const lastIdBeforeArchive = chatRecords().at(-1).id;

    // AC 2: archive shuts the chat down, and it stays shut while archived.
    response = await request("PUT", "/api/projects/rc/archive", { archived: true });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.archived, true);
    assert.equal(response.json.resources.file_chat_engines, 1, "archive stops the live chat engine");
    assert.equal(fileChat.isProjectInitialized("rc"), false, "archive shuts the project's chat down");
    assert.equal(await monitorMode(), "archived", "archive archives the running Monitor");
    assert.equal(telegramBridge.isRunning("rc"), false, "archive stops the Telegram bridge");
    assert.equal(discordBridge.isRunning("rc"), false, "archive stops the Discord bridge");
    response = await request("POST", "/api/chat?project=rc", { text: "while archived" });
    assert.equal(response.status, 409, response.text);
    assert.equal(response.json.code, "project_archived");
    assert.equal((await launch("dev")).code, "project_archived", "an archived project launches no agent");
    assert.equal(fileChat.isProjectInitialized("rc"), false, "archived chat stays shut down");

    // A restore whose cleanup cannot finish keeps the project archived, so its
    // chat must stay shut down too.
    runtime.agentSessions.set("rc/dev", {
      projectId: "rc",
      agentId: "dev",
      term: { kill: () => { throw new Error("stuck PTY"); } },
      viewers: new Set(),
      viewerDims: new Map(),
      state: "running",
    });
    response = await request("PUT", "/api/projects/rc/archive", { archived: false });
    assert.equal(response.status, 503, response.text);
    assert.equal(response.json.archived, true, "incomplete cleanup keeps the project archived");
    assert.equal(fileChat.isProjectInitialized("rc"), false, "a held restore does not start the archived chat");
    response = await request("POST", "/api/chat?project=rc", { text: "held restore" });
    assert.equal(response.status, 409, response.text);
    runtime.agentSessions.get("rc/dev").term.kill = () => {};

    // AC 1: a completed restore brings the chat back with no restart.
    await flush();
    const fetchesBeforeRestore = fetches.length;
    const loginsBeforeRestore = discordLogins.length;
    response = await request("PUT", "/api/projects/rc/archive", { archived: false });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.archived, false);
    assert.deepEqual(response.json.cleanup_errors, []);
    assert.equal(fileChat.isProjectInitialized("rc"), true, "restore re-initializes the project's chat");

    // AC 5: only chat came back. No agent session, Monitor or bridge started.
    await flush();
    assert.deepEqual(projectSessions(), [], "restore starts no agent session");
    assert.equal(await monitorMode(), "suspended", "restore leaves the Monitor suspended");
    assert.equal(telegramBridge.isRunning("rc"), false, "restore starts no Telegram bridge");
    assert.equal(discordBridge.isRunning("rc"), false, "restore starts no Discord bridge");
    assert.deepEqual(fetches.slice(fetchesBeforeRestore), [], "restore makes no bridge or network request");
    assert.equal(discordLogins.length, loginsBeforeRestore, "restore logs no Discord bridge in");

    response = await request("POST", "/api/chat?project=rc", { text: "after restore" });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.message.id, lastIdBeforeArchive + 1, "the restored chat continues its persisted history");

    // Lifecycle lines from the real launch path land in the restored chat.
    const beforeLaunch = chatRecords().length;
    const dev = await launch("dev");
    assert.equal(dev.ok, true, JSON.stringify(dev));
    const head = await launch("head");
    assert.equal(head.ok, true, JSON.stringify(head));
    const lines = chatRecords().slice(beforeLaunch);
    assert.ok(lines.some((record) => record.sender === "system" && record.type === "system" && record.text === "dev joined"),
      `"dev joined" is recorded after restore: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((record) => record.type === "system" && record.text === "head joined"),
      `"head joined" is recorded after restore: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((record) => record.trusted_event?.scope === "head_lifecycle" &&
      record.trusted_event.anchors.operation_id === head.lifecycle.operation_id),
    `the Head recovery line is recorded after restore: ${JSON.stringify(lines)}`);
    await stopAgents();

    // AC 4: a lost lifecycle line is logged, never silent. Stop the engine of
    // an admitted project (the state restore left behind before this fix) and
    // launch again: both writers must report the failed chat write.
    fileChat.shutdownProject("rc");
    const recordedBefore = chatRecords().length;
    const logged = [];
    console.error = (...args) => { logged.push(args.map(String).join(" ")); };
    let lostDev;
    let lostHead;
    try {
      lostDev = await launch("dev");
      lostHead = await launch("head");
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(lostDev.ok, true, JSON.stringify(lostDev));
    assert.equal(lostHead.ok, true, JSON.stringify(lostHead));
    assert.equal(chatRecords().length, recordedBefore, "the stopped engine records none of the lines");
    const lost = (fragment) => logged.some((line) => line.startsWith("[file-chat] rc: ") &&
      line.includes(fragment) && line.includes("Project rc not initialized"));
    assert.ok(lost('lifecycle line "dev joined" not recorded'), `a failed "dev joined" write is logged: ${JSON.stringify(logged)}`);
    assert.ok(lost('lifecycle line "head joined" not recorded'), `a failed "head joined" write is logged: ${JSON.stringify(logged)}`);
    assert.ok(lost("Head recovery line not recorded"), `a failed Head recovery write is logged: ${JSON.stringify(logged)}`);
    await stopAgents();

    // A chat that cannot start again is reported, not swallowed. The project
    // stays restored, the response carries only the typed entry and its safe
    // retry (archive and restore, never a server restart), and the raw cause
    // (here an unreadable chat history) stays in the server log.
    response = await request("PUT", "/api/projects/rc/archive", { archived: true });
    assert.equal(response.status, 200, response.text);
    const restartLog = [];
    const readFileSync = fs.readFileSync;
    fs.readFileSync = function (target, ...args) {
      if (target === chatFile) throw Object.assign(new Error("fixture history read failed"), { code: "EIO" });
      return readFileSync.call(this, target, ...args);
    };
    console.error = (...args) => { restartLog.push(args.map(String).join(" ")); };
    try {
      response = await request("PUT", "/api/projects/rc/archive", { archived: false });
    } finally {
      console.error = originalConsoleError;
      fs.readFileSync = readFileSync;
    }
    assert.equal(response.status, 503, response.text);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.archived, false, "the committed restore is still reported");
    assert.deepEqual(response.json.cleanup_errors, [{
      resource: "file_chat",
      code: "file_chat_start_failed",
      message: "Project chat did not start. Archive and restore the project to retry. If it keeps failing, check the project's chat files. Restarting QuadWork will fail until the cause is fixed.",
    }]);
    assert.equal(response.text.includes("fixture history read failed"), false, "the raw cause stays out of the response");
    assert.equal(fileChat.isProjectInitialized("rc"), false, "a failed restart leaves no half-started chat");
    assert.ok(restartLog.some((line) => line === "[project-lifecycle] rc: file chat restart failed: fixture history read failed"),
      `the raw cause is logged: ${JSON.stringify(restartLog)}`);

    // The advised retry works: archive and restore again starts the chat.
    response = await request("PUT", "/api/projects/rc/archive", { archived: true });
    assert.equal(response.status, 200, response.text);
    response = await request("PUT", "/api/projects/rc/archive", { archived: false });
    assert.equal(response.status, 200, response.text);
    assert.equal(fileChat.isProjectInitialized("rc"), true, "archive and restore again retries the chat start");

    // A shutdown that begins while a restore is in flight stops every chat at
    // once. The restore still commits, but it must not start this chat after
    // that, or a live writer lock would outlive the stopped server.
    response = await request("PUT", "/api/projects/rc/archive", { archived: true });
    assert.equal(response.status, 200, response.text);
    const restoring = runtime.projectLifecycle.unarchiveProject("rc");
    const stopping = runtime.shutdown();
    const [restored, stopped] = await Promise.all([restoring, stopping]);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.archived, false, "the restore committed, so its chat hook ran during shutdown");
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(fileChat.isProjectInitialized("rc"), false, "no chat is started once shutdown has begun");
    assert.equal(fs.existsSync(writerLock), false, "no writer lock outlives the stopped server");

    console.log("projectRestoreChat.test.js: all assertions passed");
  } finally {
    console.error = originalConsoleError;
    for (const release of fixtures) release();
    if (server) await new Promise((resolve) => server.close(resolve));
    await runtime.shutdown();
    global.fetch = originalFetch;
    routes.getOrComputeBatchProgress = originalBatchProgress;
    os.homedir = originalHome;
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
