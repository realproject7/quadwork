# QuadWork — Mac Installation Guide

Step-by-step guide for installing QuadWork on macOS. Designed for both humans and AI coding agents.

---

## Prerequisites

### Check existing tools

```bash
node --version   # Need 20+ (24 recommended)
python3 --version # Need 3.x
git --version
gh --version
```

### Install missing prerequisites

**Node.js 20+** (via nvm — recommended):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.zshrc
nvm install 24
nvm use 24
```

**Python 3** (via Homebrew if not already installed):
```bash
brew install python3
```

**Git** (included with Xcode Command Line Tools):
```bash
xcode-select --install
```

**GitHub CLI:**
```bash
brew install gh
```

### Fix macOS Python SSL certificates

macOS Python installations often fail SSL verification. Run this once after installing Python:

```bash
/Applications/Python\ 3.*/Install\ Certificates.command
```

> **This requires operator input.** If the path doesn't match, ask the user to check their Python version: `ls /Applications/ | grep Python`

Without this fix, AgentChattr's Python dependencies (fastapi, uvicorn) may fail to install with SSL errors.

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
npm install -g @anthropic-ai/claude-code  # placeholder: check Gemini CLI availability
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

Verify:
```bash
quadwork --version
# You should see the version number (e.g., 1.14.5)
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

You should see output like:
```
QuadWork dashboard: http://localhost:8400
AgentChattr:        http://127.0.0.1:8300
```

Open the dashboard URL in your browser to access the web UI.

---

## Create Your First Project

1. Open the dashboard at `http://localhost:8400`
2. Click **"+ New Project"** or navigate to `/setup`
3. Fill in the project details:
   - **Name:** Your project name
   - **Repo:** GitHub repo in `owner/repo` format
   - **Working directory:** Absolute path to the repo clone
   - **Agent backends:** Choose Claude, Codex, or Gemini for each agent role
4. Click **Create**

QuadWork will:
- Create worktree directories for each agent (e.g., `project-head/`, `project-dev/`, `project-re1/`, `project-re2/`)
- Generate AgentChattr config
- Seed AGENTS.md files for each role

---

## Trust Prompt (Claude Code)

On first launch, Claude Code agents may get stuck at a "Do you trust this directory?" prompt. QuadWork v1.14.5+ automatically pre-trusts worktree directories for Claude-configured agents during project creation.

**If agents are still stuck** (e.g., upgraded from an older version), manually pre-trust each worktree:

```bash
# Run in each worktree directory
cd /path/to/project-head && claude -p "echo ok"
cd /path/to/project-dev && claude -p "echo ok"
cd /path/to/project-re1 && claude -p "echo ok"
cd /path/to/project-re2 && claude -p "echo ok"
```

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

> **Note:** Bridge agent sections (`[agents.dc]`, `[agents.tg]`) are automatically included in config.toml for projects created on v1.14.6+. If upgrading from an older version, restart QuadWork — the startup migration will add them.

---

## Stopping & Restarting

```bash
# Stop the server (Ctrl+C if running in foreground)
# Or if running in background:
quadwork stop

# Restart
quadwork start
```

For persistent background operation on Mac, consider using pm2:
```bash
npm install -g pm2
pm2 start "quadwork start" --name quadwork
pm2 save
```
