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

## Step 3: Follow the Mac Installation Guide

From here, the setup is identical to macOS. Follow **[docs/install-mac.md](install-mac.md)** starting from Step 1 (nvm + Node.js).

This includes:
- nvm + Node.js 24
- GitHub CLI (`gh auth login`)
- Claude Code + Codex CLI
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

After WSL2 is installed by the operator, follow `docs/install-mac.md` exactly. The environment is standard Ubuntu — all commands work identically.
