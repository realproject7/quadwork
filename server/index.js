const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { WebSocketServer, WebSocket } = require("ws");
const pty = require("node-pty");
const { spawn } = require("child_process");
const { readConfig, resolveAgentCwd, resolveAgentCommand, CONFIG_PATH, ensureSecureDir, writeSecureFile, writeConfig } = require("./config");
const routes = require("./routes");
const fileChat = require("./file-chat");
const { dispatchToAgentPTY, cleanupSession: cleanupPtyDispatcher } = require("./pty-dispatcher");
const { runAcMigration } = require("./migrate-ac");
const selfHeal = require("./self-heal");
const tempCleanup = require("./temp-cleanup"); // #957: stale backend-temp sweep
const { injectModeForCommand, cliBaseFromCommand } = require("../src/lib/injectMode.js");
const telegramBridge = require("./bridges/telegram"); // #972: stop on shutdown
const discordBridge = require("./bridges/discord");   // #972: stop on shutdown

const net = require("net");
const crypto = require("crypto");
const config = readConfig();
const PORT = config.port || 8400;

// #968: shared session token gating the PTY-driving surface (/ws/terminal,
// /ws/butler, /write, /interrupt). Auto-provisioned + persisted to config.json
// so the LOCAL dashboard attaches it with zero operator friction; tailnet/LAN
// exposure must supply it out-of-band (see docs/*). Kept out of any response
// except the localhost-only /api/session-token endpoint.
let SESSION_TOKEN =
  typeof config.session_token === "string" && config.session_token
    ? config.session_token
    : null;
if (!SESSION_TOKEN) {
  SESSION_TOKEN = crypto.randomBytes(32).toString("hex");
  try {
    writeConfig({ ...config, session_token: SESSION_TOKEN });
  } catch (err) {
    console.warn(`[auth] could not persist session token to config: ${err.message || err}`);
  }
}

// #988: opt-in allowlist of trusted reverse-proxy dashboard hosts. When the
// dashboard is served through a LOCAL, AUTHENTICATED reverse proxy (e.g. nginx
// terminating basic-auth and proxying p7.quadwork.xyz -> 127.0.0.1:8400 with
// `proxy_set_header Host $host`), the forwarded Host/Origin is a REMOTE name so
// #968's strict loopback checks 403 the token fetch and every terminal WS dies.
// Configuring `trusted_dashboard_hosts: ["p7.quadwork.xyz"]` lets those (and
// ONLY those) forwarded names through, but ONLY when the socket itself is
// loopback (the request truly arrived via the on-box proxy). Empty/unset (the
// default) → exactly #968's loopback-only behavior, no change. The proxy MUST
// be authenticated; see docs/troubleshooting.md.
const TRUSTED_DASHBOARD_HOSTS = normalizeTrustedDashboardHosts(config.trusted_dashboard_hosts);

function normalizeTrustedDashboardHosts(raw) {
  const out = new Set();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    // Accept a bare host ("p7.quadwork.xyz[:443]") or a full origin URL.
    const h = hostnameOfHostHeader(entry) || hostnameOfOrigin(entry);
    if (h) out.add(h);
  }
  return out;
}

function emitSystemMessage(projectId, text) {
  try {
    if (routes.getProjectChatMode(projectId) !== "file") return;
    fileChat.appendMessage(projectId, { sender: "system", type: "system", text });
  } catch {}
}

const app = express();
// #412 / quadwork#279: bump the global JSON body limit to 10mb so
// POST /api/project-history can accept full chat exports. The
// default ~100kb 413'd long before the route-local parser had a
// chance to apply its own 10mb cap (the global parser runs first).
// All other routes are well within 10mb in practice; this is the
// least invasive fix and matches the documented import ceiling.
app.use(express.json({ limit: "10mb" }));

// --- Mount migrated API routes (from Next.js) ---
app.use(routes);

// #730: wire PTY injection dispatcher into the chat route
routes.setPtyDispatchCallback((projectId, msg) => {
  dispatchToAgentPTY(projectId, msg, agentSessions, {
    isLoopGuardPaused: fileChat.isLoopGuardPaused,
    safeWrite,
  });
});

const server = http.createServer(app);

// --- REST endpoints ---

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// #968: hand the shared session token to the LOCAL dashboard only, so it can
// auto-attach it to WS + PTY-write calls with no operator action. The guard
// checks socket IP + Host + Origin are all loopback (see isLocalTokenRequest)
// so a DNS-rebinding page or a same-host reverse proxy can't pull the token to
// a remote origin. Non-loopback (tailnet/LAN/proxied) callers get 403 and must
// configure the token out-of-band — it is never leaked off-box. The one
// exception (#988) is an operator-configured trusted_dashboard_hosts allowlist
// for an authenticated on-box reverse proxy (see isTrustedProxyRequest).
app.get("/api/session-token", (req, res) => {
  if (!isLocalTokenRequest(req) && !isTrustedProxyRequest(req))
    return res.status(403).json({ error: "Local access only" });
  res.json({ token: SESSION_TOKEN });
});

// --- Safe PTY write helper (#670) ---

function safeWrite(term, data) {
  if (!term) return false;
  try { term.write(data); return true; }
  catch (err) {
    if (err.code === "EIO") return false;
    throw err;
  }
}

// --- #968: PTY-surface auth (Origin allowlist + shared session token) ---

function isLocalhost(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// Parse the hostname out of a `Host` header value ("name[:port]"). Lowercased
// for case-insensitive allowlist comparison. Returns null on garbage.
function hostnameOfHostHeader(host) {
  if (!host || typeof host !== "string") return null;
  try { return new URL(`http://${host}`).hostname.toLowerCase(); } catch { return null; }
}

// Parse the hostname out of an `Origin` header value (a full URL). Lowercased.
function hostnameOfOrigin(origin) {
  if (!origin || typeof origin !== "string") return null;
  try { return new URL(origin).hostname.toLowerCase(); } catch { return null; }
}

// True when `host` (an `Origin`/`Host` header value, "name[:port]") resolves to
// a loopback name. Used to keep the session token on-box.
function isLoopbackHostHeader(host) {
  const hostname = hostnameOfHostHeader(host);
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

// #988: true when the request arrived over loopback (i.e. from the on-box
// reverse proxy) AND its forwarded Host — and, when the browser sends one, its
// Origin — are BOTH in the operator's trusted_dashboard_hosts allowlist. An
// empty allowlist (the default) short-circuits to false, so with no config this
// is a no-op and the strict #968 loopback checks are the only gate. A foreign
// Host/Origin (DNS-rebind, untrusted proxy, tailnet name) is never in the
// allowlist, so it still fails here → 403 / rejected upgrade. Works for both an
// Express req (req.ip) and a raw upgrade req (req.socket.remoteAddress).
function isTrustedProxyRequest(req) {
  if (TRUSTED_DASHBOARD_HOSTS.size === 0) return false;
  const ip = req.ip || (req.socket && req.socket.remoteAddress);
  if (!isLocalhost(ip)) return false;
  const host = hostnameOfHostHeader(req.headers.host);
  if (!host || !TRUSTED_DASHBOARD_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    const o = hostnameOfOrigin(origin);
    if (!o || !TRUSTED_DASHBOARD_HOSTS.has(o)) return false;
  }
  return true;
}

// #968 (hardened per review): the session token is a bearer secret, so only
// hand it to a request that is unambiguously this machine's own loopback.
// `req.ip` alone is insufficient — a DNS-rebinding page (attacker domain rebound
// to 127.0.0.1) or a same-host reverse proxy keeps `req.ip` at 127.0.0.1 while
// the browser's Host/Origin is a REMOTE name. Require the socket IP AND the Host
// header AND the Origin (when the browser sends one) to all be loopback.
// Remote/proxied/tailnet access uses the out-of-band localStorage token instead.
function isLocalTokenRequest(req) {
  if (!isLocalhost(req.ip)) return false;
  if (!isLoopbackHostHeader(req.headers.host)) return false;
  // Origin (present on cross-origin/CORS requests) is a full URL, not a bare
  // host — parse it directly and require loopback too.
  const origin = req.headers.origin;
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { return false; }
    if (o.hostname !== "127.0.0.1" && o.hostname !== "localhost" && o.hostname !== "::1") return false;
  }
  return true;
}

// A cross-origin web page CAN open a WebSocket to 127.0.0.1 (browsers don't
// enforce same-origin on WS), so the upgrade handler must vet Origin itself.
// Allow any localhost origin (the local dashboard, incl. dev on :3000), an
// allowlisted reverse-proxy origin (#988), and — for a DIRECT (non-loopback)
// connection only — a request whose Origin host matches the server Host (direct
// tailnet/LAN access to this very port). Absent Origin → reject (browsers always
// send it on WS).
function isAllowedWsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1") return true;
  // #988: an allowlisted reverse-proxy dashboard origin (verified loopback +
  // trusted forwarded Host/Origin) is accepted consistently with the token fetch.
  if (isTrustedProxyRequest(req)) return true;
  // #968 direct tailnet/LAN access: the browser's Origin host matches the server
  // Host. #988: honor this ONLY for a genuine direct (non-loopback) connection.
  // A LOOPBACK socket carrying a non-loopback Host means the request arrived via
  // an on-box reverse proxy, which MUST be explicitly allowlisted (handled just
  // above). Without the loopback-socket guard, a forged/foreign Host+Origin pair
  // (DNS-rebinding page, untrusted proxy) matching each other would slip through
  // this fallback and, with a token, open the WS — violating #988's invariant.
  const ip = req.socket && req.socket.remoteAddress;
  return !isLocalhost(ip) && !!req.headers.host && u.host === req.headers.host;
}

function tokenMatches(token) {
  return typeof token === "string" && token.length > 0 && token === SESSION_TOKEN;
}

// REST guard for the PTY-write endpoints. Token travels in X-Session-Token.
function requireSessionToken(req, res) {
  if (tokenMatches(req.headers["x-session-token"])) return true;
  res.status(401).json({ ok: false, error: "Invalid or missing session token" });
  return false;
}

// --- CLI status detection ---

const { execFileSync } = require("child_process");

function isCliInstalled(cmd) {
  try {
    execFileSync("which", [cmd], { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    // #586: fallback for VPS/headless environments where ~/.local/bin
    // is not in the inherited PATH (e.g. Claude Code installer adds to
    // ~/.bashrc but Node's execFileSync doesn't source profile files).
    // #1023: ~/.grok/bin covers grok's `curl | bash` installer, which does not
    // put the binary on the npm global path. The list is generic, so this also
    // probes ~/.grok/bin/claude etc. — harmless, those paths simply don't exist.
    const fallbacks = [
      path.join(os.homedir(), ".local", "bin", cmd),
      path.join(os.homedir(), ".npm-global", "bin", cmd),
      path.join(os.homedir(), ".grok", "bin", cmd),
      `/usr/local/bin/${cmd}`,
    ];
    return fallbacks.some((p) => fs.existsSync(p));
  }
}

app.get("/api/cli-status", (_req, res) => {
  res.json({
    claude: isCliInstalled("claude"),
    codex: isCliInstalled("codex"),
    gemini: isCliInstalled("gemini"),
    grok: isCliInstalled("grok"),
  });
});

// --- Port availability check ---

function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => { srv.close(); resolve(true); });
    srv.listen(port, "127.0.0.1");
  });
}

app.get("/api/port-check", async (req, res) => {
  const port = parseInt(req.query.port, 10);
  if (!port || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  const free = await checkPort(port);
  res.json({ port, free });
});

app.get("/api/port-check/auto", async (req, res) => {
  const start = parseInt(req.query.start, 10) || 8300;
  const count = Math.min(parseInt(req.query.count, 10) || 3, 10);
  const results = [];
  let port = start;
  for (let i = 0; i < count; i++) {
    while (!(await checkPort(port)) && port < 65535) port++;
    results.push(port);
    port++;
  }
  res.json({ ports: results });
});

// --- Caffeinate (sleep prevention) ---

let caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };

