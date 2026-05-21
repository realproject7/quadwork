/**
 * Migrated Next.js API routes — now served directly from Express.
 * Routes: config, chat, projects, memory, setup, rename, github/issues, github/prs, telegram
 */
const express = require("express");
const { execFile: _execFileCb, execFileSync, spawn } = require("child_process");
const _execFileAsync = require("util").promisify(_execFileCb);
const fs = require("fs");
const path = require("path");
const os = require("os");

const multer = require("multer");
const fileChat = require("./file-chat");
const telegramBridge = require("./bridges/telegram");
const discordBridge = require("./bridges/discord");

const router = express.Router();

// #730: PTY dispatch callback — set by index.js at startup
let _ptyDispatchCallback = null;
function setPtyDispatchCallback(fn) { _ptyDispatchCallback = fn; }

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const ENV_PATH = path.join(CONFIG_DIR, ".env");
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function isLocalhost(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// ─── GitHub API rate limit tracking (#554) ────────────────────────────────
// Shared rate-limit state: periodically refreshed via `gh api rate_limit`.
// Server-side gh calls check this before executing and back off when low.
const _rateLimit = {
  limit: 5000,
  remaining: 5000,
  resetAt: 0,        // epoch ms
  updatedAt: 0,      // epoch ms when we last fetched
  error: null,       // last fetch error message, if any
};
const RATE_LIMIT_POLL_MS = 60_000;       // refresh every 60s
const RATE_LIMIT_LOW_THRESHOLD = 200;    // below this → back off
const RATE_LIMIT_CRITICAL = 50;          // below this → stop all infra gh calls
let _rateLimitTimer = null;

async function refreshRateLimit() {
  try {
    const { stdout } = await _execFileAsync("gh", [
      "api", "rate_limit", "--jq", ".resources.core | {limit,remaining,reset}",
    ], { encoding: "utf-8", timeout: 10000 });
    const data = JSON.parse(stdout);
    _rateLimit.limit = data.limit;
    _rateLimit.remaining = data.remaining;
    _rateLimit.resetAt = data.reset * 1000; // seconds → ms
    _rateLimit.updatedAt = Date.now();
    _rateLimit.error = null;
  } catch (err) {
    _rateLimit.error = err.message;
    _rateLimit.updatedAt = Date.now();
  }
}

function startRateLimitPolling() {
  if (_rateLimitTimer) return;
  refreshRateLimit();
  _rateLimitTimer = setInterval(refreshRateLimit, RATE_LIMIT_POLL_MS);
}

function isRateLimited() {
  return _rateLimit.remaining < RATE_LIMIT_CRITICAL;
}
function isRateLow() {
  return _rateLimit.remaining < RATE_LIMIT_LOW_THRESHOLD;
}

// Adaptive cache TTL: normal 30s, low 120s, critical ∞ (serve stale)
function adaptiveTTL(baseTTL) {
  if (isRateLimited()) return Infinity;
  if (isRateLow()) return Math.max(baseTTL, 120_000);
  return baseTTL;
}

// ─── Cached GitHub endpoint helper (#554) ─────────────────────────────────
// Wraps a synchronous execFileSync gh call with an in-memory cache that
// serves stale data when rate-limited instead of hammering the API.
const _ghEndpointCache = new Map(); // key → { ts, data }
const GH_ENDPOINT_CACHE_TTL = 60_000; // #698: 60s base TTL (was 30s)

// #698: concurrency-limited background refresh queue. Caps simultaneous
// gh CLI calls to avoid triggering GitHub's secondary rate limit even
// when many endpoints expire on the same poll cycle.
const _ghRefreshing = new Set();
const GH_MAX_CONCURRENT = 2;
const _ghRefreshQueue = [];
let _ghActiveRefreshes = 0;

function _ghDrainQueue() {
  while (_ghRefreshQueue.length > 0 && _ghActiveRefreshes < GH_MAX_CONCURRENT) {
    const job = _ghRefreshQueue.shift();
    _ghActiveRefreshes++;
    job().finally(() => { _ghActiveRefreshes--; _ghDrainQueue(); });
  }
}

function _ghEnqueueRefresh(cacheKey, ghArgs, transform) {
  if (_ghRefreshing.has(cacheKey)) return; // already queued/in-flight
  _ghRefreshing.add(cacheKey);
  _ghRefreshQueue.push(() =>
    _execFileAsync("gh", ghArgs, { encoding: "utf-8", timeout: 15000 })
      .then(({ stdout }) => {
        let data = JSON.parse(stdout);
        if (transform) data = transform(data);
        _ghEndpointCache.set(cacheKey, { ts: Date.now(), data, stale: false });
      })
      .catch(() => {}) // keep serving stale on error
      .finally(() => _ghRefreshing.delete(cacheKey))
  );
  _ghDrainQueue();
}

function cachedGhEndpoint(cacheKey, ghArgs, res, { transform } = {}) {
  const ttl = adaptiveTTL(GH_ENDPOINT_CACHE_TTL);
  const cached = _ghEndpointCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttl) {
    return res.json(cached.stale ? { ...cached.data, _stale: true } : cached.data);
  }
  // If critically rate-limited, serve whatever we have (even expired)
  if (isRateLimited() && cached) {
    return res.json({ ...cached.data, _stale: true, _rateLimited: true });
  }
  // #698: stale-while-revalidate — if we have stale data, serve it
  // immediately and enqueue a background refresh. The queue caps
  // concurrent gh calls to GH_MAX_CONCURRENT to prevent burst traffic.
  if (cached) {
    _ghEnqueueRefresh(cacheKey, ghArgs, transform);
    return res.json({ ...cached.data, _stale: true });
  }
  // No cached data at all — must fetch synchronously for first load
  try {
    const out = execFileSync("gh", ghArgs, { encoding: "utf-8", timeout: 15000 });
    let data = JSON.parse(out);
    if (transform) data = transform(data);
    _ghEndpointCache.set(cacheKey, { ts: Date.now(), data, stale: false });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "gh call failed", detail: err.message });
  }
}

const DEFAULT_CONFIG = {
  port: 8400,
  projects: [],
};

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfigFile(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  ensureSecureDir(dir);
  writeConfig(cfg);
}

// ─── Version ──────────────────────────────────────────────────────────────

router.get("/api/version", (_req, res) => {
  const pkg = require("../package.json");
  res.json({ version: pkg.version });
});

// ─── Config ────────────────────────────────────────────────────────────────

router.get("/api/config", (_req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // #409 / quadwork#273: overlay the sanitized operator_name so
    // the chat panel's self-message filter compares against the same
    // sender /api/chat actually stamps. The on-disk file keeps the
    // raw value the operator typed (so a future feature can show
    // both raw + effective), but every reader sees the effective
    // value here — including SettingsPage, which now reflects what
    // chat actually sends. This also makes a hand-edited file with
    // garbage characters self-correct visibly on next reload.
    parsed.operator_name = sanitizeOperatorName(parsed.operator_name);
    res.json(parsed);
  } catch (err) {
    if (err.code === "ENOENT") return res.json(DEFAULT_CONFIG);
    res.status(500).json({ error: "Failed to read config", detail: err.message });
  }
});

router.put("/api/config", (req, res) => {
  try {
    const body = req.body;
    const dir = path.dirname(CONFIG_PATH);
    ensureSecureDir(dir);
    writeConfig(body);
    // Trigger sync is handled internally since we're in the same process now
    if (typeof req.app.get("syncTriggers") === "function") {
      req.app.get("syncTriggers")();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to write config", detail: err.message });
  }
});

// ─── Chat (file-based) ────────────────────────────────────────────────────

const { sanitizeOperatorName, ensureSecureDir, writeSecureFile, writeConfig } = require("./config");
const { findAgentChattr } = require("./install-agentchattr");

/**
 * Seed ~/.quadwork/{projectId}/OVERNIGHT-QUEUE.md from the template.
 * Idempotent: never overwrites an existing file so user / Head
 * agent edits are preserved across re-runs. All errors are swallowed
 * — project creation should not abort over a docs file, and callers
 * that need the file to exist should re-run setup.
 */
function writeOvernightQueueFileSafe(projectId, projectName, repo) {
  try {
    const queuePath = path.join(CONFIG_DIR, projectId, "OVERNIGHT-QUEUE.md");
    if (fs.existsSync(queuePath)) return;
    const tpl = path.join(TEMPLATES_DIR, "OVERNIGHT-QUEUE.md");
    if (!fs.existsSync(tpl)) return;
    ensureSecureDir(path.dirname(queuePath));
    let content = fs.readFileSync(tpl, "utf-8");
    content = content.replace(/\{\{project_name\}\}/g, projectName || projectId || "");
    content = content.replace(/\{\{repo\}\}/g, repo || "");
    fs.writeFileSync(queuePath, content);
  } catch { /* non-fatal */ }
}

function getProjectMaxHops(projectId) {
  if (!projectId) return 30;
  const cfg = readConfigFile();
  const project = (cfg.projects || []).find((p) => p.id === projectId);
  if (project?.max_agent_hops != null) return project.max_agent_hops;
  return 30;
}

function getProjectChatMode(projectId) {
  const cfg = readConfigFile();
  const project = cfg.projects?.find((p) => p.id === projectId);
  return project?.chat_mode === "ac" ? "ac" : "file";
}

function emitSystemMessage(projectId, text) {
  try {
    fileChat.appendMessage(projectId, { sender: "system", type: "system", text });
  } catch {}
}

router.get("/api/chat", (req, res) => {
  const projectId = req.query.project;

  const sinceId = Number(req.query.since_id) || Number(req.query.cursor) || 0;
  const messages = fileChat.readMessages(projectId, {
    since_id: sinceId,
    limit: Number(req.query.limit) || 50,
  });
  const normalized = messages.map((m) => ({
    ...m,
    time: m.time || (m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : ""),
  }));
  return res.json(normalized);
});

// #693: Auto-normalize bare agent names to @mentions in outbound messages.
// Bare "head", "dev", "re1", "re2" become "@head", "@dev", "@re1", "@re2".
// Already-prefixed mentions are not double-prefixed; suffixed names like
// "head-2" or "re1-3" are left untouched.
const MENTION_AGENT_NAMES = ["head", "dev", "re1", "re2"];
function normalizeMentions(text) {
  if (typeof text !== "string" || !text) return text || "";
  const preserved = [];
  const ph = "\x00CODE\x00";
  let safe = text.replace(/```[\s\S]*?```|`[^`]+`/g, (m) => {
    preserved.push(m);
    return ph;
  });
  safe = MENTION_AGENT_NAMES.reduce(
    (t, name) =>
      t.replace(new RegExp(`(?<![@\\w])\\b${name}\\b(?![\\w-])`, "gi"), (match, offset, str) => {
        const before = str.slice(Math.max(0, offset - 20), offset);
        if (/[=\/]$/.test(before) || /\b(run|exec|npx|start|checkout|switch|rebase|cd|cat|ls|rm|mv|cp|mkdir)\s+$/i.test(before)) return match;
        const after = str.slice(offset + name.length, offset + name.length + 1);
        if (after === "/") return match;
        return `@${name}`;
      }),
    safe,
  );
  let i = 0;
  return safe.replace(new RegExp(ph, "g"), () => preserved[i++] || "");
}

router.get("/api/loop-guard", (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  const value = getProjectMaxHops(projectId);
  return res.json({ value, source: value === 30 ? "default" : "config" });
});

router.put("/api/loop-guard", (req, res) => {
  const projectId = req.query.project || req.body?.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  const raw = req.body?.value;
  const value = typeof raw === "number" ? raw : parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 4 || value > 50) {
    return res.status(400).json({ error: "value must be an integer between 4 and 50" });
  }

  const cfg = readConfigFile();
  const project = (cfg.projects || []).find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  project.max_agent_hops = value;
  writeConfigFile(cfg);
  return res.json({ ok: true, value });
});

// #412 / quadwork#279: project history export + import.
//
// Export reads messages from file-chat and wraps the array in a
// small metadata envelope so future imports can warn on project-id
// mismatch and so a future schema bump can be detected client-side.
//
// Import accepts the same envelope, validates the shape + size,
// and replays each message into the file-chat store — preserving
// the original sender field for cross-tool consistency.

const PROJECT_HISTORY_VERSION = 1;
const PROJECT_HISTORY_MAX_BYTES = 10 * 1024 * 1024; // 10 MB cap per issue

// #414 / quadwork#297: reject imports whose messages claim a
// reserved agent / system sender by default. Mirrors the
// RESERVED_OPERATOR_NAMES denylist from sanitizeOperatorName so
// the same identities are blocked across the codebase.
const RESERVED_HISTORY_SENDERS = new Set([
  "head",
  "dev",
  "re1",
  "re2",
  // Legacy agent slugs — kept for backward compat so old config
  // imports are still blocked. New projects use head/dev/re1/re2.
  "reviewer1",
  "reviewer2",
  "t1",
  "t2a",
  "t2b",
  "t3",
  "system",
]);

router.get("/api/project-history", (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  try {
    const messages = fileChat.readMessages(projectId, { limit: 100000 });
    res.json({
      version: PROJECT_HISTORY_VERSION,
      project_id: projectId,
      exported_at: new Date().toISOString(),
      message_count: messages.length,
      messages,
    });
  } catch (err) {
    res.status(500).json({ error: "Project history export failed", detail: err.message || String(err) });
  }
});

// Global express.json() in server/index.js is bumped to 10mb to
// cover this route — see the comment there. The route handler still
// double-checks the byte size of the parsed body below as a defense
// in depth (e.g. if a future change scopes the global parser back
// down without updating this comment).
router.post("/api/project-history", async (req, res) => {
  const projectId = req.query.project || req.body?.project_id;
  if (!projectId) return res.status(400).json({ error: "Missing project" });

  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  // Body size guard — express.json() respects its own limit too,
  // but stamp the explicit cap from the issue here so the error
  // message is operator-readable.
  try {
    const approxBytes = Buffer.byteLength(JSON.stringify(body));
    if (approxBytes > PROJECT_HISTORY_MAX_BYTES) {
      return res.status(413).json({ error: `History file too large (${approxBytes} bytes; limit ${PROJECT_HISTORY_MAX_BYTES})` });
    }
  } catch {
    // JSON.stringify circular — already invalid, fall through
  }

  if (!Array.isArray(body.messages)) {
    return res.status(400).json({ error: "Missing or invalid 'messages' array" });
  }
  if (body.version && body.version !== PROJECT_HISTORY_VERSION) {
    return res.status(400).json({ error: `Unsupported export version ${body.version} (expected ${PROJECT_HISTORY_VERSION})` });
  }
  // Soft project-id mismatch warning. The client UI should confirm
  // before POSTing when the IDs differ; if it didn't (e.g. curl),
  // require an explicit override flag so we can't silently merge
  // foreign chat into the wrong project.
  if (body.project_id && body.project_id !== projectId && body.allow_project_mismatch !== true) {
    return res.status(409).json({
      error: `Project mismatch: file is from '${body.project_id}', target is '${projectId}'. Resend with allow_project_mismatch=true to override.`,
    });
  }

  // #414 / quadwork#297 — Issue 1: agent/system sender denylist.
  // Pre-scan the messages array; if any line claims a reserved
  // identity, reject the entire import unless the operator opted
  // in via allow_agent_senders=true. Default-safe so a leaked or
  // crafted export file can't post as Head from the dashboard.
  if (body.allow_agent_senders !== true) {
    const offenders = new Set();
    for (const m of body.messages) {
      if (m && typeof m === "object" && typeof m.sender === "string") {
        if (RESERVED_HISTORY_SENDERS.has(m.sender.toLowerCase())) {
          offenders.add(m.sender);
          if (offenders.size >= 5) break;
        }
      }
    }
    if (offenders.size > 0) {
      return res.status(400).json({
        error: `Import contains messages attributed to reserved agent/system identities: ${[...offenders].join(", ")}. Resend with allow_agent_senders=true to override (e.g. legitimate disaster-recovery restore).`,
      });
    }
  }

  // #414 / quadwork#297 — Issue 2: duplicate import detection.
  // Persist the most recent imported `exported_at` on the project
  // entry in config.json. If the file's marker matches, refuse the
  // import unless allow_duplicate=true. Re-importing the same file
  // would otherwise replay every message a second time and double
  // the chat history.
  const cfg = readConfigFile();
  const project = cfg.projects?.find((p) => p.id === projectId);
  const incomingExportedAt = typeof body.exported_at === "string" ? body.exported_at : null;
  if (body.allow_duplicate !== true && project && incomingExportedAt) {
    if (project.history_last_imported_at === incomingExportedAt) {
      return res.status(409).json({
        error: `This export was already imported (exported_at=${incomingExportedAt}). Resend with allow_duplicate=true to import again.`,
      });
    }
  }

  // Replay each message into the file-chat store. Preserve the
  // original sender so the imported transcript still attributes
  // each line correctly.
  let imported = 0;
  let skipped = 0;
  const errors = [];
  for (const m of body.messages) {
    if (!m || typeof m !== "object" || typeof m.text !== "string" || !m.text) {
      skipped++;
      continue;
    }
    try {
      fileChat.appendMessage(projectId, {
        sender: typeof m.sender === "string" && m.sender ? m.sender : "user",
        text: m.text,
        channel: typeof m.channel === "string" && m.channel ? m.channel : "general",
        type: m.type || "message",
      });
      imported++;
    } catch (err) {
      errors.push(`#${m.id ?? "?"}: ${err.message || String(err)}`);
      if (errors.length > 5) break;
    }
  }
  // #414 / quadwork#297 — Issue 2: stamp the import marker on the
  // project so a re-import of the same file is caught next time.
  // Only update on a successful (no errors) replay so a half-broken
  // import can be retried without the duplicate guard tripping.
  if (incomingExportedAt && errors.length === 0 && project) {
    project.history_last_imported_at = incomingExportedAt;
    try { writeConfigFile(cfg); }
    catch (err) { console.warn(`[history] failed to persist history_last_imported_at: ${err.message || err}`); }
  }

  res.json({ ok: errors.length === 0, imported, skipped, total: body.messages.length, errors });
});

