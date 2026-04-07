#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

// ─── Constants ──────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const AGENTS = ["head", "reviewer1", "reviewer2", "dev"];
const DEFAULT_AGENTCHATTR_DIR = path.join(CONFIG_DIR, "agentchattr");
const AGENTCHATTR_REPO = "https://github.com/bcurts/agentchattr.git";

// ─── ANSI Helpers ──────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const c = isTTY ? {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
} : { reset: "", bold: "", dim: "", green: "", yellow: "", red: "", cyan: "", white: "" };

function log(msg) { console.log(`  ${c.dim}${msg}${c.reset}`); }
function ok(msg) { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function warn(msg) { console.log(`  ${c.yellow}⚠ ${msg}${c.reset}`); }
function fail(msg) { console.error(`  ${c.red}✗ ${msg}${c.reset}`); }
function header(msg) { console.log(`\n  ${c.cyan}${c.bold}┌─ ${msg} ${"─".repeat(Math.max(0, 54 - msg.length))}┐${c.reset}\n`); }

function spinner(msg) {
  if (!isTTY) {
    console.log(`  ${msg}`);
    return { stop(result) { console.log(`  ${result ? "✓" : "✗"} ${msg}`); } };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan}${frames[i++ % frames.length]}${c.reset} ${msg}`);
  }, 80);
  return {
    stop(result) {
      clearInterval(id);
      process.stdout.write(`\r  ${result ? `${c.green}✓${c.reset} ${msg}` : `${c.red}✗${c.reset} ${msg}`}${" ".repeat(10)}\n`);
    },
  };
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
  } catch {
    return null;
  }
}

function which(cmd) {
  return run(`which ${cmd}`) !== null;
}

/**
 * Resolve the agentchattr_dir from config, falling back to DEFAULT_AGENTCHATTR_DIR.
 */
function getAgentChattrDir() {
  const config = readConfig();
  return config.agentchattr_dir || DEFAULT_AGENTCHATTR_DIR;
}

/**
 * Check if AgentChattr is fully installed (cloned + venv ready).
 * Returns the directory path if both run.py and .venv/bin/python exist, or null.
 */
function findAgentChattr(dir) {
  dir = dir || getAgentChattrDir();
  if (fs.existsSync(path.join(dir, "run.py")) && fs.existsSync(path.join(dir, ".venv", "bin", "python"))) return dir;
  return null;
}

/**
 * Clone AgentChattr and set up its venv. Idempotent — safe to re-run on
 * the same path, and safe to call repeatedly with different paths in
 * the same process. Designed to support per-project clones (#181).
 *
 * Behavior on re-run:
 *   - Fully-installed path → no-op (skips clone, skips venv create, skips pip)
 *   - Missing run.py        → clones (only after refusing to overwrite
 *                             unrelated content; see safety rules below)
 *   - Missing venv          → creates venv and reinstalls requirements
 *
 * Safety rules — never accidentally clean up unrelated directories:
 *   - Empty dir                                  → safe to remove
 *   - Git repo whose origin contains "agentchattr" → safe to remove
 *   - Anything else                              → refuse, return null
 *
 * On failure, returns null and stores a human-readable reason on
 * `installAgentChattr.lastError` so callers can surface it without
 * changing the return shape.
 */
// Stale-lock thresholds for installAgentChattr().
// Lock files older than this OR whose owning pid is no longer alive are
// treated as crashed and reclaimed. Tuned to comfortably exceed the longest
// step (pip install of agentchattr requirements, ~120s timeout).
const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000; // 10 min
const INSTALL_LOCK_WAIT_TOTAL_MS = 30 * 1000;  // wait up to 30s for a peer
const INSTALL_LOCK_POLL_MS = 500;

function _isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function _readLock(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, "utf-8").trim();
    const [pidStr, tsStr] = raw.split(":");
    return { pid: parseInt(pidStr, 10), ts: parseInt(tsStr, 10) || 0 };
  } catch { return null; }
}

function _isLockStale(lockFile) {
  const info = _readLock(lockFile);
  if (!info) return true; // unreadable → assume stale
  if (Date.now() - info.ts > INSTALL_LOCK_STALE_MS) return true;
  if (!_isPidAlive(info.pid)) return true;
  return false;
}

function installAgentChattr(dir) {
  dir = dir || getAgentChattrDir();
  installAgentChattr.lastError = null;
  const setError = (msg) => { installAgentChattr.lastError = msg; return null; };

  // --- Per-target lock to prevent concurrent clones from corrupting each
  // other when two projects (or two web tabs) launch simultaneously. Lock
  // file lives next to the install dir so it's scoped per-target.
  const lockFile = `${dir}.install.lock`;
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); }
  catch (e) { return setError(`Cannot create parent of ${dir}: ${e.message}`); }

  let acquired = false;
  const deadline = Date.now() + INSTALL_LOCK_WAIT_TOTAL_MS;
  while (!acquired) {
    try {
      // Atomic create: fails if file already exists, no TOCTOU race.
      fs.writeFileSync(lockFile, `${process.pid}:${Date.now()}`, { flag: "wx" });
      acquired = true;
    } catch (e) {
      if (e.code !== "EEXIST") return setError(`Cannot create install lock ${lockFile}: ${e.message}`);
      // Reclaim if the existing lock is stale (crashed pid or too old).
      // Use rename → unlink instead of unlink directly: rename is atomic,
      // so only one racing process can move the stale lock aside. The
      // others see ENOENT and just retry the wx create. Without this,
      // two processes could both observe the same stale lock, both
      // unlink it (one of those unlinks would target the *next* lock
      // freshly acquired by a third process), and both proceed past the
      // gate concurrently — see review on quadwork#193.
      if (_isLockStale(lockFile)) {
        const sideline = `${lockFile}.stale.${process.pid}.${Date.now()}`;
        try {
          fs.renameSync(lockFile, sideline);
          try { fs.unlinkSync(sideline); } catch {}
        } catch (renameErr) {
          // ENOENT: another process already reclaimed it. Anything else:
          // treat as transient and retry — the next iteration will read
          // whatever is at lockFile now and decide again.
          if (renameErr.code !== "ENOENT") {
            return setError(`Cannot reclaim stale lock ${lockFile}: ${renameErr.message}`);
          }
        }
        continue;
      }
      // Live peer install in progress. After it finishes, the install
      // is likely already done — caller will see a fully-installed path
      // on the next call. While waiting, poll until the lock disappears
      // or we hit the wait deadline.
      if (Date.now() >= deadline) {
        const info = _readLock(lockFile) || { pid: "?", ts: 0 };
        return setError(`Another install is in progress at ${dir} (pid ${info.pid}); timed out after ${INSTALL_LOCK_WAIT_TOTAL_MS}ms. Re-run after it finishes, or remove ${lockFile} if stale.`);
      }
      // Synchronous sleep — installAgentChattr is itself synchronous and
      // is called from the CLI wizard, where blocking is acceptable.
      // Use execSync('sleep') instead of a busy-wait so we don't pin a CPU.
      try { require("child_process").execSync(`sleep ${INSTALL_LOCK_POLL_MS / 1000}`); }
      catch { /* sleep interrupted; loop will recheck */ }
    }
  }

  try {
    return _installAgentChattrLocked(dir, setError);
  } finally {
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

function _installAgentChattrLocked(dir, setError) {
  const runPy = path.join(dir, "run.py");
  const venvPython = path.join(dir, ".venv", "bin", "python");
  let venvJustCreated = false;

  // 1. Clone if run.py is missing.
  if (!fs.existsSync(runPy)) {
    if (fs.existsSync(dir)) {
      let entries;
      try { entries = fs.readdirSync(dir); }
      catch (e) { return setError(`Cannot read ${dir}: ${e.message}`); }
      const isEmpty = entries.length === 0;
      if (isEmpty) {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e) { return setError(`Cannot remove empty dir ${dir}: ${e.message}`); }
      } else if (fs.existsSync(path.join(dir, ".git"))) {
        // Only remove if origin remote positively identifies this as agentchattr.
        const remote = run(`git -C "${dir}" remote get-url origin 2>/dev/null`);
        if (remote && remote.includes("agentchattr")) {
          try { fs.rmSync(dir, { recursive: true, force: true }); }
          catch (e) { return setError(`Cannot remove failed clone at ${dir}: ${e.message}`); }
        } else {
          return setError(`Refusing to overwrite ${dir}: contains a non-AgentChattr git repo`);
        }
      } else {
        return setError(`Refusing to overwrite ${dir}: directory exists with unrelated content`);
      }
    }
    // Ensure parent exists before clone (supports arbitrary nested paths).
    try { fs.mkdirSync(path.dirname(dir), { recursive: true }); }
    catch (e) { return setError(`Cannot create parent of ${dir}: ${e.message}`); }
    const cloneResult = run(`git clone "${AGENTCHATTR_REPO}" "${dir}" 2>&1`, { timeout: 60000 });
    if (cloneResult === null) return setError(`git clone of ${AGENTCHATTR_REPO} into ${dir} failed`);
    if (!fs.existsSync(runPy)) return setError(`Clone completed but run.py missing at ${dir}`);
  }

  // 2. Create venv if missing.
  if (!fs.existsSync(venvPython)) {
    const venvResult = run(`python3 -m venv "${path.join(dir, ".venv")}" 2>&1`, { timeout: 60000 });
    if (venvResult === null) return setError(`python3 -m venv failed at ${dir}/.venv (is python3 installed?)`);
    if (!fs.existsSync(venvPython)) return setError(`venv created but ${venvPython} missing`);
    venvJustCreated = true;
  }

  // 3. Install requirements only when the venv was just (re)created.
  //    This makes re-running on a fully-installed path a true no-op.
  if (venvJustCreated) {
    const reqFile = path.join(dir, "requirements.txt");
    if (fs.existsSync(reqFile)) {
      const pipResult = run(`"${venvPython}" -m pip install -r "${reqFile}" 2>&1`, { timeout: 120000 });
      if (pipResult === null) return setError(`pip install -r ${reqFile} failed`);
    }
  }
  return dir;
}
installAgentChattr.lastError = null;

/**
 * Get spawn args for launching AgentChattr from its cloned directory.
 * Returns { command, spawnArgs, cwd } or null if not fully installed.
 * Requires .venv/bin/python — never falls back to bare python3.
 */
function chattrSpawnArgs(dir, extraArgs) {
  dir = dir || getAgentChattrDir();
  const venvPython = path.join(dir, ".venv", "bin", "python");
  if (!fs.existsSync(path.join(dir, "run.py")) || !fs.existsSync(venvPython)) return null;
  return { command: venvPython, spawnArgs: ["run.py", ...(extraArgs || [])], cwd: dir };
}

function ask(rl, question, defaultVal) {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` ${c.dim}[${defaultVal}]${c.reset}` : "";
    rl.question(`  ${c.bold}${question}${c.reset}${suffix}${c.cyan} > ${c.reset}`, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askSecret(rl, question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(`  ${c.bold}${question}${c.reset}${c.cyan} > ${c.reset}`);
    let secret = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (ch) => {
      // Iterate per character to handle pasted multi-char input
      const str = ch.toString("utf-8");
      for (const c of str) {
        if (c === "\n" || c === "\r") {
          stdin.setRawMode(wasRaw || false);
          stdin.removeListener("data", onData);
          stdout.write("\n");
          resolve(secret);
          return;
        } else if (c === "\u007F" || c === "\b") {
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (c === "\u0003") {
          process.exit(1);
        } else if (c >= " ") {
          secret += c;
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function maskValue(val) {
  if (!val || val.length < 8) return "****";
  return val.slice(0, 4) + "***" + val.slice(-3);
}

function askYN(rl, question, defaultYes = false) {
  return new Promise((resolve) => {
    const hint = defaultYes ? "Y/n" : "y/N";
    rl.question(`  ${c.bold}${question}${c.reset} ${c.dim}[${hint}]${c.reset}${c.cyan} > ${c.reset}`, (answer) => {
      const a = answer.trim().toLowerCase();
      resolve(a === "" ? defaultYes : a === "y" || a === "yes");
    });
  });
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
    try { writeConfig(config); } catch {}
  }
  return config;
}

function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return migrateAgentKeys(config);
  } catch {
    return { port: 8400, agentchattr_url: "http://127.0.0.1:8300", agentchattr_dir: DEFAULT_AGENTCHATTR_DIR, projects: [] };
  }
}

function writeConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Prerequisites ──────────────────────────────────────────────────────────

let agentChattrFound = false;

function detectPlatform() {
  const p = os.platform();
  if (p === "darwin") return "macos";
  if (p === "linux") {
    // Check for apt vs dnf vs yum
    if (which("apt")) return "linux-apt";
    if (which("dnf")) return "linux-dnf";
    if (which("yum")) return "linux-yum";
    return "linux";
  }
  return "other";
}

async function tryInstall(rl, name, description, commands, { platform } = {}) {
  const cmd = typeof commands === "function" ? commands(platform) : commands;
  if (!cmd) {
    warn(`${name} cannot be auto-installed on your system.`);
    return false;
  }
  console.log("");
  log(`${description}`);
  const doInstall = await askYN(rl, `Install ${name} now?`, true);
  if (!doInstall) {
    log("Skipped.");
    return false;
  }
  const sp = spinner(`Installing ${name}...`);
  const result = run(`${cmd} 2>&1`, { timeout: 120000 });
  if (result !== null) {
    sp.stop(true);
    return true;
  } else {
    sp.stop(false);
    warn(`Auto-install failed. You can install manually and try again.`);
    return false;
  }
}

async function checkPrereqs(rl) {
  header("Step 1: Prerequisites");
  const platform = detectPlatform();
  let allOk = true;
  let hasPython = false;

  // ── 1. Node.js 20+ (must already exist — user ran npx) ──
  const nodeVer = run("node --version");
  if (nodeVer) {
    const major = parseInt(nodeVer.replace("v", "").split(".")[0], 10);
    if (major >= 20) {
      ok(`Node.js ${nodeVer}`);
    } else {
      fail(`Node.js ${nodeVer} — version 20 or newer is required`);
      log("Update from: https://nodejs.org");
      allOk = false;
    }
  } else {
    fail("Node.js not found (this shouldn't happen since you ran npx)");
    allOk = false;
  }

  // ── 2. Homebrew (macOS only — needed for gh, AI CLIs) ──
  if (platform === "macos") {
    if (which("brew")) {
      ok("Homebrew");
    } else {
      console.log("");
      warn("Homebrew is required to install developer tools (GitHub CLI, AI coding tools).");
      log("It's the standard macOS package manager. Install it by pasting this into your terminal:");
      log("");
      log(`  → /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`);
      log("");
      log("After installing, close and reopen your terminal, then run:");
      log("  → npx quadwork init");
      console.log("");
      fail("Homebrew is required before we can set up the remaining tools.");
      log("Install Homebrew first, then re-run: npx quadwork init");
      return false;
    }
  }

  // ── 3. Python 3.10+ (manual install — guide only) ──
  const pyVer = run("python3 --version");
  if (pyVer) {
    const parts = pyVer.replace("Python ", "").split(".");
    const minor = parseInt(parts[1], 10);
    if (parseInt(parts[0], 10) >= 3 && minor >= 10) {
      ok(`${pyVer}`);
      hasPython = true;
    } else {
      console.log("");
      warn(`${pyVer} found, but version 3.10 or newer is required.`);
      log("Python powers the agent communication layer.");
      log("Download the latest version from:");
      log(`  → https://python.org/downloads`);
      log("");
      log("After installing, close and reopen your terminal, then run:");
      log("  → npx quadwork init");
      allOk = false;
    }
  } else {
    console.log("");
    warn("Python 3 is required but not installed on your system.");
    log("");
    log("Python powers the agent communication layer. Install it from:");
    log("  → https://python.org/downloads (download and run the installer)");
    log("");
    log("After installing, close and reopen your terminal, then run:");
    log("  → npx quadwork init");
    allOk = false;
  }

  if (!hasPython) {
    // Can't continue with AgentChattr without Python
    console.log("");
    fail("Python is required before we can set up the remaining tools.");
    log("Install Python first, then re-run: npx quadwork init");
    return false;
  }

  // ── 3. AgentChattr (clone + venv — needs Python and git) ──
  const acDir = findAgentChattr();
  if (acDir) {
    ok(`AgentChattr (${acDir})`);
    agentChattrFound = true;
  } else if (hasPython) {
    console.log("");
    warn("AgentChattr lets your AI agents communicate with each other.");
    log("It will be cloned and set up in a virtualenv.");
    const doInstall = await askYN(rl, "Install AgentChattr now?", true);
    if (doInstall) {
      const acSpinner = spinner("Cloning and setting up AgentChattr...");
      const result = installAgentChattr();
      acSpinner.stop(result !== null);
      if (result) {
        ok(`AgentChattr installed (${DEFAULT_AGENTCHATTR_DIR})`);
        agentChattrFound = true;
      } else {
        warn("AgentChattr install failed. You can set it up manually:");
        log(`  → git clone ${AGENTCHATTR_REPO} ${DEFAULT_AGENTCHATTR_DIR}`);
        log(`  → cd ${DEFAULT_AGENTCHATTR_DIR} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`);
        allOk = false;
      }
    } else {
      warn("AgentChattr skipped — agents won't be able to chat until it's installed.");
      log(`  → Install later: git clone ${AGENTCHATTR_REPO} ${DEFAULT_AGENTCHATTR_DIR}`);
      allOk = false;
    }
  } else {
    warn("AgentChattr requires Python — install Python first, then re-run init.");
    allOk = false;
  }

  // ── 5. GitHub CLI (independent) ──
  if (which("gh")) {
    ok("GitHub CLI (gh)");
  } else {
    console.log("");
    warn("GitHub CLI is required for agents to create branches, PRs, and reviews.");
    const ghCmd = (p) => {
      if (p === "macos") return "brew install gh";
      if (p === "linux-apt") return "sudo apt install gh -y";
      if (p === "linux-dnf") return "sudo dnf install gh -y";
      return null;
    };
    const cmd = ghCmd(platform);
    if (cmd) {
      const installed = await tryInstall(rl, "GitHub CLI",
        "We can install it now.", ghCmd, { platform });
      if (installed && which("gh")) {
        ok("GitHub CLI installed");
      } else {
        fail("GitHub CLI is required. Install from: https://cli.github.com");
        allOk = false;
      }
    } else {
      fail("GitHub CLI is required. Install from: https://cli.github.com");
      allOk = false;
    }
  }

  // ── 6. AI CLIs — at least one required (independent) ──
  let hasClaude = which("claude");
  let hasCodex = which("codex");

  if (hasClaude) ok("Claude Code");
  if (hasCodex) ok("Codex CLI");

  if (!hasClaude && !hasCodex) {
    console.log("");
    warn("You need at least one AI CLI to power your agents.");
    log("Choose one (or both) to install:");
    console.log("");
  }

  // sudo needed for global npm installs on macOS/Linux
  const npmPrefix = process.platform === "win32" ? "" : "sudo ";

  // Offer to install Claude Code if missing
  if (!hasClaude) {
    const isRequired = !hasCodex;
    log("Claude Code — Anthropic's AI coding assistant");
    const installClaude = await askYN(rl, "Install Claude Code?", isRequired);
    if (installClaude) {
      log(`Running: ${npmPrefix}npm install -g @anthropic-ai/claude-code`);
      try {
        execSync(`${npmPrefix}npm install -g @anthropic-ai/claude-code`, { stdio: "inherit", timeout: 120000 });
        hasClaude = which("claude");
        if (hasClaude) ok("Claude Code installed");
        else warn(`Install seemed to succeed but 'claude' not found on PATH. Try restarting your terminal.`);
      } catch {
        warn(`Install failed — try manually: ${npmPrefix}npm install -g @anthropic-ai/claude-code`);
      }
    }
  }

  // Offer to install Codex CLI if missing
  if (!hasCodex) {
    const isRequired = !hasClaude;
    if (hasClaude) {
      console.log("");
      log("Tip: Installing Codex CLI too gives your team different AI perspectives.");
    }
    log("Codex CLI — OpenAI's AI coding assistant");
    const installCodex = await askYN(rl, "Install Codex CLI?", isRequired);
    if (installCodex) {
      log(`Running: ${npmPrefix}npm install -g @openai/codex`);
      try {
        execSync(`${npmPrefix}npm install -g @openai/codex`, { stdio: "inherit", timeout: 120000 });
        hasCodex = which("codex");
        if (hasCodex) ok("Codex CLI installed");
        else warn(`Install seemed to succeed but 'codex' not found on PATH. Try restarting your terminal.`);
      } catch {
        warn(`Install failed — try manually: ${npmPrefix}npm install -g @openai/codex`);
      }
    }
  }

  if (!hasClaude && !hasCodex) {
    fail("At least one AI CLI is required (Claude Code or Codex CLI).");
    log("Install one and re-run: npx quadwork init");
    allOk = false;
  }

  // ── CLI Authentication Checks ──
  if (allOk) {
    console.log("");
    log("Checking CLI authentication...");
    console.log("");

    // GitHub CLI auth
    const ghAuth = run("gh auth status 2>&1");
    if (ghAuth && ghAuth.includes("Logged in")) {
      ok("GitHub CLI — authenticated");
    } else {
      warn("GitHub CLI is installed but not logged in.");
      log("  A browser window will open for authentication.");
      const doLogin = await askYN(rl, "Log in to GitHub now?", true);
      if (doLogin) {
        // Pause readline so the interactive command can use stdin
        rl.pause();
        process.stdin.setRawMode && process.stdin.setRawMode(false);
        const { status } = require("child_process").spawnSync("gh", ["auth", "login", "-w"], { stdio: "inherit", timeout: 600000 });
        rl.resume();
        if (status === 0) {
          ok("GitHub CLI — authenticated");
        } else {
          warn("Authentication cancelled or failed — you can run 'gh auth login' later.");
        }
      } else {
        warn("Skipped — you can run 'gh auth login' later.");
      }
    }

    // Claude Code auth
    if (hasClaude) {
      const claudeAuth = run("claude auth status 2>&1") || run("claude --version 2>&1");
      if (claudeAuth && (claudeAuth.includes("authenticated") || claudeAuth.includes("Logged in") || claudeAuth.includes("@"))) {
        ok("Claude Code — authenticated");
      } else {
        warn("Claude Code needs authentication.");
        const doLogin = await askYN(rl, "Log in to Claude Code now?", true);
        if (doLogin) {
          rl.pause();
          process.stdin.setRawMode && process.stdin.setRawMode(false);
          const { status } = require("child_process").spawnSync("claude", ["auth", "login"], { stdio: "inherit", timeout: 600000 });
          rl.resume();
          if (status === 0) {
            ok("Claude Code — authentication complete");
          } else {
            warn("Authentication cancelled or failed — you can run 'claude auth login' later.");
          }
        } else {
          warn("Skipped — you can run 'claude auth login' later.");
        }
      }
    }

    // Codex CLI auth
    if (hasCodex) {
      const codexAuth = run("codex login status 2>&1") || run("codex --version 2>&1");
      if (codexAuth && (codexAuth.includes("authenticated") || codexAuth.includes("Logged in") || codexAuth.includes("@"))) {
        ok("Codex CLI — authenticated");
      } else {
        warn("Codex CLI needs authentication.");
        const doLogin = await askYN(rl, "Log in to Codex CLI now?", true);
        if (doLogin) {
          rl.pause();
          process.stdin.setRawMode && process.stdin.setRawMode(false);
          const { status } = require("child_process").spawnSync("codex", ["login"], { stdio: "inherit", timeout: 600000 });
          rl.resume();
          if (status === 0) {
            ok("Codex CLI — authentication complete");
          } else {
            warn("Authentication cancelled or failed — you can run 'codex login' later.");
          }
        } else {
          warn("Skipped — you can run 'codex login' later.");
        }
      }
    }
  }

  // ── Summary ──
  console.log("");
  if (allOk) {
    ok("All prerequisites ready!");
  } else {
    console.log("");
    log("Some prerequisites are missing. Fix the issues above and re-run:");
    log("  → npx quadwork init");
  }

  return allOk;
}

