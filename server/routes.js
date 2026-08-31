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
const {
  ProjectLifecycleError,
  isProjectArchived,
  assertProjectAdmitted,
  captureProjectAdmission,
  isAdmissionCurrent,
} = require("./project-lifecycle");
const { injectModeForCommand } = require("../src/lib/injectMode.js");

const router = express.Router();

// #730: PTY dispatch callback — set by index.js at startup
let _ptyDispatchCallback = null;
function setPtyDispatchCallback(fn) { _ptyDispatchCallback = fn; }

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const ENV_PATH = path.join(CONFIG_DIR, ".env");
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

// #837: `gh api` list fetches (closed-PR pages with `-i`, GraphQL repo
// snapshot, batch progress) can exceed Node's default 1MB execFile maxBuffer.
// A real `pulls?state=closed&per_page=100` -i page measured ~1.74MB on
// realproject7/quadwork, which made ghApiConditional reject with
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER → "Recently Merged PRs" stayed empty AND
// the #828/#834 queued-from-snapshot fast-path was forced off because
// closedPagesComplete couldn't ever become true. 32MB is well above today's
// page sizes and still well under node's hard 2GB cap.
const GH_LIST_MAX_BUFFER = 32 * 1024 * 1024;

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
// #802: GitHub tracks REST (core) and GraphQL as SEPARATE budgets, so GraphQL
// can hit 0 while REST is full. The background GraphQL poller and the
// batch-progress GraphQL query must back off on THIS bucket, not the REST one.
const _graphqlRateLimit = {
  limit: 5000,       // GraphQL is a points/hour budget, not request count
  remaining: 5000,
  resetAt: 0,        // epoch ms
  updatedAt: 0,      // epoch ms when we last fetched
};
// #866: search is a separate, much smaller bucket (30/min). Tracked only for
// the always-on header badge — no server-side gh call gates on it.
const _searchRateLimit = {
  limit: 30,
  remaining: 30,
  resetAt: 0,        // epoch ms
  updatedAt: 0,      // epoch ms when we last fetched
};
// #886/#893: the reviewer-token account is a SEPARATE, per-account GitHub
// rate-limit budget (reviewers run gh as a different account). #893 makes this
// project-aware: the reviewer token path is resolved per project from that
// project's reviewer worktree AGENTS.md (the path reseed preserves), so a custom
// per-worktree token is monitored — not just cfg/default. Polled on demand from
// the /api/github/rate-limit endpoint and cached PER TOKEN PATH (exempt
// rate_limit call → zero billable cost). Entry shape:
// { ts, login, core, graphql, search, error } where each bucket is
// { limit, remaining, resetAt(ms) }.
const _reviewerRateLimitByPath = new Map(); // tokenPath → entry
const RATE_LIMIT_POLL_MS = 60_000;       // refresh every 60s
const RATE_LIMIT_LOW_THRESHOLD = 200;    // below this → back off
const RATE_LIMIT_CRITICAL = 50;          // below this → stop all infra gh calls
let _rateLimitTimer = null;

async function refreshRateLimit() {
  try {
    // One `gh api rate_limit` call returns every resource bucket; grab core
    // (REST), graphql and search. core/graphql each gate their own stream
    // (#802); search is display-only for the header badge (#866). The
    // rate_limit endpoint is itself exempt — zero budget cost.
    const { stdout } = await _execFileAsync("gh", [
      "api", "rate_limit", "--jq",
      "{core: (.resources.core | {limit,remaining,reset}), graphql: (.resources.graphql | {limit,remaining,reset}), search: (.resources.search | {limit,remaining,reset})}",
    ], { encoding: "utf-8", timeout: 10000 });
    const data = JSON.parse(stdout);
    _rateLimit.limit = data.core.limit;
    _rateLimit.remaining = data.core.remaining;
    _rateLimit.resetAt = data.core.reset * 1000; // seconds → ms
    _rateLimit.updatedAt = Date.now();
    _rateLimit.error = null;
    if (data.graphql) {
      _graphqlRateLimit.limit = data.graphql.limit;
      _graphqlRateLimit.remaining = data.graphql.remaining;
      _graphqlRateLimit.resetAt = data.graphql.reset * 1000;
      _graphqlRateLimit.updatedAt = Date.now();
    }
    if (data.search) {
      _searchRateLimit.limit = data.search.limit;
      _searchRateLimit.remaining = data.search.remaining;
      _searchRateLimit.resetAt = data.search.reset * 1000;
      _searchRateLimit.updatedAt = Date.now();
    }
  } catch (err) {
    _rateLimit.error = err.message;
    _rateLimit.updatedAt = Date.now();
  }
  // #893: the reviewer-token poll is no longer on the timer — it is project-
  // aware and driven on demand from the /api/github/rate-limit endpoint.
}

// #893: resolve the reviewer token path for a request. For a known project,
// the worktree-extracted path WINS (matches reseed's preservation order — it is
// the actual path that project's reviewer agents currently use): re1's worktree
// AGENTS.md first, then re2's. Falls back to cfg.reviewer_token_path → default
// for a no-project / unknown-project request (backward compatible with #886).
// Returns { path, source: "worktree" | "config" | "default" }.
// #897: expand a leading `~/` (and bare `~`) to os.homedir(). The setup wizard
// seeds the literal `~/.quadwork/reviewer-token` into reviewer AGENTS.md, and
// _extractReviewerTokenPath returns it raw (reseed depends on the raw value).
// Node's fs does NOT expand `~`, so the resolver must normalize before reading /
// caching — otherwise the default-seeded path ENOENTs and the badge vanishes.
function _expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// #970: a worktree-sourced reviewer-token path comes from agent-writable
// AGENTS.md (`GH_TOKEN=$(cat <path>)`), so the server would otherwise
// readFileSync an arbitrary attacker-chosen path — an existence/validity
// oracle. Confine it to under ~/.quadwork or the project's own worktree.
function _reviewerTokenPathAllowed(absPath, wtDir) {
  return [CONFIG_DIR, path.resolve(wtDir)].some((root) => {
    const rel = path.relative(root, absPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

function _resolveReviewerTokenPath(projectId) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { /* default-config / unreadable */ }
  const defaultPath = path.join(os.homedir(), ".quadwork", "reviewer-token");
  const project = projectId ? (cfg.projects || []).find((p) => p.id === projectId) : null;
  if (project) {
    const targets = _resolveReseedTargets(project); // [{ canonical, wtDir }, ...]
    for (const role of ["re1", "re2"]) {
      const t = targets.find((x) => x.canonical === role);
      if (!t) continue;
      try {
        const agentsMd = fs.readFileSync(path.join(t.wtDir, "AGENTS.md"), "utf-8");
        const extracted = _extractReviewerTokenPath(agentsMd);
        // #897: expand `~` here (not in _extractReviewerTokenPath — reseed needs
        // the raw value) so the read + cache key use an absolute path.
        if (extracted) {
          const abs = path.resolve(t.wtDir, _expandTilde(extracted));
          // #970: only honor the agent-supplied path if it stays under an
          // allowed root; otherwise ignore it and fall through to the operator
          // config / default token (a crafted path can't become a read oracle).
          if (_reviewerTokenPathAllowed(abs, t.wtDir)) {
            return { path: abs, source: "worktree" };
          }
        }
      } catch { /* worktree / AGENTS.md missing → try next role */ }
    }
  }
  if (cfg.reviewer_token_path) return { path: _expandTilde(cfg.reviewer_token_path), source: "config" };
  return { path: defaultPath, source: "default" }; // already absolute
}

// #886/#893: poll one reviewer token path (exempt `rate_limit` call as that
// token's account) and cache the result keyed by path. No/empty token → drop
// the cache entry (omitted from the payload). `login` is the label to attach
// (null when it can't be proven to match a custom token — see getReviewerRateLimit).
async function refreshReviewerForPath(tokenPath, login) {
  let token = "";
  try {
    token = fs.readFileSync(tokenPath, "utf-8").trim();
  } catch {
    _reviewerRateLimitByPath.delete(tokenPath); // no reviewer token here → omit
    return;
  }
  if (!token) { _reviewerRateLimitByPath.delete(tokenPath); return; }
  try {
    const { stdout } = await _execFileAsync("gh", [
      "api", "rate_limit", "--jq",
      "{core: (.resources.core | {limit,remaining,reset}), graphql: (.resources.graphql | {limit,remaining,reset}), search: (.resources.search | {limit,remaining,reset})}",
    ], { encoding: "utf-8", timeout: 10000, env: { ...process.env, GH_TOKEN: token } });
    const data = JSON.parse(stdout);
    const toBucket = (b) => ({ limit: b.limit, remaining: b.remaining, resetAt: b.reset * 1000 });
    _reviewerRateLimitByPath.set(tokenPath, {
      ts: Date.now(),
      login: login || null,
      core: data.core ? toBucket(data.core) : null,
      graphql: data.graphql ? toBucket(data.graphql) : null,
      search: data.search ? toBucket(data.search) : null,
      error: null,
    });
  } catch (err) {
    const prev = _reviewerRateLimitByPath.get(tokenPath);
    _reviewerRateLimitByPath.set(tokenPath, {
      ...(prev || { core: null, graphql: null, search: null }),
      ts: Date.now(),
      login: login || null,
      error: err.message,
    });
  }
}

// #893: resolve the reviewer token path for `projectId`, (re)poll it if the
// per-path cache is stale, and return the cache entry (or null). Login: only
// trust cfg.reviewer_github_user for the cfg/default sources — a custom
// worktree token may be a DIFFERENT account, so omit the label there rather than
// show a stale/mismatched login.
async function getReviewerRateLimit(projectId) {
  const { path: tokenPath, source } = _resolveReviewerTokenPath(projectId);
  let login = null;
  if (source !== "worktree") {
    try { login = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).reviewer_github_user || null; } catch { /* none */ }
  }
  const cached = _reviewerRateLimitByPath.get(tokenPath);
  if (!cached || Date.now() - cached.ts >= RATE_LIMIT_POLL_MS) {
    await refreshReviewerForPath(tokenPath, login);
  } else if (cached.login !== login) {
    // Path unchanged but the label resolution changed — update without re-polling.
    _reviewerRateLimitByPath.set(tokenPath, { ...cached, login });
  }
  return _reviewerRateLimitByPath.get(tokenPath) || null;
}

// #886/#893: build the reviewer block from a cache entry, or null when there's
// no token / no bucket data (key omitted → single-account view unchanged).
function reviewerRateLimitPayload(entry) {
  if (!entry || (!entry.core && !entry.graphql && !entry.search)) return null;
  const out = {};
  if (entry.login) out.login = entry.login;
  if (entry.core) out.core = bucketView(entry.core);
  if (entry.graphql) out.graphql = bucketView(entry.graphql);
  if (entry.search) out.search = bucketView(entry.search);
  return out;
}

function startRateLimitPolling() {
  if (_rateLimitTimer) return;
  refreshRateLimit();
  // #836: .unref() so this interval doesn't alone pin the event loop.
  // Production keeps the process alive via the Express HTTP listener, so
  // cadence/auto-start is unchanged; .unref() only lets test imports and
  // one-off `node -e` invocations exit cleanly (an unref'd `node -e` poller
  // ran for 11 days in the wild before this was caught).
  _rateLimitTimer = setInterval(refreshRateLimit, RATE_LIMIT_POLL_MS);
  _rateLimitTimer.unref();
}

function isRateLimited() {
  return _rateLimit.remaining < RATE_LIMIT_CRITICAL;
}
function isRateLow() {
  return _rateLimit.remaining < RATE_LIMIT_LOW_THRESHOLD;
}
// #802: same thresholds, applied to the separate GraphQL budget.
function isGraphqlRateLimited() {
  return _graphqlRateLimit.remaining < RATE_LIMIT_CRITICAL;
}
function isGraphqlRateLow() {
  return _graphqlRateLimit.remaining < RATE_LIMIT_LOW_THRESHOLD;
}

// Adaptive cache TTL: normal 30s, low 120s, critical ∞ (serve stale)
function adaptiveTTL(baseTTL) {
  if (isRateLimited()) return Infinity;
  if (isRateLow()) return Math.max(baseTTL, 120_000);
  return baseTTL;
}

// ─── Shared GitHub endpoint cache (#554) ──────────────────────────────────
// Per-endpoint in-memory cache of the canonical board slices, populated by the
// REST+ETag fetcher (#806, githubStateFetcher / refreshRepoRest) and served by
// the /api/github/* routes (serveGithubList) so reads cost ~0.
const _ghEndpointCache = new Map(); // key → { ts, data, stale? }
const GH_ENDPOINT_CACHE_TTL = 60_000; // #698: 60s base TTL (was 30s)
// #698: cap simultaneous gh calls (per-PR fan-out, multi-project refresh) so we
// never trip GitHub's secondary rate limit.
const GH_MAX_CONCURRENT = 2;

const DEFAULT_CONFIG = {
  port: 8400,
  projects: [],
};

function readConfigFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    // #1029: once an installation is explicitly activated, route-local V1
    // consumers temporarily receive scalar compatibility values derived from
    // the canonical primary repository. Keep them non-enumerable so any legacy
    // read-modify-write path serializes only the canonical array and cannot
    // recreate a persisted dual source. Legacy pre-activation reads remain
    // byte-for-byte shaped as before.
    if (typeof parsed.installation_id === "string" && Array.isArray(parsed.projects)) {
      parsed.projects = parsed.projects.map((project) => {
        if (!Array.isArray(project?.repositories)) return project;
        const compatible = serializeProjectCompatibility(project);
        for (const field of ["repo", "working_dir"]) {
          if (!Object.prototype.hasOwnProperty.call(compatible, field)) continue;
          const value = compatible[field];
          delete compatible[field];
          Object.defineProperty(compatible, field, {
            value,
            enumerable: false,
            configurable: true,
          });
        }
        return compatible;
      });
    }
    return parsed;
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
    // #968: never expose the PTY session token here — it's handed to the local
    // dashboard only, via the localhost-gated GET /api/session-token.
    delete parsed.session_token;
    res.json(parsed);
  } catch (err) {
    if (err.code === "ENOENT") return res.json(DEFAULT_CONFIG);
    res.status(500).json({ error: "Failed to read config", detail: err.message });
  }
});

function sendV2ConfigurationError(res, err) {
  if (!(err instanceof ConfigurationValidationError)) return false;
  const payload = {
    error: "V2 configuration validation failed",
    code: err.code,
    field: err.field,
  };
  if (err.owner_project_id !== undefined) payload.owner_project_id = err.owner_project_id;
  res.status(409).json(payload);
  return true;
}

function genericV2ProjectTopology(config) {
  if (!Array.isArray(config?.projects)) {
    throw new ConfigurationValidationError(
      "generic_project_identity_change_forbidden",
      "projects.id",
      "generic config routes cannot change activated project identity",
    );
  }
  const topology = new Map();
  for (const project of config.projects) {
    if (!project || typeof project.id !== "string" || !project.id || topology.has(project.id)) {
      throw new ConfigurationValidationError(
        "generic_project_identity_change_forbidden",
        "projects.id",
        "generic config routes cannot change activated project identity",
      );
    }
    if (!Array.isArray(project.repositories)) {
      // The full V2 validator will return the more specific canonical schema
      // error. There is no valid key topology to compare here.
      topology.set(project.id, null);
      continue;
    }
    topology.set(project.id, [...new Set(project.repositories.map((entry) => entry?.key))]
      .sort((left, right) => String(left).localeCompare(String(right))));
  }
  return topology;
}

function assertGenericV2ProjectTopology(previousTopology, candidateConfig) {
  const candidateTopology = genericV2ProjectTopology(candidateConfig);
  const previousIds = [...previousTopology.keys()].sort();
  const candidateIds = [...candidateTopology.keys()].sort();
  if (JSON.stringify(previousIds) !== JSON.stringify(candidateIds)) {
    throw new ConfigurationValidationError(
      "generic_project_identity_change_forbidden",
      "projects.id",
      "generic config routes cannot change activated project identity",
    );
  }
  for (const projectId of previousIds) {
    const before = previousTopology.get(projectId);
    const after = candidateTopology.get(projectId);
    if (before === null || after === null) continue;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new ConfigurationValidationError(
        "generic_repository_topology_change_forbidden",
        "repositories.key",
        "generic config routes cannot change activated repository key topology",
      );
    }
  }
}

// #1034: archive state is lifecycle-owned. Generic config snapshots can edit
// project presentation/settings, but they must never archive, restore, or
// remove the absence of the lifecycle field on an existing project.
function preserveProjectArchiveState(existing, incoming) {
  if (!existing || !incoming || typeof incoming !== "object") return;
  if (Object.prototype.hasOwnProperty.call(existing, "archived")) {
    incoming.archived = existing.archived;
  } else {
    delete incoming.archived;
  }
}

router.put("/api/config", (req, res) => {
  try {
    const body = req.body;
    const dir = path.dirname(CONFIG_PATH);
    ensureSecureDir(dir);
    // Reconcile the caller snapshot only after updateConfig has acquired the
    // shared lock and read the live document. This closes both stale lifecycle
    // overwrite and V1→V2 activation races between request parsing and commit.
    updateConfig((cfg) => {
      const candidate = JSON.parse(JSON.stringify(body));
      const liveHasInstallationId = Object.prototype.hasOwnProperty.call(cfg, "installation_id");
      const bodyHasInstallationId = Object.prototype.hasOwnProperty.call(candidate, "installation_id");
      if (bodyHasInstallationId &&
          (!liveHasInstallationId || candidate.installation_id !== cfg.installation_id)) {
        const err = new Error("installation identity rotation rejected");
        err.code = "QW_INSTALLATION_ID_ROTATION";
        throw err;
      }
      if (liveHasInstallationId) candidate.installation_id = cfg.installation_id;
      else delete candidate.installation_id;

      for (const key of ["pinned_projects", "sidebar_groups", "reviewer_github_user", "session_token"]) {
        if (key in cfg) candidate[key] = cfg[key];
        else delete candidate[key];
      }
      if (typeof candidate.operator_name === "string" && "operator_name" in cfg &&
          candidate.operator_name === sanitizeOperatorName(cfg.operator_name)) {
        candidate.operator_name = cfg.operator_name;
      }

      if (Array.isArray(candidate.projects)) {
        const liveById = new Map((cfg.projects || []).map((project) => [project.id, project]));
        for (const project of candidate.projects) {
          const liveProject = liveById.get(project.id);
          if (!liveProject) continue;
          preserveProjectArchiveState(liveProject, project);
          for (const key of PROJECT_FLAG_KEYS) {
            if (key in liveProject) project[key] = liveProject[key];
            else delete project[key];
          }
        }
      }

      if (liveHasInstallationId) {
        assertGenericV2ProjectTopology(genericV2ProjectTopology(cfg), candidate);
      }
      for (const key of Object.keys(cfg)) delete cfg[key];
      Object.assign(cfg, candidate);
    });
    // Trigger sync is handled internally since we're in the same process now
    if (typeof req.app.get("syncTriggers") === "function") {
      req.app.get("syncTriggers")();
    }
    res.json({ ok: true });
  } catch (err) {
    if (sendV2ConfigurationError(res, err)) return;
    if (err.code === "QW_INSTALLATION_ID_ROTATION") {
      return res.status(409).json({ error: "installation_id cannot be introduced or replaced here" });
    }
    res.status(500).json({ error: "Failed to write config", detail: err.message });
  }
});

// #971: section-merge config write for the Settings form — the last frontend
// caller that used the whole-config PUT. It MERGES the provided sections into the
// freshest on-disk config under updateConfig (atomic, serialized), so it never
// does a whole-config read-modify-write and can't clobber a concurrent write:
//   - top-level keys the client owns are assigned (never the field-scoped-owned
//     keys pinned_projects/sidebar_groups/reviewer_github_user/session_token,
//     which have their own endpoints);
//   - operator_name keeps the raw on-disk value when the client echoes the
//     sanitized one it GET'd;
//   - projects are merged by id, PRESERVING each project's field-scoped flag
//     fields from disk; a project id not on disk is appended (Settings can add
//     one); on-disk projects absent from the body are left untouched.
const CONFIG_MERGE_EXCLUDED = new Set([
  "projects", "pinned_projects", "sidebar_groups", "reviewer_github_user", "session_token", "installation_id",
]);
router.patch("/api/config", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const disk = readConfigFile();
    const activated = Object.prototype.hasOwnProperty.call(disk, "installation_id");
    const affectsProjects = activated && Array.isArray(body.projects);
    const mutator = (cfg) => {
      const previousTopology = affectsProjects ? genericV2ProjectTopology(cfg) : null;
      if (Object.prototype.hasOwnProperty.call(body, "installation_id") &&
          (!Object.prototype.hasOwnProperty.call(cfg, "installation_id") ||
           body.installation_id !== cfg.installation_id)) {
        const err = new Error("installation identity rotation rejected");
        err.code = "QW_INSTALLATION_ID_ROTATION";
        throw err;
      }
      for (const [k, v] of Object.entries(body)) {
        if (CONFIG_MERGE_EXCLUDED.has(k)) continue;
        if (k === "operator_name" && typeof v === "string" &&
            "operator_name" in cfg && v === sanitizeOperatorName(cfg.operator_name)) {
          continue; // unchanged sanitized echo — keep the raw on-disk value
        }
        cfg[k] = v;
      }
      if (Array.isArray(body.projects)) {
        if (!Array.isArray(cfg.projects)) cfg.projects = [];
        const byId = new Map(cfg.projects.map((p) => [p.id, p]));
        for (const incoming of body.projects) {
          if (!incoming || typeof incoming !== "object" || !incoming.id) continue;
          const existing = byId.get(incoming.id);
          if (existing) {
            const preserved = {};
            for (const fk of PROJECT_FLAG_KEYS) if (fk in existing) preserved[fk] = existing[fk];
            const lifecycleOwner = Object.prototype.hasOwnProperty.call(existing, "archived")
              ? { archived: existing.archived }
              : {};
            Object.assign(existing, incoming, preserved);
            preserveProjectArchiveState(lifecycleOwner, existing);
          } else {
            cfg.projects.push(incoming);
          }
        }
      }
      if (previousTopology) assertGenericV2ProjectTopology(previousTopology, cfg);
    };
    if (affectsProjects) commitV2Configuration(mutator);
    else updateConfig(mutator);
  } catch (err) {
    if (sendV2ConfigurationError(res, err)) return;
    if (err.code === "QW_INSTALLATION_ID_ROTATION") {
      return res.status(409).json({ error: "installation_id cannot be introduced or replaced here" });
    }
    return res.status(500).json({ error: "Failed to write config", detail: err.message });
  }
  if (typeof req.app.get("syncTriggers") === "function") req.app.get("syncTriggers")();
  res.json({ ok: true });
});

// ─── Per-project flag toggles (field-scoped, race-free) — #971 ──────────────
// The toggle widgets (idle, awake_auto, trigger_auto, telegram/discord auto,
// bridge filter, loop-guard auto-continue) used to GET the whole config, flip
// one field, and PUT the entire object back — so any two overlapping toggles
// (or a Settings save) clobbered each other with stale snapshots. This endpoint
// merges ONLY the whitelisted flag(s) into the target project, under the
// atomic updateConfig() serialization point, so a toggle can never lose an
// unrelated concurrent write. Booleans, except the loop-guard delay (seconds).
const PROJECT_FLAG_KEYS = new Set([
  "idle",
  "awake_auto",
  "trigger_auto",
  "telegram_auto",
  "discord_auto",
  "bridge_filter_agents_only",
  "auto_continue_loop_guard",
  "auto_continue_delay_sec",
]);

router.patch("/api/projects/:id/flags", (req, res) => {
  const { id } = req.params;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const keys = Object.keys(body);
  if (keys.length === 0) return res.status(400).json({ error: "No flags provided" });

  const updates = {};
  for (const k of keys) {
    if (!PROJECT_FLAG_KEYS.has(k)) return res.status(400).json({ error: `Unknown flag: ${k}` });
    const v = body[k];
    if (k === "auto_continue_delay_sec") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return res.status(400).json({ error: "auto_continue_delay_sec must be a non-negative number" });
      }
    } else if (typeof v !== "boolean") {
      return res.status(400).json({ error: `${k} must be a boolean` });
    }
    updates[k] = v;
  }

  try {
    updateConfig((cfg) => {
      const entry = (cfg.projects || []).find((p) => p.id === id);
      if (!entry) { const e = new Error("not found"); e.code = "QW_NOT_FOUND"; throw e; }
      Object.assign(entry, updates);
    });
  } catch (err) {
    if (err.code === "QW_NOT_FOUND") return res.status(404).json({ error: `Unknown project: ${id}` });
    return res.status(500).json({ error: "Failed to write config", detail: err.message });
  }

  // idle / trigger_auto gate the scheduler — resync it (same as the whole PUT).
  if (typeof req.app.get("syncTriggers") === "function") req.app.get("syncTriggers")();
  res.json({ ok: true });
});