// #424 / quadwork#304 Phase 4: list + restore auto-snapshots.
// snapshotProjectHistory() in server/index.js writes envelope
// files to ~/.quadwork/{id}/history-snapshots/{ISO}.json before
// destructive restart/update operations. These endpoints let the
// Project History widget surface them with a restore button so
// the operator can roll back a bad /clear or botched update.
router.get("/api/project-history/snapshots", (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  const snapDir = path.join(CONFIG_DIR, projectId, "history-snapshots");
  if (!fs.existsSync(snapDir)) return res.json({ snapshots: [] });
  try {
    const entries = fs.readdirSync(snapDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const st = fs.statSync(path.join(snapDir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ snapshots: entries });
  } catch (err) {
    res.status(500).json({ error: "Failed to list snapshots", detail: err.message });
  }
});

router.post("/api/project-history/restore", async (req, res) => {
  const projectId = req.query.project;
  const name = req.query.name || req.body?.name;
  if (!projectId || !name) return res.status(400).json({ error: "Missing project or name" });
  // Prevent path traversal — only allow basenames from the snapshot
  // directory; reject anything with a separator or ".." segment.
  if (name !== path.basename(name) || name.includes("..") || !name.endsWith(".json")) {
    return res.status(400).json({ error: "Invalid snapshot name" });
  }
  const snapPath = path.join(CONFIG_DIR, projectId, "history-snapshots", name);
  if (!fs.existsSync(snapPath)) {
    return res.status(404).json({ error: "Snapshot not found" });
  }
  let body;
  try {
    const text = fs.readFileSync(snapPath, "utf-8");
    body = JSON.parse(text);
  } catch (err) {
    return res.status(500).json({ error: "Failed to read snapshot", detail: err.message });
  }
  // Post the snapshot back through the existing import endpoint
  // with both bypass flags — the snapshot contains real agent
  // senders (so allow_agent_senders) and may match a previous
  // restore's exported_at (so allow_duplicate). This is the
  // legitimate disaster-recovery case the #297 denylist expected.
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const qwPort = cfg.port || 8400;
    const r = await fetch(`http://127.0.0.1:${qwPort}/api/project-history?project=${encodeURIComponent(projectId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, allow_agent_senders: true, allow_duplicate: true }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return res.status(r.status).json(data || { error: `import returned ${r.status}` });
    }
    res.json({ ok: true, ...(data || {}) });
  } catch (err) {
    res.status(502).json({ error: "Restore failed", detail: err.message });
  }
});

// #430 / quadwork#312: AI team work-hours tracking.
//
// The frontend's TerminalGrid detects per-agent activity transitions
// (idle → active, active → idle) via the existing activity ref and
// POSTs them to /api/activity/log. We buffer `start` events in
// memory keyed by `${project}/${agent}`; an `end` event looks up the
// matching buffered start, computes the duration, and appends a
// complete session row to ~/.quadwork/{project}/activity.jsonl.
//
// /api/activity/stats aggregates across all projects with a 30s
// cache so the dashboard can poll it every minute without thrashing
// the filesystem.

const _activityStarts = new Map(); // `${project}/${agent}` → startTimestamp
const _activityStatsCache = { ts: 0, data: null };
const ACTIVITY_STATS_TTL_MS = 30000;

function activityLogPath(projectId) {
  return path.join(CONFIG_DIR, projectId, "activity.jsonl");
}

router.post("/api/activity/log", (req, res) => {
  const { project, agent, type, timestamp } = req.body || {};
  if (typeof project !== "string" || !project) return res.status(400).json({ error: "Missing project" });
  if (typeof agent !== "string" || !agent) return res.status(400).json({ error: "Missing agent" });
  if (type !== "start" && type !== "end") return res.status(400).json({ error: "type must be start|end" });
  const ts = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now();
  const key = `${project}/${agent}`;

  if (type === "start") {
    // Only remember the first start per session — duplicate starts
    // are possible if the frontend re-mounts mid-stream; ignore
    // them so the session duration reflects the original onset.
    if (!_activityStarts.has(key)) _activityStarts.set(key, ts);
    return res.json({ ok: true });
  }

  // type === "end"
  const start = _activityStarts.get(key);
  if (start === undefined) {
    // Orphan end (missed start — probably happens on server
    // restart while a session was live). Drop it silently so we
    // don't write a row with an unknown start timestamp.
    return res.json({ ok: true, dropped: "orphan" });
  }
  _activityStarts.delete(key);
  const row = { agent, start, end: ts, duration_ms: Math.max(0, ts - start) };
  try {
    const p = activityLogPath(project);
    ensureSecureDir(path.dirname(p));
    fs.appendFileSync(p, JSON.stringify(row) + "\n");
    // Invalidate the stats cache so the next read sees the new row.
    _activityStatsCache.ts = 0;
  } catch (err) {
    console.warn(`[activity] failed to append ${project}/${agent}: ${err.message || err}`);
  }
  res.json({ ok: true, duration_ms: row.duration_ms });
});

// Aggregate all activity.jsonl files under ~/.quadwork/*/activity.jsonl.
// `today`, `week`, `month` boundaries use the operator's local
// timezone rather than UTC — "this week" should mean the week the
// operator is living in, not a UTC-offset week that starts at
// 16:00 local time.
function computeActivityStats() {
  if (Date.now() - _activityStatsCache.ts < ACTIVITY_STATS_TTL_MS && _activityStatsCache.data) {
    return _activityStatsCache.data;
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Start of this week = local Monday 00:00. JS: getDay() → 0-Sun..6-Sat.
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day; // Sun → -6, Mon → 0, Tue → -1, …
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const totals = { today_ms: 0, week_ms: 0, month_ms: 0, total_ms: 0 };
  const byProject = {};
  // #430 / quadwork#312: only count projects registered in
  // config.json, not every directory under ~/.quadwork/. Stray
  // folders from deleted / unconfigured projects must not inflate
  // the stats — that's explicit in #312's acceptance.
  let projectIds = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (Array.isArray(cfg.projects)) {
      projectIds = cfg.projects.map((p) => p && p.id).filter((id) => typeof id === "string" && id);
    }
  } catch {
    // config unreadable → no projects → empty stats (safe fallback)
  }
  for (const projectId of projectIds) {
    const p = activityLogPath(projectId);
    if (!fs.existsSync(p)) continue;
    const projectTotals = { today_ms: 0, week_ms: 0, month_ms: 0, total_ms: 0 };
    let text;
    try { text = fs.readFileSync(p, "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const d = row && typeof row.duration_ms === "number" ? row.duration_ms : 0;
      const start = row && typeof row.start === "number" ? row.start : 0;
      if (d <= 0 || !start) continue;
      projectTotals.total_ms += d;
      if (start >= startOfToday) projectTotals.today_ms += d;
      if (start >= startOfWeek)  projectTotals.week_ms  += d;
      if (start >= startOfMonth) projectTotals.month_ms += d;
    }
    byProject[projectId] = {
      today: Math.round(projectTotals.today_ms / 3600) / 1000,
      week:  Math.round(projectTotals.week_ms  / 3600) / 1000,
      month: Math.round(projectTotals.month_ms / 3600) / 1000,
      total: Math.round(projectTotals.total_ms / 3600) / 1000,
    };
    totals.today_ms += projectTotals.today_ms;
    totals.week_ms  += projectTotals.week_ms;
    totals.month_ms += projectTotals.month_ms;
    totals.total_ms += projectTotals.total_ms;
  }
  const data = {
    today: Math.round(totals.today_ms / 3600) / 1000,
    week:  Math.round(totals.week_ms  / 3600) / 1000,
    month: Math.round(totals.month_ms / 3600) / 1000,
    total: Math.round(totals.total_ms / 3600) / 1000,
    by_project: byProject,
  };
  _activityStatsCache.ts = Date.now();
  _activityStatsCache.data = data;
  return data;
}

router.get("/api/activity/stats", (_req, res) => {
  try {
    res.json(computeActivityStats());
  } catch (err) {
    res.status(500).json({ error: "Failed to compute activity stats", detail: err.message });
  }
});

router.post("/api/chat", (req, res) => {
  const projectId = req.query.project || req.body.project;

  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text) return res.status(400).json({ error: "text required" });
  const shimSender = req.headers["x-chat-sender"];
  const shimToken = req.headers["x-chat-token"];
  const bridgeSender = req.headers["x-bridge-sender"];
  let sender = "user";
  if (shimSender && shimToken) {
    if (!fileChat.validateShimToken(projectId, shimSender, shimToken)) {
      return res.status(403).json({ error: "Invalid shim token" });
    }
    sender = shimSender;
  } else if (bridgeSender && isLocalhost(req.ip)) {
    sender = bridgeSender;
  }
  const msg = fileChat.appendMessage(projectId, {
    sender,
    text: normalizeMentions(text),
    channel: req.body?.channel || "general",
    type: "message",
  });
  // #717: loop guard — count agent hops, pause if threshold reached
  const maxHops = getProjectMaxHops(projectId);
  fileChat.checkLoopGuard(projectId, msg, maxHops);
  if (!fileChat.isLoopGuardPaused(projectId)) {
    if (_ptyDispatchCallback) _ptyDispatchCallback(projectId, msg);
  }
  return res.json({ ok: true, message: msg });
});

// ─── Image upload (#466) ──────────────────────────────────────────────────

const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const uploadStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const projectId = req.query.project || "";
    if (!projectId || /[/\\]/.test(projectId)) return cb(new Error("Invalid project"));
    const dir = path.join(CONFIG_DIR, projectId, "uploads");
    ensureSecureDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `upload-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported type: ${file.mimetype}`));
  },
});

router.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  return res.json({
    ok: true,
    path: req.file.path,
    name: req.file.filename,
  });
});

// Serve uploaded images for thumbnail rendering
router.get("/api/uploads/:project/:filename", (req, res) => {
  const { project, filename } = req.params;
  // Sanitize to prevent directory traversal
  if (/[/\\]/.test(project) || /[/\\]/.test(filename)) {
    return res.status(400).json({ error: "Invalid path" });
  }
  const filePath = path.join(CONFIG_DIR, project, "uploads", filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  // #560: pass error callback so Express/send NotFoundError (race between
  // existsSync and sendFile, or stricter file resolution in Express 5's
  // send module) is handled gracefully instead of spamming the server log.
  res.sendFile(filePath, (err) => {
    if (!err || res.headersSent) return;
    if (err.status === 404 || err.code === "ENOENT") {
      res.status(404).json({ error: "Not found" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

// ─── Projects (dashboard aggregation) ──────────────────────────────────────

// #512: cache /api/projects results for 60s to eliminate repeated
// slow gh CLI calls on every dashboard poll.
let _projectsCache = null;
let _projectsCacheTs = 0;
const PROJECTS_CACHE_TTL = 60_000;

router.get("/api/projects", async (req, res) => {
  if (_projectsCache && Date.now() - _projectsCacheTs < adaptiveTTL(PROJECTS_CACHE_TTL)) {
    return res.json(_projectsCache);
  }
  // #554: serve stale projects cache when critically rate-limited
  if (isRateLimited() && _projectsCache) {
    return res.json(_projectsCache);
  }

  const cfg = readConfigFile();

  // Fetch active sessions from our own in-memory state (only running PTYs)
  const activeSessions = req.app.get("activeSessions") || new Map();
  const activeProjectIds = new Set();
  for (const [, info] of activeSessions) {
    if (info.projectId && info.state === "running") activeProjectIds.add(info.projectId);
  }

  // Fetch chat messages from all projects (per-project AgentChattr instances)
  const chatMsgsByProject = {};
  for (const p of cfg.projects || []) {
    try {
      chatMsgsByProject[p.id] = fileChat.readMessages(p.id, { limit: 30 });
    } catch {}
  }
  // Aggregate all project chat messages for the activity feed
  let chatMsgs = Object.values(chatMsgsByProject).flat();

  const eventKeywords = /\b(PR|merged|pushed|approved|opened|closed|review|commit)\b/i;
  const workflowMsgs = chatMsgs
    .filter((m) => eventKeywords.test(m.text) && m.sender !== "system")
    .slice(-10)
    .reverse();

  // #512: build project-id-to-name map from config and a reverse
  // lookup from chat message to project name via chatMsgsByProject
  // (which already knows which AC instance each message came from).
  // This replaces the expensive allPrs/allIssues gh CLI calls that
  // were only used for the numberToProject mapping.
  const projectIdToName = {};
  for (const p of cfg.projects || []) projectIdToName[p.id] = p.name;
  const msgToProject = new Map();
  for (const [pid, msgs] of Object.entries(chatMsgsByProject)) {
    for (const m of msgs) msgToProject.set(m, projectIdToName[pid]);
  }

  // #512: parallelize gh CLI calls across projects using async exec.
  // Only fetch open PR count and most recent PR activity — drop the
  // allPrs/allIssues calls that were only used for numberToProject.
  async function fetchProjectGhData(p) {
    let openPrs = 0;
    let lastActivity = null;
    if (REPO_RE.test(p.repo)) {
      try {
        const [prs, recentPrs] = await Promise.allSettled([
          ghJsonExecAsync(["pr", "list", "-R", p.repo, "--json", "number", "--limit", "100"]),
          ghJsonExecAsync(["pr", "list", "-R", p.repo, "--state", "all", "--json", "updatedAt", "--limit", "1"]),
        ]);
        if (prs.status === "fulfilled") openPrs = prs.value.length;
        if (recentPrs.status === "fulfilled") lastActivity = recentPrs.value[0]?.updatedAt || null;
      } catch {}
    }
    const hasAgents = p.agents && Object.keys(p.agents).length > 0;
    return {
      id: p.id,
      name: p.name,
      repo: p.repo,
      agentCount: p.agents ? Object.keys(p.agents).length : 0,
      openPrs,
      state: hasAgents && activeProjectIds.has(p.id) ? "active" : "idle",
      lastActivity,
    };
  }

  const projectResults = await Promise.all(
    (cfg.projects || []).map((p) => fetchProjectGhData(p))
  );

  // Build activity feed — use chat-based project association instead
  // of the dropped numberToProject gh lookup.
  const recentEvents = [];
  for (const m of workflowMsgs) {
    // First: try text match against repo/project name
    let projectName = (cfg.projects || []).find((p) => m.text.includes(p.repo) || m.text.includes(p.name))?.name;
    // Second: use the AC instance the message came from
    if (!projectName) projectName = msgToProject.get(m);
    // Fallback: single-project installs
    if (!projectName && cfg.projects && cfg.projects.length === 1) {
      projectName = cfg.projects[0].name;
    }
    if (projectName) {
      recentEvents.push({
        time: m.time,
        text: m.text.length > 120 ? m.text.slice(0, 120) + "…" : m.text,
        actor: m.sender,
        projectName,
      });
    }
    if (recentEvents.length >= 10) break;
  }

  const result = { projects: projectResults, recentEvents };
  _projectsCache = result;
  _projectsCacheTs = Date.now();
  res.json(result);
});

// ─── GitHub Rate Limit (#554) ──────────────────────────────────────────────

router.get("/api/github/rate-limit", (_req, res) => {
  const resetIn = _rateLimit.resetAt > Date.now()
    ? Math.ceil((_rateLimit.resetAt - Date.now()) / 60000)
    : 0;
  res.json({
    limit: _rateLimit.limit,
    remaining: _rateLimit.remaining,
    resetAt: _rateLimit.resetAt,
    resetInMinutes: resetIn,
    low: isRateLow(),
    critical: isRateLimited(),
    updatedAt: _rateLimit.updatedAt,
    error: _rateLimit.error,
  });
});

// ─── GitHub Issues / PRs ───────────────────────────────────────────────────

function getRepo(projectId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p) => p.id === projectId);
    const repo = project?.repo;
    if (repo && REPO_RE.test(repo)) return repo;
    return null;
  } catch {
    return null;
  }
}

// ─── #703: Batched GraphQL layer ──────────────────────────────────────────
// Instead of spawning individual `gh issue list` / `gh pr list` subprocesses
// per project per endpoint, we fetch ALL configured projects' GitHub data in
// a single GraphQL query. The per-project endpoints read from this shared
// cache, falling back to individual gh CLI calls if GraphQL fails.

const _graphqlCache = new Map(); // repo → { ts, issues, prs, closedIssues, mergedPrs }
const GRAPHQL_CACHE_TTL = 60_000; // same as GH_ENDPOINT_CACHE_TTL
let _graphqlRefreshInFlight = false;

const RECENT_FETCH_LIMIT = 20;
const RECENT_DISPLAY_LIMIT = 5;

// Build and execute a batched GraphQL query for all configured projects.
// Returns a Map of repo → { issues, prs, closedIssues, mergedPrs }.
async function fetchAllProjectsGraphQL() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
  const projects = (cfg.projects || []).filter((p) => p.repo && REPO_RE.test(p.repo));
  if (projects.length === 0) return null;

  // Build aliased repository fields — one per project.
  // Alias must be a valid GraphQL identifier: letters/digits/underscore only.
  const seen = new Set();
  const fragments = [];
  for (const p of projects) {
    const [owner, name] = p.repo.split("/");
    const alias = p.repo.replace(/[^a-zA-Z0-9]/g, "_");
    if (seen.has(alias)) continue; // skip duplicate repos
    seen.add(alias);
    fragments.push(`${alias}: repository(owner: "${owner}", name: "${name}") { ...repoFields }`);
  }

  const query = `query {
  ${fragments.join("\n  ")}
}
fragment repoFields on Repository {
  openIssues: issues(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url state labels(first: 5) { nodes { name } } assignees(first: 5) { nodes { login } } createdAt }
  }
  closedIssues: issues(first: ${RECENT_FETCH_LIMIT}, states: CLOSED, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url state closedAt }
  }
  openPRs: pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url state author { login } reviews(last: 100) { nodes { state author { login } submittedAt } } createdAt }
  }
  mergedPRs: pullRequests(first: ${RECENT_FETCH_LIMIT}, states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url state mergedAt author { login } }
  }
}`;

  try {
    const { stdout } = await _execFileAsync("gh", [
      "api", "graphql", "-f", `query=${query}`,
    ], { encoding: "utf-8", timeout: 15000 });
    const data = JSON.parse(stdout).data;
    if (!data) return null;

    const result = new Map();
    for (const p of projects) {
      const alias = p.repo.replace(/[^a-zA-Z0-9]/g, "_");
      const repoData = data[alias];
      if (!repoData) continue;

      // Transform GraphQL nodes into the same shape as gh CLI JSON output.
      const issues = (repoData.openIssues?.nodes || []).map((n) => ({
        number: n.number,
        title: n.title,
        state: n.state === "OPEN" ? "open" : n.state?.toLowerCase() || n.state,
        url: n.url,
        labels: (n.labels?.nodes || []).map((l) => ({ name: l.name })),
        assignees: (n.assignees?.nodes || []).map((a) => ({ login: a.login })),
        createdAt: n.createdAt,
      }));

      const prs = (repoData.openPRs?.nodes || []).map((n) => ({
        number: n.number,
        title: n.title,
        state: n.state === "OPEN" ? "open" : n.state?.toLowerCase() || n.state,
        url: n.url,
        author: n.author ? { login: n.author.login } : null,
        assignees: [],
        reviews: (n.reviews?.nodes || []).map((r) => ({
          state: r.state,
          author: r.author ? { login: r.author.login } : null,
          submittedAt: r.submittedAt,
        })),
        createdAt: n.createdAt,
      }));

      const closedIssues = (repoData.closedIssues?.nodes || [])
        .slice()
        .sort((a, b) => {
          const ta = a?.closedAt ? Date.parse(a.closedAt) : 0;
          const tb = b?.closedAt ? Date.parse(b.closedAt) : 0;
          return tb - ta;
        })
        .slice(0, RECENT_DISPLAY_LIMIT)
        .map((n) => ({
          number: n.number,
          title: n.title,
          state: n.state?.toLowerCase() || "closed",
          url: n.url,
          closedAt: n.closedAt,
        }));

      const mergedPrs = (repoData.mergedPRs?.nodes || [])
        .slice()
        .sort((a, b) => {
          const ta = a?.mergedAt ? Date.parse(a.mergedAt) : 0;
          const tb = b?.mergedAt ? Date.parse(b.mergedAt) : 0;
          return tb - ta;
        })
        .slice(0, RECENT_DISPLAY_LIMIT)
        .map((n) => ({
          number: n.number,
          title: n.title,
          state: n.state?.toLowerCase() || "merged",
          url: n.url,
          mergedAt: n.mergedAt,
          author: n.author ? { login: n.author.login } : null,
        }));

      result.set(p.repo, { issues, prs, closedIssues, mergedPrs });
    }
    return result;
  } catch {
    return null; // fallback to individual gh CLI calls
  }
}

// Refresh the shared GraphQL cache for all projects. Called on a timer
// and on demand when a per-project endpoint has no cached data.
async function refreshGraphQLCache() {
  if (_graphqlRefreshInFlight) return;
  if (isRateLimited()) return; // don't burn quota when critically low
  _graphqlRefreshInFlight = true;
  try {
    const data = await fetchAllProjectsGraphQL();
    if (data) {
      const now = Date.now();
      for (const [repo, repoData] of data) {
        _graphqlCache.set(repo, { ts: now, ...repoData });
        // Also populate the per-endpoint _ghEndpointCache so stale-while-
        // revalidate and existing per-project endpoints pick up the data.
        _ghEndpointCache.set(`issues:${repo}`, { ts: now, data: repoData.issues, stale: false });
        _ghEndpointCache.set(`prs:${repo}`, { ts: now, data: repoData.prs, stale: false });
        _ghEndpointCache.set(`closed-issues:${repo}`, { ts: now, data: repoData.closedIssues, stale: false });
        _ghEndpointCache.set(`merged-prs:${repo}`, { ts: now, data: repoData.mergedPrs, stale: false });
      }
    }
  } catch {
    // Non-fatal — per-project endpoints still work via individual gh CLI.
  } finally {
    _graphqlRefreshInFlight = false;
  }
}

// Start background GraphQL polling alongside rate-limit polling.
let _graphqlPollTimer = null;
function startGraphQLPolling() {
  if (_graphqlPollTimer) return;
  // Initial fetch after a short delay (let rate-limit poll run first).
  setTimeout(() => refreshGraphQLCache(), 2000);
  _graphqlPollTimer = setInterval(refreshGraphQLCache, GRAPHQL_CACHE_TTL);
}

// #703: Batched GraphQL for batch progress — fetch all issue states +
// linked PRs in a single query instead of 2N individual gh calls.
async function fetchBatchProgressGraphQL(repo, issueNumbers) {
  if (!issueNumbers || issueNumbers.length === 0) return null;
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;

  // Build aliased issue fields.
  const issueFields = issueNumbers.map((n) =>
    `issue${n}: issue(number: ${n}) {
      number title state url
      closedByPullRequestsReferences(first: 3) {
        nodes { number state url merged reviews(last: 100) { nodes { state author { login } submittedAt } } }
      }
    }`
  ).join("\n    ");

  const query = `query {
  repository(owner: "${owner}", name: "${name}") {
    ${issueFields}
  }
}`;

  try {
    const { stdout } = await _execFileAsync("gh", [
      "api", "graphql", "-f", `query=${query}`,
    ], { encoding: "utf-8", timeout: 15000 });
    const data = JSON.parse(stdout).data;
    if (!data?.repository) return null;
    return data.repository;
  } catch {
    return null; // fallback to individual gh CLI calls
  }
}

// Convert a GraphQL batch progress issue node into the same progress
// row shape that progressForItemAsync produces.
function graphqlIssueToProgressRow(issueData) {
  if (!issueData) return null;

  const linked = issueData.closedByPullRequestsReferences?.nodes || [];
  const pr = linked.length > 0
    ? linked.slice().sort((a, b) => (b.number || 0) - (a.number || 0))[0]
    : null;

  // No linked PR — delegate to the existing buildNoPrRow helper.
  if (!pr) {
    return buildNoPrRow({
      number: issueData.number,
      title: issueData.title,
      state: issueData.state,
      url: issueData.url,
    });
  }

  const merged = pr.merged && issueData.state === "CLOSED";
  if (merged) {
    return {
      issue_number: issueData.number,
      title: issueData.title,
      url: pr.url || issueData.url,
      pr_number: pr.number,
      status: "merged",
      progress: 100,
      label: "Merged ✓",
    };
  }

  // Count distinct APPROVED reviews per author.
  const reviews = (pr.reviews?.nodes || []).slice();
  reviews.sort((a, b) => {
    const ta = a?.submittedAt ? Date.parse(a.submittedAt) : 0;
    const tb = b?.submittedAt ? Date.parse(b.submittedAt) : 0;
    return ta - tb;
  });
  const latestByAuthor = new Map();
  for (const r of reviews) {
    const author = r?.author?.login || "";
    if (!author) continue;
    latestByAuthor.set(author, r.state);
  }
  let approvalCount = 0;
  for (const state of latestByAuthor.values()) {
    if (state === "APPROVED") approvalCount++;
  }

  if (approvalCount >= 2) {
    return {
      issue_number: issueData.number,
      title: issueData.title,
      url: pr.url || issueData.url,
      pr_number: pr.number,
      status: "ready",
      progress: 80,
      label: `PR #${pr.number} · 2 approvals · ready`,
    };
  }
  if (approvalCount === 1) {
    return {
      issue_number: issueData.number,
      title: issueData.title,
      url: pr.url || issueData.url,
      pr_number: pr.number,
      status: "approved1",
      progress: 50,
      label: `PR #${pr.number} · 1 approval`,
    };
  }
  return {
    issue_number: issueData.number,
    title: issueData.title,
    url: pr.url || issueData.url,
    pr_number: pr.number,
    status: "in_review",
    progress: 20,
    label: `PR #${pr.number} · waiting on review`,
  };
}

