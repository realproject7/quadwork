const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `bridges-test-${process.pid}-${Date.now()}`);

const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const telegramBridge = require("./telegram");
const discordBridge = require("./discord");

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanup);

const QW_DIR = path.join(TEST_DIR, ".quadwork");
fs.mkdirSync(QW_DIR, { recursive: true });

// --- Test: Telegram reads Python-written cursor file ---
{
  const cursorFile = path.join(QW_DIR, "tg-bridge-cursor-test-tg.json");
  fs.writeFileSync(cursorFile, JSON.stringify({ last_seen_id: 42 }));
  const sinceId = telegramBridge.readCursor("test-tg");
  assert.equal(sinceId, 42);
  console.log("PASS: Telegram reads Python-written cursor file");
}

// --- Test: Discord reads Python-written cursor file ---
{
  const cursorFile = path.join(QW_DIR, "dc-bridge-cursor-test-dc.json");
  fs.writeFileSync(cursorFile, JSON.stringify({ last_seen_id: 99 }));
  const sinceId = discordBridge.readCursor("test-dc");
  assert.equal(sinceId, 99);
  console.log("PASS: Discord reads Python-written cursor file");
}

// --- Test: Missing cursor file returns 0 ---
{
  const sinceId = telegramBridge.readCursor("nonexistent");
  assert.equal(sinceId, 0);
  console.log("PASS: Missing cursor file returns 0");
}

// --- Test: Telegram isRunning returns false for unstarted project ---
{
  assert.equal(telegramBridge.isRunning("not-started"), false);
  console.log("PASS: isRunning returns false for unstarted project");
}

// --- Test: Discord isRunning returns false for unstarted project ---
{
  assert.equal(discordBridge.isRunning("not-started"), false);
  console.log("PASS: Discord isRunning returns false for unstarted project");
}

// --- Test: getLastError returns null for unstarted project ---
{
  assert.equal(telegramBridge.getLastError("not-started"), null);
  assert.equal(discordBridge.getLastError("not-started"), null);
  console.log("PASS: getLastError returns null for unstarted projects");
}