// ─── GitHub ─────────────────────────────────────────────────────────────────

async function setupGitHub(rl) {
  header("Step 2: GitHub Connection");

  // Check auth
  const authStatus = run("gh auth status 2>&1");
  if (authStatus && authStatus.includes("Logged in")) {
    ok("GitHub authenticated");
  } else {
    fail("Not authenticated with GitHub — run: gh auth login");
    return null;
  }

  log("Enter the GitHub repo for your first project. You can add more later with `quadwork add-project`.");
  const repo = await ask(rl, "GitHub repo (owner/repo)", "");
  if (!repo || !repo.includes("/")) {
    fail("Invalid repo format — use owner/repo");
    return null;
  }

  // Verify repo exists
  const sp = spinner(`Verifying ${repo}...`);
  const repoCheck = run(`gh repo view ${repo} --json name 2>&1`);
  if (repoCheck && repoCheck.includes('"name"')) {
    sp.stop(true);
  } else {
    sp.stop(false);
    fail(`Cannot access ${repo} — check permissions`);
    return null;
  }

  return repo;
}

// ─── Agent Configuration ────────────────────────────────────────────────────

async function setupAgents(rl, repo) {
  header("Step 3: Agent Configuration");

  // Detect available CLIs
  const hasClaude = which("claude");
  const hasCodex = which("codex");
  const bothAvailable = hasClaude && hasCodex;
  const onlyOneCli = (hasClaude && !hasCodex) || (!hasClaude && hasCodex);
  let defaultBackend = hasClaude ? "claude" : "codex";

  const backends = {};

  if (onlyOneCli) {
    // Single-CLI mode: default all agents, no prompt needed
    const cliName = hasClaude ? "Claude Code" : "Codex CLI";
    const otherName = hasClaude ? "Codex CLI" : "Claude Code";
    const installCmd = hasClaude ? "npm install -g @openai/codex" : "npm install -g @anthropic-ai/claude-code";
    ok(`${cliName} detected — all 4 agents will use ${cliName}.`);
    console.log("");
    log(`Tip: Installing ${otherName} too gives your team different AI perspectives,`);
    log(`which can improve code review quality. You can add it anytime:`);
    log(`  → ${installCmd}`);
    console.log("");
    for (const agent of AGENTS) backends[agent] = defaultBackend;
  } else if (bothAvailable) {
    log("Both Claude Code and Codex CLI are available.");
    log("Choose which AI CLI to run in agent terminals.");
    const backend = await ask(rl, "Default CLI backend (claude/codex)", defaultBackend);
    if (backend !== "claude" && backend !== "codex") {
      fail("Backend must be 'claude' or 'codex'");
      return null;
    }
    defaultBackend = backend;

    // Per-agent backend selection
    const customPerAgent = await askYN(rl, "Use same backend for all agents?", true);
    if (customPerAgent) {
      for (const agent of AGENTS) backends[agent] = backend;
    } else {
      for (const agent of AGENTS) {
        const agentBackend = await ask(rl, `${agent.toUpperCase()} backend (claude/codex)`, backend);
        backends[agent] = (agentBackend === "claude" || agentBackend === "codex") ? agentBackend : backend;
      }
    }
  } else {
    fail("No AI CLI found — install Claude Code or Codex CLI first.");
    return null;
  }
  const backend = defaultBackend;

  log("Path to your local clone of the repo. Four worktrees will be created next to it");
  log("(e.g., project-head/, project-reviewer1/, project-reviewer2/, project-dev/).");
  const projectDir = await ask(rl, "Project directory", process.cwd());
  const absDir = path.resolve(projectDir);

  if (!fs.existsSync(absDir)) {
    fail(`Directory not found: ${absDir}`);
    return null;
  }

  // Check if it's a git repo
  if (!fs.existsSync(path.join(absDir, ".git"))) {
    fail(`Not a git repo: ${absDir}`);
    return null;
  }

  // Prompt for reviewer credentials (optional)
  log("A separate reviewer account lets Reviewer1/Reviewer2 approve PRs independently. You can set this up later in Settings.");
  const wantReviewer = await askYN(rl, "Use a separate GitHub account for reviewers (Reviewer1/Reviewer2)?", false);
  let reviewerUser = "";
  let reviewerTokenPath = "";
  if (wantReviewer) {
    log("GitHub username for the reviewer account (used in Reviewer1/Reviewer2 seed files for PR reviews).");
    reviewerUser = await ask(rl, "Reviewer GitHub username", "");
    log("Path to a file containing a GitHub PAT for the reviewer account.");
    reviewerTokenPath = await ask(rl, "Reviewer token file path", path.join(os.homedir(), ".quadwork", "reviewer-token"));
  }

  const projectName = path.basename(absDir);
  log(`Project: ${projectName}`);
  const wtSpinner = spinner("Creating worktrees and seeding files...");

  const worktrees = {};
  let wtFailed = null;
  for (const agent of AGENTS) {
    const wtDir = path.join(path.dirname(absDir), `${projectName}-${agent}`);
    if (!fs.existsSync(wtDir)) {
      const branchName = `worktree-${agent}`;
      run(`git -C "${absDir}" branch ${branchName} HEAD 2>&1`);
      const result = run(`git -C "${absDir}" worktree add "${wtDir}" ${branchName} 2>&1`);
      if (!result) {
        const result2 = run(`git -C "${absDir}" worktree add --detach "${wtDir}" HEAD 2>&1`);
        if (!result2) { wtFailed = agent; break; }
      }
    }
    worktrees[agent] = wtDir;

    // Copy AGENTS.md seed with placeholder substitution
    const seedSrc = path.join(TEMPLATES_DIR, "seeds", `${agent}.AGENTS.md`);
    const seedDst = path.join(wtDir, "AGENTS.md");
    if (fs.existsSync(seedSrc)) {
      let seedContent = fs.readFileSync(seedSrc, "utf-8");
      if (reviewerUser) {
        seedContent = seedContent.replace(/\{\{reviewer_github_user\}\}/g, reviewerUser);
        seedContent = seedContent.replace(/\{\{reviewer_token_path\}\}/g, reviewerTokenPath);
      } else {
        // No reviewer configured — remove the GitHub Authentication section
        seedContent = seedContent.replace(/## GitHub Authentication[\s\S]*?## Forbidden Actions/, "## Forbidden Actions");
        seedContent = seedContent.replace(/\{\{reviewer_github_user\}\}/g, "");
        seedContent = seedContent.replace(/\{\{reviewer_token_path\}\}/g, "");
      }
      fs.writeFileSync(seedDst, seedContent);
    }
  }

  if (wtFailed) {
    wtSpinner.stop(false);
    fail(`Failed to create worktree for ${wtFailed}`);
    return null;
  }

  // Copy CLAUDE.md to each worktree
  const claudeSrc = path.join(TEMPLATES_DIR, "CLAUDE.md");
  if (fs.existsSync(claudeSrc)) {
    let claudeContent = fs.readFileSync(claudeSrc, "utf-8");
    claudeContent = claudeContent.replace(/\{\{project_name\}\}/g, projectName);
    for (const agent of AGENTS) {
      const dst = path.join(worktrees[agent], "CLAUDE.md");
      if (!fs.existsSync(dst)) {
        fs.writeFileSync(dst, claudeContent);
      }
    }
  }

  wtSpinner.stop(true);

  return { projectName, absDir, worktrees, repo, backend, backends };
}

// ─── AgentChattr Config ─────────────────────────────────────────────────────

function writeAgentChattrConfig(setup, configTomlPath, { skipInstall = false } = {}) {
  header("Step 4: AgentChattr Setup");

  let tomlContent = fs.readFileSync(path.join(TEMPLATES_DIR, "config.toml"), "utf-8");
  for (const agent of AGENTS) {
    tomlContent = tomlContent.replace(new RegExp(`\\{\\{${agent}_cwd\\}\\}`, "g"), setup.worktrees[agent]);
  }
  // Replace placeholders
  tomlContent = tomlContent.replace(/\{\{project_name\}\}/g, setup.projectName);
  tomlContent = tomlContent.replace(/\{\{repo\}\}/g, setup.repo);
  // Replace per-agent commands with chosen backends
  for (const agent of AGENTS) {
    const cmd = (setup.backends && setup.backends[agent]) || setup.backend;
    tomlContent = tomlContent.replace(
      new RegExp(`(\\[agents\\.${agent}\\][\\s\\S]*?command = )"(?:claude|codex)"`),
      `$1"${cmd}"`
    );
  }

  // Per-project: isolated data dir and port
  const dataDir = path.join(path.dirname(configTomlPath), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  // Read assigned port from config (set by writeQuadWorkConfig)
  const existingConfig = readConfig();
  const existingProject = existingConfig.projects?.find((p) => p.id === setup.projectName);
  const chattrPort = existingProject?.agentchattr_url
    ? new URL(existingProject.agentchattr_url).port
    : "8300";
  const mcpHttp = existingProject?.mcp_http_port || 8200;
  const mcpSse = existingProject?.mcp_sse_port || 8201;
  tomlContent = tomlContent.replace(/^port = \d+/m, `port = ${chattrPort}`);
  tomlContent = tomlContent.replace(/^data_dir = .+/m, `data_dir = "${dataDir}"`);
  // Add session_token to [server] section if project has one
  const sessionToken = existingProject?.agentchattr_token || "";
  if (sessionToken) {
    tomlContent = tomlContent.replace(/^(data_dir = .+)$/m, `$1\nsession_token = "${sessionToken}"`);
  }
  tomlContent = tomlContent.replace(/^http_port = \d+/m, `http_port = ${mcpHttp}`);
  tomlContent = tomlContent.replace(/^sse_port = \d+/m, `sse_port = ${mcpSse}`);

  // Write config.toml
  const configDir = path.dirname(configTomlPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configTomlPath, tomlContent);
  ok(`Wrote ${configTomlPath}`);

  // Phase 2C / #181: clone AgentChattr per-project at
  // ~/.quadwork/{project_id}/agentchattr/. AgentChattr's run.py loads
  // ROOT/config.toml, so each project needs its own clone to avoid
  // multi-instance port conflicts (see master #181). The path is the
  // same one writeQuadWorkConfig() persists in project.agentchattr_dir.
  const perProjectDir = path.join(CONFIG_DIR, setup.projectName, "agentchattr");
  let acDir = findAgentChattr(perProjectDir);
  let acAvailable = !!acDir;
  if (!acAvailable && !skipInstall) {
    const acSpinner = spinner(`Setting up AgentChattr at ${perProjectDir}...`);
    const installResult = installAgentChattr(perProjectDir);
    if (installResult) {
      acSpinner.stop(true);
      acDir = installResult;
      acAvailable = true;
    } else {
      acSpinner.stop(false);
      const reason = installAgentChattr.lastError || "unknown error";
      warn(`AgentChattr install failed at ${perProjectDir}: ${reason}`);
      warn(`Install manually: git clone ${AGENTCHATTR_REPO} ${perProjectDir}`);
    }
  }

  // Start AgentChattr server (only if installed)
  if (acAvailable) {
    log("Starting AgentChattr server...");
    const acSpawn = chattrSpawnArgs(acDir, ["--config", configTomlPath]);
    if (acSpawn) {
      const acProc = spawn(acSpawn.command, acSpawn.spawnArgs, {
        cwd: acSpawn.cwd,
        stdio: "ignore",
        detached: true,
      });
      acProc.on("error", (err) => {
        warn(`AgentChattr failed to start: ${err.message}`);
      });
      acProc.unref();
      if (acProc.pid) {
        ok(`AgentChattr started (PID: ${acProc.pid})`);
        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const pidFile = path.join(CONFIG_DIR, `agentchattr-${setup.projectName}.pid`);
        fs.writeFileSync(pidFile, String(acProc.pid));
      } else {
        warn("Could not start AgentChattr — check logs in " + (acDir || perProjectDir));
      }
    } else {
      warn("AgentChattr run.py not found — skipping auto-start.");
    }
  } else {
    warn("AgentChattr not installed — skipping auto-start.");
    log(`  → Install: git clone ${AGENTCHATTR_REPO} ${perProjectDir}`);
  }

  return configTomlPath;
}

// ─── Optional Add-ons ───────────────────────────────────────────────────────

async function setupAddons(rl, setup, configTomlPath) {
  header("Step 5: Optional Add-ons");

  // Telegram Bridge
  log("Optional: connect a Telegram bot for remote notifications.");
  const wantTelegram = await askYN(rl, "Set up Telegram Bridge?", false);
  if (wantTelegram) {
    const telegramDir = path.join(path.dirname(setup.absDir), "agentchattr-telegram");
    if (!fs.existsSync(telegramDir)) {
      const cloneSpinner = spinner("Cloning agentchattr-telegram...");
      const cloneResult = run(`git clone https://github.com/realproject7/agentchattr-telegram.git "${telegramDir}" 2>&1`);
      cloneSpinner.stop(cloneResult !== null);
      if (!cloneResult) warn("You can set it up manually later");
    } else {
      ok("agentchattr-telegram already present");
    }

    if (fs.existsSync(telegramDir)) {
      const reqFile = path.join(telegramDir, "requirements.txt");
      if (fs.existsSync(reqFile)) {
        const tgSpinner = spinner("Installing Telegram Bridge dependencies...");
        const tgResult = run(`pip install -r "${reqFile}" 2>&1`);
        tgSpinner.stop(tgResult !== null);
      }

      log("Create a bot via @BotFather on Telegram (https://t.me/BotFather), then copy the token.");
      const botToken = await askSecret(rl, "Telegram bot token");
      log("To find your chat ID:");
      log("  1. Open your bot on Telegram and send it any message (e.g., 'hi')");
      log("  2. Run: curl https://api.telegram.org/bot<TOKEN>/getUpdates");
      log("  3. Look for \"chat\":{\"id\":123456789,...} — the number is your chat ID");
      log("  Note: Returns empty if no messages have been sent to the bot yet.");
      const chatId = await ask(rl, "Telegram chat ID", "");
      log("Need help? See https://github.com/realproject7/agentchattr-telegram#readme");

      if (botToken && chatId) {
        // Write bot token to ~/.quadwork/.env (never stored in config files)
        const envPath = path.join(CONFIG_DIR, ".env");
        const envKey = `TELEGRAM_BOT_TOKEN_${setup.projectName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
        let envContent = "";
        try { envContent = fs.readFileSync(envPath, "utf-8"); } catch {}
        const envRegex = new RegExp(`^${envKey}=.*$`, "m");
        const envLine = `${envKey}=${botToken}`;
        if (envRegex.test(envContent)) {
          envContent = envContent.replace(envRegex, envLine);
        } else {
          envContent = envContent.trimEnd() + (envContent ? "\n" : "") + envLine + "\n";
        }
        fs.writeFileSync(envPath, envContent, { mode: 0o600 });
        fs.chmodSync(envPath, 0o600);
        ok(`Saved bot token (${maskValue(botToken)}) to ${envPath}`);

        // Persist telegram settings for writeQuadWorkConfig (env reference, not plaintext)
        setup.telegram = {
          bot_token: `env:${envKey}`,
          chat_id: chatId,
          bridge_dir: telegramDir,
        };

        // Resolve per-project AgentChattr URL
        const projectCfg = readConfig();
        const projectEntry = projectCfg.projects?.find((p) => p.id === setup.projectName);
        const projectChattrUrl = projectEntry?.agentchattr_url || "http://127.0.0.1:8300";

        // Append telegram section to config.toml (token read from env at runtime)
        const telegramSection = `
[telegram]
bot_token = "env:${envKey}"
chat_id = "${chatId}"
agentchattr_url = "${projectChattrUrl}"
poll_interval = 2
bridge_sender = "telegram-bridge"
`;
        fs.appendFileSync(configTomlPath, telegramSection);
        ok("Added Telegram config to config.toml (token stored in .env)");

        // Start Telegram bridge daemon with a resolved config (real token, chmod 600)
        const bridgeScript = path.join(telegramDir, "telegram_bridge.py");
        if (fs.existsSync(bridgeScript)) {
          log("Starting Telegram bridge...");
          const bridgeToml = path.join(CONFIG_DIR, `telegram-${setup.projectName}.toml`);
          const bridgeTomlContent = `[telegram]\nbot_token = "${botToken}"\nchat_id = "${chatId}"\n\n[agentchattr]\nurl = "${projectChattrUrl}"\n`;
          fs.writeFileSync(bridgeToml, bridgeTomlContent, { mode: 0o600 });
          fs.chmodSync(bridgeToml, 0o600);
          const bridgeProc = spawn("python3", [bridgeScript, "--config", bridgeToml], {
            stdio: "ignore",
            detached: true,
          });
          bridgeProc.unref();
          if (bridgeProc.pid) {
            ok(`Telegram bridge started (PID: ${bridgeProc.pid})`);
            const pidFile = path.join(CONFIG_DIR, "telegram-bridge.pid");
            fs.writeFileSync(pidFile, String(bridgeProc.pid));
          } else {
            warn("Could not start Telegram bridge — start manually");
          }
        }
      }
    }
  }

  // Shared Memory
  log("Optional: set up shared memory cards for cross-agent knowledge.");
  const wantMemory = await askYN(rl, "Set up Shared Memory?", false);
  if (wantMemory) {
    const memoryDir = path.join(path.dirname(setup.absDir), "agent-memory");
    if (!fs.existsSync(memoryDir)) {
      const memSpinner = spinner("Cloning agent-memory...");
      const cloneResult = run(`git clone https://github.com/realproject7/agent-memory.git "${memoryDir}" 2>&1`);
      memSpinner.stop(cloneResult !== null);
      if (!cloneResult) warn("You can set it up manually later");
    } else {
      ok("agent-memory already present");
    }

    if (fs.existsSync(memoryDir)) {
      // Verify butler scripts exist
      const scriptsDir = path.join(memoryDir, "scripts");
      const requiredScripts = ["butler-scan.sh", "butler-consolidate.sh", "inject.sh"];
      for (const script of requiredScripts) {
        const scriptPath = path.join(scriptsDir, script);
        if (fs.existsSync(scriptPath)) {
          // Ensure executable
          try { fs.chmodSync(scriptPath, 0o755); } catch {}
        } else {
          warn(`Butler script not found: ${scriptPath}`);
        }
      }
      ok("Butler scripts verified");

      // Create project short-term memory file if missing
      const shortTermDir = path.join(memoryDir, "central", "short-term");
      const projectMemFile = path.join(shortTermDir, `${setup.projectName}.md`);
      if (!fs.existsSync(projectMemFile)) {
        if (!fs.existsSync(shortTermDir)) fs.mkdirSync(shortTermDir, { recursive: true });
        fs.writeFileSync(projectMemFile, `# ${setup.projectName} — Short-Term Memory\n\n_No entries yet._\n`);
        ok(`Created ${projectMemFile}`);
      }

      // Create cards directory if missing
      const cardsDir = path.join(memoryDir, "archive", "v2", "cards");
      if (!fs.existsSync(cardsDir)) {
        fs.mkdirSync(cardsDir, { recursive: true });
        ok("Created cards directory");
      }
    }

    setup.memoryDir = memoryDir;
  }

  return setup;
}

// ─── Write QuadWork Config ──────────────────────────────────────────────────

function writeQuadWorkConfig(setup) {
  header("Writing QuadWork Config");

  const config = readConfig();

  const project = {
    id: setup.projectName,
    name: setup.projectName,
    repo: setup.repo,
    working_dir: setup.absDir,
    agents: {},
  };

  for (const agent of AGENTS) {
    const cmd = (setup.backends && setup.backends[agent]) || setup.backend;
    const cliBase = cmd.split("/").pop().split(" ")[0];
    const injectMode = cliBase === "codex" ? "proxy_flag" : cliBase === "gemini" ? "env" : "flag";
    project.agents[agent] = {
      cwd: setup.worktrees[agent],
      command: cmd,
      auto_approve: true,
      mcp_inject: injectMode,
    };
  }

  if (setup.memoryDir) {
    project.memory_cards_dir = path.join(setup.memoryDir, "archive", "v2", "cards");
    project.shared_memory_path = path.join(setup.memoryDir, "central", "short-term", `${setup.projectName}.md`);
    project.butler_scripts_dir = path.join(setup.memoryDir, "scripts");
  }

  if (setup.telegram) {
    project.telegram = {
      bot_token: setup.telegram.bot_token,
      chat_id: setup.telegram.chat_id,
      bridge_dir: setup.telegram.bridge_dir,
    };
  }

  // Auto-assign per-project AgentChattr and MCP ports (scan existing to avoid collisions)
  const existingIdx = config.projects.findIndex((p) => p.id === setup.projectName);
  const usedChattrPorts = new Set(config.projects.map((p) => {
    try { return parseInt(new URL(p.agentchattr_url).port, 10); } catch { return 0; }
  }).filter(Boolean));
  const usedMcpPorts = new Set(config.projects.flatMap((p) => [p.mcp_http_port, p.mcp_sse_port]).filter(Boolean));
  let chattrPort = 8300;
  while (usedChattrPorts.has(chattrPort)) chattrPort++;
  let mcp_http = 8200;
  while (usedMcpPorts.has(mcp_http)) mcp_http++;
  let mcp_sse = mcp_http + 1;
  while (usedMcpPorts.has(mcp_sse)) mcp_sse++;
  project.agentchattr_url = `http://127.0.0.1:${chattrPort}`;
  project.agentchattr_token = require("crypto").randomBytes(16).toString("hex");
  project.mcp_http_port = mcp_http;
  project.mcp_sse_port = mcp_sse;
  // Per-project AgentChattr clone path (Option B / #181). Each project gets
  // its own clone so AgentChattr's ROOT/config.toml lookup picks up the right
  // ports — see master ticket #181.
  project.agentchattr_dir = path.join(os.homedir(), ".quadwork", setup.projectName, "agentchattr");

  // Upsert project
  if (existingIdx >= 0) config.projects[existingIdx] = project;
  else config.projects.push(project);

  writeConfig(config);
  ok(`Wrote ${CONFIG_PATH}`);
}

// ─── Init Command ───────────────────────────────────────────────────────────

async function cmdInit() {
  console.log("");
  console.log(`  ${c.cyan}${c.bold}╔══════════════════════════════════════════╗${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}║${c.reset}  ${c.white}${c.bold}QuadWork Init${c.reset}                           ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}║${c.reset}  ${c.dim}Global setup — projects via web UI${c.reset}       ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}╚══════════════════════════════════════════╝${c.reset}`);
  console.log(`\n  ${c.dim}Press Enter to accept defaults. Takes under 30 seconds.${c.reset}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Step 1: Prerequisites (header printed by checkPrereqs)
    const prereqsOk = await checkPrereqs(rl);
    if (!prereqsOk) {
      console.log("");
      log("Once everything is installed, re-run:  npx quadwork init");
      rl.close();
      process.exit(1);
    }

    // Step 2: Dashboard port
    header("Step 2: Dashboard Port");
    const port = await ask(rl, "Port for the QuadWork dashboard (Enter for default)", "8400");

    // Write global config
    const config = readConfig();
    config.port = parseInt(port, 10) || 8400;
    writeConfig(config);
    ok(`Wrote ${CONFIG_PATH}`);

    // Step 3: Start server in the foreground (Batch 25 / #203).
    //
    // Previously cmdInit spawned the server detached and exited, which
    // left users without logs, without a clear stop story, and
    // inconsistent with `npx quadwork start` (#169). Now we print the
    // welcome banner first, schedule the browser open, close the
    // wizard readline, and then require() the server so it runs in
    // the user's terminal — Ctrl+C stops it cleanly via the SIGINT
    // handler below (same pattern cmdStart uses).
    header("Step 3: Starting Dashboard");
    const quadworkDir = path.join(__dirname, "..");
    const serverDir = path.join(quadworkDir, "server");
    if (!fs.existsSync(path.join(serverDir, "index.js"))) {
      fail("Server not found. Run from the quadwork directory.");
      rl.close();
      process.exit(1);
    }

    const dashPort = parseInt(port, 10) || 8400;
    const dashboardUrl = `http://127.0.0.1:${dashPort}`;

    // Celebratory welcome (printed BEFORE the server takes over stdout
    // so it stays visible at the top of the scrollback).
    console.log("");
    console.log(`  ${c.cyan}${c.bold}╔══════════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.green}${c.bold}Welcome to QuadWork!${c.reset}                                ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   Your AI-powered dev team is ready to ship.             ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.green}*${c.reset} ${c.bold}Head${c.reset}        ${c.dim}— coordinates & merges${c.reset}                  ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.green}*${c.reset} ${c.bold}Dev${c.reset}         ${c.dim}— writes all the code${c.reset}                   ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.green}*${c.reset} ${c.bold}Reviewer1${c.reset}   ${c.dim}— independent code review${c.reset}               ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.green}*${c.reset} ${c.bold}Reviewer2${c.reset}   ${c.dim}— independent code review${c.reset}               ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   4 agents. Full GitHub workflow. Runs while you sleep.  ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}╚══════════════════════════════════════════════════════════╝${c.reset}`);
    console.log("");
    console.log(`  ${c.green}*${c.reset} Dashboard: ${c.cyan}${dashboardUrl}${c.reset}`);
    console.log(`  ${c.green}*${c.reset} Config:    ${c.dim}${CONFIG_PATH}${c.reset}`);
    console.log("");
    console.log(`  ${c.cyan}${c.bold}--- Create Your First Project ---${c.reset}`);
    console.log("");
    console.log(`  Your browser is opening now. If not, visit:`);
    console.log("");
    console.log(`    ${c.cyan}${c.bold}${dashboardUrl}/setup${c.reset}`);
    console.log("");
    console.log(`    ${c.dim}1.${c.reset} Connect a GitHub repo`);
    console.log(`    ${c.dim}2.${c.reset} Pick models for each agent`);
    console.log(`    ${c.dim}3.${c.reset} Hit Start — your team takes it from there`);
    console.log("");
    console.log(`  ${c.green}${c.bold}Happy shipping!${c.reset}  ${c.dim}(Press Ctrl+C to stop.)${c.reset}`);
    console.log("");

    // Close the wizard readline before requiring the server, otherwise
    // stdin stays in raw/line-buffered mode and swallows Ctrl+C.
    rl.close();

    // Schedule browser open after the server has had a moment to bind.
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    setTimeout(() => {
      try { execSync(`${openCmd} ${dashboardUrl}/setup`, { stdio: "ignore" }); } catch {}
    }, 1500);

    // Graceful shutdown on Ctrl+C. cmdInit doesn't spawn per-project
    // AgentChattr processes (there are no projects yet), so the
    // handler only needs to stop the in-process server — require()
    // brings it into this same Node process, so process.exit() is
    // enough to release the port.
    process.on("SIGINT", () => {
      console.log("");
      log("Shutting down...");
      ok("Stopped.");
      process.exit(0);
    });

    // Run the server in the foreground. require() starts the express
    // listener in this process, so cmdInit stays alive until Ctrl+C.
    require(path.join(serverDir, "index.js"));
  } catch (err) {
    fail(err.message);
    rl.close();
    process.exit(1);
  }
}

// ─── Start Command ──────────────────────────────────────────────────────────

/**
 * Phase 3 / #181 sub-G: migrate legacy v1 projects to per-project clones.
 *
 * Runs eagerly at the top of cmdStart() so users see clear progress before
 * any agents launch. For each project that doesn't yet have a working
 * per-project clone:
 *   1. Compute perProjectDir = ~/.quadwork/{project_id}/agentchattr
 *   2. installAgentChattr(perProjectDir) — idempotent (#183 + #187)
 *   3. Copy the existing legacy <working_dir>/agentchattr/config.toml into
 *      the new clone ROOT if it exists. AgentChattr's run.py reads
 *      ROOT/config.toml from the clone dir, so this is what makes the
 *      project actually start from its own clone.
 *   4. Set project.agentchattr_dir on the config entry and persist.
 *
 * Idempotent: if a project already has a working per-project clone with a
 * config.toml at the ROOT and agentchattr_dir set, it is skipped silently.
 * The legacy ~/.quadwork/agentchattr/ install is left alone — cleanup is
 * sub-H (#189).
 *
 * The migration never touches worktrees, repo content, or token files;
 * only the per-project AgentChattr install dir and config.json.
 */
function migrateLegacyProjects(config) {
  if (!config.projects || config.projects.length === 0) return false;

  const needsMigration = config.projects.filter((p) => {
    if (!p.id) return false;
    const target = p.agentchattr_dir || path.join(CONFIG_DIR, p.id, "agentchattr");
    const hasClone = fs.existsSync(path.join(target, "run.py")) &&
                     fs.existsSync(path.join(target, ".venv", "bin", "python"));
    const hasToml = fs.existsSync(path.join(target, "config.toml"));
    const hasField = !!p.agentchattr_dir;
    return !(hasField && hasClone && hasToml);
  });

  if (needsMigration.length === 0) return false;

  header("Migrating legacy projects to per-project AgentChattr clones");
  let mutated = false;
  for (const project of needsMigration) {
    const perProjectDir = path.join(CONFIG_DIR, project.id, "agentchattr");
    log(`  ${project.id} → ${perProjectDir}`);

    // 1. Install (idempotent — no-op if clone is already valid).
    if (!findAgentChattr(perProjectDir)) {
      const acSpinner = spinner(`    Cloning AgentChattr for ${project.id}...`);
      const installResult = installAgentChattr(perProjectDir);
      if (!installResult) {
        acSpinner.stop(false);
        const reason = installAgentChattr.lastError || "unknown error";
        warn(`    Migration failed for ${project.id}: ${reason}`);
        warn(`    ${project.id} will keep using the legacy global install until this is resolved.`);
        continue;
      }
      acSpinner.stop(true);
    }

    // 2. Seed config.toml at the clone ROOT from the legacy in-worktree
    //    location if present. Do not overwrite an existing per-project
    //    config.toml — re-running the migration must be a no-op.
    //
    //    If the legacy toml exists but the copy fails, we MUST NOT persist
    //    agentchattr_dir — otherwise #186's resolver would switch this
    //    project to a clone that lacks the project's real ports, and
    //    AgentChattr would silently start on run.py defaults. Leaving
    //    agentchattr_dir unset keeps the project on the legacy global
    //    install via #186's fallback ladder until the next attempt.
    const targetToml = path.join(perProjectDir, "config.toml");
    let tomlReady = fs.existsSync(targetToml);
    if (!tomlReady && project.working_dir) {
      const legacyToml = path.join(project.working_dir, "agentchattr", "config.toml");
      if (fs.existsSync(legacyToml)) {
        try {
          fs.copyFileSync(legacyToml, targetToml);
          log(`    Copied legacy config.toml → ${targetToml}`);
          tomlReady = true;
        } catch (e) {
          warn(`    Could not copy ${legacyToml}: ${e.message}`);
          warn(`    ${project.id} migration aborted: legacy config.toml not transferred.`);
          warn(`    ${project.id} will keep using the legacy global install via #186 fallback.`);
          continue;
        }
      } else {
        // No legacy toml at all (e.g. user removed it). Refuse to migrate
        // — without a config.toml at the clone ROOT, run.py would start
        // on built-in defaults and bind to the wrong ports.
        warn(`    ${project.id} has no legacy config.toml at ${legacyToml}; skipping migration.`);
        warn(`    Re-run setup to regenerate config.toml, then 'quadwork start' will retry migration.`);
        continue;
      }
    }
    if (!tomlReady) {
      warn(`    ${project.id} migration aborted: no config.toml at ${targetToml}.`);
      continue;
    }

    // 3. Persist agentchattr_dir on the project entry — only after the
    //    clone has run.py + venv + config.toml all in place.
    if (project.agentchattr_dir !== perProjectDir) {
      project.agentchattr_dir = perProjectDir;
      mutated = true;
    }
  }

  if (mutated) {
    try { writeConfig(config); ok("Updated config.json with per-project agentchattr_dir entries"); }
    catch (e) { warn(`Failed to write config.json: ${e.message}`); }
  }
  log("  Legacy ~/.quadwork/agentchattr/ left in place; remove via cleanup script (#189).");
  return true;
}

function cmdStart() {
  console.log("\n  QuadWork Start\n");

  const config = readConfig();
  if (config.projects.length === 0) {
    warn("No projects configured yet. Create one at the setup page.");
  }

  // Phase 3 / #181: migrate legacy single-install projects to their
  // own per-project clones before any AgentChattr spawn happens.
  // Idempotent — a no-op once every project already has a working clone.
  migrateLegacyProjects(config);

  const quadworkDir = path.join(__dirname, "..");
  const port = config.port || 8400;

  // Check that the pre-built frontend exists
  const outDir = path.join(quadworkDir, "out");
  if (!fs.existsSync(outDir)) {
    warn("Frontend not found (out/ missing). API will work but UI won't load.");
    warn("If running from source, run: npm run build");
  }

  // Start single Express server (serves API + WebSocket + static frontend)
  const serverDir = path.join(quadworkDir, "server");
  if (!fs.existsSync(path.join(serverDir, "index.js"))) {
    fail("Server not found. Run from the quadwork directory.");
    process.exit(1);
  }

  // Start AgentChattr for each project from its own per-project clone.
  // Phase 2E / #181: each project entry now has agentchattr_dir, set by
  // the wizards in #184/#185. Resolve per-project so two projects with
  // their own clones (and their own ports) can run side by side without
  // sharing a single global install. Falls back to the legacy global
  // install dir for v1 entries that have not been migrated yet (#188).
  const acPids = [];
  const legacyAcDir = findAgentChattr(config.agentchattr_dir);
  for (const project of config.projects) {
    if (!project.working_dir) continue;
    const projectAcDir = findAgentChattr(project.agentchattr_dir) || legacyAcDir;
    if (!projectAcDir) continue;
    // config.toml lives at the clone ROOT for new projects; legacy v1
    // setups still keep it under <working_dir>/agentchattr/config.toml.
    const perProjectToml = path.join(projectAcDir, "config.toml");
    const legacyToml = path.join(project.working_dir, "agentchattr", "config.toml");
    const configToml = fs.existsSync(perProjectToml)
      ? perProjectToml
      : (fs.existsSync(legacyToml) ? legacyToml : null);
    if (!configToml) continue;
    const acSpawn = chattrSpawnArgs(projectAcDir, ["--config", configToml]);
    if (!acSpawn) continue;
    const acProc = spawn(acSpawn.command, acSpawn.spawnArgs, {
      cwd: acSpawn.cwd,
      stdio: "ignore",
      detached: true,
    });
    acProc.on("error", () => {});
    acProc.unref();
    if (acProc.pid) {
      ok(`AgentChattr started for ${project.id} from ${projectAcDir} (PID: ${acProc.pid})`);
      acPids.push(acProc.pid);
    }
  }

  // Open dashboard in browser after a short delay
  const dashboardUrl = `http://127.0.0.1:${port}`;
  const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  setTimeout(() => {
    try { execSync(`${openCmd} ${dashboardUrl}`, { stdio: "ignore" }); } catch {}
  }, 1500);

  // Graceful shutdown on Ctrl+C
  process.on("SIGINT", () => {
    console.log("");
    log("Shutting down...");
    for (const pid of acPids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    ok("Stopped.");
    console.log("");
    log("To restart:");
    log(`  ${c.dim}npx --yes quadwork start${c.reset}`);
    console.log("");
    process.exit(0);
  });

  // Run server in foreground
  log(`Dashboard: ${dashboardUrl}`);
  log("Press Ctrl+C to stop.\n");
  require(path.join(serverDir, "index.js"));
}

// ─── Stop Command ───────────────────────────────────────────────────────────

function stopPid(name, pidFileName) {
  const pidFile = path.join(CONFIG_DIR, pidFileName);
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    try {
      process.kill(pid, "SIGTERM");
      ok(`Stopped ${name} (PID: ${pid})`);
    } catch {
      warn(`${name} process ${pid} not running`);
    }
    fs.unlinkSync(pidFile);
    return true;
  }
  return false;
}

function cmdStop() {
  console.log("\n  QuadWork Stop\n");

  let stopped = 0;
  if (stopPid("Telegram bridge", "telegram-bridge.pid")) stopped++;

  // Stop per-project AgentChattr instances
  const config = readConfig();
  for (const project of (config.projects || [])) {
    if (stopPid(`AgentChattr (${project.id})`, `agentchattr-${project.id}.pid`)) stopped++;
  }
  // Also stop legacy single-instance PID if present
  if (stopPid("AgentChattr", "agentchattr.pid")) stopped++;

  if (stopPid("Server", "server.pid")) stopped++;

  // Stop caffeinate via the running server's API (targets only QuadWork's instance)
  if (process.platform === "darwin") {
    const cfg = readConfig();
    const qwPort = cfg.port || 8400;
    try {
      const result = run(`curl -s -X POST http://127.0.0.1:${qwPort}/api/caffeinate/stop 2>/dev/null`);
      if (result && result.includes('"ok":true')) {
        ok("Stopped caffeinate (sleep prevention)");
        stopped++;
      }
    } catch {}
  }

  if (stopped === 0) warn("No running processes found");
  else ok(`Stopped ${stopped} process(es)`);
  log("");
}

// ─── Add Project Command ────────────────────────────────────────────────────

async function cmdAddProject() {
  console.log("\n  QuadWork — Add Project\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const repo = await setupGitHub(rl);
    if (!repo) { rl.close(); process.exit(1); }

    const setup = await setupAgents(rl, repo);
    if (!setup) { rl.close(); process.exit(1); }

    writeQuadWorkConfig(setup);

    // Phase 2C / #181: config.toml lives at the per-project clone ROOT
    // because AgentChattr's run.py loads ROOT/config.toml and ignores
    // --config. Must match the install path used inside
    // writeAgentChattrConfig(): CONFIG_DIR/{projectName}/agentchattr.
    const configTomlPath = path.join(CONFIG_DIR, setup.projectName, "agentchattr", "config.toml");
    writeAgentChattrConfig(setup, configTomlPath);

    header("Project Added");
    log(`Project:      ${setup.projectName}`);
    log(`Repo:         ${setup.repo}`);
    log(`Worktrees:    ${AGENTS.map((a) => `${a}/`).join(", ")}`);
    log("");

    rl.close();
  } catch (err) {
    fail(err.message);
    rl.close();
    process.exit(1);
  }
}

// ─── Cleanup Command (#181 sub-H) ───────────────────────────────────────────

/**
 * Reclaim disk space taken by per-project AgentChattr clones (~77 MB each)
 * or by the legacy shared install left behind after migration (#188).
 *
 * Usage:
 *   npx quadwork cleanup --project <id>
 *     Removes ~/.quadwork/{id}/ and the matching entry from config.json.
 *     Leaves the user's worktrees and source repos completely alone.
 *
 *   npx quadwork cleanup --legacy
 *     Removes the legacy shared ~/.quadwork/agentchattr/ install. Refuses
 *     to run unless every project in config.json already has its own
 *     working per-project clone (so nothing falls back onto the legacy
 *     install via #186's resolution ladder).
 *
 * Both modes prompt for confirmation before deleting.
 */
async function cmdCleanup() {
  const args = process.argv.slice(3);
  const projectFlagIdx = args.indexOf("--project");
  const projectId = projectFlagIdx >= 0 ? args[projectFlagIdx + 1] : null;
  const legacy = args.includes("--legacy");

  if (!projectId && !legacy) {
    console.log(`
  Usage:
    npx quadwork cleanup --project <id>   Remove a project's AgentChattr clone + config entry
    npx quadwork cleanup --legacy         Remove the legacy ~/.quadwork/agentchattr/ install
`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const config = readConfig();

    // --- Per-project cleanup ---
    if (projectId) {
      const idx = (config.projects || []).findIndex((p) => p.id === projectId);
      const projectDir = path.join(CONFIG_DIR, projectId);
      if (idx < 0 && !fs.existsSync(projectDir)) {
        warn(`No project '${projectId}' in config and no directory at ${projectDir}.`);
        return;
      }
      header(`Cleanup: ${projectId}`);
      if (fs.existsSync(projectDir)) log(`  Directory: ${projectDir}`);
      if (idx >= 0) log(`  Config entry: ${projectId} (${config.projects[idx].repo || "no repo"})`);
      log("  Worktrees and source repos will NOT be touched.");
      const confirm = await askYN(rl, `Delete ${projectDir} and remove the config entry?`, false);
      if (!confirm) { warn("Aborted."); return; }

      if (fs.existsSync(projectDir)) {
        try { fs.rmSync(projectDir, { recursive: true, force: true }); ok(`Removed ${projectDir}`); }
        catch (e) { fail(`Could not remove ${projectDir}: ${e.message}`); return; }
      }
      if (idx >= 0) {
        config.projects.splice(idx, 1);
        try { writeConfig(config); ok(`Updated ${CONFIG_PATH}`); }
        catch (e) { fail(`Could not write config: ${e.message}`); return; }
      }
      return;
    }

    // --- Legacy cleanup ---
    if (legacy) {
      const legacyDir = path.join(CONFIG_DIR, "agentchattr");
      if (!fs.existsSync(legacyDir)) {
        warn(`No legacy install at ${legacyDir}.`);
        return;
      }
      header("Cleanup: legacy ~/.quadwork/agentchattr/");

      // Refuse if any project still depends on the legacy install — i.e.
      // any project without its own working per-project clone (run.py +
      // venv + config.toml at ROOT). Mirrors #186's resolution ladder.
      const stillDepends = [];
      for (const p of config.projects || []) {
        if (!p.id) continue;
        const dir = p.agentchattr_dir || path.join(CONFIG_DIR, p.id, "agentchattr");
        const ok = fs.existsSync(path.join(dir, "run.py")) &&
                   fs.existsSync(path.join(dir, ".venv", "bin", "python")) &&
                   fs.existsSync(path.join(dir, "config.toml"));
        if (!ok) stillDepends.push(p.id);
      }
      if (stillDepends.length > 0) {
        fail(`Refusing to remove legacy install — these projects still depend on it:`);
        for (const id of stillDepends) console.log(`    - ${id}`);
        warn(`Run 'npx quadwork start' to migrate them (#188), then re-run cleanup --legacy.`);
        return;
      }

      log(`  Directory: ${legacyDir}`);
      log("  All projects already have their own per-project clones.");
      const confirm = await askYN(rl, `Delete ${legacyDir}?`, false);
      if (!confirm) { warn("Aborted."); return; }

      try { fs.rmSync(legacyDir, { recursive: true, force: true }); ok(`Removed ${legacyDir}`); }
      catch (e) { fail(`Could not remove ${legacyDir}: ${e.message}`); return; }
    }
  } finally {
    rl.close();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "init":
    cmdInit();
    break;
  case "start":
    cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "add-project":
    cmdAddProject();
    break;
  case "cleanup":
    cmdCleanup();
    break;
  default:
    console.log(`
  Usage: quadwork <command>

  Commands:
    init          Global setup (prereqs, port, backend) — then open web UI
    start         Start the QuadWork dashboard and backend
    stop          Stop all QuadWork processes
    add-project   Add a project via CLI (alternative to web UI /setup)
    cleanup       Reclaim disk space (--project <id> or --legacy)

  Workflow:
    1. npx quadwork init     — one-time global setup, opens dashboard
    2. Open /setup in browser — create projects with guided web UI
    3. npx quadwork stop     — stop everything when done

  Examples:
    npx quadwork init
    npx quadwork start
    npx quadwork stop
    npx quadwork cleanup --project my-project
    npx quadwork cleanup --legacy
`);
    if (command) process.exit(1);
}
