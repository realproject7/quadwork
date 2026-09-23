# QuadWork — Windows Installation Guide (WSL2)

QuadWork requires a Unix environment (node-pty, a POSIX shell, git worktrees).
On Windows, run it inside **WSL2** (Windows Subsystem for Linux), which gives
you a full Ubuntu environment. This guide is self-contained — every command
runs **inside the WSL2 Ubuntu shell** unless it explicitly says PowerShell.

---

## Prerequisites

- **Windows 10** (build 19041 or later) or **Windows 11**
- Administrator access (for the one-time WSL2 installation)

---

## Step 1: Install WSL2

> **Manual step** — this requires PowerShell as Administrator and cannot be done by an agent.

Open **PowerShell as Administrator** and run:

```powershell
wsl --install -d Ubuntu
```

Restart your computer when prompted. After restart, Ubuntu opens and asks you to create a username and password.

---

## Step 2: Enter WSL2

Open PowerShell (or Windows Terminal) and run:

```powershell
wsl
```

You're now in Ubuntu. **All following steps happen inside this shell.**

---

## Step 3: Install Prerequisites (Ubuntu/WSL2)

**Node.js 20.3.0+** (24 recommended) via nvm — nvm keeps the global npm prefix
under `~/.nvm/`, so the `npm install -g` steps below work without `sudo`.
20.0-20.2 are refused: QuadWork's durable stores take their writer lock in the
kernel through a native addon, whose prebuilds target the Node-20 N-API
surface from 20.3.0 on. Ubuntu under WSL2 is glibc, which those prebuilds
need; a musl distribution such as Alpine is not supported.
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
nvm use 24
```

**Git:**
```bash
sudo apt-get update
sudo apt-get install -y git
```

**GitHub CLI (`gh`):**
```bash
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | sudo tee /etc/apt/sources.list.d/github-cli.list
sudo apt-get update && sudo apt-get install -y gh
```

Verify the toolchain:
```bash
node --version   # 20.3.0 or newer
git --version
gh --version
```

**Authenticate GitHub CLI:**
```bash
gh auth login
```

> **This is interactive** — the operator must complete the login flow. In WSL2
> the flow either opens your Windows browser or prints a one-time code and URL
> to paste into it. Verify with `gh auth status` (expect
> `Logged in to github.com account <username>`).

---

## Step 4: Install AI Coding Agent CLIs

Install one or more of the supported agent CLIs (all as global npm packages):

```bash
# Claude Code (Anthropic)
npm install -g @anthropic-ai/claude-code

# Codex CLI (OpenAI)
npm install -g @openai/codex

# Gemini CLI (Google) — if using Gemini agents
npm install -g @google/gemini-cli
```

Each CLI needs a one-time interactive login — run it and complete the prompt
(the same browser/one-time-code pattern as `gh` above):

```bash
claude   # follow the login prompt
codex    # follow the login prompt
gemini   # follow the login prompt (only if using Gemini)
```

> **These are interactive steps.** Ask the operator to run each command and complete the login.

---

## Step 5: Install QuadWork

```bash
npm install -g quadwork@latest
```

Verify the install:
```bash
npm list -g quadwork
# You should see the installed version, e.g. quadwork@2.7.0
```

> If you see `EACCES: permission denied` on the global install, your Node isn't
> nvm-managed. Re-do the nvm step in Step 3 (recommended), or run QuadWork
> without a global install via `npx quadwork@latest init` / `npx quadwork@latest start`.

The install may also print a warning that `node-pty`'s install scripts are
"not yet covered by allowScripts." This is advisory. npm still runs the
scripts by default; it is only telling you that you have not explicitly
reviewed them. WSL2's Ubuntu is glibc Linux, and on glibc Linux (x64 or
arm64) this needs no action: node-pty's bundled prebuild loads and a PTY
spawns fine, whether the scripts run (the default) or are skipped (verified
both ways). If `quadwork start` or `quadwork doctor` then reports `node-pty
is unusable`, run:
```bash
npm install -g quadwork@latest --allow-scripts=node-pty
```
See [Troubleshooting: node-pty install-scripts warning](troubleshooting.md#node-pty-install-scripts-warning) for the full explanation and platform table.

---

## Step 6: Initialize & Start

Run the interactive setup wizard, then start the dashboard:

```bash
quadwork init    # prompts for your first project (name, repo, working dir, backends)
quadwork start   # starts the dashboard + agents on http://127.0.0.1:8400
```

`quadwork start` binds loopback (`127.0.0.1`) and opens the dashboard in your
browser. Create your first project from the dashboard at
`http://127.0.0.1:8400` (**"+ New Project"** or `/setup`) if you didn't during
`init`:

- **Name / Repo (`owner/repo`) / Working directory** (absolute path to your repo clone).
- **Agent backends & models** — in the **Agent Models** step, choose a CLI
  backend (**Claude Code**, **Codex**, or **Gemini CLI**) for each of the four
  roles (Head, Dev, RE1, RE2), and optionally pick a specific model per role
  (e.g. `opus` / `sonnet` for Claude, `gpt-5.4` / `gpt-5.6-*` for Codex,
  `gemini-2.5-pro` / `gemini-2.5-flash` for Gemini). Leave a role on
  **(CLI default)** to use the backend's own default model.

QuadWork then creates a git worktree for each agent next to your repo
(`project-head/`, `project-dev/`, `project-re1/`, `project-re2/`) and seeds
`AGENTS.md` and `CLAUDE.md` into each. Claude Code's "Do you trust this
directory?" prompt is auto-answered when each agent's terminal starts — no
manual pre-trust step is required.

---

## Accessing the Dashboard

QuadWork runs on `http://127.0.0.1:8400` by default. WSL2 shares `localhost`
with Windows automatically, so open that URL in your **Windows** browser
(Chrome, Edge, etc.) — no port forwarding needed.

---

## Stopping & Restarting

```bash
# Foreground: press Ctrl+C in the `quadwork start` terminal.
# From another WSL2 terminal:
quadwork stop

# Restart
quadwork start
```

Both `Ctrl+C` and `quadwork stop` shut down cleanly (agent terminals, watchdog
timers, and any running chat bridges). `quadwork start` records its PID in
`~/.quadwork/server.pid`, which is how `quadwork stop` finds a running server.

For persistent background operation, pm2 works the same as on Linux:
```bash
npm install -g pm2
pm2 start "quadwork start" --name quadwork
pm2 save
```

---

## Optional: Discord / Telegram Bridge

Bridges are built in and configured per-project from the dashboard: open the
project page and use the **Discord** or **Telegram** widget to enter your bot
token and channel/chat ID, then **Start**. Config is stored per-project in
`~/.quadwork/config.json`.

---

## Known Differences from Mac/Linux

| Feature | Behavior on WSL2 |
|---------|-----------------|
| Keep Mac Awake | Not applicable (`caffeinate` is macOS-only; nothing to stop on WSL2) |
| File paths | `/home/<user>/` instead of `/Users/<user>/` |
| VS Code | Install the "WSL" extension to edit files inside WSL2 |
| Localhost | Shared with Windows automatically (no port forwarding needed) |

---

## For AI Agents

WSL2 itself must be installed by the operator (Step 1, PowerShell as
Administrator). Once inside the WSL2 shell, run Steps 3–6 in order. Do not run
any macOS-specific prerequisites (Homebrew, Xcode) — Step 3 covers everything
needed on Ubuntu/WSL2. Authentication steps (`gh auth login`, `claude`,
`codex`, `gemini`) are interactive and must be completed by the operator.
