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
  const pendingDestroy = deferred();
  let destroyAttempts = 0;
  discordBridge._instances.set("dc-timeout", {
    timer: null,
    stopping: false,
    controllers: new Set(),
    inFlight: new Set(),
    stopTimeoutMs: 10,
    client: { destroy: () => { destroyAttempts += 1; return pendingDestroy.promise; } },
  });
  const timedOut = await discordBridge.stop("dc-timeout");
  assert.equal(timedOut.ok, false, "Discord never reports success while client teardown remains pending");
  assert.equal(timedOut.cleanup_errors[0].code, "client_stop_timeout");
  assert.equal(discordBridge.isRunning("dc-timeout"), true, "Discord timeout retains ownership for retry");
  assert.equal(destroyAttempts, 1);
  pendingDestroy.resolve();
  const retried = await discordBridge.stop("dc-timeout");
  assert.equal(retried.ok, true);
  assert.equal(destroyAttempts, 1, "Discord retry joins the pending destroy instead of invoking it twice");
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
    assert.equal(await starting, undefined,
      "Telegram canceled startup reports non-success to its route caller");
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
    batch_observation_fingerprint: "legacy-observation-bridge-4",
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

// A later assignment must never inherit A's "already running" result. The
// per-project start barrier retires A completely before installing B, and the
// stored authority value cannot be mutated after admission.
{
  const originalFetch = global.fetch;
  const keyA = { admission_generation: 21, assignment_fingerprint: "assignment-a" };
  const keyB = { admission_generation: 21, assignment_fingerprint: "assignment-b" };
  let aborts = 0;
  try {
    global.fetch = async (url) => ({
      ok: true,
      json: async () => String(url).includes("getUpdates") ? { ok: true, result: [] } : [],
    });
    telegramBridge._instances.set("tg-replace", {
      projectId: "tg-replace",
      cursor: 0,
      forwardedIds: new Set(),
      timer: setTimeout(() => {}, 60_000),
      updateTimer: null,
      stopping: false,
      controllers: new Set([{ abort: () => { aborts += 1; } }]),
      inFlight: new Set(),
      isAuthorityCurrent: () => true,
      authorityKey: Object.freeze({ ...keyA }),
    });
    const started = await telegramBridge.start("tg-replace", "token-b", "chat", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    });
    assert.equal(started.already_running, false);
    assert.equal(aborts, 1, "Telegram A is retired once before B starts");
    assert.equal(telegramBridge.isRunning("tg-replace", keyA), false);
    assert.equal(telegramBridge.isRunning("tg-replace", keyB), true);
    const runtimeKey = telegramBridge._instances.get("tg-replace").authorityKey;
    assert.equal(Object.isFrozen(runtimeKey), true, "Telegram stores a frozen runtime authority key");
    assert.equal(runtimeKey.assignment_fingerprint, "assignment-b");
  } finally {
    await telegramBridge.stop("tg-replace");
    global.fetch = originalFetch;
  }
}

{
  const originalFetch = global.fetch;
  const keyA = { admission_generation: 22, assignment_fingerprint: "assignment-a" };
  const keyB = { admission_generation: 22, assignment_fingerprint: "assignment-b" };
  let oldDestroys = 0;
  class ReplacementClient {
    constructor() {
      this.channels = { fetch: async () => ({ send: async () => {} }) };
    }
    async login() {}
    on() {}
    async destroy() {}
  }
  discordBridge._setDiscordLibForTest({
    Client: ReplacementClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  });
  try {
    global.fetch = async () => ({ ok: true, json: async () => [] });
    discordBridge._instances.set("dc-replace", {
      projectId: "dc-replace",
      cursor: 0,
      forwardedIds: new Set(),
      timer: null,
      stopping: false,
      controllers: new Set(),
      inFlight: new Set(),
      isAuthorityCurrent: () => true,
      authorityKey: Object.freeze({ ...keyA }),
      client: { destroy: async () => { oldDestroys += 1; } },
    });
    const started = await discordBridge.start("dc-replace", "token-b", "channel", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    });
    assert.equal(started.already_running, false);
    assert.equal(oldDestroys, 1, "Discord A is destroyed before B starts");
    assert.equal(discordBridge.isRunning("dc-replace", keyA), false);
    assert.equal(discordBridge.isRunning("dc-replace", keyB), true);
    const runtimeKey = discordBridge._instances.get("dc-replace").authorityKey;
    assert.equal(Object.isFrozen(runtimeKey), true, "Discord stores a frozen runtime authority key");
    assert.equal(runtimeKey.assignment_fingerprint, "assignment-b");
  } finally {
    await discordBridge.stop("dc-replace");
    global.fetch = originalFetch;
  }
}

