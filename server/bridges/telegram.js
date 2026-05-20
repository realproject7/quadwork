const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");

const instances = new Map();

function cursorPath(projectId) {
  return path.join(CONFIG_DIR, `tg-bridge-cursor-${projectId}.json`);
}

function offsetPath(projectId) {
  return path.join(CONFIG_DIR, `tg-bridge-offset-${projectId}.json`);
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

function readOffset(projectId) {
  try {
    const data = JSON.parse(fs.readFileSync(offsetPath(projectId), "utf-8"));
    return data.offset || 0;
  } catch {
    return 0;
  }
}

function writeOffset(projectId, offset) {
  try {
    fs.writeFileSync(offsetPath(projectId), JSON.stringify({ offset }), { mode: 0o600 });
  } catch {}
}

async function sendTelegram(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage ${res.status}`);
}

async function pollLoop(projectId, botToken, chatId, qwPort) {
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
      if (msg.sender === "tg" || msg.sender === "telegram-bridge" || (msg.sender && msg.sender.startsWith("tg:"))) continue;
      if (inst.forwardedIds.has(msg.id)) continue;

      const text = `**${msg.sender}**: ${msg.text}`;
      const truncated = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
      await sendTelegram(botToken, chatId, truncated);

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
    inst.timer = setTimeout(() => pollLoop(projectId, botToken, chatId, qwPort), 2000);
  }
}

async function startTelegramUpdates(projectId, botToken, chatId, qwPort) {
  const inst = instances.get(projectId);
  if (!inst || inst.stopping) return;

  let offset = readOffset(projectId);
  let retryDelay = 500;

  async function tick() {
    if (!inst || inst.stopping) return;
    try {
      const allowedUpdates = encodeURIComponent(JSON.stringify(["message"]));
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=10&allowed_updates=${allowedUpdates}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Telegram getUpdates ${res.status}`);
      const data = await res.json();
      retryDelay = 500;
      if (data.ok && data.result) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          writeOffset(projectId, offset);
          const text = update.message?.text;
          const from = update.message?.from?.username || update.message?.from?.first_name || "unknown";
          const msgChatId = String(update.message?.chat?.id);
          if (!text || msgChatId !== String(chatId)) continue;

          try {
            await fetch(`http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Bridge-Sender": `tg:${from}`,
              },
              body: JSON.stringify({
                project: projectId,
                text,
                channel: "general",
              }),
              signal: AbortSignal.timeout(5000),
            });
          } catch {}
        }
      }
    } catch (err) {
      if (!inst.stopping) {
        inst.lastError = err.message;
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    }

    if (!inst.stopping) {
      inst.updateTimer = setTimeout(tick, retryDelay);
    }
  }

  tick();
}

function start(projectId, botToken, chatId, qwPort) {
  if (instances.has(projectId)) return;

  const oldCursor = path.join(CONFIG_DIR, `telegram-bridge-cursor-${projectId}.json`);
  const newCursor = cursorPath(projectId);
  if (!fs.existsSync(newCursor) && fs.existsSync(oldCursor)) {
    try { fs.renameSync(oldCursor, newCursor); } catch {}
  }

  const inst = {
    cursor: readCursor(projectId),
    forwardedIds: new Set(),
    timer: null,
    updateTimer: null,
    stopping: false,
    lastError: null,
    startedAt: Date.now(),
  };
  instances.set(projectId, inst);

  pollLoop(projectId, botToken, chatId, qwPort).catch((err) => {
    console.error(`[bridge] telegram ${projectId} poll crashed: ${err.message}`);
    inst.lastError = err.message;
    stop(projectId);
  });

  startTelegramUpdates(projectId, botToken, chatId, qwPort).catch((err) => {
    console.error(`[bridge] telegram ${projectId} updates crashed: ${err.message}`);
    inst.lastError = err.message;
  });

  console.log(`[bridge] telegram ${projectId}: started`);
}

function stop(projectId) {
  const inst = instances.get(projectId);
  if (!inst) return;
  inst.stopping = true;
  if (inst.timer) clearTimeout(inst.timer);
  if (inst.updateTimer) clearTimeout(inst.updateTimer);
  instances.delete(projectId);
  console.log(`[bridge] telegram ${projectId}: stopped`);
}

function isRunning(projectId) {
  return instances.has(projectId);
}

function getLastError(projectId) {
  const inst = instances.get(projectId);
  return inst?.lastError || null;
}

module.exports = { start, stop, isRunning, getLastError, readCursor };
