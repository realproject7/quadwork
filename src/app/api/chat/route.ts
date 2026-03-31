import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

function getChattrUrl(): string {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    return cfg.agentchattr_url || "http://127.0.0.1:8300";
  } catch {
    return "http://127.0.0.1:8300";
  }
}

// Cached bearer token from agent registration
let cachedToken: string | null = null;

async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;

  const base = getChattrUrl();
  try {
    const res = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: "quadwork-ui", label: "QuadWork Dashboard" }),
    });
    if (res.ok) {
      const data = await res.json();
      cachedToken = data.token || null;
      return cachedToken;
    }
  } catch {
    // Registration failed — server may not require auth
  }
  return null;
}

function authHeaders(token: string | null): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

// Proxy GET requests: /api/chat?path=/api/messages&channel=general&cursor=0
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const apiPath = searchParams.get("path") || "/api/messages";
  const base = getChattrUrl();
  const token = await getToken();

  // Forward all query params except "path"
  const fwd = new URLSearchParams();
  searchParams.forEach((v, k) => {
    if (k !== "path") fwd.set(k, v);
  });

  const url = `${base}${apiPath}?${fwd.toString()}`;

  try {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      // Token may have expired — clear cache and retry once
      if (res.status === 403 && cachedToken) {
        cachedToken = null;
        const newToken = await getToken();
        const retry = await fetch(url, { headers: authHeaders(newToken) });
        if (!retry.ok) {
          return NextResponse.json(
            { error: `AgentChattr returned ${retry.status}` },
            { status: retry.status }
          );
        }
        const data = await retry.json();
        return NextResponse.json(data);
      }
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

// Proxy POST requests: /api/chat (body forwarded as-is)
export async function POST(req: NextRequest) {
  const base = getChattrUrl();
  const token = await getToken();
  const body = await req.json();

  try {
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Token may have expired — clear cache and retry once
      if (res.status === 403 && cachedToken) {
        cachedToken = null;
        const newToken = await getToken();
        const retry = await fetch(`${base}/api/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(newToken) },
          body: JSON.stringify(body),
        });
        if (!retry.ok) {
          return NextResponse.json(
            { error: `AgentChattr returned ${retry.status}` },
            { status: retry.status }
          );
        }
        const data = await retry.json();
        return NextResponse.json(data);
      }
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
