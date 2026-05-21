const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");

const instances = new Map();

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
  if (!inst || inst.stopping) return;

  try {
    let sinceId = inst.cursor;
    const r = await fetch(
      `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}&since_id=${sinceId}&limit=50`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) throw new Error(`Chat API ${r.status}`);
    const messages = await r.json();

    for (const msg of messages) {
      if (inst.stopping) return;
      if (msg.sender === "dc" || msg.sender === "discord-bridge" || (msg.sender && msg.sender.startsWith("dc:"))) continue;
      if (inst.forwardedIds.has(msg.id)) continue;

      const text = `**${msg.sender}**: ${msg.text}`;
      const truncated = text.length > 2000 ? text.slice(0, 2000) + "…" : text;
      await channelObj.send(truncated);

      inst.forwardedIds.add(msg.id);
      if (inst.forwardedIds.size > 2000) {
        const arr = [...inst.forwardedIds];
        inst.forwardedIds = new Set(arr.slice(-1000));
      }

      if (msg.id > inst.cursor) {
        inst.cursor = msg.id;
        writeCursor(projectId, inst.cursor);
      }
    }
  } catch (err) {
    inst.lastError = err.message;
  }

  if (!inst.stopping) {
    inst.timer = setTimeout(() => pollLoop(projectId, channelObj, qwPort), 2000);
  }
}

async function start(projectId, botToken, channelId, qwPort) {
  if (instances.has(projectId)) return;

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
    cursor: readCursor(projectId),
    forwardedIds: new Set(),
    timer: null,
    stopping: false,
    lastError: null,
    startedAt: Date.now(),
    client,
    channelId,
  };
  instances.set(projectId, inst);

  try {
    await client.login(botToken);
  } catch (err) {
    instances.delete(projectId);
    throw new Error(`Discord login failed: ${err.message}`);
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error("Channel not found");
  } catch (err) {
    client.destroy();
    instances.delete(projectId);
    throw new Error(`Discord channel fetch failed: ${err.message}`);
  }

  client.on("messageCreate", async (message) => {
    try {
      if (inst.stopping) return;
      if (message.author.bot) return;
      if (message.channel.id !== channelId) return;

      const from = message.author.username || "unknown";
      await fetch(`http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Sender": `dc:${from}`,
        },
        body: JSON.stringify({
          project: projectId,
          text: message.content,
          channel: "general",
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      if (!inst.stopping) inst.lastError = err.message;
    }
  });

  pollLoop(projectId, channel, qwPort).catch((err) => {
    console.error(`[bridge] discord ${projectId} poll crashed: ${err.message}`);
    inst.lastError = err.message;
    stop(projectId);
  });

  console.log(`[bridge] discord ${projectId}: started`);
}

function stop(projectId) {
  const inst = instances.get(projectId);
  if (!inst) return;
  inst.stopping = true;
  if (inst.timer) clearTimeout(inst.timer);
  try { inst.client.destroy(); } catch {}
  instances.delete(projectId);
  console.log(`[bridge] discord ${projectId}: stopped`);
}

function isRunning(projectId) {
  return instances.has(projectId);
}

function getLastError(projectId) {
  const inst = instances.get(projectId);
  return inst?.lastError || null;
}

module.exports = { start, stop, isRunning, getLastError, readCursor };
