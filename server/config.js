const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

const DEFAULT_CONFIG = {
  port: 8400,
  operator_name: "user",
  projects: [],
};

// Reserved sender names that the operator must NOT be able to claim.
const RESERVED_OPERATOR_NAMES = new Set([
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

// Sanitize operator display name: 1–32 alnum + dash + underscore,
// reject reserved agent identities.
function sanitizeOperatorName(value) {
  if (typeof value !== "string") return "user";
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleaned) return "user";
  const truncated = cleaned.slice(0, 32);
  if (RESERVED_OPERATOR_NAMES.has(truncated.toLowerCase())) return "user";
  return truncated;
}

// Migration: rename old agent keys to new ones.
// Keep this map — it migrates pre-v1.8 configs on startup so existing
// installs transition to the canonical head/dev/re1/re2 slugs.
const AGENT_KEY_MAP = { t1: "head", t2a: "re1", t2b: "re2", t3: "dev", reviewer1: "re1", reviewer2: "re2" };

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
      writeSecureFile(CONFIG_PATH, JSON.stringify(config, null, 2));
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
        ensureSecureDir(dir);
      }
      writeSecureFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
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

// --- #540: Secure file/directory helpers ---
// All paths under ~/.quadwork/ may contain secrets (tokens, configs,
// chat exports). Use these helpers instead of raw fs calls to ensure
// restrictive permissions on multi-user systems.

/** Create a directory with 0o700 (owner-only). Hardens existing dirs too. */
function ensureSecureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync mode only applies on creation — chmod existing dirs.
  try { fs.chmodSync(dir, 0o700); } catch {}
}

/** Write a file with 0o600 (owner-only read/write). Hardens existing files too. */
function writeSecureFile(filePath, data, extraOpts = {}) {
  fs.writeFileSync(filePath, data, { mode: 0o600, ...extraOpts });
  // writeFileSync mode only applies on creation — chmod existing files.
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

/** Write config.json atomically with 0o600 permissions. */
function writeConfig(cfg) {
  writeSecureFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

module.exports = { readConfig, resolveAgentCwd, resolveAgentCommand, resolveProjectChattr, sanitizeOperatorName, CONFIG_PATH, ensureSecureDir, writeSecureFile, writeConfig };
