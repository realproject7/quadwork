# QuadWork — Troubleshooting

Common issues and fixes, structured as **Symptom > Cause > Fix**. Searchable by error message.

---

## Claude Code trust prompt blocking agents

**Symptom:** A Claude Code agent hangs on startup. Its terminal shows "Do you trust the files in this folder?" and waits for input.

**Cause:** Claude Code requires explicit directory trust before running, and `--dangerously-skip-permissions` skips permission prompts but NOT the trust gate. QuadWork pre-trusts each Claude-backed agent's worktree automatically during project creation, by running `claude -p` in it once, so the prompt normally never appears. A hang means that pre-trust didn't complete for this worktree — e.g. `claude` wasn't on `PATH` when the project was created, the worktree was recreated afterward, or the pre-trust timed out.

**Fix:** Re-trust the affected worktree(s) manually, then restart the agent from the dashboard:

```bash
# Run once in each affected worktree
cd /path/to/<project>-head && claude -p "echo ok"
cd /path/to/<project>-dev  && claude -p "echo ok"
cd /path/to/<project>-re1  && claude -p "echo ok"
cd /path/to/<project>-re2  && claude -p "echo ok"
```

This is the same command QuadWork runs at project creation; it writes the trust record so the agent's next launch skips the prompt. Re-running project setup also re-applies the pre-trust.

---

## Chat file permissions

**Symptom:** Chat messages fail to send or load. Agents report errors reading/writing chat files.

**Cause:** The JSONL chat files at `~/.quadwork/<project>/chat/` aren't readable or writable by the QuadWork server process.

**Fix:**
1. Check file permissions on the chat directory and its files:
   ```bash
   ls -la ~/.quadwork/<project>/chat/
   ```
2. Fix permissions:
   ```bash
   chmod 600 ~/.quadwork/<project>/chat/*.jsonl
   ```
3. Ensure the directory itself is accessible:
   ```bash
   chmod 700 ~/.quadwork/<project>/chat/
   ```

---

## JSONL corruption recovery

**Symptom:** Chat history loads partially or shows errors. Server logs mention a JSON parse error for a chat file.

**Cause:** A chat JSONL file has a corrupted line (e.g., incomplete write due to crash). The server skips corrupted lines on read, but the bad line remains in the file.

**Fix:**
1. Backup the corrupted file:
   ```bash
   cp ~/.quadwork/<project>/chat/<channel>.jsonl ~/.quadwork/<project>/chat/<channel>.jsonl.bak
   ```
2. Identify the corrupted line — the server log will reference the line number
3. Remove the corrupted line manually (e.g., open in an editor and delete it)
4. Restart the QuadWork server to reload the file

---

## Agent not receiving messages

**Symptom:** An agent doesn't respond to chat messages. Other agents can send and receive normally.

**Cause:** Messages reach agents two ways — the chat MCP shim (`server/mcp-chat-shim.js`, exposing `chat_read` / `chat_send`) and PTY injection into the agent's terminal. If the agent process isn't running, or its shim failed to start, delivery stalls. The shim is wired into each agent **automatically at launch** — it isn't configured by hand.

**Fix:**
1. Check that the agent process is running:
   ```bash
   ps aux | grep -E "claude|codex|gemini"
   ```
2. Open the agent's terminal in the QuadWork dashboard and look for MCP errors (e.g. the `chat` server failing to connect) or a stuck prompt.
3. Restart the agent from the dashboard — this relaunches its terminal and re-provisions the chat MCP shim.

---

## pm2 PATH stripping (nvm binaries not found)

**Symptom:** Agents fail to launch. Logs show `claude: command not found` or agents get stuck on login prompts even though `claude` works in interactive SSH.

**Cause:** pm2 strips environment variables from child processes. Even if nvm is loaded when you run `pm2 start`, the QuadWork process inherits a minimal PATH without nvm binaries.

**Fix:** Use a wrapper script that sources nvm before starting QuadWork:

```bash
cat > ~/start-quadwork.sh << 'EOF'
#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24
exec quadwork start
EOF
chmod +x ~/start-quadwork.sh

pm2 stop quadwork
pm2 delete quadwork
pm2 start ~/start-quadwork.sh --name quadwork --interpreter /bin/bash
pm2 save
```

