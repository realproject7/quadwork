/**
 * Migrated Next.js API routes — now served directly from Express.
 * Routes: config, chat, projects, memory, setup, rename, github/issues, github/prs, telegram
 */
const express = require("express");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const router = express.Router();

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const ENV_PATH = path.join(CONFIG_DIR, ".env");
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

const DEFAULT_CONFIG = {
  port: 8400,
  agentchattr_url: "http://127.0.0.1:8300",
  agentchattr_dir: path.join(os.homedir(), ".quadwork", "agentchattr"),
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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

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
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(body, null, 2));
    // Trigger sync is handled internally since we're in the same process now
    if (typeof req.app.get("syncTriggers") === "function") {
      req.app.get("syncTriggers")();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to write config", detail: err.message });
  }
});

// ─── Chat (AgentChattr proxy) ──────────────────────────────────────────────

const { resolveProjectChattr, sanitizeOperatorName } = require("./config");
const { installAgentChattr, findAgentChattr } = require("./install-agentchattr");

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
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    let content = fs.readFileSync(tpl, "utf-8");
    content = content.replace(/\{\{project_name\}\}/g, projectName || projectId || "");
    content = content.replace(/\{\{repo\}\}/g, repo || "");
    fs.writeFileSync(queuePath, content);
  } catch { /* non-fatal */ }
}

function getChattrConfig(projectId) {
  const resolved = resolveProjectChattr(projectId);
  return { url: resolved.url, token: resolved.token };
}

function chatAuthHeaders(token) {
  if (!token) return {};
  return { "x-session-token": token };
}

router.get("/api/chat", async (req, res) => {
  const apiPath = req.query.path || "/api/messages";
  const { url: base, token } = getChattrConfig(req.query.project);

  const fwd = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== "path") fwd.set(k, String(v));
  }
  if (token) fwd.set("token", token);

  const url = `${base}${apiPath}?${fwd.toString()}`;
  try {
    const r = await fetch(url, { headers: chatAuthHeaders(token) });
    if (!r.ok) return res.status(r.status).json({ error: `AgentChattr returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "AgentChattr unreachable", detail: err.message });
  }
});

// #225 sub-E: send chat messages from the dashboard via the
// AgentChattr WebSocket, not via /api/send.
//
// /api/send requires `Authorization: Bearer <registration_token>` and
// the token must resolve to a registered instance via
// `registry.resolve_token()`. The session_token we store on the
// project entry only authorizes browser/middleware traffic — it is
// NOT a registration token, so /api/send always 401s with
// "missing Authorization: Bearer <token>". The dashboard browser
// already sends through the WebSocket on `/ws?token=<session_token>`
// and the server accepts that path, so we mirror that exact flow
// from the express server: open a one-shot ws, push the message,
// wait briefly for ack, close.
const { WebSocket: NodeWebSocket } = require("ws");
const { syncChattrToken } = require("./config");

function sendViaWebSocket(baseUrl, sessionToken, message) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(sessionToken || "")}`;
    const ws = new NodeWebSocket(wsUrl);
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const giveUp = setTimeout(() => finish(new Error("websocket send timeout")), 4000);
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify({ type: "message", ...message }));
        // Server acks via broadcast, but the dashboard's POST /api/chat
        // contract only needs to know the message was accepted. Wait
        // ~250ms for the server to enqueue + close cleanly.
        setTimeout(() => { clearTimeout(giveUp); finish(null, { ok: true }); }, 250);
      } catch (err) { clearTimeout(giveUp); finish(err); }
    });
    ws.on("error", (err) => { clearTimeout(giveUp); finish(err); });
    ws.on("close", (code, reason) => {
      // Code 4003 = bad token (see app.py /ws handler). Surface as
      // 401 so the dashboard's chat error banner shows the right thing.
      if (!settled && code === 4003) {
        clearTimeout(giveUp);
        const msg = (reason && reason.toString()) || "forbidden: invalid session token";
        const e = new Error(msg);
        e.code = "EAGENTCHATTR_401";
        finish(e);
      }
    });
  });
}

/**
 * #403 / quadwork#274: send an arbitrary AC ws event (not a chat
 * message). Used for `update_settings` so the loop guard widget can
 * push the new max_agent_hops to the running AgentChattr without a
 * full restart. Mirrors sendViaWebSocket but lets the caller pick
 * the event type.
 */
