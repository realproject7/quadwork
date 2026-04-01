import { NextRequest, NextResponse } from "next/server";
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const QUADWORK_DIR = path.join(os.homedir(), ".quadwork");
const BRIDGE_DIR = path.join(QUADWORK_DIR, "agentchattr-telegram");
const CONFIG_PATH = path.join(QUADWORK_DIR, "config.json");
const ENV_PATH = path.join(QUADWORK_DIR, ".env");

function pidFile(projectId: string): string {
  return path.join(QUADWORK_DIR, `telegram-bridge-${projectId}.pid`);
}

function configToml(projectId: string): string {
  return path.join(QUADWORK_DIR, `telegram-${projectId}.toml`);
}

function isRunning(projectId: string): boolean {
  const pf = pidFile(projectId);
  if (!fs.existsSync(pf)) return false;
  const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0); // Signal 0 = check if alive
    return true;
  } catch {
    // Process not running — clean up stale PID file
    fs.unlinkSync(pf);
    return false;
  }
}

/** Read a key=value from ~/.quadwork/.env */
function readEnvToken(key: string): string {
  try {
    const content = fs.readFileSync(ENV_PATH, "utf-8");
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

/** Write or update a key=value in ~/.quadwork/.env */
function writeEnvToken(key: string, value: string): void {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    // File doesn't exist yet
  }
  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + (content ? "\n" : "") + line + "\n";
  }
  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
}

/** Resolve a bot_token value — if it starts with "env:" read from .env file */
function resolveToken(value: string): string {
  if (value.startsWith("env:")) {
    return readEnvToken(value.slice(4)) || "";
  }
  return value;
}

function envKeyForProject(projectId: string): string {
  const safe = projectId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `TELEGRAM_BOT_TOKEN_${safe}`;
}

function getProjectTelegram(projectId: string): { bot_token: string; chat_id: string; agentchattr_url: string } | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const project = cfg.projects?.find((p: { id: string }) => p.id === projectId);
    if (!project?.telegram) return null;
    const rawToken = project.telegram.bot_token || "";
    return {
      bot_token: resolveToken(rawToken),
      chat_id: project.telegram.chat_id || "",
      agentchattr_url: cfg.agentchattr_url || "http://127.0.0.1:8300",
    };
  } catch {
    return null;
  }
}

// GET /api/telegram?project=<id> — check daemon status
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project") || "";
  if (!projectId) return NextResponse.json({ error: "Missing project" }, { status: 400 });
  return NextResponse.json({ running: isRunning(projectId) });
}

// POST /api/telegram?action=test|install|start|stop
export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  const body = await req.json().catch(() => ({}));

  switch (action) {
    case "test":
      return testConnection(body.bot_token, body.chat_id);
    case "install":
      return installBridge();
    case "start":
      return startDaemon(body.project_id);
    case "stop":
      return stopDaemon(body.project_id);
    case "status":
      return NextResponse.json({ running: isRunning(body.project_id || "") });
    case "save-token":
      return saveToken(body.project_id, body.bot_token);
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}

async function testConnection(botToken: string, chatId: string) {
  if (!botToken || !chatId) {
    return NextResponse.json({ ok: false, error: "Missing bot_token or chat_id" });
  }
  const resolved = resolveToken(botToken);
  if (!resolved) {
    return NextResponse.json({ ok: false, error: "Could not resolve bot token from environment" });
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${resolved}/getChat?chat_id=${chatId}`);
    const data = await res.json();
    return NextResponse.json({ ok: data.ok, error: data.ok ? undefined : data.description });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Connection failed" });
  }
}

function installBridge() {
  try {
    if (!fs.existsSync(BRIDGE_DIR)) {
      execFileSync("gh", ["repo", "clone", "realproject7/agentchattr-telegram", BRIDGE_DIR], {
        encoding: "utf-8",
        timeout: 30000,
      });
    }
    execFileSync("pip3", ["install", "-r", path.join(BRIDGE_DIR, "requirements.txt")], {
      encoding: "utf-8",
      timeout: 30000,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Install failed" });
  }
}

function writeProjectToml(projectId: string): string | null {
  const tg = getProjectTelegram(projectId);
  if (!tg || !tg.bot_token || !tg.chat_id) return null;

  const tomlPath = configToml(projectId);
  const content = `[telegram]\nbot_token = "${tg.bot_token}"\nchat_id = "${tg.chat_id}"\n\n[agentchattr]\nurl = "${tg.agentchattr_url}"\n`;
  fs.writeFileSync(tomlPath, content, { mode: 0o600 });
  return tomlPath;
}

function startDaemon(projectId: string) {
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Missing project_id" });
  }
  if (isRunning(projectId)) {
    return NextResponse.json({ ok: true, running: true, message: "Already running" });
  }

  const bridgeScript = path.join(BRIDGE_DIR, "telegram_bridge.py");
  if (!fs.existsSync(bridgeScript)) {
    return NextResponse.json({ ok: false, error: "Bridge not installed. Click Install Bridge first." });
  }

  const tomlPath = writeProjectToml(projectId);
  if (!tomlPath) {
    return NextResponse.json({ ok: false, error: "Save bot_token and chat_id in project settings first." });
  }

  try {
    const child = spawn("python3", [bridgeScript, "--config", tomlPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid) {
      fs.writeFileSync(pidFile(projectId), String(child.pid));
    }
    return NextResponse.json({ ok: true, running: true, pid: child.pid });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Start failed" });
  }
}

function saveToken(projectId: string, botToken: string) {
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Missing project_id" });
  }
  const envKey = envKeyForProject(projectId);
  writeEnvToken(envKey, botToken);

  // Update config.json to use env reference instead of plaintext
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const project = cfg.projects?.find((p: { id: string }) => p.id === projectId);
    if (project?.telegram) {
      project.telegram.bot_token = `env:${envKey}`;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    }
  } catch {
    // Config update is best-effort; token is already saved in .env
  }

  return NextResponse.json({ ok: true, env_key: envKey });
}

function stopDaemon(projectId: string) {
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Missing project_id" });
  }
  const pf = pidFile(projectId);
  try {
    if (fs.existsSync(pf)) {
      const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
      if (pid) process.kill(pid, "SIGTERM");
      fs.unlinkSync(pf);
    }
    return NextResponse.json({ ok: true, running: false });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Stop failed" });
  }
}
