"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import ProjectChatEmptyState from "./ProjectChatEmptyState";

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

// #398 / quadwork#263: shorten reviewer names in the chat sender
// column only — the underlying agent IDs (`reviewer1`, `reviewer2`)
// must stay unchanged everywhere else (registration, MCP, queue,
// terminal headers, etc.). Display-only.
function senderLabel(sender: string): string {
  const s = sender.toLowerCase();
  if (s === "reviewer1") return "RE1";
  if (s === "reviewer2") return "RE2";
  return sender;
}

// #408 / quadwork#271: render @mentions of known agents as colored
// pills. Only the four agent IDs + "user" qualify; unknown handles
// stay as plain text. The mention must be preceded by start-of-string
// or whitespace so URL fragments like "https://github.com/@user"
// don't accidentally pillify, AND must be followed by something that
// can't continue a handle (no word char, no hyphen) so longer
// hyphenated handles like "@user-name" or "@head-2" don't pill the
// known prefix and leave the rest as plain text.
const MENTION_RE = /(^|\s)(@(?:head|dev|reviewer1|reviewer2|user))(?![\w-])/gi;
function renderMessageWithMentions(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const fullStart = match.index ?? 0;
    const lead = match[1];
    const mention = match[2];
    const mentionStart = fullStart + lead.length;
    if (mentionStart > last) {
      parts.push(text.slice(last, mentionStart));
    }
    const agentId = mention.slice(1).toLowerCase();
    const color = senderColor(agentId);
    parts.push(
      <span
        key={`m${key++}`}
        className="inline-block px-1 py-0 rounded font-mono"
        style={{ backgroundColor: `${color}22`, color }}
      >
        {mention}
      </span>,
    );
    last = mentionStart + mention.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : [text];
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
  const channel = "general";
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  // #397 / quadwork#262: tracks the message the next send will be a
  // threaded reply to. Cleared after a successful send or on cancel.
  const [replyTo, setReplyTo] = useState<{ id: number; sender: string } | null>(null);
  const cursorRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldAutoScroll = useRef(true);
  const authRetryRef = useRef(0);

  // Reset cursor when project changes
  useEffect(() => {
    cursorRef.current = 0;
    setMessages([]);
  }, [projectId]);

  // Poll messages via proxy
  const fetchMessages = useCallback(() => {
    fetch(`/api/chat?path=/api/messages&channel=${encodeURIComponent(channel)}&cursor=${cursorRef.current}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`)
      .then((r) => {
        if (r.status === 403) {
          // Token may still be syncing — clear error on next successful poll
          if (authRetryRef.current < 3) setAuthError(null);
          else setAuthError("Chat authentication failed (403). Set agentchattr_token in Settings or ~/.quadwork/config.json.");
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

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Send message
  const send = () => {
    const raw = input.trim();
    if (!raw || sending) return;
    // #228: if the operator didn't tag a known agent, prepend
    // `@head ` so the message has somewhere to go. Unknown
    // `@whatever` mentions don't count — Head is still added.
    // Known agents: head, dev, reviewer1, reviewer2.
    const KNOWN_AGENT_RE = /@(head|dev|reviewer1|reviewer2)\b/i;
    const text = KNOWN_AGENT_RE.test(raw) ? raw : `@head ${raw}`;
    setSending(true);
    setSendError(null);
    fetch(`/api/chat${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        channel,
        sender: "user",
        ...(replyTo ? { reply_to: replyTo.id } : {}),
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Send failed: ${r.status}`);
        setInput("");
        setReplyTo(null);
        setTimeout(fetchMessages, 300);
      })
      .catch((err) => {
        setSendError(err.message);
        console.error(err.message);
      })
      .finally(() => setSending(false));
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
      {/* Messages */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-0.5"
      >
        {messages.length === 0 && (
          // #229: replace the bare "No messages" text with a richer
          // empty state — friendly icon, headline, click-to-insert
          // example chips, and a How to Work modal trigger.
          <div className="flex items-center justify-center h-full">
            <ProjectChatEmptyState onInsert={(t) => { setInput(t); inputRef.current?.focus(); }} />
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="group flex gap-2 text-[12px] leading-5">
            <span className="text-text-muted shrink-0 w-12 text-right tabular-nums">
              {msg.time?.slice(0, 5) || ""}
            </span>
            <span
              className="shrink-0 font-semibold w-10 text-right"
              style={{ color: senderColor(msg.sender) }}
            >
              {senderLabel(msg.sender)}
            </span>
            <span className="text-text break-words min-w-0 whitespace-pre-wrap flex-1">
              {renderMessageWithMentions(msg.text)}
            </span>
            {/* #397 / quadwork#262: reply affordance — small grey,
                hover-revealed so it doesn't visually compete with the
                message text. Mirrors AC's native reply UI. */}
            <button
              type="button"
              onClick={() => {
                setReplyTo({ id: msg.id, sender: msg.sender });
                // Only prefill `@<sender>` when the sender is a real
                // agent. Non-agent rows (user, system, …) would
                // produce broken mentions that send() then
                // double-routes through its auto-@head fallback,
                // turning a reply-to-user into "@head @user …".
                // For those rows we still set replyTo so the threaded
                // link works in AC's native UI; we just don't poison
                // the input with a mention that isn't routable.
                const KNOWN_AGENTS = new Set(["head", "dev", "reviewer1", "reviewer2"]);
                if (KNOWN_AGENTS.has(msg.sender.toLowerCase())) {
                  const prefix = `@${msg.sender} `;
                  setInput((prev) => (prev.startsWith(prefix) ? prev : prefix));
                }
                inputRef.current?.focus();
              }}
              className="shrink-0 self-start opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-[10px] text-text-muted hover:text-text px-1 py-0.5 border border-border/50 rounded"
              title={`Reply to message #${msg.id}`}
            >
              reply
            </button>
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
        {sendError && (
          <div className="px-3 py-1 text-[11px] text-red-400 bg-red-900/20 border-b border-red-700/40">
            {sendError}
          </div>
        )}
        {/* #397 / quadwork#262: active reply indicator with cancel */}
        {replyTo && (
          <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-text-muted bg-bg-surface border-b border-border/50">
            <span>
              Replying to <span style={{ color: senderColor(replyTo.sender) }}>@{replyTo.sender}</span> #{replyTo.id}
            </span>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              className="ml-auto hover:text-text"
              title="Cancel reply (Esc)"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center gap-1 px-1">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={(e) => {
              // Tab: autocomplete first filtered @mention
              if (e.key === "Tab" && showMentions && filteredAgents.length > 0) {
                e.preventDefault();
                insertMention(filteredAgents[0]);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              if (e.key === "Escape") {
                setShowMentions(false);
                if (replyTo) setReplyTo(null);
              }
            }}
            placeholder={`Message #${channel}...`}
            disabled={sending}
            className="flex-1 bg-transparent px-2 py-2 text-[12px] font-mono text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="shrink-0 px-2 py-1 text-[11px] font-mono text-accent border border-accent/40 rounded hover:bg-accent/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Send (Enter)"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
