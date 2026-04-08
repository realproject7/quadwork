const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

const DEFAULT_CONFIG = {
  port: 8400,
  agentchattr_url: "http://127.0.0.1:8300",
  agentchattr_dir: path.join(os.homedir(), ".quadwork", "agentchattr"),
  // #405 / quadwork#278: display name used as the chat sender for
  // messages posted from the dashboard. AC's registry name validator
  // accepts 1–32 alphanumeric + dash + underscore characters; mirror
  // that here so the sanitized value matches what AC will accept.
  operator_name: "user",
  projects: [],
};

// Reserved sender names that the operator must NOT be able to claim
// — these are the registered agent identities (current + legacy
// aliases) plus AC's own "system" sender. Without this denylist a
// hand-edited or PUT /api/config'd `operator_name = "head"` would
// post chat messages with sender:"head", reopening the impersonation
// vector #230 closed. Case-insensitive match.
const RESERVED_OPERATOR_NAMES = new Set([
  "head",
  "dev",
  "reviewer1",
  "reviewer2",
  // Legacy agent aliases — preserved in routing logic in a few
  // places, so block them too even though new projects no longer
  // register under these names.
  "t1",
  "t2a",
  "t2b",
  "t3",
  // AC's own broadcast / housekeeping sender.
  "system",
]);

// Sanitize an operator-supplied display name to match AC's name
// validator (registry.py: 1–32 alnum + dash + underscore) AND to
// reject any reserved agent identity. Empty / non-string / reserved
// input falls back to "user". Used both when reading the config (in
// case the file was hand-edited) and on /api/chat sends (so even a
// stale on-disk value can't impersonate an agent).
function sanitizeOperatorName(value) {
  if (typeof value !== "string") return "user";
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleaned) return "user";
  const truncated = cleaned.slice(0, 32);
  if (RESERVED_OPERATOR_NAMES.has(truncated.toLowerCase())) return "user";
  return truncated;
}

// Migration: rename old agent keys to new ones
const AGENT_KEY_MAP = { t1: "head", t2a: "reviewer1", t2b: "reviewer2", t3: "dev" };

function migrateAgentKeys(config) {
  let changed = false;
  if (config.projects) {
    for (const project of config.projects) {
      if (!project.agents) continue;
      for (const [oldKey, newKey] of Object.entries(AGENT_KEY_MAP)) {
        if (project.agents[oldKey] && !project.agents[newKey]) {
          project.agents[newKey] = project.agents[oldKey];
          delete project.agents[oldKey];
          changed = true;
        }
      }
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch {}
  }
  return config;
}

function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      // Config file doesn't exist — create default
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return { ...DEFAULT_CONFIG };
    }
    throw new Error(`Cannot read config at ${CONFIG_PATH}: ${err.message}`);
  }

  try {
    const config = JSON.parse(raw);
    return migrateAgentKeys(config);
  } catch (err) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${err.message}`);
  }
}

/**
 * Resolve the configured cwd for a project/agent pair.
 * Returns null if not found.
 */
function resolveAgentCwd(projectId, agentId) {
  const config = readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const agent = project.agents && project.agents[agentId];
  if (!agent || !agent.cwd) return null;
  return agent.cwd;
}

/**
 * Resolve the configured command for a project/agent pair.
 * Returns null if not found (caller should fall back to default shell).
 */
function resolveAgentCommand(projectId, agentId) {
  const config = readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const agent = project.agents && project.agents[agentId];
  if (!agent || !agent.command) return null;
  return agent.command;
}

/**
 * Resolve AgentChattr connection for a project (per-project → global fallback).
 */
function resolveProjectChattr(projectId) {
  const config = readConfig();
  const project = projectId ? config.projects?.find((p) => p.id === projectId) : null;

  // Resolution order for AgentChattr install dir:
  //   1. project.agentchattr_dir   — per-project clone (Option B, #181)
  //   2. config.agentchattr_dir    — legacy global clone (v1 backward compat)
  //   3. ~/.quadwork/{projectId}/agentchattr — per-project default
  //
  // Phase 1A (#182) is schema-only: project.agentchattr_dir is now written
  // on every new project, but the actual clone-on-create logic does not
  // land until #183/#184/#185. Until then, if the project field points at
  // a directory that does not yet contain a working install, fall back to
  // the legacy global so existing setups (and brand-new projects on a v1
  // host) keep starting AgentChattr from the working clone.
  const perProjectDefault = projectId
    ? path.join(os.homedir(), ".quadwork", projectId, "agentchattr")
    : path.join(os.homedir(), ".quadwork", "agentchattr");
  const legacyGlobal = config.agentchattr_dir || path.join(os.homedir(), ".quadwork", "agentchattr");
  let dir = project?.agentchattr_dir || legacyGlobal || perProjectDefault;
  if (!fs.existsSync(path.join(dir, "run.py")) && fs.existsSync(path.join(legacyGlobal, "run.py"))) {
    dir = legacyGlobal;
  }

  return {
    url: project?.agentchattr_url || config.agentchattr_url || "http://127.0.0.1:8300",
    token: project?.agentchattr_token || config.agentchattr_token || null,
    mcp_http_port: project?.mcp_http_port || null,
    mcp_sse_port: project?.mcp_sse_port || null,
    dir,
  };
}

/**
 * Resolve the command + args to spawn AgentChattr from its cloned directory.
 * Returns { command, args, cwd } or null if not fully set up.
 * Requires .venv/bin/python — never falls back to bare python3.
 */
function resolveChattrSpawn(agentchattrDir) {
  const dir = agentchattrDir || path.join(os.homedir(), ".quadwork", "agentchattr");
  const runPy = path.join(dir, "run.py");
  const venvPython = path.join(dir, ".venv", "bin", "python");
  if (!fs.existsSync(runPy) || !fs.existsSync(venvPython)) return null;
  return { command: venvPython, args: ["run.py"], cwd: dir };
}

/**
 * Fetch AgentChattr's real session token from its HTML and save to project config.
 * AgentChattr generates its own token at startup; this syncs it back.
 */
async function syncChattrToken(projectId) {
  const config = readConfig();
  const project = config.projects?.find((p) => p.id === projectId);
  if (!project) return;
  const url = project.agentchattr_url || config.agentchattr_url || "http://127.0.0.1:8300";
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const html = await res.text();
    const match = html.match(/__SESSION_TOKEN__="([^"]+)"/);
    if (match && match[1]) {
      const realToken = match[1];
      if (project.agentchattr_token !== realToken) {
        project.agentchattr_token = realToken;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      }
    }
  } catch {}
}

module.exports = { readConfig, resolveAgentCwd, resolveAgentCommand, resolveProjectChattr, resolveChattrSpawn, syncChattrToken, sanitizeOperatorName, CONFIG_PATH };
