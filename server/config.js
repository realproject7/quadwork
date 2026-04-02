const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

const DEFAULT_CONFIG = {
  port: 8400,
  agentchattr_url: "http://127.0.0.1:8300",
  projects: [],
};

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
  return {
    url: project?.agentchattr_url || config.agentchattr_url || "http://127.0.0.1:8300",
    token: project?.agentchattr_token || config.agentchattr_token || null,
    mcp_http_port: project?.mcp_http_port || null,
    mcp_sse_port: project?.mcp_sse_port || null,
  };
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

module.exports = { readConfig, resolveAgentCwd, resolveAgentCommand, resolveProjectChattr, syncChattrToken, CONFIG_PATH };
