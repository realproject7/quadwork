# QuadWork — Windows Installation Guide (WSL2)

QuadWork requires a Unix environment (node-pty, lsof, shell). On Windows, use WSL2 (Windows Subsystem for Linux) to get a full Ubuntu environment. Once inside WSL2, the setup is identical to the Mac guide.

---

## Prerequisites

- **Windows 10** (build 19041 or later) or **Windows 11**
- Administrator access (for WSL2 installation)

---

## Step 1: Install WSL2

> **Manual step** — this requires PowerShell as Administrator and cannot be done by an agent.

Open **PowerShell as Administrator** and run:

```powershell
wsl --install -d Ubuntu
```

Restart your computer when prompted. After restart, Ubuntu will open and ask you to create a username and password.

---

## Step 2: Enter WSL2

Open PowerShell (or Windows Terminal) and run:

```powershell
wsl
```

You're now in Ubuntu. All following steps happen inside this shell.

---

## Step 3: Install Prerequisites (Ubuntu/WSL2)

These replace the macOS-specific steps (Homebrew, Xcode) in the Mac guide.

**Node.js 24** (via nvm):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
nvm use 24
```

**Python 3 + venv** (required for AgentChattr):
```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv git
```

**GitHub CLI:**
```bash
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | sudo tee /etc/apt/sources.list.d/github-cli.list
sudo apt-get update && sudo apt-get install -y gh
```

**Authenticate GitHub CLI:**
```bash
gh auth login
```

> **This is interactive** — the operator must complete the browser-based auth flow.

---

## Step 4: Follow the Mac Guide (from "Install AI Coding Agents")

From here, the setup is identical. Follow **[docs/install-mac.md](install-mac.md)** starting from the **"Install AI Coding Agents"** section.

This includes:
- Claude Code + Codex CLI
- CLI authentication
- `npm install -g quadwork@latest`
- `npx quadwork init`

---

## Accessing the Dashboard

QuadWork runs on `http://127.0.0.1:8400` by default. WSL2 shares localhost with Windows automatically — open that URL in your Windows browser (Chrome, Edge, etc.) and it will connect.

---

## Known Differences from Mac/Linux

| Feature | Behavior on WSL2 |
|---------|-----------------|
| Keep Mac Awake | Not available (`caffeinate` is macOS-only) |
| File paths | `/home/<user>/` instead of `/Users/<user>/` |
| VS Code | Install the "WSL" extension to edit files inside WSL2 |
| Localhost | Shared with Windows automatically (no port forwarding needed) |

---

## For AI Agents

After WSL2 is installed by the operator: follow Steps 3–4 in this guide for prerequisites, then continue with `docs/install-mac.md` starting from the **"Install AI Coding Agents"** section. Do not run the macOS-specific prerequisite steps (Homebrew, Xcode, SSL certificates) — those are already handled by Step 3 above.