// A lifecycle action must be able to cancel an in-progress startup before the
// startup promise settles. Otherwise a hung seed/login would sit in front of
// stop and replacement forever.
{
  const originalFetch = global.fetch;
  const fetchStarted = deferred();
  const pendingFetch = deferred();
  const keyA = { admission_generation: 25, assignment_fingerprint: "assignment-a" };
  try {
    global.fetch = async () => {
      fetchStarted.resolve();
      return pendingFetch.promise;
    };
    const starting = telegramBridge.start("tg-start-stop-race", "token", "chat", 8400, {
      authorityKey: keyA,
      isAuthorityCurrent: () => true,
    });
    await fetchStarted.promise;
    const owner = telegramBridge._instances.get("tg-start-stop-race");
    owner.stopTimeoutMs = 1000;
    const stopping = telegramBridge.stop("tg-start-stop-race");
    assert.equal(owner.stopping, true, "Telegram stop synchronously cancels a pending startup owner");
    pendingFetch.resolve({ ok: true, json: async () => [] });
    assert.equal((await stopping).ok, true);
    await starting;
    assert.equal(telegramBridge.isRunning("tg-start-stop-race"), false,
      "Telegram pending startup cannot recreate ownership after stop");
  } finally {
    pendingFetch.resolve({ ok: true, json: async () => [] });
    await telegramBridge.stop("tg-start-stop-race");
    global.fetch = originalFetch;
  }
}

{
  const originalFetch = global.fetch;
  const loginStarted = deferred();
  const pendingLogin = deferred();
  const keyA = { admission_generation: 26, assignment_fingerprint: "assignment-a" };
  const keyB = { admission_generation: 26, assignment_fingerprint: "assignment-b" };
  let clients = 0;
  let destroys = 0;
  class StartupRaceClient {
    constructor() {
      this.index = clients++;
      this.channels = { fetch: async () => ({ send: async () => {} }) };
    }
    login() {
      if (this.index === 0) {
        loginStarted.resolve();
        return pendingLogin.promise;
      }
      return Promise.resolve();
    }
    on() {}
    async destroy() { destroys += 1; }
  }
  discordBridge._setDiscordLibForTest({
    Client: StartupRaceClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  });
  try {
    global.fetch = async () => ({ ok: true, json: async () => [] });
    const startingA = discordBridge.start("dc-start-replace-race", "token-a", "channel", 8400, {
      authorityKey: keyA,
      isAuthorityCurrent: () => true,
    });
    await loginStarted.promise;
    const owner = discordBridge._instances.get("dc-start-replace-race");
    owner.stopTimeoutMs = 1000;
    const startingB = discordBridge.start("dc-start-replace-race", "token-b", "channel", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    });
    assert.equal(owner.stopping, true, "Discord B synchronously cancels A's pending login");
    assert.equal(destroys, 1, "Discord teardown begins before A's login promise settles");
    pendingLogin.resolve();
    await startingA;
    const startedB = await startingB;
    assert.equal(startedB.ok, true);
    assert.equal(discordBridge.isRunning("dc-start-replace-race", keyB), true,
      "Discord B starts after strict A retirement");
  } finally {
    pendingLogin.resolve();
    await discordBridge.stop("dc-start-replace-race");
    global.fetch = originalFetch;
  }
}

