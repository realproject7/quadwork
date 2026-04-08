<div align="center">

# QuadWork

### Your AI dev team while you sleep.

<p>
  <a href="#-quick-start"><strong>Quick Start</strong></a> ·
  <a href="#-how-it-works"><strong>How it Works</strong></a> ·
  <a href="#-features"><strong>Features</strong></a> ·
  <a href="#-external-tools"><strong>Credits</strong></a> ·
  <a href="https://github.com/bcurts/agentchattr"><strong>Built on AgentChattr</strong></a>
</p>

<p>
  <a href="https://www.npmjs.com/package/quadwork"><img src="https://img.shields.io/npm/v/quadwork" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/quadwork"><img src="https://img.shields.io/npm/dm/quadwork" alt="npm downloads" /></a>
  <a href="https://github.com/realproject7/quadwork/releases/latest"><img src="https://img.shields.io/github/v/release/realproject7/quadwork" alt="latest release" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="platform" />
  <img src="https://img.shields.io/badge/runs-locally-00d4aa" alt="runs locally" />
  <img src="https://img.shields.io/badge/agents-4-orange" alt="4 agents" />
  <a href="https://github.com/bcurts/agentchattr"><img src="https://img.shields.io/badge/built_on-AgentChattr-8b5cf6" alt="AgentChattr" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
</p>

</div>

---

## Why QuadWork?

Manually reviewing every AI-generated PR is exhausting. Letting one AI agent
push straight to `main` is how you end up rolling back broken migrations at
2am. QuadWork runs a **four-agent team** that enforces a real GitHub workflow
on each other — code, review, ship — autonomously, with safety rails.

- 🤖 **Runs 24/7** — agents keep working overnight while you rest
- 🛡️ **Always reviewed** — every PR needs **2 independent approvals** before merge
- 🔒 **Local-first** — the dashboard, terminals, chat server, and PTY sessions all run on your machine. The agents still make outbound calls to the LLM APIs you've configured (Claude / Codex / Gemini) and to GitHub, and the optional Telegram bridge mirrors chat to your phone. QuadWork itself doesn't host or proxy any of that traffic through a third party

## Who is QuadWork for?

- **Solo founders / indie hackers** who want to ship faster than they can review
- **Open-source maintainers** who get more PRs than they have hours to look at
- **Engineers** who want a team workflow without the overhead of hiring
- **Tinkerers** who've tried Claude Code / Codex and wished they had reviewers who pushed back

## ─ Quick Start

