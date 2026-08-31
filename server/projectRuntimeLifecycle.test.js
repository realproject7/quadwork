"use strict";

// #1034 integration coverage for the server-owned archive barrier. This test
// loads index.js without listening, seeds every Lane A runtime owner, then
// proves partial cleanup stays retryable, another project is isolated, and an
// archive that wins an awaited spawn race creates no PTY.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-runtime-lifecycle-"));
const originalHome = os.homedir;
os.homedir = () => TEST_HOME;
process.env.HOME = TEST_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";

const configDir = path.join(TEST_HOME, ".quadwork");
const reposDir = path.join(TEST_HOME, "repos");
const repoA = path.join(reposDir, "a");
const repoB = path.join(reposDir, "b");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(repoA, { recursive: true });
fs.mkdirSync(repoB, { recursive: true });

function project(id, repo, cwd) {
  return {
    id,
    name: id,
    archived: false,
    chat_mode: "file",
    repositories: [{ key: "primary", repo, working_dir: cwd, primary: true }],
    agents: { dev: { cwd, command: "claude" } },
  };
}

const configPath = path.join(configDir, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  installation_id: "installation-runtime-0001",
  projects: [project("a", "Owner/A", repoA), project("b", "Owner/B", repoB)],
}));

const routes = require("./routes");
const fileChat = require("./file-chat");
const selfHeal = require("./self-heal");
const telegramBridge = require("./bridges/telegram");
const discordBridge = require("./bridges/discord");
const dispatcher = require("./pty-dispatcher");
const runtime = require("./index");

const ownedProgress = {
  installation_id: "installation-runtime-0001",
  batch_number: 7,
  assignment_attempt: "attempt_0002",
  provenance: "owned",
  assignment_key: "assignment-7-2",
  owned: true,
  current: true,
  assignment_items: [{
    work_item_ref: { repo_key: "primary", repo: "Owner/A", number: 42, kind: "issue" },
    ownership_key: "owner-a-42-attempt-2",
  }],
  items: [{
    installation_id: "installation-runtime-0001",
    batch_number: 7,
    assignment_attempt: "attempt_0002",
    provenance: "owned",
    assignment_key: "assignment-7-2",
    owned: true,
    current: true,
    repo_key: "primary",
    repo: "Owner/A",
    number: 42,
    kind: "issue",
    work_item_ref: { repo_key: "primary", repo: "Owner/A", number: 42, kind: "issue" },
    ownership_key: "owner-a-42-attempt-2",
  }],
  completeConfirmed: false,
};
const ownedActive = { ...ownedProgress, active: true };
const ownedAutomation = runtime.ownedBatchAutomationState(ownedProgress, ownedActive);
assert.equal(ownedAutomation.authoritative, true,
  "matching current locally-owned progress and active payloads are authoritative");
assert.deepEqual(ownedAutomation.identity, {
  installation_id: "installation-runtime-0001",
  batch_number: 7,
  assignment_attempt: "attempt_0002",
  provenance: "owned",
  assignment_key: "assignment-7-2",
  assignment_items: ownedProgress.assignment_items,
}, "authoritative automation carries the exact assignment identity into route-side guards");
assert.equal(runtime.ownedBatchAutomationState(
  ownedProgress,
  { ...ownedActive, assignment_attempt: "attempt_0003", assignment_key: "assignment-7-3" },
).authoritative, false, "a stale assignment attempt cannot drive automation");
assert.equal(runtime.ownedBatchAutomationState(
  { ...ownedProgress, provenance: "legacy_unowned", owned: false },
  ownedActive,
).authoritative, false, "legacy rows are diagnostic-only and never locally claimed");
assert.equal(runtime.ownedBatchAutomationState(
  ownedProgress,
  { ...ownedActive, current: false },
).authoritative, false, "historical progress cannot become current authority");
assert.equal(runtime.ownedBatchAutomationState(
  { ...ownedProgress, items: [{ ...ownedProgress.items[0], assignment_attempt: "attempt_0001" }] },
  ownedActive,
).authoritative, false, "one stale row rejects the whole automation transition");
assert.equal(runtime.ownedBatchAutomationState(
  { ...ownedProgress, items: [{
    ...ownedProgress.items[0],
    work_item_ref: { repo_key: "other", repo: "Owner/B", number: 42, kind: "issue" },
  }] },
  ownedActive,
).authoritative, false, "a row/ref repository mismatch rejects the whole automation transition");
assert.equal(runtime.ownedBatchAutomationState(
  { ...ownedProgress, items: [{ ...ownedProgress.items[0], ownership_key: "stale-row-owner" }] },
  ownedActive,
).authoritative, false, "a row ownership key outside the exact assignment set is rejected");

