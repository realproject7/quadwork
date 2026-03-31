"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";

interface AgentConfig {
  display_name: string;
  command: string;
  cwd: string;
  model: string;
  agents_md: string;
}

interface TelegramConfig {
  enabled: boolean;
  bot_token: string;
  chat_id: string;
  status?: string;
}

interface ProjectConfig {
  id: string;
  name: string;
  repo: string;
  working_dir: string;
  agents: Record<string, AgentConfig>;
  telegram?: TelegramConfig;
  trigger_interval?: number;
  trigger_message?: string;
}

interface Config {
  port: number;
  agentchattr_url: string;
  agentchattr_token: string;
  default_backend: string;
  projects: ProjectConfig[];
}

const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  t1: { display_name: "T1", command: "claude", cwd: "", model: "opus", agents_md: "" },
  t2a: { display_name: "T2a", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
  t2b: { display_name: "T2b", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
  t3: { display_name: "T3", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
};

const BACKENDS = ["claude-code", "codex"];
const MODELS = ["opus", "sonnet", "haiku"];

function Input({ label, value, onChange, type = "text", placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] text-text-muted uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
      />
    </div>
  );
}

function Select({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] text-text-muted uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent cursor-pointer"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-bg-surface">{o}</option>
        ))}
      </select>
    </div>
  );
}

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const [config, setConfig] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [autoAdded, setAutoAdded] = useState(false);
  const [daemonStatus, setDaemonStatus] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => setConfig({
        port: data.port || 3001,
        agentchattr_url: data.agentchattr_url || "http://127.0.0.1:8300",
        agentchattr_token: data.agentchattr_token || "",
        default_backend: data.default_backend || "claude-code",
        projects: data.projects || [],
      }))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll telegram daemon status for each project
  useEffect(() => {
    if (!config) return;
    for (const p of config.projects) {
      if (p.telegram?.bot_token) {
        fetch(`/api/telegram?project=${encodeURIComponent(p.id)}`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => {
            if (d) setDaemonStatus((prev) => ({ ...prev, [p.id]: d.running }));
          })
          .catch(() => {});
      }
    }
  }, [config]);

  // Auto-add project when navigated with ?add=true
  useEffect(() => {
    if (config && searchParams.get("add") === "true" && !autoAdded) {
      setAutoAdded(true);
      addProject();
    }
  }, [config, searchParams, autoAdded]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error(err);
    }
    setSaving(false);
  };

  const updateGlobal = (key: keyof Config, value: string | number) => {
    if (!config) return;
    setConfig({ ...config, [key]: value });
  };

  const updateProject = (idx: number, updates: Partial<ProjectConfig>) => {
    if (!config) return;
    const projects = [...config.projects];
    projects[idx] = { ...projects[idx], ...updates };
    setConfig({ ...config, projects });
  };

  const updateAgent = (projectIdx: number, agentId: string, updates: Partial<AgentConfig>) => {
    if (!config) return;
    const projects = [...config.projects];
    const agents = { ...projects[projectIdx].agents };
    agents[agentId] = { ...agents[agentId], ...updates };
    projects[projectIdx] = { ...projects[projectIdx], agents };
    setConfig({ ...config, projects });
  };

  const updateTelegram = (projectIdx: number, updates: Partial<TelegramConfig>) => {
    if (!config) return;
    const projects = [...config.projects];
    const telegram = { enabled: false, bot_token: "", chat_id: "", ...projects[projectIdx].telegram, ...updates };
    projects[projectIdx] = { ...projects[projectIdx], telegram };
    setConfig({ ...config, projects });
  };

  const addProject = () => {
    if (!config) return;
    const id = `project-${Date.now()}`;
    const newProject: ProjectConfig = {
      id,
      name: "New Project",
      repo: "owner/repo",
      working_dir: "",
      agents: { ...DEFAULT_AGENTS },
    };
    setConfig({ ...config, projects: [...config.projects, newProject] });
    setExpanded({ ...expanded, [id]: true });
  };

  const removeProject = (idx: number) => {
    if (!config) return;
    const projects = config.projects.filter((_, i) => i !== idx);
    setConfig({ ...config, projects });
    setConfirmDelete(null);
  };

  if (!config) return <div className="p-6 text-text-muted text-xs">Loading...</div>;

  return (
    <div className="h-full overflow-y-auto p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-text tracking-tight">Settings</h1>
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </button>
      </div>

      {/* Global Settings */}
      <section className="mb-6">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">Global</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="AgentChattr URL"
            value={config.agentchattr_url}
            onChange={(v) => updateGlobal("agentchattr_url", v)}
            placeholder="http://127.0.0.1:8300"
          />
          <Select
            label="Default CLI Backend"
            value={config.default_backend}
            onChange={(v) => updateGlobal("default_backend", v)}
            options={BACKENDS}
          />
          <Input
            label="QuadWork Port"
            value={String(config.port)}
            onChange={(v) => updateGlobal("port", parseInt(v, 10) || 3001)}
            type="number"
          />
        </div>
      </section>

      <hr className="border-border mb-6" />

      {/* Per-project settings */}
      <section className="mb-6">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">Projects</h2>

        {config.projects.map((project, idx) => {
          const isExpanded = expanded[project.id] ?? false;
          const telegram = project.telegram || { enabled: false, bot_token: "", chat_id: "" };

          return (
            <div key={project.id} className="border border-border mb-3">
              {/* Header */}
              <button
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#1a1a1a] transition-colors"
                onClick={() => setExpanded({ ...expanded, [project.id]: !isExpanded })}
              >
                <span className="text-[12px] text-text font-semibold">{project.name}</span>
                <span className="text-[11px] text-text-muted">{isExpanded ? "▾" : "▸"}</span>
              </button>

              {isExpanded && (
                <div className="px-3 pb-3 border-t border-border">
                  {/* Basic project info */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                    <Input
                      label="Project Name"
                      value={project.name}
                      onChange={(v) => updateProject(idx, { name: v })}
                    />
                    <Input
                      label="GitHub Repo"
                      value={project.repo}
                      onChange={(v) => updateProject(idx, { repo: v })}
                      placeholder="owner/repo"
                    />
                    <Input
                      label="Working Directory"
                      value={project.working_dir || ""}
                      onChange={(v) => updateProject(idx, { working_dir: v })}
                      placeholder="/path/to/project"
                    />
                  </div>

                  {/* Agents table */}
                  <div className="mt-4">
                    <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Agents</h3>
                    <div className="border border-border">
                      <div className="grid grid-cols-5 gap-0 px-2 py-1 border-b border-border text-[10px] text-text-muted uppercase">
                        <span>Name</span>
                        <span>Command</span>
                        <span>Model</span>
                        <span>CWD</span>
                        <span>AGENTS.md</span>
                      </div>
                      {Object.entries(project.agents || {}).map(([agentId, agent]) => (
                        <div key={agentId} className="border-b border-border/50 last:border-b-0">
                          <div className="grid grid-cols-5 gap-0 px-2 py-1">
                            <input
                              value={agent.display_name || agentId.toUpperCase()}
                              onChange={(e) => updateAgent(idx, agentId, { display_name: e.target.value })}
                              className="bg-transparent text-[11px] text-text font-semibold outline-none border border-border px-1 py-0.5 focus:border-accent"
                            />
                            <select
                              value={agent.command || "claude"}
                              onChange={(e) => updateAgent(idx, agentId, { command: e.target.value })}
                              className="bg-transparent text-[11px] text-text outline-none border border-border px-1 py-0.5 focus:border-accent"
                            >
                              {BACKENDS.map((b) => (
                                <option key={b} value={b} className="bg-bg-surface">{b}</option>
                              ))}
                            </select>
                            <select
                              value={agent.model || "sonnet"}
                              onChange={(e) => updateAgent(idx, agentId, { model: e.target.value })}
                              className="bg-transparent text-[11px] text-text outline-none border border-border px-1 py-0.5 focus:border-accent"
                            >
                              {MODELS.map((m) => (
                                <option key={m} value={m} className="bg-bg-surface">{m}</option>
                              ))}
                            </select>
                            <input
                              value={agent.cwd || ""}
                              onChange={(e) => updateAgent(idx, agentId, { cwd: e.target.value })}
                              placeholder="/path/to/worktree"
                              className="bg-transparent text-[11px] text-text outline-none border border-border px-1 py-0.5 focus:border-accent"
                            />
                            <button
                              onClick={() => setExpanded({ ...expanded, [`${project.id}-${agentId}-md`]: !expanded[`${project.id}-${agentId}-md`] })}
                              className="text-[10px] text-text-muted hover:text-accent transition-colors text-left px-1"
                            >
                              {expanded[`${project.id}-${agentId}-md`] ? "▾ edit" : "▸ edit"}
                            </button>
                          </div>
                          {expanded[`${project.id}-${agentId}-md`] && (
                            <div className="px-2 pb-2">
                              <textarea
                                value={agent.agents_md || ""}
                                onChange={(e) => updateAgent(idx, agentId, { agents_md: e.target.value })}
                                placeholder="# AGENTS.md seed content for this agent..."
                                rows={8}
                                className="w-full bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent resize-y"
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Scheduled Trigger */}
                  <div className="mt-4">
                    <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Scheduled Trigger</h3>
                    <div className="border border-border p-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                        <Input
                          label="Interval (minutes)"
                          value={String(project.trigger_interval || 30)}
                          onChange={(v) => updateProject(idx, { trigger_interval: parseInt(v, 10) || 30 } as Partial<ProjectConfig>)}
                          type="number"
                        />
                        <div className="flex flex-col gap-1">
                          <label className="text-[11px] text-text-muted uppercase tracking-wider">Message Template</label>
                          <textarea
                            value={project.trigger_message || ""}
                            onChange={(e) => updateProject(idx, { trigger_message: e.target.value } as Partial<ProjectConfig>)}
                            placeholder="@t1 @t2a @t2b @t3 — Queue check..."
                            rows={4}
                            className="bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent resize-y"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Telegram Bridge */}
                  <div className="mt-4">
                    <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Telegram Bridge</h3>
                    <div className="border border-border p-3">
                      <div className="flex items-center gap-3 mb-3">
                        <button
                          onClick={() => updateTelegram(idx, { enabled: !telegram.enabled })}
                          className={`w-8 h-4 rounded-full transition-colors relative ${
                            telegram.enabled ? "bg-accent" : "bg-border"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 w-3 h-3 rounded-full bg-text transition-transform ${
                              telegram.enabled ? "left-4" : "left-0.5"
                            }`}
                          />
                        </button>
                        <span className="text-[11px] text-text">{telegram.enabled ? "Enabled" : "Disabled"}</span>
                        <span className="text-[11px] text-text-muted">·</span>
                        <span className={`w-1.5 h-1.5 rounded-full ${daemonStatus[project.id] ? "bg-accent" : "bg-text-muted"}`} />
                        <span className="text-[11px] text-text-muted">
                          {daemonStatus[project.id] ? "running" : "stopped"}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                        <Input
                          label="Bot Token"
                          value={telegram.bot_token}
                          onChange={(v) => updateTelegram(idx, { bot_token: v })}
                          type="password"
                          placeholder="123456:ABC-DEF..."
                        />
                        <Input
                          label="Chat ID"
                          value={telegram.chat_id}
                          onChange={(v) => updateTelegram(idx, { chat_id: v })}
                          placeholder="-1001234567890"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            fetch("/api/telegram?action=test", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ bot_token: telegram.bot_token, chat_id: telegram.chat_id }),
                            })
                              .then((r) => r.json())
                              .then((d) => alert(d.ok ? "Connection OK" : `Error: ${d.error}`))
                              .catch(() => alert("Test failed"));
                          }}
                          className="px-2 py-1 text-[11px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
                        >
                          Test Connection
                        </button>
                        <button
                          onClick={() => {
                            fetch("/api/telegram?action=install", { method: "POST" })
                              .then((r) => r.json())
                              .then((d) => alert(d.ok ? "Installed" : `Error: ${d.error}`))
                              .catch(() => alert("Install failed"));
                          }}
                          className="px-2 py-1 text-[11px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
                        >
                          Install Bridge
                        </button>
                        <button
                          onClick={() => {
                            const action = daemonStatus[project.id] ? "stop" : "start";
                            fetch(`/api/telegram?action=${action}`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ project_id: project.id }),
                            })
                              .then((r) => r.json())
                              .then((d) => {
                                if (d.ok) setDaemonStatus((prev) => ({ ...prev, [project.id]: d.running }));
                                else alert(`Error: ${d.error}`);
                              })
                              .catch(() => alert(`${action} failed`));
                          }}
                          className={`px-2 py-1 text-[11px] border border-border transition-colors ${
                            daemonStatus[project.id]
                              ? "text-error hover:border-error"
                              : "text-accent hover:border-accent"
                          }`}
                        >
                          {daemonStatus[project.id] ? "Stop Daemon" : "Start Daemon"}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Remove project */}
                  <div className="mt-4 flex justify-end">
                    {confirmDelete === project.id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-error">Remove this project?</span>
                        <button
                          onClick={() => removeProject(idx)}
                          className="px-2 py-1 text-[11px] bg-error text-bg font-semibold"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-2 py-1 text-[11px] text-text-muted border border-border"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(project.id)}
                        className="text-[11px] text-error hover:text-text transition-colors"
                      >
                        Remove Project
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Add project */}
        <button
          onClick={addProject}
          className="w-full border border-dashed border-border py-2 text-[12px] text-text-muted hover:text-text hover:border-text-muted transition-colors"
        >
          + Add Project
        </button>
      </section>

      {/* Bottom save */}
      <div className="flex justify-end pb-6">
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}
