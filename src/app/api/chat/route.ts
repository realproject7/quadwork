import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

interface ChattrConfig {
  url: string;
  token: string | null;
}

function getChattrConfig(): ChattrConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    return {
      url: cfg.agentchattr_url || "http://127.0.0.1:8300",
      token: cfg.agentchattr_token || null,
    };
  } catch {
    return { url: "http://127.0.0.1:8300", token: null };
  }
}

function authHeaders(token: string | null): Record<string, string> {
  if (!token) return {};
  return { "x-session-token": token };
}

// Proxy GET requests: /api/chat?path=/api/messages&channel=general&cursor=0
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const apiPath = searchParams.get("path") || "/api/messages";
  const { url: base, token } = getChattrConfig();

  // Forward all query params except "path"
  const fwd = new URLSearchParams();
  searchParams.forEach((v, k) => {
    if (k !== "path") fwd.set(k, v);
  });

  const url = `${base}${apiPath}?${fwd.toString()}`;

  try {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      return NextResponse.json(
        { error: `AgentChattr returned ${res.status}` },
        { status: res.status }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: "AgentChattr unreachable", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

// Proxy POST requests: /api/chat (body forwarded as-is to /api/send)
export async function POST(req: NextRequest) {
  const { url: base, token } = getChattrConfig();
  const body = await req.json();

  try {
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `AgentChattr returned ${res.status}` },
        { status: res.status }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: "AgentChattr unreachable", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