const legacyProgress = {
  compatibility_mode: "v1",
  provenance: "legacy_unowned",
  owned: false,
  current: true,
  multi_repository: false,
  batch_number: 5,
  completeConfirmed: false,
  items: [{
    repo_key: "primary",
    repo: "Owner/A",
    number: 42,
    issue_number: 42,
    kind: "issue",
    work_item_ref: { repo_key: "primary", repo: "Owner/A", number: 42, kind: "issue" },
  }],
};
const legacyActive = { ...legacyProgress, active: true };
assert.equal(runtime.batchAutomationState(legacyProgress, legacyActive).mode, "v1",
  "explicit preactivation single-repository mode preserves the V1 automation lifecycle");
assert.equal(runtime.batchAutomationState(
  { ...legacyProgress, compatibility_mode: "v2" },
  { ...legacyActive, compatibility_mode: "v2" },
).authoritative, false, "activated legacy_unowned rows are never revived through the V1 compatibility path");
assert.equal(runtime.batchAutomationState(
  { ...legacyProgress, current: false, items: [], liveActiveBatchCleared: true },
  { ...legacyActive, current: false, active: false },
).shouldStop, true, "an explicit live clear remains a V1-compatible stop signal without becoming V2 ownership");

const originalCancelBackground = routes.cancelProjectBackground;

