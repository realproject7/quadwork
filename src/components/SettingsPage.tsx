"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";

interface AgentConfig {
  display_name: string;
  command: string;
  cwd: string;
  model: string;
  agents_md: string;
}

// Per-project Telegram config + Scheduled Trigger fields are still on
// the ProjectConfig type (other code paths read them) but the
// Settings page no longer renders them — both moved to per-project
// widgets in #210 and #211.
interface ProjectConfig {
  id: string;
  name: string;
  repo: string;
  working_dir: string;
  agents: Record<string, AgentConfig>;
  agentchattr_url?: string;
  agentchattr_token?: string;
  mcp_http_port?: number;
  mcp_sse_port?: number;
  archived?: boolean;
}

interface Config {
  port: number;
  agentchattr_url: string;
  agentchattr_token: string;
  default_backend?: string;
  reviewer_github_user?: string;
  // #405 / quadwork#278: display name used as the chat sender for
  // dashboard-originated messages. Defaults to "user" server-side.
  operator_name?: string;
  projects: ProjectConfig[];
}

const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  head: { display_name: "Head", command: "claude", cwd: "", model: "opus", agents_md: "" },
  reviewer1: { display_name: "Reviewer1", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
  reviewer2: { display_name: "Reviewer2", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
  dev: { display_name: "Dev", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
};

const BACKENDS: { value: string; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];
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
  options: { value: string; label: string }[];
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
          <option key={o.value} value={o.value} className="bg-bg-surface">{o.label}</option>
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
  // #212: drop the per-project accordion. AGENTS.md edit toggles
  // still need a per-key flag, so we keep `expanded` but no longer
  // gate the project body on it — every project is open by default.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [autoAdded, setAutoAdded] = useState(false);
  const [cliStatus, setCliStatus] = useState<{ claude: boolean; codex: boolean } | null>(null);

  const load = useCallback(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => setConfig({
        port: data.port || 8400,
        agentchattr_url: data.agentchattr_url || "http://127.0.0.1:8300",
        agentchattr_token: data.agentchattr_token || "",
        default_backend: data.default_backend || "claude",
        reviewer_github_user: data.reviewer_github_user || "",
        operator_name: data.operator_name || "user",
        projects: data.projects || [],
      }))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  // Fetch CLI status
  useEffect(() => {
    fetch("/api/cli-status")
      .then((r) => r.json())
      .then((status) => setCliStatus(status))
      .catch(() => {});
  }, []);

  // #212: reviewer-token presence + Keep Awake state for the new
  // global Settings sub-sections.
  const [reviewerTokenExists, setReviewerTokenExists] = useState<boolean | null>(null);
  const [reviewerTokenInput, setReviewerTokenInput] = useState("");
  const [reviewerTokenSaving, setReviewerTokenSaving] = useState(false);
  const [keepAwakeActive, setKeepAwakeActive] = useState(false);
  const [keepAwakeBusy, setKeepAwakeBusy] = useState(false);

  const refreshReviewerTokenStatus = useCallback(() => {
    fetch("/api/setup/reviewer-token-status")
      .then((r) => (r.ok ? r.json() : { exists: false }))
      .then((d) => setReviewerTokenExists(!!d.exists))
      .catch(() => setReviewerTokenExists(false));
  }, []);

  const refreshKeepAwake = useCallback(() => {
    fetch("/api/caffeinate/status")
      .then((r) => (r.ok ? r.json() : { active: false }))
      .then((d) => setKeepAwakeActive(!!d.active))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshReviewerTokenStatus();
    refreshKeepAwake();
  }, [refreshReviewerTokenStatus, refreshKeepAwake]);

  const saveReviewerToken = async () => {
    if (!reviewerTokenInput.trim()) return;
    setReviewerTokenSaving(true);
    try {
      const r = await fetch("/api/setup/save-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: reviewerTokenInput.trim() }),
      });
      if (r.ok) {
        setReviewerTokenInput("");
        refreshReviewerTokenStatus();
      }
    } finally {
      setReviewerTokenSaving(false);
    }
  };

  const toggleKeepAwake = async () => {
    setKeepAwakeBusy(true);
    try {
      const url = keepAwakeActive ? "/api/caffeinate/stop" : "/api/caffeinate/start";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (r.ok) refreshKeepAwake();
    } finally {
      setKeepAwakeBusy(false);
    }
  };

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
      // #212: Telegram credentials are now configured per-project from
      // the bottom-right Telegram Bridge widget (#211), which writes
      // its own env-references via /api/telegram?action=save-config.
      // The Settings save path no longer needs to migrate bot tokens.
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


  const addProject = () => {
    if (!config) return;
    const id = `project-${Date.now()}`;
    // #212: honor the saved Default agent CLI setting first. Fall
    // back to CLI-status-aware availability only when the configured
    // backend isn't actually installed (so we never seed a project
    // with a CLI the user can't run).
    const configured = config.default_backend || "claude";
    const configuredAvailable = !cliStatus || (cliStatus[configured as "claude" | "codex"] !== false);
    const defaultCmd = configuredAvailable
      ? configured
      : (cliStatus && cliStatus.claude && !cliStatus.codex ? "claude"
        : cliStatus && !cliStatus.claude && cliStatus.codex ? "codex"
        : "claude");
    const agents: Record<string, AgentConfig> = {};
    for (const [key, val] of Object.entries(DEFAULT_AGENTS)) {
      agents[key] = { ...val, command: defaultCmd };
    }
    const newProject: ProjectConfig = {
      id,
      name: "New Project",
      repo: "owner/repo",
      working_dir: "",
      agents,
    };
    setConfig({ ...config, projects: [...config.projects, newProject] });
    setExpanded({ ...expanded, [id]: true });
  };

  // Track original names for debounced rename propagation
  const originalNames = useRef<Record<string, string>>({});
  const renameTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const renameProject = (idx: number, newName: string) => {
    if (!config) return;
    const project = config.projects[idx];
    const key = `project:${project.id}`;

    // Store the original name on first edit
    if (!(key in originalNames.current)) {
      originalNames.current[key] = project.name;
    }

    // Update local state immediately for responsive UI
    updateProject(idx, { name: newName });

    // Debounce the API propagation (800ms after last keystroke)
    if (renameTimers.current[key]) clearTimeout(renameTimers.current[key]);
    renameTimers.current[key] = setTimeout(() => {
      const oldName = originalNames.current[key];
      if (oldName && oldName !== newName) {
        fetch("/api/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "project", projectId: project.id, oldName, newName }),
        })
          .then(() => load())
          .catch(() => {});
      }
      delete originalNames.current[key];
      delete renameTimers.current[key];
    }, 800);
  };

  const renameAgent = (projectIdx: number, agentId: string, newName: string) => {
    if (!config) return;
    const project = config.projects[projectIdx];
    const agent = project.agents?.[agentId];
    const key = `agent:${project.id}:${agentId}`;

    if (!(key in originalNames.current)) {
      originalNames.current[key] = agent?.display_name || agentId.toUpperCase();
    }

    updateAgent(projectIdx, agentId, { display_name: newName });

    if (renameTimers.current[key]) clearTimeout(renameTimers.current[key]);
    renameTimers.current[key] = setTimeout(() => {
      const oldName = originalNames.current[key];
      if (oldName && oldName !== newName) {
        fetch("/api/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "agent", projectId: project.id, agentId, oldName, newName }),
        })
          .then(() => load())
          .catch(() => {});
      }
      delete originalNames.current[key];
      delete renameTimers.current[key];
    }, 800);
  };

  const archiveProject = (idx: number) => {
    if (!config) return;
    updateProject(idx, { archived: true });
  };

  const restoreProject = (idx: number) => {
    if (!config) return;
    updateProject(idx, { archived: false });
  };

  const removeProject = (idx: number) => {
    if (!config) return;
    const projects = config.projects.filter((_, i) => i !== idx);
    setConfig({ ...config, projects });
    setConfirmDelete(null);
  };

  if (!config) return <div className="p-6 text-text-muted text-xs">Loading...</div>;

  return (
    <div className="h-full w-full overflow-y-auto p-6">
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

      {/* #405 / quadwork#278: operator identity — name shown next to
          dashboard chat messages. Server-side validated to AC's
          registry name rules (1–32 alnum + dash + underscore). */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">Operator Identity</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="Your name in chat"
            value={config.operator_name || "user"}
            onChange={(v) => updateGlobal("operator_name" as keyof Config, v)}
            placeholder="user"
          />
        </div>
        <p className="mt-2 text-[10px] text-text-muted leading-snug">
          Shows next to your messages in the AgentChattr chat panel. Defaults to <code>user</code> if blank.
          Allowed: 1–32 letters, digits, dash, underscore (matches AgentChattr&apos;s name rules; other characters are stripped server-side).
        </p>
      </section>

      {/* Global Settings (#212: full-width grid, every section visible) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">Global</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="QuadWork Dashboard Port"
            value={String(config.port)}
            onChange={(v) => updateGlobal("port", parseInt(v, 10) || 8400)}
            type="number"
          />
          <Input
            label="AgentChattr URL (global override)"
            value={config.agentchattr_url}
            onChange={(v) => updateGlobal("agentchattr_url", v)}
            placeholder="http://127.0.0.1:8300"
          />
        </div>
        <p className="mt-2 text-[10px] text-text-muted leading-snug">
          The dashboard binds to the QuadWork port. The AgentChattr URL is the v1 fallback;
          new projects use a per-project AgentChattr clone (master #181) and ignore this field.
        </p>
      </section>

      {/* Defaults — default agent CLI + reviewer credentials (#212) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">Defaults</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <Select
            label="Default agent CLI"
            value={config.default_backend || "claude"}
            onChange={(v) => updateGlobal("default_backend" as keyof Config, v)}
            options={BACKENDS.map((b) => ({
              value: b.value,
              label: b.label + (cliStatus && !cliStatus[b.value as keyof typeof cliStatus] ? " (not installed)" : ""),
            }))}
          />
          <Input
            label="Reviewer GitHub user"
            value={config.reviewer_github_user || ""}
            onChange={(v) => updateGlobal("reviewer_github_user" as keyof Config, v)}
            placeholder="reviewer-bot"
          />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-text-muted uppercase tracking-wider">Reviewer GitHub token</label>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${reviewerTokenExists ? "bg-accent" : "bg-text-muted"}`} />
              <span className="text-[11px] text-text-muted">
                {reviewerTokenExists === null ? "…" : reviewerTokenExists ? "Configured" : "Not configured"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <input
                type="password"
                value={reviewerTokenInput}
                onChange={(e) => setReviewerTokenInput(e.target.value)}
                placeholder="Paste new token"
                className="flex-1 bg-transparent border border-border px-2 py-1 text-[11px] text-text outline-none focus:border-accent font-mono"
              />
              <button
                onClick={saveReviewerToken}
                disabled={reviewerTokenSaving || !reviewerTokenInput.trim()}
                className="px-2 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 transition-colors"
              >
                {reviewerTokenSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-text-muted leading-snug">
          The default CLI seeds new project agents. The reviewer GitHub user/token are
          used by Reviewer1/Reviewer2 to post PR review comments without your personal
          token. The token is written to{" "}
          <code className="bg-bg-surface px-1 rounded">~/.quadwork/reviewer-token</code>{" "}
          (mode 0600) and is never returned by the API.
        </p>
      </section>

      {/* System — Keep Awake (#212) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">System</h2>
        <div className="border border-border p-3 flex items-center gap-3">
          <span className={`w-1.5 h-1.5 rounded-full ${keepAwakeActive ? "bg-accent" : "bg-text-muted"}`} />
          <span className="text-[11px] text-text">Keep Awake — {keepAwakeActive ? "on" : "off"}</span>
          <button
            onClick={toggleKeepAwake}
            disabled={keepAwakeBusy}
            className="px-2 py-1 text-[11px] border border-border text-text-muted hover:text-text hover:border-accent disabled:opacity-50 transition-colors"
          >
            {keepAwakeBusy ? "…" : keepAwakeActive ? "Stop" : "Start"}
          </button>
          <span className="text-[10px] text-text-muted">
            Prevents this machine from sleeping while agents are running. Machine-level
            (not per-project) — uses <code>caffeinate</code> on macOS.
          </span>
        </div>
      </section>

      {/* Cleanup commands (#212 / #189) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">Cleanup</h2>
        <div className="border border-border p-3 text-[11px] text-text-muted space-y-1">
          <p>
            Each project now has its own AgentChattr clone at
            {" "}<code className="bg-bg-surface px-1 rounded">~/.quadwork/&#123;id&#125;/agentchattr</code>
            {" "}(~77 MB). After all projects are migrated, the legacy global install can be removed:
          </p>
          <pre className="mt-1 p-2 bg-bg-surface text-text rounded font-mono text-[11px]">npx quadwork cleanup --legacy</pre>
          <p className="mt-2">To remove a single project&apos;s clone and config entry:</p>
          <pre className="mt-1 p-2 bg-bg-surface text-text rounded font-mono text-[11px]">npx quadwork cleanup --project &lt;id&gt;</pre>
          <p className="mt-2 text-text-muted/80">
            Both commands prompt for confirmation. Worktrees and source repos are never touched.
            See <code>npx quadwork --help</code> or the README&apos;s Disk Usage section for details.
          </p>
        </div>
      </section>

      <hr className="border-border mb-6" />

      {/* Per-project settings */}
      <section className="mb-6">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">Active Projects</h2>

        {config.projects.filter((p) => !p.archived).map((project) => {
          const idx = config.projects.indexOf(project);

          return (
            <div key={project.id} className="border border-border mb-3">
              {/* Header — #212: no accordion, body always visible */}
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-[12px] text-text font-semibold">{project.name}</span>
              </div>

              {(
                <div className="px-3 pb-3 border-t border-border">
                  {/* Basic project info */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                    <Input
                      label="Project Name"
                      value={project.name}
                      onChange={(v) => renameProject(idx, v)}
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
                    {cliStatus && (cliStatus.claude ? !cliStatus.codex : cliStatus.codex) && (
                      <div className="border border-accent/20 bg-accent/5 p-2 mb-2 text-[10px]">
                        <span className="text-text">
                          {cliStatus.claude ? "Only Claude Code" : "Only Codex CLI"} is installed.
                        </span>
                        <span className="text-text-muted ml-1">
                          Install {cliStatus.claude ? "Codex" : "Claude Code"} for more backend options:
                        </span>
                        <code className="text-accent ml-1">
                          {cliStatus.claude ? "npm install -g codex" : "npm install -g @anthropic-ai/claude-code"}
                        </code>
                      </div>
                    )}
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
                            <div className="flex flex-col gap-0.5">
                              <input
                                value={agent.display_name || agentId.toUpperCase()}
                                onChange={(e) => renameAgent(idx, agentId, e.target.value)}
                                className="bg-transparent text-[11px] text-text font-semibold outline-none border border-border px-1 py-0.5 focus:border-accent"
                              />
                              <span className="text-[9px] text-text-muted px-1">
                                {agentId === "head" ? "Owner" : agentId.startsWith("reviewer") ? "Reviewer" : "Builder"}
                              </span>
                            </div>
                            <select
                              value={agent.command || "claude"}
                              onChange={(e) => updateAgent(idx, agentId, { command: e.target.value })}
                              className="bg-transparent text-[11px] text-text outline-none border border-border px-1 py-0.5 focus:border-accent"
                              title={cliStatus && Object.values(cliStatus).filter(Boolean).length === 1
                                ? `Only one CLI installed — install the other for more options`
                                : undefined}
                            >
                              {BACKENDS.map((b) => (
                                <option
                                  key={b.value}
                                  value={b.value}
                                  className="bg-bg-surface"
                                  disabled={cliStatus ? !cliStatus[b.value as keyof typeof cliStatus] : false}
                                >
                                  {b.label}{cliStatus && !cliStatus[b.value as keyof typeof cliStatus] ? " (not installed)" : ""}
                                </option>
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

                  {/* AgentChattr (per-project) */}
                  <div className="mt-4">
                    <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-2">AgentChattr</h3>
                    <div className="border border-border p-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Input
                          label="AgentChattr URL"
                          value={project.agentchattr_url || ""}
                          onChange={(v) => updateProject(idx, { agentchattr_url: v } as Partial<ProjectConfig>)}
                          placeholder="http://127.0.0.1:8300"
                        />
                        <Input
                          label="Session Token"
                          value={project.agentchattr_token || ""}
                          onChange={(v) => updateProject(idx, { agentchattr_token: v } as Partial<ProjectConfig>)}
                          placeholder="(optional)"
                        />
                        <Input
                          label="MCP HTTP Port"
                          value={String(project.mcp_http_port || "")}
                          onChange={(v) => updateProject(idx, { mcp_http_port: parseInt(v, 10) || undefined } as Partial<ProjectConfig>)}
                          type="number"
                          placeholder="8200"
                        />
                        <Input
                          label="MCP SSE Port"
                          value={String(project.mcp_sse_port || "")}
                          onChange={(v) => updateProject(idx, { mcp_sse_port: parseInt(v, 10) || undefined } as Partial<ProjectConfig>)}
                          type="number"
                          placeholder="8201"
                        />
                      </div>
                    </div>
                  </div>

                  {/* #212: Scheduled Trigger and Telegram Bridge sections
                       were here. Both have been moved to per-project
                       widgets in the bottom-right Operator Features
                       quadrant (#210 + #211). Configure them from
                       the project page. */}

                  {/* Remove project */}
                  <div className="mt-4 flex justify-end gap-3">
                    {project.archived ? (
                      <button
                        onClick={() => restoreProject(idx)}
                        className="text-[11px] text-accent hover:underline"
                      >
                        Restore Project
                      </button>
                    ) : (
                      <button
                        onClick={() => archiveProject(idx)}
                        className="text-[11px] text-text-muted hover:text-text transition-colors"
                      >
                        Archive
                      </button>
                    )}
                    {confirmDelete === project.id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-error">Remove?</span>
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
                        Remove
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

        {/* Archived projects */}
        {config.projects.some((p) => p.archived) && (
          <>
            <hr className="border-border my-4" />
            <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">Archived</h2>
            {config.projects.filter((p) => p.archived).map((project) => {
              const idx = config.projects.indexOf(project);
              return (
                <div key={project.id} className="border border-border mb-3 opacity-60">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-[12px] text-text-muted">{project.name}</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => restoreProject(idx)}
                        className="text-[11px] text-accent hover:underline"
                      >
                        Restore
                      </button>
                      <button
                        onClick={() => {
                          if (confirmDelete === project.id) {
                            removeProject(idx);
                          } else {
                            setConfirmDelete(project.id);
                          }
                        }}
                        className="text-[11px] text-error hover:underline"
                      >
                        {confirmDelete === project.id ? "Confirm Remove" : "Remove"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
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
