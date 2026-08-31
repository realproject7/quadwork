#!/usr/bin/env node

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { injectModeForCommand } = require("../src/lib/injectMode.js");
const {
  readConfig: readSharedConfig,
  readRuntimeResources,
  updateConfig,
  withSerializedConfigWrite,
  commitV2Configuration,
  commitConfigurationSnapshot,
} = require("../server/config");
const { createReadOnlyProbes, runResourcePreflight } = require("../server/resource-preflight");
const { configureServiceTempEnvironment } = require("../server/resource-service-env");
const {
  resourceInstallFailureForError,
  policyProposal,
  applyPolicy,
  tempInstallProposal,
  applyTempInstall,
} = require("../server/resource-install");

// ─── Constants ──────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const AGENTS = ["head", "re1", "re2", "dev"];

// ─── Permission Helpers ────────────────────────────────────────────────────

function ensureSecureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

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

function run(cmd, args = [], opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
  } catch {
    return null;
  }
}

function runResult(cmd, args = [], opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf-8", stdio: "pipe", ...opts });
    return { ok: true, output: out.trim() };
  } catch (err) {
    return { ok: false, output: String(err.stderr || err.stdout || err.message || "").trim() };
  }
}

function which(cmd) {
  return run("which", [cmd]) !== null;
}

