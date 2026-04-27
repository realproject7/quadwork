"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/components/LocaleProvider";

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
  re1: { display_name: "RE1", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
  re2: { display_name: "RE2", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
  dev: { display_name: "Dev", command: "claude", cwd: "", model: "sonnet", agents_md: "" },
};

const BACKENDS: { value: string; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];
const MODELS = ["opus", "sonnet", "haiku"];

const COPY = {
  en: {
    loading: "Loading...",
    title: "Settings",
    save: "Save",
    saving: "Saving...",
    saved: "Saved",
    operatorIdentity: "Operator Identity",
    yourNameInChat: "Your name in chat",
    language: "Language",
    operatorHelp:
      "Shows next to your messages in the AgentChattr chat panel. Defaults to user if blank. Allowed: 1-32 letters, digits, dash, underscore (matches AgentChattr name rules; other characters are stripped server-side). Reserved agent names like head, dev, re1, re2, and system are rejected and fall back to user.",
    global: "Global",
    dashboardPort: "QuadWork Dashboard Port",
    agentChattrUrlGlobal: "AgentChattr URL (global override)",
    globalHelp:
      "The dashboard binds to the QuadWork port. The AgentChattr URL is the v1 fallback; new projects use a per-project AgentChattr clone and ignore this field.",
    defaults: "Defaults",
    defaultAgentCli: "Default agent CLI",
    reviewerGithubUser: "Reviewer GitHub user",
    reviewerGithubToken: "Reviewer GitHub token",
    configured: "Configured",
    notConfigured: "Not configured",
    pasteNewToken: "Paste new token",
    defaultsHelp:
      "The default CLI seeds new project agents. The reviewer GitHub user/token are used by RE1/RE2 to post PR review comments without your personal token. The token is written to ~/.quadwork/reviewer-token (mode 0600) and is never returned by the API.",
    system: "System",
    keepAwake: "Keep Awake",
    on: "on",
    off: "off",
    stop: "Stop",
    start: "Start",
    keepAwakeHelp:
      "Prevents this machine from sleeping while agents are running. Machine-level (not per-project) - uses caffeinate on macOS.",
    cleanup: "Cleanup",
    cleanupIntro:
      "Each project now has its own AgentChattr clone at ~/.quadwork/{id}/agentchattr (~77 MB). After all projects are migrated, the legacy global install can be removed:",
    cleanupSingle: "To remove a single project's clone and config entry:",
    cleanupHelp:
      "Both commands prompt for confirmation. Worktrees and source repos are never touched. See npx quadwork --help or the README's Disk Usage section for details.",
    activeProjects: "Active Projects",
    projectName: "Project Name",
    githubRepo: "GitHub Repo",
    workingDirectory: "Working Directory",
    agents: "Agents",
    name: "Name",
    command: "Command",
    model: "Model",
    cwd: "CWD",
    agentsMd: "AGENTS.md",
    owner: "Owner",
    reviewer: "Reviewer",
    builder: "Builder",
    edit: "edit",
    oneCliInstalled: "Only one CLI installed - install the other for more options",
    agentsMdPlaceholder: "# AGENTS.md seed content for this agent...",
    agentChattr: "AgentChattr",
    agentChattrUrl: "AgentChattr URL",
    sessionToken: "Session Token",
    optional: "(optional)",
    mcpHttpPort: "MCP HTTP Port",
    mcpSsePort: "MCP SSE Port",
    restoreProject: "Restore Project",
    archive: "Archive",
    remove: "Remove",
    removeQuestion: "Remove?",
    confirm: "Confirm",
    cancel: "Cancel",
    addProject: "+ Add Project",
    archived: "Archived",
    restore: "Restore",
    confirmRemove: "Confirm Remove",
    newProject: "New Project",
  },
  ko: {
    loading: "로딩 중...",
    title: "설정",
    save: "저장",
    saving: "저장 중...",
    saved: "저장됨",
    operatorIdentity: "운영자 정보",
    yourNameInChat: "채팅에서의 이름",
    language: "언어",
    operatorHelp:
      "AgentChattr 채팅 패널에서 내 메시지 옆에 표시됩니다. 비워두면 기본값은 user입니다. 허용: 1-32자의 영문, 숫자, 하이픈, 언더스코어(AgentChattr 이름 규칙과 동일). 다른 문자는 서버에서 제거됩니다. head, dev, re1, re2, system 같은 예약 이름은 거부되고 user로 대체됩니다.",
    global: "전역",
    dashboardPort: "QuadWork 대시보드 포트",
    agentChattrUrlGlobal: "AgentChattr URL (전역 오버라이드)",
    globalHelp:
      "대시보드는 QuadWork 포트에 바인딩됩니다. AgentChattr URL은 v1 호환용 기본값이며, 새 프로젝트는 프로젝트별 AgentChattr 클론을 사용하므로 이 필드는 무시됩니다.",
    defaults: "기본값",
    defaultAgentCli: "기본 에이전트 CLI",
    reviewerGithubUser: "리뷰어 GitHub 사용자",
    reviewerGithubToken: "리뷰어 GitHub 토큰",
    configured: "설정됨",
    notConfigured: "미설정",
    pasteNewToken: "새 토큰 붙여넣기",
    defaultsHelp:
      "기본 CLI는 새 프로젝트 에이전트의 초기값으로 사용됩니다. 리뷰어 GitHub 사용자/토큰은 개인 토큰 없이 RE1/RE2가 PR 리뷰 댓글을 남길 때 사용됩니다. 토큰은 ~/.quadwork/reviewer-token (권한 0600)에 저장되며 API로는 반환되지 않습니다.",
    system: "시스템",
    keepAwake: "절전 방지",
    on: "켜짐",
    off: "꺼짐",
    stop: "중지",
    start: "시작",
    keepAwakeHelp:
      "에이전트가 실행되는 동안 이 기기가 잠들지 않도록 합니다. 기기 전체 설정이며(프로젝트별 아님) macOS에서는 caffeinate를 사용합니다.",
    cleanup: "정리",
    cleanupIntro:
      "각 프로젝트는 이제 ~/.quadwork/{id}/agentchattr (~77 MB)에 자체 AgentChattr 클론을 가집니다. 모든 프로젝트 마이그레이션이 끝나면 예전 전역 설치는 제거할 수 있습니다:",
    cleanupSingle: "특정 프로젝트의 클론과 설정 항목만 제거하려면:",
    cleanupHelp:
      "두 명령 모두 확인 절차가 있습니다. 워크트리와 소스 저장소는 건드리지 않습니다. 자세한 내용은 npx quadwork --help 또는 README의 Disk Usage 섹션을 참고하세요.",
    activeProjects: "활성 프로젝트",
    projectName: "프로젝트 이름",
    githubRepo: "GitHub 저장소",
    workingDirectory: "작업 디렉터리",
    agents: "에이전트",
    name: "이름",
    command: "명령어",
    model: "모델",
    cwd: "작업 디렉터리",
    agentsMd: "AGENTS.md",
    owner: "소유자",
    reviewer: "검토자",
    builder: "개발자",
    edit: "편집",
    oneCliInstalled: "CLI 하나만 설치됨 - 더 많은 옵션을 위해 다른 CLI를 설치하세요",
    agentsMdPlaceholder: "# 이 에이전트의 AGENTS.md 초기 내용...",
    agentChattr: "AgentChattr",
    agentChattrUrl: "AgentChattr URL",
    sessionToken: "세션 토큰",
    optional: "(선택)",
    mcpHttpPort: "MCP HTTP 포트",
    mcpSsePort: "MCP SSE 포트",
    restoreProject: "프로젝트 복원",
    archive: "보관",
    remove: "제거",
    removeQuestion: "제거할까요?",
    confirm: "확인",
    cancel: "취소",
    addProject: "+ 프로젝트 추가",
    archived: "보관됨",
    restore: "복원",
    confirmRemove: "제거 확인",
    newProject: "새 프로젝트",
  },
} as const;

function Input({ label, value, onChange, onBlur, type = "text", placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
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
        onBlur={onBlur}
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
  const { locale, setLocale } = useLocale();
  const t = COPY[locale];
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
  // #419 / quadwork#308: draft-string mirror for the dashboard port
  // field so the operator can clear it and retype without
  // `parseInt("") || 8400` clobbering the buffer mid-keystroke.
  // Kept in sync with config.port on load + blur commit.
  const [portDraft, setPortDraft] = useState<string>("8400");
  // #419 / quadwork#308: per-project MCP port drafts keyed by
  // `${projectId}-http` / `${projectId}-sse`. Same draft-string
  // pattern as the global port input above — the previous
  // `parseInt(v) || undefined` onChange clobbered partial typing.
  const [projectPortDrafts, setProjectPortDrafts] = useState<Record<string, string>>({});
  const getProjectPortDraft = (projectId: string, key: "http" | "sse", fallback: number | undefined) => {
    const dkey = `${projectId}-${key}`;
    if (dkey in projectPortDrafts) return projectPortDrafts[dkey];
    return fallback ? String(fallback) : "";
  };
  const setProjectPortDraftValue = (projectId: string, key: "http" | "sse", value: string) => {
    setProjectPortDrafts((prev) => ({ ...prev, [`${projectId}-${key}`]: value }));
  };
  const commitProjectPortDraft = (idx: number, projectId: string, key: "http" | "sse", field: "mcp_http_port" | "mcp_sse_port") => {
    const draft = projectPortDrafts[`${projectId}-${key}`] ?? "";
    const n = parseInt(draft, 10);
    const clamped = Number.isFinite(n) && n > 0 && n <= 65535 ? n : undefined;
    updateProject(idx, { [field]: clamped } as Partial<ProjectConfig>);
    setProjectPortDrafts((prev) => ({ ...prev, [`${projectId}-${key}`]: clamped ? String(clamped) : "" }));
  };

  const load = useCallback(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => {
        setPortDraft(String(data.port || 8400));
        return setConfig({
        port: data.port || 8400,
        agentchattr_url: data.agentchattr_url || "http://127.0.0.1:8300",
        agentchattr_token: data.agentchattr_token || "",
        default_backend: data.default_backend || "claude",
        reviewer_github_user: data.reviewer_github_user || "",
        operator_name: data.operator_name || "user",
        projects: data.projects || [],
        });
      })
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
      name: t.newProject,
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

  if (!config) return <div className="p-6 text-text-muted text-xs">{t.loading}</div>;

  return (
    <div className="h-full w-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-text tracking-tight">{t.title}</h1>
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
        >
          {saving ? t.saving : saved ? t.saved : t.save}
        </button>
      </div>

      {/* #405 / quadwork#278: operator identity — name shown next to
          dashboard chat messages. Server-side validated to AC's
          registry name rules (1–32 alnum + dash + underscore). */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.operatorIdentity}</h2>
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)] gap-3 items-end">
          <Input
            label={t.yourNameInChat}
            value={config.operator_name || "user"}
            onChange={(v) => updateGlobal("operator_name" as keyof Config, v)}
            placeholder="user"
          />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-text-muted uppercase tracking-wider">{t.language}</label>
            <div className="flex items-center gap-2 h-[35px]">
              {(["en", "ko"] as const).map((code) => {
                const active = locale === code;
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setLocale(code)}
                    className={`px-3 py-1.5 text-[12px] border transition-colors ${
                      active
                        ? "border-accent bg-accent text-bg"
                        : "border-border text-text-muted hover:text-text hover:border-accent"
                    }`}
                  >
                    {code}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-text-muted leading-snug">
          {t.operatorHelp}
        </p>
      </section>

      {/* Global Settings (#212: full-width grid, every section visible) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.global}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label={t.dashboardPort}
            value={portDraft}
            onChange={(v) => setPortDraft(v)}
            onBlur={() => {
              const n = parseInt(portDraft, 10);
              const clamped = Number.isFinite(n) && n > 0 && n <= 65535 ? n : 8400;
              updateGlobal("port", clamped);
              setPortDraft(String(clamped));
            }}
            type="number"
          />
          <Input
            label={t.agentChattrUrlGlobal}
            value={config.agentchattr_url}
            onChange={(v) => updateGlobal("agentchattr_url", v)}
            placeholder="http://127.0.0.1:8300"
          />
        </div>
        <p className="mt-2 text-[10px] text-text-muted leading-snug">
          {t.globalHelp}
        </p>
      </section>

      {/* Defaults — default agent CLI + reviewer credentials (#212) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.defaults}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <Select
            label={t.defaultAgentCli}
            value={config.default_backend || "claude"}
            onChange={(v) => updateGlobal("default_backend" as keyof Config, v)}
            options={BACKENDS.map((b) => ({
              value: b.value,
              label: b.label + (cliStatus && !cliStatus[b.value as keyof typeof cliStatus] ? " (not installed)" : ""),
            }))}
          />
          <Input
            label={t.reviewerGithubUser}
            value={config.reviewer_github_user || ""}
            onChange={(v) => updateGlobal("reviewer_github_user" as keyof Config, v)}
            placeholder="reviewer-bot"
          />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-text-muted uppercase tracking-wider">{t.reviewerGithubToken}</label>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${reviewerTokenExists ? "bg-accent" : "bg-text-muted"}`} />
              <span className="text-[11px] text-text-muted">
                {reviewerTokenExists === null ? "…" : reviewerTokenExists ? t.configured : t.notConfigured}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <input
                type="password"
                value={reviewerTokenInput}
                onChange={(e) => setReviewerTokenInput(e.target.value)}
                placeholder={t.pasteNewToken}
                className="flex-1 bg-transparent border border-border px-2 py-1 text-[11px] text-text outline-none focus:border-accent font-mono"
              />
              <button
                onClick={saveReviewerToken}
                disabled={reviewerTokenSaving || !reviewerTokenInput.trim()}
                className="px-2 py-1 text-[11px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 transition-colors"
              >
                {reviewerTokenSaving ? t.saving : t.save}
              </button>
            </div>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-text-muted leading-snug">
          {t.defaultsHelp}
        </p>
      </section>

      {/* System — Keep Awake (#212) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.system}</h2>
        <div className="border border-border p-3 flex items-center gap-3">
          <span className={`w-1.5 h-1.5 rounded-full ${keepAwakeActive ? "bg-accent" : "bg-text-muted"}`} />
          <span className="text-[11px] text-text">{t.keepAwake} - {keepAwakeActive ? t.on : t.off}</span>
          <button
            onClick={toggleKeepAwake}
            disabled={keepAwakeBusy}
            className="px-2 py-1 text-[11px] border border-border text-text-muted hover:text-text hover:border-accent disabled:opacity-50 transition-colors"
          >
            {keepAwakeBusy ? "…" : keepAwakeActive ? t.stop : t.start}
          </button>
          <span className="text-[10px] text-text-muted">
            {t.keepAwakeHelp}
          </span>
        </div>
      </section>

      {/* Cleanup commands (#212 / #189) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.cleanup}</h2>
        <div className="border border-border p-3 text-[11px] text-text-muted space-y-1">
          <p>
            {t.cleanupIntro.split("~/.quadwork/{id}/agentchattr")[0]}
            {" "}<code className="bg-bg-surface px-1 rounded">~/.quadwork/&#123;id&#125;/agentchattr</code>
            {t.cleanupIntro.includes("~/.quadwork/{id}/agentchattr")
              ? t.cleanupIntro.split("~/.quadwork/{id}/agentchattr")[1]
              : ""}
          </p>
          <pre className="mt-1 p-2 bg-bg-surface text-text rounded font-mono text-[11px]">npx quadwork cleanup --legacy</pre>
          <p className="mt-2">{t.cleanupSingle}</p>
          <pre className="mt-1 p-2 bg-bg-surface text-text rounded font-mono text-[11px]">npx quadwork cleanup --project &lt;id&gt;</pre>
          <p className="mt-2 text-text-muted/80">{t.cleanupHelp}</p>
        </div>
      </section>

      <hr className="border-border mb-6" />

      {/* Per-project settings */}
      <section className="mb-6">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.activeProjects}</h2>

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
                      label={t.projectName}
                      value={project.name}
                      onChange={(v) => renameProject(idx, v)}
                    />
                    <Input
                      label={t.githubRepo}
                      value={project.repo}
                      onChange={(v) => updateProject(idx, { repo: v })}
                      placeholder="owner/repo"
                    />
                    <Input
                      label={t.workingDirectory}
                      value={project.working_dir || ""}
                      onChange={(v) => updateProject(idx, { working_dir: v })}
                      placeholder="/path/to/project"
                    />
                  </div>

                  {/* Agents table */}
                  <div className="mt-4">
                    <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-2">{t.agents}</h3>
                    {cliStatus && (cliStatus.claude ? !cliStatus.codex : cliStatus.codex) && (
                      <div className="border border-accent/20 bg-accent/5 p-2 mb-2 text-[10px]">
                        <span className="text-text">
                          {t.oneCliInstalled}
                        </span>
                        <code className="text-accent ml-2">
                          {cliStatus.claude ? "npm install -g codex" : "npm install -g @anthropic-ai/claude-code"}
                        </code>
                      </div>
                    )}
                    <div className="border border-border">
                      <div className="grid grid-cols-5 gap-0 px-2 py-1 border-b border-border text-[10px] text-text-muted uppercase">
                        <span>{t.name}</span>
                        <span>{t.command}</span>
                        <span>{t.model}</span>
                        <span>{t.cwd}</span>
                        <span>{t.agentsMd}</span>
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
                                {agentId === "head" ? t.owner : agentId.startsWith("reviewer") ? t.reviewer : t.builder}
                              </span>
                            </div>
                            <select
                              value={agent.command || "claude"}
                              onChange={(e) => updateAgent(idx, agentId, { command: e.target.value })}
                              className="bg-transparent text-[11px] text-text outline-none border border-border px-1 py-0.5 focus:border-accent"
                              title={cliStatus && Object.values(cliStatus).filter(Boolean).length === 1
                                ? t.oneCliInstalled
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
                              {expanded[`${project.id}-${agentId}-md`] ? `▾ ${t.edit}` : `▸ ${t.edit}`}
                            </button>
                          </div>
                          {expanded[`${project.id}-${agentId}-md`] && (
                            <div className="px-2 pb-2">
                              <textarea
                                value={agent.agents_md || ""}
                                onChange={(e) => updateAgent(idx, agentId, { agents_md: e.target.value })}
                                placeholder={t.agentsMdPlaceholder}
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
                    <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-2">{t.agentChattr}</h3>
                    <div className="border border-border p-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Input
                          label={t.agentChattrUrl}
                          value={project.agentchattr_url || ""}
                          onChange={(v) => updateProject(idx, { agentchattr_url: v } as Partial<ProjectConfig>)}
                          placeholder="http://127.0.0.1:8300"
                        />
                        <Input
                          label={t.sessionToken}
                          value={project.agentchattr_token || ""}
                          onChange={(v) => updateProject(idx, { agentchattr_token: v } as Partial<ProjectConfig>)}
                          placeholder={t.optional}
                        />
                        <Input
                          label={t.mcpHttpPort}
                          value={getProjectPortDraft(project.id, "http", project.mcp_http_port)}
                          onChange={(v) => setProjectPortDraftValue(project.id, "http", v)}
                          onBlur={() => commitProjectPortDraft(idx, project.id, "http", "mcp_http_port")}
                          type="number"
                          placeholder="8200"
                        />
                        <Input
                          label={t.mcpSsePort}
                          value={getProjectPortDraft(project.id, "sse", project.mcp_sse_port)}
                          onChange={(v) => setProjectPortDraftValue(project.id, "sse", v)}
                          onBlur={() => commitProjectPortDraft(idx, project.id, "sse", "mcp_sse_port")}
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
                        {t.restoreProject}
                      </button>
                    ) : (
                      <button
                        onClick={() => archiveProject(idx)}
                        className="text-[11px] text-text-muted hover:text-text transition-colors"
                      >
                        {t.archive}
                      </button>
                    )}
                    {confirmDelete === project.id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-error">{t.removeQuestion}</span>
                        <button
                          onClick={() => removeProject(idx)}
                          className="px-2 py-1 text-[11px] bg-error text-bg font-semibold"
                        >
                          {t.confirm}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-2 py-1 text-[11px] text-text-muted border border-border"
                        >
                          {t.cancel}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(project.id)}
                        className="text-[11px] text-error hover:text-text transition-colors"
                      >
                        {t.remove}
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
          {t.addProject}
        </button>

        {/* Archived projects */}
        {config.projects.some((p) => p.archived) && (
          <>
            <hr className="border-border my-4" />
            <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.archived}</h2>
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
                        {t.restore}
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
                        {confirmDelete === project.id ? t.confirmRemove : t.remove}
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
          {saving ? t.saving : saved ? t.saved : t.save}
        </button>
      </div>
    </div>
  );
}
