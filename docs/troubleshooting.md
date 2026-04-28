# QuadWork — Troubleshooting

Common issues and fixes, structured as **Symptom > Cause > Fix**. Searchable by error message.

---

## Claude Code trust prompt blocking agents

**Symptom:** Claude Code agents hang on startup. Terminal shows "Do you trust the files in this folder?" and waits for input indefinitely.

**Cause:** Claude Code requires explicit directory trust before running. The `--dangerously-skip-permissions` flag skips permission prompts but does NOT skip the trust gate.

**Fix:** Pre-trust each worktree directory:

```bash
cd /path/to/project-dev && claude -p "echo ok"
cd /path/to/project-head && claude -p "echo ok"
cd /path/to/project-re1 && claude -p "echo ok"
cd /path/to/project-re2 && claude -p "echo ok"
```

QuadWork v1.14.5+ automatically pre-trusts worktree directories for Claude-configured agents during project creation. If upgrading from an older version, run the commands above once.

---

## Agent suffix proliferation (head-2, dev-2)

**Symptom:** Agents register as `head-2`, `dev-2`, `re1-3` instead of their base names. Chat mentions break because agents look for `@head-2` instead of `@head`.

**Cause:** AgentChattr assigns a numeric suffix when another session with the same base name is still registered (e.g., from a crashed process that didn't clean up).

**Fix:**
1. Stop all agents: stop the QuadWork server
2. Restart AgentChattr (or restart QuadWork entirely)
3. Agents will re-register with their base names

QuadWork v1.15.0+ includes suffix-awareness in AGENTS.md seeds — agents will match mentions by base role name regardless of suffix.

---

## AgentChattr not reachable on port 8300

**Symptom:** Agents fail to register. Logs show connection refused to `127.0.0.1:8300`.

**Cause:** AgentChattr may not have started yet, or crashed during startup.

**Fix:**
1. Check if AgentChattr is running:
   ```bash
   curl http://127.0.0.1:8300/healthz
   ```
2. If not running, check the AgentChattr logs in the project's data directory
3. Restart QuadWork — it will restart AgentChattr automatically

---

## Discord/Telegram bridge: 400 "unknown base: dc"

**Symptom:** Bridge shows "Running" but messages don't forward. Bridge log shows: `Initial AC registration failed: 400 Client Error` / `unknown base: dc` (or `tg`).

**Cause:** The project's `config.toml` is missing `[agents.dc]` and/or `[agents.tg]` sections. AgentChattr validates the `base` field against `[agents.*]` keys during registration.

**Fix:**
1. Restart QuadWork — the startup migration (`bridge-migrate`) will add the missing sections
2. If the bridge still fails, manually add to the project's `config.toml`:
   ```toml
   [agents.dc]
   label = "Discord Bridge"

   [agents.tg]
   label = "Telegram Bridge"
   ```
3. Restart AgentChattr for the project (use the dashboard SERVER > Restart button)

QuadWork v1.14.6+ includes bridge sections in config.toml for all new projects.

---

## SSL certificate error on macOS Python

**Symptom:** AgentChattr dependency installation fails with `ssl.SSLCertVerificationError` or `[SSL: CERTIFICATE_VERIFY_FAILED]`.

**Cause:** macOS Python installations ship without root certificates configured. The system certificates are not linked to Python's `certifi` package.

**Fix:**

```bash
/Applications/Python\ 3.*/Install\ Certificates.command
```

> **This requires operator input.** If the path doesn't match, check: `ls /Applications/ | grep Python`

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

## python3-venv missing on Ubuntu

**Symptom:** AgentChattr crashes on startup with `ModuleNotFoundError: No module named 'fastapi'`.

**Cause:** Ubuntu 24.04 ships Python 3.12 without the `python3.12-venv` package. AgentChattr creates a venv during setup, but without this package the venv has no pip — dependencies are never installed.

**Fix:**

```bash
sudo apt-get install -y python3.12-venv
```

If you already hit this error, recreate the venv:

```bash
cd ~/.quadwork/<project-id>/agentchattr
rm -rf .venv
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Then restart QuadWork: `pm2 restart quadwork`

---

## Duplicate TOML keys crash AgentChattr

**Symptom:** AgentChattr crashes with a TOML parse error on startup.

**Cause:** Manual edits to `config.toml` introduced duplicate keys (e.g., two `max_agent_hops` entries). TOML does not allow duplicate keys.

**Fix:** Open the project's `config.toml` and remove the duplicate entry. Search for the key mentioned in the error message and ensure it appears only once.

**Prevention:** Avoid manually editing `config.toml` fields that QuadWork's startup migrations also manage (e.g., `max_agent_hops`, `[agents.dc]`, `[agents.tg]`).
