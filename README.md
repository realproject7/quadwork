# QuadWork

Your AI dev team in a box. Four agents — one Head, one Dev, two Reviewers — that code, review, and ship while you sleep.

## Getting Started

1. Install [Node.js 20+](https://nodejs.org) if you don't have it
2. Install [Homebrew](https://brew.sh) if you're on macOS: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
3. Open your terminal and run:

```bash
npx quadwork init
```

4. The wizard installs everything else and opens your dashboard.

That's it. The wizard handles Python, GitHub CLI, AI tools, and authentication — you just follow the prompts.

## How It Works

QuadWork runs a team of 4 AI agents on your local machine:

| Agent | Role | What it does |
|-------|------|-------------|
| **Head** | Coordinator | Creates issues, assigns tasks, merges approved PRs |
| **Dev** | Builder | Writes code, opens PRs, addresses review feedback |
| **Reviewer1** | Reviewer | Independent code review with veto authority |
| **Reviewer2** | Reviewer | Independent code review with veto authority |

Every task follows a GitHub workflow: Issue → Branch → PR → 2 Reviews → Merge. Branch protection ensures no agent can skip the process.

## Dashboard

```
+--------+----------------------------+----------------------------+
|        |  Head Terminal             |  GitHub (Issues + PRs)     |
| Side-  |  (Coordinator)             |                            |
| bar    +----------------------------+----------------------------+
|        |  Agent Chat                |  Reviewer1  |  Reviewer2   |
| [Home] |  (AgentChattr)             |             |              |
| [Proj] |                            +-------------+--------------+
| [+]    |                            |  Dev Terminal              |
| [Set]  |                            |  (Builder)                 |
+--------+----------------------------+----------------------------+
| Keep Alive | Server: Stop Restart Reset | System: Keep Awake      |
+--------+----------------------------+----------------------------+
```

## Features

- **Terminal panels** — Live terminals for each agent with PTY sessions
- **Agent chat** — Real-time agent coordination via AgentChattr
- **GitHub board** — Issues, PRs, and review status at a glance
- **Task queue** — Build and dispatch work queues with one click
- **Keep Alive** — Scheduled check-in messages to keep agents active (with auto-stop duration)
- **Keep Awake** — Prevent your Mac from sleeping during overnight runs
- **Multi-project** — Each project gets its own AgentChattr instance and ports
- **Telegram bridge** — Optional mobile notifications via [agentchattr-telegram](https://github.com/realproject7/agentchattr-telegram)

## Commands

| Command | Description |
|---------|-------------|
| `npx quadwork init` | One-time setup — installs prerequisites and opens the dashboard |
| `npx quadwork start` | Start the dashboard server |
| `npx quadwork stop` | Stop all processes |

After init, create projects from the web UI at `http://127.0.0.1:8400/setup`.

## Configuration

Config is stored at `~/.quadwork/config.json`:

```json
{
  "port": 8400,
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "repo": "owner/repo",
      "working_dir": "/path/to/project",
      "agentchattr_url": "http://127.0.0.1:8300",
      "mcp_http_port": 8200,
      "mcp_sse_port": 8201,
      "agents": {
        "head": { "cwd": "/path/to/project-head", "command": "codex" },
        "dev": { "cwd": "/path/to/project-dev", "command": "claude" },
        "reviewer1": { "cwd": "/path/to/project-reviewer1", "command": "codex" },
        "reviewer2": { "cwd": "/path/to/project-reviewer2", "command": "claude" }
      }
    }
  ]
}
```

Each project gets its own AgentChattr instance, ports, and git worktrees.

## Architecture

QuadWork runs a single Express server that serves:

- **Static frontend** — Pre-built Next.js export
- **REST API** — Agent lifecycle, config, GitHub, chat proxy, triggers
- **WebSocket** — Terminal PTY sessions

All on one port (`127.0.0.1:8400`).

## License

MIT