// ─── /api/github/all — batched endpoint (#703) ────────────────────────────
// Returns all projects' GitHub data in one response. The frontend can
// optionally filter by project query param. Serves from GraphQL cache
// with on-demand refresh if stale.
router.get("/api/github/all", async (req, res) => {
  const projectFilter = req.query.project || "";

  // Ensure cache is populated.
  const anyStale = (() => {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return true; }
    const projects = (cfg.projects || []).filter((p) => p.repo && REPO_RE.test(p.repo));
    for (const p of projects) {
      const cached = _graphqlCache.get(p.repo);
      if (!cached || Date.now() - cached.ts > adaptiveTTL(GRAPHQL_CACHE_TTL)) return true;
    }
    return false;
  })();
  if (anyStale) await refreshGraphQLCache();

  // Build response.
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return res.status(500).json({ error: "Config unreadable" }); }
  const projects = (cfg.projects || []).filter((p) => p.repo && REPO_RE.test(p.repo));

  const result = {};
  const fallbackNeeded = [];
  for (const p of projects) {
    if (projectFilter && p.id !== projectFilter) continue;
    const cached = _graphqlCache.get(p.repo);
    if (cached) {
      result[p.id] = {
        issues: cached.issues,
        prs: cached.prs,
        closedIssues: cached.closedIssues,
        mergedPrs: cached.mergedPrs,
        _stale: Date.now() - cached.ts > adaptiveTTL(GRAPHQL_CACHE_TTL),
      };
    } else {
      fallbackNeeded.push(p);
    }
  }

  // Fallback: fetch missing projects via individual gh CLI calls.
  if (fallbackNeeded.length > 0 && !isRateLimited()) {
    const fallbackResults = await Promise.allSettled(
      fallbackNeeded.map(async (p) => {
        const repo = p.repo;
        const [issues, prs, closedIssues, mergedPrs] = await Promise.allSettled([
          _execFileAsync("gh", ["issue", "list", "-R", repo, "--json", "number,title,state,assignees,labels,createdAt,url", "--limit", "50"], { encoding: "utf-8", timeout: 15000 }).then(({ stdout }) => JSON.parse(stdout)),
          _execFileAsync("gh", ["pr", "list", "-R", repo, "--json", "number,title,state,author,assignees,reviewDecision,reviews,statusCheckRollup,url,createdAt", "--limit", "50"], { encoding: "utf-8", timeout: 15000 }).then(({ stdout }) => JSON.parse(stdout)),
          _execFileAsync("gh", ["issue", "list", "-R", repo, "--state", "closed", "--json", "number,title,state,url,closedAt", "--limit", String(RECENT_FETCH_LIMIT)], { encoding: "utf-8", timeout: 15000 }).then(({ stdout }) => {
            const items = JSON.parse(stdout);
            return Array.isArray(items)
              ? items.sort((a, b) => (Date.parse(b?.closedAt || 0)) - (Date.parse(a?.closedAt || 0))).slice(0, RECENT_DISPLAY_LIMIT)
              : items;
          }),
          _execFileAsync("gh", ["pr", "list", "-R", repo, "--state", "merged", "--json", "number,title,state,url,mergedAt,author", "--limit", String(RECENT_FETCH_LIMIT)], { encoding: "utf-8", timeout: 15000 }).then(({ stdout }) => {
            const items = JSON.parse(stdout);
            return Array.isArray(items)
              ? items.sort((a, b) => (Date.parse(b?.mergedAt || 0)) - (Date.parse(a?.mergedAt || 0))).slice(0, RECENT_DISPLAY_LIMIT)
              : items;
          }),
        ]);
        return {
          id: p.id,
          issues: issues.status === "fulfilled" ? issues.value : [],
          prs: prs.status === "fulfilled" ? prs.value : [],
          closedIssues: closedIssues.status === "fulfilled" ? closedIssues.value : [],
          mergedPrs: mergedPrs.status === "fulfilled" ? mergedPrs.value : [],
          _fallback: true,
        };
      }),
    );
    for (const r of fallbackResults) {
      if (r.status === "fulfilled") {
        result[r.value.id] = r.value;
      }
    }
  }

  res.json(result);
});

