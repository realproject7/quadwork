# QuadWork — Product Proposal

> A self-hosted, open-source dashboard that organizes a multi-agent coding workflow into one clean web view — replacing the VS Code + iTerm + browser juggling with a single screen.

**Date**: 2026-03-31
**Author**: Cho (T1 / Operator)
**Status**: Draft

---

## 1. Problem Statement

Running a multi-agent coding team today requires stitching together several disconnected tools:

- **AgentChattr** for agent-to-agent chat routing
- **tmux** for monitoring agent terminal sessions
- **GitHub** for issues, PRs, and reviews
- **Telegram** for mobile operator access
- **agent-memory** scripts for shared knowledge injection
- Manual `launch.sh` / `wrapper.py` orchestration

The operator context-switches between 4–6 windows constantly. There is no single place to see what the team is doing, assign work, and track progress.

## 2. Vision

**QuadWork** is a single web dashboard that replaces the operator's current multi-window setup (VS Code + iTerm + AgentChattr browser tab + GitHub) with one organized view. It doesn't reinvent any of these tools — it **embeds and arranges** them into a unified, project-based interface.

**Core principles:**
1. **Dead simple** — no database, no auth, no heavy dependencies. JSON config, local terminals, one browser tab.
2. **Day-0 ready** — `npx quadwork init` and you have a working 4-agent team in minutes
3. **Templatized** — workflow rules, agent seeds, and panel layouts ship as defaults, but the operator can customize
4. **Display layer, not logic layer** — QuadWork organizes terminals, chat, and GitHub panels; it doesn't replace them

Think of it as: **"AgentChattr + tmux + GitHub dashboard + Telegram bridge + agent-memory, in one browser tab."**

## 3. Core Workflow

The system enforces a fixed workflow loop per task:

```
┌─────────────────────────────────────────────────────┐
│  1. Operator ↔ T1: Ideate & scope                   │
│  2. T1 creates Issue(s) with acceptance criteria     │
│  3. T1 assigns to T3                                 │
│  4. T3 implements → opens PR                         │
│  5. T3 requests review from T2a + T2b                │
│  6. T2a/T2b review (approve / request changes)       │
│  7. T3 aggregates approvals → notifies T1            │
│  8. T1 verifies → merges                             │
└─────────────────────────────────────────────────────┘
```

This is not configurable drag-and-drop — it's the enforced team protocol.

## 4. Architecture

### 4.1 High-Level

```
┌──────────────────────────────────────────────────────────┐
│                   QuadWork Dashboard                      │
│          (React / Next.js — single web view)             │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ T1 Terminal  │  │ Tickets &    │  │ Agent Chat     │  │
│  │ (xterm.js)   │  │ PRs Board    │  │ (AgentChattr)  │  │
│  ├──────────────┤  ├──────────────┤  ├────────────────┤  │
│  │              │  │              │  │ T2a/T2b/T3     │  │
│  │              │  │              │  │ Terminals      │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
└────────────────────────┬─────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │  QuadWork Backend   │
              │  (Node.js)          │
              ├─────────────────────┤
              │ • Terminal (pty)    │  ← spawns agent CLIs
              │ • GitHub API       │  ← issues/PRs board
              │ • AgentChattr API  │  ← embeds chat
              │ • Config/templates │  ← seeds, workflow rules
              └─────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
        ┌─────┴─────┐        ┌─────┴─────┐
        │Claude Code│        │  Codex    │
        │ (local)   │        │  (local)  │
        └───────────┘        └───────────┘
```

All agents run locally on the operator's machine. No VPS or cloud infrastructure required.

### 4.2 Component Breakdown

| Component | Role | Source |
|-----------|------|--------|
| **Dashboard** | React SPA — embeds terminals, chat, GitHub board | New |
| **Backend** | Spawns agent pty sessions, serves GitHub data | New |
| **Workflow templates** | Default AGENTS.md seeds, CLAUDE.md rules, config | New (packaged from existing) |
| **AgentChattr** | Agent-to-agent chat routing (embedded in Panel 3) | Existing (bcurts/agentchattr) |
| **wrapper.py** | Agent process lifecycle + auto-trigger | Existing (agent-os) |
| **Telegram Bridge** | Mobile operator access (optional add-on) | Existing (agentchattr-telegram) |
| **Memory Butler** | Shared knowledge injection (optional add-on) | Existing (agent-memory) |

## 5. Dashboard Design

### 5.1 Page Structure

Two-level navigation with a Discord-style left sidebar:

