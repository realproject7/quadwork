# Drive QuadWork from a Claude agent (Operator MCP)

QuadWork ships an **MCP operator server** — a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets a Claude agent (Claude Code or Claude Desktop) **observe and drive** a running QuadWork instance: read team chat and batch progress, define and run overnight batches, and control individual agents.

It is the same surface a human operator uses from the dashboard, exposed as tools. It talks to the QuadWork backend over `http://127.0.0.1:<port>` (default **8400**) and is launched by the MCP client, **not** by QuadWork itself.

> **The MCP client must run on the same machine as QuadWork.** The server only reaches `127.0.0.1:<port>` — see [Remote / VPS](#remote--vps-registration) below.

## Operating model — read this first

You operate QuadWork **exclusively through these MCP tools**. QuadWork is a team
of four agents (**Head, Dev, Reviewer1, Reviewer2**) coordinating over a chat;
you act as the human operator by talking to them.

- **HEAD owns the queue.** `OVERNIGHT-QUEUE.md` has a strict format (batch
  numbering, `**Batch type:**` markers, per-item state annotations). **HEAD
  writes it.** To start any batch you `send_message` HEAD a plain-English
  request — you do **not** write the queue yourself.
- **The tools are the whole surface.** Everything a human operator can do is a
  tool. If something seems to need a shell, a file edit, or an HTTP call, it
  doesn't — there's a tool, or it's HEAD's job.

### Never

- **Never SSH into the host** to run `sed`/`grep`/`find`/`git`/etc. The tools
  reach the running instance; the host filesystem is not your interface.
- **Never edit `OVERNIGHT-QUEUE.md` (or any project file) by hand.** Ask HEAD
  via `send_message`; HEAD formats it correctly. Hand-written queues cause
  malformed items, confirm-loop deadlocks, and a stuck progress panel.
- **Never `curl` / hit the backend HTTP API directly.** Use the tool that wraps
  it.
- **Never reverse-engineer internals** (seed files, `routes.js`, the queue
  grammar) to improvise. If a tool doesn't cover what you need, `send_message`
  HEAD and let the team handle it.

> **If `list_projects` fails, the MCP is not registered/connected — fix THAT
> first** (see [Registration](#registration)); do **not** fall back to SSH or
> curl. No tools = not connected, not a reason to hand-operate.

## Registration

The package installs a dedicated bin, `quadwork-mcp-operator`. Always register with the bin (never a `<quadwork-dir>/server/...` path — that breaks on global/VPS installs).

### Claude Code (local install)

```bash
claude mcp add quadwork -- quadwork-mcp-operator --port 8400
```

Then, in a Claude Code session, the `list_projects`, `batch_status`, `start_batch`, … tools are available. Verify with `list_projects` — it should return your configured projects.

### Claude Desktop

Add this to your `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "quadwork": {
      "command": "quadwork-mcp-operator",
      "args": ["--port", "8400"]
    }
  }
}
```

Restart Claude Desktop. The QuadWork tools appear under the 🔌 tools menu.

### Remote / VPS registration

The operator server speaks to `127.0.0.1:8400` — the loopback of **whatever machine the MCP client runs on**. If QuadWork runs on a VPS, a Claude Desktop registration on your laptop reaches **your laptop's** `127.0.0.1`, not the VPS. Two ways to register correctly:

1. **Run Claude Code over SSH on the VPS host** — register there with the same command; it reaches the VPS's local QuadWork directly.
   ```bash
   ssh you@your-vps
   claude mcp add quadwork -- quadwork-mcp-operator --port 8400
   ```
2. **SSH-forward the port to your local machine**, then register against the forwarded port:
   ```bash
   ssh -L 8400:127.0.0.1:8400 you@your-vps
   # in another local shell, register against the forwarded localhost port:
   claude mcp add quadwork -- quadwork-mcp-operator --port 8400
   ```

> ⚠️ **A local Claude Desktop registration reaches THIS device's `127.0.0.1`, not the VPS.** Use SSH or a port-forward so the client and QuadWork share a loopback.

## Tool reference

### Tier 1 — read / observe (no state change)

| Tool | Input | Does |
|------|-------|------|
| `list_projects` | — | List configured projects (`id`, `name`, `repo`). |
| `read_chat` | `project`, `since_id?`, `limit?` | Read a project's team chat (messages with `id`, `sender`, `text`, ISO `ts`). |
| `batch_status` | `project` | Overnight-batch status `{ active, progress }` (merged batch-active + batch-progress). |
| `read_queue` | `project` | Read the project's `OVERNIGHT-QUEUE.md` markdown. |
| `list_agents` | `project?` | List every configured agent (config ∪ runtime) with state `running`/`stopped`/`missing`. |

### Tier 2 — act

| Tool | Input | Does |
|------|-------|------|
| `send_message` | `project`, `text` | Post to the team chat **as the operator** (see security note). **This is how you start and steer batches** — `@head <plain request>`. |
| `start_batch` | `project`, `interval_min?`, `duration_min?`, `message?` | Start the scheduled trigger that drives the batch (first pulse at T+interval). |
| `trigger_now` | `project` | Fire one trigger pulse immediately. |
| `stop_batch` | `project` | Stop the scheduled trigger. |
| `agent_control` | `project`, `agent`, `action` | Non-destructive lifecycle: `start` / `stop` / `restart` / `interrupt` (Ctrl+C). |
| `interrupt_all` | `project` | Send Ctrl+C to every running agent in the project. |
| `set_batch` | `project`, `content` | **Escape hatch** — overwrite `OVERNIGHT-QUEUE.md` raw. Bypasses HEAD's formatting; **not** the normal path (see below). |
| `append_batch` | `project`, `content` | **Escape hatch** — append raw queue content (read-then-write). Same caveat. |
| `ensure_batch` | `project` | Create the queue from template if absent (idempotent). |

> **`set_batch` / `append_batch` are low-level escape hatches**, for when you
> deliberately bypass HEAD with pre-formatted content. The normal way to define
> work is `send_message` HEAD — and for **review batches** the raw-write tools
> are simply wrong (HEAD must set the `**Batch type:**` marker + per-item state
> annotations the progress panel parses). When in doubt, message HEAD.

## Workflow recipes

Each is 1–3 tool calls. Start every session with `list_projects` to get the
`project` id; if it fails, the MCP isn't connected — fix registration, don't SSH.

**Start a code batch** — let HEAD plan and write the queue:
1. `send_message(project, "@head start a batch for <feature>: #12 #15 #18")` — HEAD files issues + writes `OVERNIGHT-QUEUE.md`, then asks you to start.
2. Kick it off: `start_batch(project, { interval_min: 15 })` for an overnight cadence (first pulse at T+interval), or `trigger_now(project)` for an immediate first pulse.
3. Monitor (below).

**Run a review batch** (review-only — no code, no merges). Just ask HEAD; it stamps the `**Batch type:**` marker — you never touch the queue:
- Tickets: `send_message(project, "@head review tickets #12 #15")` → `batch_type: ticket-review`.
- Merged PRs: `send_message(project, "@head review merged PR #N")` → `batch_type: pr-review`.
Then monitor with `batch_status` (it shows review states: *queued · in review · 1 of 2 approvals · approved*).

**Monitor a batch:**
- `batch_status(project)` — `active` is authoritative for "work remaining"; `progress` may stay sticky on a just-finished batch.
- `read_chat(project, { since_id })` — tail the team conversation.
- `read_queue(project)` — see raw item states (read-only).

**Restart a stuck/exited agent:**
1. `list_agents(project)` — find one whose `state` isn't `running`.
2. `agent_control(project, agent, "restart")` (or `"interrupt"` to send Ctrl+C without killing). `interrupt_all(project)` stops a runaway loop project-wide.

**Check the rate-limit budget:** there is **no operator-MCP tool** for the GitHub rate-limit budget — watch the dashboard's rate-limit badge. To conserve budget, prefer review batches (they discover via `GITHUB.md` + REST, not `gh pr list`). Don't `curl` the API to check it.

## Security

- **stdio + localhost only, no auth by design.** The server trusts the local machine, exactly like the agent chat shim. **Do not expose this server (or the QuadWork backend port) over a network without adding authentication** — that's a future epic.
- **`send_message` acts as the human operator.** Messages post with sender `user`, which **resets the chat loop guard** (same as typing in the dashboard). Use it deliberately — `@head do X` wakes Head via the dispatcher.
- **Destructive operations are intentionally NOT exposed** in this epic: no full reset, no agent-config reset, no raw PTY writes. `agent_control` is limited to the `start`/`stop`/`restart`/`interrupt` allow-list.
- Unknown project / agent ids are rejected client-side **before** any HTTP call, so a typo can't create stray `~/.quadwork/<id>/` state or a runaway trigger timer.
