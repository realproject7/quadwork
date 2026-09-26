"use strict";

// #1186: the one CLI resolver, in a module with no side effects when required,
// so the setup wizard (bin/quadwork.js, a separate process) and routes.js
// (which index.js requires) load the same resolver index.js uses, without
// loading index.js.

const fs = require("fs");
const os = require("os");
const path = require("path");

// #1176: the executable a CLI command runs. One answer for the install check
// (/api/cli-status), the spawn path (launchAgentPty) and model discovery
// (/api/agent-model-catalog), so a CLI reported as installed is one an agent
// can start and discovery can list. A command containing "/" names its
// executable (only an absolute path resolves). A bare name is looked up on the
// calling process's PATH, then in install locations a non-login PATH can
// lack: #586 ~/.local/bin and ~/.npm-global/bin (installers add them in
// ~/.bashrc, which a Node server never sources), #1023 ~/.grok/bin (grok's
// `curl | bash` installer). Returns an absolute path, or null when no
// executable is found.
function resolveCliExecutable(command) {
  if (typeof command !== "string" || command === "") return null;
  const isExecutable = (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes("/")) return path.isAbsolute(command) && isExecutable(command) ? command : null;
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".grok", "bin"),
    "/usr/local/bin",
  ];
  // A relative PATH entry is skipped: spawn would resolve it against the
  // agent's cwd, not the server's. The candidate is concatenated like the OS
  // lookup builds it: path.join would fold a `..` without following a
  // symlinked directory.
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue;
    const file = dir + path.sep + command;
    if (isExecutable(file)) return file;
  }
  return null;
}

module.exports = { resolveCliExecutable };
