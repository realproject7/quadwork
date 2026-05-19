const fs = require("fs");
const path = require("path");
const os = require("os");
const { ensureSecureDir, writeSecureFile } = require("./config");

const MENTION_RE = /@(\w[\w-]*)/g;

// Per-project state keyed by projectId
const projectState = new Map();

function getState(projectId) {
  if (!projectState.has(projectId)) {
    projectState.set(projectId, { nextId: null, cache: [] });
  }
  return projectState.get(projectId);
}

function chatDir(projectId) {
  return path.join(os.homedir(), ".quadwork", projectId, "chat");
}

function chatFile(projectId) {
  return path.join(chatDir(projectId), "general.jsonl");
}

function writerLockPath(projectId) {
  return path.join(chatDir(projectId), ".writer.pid");
}

function parseMentions(text) {
  if (typeof text !== "string") return [];
  const mentions = [];
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) {
    mentions.push(m[1].toLowerCase());
  }
  return [...new Set(mentions)];
}

// --- Writer lock ---

function acquireWriterLock(projectId) {
  const lockPath = writerLockPath(projectId);
  const dir = chatDir(projectId);
  ensureSecureDir(dir);

  if (fs.existsSync(lockPath)) {
    let existingPid;
    try {
      existingPid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
    } catch {
      // Corrupt lock file — overwrite
    }
    if (existingPid) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`QuadWork already running on this directory (pid ${existingPid})`);
      } catch (err) {
        if (err.code === "ESRCH") {
          console.warn(`[file-chat] Stale writer lock for project ${projectId} (pid ${existingPid}), replacing`);
        } else if (!err.code) {
          throw err;
        }
      }
    }
  }

  writeSecureFile(lockPath, String(process.pid));
}

function releaseWriterLock(projectId) {
  try {
    fs.unlinkSync(writerLockPath(projectId));
  } catch {}
}

// --- ID recovery ---

function recoverNextId(projectId) {
  const filePath = chatFile(projectId);
  let maxId = 0;

  if (!fs.existsSync(filePath)) return 1;

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.id === "number" && record.id > maxId) {
        maxId = record.id;
      }
    } catch {
      console.warn(`[file-chat] Skipped corrupt JSONL line in project ${projectId}`);
    }
  }

  return maxId + 1;
}

// --- Core functions ---

const CACHE_SIZE = 200;

function initProject(projectId) {
  const dir = chatDir(projectId);
  ensureSecureDir(dir);

  acquireWriterLock(projectId);

  const state = getState(projectId);
  state.nextId = recoverNextId(projectId);

  // Populate cache from existing file
  const filePath = chatFile(projectId);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // already warned during recoverNextId
      }
    }
    state.cache = records.slice(-CACHE_SIZE);
  }

  console.log(`[file-chat] Initialized project ${projectId}, next ID: ${state.nextId}, cached: ${state.cache.length} messages`);
}

function shutdownProject(projectId) {
  releaseWriterLock(projectId);
  projectState.delete(projectId);
}

function appendMessage(projectId, { sender, channel = "general", text, type = "message" }, _skipLoopGuard = false) {
  const state = getState(projectId);
  if (state.nextId === null) {
    throw new Error(`Project ${projectId} not initialized — call initProject first`);
  }

  const id = state.nextId++;
  const seq = id; // seq mirrors id for single-channel
  const record = {
    id,
    seq,
    ts: new Date().toISOString(),
    sender: sender || "system",
    channel,
    type,
    text: text || "",
    mentions: parseMentions(text),
  };

  const dir = chatDir(projectId);
  ensureSecureDir(dir);
  const filePath = chatFile(projectId);

  const line = JSON.stringify(record) + "\n";

  let retries = 3;
  while (retries > 0) {
    try {
      fs.appendFileSync(filePath, line, { mode: 0o600 });
      try { fs.chmodSync(filePath, 0o600); } catch {}
      break;
    } catch (err) {
      retries--;
      if (retries === 0) {
        console.error(`[file-chat] Append failure for project ${projectId}: ${err.message}`);
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  state.cache.push(record);
  if (state.cache.length > CACHE_SIZE) {
    state.cache = state.cache.slice(-CACHE_SIZE);
  }

  return record;
}

function readMessages(projectId, { since_id = 0, limit = 50 } = {}) {
  const state = getState(projectId);

  // Try cache first
  if (state.cache.length > 0) {
    const cacheMinId = state.cache[0].id;
    if (since_id >= cacheMinId || since_id === 0) {
      let results = since_id > 0
        ? state.cache.filter((m) => m.id > since_id)
        : state.cache;
      return results.slice(-limit);
    }
  }

  // Fall back to disk
  const filePath = chatFile(projectId);
  if (!fs.existsSync(filePath)) {
    console.warn(`[file-chat] Missing chat file for project ${projectId}, creating empty`);
    const dir = chatDir(projectId);
    ensureSecureDir(dir);
    writeSecureFile(filePath, "");
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (since_id > 0 && record.id <= since_id) continue;
      results.push(record);
    } catch {
      console.warn(`[file-chat] Skipped corrupt JSONL line in project ${projectId}`);
    }
  }

  return results.slice(-limit);
}

function getNextId(projectId) {
  const state = getState(projectId);
  if (state.nextId === null) {
    state.nextId = recoverNextId(projectId);
  }
  return state.nextId;
}

// #717: per-project loop guard state
const _loopGuardState = new Map();

function checkLoopGuard(projectId, msg, maxHops = 30) {
  let state = _loopGuardState.get(projectId) || { hops: 0, paused: false };

  if (msg.sender === "user") {
    const isResume = typeof msg.text === "string" && msg.text.trim() === "/continue";
    state.hops = 0;
    state.paused = false;
    _loopGuardState.set(projectId, state);
    if (isResume) {
      appendMessageInternal(projectId, {
        sender: "system",
        type: "system",
        text: "Loop guard resumed.",
        channel: msg.channel || "general",
      });
    }
    return;
  }

  if (msg.type === "system") return;
  if (state.paused) return;

  state.hops++;
  if (state.hops >= maxHops) {
    state.paused = true;
    appendMessageInternal(projectId, {
      sender: "system",
      type: "system",
      text: `Loop guard: paused after ${maxHops} agent-to-agent messages with no human reply. Type /continue to resume.`,
      channel: msg.channel || "general",
    });
  }
  _loopGuardState.set(projectId, state);
}

function isLoopGuardPaused(projectId) {
  const state = _loopGuardState.get(projectId);
  return state ? state.paused : false;
}

function resetLoopGuard(projectId) {
  _loopGuardState.delete(projectId);
}

function appendMessageInternal(projectId, opts) {
  return appendMessage(projectId, opts, true);
}

// #715: per-agent shim tokens for authenticated sends.
// Map<"projectId:agentId", token>
const _shimTokens = new Map();

function registerShimToken(projectId, agentId, token) {
  _shimTokens.set(`${projectId}:${agentId}`, token);
}

function validateShimToken(projectId, agentId, token) {
  return _shimTokens.get(`${projectId}:${agentId}`) === token;
}

module.exports = {
  initProject,
  shutdownProject,
  appendMessage,
  readMessages,
  getNextId,
  parseMentions,
  MENTION_RE,
  checkLoopGuard,
  isLoopGuardPaused,
  resetLoopGuard,
  registerShimToken,
  validateShimToken,
  // exposed for testing
  _getState: getState,
  _chatDir: chatDir,
  _chatFile: chatFile,
};
