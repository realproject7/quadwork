# QuadWork — Mac Installation Guide

Step-by-step guide for installing QuadWork on macOS. Designed for both humans and AI coding agents.

---

## Prerequisites

### Check existing tools

```bash
node --version   # Need 20+ (24 recommended)
git --version
gh --version
```

### Install missing prerequisites

**Node.js 20+** (via nvm — strongly recommended):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.zshrc
nvm install 24
nvm use 24
```

> Why nvm? The QuadWork install step below uses `npm install -g`. With a Homebrew or `.pkg` Node, global installs target `/usr/local/lib/node_modules/` and fail with `EACCES: permission denied` unless you use `sudo`. nvm puts the global prefix inside `~/.nvm/`, so `npm install -g` works without elevated permissions.

**Git** (included with Xcode Command Line Tools):
```bash
xcode-select --install
```

**GitHub CLI:**
```bash
brew install gh
```

### Authenticate GitHub CLI

```bash
gh auth login
```

> **This is interactive** — the operator must complete the browser-based auth flow. Ask the user to run this command if not already authenticated.

Verify:
```bash
gh auth status
# You should see: "Logged in to github.com account <username>"
```

---

## Install AI Coding Agents

Install one or more of the supported agent CLIs:

```bash
# Claude Code (Anthropic)
npm install -g @anthropic-ai/claude-code

# Codex CLI (OpenAI)
npm install -g @openai/codex

# Gemini CLI (Google) — if using Gemini agents
npm install -g @google/gemini-cli
```

### Authenticate agent CLIs

Each CLI requires a one-time interactive login:

```bash
# Claude Code — follow the login prompt
claude

# Codex — follow the login prompt
codex
```

> **These are interactive steps.** Ask the operator to run each command and complete the login flow.

---

## Install QuadWork

```bash
npm install -g quadwork@latest
```

Verify the install:
```bash
npm list -g quadwork
# You should see the installed version, e.g. quadwork@2.7.0
```

### Troubleshooting: `EACCES: permission denied`

If you see an error like:

```
npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/quadwork
```

your Node is installed system-wide (Homebrew or the `.pkg` installer) and the global prefix is not writable by your user. Pick one:

- **Switch to nvm** (recommended) — see the [Prerequisites](#install-missing-prerequisites) section above, then re-run `npm install -g quadwork@latest`.
- **Run once with `npx`** (no global install):
  ```bash
  npx quadwork@latest init
  npx quadwork@latest start
  ```
- **Install with `sudo`** (not recommended — leaves root-owned files in your global `node_modules`):
  ```bash
  sudo npm install -g quadwork@latest
  ```

---

## Initialize & Start

### Interactive setup

```bash
quadwork init
```

> **This is interactive.** The operator will be prompted to configure their first project (name, repo, working directory, agent backends).

### Start the server

```bash
quadwork start
```

The dashboard starts on `http://127.0.0.1:8400` (the server binds loopback
only). QuadWork opens that URL in your default browser automatically; if it
doesn't, open it yourself to reach the web UI.

---

## Create Your First Project

1. Open the dashboard at `http://127.0.0.1:8400`
2. Click **"+ New Project"** or navigate to `/setup`
3. Fill in the project details:
   - **Name:** Your project name
   - **Repo:** GitHub repo in `owner/repo` format
   - **Working directory:** Absolute path to the repo clone
   - **Agent backends & models:** In the **Agent Models** step, pick a CLI
     backend — **Claude Code**, **Codex**, or **Gemini CLI** — for each of the
     four roles (Head, Dev, RE1, RE2), and optionally select a specific model
     per role (e.g. `opus` / `sonnet` for Claude, `gpt-5.4` / `gpt-5.6-*` for
     Codex, `gemini-2.5-pro` / `gemini-2.5-flash` for Gemini). Leave a role on
     **(CLI default)** to use the backend's own default model.
4. Click **Create**

QuadWork will:
- Create a git worktree for each agent next to your repo (e.g., `project-head/`, `project-dev/`, `project-re1/`, `project-re2/`)
- Seed `AGENTS.md` and `CLAUDE.md` into each role's worktree

---

## Trust Prompt (Claude Code)

On first launch, Claude Code shows a "Do you trust this directory?" prompt.
QuadWork auto-answers it: when an agent's terminal starts, a listener watches
its output for the trust prompt (within the first few seconds) and confirms it
automatically, so Claude-backed agents reach a trusted session with no operator
action. No manual pre-trust step is required.

---

## Discord / Telegram Bridge (Optional)

### Discord bridge

1. Open the project page in the dashboard
2. Click the **Discord** widget
3. Enter your Discord bot token and channel ID
4. Click **Start**

### Telegram bridge

1. Open the project page in the dashboard
2. Click the **Telegram** widget
3. Enter your Telegram bot token and chat ID
4. Click **Start**

> **Note:** Bridges are configured per-project in `~/.quadwork/config.json`. See the dashboard Telegram/Discord widgets for setup.

---

## Stopping & Restarting

```bash
# Foreground: press Ctrl+C in the `quadwork start` terminal.
# From another terminal (e.g. a backgrounded server):
quadwork stop

# Restart
quadwork start
```

Both `Ctrl+C` and `quadwork stop` shut down cleanly: agent PTYs, the
`caffeinate` sleep-blocker, the polling/watchdog timers, and the chat bridges
are all stopped (no orphaned `caffeinate` keeping the Mac awake). `quadwork
start` records its PID in `~/.quadwork/server.pid`, which is how `quadwork stop`
finds a running server.

For persistent background operation on Mac, consider using pm2:
```bash
npm install -g pm2
pm2 start "quadwork start" --name quadwork
pm2 save
```