// ─── Per-project endpoints (backward compat, served from shared cache) ────

router.get("/api/github/issues", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });
  cachedGhEndpoint(
    `issues:${repo}`,
    ["issue", "list", "-R", repo, "--json", "number,title,state,assignees,labels,createdAt,url", "--limit", "50"],
    res,
  );
});

router.get("/api/github/prs", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });
  cachedGhEndpoint(
    `prs:${repo}`,
    ["pr", "list", "-R", repo, "--json", "number,title,state,author,assignees,reviewDecision,reviews,statusCheckRollup,url,createdAt", "--limit", "50"],
    res,
  );
});

// #411 / quadwork#281: recently closed issues + merged PRs for the
// "Recently closed" / "Recently merged" sub-sections under each
// list in GitHubPanel. Limit 5 items each, ordered by closedAt
// descending so the freshest activity sits at the top.
// gh CLI's default ordering for `issue list --state closed` and
// `pr list --state merged` is createdAt-desc, not closedAt/mergedAt-desc,
// so a stale-but-recently-closed item can sit below a fresh-but-
// older one. We pull a wider window and re-sort by close/merge time
// before truncating to 5 to honor #281's "newest first" requirement.

router.get("/api/github/closed-issues", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });
  cachedGhEndpoint(
    `closed-issues:${repo}`,
    ["issue", "list", "-R", repo, "--state", "closed", "--json", "number,title,state,url,closedAt", "--limit", String(RECENT_FETCH_LIMIT)],
    res,
    {
      transform: (items) =>
        Array.isArray(items)
          ? items
              .slice()
              .sort((a, b) => {
                const ta = a && a.closedAt ? Date.parse(a.closedAt) : 0;
                const tb = b && b.closedAt ? Date.parse(b.closedAt) : 0;
                return tb - ta;
              })
              .slice(0, RECENT_DISPLAY_LIMIT)
          : items,
    },
  );
});

router.get("/api/github/merged-prs", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });
  // gh pr list with `--state merged` filters server-side so we
  // don't have to pull every closed PR and discard the un-merged
  // ones (closed-without-merge). Same fetch-wider-then-sort
  // strategy as closed-issues so the newest merge always wins.
  cachedGhEndpoint(
    `merged-prs:${repo}`,
    ["pr", "list", "-R", repo, "--state", "merged", "--json", "number,title,state,url,mergedAt,author", "--limit", String(RECENT_FETCH_LIMIT)],
    res,
    {
      transform: (items) =>
        Array.isArray(items)
          ? items
              .slice()
              .sort((a, b) => {
                const ta = a && a.mergedAt ? Date.parse(a.mergedAt) : 0;
                const tb = b && b.mergedAt ? Date.parse(b.mergedAt) : 0;
                return tb - ta;
              })
              .slice(0, RECENT_DISPLAY_LIMIT)
          : items,
    },
  );
});

