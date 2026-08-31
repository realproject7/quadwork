const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");

const instances = new Map();

function isCurrent(projectId, inst) {
  return !inst.stopping && instances.get(projectId) === inst;
}

function retireStaleInstance(projectId, inst) {
  if (!inst || inst.stopping) return;
  inst.stopping = true;
  for (const controller of inst.controllers || []) {
    try { controller.abort(); } catch {}
  }
  if (inst.timer) {
    try { clearTimeout(inst.timer); } catch {}
    inst.timer = null;
  }
  if (inst.client) {
    let operation;
    try { operation = inst.client.destroy(); }
    catch (err) {
      inst.retirementError = err;
      return;
    }
    inst.retirement = Promise.resolve(operation);
    inst.retirement.then(
      () => {
        inst.retirement = null;
        inst.retirementError = null;
        if (instances.get(projectId) === inst) instances.delete(projectId);
      },
      (err) => {
        inst.retirement = null;
        inst.retirementError = err;
      },
    );
    return;
  }
  if (instances.get(projectId) === inst) instances.delete(projectId);
}

function isAuthorizedCurrent(projectId, inst) {
  if (!isCurrent(projectId, inst)) return false;
  if (typeof inst.isAuthorityCurrent !== "function") return true;
  let authorized = false;
  try { authorized = inst.isAuthorityCurrent() === true; } catch {}
  if (!authorized) retireStaleInstance(projectId, inst);
  return authorized;
}

function staleAuthorityError() {
  const error = new Error("bridge assignment or admission changed");
  error.code = "bridge_authority_changed";
  return error;
}

async function track(inst, promise) {
  if (!inst.inFlight) inst.inFlight = new Set();
  const owned = Promise.resolve(promise);
  inst.inFlight.add(owned);
  try { return await owned; }
  finally { inst.inFlight.delete(owned); }
}

async function bridgeFetch(inst, url, options = {}, timeoutMs = 5000) {
  if (!isAuthorizedCurrent(inst.projectId, inst)) throw staleAuthorityError();
  if (!inst.controllers) inst.controllers = new Set();
  const controller = new AbortController();
  inst.controllers.add(controller);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    return await track(inst, fetch(url, { ...options, signal }));
  } finally {
    inst.controllers.delete(controller);
  }
}

async function settleInFlight(inst, timeoutMs = 5000) {
  const pending = [...(inst.inFlight || [])];
  if (pending.length === 0) return true;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(pending).then(() => true);
  const completed = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return completed;
}

async function settleOperation(operation, timeoutMs = 5000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timeout: true }), timeoutMs);
  });
  const settled = Promise.resolve(operation).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  const outcome = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return outcome;
}

// #782: cursor-lag threshold beyond which a valid cursor is treated as
// stale (bridge stopped mid-backlog) and reseeded to latest on start.
// Small lags within this window keep continuity for graceful restarts.
//
// #786: intentional trade-off — if the bridge was down while 11+ messages
// arrived, those messages are skipped (not replayed to Discord). This
// prevents the "old message flood" bug. If continuity is needed for long
// downtimes, increase this threshold or remove the stale-cursor check.
const STALE_CURSOR_THRESHOLD = 10;

function cursorPath(projectId) {
  return path.join(CONFIG_DIR, `dc-bridge-cursor-${projectId}.json`);
}

function readCursor(projectId) {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath(projectId), "utf-8"));
    return data.last_seen_id || 0;
  } catch {
    return 0;
  }
}

function writeCursor(projectId, sinceId) {
  try {
    fs.writeFileSync(cursorPath(projectId), JSON.stringify({ last_seen_id: sinceId }), { mode: 0o600 });
  } catch {}
}

let Discord;
function getDiscordLib() {
  if (!Discord) {
    try {
      Discord = require("discord.js");
    } catch {
      throw new Error("Discord bridge requires discord.js — reinstall or update QuadWork to get it");
    }
  }
  return Discord;
}