// A keyed stop can target B while only A exists and is retiring. The stop
// intent must cancel the queued future owner before B creates any runtime.
{
  const originalFetch = global.fetch;
  const pendingA = deferred();
  const keyA = { admission_generation: 27, assignment_fingerprint: "assignment-a" };
  const keyB = { admission_generation: 27, assignment_fingerprint: "assignment-b" };
  let bFetches = 0;
  try {
    global.fetch = async () => {
      bFetches += 1;
      return { ok: true, json: async () => [] };
    };
    telegramBridge._instances.set("tg-future-stop", {
      projectId: "tg-future-stop",
      timer: null,
      updateTimer: null,
      stopping: false,
      controllers: new Set(),
      inFlight: new Set([pendingA.promise]),
      stopTimeoutMs: 1000,
      isAuthorityCurrent: () => true,
      authorityKey: Object.freeze({ ...keyA }),
    });
    const startingB = telegramBridge.start("tg-future-stop", "token-b", "chat", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    });
    const stoppingB = telegramBridge.stop("tg-future-stop", keyB);
    assert.equal(await startingB, undefined,
      "Telegram future keyed stop supersedes B before startInstance");
    assert.equal((await stoppingB).ok, true);
    assert.equal(bFetches, 0, "Telegram stopped future owner creates no bridge fetch");
    assert.equal(telegramBridge.isRunning("tg-future-stop", keyB), false);
  } finally {
    pendingA.resolve();
    await telegramBridge.stop("tg-future-stop");
    global.fetch = originalFetch;
  }
}

{
  const originalFetch = global.fetch;
  const pendingA = deferred();
  const keyA = { admission_generation: 28, assignment_fingerprint: "assignment-a" };
  const keyB = { admission_generation: 28, assignment_fingerprint: "assignment-b" };
  let clients = 0;
  class FutureStopClient {
    constructor() {
      clients += 1;
      this.channels = { fetch: async () => ({ send: async () => {} }) };
    }
    async login() {}
    on() {}
    async destroy() {}
  }
  discordBridge._setDiscordLibForTest({
    Client: FutureStopClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  });
  try {
    global.fetch = async () => ({ ok: true, json: async () => [] });
    discordBridge._instances.set("dc-future-stop", {
      projectId: "dc-future-stop",
      timer: null,
      stopping: false,
      controllers: new Set(),
      inFlight: new Set([pendingA.promise]),
      stopTimeoutMs: 1000,
      isAuthorityCurrent: () => true,
      authorityKey: Object.freeze({ ...keyA }),
      client: { destroy: async () => {} },
    });
    const startingB = discordBridge.start("dc-future-stop", "token-b", "channel", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    });
    const stoppingB = discordBridge.stop("dc-future-stop", keyB);
    assert.equal(await startingB, undefined,
      "Discord future keyed stop supersedes B before client creation");
    assert.equal((await stoppingB).ok, true);
    assert.equal(clients, 0, "Discord stopped future owner never enters login");
    assert.equal(discordBridge.isRunning("dc-future-stop", keyB), false);
  } finally {
    pendingA.resolve();
    await discordBridge.stop("dc-future-stop");
    global.fetch = originalFetch;
  }
}

