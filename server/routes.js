/**
 * Migrated Next.js API routes — now served directly from Express.
 * Routes: config, chat, projects, memory, setup, rename, github/issues, github/prs, telegram
 */
const express = require("express");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const multer = require("multer");

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
  ensureSecureDir(dir);
  writeConfig(cfg);
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

// ─── Chat (AgentChattr proxy) ──────────────────────────────────────────────

const { resolveProjectChattr, sanitizeOperatorName, ensureSecureDir, writeSecureFile, writeConfig } = require("./config");
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
    ensureSecureDir(path.dirname(queuePath));
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
  const projectId = req.query.project;
  const apiPath = req.query.path || "/api/messages";
  const { url: base, token } = getChattrConfig(projectId);

  const buildUrl = (tok) => {
    const fwd = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k !== "path") fwd.set(k, String(v));
    }
    if (tok) fwd.set("token", tok);
    return `${base}${apiPath}?${fwd.toString()}`;
  };

  try {
    const r = await fetch(buildUrl(token), { headers: chatAuthHeaders(token) });
    // #448: on 401/403, re-sync the session token from AC and retry
    // once. The stored token may be stale after an AC restart.
    // #487: also retry on 5xx — a temporary AC outage (e.g. 502) may
    // precede a restart that regenerates the session token.
    if ((r.status === 401 || r.status === 403 || r.status >= 500) && projectId) {
      try { await syncChattrToken(projectId); } catch {}
      const { token: refreshed } = getChattrConfig(projectId);
      if (refreshed && refreshed !== token) {
        const retry = await fetch(buildUrl(refreshed), { headers: chatAuthHeaders(refreshed) });
        if (!retry.ok) return res.status(retry.status).json({ error: `AgentChattr returned ${retry.status}` });
        return res.json(await retry.json());
      }
    }
    if (!r.ok) return res.status(r.status).json({ error: `AgentChattr returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    // #487: fetch threw (ECONNREFUSED, DNS failure, etc.) — AC is
    // unreachable. Resync the token and retry once; AC may have
    // restarted with a new session token by the time the retry fires.
    if (projectId) {
      try { await syncChattrToken(projectId); } catch {}
      const { token: refreshed } = getChattrConfig(projectId);
      if (refreshed && refreshed !== token) {
        try {
          const retry = await fetch(buildUrl(refreshed), { headers: chatAuthHeaders(refreshed) });
          if (!retry.ok) return res.status(retry.status).json({ error: `AgentChattr returned ${retry.status}` });
          return res.json(await retry.json());
        } catch {}
      }
    }
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

// #236: wait for AgentChattr to echo our message back over the same ws
// connection before resolving, instead of fire-and-forgetting. AC's
// /ws handler does this on every connect:
//   1. Replays history as N `{type:"message", data: msg}` frames.
//   2. Sends one `{type:"status", data: …}` frame (broadcast_status).
//   3. Enters the receive loop and accepts our outgoing frame.
// After our `type:"message"` is processed, AC calls `store.add()`
// which broadcasts the stored record back to all clients (including
// us) as another `{type:"message", data: msg}`.
//
// To get a race-free ack we therefore:
//   A. Wait for the first `type:"status"` frame to confirm the
//      history replay is done — any `type:"message"` frame seen
//      BEFORE that is historical and must be ignored.
//   B. Only then send our message and record the highest message
//      id observed so far as a correlation baseline.
//   C. Accept the first post-send `type:"message"` whose payload
//      matches (sender, text, channel, reply_to) AND whose id is
//      strictly greater than the baseline (AC ids are monotonically
//      increasing from store.add). This eliminates the risk a
//      reviewer flagged on #382 round 1: a historical identical
//      message from <1.5s ago could have satisfied the old
//      heuristic matcher.
// On timeout / early close / 4003, we surface a proper error so the
// /api/chat handler can return a 5xx (or 401) instead of a silent
// {ok:true}.
function sendViaWebSocket(baseUrl, sessionToken, message) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(sessionToken || "")}`;
    const ws = new NodeWebSocket(wsUrl);
    let settled = false;
    let historyFlushed = false;
    let sent = false;
    let maxIdAtSend = -Infinity;
    let maxHistoryId = -Infinity;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const giveUp = setTimeout(() => finish(new Error("websocket send timeout")), 4000);
    const doSend = () => {
      if (sent || settled) return;
      try {
        maxIdAtSend = maxHistoryId;
        ws.send(JSON.stringify({ type: "message", ...message }));
        sent = true;
      } catch (err) { clearTimeout(giveUp); finish(err); }
    };
    ws.on("open", () => {
      // Do NOT send yet. Wait for the status frame that marks the
      // end of history replay so we have a clean correlation
      // baseline. A safety timer covers the (unlikely) case of an
      // AC build that doesn't emit status on connect — after 750ms
      // we fall back to sending anyway, using whatever max id we
      // collected from history so far as the baseline.
      setTimeout(() => {
        if (!historyFlushed) {
          historyFlushed = true;
          doSend();
        }
      }, 750);
    });
    ws.on("message", (raw) => {
      if (settled) return;
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (!frame || !frame.type) return;
      if (frame.type === "status" && !historyFlushed) {
        historyFlushed = true;
        doSend();
        return;
      }
      if (frame.type !== "message" || !frame.data) return;
      const d = frame.data;
      // Track the highest message id we have observed, whether from
      // history replay or from other live broadcasts. Used as the
      // baseline for the post-send correlation check.
      if (typeof d.id === "number" && d.id > maxHistoryId) {
        maxHistoryId = d.id;
      }
      if (!sent) return; // anything before our send is history
      if (typeof d.id !== "number" || d.id <= maxIdAtSend) return;
      if (d.sender !== message.sender) return;
      if (d.text !== message.text) return;
      if ((d.channel || "general") !== (message.channel || "general")) return;
      const wantReply = message.reply_to ?? null;
      const gotReply = d.reply_to ?? null;
      if (wantReply !== gotReply) return;
      clearTimeout(giveUp);
      finish(null, { ok: true, message: d });
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
        return;
      }
      // Any other premature close after we sent but before we saw
      // the echo is an error — the old code path would have claimed
      // success, silently swallowing a server-side reject.
      if (!settled) {
        clearTimeout(giveUp);
        const r = (reason && reason.toString()) || "";
        finish(new Error(`websocket closed before ack (code=${code}${r ? ", reason=" + r : ""})`));
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
  // Capture the previous value before rewriting so we can decide
  // whether the /continue auto-resume should fire (only when the
  // operator is RAISING the limit — lowering it means they want
  // the runaway loop to stay paused).
  let previousValue = null;
  try {
    const previousContent = fs.readFileSync(tomlPath, "utf-8");
    const prevMatch = previousContent.match(/^\s*max_agent_hops\s*=\s*(\d+)/m);
    if (prevMatch) previousValue = parseInt(prevMatch[1], 10);
  } catch {
    // fall through — previousValue stays null, auto-resume will skip
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
    writeSecureFile(tomlPath, content);
  } catch (err) {
    return res.status(500).json({ error: "Failed to write config.toml", detail: err.message });
  }

  // 2. Best-effort push to the running AC so the change is live.
  // On stale-token (4003 → EAGENTCHATTR_401) recover the same way
  // /api/chat does (#230): re-sync the session token from AC and
  // retry once. Other failures stay non-fatal — the persisted value
  // still takes effect on next AC restart.
  //
  // #417 / quadwork#309: the update_settings ws event correctly
  // updates router.max_hops in the running AC (verified in AC's
  // app.py:1249), AND writes settings.json via _save_settings. But
  // AC's router stays paused once it has tripped the guard — raising
  // max_hops at runtime does NOT resurrect an already-paused channel
  // (router.py:76-77 → `paused = True`). The operator typically
  // raises the limit precisely BECAUSE the channel is stuck paused,
  // so we immediately follow the update_settings event with a
  // `/continue` chat message (the same path AC's own slash command
  // handler uses at app.py:1106-1110) to resume routing. This is the
  // whole fix: the previous version updated max_hops live but left
  // the channel frozen, which made the widget look like a no-op.
  let live = false;
  let autoResumed = false;
  // Only auto-resume when ALL of:
  //   (a) operator is RAISING the limit (lowering = "make it
  //       stricter", must leave a paused runaway alone)
  //   (b) the router is currently paused (AC's continue_routing
  //       resets hop_count + paused + guard_emitted unconditionally,
  //       so firing it on an actively-running chain would silently
  //       extend the chain beyond the new limit — t2a finding)
  //   (c) previousValue is known (null means we can't prove it's a
  //       raise, so err on the side of not touching router state)
  const isRaising = previousValue !== null && value > previousValue;
  const ensureLive = async (sessionToken) => {
    await sendWsEvent(base, sessionToken, { type: "update_settings", data: { max_agent_hops: value } });
    if (isRaising) {
      // Check AC's /api/status before firing /continue so we don't
      // reset hop_count on a running (unpaused) chain. The endpoint
      // exposes `paused: true` iff ANY channel currently paused.
      let isPaused = false;
      try {
        // AC's security middleware (app.py:212-224) only accepts
        // bearer auth for /api/messages, /api/send, and /api/rules/*.
        // /api/status requires x-session-token header (or ?token=),
        // so pass that instead — a bearer header silently 403s and
        // leaves isPaused stuck at false, defeating the gate.
        const statusUrl = `${base}/api/status`;
        const statusRes = await fetch(statusUrl, {
          headers: sessionToken ? { "x-session-token": sessionToken } : {},
          signal: AbortSignal.timeout(5000),
        });
        if (statusRes.ok) {
          const statusJson = await statusRes.json();
          isPaused = !!(statusJson && statusJson.paused);
        }
      } catch {
        // Status fetch failed — err toward "don't auto-resume". The
        // operator can always type /continue manually.
      }
      if (isPaused) {
        // Resume paused channels. /continue is routed by AC's ws
        // message handler when the buffer starts with /continue;
        // the handler calls router.continue_routing() which
        // unpauses AND resets hop_count — which is why we gate on
        // isPaused to avoid wiping the counter on a live chain.
        await sendWsEvent(base, sessionToken, { type: "message", text: "/continue", channel: "general", sender: "user" });
        autoResumed = true;
      }
    }
    live = true;
  };
  let base = null;
  try {
    const chattr = getChattrConfig(projectId);
    base = chattr.url;
    const sessionToken = chattr.token;
    if (base) {
      try {
        await ensureLive(sessionToken);
      } catch (err) {
        if (err && err.code === "EAGENTCHATTR_401") {
          console.warn(`[loop-guard] ws auth failed for ${projectId}, re-syncing session token and retrying...`);
          try { await syncChattrToken(projectId); }
          catch (syncErr) { console.warn(`[loop-guard] syncChattrToken failed: ${syncErr.message}`); }
          const { token: refreshed } = getChattrConfig(projectId);
          if (refreshed && refreshed !== sessionToken) {
            try {
              await ensureLive(refreshed);
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

  res.json({ ok: true, value, live, previousValue, resumed: autoResumed });
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

// #414 / quadwork#297: reject imports whose messages claim a
// reserved agent / system sender by default. This closes the only
// path in QuadWork that lets a client-supplied sender reach AC
// (every other route hardcodes / sanitizes to operator). Mirrors
// the RESERVED_OPERATOR_NAMES denylist from sanitizeOperatorName so
// the same identities are blocked across the codebase.
const RESERVED_HISTORY_SENDERS = new Set([
  "head",
  "dev",
  "re1",
  "re2",
  "reviewer1",
  "reviewer2",
  "t1",
  "t2a",
  "t2b",
  "t3",
  "system",
]);

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
    // #236: sendViaWebSocket now waits for AC's broadcast echo and
    // returns `{ok, message}` where `message` is the stored record
    // (with server-assigned id/timestamp). Pass it through so
    // callers regain parity with the old /api/send response body.
    const result = await attemptSend();
    return res.json({ ok: true, message: result.message });
  } catch (err) {
    // If the cached session_token is stale (AgentChattr regenerates
    // one on every restart) the ws closes with code 4003 — re-sync
    // the token from AgentChattr's HTML and retry once before giving
    // up. This is the actual fix for the "401 after restart" report
    // in #230 (the cache was stuck on an old token).
    //
    // #487: also attempt resync on generic ws errors (connection
    // refused, ECONNRESET, timeout, etc.) — a 502/5xx from a
    // temporary AC outage may resolve after a token refresh once AC
    // is back.
    const isAuthError = err && err.code === "EAGENTCHATTR_401";
    const isConnError = !isAuthError && err;
    if ((isAuthError || isConnError) && projectId) {
      const tag = isAuthError ? "ws auth failed" : "ws connection error";
      console.warn(`[chat] ${tag} for project ${projectId}, re-syncing session token and retrying...`);
      try { await syncChattrToken(projectId); }
      catch (syncErr) { console.warn(`[chat] syncChattrToken failed: ${syncErr.message}`); }
      const { token: refreshed } = getChattrConfig(projectId);
      if (refreshed && refreshed !== sessionToken) {
        try {
          const retry = await sendViaWebSocket(base, refreshed, message);
          return res.json({ ok: true, resynced: true, message: retry.message });
        } catch (retryErr) {
          console.warn(`[chat] retry after token resync failed: ${retryErr.message}`);
          const status = isAuthError ? 401 : 502;
          return res.status(status).json({ error: "AgentChattr send failed (token resync did not help)", detail: retryErr.message });
        }
      }
      if (isAuthError) {
        return res.status(401).json({ error: "AgentChattr auth failed", detail: err.message });
      }
    }
    console.warn(`[chat] send failed for project ${projectId}: ${err && err.message}`);
    return res.status(502).json({ error: "AgentChattr unreachable", detail: err && err.message });
  }
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
  res.sendFile(filePath);
});

// ─── Projects (dashboard aggregation) ──────────────────────────────────────

// #512: cache /api/projects results for 60s to eliminate repeated
// slow gh CLI calls on every dashboard poll.
let _projectsCache = null;
let _projectsCacheTs = 0;
const PROJECTS_CACHE_TTL = 60_000;

router.get("/api/projects", async (req, res) => {
  if (_projectsCache && Date.now() - _projectsCacheTs < PROJECTS_CACHE_TTL) {
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
const { execFile: _execFile } = require("child_process");
const _execFileAsync = require("util").promisify(_execFile);
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

router.get("/api/batch-progress", async (req, res) => {
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

  // #416 / quadwork#299: parallelize the per-item gh fetches.
  // Sequential execFileSync was costing ~10s on a cold cache for a
  // 5-item batch (2 gh calls per item, ~1s each); Promise.allSettled
  // over progressForItemAsync drops that to roughly the time of the
  // slowest single item-pair (~2s). One failed item resolves with a
  // synthetic "unknown" row instead of failing the whole response.
  const settled = await Promise.allSettled(
    issueNumbers.map((n) => progressForItemAsync(repo, n)),
  );
  const items = settled.map((r, i) => {
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
      ensureSecureDir(dataDir);
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

      const agents = ["head", "re1", "re2", "dev"];
      const colors = ["#10a37f", "#22c55e", "#f59e0b", "#da7756"];
      const labels = ["Lead", "Reviewer 1", "Reviewer 2", "Builder"];

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
        content += `[agents.${agent}]\ncommand = "${(backends && backends[agent]) || "claude"}"\ncwd = "${wtDir}"\ncolor = "${colors[i]}"\nlabel = "${labels[i]}"\nmcp_inject = "flag"\n\n`;
      });
      // #403 / quadwork#274: raise the loop guard from AC's default
      // of 4 to 30 so autonomous PR review cycles (head→dev→re1+re2→
      // dev→head, ~5 hops) don't fire mid-batch and force the
      // operator to type /continue. AC clamps to [1, 50] internally.
      content += `[routing]\ndefault = "none"\nmax_agent_hops = 30\n\n`;
      content += `[mcp]\nhttp_port = ${mcp_http}\nsse_port = ${mcp_sse}\n`;
      writeSecureFile(tomlPath, content);

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
      ensureSecureDir(dir);
      writeConfig(cfg);

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
// #444: pin agentchattr-telegram to a known commit (same pattern as
// AGENTCHATTR_PIN in bin/quadwork.js for bcurts/agentchattr).
const AGENTCHATTR_TELEGRAM_PIN = "045ee18f6d5dbcd0bd45d5ab29f06e2a27382aaf";

function telegramPidFile(projectId) {
  return path.join(CONFIG_DIR, `tg-bridge-${projectId}.pid`);
}

function telegramConfigToml(projectId) {
  return path.join(CONFIG_DIR, `telegram-${projectId}.toml`);
}

// #383: path to a project's AgentChattr config.toml. The install
// handler patches this file to declare the `tg` agent
// so AC's registry accepts the bridge's register call.
function projectAgentchattrConfigPath(projectId) {
  return path.join(CONFIG_DIR, projectId, "agentchattr", "config.toml");
}

// #383 Bug 1: prefer the per-project agentchattr_url. Every project
// after the first uses a distinct port (8301, 8302, ...), so reading
// the global default silently routed bridge traffic to the wrong AC
// instance.
function resolveProjectAgentchattrUrl(cfg, project) {
  return (
    (project && project.agentchattr_url) ||
    (cfg && cfg.agentchattr_url) ||
    "http://127.0.0.1:8300"
  );
}

// #383 Bug 2: the upstream bridge only reads `agentchattr_url` from
// inside `[telegram]`. A separate `[agentchattr]` section is silently
// ignored and the bridge falls back to its hardcoded :8300 default.
// #404: accept projectId so we can write a per-project cursor_file
// path. Without this, multiple project bridges share the same default
// cursor and clobber each other's position — the project with higher
// AC message IDs advances the cursor past the other project's range,
// silently killing AC→TG forwarding for that project.
function buildTelegramBridgeToml(tg, projectId) {
  const cursorFile = path.join(CONFIG_DIR, `tg-bridge-cursor-${projectId}.json`);
  // #439: migrate old cursor file so the bridge doesn't replay history
  const oldCursor = path.join(CONFIG_DIR, `telegram-bridge-cursor-${projectId}.json`);
  if (!fs.existsSync(cursorFile) && fs.existsSync(oldCursor)) {
    fs.renameSync(oldCursor, cursorFile);
  }
  return (
    `[telegram]\n` +
    `bot_token = "${tg.bot_token}"\n` +
    `chat_id = "${tg.chat_id}"\n` +
    `agentchattr_url = "${tg.agentchattr_url}"\n` +
    `cursor_file = "${cursorFile}"\n` +
    `project_id = "${projectId}"\n`
  );
}

// #383 Bug 3: AC's registry rejects any base name not pre-declared
// in config.toml with `400 unknown base`. The bridge registers as
// `tg` (#439: renamed from `telegram-bridge`), so every per-project
// AC config must declare it. Idempotent: only appends if the section
// is not already present. Also migrates old `[agents.telegram-bridge]`.
function patchAgentchattrConfigForTelegramBridge(tomlText) {
  // #439: migrate old slug if present
  const original = tomlText;
  tomlText = tomlText.replace(/^\[agents\.telegram-bridge\]\s*$/m, "[agents.tg]");
  if (/^\[agents\.tg\]\s*$/m.test(tomlText)) {
    return { text: tomlText, changed: tomlText !== original };
  }
  const sep = tomlText.length === 0 || tomlText.endsWith("\n") ? "" : "\n";
  const block = `\n[agents.tg]\nlabel = "Telegram Bridge"\n`;
  return { text: tomlText + sep + block, changed: true };
}

// #383 Bug 4: the upstream bridge treats env vars as higher
// precedence than TOML values. If the parent shell exported
// TELEGRAM_BOT_TOKEN for a different bot, the bridge silently ran
// as the wrong identity. Scrub those keys from the child's env so
// the TOML is the single source of truth.
function buildTelegramBridgeSpawnEnv(parentEnv) {
  const env = { ...parentEnv };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;
  delete env.AGENTCHATTR_URL;
  return env;
}

// #353: per-project log file for the bridge subprocess. The start
// handler redirects stdout + stderr here so crashes (ImportError,
// config parse, auth failure) are recoverable instead of
// /dev/null'd by `stdio: "ignore"`.
function telegramBridgeLog(projectId) {
  return path.join(CONFIG_DIR, `tg-bridge-${projectId}.log`);
}

// Tail the last N lines of a file without reading the whole thing
// into memory if it is huge. For the bridge log we care about the
// final crash frame, not historical output.
function readLastLines(filePath, n) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    const readBytes = Math.min(stat.size, 64 * 1024);
    if (readBytes === 0) return "";
    const buf = Buffer.alloc(readBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, readBytes, Math.max(0, stat.size - readBytes));
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(-n).join("\n");
  } catch {
    return "";
  }
}

// Verify that the bridge's Python runtime has its required modules
// available. Cheap pre-flight so a missing `requests` install
// produces a readable error instead of a silent Start → Stopped
// flicker. Returns { ok: true } on success, { ok: false, error }
// otherwise. Keep the import list small and close to what the
// bridge actually needs; add modules here if the bridge gains new
// hard deps.
// #380: `pythonPath` defaults to bare `python3` for backward-compat,
// but the production call sites (install, start) MUST pass the
// dedicated bridge venv's interpreter (`<BRIDGE_DIR>/.venv/bin/python3`)
// so the import check runs against the same interpreter the spawn will
// use. See #379 research ticket for root cause.
function checkTelegramBridgePythonDeps(pythonPath = "python3") {
  try {
    // Only check the third-party module the bridge actually needs
    // at import time — `requests`. Toml parsing differs between
    // Python versions (tomllib on 3.11+, tomli on 3.10-), and any
    // genuine toml import failure will now be captured in the
    // bridge log file on spawn, so this pre-flight stays narrow
    // and avoids false negatives on older Python installs.
    execFileSync(pythonPath, ["-c", "import requests"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    const stderr = (err && err.stderr && err.stderr.toString && err.stderr.toString()) || "";
    const msg = stderr.trim() || (err && err.message) || "python3 import check failed";
    return { ok: false, error: msg };
  }
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
      // #383 Bug 1: prefer per-project URL over the global default.
      agentchattr_url: resolveProjectAgentchattrUrl(cfg, project),
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
          try { writeConfig(cfg); } catch {}
        }
      }
    } catch { /* non-fatal — widget will just show no username */ }
  }
  // #353: if the bridge is not running but a log file exists with
  // content, tail it and expose it as `last_error` so the widget
  // can surface runtime crashes (bad token mid-session, network
  // failure, config parse error) that happen after the initial
  // 500 ms post-spawn liveness check and would otherwise just
  // revert the pill to Stopped with no explanation.
  const running = isTelegramRunning(projectId);
  let lastError = "";
  if (!running) {
    const logPath = telegramBridgeLog(projectId);
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 0) {
        lastError = readLastLines(logPath, 20);
      }
    } catch {}
  }
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
      // #380: create a dedicated bridge venv at
      // `<BRIDGE_DIR>/.venv` and install requirements into it using
      // that venv's pip. All bridge subprocesses then spawn with
      // `<BRIDGE_DIR>/.venv/bin/python3` by absolute path. See #379
      // research ticket for the root cause — bare `python3` / `pip3`
      // resolve to Homebrew Python on modern macOS where `requests`
      // is not available, producing a ModuleNotFoundError on Start.
      // Idempotent: existing installs missing a `.venv` get the venv
      // created on top of the existing clone without re-cloning.
      const venvDir = path.join(BRIDGE_DIR, ".venv");
      const venvPython = path.join(venvDir, "bin", "python3");
      const venvPip = path.join(venvDir, "bin", "pip");
      let pipOutput = "";
      try {
        if (!fs.existsSync(BRIDGE_DIR)) {
          execFileSync("gh", ["repo", "clone", "realproject7/agentchattr-telegram", BRIDGE_DIR], { encoding: "utf-8", timeout: 30000 });
        }
        // #444 / #470: pin to a known commit — on fresh clone AND on
        // upgrade (existing clone may be on an older pin with stale
        // bridge_sender defaults).
        try {
          execFileSync("git", ["-C", BRIDGE_DIR, "fetch", "origin"], { encoding: "utf-8", timeout: 30000 });
          execFileSync("git", ["-C", BRIDGE_DIR, "checkout", "-B", "pinned", AGENTCHATTR_TELEGRAM_PIN], { encoding: "utf-8", timeout: 30000 });
        } catch {
          console.warn(`[telegram] WARNING: could not check out agentchattr-telegram pin ${AGENTCHATTR_TELEGRAM_PIN}; falling back to default branch.`);
        }
        // #380: create the dedicated venv if missing. `python3 -m venv`
        // builds a fresh isolated environment that bypasses PEP 668
        // externally-managed markers, so this works even on Homebrew
        // Python where bare `pip3 install` would be blocked.
        if (!fs.existsSync(venvPython)) {
          execFileSync("python3", ["-m", "venv", venvDir], { encoding: "utf-8", timeout: 60000 });
        }
        pipOutput = execFileSync(
          venvPip,
          ["install", "-r", path.join(BRIDGE_DIR, "requirements.txt")],
          { encoding: "utf-8", timeout: 120000 },
        );
      } catch (err) {
        const stderr = (err && err.stderr && err.stderr.toString && err.stderr.toString()) || "";
        return res.json({ ok: false, error: (stderr.trim() || err.message || "Install failed") });
      }
      const depCheck = checkTelegramBridgePythonDeps(venvPython);
      if (!depCheck.ok) {
        return res.json({
          ok: false,
          error:
            "pip reported success but the bridge venv's Python deps still fail to import. " +
            "This is unexpected for a freshly-created venv — check disk space and permissions " +
            `on ${venvDir}.\n\n` +
            `Import error: ${depCheck.error}\n\n` +
            `pip output tail:\n${pipOutput.split("\n").slice(-10).join("\n")}`,
        });
      }
      // #383 Bug 3 / #457: ensure every known project's AC config
      // declares the `tg` agent and migrates old `telegram-bridge`
      // slug. Restarts AC for projects whose config changed so the
      // new slug loads immediately.
      const patched = [];
      try {
        const cfgAll = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const serverPort = cfgAll.port || 8400;
        for (const proj of cfgAll.projects || []) {
          if (!proj || !proj.id) continue;
          const acPath = projectAgentchattrConfigPath(proj.id);
          if (!fs.existsSync(acPath)) continue;
          try {
            const before = fs.readFileSync(acPath, "utf-8");
            const { text, changed } = patchAgentchattrConfigForTelegramBridge(before);
            if (changed) {
              fs.writeFileSync(acPath, text);
              patched.push(proj.id);
              // #457: restart AC so it loads the new agent slug
              setTimeout(async () => {
                try {
                  await fetch(`http://127.0.0.1:${serverPort}/api/agentchattr/${encodeURIComponent(proj.id)}/restart`, {
                    method: "POST",
                  });
                } catch {}
              }, 1000);
            }
          } catch {}
        }
      } catch {}
      return res.json({ ok: true, patched_projects: patched });
    }
    case "start": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      if (isTelegramRunning(projectId)) return res.json({ ok: true, running: true, message: "Already running" });
      const bridgeScript = path.join(BRIDGE_DIR, "telegram_bridge.py");
      if (!fs.existsSync(bridgeScript)) return res.json({ ok: false, error: "Bridge not installed. Click Install Bridge first." });
      // #380: resolve the dedicated venv's python3 by absolute path.
      // Do NOT activate the venv or set VIRTUAL_ENV in the parent —
      // calling the venv's python3 directly is sufficient because
      // Python's sys.executable bootstrap resolves the venv
      // automatically. See #379 research ticket.
      const venvPython = path.join(BRIDGE_DIR, ".venv", "bin", "python3");
      if (!fs.existsSync(venvPython)) {
        return res.json({
          ok: false,
          error: "Bridge venv missing. Click \"Install Bridge\" to create it.",
        });
      }
      const tg = getProjectTelegram(projectId);
      if (!tg || !tg.bot_token || !tg.chat_id) return res.json({ ok: false, error: "Save bot_token and chat_id in project settings first." });
      const tomlPath = telegramConfigToml(projectId);
      // #383 Bug 2: write agentchattr_url inside [telegram]; the
      // bridge's load_config only reads from that section.
      const tomlContent = buildTelegramBridgeToml(tg, projectId);
      writeSecureFile(tomlPath, tomlContent);
      // #353: pre-flight import check so a fresh install with no
      // `requests` module produces a readable error instead of the
      // Start → Running → Stopped flicker that the v1 code path
      // produced with `stdio: "ignore"`.
      const depCheck = checkTelegramBridgePythonDeps(venvPython);
      if (!depCheck.ok) {
        // #372: persist the pre-flight failure to the bridge log
        // file so the GET /api/telegram `last_error` tail picks it
        // up on the next status poll. Without this the widget only
        // sees the error for ~5s before the polling cycle clobbers
        // local error state, producing the "silent fail" symptom
        // (pill flips back to Stopped with no trace of why).
        const msg =
          "Bridge Python dependencies not installed in the dedicated venv. " +
          "Click \"Install Bridge\" to (re)create the venv and install them.\n\n" +
          `Import error: ${depCheck.error}`;
        try {
          fs.writeFileSync(
            telegramBridgeLog(projectId),
            `[${new Date().toISOString()}] pre-flight dep check failed\n${msg}\n`,
          );
        } catch {}
        return res.json({ ok: false, error: msg });
      }
      // #353: capture stdout + stderr to a per-project log file so
      // bridge crashes (bad token, network failure, config parse
      // error, etc.) are recoverable. The handle must be opened
      // BEFORE spawn and passed through stdio so the detached
      // child keeps writing after the parent unrefs it.
      const logPath = telegramBridgeLog(projectId);
      // #353 follow-up: truncate the log at the start of every
      // spawn so the status endpoint's last_error tail only ever
      // reflects the *current* session. Otherwise a previous
      // crash's trace would linger forever and the widget would
      // keep surfacing a stale error even after the operator
      // fixed the underlying problem and restarted cleanly.
      try { fs.writeFileSync(logPath, ""); } catch {}
      let outFd, errFd;
      try {
        outFd = fs.openSync(logPath, "a");
        errFd = fs.openSync(logPath, "a");
      } catch (err) {
        return res.json({ ok: false, error: `Could not open bridge log file: ${err.message}` });
      }
      let child;
      try {
        // #383 Bug 4: scrub TELEGRAM_*/AGENTCHATTR_URL from the child
        // env so an operator shell that exports a different bot's
        // token (common on machines running AC2) can't silently
        // override the TOML. Makes the TOML the single source of
        // truth for the bridge's identity.
        child = spawn(venvPython, [bridgeScript, "--config", tomlPath], {
          detached: true,
          stdio: ["ignore", outFd, errFd],
          env: buildTelegramBridgeSpawnEnv(process.env),
        });
        child.unref();
        if (child.pid) fs.writeFileSync(telegramPidFile(projectId), String(child.pid));
      } catch (err) {
        try { fs.closeSync(outFd); } catch {}
        try { fs.closeSync(errFd); } catch {}
        return res.json({ ok: false, error: err.message || "Start failed" });
      }
      // Close our copies of the fds in the parent now that the
      // child has inherited them — otherwise the parent holds the
      // log file open forever.
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      // #353: liveness check — wait 500ms, then verify the child
      // is still running. If it already died, tail the log file
      // and return those lines as the error.
      await new Promise((r) => setTimeout(r, 500));
      let alive = true;
      try { process.kill(child.pid, 0); } catch { alive = false; }
      if (!alive) {
        const tail = readLastLines(logPath, 20);
        try { fs.unlinkSync(telegramPidFile(projectId)); } catch {}
        return res.json({
          ok: false,
          error:
            "Bridge crashed on start (exited within 500ms).\n\n" +
            `Last log lines (${logPath}):\n${tail || "(log empty)"}`,
        });
      }
      return res.json({ ok: true, running: true, pid: child.pid });
    }
    case "stop": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      // #388: deregister the bridge from AC before killing so the slot
      // clears immediately instead of lingering for 60s as a stale -2/-3.
      // Awaited so a fast stop→start cycle doesn't race the deregister.
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const project = cfg.projects?.find((p) => p.id === projectId);
        const acUrl = resolveProjectAgentchattrUrl(cfg, project);
        if (acUrl) {
          const acPort = new URL(acUrl).port || "8300";
          await fetch(`http://127.0.0.1:${acPort}/api/deregister/tg`, {
            method: "POST",
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});
        }
      } catch {}
      try {
        const pf = telegramPidFile(projectId);
        if (fs.existsSync(pf)) {
          const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
          fs.unlinkSync(pf);
        }
        // #522: clear bridge log so last_error doesn't show stale
        // connection-refused messages after an intentional stop.
        try { fs.writeFileSync(telegramBridgeLog(projectId), ""); } catch {}
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
// #396/#399: Discord ↔ AgentChattr bridge, bundled in quadwork
// package at bridges/discord/. Mirrors Telegram bridge patterns.

const DISCORD_BRIDGE_SRC = path.join(__dirname, "..", "bridges", "discord");
const DISCORD_BRIDGE_DIR = path.join(CONFIG_DIR, "agentchattr-discord");

function discordPidFile(projectId) {
  return path.join(CONFIG_DIR, `dc-bridge-${projectId}.pid`);
}

function discordConfigToml(projectId) {
  return path.join(CONFIG_DIR, `discord-${projectId}.toml`);
}

function discordBridgeLog(projectId) {
  return path.join(CONFIG_DIR, `dc-bridge-${projectId}.log`);
}

function buildDiscordBridgeToml(dc, projectId) {
  const cursorFile = path.join(CONFIG_DIR, `dc-bridge-cursor-${projectId}.json`);
  // #439: migrate old cursor file so the bridge doesn't replay history
  const oldCursor = path.join(CONFIG_DIR, `discord-bridge-cursor-${projectId}.json`);
  if (!fs.existsSync(cursorFile) && fs.existsSync(oldCursor)) {
    fs.renameSync(oldCursor, cursorFile);
  }
  return (
    `[discord]\n` +
    `bot_token = "${dc.bot_token}"\n` +
    `channel_id = "${dc.channel_id}"\n` +
    `agentchattr_url = "${dc.agentchattr_url}"\n` +
    `cursor_file = "${cursorFile}"\n` +
    `project_id = "${projectId}"\n`
  );
}

function patchAgentchattrConfigForDiscordBridge(tomlText) {
  // #439: migrate old slug if present
  const original = tomlText;
  tomlText = tomlText.replace(/^\[agents\.discord-bridge\]\s*$/m, "[agents.dc]");
  if (/^\[agents\.dc\]\s*$/m.test(tomlText)) {
    return { text: tomlText, changed: tomlText !== original };
  }
  const sep = tomlText.length === 0 || tomlText.endsWith("\n") ? "" : "\n";
  const block = `\n[agents.dc]\nlabel = "Discord Bridge"\n`;
  return { text: tomlText + sep + block, changed: true };
}

function buildDiscordBridgeSpawnEnv(parentEnv) {
  const env = { ...parentEnv };
  delete env.DISCORD_BOT_TOKEN;
  delete env.DISCORD_CHANNEL_ID;
  delete env.AGENTCHATTR_URL;
  return env;
}

function checkDiscordBridgePythonDeps(pythonPath = "python3") {
  try {
    execFileSync(pythonPath, ["-c", "import discord, requests"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    const stderr = (err && err.stderr && err.stderr.toString && err.stderr.toString()) || "";
    const msg = stderr.trim() || (err && err.message) || "python3 import check failed";
    return { ok: false, error: msg };
  }
}

function isDiscordRunning(projectId) {
  const pf = discordPidFile(projectId);
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
      agentchattr_url: resolveProjectAgentchattrUrl(cfg, project),
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
    bridgeInstalled = fs.existsSync(path.join(DISCORD_BRIDGE_DIR, "discord_bridge.py"));
    // Lazy-resolve bot username via Discord's /users/@me the first time
    // after a token is saved. Cache it on the project entry so later
    // requests don't hit the network.
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
      } catch { /* non-fatal — widget will just show no username */ }
    }
  } catch {}
  const running = isDiscordRunning(projectId);
  let lastError = "";
  if (!running) {
    const logPath = discordBridgeLog(projectId);
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 0) {
        lastError = readLastLines(logPath, 20);
      }
    } catch {}
  }
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
      const venvDir = path.join(DISCORD_BRIDGE_DIR, ".venv");
      const venvPython = path.join(venvDir, "bin", "python3");
      const venvPip = path.join(venvDir, "bin", "pip");
      let pipOutput = "";
      try {
        // #506: always copy bundled bridge files (not just on first install)
        // so re-installing after a QuadWork upgrade refreshes the script.
        if (!fs.existsSync(DISCORD_BRIDGE_DIR)) {
          ensureSecureDir(DISCORD_BRIDGE_DIR);
        }
        fs.cpSync(
          path.join(DISCORD_BRIDGE_SRC, "discord_bridge.py"),
          path.join(DISCORD_BRIDGE_DIR, "discord_bridge.py"),
        );
        fs.cpSync(
          path.join(DISCORD_BRIDGE_SRC, "requirements.txt"),
          path.join(DISCORD_BRIDGE_DIR, "requirements.txt"),
        );
        if (!fs.existsSync(venvPython)) {
          execFileSync("python3", ["-m", "venv", venvDir], { encoding: "utf-8", timeout: 60000 });
        }
        pipOutput = execFileSync(
          venvPip,
          ["install", "-r", path.join(DISCORD_BRIDGE_DIR, "requirements.txt")],
          { encoding: "utf-8", timeout: 120000 },
        );
      } catch (err) {
        const stderr = (err && err.stderr && err.stderr.toString && err.stderr.toString()) || "";
        return res.json({ ok: false, error: (stderr.trim() || err.message || "Install failed") });
      }
      const depCheck = checkDiscordBridgePythonDeps(venvPython);
      if (!depCheck.ok) {
        return res.json({
          ok: false,
          error:
            "pip reported success but the bridge venv's Python deps still fail to import. " +
            `Check disk space and permissions on ${venvDir}.\n\n` +
            `Import error: ${depCheck.error}\n\n` +
            `pip output tail:\n${pipOutput.split("\n").slice(-10).join("\n")}`,
        });
      }
      // #457: Patch all project AC configs with [agents.dc] and
      // migrate old `discord-bridge` slug. Restart AC for changed projects.
      const patched = [];
      try {
        const cfgAll = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const serverPort = cfgAll.port || 8400;
        for (const proj of cfgAll.projects || []) {
          if (!proj || !proj.id) continue;
          const acPath = projectAgentchattrConfigPath(proj.id);
          if (!fs.existsSync(acPath)) continue;
          try {
            const before = fs.readFileSync(acPath, "utf-8");
            const { text, changed } = patchAgentchattrConfigForDiscordBridge(before);
            if (changed) {
              fs.writeFileSync(acPath, text);
              patched.push(proj.id);
              // #457: restart AC so it loads the new agent slug
              setTimeout(async () => {
                try {
                  await fetch(`http://127.0.0.1:${serverPort}/api/agentchattr/${encodeURIComponent(proj.id)}/restart`, {
                    method: "POST",
                  });
                } catch {}
              }, 1000);
            }
          } catch {}
        }
      } catch {}
      return res.json({ ok: true, patched_projects: patched });
    }
    case "start": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      if (isDiscordRunning(projectId)) return res.json({ ok: true, running: true, message: "Already running" });
      const bridgeScript = path.join(DISCORD_BRIDGE_DIR, "discord_bridge.py");
      if (!fs.existsSync(bridgeScript)) return res.json({ ok: false, error: "Bridge not installed. Click Install Bridge first." });
      const venvPython = path.join(DISCORD_BRIDGE_DIR, ".venv", "bin", "python3");
      if (!fs.existsSync(venvPython)) {
        return res.json({ ok: false, error: "Bridge venv missing. Click \"Install Bridge\" to create it." });
      }
      const dc = getProjectDiscord(projectId);
      if (!dc || !dc.bot_token || !dc.channel_id) return res.json({ ok: false, error: "Save bot_token and channel_id in project settings first." });
      const tomlPath = discordConfigToml(projectId);
      const tomlContent = buildDiscordBridgeToml(dc, projectId);
      writeSecureFile(tomlPath, tomlContent);
      const depCheck = checkDiscordBridgePythonDeps(venvPython);
      if (!depCheck.ok) {
        const msg =
          "Bridge Python dependencies not installed in the dedicated venv. " +
          "Click \"Install Bridge\" to (re)create the venv and install them.\n\n" +
          `Import error: ${depCheck.error}`;
        try {
          fs.writeFileSync(
            discordBridgeLog(projectId),
            `[${new Date().toISOString()}] pre-flight dep check failed\n${msg}\n`,
          );
        } catch {}
        return res.json({ ok: false, error: msg });
      }
      const logPath = discordBridgeLog(projectId);
      try { fs.writeFileSync(logPath, ""); } catch {}
      let outFd, errFd;
      try {
        outFd = fs.openSync(logPath, "a");
        errFd = fs.openSync(logPath, "a");
      } catch (err) {
        return res.json({ ok: false, error: `Could not open bridge log file: ${err.message}` });
      }
      let child;
      try {
        child = spawn(venvPython, [bridgeScript, "--config", tomlPath], {
          detached: true,
          stdio: ["ignore", outFd, errFd],
          env: buildDiscordBridgeSpawnEnv(process.env),
        });
        child.unref();
        if (child.pid) fs.writeFileSync(discordPidFile(projectId), String(child.pid));
      } catch (err) {
        try { fs.closeSync(outFd); } catch {}
        try { fs.closeSync(errFd); } catch {}
        return res.json({ ok: false, error: err.message || "Start failed" });
      }
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      await new Promise((r) => setTimeout(r, 500));
      let alive = true;
      try { process.kill(child.pid, 0); } catch { alive = false; }
      if (!alive) {
        const tail = readLastLines(logPath, 20);
        try { fs.unlinkSync(discordPidFile(projectId)); } catch {}
        return res.json({
          ok: false,
          error:
            "Bridge crashed on start (exited within 500ms).\n\n" +
            `Last log lines (${logPath}):\n${tail || "(log empty)"}`,
        });
      }
      return res.json({ ok: true, running: true, pid: child.pid });
    }
    case "stop": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const project = cfg.projects?.find((p) => p.id === projectId);
        const acUrl = resolveProjectAgentchattrUrl(cfg, project);
        if (acUrl) {
          const acPort = new URL(acUrl).port || "8300";
          await fetch(`http://127.0.0.1:${acPort}/api/deregister/dc`, {
            method: "POST",
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});
        }
      } catch {}
      try {
        const pf = discordPidFile(projectId);
        if (fs.existsSync(pf)) {
          const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
          fs.unlinkSync(pf);
        }
        // #522: clear bridge log so last_error doesn't show stale
        // connection-refused messages after an intentional stop.
        try { fs.writeFileSync(discordBridgeLog(projectId), ""); } catch {}
        return res.json({ ok: true, running: false });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Stop failed" });
      }
    }
    case "status":
      return res.json({ running: isDiscordRunning(body.project_id || "") });
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