async function pollLoop(projectId, channelObj, qwPort) {
  const inst = instances.get(projectId);
  if (!inst) return;
  if (!inst.projectId) inst.projectId = projectId;
  if (!isAuthorizedCurrent(projectId, inst)) return;

  try {
    let sinceId = inst.cursor;
    const r = await bridgeFetch(inst,
      `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}&since_id=${sinceId}&limit=50`,
      {}, 5000,
    );
    if (!isAuthorizedCurrent(projectId, inst)) return;
    if (!r.ok) throw new Error(`Chat API ${r.status}`);
    const messages = await track(inst, r.json());
    if (!isAuthorizedCurrent(projectId, inst)) return;

    for (const msg of messages) {
      if (!isAuthorizedCurrent(projectId, inst)) return;
      if (msg.sender === "dc" || msg.sender === "discord-bridge" || (msg.sender && msg.sender.startsWith("dc:"))) continue;
      if (inst.forwardedIds.has(msg.id)) continue;

      const text = `**${msg.sender}**: ${msg.text}`;
      const truncated = text.length > 2000 ? text.slice(0, 2000) + "…" : text;
      if (!isAuthorizedCurrent(projectId, inst)) return;
      await track(inst, channelObj.send(truncated));
      if (!isAuthorizedCurrent(projectId, inst)) return;

      inst.forwardedIds.add(msg.id);
      if (inst.forwardedIds.size > 2000) {
        const arr = [...inst.forwardedIds];
        inst.forwardedIds = new Set(arr.slice(-1000));
      }

      if (msg.id > inst.cursor) {
        if (!isAuthorizedCurrent(projectId, inst)) return;
        inst.cursor = msg.id;
        writeCursor(projectId, inst.cursor);
      }
    }
  } catch (err) {
    if (isAuthorizedCurrent(projectId, inst)) inst.lastError = err.message;
  }

  if (isAuthorizedCurrent(projectId, inst)) {
    inst.timer = setTimeout(() => pollLoop(projectId, channelObj, qwPort), 2000);
  }
}

