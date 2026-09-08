"use client";

import { useEffect, useRef, useState } from "react";
import { sessionTokenHeaders } from "@/lib/sessionToken";

type Action = "start" | "stop" | "restart";
const inFlight = new Set<string>();
const stateLabels: Record<string, string> = {
  running: "Running", verified: "Verified", stopped: "Stopped", exited: "Exited",
  spawned: "Spawned · unconfirmed", reserved: "Starting · unconfirmed",
  unknown: "Status unconfirmed", rejected: "Rejected", launch_failed: "Launch failed",
  unresponsive: "Unresponsive", timed_out: "Timed out", resource_killed: "Resource killed", error: "Error",
};

interface Props {
  projectId: string;
  agentId: string;
  status?: string;
  onStatusChange?: (state: string) => void;
}

/** Manual controls only. The server owns admission, generation and health. */
export default function AgentLifecycleControls({ projectId, agentId, status, onStatusChange }: Props) {
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const lifecycleAction = async (action: Action) => {
    const key = JSON.stringify([projectId, agentId]);
    if (inFlight.has(key)) return;
    inFlight.add(key); // Covers repeated clicks before React renders disabled buttons.
    setPending(action);
    setError(null);
    try {
      const headers = await sessionTokenHeaders();
      const response = await fetch(`/api/agents/${encodeURIComponent(projectId)}/${encodeURIComponent(agentId)}/${action}`, {
        method: "POST", headers,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        const detail = typeof body?.error === "string" ? body.error : typeof body?.code === "string" ? body.code : `HTTP ${response.status}`;
        throw new Error(`${action[0].toUpperCase() + action.slice(1)} failed: ${detail.replace(/\s+/g, " ").slice(0, 180)}`);
      }
      // Never turn a successful spawn into a claim of verified health, or use
      // the state in a refused response (e.g. stop cleanup failure).
      const nextState = typeof body.state === "string" && Object.hasOwn(stateLabels, body.state) ? body.state : "unknown";
      if (mounted.current) onStatusChange?.(nextState);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error && failure.message.startsWith(`${action[0].toUpperCase() + action.slice(1)} failed:`)
        ? failure.message : "Request failed; status unconfirmed. Check the agent status before trying again.");
    } finally {
      inFlight.delete(key);
      if (mounted.current) setPending(null);
    }
  };

  const canStop = ["running", "verified", "spawned", "reserved", "unresponsive"].includes(status || "");
  const message = error || (pending ? `${pending[0].toUpperCase() + pending.slice(1)} pending…` : stateLabels[status || "unknown"] || stateLabels.unknown);
  return (
    <>
      <span
        role={error ? "alert" : "status"}
        className={`max-w-28 truncate text-[10px] ${error ? "text-error" : "text-text-muted"}`}
        title={message}
      >{message}</span>
      <button
        type="button"
        onClick={() => void lifecycleAction(canStop ? "stop" : "start")}
        disabled={pending !== null}
        className={`text-[10px] text-text-muted transition-colors px-0.5 disabled:opacity-40 disabled:cursor-wait ${canStop ? "hover:text-error" : "hover:text-accent"}`}
        title={canStop ? "Stop" : "Start"}
        aria-label={`${canStop ? "Stop" : "Start"} ${agentId}`}
      >{canStop ? "■" : "▶"}</button>
      <button
        type="button"
        onClick={() => void lifecycleAction("restart")}
        disabled={pending !== null}
        className="text-[10px] text-text-muted hover:text-accent transition-colors px-0.5 disabled:opacity-40 disabled:cursor-wait"
        title="Restart"
        aria-label={`Restart ${agentId}`}
      >↻</button>
    </>
  );
}
