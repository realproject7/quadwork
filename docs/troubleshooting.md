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

**Cause:** PTY injection isn't delivering messages to the agent process. The agent's MCP shim may not be configured, or the agent process may not be running.

**Fix:**
1. Check that the agent process is running:
   ```bash
   ps aux | grep -E "claude|codex|gemini"
   ```
2. Verify the agent's MCP shim is configured in the project's agent settings
3. Check the agent's terminal in the QuadWork dashboard for errors
4. Restart the agent from the dashboard if needed

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