// #413 / quadwork#282: Current Batch Progress panel.
//
// Reads ~/.quadwork/{project}/OVERNIGHT-QUEUE.md, parses the
// `## Active Batch` section for `Batch: N` + issue numbers, and
// resolves each issue against GitHub (state + linked PR + review
// counts) to compute a progress state. The 5 progress buckets are
// deterministic from issue/PR state — no agent inference.
//
// Progress mapping (from upstream issue):
//   queued    0%   issue OPEN, no linked PR
//   in_review 20%  PR open, 0 approvals
//   approved1 50%  PR open, 1 approval
//   ready     80%  PR open, 2+ approvals
//   merged   100%  PR merged AND issue closed
//   closed   100%  issue CLOSED with no linked PR (superseded,
//                  not planned, or runbook-only tasks) — #350
//
// Cached for 10s per project to avoid hammering gh on every poll.

const _batchProgressCache = new Map(); // projectId -> { ts, data }

// #429 / quadwork#316: persistent batch snapshot on disk so the
// Batch Progress panel keeps showing merged items after Head moves
// them from Active Batch to Done. The in-memory `_batchProgressCache`
// above is a 10s TTL cache of the rendered rows; this new cache is
// the *set of issue numbers* we currently consider "the active
// batch", and it survives restarts + lives across polls.
function batchSnapshotPath(projectId) {
  return path.join(CONFIG_DIR, projectId, "batch-progress-cache.json");
}
function readBatchSnapshot(projectId) {
  try {
    return JSON.parse(fs.readFileSync(batchSnapshotPath(projectId), "utf-8"));
  } catch {
    return null;
  }
}
function writeBatchSnapshot(projectId, snapshot) {
  try {
    const p = batchSnapshotPath(projectId);
    ensureSecureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(snapshot));
  } catch {
    // Non-fatal — panel still works from the live parse.
  }
}
function deleteBatchSnapshot(projectId) {
  try {
    fs.unlinkSync(batchSnapshotPath(projectId));
  } catch {
    // Non-fatal — file may already be gone.
  }
}

// #334: verify the snapshot's first issue number still exists on
// GitHub before trusting the snapshot. A soft existence check is
// enough — if the first issue genuinely 404s, treat the whole
// snapshot as stale (most likely a leftover from a prior
// project/repo that was purged) and let the caller drop it. One
// gh call per cache miss, wrapped in the existing
// BATCH_PROGRESS_TTL_MS cache upstream.
//
// Returns one of:
//   "fresh"   — first issue resolved, snapshot is trustworthy
//   "gone"    — first issue confirmed 404; snapshot should be dropped
//   "unknown" — transient error (auth/network/timeout); leave
//               snapshot alone and let the next cache miss retry
async function checkBatchSnapshotFreshness(repo, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.issueNumbers) || snapshot.issueNumbers.length === 0) {
    return "gone";
  }
  const first = snapshot.issueNumbers[0];
  try {
    await ghJsonExecAsync([
      "issue",
      "view",
      String(first),
      "-R",
      repo,
      "--json",
      "number",
    ]);
    return "fresh";
  } catch (err) {
    // gh surfaces a 404 via stderr text on a non-zero exit. Only
    // the unambiguous "not found" / "could not resolve" shapes
    // count as genuinely gone; anything else (network, auth,
    // timeout) is transient and must NOT delete the snapshot.
    const msg = String((err && (err.stderr || err.message)) || "").toLowerCase();
    if (msg.includes("could not resolve") || msg.includes("not found") || msg.includes("no issue")) {
      return "gone";
    }
    return "unknown";
  }
}

// Decide which batch to render, combining the live parse of
// OVERNIGHT-QUEUE.md with the persistent snapshot. The snapshot is
// replaced whenever a new batch starts (explicit Batch: N bump OR
// the live Active Batch contains items the snapshot doesn't); in
// all other cases the snapshot wins, so items Head moved to Done
// stay visible until the operator starts the next batch.
function resolveDisplayedBatch(queueText, projectId, { queueReadOk = true } = {}) {
  // Queue file deleted / unreadable → fall back to empty state per
  // #316's edge case. Returning the snapshot here would "heal" a
  // genuinely missing file into stale data the operator can't
  // reconcile without nuking ~/.quadwork/{id}/batch-progress-cache.json
  // manually.
  if (!queueReadOk) return { batchNumber: null, issueNumbers: [] };
  const current = parseActiveBatch(queueText);
  const snapshot = readBatchSnapshot(projectId);
  const hasExplicitBump =
    current.batchNumber !== null &&
    (!snapshot || snapshot.batchNumber === null || current.batchNumber > snapshot.batchNumber);
  const hasNewItems =
    current.issueNumbers.length > 0 &&
    (!snapshot || current.issueNumbers.some((n) => !snapshot.issueNumbers.includes(n)));
  let next;
  if (hasExplicitBump || hasNewItems) {
    next = { batchNumber: current.batchNumber, issueNumbers: current.issueNumbers.slice() };
  } else if (snapshot && Array.isArray(snapshot.issueNumbers) && snapshot.issueNumbers.length > 0) {
    next = {
      batchNumber: snapshot.batchNumber ?? null,
      issueNumbers: snapshot.issueNumbers.slice(),
    };
  } else {
    next = { batchNumber: current.batchNumber, issueNumbers: current.issueNumbers.slice() };
  }
  if (next.issueNumbers.length > 0) writeBatchSnapshot(projectId, next);
  return next;
}
const BATCH_PROGRESS_TTL_MS = 10000;

function parseActiveBatch(queueText) {
  if (typeof queueText !== "string" || !queueText) {
    return { batchNumber: null, issueNumbers: [] };
  }
  // Pull just the Active Batch section so a stray `#123` in Backlog
  // or Done doesn't leak into the active list.
  const m = queueText.match(/##\s+Active Batch[\s\S]*?(?=\n##\s|$)/i);
  if (!m) return { batchNumber: null, issueNumbers: [] };
  const section = m[0];
  const batchMatch = section.match(/\*\*Batch:\*\*\s*(\d+)/i) || section.match(/Batch:\s*(\d+)/i);
  const batchNumber = batchMatch ? parseInt(batchMatch[1], 10) : null;
  // Only collect issue numbers from lines that look like list-item
  // entries — i.e. lines whose first content token is either `#N`
  // or `[#N]` after an optional list marker, and optionally after
  // a GitHub-flavored markdown checkbox token `[ ]` / `[x]` / `[X]`.
  // This rejects prose like "Tracking umbrella: #293", "next after
  // #294 merged", and similar dependency / commentary references
  // that t2a flagged on realproject7/dropcast's queue.
  //
  // Accepted line shapes:
  //   - #295 sub-A heartbeat
  //   * #295 sub-A heartbeat
  //   1. #295 sub-A heartbeat
  //   #295 sub-A heartbeat
  //   - [#295] sub-A heartbeat
  //   [#295] sub-A heartbeat
  //   - [ ] #295 sub-A heartbeat      (#342/quadwork#341: GFM checkbox)
  //   - [x] #295 sub-A heartbeat      (checked)
  //   - [X] #295 sub-A heartbeat      (checked, uppercase)
  //
  // Rejected:
  //   Tracking umbrella: #293
  //   Assigned next after #294 merged.
  //   See #295 for context.
  //
  // The previous regex permitted an optional `[` *immediately*
  // before `#`, which happened to match `[#295]` but not `[ ] #295`
  // (a space between `[` and `#`), so Head-generated queues that
  // used GFM checkbox syntax produced zero issue numbers and the
  // Current Batch panel showed empty. #341 adds an explicit optional
  // checkbox token after the list marker.
  const ITEM_LINE_RE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\[[ xX]\]\s+)?\[?#(\d{1,6})\]?\b/;
  const seen = new Set();
  const issueNumbers = [];
  for (const line of section.split("\n")) {
    const lineMatch = line.match(ITEM_LINE_RE);
    if (!lineMatch) continue;
    const n = parseInt(lineMatch[1], 10);
    if (!seen.has(n)) {
      seen.add(n);
      issueNumbers.push(n);
    }
  }
  return { batchNumber, issueNumbers };
}

// #416 / quadwork#299: async variant used by the parallelized batch
// progress fetcher. Wraps node's execFile in a promise.
//
// THROWS on subprocess failure (non-zero exit, timeout, JSON parse,
// network) so progressForItemAsync can decide which subset of
// failures should bubble up to the Promise.allSettled "fetch failed"
// row vs. which should fall through to a softer state. The previous
// catch-all-and-return-null contract collapsed real subprocess
// errors into the "not found" branch, making the new failure-row
// fallback unreachable for genuine command failures (t2a review).
async function ghJsonExecAsync(args) {
  const { stdout } = await _execFileAsync("gh", args, { encoding: "utf-8", timeout: 10000 });
  return JSON.parse(stdout);
}

// #350: pure helper for the "no linked PR" branch of
// progressForItemAsync. Takes the issue JSON (shape: { number,
// title, state, url, ... }) and returns the batch-progress row
// for an item that has no closedByPullRequestsReferences. Exported
// from module.exports below for unit tests — no other callers.
function buildNoPrRow(issue) {
  if (issue && issue.state === "CLOSED") {
    return {
      issue_number: issue.number,
      title: issue.title,
      url: issue.url,
      status: "closed",
      progress: 100,
      label: "Closed (no PR) ✓",
    };
  }
  return {
    issue_number: issue.number,
    title: issue.title,
    url: issue.url,
    status: "queued",
    progress: 0,
    label: "Issue · queued",
  };
}

async function progressForItemAsync(repo, issueNumber) {
  // Pull issue state + linked PRs in one call. closedByPullRequestsReferences
  // is gh's serializer for the GraphQL `closedByPullRequestsReferences`
  // edge — only present when a PR with `Fixes #N` / `Closes #N`
  // (or the link UI) targets the issue.
  // Issue fetch is the load-bearing call — if gh can't read the
  // issue at all (404, network, auth, timeout) we can't compute a
  // meaningful progress row. Let the rejection propagate to the
  // route's Promise.allSettled so the operator sees a single
  // "fetch failed" row instead of a misleading "queued" entry.
  const issue = await ghJsonExecAsync([
    "issue",
    "view",
    String(issueNumber),
    "-R",
    repo,
    "--json",
    "number,title,state,url,closedByPullRequestsReferences",
  ]);
  const linked = Array.isArray(issue.closedByPullRequestsReferences)
    ? issue.closedByPullRequestsReferences
    : [];
  // Pick the freshest linked PR (highest number) if there are multiple.
  const pr = linked.length > 0
    ? linked.slice().sort((a, b) => (b.number || 0) - (a.number || 0))[0]
    : null;
  // No linked PR. #350: before falling into the "queued" bucket,
  // honor the issue's own state — a CLOSED issue with no linked
  // PR is fully done (superseded, not planned, runbook-only, etc.)
  // and should render at 100% with a ✓ label instead of a
  // misleading "0% · queued" row. Only truly OPEN issues with no
  // linked PR are still queued.
  if (!pr) {
    return buildNoPrRow(issue);
  }
  // Re-fetch the PR to get reviewDecision + reviews + state, since
  // the issue's closedByPullRequestsReferences edge only carries
  // number/state/url. The PR fetch is intentionally soft: if gh
  // glitches on this single call we still know the PR exists (we
  // got the link from the issue) and can render a partial
  // "in_review" row, which is more useful than dropping the whole
  // item to "fetch failed". A persistent failure here will still
  // surface on the next cache miss because the issue fetch above
  // is the load-bearing one that controls the per-item rejection.
  let prData = null;
  try {
    prData = await ghJsonExecAsync([
      "pr",
      "view",
      String(pr.number),
      "-R",
      repo,
      "--json",
      "number,state,url,reviewDecision,reviews",
    ]);
  } catch {
    // soft fall-through to the in_review row below
  }
  if (!prData) {
    return {
      issue_number: issue.number,
      title: issue.title,
      url: pr.url || issue.url,
      pr_number: pr.number,
      status: "in_review",
      progress: 20,
      label: `PR #${pr.number} · waiting on review`,
    };
  }
  const merged = prData.state === "MERGED" && issue.state === "CLOSED";
  if (merged) {
    return {
      issue_number: issue.number,
      title: issue.title,
      url: prData.url || issue.url,
      pr_number: prData.number,
      status: "merged",
      progress: 100,
      label: "Merged ✓",
    };
  }
  // Count distinct APPROVED reviews per author so a stale APPROVED
  // followed by REQUEST_CHANGES doesn't double-count. Sort by
  // submittedAt ascending first so the Map's "last write wins"
  // genuinely lands on the freshest review per author — gh's
  // current ordering is chronological in practice but undocumented,
  // so the explicit sort keeps us safe if that ever changes.
  const reviews = Array.isArray(prData.reviews) ? prData.reviews.slice() : [];
  reviews.sort((a, b) => {
    const ta = (a && a.submittedAt) ? Date.parse(a.submittedAt) : 0;
    const tb = (b && b.submittedAt) ? Date.parse(b.submittedAt) : 0;
    return ta - tb;
  });
  const latestByAuthor = new Map();
  for (const r of reviews) {
    const author = (r && r.author && r.author.login) || "";
    if (!author) continue;
    latestByAuthor.set(author, r.state);
  }
  let approvalCount = 0;
  for (const state of latestByAuthor.values()) {
    if (state === "APPROVED") approvalCount++;
  }
  if (approvalCount >= 2) {
    return {
      issue_number: issue.number,
      title: issue.title,
      url: prData.url || issue.url,
      pr_number: prData.number,
      status: "ready",
      progress: 80,
      label: `PR #${prData.number} · 2 approvals · ready`,
    };
  }
  if (approvalCount === 1) {
    return {
      issue_number: issue.number,
      title: issue.title,
      url: prData.url || issue.url,
      pr_number: prData.number,
      status: "approved1",
      progress: 50,
      label: `PR #${prData.number} · 1 approval`,
    };
  }
  return {
    issue_number: issue.number,
    title: issue.title,
    url: prData.url || issue.url,
    pr_number: prData.number,
    status: "in_review",
    progress: 20,
    label: `PR #${prData.number} · waiting on review`,
  };
}

function summarizeItems(items) {
  // #350: "closed" (CLOSED issue with no linked PR — superseded,
  // not planned, runbook-only) counts toward the complete tally
  // alongside "merged". The panel tally now reads "X/N complete"
  // when the batch mixes both kinds of completion, otherwise
  // "X/N merged" for the classic all-via-PR case.
  let merged = 0, closed = 0, ready = 0, approved1 = 0, inReview = 0, queued = 0;
  for (const it of items) {
    if (it.status === "merged") merged++;
    else if (it.status === "closed") closed++;
    else if (it.status === "ready") ready++;
    else if (it.status === "approved1") approved1++;
    else if (it.status === "in_review") inReview++;
    else if (it.status === "queued") queued++;
  }
  const done = merged + closed;
  const doneLabel = closed > 0 ? "complete" : "merged";
  const parts = [`${done}/${items.length} ${doneLabel}`];
  if (ready > 0) parts.push(`${ready} ready to merge`);
  if (approved1 > 0) parts.push(`${approved1} needs 2nd approval`);
  if (inReview > 0) parts.push(`${inReview} in review`);
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(" · ");
}

router.get("/api/batch-active", (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  if (!getRepo(projectId)) return res.status(400).json({ error: "No repo configured for project" });
  const queuePath = path.join(CONFIG_DIR, projectId, "OVERNIGHT-QUEUE.md");
  let active = false;
  try {
    const text = fs.readFileSync(queuePath, "utf-8");
    const { issueNumbers } = parseActiveBatch(text);
    active = issueNumbers.length > 0;
  } catch {}
  return res.json({ active });
});

router.get("/api/batch-progress", async (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });

  const cached = _batchProgressCache.get(projectId);
  const batchTTL = adaptiveTTL(BATCH_PROGRESS_TTL_MS);
  if (cached && Date.now() - cached.ts < batchTTL) {
    return res.json(cached.data);
  }
  // #554: if critically rate-limited, serve stale cache instead of
  // firing N gh calls per batch item.
  if (isRateLimited() && cached) {
    return res.json({ ...cached.data, _stale: true, _rateLimited: true });
  }

  const repo = getRepo(projectId);
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });

  const queuePath = path.join(CONFIG_DIR, projectId, "OVERNIGHT-QUEUE.md");
  let queueText = "";
  let queueReadOk = false;
  try {
    queueText = fs.readFileSync(queuePath, "utf-8");
    queueReadOk = true;
  } catch {
    // Missing / unreadable file — pass queueReadOk=false so the
    // resolver bypasses the snapshot and returns the empty state
    // per #316's edge case.
  }

  // #334 / quadwork#334: validate the on-disk snapshot against
  // GitHub before resolveDisplayedBatch can serve it. A snapshot
  // whose first issue 404s is almost certainly a leftover from a
  // prior project/repo that was purged; drop the file so the
  // resolver falls through to the live queue parse (which will
  // typically also be empty) instead of serving stale data
  // indefinitely. We only run the check on cache-miss paths (this
  // route already sits behind BATCH_PROGRESS_TTL_MS) and only
  // when we'd actually rely on the snapshot — i.e. the live queue
  // read succeeded, so the existing #316 bypass for unreadable
  // queue files keeps precedence.
  if (queueReadOk) {
    const existing = readBatchSnapshot(projectId);
    if (existing && Array.isArray(existing.issueNumbers) && existing.issueNumbers.length > 0) {
      const freshness = await checkBatchSnapshotFreshness(repo, existing);
      if (freshness === "gone") deleteBatchSnapshot(projectId);
      // "unknown" → leave the file alone; transient failure will
      // retry on the next cache miss.
    }
  }

  // #429 / quadwork#316: resolve the displayed batch through the
  // snapshot-aware helper so merged items stay visible after Head
  // moves them from Active Batch to Done, until a new batch starts.
  const { batchNumber, issueNumbers } = resolveDisplayedBatch(queueText, projectId, { queueReadOk });
  if (issueNumbers.length === 0) {
    const data = { batch_number: batchNumber, items: [], summary: "", complete: false };
    _batchProgressCache.set(projectId, { ts: Date.now(), data });
    return res.json(data);
  }

  // #703: Try batched GraphQL first — one query for all batch items.
  // Falls back to individual gh CLI calls (the #416 parallel approach)
  // if GraphQL fails.
  let items;
  const graphqlData = await fetchBatchProgressGraphQL(repo, issueNumbers);
  if (graphqlData) {
    items = issueNumbers.map((n) => {
      const issueNode = graphqlData[`issue${n}`];
      const row = issueNode ? graphqlIssueToProgressRow(issueNode) : null;
      return row || {
        issue_number: n,
        title: `#${n} (fetch failed)`,
        url: null,
        status: "unknown",
        progress: 0,
        label: "fetch failed",
      };
    });
  } else {
    // Fallback: #416 parallel individual gh CLI calls.
    const settled = await Promise.allSettled(
      issueNumbers.map((n) => progressForItemAsync(repo, n)),
    );
    items = settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        issue_number: issueNumbers[i],
        title: `#${issueNumbers[i]} (fetch failed)`,
        url: null,
        status: "unknown",
        progress: 0,
        label: "fetch failed",
      };
    });
  }
  const summary = summarizeItems(items);
  // #350: treat CLOSED-without-PR items as complete alongside merged
  // so batches that mix runbook/superseded closes with real PRs
  // still flip to the COMPLETE state once everything is done.
  const complete = items.length > 0 && items.every((it) => it.status === "merged" || it.status === "closed");
  const data = { batch_number: batchNumber, items, summary, complete };
  _batchProgressCache.set(projectId, { ts: Date.now(), data });
  res.json(data);
});

