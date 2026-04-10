"use client";

import { useEffect, useState } from "react";

interface DiscordSetupModalProps {
  open: boolean;
  initialChannelId?: string;
  onClose: () => void;
  onSave: (botToken: string, channelId: string) => Promise<void>;
}

/**
 * Step-by-step setup modal for the per-project Discord Bridge.
 *
 * Walks the operator through creating a Discord bot, getting a
 * channel ID, pasting both into the form, and hitting
 * "Save and start bridge".
 */
export default function DiscordSetupModal({ open, initialChannelId = "", onClose, onSave }: DiscordSetupModalProps) {
  const [botToken, setBotToken] = useState("");
  const [channelId, setChannelId] = useState(initialChannelId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) setChannelId(initialChannelId); }, [open, initialChannelId]);

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
      await onSave(botToken.trim(), channelId.trim());
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
      aria-labelledby="discord-setup-title"
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

        <h2 id="discord-setup-title" className="text-base font-semibold text-white">Set up your Discord Bridge</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-neutral-300">
          The bridge forwards AgentChattr messages from your project to a Discord channel, so you can read and reply from Discord.
        </p>

        <div className="mt-4 text-[12px] text-neutral-300 space-y-3">
          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 1 — Create a Discord bot</h3>
            <ol className="mt-1 pl-4 list-decimal space-y-0.5 text-neutral-300">
              <li>Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Discord Developer Portal</a>.</li>
              <li>Click <b>New Application</b>, give it a name, and click <b>Create</b>.</li>
              <li>Go to the <b>Bot</b> tab on the left sidebar.</li>
              <li>Click <b>Reset Token</b> (or <b>Copy</b> if shown) to get your <b>bot token</b>. Save it somewhere safe.</li>
              <li>Scroll down to <b>Privileged Gateway Intents</b> and enable <b>MESSAGE CONTENT INTENT</b>.</li>
              <li>Go to <b>OAuth2 &rarr; URL Generator</b>, select the <b>bot</b> scope, then under Bot Permissions select <b>Send Messages</b> and <b>Read Message History</b>. Copy the generated URL and open it to invite the bot to your server.</li>
            </ol>
          </section>

          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 2 — Get your channel ID</h3>
            <ol className="mt-1 pl-4 list-decimal space-y-0.5 text-neutral-300">
              <li>Open Discord and go to <b>Settings &rarr; Advanced</b>.</li>
              <li>Enable <b>Developer Mode</b>.</li>
              <li>Right-click the channel you want the bridge to post in and select <b>Copy Channel ID</b>.</li>
            </ol>
            <p className="mt-1 text-[11px] text-neutral-500">
              Channel IDs are large numbers like <code className="bg-white/5 px-1 rounded text-[11px]">1234567890123456789</code>.
            </p>
          </section>

          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 3 — Paste credentials below</h3>
            <div className="mt-2 flex flex-col gap-2">
              <label className="text-[11px] text-neutral-400">Bot token
                <input
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ..."
                  className="mt-0.5 w-full bg-transparent border border-white/10 px-2 py-1 text-[12px] text-white outline-none focus:border-accent font-mono"
                />
              </label>
              <label className="text-[11px] text-neutral-400">Channel ID
                <input
                  type="text"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  placeholder="1234567890123456789"
                  className="mt-0.5 w-full bg-transparent border border-white/10 px-2 py-1 text-[12px] text-white outline-none focus:border-accent font-mono"
                />
              </label>
              {error && <div className="text-[11px] text-error">{error}</div>}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !botToken.trim() || !channelId.trim()}
                className="mt-1 self-start px-3 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving\u2026" : "Save and start bridge"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