**Do NOT fix with symlinks** (e.g., `ln -s ~/.nvm/.../claude /usr/local/bin/claude`). Symlinks resolve the binary but not the environment — agents still won't find auth credentials.

---

## Claude Code blocks --dangerously-skip-permissions as root

**Symptom:** Claude Code refuses to start with `--dangerously-skip-permissions` flag. Error: permission flag is not allowed for root user.

**Cause:** Claude Code explicitly blocks the dangerous permissions bypass when running as root as a safety measure.

**Fix:** Never run QuadWork as root. Create a dedicated non-root user:

```bash
# As root
useradd -m -s /bin/bash quadwork
echo "quadwork ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/quadwork
chmod 440 /etc/sudoers.d/quadwork
```

See the [VPS Installation Guide](install-vps.md#step-2-create-non-root-user-critical) for full setup.


---

## Terminals won't attach (session token / cross-origin) — #968

**Background:** The terminal WebSocket (`/ws/terminal`, `/ws/butler`) and the
PTY-write endpoints (`POST /api/agents/:project/:agent/write`, `/interrupt`)
are authenticated (#968). Two checks run:

1. **Origin allowlist** — the WebSocket upgrade is rejected unless the browser's
   `Origin` is a localhost address or matches the server's own host. This blocks
   a malicious web page you happen to visit from opening a socket to your local
   QuadWork and injecting keystrokes into an agent shell.
2. **Session token** — a shared token (`session_token`, auto-generated and stored
   in `~/.quadwork/config.json` on first start) must accompany every terminal
   WS and PTY-write request.

**Normal local use needs no action.** When you open the dashboard on
`http://127.0.0.1:<port>` (or `localhost`) — directly, or through an SSH tunnel
— the dashboard fetches the token from `GET /api/session-token` and attaches it
automatically.

`/api/session-token` deliberately hands the token out **only** to a request
whose socket, `Host`, and `Origin` are all loopback. This is on purpose: a
malicious page using DNS rebinding, or a reverse proxy forwarding a public
domain, keeps the socket on `127.0.0.1` while the browser's `Host` is a remote
name — so IP alone is not enough, and those requests are refused. The token
never leaves the box automatically.

**Symptom:** Terminals show "connecting…" and never attach, or typing does
nothing, when you reach the dashboard by anything other than a loopback host —
a **reverse proxy / domain** (e.g. the nginx setup in the
[VPS guide](install-vps.md)), a **tailnet / LAN address**, or a separately
hosted frontend. In those cases `GET /api/session-token` returns 403 by design.

**Fix:** Set the token manually in the browser, once per browser:

```js
// In the browser devtools console, on the QuadWork tab:
localStorage.setItem("quadwork_session_token", "<value from ~/.quadwork/config.json>");
// then reload the page.
```

Read the value on the server with:

```bash
grep session_token ~/.quadwork/config.json
```

### Reverse proxy (nginx + Basic Auth): `trusted_dashboard_hosts` — #988

If you serve the dashboard through an **on-box, authenticated reverse proxy** —
e.g. the [VPS guide](install-vps.md) nginx setup terminating HTTP Basic Auth and
proxying `https://p7.quadwork.xyz` to `127.0.0.1:8400` — the browser's `Host`
and `Origin` are the public domain, so `GET /api/session-token` refuses them and
every terminal WebSocket closes with code `1006`. Rather than set the token by
hand in each browser, allowlist the proxied host so the dashboard can fetch the
token itself.

Add the public host(s) to `~/.quadwork/config.json` and restart QuadWork:

```jsonc
{
  "port": 8400,
  "trusted_dashboard_hosts": ["p7.quadwork.xyz"]
  // ...
}
```

With this set, `GET /api/session-token` and the WS upgrade accept a request
**only** when *both*: (1) the socket is loopback — i.e. the request genuinely
arrived via the local proxy, not directly off-box — **and** (2) the forwarded
`Host` and `Origin` are in the allowlist. Anything else (a foreign domain, a
DNS-rebinding page, an un-allowlisted proxy) still gets `403`, so #968's
protections are unchanged. The allowlist is **opt-in**: with it unset (the
default) behaviour is exactly loopback-only as before.

> [!IMPORTANT]
> The reverse proxy **must** be authenticated (e.g. nginx Basic Auth) and bound
> so QuadWork only ever receives proxied traffic on loopback. The allowlist
> tells QuadWork to trust the proxy to have already authenticated the user — it
> is not itself an authentication layer. Your nginx `server` block must forward
> the real host and origin, e.g.:
>
> ```nginx
> location / {
>     auth_basic           "QuadWork";
>     auth_basic_user_file /etc/nginx/.htpasswd;
>     proxy_pass           http://127.0.0.1:8400;
>     proxy_set_header     Host  $host;
>     proxy_set_header     Origin $http_origin;
>     proxy_http_version   1.1;
>     proxy_set_header     Upgrade    $http_upgrade;   # terminal WebSocket
>     proxy_set_header     Connection $connection_upgrade;
> }
> ```

**Security note:** keep `session_token` private and keep QuadWork behind your
existing network controls (127.0.0.1 bind + SSH tunnel, tailnet ACL, or the
nginx Basic Auth from the VPS guide). The token + Origin allowlist are
defence-in-depth against browser-based cross-origin attacks, not a substitute
for network-level access control.

## Every Claude bash command fails silently (exit 1, no output)

**Symptom:** every bash command a `claude` agent runs — even `true` — returns
exit 1 with empty stdout/stderr. The Read tool still works, a plain shell on
the host works, and `codex` agents are unaffected. Easily mistaken for a
bwrap/AppArmor/sandbox failure.

**Cause:** Claude Code keeps its temp under `/tmp/claude-{uid}` and never
cleans it up. On hosts where `/tmp` is mounted with a per-user quota
(`usrquota`), that dir grows until the quota is exhausted — after which Claude
can't write the temp files it needs before executing any command (#957).

**Check:** `du -sh /tmp/claude-$(id -u)` and try `dd if=/dev/zero
of=/tmp/probe bs=1M count=10` — a "Disk quota exceeded" error confirms it.

**Fix:** QuadWork sweeps stale backend temp automatically (hourly, at boot,
and on agent teardown; entries older than 72h). If you hit the quota *before*
a sweep (e.g. the server was down), clear it manually:
`find /tmp/claude-$(id -u)/* -maxdepth 0 -mmin +60 -exec rm -rf {} +`

Tune or disable via `~/.quadwork/config.json`:

```json
{ "temp_cleanup": { "enabled": true, "max_age_hours": 72 } }
```

## Resource staging matrix does not pass

Start with the read-only diagnostic; do not begin by changing systemd or
creating a temp directory:

```bash
quadwork resources preflight
quadwork resources preflight --json
```

If it reports `policy_absent`, use the explicit policy proposal/apply sequence
from the VPS install guide. If it reports an unavailable temp boundary after
the policy is accepted, use the token-bound commands below; the first command
is read-only and the second accepts only its exact current plan:

```bash
quadwork resources temp-install --json
quadwork resources temp-install \
  --apply \
  --accept-sha256 '<exact-token-from-the-temp-proposal>' \
  --json
```

This command only creates or verifies the temp root fixed by the persisted
policy. It does not clean `/tmp/claude-*`, relocate an agent's `TMPDIR`, install
systemd containment, restart a service, or establish staging evidence. On a
failed create it intentionally performs no path-based cleanup; a
`temp_install_failed_cleanup_required` refusal means the created root and any
replacement entries were preserved for explicit inspection and recovery.

- `proof_refused` means the disposable-host acknowledgement or the separate
  `--run-pressure-matrix` opt-in is absent or mismatched. No matrix phase has
  started.
- `proof_unavailable` means a host gate or required live adapter is unavailable.
  The bundled adapter intentionally returns this result rather than simulating
  node-pty, WebSocket, cgroup, temp, health, or OOM evidence.
- `proof_failed` means monitoring or a started phase failed. The coordinator
  stops starting new phases and closes continuous monitoring.

Do not retry a pressure phase on production and do not treat capability flags
as proof. Preserve the redacted JSON, identify the exact candidate unit names
from the disposable run record, stop only those units, wait for their process
trees to exit, and compare the recorded API/global OOM counters. The candidate
flags remain `candidate_pending_staging`; there is no automatic install/repair
or supported-production fallback in this command.
