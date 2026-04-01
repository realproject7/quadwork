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
const AGENTS = ["t1", "t2a", "t2b", "t3"];

// ─── ANSI Helpers ──────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function log(msg) { console.log(`  ${c.dim}${msg}${c.reset}`); }
function ok(msg) { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function warn(msg) { console.log(`  ${c.yellow}⚠ ${msg}${c.reset}`); }
function fail(msg) { console.error(`  ${c.red}✗ ${msg}${c.reset}`); }
function header(msg) { console.log(`\n  ${c.cyan}${c.bold}┌─ ${msg} ${"─".repeat(Math.max(0, 54 - msg.length))}┐${c.reset}\n`); }

function spinner(msg) {
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

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { port: 8400, agentchattr_url: "http://127.0.0.1:8300", projects: [] };
  }
}

function writeConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Prerequisites ──────────────────────────────────────────────────────────

let agentChattrFound = false;

function checkPrereqs() {
  header("Step 1: Prerequisites");
  let allOk = true;

  // Node.js 20+
  const nodeVer = run("node --version");
  if (nodeVer) {
    const major = parseInt(nodeVer.replace("v", "").split(".")[0], 10);
    if (major >= 20) ok(`Node.js ${nodeVer}`);
    else { fail(`Node.js ${nodeVer} — need 20+`); allOk = false; }
  } else { fail("Node.js not found"); allOk = false; }

  // Python 3.10+
  const pyVer = run("python3 --version");
  if (pyVer) {
    const parts = pyVer.replace("Python ", "").split(".");
    const minor = parseInt(parts[1], 10);
    if (parseInt(parts[0], 10) >= 3 && minor >= 10) ok(`${pyVer}`);
    else { fail(`${pyVer} — need 3.10+`); allOk = false; }
  } else { fail("Python 3 not found"); allOk = false; }

  // AgentChattr
  const acVer = run("agentchattr --version") || run("python3 -m agentchattr --version");
  if (acVer) { ok(`AgentChattr ${acVer}`); agentChattrFound = true; }
  else { warn("AgentChattr not found — install: pip install agentchattr"); allOk = false; }

  // gh CLI
  if (which("gh")) ok("GitHub CLI (gh)");
  else { fail("GitHub CLI not found — install: https://cli.github.com"); allOk = false; }

  // Claude Code or Codex
  const hasClaude = which("claude");
  const hasCodex = which("codex");
  if (hasClaude) ok("Claude Code");
  if (hasCodex) ok("Codex CLI");
  if (!hasClaude && !hasCodex) {
    fail("No AI CLI found — install Claude Code or Codex CLI");
    allOk = false;
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

  // Prompt for CLI backend
  const hasClaude = which("claude");
  const hasCodex = which("codex");
  let defaultBackend = hasClaude ? "claude" : "codex";
  log("Choose which AI CLI to run in agent terminals. Claude Code (`claude`) or OpenAI Codex (`codex`).");
  const backend = await ask(rl, "Default CLI backend (claude/codex)", defaultBackend);
  if (backend !== "claude" && backend !== "codex") {
    fail("Backend must be 'claude' or 'codex'");
    return null;
  }

  // Per-agent backend selection
  const backends = {};
  const customPerAgent = await askYN(rl, "Use same backend for all agents?", true);
  if (customPerAgent) {
    for (const agent of AGENTS) backends[agent] = backend;
  } else {
    for (const agent of AGENTS) {
      const agentBackend = await ask(rl, `${agent.toUpperCase()} backend (claude/codex)`, backend);
      backends[agent] = (agentBackend === "claude" || agentBackend === "codex") ? agentBackend : backend;
    }
  }

  log("Path to your local clone of the repo. Four worktrees will be created next to it");
  log("(e.g., project-t1/, project-t2a/, project-t2b/, project-t3/).");
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
  log("A separate reviewer account lets T2a/T2b approve PRs independently. You can set this up later in Settings.");
  const wantReviewer = await askYN(rl, "Use a separate GitHub account for reviewers (T2a/T2b)?", false);
  let reviewerUser = "";
  let reviewerTokenPath = "";
  if (wantReviewer) {
    log("GitHub username for the reviewer account (used in T2a/T2b seed files for PR reviews).");
    reviewerUser = await ask(rl, "Reviewer GitHub username", "");
    log("Path to a file containing a GitHub PAT for the reviewer account.");
    reviewerTokenPath = await ask(rl, "Reviewer token file path", path.join(os.homedir(), ".quadwork", "reviewer-token"));
  }

  const projectName = path.basename(absDir);
  log(`Project: ${projectName}`);
  log("Creating worktrees for 4 agents...\n");

  const worktrees = {};
  for (const agent of AGENTS) {
    const wtDir = path.join(path.dirname(absDir), `${projectName}-${agent}`);
    if (fs.existsSync(wtDir)) {
      ok(`Worktree exists: ${agent} → ${wtDir}`);
    } else {
      const branchName = `worktree-${agent}`;
      // Create branch if needed
      run(`git -C "${absDir}" branch ${branchName} HEAD 2>&1`);
      const result = run(`git -C "${absDir}" worktree add "${wtDir}" ${branchName} 2>&1`);
      if (result !== null) {
        ok(`Created worktree: ${agent} → ${wtDir}`);
      } else {
        // Try without branch (detached)
        const result2 = run(`git -C "${absDir}" worktree add --detach "${wtDir}" HEAD 2>&1`);
        if (result2 !== null) ok(`Created worktree (detached): ${agent} → ${wtDir}`);
        else { fail(`Failed to create worktree for ${agent}`); return null; }
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
      log(`  Copied ${agent}.AGENTS.md`);
    }
  }

  // Copy CLAUDE.md to each worktree
  const claudeSrc = path.join(TEMPLATES_DIR, "CLAUDE.md");
  if (fs.existsSync(claudeSrc)) {
    let claudeContent = fs.readFileSync(claudeSrc, "utf-8");
    claudeContent = claudeContent.replace(/\{\{project_name\}\}/g, projectName);
    for (const agent of AGENTS) {
      const dst = path.join(worktrees[agent], "CLAUDE.md");
      // Don't overwrite if CLAUDE.md already exists
      if (!fs.existsSync(dst)) {
        fs.writeFileSync(dst, claudeContent);
      }
    }
    ok("Copied CLAUDE.md to all worktrees");
  }

  return { projectName, absDir, worktrees, repo, backend, backends };
}

// ─── AgentChattr Config ─────────────────────────────────────────────────────

function writeAgentChattrConfig(setup, configTomlPath, { skipInstall = false } = {}) {
  header("Step 4: AgentChattr Setup");

  let tomlContent = fs.readFileSync(path.join(TEMPLATES_DIR, "config.toml"), "utf-8");
  for (const agent of AGENTS) {
    tomlContent = tomlContent.replace(`{{${agent}_cwd}}`, setup.worktrees[agent]);
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

  // Write config.toml
  const configDir = path.dirname(configTomlPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configTomlPath, tomlContent);
  ok(`Wrote ${configTomlPath}`);

  // Start AgentChattr if available; optionally skip install attempt
  let acAvailable = which("agentchattr");
  if (!acAvailable && !skipInstall) {
    log("Installing AgentChattr...");
    const installResult = run("pip install agentchattr 2>&1");
    if (installResult !== null) {
      ok("Installed AgentChattr");
      acAvailable = which("agentchattr");
      if (!acAvailable) warn("agentchattr binary not found in PATH after install");
    } else {
      warn("Failed to install AgentChattr — install manually: pip install agentchattr");
    }
  }

  // Start AgentChattr server (only if installed)
  if (acAvailable) {
    log("Starting AgentChattr server...");
    const acProc = spawn("agentchattr", ["--config", configTomlPath], {
      stdio: "ignore",
      detached: true,
    });
    acProc.on("error", (err) => {
      warn(`AgentChattr failed to start: ${err.message}`);
    });
    acProc.unref();
    if (acProc.pid) {
      ok(`AgentChattr started (PID: ${acProc.pid})`);
      const pidFile = path.join(CONFIG_DIR, "agentchattr.pid");
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(pidFile, String(acProc.pid));
    } else {
      warn("Could not start AgentChattr — start manually: agentchattr --config " + configTomlPath);
    }
  } else {
    warn("AgentChattr not installed — skipping auto-start. Start manually later: agentchattr --config " + configTomlPath);
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
      log("Cloning agentchattr-telegram...");
      const cloneResult = run(`git clone https://github.com/realproject7/agentchattr-telegram.git "${telegramDir}" 2>&1`);
      if (cloneResult !== null) ok("Cloned agentchattr-telegram");
      else warn("Failed to clone — you can set it up manually later");
    } else {
      ok("agentchattr-telegram already present");
    }

    if (fs.existsSync(telegramDir)) {
      const reqFile = path.join(telegramDir, "requirements.txt");
      if (fs.existsSync(reqFile)) {
        run(`pip install -r "${reqFile}" 2>&1`);
        ok("Installed Telegram Bridge dependencies");
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

        // Append telegram section to config.toml (token read from env at runtime)
        const telegramSection = `
[telegram]
bot_token = "env:${envKey}"
chat_id = "${chatId}"
agentchattr_url = "http://127.0.0.1:8300"
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
          const bridgeTomlContent = `[telegram]\nbot_token = "${botToken}"\nchat_id = "${chatId}"\n\n[agentchattr]\nurl = "http://127.0.0.1:8300"\n`;
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
      log("Cloning agent-memory...");
      const cloneResult = run(`git clone https://github.com/realproject7/agent-memory.git "${memoryDir}" 2>&1`);
      if (cloneResult !== null) ok("Cloned agent-memory");
      else warn("Failed to clone — you can set it up manually later");
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
    project.agents[agent] = { cwd: setup.worktrees[agent], command: (setup.backends && setup.backends[agent]) || setup.backend };
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

  // Upsert project
  const idx = config.projects.findIndex((p) => p.id === setup.projectName);
  if (idx >= 0) config.projects[idx] = project;
  else config.projects.push(project);

  writeConfig(config);
  ok(`Wrote ${CONFIG_PATH}`);
}

// ─── Init Command ───────────────────────────────────────────────────────────

async function cmdInit() {
  console.log("");
  console.log(`  ${c.cyan}${c.bold}╔══════════════════════════════════════════╗${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}║${c.reset}  ${c.white}${c.bold}QuadWork Init${c.reset}                           ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}║${c.reset}  ${c.dim}4-agent coding team setup${c.reset}                ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}╚══════════════════════════════════════════╝${c.reset}`);
  console.log(`\n  ${c.dim}Tip: Press Enter to accept defaults shown in [brackets].${c.reset}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Step 1: Prerequisites
    const prereqsOk = checkPrereqs();
    if (!prereqsOk) {
      const proceed = await askYN(rl, "Some prerequisites missing. Continue anyway?", false);
      if (!proceed) { rl.close(); process.exit(1); }
    }

    // Step 2: GitHub
    const repo = await setupGitHub(rl);
    if (!repo) { rl.close(); process.exit(1); }

    // Step 3: Agents
    const setup = await setupAgents(rl, repo);
    if (!setup) { rl.close(); process.exit(1); }

    // Step 4: AgentChattr config (skip install if prereqs already flagged it missing)
    const configTomlPath = path.join(setup.absDir, "config.toml");
    writeAgentChattrConfig(setup, configTomlPath, { skipInstall: !agentChattrFound });

    // Step 5: Optional add-ons
    await setupAddons(rl, setup, configTomlPath);

    // Write QuadWork config
    writeQuadWorkConfig(setup);

    // Done
    header("Setup Complete");
    log(`Project:      ${setup.projectName}`);
    log(`Repo:         ${setup.repo}`);
    log(`Worktrees:    ${AGENTS.map((a) => `${setup.projectName}-${a}/`).join(", ")}`);
    log(`Backends:     ${AGENTS.map((a) => `${a.toUpperCase()}=${(setup.backends && setup.backends[a]) || setup.backend}`).join(", ")}`);
    log(`Config:       ${CONFIG_PATH}`);
    log(`AgentChattr:  ${configTomlPath}`);
    if (setup.telegram) log(`Telegram:     configured`);
    if (setup.memoryDir) log(`Shared Memory: ${setup.memoryDir}`);
    log("");
    log("Next steps:");
    log("  npx quadwork start    — launch dashboard + agents");
    log("  npx quadwork stop     — stop all processes");
    log("");

    rl.close();
  } catch (err) {
    fail(err.message);
    rl.close();
    process.exit(1);
  }
}

// ─── Start Command ──────────────────────────────────────────────────────────

function cmdStart() {
  console.log("\n  QuadWork Start\n");

  const config = readConfig();
  if (config.projects.length === 0) {
    fail("No projects configured. Run: npx quadwork init");
    process.exit(1);
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

  log("Starting QuadWork server...");
  const server = spawn("node", [serverDir], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env },
  });
  server.unref();
  ok(`Server started (PID: ${server.pid})`);

  // Save PID for stop command
  const pidFile = path.join(CONFIG_DIR, "server.pid");
  fs.writeFileSync(pidFile, String(server.pid));

  // Start AgentChattr if installed and config.toml exists for first project
  const firstProject = config.projects[0];
  if (firstProject && which("agentchattr")) {
    const configToml = path.join(firstProject.working_dir, "config.toml");
    if (fs.existsSync(configToml)) {
      const acProc = spawn("agentchattr", ["--config", configToml], {
        stdio: "ignore",
        detached: true,
      });
      acProc.on("error", () => {});
      acProc.unref();
      if (acProc.pid) {
        ok(`AgentChattr started (PID: ${acProc.pid})`);
        fs.writeFileSync(path.join(CONFIG_DIR, "agentchattr.pid"), String(acProc.pid));
      }
    }
  }

  // Open dashboard in browser
  const dashboardUrl = `http://127.0.0.1:${port}`;
  const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  setTimeout(() => {
    try { execSync(`${openCmd} ${dashboardUrl}`, { stdio: "ignore" }); } catch {}
  }, 1500);

  log(`Dashboard: ${dashboardUrl}`);
  log("");
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
  if (stopPid("AgentChattr", "agentchattr.pid")) stopped++;
  if (stopPid("Server", "server.pid")) stopped++;

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

    const configTomlPath = path.join(setup.absDir, "config.toml");
    writeAgentChattrConfig(setup, configTomlPath);

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
  default:
    console.log(`
  Usage: quadwork <command>

  Commands:
    init          Set up a new QuadWork 4-agent environment
    start         Start the QuadWork dashboard and backend
    stop          Stop all QuadWork processes
    add-project   Add a project to an existing QuadWork setup

  Examples:
    npx quadwork init
    npx quadwork start
    npx quadwork stop
    npx quadwork add-project
`);
    if (command) process.exit(1);
}
