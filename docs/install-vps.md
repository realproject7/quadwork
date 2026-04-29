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
sudo apt-get install -y python3.12-venv git
```

`python3.12-venv` is required for AgentChattr's Python venv. Without it, the venv is created without pip, and AgentChattr crashes with `ModuleNotFoundError: No module named 'fastapi'`.

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
```

All binaries (`claude`, `codex`, `quadwork`, `pm2`) live under `~/.nvm/versions/node/v24.x.x/bin/`.

### Authenticate CLIs

> **These are interactive steps.** The operator must run these via `ssh quadwork`:

```bash
gh auth login     # Follow browser-based auth flow
claude            # Follow login prompt
codex             # Follow login prompt
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

Optional — pre-create config at `~/.quadwork/config.json`:

```json
{
  "port": 3000,
  "agentchattr_url": "http://127.0.0.1:8300",
  "agentchattr_dir": "",
  "projects": []
}
```

Run interactive setup:

```bash
quadwork init
```

---

## Step 8: Process Management with pm2

```bash
npm install -g pm2
```

**IMPORTANT:** pm2 strips PATH from child processes. Even if nvm is loaded, the QuadWork process won't have nvm binaries in PATH. **Do not fix with symlinks** — they resolve the binary but not the environment.

Create a wrapper script:

```bash
cat > ~/start-quadwork.sh << 'EOF'
#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24
exec quadwork start
EOF
chmod +x ~/start-quadwork.sh
```

Start with pm2:

```bash
pm2 start ~/start-quadwork.sh --name quadwork --interpreter /bin/bash
pm2 save
```

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

---

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
        proxy_pass http://127.0.0.1:3000;
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

sudo apt-get install -y apache2-utils
sudo htpasswd -cb /etc/nginx/.htpasswd admin 'YOUR_GENERATED_PASSWORD'
```

### Cookie-cached auth (reduces mobile reprompts)

Mobile browsers (especially Safari) drop the `Authorization` header aggressively on new connections and WebSocket reconnects, causing repeated sign-in popups every few minutes. The fix: cache successful auth in a cookie so nginx skips the challenge on subsequent requests.

Add a `map` block **outside** the `server` block (at the `http` level — typically at the top of your site config file or in `/etc/nginx/conf.d/auth-cache.conf`):

```nginx
# Cache basic auth in a cookie so mobile browsers don't reprompt
map $cookie_qw_auth $auth_ok {
    "authenticated" "off";
    default         "QuadWork";
}
```

Then update the `server` block (inside `listen 443 ssl`) to use `$auth_ok` instead of a static string, and set the cookie on every response:

```nginx
auth_basic $auth_ok;
auth_basic_user_file /etc/nginx/.htpasswd;

# Set cookie after successful auth (24h expiry)
add_header Set-Cookie "qw_auth=authenticated; Path=/; Max-Age=86400; HttpOnly; Secure" always;
```

**How it works:**
- First visit: no `qw_auth` cookie → `$auth_ok` = `"QuadWork"` → browser prompts for credentials (normal basic auth)
- After successful auth: cookie is set with 24h expiry
- Subsequent requests: cookie present → `$auth_ok` = `"off"` → auth challenge skipped
- To force re-login: clear the `qw_auth` cookie in your browser, or wait 24h

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
4. Install system packages: `python3.12-venv`, `git`
5. Install nvm + Node.js 24
6. Install GitHub CLI
7. Install Claude Code + Codex CLI
8. Authenticate CLIs (gh, claude, codex)
9. Install QuadWork + pm2
10. Run `quadwork init`
11. Start with pm2 wrapper, save, configure startup
12. Set up DNS A record
13. Configure nginx reverse proxy + SSL
14. Add HTTP basic auth
15. Verify reboot survival: `sudo reboot`, then check `pm2 list`
