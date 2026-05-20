#!/usr/bin/env node

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

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

function which(cmd) {
  return run("which", [cmd]) !== null;
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
  if (!fs.existsSync(CONFIG_DIR)) ensureSecureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
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
  const sp = spinner(`Installing ${name}...`);
  const [cmd, ...args] = cmdSpec;
  const result = run(cmd, args, { timeout: 120000 });
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
  log("A separate reviewer account lets RE1/RE2 approve PRs independently. You can set this up later in Settings.");
  const wantReviewer = await askYN(rl, "Use a separate GitHub account for reviewers (RE1/RE2)?", false);
  let reviewerUser = "";
  let reviewerTokenPath = "";
  if (wantReviewer) {
    log("GitHub username for the reviewer account (used in RE1/RE2 seed files for PR reviews).");
    reviewerUser = await ask(rl, "Reviewer GitHub username", "");
    log("Path to a file containing a GitHub PAT for the reviewer account.");
    reviewerTokenPath = await ask(rl, "Reviewer token file path", path.join(os.homedir(), ".quadwork", "reviewer-token"));
  }

  const projectName = path.basename(absDir);
  log(`Project: ${projectName}`);
  const wtSpinner = spinner("Creating worktrees and seeding files...");

  // Empty repos have no commits — git worktree add requires at least one.
  const headCheck = run("git", ["-C", absDir, "rev-parse", "HEAD"]);
  if (!headCheck || headCheck.includes("fatal")) {
    run("git", ["-C", absDir, "commit", "--allow-empty", "-m", "Initial commit (created by QuadWork setup)"]);
    const defaultBranch = run("git", ["-C", absDir, "symbolic-ref", "--short", "HEAD"]) || "main";
    run("git", ["-C", absDir, "push", "origin", defaultBranch]);
  }

  const worktrees = {};
  let wtFailed = null;
  for (const agent of AGENTS) {
    const wtDir = path.join(path.dirname(absDir), `${projectName}-${agent}`);
    if (!fs.existsSync(wtDir)) {
      const branchName = `worktree-${agent}`;
      run("git", ["-C", absDir, "branch", branchName, "HEAD"]);
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
      // Batch 25 / #205: substitute the per-project queue file path.
      seedContent = seedContent.replace(/\{\{project_name\}\}/g, projectName);
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

  if (setup.telegram) {
    project.telegram = {
      bot_token: setup.telegram.bot_token,
      chat_id: setup.telegram.chat_id,
      bridge_dir: setup.telegram.bridge_dir,
    };
  }

  // All new projects use file-based chat (AC is deprecated).
  project.chat_mode = "file";

  const existingIdx = config.projects.findIndex((p) => p.id === setup.projectName);

  // Batch 25 / #204: seed the per-project OVERNIGHT-QUEUE.md at
  // ~/.quadwork/{id}/OVERNIGHT-QUEUE.md. Idempotent — if the file
  // already exists, preserve the user's / Head agent's edits.
  writeOvernightQueueFile(setup.projectName, setup.repo);

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

  process.on("SIGINT", () => {
    console.log("");
    log("Shutting down...");
    try { serverExports && serverExports.shutdown && serverExports.shutdown(); }
    catch (e) { warn(`shutdown failed: ${e.message}`); }
    ok("Stopped.");
    console.log("");
    log("To restart:");
    log(`  ${c.dim}npx --yes quadwork start${c.reset}`);
    console.log("");
    process.exit(0);
  });
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
`);
    process.exit(1);
}