// #445: Memory section (agent-memory butler integration) removed.

// ─── Setup ─────────────────────────────────────────────────────────────────

function exec(cmd, args, opts) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 30000, ...opts });
    return { ok: true, output: out.trim() };
  } catch (err) {
    return { ok: false, output: err.message };
  }
}

// ─── GitHub helpers for Setup Wizard ──────────────────────────────────────

// GitHub user info
router.get("/api/github/user", (_req, res) => {
  try {
    const out = execFileSync("gh", ["api", "user", "--jq", "{login: .login}"], { encoding: "utf-8", timeout: 10000 });
    res.json(JSON.parse(out));
  } catch {
    res.status(502).json({ error: "GitHub CLI not authenticated" });
  }
});

// GitHub orgs the authenticated user belongs to
router.get("/api/github/orgs", (_req, res) => {
  try {
    const out = execFileSync("gh", ["api", "user/orgs", "--jq", "[.[].login]"], { encoding: "utf-8", timeout: 10000 });
    const orgs = JSON.parse(out);
    res.json(Array.isArray(orgs) ? orgs : []);
  } catch {
    res.json([]);
  }
});

// GitHub repo list for an owner (only repos with push access)
router.get("/api/github/repos", (req, res) => {
  const owner = req.query.owner;
  if (!owner) return res.status(400).json({ error: "Missing owner" });
  try {
    const out = execFileSync("gh", ["repo", "list", String(owner), "--json", "name,description,isPrivate,viewerPermission", "--limit", "50"], { encoding: "utf-8", timeout: 15000 });
    const repos = JSON.parse(out);
    // Filter to repos with push access (ADMIN, MAINTAIN, WRITE)
    const pushAccess = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
    res.json(repos.filter((r) => pushAccess.has(r.viewerPermission)));
  } catch {
    res.json([]);
  }
});

// Auto-detect existing clone of a repo
router.get("/api/setup/detect-clone", (req, res) => {
  const repoName = req.query.repo; // "owner/repo"
  if (!repoName) return res.status(400).json({ error: "Missing repo" });
  const slug = String(repoName).split("/").pop();
  const home = os.homedir();
  const searchDirs = [
    path.join(home, "Projects"),
    path.join(home, "Developer"),
    path.join(home, "repos"),
    path.join(home, "code"),
    path.join(home, "src"),
    path.join(home, "workspace"),
    home,
  ];
  for (const dir of searchDirs) {
    const candidate = path.join(dir, slug);
    if (fs.existsSync(path.join(candidate, ".git"))) {
      return res.json({ found: true, path: candidate, suggested: path.join(searchDirs[0], slug) });
    }
  }
  // Not found — suggest a default location
  const defaultDir = fs.existsSync(searchDirs[0]) ? searchDirs[0] : home;
  return res.json({ found: false, path: null, suggested: path.join(defaultDir, slug) });
});

// Save reviewer token securely
router.post("/api/setup/save-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Missing token" });
  const tokenPath = path.join(os.homedir(), ".quadwork", "reviewer-token");
  const dir = path.dirname(tokenPath);
  ensureSecureDir(dir);
  writeSecureFile(tokenPath, token.trim() + "\n");
  try { fs.chmodSync(tokenPath, 0o600); } catch {}
  res.json({ ok: true, path: tokenPath });
});

// #212: report whether the reviewer GitHub token is configured.
// Never returns the token itself — just `exists` + the path so the
// Settings page can show "Configured" / "Not configured" without
// leaking the secret over the API.
router.get("/api/setup/reviewer-token-status", (_req, res) => {
  const tokenPath = path.join(os.homedir(), ".quadwork", "reviewer-token");
  res.json({ exists: fs.existsSync(tokenPath), path: tokenPath });
});

// ─── Setup Wizard ─────────────────────────────────────────────────────────