function sendWsEvent(baseUrl, sessionToken, event) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(sessionToken || "")}`;
    const ws = new NodeWebSocket(wsUrl);
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const giveUp = setTimeout(() => finish(new Error("websocket send timeout")), 4000);
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify(event));
        setTimeout(() => { clearTimeout(giveUp); finish(null, { ok: true }); }, 250);
      } catch (err) { clearTimeout(giveUp); finish(err); }
    });
    ws.on("error", (err) => { clearTimeout(giveUp); finish(err); });
    ws.on("close", (code, reason) => {
      if (!settled && code === 4003) {
        clearTimeout(giveUp);
        const msg = (reason && reason.toString()) || "forbidden: invalid session token";
        const e = new Error(msg);
        e.code = "EAGENTCHATTR_401";
        finish(e);
      }
    });
  });
}

// #403 / quadwork#274: read/write the loop guard for a given project.
// Source of truth at rest is the project's config.toml [routing]
// max_agent_hops. The PUT also pushes the value to the running AC via
// `update_settings` so the change is live without a daemon restart.
// Resolve the per-project config.toml path through resolveProjectChattr
// so we honor `project.agentchattr_dir` (web wizard sets this; legacy
// imports can have arbitrary paths) and don't drift from the rest of
// the codebase that already goes through that helper.
function resolveProjectConfigToml(projectId) {
  const resolved = resolveProjectChattr(projectId);
  if (!resolved || !resolved.dir) return null;
  return path.join(resolved.dir, "config.toml");
}

router.get("/api/loop-guard", (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  const tomlPath = resolveProjectConfigToml(projectId);
  if (!tomlPath || !fs.existsSync(tomlPath)) return res.json({ value: 30, source: "default" });
  try {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const m = content.match(/^\s*max_agent_hops\s*=\s*(\d+)/m);
    const value = m ? parseInt(m[1], 10) : 30;
    res.json({ value, source: m ? "toml" : "default" });
  } catch (err) {
    res.status(500).json({ error: "Failed to read config.toml", detail: err.message });
  }
});

router.put("/api/loop-guard", async (req, res) => {
  const projectId = req.query.project || req.body?.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  const raw = req.body?.value;
  const value = typeof raw === "number" ? raw : parseInt(raw, 10);
  // AC's update_settings handler clamps to [1, 50]; mirror that
  // here so we don't write a value AC will silently rewrite.
  if (!Number.isInteger(value) || value < 4 || value > 50) {
    return res.status(400).json({ error: "value must be an integer between 4 and 50" });
  }

  // 1. Persist to config.toml so the next restart picks it up.
  const tomlPath = resolveProjectConfigToml(projectId);
  if (!tomlPath || !fs.existsSync(tomlPath)) {
    return res.status(404).json({ error: "config.toml not found for project" });
  }
  try {
    let content = fs.readFileSync(tomlPath, "utf-8");
    if (/^\s*max_agent_hops\s*=/m.test(content)) {
      content = content.replace(/^\s*max_agent_hops\s*=.*$/m, `max_agent_hops = ${value}`);
    } else if (/^\s*\[routing\]/m.test(content)) {
      // Section exists but the key doesn't — append the key on the
      // line right after the [routing] header to keep it scoped.
      content = content.replace(/^(\s*\[routing\]\s*\n)/m, `$1max_agent_hops = ${value}\n`);
    } else {
      const trailing = content.endsWith("\n") ? "" : "\n";
      content += `${trailing}\n[routing]\ndefault = "none"\nmax_agent_hops = ${value}\n`;
    }
    fs.writeFileSync(tomlPath, content);
  } catch (err) {
    return res.status(500).json({ error: "Failed to write config.toml", detail: err.message });
  }

  // 2. Best-effort push to the running AC so the change is live.
  // On stale-token (4003 → EAGENTCHATTR_401) recover the same way
  // /api/chat does (#230): re-sync the session token from AC and
  // retry once. Other failures stay non-fatal — the persisted value
  // still takes effect on next AC restart.
  let live = false;
  try {
    const { url: base, token: sessionToken } = getChattrConfig(projectId);
    if (base) {
      const event = { type: "update_settings", data: { max_agent_hops: value } };
      try {
        await sendWsEvent(base, sessionToken, event);
        live = true;
      } catch (err) {
        if (err && err.code === "EAGENTCHATTR_401") {
          console.warn(`[loop-guard] ws auth failed for ${projectId}, re-syncing session token and retrying...`);
          try { await syncChattrToken(projectId); }
          catch (syncErr) { console.warn(`[loop-guard] syncChattrToken failed: ${syncErr.message}`); }
          const { token: refreshed } = getChattrConfig(projectId);
          if (refreshed && refreshed !== sessionToken) {
            try {
              await sendWsEvent(base, refreshed, event);
              live = true;
            } catch (retryErr) {
              console.warn(`[loop-guard] retry after token resync failed: ${retryErr.message || retryErr}`);
            }
          }
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    console.warn(`[loop-guard] live update failed for ${projectId}: ${err.message || err}`);
  }

  res.json({ ok: true, value, live });
});

// #412 / quadwork#279: project history export + import.
//
// Export proxies AC's /api/messages for the project channel and
// wraps the array in a small metadata envelope so future imports
// can warn on project-id mismatch and so a future schema bump can
// be detected client-side.
//
// Import accepts the same envelope, validates the shape + size,
// and replays each message back into the project's AgentChattr
// instance via sendViaWebSocket — preserving the original sender
// field for cross-tool consistency. Originals' message IDs are NOT
// preserved (AC re-assigns on insert), which is a known v1 limit
// and matches the issue's "AgentChattr will tell us" note.

const PROJECT_HISTORY_VERSION = 1;
const PROJECT_HISTORY_MAX_BYTES = 10 * 1024 * 1024; // 10 MB cap per issue
const PROJECT_HISTORY_REPLAY_DELAY_MS = 25; // pace AC ws inserts

router.get("/api/project-history", async (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  const { url: base, token: sessionToken } = getChattrConfig(projectId);
  if (!base) return res.status(400).json({ error: "No AgentChattr configured for project" });
  try {
    // AC's /api/messages accepts a bearer token in the Authorization
    // header; the session token is what the chat panel already uses.
    const target = `${base}/api/messages?channel=general&limit=100000`;
    const r = await fetch(target, {
      headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
      // Cap the AC fetch at 30s so a hung daemon doesn't park the
      // export request indefinitely.
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(502).json({ error: `AgentChattr /api/messages returned ${r.status}`, detail: detail.slice(0, 200) });
    }
    const raw = await r.json();
    // AC returns either a bare array or { messages: [...] } depending
    // on version — handle both.
    const messages = Array.isArray(raw) ? raw : Array.isArray(raw && raw.messages) ? raw.messages : [];
    res.json({
      version: PROJECT_HISTORY_VERSION,
      project_id: projectId,
      exported_at: new Date().toISOString(),
      message_count: messages.length,
      messages,
    });
  } catch (err) {
    res.status(502).json({ error: "Project history export failed", detail: err.message || String(err) });
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
  if (body.project_id && body.project_id !== projectId && !body.allow_project_mismatch) {
    return res.status(409).json({
      error: `Project mismatch: file is from '${body.project_id}', target is '${projectId}'. Resend with allow_project_mismatch=true to override.`,
    });
  }

  const { url: base, token: sessionToken } = getChattrConfig(projectId);
  if (!base) return res.status(400).json({ error: "No AgentChattr configured for project" });

  // Replay each message via the existing ws send helper. Preserve
  // the original sender so the imported transcript still attributes
  // each line correctly. Pace the writes so AC's ws handler isn't
  // overloaded on a multi-thousand-message import.
  //
  // SECURITY NOTE: This deliberately bypasses /api/chat's #230/#288
  // sanitize-as-user lockdown — the imported sender field is sent
  // straight to AC's ws, so a crafted import file CAN post as
  // `head` / `dev` / etc. That's intentional: imports must round-
  // trip the original attribution to be useful (otherwise every
  // restored message would say `user` and the transcript would be
  // worthless). The trade-off is acceptable because the only entry
  // point is an authenticated dashboard operator picking a file by
  // hand and clicking through the project-mismatch confirm. Don't
  // expose this route from a less-trusted surface without revisiting.
  let imported = 0;
  let skipped = 0;
  const errors = [];
  for (const m of body.messages) {
    if (!m || typeof m !== "object" || typeof m.text !== "string" || !m.text) {
      skipped++;
      continue;
    }
    const msg = {
      text: m.text,
      channel: typeof m.channel === "string" && m.channel ? m.channel : "general",
      sender: typeof m.sender === "string" && m.sender ? m.sender : "user",
    };
    try {
      await sendViaWebSocket(base, sessionToken, msg);
      imported++;
    } catch (err) {
      errors.push(`#${m.id ?? "?"}: ${err.message || String(err)}`);
      // Stop on the first error to avoid spamming AC if its ws is down.
      if (errors.length > 5) break;
    }
    // Tiny delay between sends — AC's ws handler can keep up but
    // 10k messages back-to-back hit the recv buffer hard.
    if (PROJECT_HISTORY_REPLAY_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, PROJECT_HISTORY_REPLAY_DELAY_MS));
    }
  }
  res.json({ ok: errors.length === 0, imported, skipped, total: body.messages.length, errors });
});