// An unabortable owned operation makes replacement fail closed. A concurrent
// stop supersedes the queued replacement and joins the exact same retirement
// attempt (one abort/destroy). Ownership remains installed after timeout, and a
// later retry can finish replacement after the old operation settles.
{
  const originalFetch = global.fetch;
  const keyA = { admission_generation: 23, assignment_fingerprint: "assignment-a" };
  const keyB = { admission_generation: 23, assignment_fingerprint: "assignment-b" };
  const pending = deferred();
  let aborts = 0;
  try {
    global.fetch = async (url) => ({
      ok: true,
      json: async () => String(url).includes("getUpdates") ? { ok: true, result: [] } : [],
    });
    const owner = {
      projectId: "tg-replace-timeout",
      cursor: 0,
      forwardedIds: new Set(),
      timer: null,
      updateTimer: null,
      stopping: false,
      controllers: new Set([{ abort: () => { aborts += 1; } }]),
      inFlight: new Set([pending.promise]),
      stopTimeoutMs: 10,
      isAuthorityCurrent: () => true,
      authorityKey: Object.freeze({ ...keyA }),
    };
    telegramBridge._instances.set("tg-replace-timeout", owner);
    const replacing = telegramBridge.start("tg-replace-timeout", "token-b", "chat", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    }).then(
      () => null,
      (error) => error,
    );
    await Promise.resolve();
    const stopping = telegramBridge.stop("tg-replace-timeout");
    const [replacementError, stopped] = await Promise.all([replacing, stopping]);
    assert.equal(replacementError, null, "Telegram stop supersedes the queued replacement");
    assert.equal(stopped.ok, false);
    assert.equal(stopped.cleanup_errors[0].code, "inflight_stop_timeout");
    assert.equal(stopped.cleanup_errors[0].retryable, true);
    assert.equal(aborts, 1, "Telegram replacement and stop share one retirement promise");
    assert.equal(telegramBridge._instances.get("tg-replace-timeout"), owner,
      "Telegram retains A until every owned operation settles");
    pending.resolve();
    owner.inFlight.delete(pending.promise);
    const retried = await telegramBridge.start("tg-replace-timeout", "token-b", "chat", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    });
    assert.equal(retried.ok, true);
    assert.equal(telegramBridge.isRunning("tg-replace-timeout", keyB), true);
  } finally {
    pending.resolve();
    await telegramBridge.stop("tg-replace-timeout");
    global.fetch = originalFetch;
  }
}

{
  const originalFetch = global.fetch;
  const keyA = { admission_generation: 24, assignment_fingerprint: "assignment-a" };
  const keyB = { admission_generation: 24, assignment_fingerprint: "assignment-b" };
  const pending = deferred();
  let aborts = 0;
  let oldDestroys = 0;
  class RetryClient {
    constructor() {
      this.channels = { fetch: async () => ({ send: async () => {} }) };
    }
    async login() {}
    on() {}
    async destroy() {}
  }
  discordBridge._setDiscordLibForTest({
    Client: RetryClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  });
  try {
    global.fetch = async () => ({ ok: true, json: async () => [] });
    const owner = {
      projectId: "dc-replace-timeout",
      cursor: 0,
      forwardedIds: new Set(),
      timer: null,
      stopping: false,
      controllers: new Set([{ abort: () => { aborts += 1; } }]),
      inFlight: new Set([pending.promise]),
      stopTimeoutMs: 10,
      isAuthorityCurrent: () => true,
      authorityKey: Object.freeze({ ...keyA }),
      client: { destroy: async () => { oldDestroys += 1; } },
    };
    discordBridge._instances.set("dc-replace-timeout", owner);
    const replacing = discordBridge.start("dc-replace-timeout", "token-b", "channel", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    }).then(
      () => null,
      (error) => error,
    );
    await Promise.resolve();
    const stopping = discordBridge.stop("dc-replace-timeout");
    const [replacementError, stopped] = await Promise.all([replacing, stopping]);
    assert.equal(replacementError, null, "Discord stop supersedes the queued replacement");
    assert.equal(stopped.cleanup_errors[0].code, "inflight_stop_timeout");
    assert.equal(aborts, 1, "Discord replacement and stop share one retirement promise");
    assert.equal(oldDestroys, 1, "Discord destroy belongs to the shared retirement promise");
    assert.equal(discordBridge._instances.get("dc-replace-timeout"), owner,
      "Discord retains A after a retryable in-flight timeout");
    pending.resolve();
    owner.inFlight.delete(pending.promise);
    const retried = await discordBridge.start("dc-replace-timeout", "token-b", "channel", 8400, {
      authorityKey: keyB,
      isAuthorityCurrent: () => true,
    });
    assert.equal(retried.ok, true);
    assert.equal(oldDestroys, 1, "Discord retry preserves the already-completed client teardown");
    assert.equal(discordBridge.isRunning("dc-replace-timeout", keyB), true);
  } finally {
    pending.resolve();
    await discordBridge.stop("dc-replace-timeout");
    global.fetch = originalFetch;
  }
}

console.log("\nAll bridge tests passed.");
}

runLifecycleTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
