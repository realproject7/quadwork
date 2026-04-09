"use client";

import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalPanelProps {
  projectId: string;
  agentId: string;
  /** WebSocket server base URL */
  wsUrl?: string;
  /**
   * #399 / quadwork#264: fired whenever PTY output arrives over the
   * WebSocket. TerminalGrid uses this to derive a "currently active"
   * signal for the activity ring on each agent's status dot — running
   * but idle agents must show a static dot, not a constantly-pulsing
   * one. Kept as a fire-and-forget callback so it can't slow rendering
   * inside the xterm write path.
   */
  onActivity?: () => void;
}

export default function TerminalPanel({
  projectId,
  agentId,
  wsUrl,
  onActivity,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Stash onActivity in a ref so the hot ws.onmessage path can call
  // the latest callback without becoming an effect dep — otherwise an
  // inline arrow from the parent (re-created on every render via the
  // 500ms activityTick) would tear down and reopen the PTY ws every
  // tick, losing scrollback and starving the activity signal itself.
  const onActivityRef = useRef(onActivity);
  useEffect(() => { onActivityRef.current = onActivity; }, [onActivity]);

  const fit = useCallback(() => {
    if (fitRef.current && termRef.current && containerRef.current) {
      try {
        fitRef.current.fit();
        // Notify backend of new dimensions
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            })
          );
        }
      } catch {
        // Container not visible yet
      }
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      scrollback: 1000,
      // #426 / quadwork#315: fontSize 12 → 11 + lineHeight 1.4 → 1.2
      // drops per-line height from 16.8px to 13.2px, ~20% more
      // rows per panel without scrolling and matches the chat
      // panel's visual density. letterSpacing stays 0.5 so the
      // smaller glyphs don't crowd.
      fontSize: 11,
      fontFamily: '"Geist Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      lineHeight: 1.2,
      letterSpacing: 0.5,
      cursorBlink: false,
      cursorStyle: "block",
      theme: {
        background: "#0a0a0a",
        foreground: "#e0e0e0",
        cursor: "#00ff88",
        cursorAccent: "#0a0a0a",
        selectionBackground: "#00ff8844",
        black: "#0a0a0a",
        red: "#ff4444",
        green: "#00ff88",
        yellow: "#ffcc00",
        blue: "#4488ff",
        magenta: "#cc44ff",
        cyan: "#44ccff",
        white: "#e0e0e0",
        brightBlack: "#737373",
        brightRed: "#ff6666",
        brightGreen: "#00ff88",
        brightYellow: "#ffdd44",
        brightBlue: "#66aaff",
        brightMagenta: "#dd66ff",
        brightCyan: "#66ddff",
        brightWhite: "#ffffff",
      },
      allowTransparency: false,
      drawBoldTextInBrightColors: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Initial fit
    requestAnimationFrame(() => fit());

    // Resize observer
    const observer = new ResizeObserver(() => fit());
    observer.observe(containerRef.current);

    // #368: register the xterm → client data handler ONCE up-front
    // so reattach cycles don't stack duplicate handlers that would
    // each try to send the same keystroke to the latest ws.
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Connect WebSocket — resolve backend URL from config if not provided
    let cancelled = false;
    let baseUrl: string | null = null;

    const resolveBase = async (): Promise<string> => {
      if (baseUrl) return baseUrl;
      if (wsUrl) { baseUrl = wsUrl; return baseUrl; }
      const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
      try {
        const res = await fetch("/api/config");
        if (res.ok) {
          const cfg = await res.json();
          const backendPort = cfg.port || 8400;
          const currentPort = parseInt(window.location.port, 10);
          if (currentPort && currentPort !== backendPort) {
            baseUrl = `${wsProto}//${window.location.hostname}:${backendPort}`;
          } else {
            baseUrl = `${wsProto}//${window.location.host}`;
          }
        } else {
          baseUrl = `${wsProto}//${window.location.host}`;
        }
      } catch {
        baseUrl = `${wsProto}//${window.location.host}`;
      }
      return baseUrl;
    };

    // #368: after a ws close (typically because the PTY was stopped
    // by a /api/agents/:project/:agent/restart handler), check
    // /api/sessions to see if a fresh session already exists under
    // the same project/agent key. If it does, clear the buffer and
    // reattach transparently so the terminal tracks the new PTY
    // without the operator having to reload the page. If not,
    // render the "session closed" line as before.
    const sessionIsLive = async (): Promise<boolean> => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) return false;
        const list = await res.json();
        return Array.isArray(list) && list.some(
          (s) => s && s.projectId === projectId && s.agentId === agentId,
        );
      } catch {
        return false;
      }
    };

    // Track reattach attempts so a genuinely dead session cannot
    // trigger an infinite reconnect loop. Resets whenever a ws
    // successfully opens (i.e. a real session was observed).
    let reattachAttempts = 0;
    const MAX_REATTACH = 5;

    const connect = async () => {
      const base = await resolveBase();
      if (cancelled) return;

      const endpoint = `${base}/ws/terminal?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agentId)}`;
      const ws = new WebSocket(endpoint);
      wsRef.current = ws;

      ws.onopen = () => {
        reattachAttempts = 0;
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
          })
        );
      };

      ws.onmessage = (e) => {
        term.write(e.data);
        const cb = onActivityRef.current;
        if (cb) cb();
      };

      ws.onclose = async (e) => {
        if (cancelled) return;
        // #368: bounded polling probe of /api/sessions. A single
        // fixed-delay probe is timing-fragile — if the server-side
        // stop→spawn sequence takes longer than the delay (slow
        // PTY spawn, busy event loop, AgentChattr re-registration
        // stall) the probe sees "no session" and the terminal
        // permanently falls through to [session closed] even
        // though the new PTY came up a moment later. Instead,
        // poll every 200ms for up to 2000ms (10 attempts) and
        // reattach as soon as a live session appears. The loop
        // bails immediately on any liveness hit, so the happy
        // path still completes in ~200-400ms.
        if (reattachAttempts < MAX_REATTACH) {
          const PROBE_INTERVAL_MS = 200;
          const PROBE_WINDOW_MS = 2000;
          const probeStart = Date.now();
          let live = false;
          while (Date.now() - probeStart < PROBE_WINDOW_MS) {
            await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
            if (cancelled) return;
            if (await sessionIsLive()) { live = true; break; }
          }
          if (cancelled) return;
          if (live) {
            reattachAttempts += 1;
            // Clear the stale buffer so the previous session's
            // last frame (including any "stopped" marker) doesn't
            // linger above the new prompt.
            term.reset();
            term.write(`\x1b[38;2;115;115;115m[reattached to new session]\x1b[0m\r\n`);
            connect();
            return;
          }
        }
        term.write(`\r\n\x1b[38;2;115;115;115m[session closed: ${e.reason || e.code}]\x1b[0m\r\n`);
      };

    };

    connect();

    return () => {
      cancelled = true;
      observer.disconnect();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [projectId, agentId, wsUrl, fit]);

  return <div ref={containerRef} className="w-full h-full" />;
}
