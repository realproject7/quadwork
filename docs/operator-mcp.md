# Drive QuadWork from an MCP client (Operator MCP)

QuadWork ships an **MCP operator server** — a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-capable client (Claude Code, Claude Desktop, Codex, or another MCP agent) **observe and drive** a running QuadWork instance: read team chat and batch progress, define and run overnight batches, and control individual agents.

It is the same surface a human operator uses from the dashboard, exposed as tools. It talks to the QuadWork backend over `http://127.0.0.1:<port>` (default **8400**) and is launched by the MCP client, **not** by QuadWork itself.

> **The client and QuadWork must share a loopback.** The server only reaches `127.0.0.1:<port>`, so either run the MCP client on the same machine as QuadWork, or bridge the two with the SSH local port-forward in [Remote / VPS](#remote--vps-registration) below.

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

The package installs a dedicated bin, `quadwork-mcp-operator`. Always register with the bin (never a `<quadwork-dir>/server/...` path — that breaks on global/VPS installs). Every client launches the **same** command — `quadwork-mcp-operator --port <port>` — only the registration syntax differs. Examples for common clients follow; any MCP client that can launch a stdio server works the same way.

### Claude Code (local install)

```bash
claude mcp add quadwork -- quadwork-mcp-operator --port 8400
```

Then, in a Claude Code session, the `list_projects`, `batch_status`, `start_batch`, … tools are available. Verify with `list_projects` — it should return your configured projects.

### Codex CLI

Codex registers MCP servers with `-c mcp_servers.<name>` config flags — the same mechanism QuadWork uses to attach its chat shim to Codex-backed agents:

```bash
codex -c 'mcp_servers.quadwork.command="quadwork-mcp-operator"' \
      -c 'mcp_servers.quadwork.args=["--port","8400"]'
```

The `quadwork` tools are then available in the Codex session; verify with `list_projects`.

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

The operator server speaks to `127.0.0.1:8400` — the loopback of **whatever machine the MCP client runs on**. If QuadWork runs on a VPS, a local client registration on your laptop reaches **your laptop's** `127.0.0.1`, not the VPS. Two ways to register correctly:

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

> ⚠️ **A local MCP-client registration reaches THIS device's `127.0.0.1`, not the VPS.** Use SSH or a port-forward so the client and QuadWork share a loopback.

### Remote / VPS troubleshooting

`quadwork-mcp-operator --port 8400` **always** connects to `127.0.0.1:8400` of the machine where that command runs (see [Remote / VPS registration](#remote--vps-registration) above). Most VPS confusion comes from expecting a *direct* connection to the VPS's public IP — which is deliberately closed.

**Expected failures — these are normal, not bugs:**

- `nc -vz <vps-ip> 8400` → *connection refused*, and a browser to `http://<vps-ip>:8400` failing, are **expected** when the backend binds VPS loopback only (the default). Nothing is broken — the port is simply not exposed publicly.
- **Do not open port 8400 publicly to "fix" this.** The backend is not meant to be a public, internet-facing auth boundary; exposing it is a security regression. Forward it over SSH instead.

**The fix — forward the port over SSH, then connect to the local loopback:**

```bash
ssh -N -L 8400:127.0.0.1:8400 <ssh-alias-or-user@vps>
# then, in another local shell:
quadwork-mcp-operator --port 8400   # now reaches the VPS via the forwarded 127.0.0.1:8400
```

`-N` opens the tunnel without starting a remote shell; `-L 8400:127.0.0.1:8400` maps your **local** `127.0.0.1:8400` onto the VPS's loopback `8400`. (Alternatively, run the MCP client over SSH *on* the VPS, as in option 1 above — then no forward is needed.)

**Verify each layer independently, bottom-up:**

```bash
ssh -G <alias> | sed -n '1,20p'           # 1. confirm the alias's user + hostname
lsof -iTCP:8400 -sTCP:LISTEN -n -P        # 2. is something listening on local 8400 (the tunnel)?
quadwork-mcp-operator --port 8400         # 3. end-to-end: list_projects should return
```

> ⚠️ **`ssh <alias>` and `ssh <ip>` can resolve to different users and identity files.** `ssh -G quadwork` may report `user quadwork`, while `ssh -G 178.x.x.x` falls back to your **local** username — so a direct-IP check can silently test the wrong login. Always confirm with `ssh -G` before assuming you're reaching the intended VPS account.

**Symptom → cause → fix:**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `nc -vz <vps-ip> 8400` → refused | Backend binds VPS loopback only (expected) | Not a bug — use the SSH tunnel; do **not** expose 8400 publicly |
| MCP client can't reach QuadWork from your laptop | The client hits **your laptop's** `127.0.0.1`, not the VPS | `ssh -N -L 8400:127.0.0.1:8400 <vps>`, then rerun the client |
| `nc -vz <vps-ip> 22` works but MCP still fails | SSH host reachable, but no forward for 8400 | Add `-L 8400:127.0.0.1:8400` (or run the client on the VPS) |
| `ssh <ip>` uses the wrong user | Direct IP uses your **local** username, not the alias's | Use the alias (`ssh quadwork`) or `user@ip`; confirm with `ssh -G` |
| stdio JSON-RPC returns nothing | Pipe closed before the server wrote its responses | Keep the trailing `sleep` in the [stdio examples](#direct-stdio-json-rpc-invocation) below (raise it on slow links) |

## Direct stdio JSON-RPC invocation

Use this only when your MCP client does not surface tools directly, or when you
need a short non-interactive status script. This is still the **Operator MCP**
path: you launch the stdio MCP server and send JSON-RPC MCP messages on stdin.
It is **not** a raw QuadWork backend API call, and it does not replace the
tool-first rules above.

The command still follows the same loopback rule as registration:
`quadwork-mcp-operator --port 8400` connects to `127.0.0.1:8400` from the
machine where that command runs. For a VPS-hosted QuadWork instance, either run
the command on the VPS or establish an SSH port-forward first. Do not switch to
`curl` against backend endpoints, SSH filesystem inspection, or manual queue
edits.

The minimal flow is:

1. Send `initialize`.
2. Optionally send `tools/list` to inspect available tools.
3. Send one or more `tools/call` requests.

Each request is one JSON object. The examples below write newline-delimited
JSON-RPC requests and pipe them into the installed bin.

The trailing `sleep` in each example keeps stdin open long enough for the MCP
server to write its responses before the pipe closes — without it you may see
no output. Raise it for slower links or heavier calls.

### List projects / verify connection

```bash
python3 - <<'PY'
import json
reqs = [
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"operator-script","version":"1"}}},
  {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}},
  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_projects","arguments":{}}},
]
open('/tmp/qw-list-projects.jsonl','w').write('\n'.join(json.dumps(r) for r in reqs) + '\n')
PY
( cat /tmp/qw-list-projects.jsonl; sleep 4 ) | quadwork-mcp-operator --port 8400
```

If this cannot list projects, fix MCP registration / loopback access first. Do
not fall back to SSH or HTTP endpoint calls.

### Read status and recent chat

Replace `myproject` with the `id` returned by `list_projects`.

```bash
python3 - <<'PY'
import json
reqs = [
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"operator-script","version":"1"}}},
  {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"batch_status","arguments":{"project":"myproject"}}},
  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_chat","arguments":{"project":"myproject","limit":20}}},
]
open('/tmp/qw-status.jsonl','w').write('\n'.join(json.dumps(r) for r in reqs) + '\n')
PY
( cat /tmp/qw-status.jsonl; sleep 8 ) | quadwork-mcp-operator --port 8400
```

### Send an operator instruction to HEAD

```bash
python3 - <<'PY'
import json
msg = "@head Start a focused CODE batch for project-x with issue #123 only. Open a PR, require both reviews, and report back."
reqs = [
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"operator-script","version":"1"}}},
  {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_message","arguments":{"project":"project-x","text":msg}}},
]
open('/tmp/qw-send.jsonl','w').write('\n'.join(json.dumps(r) for r in reqs) + '\n')
PY
( cat /tmp/qw-send.jsonl; sleep 8 ) | quadwork-mcp-operator --port 8400
```

The message is posted as the operator (`user`) and must use the same routing
discipline as dashboard chat, for example `@head ...` to wake Head.

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
2. Kick it off: `start_batch(project, { interval_min: 30 })` for an overnight cadence (30 min is the default; first pulse at T+interval), or `trigger_now(project)` for an immediate first pulse.
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