```
┌────┬────────────────────────────────────────────────────────┐
│    │                                                        │
│ 🏠 │   Main Dashboard  /  Project Dashboard                 │
│    │                                                        │
│────│                                                        │
│    │                                                        │
│ P1 │         (content area — see 5.3 and 5.4)               │
│    │                                                        │
│ P2 │                                                        │
│    │                                                        │
│ P3 │                                                        │
│    │                                                        │
│────│                                                        │
│    │                                                        │
│ +  │   ← Add new project                                    │
│    │                                                        │
│────│                                                        │
│ ⚙  │   ← Global settings                                   │
│    │                                                        │
└────┴────────────────────────────────────────────────────────┘

Sidebar:
  🏠  Home (Main Dashboard)
  P1  Project icon/avatar (click → Project Dashboard)
  P2  Project icon/avatar
  P3  Project icon/avatar
  +   Add Project (opens setup wizard)
  ⚙   Settings
```

- Each project shows as a circular icon (like Discord servers)
- Hover shows project name tooltip
- Active project is highlighted
- `+` button opens the project setup wizard (see Section 6)
- Sidebar persists across all pages

### 5.2 Main Dashboard (Home)

Overview of all projects at a glance. Shown when clicking the home icon.

```
┌─────────────────────────────────────────────────────────────┐
│  QuadWork                                          ⚙       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────┐  │
│  │ PlotLink        │  │ DropCast        │  │ + New      │  │
│  │ ● 4 agents      │  │ ● 4 agents      │  │   Project  │  │
│  │ 2 open PRs      │  │ 1 open PR       │  │            │  │
│  │ T3 building     │  │ idle            │  │            │  │
│  │ Last: 3m ago    │  │ Last: 2h ago    │  │            │  │
│  └─────────────────┘  └─────────────────┘  └────────────┘  │
│                                                             │
│  Recent Activity                                            │
│  ─────────────────                                          │
│  • PlotLink: T2a approved PR #673              3m ago       │
│  • PlotLink: T3 pushed to task/669-e2e-fix     5m ago       │
│  • DropCast: T1 merged PR #264                 2h ago       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

- Project cards with live status summary (agent count, open PRs, current state)
- Click any project card → navigates to its Project Dashboard
- Recent activity feed aggregated across all projects
- Quick-add project card

### 5.3 Project Dashboard — 4 Panels

Shown when clicking a project in the sidebar. The main view is a 2×2 grid, matching the operator's current tmux + browser workflow:

```
┌─────────────────────────────┬─────────────────────────────┐
│                             │                             │
│   Panel 1: T1 Terminal      │   Panel 2: Tickets & PRs    │
│   (Operator ↔ T1 via CLI)   │   (GitHub Issues + PRs)     │
│                             │                             │
│   • Real terminal (xterm)   │   • Open issues list        │
│   • Operator types here     │   • Open PRs + review state │
│   • T1 creates tickets,     │   • CI check status         │
│     reports merge status    │   • Click → opens GitHub    │
│                             │                             │
│                             │                             │
├─────────────────────────────┼─────────────────────────────┤
│                             │                             │
│   Panel 3: Agent Chat       │   Panel 4: Agent Terminals  │
│   (AgentChattr web UI)      │   (T2a, T2b, T3)            │
│                             │                             │
│   • Embedded AgentChattr    │   • T2a  │ T2b              │
│   • All agent messages      │   • ──────┼──────           │
│   • Channel selector        │   • T3 (full width)         │
│   • @mention routing        │   • Live terminal output    │
│                             │   • Scrollback per agent    │
│                             │                             │
└─────────────────────────────┴─────────────────────────────┘
```

### 5.4 Panel Details

**Panel 1 — T1 Terminal (Operator ↔ T1)**
- Embedded terminal (xterm.js) running the T1 agent process
- The operator interacts with T1 directly in the terminal, same as today's tmux pane
- T1 handles ideation, ticket creation, and merge decisions through the CLI
- No custom chat UI — just the real terminal

**Panel 2 — Tickets & PRs (read-only)**
- Simple list view of open GitHub Issues + PRs for the connected repo
- Each item shows: title, assignee, status badge, linked PR
- PR items show: T2a/T2b review status, CI check status
- Click to open in GitHub (external link)
- Data fetched via `gh` CLI — no GitHub SDK, no OAuth

**Panel 3 — Agent Chat (AgentChattr)**
- Embedded AgentChattr web UI (iframe or API-driven feed)
- Shows all inter-agent messages in real time
- Channel switching (#general, #ops, project-specific)
- Operator can intervene by sending messages directly
- Same UI as the current `http://127.0.0.1:8300` — just embedded in the dashboard

**Panel 4 — Agent Terminals (T2a, T2b, T3)**
- 3 embedded terminal panes (xterm.js) showing the other agent processes
- Layout: T2a (top-left), T2b (top-right), T3 (bottom, full-width)
- Same as today's tmux split — just rendered in the browser
- Click to expand any pane to full panel
- Scrollback buffer per agent

## 6. Setup & Onboarding

### 6.1 One-Command Install

```bash
npx quadwork init
```