function safeProjectLifecyclePayload(result, projectId) {
  const source = result && typeof result === "object" ? result : {};
  const payload = {
    ok: source.ok === true,
    project_id: typeof source.project_id === "string" ? source.project_id : projectId,
    resources: {},
    cleanup_errors: [],
  };
  for (const key of ["archived", "removed", "already_archived", "already_unarchived"]) {
    if (typeof source[key] === "boolean") payload[key] = source[key];
  }
  if (Number.isSafeInteger(source.admission_generation) && source.admission_generation >= 0) {
    payload.admission_generation = source.admission_generation;
  }
  if (source.resources && typeof source.resources === "object" && !Array.isArray(source.resources)) {
    for (const [key, value] of Object.entries(source.resources)) {
      if (/^[a-z][a-z0-9_]{0,63}$/.test(key) && Number.isSafeInteger(value) && value >= 0) {
        payload.resources[key] = value;
      }
    }
  }
  if (Array.isArray(source.cleanup_errors)) {
    payload.cleanup_errors = source.cleanup_errors.map((entry) => ({
      resource: typeof entry?.resource === "string" ? entry.resource.slice(0, 64) : "project",
      code: typeof entry?.code === "string" ? entry.code.slice(0, 64) : "cleanup_failed",
      message: typeof entry?.message === "string"
        ? entry.message.replace(/[\r\n\t]+/g, " ").slice(0, 300)
        : "project cleanup failed",
    }));
  }
  if (!payload.ok && payload.cleanup_errors.length > 0) payload.code = "project_cleanup_incomplete";
  return payload;
}

function sendProjectLifecycleException(res, err, projectId) {
  if (err instanceof ProjectLifecycleError) {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 409;
    return res.status(status).json({
      ok: false,
      error: String(err.message || "project lifecycle operation failed").replace(/[\r\n\t]+/g, " ").slice(0, 300),
      code: typeof err.code === "string" ? err.code : "project_lifecycle_failed",
      project_id: typeof err.project_id === "string" ? err.project_id : projectId,
    });
  }
  if (err instanceof ConfigurationValidationError) {
    const payload = {
      ok: false,
      error: "V2 configuration validation failed",
      code: err.code,
      field: err.field,
      project_id: projectId,
    };
    if (err.owner_project_id !== undefined) payload.owner_project_id = err.owner_project_id;
    return res.status(409).json(payload);
  }
  return res.status(500).json({
    ok: false,
    error: "Project lifecycle operation failed",
    code: "project_lifecycle_failed",
    project_id: projectId,
  });
}

function projectLifecycleController(req, res, projectId) {
  const controller = req.app.get("projectLifecycle");
  if (controller) return controller;
  res.status(503).json({
    ok: false,
    error: "Project lifecycle controller is unavailable",
    code: "project_lifecycle_unavailable",
    project_id: projectId,
  });
  return null;
}

function requestedBridgeAdmission(body, projectId, res) {
  if (!Object.prototype.hasOwnProperty.call(body, "admission_generation")) return undefined;
  const generation = body.admission_generation;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    res.status(400).json({
      ok: false,
      error: "admission_generation must be a safe nonnegative integer",
      code: "invalid_admission_generation",
      project_id: projectId,
    });
    return null;
  }
  const admission = projectAdmission(projectId);
  if (!admission || admission.generation !== generation || !isAdmissionCurrent(admission)) {
    res.status(409).json({
      ok: false,
      error: "project admission changed; refresh and retry",
      code: "project_admission_changed",
      project_id: projectId,
    });
    return null;
  }
  return admission;
}

// #1034: archive/unarchive is a lifecycle barrier. The injected controller is
// the sole mutation authority; route-local config mutation is forbidden.
router.put("/api/projects/:id/archive", async (req, res) => {
  const { id } = req.params;
  if (typeof req.body?.archived !== "boolean") {
    return res.status(400).json({ ok: false, error: "archived must be a boolean", code: "invalid_archive_state", project_id: id });
  }
  const controller = projectLifecycleController(req, res, id);
  if (!controller) return;
  try {
    const result = req.body.archived
      ? await controller.archiveProject(id)
      : await controller.unarchiveProject(id);
    const payload = safeProjectLifecyclePayload(result, id);
    if (payload.archived === true) clearProjectBackgroundDemand(id);
    else if (payload.archived === false) {
      _projectsCache = null;
      _projectsCacheTs = 0;
    }
    return res.status(payload.ok ? 200 : 503).json(payload);
  } catch (err) {
    return sendProjectLifecycleException(res, err, id);
  }
});

router.delete("/api/projects/:id", async (req, res) => {
  const { id } = req.params;
  const controller = projectLifecycleController(req, res, id);
  if (!controller) return;
  try {
    const payload = safeProjectLifecyclePayload(await controller.removeProject(id), id);
    if (payload.archived === true || payload.removed === true) clearProjectBackgroundDemand(id);
    return res.status(payload.ok && payload.removed === true ? 200 : 503).json(payload);
  } catch (err) {
    return sendProjectLifecycleException(res, err, id);
  }
});

// ─── Pinned projects & sidebar groups (field-scoped, race-free) ─────────────
// #944: pins/groups used to persist via the whole-config GET→mutate→PUT path,
// which dropped them whenever any concurrent writer PUT a stale snapshot — and
// a restart fires several of those at once. These endpoints read the freshest
// config off disk, set ONLY their own key, and write it back, so a save can
// never clobber a concurrent one. The whole-config PUT above preserves both
// keys for the same reason.

// Validate pinned_projects: array of non-empty project-id strings, deduped.
// Returns the cleaned array, or null if the shape is invalid.
function validatePinnedProjects(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const id of value) {
    if (typeof id !== "string" || !id) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// Validate sidebar_groups: array of { name: non-empty string, projects: string[] }.
// Returns the cleaned array, or null if the shape is invalid.
function validateSidebarGroups(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const g of value) {
    if (!g || typeof g !== "object" || Array.isArray(g)) return null;
    if (typeof g.name !== "string" || !g.name) return null;
    if (!Array.isArray(g.projects)) return null;
    const projects = [];
    for (const id of g.projects) {
      if (typeof id !== "string" || !id) return null;
      projects.push(id);
    }
    out.push({ name: g.name, projects });
  }
  return out;
}

router.put("/api/pins", (req, res) => {
  const pins = validatePinnedProjects(req.body && req.body.pinned_projects);
  if (pins === null) {
    return res.status(400).json({ error: "pinned_projects must be an array of project id strings" });
  }
  try {
    const dir = path.dirname(CONFIG_PATH);
    ensureSecureDir(dir);
    const cfg = readConfigFile(); // read fresh — never a stale client snapshot
    cfg.pinned_projects = pins;
    writeConfig(cfg);
    res.json({ ok: true, pinned_projects: pins });
  } catch (err) {
    res.status(500).json({ error: "Failed to write config", detail: err.message });
  }
});

router.put("/api/sidebar-groups", (req, res) => {
  const groups = validateSidebarGroups(req.body && req.body.sidebar_groups);
  if (groups === null) {
    return res.status(400).json({ error: "sidebar_groups must be an array of { name, projects } objects" });
  }
  try {
    const dir = path.dirname(CONFIG_PATH);
    ensureSecureDir(dir);
    const cfg = readConfigFile(); // read fresh — never a stale client snapshot
    cfg.sidebar_groups = groups;
    writeConfig(cfg);
    res.json({ ok: true, sidebar_groups: groups });
  } catch (err) {
    res.status(500).json({ error: "Failed to write config", detail: err.message });
  }
});

function validateReviewerGithubUser(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v === "") return "";
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(v) ? v : null;
}

router.put("/api/reviewer-github-user", (req, res) => {
  const reviewer = validateReviewerGithubUser(req.body && req.body.reviewer_github_user);
  if (reviewer === null) {
    return res.status(400).json({ error: "reviewer_github_user must be a valid GitHub username or blank" });
  }
  try {
    const dir = path.dirname(CONFIG_PATH);
    ensureSecureDir(dir);
    const cfg = readConfigFile();
    if (reviewer) cfg.reviewer_github_user = reviewer;
    else delete cfg.reviewer_github_user;
    writeConfig(cfg);
    res.json({ ok: true, reviewer_github_user: reviewer });
  } catch (err) {
    res.status(500).json({ error: "Failed to write config", detail: err.message });
  }
});

// ─── Chat (file-based) ────────────────────────────────────────────────────

const {
  sanitizeOperatorName,
  ensureSecureDir,
  writeSecureFile,
  writeConfig,
  updateConfig,
  serializeProjectCompatibility,
  primaryRepository,
  ConfigurationValidationError,
  commitV2Configuration,
} = require("./config");
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

// #807: seed the per-project GITHUB.md from the template (idempotent — no-op if
// it already exists). Mirrors writeOvernightQueueFileSafe. The machine sections
// are then authored by the server on each fetch pass (writeGithubFileFromSnapshot).
function writeGithubFileSafe(projectId, projectName, repo) {
  try {
    const ghPath = path.join(CONFIG_DIR, projectId, "GITHUB.md");
    if (fs.existsSync(ghPath)) return;
    const tpl = path.join(TEMPLATES_DIR, "GITHUB.md");
    if (!fs.existsSync(tpl)) return;
    ensureSecureDir(path.dirname(ghPath));
    let content = fs.readFileSync(tpl, "utf-8");
    content = content.replace(/\{\{project_name\}\}/g, projectName || projectId || "");
    content = content.replace(/\{\{repo\}\}/g, repo || "");
    fs.writeFileSync(ghPath, content);
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
  // #783: return raw ISO `ts` only. The previous server-side `time`
  // field used the server's local time, which on UTC VPS hosts gave
  // wrong-timezone display. The frontend formats `ts` in the browser.
  return res.json(messages);
});

// #693: Auto-normalize bare agent names to @mentions in outbound messages.
// Bare "head", "dev", "re1", "re2" become "@head", "@dev", "@re1", "@re2".
// Already-prefixed mentions are not double-prefixed; suffixed names like
// "head-2" or "re1-3" are left untouched.
// #788: `skipName` is the sender's own agent name — it is never converted, so
// an agent writing "head received the batch" doesn't self-mention. Pass a
// falsy skipName (user / bridge senders) to normalize every name.
const MENTION_AGENT_NAMES = ["head", "dev", "re1", "re2"];
function normalizeMentions(text, skipName) {
  if (typeof text !== "string" || !text) return text || "";
  const names = skipName ? MENTION_AGENT_NAMES.filter((n) => n !== skipName) : MENTION_AGENT_NAMES;
  const preserved = [];
  const ph = "\x00CODE\x00";
  let safe = text.replace(/```[\s\S]*?```|`[^`]+`/g, (m) => {
    preserved.push(m);
    return ph;
  });
  safe = names.reduce(
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
  // #970: `project` flows into path.join(CONFIG_DIR, project, "activity.jsonl")
  // (mkdir + appendFileSync). Restrict it to a configured project id so a
  // crafted value like "../../tmp/x" can't become an arbitrary-path write
  // primitive (matches the project-scoping other write routes already apply).
  if (!(readConfigFile().projects || []).some((p) => p.id === project)) {
    return res.status(400).json({ error: "Invalid project" });
  }
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

  try {
    assertProjectAdmitted(projectId);
  } catch (err) {
    return sendProjectLifecycleException(res, err, projectId);
  }

  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text) return res.status(400).json({ error: "text required" });
  const shimSender = req.headers["x-chat-sender"];
  const shimToken = req.headers["x-chat-token"];
  const bridgeSender = req.headers["x-bridge-sender"];
  let sender = "user";
  // #788: only an authenticated agent (shim) sender skips its own name; user
  // and bridge messages normalize every name.
  let selfMentionSkip = null;
  if (shimSender && shimToken) {
    if (!fileChat.validateShimToken(projectId, shimSender, shimToken)) {
      return res.status(403).json({ error: "Invalid shim token" });
    }
    sender = shimSender;
    selfMentionSkip = shimSender;
  } else if (bridgeSender && isLocalhost(req.ip)) {
    // #970: the bridge relays external chat over localhost with no auth token;
    // it must not be able to post under a reserved agent identity
    // (head/dev/re1/re2/…), mirroring the reserved-sender denial on the
    // history-import path.
    if (RESERVED_HISTORY_SENDERS.has(bridgeSender.toLowerCase())) {
      return res.status(403).json({ error: "Reserved sender" });
    }
    sender = bridgeSender;
  }
  // #940: thread image attachments through. Persist only the `name`
  // (the absolute server FS `path` must not be stored/broadcast), and
  // since the name is later used to build a serve path, reject any with
  // path separators — same guard as the serve route.
  let attachments;
  if (req.body?.attachments !== undefined) {
    if (!Array.isArray(req.body.attachments)) {
      return res.status(400).json({ error: "attachments must be an array" });
    }
    attachments = req.body.attachments.map((att) => {
      const name = att?.name;
      if (typeof name !== "string" || !name || /[/\\]/.test(name)) {
        return null;
      }
      return { name };
    });
    if (attachments.some((att) => att === null)) {
      return res.status(400).json({ error: "Invalid attachment name" });
    }
  }
  const msg = fileChat.appendMessage(projectId, {
    sender,
    text: normalizeMentions(text, selfMentionSkip),
    channel: req.body?.channel || "general",
    type: "message",
    attachments,
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

router.post("/api/upload", (req, res, next) => {
  const projectId = req.query.project || "";
  try {
    assertProjectAdmitted(projectId);
    next();
  } catch (err) {
    sendProjectLifecycleException(res, err, projectId);
  }
}, upload.single("file"), (req, res) => {
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
  res.sendFile(filePath, { dotfiles: "allow" }, (err) => {
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

function shouldPublishProjectsCache(projectResults, admissions) {
  return projectResults.every((project) => {
    const currentlyArchived = isProjectArchived(project.id);
    if (currentlyArchived !== (project._archived === true)) return false;
    const admission = admissions.get(project.id);
    return !admission || isAdmissionCurrent(admission);
  });
}

router.get("/api/projects", async (req, res) => {
  if (_projectsCache && Date.now() - _projectsCacheTs < adaptiveTTL(PROJECTS_CACHE_TTL)) {
    return res.json(_projectsCache);
  }
  // #554: serve stale projects cache when critically rate-limited
  if (isRateLimited() && _projectsCache) {
    return res.json(_projectsCache);
  }

  const cfg = readConfigFile();
  const projectResultAdmissions = new Map();

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
    const configuredRepo = getRepo(p.id);
    if (isProjectArchived(p.id, cfg)) {
      const hasArchivedAgents = p.agents && Object.keys(p.agents).length > 0;
      return {
        id: p.id,
        name: p.name,
        repo: configuredRepo,
        agentCount: hasArchivedAgents ? Object.keys(p.agents).length : 0,
        openPrs: 0,
        state: "archived",
        lastActivity: null,
        _archived: true,
        _readonly: true,
      };
    }
    // #812: parked (idle) project — no gh calls; return zero/last-known metadata.
    if (p.idle) {
      const hasAgentsIdle = p.agents && Object.keys(p.agents).length > 0;
      return {
        id: p.id,
        name: p.name,
        repo: configuredRepo,
        agentCount: hasAgentsIdle ? Object.keys(p.agents).length : 0,
        openPrs: 0,
        state: "idle",
        lastActivity: null,
        _idle: true,
      };
    }
    const admission = projectAdmission(p.id, { demand: true });
    if (!admission) {
      return { id: p.id, name: p.name, repo: configuredRepo, agentCount: 0, openPrs: 0, state: "archived", lastActivity: null, _archived: true, _readonly: true };
    }
    projectResultAdmissions.set(p.id, admission);
    if (configuredRepo && REPO_RE.test(configuredRepo)) {
      try {
        // #806: REST + ETag instead of `gh pr list` (GraphQL-backed). Open-PR
        // count + latest cross-state PR activity; both conditional (mostly 304).
        const stillAdmitted = () => isAdmissionCurrent(admission);
        const [prs, recentPrs] = await Promise.all([
          ghApiConditional(`${configuredRepo}#projects-open-pulls`, `repos/${configuredRepo}/pulls?state=open&per_page=100`, stillAdmitted),
          ghApiConditional(`${configuredRepo}#projects-last-activity`, `repos/${configuredRepo}/pulls?state=all&sort=updated&direction=desc&per_page=1`, stillAdmitted),
        ]);
        if (Array.isArray(prs.data)) openPrs = prs.data.length;
        if (Array.isArray(recentPrs.data) && recentPrs.data[0]) lastActivity = recentPrs.data[0].updated_at || null;
      } catch {}
    }
    if (!isAdmissionCurrent(admission)) {
      return { id: p.id, name: p.name, repo: configuredRepo, agentCount: 0, openPrs: 0, state: "archived", lastActivity: null, _archived: true, _readonly: true };
    }
    const hasAgents = p.agents && Object.keys(p.agents).length > 0;
    return {
      id: p.id,
      name: p.name,
      repo: configuredRepo,
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
    let projectName = (cfg.projects || []).find((p) => m.text.includes(getRepo(p.id) || "") || m.text.includes(p.name))?.name;
    // Second: use the AC instance the message came from
    if (!projectName) projectName = msgToProject.get(m);
    // Fallback: single-project installs
    if (!projectName && cfg.projects && cfg.projects.length === 1) {
      projectName = cfg.projects[0].name;
    }
    if (projectName) {
      recentEvents.push({
        ts: m.ts,
        text: m.text.length > 120 ? m.text.slice(0, 120) + "…" : m.text,
        actor: m.sender,
        projectName,
      });
    }
    if (recentEvents.length >= 10) break;
  }

  const result = { projects: projectResults, recentEvents };
  if (shouldPublishProjectsCache(projectResults, projectResultAdmissions)) {
    _projectsCache = result;
    _projectsCacheTs = Date.now();
  }
  res.json(result);
});

// ─── GitHub Rate Limit (#554) ──────────────────────────────────────────────

// #866: expose each bucket as { limit, remaining, resetInMinutes, resetAt }
// so the header badge can color core / graphql / search independently.
function bucketView(b) {
  return {
    limit: b.limit,
    remaining: b.remaining,
    resetAt: b.resetAt,
    resetInMinutes: b.resetAt > Date.now() ? Math.ceil((b.resetAt - Date.now()) / 60000) : 0,
  };
}

router.get("/api/github/rate-limit", async (req, res) => {
  const resetIn = _rateLimit.resetAt > Date.now()
    ? Math.ceil((_rateLimit.resetAt - Date.now()) / 60000)
    : 0;
  // #893: project-aware reviewer budget. `?project=<id>` resolves the reviewer
  // token from that project's reviewer worktree (custom paths included); no /
  // unknown project → cfg/default (back-compatible with #886).
  const projectId = typeof req.query.project === "string" ? req.query.project : null;
  let reviewer = null;
  if (!projectId || !isProjectArchived(projectId)) {
    try {
      reviewer = reviewerRateLimitPayload(await getReviewerRateLimit(projectId));
    } catch { /* reviewer block is best-effort; never fail the core response */ }
  }
  res.json({
    // Top-level fields are core (REST), kept for the existing alert banner.
    limit: _rateLimit.limit,
    remaining: _rateLimit.remaining,
    resetAt: _rateLimit.resetAt,
    resetInMinutes: resetIn,
    low: isRateLow(),
    critical: isRateLimited(),
    updatedAt: _rateLimit.updatedAt,
    error: _rateLimit.error,
    // #866: per-bucket detail for the always-on header badge.
    core: bucketView(_rateLimit),
    graphql: bucketView(_graphqlRateLimit),
    search: bucketView(_searchRateLimit),
    // #886/#893: reviewer-token account (separate budget), present only when a
    // reviewer token resolves for the requested project (or cfg/default).
    ...(reviewer ? { reviewer } : {}),
  });
});

// ─── GitHub Issues / PRs ───────────────────────────────────────────────────

function getRepo(projectId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p) => p.id === projectId);
    const repo = primaryRepository(project)?.repo;
    if (repo && REPO_RE.test(repo)) return repo;
    return null;
  } catch {
    return null;
  }
}

// #812: per-project Idle toggle. When a project is idle, QuadWork must
// initiate ZERO project-specific GitHub/API activity for it. Callers
// (board fetch, per-endpoint handlers, batch-progress, /api/projects)
// check this before issuing any gh call.
function isProjectIdle(projectId) {
  if (!projectId) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !!cfg.projects?.find((p) => p.id === projectId)?.idle;
  } catch {
    return false;
  }
}

// #1034: background GitHub work is demand-driven per project. Archiving clears
// demand; restoring does not recreate it, so polling stays stopped until a
// real consumer asks for that project again.
const _githubDemandedProjects = new Set();

function projectAdmission(projectId, { demand = false } = {}) {
  try {
    const token = captureProjectAdmission(projectId);
    if (demand) _githubDemandedProjects.add(projectId);
    return token;
  } catch {
    return null;
  }
}

function clearProjectBackgroundDemand(projectId) {
  const resources = {
    github_demand: _githubDemandedProjects.delete(projectId) ? 1 : 0,
    github_leases: 0,
    batch_progress: 0,
  };
  _projectsCache = null;
  _projectsCacheTs = 0;
  for (const entry of _restRefreshing.values()) {
    for (const owner of entry?.owners || []) {
      if (owner?.project_id === projectId && entry.owners.delete(owner)) resources.github_leases += 1;
    }
  }
  const batchEntry = _batchProgressRefreshes?.get(projectId);
  if (batchEntry && _batchProgressRefreshes.delete(projectId)) resources.batch_progress = 1;
  return resources;
}

function archivedGithubLists(cached) {
  return cached
    ? { issues: cached.issues, prs: cached.prs, closedIssues: cached.closedIssues, mergedPrs: cached.mergedPrs, _archived: true, _readonly: true }
    : { issues: [], prs: [], closedIssues: [], mergedPrs: [], _archived: true, _readonly: true };
}

async function cancelProjectBackground(projectId) {
  return { ok: true, resources: clearProjectBackgroundDemand(projectId), cleanup_errors: [] };
}

// ─── #703 / #806: shared board cache ──────────────────────────────────────
// `_graphqlCache` holds each repo's assembled board snapshot. As of #806 it is
// populated by the REST+ETag fetcher (githubStateFetcher / refreshRepoRest);
// the batched GraphQL query below (fetchAllProjectsGraphQL) remains ONLY as an
// emergency fallback, gated on the GraphQL budget. Name kept for minimal churn.

const _graphqlCache = new Map(); // repo → { ts, issues, prs, closedIssues, mergedPrs }
const GRAPHQL_CACHE_TTL = 60_000; // same as GH_ENDPOINT_CACHE_TTL
let _graphqlRefreshInFlight = false;

const RECENT_FETCH_LIMIT = 20;
const RECENT_DISPLAY_LIMIT = 5;
// #828 P3: max state=closed pages (×100) to scan for the latest merged PRs when
// a burst of recently-closed *unmerged* PRs pushes real merges past page 1.
const MERGED_PAGE_CAP = 3;

// ─── #806 (#805 step 1): REST + ETag GitHub state fetcher ──────────────────
// The dashboard board was fed by `gh pr list`/`gh issue list --json
// reviewDecision,statusCheckRollup,...`, which are GraphQL-backed under the
// hood — draining GitHub's GraphQL points budget on every poll. This fetcher
// acquires the same state via plain REST (`gh api repos/...`) with conditional
// If-None-Match requests, so steady-state polling costs ~0 (304s are free and
// don't count against the budget). It feeds the existing _ghEndpointCache /
// _graphqlCache, and emits a single fully-assembled snapshot per pass.

// ETag store: etagKey → { etag, data } (the RAW REST JSON, re-mapped per pass).
const _etagStore = new Map();
// Per-repo in-flight refresh: repo → Promise. Concurrent callers AWAIT the same
// refresh (not just skip it) so a cold first load — where GitHubPanel fires the
// four list endpoints in parallel — never races ahead of the populated cache.
const _restRefreshing = new Map(); // repo → { owners: Set<exact admission token>, promise }

// Split a `gh api -i` response into its header block and JSON body. gh emits
// HTTP headers (CRLF) then a blank line then the body.
function _parseGhInclude(raw) {
  const sep = raw.search(/\r?\n\r?\n/);
  if (sep === -1) return { headerBlock: raw, body: "" };
  return {
    headerBlock: raw.slice(0, sep),
    body: raw.slice(sep).replace(/^\r?\n\r?\n/, ""),
  };
}

