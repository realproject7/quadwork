"use client";

import { useEffect, useState } from "react";

interface TelegramSetupModalProps {
  open: boolean;
  initialChatId?: string;
  onClose: () => void;
  onSave: (botToken: string, chatId: string) => Promise<void>;
}

/**
 * Step-by-step setup modal for the per-project Telegram Bridge (#211).
 *
 * Walks a newbie through creating a bot with @BotFather, grabbing
 * their chat id, pasting both into the form, and hitting
 * "Save and start bridge". The save path calls the parent's
 * `onSave` which hits POST /api/telegram?action=save-config and
 * then POST /api/telegram?action=start.
 */
export default function TelegramSetupModal({ open, initialChatId = "", onClose, onSave }: TelegramSetupModalProps) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState(initialChatId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) setChatId(initialChatId); }, [open, initialChatId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(botToken.trim(), chatId.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="telegram-setup-title"
    >
      <div
        className="relative mx-4 max-w-xl w-full max-h-[90vh] overflow-auto rounded-lg border border-white/10 bg-neutral-950 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-white"
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 4l12 12M16 4L4 16" strokeLinecap="round" />
          </svg>
        </button>

        <h2 id="telegram-setup-title" className="text-base font-semibold text-white">Set up your Telegram Bridge</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-neutral-300">
          The bridge forwards AgentChattr messages from your project to a Telegram chat, so you can read and reply on your phone.
        </p>

        <div className="mt-4 text-[12px] text-neutral-300 space-y-3">
          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 1 — Create a Telegram bot</h3>
            <ol className="mt-1 pl-4 list-decimal space-y-0.5 text-neutral-300">
              <li>Open Telegram and search for <b>@BotFather</b>.</li>
              <li>Send <code className="bg-white/5 px-1 rounded text-[11px]">/newbot</code> and follow the prompts.</li>
              <li>Choose a name and username (must end in <code className="bg-white/5 px-1 rounded text-[11px]">bot</code>).</li>
              <li>BotFather replies with a <b>bot token</b> that looks like <code className="bg-white/5 px-1 rounded text-[11px]">123456:ABC-DEF1234ghIkl…</code>. Copy it.</li>
            </ol>
          </section>

          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 2 — Get your chat ID</h3>
            <ol className="mt-1 pl-4 list-decimal space-y-0.5 text-neutral-300">
              <li>Open Telegram and search for your new bot by username.</li>
              <li>Click <b>Start</b> and send any message (e.g. <code className="bg-white/5 px-1 rounded text-[11px]">hello</code>).</li>
              <li>
                Open this URL in your browser (replace <code className="bg-white/5 px-1 rounded text-[11px]">YOUR_TOKEN</code>):
                <pre className="mt-1 p-2 bg-white/5 rounded text-[11px] text-neutral-200 overflow-auto">https://api.telegram.org/botYOUR_TOKEN/getUpdates</pre>
              </li>
              <li>Look for <code className="bg-white/5 px-1 rounded text-[11px]">&quot;chat&quot;:&#123;&quot;id&quot;:&lt;NUMBER&gt;</code> in the JSON. That number is your <b>chat id</b>.</li>
            </ol>
            <p className="mt-1 text-neutral-400">Or use this curl command in your terminal:</p>
            <pre className="mt-1 p-2 bg-white/5 rounded text-[11px] text-neutral-200 overflow-auto">curl -s &apos;https://api.telegram.org/bot&lt;YOUR_TOKEN&gt;/getUpdates&apos; | grep -o &apos;&quot;id&quot;:[0-9-]*&apos; | head -1</pre>
          </section>

          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 3 — Paste credentials below</h3>
            <div className="mt-2 flex flex-col gap-2">
              <label className="text-[11px] text-neutral-400">Bot token
                <input
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="123456:ABC-DEF…"
                  className="mt-0.5 w-full bg-transparent border border-white/10 px-2 py-1 text-[12px] text-white outline-none focus:border-accent font-mono"
                />
              </label>
              <label className="text-[11px] text-neutral-400">Chat id
                <input
                  type="text"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  placeholder="123456789"
                  className="mt-0.5 w-full bg-transparent border border-white/10 px-2 py-1 text-[12px] text-white outline-none focus:border-accent font-mono"
                />
              </label>
              {error && <div className="text-[11px] text-error">{error}</div>}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !botToken.trim() || !chatId.trim()}
                className="mt-1 self-start px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving…" : "Save and start bridge"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
