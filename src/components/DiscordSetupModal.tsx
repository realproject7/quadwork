"use client";

import { useEffect, useState } from "react";

interface DiscordSetupModalProps {
  open: boolean;
  initialChannelId?: string;
  onClose: () => void;
  onSave: (botToken: string, channelId: string) => Promise<void>;
}

/**
 * Step-by-step setup modal for the per-project Discord Bridge (#400).
 *
 * Walks the operator through 5 steps: create bot, enable MESSAGE_CONTENT
 * intent (critical — the #1 silent-failure gotcha), invite bot, get
 * channel ID, and paste credentials. Includes collapsible troubleshooting.
 */
export default function DiscordSetupModal({ open, initialChannelId = "", onClose, onSave }: DiscordSetupModalProps) {
  const [botToken, setBotToken] = useState("");
  const [channelId, setChannelId] = useState(initialChannelId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [troubleshootOpen, setTroubleshootOpen] = useState(false);

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
          {/* Step 1 — Create bot */}
          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 1 — Create a Discord Application + Bot</h3>
            <ol className="mt-1 pl-4 list-decimal space-y-0.5 text-neutral-300">
              <li>Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Discord Developer Portal</a>.</li>
              <li>Click <b>New Application</b> &rarr; name it (e.g. &quot;QuadWork&quot;) &rarr; <b>Create</b>.</li>
              <li>Go to the <b>Bot</b> tab in the left sidebar.</li>
              <li>Click <b>Reset Token</b> &rarr; copy the bot token. Save it somewhere safe.</li>
            </ol>
          </section>

          {/* Step 2 — MESSAGE_CONTENT intent (critical) */}
          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 2 — Enable MESSAGE_CONTENT intent (critical)</h3>
            <div className="mt-1.5 rounded border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-start gap-2">
                <span className="text-amber-400 text-[16px] leading-none shrink-0">&#9888;</span>
                <div className="text-[12px] text-amber-200/90 leading-relaxed">
                  <b className="text-amber-300">This step is required.</b> Without it, the bot connects successfully but receives empty message content &mdash; no error, no warning, just silent empty messages. This is the #1 cause of Discord bot setup issues.
                </div>
              </div>
              <ol className="mt-2 pl-6 list-decimal space-y-0.5 text-neutral-300 text-[12px]">
                <li>On the same <b>Bot</b> tab, scroll down to <b>Privileged Gateway Intents</b>.</li>
                <li>Toggle <b>ON</b>: <code className="bg-white/5 px-1 rounded text-[11px]">MESSAGE CONTENT INTENT</code>.</li>
                <li>Click <b>Save Changes</b>.</li>
              </ol>
            </div>
          </section>

          {/* Step 3 — Invite bot */}
          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 3 — Invite the bot to your server</h3>
            <ol className="mt-1 pl-4 list-decimal space-y-0.5 text-neutral-300">
              <li>Go to the <b>OAuth2</b> tab &rarr; <b>URL Generator</b>.</li>
              <li>Under <b>Scopes</b>, check <code className="bg-white/5 px-1 rounded text-[11px]">bot</code>.</li>
              <li>
                Under <b>Bot Permissions</b>, check:
                <ul className="mt-0.5 pl-4 list-disc text-neutral-400">
                  <li><code className="bg-white/5 px-1 rounded text-[11px]">Send Messages</code></li>
                  <li><code className="bg-white/5 px-1 rounded text-[11px]">Read Message History</code></li>
                  <li><code className="bg-white/5 px-1 rounded text-[11px]">View Channels</code></li>
                </ul>
              </li>
              <li>
                Copy the generated URL at the bottom. It will look like:
                <pre className="mt-1 p-2 bg-white/5 rounded text-[11px] text-neutral-200 overflow-auto">https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&amp;permissions=66560&amp;scope=bot</pre>
              </li>
              <li>Open it in your browser &rarr; select your Discord server &rarr; <b>Authorize</b>.</li>
            </ol>
          </section>

          {/* Step 4 — Channel ID */}
          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 4 — Get your channel ID</h3>
            <ol className="mt-1 pl-4 list-decimal space-y-0.5 text-neutral-300">
              <li>In Discord, go to <b>User Settings</b> &rarr; <b>Advanced</b> &rarr; enable <b>Developer Mode</b>.</li>
              <li>Right-click the channel you want to bridge &rarr; <b>Copy Channel ID</b>.</li>
            </ol>
            <p className="mt-1 text-[11px] text-neutral-500">
              Channel IDs are large numbers like <code className="bg-white/5 px-1 rounded text-[11px]">1234567890123456789</code>.
            </p>
          </section>

          {/* Step 5 — Credentials */}
          <section>
            <h3 className="text-[13px] font-semibold text-white">Step 5 — Paste credentials below</h3>
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

          {/* Troubleshooting */}
          <section>
            <button
              type="button"
              onClick={() => setTroubleshootOpen((s) => !s)}
              className="text-[11px] text-accent hover:underline"
              aria-expanded={troubleshootOpen}
            >
              {troubleshootOpen ? "Hide troubleshooting \u25BE" : "Troubleshooting \u25B8"}
            </button>
            {troubleshootOpen && (
              <div className="mt-2 p-2 border border-white/10 rounded text-[11px] text-neutral-300 space-y-2">
                <div>
                  <b className="text-white">Bot connects but messages are empty.</b>{" "}
                  MESSAGE_CONTENT intent is not enabled. Go back to Step 2 &mdash; toggle it on in the Developer Portal under Bot &rarr; Privileged Gateway Intents, then restart the bridge.
                </div>
                <div>
                  <b className="text-white">Bot can&apos;t see the channel.</b>{" "}
                  The bot wasn&apos;t invited to the server (Step 3) or it lacks the <code className="bg-white/5 px-0.5 rounded">View Channels</code> permission for that specific channel. Check your server&apos;s role permissions.
                </div>
                <div>
                  <b className="text-white">&quot;Disallowed intents&quot; error in logs.</b>{" "}
                  MESSAGE_CONTENT intent is not toggled in the Developer Portal. This is different from not requesting it in code &mdash; the portal toggle is the gatekeeper.
                </div>
                <div>
                  <b className="text-white">Rate limited.</b>{" "}
                  Normal for high-traffic channels. <code className="bg-white/5 px-0.5 rounded">discord.py</code> handles backoff automatically. If persistent, increase the AC poll interval in the bridge config.
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
