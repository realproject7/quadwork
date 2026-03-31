import { NextRequest, NextResponse } from "next/server";
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const BRIDGE_DIR = path.join(os.homedir(), ".quadwork", "agentchattr-telegram");

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
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}

async function testConnection(botToken: string, chatId: string) {
  if (!botToken || !chatId) {
    return NextResponse.json({ ok: false, error: "Missing bot_token or chat_id" });
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${chatId}`);
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
    // Install deps
    execFileSync("pip3", ["install", "-r", path.join(BRIDGE_DIR, "requirements.txt")], {
      encoding: "utf-8",
      timeout: 30000,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Install failed" });
  }
}

const PID_FILE = path.join(os.homedir(), ".quadwork", "telegram-bridge.pid");

function startDaemon(projectId: string) {
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Missing project_id" });
  }
  const configPath = path.join(os.homedir(), ".quadwork", "config.json");
  const bridgeScript = path.join(BRIDGE_DIR, "telegram_bridge.py");

  if (!fs.existsSync(bridgeScript)) {
    return NextResponse.json({ ok: false, error: "Bridge not installed. Click Install Bridge first." });
  }

  try {
    const child = spawn("python3", [bridgeScript, "--config", configPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid) {
      fs.writeFileSync(PID_FILE, String(child.pid));
    }
    return NextResponse.json({ ok: true, pid: child.pid });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Start failed" });
  }
}

function stopDaemon(_projectId: string) {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (pid) process.kill(pid, "SIGTERM");
      fs.unlinkSync(PID_FILE);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Stop failed" });
  }
}
