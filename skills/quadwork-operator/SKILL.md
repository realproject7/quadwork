---
name: quadwork-operator
description: >-
  Operate/drive a QuadWork instance from an external Claude agent — assign and
  start an overnight batch, monitor agents and batch progress, append work, run
  a review batch, and control the team — via the Operator MCP
  (quadwork-mcp-operator, shipped in QuadWork 2.3.0). Use when the user wants to
  register the QuadWork Operator MCP or operate a running QuadWork (local or on
  a VPS) through its MCP tools rather than the dashboard.
---

# Operate QuadWork via the Operator MCP

QuadWork runs a team of four AI agents — **Head, Dev, Reviewer1, Reviewer2** —
through a GitHub-native loop (Issue → Branch → PR → 2 Reviews → Merge). The
**Operator MCP** (`quadwork-mcp-operator`) exposes the same surface a human
operator uses from the dashboard as MCP tools, so you can register it and drive
a running QuadWork instance yourself: read chat, define/run batches, monitor
progress, and control individual agents.

This skill is the operating *playbook*. For the exhaustive tool reference,
Claude Desktop config, and VPS details, see
[`docs/operator-mcp.md`](../../docs/operator-mcp.md).

## When to use this skill

- The user asks to **register** the QuadWork Operator MCP, or to **drive/run**
  a QuadWork instance (assign a batch, monitor agents, control the team) from
  an external Claude agent.
- The user is operating QuadWork **on a VPS** and wants to reach it over SSH.

If the user just wants conceptual docs, point them at the README sections; this
skill is for *doing* the operating.

## 1. Register the MCP

The QuadWork npm package installs a dedicated bin, `quadwork-mcp-operator`.
Always register with the bin (never a `server/...` path — that breaks on
global/VPS installs). The server talks to the QuadWork backend at
`http://127.0.0.1:<port>` (default **8400**) and is launched by the MCP client,
**not** by QuadWork.

**Local (Claude Code):**

```bash
claude mcp add quadwork -- quadwork-mcp-operator --port 8400
```

**VPS / remote.** The server only reaches the **loopback of the machine the MCP
client runs on**. A laptop registration reaches *your laptop's* `127.0.0.1`, not
the VPS. Two correct ways:

1. **Run Claude Code on the VPS host** (e.g. over SSH) and register there.
2. **SSH-forward the port**, then register against the forwarded localhost:

   ```bash
   ssh -L 8400:127.0.0.1:8400 you@your-vps
   # in another local shell:
   claude mcp add quadwork -- quadwork-mcp-operator --port 8400
   ```

> Proven live: an external agent drove a VPS QuadWork through this MCP over an
> SSH tunnel — `list_projects` / `read_chat` / `batch_status` / `send_message`
> all worked.

**Verify:** call `list_projects` — it should return your configured projects.
Always start here; every other tool takes a project `id` from this list.

## 2. Tool map

### Tier 1 — read / observe (no state change)

| Tool | Args | Returns |
|------|------|---------|
| `list_projects` | — | `[{ id, name, repositories, repo }]`; `repo` is the temporary primary alias. Use `repositories[]` for qualified work. |
| `read_chat` | `project`, `since_id?`, `limit?` (default 50) | message array (`id`, `sender`, `text`, ISO `ts`, `type`, `channel`) |
| `batch_status` | `project` | `{ active, progress }` follows the live `## Active Batch`. An empty section stays empty; completed or historical work never becomes a new assignment. |
| `read_queue` | `project` | `{ exists, content }` (raw `OVERNIGHT-QUEUE.md` markdown) |
| `list_agents` | `project?` | `[{ project, agent, state, error }]` — `state` is `running` / `stopped` / `missing` (omit `project` for all projects) |

### Tier 2 — act (mutates live state)

| Tool | Args | Does |
|------|------|------|
| `send_message` | `project`, `text` | Post to chat **as the operator** (sender `user`). Bare agent names → `@mentions` automatically. **Resets the loop guard** (see Safety). |
| `set_batch` | `project`, `content` | Replace `OVERNIGHT-QUEUE.md` (full overwrite; rejects empty). Does **not** start it. |
| `append_batch` | `project`, `content` | Append to the queue (read-then-write; creates if absent). Does not start it. **Lost-update caveat** — re-`read_queue` first if you may have edited it elsewhere. |
| `ensure_batch` | `project` | Create the queue from template if absent (idempotent) → `{ ok, existed }`. |
| `start_batch` | `project` | Enable the **Head-only Project Monitor** for the live batch. No cadence, no message, no repeating pulse: it writes one `[QW-MONITOR:<kind>]` event to `@head` only when a fixed-policy transition is due. Rejected if the project is idle, archived, not V2-ready, or has no active batch. Passing any trigger-authoring field is rejected with `trigger_authoring_removed`. |
| `trigger_now` | `project` | Run **one** deduplicated Monitor evaluation now (compatibility name for `project_monitor evaluate_now`). Unchanged state writes nothing and wakes no agent. Rejected if idle. |
| `stop_batch` | `project` | Suspend the project's Monitor (compatibility name for `project_monitor stop`). Observation only — batch, workers and queue are untouched. |
| `agent_control` | `project`, `agent`, `action` | Non-destructive lifecycle: `start` / `stop` / `restart` / `interrupt` (Ctrl+C — interrupts, does not kill). |
| `interrupt_all` | `project` | Ctrl+C every running agent in the project → `{ ok, interrupted }`. |