function cleanup() {
  routes.cancelProjectBackground = originalCancelBackground;
  os.homedir = originalHome;
  for (const timer of [
    ...runtime.triggers.values(),
  ]) {
    if (timer.timer) clearInterval(timer.timer);
    if (timer.durationTimer) clearTimeout(timer.durationTimer);
  }
  runtime.triggers.clear();
  telegramBridge._instances.clear();
  discordBridge._instances.clear();
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

(async () => {
  fileChat.initProject("a");
  fileChat.initProject("b");

  const events = [];
  routes.cancelProjectBackground = async (projectId) => {
    const disk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(disk.projects.find((entry) => entry.id === projectId).archived, true,
      "durable barrier is on disk before the first cleanup step");
    events.push(`routes:${projectId}`);
    return { ok: true, resources: { route_background_jobs: 0 }, cleanup_errors: [] };
  };

  let killAttempts = 0;
  const aViewer = { readyState: 1, close: () => events.push("viewer:a") };
  const aSession = {
    projectId: "a",
    agentId: "dev",
    term: {
      kill: () => {
        killAttempts += 1;
        if (killAttempts === 1) throw new Error(`secret path ${repoA}`);
        events.push("pty:a");
      },
    },
    viewers: new Set([aViewer]),
    viewerDims: new Map(),
    state: "running",
  };
  const bSession = {
    projectId: "b",
    agentId: "dev",
    term: { kill: () => events.push("pty:b") },
    viewers: new Set(),
    viewerDims: new Map(),
    state: "running",
  };
  runtime.agentSessions.set("a/dev", aSession);
  runtime.agentSessions.set("b/dev", bSession);
  runtime.mcpProxies.set("a/dev", {
    server: { close: (cb) => { events.push("mcp:a"); cb(); } },
  });

  runtime.triggers.set("a", { timer: setInterval(() => {}, 60_000) });
  runtime.triggers.set("b", { timer: setInterval(() => {}, 60_000) });
  dispatcher._pendingWake.set("a/dev", { queued: true });
  dispatcher._pendingWake.set("b/dev", { queued: true });
  selfHeal._state.set("a/dev", { countInWindow: 1 });
  selfHeal._state.set("b/dev", { countInWindow: 1 });
  telegramBridge._instances.set("a", { timer: null, updateTimer: null, stopping: false });
  telegramBridge._instances.set("b", { timer: null, updateTimer: null, stopping: false });
  discordBridge._instances.set("a", { timer: null, stopping: false, client: { destroy: async () => events.push("discord:a") } });
  discordBridge._instances.set("b", { timer: null, stopping: false, client: { destroy: async () => events.push("discord:b") } });

  const caffeinateKills = [];
  runtime.caffeinateProcess.process = { kill: (signal) => caffeinateKills.push(signal) };
  runtime.caffeinateProcess.pid = 4242;
  runtime.caffeinateProcess.manualOwner = true;
  runtime.caffeinateProcess.projectOwners.set("a", { expiresAt: null, timer: null });
  runtime.caffeinateProcess.projectOwners.set("b", { expiresAt: null, timer: null });

  const partial = await runtime.projectLifecycle.archiveProject("a");
  assert.equal(partial.ok, false, "first strict PTY failure makes archive cleanup partial");
  assert.equal(partial.archived, true, "partial cleanup keeps the barrier archived");
  assert.equal(runtime.agentSessions.has("a/dev"), true, "failed resource owner is retained for retry");
  assert.equal(runtime.agentSessions.has("b/dev"), true, "another project's session is untouched");
  assert.equal(runtime.triggers.has("a"), false);
  assert.equal(runtime.triggers.has("b"), true, "another project's trigger is untouched");
  assert.equal(dispatcher._pendingWake.has("a/dev"), false);
  assert.equal(dispatcher._pendingWake.has("b/dev"), true, "another project's deferred wake is untouched");
  assert.equal(selfHeal._state.has("a/dev"), false);
  assert.equal(selfHeal._state.has("b/dev"), true, "another project's self-heal guard is untouched");
  assert.equal(telegramBridge.isRunning("a"), false);
  assert.equal(telegramBridge.isRunning("b"), true, "another project's Telegram bridge is untouched");
  assert.equal(discordBridge.isRunning("a"), false);
  assert.equal(discordBridge.isRunning("b"), true, "another project's Discord bridge is untouched");
  assert.equal(runtime.caffeinateProcess.projectOwners.has("a"), false);
  assert.equal(runtime.caffeinateProcess.projectOwners.has("b"), true);
  assert.equal(runtime.caffeinateProcess.manualOwner, true);
  assert.deepEqual(caffeinateKills, [], "archiving A cannot stop B/manual caffeinate ownership");
  assert.equal(runtime.caffeinateStatus("a").active, false, "A status does not inherit B's global OS process");
  assert.equal(runtime.caffeinateStatus("b").active, true, "B status reflects B's own requirement");
  assert.equal(partial.resources.file_chat_engines, 1, "first cleanup reports one real file-chat engine");
  assert.ok(!JSON.stringify(partial.cleanup_errors).includes(repoA), "cleanup response never exposes a repo path");

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error("must not fetch"); };
  try {
    const blockedTrigger = await runtime.sendTriggerMessage("a");
    assert.equal(blockedTrigger.ok, false);
    assert.equal(fetchCalls, 0, "archived scheduled trigger performs zero HTTP work");
  } finally {
    global.fetch = originalFetch;
  }

  const retry = await runtime.projectLifecycle.archiveProject("a");
  assert.equal(retry.ok, true, "repeated archive retries the retained failed owner");
  assert.equal(retry.already_archived, true);
  assert.equal(runtime.agentSessions.has("a/dev"), false, "successful retry deletes the archived session map entry");
  assert.equal(runtime.mcpProxies.has("a/dev"), false);
  assert.equal(retry.resources.file_chat_engines, 0, "idempotent retry reports no already-stopped file-chat engine");
  assert.equal(events[0], "routes:a", "route background cancellation is the first runtime cleanup step");

  runtime.mcpProxies.set("b/stray", {
    stopTimeoutMs: 10,
    server: { close: () => {} },
  });
  const stuckProxy = await runtime.stopAgentSession("b/stray", { removeEntry: true });
  assert.equal(stuckProxy.ok, false, "MCP proxy timeout is a truthful partial cleanup");
  assert.equal(runtime.mcpProxies.has("b/stray"), true, "failed MCP proxy remains owned for retry");
  runtime.mcpProxies.get("b/stray").server.close = (cb) => cb();
  const retriedProxy = await runtime.stopAgentSession("b/stray", { removeEntry: true });
  assert.equal(retriedProxy.ok, true);
  assert.equal(runtime.mcpProxies.has("b/stray"), false, "MCP proxy retry clears ownership");

  runtime.registerCaffeinateOwner("timed", 0.02);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runtime.caffeinateProcess.projectOwners.has("timed"), false, "duration expiry releases only its own owner");
  assert.equal(runtime.caffeinateProcess.projectOwners.has("b"), true, "duration expiry preserves an indefinite project owner");
  assert.equal(runtime.caffeinateProcess.manualOwner, true, "duration expiry preserves the manual owner");
  assert.deepEqual(caffeinateKills, [], "one owner's duration expiry cannot stop the shared OS process");

  let releaseBuild;
  const buildGate = new Promise((resolve) => { releaseBuild = resolve; });
  let admitted = true;
  let ptySpawns = 0;
  const spawnPromise = runtime.spawnAgentPty("b", "dev", {
    captureProjectAdmission: () => ({ project_id: "b", generation: 0 }),
    isAdmissionCurrent: () => admitted,
    buildAgentArgs: async () => { await buildGate; return { args: [] }; },
    ptySpawn: () => { ptySpawns += 1; throw new Error("must not spawn"); },
  });
  admitted = false;
  releaseBuild();
  const raced = await spawnPromise;
  assert.equal(raced.code, "project_archived");
  assert.equal(ptySpawns, 0, "archive during awaited spawn preparation creates no PTY");

  const beforeUnarchiveSessions = runtime.agentSessions.size;
  const restored = await runtime.projectLifecycle.unarchiveProject("a");
  assert.equal(restored.ok, true);
  assert.equal(runtime.agentSessions.size, beforeUnarchiveSessions, "unarchive does not auto-start runtime work");
  assert.equal(runtime.triggers.has("a"), false);
  assert.equal(telegramBridge.isRunning("a"), false);
  assert.equal(discordBridge.isRunning("a"), false);

  const liveCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const liveB = liveCfg.projects.find((entry) => entry.id === "b");
  liveB.trigger_auto = true;
  liveB.telegram_auto = true;
  liveB.discord_auto = true;
  fs.writeFileSync(configPath, JSON.stringify(liveCfg));

  const lifecycleApi = require("./project-lifecycle");
  const staleBridgeAdmission = lifecycleApi.captureProjectAdmission("b");
  let directBridgeFetches = 0;
  const stopBodies = [];
  const bridgeFetch = global.fetch;
  global.fetch = async (_url, options = {}) => {
    directBridgeFetches += 1;
    if (options.body) stopBodies.push(JSON.parse(options.body));
    return { ok: true };
  };
  try {
    await runtime.autoStopBridges("b", liveB, 8400, staleBridgeAdmission, ownedAutomation);
    assert.equal(directBridgeFetches, 2);
    assert.ok(stopBodies.every((body) => body.admission_generation === staleBridgeAdmission.generation),
      "auto-stop requests carry the captured lease for route-side stale-cycle rejection");
    assert.ok(stopBodies.every((body) => body.assignment_key === ownedProgress.assignment_key &&
      body.assignment_attempt === ownedProgress.assignment_attempt),
    "auto-stop requests carry the exact queue assignment for route-side rollover rejection");
    directBridgeFetches = 0;
    lifecycleApi.revokeProjectAdmission("b");
    await runtime.autoStartBridges("b", liveB, 8400, staleBridgeAdmission);
    await runtime.autoStopBridges("b", liveB, 8400, staleBridgeAdmission);
    assert.equal(directBridgeFetches, 0,
      "stale generation blocks both auto-start and auto-stop bridge decisions");
  } finally {
    global.fetch = bridgeFetch;
  }

  let staleFetches = 0;
  const savedFetch = global.fetch;
  global.fetch = async () => {
    staleFetches += 1;
    return {
      ok: true,
      json: async () => {
        lifecycleApi.revokeProjectAdmission("b");
        return { items: [{ id: 1 }], complete: false };
      },
    };
  };
  try {
    const staleTrigger = await runtime.sendTriggerMessage("b");
    assert.equal(staleTrigger.code, "project_admission_changed");
    assert.equal(staleFetches, 2, "stale trigger decision fetches only progress + active authority and never reaches its chat write");
    staleFetches = 0;
    await runtime.autoStopPollingTick();
    assert.equal(staleFetches, 2, "stale batch poll fetches only progress + active authority and never reaches bridge auto-start");
  } finally {
    global.fetch = savedFetch;
  }

  let proxyClose;
  runtime.agentSessions.set("b/dev", {
    projectId: "b",
    agentId: "dev",
    term: { kill: () => {} },
    viewers: new Set(),
    viewerDims: new Map(),
    state: "running",
  });
  runtime.mcpProxies.set("b/dev", { server: { close: (cb) => { proxyClose = cb; } } });
  const staleRestart = runtime.restartAgentSession("b/dev", { reason: "stale-generation-test" });
  await new Promise((resolve) => setImmediate(resolve));
  lifecycleApi.revokeProjectAdmission("b");
  proxyClose();
  const staleRestartResult = await staleRestart;
  assert.equal(staleRestartResult.code, "project_admission_changed",
    "archive/unarchive generation change blocks a restart decision captured before its await");

  dispatcher.cleanupSession("b/dev");
  fileChat.shutdownProject("b");
  assert.equal(runtime.releaseProjectCaffeinate("b").ok, true);
  runtime.caffeinateProcess.process.kill = () => { throw new Error("cannot stop"); };
  const failedManualStop = runtime.releaseManualCaffeinate();
  assert.equal(failedManualStop.ok, false, "caffeinate stop failure is not reported as success");
  assert.equal(runtime.caffeinateProcess.manualOwner, true, "failed caffeinate owner is retained for retry");
  assert.ok(runtime.caffeinateProcess.process, "failed caffeinate process remains owned");
  runtime.caffeinateProcess.process.kill = (signal) => caffeinateKills.push(signal);
  assert.equal(runtime.releaseManualCaffeinate().ok, true, "caffeinate stop retry succeeds");
  assert.equal(runtime.caffeinateProcess.process, null);
  console.log("projectRuntimeLifecycle.test.js: all assertions passed");
  cleanup();
})().catch((err) => {
  console.error(err);
  cleanup();
  process.exitCode = 1;
});
