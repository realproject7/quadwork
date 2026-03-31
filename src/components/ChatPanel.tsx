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
  t1: "#00ff88",
  t2a: "#4488ff",
  t2b: "#cc44ff",
  t3: "#ffcc00",
  user: "#e0e0e0",
  system: "#737373",
};

const AGENTS = ["t1", "t2a", "t2b", "t3", "user"];

function senderColor(sender: string): string {
  return SENDER_COLORS[sender.toLowerCase()] || "#e0e0e0";
}

export default function ChatPanel() {
  const [channels, setChannels] = useState<string[]>([]);
  const [channel, setChannel] = useState("general");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const cursorRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldAutoScroll = useRef(true);

  // Fetch channels via proxy
  useEffect(() => {
    fetch("/api/chat?path=/api/channels")
      .then((r) => {
        if (!r.ok) throw new Error("channels fetch failed");
        return r.json();
      })
      .then((data) => {
        const list = Array.isArray(data) ? data : data.channels || [];
        setChannels(list.map((c: string | { name: string }) => (typeof c === "string" ? c : c.name)));
      })
      .catch(() => setChannels(["general"]));
  }, []);

  // Reset cursor when channel changes
  useEffect(() => {
    cursorRef.current = 0;
    setMessages([]);
  }, [channel]);

  // Poll messages via proxy
  const fetchMessages = useCallback(() => {
    fetch(`/api/chat?path=/api/messages&channel=${encodeURIComponent(channel)}&cursor=${cursorRef.current}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Poll failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
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
  }, [channel]);

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
    fetch("/api/chat", {
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
          placeholder="Message #general..."
          className="w-full bg-transparent px-3 py-2 text-[12px] text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
    </div>
  );
}