router.post("/api/chat", async (req, res) => {
  const projectId = req.query.project || req.body.project;
  const { url: base, token: sessionToken } = getChattrConfig(projectId);
  if (!base) return res.status(400).json({ error: "Missing project" });

  // #230: ignore any client-supplied sender. /api/chat is the
  // dashboard's send path, so the message must always be attributed
  // to a server-controlled value. Forwarding `req.body.sender` would
  // let any caller hitting QuadWork's /api/chat impersonate an agent
  // identity (t1, t3, …) over the AgentChattr ws path, which the
  // old /api/send flow could not do.
  //
  // #405 / quadwork#278: read the operator's display name from the
  // server-side config file rather than hardcoding "user". The
  // sanitizer matches AC's registry name validator (1–32 alnum +
  // dash + underscore) so even a hand-edited config can't post a
  // value AC will reject (or impersonate an agent), and an empty /
  // missing value falls back to "user".
  let operatorSender = "user";
  try {
    const cfg = readConfigFile();
    operatorSender = sanitizeOperatorName(cfg.operator_name);
  } catch {
    // non-fatal — fall through to "user"
  }
  // #397 / quadwork#262: pass reply_to through to AgentChattr so the
  // dashboard's reply button mirrors AC's native threaded-reply
  // behavior. Only forward when it's a real positive integer — guards
  // against arbitrary client payloads.
  const replyToRaw = req.body?.reply_to;
  const replyTo = (typeof replyToRaw === "number" && Number.isInteger(replyToRaw) && replyToRaw > 0)
    ? replyToRaw
    : null;
  const message = {
    text: typeof req.body?.text === "string" ? req.body.text : "",
    channel: req.body?.channel || "general",
    sender: operatorSender,
    attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
    ...(replyTo !== null ? { reply_to: replyTo } : {}),
  };
  if (!message.text && message.attachments.length === 0) {
    return res.status(400).json({ error: "text or attachments required" });
  }

  const attemptSend = () => sendViaWebSocket(base, sessionToken, message);

  try {
    await attemptSend();
    return res.json({ ok: true });
  } catch (err) {
    // If the cached session_token is stale (AgentChattr regenerates
    // one on every restart) the ws closes with code 4003 — re-sync
    // the token from AgentChattr's HTML and retry once before giving
    // up. This is the actual fix for the "401 after restart" report
    // in #230 (the cache was stuck on an old token).
    if (err && err.code === "EAGENTCHATTR_401") {
      console.warn(`[chat] ws auth failed for project ${projectId}, re-syncing session token and retrying...`);
      try { await syncChattrToken(projectId); }
      catch (syncErr) { console.warn(`[chat] syncChattrToken failed: ${syncErr.message}`); }
      const { token: refreshed } = getChattrConfig(projectId);
      if (refreshed && refreshed !== sessionToken) {
        try {
          await sendViaWebSocket(base, refreshed, message);
          return res.json({ ok: true, resynced: true });
        } catch (retryErr) {
          console.warn(`[chat] retry after token resync failed: ${retryErr.message}`);
          return res.status(401).json({ error: "AgentChattr auth failed (token resync did not help)", detail: retryErr.message });
        }
      }
      return res.status(401).json({ error: "AgentChattr auth failed", detail: err.message });
    }
    console.warn(`[chat] send failed for project ${projectId}: ${err && err.message}`);
    return res.status(502).json({ error: "AgentChattr unreachable", detail: err && err.message });
  }
});

// ─── Projects (dashboard aggregation) ──────────────────────────────────────