app.post("/api/caffeinate/start", (req, res) => {
  if (process.platform !== "darwin") {
    return res.status(400).json({ ok: false, error: "Sleep prevention is only available on macOS" });
  }
  // Kill existing if running
  if (caffeinateProcess.process) {
    try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
  }
  const duration = req.body?.duration || 0; // seconds, 0 = indefinite
  const args = ["-d", "-i", "-s"];
  if (duration > 0) args.push("-t", String(duration));
  const child = spawn("caffeinate", args, { stdio: "ignore", detached: true });
  child.unref();
  child.on("exit", () => {
    if (caffeinateProcess.process === child) {
      caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
    }
  });
  caffeinateProcess = { process: child, pid: child.pid, startedAt: Date.now(), duration: duration || null };
  res.json({ ok: true, active: true, pid: child.pid, duration });
});

app.post("/api/caffeinate/stop", (_req, res) => {
  if (caffeinateProcess.process) {
    try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
  }
  caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
  res.json({ ok: true, active: false });
});

app.get("/api/caffeinate/status", (_req, res) => {
  const active = !!(caffeinateProcess.process && caffeinateProcess.pid);
  let remaining = null;
  if (active && caffeinateProcess.duration && caffeinateProcess.startedAt) {
    const elapsed = Math.floor((Date.now() - caffeinateProcess.startedAt) / 1000);
    remaining = Math.max(0, caffeinateProcess.duration - elapsed);
  }
  res.json({ active, pid: caffeinateProcess.pid, remaining, platform: process.platform });
});

// --- Unified agent sessions ---
// Single map: key = "project/agent" → { projectId, agentId, term, ws, state, error }
// PTY (term) is the source of truth for "running". WS is optional (attaches to view terminal).
const agentSessions = new Map();

// #631: Butler session — single global PTY (not per-project, no AC integration)
let butlerSession = { term: null, viewers: new Set(), viewerDims: new Map(), lastDims: null, state: "stopped", error: null, scrollback: Buffer.alloc(0) };

// --- MCP auth proxy for Codex (can't pass headers via -c flag) ---
// Maps "project/agent" → { server, port }
const mcpProxies = new Map();

/**
 * Start a local HTTP proxy that forwards MCP requests with Bearer token.
 * Returns a Promise that resolves to the proxy URL once listening.
 */