## 3. Workflow recipes

### Assign and observe a batch
1. `list_projects` → use the exact project id and registered repositories.
2. `list_agents` → confirm the configured roles are running. Use the existing `agent_control` lifecycle tools to start a stopped role when the operator has authorized the work.
3. `send_message` → `"@head plan and implement <feature>: owner/repo#12 owner/repo#15"`. Head owns issue edits, scope, the queue, frozen manifests and authenticated assignment. A queue file or chat sentence alone cannot authorize a V2 worker.
4. Head enables the Project Monitor after the batch is qualified. `start_batch` enables this same observation; `trigger_now` requests one immediate evaluation. Neither creates assignments, starts workers, nor advances the queue. There is no cadence or repeating message. Due events go only to Head.
5. Observe progress below. Head explicitly advances eligible work and closes the batch at completion. Empty or completed batches never start the next batch automatically.

For Local verification, Dev runs the repository's required commands and submits
named `unit`, `typecheck`, and `build` receipts for the exact candidate and base.
These labels are not executable commands. Head needs passing current evidence,
two independent exact-candidate final approvals and a fresh merge gate before
merging. No GitHub Actions run is required in local mode; explicit external-check
policies retain their own requirements. Follow the
[verification contract](../../docs/operator-mcp.md#local-verification-and-merge-evidence).

### Monitor a running batch
- `batch_status` → inspect the live `active` and per-item `progress`. Current
  Batch never falls back to historical work when the Active Batch section is empty.
- `read_chat` with `since_id` (the last id you saw) to tail the team conversation.
- `read_queue` to see raw item states.

### Append to an active batch
1. `read_queue` (avoid the lost-update caveat).
2. `append_batch` with the new items, **or** simply
   `send_message` → `"@head add #20 to the current batch"` and let Head edit the
   queue.

### Drive a review batch
Review batches review *tickets* or *merged PRs* in review-only mode (no code, no
merges). Just ask Head — it stamps the `**Batch type:**` marker:
- `send_message` → `"@head review tickets #12 #15"` (`ticket-review`), or
- `send_message` → `"@head review merged PRs #40 #41"` (`pr-review`).

Head alone edits issue contracts, files follow-ups and closes review items. Dev
has no review-driver or issue-edit role. Reviewers return independent verdicts
bound to the assigned revision or merged SHA.

`batch_status` then shows review states (*queued · in review · 1 of 2 approvals ·
approved*), not merge language. See
[`docs/review-batches.md`](../../docs/review-batches.md) for the queue contract.

### Restart a stuck agent
1. `list_agents` (filter by `project`) → find the one whose `state` isn't
   `running`, or that's wedged.
2. `agent_control` with `action: "restart"` (stop + start) — or `"interrupt"`
   to send Ctrl+C **without** killing the session (good for a runaway loop).
3. For a project-wide stop, `interrupt_all`.

### Check the GitHub rate-limit budget
There is **no operator-MCP tool for the rate-limit budget** — don't invent one.
Watch the dashboard's rate-limit badge, and to *conserve* budget prefer **review
batches**, which discover work via `GITHUB.md` + the REST API instead of the
GraphQL-backed `gh pr list` (see the review-batch recipe above).

## 4. Safety boundaries

- **Localhost / no-auth by design.** The server only reaches `127.0.0.1:<port>`
  and the MCP client must run on the same host (or via SSH-forward). **Never
  expose the backend port over a network without adding authentication.**
- **`send_message` acts as the human operator** (sender `user`) and **resets the
  chat loop guard** — exactly as if a human typed in the dashboard. It *wakes*
  agents (`@head do X`). Use it deliberately; don't spam it.
- **Do not manage the backend through agent lifecycle tools.** The backend
  defaults to port **8400**. `agent_control` manages the selected role session;
  it does not control the backend. V2 has no per-project legacy MCP HTTP/SSE ports.
- **Act-tools mutate live state — confirm before destructive moves.**
  `set_batch` overwrites the **entire** queue; `start_batch` enables observation
  only; `append_batch` is not atomic (re-read first). Destructive ops
  (full reset, config reset, raw PTY writes) are intentionally **not** exposed.
- Unknown project/agent ids are rejected **before** any HTTP call, so a typo
  can't strand `~/.quadwork/<id>/` state or start a runaway trigger.