router.post("/api/setup", (req, res) => {
  const step = req.query.step;
  const body = req.body || {};

  switch (step) {
    case "verify-repo": {
      const repo = body.repo;
      if (!repo || !REPO_RE.test(repo)) return res.json({ ok: false, error: "Invalid repo format (use owner/repo)" });
      const result = exec("gh", ["repo", "view", repo, "--json", "name,owner,viewerPermission"]);
      if (!result.ok) return res.json({ ok: false, error: "Cannot access repo. Check gh auth and repo permissions." });
      try {
        const info = JSON.parse(result.output);
        const pushAccess = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
        if (!pushAccess.has(info.viewerPermission)) {
          return res.json({ ok: false, error: "You don't have push access to this repo. Agents need push access to create branches and PRs." });
        }
      } catch {}
      return res.json({ ok: true });
    }
    case "create-worktrees": {
      const workingDir = body.workingDir;
      if (!workingDir) return res.json({ ok: false, error: "Missing working directory" });
      if (!fs.existsSync(path.join(workingDir, ".git"))) {
        if (!fs.existsSync(workingDir)) ensureSecureDir(workingDir);
        if (!REPO_RE.test(body.repo)) return res.json({ ok: false, error: "Invalid repo" });
        const clone = exec("gh", ["repo", "clone", body.repo, workingDir]);
        if (!clone.ok) return res.json({ ok: false, error: `Clone failed: ${clone.output}` });
      }
      // Empty repos have no commits — git worktree add requires at least one.
      const headCheck = exec("git", ["rev-parse", "HEAD"], { cwd: workingDir });
      if (!headCheck.ok) {
        exec("git", ["commit", "--allow-empty", "-m", "Initial commit (created by QuadWork setup)"], { cwd: workingDir });
        const branchResult = exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: workingDir });
        const defaultBranch = branchResult.ok ? branchResult.output : "main";
        exec("git", ["push", "origin", defaultBranch], { cwd: workingDir });
      }
      // Sibling dirs: ../projectName-head/, ../projectName-re1/, etc. (matches CLI wizard)
      const projectName = path.basename(workingDir);
      const parentDir = path.dirname(workingDir);
      const agents = ["head", "re1", "re2", "dev"];
      const created = [];
      const errors = [];
      for (const agent of agents) {
        const wtDir = path.join(parentDir, `${projectName}-${agent}`);
        if (fs.existsSync(wtDir)) { created.push(`${agent} (exists)`); continue; }
        const branchName = `worktree-${agent}`;
        exec("git", ["branch", branchName, "HEAD"], { cwd: workingDir });
        const result = exec("git", ["worktree", "add", wtDir, branchName], { cwd: workingDir });
        if (result.ok) {
          created.push(agent);
        } else {
          // Fallback: detached worktree
          const result2 = exec("git", ["worktree", "add", "--detach", wtDir, "HEAD"], { cwd: workingDir });
          if (result2.ok) created.push(`${agent} (detached)`);
          else errors.push(`${agent}: ${result.output}`);
        }
      }
      // Pre-trust worktree directories for Claude Code agents (#599).
      // Running `claude -p` in a directory auto-trusts it for future sessions,
      // preventing the interactive "Do you trust this directory?" prompt.
      const agentBackends = body.backends || {};
      const claudeAgents = agents.filter((a) => (agentBackends[a] || "claude") === "claude");
      if (claudeAgents.length > 0) {
        const claudePath = exec("which", ["claude"]);
        if (claudePath.ok) {
          for (const agent of claudeAgents) {
            const wtDir = path.join(parentDir, `${projectName}-${agent}`);
            if (!fs.existsSync(wtDir)) continue;
            exec("claude", ["-p", "echo ok"], { cwd: wtDir, timeout: 15000, stdio: "pipe" });
          }
        }
      }
      return res.json({ ok: errors.length === 0, created, errors });
    }
    case "seed-files": {
      const workingDir = body.workingDir;
      if (!workingDir) return res.json({ ok: false, error: "Missing working directory" });
      // Use directory basename for sibling paths and template substitution (matches CLI)
      const dirName = path.basename(workingDir);
      const parentDir = path.dirname(workingDir);
      const reviewerUser = body.reviewerUser || "";
      const reviewerTokenPath = body.reviewerTokenPath || path.join(os.homedir(), ".quadwork", "reviewer-token");
      const agents = ["head", "re1", "re2", "dev"];
      const seeded = [];
      for (const agent of agents) {
        // Sibling dir layout (matches CLI wizard)
        const wtDir = path.join(parentDir, `${dirName}-${agent}`);
        if (!fs.existsSync(wtDir)) continue;

        // AGENTS.md — always (re)write from template so role definitions
        // stay in sync with templates/seeds/ on every project (re)creation.
        // Previously this was guarded by `!exists`, so if a worktree already
        // had any AGENTS.md (stale, hand-edited, or empty) it was preserved
        // forever and agents could launch with no/outdated role definition.
        const agentsMd = path.join(wtDir, "AGENTS.md");
        const seedSrc = path.join(TEMPLATES_DIR, "seeds", `${agent}.AGENTS.md`);
        if (!fs.existsSync(seedSrc)) {
          // Hard fail: missing seed means role is undefined. Better to surface
          // the error than silently write a generic stub.
          return res.json({
            ok: false,
            error: `Missing seed template: templates/seeds/${agent}.AGENTS.md`,
          });
        }
        let agentsContent = fs.readFileSync(seedSrc, "utf-8");
        agentsContent = agentsContent.replace(/\{\{reviewer_github_user\}\}/g, reviewerUser);
        agentsContent = agentsContent.replace(/\{\{reviewer_token_path\}\}/g, reviewerTokenPath);
        // Batch 25 / #205: substitute the per-project queue file path.
        agentsContent = agentsContent.replace(/\{\{project_name\}\}/g, dirName);
        fs.writeFileSync(agentsMd, agentsContent);
        seeded.push(`${agent}/AGENTS.md`);

        // CLAUDE.md — use template with placeholder substitution (matches CLI)
        const claudeMd = path.join(wtDir, "CLAUDE.md");
        if (!fs.existsSync(claudeMd)) {
          const claudeSrc = path.join(TEMPLATES_DIR, "CLAUDE.md");
          if (fs.existsSync(claudeSrc)) {
            let content = fs.readFileSync(claudeSrc, "utf-8");
            // CLI uses path.basename(workingDir) for {{project_name}}
            content = content.replace(/\{\{project_name\}\}/g, dirName);
            fs.writeFileSync(claudeMd, content);
          } else {
            fs.writeFileSync(claudeMd, `# ${dirName}\n\nBranch: task/<issue>-<slug>\nCommit: [#<issue>] Short description\nNever push to main.\n`);
          }
          seeded.push(`${agent}/CLAUDE.md`);
        }

        // DESIGN-GUIDE.md — universal design craft rules (#690)
        const designGuideSrc = path.join(TEMPLATES_DIR, "seeds", "DESIGN-GUIDE.md");
        const designGuideDst = path.join(wtDir, "DESIGN-GUIDE.md");
        if (fs.existsSync(designGuideSrc) && !fs.existsSync(designGuideDst)) {
          fs.copyFileSync(designGuideSrc, designGuideDst);
          seeded.push(`${agent}/DESIGN-GUIDE.md`);
        }

        // .gitignore — ensure token files are never committed
        const gitignorePath = path.join(wtDir, ".gitignore");
        const tokenIgnorePatterns = "reviewer-token\n*-token\n";
        if (!fs.existsSync(gitignorePath)) {
          fs.writeFileSync(gitignorePath, tokenIgnorePatterns);
          seeded.push(`${agent}/.gitignore`);
        } else {
          const existing = fs.readFileSync(gitignorePath, "utf-8");
          if (!existing.includes("*-token")) {
            fs.appendFileSync(gitignorePath, "\n" + tokenIgnorePatterns);
            seeded.push(`${agent}/.gitignore (updated)`);
          }
        }
      }
      return res.json({ ok: true, seeded });
    }
    case "add-config": {
      const { id, name, repo, workingDir, backends } = body;
      const autoApprove = body.auto_approve !== false; // default true
      // Use directory basename for sibling paths (matches CLI wizard)
      const dirName = path.basename(workingDir);
      const parentDir = path.dirname(workingDir);
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
      catch { cfg = { port: 8400, projects: [] }; }
      if (cfg.projects.some((p) => p.id === id)) {
        // Project already saved, but still (idempotently) seed the
        // OVERNIGHT-QUEUE.md in case a previous run failed to write
        // it or the operator deleted it. writeOvernightQueueFileSafe
        // below no-ops when the file is already present, so this
        // can't clobber Head/user edits.
        writeOvernightQueueFileSafe(id, cfg.projects.find((p) => p.id === id)?.name || id, cfg.projects.find((p) => p.id === id)?.repo || "");
        return res.json({ ok: true, message: "Project already in config" });
      }
      // Match CLI wizard agent structure: { cwd, command, auto_approve, mcp_inject }
      // #343: default Codex-backed agents to reasoning_effort="medium"
      // instead of the upstream xhigh/high default. high/xhigh is the
      // provider-side capacity-failure hot spot; medium is the
      // safe-default for fresh installs so new projects don't hit
      // "Selected model is at capacity" out of the box. Operators can
      // bump individual agents back up via the Agent Models widget.
      const agents = {};
      for (const agentId of ["head", "re1", "re2", "dev"]) {
        const cmd = (backends && backends[agentId]) || "claude";
        const cliBase = cmd.split("/").pop().split(" ")[0];
        const injectMode = cliBase === "codex" ? "proxy_flag" : cliBase === "gemini" ? "env" : "flag";
        agents[agentId] = {
          cwd: path.join(parentDir, `${dirName}-${agentId}`),
          command: cmd,
          auto_approve: autoApprove,
          mcp_inject: injectMode,
          ...(cliBase === "codex" ? { reasoning_effort: "medium" } : {}),
        };
      }
      cfg.projects.push({
        id, name, repo, working_dir: workingDir, agents,
        chat_mode: "file",
      });
      const dir = path.dirname(CONFIG_PATH);
      ensureSecureDir(dir);
      writeConfig(cfg);

      // Batch 25 / #204: seed the per-project OVERNIGHT-QUEUE.md at
      // ~/.quadwork/{id}/OVERNIGHT-QUEUE.md.
      writeOvernightQueueFileSafe(id, name || id, repo);

      return res.json({ ok: true });
    }
    default:
      return res.status(400).json({ error: "Unknown step" });
  }
});

// ─── Rename ────────────────────────────────────────────────────────────────

function replaceInFile(filePath, oldStr, newStr) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes(oldStr)) return false;
    fs.writeFileSync(filePath, content.replaceAll(oldStr, newStr));
    return true;
  } catch {
    return false;
  }
}

function replaceInFileRegex(filePath, oldStr, newStr) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf-8");
    const escaped = oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");
    if (!regex.test(content)) return false;
    fs.writeFileSync(filePath, content.replace(regex, newStr));
    return true;
  } catch {
    return false;
  }
}

router.post("/api/rename", (req, res) => {
  const { type, projectId, oldName, newName, agentId } = req.body;
  const cfg = readConfigFile();
  const project = cfg.projects?.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const changes = [];
  const workDir = project.working_dir || "";

  if (type === "project") {
    project.name = newName;
    changes.push("config.json");
    if (project.trigger_message && project.trigger_message.includes(oldName)) {
      project.trigger_message = project.trigger_message.replaceAll(oldName, newName);
      changes.push("trigger_message");
    }
    if (workDir) {
      const claudeMd = path.join(workDir, "CLAUDE.md");
      if (replaceInFile(claudeMd, oldName, newName)) changes.push("CLAUDE.md");
    }
  }

  if (type === "agent" && agentId) {
    const agent = project.agents?.[agentId];
    if (agent) {
      const oldDisplayName = oldName || agent.display_name || agentId.toUpperCase();
      agent.display_name = newName;
      changes.push("config.json");
      if (agent.agents_md && agent.agents_md.includes(oldDisplayName)) {
        agent.agents_md = agent.agents_md.replaceAll(oldDisplayName, newName);
        changes.push("agents_md");
      }
      if (project.trigger_message) {
        const oldMention = `@${oldDisplayName.toLowerCase()}`;
        const newMention = `@${newName.toLowerCase()}`;
        if (project.trigger_message.includes(oldMention)) {
          project.trigger_message = project.trigger_message.replaceAll(oldMention, newMention);
          changes.push("trigger_message");
        }
      }
      if (workDir) {
        const tomlPaths = [
          path.join(workDir, "agentchattr", "config.toml"),
          path.join(workDir, "..", "agentchattr", "config.toml"),
          path.join(workDir, "config.toml"),
        ];
        for (const tomlPath of tomlPaths) {
          if (replaceInFile(tomlPath, `label = "${oldDisplayName}"`, `label = "${newName}"`)) {
            changes.push("agentchattr/config.toml");
            break;
          }
        }
        const claudeMd = path.join(workDir, "CLAUDE.md");
        if (replaceInFileRegex(claudeMd, oldDisplayName, newName)) changes.push("CLAUDE.md");
      }
      if (agent.cwd) {
        const agentsMd = path.join(agent.cwd, "AGENTS.md");
        if (replaceInFile(agentsMd, oldDisplayName, newName)) changes.push("AGENTS.md");
      }
    }
  }

  writeConfigFile(cfg);

  // Sync triggers internally
  if (typeof req.app.get("syncTriggers") === "function") {
    req.app.get("syncTriggers")();
  }

  res.json({ ok: true, changes });
});

// ─── Telegram ──────────────────────────────────────────────────────────────

