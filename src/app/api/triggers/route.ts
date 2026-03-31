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

export async function GET() {
  const port = getBackendPort();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/triggers`);
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({}, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const project = req.nextUrl.searchParams.get("project") || "";
  const action = req.nextUrl.searchParams.get("action") || "start";
  const port = getBackendPort();
  const body = await req.json().catch(() => ({}));

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/triggers/${project}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }
}
