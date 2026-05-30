# Drive QuadWork from a Claude agent (Operator MCP)

QuadWork ships an **MCP operator server** — a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets a Claude agent (Claude Code or Claude Desktop) **observe and drive** a running QuadWork instance: read team chat and batch progress, define and run overnight batches, and control individual agents.

It is the same surface a human operator uses from the dashboard, exposed as tools. It talks to the QuadWork backend over `http://127.0.0.1:<port>` (default **8400**) and is launched by the MCP client, **not** by QuadWork itself.

> **The MCP client must run on the same machine as QuadWork.** The server only reaches `127.0.0.1:<port>` — see [Remote / VPS](#remote--vps-registration) below.

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
| `send_message` | `project`, `text` | Post to the team chat **as the operator** (see security note). |
| `set_batch` | `project`, `content` | Replace `OVERNIGHT-QUEUE.md` (full overwrite). |
| `append_batch` | `project`, `content` | Append to the queue (read-then-write). |
| `ensure_batch` | `project` | Create the queue from template if absent (idempotent). |
| `start_batch` | `project`, `interval_min?`, `duration_min?`, `message?` | Start the scheduled trigger that drives the batch. |
| `trigger_now` | `project` | Fire one trigger pulse immediately. |
| `stop_batch` | `project` | Stop the scheduled trigger. |
| `agent_control` | `project`, `agent`, `action` | Non-destructive lifecycle: `start` / `stop` / `restart` / `interrupt` (Ctrl+C). |
| `interrupt_all` | `project` | Send Ctrl+C to every running agent in the project. |

Typical flow: `set_batch` / `append_batch` to define the work → `start_batch` for a scheduled cadence, or `trigger_now` for a single immediate pulse → `batch_status` to watch progress.

## Security

- **stdio + localhost only, no auth by design.** The server trusts the local machine, exactly like the agent chat shim. **Do not expose this server (or the QuadWork backend port) over a network without adding authentication** — that's a future epic.
- **`send_message` acts as the human operator.** Messages post with sender `user`, which **resets the chat loop guard** (same as typing in the dashboard). Use it deliberately — `@head do X` wakes Head via the dispatcher.
- **Destructive operations are intentionally NOT exposed** in this epic: no full reset, no agent-config reset, no raw PTY writes. `agent_control` is limited to the `start`/`stop`/`restart`/`interrupt` allow-list.
- Unknown project / agent ids are rejected client-side **before** any HTTP call, so a typo can't create stray `~/.quadwork/<id>/` state or a runaway trigger timer.
