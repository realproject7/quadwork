"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface Message {
  id: number;
  sender: string;
  text: string;
  time: string;
  channel: string;
  type?: string;
}

const SENDER_COLORS: Record<string, string> = {
  head: "#00ff88",
  reviewer1: "#4488ff",
  reviewer2: "#cc44ff",
  dev: "#ffcc00",
  user: "#e0e0e0",
  system: "#737373",
};

const AGENTS = ["head", "reviewer1", "reviewer2", "dev", "user"];

function senderColor(sender: string): string {
  return SENDER_COLORS[sender.toLowerCase()] || "#e0e0e0";
}

/**
 * Tries iframe first (uses AgentChattr's own session auth).
 * Falls back to API polling if iframe fails to load.
 */
interface ChatPanelProps {
  projectId?: string;
}

export default function ChatPanel({ projectId }: ChatPanelProps) {
  const [mode, setMode] = useState<"iframe" | "api" | "loading">("loading");
  const [chattrUrl, setChattrUrl] = useState("");
  const [chattrToken, setChattrToken] = useState("");

  // Resolve AgentChattr URL and token from per-project config (fallback to global)
  useEffect(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error("config fetch failed");
        return r.json();
      })
      .then((cfg) => {
        const project = projectId ? cfg.projects?.find((p: { id: string }) => p.id === projectId) : null;
        setChattrUrl(project?.agentchattr_url || cfg.agentchattr_url || "http://127.0.0.1:8300");
        setChattrToken(project?.agentchattr_token || cfg.agentchattr_token || "");
      })
      .catch(() => setChattrUrl("http://127.0.0.1:8300"));
  }, [projectId]);

  // Timeout fallback: if iframe hasn't loaded within 3s, switch to API mode
  // (onError doesn't fire for CSP/X-Frame-Options blocks)
  useEffect(() => {
    if (mode !== "loading") return;
    const timer = setTimeout(() => {
      setMode((prev) => (prev === "loading" ? "api" : prev));
    }, 3000);
    return () => clearTimeout(timer);
  }, [mode]);

  if (!chattrUrl) return null;

  if (mode === "loading" || mode === "iframe") {
    return (
      <div className="w-full h-full">
        <iframe
          ref={(el) => {
            if (!el) return;
            el.onload = () => {
              // onLoad fires even for CSP/X-Frame-Options blocks.
              // Try accessing contentDocument — blocked iframes throw.
              try {
                const doc = el.contentDocument || el.contentWindow?.document;
                if (doc && doc.body && doc.body.innerHTML.length > 0) {
                  setMode("iframe");
                } else {
                  setMode("api");
                }
              } catch {
                // Cross-origin or blocked — fall back to API
                setMode("api");
              }
            };
            el.onerror = () => setMode("api");
          }}
          src={chattrToken ? `${chattrUrl}?token=${encodeURIComponent(chattrToken)}` : chattrUrl}
          className="w-full h-full border-0"
          style={{ display: mode === "loading" ? "none" : "block" }}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
        />
        {mode === "loading" && (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xs text-text-muted">Connecting to AgentChattr...</span>
          </div>
        )}
      </div>
    );
  }

  return <ChatPanelAPI projectId={projectId} />;
}