// Extract the ETag header value (GitHub sends it as `Etag:`; match any case).
function _extractEtag(headerBlock) {
  const m = headerBlock.match(/^etag:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

// gh exits non-zero on a 304; the marker lands in stderr ("gh: HTTP 304") and
// the status line in stdout when `-i` is used.
function _is304Error(err) {
  const blob = `${(err && err.stderr) || ""}${(err && err.stdout) || ""}`;
  return /HTTP 304|304 Not Modified/.test(blob);
}

// Conditional `gh api` GET. Reuses the stored ETag; on 304 returns the cached
// payload (status "unchanged", zero budget cost). Never throws — a hard
// failure returns the last good payload (if any) with status "error".
async function ghApiConditional(etagKey, apiPath, isCurrent = () => true) {
  if (!isCurrent()) return { status: "cancelled", data: null, changed: false };
  const prev = _etagStore.get(etagKey);
  const args = ["api", apiPath, "-i"];
  if (prev && prev.etag) args.push("-H", `If-None-Match: ${prev.etag}`);
  try {
    const { stdout } = await _execFileAsync("gh", args, { encoding: "utf-8", timeout: 15000, maxBuffer: GH_LIST_MAX_BUFFER });
    const { headerBlock, body } = _parseGhInclude(stdout);
    const etag = _extractEtag(headerBlock);
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!isCurrent()) return { status: "cancelled", data: null, changed: false };
    _etagStore.set(etagKey, { etag, data });
    return { status: "ok", data, changed: true };
  } catch (err) {
    if (_is304Error(err) && prev) {
      return { status: "unchanged", data: prev.data, changed: false };
    }
    return { status: "error", data: prev ? prev.data : null, changed: false };
  }
}

// Coalesce concurrent async work by key: a caller arriving while a call for the
// same key is in flight awaits the SAME promise (so it sees the result, not a
// premature miss); a fresh call starts only after the prior one settles.
function _coalesce(map, key, fn) {
  const inflight = map.get(key);
  if (inflight) return inflight;
  // Invoke eagerly so the work starts now; register before any await of fn can
  // resolve so same-tick concurrent callers join this exact promise.
  const p = (async () => fn())().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

// Run `fn` over `items` with at most `limit` concurrent in flight (keeps the
// per-PR fan-out from draining the core budget). Preserves input order.
async function _mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ── Canonical dashboard shape (pinned + tested; do NOT defer to "same as
// GraphQL"). issue/PR `state` is UPPERCASE OPEN/CLOSED/MERGED — matches the
// gh-CLI path and GitHubPanel.tsx's `state === "OPEN"` dot (the prior GraphQL
// transform lowercased to "open", an inconsistency this pins). ──
function restIssueToCanonical(it) {
  return {
    number: it.number,
    title: it.title,
    state: (it.state || "").toUpperCase(),
    url: it.html_url,
    labels: (it.labels || []).map((l) => ({ name: typeof l === "string" ? l : l.name })),
    assignees: (it.assignees || []).map((a) => ({ login: a.login })),
    createdAt: it.created_at,
  };
}

function restClosedIssueToCanonical(it) {
  return {
    number: it.number,
    title: it.title,
    state: (it.state || "closed").toUpperCase(),
    url: it.html_url,
    closedAt: it.closed_at,
  };
}

function restMergedPrToCanonical(p) {
  return {
    number: p.number,
    title: p.title,
    state: "MERGED",
    url: p.html_url,
    mergedAt: p.merged_at,
    author: p.user ? { login: p.user.login } : null,
  };
}

// Base open-PR row; reviews/reviewDecision/statusCheckRollup are attached after
// the per-PR sub-fetches.
function restPullBaseToCanonical(p) {
  return {
    number: p.number,
    title: p.title,
    state: (p.state || "").toUpperCase(),
    url: p.html_url,
    author: p.user ? { login: p.user.login } : null,
    assignees: (p.assignees || []).map((a) => ({ login: a.login })),
    createdAt: p.created_at,
  };
}

// Keep the FULL review list with bodies — re1/re2 share one GitHub author, so
// #807/#810 attribute ROLE from body markers, not author-latest collapse.
function mapReviews(restReviews) {
  return (restReviews || []).map((r) => ({
    state: r.state,
    author: r.user ? { login: r.user.login } : null,
    submittedAt: r.submitted_at,
    body: r.body || "",
  }));
}

// Derive a reviewDecision from the raw review list (the per-PR reviews are
// authoritative). Latest decision-affecting review per author wins; any
// CHANGES_REQUESTED blocks, else any APPROVED approves, else REVIEW_REQUIRED.
function deriveReviewDecision(reviews) {
  const byAuthor = new Map();
  const sorted = (reviews || []).slice().sort(
    (a, b) => (Date.parse(a && a.submittedAt) || 0) - (Date.parse(b && b.submittedAt) || 0),
  );
  for (const r of sorted) {
    const login = r && r.author && r.author.login;
    if (!login) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") {
      byAuthor.set(login, r.state);
    }
  }
  let approved = false;
  for (const s of byAuthor.values()) {
    if (s === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (s === "APPROVED") approved = true;
  }
  return approved ? "APPROVED" : "REVIEW_REQUIRED";
}

function _normCheckRunState(run) {
  if (run.status && run.status !== "completed") return "PENDING";
  switch ((run.conclusion || "").toLowerCase()) {
    case "success": return "SUCCESS";
    case "failure": case "timed_out": case "startup_failure": return "FAILURE";
    case "cancelled": case "action_required": case "stale": return "ERROR";
    case "neutral": case "skipped": return "SUCCESS";
    default: return "PENDING";
  }
}

function _normStatusState(state) {
  switch ((state || "").toLowerCase()) {
    case "success": return "SUCCESS";
    case "failure": return "FAILURE";
    case "error": return "ERROR";
    default: return "PENDING";
  }
}

// statusCheckRollup = check-runs AND the legacy combined-status, normalized to
// the { state } array GitHubPanel.tsx's ciColor/ciLabel expect (SUCCESS /
// FAILURE / ERROR / PENDING).
function buildStatusCheckRollup(checkRunsResp, statusResp) {
  const rollup = [];
  const runs = (checkRunsResp && checkRunsResp.check_runs) || [];
  for (const r of runs) rollup.push({ state: _normCheckRunState(r) });
  const statuses = (statusResp && statusResp.statuses) || [];
  for (const s of statuses) rollup.push({ state: _normStatusState(s.state) });
  return rollup;
}

// Fetch a repo's full board state via REST + ETag in one pass. Returns a single
// fully-assembled snapshot (never section-by-section) plus a status the file
// writer (#807) can trust: "ok" (something changed), "unchanged" (all 304s),
// or "error" (could not assemble any list — never stamp this as fresh).
// #828 P3: page through state=closed (newest-updated first) until we have
// ≥RECENT_DISPLAY_LIMIT merged PRs or hit the page cap — a burst of recently-
// closed *unmerged* PRs could otherwise push real merges past a single page and
// under-report "Recently merged". Page 1 is fetched in parallel with the other
// top lists and passed in; further pages are fetched on demand only when page 1
// is FULL (more pages may exist) AND short on merges. `fetchPage(page)` returns
// the same { status, data } shape as ghApiConditional. Pure control flow over
// an injected fetcher → unit-testable without network.
async function gatherClosedPrPages(firstPage, fetchPage, isCurrent = () => true) {
  const pages = [firstPage];
  const mergedCount = (r) => (Array.isArray(r && r.data) ? r.data : []).filter((p) => p.merged_at).length;
  let mergedSoFar = mergedCount(firstPage);
  let lastLen = Array.isArray(firstPage && firstPage.data) ? firstPage.data.length : 0;
  for (let page = 2; page <= MERGED_PAGE_CAP && mergedSoFar < RECENT_DISPLAY_LIMIT && lastLen === 100; page++) {
    if (!isCurrent()) break;
    const r = await fetchPage(page);
    pages.push(r);
    mergedSoFar += mergedCount(r);
    lastLen = Array.isArray(r && r.data) ? r.data.length : 0;
  }
  return pages;
}

// The latest RECENT_DISPLAY_LIMIT merged PRs across the gathered closed-PR
// pages, newest merge first. Pure → unit-testable.
function selectRecentMergedPrs(pages) {
  return pages
    .flatMap((r) => (Array.isArray(r && r.data) ? r.data : []))
    .filter((p) => p.merged_at)
    .sort((a, b) => (Date.parse(b && b.merged_at) || 0) - (Date.parse(a && a.merged_at) || 0))
    .slice(0, RECENT_DISPLAY_LIMIT)
    .map(restMergedPrToCanonical);
}

// #834: whether the closed-PR pagination reached the ACTUAL end of the list —
// the ONLY proof that no further closed/merged PR exists beyond what we scanned.
// True iff the LAST fetched page came back reliably (not an "error") AND had
// < 100 items (a genuine final page; a full 100 means more may exist). This is
// deliberately stricter than "the loop stopped": stopping early because the
// display need was met (≥5 merged) or hitting MERGED_PAGE_CAP while pages were
// still full does NOT prove completeness — those leave a full (===100) last
// page, so this returns false and the caller falls back to by-number. A 304
// carries the unchanged real data, so a short (<100) 304 page is a genuine end
// too; only "error" pages (possibly stale/null data) can't prove it. Pure.
function closedPagesComplete(pages) {
  const last = pages[pages.length - 1];
  return !!last && last.status !== "error" && Array.isArray(last.data) && last.data.length < 100;
}

// #834: issue numbers linked by the team's `[#N]` PR-title convention across
// ALL fetched closed-PR pages (not just the 5 displayed merged). Lets
// progressFromSnapshot prove an OPEN issue has no closed/merged linked PR —
// even one merged/closed outside the recent-5 window — before classifying it
// queued. Pure → unit-testable.
function closedPrIssueNumsFromPages(pages) {
  const re = /^\s*\[#(\d{1,7})\]/;
  const nums = [];
  for (const r of pages) {
    const arr = Array.isArray(r && r.data) ? r.data : [];
    for (const p of arr) {
      const m = ((p && p.title) || "").match(re);
      if (m) nums.push(parseInt(m[1], 10));
    }
  }
  return nums;
}

async function githubStateFetcher(repo, isCurrent = () => true) {
  const [owner, name] = (repo || "").split("/");
  if (!owner || !name || !isCurrent()) return { status: "cancelled", data: null };
  const base = `repos/${owner}/${name}`;
  let changed = 0;

  const [openPullsR, openIssuesR, closedIssuesR, closedPulls1R] = await Promise.all([
    ghApiConditional(`${repo}#pulls-open`, `${base}/pulls?state=open&per_page=50&sort=updated&direction=desc`, isCurrent),
    ghApiConditional(`${repo}#issues-open`, `${base}/issues?state=open&per_page=50&sort=updated&direction=desc`, isCurrent),
    ghApiConditional(`${repo}#issues-closed`, `${base}/issues?state=closed&per_page=100&sort=updated&direction=desc`, isCurrent),
    ghApiConditional(`${repo}#pulls-closed`, `${base}/pulls?state=closed&per_page=100&sort=updated&direction=desc`, isCurrent),
  ]);
  if (!isCurrent()) return { status: "cancelled", data: null };

  // #828 P3: extend the closed-PR window across pages only when needed (each
  // page conditional/ETag'd, so steady-state extra pages cost nothing on a 304).
  const closedPullPages = await gatherClosedPrPages(
    closedPulls1R,
    (page) => ghApiConditional(
      `${repo}#pulls-closed-p${page}`,
      `${base}/pulls?state=closed&per_page=100&sort=updated&direction=desc&page=${page}`,
      isCurrent,
    ),
    isCurrent,
  );
  if (!isCurrent()) return { status: "cancelled", data: null };

  let anyTopData = false;
  for (const r of [openPullsR, openIssuesR, closedIssuesR, ...closedPullPages]) {
    if (r.status === "ok") changed++;
    if (Array.isArray(r.data)) anyTopData = true;
  }
  // No list data at all (first run, every call failed) → don't fabricate a
  // snapshot; let callers keep serving whatever they already had.
  if (!anyTopData) return { status: "error", data: null };

  // REST /issues includes PRs — drop anything carrying a pull_request key.
  const issues = (Array.isArray(openIssuesR.data) ? openIssuesR.data : [])
    .filter((it) => !it.pull_request)
    .map(restIssueToCanonical);

  const closedIssues = (Array.isArray(closedIssuesR.data) ? closedIssuesR.data : [])
    .filter((it) => !it.pull_request)
    .sort((a, b) => (Date.parse(b && b.closed_at) || 0) - (Date.parse(a && a.closed_at) || 0))
    .slice(0, RECENT_DISPLAY_LIMIT)
    .map(restClosedIssueToCanonical);

  const mergedPrs = selectRecentMergedPrs(closedPullPages);

  // #828 P1: record whether the open-PR board window is PROVABLY complete — we
  // asked for 50 and got fewer, so we've seen EVERY open PR. progressFrom-
  // Snapshot relies on this to classify a no-matching-PR open issue as queued
  // without a by-number fetch; if exactly 50 came back the window may be
  // truncated and it must NOT guess.
  const openPrsWindowComplete = Array.isArray(openPullsR.data) && openPullsR.data.length < 50;
  // #834: queued-from-snapshot also requires proving NO closed/merged linked PR
  // exists. closedPrsWindowComplete = the closed-PR pagination reached an actual
  // <100 end (not just stopped early); closedPrIssueNums = every [#N] across ALL
  // scanned closed pages, so a PR merged/closed outside the recent-5 window
  // still blocks a false "queued". Both are consumed by progressFromSnapshot.
  const closedPrsWindowComplete = closedPagesComplete(closedPullPages);
  const closedPrIssueNums = closedPrIssueNumsFromPages(closedPullPages);

  const openPullsRaw = Array.isArray(openPullsR.data) ? openPullsR.data : [];
  const prs = await _mapLimited(openPullsRaw, GH_MAX_CONCURRENT, async (p) => {
    if (!isCurrent()) return null;
    const sha = p.head && p.head.sha;
    const [reviewsR, checkRunsR, statusR] = await Promise.all([
      ghApiConditional(`${repo}#reviews-${p.number}`, `${base}/pulls/${p.number}/reviews?per_page=100`, isCurrent),
      sha ? ghApiConditional(`${repo}#checkruns-${sha}`, `${base}/commits/${sha}/check-runs?per_page=100`, isCurrent) : Promise.resolve({ status: "error", data: null }),
      sha ? ghApiConditional(`${repo}#status-${sha}`, `${base}/commits/${sha}/status`, isCurrent) : Promise.resolve({ status: "error", data: null }),
    ]);
    if (!isCurrent()) return null;
    if (reviewsR.status === "ok" || checkRunsR.status === "ok" || statusR.status === "ok") changed++;
    const reviews = mapReviews(Array.isArray(reviewsR.data) ? reviewsR.data : []);
    return {
      ...restPullBaseToCanonical(p),
      reviews,
      reviewDecision: deriveReviewDecision(reviews),
      statusCheckRollup: buildStatusCheckRollup(checkRunsR.data, statusR.data),
    };
  });

  if (!isCurrent()) return { status: "cancelled", data: null };

  return {
    status: changed > 0 ? "ok" : "unchanged",
    data: { issues, prs: prs.filter(Boolean), closedIssues, mergedPrs, openPrsWindowComplete, closedPrsWindowComplete, closedPrIssueNums },
  };
}

// Refresh a single repo's REST snapshot into the shared caches. Coalesced: a
// concurrent caller (e.g. the parallel cold-load of all four list endpoints, or
// a background stale refresh overlapping an on-demand one) joins and awaits the
// SAME in-flight pass, so by the time it resolves the slice caches are written.
function refreshRepoRest(repo, ownerTokens = [], fetcher = githubStateFetcher) {
  const existing = _restRefreshing.get(repo);
  if (existing) {
    for (const token of ownerTokens) {
      if (token?.project_id) existing.owners.add(token);
    }
    return existing.promise;
  }
  const entry = { owners: new Set(), promise: null };
  for (const token of ownerTokens) {
    if (token?.project_id) entry.owners.add(token);
  }
  const hasCurrentOwner = () => [...entry.owners].some((token) => isAdmissionCurrent(token));
  if (!hasCurrentOwner()) return Promise.resolve({ status: "cancelled", data: null });
  entry.promise = (async () => {
    let result;
    try {
      const { status, data } = await fetcher(repo, hasCurrentOwner);
      if (!hasCurrentOwner()) return { status: "cancelled", data: null };
      if (data) {
        const now = Date.now();
        _graphqlCache.set(repo, { ts: now, ...data });
        _ghEndpointCache.set(`issues:${repo}`, { ts: now, data: data.issues, stale: false });
        _ghEndpointCache.set(`prs:${repo}`, { ts: now, data: data.prs, stale: false });
        _ghEndpointCache.set(`closed-issues:${repo}`, { ts: now, data: data.closedIssues, stale: false });
        _ghEndpointCache.set(`merged-prs:${repo}`, { ts: now, data: data.mergedPrs, stale: false });
      }
      result = { status, data };
    } catch {
      result = { status: "error", data: null };
    }
    // #807: the server is the sole author of GITHUB.md's machine sections —
    // regenerate it from this completed pass's snapshot (success or error so
    // staleCycles advances). Non-fatal; never affects the board cache result.
    if (hasCurrentOwner()) {
      try { syncGithubFilesForRepo(repo, result.status, entry.owners); } catch { /* non-fatal */ }
    }
    return result;
  })().finally(() => {
    if (_restRefreshing.get(repo) === entry) _restRefreshing.delete(repo);
  });
  _restRefreshing.set(repo, entry);
  return entry.promise;
}

// ─── #807 (#805 step 2): server-authored GITHUB.md ────────────────────────
// Per-project GITHUB.md mirrors OVERNIGHT-QUEUE.md: the server is the sole
// author of the machine sections (built from #806's structured snapshot),
// agents read the file for discovery. Section bodies are injection-safe and
// strictly parseable (parseGithub). The `## Notes` block is human/HEAD-writable
// and preserved across regeneration.

// Per-project freshness: projectId → { generatedAt(ms), staleCycles }.
const _githubMeta = new Map();
// #807: FIXED freshness window for the live `_stale` signal — must NOT use
// adaptiveTTL, which returns Infinity under critical rate-limit (the exact case
// where no sync pass runs and staleness is unbounded). ~5 poll cycles.
const GITHUB_FRESH_TTL_MS = 5 * 60_000;

// Live staleness for /api/github-parsed: stale if the file says so, if we have
// no generatedAt, or if the snapshot is older than the FIXED window. Pure so
// the rate-limit edge case (unbounded age) is regression-tested directly.
// #827: a NaN ageMs (Date.parse of a malformed/corrupted `generatedAt`) must
// count as stale/unknown — NOT fresh. Without the guard, `NaN > window` is
// false and staleness would be hidden exactly when the file is suspect.
function _githubLiveStale(headerStale, ageMs) {
  return headerStale || ageMs == null || Number.isNaN(ageMs) || ageMs > GITHUB_FRESH_TTL_MS;
}
const GITHUB_SECTION_HEADERS = {
  openIssues: "Open Issues",
  openPRs: "Open PRs",
  closedIssues: "Recently Closed Issues",
  mergedPrs: "Recently Merged PRs",
};

// Collapse untrusted text to a single safe line so it can NEVER begin a new
// `## ` section marker or break the strict list-line grammar. Also strips the
// field delimiter (·) we use, and `[`/`]` that bound the assignees field.
function _sanitizeInline(s) {
  return String(s == null ? "" : s)
    .replace(/[\r\n]+/g, " ")
    .replace(/[·\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _renderAssignees(assignees) {
  // Empty → "" so the rendered `[]` round-trips back to an empty array (rather
  // than a phantom assignee literally named "none").
  const logins = (assignees || []).map((a) => a && a.login).filter(Boolean).map(_sanitizeInline);
  return logins.map((l) => `@${l}`).join(", ");
}

// One strict list line: `- [#N](url) · STATE · [assignees] · title`. The
// free-text title is LAST (the parser reads it as the line tail), and url is
// whitespace-free, so neither can corrupt the earlier fixed fields.
function _renderListItem(item) {
  const url = _sanitizeInline(item.url).replace(/\s/g, "") || "-";
  const state = _sanitizeInline(item.state).toUpperCase() || "OPEN";
  return `- [#${item.number}](${url}) · ${state} · [${_renderAssignees(item.assignees)}] · ${_sanitizeInline(item.title)}`;
}

function _renderSection(items, renderLine) {
  if (!items || items.length === 0) return "(none)";
  return items.map(renderLine).join("\n");
}

// Latest review per body-marker ROLE (re1/re2) across the shared author's full
// review list — GitHub login can't distinguish the reviewers (same account), so
// we match RE1/RE2/Reviewer1/Reviewer2/T2a/T2b (and `## Verdict`→re1) prefixes
// in the review BODY. A marker-less/ambiguous review is UNCOUNTED (never
// over-counts). Mirrors GitHubPanel.tsx's body-marker logic.
function attributeReviewsByRole(reviews) {
  const sorted = (reviews || []).slice().sort(
    (a, b) => (Date.parse(a && a.submittedAt) || 0) - (Date.parse(b && b.submittedAt) || 0),
  );
  const out = { re1: null, re2: null };
  for (const r of sorted) {
    const body = ((r && r.body) || "").trim();
    let role = null;
    if (/^(?:RE2|Reviewer2|T2b)\b/i.test(body)) role = "re2";
    else if (/^(?:RE1|Reviewer1|T2a)\b/i.test(body) || /^##\s*Verdict/i.test(body)) role = "re1";
    if (!role) continue; // ambiguous → uncounted
    out[role] = { state: r.state, submittedAt: r.submittedAt || null };
  }
  return out;
}

function _renderReviewDetail(prs) {
  const lines = [];
  for (const pr of prs || []) {
    const roles = attributeReviewsByRole(pr.reviews);
    for (const role of ["re1", "re2"]) {
      const rv = roles[role];
      if (!rv) continue;
      lines.push(`- #${pr.number} · ${role}:${_sanitizeInline(rv.state).toUpperCase()} · ${_sanitizeInline(rv.submittedAt) || "-"}`);
    }
  }
  return lines.length ? lines.join("\n") : "(none)";
}

// Build the full GITHUB.md from a structured snapshot. Pure (no I/O). `notesBody`
// is the preserved `## Notes` text. `meta` = { generatedAt(ms), staleCycles }.
function renderGithubMarkdown(projectName, repo, snapshot, meta, notesBody) {
  const snap = snapshot || {};
  const generatedAt = meta && meta.generatedAt ? new Date(meta.generatedAt).toISOString() : "never";
  const staleCycles = (meta && meta.staleCycles) || 0;
  const stale = staleCycles > 0 || !meta || !meta.generatedAt;
  return [
    `# ${projectName || ""} — GitHub State`,
    "",
    `> **Repo:** ${repo || ""}`,
    `> **Generated:** ${generatedAt} · staleCycles: ${staleCycles} · stale: ${stale}`,
    ">",
    "> Machine-generated by QuadWork — do NOT edit the sections below (overwritten",
    "> on every sync). Edit only `## Notes`.",
    "",
    "---",
    "",
    `## ${GITHUB_SECTION_HEADERS.openIssues}`,
    "",
    _renderSection(snap.issues, _renderListItem),
    "",
    "---",
    "",
    `## ${GITHUB_SECTION_HEADERS.openPRs}`,
    "",
    _renderSection(snap.prs, _renderListItem),
    "",
    "---",
    "",
    `## ${GITHUB_SECTION_HEADERS.closedIssues}`,
    "",
    _renderSection(snap.closedIssues, _renderListItem),
    "",
    "---",
    "",
    `## ${GITHUB_SECTION_HEADERS.mergedPrs}`,
    "",
    _renderSection(snap.mergedPrs, _renderListItem),
    "",
    "---",
    "",
    "## Review Detail",
    "",
    _renderReviewDetail(snap.prs),
    "",
    "---",
    "",
    "## Notes",
    "",
    (notesBody && notesBody.trim()) ? notesBody.trim() : "(none)",
    "",
  ].join("\n");
}

const _GITHUB_DEFAULT_NOTES =
  "_Advisory only. The Review Detail above is body-marker attribution (re1/re2),\n" +
  "not merge-authoritative — Head re-checks live before merging. This section is\n" +
  "human/Head-writable and is preserved across regeneration._";

// Extract the existing `## Notes` body (preserved verbatim across regeneration).
// Anchored to line start (multiline) so it matches the real `## Notes` SECTION,
// not the `` `## Notes` `` reference in the header instructions. Notes is the
// last section, so we capture to EOF and do NOT strip trailing `## ` lines —
// that lets a human note contain its own `## ` headings without truncation.
function _extractNotesBody(text) {
  const m = (text || "").match(/^##\s+Notes\b[^\n]*\n([\s\S]*)$/im);
  if (!m) return _GITHUB_DEFAULT_NOTES;
  const body = m[1].trim();
  return body || _GITHUB_DEFAULT_NOTES;
}

// Write one project's GITHUB.md atomically (temp + rename) from a snapshot,
// preserving its `## Notes`. status drives the freshness meta.
function writeGithubFileFromSnapshot(projectId, projectName, repo, snapshot, status) {
  try {
    // #827: re-check idle here (reads config fresh) — syncGithubFilesForRepo
    // filtered on a config snapshot taken earlier, so an idle-flip concurrent
    // with a setup-seed/refresh pass could otherwise still write a parked
    // project's GITHUB.md. Defensive; idle projects must author nothing.
    if (isProjectIdle(projectId) || isProjectArchived(projectId)) return;
    const dir = path.join(CONFIG_DIR, projectId);
    const filePath = path.join(dir, "GITHUB.md");
    // Cold + total failure with nothing cached: leave the seeded template be.
    if (!snapshot && status === "error") return;
    ensureSecureDir(dir);

    let notesBody = _GITHUB_DEFAULT_NOTES;
    try { notesBody = _extractNotesBody(fs.readFileSync(filePath, "utf-8")); } catch { /* seed defaults */ }

    const meta = _githubMeta.get(projectId) || { generatedAt: 0, staleCycles: 0 };
    if (status === "error") {
      meta.staleCycles += 1; // keep last generatedAt — never stamp a failed cycle fresh
    } else {
      meta.generatedAt = Date.now();
      meta.staleCycles = 0;
    }
    _githubMeta.set(projectId, meta);

    const content = renderGithubMarkdown(projectName, repo, snapshot, meta, notesBody);
    const tmp = path.join(dir, `.GITHUB.md.tmp-${process.pid}`);
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, filePath); // atomic — readers never see partial content
  } catch { /* non-fatal */ }
}

// Regenerate GITHUB.md for every non-idle project bound to this repo, from the
// last-good snapshot in _graphqlCache. Idle projects are never regenerated.
function syncGithubFilesForRepo(repo, status, ownerTokens = new Set()) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return; }
  const snapshot = _graphqlCache.get(repo) || null;
  for (const p of cfg.projects || []) {
    const token = [...ownerTokens].find((candidate) => candidate?.project_id === p.id && isAdmissionCurrent(candidate));
    if (getRepo(p.id) !== repo || p.idle || !token || !isAdmissionCurrent(token)) continue;
    writeGithubFileFromSnapshot(p.id, p.name || p.id, repo, snapshot, status);
  }
}

// ── Strict GITHUB.md parser (mirrors parseActiveBatch). Pure; section-isolating
// (stops at the next `## `); list lines must match the exact grammar so prose
// `#N` can't leak. Distinguishes a parse error (not our file) from an
// empty-but-valid section. Exported for unit tests. ──
const _GH_ITEM_RE = /^-\s+\[#(\d{1,7})\]\((\S+)\)\s+·\s+(OPEN|CLOSED|MERGED)\s+·\s+\[([^\]]*)\]\s+·\s+(.*)$/;
const _GH_REVIEW_RE = /^-\s+#(\d{1,7})\s+·\s+(re1|re2):([A-Z_]+)\s+·\s+(\S+)$/;
const _GH_FRESH_RE = /\*\*Generated:\*\*\s*(\S+)\s*·\s*staleCycles:\s*(\d+)\s*·\s*stale:\s*(true|false)/i;

function _ghSection(text, header) {
  const re = new RegExp(`##\\s+${header.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b[\\s\\S]*?(?=\\n##\\s|$)`, "i");
  const m = text.match(re);
  return m ? m[0] : null;
}

function _parseGhList(text, header) {
  const section = _ghSection(text, header);
  if (section == null) return null; // header missing → distinct from empty
  const items = [];
  for (const line of section.split("\n")) {
    const m = line.match(_GH_ITEM_RE);
    if (!m) continue; // prose / "(none)" / blanks are skipped
    const assignees = m[4].split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean).map((login) => ({ login }));
    items.push({ number: parseInt(m[1], 10), url: m[2], state: m[3], assignees, title: m[5].trim() });
  }
  return items;
}

function parseGithub(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "empty or non-string input" };
  }
  const openIssues = _parseGhList(text, GITHUB_SECTION_HEADERS.openIssues);
  const openPRs = _parseGhList(text, GITHUB_SECTION_HEADERS.openPRs);
  const closedIssues = _parseGhList(text, GITHUB_SECTION_HEADERS.closedIssues);
  const mergedPrs = _parseGhList(text, GITHUB_SECTION_HEADERS.mergedPrs);
  // If none of the required machine headers exist, this isn't a GITHUB.md.
  if (openIssues == null && openPRs == null && closedIssues == null && mergedPrs == null) {
    return { ok: false, error: "no recognizable GITHUB.md sections" };
  }

  // Review Detail → { [prNumber]: { re1?: {state,submittedAt}, re2?: {...} } }.
  const reviewDetail = {};
  const reviewSection = _ghSection(text, "Review Detail");
  if (reviewSection) {
    for (const line of reviewSection.split("\n")) {
      const m = line.match(_GH_REVIEW_RE);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      (reviewDetail[n] || (reviewDetail[n] = {}))[m[2]] = { state: m[3], submittedAt: m[4] };
    }
  }

  const fresh = text.match(_GH_FRESH_RE);
  return {
    ok: true,
    generatedAt: fresh && fresh[1] !== "never" ? fresh[1] : null,
    staleCycles: fresh ? parseInt(fresh[2], 10) : 0,
    stale: fresh ? fresh[3].toLowerCase() === "true" : true,
    openIssues: openIssues || [],
    openPRs: openPRs || [],
    closedIssues: closedIssues || [],
    mergedPrs: mergedPrs || [],
    reviewDetail,
  };
}

// Build and execute a batched GraphQL query for all configured projects.
// Returns a Map of repo → { issues, prs, closedIssues, mergedPrs }.
async function fetchAllProjectsGraphQL() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
  const projects = (cfg.projects || []).filter((p) => {
    const repo = getRepo(p.id);
    return repo && REPO_RE.test(repo) && !p.idle &&
      _githubDemandedProjects.has(p.id) && !isProjectArchived(p.id, cfg);
  }); // #812/#1034: skip idle, archived, and not-yet-demanded projects
  const admissions = new Map();
  const admittedProjects = [];
  for (const project of projects) {
    const admission = projectAdmission(project.id);
    if (!admission) continue;
    admissions.set(project.id, admission);
    admittedProjects.push(project);
  }
  if (admittedProjects.length === 0) return null;

  // Build aliased repository fields — one per project.
  // Alias must be a valid GraphQL identifier: letters/digits/underscore only.
  const seen = new Set();
  const fragments = [];
  for (const p of admittedProjects) {
    const repo = getRepo(p.id);
    const [owner, name] = repo.split("/");
    const alias = repo.replace(/[^a-zA-Z0-9]/g, "_");
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
    nodes { number title url state author { login } reviews(last: 100) { nodes { state author { login } submittedAt body } } createdAt }
  }
  mergedPRs: pullRequests(first: ${RECENT_FETCH_LIMIT}, states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url state mergedAt author { login } }
  }
}`;

  try {
    const { stdout } = await _execFileAsync("gh", [
      "api", "graphql", "-f", `query=${query}`,
    ], { encoding: "utf-8", timeout: 15000, maxBuffer: GH_LIST_MAX_BUFFER });
    const data = JSON.parse(stdout).data;
    if (!data) return null;

    const result = new Map();
    for (const p of admittedProjects) {
      if (!isAdmissionCurrent(admissions.get(p.id))) continue;
      const repo = getRepo(p.id);
      const alias = repo.replace(/[^a-zA-Z0-9]/g, "_");
      const repoData = data[alias];
      if (!repoData) continue;

      // Transform GraphQL nodes into the same shape as gh CLI JSON output.
      // #806: pin canonical uppercase state for emergency-fallback parity with
      // the REST path. reviewDecision/statusCheckRollup are absent here (the
      // GraphQL query doesn't fetch them) — acceptable for a degraded fallback.
      const issues = (repoData.openIssues?.nodes || []).map((n) => ({
        number: n.number,
        title: n.title,
        state: (n.state || "").toUpperCase(),
        url: n.url,
        labels: (n.labels?.nodes || []).map((l) => ({ name: l.name })),
        assignees: (n.assignees?.nodes || []).map((a) => ({ login: a.login })),
        createdAt: n.createdAt,
      }));

      const prs = (repoData.openPRs?.nodes || []).map((n) => ({
        number: n.number,
        title: n.title,
        state: (n.state || "").toUpperCase(),
        url: n.url,
        author: n.author ? { login: n.author.login } : null,
        assignees: [],
        reviews: (n.reviews?.nodes || []).map((r) => ({
          state: r.state,
          author: r.author ? { login: r.author.login } : null,
          submittedAt: r.submittedAt,
          body: r.body || "",
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
          state: (n.state || "CLOSED").toUpperCase(),
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
          state: (n.state || "MERGED").toUpperCase(),
          url: n.url,
          mergedAt: n.mergedAt,
          author: n.author ? { login: n.author.login } : null,
        }));

      result.set(repo, { issues, prs, closedIssues, mergedPrs });
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
  // #806: the board state now comes from REST + ETag (githubStateFetcher), so
  // gate on the REST (core) budget. 304s are free, but the first/changed
  // fetches cost core — back off when REST is critically low and let consumers
  // serve stale. (Name kept so the module-scope auto-start stays untouched.)
  if (isRateLimited()) return;
  _graphqlRefreshInFlight = true;
  try {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return; }
    const seen = new Set();
    const repos = [];
    const ownersByRepo = new Map();
    for (const p of cfg.projects || []) {
      const repo = getRepo(p.id);
      if (!repo || !REPO_RE.test(repo) || p.idle) continue; // #812: skip idle
      if (!_githubDemandedProjects.has(p.id) || isProjectArchived(p.id, cfg)) continue;
      const token = repo && projectAdmission(p.id);
      if (!repo || !token) continue;
      if (!ownersByRepo.has(repo)) ownersByRepo.set(repo, []);
      ownersByRepo.get(repo).push(token);
      if (seen.has(repo)) continue;
      seen.add(repo);
      repos.push(repo);
    }
    const results = await _mapLimited(repos, GH_MAX_CONCURRENT, (repo) =>
      refreshRepoRest(repo, ownersByRepo.get(repo)).then((r) => ({ repo, status: r.status })),
    );

    // #805/#806 emergency fallback: if REST could not assemble a snapshot for
    // some repos AND the GraphQL budget is healthy, backfill via the legacy
    // batched GraphQL query (gated on the GRAPHQL bucket, never REST).
    const failed = results.filter((r) => r.status === "error").map((r) => r.repo);
    if (failed.length > 0 && !isGraphqlRateLimited()) {
      const gql = await fetchAllProjectsGraphQL();
      if (gql) {
        const now = Date.now();
        for (const repo of failed) {
          const currentOwners = ownersByRepo.get(repo) || [];
          if (!currentOwners.some((token) => isAdmissionCurrent(token))) continue;
          const d = gql.get(repo);
          if (!d) continue;
          _graphqlCache.set(repo, { ts: now, ...d });
          _ghEndpointCache.set(`issues:${repo}`, { ts: now, data: d.issues, stale: false });
          _ghEndpointCache.set(`prs:${repo}`, { ts: now, data: d.prs, stale: false });
          _ghEndpointCache.set(`closed-issues:${repo}`, { ts: now, data: d.closedIssues, stale: false });
          _ghEndpointCache.set(`merged-prs:${repo}`, { ts: now, data: d.mergedPrs, stale: false });
        }
      }
    }
  } catch {
    // Non-fatal — consumers serve last-known cache.
  } finally {
    _graphqlRefreshInFlight = false;
  }
}

// Start background GraphQL polling alongside rate-limit polling.
let _graphqlPollTimer = null;
function startGraphQLPolling() {
  if (_graphqlPollTimer) return;
  // #836: both the warm-up setTimeout and the steady-state setInterval are
  // .unref()'d so a test/import process can exit. The Express HTTP listener
  // keeps prod alive on its own; cadence is unchanged.
  // Initial fetch after a short delay (let rate-limit poll run first).
  setTimeout(() => refreshGraphQLCache(), 2000).unref();
  _graphqlPollTimer = setInterval(refreshGraphQLCache, GRAPHQL_CACHE_TTL);
  _graphqlPollTimer.unref();
}

// ─── #810: batch progress sourced from the REST snapshot ──────────────────
// #806's server cache already holds open PRs (with full reviews + bodies),
// open/closed issues, and merged PRs. Batch progress is computed from that
// snapshot in steady state — no GraphQL — falling back to a targeted by-number
// fetch only when an active-batch issue sits outside the board window.

// Per-ROLE approval count. re1/re2 share one GitHub login, so we attribute by
// body-marker ROLE (attributeReviewsByRole, #807) and count roles whose LATEST
// decision-affecting review is APPROVED — max 2 (re1, re2). NOT per-author.
function countApprovedRoles(reviews) {
  const roles = attributeReviewsByRole(reviews);
  return ["re1", "re2"].filter((r) => roles[r] && roles[r].state === "APPROVED").length;
}

// Compute issue `n`'s progress row from the snapshot (no network). Links
// issue↔PR by the team's `[#<issue>]` PR-title convention. Returns a row when
// the snapshot can PROVE the state: a matching in-window PR (in_review/approved/
// ready/merged), or — #828 P1 / #834 — a queued OPEN issue when BOTH windows are
// provably complete: openPrsWindowComplete (<50 open PRs → no open PR exists)
// AND closedPrsWindowComplete (the closed-PR pagination reached an actual <100
// end) with the issue absent from closedPrIssueNums (every [#N] across ALL
// scanned closed pages, so a PR merged/closed even OUTSIDE the recent-5 window
// is accounted for). Returns null otherwise (either window unproven, issue
// absent, CLOSED-with-no-in-window-PR, merged-but-open, or a linked closed/
// merged PR exists) — a partial window can't prove absence of a linked PR, so
// the caller does the authoritative by-number REST fetch (progressForItemRest).
function progressFromSnapshot(snapshot, n) {
  if (!snapshot) return null;
  const titleRe = new RegExp(`^\\s*\\[#${n}\\]`);
  const openPr = (snapshot.prs || []).find((p) => titleRe.test(p.title || ""));
  const mergedPr = (snapshot.mergedPrs || []).find((p) => titleRe.test(p.title || ""));
  const openIssue = (snapshot.issues || []).find((i) => i.number === n);
  const closedIssue = (snapshot.closedIssues || []).find((i) => i.number === n);
  const title = (openIssue && openIssue.title) || (closedIssue && closedIssue.title) || `#${n}`;

  // merged requires a matching merged PR in-window AND the issue CLOSED.
  if (mergedPr && closedIssue) {
    return {
      issue_number: n, title: closedIssue.title, url: mergedPr.url || closedIssue.url,
      pr_number: mergedPr.number, status: "merged", progress: 100, label: "Merged ✓",
    };
  }
  // Matching open PR in-window → confident in_review/approved/ready.
  if (openPr) {
    const approvals = countApprovedRoles(openPr.reviews);
    if (approvals >= 2) return { issue_number: n, title, url: openPr.url, pr_number: openPr.number, status: "ready", progress: 80, label: `PR #${openPr.number} · 2 approvals · ready` };
    if (approvals === 1) return { issue_number: n, title, url: openPr.url, pr_number: openPr.number, status: "approved1", progress: 50, label: `PR #${openPr.number} · 1 approval` };
    return { issue_number: n, title, url: openPr.url, pr_number: openPr.number, status: "in_review", progress: 20, label: `PR #${openPr.number} · waiting on review` };
  }
  // No matching open/in-window-merged PR. #828 P1 / #834: classify queued from
  // the snapshot ONLY when absence of BOTH an open AND a closed/merged linked PR
  // is proven — openPrsWindowComplete (no open PR) AND closedPrsWindowComplete
  // (the closed-PR window genuinely ended) AND `n` not in closedPrIssueNums
  // (no [#N] across ANY scanned closed page, incl. merges past the recent-5
  // display window). Then an OPEN issue is genuinely queued — NO network. Any
  // gap (either window unproven, or a linked closed/merged PR exists) → null,
  // and the by-number REST fetch resolves it authoritatively.
  if (
    snapshot.openPrsWindowComplete &&
    snapshot.closedPrsWindowComplete &&
    openIssue &&
    !openPr &&
    !(snapshot.closedPrIssueNums || []).includes(n)
  ) {
    return buildNoPrRow({ number: n, title: openIssue.title, state: "OPEN", url: openIssue.url });
  }
  // Can't prove the issue has no linked PR (a window unproven / issue absent /
  // linked closed PR) — return null; the by-number REST fetch resolves it.
  return null;
}

// #943: per-ROLE approval count from the PERSISTED GITHUB.md Review Detail,
// which parseGithub already attributes by body-marker role → { re1?: { state },
// re2?: { state } }. Mirrors countApprovedRoles' semantics (re1/re2, latest
// decision APPROVED) but reads the already-attributed parse rather than raw
// review bodies (the file doesn't carry per-review bodies).
function approvalsFromReviewDetail(reviewDetail, prNumber) {
  const rd = (reviewDetail && reviewDetail[prNumber]) || {};
  return ["re1", "re2"].filter((role) => rd[role] && rd[role].state === "APPROVED").length;
}

// #943: resolve issue `n`'s progress row from the PERSISTED GITHUB.md parse
// (parseGithub output) — used when the in-memory _graphqlCache is empty, e.g.
// just after a server restart. The file survives restarts, so this replaces the
// post-restart burst of live per-item Searches that mis-rendered queued items
// as "fetch failed". Mirrors progressFromSnapshot's buckets, with two shape
// differences: approvals come from the parsed Review Detail, and the merged/
// closed windows are the file's recent-display slice (open PRs are the full
// window). An active-batch OPEN issue with no matching [#N] open PR and no
// in-window merged PR is genuinely queued (NO network). Items the file can't
// classify (absent, or merged-but-still-open) return null; the caller renders a
// soft "queued (retrying)" row that firms up once the snapshot repopulates.
function progressFromGithubFile(parsed, n) {
  if (!parsed || !parsed.ok) return null;
  // NOTE: parseGithub's titles come through _sanitizeInline, which STRIPS the
  // `[` `]` of the `[#N]` convention — so the persisted PR title reads `#N …`,
  // not `[#N] …` (unlike the in-memory snapshot progressFromSnapshot matches).
  // Anchor on `#N` + a word boundary so `#80` can't match issue 8.
  const titleRe = new RegExp(`^\\s*#${n}\\b`);
  const openPr = (parsed.openPRs || []).find((p) => titleRe.test(p.title || ""));
  const mergedPr = (parsed.mergedPrs || []).find((p) => titleRe.test(p.title || ""));
  const openIssue = (parsed.openIssues || []).find((i) => i.number === n);
  const closedIssue = (parsed.closedIssues || []).find((i) => i.number === n);

  // merged requires a matching merged PR AND the issue CLOSED.
  if (mergedPr && closedIssue) {
    return { issue_number: n, title: closedIssue.title, url: mergedPr.url || closedIssue.url, pr_number: mergedPr.number, status: "merged", progress: 100, label: "Merged ✓" };
  }
  // Matching open PR → in_review/approved/ready from the parsed Review Detail.
  if (openPr) {
    const title = (openIssue && openIssue.title) || openPr.title || `#${n}`;
    const approvals = approvalsFromReviewDetail(parsed.reviewDetail, openPr.number);
    if (approvals >= 2) return { issue_number: n, title, url: openPr.url, pr_number: openPr.number, status: "ready", progress: 80, label: `PR #${openPr.number} · 2 approvals · ready` };
    if (approvals === 1) return { issue_number: n, title, url: openPr.url, pr_number: openPr.number, status: "approved1", progress: 50, label: `PR #${openPr.number} · 1 approval` };
    return { issue_number: n, title, url: openPr.url, pr_number: openPr.number, status: "in_review", progress: 20, label: `PR #${openPr.number} · waiting on review` };
  }
  // No matching open PR. The persisted board lists the FULL open-PR window, so an
  // OPEN active-batch issue with no [#N] open PR and no in-window merged PR is
  // queued — NO network. A merged PR in-window for a still-OPEN issue is the
  // ambiguous merged-but-open case (mirrors progressFromSnapshot returning null
  // there) → defer to the authoritative snapshot next cycle.
  if (openIssue && !mergedPr) {
    return buildNoPrRow({ number: n, title: openIssue.title, state: "OPEN", url: openIssue.url });
  }
  // CLOSED issue with no in-window merged PR → closed (no PR) ✓ (superseded/runbook).
  if (closedIssue && !mergedPr) {
    return buildNoPrRow({ number: n, title: closedIssue.title, state: "CLOSED", url: closedIssue.url });
  }
  // Absent from the file, or merged-but-open ambiguity → unproven.
  return null;
}

// #943: a transient or cold-cache-unproven item degrades to a SOFT "queued
// (retrying)" row (status "queued", progress 0, retried next cycle) instead of a
// hard "fetch failed". A queued batch item must never render an alarming error
// just because the in-memory snapshot is briefly cold (post-restart) or a
// transient secondary-rate-limit/network blip hit its by-number fetch.
function softRetryingRow(n, title) {
  return { issue_number: n, title: title || `#${n}`, url: null, status: "queued", progress: 0, label: "queued (retrying)" };
}

// Confirmed-complete state machine, per project. `complete` must hold across
// TWO consecutive SUCCESSFUL fetch cycles with DISTINCT generatedAt (the
// snapshot ts, which only advances on a real #806 refresh) before we confirm.
// A stale/served-expired cycle keeps the same ts, and an errored item flips
// complete=false — so neither can confirm on its own. Consumers (server
// auto-stop) gate stopTrigger/bridge-stop on the confirmed signal, never a
// single transient `complete`.
const _batchCompleteState = new Map(); // projectId -> { batchKey, ts, confirmed }
// #828 P2: confirmation is BATCH-scoped, not just project-scoped. `batchKey`
// identifies the batch (its number + issue set); when it changes, the streak
// resets so a brand-new already-complete batch can never inherit the prior
// batch's first cycle and confirm in a single tick (premature auto-stop). A new
// batch must earn its own two distinct successful cycles.
function evalBatchCompleteConfirmed(projectId, batchKey, complete, generatedAt) {
  let st = _batchCompleteState.get(projectId);
  if (!st || st.batchKey !== batchKey) {
    st = { batchKey, ts: null, confirmed: false };
    _batchCompleteState.set(projectId, st);
  }
  if (!complete) { st.ts = null; st.confirmed = false; return false; }
  if (generatedAt == null) return st.confirmed;          // inconclusive cycle — no advance
  if (st.ts == null) { st.ts = generatedAt; st.confirmed = false; return false; }
  if (generatedAt !== st.ts) { st.ts = generatedAt; st.confirmed = true; return true; }
  return st.confirmed;                                   // same snapshot re-served — no new cycle
}

// ─── /api/github/all — batched endpoint (#703) ────────────────────────────
// Returns all projects' GitHub data in one response. The frontend can
// optionally filter by project query param. Serves from GraphQL cache
// with on-demand refresh if stale.
router.get("/api/github/all", async (req, res) => {
  const projectFilter = req.query.project || "";

  if (projectFilter && isProjectArchived(projectFilter)) {
    const repo = getRepo(projectFilter);
    return res.json({ [projectFilter]: archivedGithubLists(repo ? _graphqlCache.get(repo) : null) });
  }

  if (projectFilter) {
    projectAdmission(projectFilter, { demand: true });
  } else {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      for (const project of cfg.projects || []) {
        if (!project?.id || project.idle || isProjectArchived(project.id, cfg)) continue;
        projectAdmission(project.id, { demand: true });
      }
    } catch {}
  }

  // Ensure cache is populated.
  const anyStale = (() => {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return true; }
    const projects = (cfg.projects || []).filter((p) => {
      const repo = getRepo(p.id);
      return repo && REPO_RE.test(repo) && !p.idle &&
        _githubDemandedProjects.has(p.id) && !isProjectArchived(p.id, cfg);
    }); // #812/#1034: skip idle, archived, and undemanded projects
    for (const p of projects) {
      const cached = _graphqlCache.get(getRepo(p.id));
      if (!cached || Date.now() - cached.ts > adaptiveTTL(GRAPHQL_CACHE_TTL)) return true;
    }
    return false;
  })();
  if (anyStale) await refreshGraphQLCache();

  // Build response.
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return res.status(500).json({ error: "Config unreadable" }); }
  const projects = (cfg.projects || []).filter((p) => {
    const repo = getRepo(p.id);
    return repo && REPO_RE.test(repo);
  }); // #812: include idle projects — served stale below, never fetched

  const result = {};
  const fallbackNeeded = [];
  for (const p of projects) {
    if (projectFilter && p.id !== projectFilter) continue;
    const cached = _graphqlCache.get(getRepo(p.id));
    if (isProjectArchived(p.id, cfg)) {
      result[p.id] = archivedGithubLists(cached);
      continue;
    }
    // #812: idle (parked) project — serve last-known data flagged _idle,
    // never trigger a fetch or fall back to gh.
    if (p.idle) {
      result[p.id] = cached
        ? { issues: cached.issues, prs: cached.prs, closedIssues: cached.closedIssues, mergedPrs: cached.mergedPrs, _idle: true }
        : { issues: [], prs: [], closedIssues: [], mergedPrs: [], _idle: true };
      continue;
    }
    if (cached) {
      result[p.id] = {
        issues: cached.issues,
        prs: cached.prs,
        closedIssues: cached.closedIssues,
        mergedPrs: cached.mergedPrs,
        _stale: Date.now() - cached.ts > adaptiveTTL(GRAPHQL_CACHE_TTL),
      };
    } else {
      const admission = projectAdmission(p.id);
      if (admission) fallbackNeeded.push({ project: p, admission });
    }
  }

  // #806: fallback for still-missing repos goes through the REST+ETag snapshot
  // (refreshRepoRest), NOT `gh pr list`/`gh issue list`. Concurrency-limited so
  // a cold multi-project load doesn't drain the core budget.
  if (fallbackNeeded.length > 0 && !isRateLimited()) {
    await _mapLimited(fallbackNeeded, GH_MAX_CONCURRENT, ({ project, admission }) => refreshRepoRest(getRepo(project.id), [admission]));
    for (const { project: p, admission } of fallbackNeeded) {
      const repo = getRepo(p.id);
      const cached = repo ? _graphqlCache.get(repo) : null;
      if (!isAdmissionCurrent(admission)) {
        result[p.id] = archivedGithubLists(cached);
        continue;
      }
      result[p.id] = cached
        ? {
            issues: cached.issues,
            prs: cached.prs,
            closedIssues: cached.closedIssues,
            mergedPrs: cached.mergedPrs,
            _fallback: true,
          }
        : { issues: [], prs: [], closedIssues: [], mergedPrs: [], _fallback: true };
    }
  }

  res.json(result);
});

