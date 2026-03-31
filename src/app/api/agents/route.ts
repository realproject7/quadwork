import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

function getBackendPort(): number {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw).port || 3001;
  } catch {
    return 3001;
  }
}

// GET /api/agents — list all agent states
export async function GET() {
  const port = getBackendPort();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    if (!res.ok) return NextResponse.json({}, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({}, { status: 502 });
  }
}

// POST /api/agents?project=X&agent=Y&action=start|stop|restart
export async function POST(req: NextRequest) {
  const project = req.nextUrl.searchParams.get("project") || "";
  const agent = req.nextUrl.searchParams.get("agent") || "";
  const action = req.nextUrl.searchParams.get("action") || "start";
  const port = getBackendPort();

  if (!project || !agent || !["start", "stop", "restart"].includes(action)) {
    return NextResponse.json({ error: "Missing project, agent, or valid action" }, { status: 400 });
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/${project}/${agent}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }
}