async function start(projectId, botToken, channelId, qwPort, options = {}) {
  if (instances.has(projectId)) return;

  const isAuthorityCurrent = typeof options.isAuthorityCurrent === "function"
    ? options.isAuthorityCurrent
    : null;
  const automationIdentity = options.automationIdentity && typeof options.automationIdentity === "object"
    ? Object.freeze({ ...options.automationIdentity })
    : null;
  if (isAuthorityCurrent) {
    let authorized = false;
    try { authorized = isAuthorityCurrent() === true; } catch {}
    if (!authorized) return;
  }

  const oldCursor = path.join(CONFIG_DIR, `discord-bridge-cursor-${projectId}.json`);
  const newCursor = cursorPath(projectId);
  if (!fs.existsSync(newCursor) && fs.existsSync(oldCursor)) {
    try { fs.renameSync(oldCursor, newCursor); } catch {}
  }

  const { Client, GatewayIntentBits } = getDiscordLib();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const inst = {
    projectId,
    cursor: readCursor(projectId),
    forwardedIds: new Set(),
    timer: null,
    stopping: false,
    lastError: null,
    startedAt: Date.now(),
    client,
    channelId,
    controllers: new Set(),
    inFlight: new Set(),
    isAuthorityCurrent,
    automationIdentity,
  };
  instances.set(projectId, inst);

  try {
    if (!isAuthorizedCurrent(projectId, inst)) return;
    await track(inst, client.login(botToken));
  } catch (err) {
    if (!isAuthorizedCurrent(projectId, inst)) return;
    instances.delete(projectId);
    throw new Error(`Discord login failed: ${err.message}`);
  }

  if (!isAuthorizedCurrent(projectId, inst)) return;

  let channel;
  try {
    if (!isAuthorizedCurrent(projectId, inst)) return;
    channel = await track(inst, client.channels.fetch(channelId));
    if (!channel) throw new Error("Channel not found");
  } catch (err) {
    if (!isAuthorizedCurrent(projectId, inst)) return;
    try { await client.destroy(); } catch {}
    instances.delete(projectId);
    throw new Error(`Discord channel fetch failed: ${err.message}`);
  }

  // Archive may have stopped this instance while login/channel discovery was
  // awaiting the network. Never attach handlers or start polling for a stale
  // instance after that durable barrier won the race.
  if (!isAuthorizedCurrent(projectId, inst)) return;

  if (!isAuthorizedCurrent(projectId, inst)) return;
  client.on("messageCreate", async (message) => {
    try {
      if (!isAuthorizedCurrent(projectId, inst)) return;
      if (message.author.bot) return;
      if (message.channel.id !== channelId) return;

      const from = message.author.username || "unknown";
      console.log(`[bridge] discord ${projectId}: received message from ${from}`);
      if (!message.content) {
        console.warn(`[bridge] discord ${projectId}: empty message content — check MESSAGE_CONTENT intent`);
      }
      const res = await bridgeFetch(inst, `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Sender": `dc:${from}`,
        },
        body: JSON.stringify({
          project: projectId,
          text: message.content,
          channel: "general",
          ...(inst.automationIdentity || {}),
        }),
      }, 5000);
      if (!isAuthorizedCurrent(projectId, inst)) return;
      if (!res.ok) {
        console.error(`[bridge] discord ${projectId} inbound POST failed: ${res.status}`);
      }
    } catch (err) {
      if (isAuthorizedCurrent(projectId, inst)) {
        console.error(`[bridge] discord ${projectId} inbound error: ${err.message}`);
        inst.lastError = err.message;
      }
    }
  });

  if (!isAuthorizedCurrent(projectId, inst)) return;
  client.on("error", (err) => {
    console.error(`[bridge] discord ${projectId} client error: ${err?.message || err}`);
  });
  if (!isAuthorizedCurrent(projectId, inst)) return;
  client.on("warn", (msg) => {
    console.warn(`[bridge] discord ${projectId} client warn: ${msg}`);
  });

  // #782: seed cursor to latest on first enable (no cursor file, or
  // cursor=0) AND on stale-cursor restarts where the cursor lags the
  // latest chat message by more than STALE_CURSOR_THRESHOLD. The stale
  // case covers bridges stopped mid-backlog (e.g. the plottoon scenario:
  // cursor=83 with 127 messages — without this guard the next start
  // replays 44 old messages to Discord). Small lags (graceful restart
  // mid-conversation) keep continuity.
  const cursorFileExists = fs.existsSync(cursorPath(projectId));
  try {
    const r = await bridgeFetch(inst,
      `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}&limit=1`,
      {}, 5000,
    );
    if (!isAuthorizedCurrent(projectId, inst)) return;
    if (r.ok) {
      const msgs = await track(inst, r.json());
      if (!isAuthorizedCurrent(projectId, inst)) return;
      if (msgs.length > 0) {
        const latestId = msgs[msgs.length - 1].id;
        const stale = !cursorFileExists
          || inst.cursor === 0
          || (latestId - inst.cursor) > STALE_CURSOR_THRESHOLD;
        if (stale) {
          if (!isAuthorizedCurrent(projectId, inst)) return;
          inst.cursor = latestId;
          writeCursor(projectId, inst.cursor);
        }
      }
    } else {
      // #786: surface HTTP failures so non-OK responses don't fall
      // through silently (the catch only fires on thrown errors).
      console.warn(`[bridge] discord ${projectId}: cursor seed fetch returned ${r.status}`);
    }
  } catch (err) {
    if (isAuthorizedCurrent(projectId, inst)) console.warn(`[bridge] discord ${projectId}: cursor seed failed (${err.message})`);
  }

  if (!isAuthorizedCurrent(projectId, inst)) return;
  pollLoop(projectId, channel, qwPort).catch((err) => {
    console.error(`[bridge] discord ${projectId} poll crashed: ${err.message}`);
    inst.lastError = err.message;
    void stop(projectId).catch((stopErr) => {
      console.error(`[bridge] discord ${projectId} stop failed: ${stopErr.message}`);
    });
  });

  console.log(`[bridge] discord ${projectId}: started`);
}

async function stop(projectId) {
  const inst = instances.get(projectId);
  if (!inst) {
    return {
      ok: true,
      resources: { discord_bridges: 0, bridge_timers: 0 },
      cleanup_errors: [],
    };
  }
  inst.stopping = true;
  for (const controller of inst.controllers || []) {
    try { controller.abort(); } catch {}
  }
  let timers = 0;
  const cleanupErrors = [];
  if (inst.timer) {
    try {
      clearTimeout(inst.timer);
      inst.timer = null;
      timers += 1;
    } catch (err) {
      cleanupErrors.push({
        resource: "discord_bridge",
        code: "timer_stop_failed",
        message: err?.message || "Discord bridge timer stop failed",
      });
    }
  }
  try {
    if (inst.client) {
      const operation = inst.retirement || inst.client.destroy();
      const outcome = await settleOperation(operation, inst.stopTimeoutMs || 5000);
      if (!outcome.ok) throw outcome.error || new Error("Discord client stop timed out");
      inst.retirementError = null;
    }
  } catch (err) {
    cleanupErrors.push({
      resource: "discord_bridge",
      code: "client_stop_failed",
      message: err?.message || "Discord bridge client stop failed",
    });
  }
  if (!(await settleInFlight(inst, inst.stopTimeoutMs || 5000))) {
    cleanupErrors.push({
      resource: "discord_bridge",
      code: "inflight_stop_timeout",
      message: "Discord bridge in-flight work did not settle",
    });
  }
  if (cleanupErrors.length === 0) {
    if (instances.get(projectId) === inst) instances.delete(projectId);
    console.log(`[bridge] discord ${projectId}: stopped`);
  }
  return {
    ok: cleanupErrors.length === 0,
    resources: {
      discord_bridges: cleanupErrors.length === 0 ? 1 : 0,
      bridge_timers: timers,
    },
    cleanup_errors: cleanupErrors,
  };
}

function isRunning(projectId) {
  return instances.has(projectId);
}

// #972: stop every running instance (used on server shutdown).
async function stopAll() {
  return Promise.all([...instances.keys()].map((projectId) => stop(projectId)));
}

function getLastError(projectId) {
  const inst = instances.get(projectId);
  return inst?.lastError || null;
}

function setDiscordLibForTest(lib) {
  Discord = lib;
}

module.exports = {
  start,
  stop,
  stopAll,
  isRunning,
  getLastError,
  readCursor,
  _instances: instances,
  _pollLoop: pollLoop,
  _setDiscordLibForTest: setDiscordLibForTest,
};