// ─── Per-project endpoints (backward compat, served from shared cache) ────
//
// #806: all four lists are slices of the single REST+ETag snapshot built by
// githubStateFetcher (closed/merged already sorted newest-first and capped to
// RECENT_DISPLAY_LIMIT there). On a warm cache we serve instantly; cold misses
// fetch the whole snapshot once via refreshRepoRest — no `gh pr list`/`gh issue
// list` (those are GraphQL-backed). Idle projects never fetch.
async function serveGithubList(req, res, kind) {
  const project = req.query.project || "";
  const repo = getRepo(project);
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });
  const cacheKey = `${kind}:${repo}`;
  const cached = _ghEndpointCache.get(cacheKey);

  if (isProjectArchived(project)) {
    res.set("X-QuadWork-Archived", "1");
    res.set("X-QuadWork-Readonly", "1");
    return res.json(cached ? cached.data : []);
  }

  // #812: a parked (idle) project must never initiate a fetch.
  if (isProjectIdle(project)) {
    res.set("X-QuadWork-Idle", "1");
    return res.json(cached ? cached.data : []);
  }
  const admission = projectAdmission(project, { demand: true });
  if (!admission) {
    res.set("X-QuadWork-Archived", "1");
    return res.json(cached ? cached.data : []);
  }

  // #824: these four endpoints serve a BARE ARRAY (cached.data is an array).
  // Stale/rate-limited state must be signalled via a response header — mirroring
  // the X-QuadWork-Idle pattern above — never by spreading the array into an
  // object (which yields {"0":…,"_stale":true} and trips GitHubPanel's
  // Array.isArray guard, blanking the board exactly when it should show
  // last-known data).
  //
  // Freshness is measured against the BASE TTL, not adaptiveTTL: under critical
  // rate-limit adaptiveTTL is Infinity, so an age<ttl check would treat an
  // arbitrarily-old cache as fresh and skip the staleness signal entirely.
  const baseFresh = cached && Date.now() - cached.ts < GH_ENDPOINT_CACHE_TTL;

  // Critically REST-rate-limited → serve whatever we have (even expired) without
  // revalidating. MUST precede the cache-hit branch below: adaptiveTTL is
  // Infinity here, so that branch would otherwise return first and an expired
  // array would go out with no X-QuadWork-Stale / X-QuadWork-Rate-Limited.
  if (isRateLimited() && cached) {
    res.set("X-QuadWork-Rate-Limited", "1");
    if (!baseFresh || cached.stale) res.set("X-QuadWork-Stale", "1");
    return res.json(cached.data);
  }
  // Fresh enough (within the adaptive window) → serve as-is.
  if (cached && Date.now() - cached.ts < adaptiveTTL(GH_ENDPOINT_CACHE_TTL)) {
    if (cached.stale) res.set("X-QuadWork-Stale", "1");
    return res.json(cached.data);
  }
  // Stale-while-revalidate: serve stale now, refresh the snapshot in background.
  if (cached) {
    refreshRepoRest(repo, [admission]);
    res.set("X-QuadWork-Stale", "1");
    return res.json(cached.data);
  }
  // Cold: assemble the snapshot synchronously, then serve this slice.
  await refreshRepoRest(repo, [admission]);
  if (!isAdmissionCurrent(admission)) {
    res.set("X-QuadWork-Archived", "1");
    const lastKnown = _ghEndpointCache.get(cacheKey);
    return res.json(lastKnown ? lastKnown.data : []);
  }
  const fresh = _ghEndpointCache.get(cacheKey);
  if (fresh) return res.json(fresh.data);
  return res.status(502).json({ error: "gh call failed" });
}