function ghJson(args) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf-8", timeout: 15000 });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.get("/api/projects", async (req, res) => {
  const cfg = readConfigFile();

  // Fetch active sessions from our own in-memory state (only running PTYs)
  const activeSessions = req.app.get("activeSessions") || new Map();
  const activeProjectIds = new Set();
  for (const [, info] of activeSessions) {
    if (info.projectId && info.state === "running") activeProjectIds.add(info.projectId);
  }

  // Fetch chat messages from all projects (per-project AgentChattr instances)
  const chatMsgsByProject = {};
  const chatFetches = (cfg.projects || []).map(async (p) => {
    const { url: chattrUrl, token: chattrToken } = getChattrConfig(p.id);
    try {
      const headers = chattrToken ? { "x-session-token": chattrToken } : {};
      const tokenParam = chattrToken ? `&token=${encodeURIComponent(chattrToken)}` : "";
      const r = await fetch(`${chattrUrl}/api/messages?channel=general&limit=30${tokenParam}`, { headers });
      if (r.ok) {
        const data = await r.json();
        chatMsgsByProject[p.id] = Array.isArray(data) ? data : data.messages || [];
      }
    } catch {}
  });
  await Promise.allSettled(chatFetches);
  // Aggregate all project chat messages for the activity feed
  let chatMsgs = Object.values(chatMsgsByProject).flat();

  const eventKeywords = /\b(PR|merged|pushed|approved|opened|closed|review|commit)\b/i;
  const workflowMsgs = chatMsgs
    .filter((m) => eventKeywords.test(m.text) && m.sender !== "system")
    .slice(-10)
    .reverse();

  const numberToProject = {};
  const projectResults = (cfg.projects || []).map((p) => {
    let openPrs = 0;
    let lastActivity = null;

    if (REPO_RE.test(p.repo)) {
      const prs = ghJson(["pr", "list", "-R", p.repo, "--json", "number", "--limit", "100"]);
      openPrs = prs.length;

      const recentPrs = ghJson(["pr", "list", "-R", p.repo, "--state", "all", "--json", "updatedAt", "--limit", "1"]);
      lastActivity = recentPrs[0]?.updatedAt || null;

      const allPrs = ghJson(["pr", "list", "-R", p.repo, "--state", "all", "--json", "number", "--limit", "100"]);
      for (const pr of allPrs) numberToProject[pr.number] = p.name;
      const allIssues = ghJson(["issue", "list", "-R", p.repo, "--state", "all", "--json", "number", "--limit", "100"]);
      for (const issue of allIssues) numberToProject[issue.number] = p.name;
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
  });

  // Build activity feed
  const recentEvents = [];
  for (const m of workflowMsgs) {
    let projectName = (cfg.projects || []).find((p) => m.text.includes(p.repo) || m.text.includes(p.name))?.name;
    if (!projectName) {
      const numMatch = m.text.match(/#(\d+)/);
      if (numMatch) projectName = numberToProject[parseInt(numMatch[1], 10)];
    }
    if (!projectName) {
      const branchMatch = m.text.match(/task\/(\d+)/);
      if (branchMatch) projectName = numberToProject[parseInt(branchMatch[1], 10)];
    }
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

  res.json({ projects: projectResults, recentEvents });
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

router.get("/api/github/issues", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });

  try {
    const out = execFileSync(
      "gh",
      ["issue", "list", "-R", repo, "--json", "number,title,state,assignees,labels,createdAt,url", "--limit", "50"],
      { encoding: "utf-8", timeout: 15000 }
    );
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(502).json({ error: "gh issue list failed", detail: err.message });
  }
});

router.get("/api/github/prs", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });

  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "-R", repo, "--json", "number,title,state,author,assignees,reviewDecision,reviews,statusCheckRollup,url,createdAt", "--limit", "50"],
      { encoding: "utf-8", timeout: 15000 }
    );
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(502).json({ error: "gh pr list failed", detail: err.message });
  }
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
const RECENT_FETCH_LIMIT = 20;
const RECENT_DISPLAY_LIMIT = 5;

router.get("/api/github/closed-issues", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });
  try {
    const out = execFileSync(
      "gh",
      ["issue", "list", "-R", repo, "--state", "closed", "--json", "number,title,state,url,closedAt", "--limit", String(RECENT_FETCH_LIMIT)],
      { encoding: "utf-8", timeout: 15000 },
    );
    const items = JSON.parse(out);
    const sorted = Array.isArray(items)
      ? items
          .slice()
          .sort((a, b) => {
            const ta = a && a.closedAt ? Date.parse(a.closedAt) : 0;
            const tb = b && b.closedAt ? Date.parse(b.closedAt) : 0;
            return tb - ta;
          })
          .slice(0, RECENT_DISPLAY_LIMIT)
      : items;
    res.json(sorted);
  } catch (err) {
    res.status(502).json({ error: "gh issue list (closed) failed", detail: err.message });
  }
});

router.get("/api/github/merged-prs", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });
  try {
    // gh pr list with `--state merged` filters server-side so we
    // don't have to pull every closed PR and discard the un-merged
    // ones (closed-without-merge). Same fetch-wider-then-sort
    // strategy as closed-issues so the newest merge always wins.
    const out = execFileSync(
      "gh",
      ["pr", "list", "-R", repo, "--state", "merged", "--json", "number,title,state,url,mergedAt,author", "--limit", String(RECENT_FETCH_LIMIT)],
      { encoding: "utf-8", timeout: 15000 },
    );
    const items = JSON.parse(out);
    const sorted = Array.isArray(items)
      ? items
          .slice()
          .sort((a, b) => {
            const ta = a && a.mergedAt ? Date.parse(a.mergedAt) : 0;
            const tb = b && b.mergedAt ? Date.parse(b.mergedAt) : 0;
            return tb - ta;
          })
          .slice(0, RECENT_DISPLAY_LIMIT)
      : items;
    res.json(sorted);
  } catch (err) {
    res.status(502).json({ error: "gh pr list (merged) failed", detail: err.message });
  }
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
//   queued    0%   issue exists, no linked PR
//   in_review 20%  PR open, 0 approvals
//   approved1 50%  PR open, 1 approval
//   ready     80%  PR open, 2+ approvals
//   merged   100%  PR merged AND issue closed
//
// Cached for 10s per project to avoid hammering gh on every poll.

