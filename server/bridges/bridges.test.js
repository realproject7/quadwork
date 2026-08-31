const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `bridges-test-${process.pid}-${Date.now()}`);

const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const telegramBridge = require("./telegram");
const discordBridge = require("./discord");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

// #1031: assignment/admission authority is a lifetime property, not only a
// route-entry check. A rollover while Telegram cursor startup is awaiting must
// retire the instance before either polling owner can be created.
{
  const originalFetch = global.fetch;
  const fetchStarted = deferred();
  const seedResponse = deferred();
  let authorized = true;
  let fetches = 0;
  try {
    global.fetch = async () => {
      fetches += 1;
      fetchStarted.resolve();
      return seedResponse.promise;
    };
    const starting = telegramBridge.start("tg-authority-start", "token", "chat", 8400, {
      isAuthorityCurrent: () => authorized,
    });
    await fetchStarted.promise;
    authorized = false;
    seedResponse.resolve({ ok: true, json: async () => [] });
    await starting;
    assert.equal(fetches, 1, "Telegram rollover during cursor startup starts no poll/update fetch");
    assert.equal(telegramBridge.isRunning("tg-authority-start"), false, "stale Telegram startup retires its instance");
  } finally {
    global.fetch = originalFetch;
    await telegramBridge.stop("tg-authority-start");
  }
}

// A later rollover while the chat response is being decoded must also suppress
// the outbound network send and cursor mutation.
{
  const originalFetch = global.fetch;
  const messages = deferred();
  const jsonStarted = deferred();
  let authorized = true;
  let sends = 0;
  try {
    global.fetch = async (url) => {
      if (String(url).includes("sendMessage")) {
        sends += 1;
        return { ok: true };
      }
      return {
        ok: true,
        json: async () => {
          jsonStarted.resolve();
          return messages.promise;
        },
      };
    };
    telegramBridge._instances.set("tg-authority-loop", {
      projectId: "tg-authority-loop",
      cursor: 0,
      forwardedIds: new Set(),
      timer: null,
      updateTimer: null,
      stopping: false,
      controllers: new Set(),
      inFlight: new Set(),
      isAuthorityCurrent: () => authorized,
    });
    const polling = telegramBridge._pollLoop("tg-authority-loop", "token", "chat", 8400);
    await jsonStarted.promise;
    authorized = false;
    messages.resolve([{ id: 12, sender: "head", text: "stale" }]);
    await polling;
    assert.equal(sends, 0, "Telegram rollover during chat decode performs zero stale external send");
    assert.equal(telegramBridge.readCursor("tg-authority-loop"), 0, "Telegram stale loop persists no cursor");
    assert.equal(telegramBridge.isRunning("tg-authority-loop"), false, "Telegram stale loop retires its instance");
  } finally {
    global.fetch = originalFetch;
    await telegramBridge.stop("tg-authority-loop");
  }
}

// Automated inbound messages carry the server-canonical identity all the way
// to /api/chat, where the receiver performs the final exact revalidation.
{
  const originalFetch = global.fetch;
  const inboundPosted = deferred();
  const identity = {
    admission_generation: 3,
    compatibility_mode: "v2",
    provenance: "owned",
    assignment_key: "assignment-key",
    installation_id: "installation_1234567890",
    batch_number: 7,
    assignment_attempt: "attempt-a",
    assignment_items: [],
  };
  let inboundBody = null;
  let updatesServed = false;
  try {
    global.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value.includes("getUpdates")) {
        if (updatesServed) return { ok: true, json: async () => ({ ok: true, result: [] }) };
        updatesServed = true;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [{
              update_id: 1,
              message: { text: "hello", from: { username: "operator" }, chat: { id: "chat" } },
            }],
          }),
        };
      }
      if (options.method === "POST" && value.includes("/api/chat")) {
        inboundBody = JSON.parse(options.body);
        inboundPosted.resolve();
        return { ok: true };
      }
      return { ok: true, json: async () => [] };
    };
    await telegramBridge.start("tg-identity", "token", "chat", 8400, {
      isAuthorityCurrent: () => true,
      automationIdentity: identity,
    });
    await inboundPosted.promise;
    assert.deepEqual(
      Object.fromEntries(Object.keys(identity).map((key) => [key, inboundBody[key]])),
      identity,
      "Telegram inbound POST carries canonical automation identity",
    );
  } finally {
    await telegramBridge.stop("tg-identity");
    global.fetch = originalFetch;
  }
}