// #974: does a global `npm install -g` need sudo? True only when the npm
// global prefix dir exists and isn't writable by the current user. Windows
// never needs sudo; if the prefix can't be determined we keep the safe
// (sudo) default rather than risk an EACCES mid-install.
function npmGlobalNeedsSudo() {
  if (process.platform === "win32") return false;
  const prefix = run("npm", ["prefix", "-g"]);
  if (!prefix) return true;
  try {
    fs.accessSync(prefix, fs.constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

// #974: reduce a git remote URL to its canonical `owner/repo` slug so the
// entered repo can be compared against what a reused clone actually points at.
// Handles https://github.com/owner/repo(.git), git@github.com:owner/repo(.git),
// and ssh://… forms.
function repoSlugFromRemote(url) {
  if (!url) return "";
  const m = url.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1].toLowerCase() : "";
}

function ensureGitHeadForSetup(absDir, repo) {
  if (!fs.existsSync(path.join(absDir, ".git"))) {
    const clone = runResult("gh", ["repo", "clone", repo, absDir]);
    if (!clone.ok) return { ok: false, error: `Clone failed: ${clone.output}` };
  } else {
    const fetch = runResult("git", ["-C", absDir, "fetch", "origin", "--prune"]);
    if (!fetch.ok) return { ok: false, error: `Fetch failed: ${fetch.output}` };
  }

  // #974: fail clearly if the directory is a clone of a DIFFERENT repo than the
  // slug entered — otherwise setup silently seeds worktrees/branches into the
  // wrong project.
  const originUrl = runResult("git", ["-C", absDir, "remote", "get-url", "origin"]);
  if (originUrl.ok) {
    const actual = repoSlugFromRemote(originUrl.output);
    const expected = String(repo || "").toLowerCase().replace(/\.git$/, "");
    if (actual && expected && actual !== expected) {
      return { ok: false, error: `Origin mismatch: ${absDir} points to '${actual}', but you entered '${repo}'. Point setup at the matching clone or correct the repo slug.` };
    }
  }

  let headCheck = runResult("git", ["-C", absDir, "rev-parse", "--verify", "HEAD"]);
  if (!headCheck.ok) {
    const remoteHead = runResult("git", ["-C", absDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    let remoteBranch = remoteHead.ok ? remoteHead.output.replace(/^origin\//, "") : "";
    if (!remoteBranch) {
      for (const candidate of ["main", "master"]) {
        const hasBranch = runResult("git", ["-C", absDir, "rev-parse", "--verify", `origin/${candidate}`]);
        if (hasBranch.ok) { remoteBranch = candidate; break; }
      }
    }
    if (remoteBranch) {
      const checkout = runResult("git", ["-C", absDir, "checkout", "-B", remoteBranch, `origin/${remoteBranch}`]);
      if (!checkout.ok) return { ok: false, error: `Checkout failed after fetch: ${checkout.output}` };
      headCheck = runResult("git", ["-C", absDir, "rev-parse", "--verify", "HEAD"]);
    }
  }
  if (headCheck.ok) return { ok: true };

  const seed = runResult("git", [
    "-C", absDir,
    "-c", "user.name=QuadWork",
    "-c", "user.email=quadwork@localhost",
    "commit", "--allow-empty", "-m", "Initial commit (created by QuadWork setup)",
  ]);
  if (!seed.ok) return { ok: false, error: `Repository is empty and could not be initialized: ${seed.output}` };
  const branchResult = runResult("git", ["-C", absDir, "symbolic-ref", "--short", "HEAD"]);
  const defaultBranch = branchResult.ok ? branchResult.output : "main";
  const push = runResult("git", ["-C", absDir, "push", "origin", defaultBranch]);
  if (!push.ok) return { ok: false, error: `Initial commit created but push failed: ${push.output}` };
  return { ok: true };
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
    try { writeConfig(config); } catch {}
  }
  return config;
}

function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return migrateAgentKeys(config);
  } catch {
    return { port: 8400, projects: [] };
  }
}

function writeConfig(config) {
  // The shared transaction determines activation from the locked live file.
  // A caller cannot select the legacy branch by omitting installation_id from
  // a stale snapshot.
  return commitConfigurationSnapshot(config);
}

function projectRuntimeDirectory(projectId) {
  const reservedEntries = new Set([
    ".env",
    "agentchattr",
    "config.json",
    "config.lock",
    "reseed-state.json",
    "reviewer-token",
    "server.pid",
  ]);
  if (typeof projectId !== "string" || !projectId || projectId === "." || projectId === ".." || path.basename(projectId) !== projectId) {
    const error = new Error("project id must name one direct QuadWork config directory");
    error.code = "invalid_project_id";
    throw error;
  }
  if (reservedEntries.has(projectId)) {
    const error = new Error("project cleanup target is a reserved QuadWork control entry");
    error.code = "invalid_project_id";
    throw error;
  }
  const configRoot = path.resolve(CONFIG_DIR);
  const projectDir = path.resolve(CONFIG_DIR, projectId);
  if (path.dirname(projectDir) !== configRoot) {
    const error = new Error("project cleanup target is outside the QuadWork config directory");
    error.code = "invalid_project_id";
    throw error;
  }
  return projectDir;
}

function cleanupLegacyProjectAfterConfirmation(projectId) {
  const projectDir = projectRuntimeDirectory(projectId);
  let removedDirectory = false;
  let removedConfigEntry = false;
  updateConfig((fresh) => {
    if (Object.prototype.hasOwnProperty.call(fresh, "installation_id")) {
      const error = new Error("Activated V2 projects must be removed from the dashboard so lifecycle cleanup can run.");
      error.code = "v2_cleanup_requires_lifecycle";
      throw error;
    }
    const freshIdx = (fresh.projects || []).findIndex((project) => project.id === projectId);
    if (fs.existsSync(projectDir)) {
      const target = fs.lstatSync(projectDir);
      if (!target.isDirectory() || target.isSymbolicLink()) {
        const error = new Error("project cleanup target must be a real project directory");
        error.code = "invalid_project_cleanup_target";
        throw error;
      }
      fs.rmSync(projectDir, { recursive: true, force: true });
      removedDirectory = true;
    }
    if (freshIdx >= 0) {
      fresh.projects.splice(freshIdx, 1);
      removedConfigEntry = true;
    }
  });
  return { projectDir, removedDirectory, removedConfigEntry };
}

function legacyAgentChattrDependents(config) {
  const stillDepends = [];
  for (const project of config.projects || []) {
    if (!project.id) continue;
    const dir = project.agentchattr_dir || path.join(CONFIG_DIR, project.id, "agentchattr");
    const ready = fs.existsSync(path.join(dir, "run.py")) &&
      fs.existsSync(path.join(dir, ".venv", "bin", "python")) &&
      fs.existsSync(path.join(dir, "config.toml"));
    if (!ready) stillDepends.push(project.id);
  }
  return stillDepends;
}

function cleanupLegacyAgentChattrAfterConfirmation() {
  const legacyDir = path.join(CONFIG_DIR, "agentchattr");
  return withSerializedConfigWrite(() => {
    const fresh = readSharedConfig();
    const stillDepends = legacyAgentChattrDependents(fresh);
    if (stillDepends.length > 0) {
      const error = new Error("one or more projects still depend on the legacy AgentChattr install");
      error.code = "legacy_agentchattr_still_required";
      error.project_ids = stillDepends;
      throw error;
    }
    if (!fs.existsSync(legacyDir)) return { legacyDir, removed: false };
    const target = fs.lstatSync(legacyDir);
    if (!target.isDirectory() || target.isSymbolicLink()) {
      const error = new Error("legacy AgentChattr cleanup target must be a real directory");
      error.code = "invalid_legacy_cleanup_target";
      throw error;
    }
    fs.rmSync(legacyDir, { recursive: true, force: true });
    return { legacyDir, removed: true };
  });
}

// ─── Prerequisites ──────────────────────────────────────────────────────────

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
  const cmdSpec = typeof commands === "function" ? commands(platform) : commands;
  if (!cmdSpec) {
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
  const [cmd, ...args] = cmdSpec;
  // #974: install commands (esp. `sudo apt install …`) may prompt for a
  // password or a confirmation on the real TTY. The old `run()` piped stdio,
  // which swallows the prompt and hangs / fails silently — inherit stdio so
  // the operator can actually respond. No spinner here: it would fight the
  // inherited install output for the same stdout.
  log(`Installing ${name}...`);
  try {
    execFileSync(cmd, args, { stdio: "inherit", timeout: 120000 });
    ok(`${name} installed`);
    return true;
  } catch {
    warn(`Auto-install failed. You can install manually and try again.`);
    return false;
  }
}

async function checkPrereqs(rl) {
  header("Step 1: Prerequisites");
  const platform = detectPlatform();
  let allOk = true;

  // ── 1. Node.js 20+ (must already exist — user ran npx) ──
  const nodeVer = run("node", ["--version"]);
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

  // ── 3. GitHub CLI (independent) ──
  if (which("gh")) {
    ok("GitHub CLI (gh)");
  } else {
    console.log("");
    warn("GitHub CLI is required for agents to create branches, PRs, and reviews.");
    const ghCmd = (p) => {
      if (p === "macos") return ["brew", "install", "gh"];
      if (p === "linux-apt") return ["sudo", "apt", "install", "gh", "-y"];
      if (p === "linux-dnf") return ["sudo", "dnf", "install", "gh", "-y"];
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

  // #974: only escalate with sudo when the global npm prefix isn't writable by
  // the current user. Node from nvm/fnm/volta/Homebrew puts the prefix under a
  // user-owned dir where `sudo npm i -g` is unnecessary and often corrupts
  // ownership. Fall back to sudo only when the prefix genuinely needs root.
  const npmPrefix = npmGlobalNeedsSudo() ? "sudo " : "";

  // Offer to install Claude Code if missing
  if (!hasClaude) {
    const isRequired = !hasCodex;
    log("Claude Code — Anthropic's AI coding assistant");
    const installClaude = await askYN(rl, "Install Claude Code?", isRequired);
    if (installClaude) {
      log(`Running: ${npmPrefix}npm install -g @anthropic-ai/claude-code`);
      try {
        if (npmPrefix) {
          execFileSync("sudo", ["npm", "install", "-g", "@anthropic-ai/claude-code"], { stdio: "inherit", timeout: 120000 });
        } else {
          execFileSync("npm", ["install", "-g", "@anthropic-ai/claude-code"], { stdio: "inherit", timeout: 120000 });
        }
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
        if (npmPrefix) {
          execFileSync("sudo", ["npm", "install", "-g", "@openai/codex"], { stdio: "inherit", timeout: 120000 });
        } else {
          execFileSync("npm", ["install", "-g", "@openai/codex"], { stdio: "inherit", timeout: 120000 });
        }
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
    const ghAuth = run("gh", ["auth", "status"]);
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
      const claudeAuth = run("claude", ["auth", "status"]) || run("claude", ["--version"]);
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
      const codexAuth = run("codex", ["login", "status"]) || run("codex", ["--version"]);
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
  const authStatus = run("gh", ["auth", "status"]);
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
  const repoCheck = run("gh", ["repo", "view", repo, "--json", "name"]);
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
  log("(e.g., project-head/, project-re1/, project-re2/, project-dev/).");
  const projectDir = await ask(rl, "Project directory", process.cwd());
  const absDir = path.resolve(projectDir);

  // Prompt for reviewer credentials (optional)
  log("A separate reviewer account lets RE1/RE2 approve PRs independently. You can set this up later in Settings.");
  const wantReviewer = await askYN(rl, "Use a separate GitHub account for reviewers (RE1/RE2)?", false);
  let reviewerUser = "";
  let reviewerTokenPath = "";
  if (wantReviewer) {
    log("GitHub username for the reviewer account (used in RE1/RE2 seed files for PR reviews).");
    reviewerUser = await ask(rl, "Reviewer GitHub username", "");
    log("Path to a file containing a GitHub PAT for the reviewer account.");
    reviewerTokenPath = await ask(rl, "Reviewer token file path", path.join(os.homedir(), ".quadwork", "reviewer-token"));
    // #974: previously we collected the token PATH but never the token itself,
    // so RE1/RE2 launched pointed at an empty/nonexistent file and PR reviews
    // failed. Prompt for the token now and write it 0600 (matching the server
    // save-token endpoint); if the operator skips it, tell them exactly where
    // to add it later instead of silently leaving reviewing broken.
    const reviewerToken = await askSecret(rl, "Reviewer GitHub token (paste, or leave blank to set later in Settings)");
    if (reviewerToken.trim()) {
      try {
        const tokenDir = path.dirname(path.resolve(reviewerTokenPath));
        if (!fs.existsSync(tokenDir)) ensureSecureDir(tokenDir);
        fs.writeFileSync(reviewerTokenPath, reviewerToken.trim() + "\n", { mode: 0o600 });
        try { fs.chmodSync(reviewerTokenPath, 0o600); } catch {}
        ok(`Reviewer token saved to ${reviewerTokenPath} (mode 0600)`);
      } catch (err) {
        warn(`Could not write reviewer token to ${reviewerTokenPath}: ${err.message}`);
        log(`Add it later in Settings → Reviewer Account, or write it to ${reviewerTokenPath} yourself (chmod 600).`);
      }
    } else {
      log(`No token entered — add it later in Settings → Reviewer Account (it saves to ${reviewerTokenPath}, mode 0600).`);
    }
  }

  const projectName = path.basename(absDir);
  log(`Project: ${projectName}`);
  const wtSpinner = spinner("Creating worktrees and seeding files...");

  const ready = ensureGitHeadForSetup(absDir, repo);
  if (!ready.ok) {
    wtSpinner.stop(false);
    fail(ready.error);
    return null;
  }

  const worktrees = {};
  let wtFailed = null;
  for (const agent of AGENTS) {
    const wtDir = path.join(path.dirname(absDir), `${projectName}-${agent}`);
    if (!fs.existsSync(wtDir)) {
      const branchName = `worktree-${agent}`;
      // #974: a prior setup can leave the `worktree-<agent>` branch behind after
      // its directory was deleted. `git branch <name> HEAD` then fails "already
      // exists" and used to brick the whole re-run with no rollback. Reuse an
      // existing branch instead: prune any stale worktree registration still
      // holding it, then `worktree add` re-attaches. Only create the branch when
      // it doesn't already exist.
      const branchExists = runResult("git", ["-C", absDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`]).ok;
      if (branchExists) {
        run("git", ["-C", absDir, "worktree", "prune"]);
      } else {
        const branch = runResult("git", ["-C", absDir, "branch", branchName, "HEAD"]);
        if (!branch.ok) { wtFailed = `${agent}: branch failed: ${branch.output}`; break; }
      }
      const result = run("git", ["-C", absDir, "worktree", "add", wtDir, branchName]);
      if (!result) {
        const result2 = run("git", ["-C", absDir, "worktree", "add", "--detach", wtDir, "HEAD"]);
        if (!result2) { wtFailed = agent; break; }
      }
    }
    worktrees[agent] = wtDir;

    // Copy AGENTS.md seed with placeholder substitution
    const seedSrc = path.join(TEMPLATES_DIR, "seeds", `${agent}.AGENTS.md`);
    const seedDst = path.join(wtDir, "AGENTS.md");
    // #974: a missing seed template means the agent's role is undefined —
    // shipping a worktree with no AGENTS.md is worse than failing. Hard-fail
    // instead of silently skipping (matches the server seed-files route).
    if (!fs.existsSync(seedSrc)) {
      wtFailed = `${agent}: missing AGENTS.md seed template (templates/seeds/${agent}.AGENTS.md)`;
      break;
    }
    {
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
      // Batch 25 / #205: substitute the per-project queue file path.
      seedContent = seedContent.replace(/\{\{project_name\}\}/g, projectName);
      seedContent = seedContent.replace(/\{\{project_id\}\}/g, projectName);
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

// ─── Write QuadWork Config ──────────────────────────────────────────────────

/**
 * Seed ~/.quadwork/{projectName}/OVERNIGHT-QUEUE.md from templates/.
 * Idempotent — never overwrites an existing file so user and Head
 * agent edits are preserved across re-runs.
 */
function writeOvernightQueueFile(projectName, repo) {
  const queueDir = path.join(CONFIG_DIR, projectName);
  const queuePath = path.join(queueDir, "OVERNIGHT-QUEUE.md");
  if (fs.existsSync(queuePath)) return false;
  try { ensureSecureDir(queueDir); }
  catch (e) { warn(`Could not create ${queueDir}: ${e.message}`); return false; }
  const templatePath = path.join(TEMPLATES_DIR, "OVERNIGHT-QUEUE.md");
  if (!fs.existsSync(templatePath)) {
    warn(`OVERNIGHT-QUEUE.md template missing at ${templatePath}`);
    return false;
  }
  let content = fs.readFileSync(templatePath, "utf-8");
  content = content.replace(/\{\{project_name\}\}/g, projectName || "");
  content = content.replace(/\{\{repo\}\}/g, repo || "");
  fs.writeFileSync(queuePath, content);
  ok(`Wrote ${queuePath}`);
  return true;
}

/**
 * Seed the versioned Head PO playbook beside the project queue. Idempotent:
 * existing operator content is preserved on CLI setup; server reseed owns
 * version refreshes.
 */
function writeHeadPoPlaybook(projectName) {
  const playbookDir = path.join(CONFIG_DIR, projectName);
  const playbookPath = path.join(playbookDir, "HEAD-PO-PLAYBOOK.md");
  if (fs.existsSync(playbookPath)) return false;
  try { ensureSecureDir(playbookDir); }
  catch (e) { warn(`Could not create ${playbookDir}: ${e.message}`); return false; }
  const templatePath = path.join(TEMPLATES_DIR, "seeds", "HEAD-PO-PLAYBOOK.md");
  if (!fs.existsSync(templatePath)) {
    warn(`HEAD-PO-PLAYBOOK.md template missing at ${templatePath}`);
    return false;
  }
  const content = fs.readFileSync(templatePath, "utf-8")
    .replace(/\{\{project_id\}\}/g, projectName || "")
    .replace(/\{\{project_name\}\}/g, projectName || "");
  fs.writeFileSync(playbookPath, content);
  ok(`Wrote ${playbookPath}`);
  return true;
}

function writeQuadWorkConfig(setup) {
  header("Writing QuadWork Config");

  const config = readConfig();
  // #405 / quadwork#278: ensure the global config has an
  // operator_name slot. /api/chat reads this on every send and
  // sanitizes empty/missing values back to "user", so leaving it
  // unset is safe — but writing the default explicitly makes the
  // setting discoverable in the on-disk file.
  if (typeof config.operator_name !== "string") {
    config.operator_name = "user";
  }

  const project = {
    id: setup.projectName,
    name: setup.projectName,
    agents: {},
  };
  const activated = typeof config.installation_id === "string";
  if (activated) {
    project.repositories = [{
      key: "primary",
      repo: setup.repo,
      working_dir: setup.absDir,
      primary: true,
    }];
  } else {
    project.repo = setup.repo;
    project.working_dir = setup.absDir;
  }

  for (const agent of AGENTS) {
    const cmd = (setup.backends && setup.backends[agent]) || setup.backend;
    const injectMode = injectModeForCommand(cmd);
    project.agents[agent] = {
      cwd: setup.worktrees[agent],
      command: cmd,
      auto_approve: true,
      mcp_inject: injectMode,
    };
  }

  if (setup.telegram) {
    project.telegram = {
      bot_token: setup.telegram.bot_token,
      chat_id: setup.telegram.chat_id,
      bridge_dir: setup.telegram.bridge_dir,
    };
  }

  // All new projects use file-based chat (AC is deprecated).
  project.chat_mode = "file";

  // Batch 25 / #204: seed the per-project OVERNIGHT-QUEUE.md at
  // ~/.quadwork/{id}/OVERNIGHT-QUEUE.md. Idempotent — if the file
  // already exists, preserve the user's / Head agent's edits.
  writeOvernightQueueFile(setup.projectName, setup.repo);
  writeHeadPoPlaybook(setup.projectName);

  if (activated) {
    // Re-enter the shared fresh-read/validate/atomic-write boundary instead of
    // publishing the wizard's stale whole-document snapshot. In particular,
    // replacing an archived project would be a true→active transition and is
    // rejected without the server lifecycle's cleanup reservation token, even
    // though this CLI is a separate process.
    commitV2Configuration((fresh) => {
      if (typeof fresh.operator_name !== "string") fresh.operator_name = "user";
      const existingIdx = fresh.projects.findIndex((entry) => entry.id === setup.projectName);
      if (existingIdx >= 0) fresh.projects[existingIdx] = project;
      else fresh.projects.push(project);
    });
  } else {
    const existingIdx = config.projects.findIndex((entry) => entry.id === setup.projectName);
    if (existingIdx >= 0) config.projects[existingIdx] = project;
    else config.projects.push(project);
    writeConfig(config);
  }
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

    // #573: Install phase complete — do NOT start the server.
    rl.close();

    console.log("");
    console.log(`  ${c.cyan}${c.bold}╔══════════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.green}${c.bold}Setup complete!${c.reset}                                     ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   Prerequisites installed. Config written.                ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.green}Next step:${c.reset}                                             ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}     ${c.cyan}${c.bold}npx quadwork start${c.reset}                                 ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   This launches the dashboard where you can create        ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}   projects and start your AI agent team.                  ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                          ${c.cyan}${c.bold}║${c.reset}`);
    console.log(`  ${c.cyan}${c.bold}╚══════════════════════════════════════════════════════════╝${c.reset}`);
    console.log("");
  } catch (err) {
    fail(err.message);
    rl.close();
    process.exit(1);
  }
}

// ─── Start Command ──────────────────────────────────────────────────────────



async function cmdStart() {
  console.log("\n  QuadWork Start\n");

  // #1038: before loading the server (and therefore before any agent/control
  // child spawn), re-verify the explicitly installed service temp root. This
  // path is read-only and never blocks the diagnostic control plane.
  const serviceTempFact = configureServiceTempEnvironment();
  if (serviceTempFact.status === "ready") {
    ok(`Resource temp environment verified [${serviceTempFact.code}]; containment_ready=false (service temp only).`);
  } else {
    warn(`Resource temp environment unavailable [${serviceTempFact.code}]; dashboard diagnostics remain online; containment_ready=false.`);
  }

  const config = readConfig();
  if (config.projects.length === 0) {
    warn("No projects configured yet. Create one at the setup page.");
  }

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

  // Open dashboard in browser after a short delay
  const dashboardUrl = `http://127.0.0.1:${port}`;
  setTimeout(() => {
    try {
      if (process.platform === "win32") {
        execFileSync("cmd", ["/c", "start", dashboardUrl], { stdio: "ignore" });
      } else {
        execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [dashboardUrl], { stdio: "ignore" });
      }
    } catch {}
  }, 1500);

  // Run server in foreground. Capture exports so the SIGINT handler
  // can call shutdown() for a clean exit.
  log(`Dashboard: ${dashboardUrl}`);
  log("Press Ctrl+C to stop.\n");
  const serverExports = require(path.join(serverDir, "index.js"));

  // #972: record the server PID so `quadwork stop` (which reads server.pid)
  // actually finds this in-foreground process. Removed again on exit.
  const serverPidFile = path.join(CONFIG_DIR, "server.pid");
  try {
    if (!fs.existsSync(CONFIG_DIR)) ensureSecureDir(CONFIG_DIR);
    fs.writeFileSync(serverPidFile, String(process.pid));
  } catch (e) { warn(`could not write server.pid: ${e.message}`); }

  let shuttingDown = false;
  const cleanExit = () => {
    if (shuttingDown) return; // idempotent: SIGINT then SIGTERM
    shuttingDown = true;
    console.log("");
    log("Shutting down...");
    try { serverExports && serverExports.shutdown && serverExports.shutdown(); }
    catch (e) { warn(`shutdown failed: ${e.message}`); }
    try { fs.unlinkSync(serverPidFile); } catch {}
    ok("Stopped.");
    console.log("");
    log("To restart:");
    log(`  ${c.dim}npx --yes quadwork start${c.reset}`);
    console.log("");
    process.exit(0);
  };

  // #972: handle SIGTERM too so `quadwork stop` gets the same clean shutdown
  // (agent PTYs + caffeinate + timers) as Ctrl+C, not a bare process kill.
  process.on("SIGINT", cleanExit);
  process.on("SIGTERM", cleanExit);
}

// ─── Stop Command ───────────────────────────────────────────────────────────

// #972: a corrupt PID file ("0", "-1", "abc", "") must never reach
// process.kill — process.kill(0) / kill(-n) signals the CALLER's process group,
// so a garbage file would take down `quadwork stop` itself. Returns a positive
// integer PID, or null when the content isn't one.
function sanitizePid(raw) {
  const pid = Number(String(raw).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function stopPid(name, pidFileName) {
  const pidFile = path.join(CONFIG_DIR, pidFileName);
  if (!fs.existsSync(pidFile)) return false;
  const pid = sanitizePid(fs.readFileSync(pidFile, "utf-8"));
  if (pid === null) {
    // #972: never signal on a corrupt PID; just clean the stale file.
    warn(`${name}: ignoring corrupt PID file (${pidFileName})`);
    try { fs.unlinkSync(pidFile); } catch {}
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    ok(`Stopped ${name} (PID: ${pid})`);
  } catch {
    warn(`${name} process ${pid} not running`);
  }
  // #972: a failed unlink must not abort the rest of cmdStop.
  try { fs.unlinkSync(pidFile); } catch {}
  return true;
}

function cmdStop() {
  console.log("\n  QuadWork Stop\n");

  let stopped = 0;
  if (stopPid("Telegram bridge", "tg-bridge.pid")) stopped++;

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
      const result = run("curl", ["-s", "-X", "POST", `http://127.0.0.1:${qwPort}/api/caffeinate/stop`]);
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
      if (typeof config.installation_id === "string") {
        fail("Activated V2 projects must be removed from the dashboard so lifecycle cleanup can run.");
        return;
      }
      const idx = (config.projects || []).findIndex((p) => p.id === projectId);
      let projectDir;
      try { projectDir = projectRuntimeDirectory(projectId); }
      catch (error) { fail(error.message); return; }
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

      let cleanup;
      try {
        // Confirmation is an await boundary. Re-read under the shared config
        // lock before any deletion so activation or a concurrent V1 edit during
        // the prompt cannot turn this legacy command into a V2 lifecycle bypass.
        cleanup = cleanupLegacyProjectAfterConfirmation(projectId);
      } catch (error) {
        fail(error?.code === "v2_cleanup_requires_lifecycle"
          ? error.message
          : `Could not clean up project: ${error.message}`);
        return;
      }
      if (cleanup.removedDirectory) ok(`Removed ${cleanup.projectDir}`);
      if (cleanup.removedConfigEntry) ok(`Updated ${CONFIG_PATH}`);
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
      const stillDepends = legacyAgentChattrDependents(config);
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

      try {
        const cleanup = cleanupLegacyAgentChattrAfterConfirmation();
        if (cleanup.removed) ok(`Removed ${cleanup.legacyDir}`);
      } catch (error) {
        if (error?.code === "legacy_agentchattr_still_required") {
          fail("Refusing to remove legacy install — these projects still depend on it:");
          for (const id of error.project_ids) console.log(`    - ${id}`);
          warn(`Run 'npx quadwork start' to migrate them (#188), then re-run cleanup --legacy.`);
        } else {
          fail(`Could not remove ${legacyDir}: ${error.message}`);
        }
        return;
      }
    }
  } finally {
    rl.close();
  }
}

// ─── Resource Preflight (#1038) ────────────────────────────────────────────

const RESOURCE_PREFLIGHT_USAGE = [
  "Usage: quadwork resources preflight [--json]",
  "       quadwork resources configure [--apply] --policy-file ABS [--accept-sha256 HASH] [--json]",
  "       quadwork resources temp-install [--apply] [--accept-sha256 HASH] [--json]",
].join("\n");
const RESOURCE_CONFIGURE_USAGE = "Usage: quadwork resources configure [--apply] --policy-file ABS [--accept-sha256 HASH] [--json]";
const RESOURCE_TEMP_INSTALL_USAGE = "Usage: quadwork resources temp-install [--apply] [--accept-sha256 HASH] [--json]";

function renderBooleanFact(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unavailable";
}

function renderIntegerFact(value, suffix = "", allowNegative = false) {
  return Number.isSafeInteger(value) && (allowNegative || value >= 0) ? `${value}${suffix}` : "unavailable";
}

function renderOomPolicy(value) {
  return value === "continue" || value === "unverified" ? value : "unavailable";
}

function renderResourcePreflight(report) {
  const policy = report.policy || {};
  const host = report.host || {};
  const containment = report.containment || {};
  const temp = report.temp || {};
  const api = report.api || {};
  const scopes = report.scopes || {};
  const capacity = report.capacity || {};
  const mib = (value) => renderIntegerFact(value, " MiB");
  const signedMib = (value) => renderIntegerFact(value, " MiB", true);
  const lines = [
    "QuadWork resource preflight",
    "===========================",
    `Status: ${report.ok ? "PASS" : "FAIL"}`,
    `Primary reason: ${report.reason}`,
    `Policy configured: ${renderBooleanFact(policy.configured)}`,
    `Configured API limits: low ${mib(policy.apiMemoryLowMib)}; max ${mib(policy.apiMemoryMaxMib)}`,
    `Configured worker limits: high ${mib(policy.workerMemoryHighMib)}; max ${mib(policy.workerMemoryMaxMib)}; swap max ${mib(policy.workerSwapMaxMib)}`,
    `Configured control limits: max ${mib(policy.controlMemoryMaxMib)}; swap max ${mib(policy.controlSwapMaxMib)}; concurrent children ${renderIntegerFact(policy.maxConcurrentChildren)}`,
    `Configured host reserve: ${mib(policy.hostReserveMib)}`,
    `Configured worker scope ceiling: ${renderIntegerFact(policy.maxWorkerScopes)}`,
    `Configured temp free threshold: ${mib(policy.tempMinFreeMib)}`,
    `Host memory: available ${mib(host.availableMib)}; total ${mib(host.totalMib)}`,
    `Host swap: free ${mib(host.swapFreeMib)}; total ${mib(host.swapTotalMib)}`,
    `Containment: cgroup v2 ${renderBooleanFact(containment.cgroupV2)}; user manager ${renderBooleanFact(containment.userManager)}; systemd-run ${renderBooleanFact(containment.systemdRun)}; scope proof ${renderBooleanFact(containment.scopeProof)}`,
    `Temp root: exists ${renderBooleanFact(temp.exists)}; directory ${renderBooleanFact(temp.directory)}; symlink ${renderBooleanFact(temp.symlink)}; owned ${renderBooleanFact(temp.owned)}; mode 0700 ${renderBooleanFact(temp.secureMode)}; disk-backed ${renderBooleanFact(temp.diskBacked)}`,
    `Temp capacity: free ${mib(temp.freeMib)}; total ${mib(temp.totalMib)}`,
    `Observed API limits: low ${mib(api.memoryLowMib)}; max ${mib(api.memoryMaxMib)}; OOM policy ${renderOomPolicy(api.oomPolicy)}; separate from workers ${renderBooleanFact(api.separateFromWorkers)}`,
    `Worker scopes: ${renderIntegerFact(scopes.admitted)} active; ${renderIntegerFact(scopes.requested)} requested; ${renderIntegerFact(scopes.staticCeiling)} static ceiling`,
    `Static RAM reservation: ${mib(capacity.staticReservationMib)}`,
    `Static RAM headroom: ${mib(capacity.staticHeadroomMib)}`,
    `Configured swap reservation: ${mib(capacity.configuredSwapMib)}`,
    `Configured swap headroom: ${mib(capacity.swapHeadroomMib)}`,
    `Requested worker RAM: ${mib(capacity.requestedMemoryMib)}`,
    `Requested worker swap: ${mib(capacity.requestedSwapMib)}`,
    `Live RAM reserve plus request: ${mib(capacity.liveRequiredMib)}`,
    `Live RAM headroom: ${signedMib(capacity.liveHeadroomMib)}`,
    `Live swap headroom: ${signedMib(capacity.liveSwapHeadroomMib)}`,
  ];
  if (Array.isArray(report.reasons) && report.reasons.length > 0) {
    lines.push("Checks:");
    for (const reason of report.reasons) {
      lines.push(`  - ${reason.code}/${reason.check}: ${reason.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseResourceInstallArgs(args, { needsPolicyFile }) {
  const parsed = { apply: false, json: false, policyFile: null, acceptanceSha256: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--apply" || flag === "--json") {
      if (seen.has(flag)) return null;
      seen.add(flag);
      parsed[flag === "--apply" ? "apply" : "json"] = true;
      continue;
    }
    if (flag === "--policy-file" || flag === "--accept-sha256") {
      if (seen.has(flag) || index + 1 >= args.length) return null;
      seen.add(flag);
      const value = args[++index];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return null;
      parsed[flag === "--policy-file" ? "policyFile" : "acceptanceSha256"] = value;
      continue;
    }
    return null;
  }
  if (needsPolicyFile !== Boolean(parsed.policyFile)) return null;
  if (!parsed.apply && parsed.acceptanceSha256 !== null) return null;
  if (parsed.apply !== Boolean(parsed.acceptanceSha256)) return null;
  return parsed;
}

function renderResourceInstall(result) {
  const lines = [
    result.action === "configure_runtime_resources"
      ? "QuadWork resource policy"
      : "QuadWork resource temp root",
    "==============================",
    `Status: ${result.status.toUpperCase()}`,
    `Action: ${result.action}`,
    `Accept SHA-256: ${result.acceptance.sha256}`,
  ];
  if (result.policy) {
    lines.push("Validated policy:", JSON.stringify(result.policy, null, 2));
  }
  lines.push("Plan:", JSON.stringify(result.plan, null, 2));
  if (result.result) lines.push("Result:", JSON.stringify(result.result, null, 2));
  if (result.status === "proposal") {
    lines.push("No changes were made. Re-run with --apply and the exact SHA-256 token to apply this plan.");
  }
  return `${lines.join("\n")}\n`;
}

function renderResourceInstallFailure(code, recoveryEntries = [], recoveryScope = null) {
  const lines = [`QuadWork resource operation refused: ${code}`];
  if (recoveryEntries.length > 0) {
    lines.push("Recovery entries (exact basenames; never use wildcards):");
    for (const entry of recoveryEntries) lines.push(`  - ${entry}`);
  }
  if (recoveryScope) lines.push(`Recovery scope: ${recoveryScope}`);
  return `${lines.join("\n")}\n`;
}

function runResourceInstallCommand(subcommand, args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const usage = subcommand === "configure" ? RESOURCE_CONFIGURE_USAGE : RESOURCE_TEMP_INSTALL_USAGE;
  const parsed = parseResourceInstallArgs(args, { needsPolicyFile: subcommand === "configure" });
  if (!parsed) {
    stderr.write(`${usage}\n`);
    return 2;
  }

  let result;
  try {
    if (subcommand === "configure") {
      result = parsed.apply
        ? (options.applyPolicy || applyPolicy)({ policyFile: parsed.policyFile, acceptanceSha256: parsed.acceptanceSha256 })
        : (options.policyProposal || policyProposal)(parsed.policyFile);
    } else {
      result = parsed.apply
        ? (options.applyTempInstall || applyTempInstall)({ acceptanceSha256: parsed.acceptanceSha256 })
        : (options.tempInstallProposal || tempInstallProposal)();
    }
  } catch (err) {
    const errorState = resourceInstallFailureForError(err);
    const reason = errorState ? errorState.reason : "resource_operation_failed";
    const recoveryEntries = errorState ? errorState.recoveryEntries : [];
    const recoveryScope = errorState ? errorState.recoveryScope : null;
    const failure = Object.freeze({
      ok: false,
      status: "refused",
      reason,
      ...(recoveryEntries.length > 0 ? { recovery_entries: recoveryEntries } : {}),
      ...(recoveryScope ? { recovery_scope: recoveryScope } : {}),
    });
    if (parsed.json) stdout.write(`${JSON.stringify(failure)}\n`);
    else stderr.write(renderResourceInstallFailure(reason, recoveryEntries, recoveryScope));
    return 1;
  }
  stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : renderResourceInstall(result));
  return 0;
}

// Minimal injectable handler: the command never imports config writers and
// never accepts a flag that could fabricate the still-pending staging proof.
function runResourcesCommand(args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const loadPolicy = options.readRuntimeResources || readRuntimeResources;
  const makeProbes = options.createReadOnlyProbes || createReadOnlyProbes;
  const preflight = options.runResourcePreflight || runResourcePreflight;
  const commandArgs = Array.isArray(args) ? args : [];

  if (commandArgs[0] === "configure" || commandArgs[0] === "temp-install") {
    return runResourceInstallCommand(commandArgs[0], commandArgs.slice(1), options);
  }

  if (commandArgs[0] !== "preflight"
    || commandArgs.slice(1).some((arg) => arg !== "--json")
    || commandArgs.filter((arg) => arg === "--json").length > 1) {
    stderr.write(`${RESOURCE_PREFLIGHT_USAGE}\n`);
    return 2;
  }

  const json = commandArgs.includes("--json");
  let report;
  try {
    const runtimeResources = loadPolicy();
    // scopeProof deliberately defaults false. There is no CLI override until
    // the fixed PTY/systemd staging matrix has established real proof.
    const probes = makeProbes();
    report = preflight({ runtimeResources, probes });
  } catch {
    // Reduce config/read failures to the same redacted typed policy failure.
    // A non-object sentinel makes the canonical preflight parser fail closed.
    report = runResourcePreflight({ runtimeResources: false, probes: Object.freeze({}) });
  }

  stdout.write(json ? `${JSON.stringify(report)}\n` : renderResourcePreflight(report));
  return report.ok ? 0 : 1;
}

function cmdResources() {
  process.exitCode = runResourcesCommand(process.argv.slice(3));
}

// ─── Doctor ─────────────────────────────────────────────────────────────────

function cmdDoctor() {
  console.log("");
  console.log("QuadWork doctor");
  console.log("===============");
  console.log("Chat mode: file-based (AC removed)");
  console.log("");
  try {
    const cfg = readConfig();
    const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
    if (projects.length === 0) {
      console.log("  (no projects in config.json)");
    }
    for (const p of projects) {
      const chatMode = p.chat_mode || "file";
      console.log(`  project:${p.id || "(unnamed)"} chat_mode=${chatMode} working_dir=${p.working_dir || "(not set)"}`);
    }
  } catch (err) {
    console.log(`  (could not enumerate projects: ${err.message})`);
  }
  console.log("");
}

// ─── Migrate Agent Slugs ────────────────────────────────────────────────────

/**
 * One-shot migration: rename reviewer1/reviewer2 → re1/re2 in
 * ~/.quadwork/config.json and per-project AgentChattr config.toml files.
 * Idempotent — skips projects that already use the new slugs.
 *
 * Does NOT rename worktree directories; instead adds a worktree_suffix
 * field so re1 maps to the existing project-reviewer1 dir for legacy
 * projects. New projects created after this version will use re1/re2
 * directory names directly.
 *
 * Does NOT rewrite chat history — old messages keep their original sender.
 */
async function cmdMigrateAgentSlugs() {
  header("Migrate Agent Slugs (reviewer1/reviewer2 → re1/re2)");

  const config = readConfig();
  if (!config.projects || config.projects.length === 0) {
    warn("No projects found in config. Nothing to migrate.");
    return;
  }

  const SLUG_MAP = { reviewer1: "re1", reviewer2: "re2" };
  const LABEL_MAP = { head: "Lead", dev: "Builder", re1: "Reviewer 1", re2: "Reviewer 2" };

  let totalChanged = 0;

  for (const project of config.projects) {
    const changes = [];
    if (!project.agents) continue;

    // 1. Rename agent keys in config.json
    for (const [oldKey, newKey] of Object.entries(SLUG_MAP)) {
      if (project.agents[oldKey] && !project.agents[newKey]) {
        project.agents[newKey] = { ...project.agents[oldKey] };
        delete project.agents[oldKey];
        changes.push(`  agents.${oldKey} → agents.${newKey}`);
      }
    }

    // 2. Add labels to all agents
    for (const [agentId, label] of Object.entries(LABEL_MAP)) {
      if (project.agents[agentId] && !project.agents[agentId].label) {
        project.agents[agentId].label = label;
        changes.push(`  agents.${agentId}.label = "${label}"`);
      }
    }

    // 3. Add worktree_suffix for legacy worktree dirs
    for (const [oldKey, newKey] of Object.entries(SLUG_MAP)) {
      if (project.agents[newKey] && !project.agents[newKey].worktree_suffix) {
        // Check if the worktree dir uses the old naming convention
        const cwd = project.agents[newKey].cwd || "";
        if (cwd.includes(`-${oldKey}`)) {
          project.agents[newKey].worktree_suffix = oldKey;
          changes.push(`  agents.${newKey}.worktree_suffix = "${oldKey}"`);
        }
      }
    }

    // 4. Rewrite stale slugs in worktree AGENTS.md and CLAUDE.md files (#479)
    const SEED_REPLACEMENTS = [
      [/@reviewer1/g, "@re1"],
      [/@reviewer2/g, "@re2"],
      [/@t2a/g, "@re1"],
      [/@t2b/g, "@re2"],
      [/@t1/g, "@head"],
      [/@t3/g, "@dev"],
      [/\breviewer1\b/g, "re1"],
      [/\breviewer2\b/g, "re2"],
    ];

    if (project.agents) {
      for (const [agentId, agentCfg] of Object.entries(project.agents)) {
        const wtDir = agentCfg.cwd;
        if (!wtDir || !fs.existsSync(wtDir)) continue;
        for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
          const filePath = path.join(wtDir, filename);
          if (!fs.existsSync(filePath)) continue;
          let content = fs.readFileSync(filePath, "utf-8");
          let fileChanged = false;
          for (const [pattern, replacement] of SEED_REPLACEMENTS) {
            const before = content;
            content = content.replace(pattern, replacement);
            if (content !== before) fileChanged = true;
          }
          if (fileChanged) {
            fs.writeFileSync(filePath, content);
            changes.push(`  rewritten: ${filePath}`);
          }
        }
      }
    }

    if (changes.length > 0) {
      ok(`Project "${project.id}" — ${changes.length} change(s):`);
      for (const c of changes) log(c);
      totalChanged++;
    } else {
      log(`Project "${project.id}" — already migrated, skipping.`);
    }
  }

  // Write updated config
  writeConfig(config);
  ok(`Config saved. ${totalChanged} project(s) migrated.`);
  log("");
  log("Next steps:");
  log("  1. Run 'npx quadwork start' to restart with the new slugs");
  log("  2. Old chat messages keep their original sender — no history rewrite");
}

// ─── ac-restore ────────────────────────────────────────────────────────────

function cmdAcRestore() {
  const args = process.argv.slice(3);
  const projectFlagIdx = args.indexOf("--project");
  const projectFilter = projectFlagIdx >= 0 ? args[projectFlagIdx + 1] : null;

  if (projectFlagIdx >= 0 && (!projectFilter || projectFilter.startsWith("--"))) {
    warn("--project requires a project ID. Usage: npx quadwork ac-restore --project <id>");
    process.exit(1);
  }

  if (projectFilter && !projectFilter.match(/^[\w-]+$/)) {
    warn("Invalid project ID.");
    process.exit(1);
  }

  const config = readConfig();

  if (projectFilter && !(config.projects || []).some((p) => p.id === projectFilter)) {
    warn(`Project '${projectFilter}' not found in config.`);
    process.exit(1);
  }

  const { runAcRestore } = require("../server/ac-restore");
  runAcRestore(config, projectFilter || null);
}

// ─── Main ───────────────────────────────────────────────────────────────────

// #972: run the CLI dispatch only when invoked directly, so tests can
// `require("../bin/quadwork")` for the pure helpers (sanitizePid, stopPid)
// without executing a command.
if (require.main === module) {
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
  case "doctor":
    cmdDoctor();
    break;
  case "resources":
    cmdResources();
    break;
  case "migrate-agent-slugs":
    cmdMigrateAgentSlugs();
    break;
  case "ac-restore":
    cmdAcRestore();
    break;
  case undefined: {
    // #573: No subcommand — smart default based on config state.
    // Config file exists (even with 0 projects) → start, so the user
    // can reach /setup to create their first project after init.
    // No config file at all → init wizard (true fresh install).
    if (fs.existsSync(CONFIG_PATH)) {
      cmdStart();
    } else {
      cmdInit();
    }
    break;
  }
  default:
    console.log(`
  Usage: quadwork <command>

  Commands:
    init          Run setup wizard (prereqs, port)
    start         Start the QuadWork dashboard and agents
    stop          Stop all QuadWork processes
    add-project   Add a project via CLI (alternative to web UI /setup)
    cleanup       Reclaim disk space (--project <id> or --legacy)
    doctor        Report project configuration status
    resources     Resource policy/temp setup and read-only preflight
    migrate-agent-slugs  Rename reviewer1/reviewer2 → re1/re2 in existing projects
    ac-restore           Restore file-chat JSONL back to AC format

  Workflow:
    1. npx quadwork init     — one-time setup (installs prerequisites)
    2. npx quadwork start    — launch dashboard, create projects, run agents
    3. npx quadwork stop     — stop everything when done

  Smart default:
    npx quadwork             — runs 'init' on fresh install, 'start' if configured

  Examples:
    npx quadwork init
    npx quadwork start
    npx quadwork stop
    npx quadwork cleanup --project my-project
    npx quadwork cleanup --legacy
    npx quadwork resources configure --policy-file /absolute/policy.json --json
    npx quadwork resources temp-install --json
    npx quadwork resources preflight --json
`);
    process.exit(1);
}
}

// #972: exported for unit tests (see server/binStop.test.js).
module.exports = {
  sanitizePid,
  stopPid,
  renderResourcePreflight,
  renderResourceInstall,
  runResourceInstallCommand,
  runResourcesCommand,
  cleanupLegacyProjectAfterConfirmation,
  cleanupLegacyAgentChattrAfterConfirmation,
  writeConfig,
  writeQuadWorkConfig,
  writeHeadPoPlaybook,
};
