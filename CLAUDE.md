# QuadWork — Development Rules

## What is QuadWork

A unified local dashboard for 4-agent coding teams. Embeds terminals, AgentChattr chat, and GitHub board in one browser tab. See `docs/PROPOSAL.md` for full spec.

## Tech Stack

- **Frontend**: Next.js (App Router) + TypeScript + Tailwind CSS
- **Backend**: Node.js + Express + node-pty + WebSocket
- **Terminal**: xterm.js
- **Config**: JSON file (`~/.quadwork/config.json`) — no database
- **GitHub**: `gh` CLI (shelled out) — no SDK
- **Design**: Dark mode only, Geist Mono, `#00ff88` accent

## Design Tokens

```css
--bg: #0a0a0a;  --bg-surface: #111111;  --text: #e0e0e0;
--text-muted: #737373;  --accent: #00ff88;  --accent-dim: #00cc6a;
--border: #2a2a2a;  --error: #ff4444;
```

Reference: [plotlink at `pre-design-overhaul`](https://github.com/realproject7/plotlink/tree/pre-design-overhaul/src/app/globals.css)

## Code Conventions

- Existing patterns first — read before writing
- Minimal changes only — no "while I'm here" improvements
- No unnecessary abstractions or helpers for one-time operations
- Keep it simple — this is a display layer, not a logic layer

## Git

- Branch naming: `task/<issue-number>-<short-slug>`
- Commit format: `[#<issue>] Short description`
- Never push to `main` — open PRs only
- PR title format: `[#<issue>] Short description`

## Frontend

- Use `/frontend-design` skill on Claude Code for all UI work
- Dark mode only — no light theme
- Monospace font (Geist Mono) everywhere
- Sharp corners, thin borders, no shadows or glows
- Information density: dev-tool level, not consumer SaaS

## Dependencies

- AgentChattr: external dependency, cloned to `~/.quadwork/agentchattr` and run via `.venv/bin/python run.py`
- Telegram bridge: external (`realproject7/agentchattr-telegram`), optional
- Shared memory: external (`realproject7/agent-memory`), optional

## Running locally

```bash
npm install        # install deps
npm run dev        # start frontend (Next.js)
node server/       # start backend (Express + pty)
```
