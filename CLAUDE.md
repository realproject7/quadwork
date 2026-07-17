# QuadWork — Development Rules

## What is QuadWork

A unified local dashboard for 4-agent coding teams. Embeds terminals, the file-based project chat, and GitHub board in one browser tab. See `README.md` for the full product overview.

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

- Chat: built-in file-based JSONL chat (`server/file-chat.js`), exposed to agents through an MCP shim (`server/mcp-chat-shim.js`) as the `chat_send` / `chat_read` tools — no external chat service
- Telegram bridge: built-in and optional (`server/bridges/telegram.js`)
- Any new shared module `require`d by Node runtime code (`bin/`, `server/`) must live under a shipped dir or be added to `package.json` `files` — otherwise it's missing from the published tarball and crash-loops on fresh install (#937/#939). `server/pack-smoke.test.js` guards this; CI (`.github/workflows/ci.yml`) runs the suite on every PR and push to main (#976).

## Running locally

```bash
npm install        # install deps
npm run dev        # start frontend (Next.js)
node server/       # start backend (Express + pty)
```
