# QuadWork — VPS Installation Guide

Step-by-step guide for installing QuadWork on a remote VPS (Hetzner/Ubuntu). Based on real deployment notes. Designed for both humans and AI coding agents.

---

## Recommended VPS Setup

**Provider:** [Hetzner Cloud](https://www.hetzner.com/cloud/) — tested and confirmed working.

| Setting | Value |
|---|---|
| Type | Shared Resources > **Regular Performance** (x86 AMD) |
| Plan | **CPX32** — 4 vCPU, 8 GB RAM, 160 GB disk (~$17/mo) |
| Image | **Ubuntu 24.04** |
| Networking | **IPv4 + IPv6** |
| SSH keys | Add your public key |

**Why CPX32:** QuadWork runs 4 concurrent AI agents, each spawning its own PTY + subprocess. 4 vCPUs map to the 4-agent model, 8 GB RAM provides headroom. Smaller plans may work for testing.

**Why Regular Performance:** Newer AMD hardware with consistent CPU. Cost-Optimized uses older generation hardware — not ideal for sustained agent workloads.

---

## Step 1: Initial SSH Access

After creating the server, add it to your local `~/.ssh/config`:

```
Host quadwork
    User root
    HostName <server-ip>
    Port 22
    IdentityFile ~/.ssh/<your-key>
```

Verify: `ssh quadwork`

---

## Step 2: Create Non-Root User (CRITICAL)

Claude Code blocks `--dangerously-skip-permissions` when running as root. Agents will crash immediately if QuadWork runs under root.

Run these as root:

```bash
useradd -m -s /bin/bash quadwork
mkdir -p /projects
chown quadwork:quadwork /projects
```

Grant passwordless sudo:

```bash
echo "quadwork ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/quadwork
chmod 440 /etc/sudoers.d/quadwork
```

Copy SSH keys:

```bash
mkdir -p /home/quadwork/.ssh
cp /root/.ssh/authorized_keys /home/quadwork/.ssh/authorized_keys
chown -R quadwork:quadwork /home/quadwork/.ssh
chmod 700 /home/quadwork/.ssh
chmod 600 /home/quadwork/.ssh/authorized_keys
```

Update local `~/.ssh/config` — change `User root` to `User quadwork`. **All subsequent steps run as the `quadwork` user.**

---

## Step 3: System Packages

```bash
sudo apt-get update
sudo apt-get install -y git apache2-utils
```

`apache2-utils` provides `htpasswd` (used in Step 10 for HTTP basic auth).

---

## Step 4: Node.js via nvm (REQUIRED)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
nvm use 24
```

**Do NOT use system Node (`apt` or `nodesource`).** Only use nvm. System Node alongside nvm creates PATH conflicts — pm2 and QuadWork spawn agents with system PATH (missing nvm binaries), causing agents to fail auth or not be found.

---

## Step 5: GitHub CLI

```bash
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | sudo tee /etc/apt/sources.list.d/github-cli.list
sudo apt-get update && sudo apt-get install -y gh
```

---

## Step 6: AI Agent CLIs

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g @google/gemini-cli   # only if using Gemini agents
```

Install whichever backends your roles will use — each of the four roles can run
Claude Code, Codex, or Gemini, chosen per role during setup. All binaries
(`claude`, `codex`, `gemini`, `quadwork`, `pm2`) live under
`~/.nvm/versions/node/v24.x.x/bin/`.

### Authenticate CLIs

> **Operator-required, interactive steps.** These each open a browser or
> one-time-code login and must be completed by the operator via `ssh quadwork`
> — they cannot be done by an agent. Run only the ones for the backends you
> installed:

```bash
gh auth login     # Follow browser-based auth flow
claude            # Follow login prompt
codex             # Follow login prompt
gemini            # Follow login prompt (only if using Gemini)
```

**If migrating from an existing server**, copy auth configs instead:

```bash
# From your local machine
ssh quadwork-old 'tar czf /tmp/auth-backup.tar.gz .claude .codex .config/gh'
scp quadwork-old:/tmp/auth-backup.tar.gz /tmp/
scp /tmp/auth-backup.tar.gz quadwork:/tmp/
ssh quadwork 'cd ~ && tar xzf /tmp/auth-backup.tar.gz && rm /tmp/auth-backup.tar.gz'
```

---

## Step 7: Install QuadWork

```bash
npm install -g quadwork@latest
```

Run interactive setup — this creates `~/.quadwork/config.json`, prompts for the
dashboard port (default **8400**), and configures your first project:

```bash
quadwork init
```

The QuadWork server always binds **loopback only** (`127.0.0.1:8400`); the port
is never opened to the public network directly. Remote access is added later
(see [Remote Access](#remote-access)) via an SSH tunnel or an authenticated
reverse proxy.

---

## Step 8: Process Management with pm2

```bash
npm install -g pm2
```

**IMPORTANT:** pm2 strips PATH from child processes. Even if nvm is loaded, the QuadWork process won't have nvm binaries in PATH. **Do not fix with symlinks** — they resolve the binary but not the environment.

Before creating or starting the wrapper, complete the explicit resource-policy
proposal/apply and `temp-install` proposal/apply sequence in
[Resource preflight and disposable staging evidence](#resource-preflight-and-disposable-staging-evidence)
below. Then run `quadwork resources preflight --json` and verify the accepted
temp-root facts are owner-only, disk-backed, and available. The overall
preflight remains non-zero while the separate containment staging proof is
pending; temp-root readiness alone is not containment readiness.

Create a wrapper script. The single-quoted `TMPDIR` value must be copied exactly
from the accepted `runtime_resources.temp_root`; do not compute it with shell
interpolation, `eval`, a wildcard, or a directory search:

```bash
cat > ~/start-quadwork.sh << 'EOF'
#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24
export TMPDIR='/home/quadwork/.quadwork/tmp'
exec quadwork start
EOF
chmod +x ~/start-quadwork.sh
```

Start with pm2:

```bash
pm2 start ~/start-quadwork.sh --name quadwork --interpreter /bin/bash
pm2 save
```

`quadwork start` re-reads the fixed policy and re-verifies that exact root before
loading the server or spawning descendants. If the root is missing, aliased,
memory-backed, incorrectly owned/mode-set, or below the accepted capacity, it
discards the unverified Linux `TMPDIR`, prints a typed warning, and keeps the
dashboard/API diagnostic plane online. Even a verified service `TMPDIR` reports
`containment_ready=false`; worker cgroup/PTY containment still requires the
separate staging proof.

Auto-start on reboot:

```bash
pm2 startup systemd
# This prints a sudo command — copy and run it. Example:
# sudo env PATH=... pm2 startup systemd -u quadwork --hp /home/quadwork
```

**Important:** Always run `pm2 save` while the process is **online**. If saved while stopped, it resurrects as stopped on every reboot.

### Common pm2 commands

```bash
pm2 list                          # View processes
pm2 logs quadwork                 # Live logs
pm2 logs quadwork --lines 50 --nostream  # Last 50 lines
pm2 stop quadwork                 # Stop
pm2 start quadwork                # Start
pm2 restart quadwork              # Restart
pm2 save                          # Save state (always do after start/stop)
```

### Resource preflight and disposable staging evidence

Resource setup is deliberately two-step and is never performed by `start`,
`init`, or `preflight`. First create a private policy file containing one exact
`runtime_resources` v1 policy object (not a whole QuadWork config):

```bash
install -m 600 /dev/null "$HOME/quadwork-resource-policy.json"
${EDITOR:-vi} "$HOME/quadwork-resource-policy.json"
quadwork resources configure \
  --policy-file "$HOME/quadwork-resource-policy.json" \
  --json
```

For the measured 8 GiB reference VPS, the v1 proposal shape is:

```json
{
  "version": 1,
  "mode": "systemd-user-v1",
  "temp_root": "/home/quadwork/.quadwork/tmp",
  "host_reserve_mib": 1536,
  "max_worker_scopes": 3,
  "api": { "memory_low_mib": 512, "memory_max_mib": 1280 },
  "worker": { "memory_high_mib": 1024, "memory_max_mib": 1200, "swap_max_mib": 512 },
  "control": { "memory_max_mib": 512, "swap_max_mib": 256, "max_concurrent_children": 2 },
  "temp_min_free_mib": 4096
}
```

This is an operator-visible proposal, not a hidden default. Confirm the account
path and measured host/swap capacity before accepting it; the strict parser
rejects omitted or additional fields.

The proposal validates the strict schema, prints the exact policy and a
SHA-256 token, and makes no changes. Inspect it, then copy that exact token into
the explicit apply form:

```bash
quadwork resources configure \
  --apply \
  --policy-file "$HOME/quadwork-resource-policy.json" \
  --accept-sha256 '<exact-token-from-the-proposal>' \
  --json
```

Apply re-reads the private policy file, refuses a stale token, and atomically
updates only `runtime_resources` in the existing private
`~/.quadwork/config.json`. It never creates a missing config or changes the
other config fields. The Linux apply requires `/usr/bin/python3` and kernel/
filesystem support for `renameat2(RENAME_EXCHANGE)`. Python runs with `-I`, a
fixed script and arguments, and only `LANG=C`/`LC_ALL=C`; it does not inherit
`PATH`, `HOME`, `PYTHONPATH`, `PYTHONHOME`, loader variables, or other user
environment. Before creating a config candidate, it creates two private 0600
probe files through the verified config-directory descriptor, exchanges them
on that exact filesystem, and verifies their moved inode identities. POSIX has
no inode-conditional unlink, so the probe files are never deleted
automatically. The JSON result reports them as
`result.exchange_probe_recovery_entries`.

The config exchange also deliberately keeps the previous 0600 config as a
randomly named private `.recovery` sibling and reports it as
`result.previous_config_recovery_entry`. A refusal after probe or candidate
creation reports every known exact basename in `recovery_entries`. These names
are recovery candidates, not permission to delete: an exchange race can leave
an unexpected inode under any reported name. If atomic exchange is unavailable
or its displaced inode does not match the accepted config, apply never reports
success and preserves every entry for explicit recovery.

On the target Ubuntu host, stop every process that can write
`~/.quadwork`, then inspect exactly one reported basename at a time. `stat`
without `-L` is the required non-dereferencing check. Replace only the quoted
value below; do not derive it with a wildcard:

```bash
cd -- "$HOME/.quadwork" || exit 1
ENTRY='.config.json.resource-install-12345-0123456789abcdef01234567.recovery'
[ -n "$ENTRY" ] && [ "$ENTRY" != '.' ] && [ "$ENTRY" != '..' ] && \
  [ "$(basename -- "$ENTRY")" = "$ENTRY" ] || { printf '%s\n' 'invalid recovery basename' >&2; exit 1; }
OWNER_UID=$(id -u) || exit 1
BEFORE=$(stat --printf='%f|%u|%a|%h|%d|%i\n' -- "$ENTRY") || exit 1
printf 'recovery record: %s\n' "$BEFORE"
IFS='|' read -r MODE_HEX ENTRY_UID MODE NLINK DEV INO <<EOF
$BEFORE
EOF
[ $((0x$MODE_HEX & 0170000)) -eq $((0100000)) ] && \
  [ "$ENTRY_UID" = "$OWNER_UID" ] && \
  [ "$MODE" = '600' ] && [ "$NLINK" = '1' ] || exit 1
AFTER=$(stat --printf='%f|%u|%a|%h|%d|%i\n' -- "$ENTRY") || exit 1
[ "$AFTER" = "$BEFORE" ] || { printf '%s\n' 'recovery inode changed; stop' >&2; exit 1; }
```

Only after independently identifying the contents and repeating the exact
`AFTER` check immediately before the action may the operator use an exact
command such as `rm -- "$ENTRY"`. Never use `*`, a prefix match, `find
-delete`, or remove a different entry. Run the same record/recheck sequence for
each reported probe basename; empty content alone is not identity proof.
A reported basename can be absent if the helper failed before creating it; an
`ENOENT` for that exact name requires no cleanup and is not permission to inspect
or delete similarly named entries.

Next, propose the disk-backed, owner-only temp-root operation derived from the
persisted policy:

```bash
quadwork resources temp-install --json
quadwork resources temp-install \
  --apply \
  --accept-sha256 '<exact-token-from-the-temp-proposal>' \
  --json
```

The first command is read-only. The apply form can create or verify only the
policy-owned temp root and refuses aliases, memory-backed filesystems, unsafe
ownership/mode, or insufficient accepted capacity. It does not clean legacy
`/tmp` paths, assign per-worker `TMPDIR`, install systemd units, restart
QuadWork, or run pressure tests. A failed create performs no automatic rename,
quarantine, or deletion: it returns `temp_install_failed_cleanup_required` and
leaves the operation-created root and any substituted entries for explicit
operator recovery. The refusal JSON reports the exact target basename in
`recovery_entries`. Use the accepted `temp_root` parent and that one basename,
never a wildcard; record and recheck the non-dereferenced Ubuntu facts before
any manual action. If no exact basename remains knowable, JSON instead reports
`recovery_scope: operation_created_entry_unlocated`; stop all writers and
inspect the accepted parent as a whole, but do not infer a deletion target from
a prefix, timestamp, inode order, or other heuristic:

```bash
ls -lai -- '/exact/parent/from-the-accepted-temp_root'
```

When an exact basename is reported, use this per-entry sequence:

```bash
TEMP_PARENT='/exact/parent/from-the-accepted-temp_root'
ENTRY='exact-reported-temp-root-basename'
cd -- "$TEMP_PARENT" || exit 1
[ -n "$ENTRY" ] && [ "$ENTRY" != '.' ] && [ "$ENTRY" != '..' ] && \
  [ "$(basename -- "$ENTRY")" = "$ENTRY" ] || { printf '%s\n' 'invalid recovery basename' >&2; exit 1; }
OWNER_UID=$(id -u) || exit 1
BEFORE=$(stat --printf='%f|%u|%a|%h|%d|%i\n' -- "$ENTRY") || exit 1
printf 'temp recovery record: %s\n' "$BEFORE"
IFS='|' read -r MODE_HEX ENTRY_UID MODE NLINK DEV INO <<EOF
$BEFORE
EOF
[ $((0x$MODE_HEX & 0170000)) -eq $((0040000)) ] && \
  [ "$ENTRY_UID" = "$OWNER_UID" ] && [ "$MODE" = '700' ] || exit 1
AFTER=$(stat --printf='%f|%u|%a|%h|%d|%i\n' -- "$ENTRY") || exit 1
[ "$AFTER" = "$BEFORE" ] || { printf '%s\n' 'temp recovery inode changed; stop' >&2; exit 1; }
```

Do not move or remove it until its owner, type, mode, link count, device, inode,
and contents are understood and the exact record still matches.

Run the shipped diagnostic before considering any resource-containment work:

```bash
quadwork resources preflight
quadwork resources preflight --json
```

This preflight is read-only. A non-zero result is expected while the policy,
temp boundary, or staging proof is unavailable; it does not install, repair,
create, or modify systemd units. Policy/temp acceptance alone is not
containment proof. The current `systemd-run --user --scope
--collect --quiet` contract remains `candidate_pending_staging` and is not a
supported production launch path.

Never run memory pressure or fault injection on production. The source checkout
contains an opt-in staging coordinator for a disposable VPS, but its bundled
adapter deliberately returns `proof_unavailable` instead of launching a fake or
incomplete test. A deployment-specific live adapter must provide authenticated
API, Primary Chat-WebSocket, unrelated-worker, cgroup, node-pty, and temp probes.
Even then, every phase remains blocked until Linux, cgroup v2, the user manager,
the separate run flag, and this exact acknowledgement all match:

```bash
machine_id="$(tr -d '\n' < /etc/machine-id)"
npm run resource:staging-proof -- \
  --json \
  --run-pressure-matrix \
  --ack-disposable-host "DISPOSABLE-STAGING:${machine_id}"
```

Run that command only from the matching QuadWork source checkout on the named
disposable machine. Omitting either opt-in, copying an acknowledgement from a
different machine, or lacking a live adapter starts no matrix phase.

Before a live-adapter run, record the disposable VPS identifier, candidate unit
names, current API/global OOM counters, and the redacted JSON report in the test
change record. On any failure, stop only the exact candidate units recorded by
that run, wait for their process trees to exit, and verify with read-only
`systemctl --user show <recorded-unit>` and cgroup counters. The candidate uses
transient `--collect` scopes; do not install a persistent unit or copy candidate
properties into production. A report is evidence only when every matrix check
is `passed`; this guide does not claim that such a PASS has occurred.

### Resource upgrade and rollback

Treat a package upgrade, a resource-policy change, and a staging-proof change
as three separate operator actions. A successful proof belongs to the exact
reviewed QuadWork source/package candidate and disposable-host record; do not
carry it forward to a different version or policy.

Before an upgrade, record the currently installed package version and run the
read-only checks without redirecting them into the QuadWork state directory:

```bash
npm list -g quadwork --depth=0
quadwork resources preflight --json
quadwork resources temp-install --json
pm2 describe quadwork
```

Keep the exact previously accepted `runtime_resources` JSON, its package
version, and the single-quoted `TMPDIR` used by `~/start-quadwork.sh` in the
operator change record. Do not use a config-directory wildcard or infer a
rollback policy from a `.recovery` filename.

Install only the explicitly approved version, then repeat the policy and temp
proposal/apply sequence above if the accepted policy changes. Every apply must
use the SHA-256 token printed by its immediately preceding proposal; a token
from an older file or version is invalid. Update the wrapper's single-quoted
`TMPDIR` only when the newly accepted policy has a different exact
`temp_root`:

```bash
npm install -g quadwork@'<approved-version>'
quadwork resources configure \
  --policy-file "$HOME/quadwork-resource-policy.json" \
  --json
quadwork resources temp-install --json
pm2 restart quadwork
pm2 save
```

The commands shown above deliberately stop at proposal mode. If the proposal
diff is intended, run the documented `--apply --accept-sha256 '<exact-token>'`
form separately, inspect its JSON recovery fields, and only then restart. After
restart, validate the exact accepted root and the loopback resource endpoint:

Keep `/api/resources` on the loopback-only operator surface. Do not expose or
proxy it publicly: even though secrets and raw paths are redacted, the response
reports host memory, swap, temp-capacity, and worker-scope capacity facts.

```bash
TEMP_ROOT='/exact/accepted/runtime_resources.temp_root'
stat --printf='%f|%u|%a|%h|%d|%i\n' -- "$TEMP_ROOT"
findmnt --noheadings --output TARGET,FSTYPE,OPTIONS --target "$TEMP_ROOT"
quadwork resources preflight --json
curl --fail --silent --show-error 'http://127.0.0.1:8400/api/resources'
```

Rollback is also explicit. Reinstall the exact prior package version, restore
the prior policy through a fresh token-bound `resources configure` proposal and
apply (never by overwriting `config.json`), verify or create only its accepted
temp root through `resources temp-install`, restore the wrapper's exact prior
single-quoted `TMPDIR`, and restart:

```bash
npm install -g quadwork@'<previous-version>'
quadwork resources configure \
  --policy-file "$HOME/quadwork-resource-policy.previous.json" \
  --json
quadwork resources temp-install --json
pm2 restart quadwork
pm2 save
```

Again, proposal mode makes no resource-policy/temp mutation; use only the fresh
printed tokens in separately reviewed apply commands. A rollback does not
delete the newer temp root, exchange probes, previous-config recovery entry, or
any worker data. Inspect only exact reported recovery basenames with the
non-dereferencing procedure above. Containment remains unavailable until the
rolled-back exact source and policy have their own complete disposable-staging
PASS; production receives read-only verification only.

---

## Remote Access

The QuadWork dashboard is a **control surface** — it drives agent terminals,
chat, and batch state. Keep it behind authentication at all times, and never
bind or expose the raw `127.0.0.1:8400` port to the public network. There are
two supported ways to reach it from your laptop.

### Option A — SSH local port-forward (recommended)

The simplest and safest option: tunnel the loopback port over your existing SSH
connection. Nothing is published publicly and your SSH key is the only
credential.

```bash
# From your laptop
ssh -L 8400:127.0.0.1:8400 quadwork
```

Leave that session open and browse to `http://127.0.0.1:8400` on your laptop.
The request reaches QuadWork as a loopback call, so the dashboard works with no
extra server configuration. This needs no domain, nginx, or basic-auth setup —
skip the rest of this section unless you want a persistent public URL.

### Option B — Authenticated public dashboard (nginx + SSL)

Use this only if you need a persistent shared URL. It requires **both** an
authenticating reverse proxy (Step 10 basic auth) **and** an allowlist entry so
QuadWork accepts the proxied hostname — without the allowlist, QuadWork's
loopback checks reject the forwarded `Host`/`Origin` and every terminal
WebSocket dies.

Add your domain to `~/.quadwork/config.json` (create the key if absent), then
restart QuadWork with `pm2 restart quadwork`:

```json
{
  "port": 8400,
  "trusted_dashboard_hosts": ["app.example.com"],
  "projects": []
}
```

> `trusted_dashboard_hosts` takes effect **only** when the request truly arrives
> via the on-box loopback proxy (nginx on `127.0.0.1`). It never lets a direct
> remote connection through, and it is **not** a substitute for the Step 10
> basic auth — configure both. Steps 9–10 build this authenticated proxy.

## Step 9: Domain + Nginx + SSL

### DNS

Create an A record: `app.example.com` -> server IP.

### Nginx reverse proxy

```bash
sudo apt-get install -y nginx
```

Create `/etc/nginx/sites-available/app.example.com`:

```nginx
server {
    listen 80;
    server_name app.example.com;

    location / {
        proxy_pass http://127.0.0.1:8400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

`proxy_read_timeout 86400` and WebSocket headers are required for live agent terminal connections.

```bash
sudo ln -sf /etc/nginx/sites-available/app.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### SSL with Let's Encrypt

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.example.com --non-interactive --agree-tos -m your@email.com
```

---

## Step 10: Basic HTTP Auth (Recommended)

The dashboard is publicly accessible once deployed. Add password protection:

```bash
openssl rand -base64 18
# Save the output as your password

sudo htpasswd -cb /etc/nginx/.htpasswd admin 'YOUR_GENERATED_PASSWORD'
```

### Cookie-cached auth (reduces mobile reprompts)

Mobile browsers (especially Safari) drop the `Authorization` header aggressively on new connections and WebSocket reconnects, causing repeated sign-in popups every few minutes. The fix: cache successful auth in a cookie so nginx skips the challenge on subsequent requests.

Generate a unique secret for your deployment (this becomes the cookie value):

```bash
openssl rand -hex 16
# Example output: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
# Save this — you'll use it in the nginx config below
```

Add a `map` block **outside** the `server` block (at the `http` level — typically at the top of your site config file or in `/etc/nginx/conf.d/auth-cache.conf`). Replace `YOUR_AUTH_SECRET` with the value generated above:

```nginx
# Cache basic auth in a cookie so mobile browsers don't reprompt
map $cookie_qw_auth $auth_ok {
    "YOUR_AUTH_SECRET" "off";
    default            "QuadWork";
}
```

Then update the `server` block (inside `listen 443 ssl`) to use `$auth_ok` instead of a static string, and set the cookie on every response. Replace `YOUR_AUTH_SECRET` with the same value:

```nginx
auth_basic $auth_ok;
auth_basic_user_file /etc/nginx/.htpasswd;

# Set cookie after successful auth (24h expiry)
# Do NOT use "always" — it would set the cookie on 401 responses too
add_header Set-Cookie "qw_auth=YOUR_AUTH_SECRET; Path=/; Max-Age=86400; HttpOnly; Secure";
```

**How it works:**
- First visit: no `qw_auth` cookie → `$auth_ok` = `"QuadWork"` → browser prompts for credentials (normal basic auth)
- After successful auth: cookie is set with 24h expiry (value is your unique secret)
- Subsequent requests: cookie value matches map key → `$auth_ok` = `"off"` → auth challenge skipped
- To force re-login: clear the `qw_auth` cookie in your browser, or wait 24h
- **Security:** the secret is unique to your deployment — knowing the guide's placeholder doesn't help an attacker

Reload nginx to apply the new config (only needed for initial setup — nginx reads `.htpasswd` on every request, so credential changes don't require a reload):

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Save credentials for reference:

```bash
cat > ~/.quadwork/.env << 'EOF'
QUADWORK_HTTP_USER=admin
QUADWORK_HTTP_PASS=YOUR_GENERATED_PASSWORD
EOF
chmod 600 ~/.quadwork/.env
```

---

## Quick Reference: Full Install Order

1. Create Hetzner VPS (CPX32, Ubuntu 24.04, Regular Performance)
2. SSH in as root, create `quadwork` user with sudo + SSH keys
3. Update local SSH config to `User quadwork`
4. Install system packages: `git`, `apache2-utils`
5. Install nvm + Node.js 24
6. Install GitHub CLI
7. Install agent CLIs (Claude Code / Codex / Gemini CLI — those you'll use)
8. Authenticate the installed CLIs (gh, claude, codex, gemini) — operator-required
9. Install QuadWork + pm2
10. Run `quadwork init`
11. Create `~/start-quadwork.sh` wrapper script (loads nvm before exec)
12. Start with pm2 wrapper, save, configure startup
13. Verify reboot survival: `sudo reboot`, then check `pm2 list`
14. **Remote access:** either SSH-forward `ssh -L 8400:127.0.0.1:8400 quadwork` (recommended, nothing published), **or** for a persistent public URL: set `trusted_dashboard_hosts` in config, then DNS A record → nginx reverse proxy + SSL → HTTP basic auth (never expose the port unauthenticated)

## Note: /tmp quotas and Claude temp

Some VPS images mount `/tmp` with a per-user quota (`usrquota`). Claude Code
accumulates temp under `/tmp/claude-{uid}`; if the quota fills up, every
Claude bash command starts failing silently with exit 1 (see
[troubleshooting](troubleshooting.md#every-claude-bash-command-fails-silently-exit-1-no-output)).
QuadWork sweeps stale entries automatically (hourly + on agent teardown,
72h age) — configurable via `temp_cleanup` in `~/.quadwork/config.json`.