module.exports = router;
// #341: export parseActiveBatch for unit tests. No production callers
// outside this file; the export is strictly for the node:assert
// script at server/routes.parseActiveBatch.test.js.
module.exports.parseActiveBatch = parseActiveBatch;
// #350: same pattern — expose the no-linked-PR row builder and
// summarizeItems for the batch-progress fixture test.
module.exports.buildNoPrRow = buildNoPrRow;
module.exports.summarizeItems = summarizeItems;
// #353: expose readLastLines for the tg-bridge test.
module.exports.readLastLines = readLastLines;
// #380: expose checkTelegramBridgePythonDeps so the bridge test can
// exercise the venv-path interpreter argument round trip.
module.exports.checkTelegramBridgePythonDeps = checkTelegramBridgePythonDeps;
// #383: pure helpers exposed for unit tests in
// routes.telegramBridge.test.js. No production callers outside
// this file.
module.exports.resolveProjectAgentchattrUrl = resolveProjectAgentchattrUrl;
module.exports.buildTelegramBridgeToml = buildTelegramBridgeToml;
module.exports.patchAgentchattrConfigForTelegramBridge = patchAgentchattrConfigForTelegramBridge;
module.exports.buildTelegramBridgeSpawnEnv = buildTelegramBridgeSpawnEnv;
module.exports.checkDiscordBridgePythonDeps = checkDiscordBridgePythonDeps;
module.exports.buildDiscordBridgeToml = buildDiscordBridgeToml;
module.exports.patchAgentchattrConfigForDiscordBridge = patchAgentchattrConfigForDiscordBridge;
module.exports.buildDiscordBridgeSpawnEnv = buildDiscordBridgeSpawnEnv;
module.exports.projectAgentchattrConfigPath = projectAgentchattrConfigPath;
// #236: expose sendViaWebSocket so the chat-ws-send regression test
// can verify the ack/body/error paths against a fake AC ws server.
module.exports.sendViaWebSocket = sendViaWebSocket;