The CLI wizard handles everything:

```
$ npx quadwork init

Welcome to QuadWork!

Step 1/5: Prerequisites Check
  ✓ Node.js 20+ detected
  ✓ Python 3.10+ detected
  ✗ AgentChattr not found
    → Installing AgentChattr... done (clone + venv)
  ✓ GitHub CLI (gh) detected
  ✓ Claude Code detected

Step 2/5: GitHub Connection
  → Repo URL: owner/repo
  → Authenticating via gh... done
  → Setting up branch protection... done

Step 3/5: Agent Configuration
  → CLI backend: (claude-code / codex)
  → Creating 4 agent worktrees... done
  → Writing default AGENTS.md seeds... done
  → Writing default CLAUDE.md rules... done

Step 4/5: AgentChattr Setup
  → Writing config.toml (4 agents + channels)... done
  → Starting AgentChattr on port 8300... done
  → Registering agents... done

Step 5/5: Optional Add-ons
  → Telegram Bridge? (y/n)
    → Bot token: ***
    → Chat ID: ***
    → Bridge started... done
  → Shared Memory? (y/n)
    → Butler pipeline configured... done

✓ QuadWork is ready!
  Dashboard: http://localhost:3000
  AgentChattr: http://localhost:8300
```

### 6.2 What `init` Sets Up

| What | Details |
|------|---------|
| **AgentChattr** | Installs if missing, writes `config.toml`, starts server |
| **Agent worktrees** | Creates 4 git worktrees (`head/`, `re1/`, `re2/`, `dev/`) |
| **Seed files** | Copies default `AGENTS.md` per agent (Head=coordinator, RE1/RE2=reviewer, Dev=builder) |
| **Workflow rules** | Writes default `CLAUDE.md` with the Head→Dev→RE1/RE2→Head protocol |
| **wrapper.py** | Copies agent launcher with auto-trigger and REMINDER injection |
| **GitHub** | Configures branch protection (require 1 approval on `main`) |
| **Telegram** | (Optional) Installs bridge, writes bot config, starts daemon |
| **Shared Memory** | (Optional) Sets up butler scripts and injection pipeline |

### 6.3 Adding a Project (Post-Init)

After initial setup, add more projects from the dashboard sidebar (`+` button) or CLI:

```bash
npx quadwork add-project
  → Name: my-new-project
  → Repo: owner/repo
  → CLI backend: claude-code
  → Creating worktrees... done
  → ✓ Project added to dashboard
```

### 6.4 Settings (via Dashboard UI)