/** API-driven fallback when iframe is blocked */
function ChatPanelAPI({ projectId }: { projectId?: string }) {
  const [channels, setChannels] = useState<string[]>(["general"]);
  const [channel, setChannel] = useState("general");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const cursorRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldAutoScroll = useRef(true);

  // Fetch channels via proxy
  useEffect(() => {
    fetch(`/api/chat?path=/api/channels${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`)
      .then((r) => {
        if (r.status === 403) {
          setAuthError("Chat authentication failed (403). Set agentchattr_token in Settings or ~/.quadwork/config.json.");
          throw new Error("auth failed");
        }
        if (!r.ok) throw new Error("channels fetch failed");
        return r.json();
      })
      .then((data) => {
        setAuthError(null);
        const list = Array.isArray(data) ? data : data.channels || [];
        setChannels(list.map((c: string | { name: string }) => (typeof c === "string" ? c : c.name)));
      })
      .catch(() => setChannels(["general"]));
  }, []);

  // Reset cursor when channel changes
  useEffect(() => {
    cursorRef.current = 0;
    setMessages([]);
  }, [channel, projectId]);

  // Poll messages via proxy
  const fetchMessages = useCallback(() => {
    fetch(`/api/chat?path=/api/messages&channel=${encodeURIComponent(channel)}&cursor=${cursorRef.current}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`)
      .then((r) => {
        if (r.status === 403) {
          setAuthError("Chat authentication failed (403). Set agentchattr_token in Settings or ~/.quadwork/config.json.");
          throw new Error("auth failed");
        }
        if (!r.ok) throw new Error(`Poll failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setAuthError(null);
        const msgs: Message[] = Array.isArray(data) ? data : data.messages || [];
        if (msgs.length > 0) {
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const newMsgs = msgs.filter((m) => !existingIds.has(m.id));
            return newMsgs.length > 0 ? [...prev, ...newMsgs] : prev;
          });
          const maxId = Math.max(...msgs.map((m) => m.id));
          if (maxId > cursorRef.current) cursorRef.current = maxId;
        }
      })
      .catch(() => {});
  }, [channel, projectId]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  // Auto-scroll
  useEffect(() => {
    if (shouldAutoScroll.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
  };

  // Send message
  const send = () => {
    const text = input.trim();
    if (!text) return;
    fetch(`/api/chat${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, channel, sender: "user" }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Send failed: ${r.status}`);
        setInput("");
        setTimeout(fetchMessages, 300);
      })
      .catch((err) => console.error(err.message));
  };

  // @mention handling
  const handleInput = (value: string) => {
    setInput(value);
    const atMatch = value.match(/@(\w*)$/);
    if (atMatch) {
      setShowMentions(true);
      setMentionFilter(atMatch[1].toLowerCase());
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (agent: string) => {
    const newValue = input.replace(/@\w*$/, `@${agent} `);
    setInput(newValue);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  const filteredAgents = AGENTS.filter((a) =>
    a.toLowerCase().startsWith(mentionFilter)
  );

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Auth error banner */}
      {authError && (
        <div className="px-3 py-2 bg-red-900/30 border-b border-red-700/50 text-[11px] text-red-400">
          {authError}
        </div>
      )}
      {/* Channel selector */}
      <div className="flex items-center gap-2 px-3 h-7 shrink-0 border-b border-border">
        <span className="text-[11px] text-text-muted">#</span>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="bg-transparent text-[11px] text-text-muted outline-none cursor-pointer"
        >
          {channels.map((ch) => (
            <option key={ch} value={ch} className="bg-bg-surface">
              {ch}
            </option>
          ))}
        </select>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-0.5"
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-text-muted">No messages</span>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="flex gap-2 text-[12px] leading-5">
            <span className="text-text-muted shrink-0 w-12 text-right tabular-nums">
              {msg.time?.slice(0, 5) || ""}
            </span>
            <span className="shrink-0 text-[10px] text-text-muted border border-border px-1 rounded-sm self-start mt-0.5">
              #{msg.channel || channel}
            </span>
            <span
              className="shrink-0 font-semibold w-10 text-right"
              style={{ color: senderColor(msg.sender) }}
            >
              {msg.sender}
            </span>
            <span className="text-text break-words min-w-0 whitespace-pre-wrap">
              {msg.text}
            </span>
          </div>
        ))}
      </div>

      {/* Send input */}
      <div className="relative shrink-0 border-t border-border">
        {/* @mention dropdown */}
        {showMentions && filteredAgents.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 border border-border bg-bg-surface">
            {filteredAgents.map((agent) => (
              <button
                key={agent}
                onClick={() => insertMention(agent)}
                className="w-full text-left px-3 py-1 text-[12px] hover:bg-[#1a1a1a] transition-colors"
                style={{ color: senderColor(agent) }}
              >
                @{agent}
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape") setShowMentions(false);
          }}
          placeholder={`Message #${channel}...`}
          className="w-full bg-transparent px-3 py-2 text-[12px] font-mono text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
    </div>
  );
}