// --- #1034: strict stop is idempotent and never reports success after a
// resource teardown error. The failed Discord instance remains owned so a
// repeated archive can retry it; another project's instance is untouched. ---
async function runLifecycleTests() {
{
  telegramBridge._instances.set("tg-a", {
    timer: setTimeout(() => {}, 60_000),
    updateTimer: setTimeout(() => {}, 60_000),
    stopping: false,
  });
  telegramBridge._instances.set("tg-b", { timer: null, updateTimer: null, stopping: false });
  const stopped = await telegramBridge.stop("tg-a");
  assert.equal(stopped.ok, true);
  assert.equal(stopped.resources.telegram_bridges, 1);
  assert.equal(telegramBridge.isRunning("tg-a"), false);
  assert.equal(telegramBridge.isRunning("tg-b"), true, "Telegram stop is project-scoped");
  assert.deepEqual(await telegramBridge.stop("tg-a"), {
    ok: true,
    resources: { telegram_bridges: 0, bridge_timers: 0 },
    cleanup_errors: [],
  }, "Telegram stop retry is an idempotent no-op");
  await telegramBridge.stop("tg-b");
}

{
  let release;
  let aborted = false;
  const pending = new Promise((resolve) => { release = resolve; });
  telegramBridge._instances.set("tg-flight", {
    timer: null,
    updateTimer: null,
    stopping: false,
    controllers: new Set([{ abort: () => { aborted = true; } }]),
    inFlight: new Set([pending]),
  });
  let completed = false;
  const stopping = telegramBridge.stop("tg-flight").then((result) => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(aborted, true, "Telegram strict stop aborts owned fetches");
  assert.equal(completed, false, "Telegram strict stop waits for in-flight work");
  release();
  const stopped = await stopping;
  assert.equal(stopped.ok, true);
  assert.equal(telegramBridge.isRunning("tg-flight"), false, "Telegram ok:true has no retained instance");
}

{
  telegramBridge._instances.set("tg-timeout", {
    timer: null,
    updateTimer: null,
    stopping: false,
    controllers: new Set(),
    inFlight: new Set([new Promise(() => {})]),
    stopTimeoutMs: 10,
  });
  const timedOut = await telegramBridge.stop("tg-timeout");
  assert.equal(timedOut.ok, false, "Telegram never reports success while in-flight work remains");
  assert.equal(timedOut.cleanup_errors[0].code, "inflight_stop_timeout");
  assert.equal(telegramBridge.isRunning("tg-timeout"), true, "Telegram timeout retains ownership for retry");
  telegramBridge._instances.delete("tg-timeout");
}

// Archive while an outbound bridge send is awaiting. stop() must not return
// before it settles, and the resumed poll must not persist its cursor.
{
  const originalFetch = global.fetch;
  let releaseSend;
  let sendStarted;
  const sendStartedPromise = new Promise((resolve) => { sendStarted = resolve; });
  global.fetch = async (url) => {
    if (String(url).includes("sendMessage")) {
      sendStarted();
      return new Promise((resolve) => { releaseSend = () => resolve({ ok: true }); });
    }
    return { ok: true, json: async () => [{ id: 7, sender: "head", text: "work" }] };
  };
  telegramBridge._instances.set("tg-race", {
    cursor: 0,
    forwardedIds: new Set(),
    timer: null,
    updateTimer: null,
    stopping: false,
    controllers: new Set(),
    inFlight: new Set(),
  });
  const poll = telegramBridge._pollLoop("tg-race", "token", "chat", 8400);
  await sendStartedPromise;
  let stopDone = false;
  const stopping = telegramBridge.stop("tg-race").then((result) => { stopDone = true; return result; });
  await Promise.resolve();
  assert.equal(stopDone, false, "Telegram stop waits across an outbound send await");
  releaseSend();
  await Promise.all([poll, stopping]);
  assert.equal(telegramBridge.readCursor("tg-race"), 0, "Telegram stopped poll performs no post-await cursor write");
  global.fetch = originalFetch;
}

{
  let attempts = 0;
  discordBridge._instances.set("dc-a", {
    timer: setTimeout(() => {}, 60_000),
    stopping: false,
    client: { destroy: async () => { attempts += 1; if (attempts === 1) throw new Error("socket stuck"); } },
  });
  discordBridge._instances.set("dc-b", {
    timer: null,
    stopping: false,
    client: { destroy: () => {} },
  });
  const partial = await discordBridge.stop("dc-a");
  assert.equal(partial.ok, false);
  assert.equal(partial.cleanup_errors[0].resource, "discord_bridge");
  assert.equal(discordBridge.isRunning("dc-a"), true, "failed strict stop retains ownership for retry");
  assert.equal(discordBridge.isRunning("dc-b"), true, "Discord failure is isolated from another project");
  const retry = await discordBridge.stop("dc-a");
  assert.equal(retry.ok, true);
  assert.equal(discordBridge.isRunning("dc-a"), false);
  await discordBridge.stop("dc-b");
}

{
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [{ id: 9, sender: "head", text: "work" }] });
  let releaseSend;
  let sendStarted;
  const sendStartedPromise = new Promise((resolve) => { sendStarted = resolve; });
  const channel = {
    send: () => {
      sendStarted();
      return new Promise((resolve) => { releaseSend = resolve; });
    },
  };
  discordBridge._instances.set("dc-race", {
    cursor: 0,
    forwardedIds: new Set(),
    timer: null,
    stopping: false,
    controllers: new Set(),
    inFlight: new Set(),
    client: { destroy: async () => {} },
  });
  const poll = discordBridge._pollLoop("dc-race", channel, 8400);
  await sendStartedPromise;
  let stopDone = false;
  const stopping = discordBridge.stop("dc-race").then((result) => { stopDone = true; return result; });
  await Promise.resolve();
  assert.equal(stopDone, false, "Discord stop waits across an outbound send await");
  releaseSend();
  await Promise.all([poll, stopping]);
  assert.equal(discordBridge.readCursor("dc-race"), 0, "Discord stopped poll performs no post-await cursor write");
  global.fetch = originalFetch;
}


{
  discordBridge._instances.set("dc-timeout", {
    timer: null,
    stopping: false,
    controllers: new Set(),
    inFlight: new Set(),
    stopTimeoutMs: 10,
    client: { destroy: () => new Promise(() => {}) },
  });
  const timedOut = await discordBridge.stop("dc-timeout");
  assert.equal(timedOut.ok, false, "Discord never reports success while client teardown remains pending");
  assert.equal(timedOut.cleanup_errors[0].code, "client_stop_failed");
  assert.equal(discordBridge.isRunning("dc-timeout"), true, "Discord timeout retains ownership for retry");
  discordBridge._instances.delete("dc-timeout");
}

console.log("\nAll bridge tests passed.");
}

runLifecycleTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