const _batchProgressCache = new Map(); // projectId -> { ts, data }
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
  // or `[#N]` after an optional list marker. This rejects prose
  // like "Tracking umbrella: #293", "next after #294 merged", and
  // similar dependency / commentary references that t2a flagged on
  // realproject7/dropcast's queue.
  //
  // Accepted line shapes:
  //   - #295 sub-A heartbeat
  //   * #295 sub-A heartbeat
  //   1. #295 sub-A heartbeat
  //   #295 sub-A heartbeat
  //   - [#295] sub-A heartbeat
  //   [#295] sub-A heartbeat
  //
  // Rejected:
  //   Tracking umbrella: #293
  //   Assigned next after #294 merged.
  //   See #295 for context.
  const ITEM_LINE_RE = /^\s*(?:[-*]\s+|\d+\.\s+)?\[?#(\d{1,6})\]?\b/;
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

function ghJsonExec(args) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf-8", timeout: 10000 });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function progressForItem(repo, issueNumber) {
  // Pull issue state + linked PRs in one call. closedByPullRequestsReferences
  // is gh's serializer for the GraphQL `closedByPullRequestsReferences`
  // edge — only present when a PR with `Fixes #N` / `Closes #N`
  // (or the link UI) targets the issue.
  const issue = ghJsonExec([
    "issue",
    "view",
    String(issueNumber),
    "-R",
    repo,
    "--json",
    "number,title,state,url,closedByPullRequestsReferences",
  ]);
  if (!issue) {
    return {
      issue_number: issueNumber,
      title: `#${issueNumber} (not found)`,
      url: null,
      status: "unknown",
      progress: 0,
      label: "not found",
    };
  }
  const linked = Array.isArray(issue.closedByPullRequestsReferences)
    ? issue.closedByPullRequestsReferences
    : [];
  // Pick the freshest linked PR (highest number) if there are multiple.
  const pr = linked.length > 0
    ? linked.slice().sort((a, b) => (b.number || 0) - (a.number || 0))[0]
    : null;
  // No linked PR yet — queued.
  if (!pr) {
    return {
      issue_number: issue.number,
      title: issue.title,
      url: issue.url,
      status: "queued",
      progress: 0,
      label: "Issue · queued",
    };
  }
  // Re-fetch the PR to get reviewDecision + reviews + state, since
  // the issue's closedByPullRequestsReferences edge only carries
  // number/state/url.
  const prData = ghJsonExec([
    "pr",
    "view",
    String(pr.number),
    "-R",
    repo,
    "--json",
    "number,state,url,reviewDecision,reviews",
  ]);
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
  let merged = 0, ready = 0, approved1 = 0, inReview = 0, queued = 0;
  for (const it of items) {
    if (it.status === "merged") merged++;
    else if (it.status === "ready") ready++;
    else if (it.status === "approved1") approved1++;
    else if (it.status === "in_review") inReview++;
    else if (it.status === "queued") queued++;
  }
  const parts = [`${merged}/${items.length} merged`];
  if (ready > 0) parts.push(`${ready} ready to merge`);
  if (approved1 > 0) parts.push(`${approved1} needs 2nd approval`);
  if (inReview > 0) parts.push(`${inReview} in review`);
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(" · ");
}

router.get("/api/batch-progress", (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });

  const cached = _batchProgressCache.get(projectId);
  if (cached && Date.now() - cached.ts < BATCH_PROGRESS_TTL_MS) {
    return res.json(cached.data);
  }

  const repo = getRepo(projectId);
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });

  const queuePath = path.join(CONFIG_DIR, projectId, "OVERNIGHT-QUEUE.md");
  let queueText = "";
  try { queueText = fs.readFileSync(queuePath, "utf-8"); }
  catch { /* missing file → empty active batch */ }

  const { batchNumber, issueNumbers } = parseActiveBatch(queueText);
  if (issueNumbers.length === 0) {
    const data = { batch_number: batchNumber, items: [], summary: "", complete: false };
    _batchProgressCache.set(projectId, { ts: Date.now(), data });
    return res.json(data);
  }

  const items = issueNumbers.map((n) => progressForItem(repo, n));
  const summary = summarizeItems(items);
  const complete = items.length > 0 && items.every((it) => it.status === "merged");
  const data = { batch_number: batchNumber, items, summary, complete };
  _batchProgressCache.set(projectId, { ts: Date.now(), data });
  res.json(data);
});

// ─── Memory ────────────────────────────────────────────────────────────────

function getProject(projectId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return cfg.projects?.find((p) => p.id === projectId) || null;
  } catch {
    return null;
  }
}

function getMemoryPaths(project) {
  const workDir = project.working_dir || "";
  return {
    cardsDir: project.memory_cards_dir || path.join(workDir, "..", "agent-memory", "archive", "v2", "cards"),
    sharedMemoryPath: project.shared_memory_path || path.join(workDir, "..", "agent-memory", "central", "short-term", "agent-os.md"),
    butlerDir: project.butler_scripts_dir || path.join(workDir, "..", "agent-memory", "scripts"),
  };
}

function findMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findMdFiles(full));
    else if (entry.name.endsWith(".md")) results.push(full);
  }
  return results;
}

function parseFrontmatter(content) {
  const fm = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fm;
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (val.startsWith("[") && val.endsWith("]")) val = val.slice(1, -1).trim();
      fm[key] = val;
    }
  }
  return fm;
}

