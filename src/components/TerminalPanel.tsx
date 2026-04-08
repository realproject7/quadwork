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

    // Connect WebSocket — resolve backend URL from config if not provided
    let cancelled = false;

    (async () => {
      let base = wsUrl;
      if (!base) {
        // In production, WS is same-origin. In dev mode (next dev on :3000),
        // resolve the backend port from config since WS isn't proxied by Next.js.
        const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
        try {
          const res = await fetch("/api/config");
          if (res.ok) {
            const cfg = await res.json();
            const backendPort = cfg.port || 8400;
            const currentPort = parseInt(window.location.port, 10);
            if (currentPort && currentPort !== backendPort) {
              // Dev mode: connect directly to Express backend
              base = `${wsProto}//${window.location.hostname}:${backendPort}`;
            } else {
              base = `${wsProto}//${window.location.host}`;
            }
          } else {
            base = `${wsProto}//${window.location.host}`;
          }
        } catch {
          base = `${wsProto}//${window.location.host}`;
        }
      }
      if (cancelled) return;

      const endpoint = `${base}/ws/terminal?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agentId)}`;
      const ws = new WebSocket(endpoint);
      wsRef.current = ws;

      ws.onopen = () => {
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

      ws.onclose = (e) => {
        term.write(`\r\n\x1b[38;2;115;115;115m[session closed: ${e.reason || e.code}]\x1b[0m\r\n`);
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
    })();

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
