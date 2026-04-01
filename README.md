# QuadWork

A unified dashboard for multi-agent coding teams. Four AI agents (T1 owner, T2a/T2b reviewers, T3 builder) collaborate through terminals, chat, GitHub integration, and shared memory — all served from a single local web view.

## Dashboard

```
+--------+----------------------------+----------------------------+
|        |  T1 Terminal               |  T2a Terminal              |
| Side-  |  (Owner)                   |  (Reviewer)               |
| bar    +----------------------------+----------------------------+
|        |  T3 Terminal               |  T2b Terminal              |
| [Home] |  (Builder)                 |  (Reviewer)               |
| [Proj] +----------------------------+----------------------------+
| [+]    |  Agent Chat (AgentChattr)  |  GitHub (Issues + PRs)    |
| [Set]  |                            |                           |
+--------+----------------------------+----------------------------+
```

## Features

- **Terminal panels** — Live xterm.js terminals for each agent with PTY sessions
- **Agent chat** — AgentChattr integration for real-time agent coordination
- **GitHub board** — Issues, PRs, and review status at a glance
- **Task queue** — Build and dispatch work queues to T1 with one click
- **Shared memory** — Memory cards, butler scripts, and cross-agent context
- **Telegram bridge** — Optional Telegram bot integration for mobile notifications
- **Single-port server** — Everything on `http://127.0.0.1:8400` (API + WebSocket + UI)
- **Backend indicator** — Clear offline/online status in the sidebar

## Prerequisites

- **Node.js 20+** (with C++ toolchain for native modules)
- **Python 3.10+** (for AgentChattr)
- **GitHub CLI** (`gh`) — [install](https://cli.github.com)
- **Claude Code** or **Codex CLI** — at least one AI agent CLI

## Quick Start

```bash
npx quadwork init      # Interactive setup: repo, worktrees, agents, config
npx quadwork start     # Launches dashboard at http://127.0.0.1:8400
npx quadwork stop      # Stops all processes
```

## Install from Source

```bash
git clone https://github.com/realproject7/quadwork.git
cd quadwork
npm install
npm run build          # Static frontend export to out/
node server/           # Start server at http://127.0.0.1:8400
```

For development (hot reload):

```bash
npm run dev            # Next.js dev server on :3000
npm run server         # Express backend on :8400 (run in separate terminal)
```

## Commands

| Command | Description |
|---------|-------------|
| `quadwork init` | Interactive setup wizard — repo, worktrees, agent config |
| `quadwork start` | Start the server (frontend must be pre-built) |
| `quadwork stop` | Stop server, AgentChattr, and Telegram bridge |
| `quadwork add-project` | Add another project to an existing setup |

## Configuration

Config is stored at `~/.quadwork/config.json`:

```json
{
  "port": 8400,
  "agentchattr_url": "http://127.0.0.1:8300",
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "repo": "owner/repo",
      "working_dir": "/path/to/project",
      "agents": {
        "t1": { "cwd": "/path/to/project-t1", "command": "claude" },
        "t2a": { "cwd": "/path/to/project-t2a", "command": "claude" },
        "t2b": { "cwd": "/path/to/project-t2b", "command": "claude" },
        "t3": { "cwd": "/path/to/project-t3", "command": "claude" }
      }
    }
  ]
}
```

Each agent runs in its own git worktree (sibling directories).

## Optional Add-ons

### AgentChattr

Shared chat server for agent coordination. Install separately:

```bash
pip install agentchattr
```

The setup wizard configures AgentChattr automatically. See [agentchattr](https://github.com/realproject7/agentchattr) for details.

### Telegram Bridge

Forward agent chat to a Telegram group. Configure in Settings or during `quadwork init`. Requires a Telegram bot token and chat ID.

### Shared Memory

Cross-agent memory system with memory cards and butler scripts. Set up during `quadwork init` or configure paths in Settings.

## Architecture

QuadWork runs a single Express server that serves:

- **Static frontend** — Pre-built Next.js export (`out/`)
- **REST API** — Agent lifecycle, config, GitHub, chat proxy, memory, triggers
- **WebSocket** — Terminal PTY sessions at `/ws/terminal`

All on one port (`127.0.0.1:8400`), no CORS needed.

## Design

See [docs/PROPOSAL.md](docs/PROPOSAL.md) for the full design specification.

## License

MIT
