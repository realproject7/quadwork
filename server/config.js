const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

const DEFAULT_CONFIG = {
  port: 8400,
  agentchattr_url: "http://127.0.0.1:8300",
  projects: [],
};

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
    return JSON.parse(raw);
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

module.exports = { readConfig, resolveAgentCwd, resolveAgentCommand, CONFIG_PATH };