// Discord login is itself asynchronous. Rollover before it resolves must
// destroy the logged-in client without channel discovery or handler attach.
{
  const loginStarted = deferred();
  const loginResult = deferred();
  let authorized = true;
  let channelFetches = 0;
  let handlerAttaches = 0;
  let destroys = 0;
  class DeferredClient {
    constructor() {
      this.channels = {
        fetch: async () => {
          channelFetches += 1;
          return { send: async () => {} };
        },
      };
    }
    login() {
      loginStarted.resolve();
      return loginResult.promise;
    }
    on() { handlerAttaches += 1; }
    async destroy() { destroys += 1; }
  }
  discordBridge._setDiscordLibForTest({
    Client: DeferredClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  });
  const starting = discordBridge.start("dc-authority-start", "token", "channel", 8400, {
    isAuthorityCurrent: () => authorized,
  });
  await loginStarted.promise;
  authorized = false;
  loginResult.resolve("ok");
  await starting;
  await Promise.resolve();
  assert.equal(channelFetches, 0, "Discord rollover during login performs no channel fetch");
  assert.equal(handlerAttaches, 0, "Discord rollover during login attaches no handlers");
  assert.equal(destroys, 1, "Discord stale login destroys its client");
  assert.equal(discordBridge.isRunning("dc-authority-start"), false, "Discord stale startup retires its instance");
}

// The persistent guard remains active after startup and blocks a channel send
// if authority changes while an outbound chat response is awaiting decode.
{
  const originalFetch = global.fetch;
  const messages = deferred();
  const jsonStarted = deferred();
  let authorized = true;
  let sends = 0;
  let destroys = 0;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => {
        jsonStarted.resolve();
        return messages.promise;
      },
    });
    discordBridge._instances.set("dc-authority-loop", {
      projectId: "dc-authority-loop",
      cursor: 0,
      forwardedIds: new Set(),
      timer: null,
      stopping: false,
      controllers: new Set(),
      inFlight: new Set(),
      isAuthorityCurrent: () => authorized,
      client: { destroy: async () => { destroys += 1; } },
    });
    const polling = discordBridge._pollLoop("dc-authority-loop", {
      send: async () => { sends += 1; },
    }, 8400);
    await jsonStarted.promise;
    authorized = false;
    messages.resolve([{ id: 13, sender: "head", text: "stale" }]);
    await polling;
    await Promise.resolve();
    assert.equal(sends, 0, "Discord rollover during chat decode performs zero stale channel send");
    assert.equal(discordBridge.readCursor("dc-authority-loop"), 0, "Discord stale loop persists no cursor");
    assert.equal(destroys, 1, "Discord stale loop destroys its client");
    assert.equal(discordBridge.isRunning("dc-authority-loop"), false, "Discord stale loop retires its instance");
  } finally {
    global.fetch = originalFetch;
    await discordBridge.stop("dc-authority-loop");
  }
}

// Discord's attached inbound handler must carry the same canonical identity.
{
  const originalFetch = global.fetch;
  const handlers = new Map();
  let inboundBody = null;
  const identity = {
    admission_generation: 4,
    compatibility_mode: "v1",
  };
  class IdentityClient {
    constructor() {
      this.channels = { fetch: async () => ({ send: async () => {} }) };
    }
    async login() {}
    on(name, handler) { handlers.set(name, handler); }
    async destroy() {}
  }
  discordBridge._setDiscordLibForTest({
    Client: IdentityClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  });
  try {
    global.fetch = async (url, options = {}) => {
      if (options.method === "POST" && String(url).includes("/api/chat")) {
        inboundBody = JSON.parse(options.body);
        return { ok: true };
      }
      return { ok: true, json: async () => [] };
    };
    await discordBridge.start("dc-identity", "token", "channel", 8400, {
      isAuthorityCurrent: () => true,
      automationIdentity: identity,
    });
    await handlers.get("messageCreate")({
      author: { bot: false, username: "operator" },
      channel: { id: "channel" },
      content: "hello",
    });
    assert.equal(inboundBody.admission_generation, identity.admission_generation);
    assert.equal(inboundBody.compatibility_mode, identity.compatibility_mode,
      "Discord inbound POST carries canonical V1 automation identity");
  } finally {
    await discordBridge.stop("dc-identity");
    global.fetch = originalFetch;
  }
}

console.log("\nAll bridge tests passed.");
}

runLifecycleTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