function startMcpProxy(projectId, agentId, upstreamUrl, token) {
  const key = `${projectId}/${agentId}`;
  const existing = mcpProxies.get(key);
  if (existing) return Promise.resolve(`http://127.0.0.1:${existing.port}/mcp`);

  // #394 / quadwork#253: token is mutable so the 409 recovery path can
  // swap it via updateMcpProxyToken without rebinding the listener —
  // Codex was launched with a fixed proxy URL on an ephemeral port and
  // can't be told to use a new one mid-flight.
  const tokenRef = { current: token };
  return new Promise((resolve, reject) => {
    const proxyServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1`);
      const targetUrl = `${upstreamUrl}${parsedUrl.pathname}${parsedUrl.search}`;
      const headers = { ...req.headers, host: new URL(upstreamUrl).host };
      const tok = tokenRef.current;
      if (tok) {
        headers["authorization"] = `Bearer ${tok}`;
        headers["x-agent-token"] = tok;
      }
      delete headers["content-length"];

      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const proxyReq = (upstreamUrl.startsWith("https") ? require("https") : http).request(
          targetUrl,
          { method: req.method, headers: { ...headers, "content-length": body.length } },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        proxyReq.on("error", (err) => {
          res.writeHead(502);
          res.end(`Proxy error: ${err.message}`);
        });
        proxyReq.end(body);
      });
    });

    proxyServer.on("error", (err) => reject(err));
    proxyServer.listen(0, "127.0.0.1", () => {
      const port = proxyServer.address().port;
      mcpProxies.set(key, { server: proxyServer, port, tokenRef });
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

/**
 * Swap the bearer token of a running MCP proxy in place. Used by the
 * sub-D 409 recovery path: rebinding the listener would change the
 * ephemeral port and the running Codex process is pinned to the
 * original URL, so we mutate the closure-captured tokenRef instead.
 * Returns true if a proxy existed and was updated.
 */
function updateMcpProxyToken(projectId, agentId, newToken) {
  const key = `${projectId}/${agentId}`;
  const proxy = mcpProxies.get(key);
  if (!proxy || !proxy.tokenRef) return false;
  proxy.tokenRef.current = newToken;
  return true;
}

function stopMcpProxy(projectId, agentId) {
  const key = `${projectId}/${agentId}`;
  const proxy = mcpProxies.get(key);
  if (proxy) {
    try { proxy.server.close(); } catch {}
    mcpProxies.delete(key);
  }
}

// --- Permission bypass flags per CLI ---
const PERMISSION_FLAGS = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--yolo"],
  // #1023: grok's own docs recommend always-approve for automation. `--yolo`
  // is an alias for it; the long form is the documented spelling.
  grok: ["--always-approve"],
};

// --- MCP config generation & agent launch args ---

/**
 * Generate a per-agent MCP config file for Claude (--mcp-config).
 * Returns the absolute path to the written JSON file.
 */
/**
 * Per-agent registration tokens persisted across QuadWork restarts so
 * #242 stale-slot reclaim works after a crash. Without this the
 * in-memory _tokenCache is empty on startup and the family-name
 * deregister returns 403 (app.py:2123-2135).
 */
function _agentTokenPath(projectId, agentId) {
  const configDir = path.join(os.homedir(), ".quadwork", projectId);
  return path.join(configDir, `agent-token-${agentId}.txt`);
}

function readPersistedAgentToken(projectId, agentId) {
  try {
    return fs.readFileSync(_agentTokenPath(projectId, agentId), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writePersistedAgentToken(projectId, agentId, token) {
  try {
    const configDir = path.join(os.homedir(), ".quadwork", projectId);
    ensureSecureDir(configDir);
    writeSecureFile(_agentTokenPath(projectId, agentId), token);
  } catch {
    // non-fatal — stale-slot reclaim will degrade but registration still works
  }
}

function clearPersistedAgentToken(projectId, agentId) {
  try { fs.unlinkSync(_agentTokenPath(projectId, agentId)); } catch {}
}

function writeMcpConfigFile(projectId, agentId, mcpHttpPort, token) {
  const os = require("os");
  const configDir = path.join(os.homedir(), ".quadwork", projectId);
  ensureSecureDir(configDir);
  const filePath = path.join(configDir, `mcp-${agentId}.json`);
  const url = `http://127.0.0.1:${mcpHttpPort}/mcp`;
  const config = {
    mcpServers: {
      agentchattr: {
        type: "http",
        url,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
    },
  };
  writeSecureFile(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

function writeFileChatMcpConfig(projectId, agentId, serverPort) {
  const os = require("os");
  const crypto = require("crypto");
  const configDir = path.join(os.homedir(), ".quadwork", projectId);
  ensureSecureDir(configDir);
  const filePath = path.join(configDir, `mcp-${agentId}.json`);
  const shimPath = path.join(__dirname, "mcp-chat-shim.js");
  const token = crypto.randomBytes(16).toString("hex");
  fileChat.registerShimToken(projectId, agentId, token);
  const config = {
    mcpServers: {
      chat: {
        command: "node",
        args: [shimPath, "--project", projectId, "--agent", agentId, "--port", String(serverPort), "--token", token],
      },
    },
  };
  writeSecureFile(filePath, JSON.stringify(config, null, 2));
  return { filePath, token };
}

/**
 * #1023: exclude `.grok/` from git for an agent worktree.
 *
 * MUST resolve `git rev-parse --git-common-dir` against the agent cwd. The
 * command returns an ABSOLUTE path from a linked worktree but a RELATIVE `.git`
 * from a plain clone, and `resolveAgentCwd` returns whatever the operator put in
 * config.json — nothing forces it to be a worktree. Unresolved, a plain-clone
 * cwd would send the write to the SERVER process's repo, leaving the agent's
 * token-bearing .grok/ committable.
 *
 * The common dir (not `--git-dir`) is deliberate: QuadWork creates agent cwds
 * with `git worktree add`, so <cwd>/.git is a FILE (writing <cwd>/.git/info/…
 * throws ENOTDIR) and a per-worktree exclude is not honored.
 *
 * Append-if-absent: this file is SHARED by every agent worktree and
 * buildAgentArgs runs on every spawn and respawn, so a blind append would grow
 * it without bound.
 */
function excludeGrokFromGit(cwd) {
  let out;
  try {
    out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return; // not a git repo — nothing to exclude, and not fatal for spawn
  }
  if (!out) return;
  const infoDir = path.join(path.resolve(cwd, out), "info");
  const excludePath = path.join(infoDir, "exclude");
  let existing = "";
  try { existing = fs.readFileSync(excludePath, "utf-8"); } catch {}
  if (existing.split("\n").some((line) => line.trim() === ".grok/")) return;
  fs.mkdirSync(infoDir, { recursive: true });
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${sep}.grok/\n`);
}

/**
 * #1023: write the project-scoped MCP config Grok reads (<cwd>/.grok/config.toml)
 * and git-exclude it. Grok has no --mcp-config flag; native TOML is its only
 * "always on" MCP source (.mcp.json is silently disabled once the Claude import
 * prompt has been dismissed, so it is not a safe channel).
 *
 * Hand-written on purpose — five lines of fixed-shape output, so a TOML
 * dependency would be pure overhead. Values go through JSON.stringify: TOML
 * basic strings and JSON strings share quoting/escaping semantics over this
 * value domain (absolute paths, slug ids, a numeric port, a hex token).
 */
function writeGrokProjectConfig(projectId, agentId, cwd, serverPort) {
  const crypto = require("crypto");
  const grokDir = path.join(cwd, ".grok");
  ensureSecureDir(grokDir);
  const shimPath = path.join(__dirname, "mcp-chat-shim.js");
  const token = crypto.randomBytes(16).toString("hex");
  fileChat.registerShimToken(projectId, agentId, token);
  const args = [shimPath, "--project", projectId, "--agent", agentId, "--port", String(serverPort), "--token", token];
  const toml =
    "# Generated by QuadWork — do not edit. Regenerated on every agent spawn.\n" +
    "[mcp_servers.chat]\n" +
    'command = "node"\n' +
    `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
  const filePath = path.join(grokDir, "config.toml");
  writeSecureFile(filePath, toml);
  excludeGrokFromGit(cwd);
  return { filePath, token };
}

/**
 * Build extra launch args for an agent (permission flags + MCP injection).
 * Async because Codex proxy_flag mode needs to await proxy startup.
 */
async function buildAgentArgs(projectId, agentId) {
  const cfg = readConfig();
  const project = cfg.projects?.find((p) => p.id === projectId);
  if (!project) return { args: [] };

  const agentCfg = project.agents?.[agentId] || {};
  const command = agentCfg.command || "claude";
  const cliBase = command.split("/").pop().split(" ")[0];
  const args = [];

  // Permission bypass flags
  if (agentCfg.auto_approve !== false) {
    const flags = PERMISSION_FLAGS[cliBase];
    if (flags) args.push(...flags);
  }

  // #343: per-agent model + reasoning effort overrides. Persist in
  // project.agents[agentId].{model,reasoning_effort} via the
  // dashboard Agent Models widget. When unset, fall back to the
  // CLI's own default so existing projects without overrides keep
  // their current behavior.
  //
  // Codex: -c model="<slug>" / -c model_reasoning_effort="<level>"
  //   reasoning levels: minimal | low | medium | high (xhigh is
  //   deliberately NOT offered — it's the capacity-failure hot
  //   spot #343 was filed for).
  // Claude: --model <slug>
  //   reasoning_effort is not wired for Claude — Anthropic's CLI
  //   doesn't expose an equivalent flag.
  // Gemini: --model <slug> (the Gemini CLI's -m / --model flag)
  //   reasoning_effort has no Gemini equivalent — model only.
  // Grok: --model <slug> (the Grok CLI's -m / --model flag)
  //   #1023: reasoning_effort is deliberately not wired (the CLI supports
  //   --reasoning-effort; deferred until requested — model-only, like gemini).
  if (cliBase === "codex") {
    if (agentCfg.model && typeof agentCfg.model === "string") {
      args.push("-c", `model="${agentCfg.model}"`);
    }
    if (agentCfg.reasoning_effort && typeof agentCfg.reasoning_effort === "string") {
      args.push("-c", `model_reasoning_effort="${agentCfg.reasoning_effort}"`);
    }
  } else if (cliBase === "claude") {
    if (agentCfg.model && typeof agentCfg.model === "string") {
      args.push("--model", agentCfg.model);
    }
  } else if (cliBase === "gemini") {
    if (agentCfg.model && typeof agentCfg.model === "string") {
      args.push("--model", agentCfg.model);
    }
  } else if (cliBase === "grok") {
    if (agentCfg.model && typeof agentCfg.model === "string") {
      args.push("--model", agentCfg.model);
    }
  }

  // MCP config injection — file-chat shim
  const injectMode = agentCfg.mcp_inject || injectModeForCommand(command);
  if (injectMode === "flag") {
    const { filePath: mcpConfigPath } = writeFileChatMcpConfig(projectId, agentId, PORT);
    const mcpFlag = agentCfg.mcp_flag || "--mcp-config";
    args.push(mcpFlag, mcpConfigPath);
  } else if (injectMode === "proxy_flag") {
    const { token: shimToken } = writeFileChatMcpConfig(projectId, agentId, PORT);
    const shimPath = path.join(__dirname, "mcp-chat-shim.js");
    args.push(
      "-c", `mcp_servers.chat.command="node"`,
      "-c", `mcp_servers.chat.args=["${shimPath}","--project","${projectId}","--agent","${agentId}","--port","${PORT}","--token","${shimToken}"]`,
    );
  } else if (injectMode === "project_toml") {
    // #1023: grok has no MCP flag — the config is a file in the agent's own
    // worktree. `--trust` grants the folder trust that gates repo-local MCP
    // servers from actually running (verified: without it `grok inspect`
    // reports "Project trusted: no" and the server is listed but inert).
    //
    // resolveAgentCwd returns null for an agent config with no cwd. Production
    // always has one — spawnAgentPty hard-fails otherwise — so this guard only
    // keeps arg-building from throwing on a partial config.
    const grokCwd = resolveAgentCwd(projectId, agentId);
    if (grokCwd) {
      writeGrokProjectConfig(projectId, agentId, grokCwd, PORT);
      args.push("--trust");
    }
  }
  // env mode (Gemini) handled in buildAgentEnv
  return { args };
}

/**
 * Build extra env vars for an agent (MCP injection via env for Gemini).
 */
function buildAgentEnv(projectId, agentId) {
  const cfg = readConfig();
  const project = cfg.projects?.find((p) => p.id === projectId);
  if (!project) return {};

  const agentCfg = project.agents?.[agentId] || {};
  const command = agentCfg.command || "claude";
  const cliBase = command.split("/").pop().split(" ")[0];
  const env = {};

  // Gemini: inject MCP via env var
  if (cliBase === "gemini") {
    const os = require("os");
    const configDir = path.join(os.homedir(), ".quadwork", projectId);
    ensureSecureDir(configDir);
    const settingsPath = path.join(configDir, `mcp-${agentId}-settings.json`);

    const { token: shimToken } = writeFileChatMcpConfig(projectId, agentId, PORT);
    const shimPath = path.join(__dirname, "mcp-chat-shim.js");
    const settings = {
      mcpServers: {
        chat: {
          command: "node",
          args: [shimPath, "--project", projectId, "--agent", agentId, "--port", String(PORT), "--token", shimToken],
        },
      },
    };
    writeSecureFile(settingsPath, JSON.stringify(settings, null, 2));
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
  }

  return env;
}

// Helper: spawn a PTY for a project/agent and register in agentSessions
async function spawnAgentPty(project, agent, opts = {}) {
  const key = `${project}/${agent}`;

  const cwd = resolveAgentCwd(project, agent);
  if (!cwd) return { ok: false, error: `Unknown agent: ${key}` };

  const command = resolveAgentCommand(project, agent) || (process.env.SHELL || "/bin/zsh");
  const extraEnv = buildAgentEnv(project, agent);

  try {
    // #565: buildAgentArgs is inside try-catch so registration failures
    // cannot crash the server as an unhandled rejection.
    const built = await buildAgentArgs(project, agent);
    const args = built.args;

    const term = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, ...extraEnv },
    });

    const session = {
      projectId: project,
      agentId: agent,
      term,
      viewers: new Set(),
      viewerDims: new Map(),
      lastDims: null,
      state: "running",
      error: null,
      // #1010: explicit backend identity for the session. The PTY dispatcher
      // gates its bounded deferred-wake cap on this — Claude only, because only
      // the Claude TUI repaints continuously while idle. Derived with the same
      // helper the spawn/arg paths use, so "claude", "/usr/bin/claude" and
      // "claude --foo" all resolve to "claude".
      backend: cliBaseFromCommand(command),
      lastOutputAt: Date.now(),
      // #418: ring buffer of recent PTY output so reconnecting WS
      // clients see the terminal state instead of a blank panel.
      // #538: scrollback is scrubbed of likely secrets before replay.
      scrollback: Buffer.alloc(0),
    };
    agentSessions.set(key, session);

    if (!opts.suppressLifecycleMsg) {
      emitSystemMessage(project, `${agent} joined`);
    }

    // #418: capture PTY output into the scrollback ring buffer (64KB).
    // This runs independently of WS — even when no client is connected,
    // the buffer accumulates so the next connect gets replay.
    const SCROLLBACK_SIZE = 64 * 1024;
    term.onData((data) => {
      session.lastOutputAt = Date.now();
      const chunk = Buffer.from(data);
      session.scrollback = Buffer.concat([session.scrollback, chunk]);
      if (session.scrollback.length > SCROLLBACK_SIZE) {
        session.scrollback = session.scrollback.slice(-SCROLLBACK_SIZE);
      }

      // #797: observe-only self-heal detector. Wrapped in its own try/catch so
      // a detector bug can never break the PTY → xterm pipeline; the chunk is
      // never consumed or altered (the WS viewer forwards it independently).
      try {
        selfHeal.observeChunk(key, data, {
          now: Date.now(),
          recovering: !!session._autoRecovering,
          onRestart: () => {
            session._autoRecovering = true;
            console.log(`[self-heal] ${key}: thinking-block 400 detected — restarting session`);
            // #825: NO clearSelfHeal here — the breaker window must persist
            // across auto-restarts so repeated trips can pause auto-recovery.
            restartAgentSession(key, { reason: "thinking-block-400" })
              .then((result) => {
                if (result && result.ok) {
                  emitSystemMessage(project, `${agent} auto-restarted (recovered from thinking-block API error)`);
                }
              })
              .catch((err) => console.error(`[self-heal] ${key}: auto-restart failed:`, err.message))
              .finally(() => {
                const s = agentSessions.get(key);
                if (s) s._autoRecovering = false;
              });
          },
          onBreaker: (message) => {
            console.log(`[self-heal] ${key}: ${message}`);
            emitSystemMessage(project, message);
          },
        });
      } catch (err) {
        console.error(`[self-heal] ${key}: detector error (ignored):`, err.message);
      }
    });

    term.onExit(({ exitCode }) => {
      const current = agentSessions.get(key);
      if (current && current.term === term) {
        markSessionExited(key, current, exitCode);
      }
    });

    return { ok: true, pid: term.pid };
  } catch (err) {
    agentSessions.set(key, { projectId: project, agentId: agent, term: null, viewers: new Set(), viewerDims: new Map(), lastDims: null, state: "error", error: err.message });
    return { ok: false, error: err.message };
  }
}

// #910: mark a session whose CLI process exited on its own (clean exit OR
// crash) as stopped, and flag it `exitedUnexpectedly` so the watchdog will
// auto-respawn it for a non-idle project. Shared by term.onExit and the
// watchdog liveness probe (which catches the case where onExit never fired and
// the dashboard was left showing a stale `running`).
function markSessionExited(key, session, exitCode) {
  cleanupPtyDispatcher(key);
  session.state = "stopped";
  session.error = exitCode ? `exit:${exitCode}` : null;
  session.term = null;
  session.exitedUnexpectedly = true;
  for (const v of session.viewers) {
    if (v.readyState <= 1) v.close(1000, `exited:${exitCode == null ? "" : exitCode}`);
  }
  session.viewers.clear();
}

// #910: is the PTY's child process still alive? signal 0 probes without
// delivering a signal: ESRCH → gone, EPERM → alive but not ours. A session can
// read `running` while its process is already dead if onExit didn't fire; this
// is how the watchdog detects that and clears the stale state.
function isPtyAlive(term) {
  if (!term || typeof term.pid !== "number") return false;
  try {
    process.kill(term.pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

async function stopAgentSession(key, { clearSelfHeal = false } = {}) {
  // #825 (#797 follow-up): a MANUAL stop/restart/reset must reset the per-agent
  // self-heal circuit-breaker window, so a fresh operator-driven session isn't
  // suppressed by a stale "paused" state from a prior trip. This is gated:
  // the auto-restart path (restartAgentSession with reason "thinking-block-400")
  // leaves clearSelfHeal=false, because clearing on every auto-restart would
  // reset countInWindow each time and defeat the #797 breaker entirely. Cleared
  // before the session lookup so a manual stop resets the window even when no
  // live session remains (e.g. the agent already exited).
  if (clearSelfHeal) selfHeal.clearState(key);
  const session = agentSessions.get(key);
  if (!session) {
    agentSessions.set(key, { projectId: null, agentId: null, term: null, viewers: new Set(), viewerDims: new Map(), lastDims: null, state: "stopped", error: null });
    return;
  }
  if (session.projectId && session.agentId && !session._suppressLifecycleMsg) {
    emitSystemMessage(session.projectId, `${session.agentId} left`);
  }
  cleanupPtyDispatcher(key);
  if (session.term) {
    try { session.term.kill(); } catch {}
    session.term = null;
  }
  for (const v of session.viewers) {
    if (v.readyState <= 1) v.close(1000, "stopped");
  }
  session.viewers.clear();
  session.state = "stopped";
  session.error = null;
  // #910: a manual stop is intentional — do NOT let the watchdog respawn it.
  session.exitedUnexpectedly = false;
  const [projectId, agentId] = key.split("/");
  if (projectId && agentId) stopMcpProxy(projectId, agentId);
  // #957: teardown is a known-safe moment to sweep stale backend temp. It's
  // deferred (setImmediate) so it never blocks the stop path, and stale-only,
  // so it never touches files a still-live agent on the shared /tmp/claude-{uid}
  // is using. This only reads a session's OWN temp when that session is gone.
  setImmediate(backendTempSweepTick);
}

// #957: sweep stale backend temp entries (/tmp/claude-{uid}, stray gemini
// crash dumps). On hosts where /tmp has a per-user quota, unbounded Claude
// temp eventually exhausts it and every Claude bash call fails silently with
// exit 1 — see issue #957 for the full post-mortem. Runs on agent teardown and
// on an hourly timer; opt-out / age via config.json
// `temp_cleanup: { enabled, max_age_hours }`. The reentrancy guard stops a
// teardown-triggered sweep from overlapping the periodic one.
let _tempSweepRunning = false;
function backendTempSweepTick() {
  if (_tempSweepRunning) return;
  _tempSweepRunning = true;
  try {
    const settings = tempCleanup.cleanupSettings(readConfig());
    if (!settings.enabled) return;
    const r = tempCleanup.sweepBackendTemp({ maxAgeHours: settings.maxAgeHours });
    if (r.removed.length > 0) {
      console.log(`[temp-cleanup] removed ${r.removed.length} stale entr${r.removed.length === 1 ? "y" : "ies"} (kept ${r.kept})`);
    }
    for (const e of r.errors) console.error(`[temp-cleanup] ${e}`);
  } catch (err) {
    console.error(`[temp-cleanup] sweep failed: ${err.message}`);
  } finally {
    _tempSweepRunning = false;
  }
}

app.get("/api/agents", (_req, res) => {
  const agents = {};
  for (const [key, session] of agentSessions) {
    agents[key] = { state: session.state, error: session.error || null };
  }
  res.json(agents);
});

// Per-project AgentChattr lifecycle (removed in #723 — AC stack deleted)

// Stub endpoints — return 410 Gone so dashboard code degrades gracefully
async function handleAgentChattr(_req, res) {
  return res.status(410).json({ ok: false, error: "AgentChattr removed in Phase 3" });
}
app.post("/api/agents/:project/reset", async (req, res) => {
  const projectId = req.params.project;

  // #417: Reset Agents now stops and respawns all agent sessions for
  // the project. Uses the configured agent list from config.json so
  // agents missing from agentSessions (e.g. after a crash or prior
  // stop) are still brought back. The old implementation only
  // deregistered AC slots, which fails with stale tokens after an AC
  // crash and doesn't restart the agent processes.
  try {
    // Build the full agent set: start with configured agents, then
    // merge any tracked sessions that might use a different key.
    const cfg = readConfig();
    const project = cfg.projects?.find((p) => p.id === projectId);
    const configuredAgents = project?.agents ? Object.keys(project.agents) : [];

    // Also include any live sessions not in the config (defensive)
    const sessionAgentIds = new Set();
    for (const [key] of agentSessions) {
      if (key.startsWith(`${projectId}/`)) {
        sessionAgentIds.add(key.split("/")[1]);
      }
    }
    const allAgentIds = [...new Set([...configuredAgents, ...sessionAgentIds])];

    if (allAgentIds.length === 0) {
      return res.json({ ok: true, restarted: 0, total: 0, message: "No agents configured" });
    }

    // Stop all agents first (handles deregistration best-effort)
    for (const agentId of allAgentIds) {
      const s = agentSessions.get(`${projectId}/${agentId}`);
      if (s) s._suppressLifecycleMsg = true;
      await stopAgentSession(`${projectId}/${agentId}`, { clearSelfHeal: true }); // #825: manual reset resets the self-heal window
    }

    // Respawn all agents with fresh MCP tokens
    let restarted = 0;
    const errors = [];
    for (const agentId of allAgentIds) {
      const result = await spawnAgentPty(projectId, agentId, { suppressLifecycleMsg: true });
      if (result.ok) {
        emitSystemMessage(projectId, `${agentId} restarted`);
        restarted++;
      } else {
        errors.push(`${agentId}: ${result.error}`);
      }
    }

    res.json({
      ok: restarted > 0,
      restarted,
      total: allAgentIds.length,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Full Reset: restart all agents across all projects (#657) ---

app.post("/api/full-reset", async (_req, res) => {
  const start = Date.now();
  console.log("[full-reset] starting...");
  try {
    const cfg = readConfig();
    const projects = (cfg.projects || []).filter((p) => !p.archived);

    console.log("[full-reset] stopping all agent sessions...");
    const sessionKeys = [...agentSessions.keys()];
    for (const key of sessionKeys) {
      await stopAgentSession(key, { clearSelfHeal: true }); // #825: manual full-reset resets the self-heal window
    }

    console.log("[full-reset] stopping Butler...");
    stopButlerPty();

    console.log("[full-reset] running startup migrations...");
    runStartupMigrations(cfg);

    let totalAgents = 0;
    const errors = [];
    for (const project of projects) {
      try {
        const resetResp = await fetch(`http://127.0.0.1:${PORT}/api/agents/${encodeURIComponent(project.id)}/reset`, {
          method: "POST",
        });
        const resetData = await resetResp.json();
        if (resetData.ok) {
          totalAgents += resetData.restarted;
        } else {
          errors.push(`${project.id}: agent reset failed`);
        }
      } catch (err) {
        errors.push(`${project.id}: agent reset — ${err.message}`);
      }
    }

    if (cfg.butler?.enabled) {
      console.log("[full-reset] restarting Butler...");
      const result = spawnButlerPty();
      if (!result.ok) errors.push(`butler: ${result.error}`);
    }

    const duration = Date.now() - start;
    console.log(`[full-reset] complete in ${duration}ms — ${projects.length} projects, ${totalAgents} agents`);
    res.json({
      ok: errors.length === 0,
      projects: projects.length,
      agents: totalAgents,
      duration_ms: duration,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (err) {
    console.error(`[full-reset] failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Lifecycle: start spawns PTY (visible in terminal panel) ---

app.post("/api/agents/:project/:agent/start", async (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;

  const existing = agentSessions.get(key);
  if (existing && existing.state === "running" && existing.term) {
    return res.json({ ok: true, state: "running", message: "Already running" });
  }

  const result = await spawnAgentPty(project, agent);
  if (result.ok) {
    res.json({ ok: true, state: "running", pid: result.pid });
  } else {
    res.status(result.error?.includes("Unknown") ? 400 : 500).json({ ok: false, state: "error", error: result.error });
  }
});

// --- Lifecycle: stop kills PTY + closes WS ---

app.post("/api/agents/:project/:agent/stop", async (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;
  await stopAgentSession(key, { clearSelfHeal: true }); // #825: manual stop resets the self-heal window
  res.json({ ok: true, state: "stopped" });
});

// --- Lifecycle: restart ---

// #797: shared restart sequence, used by both the manual restart route and
// the self-heal detector. Exactly the prior route body — no new lifecycle
// logic. The `reason` is informational (logged by callers).
async function restartAgentSession(key, { reason, clearSelfHeal = false } = {}) {
  const [project, agent] = key.split("/");
  console.log(`[restart] ${key}: restarting session (reason: ${reason || "unspecified"})`);

  // #241: must await deregister before respawn so the slot frees and
  // the fresh register lands at slot 1 instead of head-2.
  const existing = agentSessions.get(key);
  if (existing) existing._suppressLifecycleMsg = true;
  // #825: forward clearSelfHeal — a manual restart resets the breaker window;
  // the self-heal auto-restart does NOT (preserves the #797 circuit breaker).
  await stopAgentSession(key, { clearSelfHeal });

  return spawnAgentPty(project, agent, { suppressLifecycleMsg: true });
}

app.post("/api/agents/:project/:agent/restart", async (req, res) => {
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;

  const result = await restartAgentSession(key, { reason: "manual", clearSelfHeal: true }); // #825
  if (result.ok) {
    emitSystemMessage(project, `${agent} restarted`);
    res.json({ ok: true, state: "running", pid: result.pid });
  } else {
    res.status(500).json({ ok: false, state: "error", error: result.error });
  }
});

// --- #706: Manual interrupt — send Ctrl+C to agent PTY ---

app.post("/api/agents/:project/:agent/interrupt", (req, res) => {
  if (!requireSessionToken(req, res)) return; // #968
  const key = `${req.params.project}/${req.params.agent}`;
  const session = agentSessions.get(key);
  if (!session || !session.term) {
    return res.json({ ok: false, error: "Agent not running" });
  }
  safeWrite(session.term, "\x03");
  console.log(`[interrupt] ${key}: operator sent Ctrl+C`);
  res.json({ ok: true });
});

app.post("/api/agents/:project/interrupt-all", (req, res) => {
  if (!requireSessionToken(req, res)) return; // #968
  const { project } = req.params;
  let count = 0;
  for (const [key, session] of agentSessions) {
    if (!key.startsWith(`${project}/`)) continue;
    if (session.state !== "running" || !session.term) continue;
    safeWrite(session.term, "\x03");
    count++;
  }
  console.log(`[interrupt] ${project}: operator sent Ctrl+C to ${count} agent(s)`);
  res.json({ ok: true, interrupted: count });
});

// --- Sessions tracking (for /api/projects dashboard) ---

// Expose agentSessions to migrated routes
app.set("activeSessions", agentSessions);

app.get("/api/sessions", (_req, res) => {
  const sessions = [];
  for (const [, info] of agentSessions) {
    if (info.state === "running") {
      sessions.push({ projectId: info.projectId, agentId: info.agentId });
    }
  }
  res.json(sessions);
});

// --- Write to active PTY session ---

app.post("/api/agents/:project/:agent/write", (req, res) => {
  if (!requireSessionToken(req, res)) return; // #968
  const { project, agent } = req.params;
  const key = `${project}/${agent}`;
  const session = agentSessions.get(key);

  if (!session || !session.term) {
    return res.status(404).json({ ok: false, error: "No active terminal session" });
  }

  const { text } = req.body || {};
  if (!text) {
    return res.status(400).json({ ok: false, error: "Missing text" });
  }

  try {
    // #968 (C2): route through safeWrite so a write to a just-exited PTY
    // surfaces EIO as a clean 409 instead of an unhandled 500.
    const ok = safeWrite(session.term, text);
    if (!ok) return res.status(409).json({ ok: false, error: "PTY not writable (exited)" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Butler agent (#631) ---

function spawnButlerPty() {
  if (butlerSession.term) return { ok: true, pid: butlerSession.term.pid };

  try {
    const cfg = readConfig();
    const butlerCfg = cfg.butler || {};
    const cwdRaw = butlerCfg.cwd || "~/docs/";
    const docsDir = cwdRaw.startsWith("~/") ? path.join(os.homedir(), cwdRaw.slice(2)) : cwdRaw;
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true, mode: 0o700 });
    }

    const command = butlerCfg.command || "claude";
    const args = [];
    if (butlerCfg.model) args.push("--model", butlerCfg.model);
    if (butlerCfg.auto_approve !== false) {
      const flags = PERMISSION_FLAGS[command] || [];
      args.push(...flags);
    }

    // #975: the old pre-trust ran `claude -p "echo ok"` synchronously with a
    // 15s timeout on the event loop — a hung claude blackholed every agent's
    // WS/HTTP/timers for up to 15s. Dropped: the interactive trust prompt is
    // already auto-answered by the onData trust-listener installed below (the
    // same mechanism the agent PTYs rely on), so no synchronous pre-trust is
    // needed to reach a trusted session.

    const seedPath = path.join(__dirname, "..", "templates", "seeds", "butler.CLAUDE.md");
    const claudePath = path.join(docsDir, "CLAUDE.md");
    if (!fs.existsSync(claudePath)) {
      const legacyPath = path.join(docsDir, "AGENTS.md");
      if (fs.existsSync(legacyPath)) {
        fs.copyFileSync(legacyPath, claudePath);
      } else if (fs.existsSync(seedPath)) {
        fs.copyFileSync(seedPath, claudePath);
      }
    }

    // #635: seed README.md explaining ~/docs/ folder purpose
    const readmePath = path.join(docsDir, "README.md");
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, [
        "# ~/docs/",
        "",
        "Butler's working directory — cross-project operator notes and artifacts.",
        "Not git-tracked; operator-local.",
        "",
        "## File types",
        "",
        "| Prefix | Purpose |",
        "|--------|---------|",
        "| `PROPOSAL-<name>.md` | Feature proposals with phases and operator gates |",
        "| `REVIEW-<batch>.md` | PR review summaries |",
        "| `INFO-<topic>.md` | Research notes |",
        "| `PROGRESS-<project>.md` | Per-project progress (one file per project) |",
        "",
      ].join("\n"));
    }

    const term = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: docsDir,
      env: { ...process.env },
    });

    butlerSession = {
      term,
      viewers: new Set(),
      viewerDims: new Map(),
      lastDims: null,
      state: "running",
      error: null,
      scrollback: Buffer.alloc(0),
      command,
      model: butlerCfg.model || "",
    };

    const SCROLLBACK_SIZE = 64 * 1024;
    term.onData((data) => {
      const chunk = Buffer.from(data);
      butlerSession.scrollback = Buffer.concat([butlerSession.scrollback, chunk]);
      if (butlerSession.scrollback.length > SCROLLBACK_SIZE) {
        butlerSession.scrollback = butlerSession.scrollback.slice(-SCROLLBACK_SIZE);
      }
    });

    // Auto-answer Claude's trust prompt if it appears within the first 10s
    if (command === "claude") {
      let trustHandled = false;
      const trustListener = term.onData((data) => {
        if (trustHandled) return;
        if (data.includes("trust") || data.includes("Yes,") || data.includes("1.")) {
          setTimeout(() => {
            if (!trustHandled && butlerSession.term === term) {
              safeWrite(term, "1\r");
              trustHandled = true;
            }
          }, 500);
        }
      });
      setTimeout(() => { trustListener.dispose(); trustHandled = true; }, 10000);
    }

    term.onExit(({ exitCode }) => {
      if (butlerSession.term === term) {
        butlerSession.state = "stopped";
        butlerSession.error = exitCode ? `exit:${exitCode}` : null;
        butlerSession.term = null;
        for (const v of butlerSession.viewers) {
          if (v.readyState <= 1) v.close(1000, `exited:${exitCode}`);
        }
        butlerSession.viewers.clear();
      }
    });

    console.log(`[butler] spawned (PID: ${term.pid}, cwd: ${docsDir})`);
    return { ok: true, pid: term.pid };
  } catch (err) {
    butlerSession = { term: null, viewers: new Set(), viewerDims: new Map(), lastDims: null, state: "error", error: err.message, scrollback: Buffer.alloc(0) };
    return { ok: false, error: err.message };
  }
}

function stopButlerPty() {
  if (butlerSession.term) {
    try { butlerSession.term.kill(); } catch {}
    butlerSession.term = null;
  }
  for (const v of butlerSession.viewers) {
    if (v.readyState <= 1) v.close(1000, "stopped");
  }
  butlerSession = { term: null, viewers: new Set(), viewerDims: new Map(), lastDims: null, state: "stopped", error: null, scrollback: Buffer.alloc(0) };
}

app.post("/api/butler/start", (_req, res) => {
  const result = spawnButlerPty();
  if (result.ok) {
    try {
      const cfg = readConfig();
      cfg.butler = { ...cfg.butler, enabled: true };
      writeConfig(cfg);
    } catch {}
  }
  res.json(result);
});

app.post("/api/butler/stop", (_req, res) => {
  stopButlerPty();
  try {
    const cfg = readConfig();
    cfg.butler = { ...cfg.butler, enabled: false };
    writeConfig(cfg);
  } catch {}
  res.json({ ok: true });
});

app.get("/api/butler/status", (_req, res) => {
  const running = butlerSession.state === "running" && !!butlerSession.term;
  res.json({
    running,
    pid: butlerSession.term ? butlerSession.term.pid : null,
    command: running ? butlerSession.command : undefined,
    model: running ? butlerSession.model : undefined,
  });
});

// --- Scheduled Triggers ---

const triggers = new Map();

const DEFAULT_MESSAGE = `@head @re1 @re2 @dev — Queue check.
Discovery: read GITHUB.md (or GET /api/github-parsed) for issue/PR state instead of running gh. If GITHUB.md is absent or stale (>2 cycles / _stale), do ONE direct gh read to confirm. GITHUB.md may lag — confirm with a direct gh read before any merge/review decision.
Head: Merge any PR with both current-revision approvals, assign next from queue.
Dev: Work on assigned ticket or address review feedback.
RE1/RE2: Review ONLY PRs you were @mentioned on in this chat (not all open PRs). If Dev pushed fixes, re-review. Post verdict on PR AND notify here.
ALL: If nothing is assigned or pending for you, no-op quietly. Communicate via this chat by tagging agents. Your terminal is NOT visible.`;

// #518: server-side bridge lifecycle helpers. Stop and start Telegram +
// Discord bridges so they respond to batch transitions even when the
// operator is on a different project page.

async function autoStopBridges(projectId, project, qwPort) {
  if (project?.telegram_auto) {
    try {
      await fetch(`http://127.0.0.1:${qwPort}/api/telegram?action=stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[auto-bridge] ${projectId}: telegram bridge auto-stopped`);
    } catch { /* non-fatal */ }
  }
  if (project?.discord_auto) {
    try {
      await fetch(`http://127.0.0.1:${qwPort}/api/discord?action=stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[auto-bridge] ${projectId}: discord bridge auto-stopped`);
    } catch { /* non-fatal */ }
  }
}

async function autoStartBridges(projectId, project, qwPort) {
  if (project?.telegram_auto) {
    try {
      // Check if already running before starting
      const st = await fetch(
        `http://127.0.0.1:${qwPort}/api/telegram?project=${encodeURIComponent(projectId)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (st.ok) {
        const data = await st.json();
        if (data.running) return; // already running
        if (!data.configured) return; // not configured — can't start
      }
      await fetch(`http://127.0.0.1:${qwPort}/api/telegram?action=start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[auto-bridge] ${projectId}: telegram bridge auto-started`);
    } catch { /* non-fatal */ }
  }
  if (project?.discord_auto) {
    try {
      const st = await fetch(
        `http://127.0.0.1:${qwPort}/api/discord?project=${encodeURIComponent(projectId)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (st.ok) {
        const data = await st.json();
        if (data.running) return;
        if (!data.configured) return;
      }
      await fetch(`http://127.0.0.1:${qwPort}/api/discord?action=start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[auto-bridge] ${projectId}: discord bridge auto-started`);
    } catch { /* non-fatal */ }
  }
}

// Track previous batch state per project for bridge auto-start detection
const _bridgeBatchPrev = new Map();

async function sendTriggerMessage(projectId) {
  const cfg = readConfig();
  const project = cfg.projects && cfg.projects.find((p) => p.id === projectId);

  // #516: server-side auto-stop — check batch progress before sending.
  // When trigger_auto is enabled, skip the message and stop the trigger
  // (plus caffeinate) if the batch is already complete. This covers the
  // case where the operator is on a different page and the client-side
  // ScheduledTriggerWidget is not mounted to detect completion.
  if (project && project.trigger_auto) {
    const qwPort = cfg.port || 8400;
    try {
      const bpRes = await fetch(
        `http://127.0.0.1:${qwPort}/api/batch-progress?project=${encodeURIComponent(projectId)}`
      );
      if (bpRes.ok) {
        const bp = await bpRes.json();
        // #810: gate auto-stop on completeConfirmed (two distinct successful
        // fetch cycles), NOT a single transient/stale `complete`.
        // #864: also auto-stop on an explicit operator clear (`liveActiveBatchCleared`).
        // The preserved snapshot may keep `items` non-empty / `complete` mixed, so
        // `completeConfirmed` alone won't fire when items don't all resolve as
        // merged/closed (e.g. a duplicate unmerged PR). The cleared flag is the
        // operator's intent and overrides those signals for lifecycle purposes.
        const clearedByOperator = !!(bp && bp.liveActiveBatchCleared);
        if (bp && (bp.completeConfirmed || clearedByOperator)) {
          console.log(`[auto-trigger] ${projectId}: batch ${clearedByOperator ? "cleared by operator" : "complete (confirmed)"}, auto-stopped`);
          stopTrigger(projectId);
          // Also stop caffeinate if no other triggers remain running
          // (#441 companion fix). caffeinateProcess is global (not
          // project-scoped), so only kill it when all work is done.
          if (caffeinateProcess.process && triggers.size === 0) {
            try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
            caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
            console.log(`[auto-trigger] ${projectId}: caffeinate auto-stopped (no active triggers remain)`);
          }
          // #518: also stop bridges when batch completes
          // #542: transition guard — only stop if not already stopped for this completion
          const prev = _bridgeBatchPrev.get(projectId);
          _bridgeBatchPrev.set(projectId, { complete: true, hasItems: !!(bp.items && bp.items.length) });
          if (!prev || !prev.complete) {
            await autoStopBridges(projectId, project, qwPort);
          }
          return;
        }
      }
    } catch (err) {
      // Non-fatal — if batch-progress fails, proceed with the message
      console.error(`[auto-trigger] ${projectId}: batch-progress check failed:`, err.message);
    }
  }

  const message = (project && project.trigger_message) || DEFAULT_MESSAGE;

  // #401 / quadwork#277: route trigger sends through the local
  // /api/chat path that already works for the chat panel. The old
  // direct /api/send call required a registration token (not the
  // session token we have on hand) and 401'd silently — agents never
  // saw the queue-check pulse. /api/chat opens the AC ws with the
  // session token and inherits the #230 token-resync-on-401 retry,
  // so the trigger now gets the same proven path as the chat panel.
  const qwPort = cfg.port || 8400;
  const url = `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}`;

  const info = triggers.get(projectId);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, channel: "general" }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error(`Trigger send failed for ${projectId}: ${res.status} ${err}`);
      if (info) info.lastError = `${res.status}: ${err.slice(0, 100)}`;
    } else {
      if (info) info.lastError = null;
    }
  } catch (err) {
    console.error(`Trigger send error for ${projectId}:`, err.message);
    if (info) info.lastError = err.message;
  }

  if (info) {
    info.lastSent = Date.now();
    info.nextAt = Date.now() + info.interval;
  }
}

app.get("/api/triggers", (_req, res) => {
  const result = {};
  // Include active runtime triggers first.
  for (const [id, info] of triggers) {
    result[id] = {
      enabled: true,
      interval: info.interval,
      lastSent: info.lastSent,
      nextAt: info.nextAt,
      lastError: info.lastError || null,
      expiresAt: info.expiresAt || null,
      message: null,        // filled in below from config
      intervalMin: null,    // filled in below — last-used interval in minutes
      durationMin: null,    // filled in below — last-used duration in minutes
    };
  }
  // Enrich with the persisted message AND last-used interval/duration
  // for every project in config.json — even projects that don't
  // currently have a running trigger. The Scheduled Trigger widget
  // (#210) hydrates all three controls from this on page reload.
  try {
    const cfg = readConfig();
    for (const p of (cfg.projects || [])) {
      const msg = typeof p.trigger_message === "string" ? p.trigger_message : null;
      const intervalMin = Number.isFinite(p.trigger_interval_min) ? p.trigger_interval_min : null;
      const durationMin = Number.isFinite(p.trigger_duration_min) ? p.trigger_duration_min : null;
      const existing = result[p.id];
      if (existing) {
        existing.message = msg;
        existing.intervalMin = intervalMin;
        existing.durationMin = durationMin;
      } else if (msg !== null || intervalMin !== null || durationMin !== null) {
        result[p.id] = {
          enabled: false,
          interval: intervalMin !== null ? intervalMin * 60 * 1000 : 0,
          lastSent: null,
          nextAt: null,
          lastError: null,
          expiresAt: null,
          message: msg,
          intervalMin,
          durationMin,
        };
      }
    }
  } catch { /* non-fatal */ }
  res.json(result);
});

// #812: a parked (idle) project gets no trigger starts/pulses. Read
// the live config so a config-write that sets idle takes effect at once.
function isProjectIdleId(projectId) {
  try { return !!readConfig().projects?.find((p) => p.id === projectId)?.idle; }
  catch { return false; }
}

function stopTrigger(project) {
  const existing = triggers.get(project);
  if (existing) {
    if (existing.timer) clearInterval(existing.timer);
    if (existing.durationTimer) clearTimeout(existing.durationTimer);
  }
  triggers.delete(project);
}

app.post("/api/triggers/:project/start", (req, res) => {
  const { project } = req.params;
  // #812: refuse to start a trigger for a parked (idle) project — no
  // timer created, no agents pulsed. Toggle the project off idle first.
  if (isProjectIdleId(project)) {
    return res.json({ ok: false, idle: true, enabled: false });
  }
  // #418 / quadwork#306: sendImmediately was an always-true
  // send-and-start flag from the original #210 button; operators
  // asked for a pure scheduler (the button is now just "Start
  // Trigger" — wait for the first interval). The field is
  // ignored here; the send-now endpoint below still exists for
  // the explicit one-shot path.
  const { interval, duration, message } = req.body || {};
  const ms = (interval || 30) * 60 * 1000;
  const durationMs = duration ? duration * 60 * 1000 : 0; // duration in minutes, 0 = indefinite

  // #210: persist the custom message AND the last-used interval +
  // duration on the project entry so reopening an idle project
  // pre-fills all three controls from the saved state (not just the
  // message). Without persisting interval/duration, the widget
  // would snap back to its defaults (15 min / 3 hr) after every
  // reload even if the operator had picked something else.
  try {
    const cfg = readConfig();
    const entry = (cfg.projects || []).find((p) => p.id === project);
    if (entry) {
      if (typeof message === "string" && message.length > 0) entry.trigger_message = message;
      if (Number.isFinite(interval) && interval > 0) entry.trigger_interval_min = interval;
      if (Number.isFinite(duration) && duration >= 0) entry.trigger_duration_min = duration;
      writeConfig(cfg);
    }
  } catch (e) { /* non-fatal — timer still runs with its in-memory values */ }

  const existing = triggers.get(project);
  if (existing) {
    if (existing.timer) clearInterval(existing.timer);
    if (existing.durationTimer) clearTimeout(existing.durationTimer);
  }

  // #418 / quadwork#306: no immediate fire — the first send happens
  // at T + interval via the setInterval below. Operators set the
  // trigger up in advance of going afk and don't want it interrupting
  // whatever agents are currently mid-task. The explicit "send now"
  // path still lives at /api/triggers/:project/send-now for the
  // rare case an operator actually wants to kick things off.
  const timer = setInterval(() => sendTriggerMessage(project), ms);
  const expiresAt = durationMs > 0 ? Date.now() + durationMs : null;

  const triggerInfo = {
    interval: ms,
    timer,
    lastSent: null,
    nextAt: Date.now() + ms,
    lastError: null,
    expiresAt,
    durationTimer: null,
  };

  // Auto-stop after duration
  if (durationMs > 0) {
    triggerInfo.durationTimer = setTimeout(() => {
      stopTrigger(project);
    }, durationMs);
  }

  triggers.set(project, triggerInfo);
  res.json({ ok: true, enabled: true, interval: ms, nextAt: Date.now() + ms, expiresAt });
});

app.post("/api/triggers/:project/stop", (req, res) => {
  const { project } = req.params;
  stopTrigger(project);
  res.json({ ok: true, enabled: false });
});

app.post("/api/triggers/:project/send-now", (req, res) => {
  const { project } = req.params;
  // #812: parked (idle) project — do not pulse agents.
  if (isProjectIdleId(project)) {
    return res.json({ ok: false, idle: true, sent: false });
  }
  sendTriggerMessage(project);
  res.json({ ok: true, sent: true });
});

app.post("/api/triggers/sync", (_req, res) => {
  syncTriggersFromConfig();
  res.json({ ok: true });
});

// Expose syncTriggers for migrated routes (config PUT, rename)
app.set("syncTriggers", syncTriggersFromConfig);

// --- OVERNIGHT-QUEUE.md viewer/editor (#209) ---------------------------------
// Read/write the per-project ~/.quadwork/{id}/OVERNIGHT-QUEUE.md file from
// the operator panel. The id must resolve to a project already saved in
// config.json — we never touch an arbitrary path on disk.
function resolveQueueProject(projectId) {
  if (!projectId || typeof projectId !== "string") return null;
  if (projectId.includes("/") || projectId.includes("\\") || projectId.includes("..")) return null;
  const cfg = readConfig();
  return (cfg.projects || []).find((p) => p.id === projectId) || null;
}
function queuePathFor(projectId) {
  return path.join(os.homedir(), ".quadwork", projectId, "OVERNIGHT-QUEUE.md");
}
const OVERNIGHT_TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");

app.get("/api/queue", (req, res) => {
  const projectId = String(req.query.project || "");
  if (!resolveQueueProject(projectId)) return res.status(404).json({ error: "Unknown project" });
  const p = queuePathFor(projectId);
  if (!fs.existsSync(p)) return res.json({ ok: true, exists: false, content: "" });
  try { return res.json({ ok: true, exists: true, content: fs.readFileSync(p, "utf-8") }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

app.put("/api/queue", express.json({ limit: "512kb" }), (req, res) => {
  const projectId = String(req.query.project || "");
  if (!resolveQueueProject(projectId)) return res.status(404).json({ error: "Unknown project" });
  const content = typeof req.body?.content === "string" ? req.body.content : null;
  if (content === null) return res.status(400).json({ error: "Missing content" });
  const p = queuePathFor(projectId);
  try {
    ensureSecureDir(path.dirname(p));
    fs.writeFileSync(p, content);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/api/queue", (req, res) => {
  const projectId = String(req.query.project || "");
  const project = resolveQueueProject(projectId);
  if (!project) return res.status(404).json({ error: "Unknown project" });
  const p = queuePathFor(projectId);
  if (fs.existsSync(p)) return res.json({ ok: true, existed: true });
  const tpl = path.join(OVERNIGHT_TEMPLATES_DIR, "OVERNIGHT-QUEUE.md");
  if (!fs.existsSync(tpl)) return res.status(500).json({ error: "Template missing" });
  try {
    let content = fs.readFileSync(tpl, "utf-8");
    content = content.replace(/\{\{project_name\}\}/g, project.name || projectId);
    content = content.replace(/\{\{repo\}\}/g, project.repo || "");
    ensureSecureDir(path.dirname(p));
    fs.writeFileSync(p, content);
    return res.json({ ok: true, existed: false });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// --- Serve static frontend (built Next.js export) ---

// Strip trailing slashes (redirect /settings/ → /settings, /setup/ → /setup)
app.use((req, res, next) => {
  if (req.path !== "/" && req.path.endsWith("/")) {
    const clean = req.path.slice(0, -1);
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return res.redirect(301, clean + query);
  }
  next();
});

const outDir = path.resolve(__dirname, "..", "out");

// Resolve extensionless requests to .html files before express.static.
// Next.js static export creates both /setup.html and /setup/ directory —
// express.static finds the directory first and returns NotFoundError.
app.use((req, res, next) => {
  if (req.path === "/" || req.path.startsWith("/api/") || req.path.startsWith("/_next/") || path.extname(req.path)) {
    return next();
  }
  const htmlFile = req.path.slice(1) + ".html";
  const htmlPath = path.join(outDir, htmlFile);
  if (fs.existsSync(htmlPath)) {
    return res.sendFile(htmlFile, { root: outDir }, (err) => {
      if (err) next();
    });
  }
  next();
});

if (fs.existsSync(outDir)) {
  app.use(express.static(outDir, { redirect: false, extensions: ["html"] }));
}

// SPA fallback: serve the pre-rendered template for dynamic routes,
// fall back to index.html for everything else.
app.use((req, res, next) => {
  if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api/")) {
    return next();
  }

  // Dynamic routes → serve their pre-rendered template (has the right JS chunks).
  // Hydration #418 is cosmetic — dashboard renders and functions correctly.
  // NOTE: app-shell.html does NOT work — it has no route JS chunks and renders blank.
  const dynamicRoutes = [
    // #445: memory route removed (agent-memory integration deprecated)
    { pattern: /^\/project\/[^/]+\/queue\/?$/, template: "project/_/queue.html" },
    { pattern: /^\/project\/[^/]+\/?$/, template: "project/_.html" },
  ];

  for (const route of dynamicRoutes) {
    if (route.pattern.test(req.path)) {
      if (fs.existsSync(path.join(outDir, route.template))) {
        return res.sendFile(route.template, { root: outDir }, (err) => {
          if (err) next();
        });
      }
    }
  }

  // Everything else → index.html
  if (fs.existsSync(path.join(outDir, "index.html"))) {
    res.sendFile("index.html", { root: outDir }, (err) => {
      if (err) next();
    });
  } else {
    res.status(503).send("Frontend not built. Run: npm run build");
  }
});

// --- #538: PTY output secret scrubbing (extracted to scrub-secrets.js) ---
const { scrubSecrets, scrubScrollback } = require("./scrub-secrets");

// --- WebSocket + PTY ---
// WS connects to an existing PTY session (started via lifecycle API)
// or spawns a new one if none exists.

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  if (pathname !== "/ws/terminal" && pathname !== "/ws/butler") {
    socket.destroy();
    return;
  }
  // #968: a cross-origin page can open a WS to 127.0.0.1 and inject keystrokes
  // into an agent PTY (remote shell over tailnet). Vet Origin, then require the
  // shared session token (passed as ?token= since browsers can't set WS headers).
  if (!isAllowedWsOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!tokenMatches(url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  if (pathname === "/ws/terminal") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection:terminal", ws, req);
    });
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection:butler", ws, req);
    });
  }
});

wss.on("connection:terminal", async (ws, req) => {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const projectId = params.get("project");
  const agentId = params.get("agent");

  if (!projectId || !agentId) {
    ws.close(1008, "missing project or agent query params");
    return;
  }

  const sessionKey = `${projectId}/${agentId}`;
  let session = agentSessions.get(sessionKey);

  // If no active PTY, spawn one
  if (!session || !session.term) {
    const result = await spawnAgentPty(projectId, agentId);
    if (!result.ok) {
      ws.close(1011, "pty-spawn-failed");
      return;
    }
    session = agentSessions.get(sessionKey);
  }

  session.viewers.add(ws);

  // PTY → this viewer (#538: scrub secrets from live output)
  const dataHandler = session.term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(scrubSecrets(data));
  });

  // Client → PTY
  ws.on("message", (msg) => {
    if (!session.term) return;
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize") {
        if (typeof parsed.cols === "number" && typeof parsed.rows === "number" &&
            Number.isFinite(parsed.cols) && Number.isFinite(parsed.rows) &&
            parsed.cols >= 1 && parsed.cols <= 500 &&
            parsed.rows >= 1 && parsed.rows <= 500) {
          session.viewerDims.set(ws, { cols: parsed.cols, rows: parsed.rows });
          const dims = [...session.viewerDims.values()];
          const merged = {
            cols: Math.min(...dims.map(d => d.cols)),
            rows: Math.min(...dims.map(d => d.rows)),
          };
          if (!session.lastDims ||
              merged.cols !== session.lastDims.cols ||
              merged.rows !== session.lastDims.rows) {
            session.term.resize(merged.cols, merged.rows);
            session.lastDims = merged;
          }
        }
        return;
      }
      if (parsed.type === "replay") {
        if (session.scrollback && session.scrollback.length > 0) {
          ws.send(scrubScrollback(session.scrollback));
        } else {
          ws.send(`\x1b[2m[agent online — waiting for input]\x1b[0m\r\n`);
        }
        return;
      }
    } catch {}
    safeWrite(session.term, str);
  });

  ws.on("close", () => {
    dataHandler.dispose();
    session.viewers.delete(ws);
    session.viewerDims.delete(ws);
    if (session.viewerDims.size > 0 && session.term) {
      const dims = [...session.viewerDims.values()];
      const merged = {
        cols: Math.min(...dims.map(d => d.cols)),
        rows: Math.min(...dims.map(d => d.rows)),
      };
      if (merged.cols !== session.lastDims?.cols || merged.rows !== session.lastDims?.rows) {
        session.term.resize(merged.cols, merged.rows);
        session.lastDims = merged;
      }
    }
  });
});

// --- Butler WebSocket (#631) ---

wss.on("connection:butler", async (ws) => {
  if (!butlerSession.term) {
    const result = spawnButlerPty();
    if (!result.ok) {
      ws.close(1011, "pty-spawn-failed");
      return;
    }
  }

  butlerSession.viewers.add(ws);

  const dataHandler = butlerSession.term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(scrubSecrets(data));
  });

  ws.on("message", (msg) => {
    if (!butlerSession.term) return;
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize") {
        if (typeof parsed.cols === "number" && typeof parsed.rows === "number" &&
            Number.isFinite(parsed.cols) && Number.isFinite(parsed.rows) &&
            parsed.cols >= 1 && parsed.cols <= 500 &&
            parsed.rows >= 1 && parsed.rows <= 500) {
          butlerSession.viewerDims.set(ws, { cols: parsed.cols, rows: parsed.rows });
          const dims = [...butlerSession.viewerDims.values()];
          const merged = {
            cols: Math.min(...dims.map(d => d.cols)),
            rows: Math.min(...dims.map(d => d.rows)),
          };
          if (!butlerSession.lastDims ||
              merged.cols !== butlerSession.lastDims.cols ||
              merged.rows !== butlerSession.lastDims.rows) {
            butlerSession.term.resize(merged.cols, merged.rows);
            butlerSession.lastDims = merged;
          }
        }
        return;
      }
      if (parsed.type === "replay") {
        if (butlerSession.scrollback && butlerSession.scrollback.length > 0) {
          ws.send(scrubScrollback(butlerSession.scrollback));
        } else {
          ws.send(`\x1b[2m[butler online — waiting for input]\x1b[0m\r\n`);
        }
        return;
      }
    } catch {}
    safeWrite(butlerSession.term, str);
  });

  ws.on("close", () => {
    dataHandler.dispose();
    butlerSession.viewers.delete(ws);
    butlerSession.viewerDims.delete(ws);
    if (butlerSession.viewerDims.size > 0 && butlerSession.term) {
      const dims = [...butlerSession.viewerDims.values()];
      const merged = {
        cols: Math.min(...dims.map(d => d.cols)),
        rows: Math.min(...dims.map(d => d.rows)),
      };
      if (merged.cols !== butlerSession.lastDims?.cols || merged.rows !== butlerSession.lastDims?.rows) {
        butlerSession.term.resize(merged.cols, merged.rows);
        butlerSession.lastDims = merged;
      }
    }
  });
});

// --- Trigger auto-start from config ---

function syncTriggersFromConfig() {
  const cfg = readConfig();
  const activeIds = new Set();

  if (cfg.projects) {
    for (const project of cfg.projects) {
      // #812: idle (parked) projects get no trigger. Excluding them from
      // activeIds also makes the cleanup loop below clear any timer they
      // had — so writing idle:true via PUT /api/config (which calls this)
      // stops a running trigger with no separate stop call.
      if (project.trigger_enabled && !project.idle) {
        activeIds.add(project.id);
        const ms = (project.trigger_interval || 30) * 60 * 1000;
        const existing = triggers.get(project.id);
        if (!existing || existing.interval !== ms) {
          if (existing && existing.timer) clearInterval(existing.timer);
          const timer = setInterval(() => sendTriggerMessage(project.id), ms);
          triggers.set(project.id, { interval: ms, timer, lastSent: null, nextAt: Date.now() + ms, lastError: null });
        }
      }
    }
  }

  for (const [id, info] of triggers) {
    if (!activeIds.has(id)) {
      if (info.timer) clearInterval(info.timer);
      if (info.durationTimer) clearTimeout(info.durationTimer);
      triggers.delete(id);
    }
  }
}

// #516: server-side batch-completion poller. Checks every 30s whether
// any trigger_auto project's batch is complete, and auto-stops the
// trigger (plus caffeinate when no triggers remain). This runs
// independently of the trigger tick interval, so completion is
// detected within 30s even if the operator is on a different page.
// #518: also handles telegram_auto / discord_auto bridge lifecycle
// (both start and stop) so bridges respond to batch transitions
// even when the operator is viewing a different project page.

const AUTO_STOP_POLL_INTERVAL_MS = 30_000;

async function autoStopPollingTick() {
  const cfg = readConfig();
  if (!cfg.projects) return;

  for (const project of cfg.projects) {
    if (project.idle) continue; // #812: parked project — no batch-progress polling
    const hasTriggerAuto = project.trigger_auto && triggers.has(project.id);
    const hasBridgeAuto = project.telegram_auto || project.discord_auto;
    if (!hasTriggerAuto && !hasBridgeAuto) continue;
    const qwPort = cfg.port || 8400;
    try {
      const res = await fetch(
        `http://127.0.0.1:${qwPort}/api/batch-progress?project=${encodeURIComponent(project.id)}`
      );
      if (!res.ok) continue;
      const bp = await res.json();
      const hasItems = bp.items && bp.items.length > 0;
      // #810: gate auto-stop on completeConfirmed (two distinct successful fetch
      // cycles), not a single transient/stale `complete`. Track prev on the
      // confirmed value so the bridge-stop transition guard fires on it.
      // #864: an explicit operator clear (`liveActiveBatchCleared`) ALSO triggers
      // the stop path, so trigger + bridges shut down when Head sets the Active
      // Batch section to empty even if the preserved snapshot's items don't all
      // resolve as merged/closed (e.g. a duplicate unmerged PR keeps the items
      // in `in_review`). The cleared flag is the operator's intent.
      const confirmed = !!bp.completeConfirmed;
      const clearedByOperator = !!bp.liveActiveBatchCleared;
      const shouldStop = confirmed || clearedByOperator;
      const prev = _bridgeBatchPrev.get(project.id);
      _bridgeBatchPrev.set(project.id, { complete: shouldStop, hasItems });

      if (bp && shouldStop) {
        if (hasTriggerAuto) {
          const reason = clearedByOperator ? "cleared by operator" : "complete (confirmed)";
          console.log(`[auto-trigger] ${project.id}: batch ${reason}, auto-stopped (poller)`);
          stopTrigger(project.id);
          if (caffeinateProcess.process && triggers.size === 0) {
            try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
            caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
            console.log(`[auto-trigger] ${project.id}: caffeinate auto-stopped (no active triggers remain)`);
          }
        }
        // #518: also stop bridges when batch completes
        // #542: only fire on the transition (incomplete→complete), not every tick
        if (hasBridgeAuto && (!prev || !prev.complete)) {
          await autoStopBridges(project.id, project, qwPort);
        }
      }

      // #518: detect batch-start transition → auto-start bridges
      // #864: do NOT auto-start on a cleared queue even though hasItems may be
      // true from the preserved snapshot — the operator's clear is a stop signal.
      if (hasBridgeAuto && hasItems && !bp.complete && !clearedByOperator) {
        const isNewBatch = !prev || prev.complete || !prev.hasItems;
        if (isNewBatch) {
          await autoStartBridges(project.id, project, qwPort);
        }
      }
    } catch {
      // Non-fatal — retry on next tick
    }
  }
}

// QUADWORK_SKIP_LISTEN lets a test `require("./index")` to reach the exported
// pure helpers (e.g. buildAgentArgs) WITHOUT starting the server, its pollers,
// or binding the port. Production never sets it; `quadwork start` requires this
// module for its side effects, so the guard must be an explicit env var (not
// require.main, which is the bin, not this file).
let _autoStopHandle = null; // #972: captured so shutdown() can clear it
if (!process.env.QUADWORK_SKIP_LISTEN) {
  _autoStopHandle = setInterval(autoStopPollingTick, AUTO_STOP_POLL_INTERVAL_MS);
}

// #915: retry deferred reseeds without a server restart. A reseed deferred on
// boot because a project's batch was active used to wait for the next startup —
// stranding a busy project on old seeds indefinitely. autoReseedOnStartup is
// idempotent (current projects skip, active ones defer, idle pending ones get
// re-seeded), so re-running it on a tick re-attempts any pending project once
// its batch clears, keeping the fail-closed mid-batch guard intact.
const RESEED_RETRY_INTERVAL_MS = 60_000;
let _reseedRetryRunning = false;
async function reseedRetryTick() {
  if (_reseedRetryRunning) return; // a slow tick must not overlap the next
  _reseedRetryRunning = true;
  try {
    await routes.autoReseedOnStartup(readConfig(), { periodic: true });
  } catch (err) {
    console.error(`[reseed] periodic retry failed: ${err.message}`);
  } finally {
    _reseedRetryRunning = false;
  }
}
let _reseedRetryHandle = null; // #972: captured so shutdown() can clear it
if (!process.env.QUADWORK_SKIP_LISTEN) {
  _reseedRetryHandle = setInterval(reseedRetryTick, RESEED_RETRY_INTERVAL_MS);
}

// #957: hourly stale-temp sweep, plus one at boot — a server that was down for
// days should reclaim quota immediately, not an hour after start. The handle is
// captured so shutdown() (#972) clears the timer on Ctrl+C / full reset.
const TEMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let _tempSweepHandle = null;
if (!process.env.QUADWORK_SKIP_LISTEN) {
  setImmediate(backendTempSweepTick);
  _tempSweepHandle = setInterval(backendTempSweepTick, TEMP_SWEEP_INTERVAL_MS);
}

// #422 / quadwork#310: auto-continue after loop guard.
//
// Per opted-in project, poll AC's /api/status every 10s. When we see
// a false → true transition on `paused`, wait the configured delay
// (default 30s) and POST /continue to /api/chat — same path the
// operator would use manually. The delay gives a human a chance to
// intervene on an actually-runaway loop, and acts as a soft rate
// limit against pathological loops that would otherwise just loop
// forever under an auto-continue.
//
// Detection is deliberately polling rather than a long-lived ws:
// a ws subscription per project would complicate lifecycle and
// reconnection, and 10s polling latency is acceptable when the
// delay is tens of seconds. Skipping projects without the opt-in
// keeps the poller cheap for single-project setups.

// --- Start ---

// #705: auto-interrupt agents stuck with no PTY output for 10 minutes.
const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000;
let _watchdogHandle = null;

// #924: the integration logic (probe -> mark -> respawn, manual-stop exclusion,
// idle-skip, breaker wiring) is the part most likely to regress, so its deps are
// dependency-injected for tests — exactly as autoReseedOnStartup is. Production
// calls `watchdogCheck()` with no args, so every dep resolves to the real
// module function and behavior is unchanged.
async function watchdogCheck(deps = {}) {
  const sessions = deps.agentSessions || agentSessions;
  const isAlive = deps.isPtyAlive || isPtyAlive;
  const markExited = deps.markSessionExited || markSessionExited;
  const getChatMode = deps.getProjectChatMode || routes.getProjectChatMode;
  const write = deps.safeWrite || safeWrite;
  const isIdle = deps.isProjectIdleId || isProjectIdleId;
  const shouldRespawn = deps.shouldRespawn || selfHeal.shouldRespawn;
  const spawn = deps.spawnAgentPty || spawnAgentPty;
  const emit = deps.emitSystemMessage || emitSystemMessage;
  const now = deps.now || Date.now;
  const log = deps.log || ((m) => console.log(m));
  const errorLog = deps.errorLog || ((m) => console.error(m));

  const toRespawn = [];
  for (const [key, session] of sessions) {
    // #910: liveness probe — a session can read `running` while its CLI process
    // already exited (onExit didn't fire / process died without it), leaving a
    // false green dot. Detect the dead pid and clear the stale state.
    if (session.state === "running" && session.term && !isAlive(session.term)) {
      log(`[watchdog] ${key}: PTY process gone while state was 'running' — marking stopped`);
      markExited(key, session, null);
    }

    // #797/#825: stuck-agent detection (running but silent) — Ctrl+C nudge.
    // #732: skip file-chat projects — idle is normal, PTY dispatch wakes them.
    if (session.state === "running" && session.term && session.lastOutputAt
        && getChatMode(session.projectId) !== "file"
        && now() - session.lastOutputAt > WATCHDOG_TIMEOUT_MS) {
      log(`[watchdog] ${key}: no output for 10m — sending Ctrl+C`);
      write(session.term, "\x03");
      session.lastOutputAt = now();
    }

    // #910: collect agents that exited on their own (clean exit / crash) for
    // auto-respawn. Operator-stopped agents have exitedUnexpectedly=false.
    if (session.exitedUnexpectedly && session.state !== "running" && !session.term) {
      toRespawn.push(key);
    }
  }

  // #910: respawn exited agents for non-idle projects, after iterating (spawn
  // mutates agentSessions). The self-heal respawn breaker caps repeated deaths
  // so a session that keeps dying isn't loop-respawned.
  for (const key of toRespawn) {
    const session = sessions.get(key);
    if (!session || !session.exitedUnexpectedly) continue;
    const [projectId, agentId] = key.split("/");
    if (!projectId || !agentId) continue;
    if (isIdle(projectId)) continue; // #812: parked project — leave stopped
    const decision = shouldRespawn(key, {
      now: now(),
      onBreaker: (message) => { log(`[watchdog] ${key}: ${message}`); emit(projectId, message); },
    });
    if (decision !== "respawn") continue; // breaker tripped — leave stopped
    session.exitedUnexpectedly = false; // consume the flag for this attempt
    log(`[watchdog] ${key}: agent exited — auto-respawning`);
    try {
      const result = await spawn(projectId, agentId, { suppressLifecycleMsg: true });
      if (result.ok) emit(projectId, `${agentId} auto-respawned (had exited)`);
      else errorLog(`[watchdog] ${key}: auto-respawn failed: ${result.error}`);
    } catch (err) {
      errorLog(`[watchdog] ${key}: auto-respawn threw: ${err.message}`);
    }
  }
}

function startWatchdog() {
  if (_watchdogHandle) return;
  _watchdogHandle = setInterval(watchdogCheck, 60_000);
  console.log("[watchdog] stuck-agent watchdog started (60s interval, 10m threshold)");
}

// #657: extracted startup migrations so full-reset can re-run them
function runStartupMigrations(cfg) {
  const projects = (cfg.projects || []).filter((p) => !p.archived);

  // reseed stale slugs
  const SLUG_FIXES = [
    [/@reviewer1/g, "@re1"], [/@reviewer2/g, "@re2"],
    [/@t2a/g, "@re1"], [/@t2b/g, "@re2"],
    [/@t1\b/g, "@head"], [/@t3\b/g, "@dev"],
    [/\breviewer1\b/g, "re1"], [/\breviewer2\b/g, "re2"],
  ];
  for (const p of projects) {
    if (!p.agents) continue;
    for (const [agentId, agentCfg] of Object.entries(p.agents)) {
      const wtDir = agentCfg.cwd;
      if (!wtDir || !fs.existsSync(wtDir)) continue;
      for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
        const filePath = path.join(wtDir, filename);
        if (!fs.existsSync(filePath)) continue;
        try {
          let content = fs.readFileSync(filePath, "utf-8");
          let changed = false;
          for (const [pattern, repl] of SLUG_FIXES) {
            const before = content;
            content = content.replace(pattern, repl);
            if (content !== before) changed = true;
          }
          if (changed) {
            fs.writeFileSync(filePath, content);
            console.log(`[reseed] ${p.id}/${agentId}: fixed stale slugs in ${filename}`);
          }
        } catch (err) {
          console.warn(`[reseed] ${p.id}/${agentId}: failed to patch ${filename}: ${err.message}`);
        }
      }
    }
  }

  // #690: seed DESIGN-GUIDE.md into existing agent worktrees
  const designGuideSrc = path.join(__dirname, "..", "templates", "seeds", "DESIGN-GUIDE.md");
  if (fs.existsSync(designGuideSrc)) {
    for (const p of projects) {
      if (!p.working_dir) continue;
      const dirName = path.basename(p.working_dir);
      const parentDir = path.dirname(p.working_dir);
      for (const agent of ["head", "dev", "re1", "re2"]) {
        const wtDir = path.join(parentDir, `${dirName}-${agent}`);
        const dst = path.join(wtDir, "DESIGN-GUIDE.md");
        if (fs.existsSync(wtDir) && !fs.existsSync(dst)) {
          try {
            fs.copyFileSync(designGuideSrc, dst);
            console.log(`[#690] ${p.id}: seeded DESIGN-GUIDE.md into ${agent} worktree`);
          } catch {}
        }
      }
    }
  }

}

// #992: after a restart, respawn agents for projects that were MID-BATCH.
// #972's shutdown kills agent PTYs cleanly on `pm2 restart` / local restart,
// but nothing respawned them — so a project driving an active batch stayed
// `missing` (no dev progress, no reviews) until an operator manually restarted
// each of head/dev/re1/re2. That bit every v2.5.x upgrade. Here we restore ONLY
// active-batch projects; idle projects still spawn agents on demand
// (terminal-connect / batch-start) exactly as before.
//
// "Active batch" comes from the SAME getOrComputeBatchProgress +
// isBatchActiveFromProgress source the /api/batch-active route and the
// auto-reseed gate use — no new batch/pulse logic. Opt out via config.json
// `restart_respawn: { enabled: false }` (defaults on).
//
// Fail-SAFE direction is the inverse of auto-reseed's fail-CLOSED gate: if we
// can't prove a batch is active (the check throws or returns null), we do
// NOTHING and never spawn, so an idle project is never disturbed. Dependencies
// are injected (getProgress / isActiveFromProgress / spawnAgentPty / log)
// exactly like autoReseedOnStartup so tests need neither gh nor a real pty.
async function respawnActiveBatchAgents(cfg, opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const getProgress = opts.getProgress || routes.getOrComputeBatchProgress;
  const isActiveFromProgress = opts.isActiveFromProgress || routes.isBatchActiveFromProgress;
  const spawn = opts.spawnAgentPty || spawnAgentPty;
  const sessions = opts.agentSessions || agentSessions;
  const decisions = [];

  if (cfg && cfg.restart_respawn && cfg.restart_respawn.enabled === false) {
    log("[respawn] disabled via config (restart_respawn.enabled: false)");
    return { decisions };
  }

  const projects = (cfg?.projects || []).filter((p) => p && p.id && p.working_dir);
  for (const project of projects) {
    let active;
    try {
      const progress = await getProgress(project.id);
      active = isActiveFromProgress(progress);
    } catch (err) {
      // Fail-safe: an unknowable batch state means DON'T spawn (never disturb
      // a possibly-idle project). Logged so the skip is observable.
      decisions.push({ projectId: project.id, action: "skip", reason: `batch-state check threw: ${err.message}` });
      log(`[respawn] ${project.id}: skipped — batch state unknown (${err.message})`);
      continue;
    }
    if (!active) { // false (no active batch) OR null (unknown) → leave alone
      decisions.push({ projectId: project.id, action: "skip", reason: active === null ? "batch state unknown" : "no active batch" });
      continue;
    }

    // Reuse the project's configured agent keys (covers legacy layouts); fall
    // back to the canonical four. spawnAgentPty resolves cwd per agent and
    // returns {ok:false} for an unknown one, so a stray key can't crash boot.
    const agentKeys = project.agents && typeof project.agents === "object"
      ? Object.keys(project.agents)
      : ["head", "re1", "re2", "dev"];
    const restored = [];
    for (const agentId of agentKeys) {
      const key = `${project.id}/${agentId}`;
      // Idempotent: never double-spawn an agent already live (e.g. one a
      // terminal-connect raced in first).
      const existing = sessions.get(key);
      if (existing && isPtyAlive(existing.term)) continue;
      try {
        const r = await spawn(project.id, agentId, { suppressLifecycleMsg: true });
        if (r && r.ok) restored.push(agentId);
        else log(`[respawn] ${key}: spawn failed: ${(r && r.error) || "unknown error"}`);
      } catch (err) {
        log(`[respawn] ${key}: spawn threw: ${err.message}`);
      }
    }
    if (restored.length > 0) {
      log(`[respawn] ${project.id}: active batch — restored agents: ${restored.join(", ")}`);
    }
    decisions.push({ projectId: project.id, action: "respawned", agents: restored });
  }
  return { decisions };
}

if (!process.env.QUADWORK_SKIP_LISTEN) {
  // #974: a second `quadwork start` (or anything already bound to PORT) makes
  // server.listen emit 'error'; with no handler Node throws the raw EADDRINUSE
  // stack trace. Surface a friendly, actionable message and exit cleanly.
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`\nQuadWork: port ${PORT} is already in use — another instance may already be running.`);
      console.error(`Run 'quadwork stop' first, or change the port in Settings, then retry.\n`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, "127.0.0.1", async () => {
  console.log(`QuadWork server listening on http://127.0.0.1:${PORT}`);
  syncTriggersFromConfig();
  const startupCfg = readConfig();

  // #719: Migrate AC chat history to JSONL before initializing file-chat.
  const migrationFailed = new Set(runAcMigration(startupCfg));

  // #722: One-time switchover — set all projects to file-based chat.
  if (!startupCfg.file_chat_switchover_done) {
    let switched = false;
    for (const p of (startupCfg.projects || [])) {
      if (p.chat_mode !== "file" && !migrationFailed.has(p.id)) {
        p.chat_mode = "file";
        switched = true;
        console.log(`[startup] ${p.id}: switched to file-based chat`);
      }
    }
    startupCfg.file_chat_switchover_done = true;
    writeConfig(startupCfg);
    if (switched) console.log("[startup] file-chat switchover complete");
  }

  // Initialize file-chat engine for all projects.
  for (const p of (startupCfg.projects || [])) {
    if (p.chat_mode === "file") {
      if (migrationFailed.has(p.id)) {
        console.error(`[startup] ${p.id}: migration failed — skipping file-chat init`);
        continue;
      }
      try {
        fileChat.initProject(p.id);
        console.log(`[startup] ${p.id}: file-chat engine initialized`);
      } catch (err) {
        console.error(`[startup] FATAL: ${p.id}: ${err.message}`);
        process.exit(1);
      }
    }
  }

  runStartupMigrations(startupCfg);

  // #856: Auto-reseed worktree AGENTS.md when the package version changes.
  // Per-project completion state lives in ~/.quadwork/reseed-state.json, so
  // projects deferred mid-batch stay pending and retry on the next startup.
  // Failures here MUST NOT block server boot.
  try {
    await routes.autoReseedOnStartup(startupCfg);
  } catch (err) {
    console.error(`[reseed] auto-reseed failed: ${err.message}`);
  }

  // #992: restore agents for any project mid-batch (see fn comment). Runs
  // AFTER auto-reseed (which defers active-batch projects, so their seeds are
  // untouched) and must never block boot.
  try {
    await respawnActiveBatchAgents(startupCfg);
  } catch (err) {
    console.error(`[respawn] restart respawn failed: ${err.message}`);
  }

  if (startupCfg.butler && startupCfg.butler.enabled && startupCfg.butler.auto_start) {
    const result = spawnButlerPty();
    if (result.ok) console.log(`[butler] auto-started (PID: ${result.pid})`);
    else console.warn(`[butler] auto-start failed: ${result.error}`);
  }
  startWatchdog();
  });
}

// #972: clean shutdown. Previously only stopped butler + file-chat, so Ctrl+C
// orphaned the detached caffeinate process (Mac never slept again), left agent
// PTYs (and their CLI children holding worktree locks) alive, and never cleared
// the polling/watchdog timers or the bridge/trigger connections. Every step is
// independently guarded so the function stays idempotent (SIGINT then SIGTERM,
// or a full-reset re-run, can call it more than once safely).
function shutdown() {
  // Polling + watchdog timers.
  if (_autoStopHandle) { clearInterval(_autoStopHandle); _autoStopHandle = null; }
  if (_reseedRetryHandle) { clearInterval(_reseedRetryHandle); _reseedRetryHandle = null; }
  if (_tempSweepHandle) { clearInterval(_tempSweepHandle); _tempSweepHandle = null; } // #957
  if (_watchdogHandle) { clearInterval(_watchdogHandle); _watchdogHandle = null; }

  // Trigger schedulers (clears each trigger's interval + duration timers).
  for (const project of [...triggers.keys()]) {
    try { stopTrigger(project); } catch {}
  }

  // Message bridges (in-process Discord/Telegram clients).
  try { telegramBridge.stopAll(); } catch {}
  try { discordBridge.stopAll(); } catch {}

  // caffeinate is spawned detached+unref, so it survives our exit unless killed.
  if (caffeinateProcess.process) {
    try { caffeinateProcess.process.kill("SIGTERM"); } catch {}
    caffeinateProcess = { process: null, pid: null, startedAt: null, duration: null };
  }

  // Agent PTYs (and the CLI children they hold).
  for (const [, session] of agentSessions) {
    if (session && session.term) { try { session.term.kill(); } catch {} }
  }

  stopButlerPty();
  const cfg = readConfig();
  for (const p of (cfg.projects || [])) {
    if (p.chat_mode === "file") {
      try { fileChat.shutdownProject(p.id); } catch {}
    }
  }
}

module.exports = { shutdown, buildAgentArgs, buildAgentEnv, isPtyAlive, watchdogCheck, markSessionExited };
module.exports.agentSessions = agentSessions; // #972: test seam for shutdown() PTY cleanup
module.exports.respawnActiveBatchAgents = respawnActiveBatchAgents; // #992: startup respawn (DI'd for tests)