router.get("/api/memory", (req, res) => {
  const projectId = req.query.project || "";
  const action = req.query.action || "cards";
  const project = getProject(projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const paths = getMemoryPaths(project);

  if (action === "cards") {
    const search = req.query.search || "";
    try {
      const files = findMdFiles(paths.cardsDir);
      const cards = files.map((fullPath) => {
        const content = fs.readFileSync(fullPath, "utf-8");
        const fm = parseFrontmatter(content);
        const relPath = path.relative(paths.cardsDir, fullPath);
        const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
        const firstLine = body.split("\n")[0]?.replace(/^#\s*/, "").trim();
        return {
          file: relPath,
          title: firstLine || fm.id || path.basename(fullPath, ".md"),
          date: fm.at || "",
          agent: fm.by || "",
          tags: fm.tags || "",
          content: body,
        };
      });
      cards.sort((a, b) => b.date.localeCompare(a.date));
      if (search) {
        const q = search.toLowerCase();
        return res.json(cards.filter((c) =>
          c.title.toLowerCase().includes(q) || c.agent.toLowerCase().includes(q) || c.tags.toLowerCase().includes(q) || c.content.toLowerCase().includes(q)
        ));
      }
      return res.json(cards);
    } catch {
      return res.json([]);
    }
  }

  if (action === "status") {
    const agents = project.agents || {};
    const status = {};
    for (const [id, agent] of Object.entries(agents)) {
      const targetPath = path.join(agent.cwd || "", "shared-memory.md");
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        status[id] = { injected: true, lastModified: stat.mtime.toISOString() };
      } else {
        status[id] = { injected: false, lastModified: null };
      }
    }
    const sourceExists = fs.existsSync(paths.sharedMemoryPath);
    return res.json({ agents: status, sourceExists });
  }

  if (action === "shared-memory") {
    try {
      const content = fs.readFileSync(paths.sharedMemoryPath, "utf-8");
      return res.json({ content, path: paths.sharedMemoryPath });
    } catch {
      return res.json({ content: "", path: paths.sharedMemoryPath });
    }
  }

  if (action === "settings") {
    return res.json({
      memory_cards_dir: project.memory_cards_dir || "",
      shared_memory_path: project.shared_memory_path || "",
      butler_scripts_dir: project.butler_scripts_dir || "",
    });
  }

  res.status(400).json({ error: "Unknown action" });
});

router.post("/api/memory", (req, res) => {
  const projectId = req.query.project || "";
  const action = req.query.action || "";
  const project = getProject(projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const paths = getMemoryPaths(project);

  if (action === "butler") {
    const allowed = ["butler-scan.sh", "butler-consolidate.sh", "inject.sh"];
    const command = req.body.command;
    if (!allowed.includes(command)) return res.json({ ok: false, error: `Unknown command: ${command}` });
    const scriptPath = path.join(paths.butlerDir, command);
    if (!fs.existsSync(scriptPath)) return res.json({ ok: false, error: `Script not found: ${scriptPath}` });
    try {
      const output = execFileSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 30000,
        cwd: path.dirname(paths.butlerDir),
      });
      return res.json({ ok: true, output });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  }

  if (action === "save-memory") {
    try {
      const dir = path.dirname(paths.sharedMemoryPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(paths.sharedMemoryPath, req.body.content);
      return res.json({ ok: true });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  }

  if (action === "save-settings") {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      const proj = cfg.projects?.find((p) => p.id === projectId);
      if (!proj) return res.json({ ok: false, error: "Project not found" });
      const s = req.body;
      if (s.memory_cards_dir !== undefined) proj.memory_cards_dir = s.memory_cards_dir || undefined;
      if (s.shared_memory_path !== undefined) proj.shared_memory_path = s.shared_memory_path || undefined;
      if (s.butler_scripts_dir !== undefined) proj.butler_scripts_dir = s.butler_scripts_dir || undefined;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      return res.json({ ok: true });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  }

  res.status(400).json({ error: "Unknown action" });
});

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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tokenPath, token.trim() + "\n", { mode: 0o600 });
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
        if (!fs.existsSync(workingDir)) fs.mkdirSync(workingDir, { recursive: true });
        if (!REPO_RE.test(body.repo)) return res.json({ ok: false, error: "Invalid repo" });
        const clone = exec("gh", ["repo", "clone", body.repo, workingDir]);
        if (!clone.ok) return res.json({ ok: false, error: `Clone failed: ${clone.output}` });
      }
      // Sibling dirs: ../projectName-head/, ../projectName-reviewer1/, etc. (matches CLI wizard)
      const projectName = path.basename(workingDir);
      const parentDir = path.dirname(workingDir);
      const agents = ["head", "reviewer1", "reviewer2", "dev"];
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
      const agents = ["head", "reviewer1", "reviewer2", "dev"];
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
    case "agentchattr-config": {
      const workingDir = body.workingDir;
      if (!workingDir) return res.json({ ok: false, error: "Missing working directory" });
      const dirName = path.basename(workingDir);
      const displayName = body.projectName || dirName;
      const parentDir = path.dirname(workingDir);
      const backends = body.backends;

      // Phase 2D / #181: config.toml lives at the per-project AgentChattr
      // clone ROOT (~/.quadwork/{id}/agentchattr/), not inside the user's
      // project working_dir. AgentChattr's run.py loads ROOT/config.toml
      // and ignores --config, so the toml has to be at the same path the
      // clone lives at. Same path matches what writeQuadWorkConfig()
      // persists in agentchattr_dir (#182) and what the CLI wizard
      // writes (#184).
      //
      // We install the clone *here*, before writing config.toml. The
      // install must run first because installAgentChattr() refuses to
      // overwrite a non-empty directory it doesn't recognize — if we
      // mkdir + write config.toml first, the subsequent install in
      // add-config would see "unrelated content" and reject the dir,
      // breaking first-run web project creation (t2a's review of #195).
      const projectConfigDir = path.join(CONFIG_DIR, dirName, "agentchattr");
      if (!findAgentChattr(projectConfigDir)) {
        const installResult = installAgentChattr(projectConfigDir);
        if (!installResult) {
          const reason = installAgentChattr.lastError || "unknown error";
          return res.json({ ok: false, error: `AgentChattr install failed at ${projectConfigDir}: ${reason}` });
        }
      }
      const dataDir = path.join(projectConfigDir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      const tomlPath = path.join(projectConfigDir, "config.toml");

      // Resolve per-project ports: prefer explicit body params (from setup wizard),
      // then fall back to saved config, then defaults
      let chattrPort, mcp_http, mcp_sse;
      if (body.agentchattr_port) {
        chattrPort = String(body.agentchattr_port);
        mcp_http = body.mcp_http_port || 8200;
        mcp_sse = body.mcp_sse_port || 8201;
      } else {
        const projectChattr = resolveProjectChattr(dirName);
        chattrPort = new URL(projectChattr.url).port || "8300";
        mcp_http = projectChattr.mcp_http_port || 8200;
        mcp_sse = projectChattr.mcp_sse_port || 8201;
      }

      const agents = ["head", "reviewer1", "reviewer2", "dev"];
      const colors = ["#10a37f", "#22c55e", "#f59e0b", "#da7756"];
      const labels = ["Owner", "Reviewer", "Reviewer", "Builder"];

      // Read or generate token for this project
      const crypto = require("crypto");
      const savedCfg = readConfigFile();
      const savedProject = savedCfg.projects?.find((p) => p.id === dirName);
      const sessionToken = body.agentchattr_token || savedProject?.agentchattr_token || crypto.randomBytes(16).toString("hex");

      let content = `[meta]\nname = "${displayName}"\n\n`;
      content += `[server]\nport = ${chattrPort}\nhost = "127.0.0.1"\ndata_dir = "${dataDir}"\n`;
      if (sessionToken) content += `session_token = "${sessionToken}"\n`;
      content += `\n`;
      agents.forEach((agent, i) => {
        const wtDir = path.join(parentDir, `${dirName}-${agent}`);
        content += `[agents.${agent}]\ncommand = "${(backends && backends[agent]) || "claude"}"\ncwd = "${wtDir}"\ncolor = "${colors[i]}"\nlabel = "${agent.charAt(0).toUpperCase() + agent.slice(1)} ${labels[i]}"\nmcp_inject = "flag"\n\n`;
      });
      // #403 / quadwork#274: raise the loop guard from AC's default
      // of 4 to 30 so autonomous PR review cycles (head→dev→re1+re2→
      // dev→head, ~5 hops) don't fire mid-batch and force the
      // operator to type /continue. AC clamps to [1, 50] internally.
      content += `[routing]\ndefault = "none"\nmax_agent_hops = 30\n\n`;
      content += `[mcp]\nhttp_port = ${mcp_http}\nsse_port = ${mcp_sse}\n`;
      fs.writeFileSync(tomlPath, content);

      // Restart this project's AgentChattr instance (not global)
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const qwPort = cfg.port || 8400;
        fetch(`http://127.0.0.1:${qwPort}/api/agentchattr/${encodeURIComponent(dirName)}/restart`, { method: "POST" }).catch(() => {});
      } catch {}
      return res.json({ ok: true, path: tomlPath, agentchattr_token: sessionToken, agentchattr_port: chattrPort, mcp_http_port: mcp_http, mcp_sse_port: mcp_sse });
    }
    case "add-config": {
      const { id, name, repo, workingDir, backends } = body;
      const autoApprove = body.auto_approve !== false; // default true
      // Use directory basename for sibling paths (matches CLI wizard)
      const dirName = path.basename(workingDir);
      const parentDir = path.dirname(workingDir);
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
      catch { cfg = { port: 8400, agentchattr_url: "http://127.0.0.1:8300", agentchattr_dir: path.join(os.homedir(), ".quadwork", "agentchattr"), projects: [] }; }
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
      const agents = {};
      for (const agentId of ["head", "reviewer1", "reviewer2", "dev"]) {
        const cmd = (backends && backends[agentId]) || "claude";
        const cliBase = cmd.split("/").pop().split(" ")[0];
        const injectMode = cliBase === "codex" ? "proxy_flag" : cliBase === "gemini" ? "env" : "flag";
        agents[agentId] = {
          cwd: path.join(parentDir, `${dirName}-${agentId}`),
          command: cmd,
          auto_approve: autoApprove,
          mcp_inject: injectMode,
        };
      }
      // Use pre-assigned ports/token from agentchattr-config step if provided,
      // otherwise auto-assign (direct add-config without prior agentchattr-config)
      const crypto = require("crypto");
      let chattrPort = body.agentchattr_port;
      let mcp_http_port = body.mcp_http_port;
      let mcp_sse_port = body.mcp_sse_port;
      let agentchattr_token = body.agentchattr_token;
      if (!chattrPort) {
        const usedChattrPorts = new Set(cfg.projects.map((p) => {
          try { return parseInt(new URL(p.agentchattr_url).port, 10); } catch { return 0; }
        }).filter(Boolean));
        const usedMcpPorts = new Set(cfg.projects.flatMap((p) => [p.mcp_http_port, p.mcp_sse_port]).filter(Boolean));
        chattrPort = 8300;
        while (usedChattrPorts.has(chattrPort)) chattrPort++;
        mcp_http_port = 8200;
        while (usedMcpPorts.has(mcp_http_port)) mcp_http_port++;
        mcp_sse_port = mcp_http_port + 1;
        while (usedMcpPorts.has(mcp_sse_port)) mcp_sse_port++;
      }
      if (!agentchattr_token) agentchattr_token = crypto.randomBytes(16).toString("hex");

      // Phase 2D / #181: clone AgentChattr per-project before saving config.
      // The path here must match the one written into agentchattr_dir below
      // and the one agentchattr-config writes config.toml into.
      const perProjectDir = path.join(CONFIG_DIR, id, "agentchattr");
      if (!findAgentChattr(perProjectDir)) {
        const installResult = installAgentChattr(perProjectDir);
        if (!installResult) {
          const reason = installAgentChattr.lastError || "unknown error";
          return res.json({ ok: false, error: `AgentChattr install failed at ${perProjectDir}: ${reason}` });
        }
      }

      cfg.projects.push({
        id, name, repo, working_dir: workingDir, agents,
        agentchattr_url: `http://127.0.0.1:${chattrPort}`,
        agentchattr_token,
        mcp_http_port,
        mcp_sse_port,
        // Per-project AgentChattr clone path (Option B / #181).
        agentchattr_dir: perProjectDir,
      });
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

      // Batch 25 / #204: seed the per-project OVERNIGHT-QUEUE.md at
      // ~/.quadwork/{id}/OVERNIGHT-QUEUE.md.
      writeOvernightQueueFileSafe(id, name || id, repo);

      // Batch 28 / #392 / quadwork#252: auto-spawn the per-project
      // AgentChattr process. The CLI wizard's writeAgentChattrConfig
      // does this; the web wizard previously left the install dormant
      // until the user clicked Restart, so MCP fell through to a stale
      // instance on port 8300. Mirror the loopback-restart pattern
      // already used by the agentchattr-config branch above. Failures
      // are non-fatal — the dashboard's Restart button is still
      // available, and per the issue add-config must still return ok.
      try {
        const qwPort = cfg.port || 8400;
        fetch(
          `http://127.0.0.1:${qwPort}/api/agentchattr/${encodeURIComponent(id)}/restart`,
          { method: "POST" },
        )
          .then(async (r) => {
            // /restart reports spawn failures (e.g. port collision —
            // server/index.js:650-668) as HTTP 500, so a resolved
            // fetch is not the same thing as a successful spawn. Log
            // non-2xx responses with status and body so the operator
            // can see why the auto-spawn silently didn't take.
            if (!r.ok) {
              let detail = "";
              try { detail = (await r.text()).slice(0, 500); } catch {}
              console.warn(
                `[setup] auto-spawn AgentChattr for ${id} returned HTTP ${r.status}: ${detail}`,
              );
            }
          })
          .catch((err) => {
            console.warn(
              `[setup] auto-spawn AgentChattr for ${id} failed:`,
              err.message || err,
            );
          });
      } catch (err) {
        console.warn(`[setup] auto-spawn AgentChattr for ${id} skipped:`, err.message || err);
      }

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

const BRIDGE_DIR = path.join(CONFIG_DIR, "agentchattr-telegram");

function telegramPidFile(projectId) {
  return path.join(CONFIG_DIR, `telegram-bridge-${projectId}.pid`);
}

function telegramConfigToml(projectId) {
  return path.join(CONFIG_DIR, `telegram-${projectId}.toml`);
}

function isTelegramRunning(projectId) {
  const pf = telegramPidFile(projectId);
  if (!fs.existsSync(pf)) return false;
  const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    fs.unlinkSync(pf);
    return false;
  }
}

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
  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
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
      agentchattr_url: cfg.agentchattr_url || "http://127.0.0.1:8300",
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
    bridgeInstalled = fs.existsSync(path.join(BRIDGE_DIR, "telegram_bridge.py"));
  } catch {}
  // Lazy-resolve bot username via Telegram getMe the first time
  // after a token is saved. Cache it on the project entry so later
  // requests don't hit the network.
  if (configured && !botUsername && project?.telegram?.bot_token && cfg) {
    try {
      const resolved = resolveToken(project.telegram.bot_token);
      if (resolved) {
        const r = await fetch(`https://api.telegram.org/bot${resolved}/getMe`);
        const data = await r.json();
        if (data && data.ok && data.result && typeof data.result.username === "string") {
          botUsername = data.result.username;
          project.telegram.bot_username = botUsername;
          try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
        }
      }
    } catch { /* non-fatal — widget will just show no username */ }
  }
  res.json({
    running: isTelegramRunning(projectId),
    configured,
    chat_id: chatId,
    bot_username: botUsername,
    bridge_installed: bridgeInstalled,
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
      try {
        if (!fs.existsSync(BRIDGE_DIR)) {
          execFileSync("gh", ["repo", "clone", "realproject7/agentchattr-telegram", BRIDGE_DIR], { encoding: "utf-8", timeout: 30000 });
        }
        execFileSync("pip3", ["install", "-r", path.join(BRIDGE_DIR, "requirements.txt")], { encoding: "utf-8", timeout: 30000 });
        return res.json({ ok: true });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Install failed" });
      }
    }
    case "start": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      if (isTelegramRunning(projectId)) return res.json({ ok: true, running: true, message: "Already running" });
      const bridgeScript = path.join(BRIDGE_DIR, "telegram_bridge.py");
      if (!fs.existsSync(bridgeScript)) return res.json({ ok: false, error: "Bridge not installed. Click Install Bridge first." });
      const tg = getProjectTelegram(projectId);
      if (!tg || !tg.bot_token || !tg.chat_id) return res.json({ ok: false, error: "Save bot_token and chat_id in project settings first." });
      const tomlPath = telegramConfigToml(projectId);
      const tomlContent = `[telegram]\nbot_token = "${tg.bot_token}"\nchat_id = "${tg.chat_id}"\n\n[agentchattr]\nurl = "${tg.agentchattr_url}"\n`;
      fs.writeFileSync(tomlPath, tomlContent, { mode: 0o600 });
      fs.chmodSync(tomlPath, 0o600);
      try {
        const child = spawn("python3", [bridgeScript, "--config", tomlPath], { detached: true, stdio: "ignore" });
        child.unref();
        if (child.pid) fs.writeFileSync(telegramPidFile(projectId), String(child.pid));
        return res.json({ ok: true, running: true, pid: child.pid });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Start failed" });
      }
    }
    case "stop": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      try {
        const pf = telegramPidFile(projectId);
        if (fs.existsSync(pf)) {
          const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
          fs.unlinkSync(pf);
        }
        return res.json({ ok: true, running: false });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Stop failed" });
      }
    }
    case "status":
      return res.json({ running: isTelegramRunning(body.project_id || "") });
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
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
        return res.json({ ok: true, env_key: envKey });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Config write failed" });
      }
    }
    default:
      return res.status(400).json({ error: "Unknown action" });
  }
});

module.exports = router;