function readEnvToken(key) {
  try {
    const content = fs.readFileSync(ENV_PATH, "utf-8");
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

function writeEnvToken(key, value) {
  let content = "";
  try { content = fs.readFileSync(ENV_PATH, "utf-8"); } catch {}
  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) content = content.replace(regex, line);
  else content = content.trimEnd() + (content ? "\n" : "") + line + "\n";
  writeSecureFile(ENV_PATH, content);
}

function resolveToken(value) {
  if (value.startsWith("env:")) return readEnvToken(value.slice(4)) || "";
  return value;
}

function envKeyForProject(projectId) {
  return `TELEGRAM_BOT_TOKEN_${projectId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function getProjectTelegram(projectId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p) => p.id === projectId);
    if (!project?.telegram) return null;
    return {
      bot_token: resolveToken(project.telegram.bot_token || ""),
      chat_id: project.telegram.chat_id || "",
    };
  } catch {
    return null;
  }
}

router.get("/api/telegram", async (req, res) => {
  const projectId = req.query.project || "";
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  // #211: expose whether credentials are configured + the chat_id
  // and the bot's @username (fetched from Telegram's getMe, cached
  // on the project entry). Never returns the raw bot token.
  let configured = false;
  let chatId = "";
  let botUsername = "";
  let bridgeInstalled = false;
  let cfg = null;
  let project = null;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    project = cfg.projects?.find((p) => p.id === projectId) || null;
    if (project?.telegram?.bot_token && project?.telegram?.chat_id) {
      configured = true;
      chatId = project.telegram.chat_id;
      botUsername = project.telegram.bot_username || "";
    }
    bridgeInstalled = true;
  } catch {}
  if (configured && !botUsername && project?.telegram?.bot_token && cfg) {
    try {
      const resolved = resolveToken(project.telegram.bot_token);
      if (resolved) {
        const r = await fetch(`https://api.telegram.org/bot${resolved}/getMe`);
        const data = await r.json();
        if (data && data.ok && data.result && typeof data.result.username === "string") {
          botUsername = data.result.username;
          project.telegram.bot_username = botUsername;
          try { writeConfig(cfg); } catch {}
        }
      }
    } catch {}
  }
  const running = telegramBridge.isRunning(projectId);
  const lastError = running ? "" : (telegramBridge.getLastError(projectId) || "");
  res.json({
    running,
    configured,
    chat_id: chatId,
    bot_username: botUsername,
    bridge_installed: bridgeInstalled,
    last_error: lastError,
  });
});

router.post("/api/telegram", async (req, res) => {
  const action = req.query.action;
  const body = req.body || {};

  switch (action) {
    case "test": {
      const { bot_token, chat_id } = body;
      if (!bot_token || !chat_id) return res.json({ ok: false, error: "Missing bot_token or chat_id" });
      const resolved = resolveToken(bot_token);
      if (!resolved) return res.json({ ok: false, error: "Could not resolve bot token from environment" });
      try {
        const r = await fetch(`https://api.telegram.org/bot${resolved}/getChat?chat_id=${chat_id}`);
        const data = await r.json();
        return res.json({ ok: data.ok, error: data.ok ? undefined : data.description });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Connection failed" });
      }
    }
    case "install": {
      return res.json({ ok: true, patched_projects: [] });
    }
    case "start": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      if (telegramBridge.isRunning(projectId)) return res.json({ ok: true, running: true, message: "Already running" });
      const tg = getProjectTelegram(projectId);
      if (!tg || !tg.bot_token || !tg.chat_id) return res.json({ ok: false, error: "Save bot_token and chat_id in project settings first." });
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const qwPort = cfg.port || 8400;
        telegramBridge.start(projectId, tg.bot_token, tg.chat_id, qwPort);
        emitSystemMessage(projectId, "Telegram bridge connected");
        return res.json({ ok: true, running: true });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Start failed" });
      }
    }
    case "stop": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      try {
        telegramBridge.stop(projectId);
        emitSystemMessage(projectId, "Telegram bridge disconnected");
        return res.json({ ok: true, running: false });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Stop failed" });
      }
    }
    case "status":
      return res.json({ running: telegramBridge.isRunning(body.project_id || "") });
    case "save-token": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      const envKey = envKeyForProject(projectId);
      writeEnvToken(envKey, body.bot_token);
      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = JSON.parse(raw);
        const project = cfg.projects?.find((p) => p.id === projectId);
        if (project?.telegram) {
          project.telegram.bot_token = `env:${envKey}`;
          writeConfig(cfg);
        }
      } catch {}
      return res.json({ ok: true, env_key: envKey });
    }
    case "save-config": {
      // #211: atomic save of bot_token + chat_id for the per-project
      // Telegram Bridge widget. Unlike save-token (which requires
      // project.telegram to already exist), save-config creates the
      // telegram block on the fly for projects that haven't been
      // configured yet. The raw token is written to ~/.quadwork/.env
      // (0600) and replaced on the config entry with `env:KEY`.
      const projectId = body.project_id;
      const bot_token = typeof body.bot_token === "string" ? body.bot_token.trim() : "";
      const chat_id = typeof body.chat_id === "string" ? body.chat_id.trim() : "";
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      if (!bot_token || !chat_id) return res.json({ ok: false, error: "bot_token and chat_id are required" });
      const envKey = envKeyForProject(projectId);
      try { writeEnvToken(envKey, bot_token); }
      catch (err) { return res.json({ ok: false, error: `Could not write .env: ${err.message}` }); }
      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = JSON.parse(raw);
        const project = cfg.projects?.find((p) => p.id === projectId);
        if (!project) return res.json({ ok: false, error: "Unknown project" });
        project.telegram = {
          ...(project.telegram || {}),
          bot_token: `env:${envKey}`,
          chat_id,
          // Clear any cached bot_username — the next GET /api/telegram
          // will re-fetch it from Telegram's getMe for the new token.
          bot_username: "",
        };
        writeConfig(cfg);
        return res.json({ ok: true, env_key: envKey });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Config write failed" });
      }
    }
    default:
      return res.status(400).json({ error: "Unknown action" });
  }
});

// --- Discord Bridge ---

function discordEnvKeyForProject(projectId) {
  return `DISCORD_BOT_TOKEN_${projectId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function getProjectDiscord(projectId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p) => p.id === projectId);
    if (!project?.discord) return null;
    return {
      bot_token: resolveToken(project.discord.bot_token || ""),
      channel_id: project.discord.channel_id || "",
    };
  } catch {
    return null;
  }
}

router.get("/api/discord", async (req, res) => {
  const projectId = req.query.project || "";
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  let configured = false;
  let channelId = "";
  let botUsername = "";
  let bridgeInstalled = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p) => p.id === projectId) || null;
    if (project?.discord?.bot_token && project?.discord?.channel_id) {
      configured = true;
      channelId = project.discord.channel_id;
      botUsername = project.discord.bot_username || "";
    }
    bridgeInstalled = true;
    if (configured && !botUsername && project?.discord?.bot_token && cfg) {
      try {
        const resolved = resolveToken(project.discord.bot_token);
        if (resolved) {
          const r = await fetch("https://discord.com/api/v10/users/@me", {
            headers: { Authorization: `Bot ${resolved}` },
          });
          const data = await r.json();
          if (r.ok && data.username) {
            botUsername = data.username;
            project.discord.bot_username = botUsername;
            try { writeConfig(cfg); } catch {}
          }
        }
      } catch {}
    }
  } catch {}
  const running = discordBridge.isRunning(projectId);
  const lastError = running ? "" : (discordBridge.getLastError(projectId) || "");
  res.json({
    running,
    configured,
    channel_id: channelId,
    bot_username: botUsername,
    bridge_installed: bridgeInstalled,
    last_error: lastError,
  });
});

router.post("/api/discord", async (req, res) => {
  const action = req.query.action;
  const body = req.body || {};

  switch (action) {
    case "test": {
      const { bot_token } = body;
      if (!bot_token) return res.json({ ok: false, error: "Missing bot_token" });
      const resolved = resolveToken(bot_token);
      if (!resolved) return res.json({ ok: false, error: "Could not resolve bot token from environment" });
      try {
        const r = await fetch(`https://discord.com/api/v10/users/@me`, {
          headers: { Authorization: `Bot ${resolved}` },
        });
        const data = await r.json();
        if (r.ok && data.username) {
          return res.json({ ok: true, username: data.username, discriminator: data.discriminator || "" });
        }
        return res.json({ ok: false, error: data.message || `Discord API returned ${r.status}` });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Connection failed" });
      }
    }
    case "install": {
      return res.json({ ok: true, patched_projects: [] });
    }
    case "start": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      if (discordBridge.isRunning(projectId)) return res.json({ ok: true, running: true, message: "Already running" });
      const dc = getProjectDiscord(projectId);
      if (!dc || !dc.bot_token || !dc.channel_id) return res.json({ ok: false, error: "Save bot_token and channel_id in project settings first." });
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const qwPort = cfg.port || 8400;
        await discordBridge.start(projectId, dc.bot_token, dc.channel_id, qwPort);
        emitSystemMessage(projectId, "Discord bridge connected");
        return res.json({ ok: true, running: true });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Start failed" });
      }
    }
    case "stop": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      try {
        discordBridge.stop(projectId);
        emitSystemMessage(projectId, "Discord bridge disconnected");
        return res.json({ ok: true, running: false });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Stop failed" });
      }
    }
    case "status":
      return res.json({ running: discordBridge.isRunning(body.project_id || "") });
    case "save-config": {
      const projectId = body.project_id;
      const bot_token = typeof body.bot_token === "string" ? body.bot_token.trim() : "";
      const channel_id = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      if (!bot_token || !channel_id) return res.json({ ok: false, error: "bot_token and channel_id are required" });
      const envKey = discordEnvKeyForProject(projectId);
      try { writeEnvToken(envKey, bot_token); }
      catch (err) { return res.json({ ok: false, error: `Could not write .env: ${err.message}` }); }
      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = JSON.parse(raw);
        const project = cfg.projects?.find((p) => p.id === projectId);
        if (!project) return res.json({ ok: false, error: "Unknown project" });
        project.discord = {
          ...(project.discord || {}),
          bot_token: `env:${envKey}`,
          channel_id,
          bot_username: "",
        };
        writeConfig(cfg);
        return res.json({ ok: true, env_key: envKey });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Config write failed" });
      }
    }
    default:
      return res.status(400).json({ error: "Unknown action" });
  }
});

// #343: per-agent model + reasoning-effort settings endpoint.
// GET returns the rows the dashboard Agent Models widget needs;
// PUT persists a single row back to config.json. Kept narrow on
// purpose — only `model` and `reasoning_effort` are writable
// here, and codex is the only backend that accepts
// reasoning_effort today. The launch-time wiring lives in
// server/index.js buildAgentArgs; this endpoint is purely
// config storage.
const ALLOWED_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

router.get("/api/project/:projectId/agent-models", (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p) => p.id === req.params.projectId);
    if (!project) return res.status(404).json({ error: "Unknown project" });
    const rows = ["head", "re1", "re2", "dev"].map((agentId) => {
      const a = project.agents?.[agentId] || {};
      const command = a.command || "claude";
      const cliBase = command.split("/").pop().split(" ")[0];
      return {
        agent_id: agentId,
        backend: cliBase,
        model: a.model || "",
        reasoning_effort: a.reasoning_effort || "",
        reasoning_supported: cliBase === "codex",
      };
    });
    return res.json({ agents: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message || "read failed" });
  }
});

router.put("/api/project/:projectId/agent-models/:agentId", (req, res) => {
  const { projectId, agentId } = req.params;
  if (!["head", "re1", "re2", "dev"].includes(agentId)) {
    return res.json({ ok: false, error: "Unknown agent" });
  }
  const body = req.body || {};
  // Accept empty string as "clear override → fall back to CLI default".
  const model = typeof body.model === "string" ? body.model.trim() : undefined;
  const reasoning = typeof body.reasoning_effort === "string" ? body.reasoning_effort.trim() : undefined;
  if (reasoning && reasoning !== "" && !ALLOWED_REASONING_EFFORTS.has(reasoning)) {
    return res.json({ ok: false, error: `Invalid reasoning_effort: ${reasoning}` });
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const project = cfg.projects?.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ ok: false, error: "Unknown project" });
    if (!project.agents) project.agents = {};
    const a = project.agents[agentId] || {};
    if (model !== undefined) {
      if (model === "") delete a.model;
      else a.model = model;
    }
    if (reasoning !== undefined) {
      if (reasoning === "") delete a.reasoning_effort;
      else a.reasoning_effort = reasoning;
    }
    project.agents[agentId] = a;
    writeConfig(cfg);
    return res.json({ ok: true, agent: { agent_id: agentId, model: a.model || "", reasoning_effort: a.reasoning_effort || "" } });
  } catch (err) {
    return res.json({ ok: false, error: err.message || "write failed" });
  }
});

// #554: start rate-limit polling as soon as routes are loaded.
startRateLimitPolling();
// #703: start batched GraphQL polling for dashboard data.
startGraphQLPolling();

module.exports = router;
// #341: export parseActiveBatch for unit tests. No production callers
// outside this file; the export is strictly for the node:assert
// script at server/routes.parseActiveBatch.test.js.
module.exports.parseActiveBatch = parseActiveBatch;
// #350: same pattern — expose the no-linked-PR row builder and
// summarizeItems for the batch-progress fixture test.
module.exports.buildNoPrRow = buildNoPrRow;
module.exports.summarizeItems = summarizeItems;
// #693: expose normalizeMentions for unit tests
module.exports.normalizeMentions = normalizeMentions;
// #714: expose for file-chat integration
module.exports.getProjectChatMode = getProjectChatMode;
// #730: PTY dispatch callback setter
module.exports.setPtyDispatchCallback = setPtyDispatchCallback;
