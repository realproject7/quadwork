// Retained for `npx quadwork cleanup --legacy` — locates AC directories on disk.

const fs = require("fs");
const path = require("path");

/**
 * Check if AgentChattr is installed (cloned + venv ready) at `dir`.
 * Returns the directory path if both run.py and .venv/bin/python exist, or null.
 */
function findAgentChattr(dir) {
  if (!dir) return null;
  if (fs.existsSync(path.join(dir, "run.py")) && fs.existsSync(path.join(dir, ".venv", "bin", "python"))) return dir;
  return null;
}

module.exports = { findAgentChattr };
