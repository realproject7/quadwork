// #968: shared session token for the PTY-driving surface (terminal/butler
// WebSockets + /write + /interrupt). The server auto-provisions it and hands it
// to the LOCAL dashboard via GET /api/session-token, so the operator sees no
// change. For tailnet/LAN access (where that endpoint 403s), set
// localStorage["quadwork_session_token"] to the value from ~/.quadwork/config.json
// (see docs/troubleshooting.md).

let cached: string | null = null;
let inflight: Promise<string> | null = null;

async function getSessionToken(): Promise<string> {
  if (cached) return cached;
  try {
    const override = window.localStorage.getItem("quadwork_session_token");
    if (override) { cached = override; return cached; }
  } catch { /* localStorage unavailable (SSR) */ }
  if (!inflight) {
    inflight = fetch("/api/session-token")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const t = d && typeof d.token === "string" ? d.token : "";
        if (t) cached = t; // only cache a real token so a transient failure can retry
        return t;
      })
      .catch(() => "")
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Bare `token=<value>` query param (no leading separator), or "" if unknown. */
export async function sessionTokenParam(): Promise<string> {
  const t = await getSessionToken();
  return t ? `token=${encodeURIComponent(t)}` : "";
}

/** Header object for authenticated PTY-write / interrupt fetches. */
export async function sessionTokenHeaders(): Promise<Record<string, string>> {
  const t = await getSessionToken();
  return t ? { "X-Session-Token": t } : {};
}