router.get("/api/github/issues", (req, res) => serveGithubList(req, res, "issues"));
router.get("/api/github/prs", (req, res) => serveGithubList(req, res, "prs"));
// #411 / quadwork#281: "Recently closed" / "Recently merged" — newest-first,
// capped to 5 in githubStateFetcher (REST default ordering isn't close/merge
// time, so the snapshot re-sorts by closedAt/mergedAt before truncating).
router.get("/api/github/closed-issues", (req, res) => serveGithubList(req, res, "closed-issues"));
router.get("/api/github/merged-prs", (req, res) => serveGithubList(req, res, "merged-prs"));

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
const _batchProgressRefreshes = new Map(); // projectId -> { admission, promise }
const BATCH_TERMINAL_STATUSES = new Set(["merged", "closed"]);

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
    if (isProjectArchived(projectId)) return;
    const p = batchSnapshotPath(projectId);
    ensureSecureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(snapshot));
  } catch {
    // Non-fatal — panel still works from the live parse.
  }
}
function deleteBatchSnapshot(projectId) {
  try {
    if (isProjectArchived(projectId)) return;
    fs.unlinkSync(batchSnapshotPath(projectId));
  } catch {
    // Non-fatal — file may already be gone.
  }
}

function isTerminalBatchItem(item) {
  return item && BATCH_TERMINAL_STATUSES.has(item.status);
}

function terminalItemsFromSnapshot(snapshot, batchNumber, issueNumbers) {
  if (!snapshot || snapshot.batchNumber !== batchNumber || !Array.isArray(issueNumbers)) return new Map();
  const source = snapshot.terminalItems && typeof snapshot.terminalItems === "object" ? snapshot.terminalItems : {};
  const wanted = new Set(issueNumbers);
  const rows = new Map();
  for (const [rawIssue, row] of Object.entries(source)) {
    const n = parseInt(rawIssue, 10);
    if (!wanted.has(n) || !isTerminalBatchItem(row)) continue;
    rows.set(n, row);
  }
  return rows;
}

function collectTerminalItems(items, previous = new Map()) {
  const rows = {};
  for (const [n, row] of previous.entries()) {
    if (isTerminalBatchItem(row)) rows[n] = row;
  }
  for (const row of Array.isArray(items) ? items : []) {
    if (!Number.isInteger(row && row.issue_number)) continue;
    if (isTerminalBatchItem(row)) rows[row.issue_number] = row;
    else delete rows[row.issue_number];
  }
  return rows;
}