- Agent display names (default: T1, T2a, T2b, T3)
- CLI backend per agent (claude-code / codex)
- Model selection per agent
- AGENTS.md seed editor (in-browser)
- AgentChattr URL (default: http://127.0.0.1:8300)
- Auto-restart policy per agent

## 7. Telegram Bridge Integration

Reuses the existing `agentchattr-telegram` bridge:

- Per-project Telegram bot connection
- Operator receives all agent chat messages on mobile
- Operator can reply with @mentions and #channel routing
- `/status`, `/channels`, `/merge` commands from Telegram
- New: `/approve <PR#>` command to approve merges from mobile

## 8. Shared Memory Dashboard

Surfaces the `agent-memory` butler system in the UI:

- **Memory Cards**: Browse and search existing memory cards
- **Injection Status**: See which agents have `shared-memory.md` injected
- **Butler Controls**:
  - `Scan` — run butler-scan.sh to collect new cards
  - `Consolidate` — run butler-consolidate.sh to merge duplicates
  - `Inject` — run inject.sh to push to agent workspaces
- **Memory Editor**: View/edit shared-memory.md content directly
- **Card Timeline**: Visual timeline of when memories were created/updated

## 9. Design Direction

Terminal-native, dark-mode-only aesthetic. The visual language comes from PlotLink's pre-overhaul design — monospace, minimal, with a bright green accent on deep black surfaces.

**Reference**: [`realproject7/plotlink` at tag `pre-design-overhaul`](https://github.com/realproject7/plotlink/tree/pre-design-overhaul)
- Design tokens: [`src/app/globals.css`](https://github.com/realproject7/plotlink/blob/pre-design-overhaul/src/app/globals.css)
- Component examples: [`src/components/`](https://github.com/realproject7/plotlink/tree/pre-design-overhaul/src/components)
- Page layouts: [`src/app/page.tsx`](https://github.com/realproject7/plotlink/blob/pre-design-overhaul/src/app/page.tsx)

### 9.1 Design Tokens

```css
:root {
  --bg: #0a0a0a;           /* deep black background */
  --bg-surface: #111111;   /* card/panel surfaces */
  --text: #e0e0e0;         /* primary text */
  --text-muted: #737373;   /* secondary text */
  --accent: #00ff88;       /* bright green accent */
  --accent-dim: #00cc6a;   /* muted green for hover/secondary */
  --border: #2a2a2a;       /* subtle borders */
  --error: #ff4444;        /* error states */
}
```

### 9.2 Design Principles

- **Dark mode only** (v1) — no light theme, this is a terminal tool
- **Monospace font** — Geist Mono everywhere (body, headings, labels)
- **Green accent** (`#00ff88`) — terminal green for active states, highlights, agent status indicators
- **Layered dark surfaces** — `#0a0a0a` base → `#111111` panels → `#2a2a2a` borders
- **No rounded pastel cards** — sharp corners, thin borders, minimal decoration
- **Text selection** — green background with black text (like terminal selection)
- **Agent status colors** — green (active), muted (idle), red (error)
- **Panel borders** — subtle `1px solid #2a2a2a`, no shadows or glows
- **Information density** — dev-tool level density, not consumer SaaS spacing

### 9.3 Visual Reference

The dashboard should feel like a well-organized tmux session rendered in a browser — not a SaaS product. Think: GitHub dark mode meets terminal emulator.

## 10. Tech Stack (Proposed)

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | React + Tailwind | Fast iteration, component ecosystem |
| Terminal | xterm.js | Standard web terminal emulator |
| Backend | Node.js (Express/Fastify) | Lightweight local server |
| Config | JSON file (`~/.quadwork/config.json`) | No database — just a config file |
| Process mgmt | node-pty | Spawns agent terminal sessions |
| GitHub | `gh` CLI (shelled out) | Already installed, no SDK needed |
| Chat | AgentChattr REST API | Already running separately |
| Telegram | agentchattr-telegram | Already built (optional) |
| Memory | Shell scripts (butler) | Already built (optional) |

**No database. No ORM. No auth layer. No SDK dependencies beyond xterm.js and node-pty.**

## 11. Phased Roadmap

### Phase 1 — Core Dashboard (MVP)
- [ ] Project CRUD + GitHub repo connection
- [ ] 4-panel layout with resizable panes
- [ ] Panel 3: AgentChattr chat feed (read-only via API polling)
- [ ] Panel 4: Embedded terminals for 4 agents (xterm.js + node-pty)
- [ ] Agent lifecycle: start / stop / restart from UI
- [ ] Basic settings page

### Phase 2 — GitHub Panel + Onboarding
- [ ] Panel 2: Issues + PRs list (read-only, via `gh` CLI)
- [ ] PR status with T2a/T2b review + CI badges
- [ ] `npx quadwork init` setup wizard
- [ ] Default workflow templates (AGENTS.md seeds, CLAUDE.md rules)

### Phase 3 — Optional Add-ons
- [ ] Telegram bridge setup in settings
- [ ] Shared memory viewer + butler controls
- [ ] AGENTS.md seed editor in UI

### Phase 4 — Polish
- [ ] Multi-project switching (sidebar)
- [ ] Agent log search and filtering
- [ ] Theme customization (accent colors)

## 12. What We Already Have

A significant amount of the system already exists and is battle-tested:

| Component | Status | Location |
|-----------|--------|----------|
| 4-agent workflow | Production | agent-os (CLAUDE.md rules) |
| AgentChattr chat | Production | bcurts/agentchattr |
| Agent seeds (AGENTS.md) | Production | agent-os/agentchattr2/seeds/ |
| wrapper.py (lifecycle) | Production | agent-os/agentchattr2/wrapper.py |
| Telegram bridge | Published | agentchattr-telegram (MIT) |
| Memory butler | Production | agent-memory repo |
| GitHub workflow (v6) | Production | CLAUDE.md + agent seeds |

The dashboard and backend API are the new pieces. Everything else is integration work connecting existing, working components.

## 13. Decisions

| Question | Decision |
|----------|----------|
| **Repo** | Standalone private repo: `realproject7/quadwork` |
| **Open source** | Build private, flip to public when MVP is solid. Run credential scan before flipping. |
| **AgentChattr** | External dependency (Option A) — auto-installed by `npx quadwork init` if missing |
| **Auth** | Single-user, local-only for v1 |
| **Remote agents** | Local-only for v1. Remote/VPS support is a future consideration. |
| **Design** | Dark mode only, terminal aesthetic (see Section 9) |

### Launch checklist (before flipping public)
- [ ] `npx quadwork init` works end-to-end on a clean machine
- [ ] README with screenshots, quickstart, and feature overview
- [ ] Credential scan: `git log -p | grep -i "token\|secret\|key\|password"`
- [ ] LICENSE (MIT)
- [ ] Clean up stale issues/PRs

---

*QuadWork doesn't reinvent the agent stack — it organizes what already works (terminals, AgentChattr, GitHub) into one view that anyone can set up on day 0. The value is in the packaging: templatized workflow, unified dashboard, zero window-juggling.*