1. Install [Node.js 20+](https://nodejs.org) if you don't have it
2. On macOS, install [Homebrew](https://brew.sh):
   `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
3. Open your terminal and run:

```bash
npx quadwork init
```

4. The wizard installs everything else and opens your dashboard.

That's it. The wizard handles Python, GitHub CLI, AI tools, and
authentication — you just follow the prompts. Subsequent runs are one
command: `npx quadwork start`.

## ─ How it Works

QuadWork runs a team of 4 AI agents on your local machine and enforces a
GitHub-native workflow on them:

| Agent | Role | What it does |
|-------|------|-------------|
| **Head** | Coordinator | Creates issues, assigns tasks, merges approved PRs |
| **Dev** | Builder | Writes code, opens PRs, addresses review feedback |
| **Reviewer1** | Reviewer | Independent code review with veto authority |
| **Reviewer2** | Reviewer | Independent code review with veto authority |

Every task follows the same cycle: **Issue → Branch → PR → 2 Reviews → Merge**.
Branch protection ensures no agent can skip the process.

### The full autonomous loop

```
You: "@head start a batch for feature X"
     │
     ▼
Head: creates issues + queue, asks you to kick off the batch
     │
     ▼ (you click "Start Trigger" in the Operator panel)
Head: assigns the first issue to Dev
     │
     ▼
Dev: opens a PR with code
     │
     ▼
Reviewer1 + Reviewer2: independent reviews
     │
     ▼ (both approve)
Head: merges, picks the next issue
     │
     └──── repeat overnight ────┐
                                │
                                ▼
                       You wake up to merged PRs
```

### A concrete example

1. You drop a batch of 5 related tickets into chat: `@head start 5 sub-tickets under #123`.
2. Head files the 5 issues on GitHub, writes them to `OVERNIGHT-QUEUE.md`, and asks you to click **Start Trigger**.
3. You click it, close the laptop, and sleep.
4. The Scheduled Trigger pulses the agents every 15 minutes. Each pulse, Head assigns the next queued issue to Dev.
5. Dev opens a PR. Reviewer1 + Reviewer2 each review independently — approve, request changes, or veto. Dev iterates until both approve.
6. Head merges and picks the next ticket. Loop until the queue is empty or the duration expires.
7. You wake up to 5 merged PRs, a clean queue, and a chat transcript you can scroll.

## ─ Features

### Dashboard

- 📺 **4-quadrant project view** — chat, agent terminals (HEAD / DEV / RE1 / RE2), GitHub board, operator panel
- ⏰ **Scheduled Trigger** — recurring "queue check" pulses for autonomous overnight runs
- 📲 **Telegram bridge** — mirror the chat to your phone for remote monitoring
- 💾 **Project history export/import** — JSON snapshots of the full chat transcript
- 🧯 **Loop Guard control** — raise the hop limit and auto-resume stuck chains without restarting AC
- 🔔 **Notification sounds** — Web Audio chime on new agent messages with a background-only mode
- 🎞️ **Current Batch Progress panel** — per-issue progress bars computed from live GitHub state
- 🗂️ **Recently closed / merged feed** — so finished work doesn't disappear from the GitHub panel
- 💤 **Keep Mac Awake** — `caffeinate` wrapper so your laptop survives the night

### Workflow

- 🧭 **Multi-project support** — each project has its own AgentChattr instance + isolated worktrees
- 📝 **Per-project `OVERNIGHT-QUEUE.md`** with auto-incrementing batch numbers
- 💬 **Slash commands** — `/continue`, `/clear`, `/summary`, `/poetry`, `/roastreview`
- 🏷️ **Chat polish** — threaded replies, colored `@mentions`, short reviewer labels (RE1/RE2)
- 🧰 **Operator identity** — set your chat display name in Settings

### Safety

- 🚧 **GitHub branch protection** enforced on `main`
- ✅ **2-of-2 reviewer approval** required before merge
- 🛑 **Sender lockdown** — chat POSTs can't impersonate an agent (`head`, `dev`, …) from the UI
- 🗄️ **Auto-snapshot** of chat history to `~/.quadwork/{project}/history-snapshots/` before every AgentChattr restart, with an in-dashboard **Restore** button and an optional auto-restore-on-restart opt-in

## ─ External Tools

QuadWork stands on top of some great open-source work. Explicit thanks:

- **[AgentChattr](https://github.com/bcurts/agentchattr)** — by [@bcurts](https://github.com/bcurts).
  The local chat server + MCP tooling that lets QuadWork's agents talk to
  each other. **QuadWork would not exist without it** — huge thanks to
  bcurts for building such a clean foundation.
- **[GitHub CLI (`gh`)](https://cli.github.com)** — used by all four agents
  for issues, PRs, reviews, and merges.
- **[Claude Code](https://github.com/anthropics/claude-code)** — Anthropic's
  CLI. Recommended for the Dev / Reviewer2 roles.
- **[Codex CLI](https://github.com/openai/codex)** — OpenAI's CLI.
  Recommended for the Head / Reviewer1 roles.
- **[Next.js](https://nextjs.org)** + **[Express](https://expressjs.com)** —
  dashboard frontend + backend.
- **[node-pty](https://github.com/microsoft/node-pty)** — embeds the agent
  terminals.
- **[xterm.js](https://xtermjs.org)** — in-browser terminal rendering.

## ─ Configuration

Global config lives at `~/.quadwork/config.json`. Per-project AgentChattr
config lives at `~/.quadwork/{project_id}/agentchattr/config.toml`. The per-
project queue lives at `~/.quadwork/{project_id}/OVERNIGHT-QUEUE.md`.

```json
{
  "port": 8400,
  "operator_name": "user",
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "repo": "owner/repo",
      "working_dir": "/path/to/project",
      "agentchattr_url": "http://127.0.0.1:8300",
      "mcp_http_port": 8200,
      "mcp_sse_port": 8201,
      "auto_continue_loop_guard": false,
      "auto_continue_delay_sec": 30,
      "auto_restore_after_restart": false,
      "agents": {
        "head":      { "cwd": "/path/to/project-head",      "command": "codex"  },
        "dev":       { "cwd": "/path/to/project-dev",       "command": "claude" },
        "reviewer1": { "cwd": "/path/to/project-reviewer1", "command": "codex"  },
        "reviewer2": { "cwd": "/path/to/project-reviewer2", "command": "claude" }
      }
    }
  ]
}
```

Each project gets its own AgentChattr instance, ports, and git worktrees.

## ─ Architecture

QuadWork runs as a single Express server on `127.0.0.1:8400`:

- **Static frontend** — pre-built Next.js export (the `out/` directory)
- **REST API** — agent lifecycle, config, GitHub proxy, chat proxy, triggers, loop guard, batch progress, project history
- **WebSocket** — xterm.js terminal PTY sessions + AgentChattr ws fan-out

Per-project AgentChattr clones live at `~/.quadwork/{project}/agentchattr/`,
each with their own ports. Per-project git worktrees sit next to the repo:
`{repo}-head`, `{repo}-dev`, `{repo}-reviewer1`, `{repo}-reviewer2`. The
dashboard's xterm.js tiles attach to node-pty sessions over a WebSocket;
nothing about the agent state is held client-side.

## ─ Commands

| Command | Description |
|---------|-------------|
| `npx quadwork init` | One-time setup — installs prerequisites, opens the dashboard |
| `npx quadwork start` | Start the dashboard server |
| `npx quadwork stop` | Stop all processes |
| `npx quadwork cleanup --project <id>` | Remove a project's AgentChattr clone and config entry |
| `npx quadwork cleanup --legacy` | Remove the legacy `~/.quadwork/agentchattr/` install after migration |

After `init`, create projects from the web UI at `http://127.0.0.1:8400/setup`.

### Disk usage

Each project gets its own AgentChattr clone at
`~/.quadwork/{project_id}/agentchattr/` (~77 MB per project):

| Projects | Disk |
|---------:|-----:|
| 1 | ~77 MB |
| 5 | ~385 MB |
| 10 | ~770 MB |

Per-project clones are necessary so multiple projects can run AgentChattr
simultaneously without port conflicts. Existing v1 users are auto-migrated
to per-project clones on the next `npx quadwork start`; once every project
has a working clone, the legacy shared install can be removed safely via
`npx quadwork cleanup --legacy` (which refuses to run if any project is
still on the legacy install).

## ─ License

MIT