function snapshotHasOpenIssue(snapshot, n) {
  return !!(
    snapshot &&
    Array.isArray(snapshot.issues) &&
    snapshot.issues.some((it) => it && it.number === n && it.state === "OPEN")
  );
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
    // #828 P1: REST, not `gh issue view` (GraphQL). We only need existence, so
    // the cheap REST issue endpoint suffices and keeps the whole batch-progress
    // path off GraphQL.
    await ghJsonExecAsync(["api", `repos/${repo}/issues/${first}`, "--jq", ".number"]);
    return "fresh";
  } catch (err) {
    // gh surfaces a 404 via stderr text on a non-zero exit. Only
    // the unambiguous "not found" / "could not resolve" shapes
    // count as genuinely gone; anything else (network, auth,
    // timeout) is transient and must NOT delete the snapshot.
    const msg = String((err && (err.stderr || err.message)) || "").toLowerCase();
    if (msg.includes("could not resolve") || msg.includes("not found") || msg.includes("http 404")) {
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
// Decide whether the displayed batch comes from the LIVE Active Batch parse or
// the preserved snapshot. A new batch (explicit Batch: N bump OR live items the
// snapshot doesn't have) → "live"; otherwise a non-empty snapshot wins
// ("snapshot"), so items Head moved to Done stay visible until the next batch
// starts. Extracted so #870's type pre-check follows the SAME decision.
function pickDisplayedSource(current, snapshot) {
  const hasExplicitBump =
    current.batchNumber !== null &&
    (!snapshot || snapshot.batchNumber === null || current.batchNumber > snapshot.batchNumber);
  const hasNewItems =
    current.issueNumbers.length > 0 &&
    (!snapshot || current.issueNumbers.some((n) => !snapshot.issueNumbers.includes(n)));
  if (hasExplicitBump || hasNewItems) return "live";
  if (snapshot && Array.isArray(snapshot.issueNumbers) && snapshot.issueNumbers.length > 0) return "snapshot";
  return "live";
}

function resolveDisplayedBatch(
  queueText,
  projectId,
  // #899: snapshot I/O is injectable so the live-progression path is unit-
  // testable without writing to the real ~/.quadwork/{id}/batch-progress-cache.json
  // (which belongs to the running orchestrator). Production callers pass nothing
  // and get the real readers/writers.
  { queueReadOk = true, _readSnapshot = readBatchSnapshot, _writeSnapshot = writeBatchSnapshot } = {},
) {
  // Queue file deleted / unreadable → fall back to empty state per
  // #316's edge case. Returning the snapshot here would "heal" a
  // genuinely missing file into stale data the operator can't
  // reconcile without nuking ~/.quadwork/{id}/batch-progress-cache.json
  // manually.
  if (!queueReadOk) return { batchNumber: null, issueNumbers: [], batch_type: "code", reviewItems: [] };
  const current = parseActiveBatch(queueText);
  const snapshot = _readSnapshot(projectId);
  const source = pickDisplayedSource(current, snapshot);
  let next;
  if (source === "live") {
    next = {
      batchNumber: current.batchNumber,
      issueNumbers: current.issueNumbers.slice(),
      // #870: type + per-item review states from the LIVE Active Batch.
      batch_type: parseBatchType(queueText),
      reviewItems: parseReviewItems(queueText),
    };
  } else {
    next = {
      batchNumber: snapshot.batchNumber ?? null,
      issueNumbers: snapshot.issueNumbers.slice(),
      // #870: a just-archived review batch keeps its type + review states from
      // the snapshot, so it renders without GitHub and is NEVER reinterpreted
      // as code. Absent (legacy / code snapshots) → "code"/[] — back-compatible.
      batch_type: snapshot.batch_type || "code",
      reviewItems: Array.isArray(snapshot.reviewItems) ? snapshot.reviewItems : [],
      terminalItems: snapshot.terminalItems && typeof snapshot.terminalItems === "object" ? snapshot.terminalItems : {},
    };
    // #899: snapshot stickiness preserves the displayed issue SET (so items Head
    // moved to Done stay visible — #316/#429), but a review batch's per-item
    // state lives in the QUEUE, not on GitHub. When the same batch number +
    // issue set persist and only review states change in place
    // (queued → in-review → approved), pickDisplayedSource finds no bump / no
    // new items and returns "snapshot" — which froze reviewItems at their
    // first-seen states AND re-persisted them each cycle. So while the live
    // Active Batch is still present (non-empty), refresh batch_type + reviewItems
    // from the LIVE queue. We are already in the "snapshot" branch, so a
    // non-empty live parse here is necessarily the SAME batch (no explicit bump,
    // every live issue already in the snapshot) — never a newer one. The
    // snapshot's reviewItems stay authoritative ONLY once the Active Batch is
    // cleared (archived), where the live parse is empty and this is skipped.
    // Code batches are unaffected: their live parse yields batch_type "code" /
    // reviewItems [] — identical to what the snapshot already holds.
    if (current.issueNumbers.length > 0) {
      next.batch_type = parseBatchType(queueText);
      // re1 on #900: MERGE, don't replace. When Head moves an approved item out
      // of Active Batch (→ Done) before the whole batch is archived, the snapshot
      // still preserves its issue number in next.issueNumbers, but the LIVE queue
      // no longer carries its line. A wholesale `parseReviewItems(queueText)`
      // would drop that item's final state from the displayed set (and from the
      // re-persisted snapshot). So derive reviewItems across the preserved issue
      // set: live state for items still in Active Batch, snapshot state for items
      // moved to Done, queued as a last-resort default for any issue number with
      // neither. This keeps the per-item count aligned with next.issueNumbers.
      const liveByIssue = new Map(parseReviewItems(queueText).map((r) => [r.issue, r]));
      const snapByIssue = new Map(
        (Array.isArray(snapshot.reviewItems) ? snapshot.reviewItems : []).map((r) => [r.issue, r]),
      );
      next.reviewItems = next.issueNumbers.map(
        (n) => liveByIssue.get(n) || snapByIssue.get(n) || { issue: n, review_state: "queued", approvals: 0 },
      );
    } else {
      // #925: the Active Batch is empty → this is the just-ARCHIVED batch's
      // sticky display (#870). The snapshot's reviewItems can be frozen at a
      // pre-final state when the last item's approval + the archive landed
      // between polls, so the panel never read as complete. Head's matching
      // `## Done` block holds the authoritative final states — read them for
      // THIS batch only. Gated on the Done block being a review batch, so code
      // batches (Done lines carry no state → "queued") are left untouched and
      // keep using the GitHub-derived path. Merge across the preserved issue
      // set (Done state first, then snapshot, then queued) to stay aligned with
      // next.issueNumbers — same shape as the #899/#900 live-refresh above.
      const doneBatch = parseDoneBatchReviewItems(queueText, next.batchNumber);
      if (doneBatch && REVIEW_BATCH_TYPES.has(doneBatch.batch_type) && doneBatch.reviewItems.length > 0) {
        next.batch_type = doneBatch.batch_type;
        const doneByIssue = new Map(doneBatch.reviewItems.map((r) => [r.issue, r]));
        const snapByIssue = new Map(
          (Array.isArray(snapshot.reviewItems) ? snapshot.reviewItems : []).map((r) => [r.issue, r]),
        );
        next.reviewItems = next.issueNumbers.map(
          (n) => doneByIssue.get(n) || snapByIssue.get(n) || { issue: n, review_state: "queued", approvals: 0 },
        );
      }
    }
  }
  // Snapshot persists batchNumber/issueNumbers (existing consumers) PLUS the
  // additive #870 batch_type/reviewItems. With the #899 refresh above, the
  // snapshot now also captures the LATEST live review states each cycle, so the
  // post-archive sticky view shows the FINAL states (all approved) rather than
  // the first-seen ones.
  if (next.issueNumbers.length > 0) _writeSnapshot(projectId, next);
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

// #870: review-batch support. The queue's `## Active Batch` section may carry a
// `**Batch type:** code | ticket-review | pr-review` line (right after
// `**Batch:** N`). Absent/unrecognized → "code" (preserves existing behavior
// exactly). Review batches compute progress from the Active Batch item states
// alone — no GitHub calls.
const ACTIVE_BATCH_SECTION_RE = /##\s+Active Batch[\s\S]*?(?=\n##\s|$)/i;
const REVIEW_BATCH_TYPES = new Set(["ticket-review", "pr-review"]);

function parseBatchType(queueText) {
  if (typeof queueText !== "string" || !queueText) return "code";
  const m = queueText.match(ACTIVE_BATCH_SECTION_RE);
  if (!m) return "code";
  const tm = m[0].match(/\*\*Batch type:\*\*\s*(code|ticket-review|pr-review)\b/i);
  return tm ? tm[1].toLowerCase() : "code";
}

// Parse one Active Batch item's review-state annotation — the text after
// `- #123 — `. Recognizes queued / in-review / in-review (N/2) / approved /
// changes-requested; the leading separator (`—`, `-`, `:`, `]`, …) is stripped,
// and anything unrecognized falls back to `queued` (safe default).
function parseReviewState(raw) {
  const s = String(raw || "").trim().replace(/^[^a-z0-9]+/i, "").toLowerCase();
  if (s.startsWith("approved")) return { review_state: "approved", approvals: 2 };
  if (s.startsWith("changes")) return { review_state: "changes-requested", approvals: 0 };
  if (s.startsWith("in-review") || s.startsWith("in review")) {
    const mm = s.match(/\((\d)\s*\/\s*2\)/);
    return { review_state: "in-review", approvals: mm ? parseInt(mm[1], 10) : 0 };
  }
  return { review_state: "queued", approvals: 0 };
}

// Parse the `## Active Batch` review items: `- #<n> — <state>`. Same line
// grammar as parseActiveBatch (so the issue set matches exactly), plus the
// trailing state annotation. Scoped to Active Batch — NEVER `## Done`.
const REVIEW_ITEM_LINE_RE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\[[ xX]\]\s+)?\[?#(\d{1,6})\]?\b(.*)$/;
function parseReviewItems(queueText) {
  if (typeof queueText !== "string" || !queueText) return [];
  const m = queueText.match(ACTIVE_BATCH_SECTION_RE);
  if (!m) return [];
  const seen = new Set();
  const items = [];
  for (const line of m[0].split("\n")) {
    const lm = line.match(REVIEW_ITEM_LINE_RE);
    if (!lm) continue;
    const n = parseInt(lm[1], 10);
    if (seen.has(n)) continue;
    seen.add(n);
    const { review_state, approvals } = parseReviewState(lm[2]);
    items.push({ issue: n, review_state, approvals });
  }
  return items;
}

// #925: parse the per-item review states from the ONE `## Done` block whose
// `**Batch:** N` matches `batchNumber`. After a review batch is archived the
// Active Batch is empty, so resolveDisplayedBatch serves the snapshot — whose
// reviewItems can be frozen at a pre-final state (the final approval + archive
// happened between the 30s polls). Head's Done block holds the AUTHORITATIVE
// final states, so for the archived (displayed) batch we read them from there.
// Scoped to the single matching block — every OTHER Done batch stays ignored
// (#870: never count `## Done` for progress beyond this one sticky block).
// Returns { batch_type, reviewItems } or null if no matching block exists.
const DONE_SECTION_RE = /##\s+Done\b[\s\S]*?(?=\n##\s|$)/i;
const DONE_BATCH_MARKER_RE = /\*\*Batch:\*\*\s*(\d+)/g;
function parseDoneBatchReviewItems(queueText, batchNumber) {
  if (typeof queueText !== "string" || !queueText || !Number.isInteger(batchNumber)) return null;
  const dm = queueText.match(DONE_SECTION_RE);
  if (!dm) return null;
  const done = dm[0];
  // Split the Done section into per-batch blocks at each `**Batch:** N` marker
  // (`**Batch type:**` is NOT matched — it has no `:` right after "Batch").
  const markers = [];
  let mk;
  DONE_BATCH_MARKER_RE.lastIndex = 0;
  while ((mk = DONE_BATCH_MARKER_RE.exec(done)) !== null) {
    markers.push({ num: parseInt(mk[1], 10), start: mk.index });
  }
  const idx = markers.findIndex((b) => b.num === batchNumber);
  if (idx === -1) return null;
  const block = done.slice(markers[idx].start, idx + 1 < markers.length ? markers[idx + 1].start : done.length);
  const tm = block.match(/\*\*Batch type:\*\*\s*(code|ticket-review|pr-review)\b/i);
  const batch_type = tm ? tm[1].toLowerCase() : "code";
  const seen = new Set();
  const reviewItems = [];
  for (const line of block.split("\n")) {
    const lm = line.match(REVIEW_ITEM_LINE_RE);
    if (!lm) continue;
    const n = parseInt(lm[1], 10);
    if (seen.has(n)) continue;
    seen.add(n);
    const { review_state, approvals } = parseReviewState(lm[2]);
    reviewItems.push({ issue: n, review_state, approvals });
  }
  return { batch_type, reviewItems };
}

// Map a parsed review state → the batch-progress item, EXTENDING the existing
// item shape ({ issue_number, title, url, pr_number, status, progress, label })
// with review_state + approvals. pr-review items ARE PRs → set pr_number;
// ticket-review omits it (frontend type is pr_number?: number — never null).
function reviewItemView(ri, batchType, ghIndex) {
  const n = ri.issue;
  const meta = ghIndex && ghIndex.get(n);
  let progress, status, label;
  if (ri.review_state === "approved") { progress = 100; status = "approved"; label = "Approved ✓"; }
  else if (ri.review_state === "changes-requested") { progress = 0; status = "changes_requested"; label = "changes requested"; }
  else if (ri.review_state === "in-review") {
    // #907: a 2/2-approved item that Head hasn't yet written `approved`
    // (Dev is still filing follow-ups / posting the summary) must NOT render
    // as "50% · In review · 2/2" — that's self-contradictory. Resolve it to a
    // high-progress finalizing state with a non-contradictory label. The
    // batch still only reads complete on the literal `approved` state.
    if (ri.approvals >= 2) { progress = 90; status = "finalizing"; label = "Approved (2/2) · finalizing"; }
    else if (ri.approvals === 1) { progress = 50; status = "in_review"; label = "In review · 1/2 approvals"; }
    else { progress = 20; status = "in_review"; label = "In review"; }
  } else { progress = 0; status = "queued"; label = "Queued"; }
  const item = {
    issue_number: n,
    title: (meta && meta.title) || `#${n}`,
    url: (meta && meta.url) || null,
    status,
    progress,
    label,
    review_state: ri.review_state,
    approvals: ri.approvals,
  };
  if (batchType === "pr-review") item.pr_number = n;
  return item;
}

function summarizeReviewItems(reviewItems) {
  const total = reviewItems.length;
  let approved = 0, inReview = 0, changes = 0, queued = 0;
  for (const r of reviewItems) {
    if (r.review_state === "approved") approved++;
    else if (r.review_state === "in-review") inReview++;
    else if (r.review_state === "changes-requested") changes++;
    else queued++;
  }
  const parts = [`${approved}/${total} approved`];
  if (inReview > 0) parts.push(`${inReview} in review`);
  if (changes > 0) parts.push(`${changes} changes requested`);
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(" · ");
}

// Build a number → { title, url } index from the project's GITHUB.md (file
// read only — NO gh call). Resolves review-item titles/urls; absent/unparseable
// file → empty map and items fall back to `#N` / null url.
function loadGithubItemIndex(projectId) {
  const map = new Map();
  let text;
  try {
    text = fs.readFileSync(path.join(CONFIG_DIR, projectId, "GITHUB.md"), "utf-8");
  } catch {
    return map;
  }
  const parsed = parseGithub(text);
  if (!parsed || !parsed.ok) return map;
  for (const list of [parsed.openIssues, parsed.closedIssues, parsed.openPRs, parsed.mergedPrs]) {
    for (const it of list || []) {
      if (it && typeof it.number === "number" && !map.has(it.number)) {
        map.set(it.number, { title: it.title, url: it.url });
      }
    }
  }
  return map;
}

// #943: load the persisted GITHUB.md board as a parseGithub result (or null if
// missing / unparseable). The code-batch progress path uses this as the restart-
// surviving fallback when the in-memory _graphqlCache is empty, so a cold cache
// never triggers a live per-item Search burst.
function loadGithubParsed(projectId) {
  let text;
  try {
    text = fs.readFileSync(path.join(CONFIG_DIR, projectId, "GITHUB.md"), "utf-8");
  } catch {
    return null;
  }
  const parsed = parseGithub(text);
  return parsed && parsed.ok ? parsed : null;
}

// #416 / quadwork#299: async variant used by the parallelized batch
// progress fetcher. Wraps node's execFile in a promise.
//
// THROWS on subprocess failure (non-zero exit, timeout, JSON parse,
// network) so progressForItemRest can decide which subset of
// failures should bubble up to the route's per-item failure row
// vs. which should fall through to a softer state. The previous
// catch-all-and-return-null contract collapsed real subprocess
// errors into the "not found" branch, making the failure-row
// fallback unreachable for genuine command failures (t2a review).
// #943: the route now catches that rejection and renders a SOFT
// "queued (retrying)" row (retried next cycle), not a hard "fetch failed".
async function ghJsonExecAsync(args) {
  const { stdout } = await _execFileAsync("gh", args, { encoding: "utf-8", timeout: 10000, maxBuffer: GH_LIST_MAX_BUFFER });
  return JSON.parse(stdout);
}

// #350: pure helper for the "no linked PR" branch of
// progressForItemRest. Takes the issue JSON (shape: { number,
// title, state, url, ... }) and returns the batch-progress row
// for an item that has no linked PR. Exported from module.exports
// below for unit tests — no other callers.
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

// #828 P1: find the PR linked to issue `n` by the team's `[#N]` PR-title
// convention, via the REST Search API (1 search point) — NOT GraphQL. gh's
// `-X GET -f q=…` URL-encodes the query, so we never hand-concatenate the repo
// or number into the URL. Search tokenises loosely (and `is:pr in:title N`
// would also surface `[#807]` for n=80), so we re-apply the strict `^\s*\[#N\]`
// regex the snapshot matcher uses. Returns the freshest matching PR number (or
// null), treating a search failure as "no linked PR found".
// Pure: pick the right PR whose title matches the STRICT `^\s*\[#N\]` convention
// from a set of REST search items. Guards `[#807]` from matching n=80 even
// though Search's loose `in:title 80` would surface it. Returns the PR number
// or null. Exported for unit tests.
//
// #864: when more than one strict match exists for a CLOSED issue (e.g. a
// closed-unmerged duplicate opened after the real merged PR for the same
// issue), prefer a MERGED match over an unmerged one — otherwise the
// highest-PR-number tie-break picks the duplicate and downstream progress
// flips a CLOSED issue back to in_review, keeping the batch falsely "active"
// after Head clears the queue.
//
// #864/RE1: the merged-preference is GATED on `opts.issueState === "CLOSED"`.
// For an OPEN/reopened issue, applying it would let an OLDER merged PR beat a
// NEWER active duplicate/reopen PR with the same `[#N]` prefix — the picker
// would return the stale merged PR number and progressForItemRest would fall
// through to in_review-with-the-wrong-PR (since the `merged && CLOSED` row
// requires the issue to be closed). The default (no opts → open-by-omission)
// is the legacy freshest-wins behavior, preserving back-compat for direct
// callers and tests that don't yet supply issue state.
function pickLinkedPrFromSearch(items, n, opts = {}) {
  const titleRe = new RegExp(`^\\s*\\[#${n}\\]`);
  const matches = (Array.isArray(items) ? items : []).filter((it) => titleRe.test((it && it.title) || ""));
  if (matches.length === 0) return null;
  const preferMerged = opts.issueState === "CLOSED";
  if (preferMerged) {
    const merged = matches.filter((it) => it && it.pull_request && it.pull_request.merged_at);
    if (merged.length > 0) {
      return merged.slice().sort((a, b) => (b.number || 0) - (a.number || 0))[0].number;
    }
  }
  return matches.slice().sort((a, b) => (b.number || 0) - (a.number || 0))[0].number;
}

// The actual REST Search call, split out so findLinkedPrByTitle's
// success-vs-failure distinction is unit-testable via an injected executor.
// `gh api -X GET -f q=…` URL-encodes the query (we never hand-concatenate repo
// or number into the URL). THROWS (propagates) on any Search failure.
async function _searchLinkedPrItems(repo, n) {
  const res = await ghJsonExecAsync(["api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} is:pr in:title ${n}`]);
  return Array.isArray(res && res.items) ? res.items : [];
}

// Find the PR linked to issue `n` by the strict `[#N]` title convention via the
// REST Search API (1 search point) — NOT GraphQL. Returns the freshest matching
// PR number, or null ONLY when Search SUCCEEDED with zero strict matches
// (authoritative "no linked PR"). #828/RE1: a Search FAILURE (rate-limit /
// network / parse) is NOT proof of no PR — it must NOT collapse to null, or an
// out-of-window OPEN issue with a real PR would render queued (and a CLOSED one
// with a merged PR would render closed). So failure THROWS, and the caller
// (progressForItemRest, awaiting without a catch) lets the rejection reach the
// route, which (#943) renders a soft "queued (retrying)" row retried next cycle.
async function findLinkedPrByTitle(repo, n, search = _searchLinkedPrItems, opts = {}) {
  const items = await search(repo, n);
  return pickLinkedPrFromSearch(items, n, opts);
}

function prNumberFromApiUrl(url) {
  const m = String(url || "").match(/\/pulls\/(\d+)(?:\b|$)/);
  return m ? parseInt(m[1], 10) : null;
}

function pickClosingPrFromTimeline(events) {
  const candidates = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.event !== "closed") continue;
    const issue = ev.source && ev.source.issue;
    const pr = issue && issue.pull_request;
    const n = (issue && Number.isInteger(issue.number) && pr && issue.number) || prNumberFromApiUrl(pr && pr.url);
    if (Number.isInteger(n)) candidates.push(n);
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b - a)[0];
}

async function findClosingPrByTimeline(repo, issueNumber) {
  const events = await ghJsonExecAsync(["api", `repos/${repo}/issues/${issueNumber}/timeline?per_page=100`]);
  return pickClosingPrFromTimeline(events);
}

// Authoritative by-number resolution for an active-batch issue the board
// snapshot can't prove (outside / truncated window, or absent). REST-only:
// issue/PR endpoints + Search/title convention + native issue timeline
// close-link — zero `gh issue view` / `gh pr view` (GraphQL). Bucket mapping
// matches progressFromSnapshot exactly.
async function progressForItemRest(repo, issueNumber, stillCurrent = () => true, deps = {}) {
  const execJson = deps.ghJsonExecAsync || ghJsonExecAsync;
  const stopIfRevoked = () => {
    if (stillCurrent()) return;
    const error = new Error("project admission revoked");
    error.code = "project_admission_revoked";
    throw error;
  };
  stopIfRevoked();
  // Load-bearing call: the issue's own state via REST. If gh can't read it at
  // all (404, network, auth, timeout) we can't compute a meaningful row — let
  // the rejection propagate to the route, which (#943) renders a soft "queued
  // (retrying)" row instead of emitting a misleading "queued"/"merged" entry.
  const raw = await execJson(["api", `repos/${repo}/issues/${issueNumber}`]);
  stopIfRevoked();
  const issue = {
    number: raw.number,
    title: raw.title,
    state: (raw.state || "").toUpperCase(),
    url: raw.html_url,
  };
  // Title convention first; for CLOSED issues, fall back to GitHub's native
  // issue timeline close-link. A lookup failure must not make a CLOSED issue
  // flap to "queued (retrying)" — terminal-ness comes from the issue state.
  let prNumber = null;
  try {
    stopIfRevoked();
    const search = deps.searchLinkedPrItems || _searchLinkedPrItems;
    prNumber = await findLinkedPrByTitle(repo, issueNumber, search, { issueState: issue.state });
    stopIfRevoked();
  } catch (err) {
    if (err?.code === "project_admission_revoked") throw err;
    if (issue.state !== "CLOSED") throw err;
  }
  if (prNumber == null && issue.state === "CLOSED") {
    try {
      stopIfRevoked();
      const events = await execJson(["api", `repos/${repo}/issues/${issueNumber}/timeline?per_page=100`]);
      stopIfRevoked();
      prNumber = pickClosingPrFromTimeline(events);
    } catch {
      stopIfRevoked();
      // Degrade below to Closed (no PR) ✓. The item is still terminal.
    }
  }
  // No linked PR (authoritative). #350: honor the issue's own state — a CLOSED
  // issue with no linked PR is fully done (superseded/not-planned/runbook) →
  // 100% ✓; only a truly OPEN issue with no PR is queued.
  if (prNumber == null) {
    return buildNoPrRow(issue);
  }
  // REST-fetch the PR for state + reviews. Soft: a glitch on these single calls
  // still lets us render a partial in_review row (we know the PR exists) rather
  // than dropping the whole item to "fetch failed".
  let prData = null;
  try {
    stopIfRevoked();
    prData = await execJson(["api", `repos/${repo}/pulls/${prNumber}`]);
    stopIfRevoked();
  } catch {
    stopIfRevoked();
    // soft fall-through to the in_review row below
  }
  if (!prData) {
    if (issue.state === "CLOSED") return buildNoPrRow(issue);
    return {
      issue_number: issue.number,
      title: issue.title,
      url: issue.url,
      pr_number: prNumber,
      status: "in_review",
      progress: 20,
      label: `PR #${prNumber} · waiting on review`,
    };
  }
  let reviews = [];
  try {
    stopIfRevoked();
    const rv = await execJson(["api", `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`]);
    stopIfRevoked();
    reviews = mapReviews(Array.isArray(rv) ? rv : []);
  } catch {
    // soft — reviews stay [], so the row degrades to in_review, never "failed"
  }
  const url = prData.html_url || issue.url;
  // REST: a merged PR is state "closed" with `merged: true`. merged requires
  // the issue CLOSED too (mirrors progressFromSnapshot and the prior path).
  if (prData.merged === true && issue.state === "CLOSED") {
    return {
      issue_number: issue.number,
      title: issue.title,
      url,
      pr_number: prData.number,
      status: "merged",
      progress: 100,
      label: "Merged ✓",
    };
  }
  // #810: count APPROVED reviews per body-marker ROLE (re1/re2 share one login),
  // latest decision-affecting review per role — no stale double-count.
  const approvalCount = countApprovedRoles(reviews);
  if (approvalCount >= 2) {
    return { issue_number: issue.number, title: issue.title, url, pr_number: prData.number, status: "ready", progress: 80, label: `PR #${prData.number} · 2 approvals · ready` };
  }
  if (approvalCount === 1) {
    return { issue_number: issue.number, title: issue.title, url, pr_number: prData.number, status: "approved1", progress: 50, label: `PR #${prData.number} · 1 approval` };
  }
  return { issue_number: issue.number, title: issue.title, url, pr_number: prData.number, status: "in_review", progress: 20, label: `PR #${prData.number} · waiting on review` };
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

// #839: derive the sidebar heartbeat-active flag from a batch-progress payload
// so the pulse means "batch actively in progress", not just "Active Batch
// section non-empty". Once `complete` is true (every item merged/closed —
// see getOrComputeBatchProgress at items.every(...merged||closed)), the pulse
// must stop even if Head leaves a parked/blocked ticket lingering in the
// Active Batch section. Returns null when there's no progress payload (an
// undefined input — current callers always pass a value), defensively
// treated as "not active" at the route.
//
// #864: lifecycle consumers (this route, trigger auto-stop, reseed safe-boundary
// checks via isActiveFromProgress) must NOT consider an explicitly cleared
// `## Active Batch` section as active. resolveDisplayedBatch still serves the
// preserved snapshot so /api/batch-progress can render the prior batch for
// history, but the lifecycle signal must follow the operator's intent. The
// `liveActiveBatchCleared` flag set by getOrComputeBatchProgress short-circuits
// the items-based check below.
function isBatchActiveFromProgress(progress) {
  if (!progress) return null;
  if (progress.liveActiveBatchCleared) return false;
  const items = Array.isArray(progress.items) ? progress.items : [];
  return items.length > 0 && !progress.complete;
}

router.get("/api/batch-active", async (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  if (!getRepo(projectId)) return res.status(400).json({ error: "No repo configured for project" });

  // #839 (re1 follow-up on #844): share the same compute path that
  // /api/batch-progress uses so the completion-aware answer is available on
  // cache miss too, not only after the panel has been opened once. The
  // sidebar's 30s poll on all projects stays cheap because (a) the shared
  // BATCH_PROGRESS_TTL_MS cache absorbs most hits, (b) idle projects skip the
  // compute entirely, and (c) progressFromSnapshot resolves items from the
  // already-polled #806 GraphQL snapshot — REST fallback only fires for
  // items outside the recent window.
  const data = await getOrComputeBatchProgress(projectId);
  const active = isBatchActiveFromProgress(data);
  // #870: surface batch_type so the sidebar can label review vs code batches.
  return res.json({ active: active === null ? false : active, batch_type: (data && data.batch_type) || "code" });
});

// #807: parsed view of the server-authored GITHUB.md. Single source of truth is
// the file, so this endpoint and file-reading agents see identical data. Same
// project/config guard as batch-active (a traversal id isn't in config →
// getRepo null → 400). Surfaces freshness + a distinct parse-error result.
router.get("/api/github-parsed", (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  if (!getRepo(projectId)) return res.status(400).json({ error: "No repo configured for project" });
  const ghPath = path.join(CONFIG_DIR, projectId, "GITHUB.md");
  let text;
  try {
    text = fs.readFileSync(ghPath, "utf-8");
  } catch {
    return res.json({ ok: false, error: "GITHUB.md not found" });
  }
  const parsed = parseGithub(text);
  if (!parsed.ok) return res.json(parsed);
  // Live staleness: even when the file isn't regenerated (e.g. rate-limited →
  // no new sync pass), age must stay visible. Compare against a FIXED window,
  // never adaptiveTTL (which is Infinity under critical rate-limit and would
  // hide unbounded staleness exactly when it matters).
  // #827: a malformed `generatedAt` → Date.parse NaN. Normalize to null so the
  // response field is a clean "unknown age" (not NaN), and _githubLiveStale
  // also treats NaN/null as stale rather than hiding staleness on a suspect file.
  const rawAge = parsed.generatedAt ? Date.now() - Date.parse(parsed.generatedAt) : null;
  const ageMs = Number.isNaN(rawAge) ? null : rawAge;
  return res.json({
    ...parsed,
    ageMs,
    _stale: _githubLiveStale(parsed.stale, ageMs),
  });
});

// #839 (re1 follow-up on #844): shared compute path for /api/batch-progress
// and /api/batch-active. Returns the JSON body either route would send for a
// successful response, or null to signal "no repo configured for project"
// (caller's 400). Hits/populates _batchProgressCache so concurrent panel +
// sidebar polls share the work via the BATCH_PROGRESS_TTL_MS cache.
async function getOrComputeBatchProgress(projectId) {
  const cached = _batchProgressCache.get(projectId);
  if (isProjectArchived(projectId)) {
    return { batch_number: null, items: [], summary: "", complete: false, completeConfirmed: false, batch_type: "code", _archived: true, _readonly: true };
  }
  // #812: parked (idle) project — never run batch-progress gh/GraphQL calls,
  // and ALWAYS flag the payload _idle (even on a fresh cache hit), so the
  // endpoint contract is consistent regardless of cache freshness. This must
  // precede the fresh-cache and rate-limit returns below.
  if (isProjectIdle(projectId)) {
    if (cached) return { ...cached.data, _idle: true };
    return { batch_number: null, items: [], summary: "", complete: false, completeConfirmed: false, batch_type: "code", _idle: true };
  }
  const batchTTL = adaptiveTTL(BATCH_PROGRESS_TTL_MS);
  if (cached && Date.now() - cached.ts < batchTTL) {
    return cached.data;
  }
  // #554: if critically rate-limited, serve stale cache instead of
  // firing N gh calls per batch item.
  if (isRateLimited() && cached) {
    return { ...cached.data, _stale: true, _rateLimited: true };
  }
  // #802: GraphQL budget exhausted (separate from REST) — prefer serving the
  // existing cache (even stale) over the GraphQL query below. With no cache we
  // fall through to the REST gh-CLI fallback path (gated on its own bucket).
  if (isGraphqlRateLimited() && cached) {
    return { ...cached.data, _stale: true, _rateLimited: true };
  }

  const repo = getRepo(projectId);
  if (!repo) return null;
  const admission = projectAdmission(projectId, { demand: true });
  if (!admission) {
    return { batch_number: null, items: [], summary: "", complete: false, completeConfirmed: false, batch_type: "code", _archived: true, _readonly: true };
  }
  if (cached) {
    startBatchProgressRefresh(projectId, repo, admission);
    return { ...cached.data, _stale: true, _refreshing: true };
  }

  return computeBatchProgress(projectId, repo, admission);
}

function startBatchProgressRefresh(projectId, repo, admission) {
  const existing = _batchProgressRefreshes.get(projectId);
  if (existing && isAdmissionCurrent(existing.admission)) return existing.promise;
  const entry = { admission, promise: null };
  entry.promise = computeBatchProgress(projectId, repo, admission)
    .catch(() => {
      // Non-fatal: callers already received the last good payload. The next poll
      // will retry rather than turning a transient gh/GitHub failure into UI lag.
    })
    .finally(() => {
      if (_batchProgressRefreshes.get(projectId) === entry) _batchProgressRefreshes.delete(projectId);
    });
  _batchProgressRefreshes.set(projectId, entry);
  return entry.promise;
}

async function computeBatchProgress(projectId, repo, admission = projectAdmission(projectId, { demand: true })) {
  if (!admission || !isAdmissionCurrent(admission)) {
    return { batch_number: null, items: [], summary: "", complete: false, completeConfirmed: false, batch_type: "code", _archived: true, _readonly: true };
  }
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
  // #870: determine the displayed batch type up front (read-only) so review
  // batches skip the GitHub snapshot-freshness check AND the merge-state path
  // below entirely. The displayed type follows the SAME live-vs-snapshot
  // decision as resolveDisplayedBatch: a just-archived review batch's live
  // `**Batch type:**` is gone, so its type must come from the persisted snapshot.
  const _liveActive = parseActiveBatch(queueText);
  const _existingSnap = queueReadOk ? readBatchSnapshot(projectId) : null;
  const _displaySource = queueReadOk ? pickDisplayedSource(_liveActive, _existingSnap) : "live";
  const displayedBatchType =
    _displaySource === "snapshot"
      ? (_existingSnap && _existingSnap.batch_type) || "code"
      : parseBatchType(queueText);
  const isReviewBatch = REVIEW_BATCH_TYPES.has(displayedBatchType);

  // #334: validate the on-disk snapshot's first issue against GitHub before
  // resolveDisplayedBatch can serve it — CODE batches only. Review batches must
  // make ZERO GitHub calls, and their snapshot issue numbers are queue-authored
  // (not subject to the purged-repo staleness this check guards).
  if (queueReadOk && !isReviewBatch) {
    const existing = readBatchSnapshot(projectId);
    if (existing && Array.isArray(existing.issueNumbers) && existing.issueNumbers.length > 0) {
      const freshness = await checkBatchSnapshotFreshness(repo, existing);
      if (!isAdmissionCurrent(admission)) {
        return { batch_number: null, items: [], summary: "", complete: false, completeConfirmed: false, batch_type: "code", _archived: true, _readonly: true };
      }
      if (freshness === "gone") deleteBatchSnapshot(projectId);
      // "unknown" → leave the file alone; transient failure will
      // retry on the next cache miss.
    }
  }

  // #429 / quadwork#316: resolve the displayed batch through the
  // snapshot-aware helper so merged items stay visible after Head
  // moves them from Active Batch to Done, until a new batch starts.
  const { batchNumber, issueNumbers, batch_type, reviewItems } = resolveDisplayedBatch(queueText, projectId, { queueReadOk });
  // #864: lifecycle-signal flag. The displayed batch may be the preserved
  // snapshot (so /api/batch-progress keeps showing it), but lifecycle consumers
  // (/api/batch-active, trigger auto-stop, reseed safe-boundary) must follow
  // the operator's explicit clear. Compute from the LIVE parse, only when the
  // queue file actually read OK — the #316 bypass (queueReadOk=false) must NOT
  // be mistaken for an explicit clear, since the operator never touched it.
  const liveActiveBatchCleared = queueReadOk && parseActiveBatch(queueText).issueNumbers.length === 0;
  // #828 P2: batch identity = number + issue set. evalBatchCompleteConfirmed
  // resets its streak when this changes, so a new already-complete batch can't
  // inherit the prior batch's first cycle and confirm in one tick.
  const batchKey = `${batchNumber}::${[...issueNumbers].sort((a, b) => a - b).join(",")}`;
  const terminalRows = terminalItemsFromSnapshot(readBatchSnapshot(projectId), batchNumber, issueNumbers);
  if (issueNumbers.length === 0) {
    evalBatchCompleteConfirmed(projectId, batchKey, false, null); // reset any complete streak
    const data = { batch_number: batchNumber, items: [], summary: "", complete: false, completeConfirmed: false, liveActiveBatchCleared, batch_type };
    _batchProgressCache.set(projectId, { ts: Date.now(), data });
    return data;
  }

  // #870: review batch — progress computed ENTIRELY from the current Active
  // Batch item states (or the preserved snapshot's), with NO GitHub calls. The
  // queue is HEAD-authored and authoritative, so completeConfirmed = complete —
  // do NOT route through evalBatchCompleteConfirmed (its two-cycle distinct-ts
  // guard never advances without a #806 GraphQL fetch a review batch never makes).
  if (batch_type === "ticket-review" || batch_type === "pr-review") {
    // Defensive: a review batch should always carry per-item states, but if the
    // snapshot somehow has issue numbers without them, treat all as queued.
    const ri = reviewItems.length > 0
      ? reviewItems
      : issueNumbers.map((n) => ({ issue: n, review_state: "queued", approvals: 0 }));
    const ghIndex = loadGithubItemIndex(projectId);
    const items = ri.map((r) => reviewItemView(r, batch_type, ghIndex));
    const summary = summarizeReviewItems(ri);
    const complete = ri.length > 0 && ri.every((r) => r.review_state === "approved");
    const data = { batch_number: batchNumber, items, summary, complete, completeConfirmed: complete, liveActiveBatchCleared, batch_type };
    _batchProgressCache.set(projectId, { ts: Date.now(), data });
    return data;
  }

  // #810: compute each item from the #806 REST snapshot (no GraphQL in steady
  // state); #828 P1: fall back to a targeted by-number REST/Search fetch
  // (progressForItemRest, no GraphQL) only for active-batch issues the snapshot
  // can't prove (outside / truncated window, or absent).
  // #943: when the in-memory snapshot is empty (e.g. just after a restart, until
  // the next board refresh repopulates it), resolve from the PERSISTED GITHUB.md
  // board instead of firing an uncapped burst of live per-item Searches. The
  // file survives restarts, so the post-restart "fetch failed" window disappears.
  // The live by-number fallback runs ONLY when an in-memory snapshot exists but
  // can't prove a specific item — now (a) concurrency-capped via _mapLimited and
  // (b) soft-failing a transient error to "queued (retrying)" rather than a hard
  // "fetch failed".
  const snapshot = _graphqlCache.get(repo) || null;
  let items;
  if (snapshot) {
    items = await _mapLimited(issueNumbers, GH_MAX_CONCURRENT, async (n) => {
      if (!isAdmissionCurrent(admission)) return softRetryingRow(n);
      const fromSnap = progressFromSnapshot(snapshot, n);
      if (fromSnap) return fromSnap;
      const fromTerminalCache = terminalRows.get(n);
      if (fromTerminalCache && !snapshotHasOpenIssue(snapshot, n)) return fromTerminalCache;
      try {
        return await progressForItemRest(repo, n, () => isAdmissionCurrent(admission));
      } catch {
        return softRetryingRow(n); // #943: transient (secondary rate-limit/network) → soft
      }
    });
  } else {
    // Cold in-memory cache → persisted-snapshot fallback, zero live per-item
    // Search. Items the file can't classify render soft "queued (retrying)" and
    // firm up next cycle once _graphqlCache repopulates.
    const parsed = loadGithubParsed(projectId);
    items = issueNumbers.map((n) => progressFromGithubFile(parsed, n) || terminalRows.get(n) || softRetryingRow(n));
  }
  if (!isAdmissionCurrent(admission)) {
    return { batch_number: null, items: [], summary: "", complete: false, completeConfirmed: false, batch_type: "code", _archived: true, _readonly: true };
  }
  const summary = summarizeItems(items);
  // #350: treat CLOSED-without-PR items as complete alongside merged
  // so batches that mix runbook/superseded closes with real PRs
  // still flip to the COMPLETE state once everything is done.
  const complete = items.length > 0 && items.every((it) => it.status === "merged" || it.status === "closed");
  // #810: confirm `complete` across two distinct successful snapshot cycles
  // before any auto-stop consumer may act on it (never auto-stop on a single
  // transient/stale complete). Keyed on the snapshot's ts as the cycle marker.
  const completeConfirmed = evalBatchCompleteConfirmed(projectId, batchKey, complete, snapshot ? snapshot.ts : null);
  const data = { batch_number: batchNumber, items, summary, complete, completeConfirmed, liveActiveBatchCleared, batch_type };
  writeBatchSnapshot(projectId, {
    batchNumber,
    issueNumbers: issueNumbers.slice(),
    batch_type,
    reviewItems,
    terminalItems: collectTerminalItems(items, terminalRows),
  });
  _batchProgressCache.set(projectId, { ts: Date.now(), data });
  return data;
}

router.get("/api/batch-progress", async (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  const data = await getOrComputeBatchProgress(projectId);
  if (data === null) return res.status(400).json({ error: "No repo configured for project" });
  return res.json(data);
});

// #445: Memory section (agent-memory butler integration) removed.

// ─── Setup ─────────────────────────────────────────────────────────────────

// #975: setup shell-outs run OFF the event loop via the promisified execFile,
// so a slow/hung `gh clone` / `git fetch` / `git worktree add` / `claude -p` no
// longer blocks every agent's WS/HTTP/timers in this single-process server.
// Returns { ok, output } (the old synchronous exec()'s contract) so call sites
// only needed an `await`; setup fns take this as an injectable execFn for tests.
async function execAsync(cmd, args, opts) {
  try {
    const { stdout } = await _execFileAsync(cmd, args, { encoding: "utf-8", timeout: 30000, ...opts });
    return { ok: true, output: (stdout || "").trim() };
  } catch (err) {
    return { ok: false, output: String(err.stderr || err.stdout || err.message || "").trim() };
  }
}

// #974: reduce a git remote URL to its canonical `owner/repo` slug (mirrors the
// CLI helper) so a reused clone can be checked against the entered repo.
function repoSlugFromRemote(url) {
  if (!url) return "";
  const m = url.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1].toLowerCase() : "";
}

// #975: async — awaits each git/gh shell-out via the injectable execFn
// (default execAsync) so the setup route never blocks the event loop. execFn
// keeps the exec() { ok, output } contract; tests inject a fake.
async function ensureGitHeadForSetup(workingDir, repo, execFn = execAsync) {
  const gitDir = path.join(workingDir, ".git");
  if (!fs.existsSync(gitDir)) {
    if (!fs.existsSync(workingDir)) ensureSecureDir(workingDir);
    if (!REPO_RE.test(repo)) return { ok: false, error: "Invalid repo" };
    const clone = await execFn("gh", ["repo", "clone", repo, workingDir]);
    if (!clone.ok) return { ok: false, error: `Clone failed: ${clone.output}` };
  } else {
    const fetch = await execFn("git", ["fetch", "origin", "--prune"], { cwd: workingDir });
    if (!fetch.ok) return { ok: false, error: `Fetch failed: ${fetch.output}` };
  }

  // #974: fail clearly if the working dir is a clone of a DIFFERENT repo than
  // the slug entered — otherwise setup silently seeds worktrees into the wrong
  // project. (Same guard as the CLI wizard.)
  const originUrl = await execFn("git", ["remote", "get-url", "origin"], { cwd: workingDir });
  if (originUrl.ok) {
    const actual = repoSlugFromRemote(originUrl.output);
    const expected = String(repo || "").toLowerCase().replace(/\.git$/, "");
    if (actual && expected && actual !== expected) {
      return { ok: false, error: `Origin mismatch: working directory points to '${actual}', but the repo entered is '${repo}'. Use the matching clone or correct the repo slug.` };
    }
  }

  let headCheck = await execFn("git", ["rev-parse", "--verify", "HEAD"], { cwd: workingDir });
  if (!headCheck.ok) {
    const remoteHead = await execFn("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: workingDir });
    let remoteBranch = remoteHead.ok ? remoteHead.output.replace(/^origin\//, "") : "";
    if (!remoteBranch) {
      for (const candidate of ["main", "master"]) {
        const hasBranch = await execFn("git", ["rev-parse", "--verify", `origin/${candidate}`], { cwd: workingDir });
        if (hasBranch.ok) { remoteBranch = candidate; break; }
      }
    }
    if (remoteBranch) {
      const checkout = await execFn("git", ["checkout", "-B", remoteBranch, `origin/${remoteBranch}`], { cwd: workingDir });
      if (!checkout.ok) return { ok: false, error: `Checkout failed after fetch: ${checkout.output}` };
      headCheck = await execFn("git", ["rev-parse", "--verify", "HEAD"], { cwd: workingDir });
    }
  }
  if (headCheck.ok) return { ok: true };

  const seed = await execFn("git", [
    "-c", "user.name=QuadWork",
    "-c", "user.email=quadwork@localhost",
    "commit", "--allow-empty", "-m", "Initial commit (created by QuadWork setup)",
  ], { cwd: workingDir });
  if (!seed.ok) {
    return { ok: false, error: `Repository is empty and could not be initialized: ${seed.output}` };
  }
  const branchResult = await execFn("git", ["symbolic-ref", "--short", "HEAD"], { cwd: workingDir });
  const defaultBranch = branchResult.ok ? branchResult.output : "main";
  const push = await execFn("git", ["push", "origin", defaultBranch], { cwd: workingDir });
  if (!push.ok) return { ok: false, error: `Initial commit created but push failed: ${push.output}` };
  return { ok: true };
}

// #974: create (or re-attach) a single agent worktree. A prior setup can leave
// the `worktree-<agent>` branch behind after its directory was deleted; the old
// code ran `git branch <name> HEAD` unconditionally, which fails "already
// exists" and bricked a re-run with no rollback. Reuse an existing branch
// instead — prune any stale worktree registration still holding it, then
// `worktree add` re-attaches. `execFn` is injectable for tests.
// #975: async (default execFn = execAsync) so `git worktree add` runs off the
// event loop. `await execFn(...)` works whether execFn is async (production) or
// returns a plain object (test fakes).
async function createAgentWorktree(workingDir, wtDir, branchName, execFn = execAsync) {
  const branchExists = (await execFn("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: workingDir })).ok;
  if (branchExists) {
    await execFn("git", ["worktree", "prune"], { cwd: workingDir });
  } else {
    const branch = await execFn("git", ["branch", branchName, "HEAD"], { cwd: workingDir });
    if (!branch.ok) return { ok: false, error: `branch failed: ${branch.output}` };
  }
  const result = await execFn("git", ["worktree", "add", wtDir, branchName], { cwd: workingDir });
  if (result.ok) return { ok: true, detached: false };
  // Fallback: detached worktree (branch may be checked out in a live worktree).
  const result2 = await execFn("git", ["worktree", "add", "--detach", wtDir, "HEAD"], { cwd: workingDir });
  if (result2.ok) return { ok: true, detached: true };
  return { ok: false, error: result.output };
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
  if (typeof token !== "string" || !token.trim()) return res.status(400).json({ error: "Missing token" });
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

// #975: async handler — setup shell-outs (gh/git/claude) now await execAsync
// so they run off the event loop instead of freezing every agent's WS/HTTP/
// timers in this single-process server. Express 5 forwards a rejected handler
// to the default error handler (same 500 the prior sync throws produced).
router.post("/api/setup", async (req, res) => {
  const step = req.query.step;
  const body = req.body || {};

  switch (step) {
    case "verify-repo": {
      const repo = body.repo;
      if (!repo || !REPO_RE.test(repo)) return res.json({ ok: false, error: "Invalid repo format (use owner/repo)" });
      const result = await execAsync("gh", ["repo", "view", repo, "--json", "name,owner,viewerPermission"]);
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
      const ready = await ensureGitHeadForSetup(workingDir, body.repo);
      if (!ready.ok) return res.json({ ok: false, error: ready.error });
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
        // #974: reuse an existing branch (see createAgentWorktree) so a re-run
        // after a deleted worktree dir no longer aborts on "branch exists".
        const wt = await createAgentWorktree(workingDir, wtDir, branchName);
        if (!wt.ok) { errors.push(`${agent}: ${wt.error}`); continue; }
        created.push(wt.detached ? `${agent} (detached)` : agent);
      }
      // Pre-trust worktree directories for Claude Code agents (#599).
      // Running `claude -p` in a directory auto-trusts it for future sessions,
      // preventing the interactive "Do you trust this directory?" prompt.
      const agentBackends = body.backends || {};
      const claudeAgents = agents.filter((a) => (agentBackends[a] || "claude") === "claude");
      if (claudeAgents.length > 0) {
        const claudePath = await execAsync("which", ["claude"]);
        if (claudePath.ok) {
          for (const agent of claudeAgents) {
            const wtDir = path.join(parentDir, `${projectName}-${agent}`);
            if (!fs.existsSync(wtDir)) continue;
            // #975: await off the event loop. A hung `claude -p` (15s timeout)
            // per agent used to block the whole server; now it yields.
            await execAsync("claude", ["-p", "echo ok"], { cwd: wtDir, timeout: 15000, stdio: "pipe" });
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
      const activated = Object.prototype.hasOwnProperty.call(cfg, "installation_id");
      if (!activated && cfg.projects.some((p) => p.id === id)) {
        // Project already saved, but still (idempotently) seed the
        // OVERNIGHT-QUEUE.md in case a previous run failed to write
        // it or the operator deleted it. writeOvernightQueueFileSafe
        // below no-ops when the file is already present, so this
        // can't clobber Head/user edits.
        writeOvernightQueueFileSafe(id, cfg.projects.find((p) => p.id === id)?.name || id, cfg.projects.find((p) => p.id === id)?.repo || "");
        writeGithubFileSafe(id, cfg.projects.find((p) => p.id === id)?.name || id, cfg.projects.find((p) => p.id === id)?.repo || "");
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
        agents[agentId] = {
          cwd: path.join(parentDir, `${dirName}-${agentId}`),
          command: cmd,
          auto_approve: autoApprove,
          mcp_inject: injectModeForCommand(cmd),
          ...(cliBase === "codex" ? { reasoning_effort: "medium" } : {}),
        };
      }
      const dir = path.dirname(CONFIG_PATH);
      ensureSecureDir(dir);
      if (activated) {
        try {
          commitV2Configuration((fresh) => {
            if ((fresh.projects || []).some((project) => project.id === id)) {
              const error = new Error("Project already in config");
              error.code = "QW_PROJECT_ALREADY_CONFIGURED";
              throw error;
            }
            if (!Array.isArray(fresh.projects)) fresh.projects = [];
            fresh.projects.push({
              id,
              name,
              repositories: [{ key: "primary", repo, working_dir: workingDir, primary: true }],
              agents,
              chat_mode: "file",
            });
          });
        } catch (err) {
          if (err.code === "QW_PROJECT_ALREADY_CONFIGURED") {
            const fresh = readConfigFile();
            const existing = (fresh.projects || []).find((project) => project.id === id);
            const existingRepo = primaryRepository(existing)?.repo || "";
            writeOvernightQueueFileSafe(id, existing?.name || id, existingRepo);
            writeGithubFileSafe(id, existing?.name || id, existingRepo);
            return res.json({ ok: true, message: "Project already in config" });
          }
          if (sendV2ConfigurationError(res, err)) return;
          throw err;
        }
      } else {
        cfg.projects.push({
          id, name, repo, working_dir: workingDir, agents,
          chat_mode: "file",
        });
        writeConfig(cfg);
      }

      // #775: initialize file-chat for the new project so the first
      // chat send doesn't error with "Project not initialized" before
      // the next server restart. Boot init only runs for projects
      // already in config.json at startup.
      fileChat.initProject(id);

      // Batch 25 / #204: seed the per-project OVERNIGHT-QUEUE.md at
      // ~/.quadwork/{id}/OVERNIGHT-QUEUE.md.
      writeOvernightQueueFileSafe(id, name || id, repo);
      // #807: seed the per-project GITHUB.md alongside it.
      writeGithubFileSafe(id, name || id, repo);

      return res.json({ ok: true });
    }
    default:
      return res.status(400).json({ error: "Unknown step" });
  }
});

// ─── Re-seed agents from current templates (#845) ──────────────────────────

// Split an AGENTS.md into the leading "intro" text (above the first H2) plus
// one block per `## H2` heading. Lines that begin with `## ` (exactly two
// hashes + whitespace) start a new block; H1 / H3+ stay inside the current
// block so subsections nested under an H2 are not orphaned.
function _splitAgentsMdSections(text) {
  const blocks = [];
  let intro = [];
  let current = null;
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) blocks.push(current);
      current = { heading: m[1], body: "" };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    } else {
      intro.push(line);
    }
  }
  if (current) blocks.push(current);
  return { intro: intro.join("\n"), blocks };
}

// Merge a fresh seed template with operator-added sections from the existing
// worktree AGENTS.md. The fresh template wins for any H2 heading it defines
// (so canonical role/workflow/communication sections always reflect current
// rules), and any H2 block in the existing file whose heading is NOT in the
// template is appended at the end under a marker comment. Heading comparison
// is case-insensitive and whitespace-normalized.
//
// Returns { content, preservedHeadings }. If the existing content is empty
// or has no custom sections, returns the fresh template verbatim.
function reseedAgentsMd(existingContent, freshContent) {
  if (!existingContent || !existingContent.trim()) {
    return { content: freshContent, preservedHeadings: [] };
  }
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const fresh = _splitAgentsMdSections(freshContent);
  const existing = _splitAgentsMdSections(existingContent);
  const freshHeadings = new Set(fresh.blocks.map((b) => norm(b.heading)));
  const preserved = existing.blocks.filter((b) => !freshHeadings.has(norm(b.heading)));
  if (preserved.length === 0) {
    return { content: freshContent, preservedHeadings: [] };
  }
  const trailer =
    "\n\n<!-- Operator notes preserved from prior AGENTS.md (#845) -->\n\n" +
    preserved
      .map((b) => `## ${b.heading}\n${b.body}`.replace(/\s+$/, ""))
      .join("\n\n");
  const base = freshContent.replace(/\s+$/, "");
  return {
    content: base + trailer + "\n",
    preservedHeadings: preserved.map((b) => b.heading),
  };
}

// #966: Distinctive H2 headings that only appear in QuadWork's seeded
// `templates/CLAUDE.md`. A worktree CLAUDE.md is treated as QuadWork-seeded
// (and therefore safe to refresh) ONLY when it contains ALL of these — a
// project's own hand-authored CLAUDE.md (e.g. this repo's, whose H2s are
// "What is QuadWork", "Tech Stack", …) won't, so it is never clobbered. These
// three headings have been stable across template versions, so a file seeded
// by an older template is still recognized.
const SEEDED_CLAUDE_SIGNATURE = Object.freeze([
  "Multi-Agent System",
  "GitHub Workflow",
  "Communication Rules",
]);

// #966: True only when `content` is a QuadWork-seeded CLAUDE.md — i.e. it
// carries every heading in SEEDED_CLAUDE_SIGNATURE (case-insensitive,
// whitespace-normalized, same comparison the merger uses). Empty/foreign
// content returns false so reseed leaves it untouched. Pure — no I/O.
function _isSeededClaudeMd(content) {
  if (!content || !content.trim()) return false;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const headings = new Set(
    _splitAgentsMdSections(content).blocks.map((b) => norm(b.heading))
  );
  return SEEDED_CLAUDE_SIGNATURE.every((h) => headings.has(norm(h)));
}

// #854: Extract the reviewer token path from a worktree's existing AGENTS.md
// so the re-seed substitution preserves a custom path instead of resetting
// it to the default. The re1/re2 seed renders:
//
//     export GH_TOKEN=$(cat <path>)
//
// Common operator-edited variations are recognized:
//   • optional `export ` prefix
//   • optional outer `"$(cat …)"` double-quote wrapping
//   • optional inner quoting of the path (single or double quotes)
//   • whitespace tolerated between tokens
//
// Returns the raw extracted path (quotes stripped, whitespace trimmed) or
// `null` when no GH_TOKEN line is present or the line doesn't use the
// `$(cat …)` form. Pure — no I/O.
function _extractReviewerTokenPath(existingContent) {
  if (!existingContent || typeof existingContent !== "string") return null;
  // First find a GH_TOKEN line. We anchor on the literal name so an operator
  // comment about token paths can't accidentally seed a stale path.
  const lineMatch = existingContent.match(/^[ \t]*(?:export[ \t]+)?GH_TOKEN[ \t]*=.*$/m);
  if (!lineMatch) return null;
  // Then pull the path out of `$(cat …)` on that line. Non-greedy capture
  // stops at the first `)` after `cat`, which is the correct boundary for
  // any well-formed command substitution.
  const catMatch = lineMatch[0].match(/\$\(\s*cat\s+(.+?)\s*\)/);
  if (!catMatch) return null;
  let raw = catMatch[1].trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw || null;
}

// #855: Map legacy agent config keys to the canonical seed-template names.
// Older projects (and operator-renamed agents) may use keys like
// `reviewer1` / `reviewer2` / `t1..t3`; the seed templates only exist for
// the canonical `head/re1/re2/dev` slugs. Any key not in this table is
// assumed canonical (so future agent slugs work without a code change).
const LEGACY_AGENT_KEY_TO_CANONICAL = Object.freeze({
  t1: "head",
  t2a: "re1",
  t2b: "re2",
  t3: "dev",
  reviewer1: "re1",
  reviewer2: "re2",
});

function _canonicalAgentSlug(agentKey) {
  return LEGACY_AGENT_KEY_TO_CANONICAL[agentKey] || agentKey;
}

// #855: Resolve the per-agent re-seed targets for a project. Pulls the
// worktree path from `project.agents[key].cwd` (the source of truth — the
// agent process itself spawns there) rather than reconstructing
// `${dirName}-${key}`, so legacy worktree names like `*-reviewer1` are
// covered. When a project has no `agents` map at all (very old config),
// falls back to the canonical sibling layout. Pure — no I/O.
function _resolveReseedTargets(project) {
  const workingDir = project?.working_dir;
  if (!workingDir) return [];
  const dirName = path.basename(workingDir);
  const parentDir = path.dirname(workingDir);
  const agentsCfg = project.agents && typeof project.agents === "object" ? project.agents : null;
  const keys = agentsCfg ? Object.keys(agentsCfg) : ["head", "re1", "re2", "dev"];
  return keys.map((agentKey) => {
    const canonical = _canonicalAgentSlug(agentKey);
    const configuredCwd = agentsCfg?.[agentKey]?.cwd;
    const wtDir = configuredCwd || path.join(parentDir, `${dirName}-${canonical}`);
    return { agentKey, canonical, wtDir };
  });
}

// Operator-triggered re-seed of a project's worktree AGENTS.md files from
// the current `templates/seeds/*.AGENTS.md` templates, using the same
// placeholder substitution as the setup wizard's `seed-files` step. New
// seed content (e.g. the #809 GITHUB.md discovery instructions) takes
// effect on the NEXT agent restart — this endpoint only rewrites the file.
//
// Guard: refuses to run while the project's batch is active, so a re-seed
// can't drop new instructions on agents in the middle of a task. Pass
// `{ force: true }` to override (operator escape hatch — the file is only
// re-read on next spawn, so even a forced re-seed is harmless to a live
// session, but the guard makes the safe path obvious).
router.post("/api/projects/:project/reseed-agents", async (req, res) => {
  const projectId = req.params.project;
  const body = req.body || {};
  const force = body.force === true;
  let admission;
  try { admission = captureProjectAdmission(projectId); }
  catch (err) { return sendProjectLifecycleException(res, err, projectId); }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
  catch { return res.status(500).json({ ok: false, error: "Failed to read config" }); }
  const project = cfg.projects?.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ ok: false, error: "Project not found" });
  const workingDir = project.working_dir;
  if (!workingDir) return res.status(400).json({ ok: false, error: "Project has no working_dir" });

  if (!force) {
    // re1 review on #845: fail CLOSED when batch state can't be computed.
    // Falling through to a re-seed when the gate is uncertain re-introduces
    // the exact mid-batch rewrite the gate exists to prevent. Three cases
    // route to the same "unknown" 503 (operator can retry or pass force:true):
    //  1. getOrComputeBatchProgress throws (network/IO)
    //  2. getOrComputeBatchProgress returns null (no repo / no progress data)
    //  3. isBatchActiveFromProgress returns null (no items payload)
    let active;
    try {
      const progress = await getOrComputeBatchProgress(projectId);
      active = isBatchActiveFromProgress(progress);
    } catch {
      return res.status(503).json({
        ok: false,
        error: "Could not verify batch state — aborting to avoid a mid-batch re-seed. Retry, or pass force:true to override.",
        batchUnknown: true,
      });
    }
    if (active === null) {
      return res.status(503).json({
        ok: false,
        error: "Batch state unknown (no progress data) — aborting to avoid a mid-batch re-seed. Retry, or pass force:true to override.",
        batchUnknown: true,
      });
    }
    if (active) {
      return res.status(409).json({
        ok: false,
        error: "Batch is active — re-seed deferred to avoid mid-batch instruction drift. Pass force:true to override; new seed content only takes effect on next agent restart.",
        batchActive: true,
      });
    }
  }

  if (!isAdmissionCurrent(admission)) {
    return res.status(409).json({ ok: false, error: "project is archived", code: "project_archived", project_id: projectId });
  }

  let result;
  try {
    result = _performReseedWrites(project, cfg, {
      reviewerUser: body.reviewerUser,
      reviewerTokenPath: body.reviewerTokenPath,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
  // #915: a manual reseed writes the current-version seeds, so advance the
  // auto-reseed marker too — otherwise it read stale (e.g. 2.2.1) after a
  // manual reseed to 2.3.0 and auto-reseed redundantly re-ran on next boot.
  try {
    const state = _loadReseedState();
    state.completedByProjectVersion[projectId] = _readPackageVersion();
    _saveReseedState(state);
  } catch { /* best-effort marker update; auto-reseed re-running is harmless/idempotent */ }
  return res.json({
    ok: true,
    reseeded: result.reseeded,
    skipped: result.skipped,
    preserved: result.preserved,
    note: "Re-seeded files take effect on next agent restart.",
  });
});

// #856: Per-target write loop, extracted so the manual route handler and the
// auto-reseed startup hook share one implementation. Throws on missing seed
// template (the route handler maps that to a 500). Returns the same shape
// the endpoint returns so the auto-reseed log can include per-project stats.
//
// `opts.reviewerUser` and `opts.reviewerTokenPath` are operator overrides:
// when set they win over the per-agent extraction / cfg fallback. Auto-reseed
// passes neither so each project uses the same priority chain manual re-seed
// uses (per-agent extraction → cfg → default).
function _performReseedWrites(project, cfg, opts = {}) {
  const workingDir = project.working_dir;
  const dirName = path.basename(workingDir);
  const reviewerUser = opts.reviewerUser ?? cfg.reviewer_github_user ?? "";
  const defaultReviewerTokenPath = path.join(os.homedir(), ".quadwork", "reviewer-token");

  // #855: walk the project's configured agents (resolved by `cwd`) instead of
  // reconstructing sibling paths. Legacy keys (`reviewer1` etc.) still pull
  // the canonical seed template via `_canonicalAgentSlug`.
  const targets = _resolveReseedTargets(project);
  const reseeded = [];
  const preserved = {};
  const skipped = [];
  for (const { agentKey, canonical, wtDir } of targets) {
    if (!fs.existsSync(wtDir)) { skipped.push(`${agentKey} (no worktree)`); continue; }
    const seedSrc = path.join(TEMPLATES_DIR, "seeds", `${canonical}.AGENTS.md`);
    if (!fs.existsSync(seedSrc)) {
      throw new Error(`Missing seed template: templates/seeds/${canonical}.AGENTS.md`);
    }

    // #854: Read the existing AGENTS.md FIRST so the per-agent token path
    // resolution can see what the operator currently has. Resolution order:
    //   1. explicit opts override (`opts.reviewerTokenPath`)
    //   2. extracted from this worktree's existing AGENTS.md
    //   3. project/global config (`cfg.reviewer_token_path`)
    //   4. default `~/.quadwork/reviewer-token`
    // Head/dev seeds have no GH_TOKEN line, so (2) is `null` for them and
    // they fall through to the default — the substituted placeholder is
    // unused in those templates anyway.
    const agentsMd = path.join(wtDir, "AGENTS.md");
    let existing = "";
    if (fs.existsSync(agentsMd)) {
      try { existing = fs.readFileSync(agentsMd, "utf-8"); } catch { existing = ""; }
    }
    const tokenPath =
      opts.reviewerTokenPath
      || _extractReviewerTokenPath(existing)
      || cfg.reviewer_token_path
      || defaultReviewerTokenPath;

    let freshContent = fs.readFileSync(seedSrc, "utf-8");
    freshContent = freshContent
      .replace(/\{\{reviewer_github_user\}\}/g, reviewerUser)
      .replace(/\{\{reviewer_token_path\}\}/g, tokenPath)
      .replace(/\{\{project_name\}\}/g, dirName);

    const merged = reseedAgentsMd(existing, freshContent);
    fs.writeFileSync(agentsMd, merged.content);
    reseeded.push(`${agentKey}/AGENTS.md`);
    if (merged.preservedHeadings.length > 0) {
      preserved[agentKey] = merged.preservedHeadings;
    }

    // #966: Refresh the worktree CLAUDE.md too — but ONLY when it is provably
    // QuadWork-seeded, so a project's own hand-authored CLAUDE.md is never
    // clobbered. Uses the same reseedAgentsMd merge (fresh template wins
    // per-H2, operator-added H2 sections preserved). Missing or foreign
    // CLAUDE.md is left byte-identical and recorded in `skipped`.
    const claudeMd = path.join(wtDir, "CLAUDE.md");
    if (!fs.existsSync(claudeMd)) {
      skipped.push(`${agentKey}/CLAUDE.md (none)`);
    } else {
      let claudeExisting = "";
      try { claudeExisting = fs.readFileSync(claudeMd, "utf-8"); } catch { claudeExisting = ""; }
      if (!_isSeededClaudeMd(claudeExisting)) {
        skipped.push(`${agentKey}/CLAUDE.md (not QuadWork-seeded)`);
      } else {
        const claudeSrc = path.join(TEMPLATES_DIR, "CLAUDE.md");
        if (!fs.existsSync(claudeSrc)) {
          skipped.push(`${agentKey}/CLAUDE.md (no template)`);
        } else {
          const freshClaude = fs.readFileSync(claudeSrc, "utf-8")
            .replace(/\{\{project_name\}\}/g, dirName);
          const mergedClaude = reseedAgentsMd(claudeExisting, freshClaude);
          fs.writeFileSync(claudeMd, mergedClaude.content);
          reseeded.push(`${agentKey}/CLAUDE.md`);
          if (mergedClaude.preservedHeadings.length > 0) {
            preserved[`${agentKey}/CLAUDE.md`] = mergedClaude.preservedHeadings;
          }
        }
      }
    }
  }
  return { reseeded, skipped, preserved };
}

// ─── #856: Auto-reseed on version upgrade ────────────────────────────────
//
// On every server startup we compare the current package version against a
// per-project completion record in `~/.quadwork/reseed-state.json`. Any
// project that hasn't been re-seeded for the current version gets re-seeded
// from the current templates so existing users pick up new seed instructions
// (e.g. GITHUB.md discovery) without ever clicking the manual button.
//
// The per-project state is load-bearing: a project deferred mid-batch stays
// pending in the state file so the very next startup (or any future safe-
// boundary hook) retries it. Using a single global "last run version"
// marker would strand any deferred project — once the marker advanced past
// the upgrade version, the deferred project would never be re-seeded.

const RESEED_STATE_PATH = path.join(os.homedir(), ".quadwork", "reseed-state.json");
const PACKAGE_JSON_PATH = path.join(__dirname, "..", "package.json");

function _readPackageVersion(pkgPath = PACKAGE_JSON_PATH) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch { return "0.0.0"; }
}

function _loadReseedState(statePath = RESEED_STATE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const map = parsed && typeof parsed === "object" && parsed !== null && parsed.completedByProjectVersion;
    const completed = map && typeof map === "object" && !Array.isArray(map) ? { ...map } : {};
    // Drop non-string version values so a corrupt write can't poison the
    // up-to-date check (which is a string equality).
    for (const k of Object.keys(completed)) {
      if (typeof completed[k] !== "string") delete completed[k];
    }
    return { completedByProjectVersion: completed };
  } catch { return { completedByProjectVersion: {} }; }
}

function _saveReseedState(state, statePath = RESEED_STATE_PATH) {
  try {
    const dir = path.dirname(statePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {}
  // Single fs.writeFileSync — write-replace is atomic enough for this
  // boot-time-only writer (no concurrent writer exists).
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

// #922: per-project throttle for the periodic-tick "stuck deferral" log (the
// batch-state-unknown / threw paths only). Map: projectId -> consecutive
// periodic error-deferral count. The first occurrence logs immediately, then
// once every PERIODIC_DEFER_LOG_EVERY ticks — so a persistently-erroring
// project stays observable without per-tick spam. Exported for test reset.
const PERIODIC_DEFER_LOG_EVERY = 15; // ~15 min at the 60s retry-tick cadence
const _periodicDeferStreak = new Map();

async function autoReseedOnStartup(cfg, opts = {}) {
  const version = opts.version || _readPackageVersion();
  const statePath = opts.statePath || RESEED_STATE_PATH;
  const log = opts.log || ((m) => console.log(m));
  // Dependency-injected for tests so we don't have to spin up gh.
  const getProgress = opts.getProgress || getOrComputeBatchProgress;
  const isActiveFromProgress = opts.isActiveFromProgress || isBatchActiveFromProgress;
  const performWrites = opts.performWrites || _performReseedWrites;
  const captureAdmission = opts.captureAdmission || ((projectId) => projectAdmission(projectId));
  const admissionCurrent = opts.admissionCurrent || ((token) => isAdmissionCurrent(token));
  // #915: `periodic` = invoked from the recurring retry tick, not boot. A
  // still-deferred project is expected on every tick until its batch clears, so
  // suppress the BENIGN active-batch deferral log there (it would spam) —
  // reseeded/error events still log. Deferral semantics are unchanged: the
  // project stays pending and is retried on the next tick, no restart.
  const periodic = !!opts.periodic;
  const logActiveDeferral = periodic ? () => {} : log;
  // #922: the error/unknown deferral paths (batch-state check threw OR returned
  // null) are NOT a healthy active batch — they mean we couldn't confirm the
  // batch state, so the project stays on old seeds. On the periodic tick these
  // were also fully suppressed, so a persistently-erroring project was stranded
  // with zero signal between restarts (the silent-stranding class #915 fought).
  // Keep them visible but THROTTLED per project: log the first occurrence, then
  // once per PERIODIC_DEFER_LOG_EVERY ticks. On boot (non-periodic) everything
  // logs every time, exactly as before.
  const logStuckDeferral = (projectId, message) => {
    if (!periodic) { log(message); return; }
    const streak = (_periodicDeferStreak.get(projectId) || 0) + 1;
    _periodicDeferStreak.set(projectId, streak);
    if (streak === 1 || streak % PERIODIC_DEFER_LOG_EVERY === 0) {
      log(`${message} [still deferred after ${streak} periodic check(s) — check the project's batch/GitHub state]`);
    }
  };
  // A project that is no longer error-deferred (current, reseeded, or a benign
  // active batch) clears its streak, so a fresh stuck episode logs immediately
  // rather than waiting out a stale counter.
  const clearStuckStreak = (projectId) => { _periodicDeferStreak.delete(projectId); };

  const state = _loadReseedState(statePath);
  const decisions = [];
  const projects = (cfg?.projects || []).filter((p) => p && p.id && p.working_dir);

  for (const project of projects) {
    if (state.completedByProjectVersion[project.id] === version) {
      clearStuckStreak(project.id);
      decisions.push({ projectId: project.id, action: "skip", reason: "already current" });
      continue;
    }

    let admission = null;
    try { admission = captureAdmission(project.id); } catch {}
    if (!admission) {
      clearStuckStreak(project.id);
      decisions.push({ projectId: project.id, action: "skip", reason: "project archived" });
      continue;
    }

    // Fail-closed batch gate, same contract as the manual /reseed-agents
    // route (#853): a throw OR a null result both mean "we cannot prove the
    // batch is idle, so we MUST defer rather than risk mid-batch instruction
    // drift". The deferred state stays pending so the next startup retries.
    let active;
    try {
      const progress = await getProgress(project.id);
      active = isActiveFromProgress(progress);
    } catch (err) {
      decisions.push({ projectId: project.id, action: "deferred", reason: `batch-state check threw: ${err.message}` });
      logStuckDeferral(project.id, `[reseed] ${project.id}: deferred — batch state unknown (${err.message}); will retry automatically once the batch clears (no restart required)`);
      continue;
    }
    if (active === null) {
      decisions.push({ projectId: project.id, action: "deferred", reason: "batch state unknown" });
      logStuckDeferral(project.id, `[reseed] ${project.id}: deferred — batch state unknown; will retry automatically once the batch clears (no restart required)`);
      continue;
    }
    if (active === true) {
      clearStuckStreak(project.id);
      decisions.push({ projectId: project.id, action: "deferred", reason: "batch active" });
      logActiveDeferral(`[reseed] ${project.id}: deferred — batch active; will retry automatically once the batch clears (no restart required)`);
      continue;
    }
    // active === false: batch state is definitively known/idle — no longer
    // error-deferred, so clear any stuck-streak before attempting the reseed.
    clearStuckStreak(project.id);

    if (!admissionCurrent(admission)) {
      decisions.push({ projectId: project.id, action: "skip", reason: "project archived" });
      continue;
    }

    let result;
    try {
      result = performWrites(project, cfg, {});
    } catch (err) {
      decisions.push({ projectId: project.id, action: "error", error: err.message });
      log(`[reseed] ${project.id}: ERROR — ${err.message}; state NOT advanced, will retry automatically (next tick or restart)`);
      continue;
    }

    state.completedByProjectVersion[project.id] = version;
    try {
      _saveReseedState(state, statePath);
    } catch (err) {
      // If we can't persist, the project will re-seed again next boot.
      // Idempotent (file rewrite + #845 merger) so this is annoying-but-safe.
      log(`[reseed] ${project.id}: WARN — could not persist reseed-state (${err.message}); will re-seed next startup`);
    }
    decisions.push({
      projectId: project.id, action: "reseeded",
      reseeded: result.reseeded, skipped: result.skipped, preserved: result.preserved,
    });
    log(`[reseed] ${project.id}: reseeded for v${version} — wrote ${result.reseeded.length} file(s)` +
        (result.skipped.length ? `, skipped ${result.skipped.length}` : ""));
  }

  return { version, decisions };
}

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

function cacheBridgeBotUsername(projectId, bridgeKey, expectedToken, username, admission) {
  if (!isAdmissionCurrent(admission)) return false;
  let committed = false;
  try {
    updateConfig((fresh) => {
      const current = fresh.projects?.find((entry) => entry.id === projectId);
      const bridge = current?.[bridgeKey];
      if (!current || current.archived || !bridge || bridge.bot_token !== expectedToken ||
          !isAdmissionCurrent(admission)) return;
      bridge.bot_username = username;
      committed = true;
    });
  } catch {}
  return committed;
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
  const admission = projectAdmission(projectId);
  if (!admission) {
    return res.json({ running: false, configured: false, chat_id: "", bot_username: "", bridge_installed: true, last_error: "", archived: true });
  }
  // #211: expose whether credentials are configured + the chat_id
  // and the bot's @username (fetched from Telegram's getMe, cached
  // on the project entry). Never returns the raw bot token.
  let configured = false;
  let chatId = "";
  let botUsername = "";
  let bridgeInstalled = false;
  let project = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    project = cfg.projects?.find((p) => p.id === projectId) || null;
    if (project?.telegram?.bot_token && project?.telegram?.chat_id) {
      configured = true;
      chatId = project.telegram.chat_id;
      botUsername = project.telegram.bot_username || "";
    }
    bridgeInstalled = true;
  } catch {}
  if (configured && !botUsername && project?.telegram?.bot_token) {
    try {
      const expectedToken = project.telegram.bot_token;
      const resolved = resolveToken(expectedToken);
      if (resolved) {
        const r = await fetch(`https://api.telegram.org/bot${resolved}/getMe`);
        const data = await r.json();
        if (data && data.ok && data.result && typeof data.result.username === "string" &&
            cacheBridgeBotUsername(projectId, "telegram", expectedToken, data.result.username, admission)) {
          botUsername = data.result.username;
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

  if (body.project_id && action !== "stop" &&
      !(action === "start" && Object.prototype.hasOwnProperty.call(body, "admission_generation"))) {
    try { assertProjectAdmitted(body.project_id); }
    catch (err) { return sendProjectLifecycleException(res, err, body.project_id); }
  }

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
      const requestedAdmission = requestedBridgeAdmission(body, projectId, res);
      if (requestedAdmission === null) return;
      const admission = requestedAdmission || projectAdmission(projectId);
      if (!admission) return res.status(409).json({ ok: false, error: "project is archived", code: "project_archived", project_id: projectId });
      if (telegramBridge.isRunning(projectId)) return res.json({ ok: true, running: true, message: "Already running" });
      const tg = getProjectTelegram(projectId);
      if (!tg || !tg.bot_token || !tg.chat_id) return res.json({ ok: false, error: "Save bot_token and chat_id in project settings first." });
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const qwPort = cfg.port || 8400;
        await telegramBridge.start(projectId, tg.bot_token, tg.chat_id, qwPort);
        if (!isAdmissionCurrent(admission)) {
          const stopped = await telegramBridge.stop(projectId);
          if (stopped?.ok !== true) {
            const payload = safeProjectLifecyclePayload({ ...stopped, ok: false }, projectId);
            return res.status(503).json({ ...payload, code: "bridge_cleanup_incomplete", running: telegramBridge.isRunning(projectId) });
          }
          return res.status(409).json({ ok: false, error: "project is archived", code: "project_archived", project_id: projectId, cleanup_errors: stopped?.cleanup_errors || [] });
        }
        emitSystemMessage(projectId, "Telegram bridge connected");
        return res.json({ ok: true, running: true });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Start failed" });
      }
    }
    case "stop": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      const requestedAdmission = requestedBridgeAdmission(body, projectId, res);
      if (requestedAdmission === null) return;
      try {
        const stopped = await telegramBridge.stop(projectId);
        if (stopped?.ok !== true) {
          const payload = safeProjectLifecyclePayload({ ...stopped, ok: false }, projectId);
          return res.status(503).json({ ...payload, code: "bridge_cleanup_incomplete", running: telegramBridge.isRunning(projectId) });
        }
        if (!isProjectArchived(projectId)) emitSystemMessage(projectId, "Telegram bridge disconnected");
        return res.json({ ...stopped, ok: true, running: false });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Stop failed" });
      }
    }
    case "status": {
      const projectId = body.project_id || "";
      if (projectId && isProjectArchived(projectId)) return res.json({ running: false, archived: true });
      return res.json({ running: telegramBridge.isRunning(projectId) });
    }
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
  const admission = projectAdmission(projectId);
  if (!admission) {
    return res.json({ running: false, configured: false, channel_id: "", bot_username: "", bridge_installed: true, last_error: "", archived: true });
  }
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
          if (r.ok && data.username &&
              cacheBridgeBotUsername(projectId, "discord", project.discord.bot_token, data.username, admission)) {
            botUsername = data.username;
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

  if (body.project_id && action !== "stop" &&
      !(action === "start" && Object.prototype.hasOwnProperty.call(body, "admission_generation"))) {
    try { assertProjectAdmitted(body.project_id); }
    catch (err) { return sendProjectLifecycleException(res, err, body.project_id); }
  }

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
      const requestedAdmission = requestedBridgeAdmission(body, projectId, res);
      if (requestedAdmission === null) return;
      const admission = requestedAdmission || projectAdmission(projectId);
      if (!admission) return res.status(409).json({ ok: false, error: "project is archived", code: "project_archived", project_id: projectId });
      if (discordBridge.isRunning(projectId)) return res.json({ ok: true, running: true, message: "Already running" });
      const dc = getProjectDiscord(projectId);
      if (!dc || !dc.bot_token || !dc.channel_id) return res.json({ ok: false, error: "Save bot_token and channel_id in project settings first." });
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const qwPort = cfg.port || 8400;
        await discordBridge.start(projectId, dc.bot_token, dc.channel_id, qwPort);
        if (!isAdmissionCurrent(admission)) {
          const stopped = await discordBridge.stop(projectId);
          return res.status(409).json({ ok: false, error: "project is archived", code: "project_archived", project_id: projectId, cleanup_errors: stopped?.cleanup_errors || [] });
        }
        emitSystemMessage(projectId, "Discord bridge connected");
        return res.json({ ok: true, running: true });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Start failed" });
      }
    }
    case "stop": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      const requestedAdmission = requestedBridgeAdmission(body, projectId, res);
      if (requestedAdmission === null) return;
      try {
        const stopped = await discordBridge.stop(projectId);
        if (stopped?.ok !== true) {
          const payload = safeProjectLifecyclePayload({ ...stopped, ok: false }, projectId);
          return res.status(503).json({ ...payload, code: "bridge_cleanup_incomplete", running: discordBridge.isRunning(projectId) });
        }
        if (!isProjectArchived(projectId)) emitSystemMessage(projectId, "Discord bridge disconnected");
        return res.json({ ...stopped, ok: true, running: false });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Stop failed" });
      }
    }
    case "status": {
      const projectId = body.project_id || "";
      if (projectId && isProjectArchived(projectId)) return res.json({ running: false, archived: true });
      return res.json({ running: discordBridge.isRunning(projectId) });
    }
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
// #899: expose the live-vs-snapshot resolver + its source picker so the
// in-place review-state progression path is unit-testable with injected
// snapshot I/O (no writes to the real ~/.quadwork). No production callers
// outside this file.
module.exports.resolveDisplayedBatch = resolveDisplayedBatch;
module.exports.pickDisplayedSource = pickDisplayedSource;
// #870: expose review-batch parsers/helpers for the reviewBatch fixture test.
module.exports.parseBatchType = parseBatchType;
module.exports.parseReviewItems = parseReviewItems;
module.exports.parseDoneBatchReviewItems = parseDoneBatchReviewItems;
module.exports.parseReviewState = parseReviewState;
module.exports.reviewItemView = reviewItemView;
module.exports.summarizeReviewItems = summarizeReviewItems;
// #350: same pattern — expose the no-linked-PR row builder and
// summarizeItems for the batch-progress fixture test.
module.exports.buildNoPrRow = buildNoPrRow;
module.exports.summarizeItems = summarizeItems;
// #810: expose batch-progress-from-snapshot helpers for unit tests.
module.exports.progressFromSnapshot = progressFromSnapshot;
module.exports.countApprovedRoles = countApprovedRoles;
// #943: expose the persisted-GITHUB.md fallback helpers for unit tests.
module.exports.progressFromGithubFile = progressFromGithubFile;
module.exports.approvalsFromReviewDetail = approvalsFromReviewDetail;
module.exports.softRetryingRow = softRetryingRow;
module.exports.loadGithubParsed = loadGithubParsed;
module.exports.evalBatchCompleteConfirmed = evalBatchCompleteConfirmed;
// #693: expose normalizeMentions for unit tests
module.exports.normalizeMentions = normalizeMentions;
// #714: expose for file-chat integration
module.exports.getProjectChatMode = getProjectChatMode;
// #730: PTY dispatch callback setter
module.exports.setPtyDispatchCallback = setPtyDispatchCallback;
// #802: expose the GraphQL rate-limit bucket + predicates for unit tests.
// No production callers outside this file.
module.exports._graphqlRateLimit = _graphqlRateLimit;
module.exports.isGraphqlRateLimited = isGraphqlRateLimited;
module.exports.isGraphqlRateLow = isGraphqlRateLow;
// #806: expose the canonical-shape transforms for unit tests + the fetcher
// entry point (#807's file writer consumes the assembled snapshot).
module.exports.githubStateFetcher = githubStateFetcher;
module.exports._coalesce = _coalesce;
// #837: expose ghApiConditional + the shared list-fetch maxBuffer constant for
// the >1MB closed-PR page regression test.
module.exports.ghApiConditional = ghApiConditional;
module.exports.GH_LIST_MAX_BUFFER = GH_LIST_MAX_BUFFER;
// #839: expose the completion-aware sidebar-heartbeat helper for unit tests.
module.exports.isBatchActiveFromProgress = isBatchActiveFromProgress;
// #845: expose the AGENTS.md re-seed merger so the placeholder substitution +
// custom-section preservation contract is exercisable without spinning up a
// real worktree. Pure function; no production callers outside this file.
module.exports.reseedAgentsMd = reseedAgentsMd;
// #966: expose the QuadWork-seeded CLAUDE.md predicate for unit tests.
module.exports._isSeededClaudeMd = _isSeededClaudeMd;
// #855: expose the per-agent target resolver + legacy-key map so the legacy
// config (`reviewer1` / `reviewer2` / `t1..t3`) → canonical-template mapping
// is exercisable without spinning up a real worktree. Pure helpers; no
// production callers outside this file.
module.exports._resolveReseedTargets = _resolveReseedTargets;
module.exports._canonicalAgentSlug = _canonicalAgentSlug;
// #854: expose the GH_TOKEN path extractor so the parse forms (`export`,
// double-quoted, inner-quoted, etc.) are exercisable without a temp fs.
module.exports._extractReviewerTokenPath = _extractReviewerTokenPath;
// #886/#893: expose the project-aware reviewer rate-limit resolver/poll/payload
// for tests.
module.exports._resolveReviewerTokenPath = _resolveReviewerTokenPath;
// #970: expose the reviewer-token-path containment predicate for the guard test.
module.exports._reviewerTokenPathAllowed = _reviewerTokenPathAllowed;
module.exports.getReviewerRateLimit = getReviewerRateLimit;
module.exports.reviewerRateLimitPayload = reviewerRateLimitPayload;
// #856: expose the auto-reseed startup hook + supporting state/version
// helpers. server/index.js calls `autoReseedOnStartup` after config is
// loaded; the helpers are exposed for unit tests + the integration test
// (state corruption, version round-trip, per-project decision matrix).
module.exports.autoReseedOnStartup = autoReseedOnStartup;
module.exports._loadReseedState = _loadReseedState;
module.exports._periodicDeferStreak = _periodicDeferStreak;
module.exports.PERIODIC_DEFER_LOG_EVERY = PERIODIC_DEFER_LOG_EVERY;
module.exports._saveReseedState = _saveReseedState;
module.exports._readPackageVersion = _readPackageVersion;
module.exports._performReseedWrites = _performReseedWrites;
module.exports.RESEED_STATE_PATH = RESEED_STATE_PATH;
// #839 (re1 follow-up): expose the shared compute path plus the caches it
// reads so the cache-miss completed-batch case is exercisable end-to-end.
module.exports.getOrComputeBatchProgress = getOrComputeBatchProgress;
module.exports._batchProgressCache = _batchProgressCache;
module.exports._batchProgressRefreshes = _batchProgressRefreshes;
module.exports._graphqlCache = _graphqlCache;
module.exports.restIssueToCanonical = restIssueToCanonical;
module.exports.restClosedIssueToCanonical = restClosedIssueToCanonical;
module.exports.restMergedPrToCanonical = restMergedPrToCanonical;
module.exports.restPullBaseToCanonical = restPullBaseToCanonical;
module.exports.mapReviews = mapReviews;
module.exports.deriveReviewDecision = deriveReviewDecision;
module.exports.buildStatusCheckRollup = buildStatusCheckRollup;
// #807: expose the GITHUB.md parser/renderer + role attribution for unit tests.
// No production callers outside this file.
module.exports.parseGithub = parseGithub;
module.exports.renderGithubMarkdown = renderGithubMarkdown;
module.exports.attributeReviewsByRole = attributeReviewsByRole;
module.exports._githubLiveStale = _githubLiveStale;
module.exports._extractNotesBody = _extractNotesBody;
module.exports.GITHUB_FRESH_TTL_MS = GITHUB_FRESH_TTL_MS;
// #824: expose the bare-array list handler + its cache and the REST rate-limit
// bucket so the regression test can drive the stale/rate-limited paths and
// assert the body stays a JSON array (never an object). No production callers
// outside this file.
module.exports.serveGithubList = serveGithubList;
module.exports._ghEndpointCache = _ghEndpointCache;
module.exports._rateLimit = _rateLimit;
// #828: expose the merged-PR pagination helpers + the REST-search linked-PR
// picker for unit tests. No production callers outside this file.
module.exports.gatherClosedPrPages = gatherClosedPrPages;
module.exports.selectRecentMergedPrs = selectRecentMergedPrs;
// #834: closed-PR window completeness + linked-issue extraction, for the
// queued-from-snapshot fix. No production callers outside this file.
module.exports.closedPagesComplete = closedPagesComplete;
module.exports.closedPrIssueNumsFromPages = closedPrIssueNumsFromPages;
module.exports.pickLinkedPrFromSearch = pickLinkedPrFromSearch;
module.exports.findLinkedPrByTitle = findLinkedPrByTitle;
module.exports.pickClosingPrFromTimeline = pickClosingPrFromTimeline;
module.exports.progressForItemRest = progressForItemRest;
module.exports.ensureGitHeadForSetup = ensureGitHeadForSetup;
module.exports.createAgentWorktree = createAgentWorktree;
module.exports.repoSlugFromRemote = repoSlugFromRemote;
// #827: expose the GITHUB.md writer for the idle-no-op regression test. No
// production callers outside this file.
module.exports.writeGithubFileFromSnapshot = writeGithubFileFromSnapshot;
// #1034: lifecycle cleanup contract consumed by project-lifecycle wiring, plus
// narrow observability hooks for the admission/ownership regression fixture.
module.exports.cancelProjectBackground = cancelProjectBackground;
module.exports.refreshRepoRest = refreshRepoRest;
module.exports._restRefreshing = _restRefreshing;
module.exports._githubDemandedProjects = _githubDemandedProjects;
module.exports.shouldPublishProjectsCache = shouldPublishProjectsCache;
