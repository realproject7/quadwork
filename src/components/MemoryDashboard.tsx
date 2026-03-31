"use client";

import { useState, useEffect, useCallback } from "react";

interface Card {
  file: string;
  title: string;
  date: string;
  agent: string;
  tags: string;
  content: string;
}

interface AgentStatus {
  injected: boolean;
  lastModified: string | null;
}

interface MemoryDashboardProps {
  projectId: string;
}

export default function MemoryDashboard({ projectId }: MemoryDashboardProps) {
  const [cards, setCards] = useState<Card[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, AgentStatus>>({});
  const [sharedMemory, setSharedMemory] = useState("");
  const [butlerLog, setButlerLog] = useState("");
  const [butlerRunning, setButlerRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<"cards" | "editor" | "settings">("cards");
  const [settings, setSettings] = useState({ memory_cards_dir: "", shared_memory_path: "", butler_scripts_dir: "" });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const fetchCards = useCallback(() => {
    fetch(`/api/memory?project=${encodeURIComponent(projectId)}&action=cards&search=${encodeURIComponent(search)}`)
      .then((r) => r.ok ? r.json() : [])
      .then(setCards)
      .catch(() => {});
  }, [projectId, search]);

  useEffect(() => { fetchCards(); }, [fetchCards]);

  useEffect(() => {
    fetch(`/api/memory?project=${encodeURIComponent(projectId)}&action=status`)
      .then((r) => r.ok ? r.json() : { agents: {} })
      .then((d: { agents?: Record<string, AgentStatus> }) => setStatus(d.agents || {}))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    fetch(`/api/memory?project=${encodeURIComponent(projectId)}&action=shared-memory`)
      .then((r) => r.ok ? r.json() : { content: "" })
      .then((d) => setSharedMemory(d.content))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    fetch(`/api/memory?project=${encodeURIComponent(projectId)}&action=settings`)
      .then((r) => r.ok ? r.json() : {})
      .then((d: { memory_cards_dir?: string; shared_memory_path?: string; butler_scripts_dir?: string }) => setSettings({ memory_cards_dir: d.memory_cards_dir || "", shared_memory_path: d.shared_memory_path || "", butler_scripts_dir: d.butler_scripts_dir || "" }))
      .catch(() => {});
  }, [projectId]);

  const runButler = (command: string) => {
    setButlerRunning(true);
    setButlerLog((prev) => prev + `\n> ${command}\n`);
    fetch(`/api/memory?project=${encodeURIComponent(projectId)}&action=butler`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    })
      .then((r) => r.json())
      .then((d) => {
        setButlerLog((prev) => prev + (d.ok ? d.output : `Error: ${d.error}`) + "\n");
        if (command === "inject.sh") {
          // Refresh injection status
          fetch(`/api/memory?project=${encodeURIComponent(projectId)}&action=status`)
            .then((r) => r.ok ? r.json() : { agents: {} })
            .then((s: { agents?: Record<string, AgentStatus> }) => setStatus(s.agents || {}))
            .catch(() => {});
        }
        if (command === "butler-scan.sh" || command === "butler-consolidate.sh") {
          fetchCards();
        }
      })
      .catch((err) => setButlerLog((prev) => prev + `Error: ${err.message}\n`))
      .finally(() => setButlerRunning(false));
  };

  const saveSettings = () => {
    setSettingsSaving(true);
    fetch(`/api/memory?project=${encodeURIComponent(projectId)}&action=save-settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
      .then((r) => r.json())
      .then((d) => { if (d.ok) { setSettingsSaved(true); setTimeout(() => setSettingsSaved(false), 2000); } })
      .catch(() => {})
      .finally(() => setSettingsSaving(false));
  };

  const saveMemory = () => {
    setSaving(true);
    fetch(`/api/memory?project=${encodeURIComponent(projectId)}&action=save-memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: sharedMemory }),
    })
      .then((r) => r.json())
      .then((d) => { if (d.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); } })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <div className="h-full flex flex-col p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-text tracking-tight">Shared Memory</h1>
        <div className="flex items-center gap-1 border border-border">
          <button onClick={() => setTab("cards")} className={`px-3 py-1 text-[11px] ${tab === "cards" ? "bg-accent text-bg" : "text-text-muted hover:text-text"}`}>Cards</button>
          <button onClick={() => setTab("editor")} className={`px-3 py-1 text-[11px] ${tab === "editor" ? "bg-accent text-bg" : "text-text-muted hover:text-text"}`}>Editor</button>
          <button onClick={() => setTab("settings")} className={`px-3 py-1 text-[11px] ${tab === "settings" ? "bg-accent text-bg" : "text-text-muted hover:text-text"}`}>Settings</button>
        </div>
      </div>

      {/* Injection status */}
      <div className="flex items-center gap-4 mb-4 text-[11px]">
        {Object.entries(status).map(([agent, s]) => (
          <div key={agent} className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${s.injected ? "bg-accent" : "bg-text-muted"}`} />
            <span className="text-text-muted">{agent.toUpperCase()}</span>
            {s.lastModified && <span className="text-text-muted text-[10px]">{new Date(s.lastModified).toLocaleTimeString()}</span>}
          </div>
        ))}
      </div>

      {/* Butler controls */}
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => runButler("butler-scan.sh")} disabled={butlerRunning} className="px-3 py-1 text-[11px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors disabled:opacity-50">Scan</button>
        <button onClick={() => runButler("butler-consolidate.sh")} disabled={butlerRunning} className="px-3 py-1 text-[11px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors disabled:opacity-50">Consolidate</button>
        <button onClick={() => runButler("inject.sh")} disabled={butlerRunning} className="px-3 py-1 text-[11px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors disabled:opacity-50">Inject</button>
        {butlerRunning && <span className="text-[10px] text-text-muted">Running...</span>}
      </div>

      {/* Butler log */}
      {butlerLog && (
        <div className="mb-4 border border-border bg-bg-surface max-h-32 overflow-y-auto">
          <pre className="p-2 text-[10px] text-text-muted whitespace-pre-wrap">{butlerLog.trim()}</pre>
        </div>
      )}

      {/* Cards tab */}
      {tab === "cards" && (
        <div className="flex-1 min-h-0 flex flex-col">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search cards..."
            className="mb-3 bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
          />
          <div className="flex-1 overflow-y-auto border border-border">
            {cards.length === 0 && (
              <div className="p-3 text-[11px] text-text-muted">No memory cards found</div>
            )}
            {cards.map((card) => (
              <div key={card.file} className="border-b border-border/50 last:border-b-0">
                <button
                  onClick={() => setExpanded(expanded === card.file ? null : card.file)}
                  className="w-full flex items-center gap-3 px-3 py-1.5 hover:bg-[#1a1a1a] transition-colors text-left"
                >
                  <span className="text-[11px] text-text flex-1 truncate">{card.title}</span>
                  <span className="text-[10px] text-text-muted shrink-0">{card.agent}</span>
                  <span className="text-[10px] text-text-muted shrink-0">{card.date}</span>
                  {card.tags && <span className="text-[10px] text-accent shrink-0">{card.tags}</span>}
                </button>
                {expanded === card.file && (
                  <div className="px-3 pb-2 bg-bg-surface">
                    <pre className="text-[11px] text-text whitespace-pre-wrap">{card.content}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Editor tab */}
      {tab === "editor" && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-text-muted">shared-memory.md</span>
            <button onClick={saveMemory} disabled={saving} className="px-4 py-1 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
              {saving ? "Saving..." : saved ? "Saved" : "Save"}
            </button>
          </div>
          <textarea
            value={sharedMemory}
            onChange={(e) => setSharedMemory(e.target.value)}
            className="flex-1 bg-bg-surface border border-border p-3 text-[12px] text-text outline-none focus:border-accent resize-none"
          />
        </div>
      )}

      {/* Settings tab */}
      {tab === "settings" && (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
          <p className="text-[11px] text-text-muted">Override default paths for this project. Leave blank to use defaults.</p>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Memory Cards Directory</span>
            <input
              value={settings.memory_cards_dir}
              onChange={(e) => setSettings({ ...settings, memory_cards_dir: e.target.value })}
              placeholder="../agent-memory/archive/v2/cards"
              className="bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Shared Memory Path</span>
            <input
              value={settings.shared_memory_path}
              onChange={(e) => setSettings({ ...settings, shared_memory_path: e.target.value })}
              placeholder="../agent-memory/central/short-term/agent-os.md"
              className="bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Butler Scripts Directory</span>
            <input
              value={settings.butler_scripts_dir}
              onChange={(e) => setSettings({ ...settings, butler_scripts_dir: e.target.value })}
              placeholder="../agent-memory/scripts"
              className="bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
            />
          </label>
          <div>
            <button onClick={saveSettings} disabled={settingsSaving} className="px-4 py-1 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
              {settingsSaving ? "Saving..." : settingsSaved ? "Saved" : "Save Settings"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
