"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/components/LocaleProvider";
import { modelsForBackend, effectiveModel, sanitizeModel } from "@/lib/agentModels";
import { injectModeForCommand } from "@/lib/injectMode";
import { firstInstalledBackend } from "@/lib/defaultBackend";
import ActiveSwitch from "./ActiveSwitch";
import ConfirmModal from "./ConfirmModal";
import { persistProjectIdle, onIdleChange, idleConfirmTitle, IDLE_CONFIRM_BODY } from "@/lib/idle";

interface AgentConfig {
  display_name: string;
  command: string;
  cwd: string;
  model: string;
  agents_md: string;
  // #937: MCP injection mode (codex→proxy_flag, gemini→env, else flag). Written
  // by the setup wizard on every agent; the spawn path reads it. The Settings
  // command-change/save flow must keep it in sync with the command.
  mcp_inject?: string;
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
  archived?: boolean;
  idle?: boolean;
}

interface ButlerConfig {
  enabled?: boolean;
  command?: string;
  model?: string;
  auto_start?: boolean;
  cwd?: string;
  // #937: present only if a config carries it (the wizard doesn't write one for
  // the butler and the butler spawn doesn't consume it). Healed on save only
  // when already set, so a stale value never re-persists.
  mcp_inject?: string;
}

interface Config {
  port: number;
  default_backend?: string;
  reviewer_github_user?: string;
  // #405 / quadwork#278: display name used as the chat sender for
  // dashboard-originated messages. Defaults to "user" server-side.
  operator_name?: string;
  projects: ProjectConfig[];
  butler?: ButlerConfig;
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
  { value: "gemini", label: "Gemini CLI" },
  { value: "grok", label: "Grok CLI" },
];

const COPY = {
  en: {
    loading: "Loading...",
    loadError: "Couldn't load settings.",
    retry: "Retry",
    title: "Settings",
    save: "Save",
    saving: "Saving...",
    saved: "Saved",
    operatorIdentity: "Operator Identity",
    yourNameInChat: "Your name in chat",
    language: "Language",
    operatorHelp:
      "Shows next to your messages in the project chat panel. Defaults to user if blank. Allowed: 1-32 letters, digits, dash, underscore (other characters are stripped server-side). Reserved agent names like head, dev, re1, re2, and system are rejected and fall back to user.",
    global: "Global",
    dashboardPort: "QuadWork Dashboard Port",
    globalHelp:
      "The dashboard binds to the QuadWork port.",
    defaults: "Defaults",
    defaultAgentCli: "Default agent CLI",
    reviewerGithubUser: "Reviewer GitHub user",
    reviewerGithubToken: "Reviewer GitHub token",
    reviewerAccount: "Reviewer Account",
    reviewerAccountHelp:
      "Global reviewer credentials for RE1/RE2 across all projects. The token value is written to ~/.quadwork/reviewer-token (mode 0600), is never returned by the API, and is not rendered after save.",
    reviewerTokenStatus: "Token status",
    tokenPath: "Token path",
    configured: "Configured",
    notConfigured: "Not configured",
    pasteNewToken: "Paste new token",
    saveToken: "Save token",
    saveReviewerUser: "Save reviewer user",
    tokenSaved: "Token saved",
    reviewerUserSaved: "Reviewer user saved",
    defaultsHelp:
      "The default CLI seeds new project agents. Reviewer account credentials are configured in the global Reviewer Account section below.",
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
      "Remove legacy AgentChattr files left over from pre-v2 installs:",
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
    butlerAgent: "Butler Agent",
    butlerEnabled: "Enabled",
    butlerDisabled: "Disabled",
    butlerCli: "CLI",
    butlerModel: "Model",
    butlerAutoStart: "Auto-start on boot",
    butlerCwd: "Working directory",
    butlerHelp: "Butler is a cross-project operator assistant that runs in ~/docs/. It helps manage tickets, proposals, reviews, and releases across all projects.",
    enable: "Enable",
    disable: "Disable",
    unsavedChanges: "Unsaved changes",
    butlerRestartHint: "Butler is running with previous settings. Disable and re-enable to apply changes.",
  },
  ko: {
    loading: "로딩 중...",
    loadError: "설정을 불러오지 못했습니다.",
    retry: "다시 시도",
    title: "설정",
    save: "저장",
    saving: "저장 중...",
    saved: "저장됨",
    operatorIdentity: "운영자 정보",
    yourNameInChat: "채팅에서의 이름",
    language: "언어",
    operatorHelp:
      "프로젝트 채팅 패널에서 내 메시지 옆에 표시됩니다. 비워두면 기본값은 user입니다. 허용: 1-32자의 영문, 숫자, 하이픈, 언더스코어. 다른 문자는 서버에서 제거됩니다. head, dev, re1, re2, system 같은 예약 이름은 거부되고 user로 대체됩니다.",
    global: "전역",
    dashboardPort: "QuadWork 대시보드 포트",
    globalHelp:
      "대시보드는 QuadWork 포트에 바인딩됩니다.",
    defaults: "기본값",
    defaultAgentCli: "기본 에이전트 CLI",
    reviewerGithubUser: "리뷰어 GitHub 사용자",
    reviewerGithubToken: "리뷰어 GitHub 토큰",
    reviewerAccount: "리뷰어 계정",
    reviewerAccountHelp:
      "모든 프로젝트의 RE1/RE2가 사용하는 전역 리뷰어 인증 정보입니다. 토큰 값은 ~/.quadwork/reviewer-token (권한 0600)에 저장되며 API로 반환되지 않고 저장 후 화면에 표시되지 않습니다.",
    reviewerTokenStatus: "토큰 상태",
    tokenPath: "토큰 경로",
    configured: "설정됨",
    notConfigured: "미설정",
    pasteNewToken: "새 토큰 붙여넣기",
    saveToken: "토큰 저장",
    saveReviewerUser: "리뷰어 사용자 저장",
    tokenSaved: "토큰 저장됨",
    reviewerUserSaved: "리뷰어 사용자 저장됨",
    defaultsHelp:
      "기본 CLI는 새 프로젝트 에이전트의 초기값으로 사용됩니다. 리뷰어 계정 인증 정보는 아래 전역 리뷰어 계정 섹션에서 설정합니다.",
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
      "v2 이전 설치에서 남은 레거시 AgentChattr 파일을 제거합니다:",
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
    butlerAgent: "버틀러 에이전트",
    butlerEnabled: "활성",
    butlerDisabled: "비활성",
    butlerCli: "CLI",
    butlerModel: "모델",
    butlerAutoStart: "서버 시작 시 자동 실행",
    butlerCwd: "작업 디렉터리",
    butlerHelp: "버틀러는 ~/docs/에서 실행되는 크로스 프로젝트 운영자 어시스턴트입니다. 모든 프로젝트의 티켓, 제안서, 리뷰, 릴리스 관리를 지원합니다.",
    enable: "활성화",
    disable: "비활성화",
    unsavedChanges: "저장되지 않은 변경사항",
    butlerRestartHint: "버틀러가 이전 설정으로 실행 중입니다. 변경사항을 적용하려면 비활성화 후 다시 활성화하세요.",
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
  // #973: distinguish "still loading" from "load failed" so a failed
  // initial /api/config read shows an error + Retry instead of the
  // "Loading..." placeholder spinning forever (the .catch swallowed it).
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedConfigRef = useRef<string>("");
  const [butlerStartConfig, setButlerStartConfig] = useState<{ command: string; model: string } | null>(null);
  // #814: pending "Set Inactive?" confirmation (null = no modal).
  const [idleConfirm, setIdleConfirm] = useState<{ id: string; name: string } | null>(null);
  // #826: project ids with an idle PUT in flight — disable the switch for them
  // so a queued double-toggle can't race the persist.
  const [idlePending, setIdlePending] = useState<Set<string>>(new Set());

  // Keep the saved snapshot's idle in lockstep with an idle toggle. Idle is
  // persisted immediately (out of band from the batched Save), so without this
  // it would falsely register as an unsaved change (isDirty) and a later Save
  // could clobber an idle change made in the sidebar.
  const syncSavedIdle = useCallback((projectId: string, idle: boolean) => {
    try {
      const saved = JSON.parse(savedConfigRef.current);
      const sp = (saved.projects || []).find((p: { id: string }) => p.id === projectId);
      if (sp) { sp.idle = idle; savedConfigRef.current = JSON.stringify(saved); }
    } catch { /* no saved snapshot yet */ }
  }, []);

  // #973: advance the saved snapshot's name after a debounced rename
  // persists, instead of reloading the whole config. A full load() would
  // overwrite any unsaved edits the operator made in other fields while
  // the 800ms debounce was pending; the optimistic update already put the
  // new name in local state, so this just keeps dirty-tracking honest.
  const syncSavedProjectName = useCallback((projectId: string, name: string) => {
    try {
      const saved = JSON.parse(savedConfigRef.current);
      const sp = (saved.projects || []).find((p: { id: string }) => p.id === projectId);
      if (sp) { sp.name = name; savedConfigRef.current = JSON.stringify(saved); }
    } catch { /* no saved snapshot yet */ }
  }, []);

  const syncSavedAgentName = useCallback((projectId: string, agentId: string, displayName: string) => {
    try {
      const saved = JSON.parse(savedConfigRef.current);
      const sp = (saved.projects || []).find((p: { id: string }) => p.id === projectId);
      if (sp?.agents?.[agentId]) { sp.agents[agentId].display_name = displayName; savedConfigRef.current = JSON.stringify(saved); }
    } catch { /* no saved snapshot yet */ }
  }, []);

  const setProjectIdleLocal = useCallback((projectId: string, idle: boolean) => {
    setConfig((prev) => (prev ? { ...prev, projects: prev.projects.map((p) => (p.id === projectId ? { ...p, idle } : p)) } : prev));
    syncSavedIdle(projectId, idle);
  }, [syncSavedIdle]);

  // Optimistic local flip + immediate persist + revert on failure.
  const applyIdle = useCallback((projectId: string, nextIdle: boolean) => {
    setProjectIdleLocal(projectId, nextIdle);
    setIdlePending((prev) => new Set(prev).add(projectId));
    persistProjectIdle(projectId, nextIdle)
      .catch(() => setProjectIdleLocal(projectId, !nextIdle))
      .finally(() => setIdlePending((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      }));
  }, [setProjectIdleLocal]);

  const handleToggleActive = useCallback((project: ProjectConfig) => {
    if (!project.idle) setIdleConfirm({ id: project.id, name: project.name });
    else applyIdle(project.id, false);
  }, [applyIdle]);

  // Re-sync when idle is changed elsewhere (sidebar, dashboard).
  useEffect(() => onIdleChange(({ projectId, idle }) => setProjectIdleLocal(projectId, idle)), [setProjectIdleLocal]);
  // #212: drop the per-project accordion. AGENTS.md edit toggles
  // still need a per-key flag, so we keep `expanded` but no longer
  // gate the project body on it — every project is open by default.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [autoAdded, setAutoAdded] = useState(false);
  // #1023: was {claude, codex} — gemini was already missing and grok would have
  // been too, so every `cliStatus[b.value]` lookup below leaned on a cast.
  const [cliStatus, setCliStatus] = useState<{ claude: boolean; codex: boolean; gemini: boolean; grok: boolean } | null>(null);
  // #419 / quadwork#308: draft-string mirror for the dashboard port
  // field so the operator can clear it and retype without
  // `parseInt("") || 8400` clobbering the buffer mid-keystroke.
  // Kept in sync with config.port on load + blur commit.
  const [portDraft, setPortDraft] = useState<string>("8400");

  const load = useCallback(() => {
    setLoadError(false);
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => {
        setPortDraft(String(data.port || 8400));
        const cfg = {
          port: data.port || 8400,
          default_backend: data.default_backend || "claude",
          reviewer_github_user: data.reviewer_github_user || "",
          operator_name: data.operator_name || "user",
          projects: data.projects || [],
          butler: data.butler || {},
        };
        savedConfigRef.current = JSON.stringify(cfg);
        return setConfig(cfg);
      })
      // #973: surface the failure instead of swallowing it — otherwise a
      // failed initial read leaves config null and the "Loading..."
      // placeholder spins forever. load() only runs on mount + Retry, so
      // config is always null here on failure.
      .catch(() => setLoadError(true));
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
  const [reviewerTokenPath, setReviewerTokenPath] = useState("");
  const [reviewerTokenInput, setReviewerTokenInput] = useState("");
  const [reviewerTokenSaving, setReviewerTokenSaving] = useState(false);
  const [reviewerTokenMessage, setReviewerTokenMessage] = useState("");
  const [reviewerUserDraft, setReviewerUserDraft] = useState("");
  const [reviewerUserSaving, setReviewerUserSaving] = useState(false);
  const [reviewerUserMessage, setReviewerUserMessage] = useState("");
  const [keepAwakeActive, setKeepAwakeActive] = useState(false);
  const [keepAwakeBusy, setKeepAwakeBusy] = useState(false);
  const [butlerRunning, setButlerRunning] = useState(false);
  const [butlerBusy, setButlerBusy] = useState(false);

  const refreshReviewerTokenStatus = useCallback(() => {
    fetch("/api/setup/reviewer-token-status")
      .then((r) => (r.ok ? r.json() : { exists: false, path: "" }))
      .then((d) => {
        setReviewerTokenExists(!!d.exists);
        setReviewerTokenPath(typeof d.path === "string" ? d.path : "");
      })
      .catch(() => {
        setReviewerTokenExists(false);
        setReviewerTokenPath("");
      });
  }, []);

  const refreshKeepAwake = useCallback(() => {
    fetch("/api/caffeinate/status")
      .then((r) => (r.ok ? r.json() : { active: false }))
      .then((d) => setKeepAwakeActive(!!d.active))
      .catch(() => {});
  }, []);

  const refreshButlerStatus = useCallback(() => {
    fetch("/api/butler/status")
      .then((r) => (r.ok ? r.json() : { running: false }))
      .then((d) => {
        setButlerRunning(!!d.running);
        if (d.running && d.command) {
          setButlerStartConfig({ command: d.command, model: d.model || "" });
        }
        if (!d.running) setButlerStartConfig(null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshReviewerTokenStatus();
    refreshKeepAwake();
    refreshButlerStatus();
  }, [refreshReviewerTokenStatus, refreshKeepAwake, refreshButlerStatus]);

  useEffect(() => {
    if (config) setReviewerUserDraft(config.reviewer_github_user || "");
  }, [config?.reviewer_github_user]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveReviewerToken = async () => {
    if (!reviewerTokenInput.trim()) return;
    setReviewerTokenSaving(true);
    setReviewerTokenMessage("");
    try {
      const r = await fetch("/api/setup/save-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: reviewerTokenInput.trim() }),
      });
      if (r.ok) {
        setReviewerTokenInput("");
        refreshReviewerTokenStatus();
        setReviewerTokenMessage(t.tokenSaved);
      } else {
        const data = await r.json().catch(() => ({}));
        setReviewerTokenMessage(data.error || "Failed to save token");
      }
    } catch {
      setReviewerTokenMessage("Failed to save token");
    } finally {
      setReviewerTokenSaving(false);
    }
  };

  const saveReviewerUser = async () => {
    if (!config) return;
    setReviewerUserSaving(true);
    setReviewerUserMessage("");
    try {
      const r = await fetch("/api/reviewer-github-user", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewer_github_user: reviewerUserDraft.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setReviewerUserMessage(data.error || "Failed to save reviewer user");
        return;
      }
      const next = { ...config, reviewer_github_user: data.reviewer_github_user || "" };
      setConfig(next);
      try {
        const saved = JSON.parse(savedConfigRef.current || "{}");
        saved.reviewer_github_user = data.reviewer_github_user || "";
        savedConfigRef.current = JSON.stringify(saved);
      } catch {
        savedConfigRef.current = JSON.stringify(next);
      }
      setReviewerUserDraft(data.reviewer_github_user || "");
      setReviewerUserMessage(t.reviewerUserSaved);
    } catch {
      setReviewerUserMessage("Failed to save reviewer user");
    } finally {
      setReviewerUserSaving(false);
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

  const updateButler = (updates: Partial<ButlerConfig>) => {
    if (!config) return;
    setConfig({ ...config, butler: { ...config.butler, ...updates } });
  };

  const toggleButler = async () => {
    setButlerBusy(true);
    try {
      const stopping = butlerRunning;
      const url = stopping ? "/api/butler/stop" : "/api/butler/start";
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (r.ok) {
        const data = await r.json();
        if (stopping || data.ok) {
          if (stopping) {
            setButlerStartConfig(null);
          }
          refreshButlerStatus();
          updateButler({ enabled: !stopping });
        }
      }
    } finally {
      setButlerBusy(false);
    }
  };

  // Auto-add project when navigated with ?add=true
  useEffect(() => {
    if (config && searchParams.get("add") === "true" && !autoAdded) {
      setAutoAdded(true);
      addProject();
    }
  }, [config, searchParams, autoAdded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!config) return;
    const hash = window.location.hash.replace("#", "");
    if (hash) {
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: "smooth" });
    }
  }, [config]);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      // #212: Telegram credentials are now configured per-project from
      // the bottom-right Telegram Bridge widget (#211), which writes
      // its own env-references via /api/telegram?action=save-config.
      // The Settings save path no longer needs to migrate bot tokens.
      // #931: normalize every per-agent model to one valid for its command
      // before persisting. This is the catch-all the AC requires ("Saving
      // persists a model valid for that agent's CLI") — it heals a model left
      // invalid by the old hardcoded dropdown (e.g. a codex agent saved with
      // "sonnet") and also covers a new project seeded from DEFAULT_AGENTS with
      // a non-Claude default command. sanitizeModel keeps "" (CLI default) as-is.
      // #935: the butler model needs the same guard. Its dropdown is
      // provider-aware and resets on Command-change, but a butler left invalid
      // (hand-edited config, never command-changed) would otherwise re-persist.
      // #937: reconcile mcp_inject the same way. Every agent carries one (the
      // wizard writes it and the spawn path reads it), so always re-derive it
      // from the command — this heals a stale "flag" left on an agent converted
      // to gemini before this fix, which would otherwise crash the CLI. The
      // butler is different: its spawn doesn't consume mcp_inject and the wizard
      // never writes one, so we only heal a value that's already present rather
      // than fabricate one.
      const normalizedConfig = {
        ...config,
        projects: config.projects.map((p) => {
          const agents: Record<string, AgentConfig> = {};
          for (const [id, a] of Object.entries(p.agents)) {
            agents[id] = {
              ...a,
              model: sanitizeModel(a.command || "claude", a.model),
              mcp_inject: injectModeForCommand(a.command || "claude"),
            };
          }
          return { ...p, agents };
        }),
        butler: config.butler
          ? {
              ...config.butler,
              model: sanitizeModel(config.butler.command || "claude", config.butler.model),
              ...(config.butler.mcp_inject !== undefined
                ? { mcp_inject: injectModeForCommand(config.butler.command || "claude") }
                : {}),
            }
          : config.butler,
      };
      // #971: save via the section-merge PATCH (no whole-config PUT). Send only
      // the sections Settings owns — strip the field-scoped-owned keys so the
      // payload can never carry a stale flag/pin the server owns via its own
      // endpoints. The server merges into the freshest config under updateConfig.
      const FLAG_KEYS = [
        "idle", "awake_auto", "trigger_auto", "telegram_auto", "discord_auto",
        "bridge_filter_agents_only", "auto_continue_loop_guard", "auto_continue_delay_sec",
      ];
      const patchBody: Record<string, unknown> = { ...normalizedConfig };
      for (const k of ["pinned_projects", "sidebar_groups", "reviewer_github_user", "session_token"]) {
        delete patchBody[k];
      }
      patchBody.projects = normalizedConfig.projects.map((p) => {
        const clean: Record<string, unknown> = { ...p };
        for (const k of FLAG_KEYS) delete clean[k];
        return clean;
      });
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setConfig(normalizedConfig);
      savedConfigRef.current = JSON.stringify(normalizedConfig);
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
    const configuredAvailable = !cliStatus || (cliStatus[configured as keyof typeof cliStatus] !== false);
    // #1023: fall back to the first INSTALLED backend rather than a hardcoded
    // claude/codex chain, which could only ever answer "claude" or "codex" — so
    // a grok-only machine seeded the uninstalled claude, and so did a
    // gemini-only one (the same pre-existing bug, fixed deliberately; see the
    // ticket's operator ruling). Pinned by server/defaultBackend.test.js.
    const defaultCmd = configuredAvailable
      ? configured
      : firstInstalledBackend(cliStatus, BACKENDS.map((b) => b.value));
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
          // #973: merge just the renamed field into the saved snapshot
          // rather than load()-ing the whole config, which would clobber
          // other fields the operator edited during the debounce window.
          .then(() => syncSavedProjectName(project.id, newName))
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
          // #973: merge just the renamed field (see renameProject).
          .then(() => syncSavedAgentName(project.id, agentId, newName))
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

  // #971: removal persists immediately via the field-scoped DELETE endpoint
  // (the section-merge save never drops projects). Local state + the saved
  // snapshot both drop it, so any OTHER pending edits stay correctly marked dirty.
  const removeProject = async (idx: number) => {
    if (!config) return;
    const target = config.projects[idx];
    setConfirmDelete(null);
    if (!target) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
    } catch (err) {
      console.error(err);
      return; // leave the UI unchanged on failure
    }
    setConfig({ ...config, projects: config.projects.filter((_, i) => i !== idx) });
    if (savedConfigRef.current) {
      try {
        const saved = JSON.parse(savedConfigRef.current);
        if (Array.isArray(saved.projects)) {
          saved.projects = saved.projects.filter((p: { id: string }) => p.id !== target.id);
          savedConfigRef.current = JSON.stringify(saved);
        }
      } catch { /* dirty-tracking best-effort */ }
    }
  };

  // #973: failed initial load → error + Retry instead of an endless spinner.
  if (!config && loadError) {
    return (
      <div className="p-6 flex flex-col items-start gap-3">
        <div className="border border-error/30 bg-error/5 text-error text-[11px] px-3 py-2">
          {t.loadError}
        </div>
        <button
          onClick={load}
          className="px-3 py-1.5 text-[12px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
        >
          {t.retry}
        </button>
      </div>
    );
  }
  if (!config) return <div className="p-6 text-text-muted text-xs">{t.loading}</div>;

  const isDirty = savedConfigRef.current !== "" && JSON.stringify(config) !== savedConfigRef.current;
  const butlerConfigChanged = butlerRunning && butlerStartConfig != null && (
    (config.butler?.command || "claude") !== butlerStartConfig.command ||
    (config.butler?.model || "") !== butlerStartConfig.model
  );

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
          dashboard chat messages. Server-side validated to chat
          name rules (1–32 alnum + dash + underscore). */}
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
        </div>
        <p className="mt-2 text-[10px] text-text-muted leading-snug">
          {t.globalHelp}
        </p>
      </section>

      {/* Defaults — default agent CLI (#212) */}
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
        </div>
        <p className="mt-2 text-[10px] text-text-muted leading-snug">
          {t.defaultsHelp}
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.reviewerAccount}</h2>
        <div className="border border-border p-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)] gap-4">
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-[11px] text-text-muted uppercase tracking-wider mb-1">{t.reviewerTokenStatus}</div>
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${reviewerTokenExists ? "bg-accent" : "bg-text-muted"}`} />
                <span className="text-[12px] text-text">
                  {reviewerTokenExists === null ? "…" : reviewerTokenExists ? `${t.configured} ✓` : t.notConfigured}
                </span>
              </div>
              {reviewerTokenPath && (
                <div className="mt-1 text-[10px] text-text-muted font-mono break-all">
                  {t.tokenPath}: {reviewerTokenPath}
                </div>
              )}
            </div>
            <div>
              <label className="text-[11px] text-text-muted uppercase tracking-wider">{t.reviewerGithubToken}</label>
              <div className="flex flex-col sm:flex-row gap-2 mt-1">
                <input
                  type="password"
                  value={reviewerTokenInput}
                  onChange={(e) => {
                    setReviewerTokenInput(e.target.value);
                    setReviewerTokenMessage("");
                  }}
                  placeholder={t.pasteNewToken}
                  className="flex-1 min-w-0 bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent font-mono"
                  autoComplete="new-password"
                />
                <button
                  onClick={saveReviewerToken}
                  disabled={reviewerTokenSaving || !reviewerTokenInput.trim()}
                  className="px-3 py-1.5 text-[12px] font-semibold text-bg bg-accent hover:bg-accent-dim disabled:opacity-50 transition-colors"
                >
                  {reviewerTokenSaving ? t.saving : t.saveToken}
                </button>
              </div>
              {reviewerTokenMessage && (
                <p className="mt-1 text-[10px] text-text-muted">{reviewerTokenMessage}</p>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-[11px] text-text-muted uppercase tracking-wider">{t.reviewerGithubUser}</label>
              <div className="flex flex-col sm:flex-row gap-2 mt-1">
                <input
                  value={reviewerUserDraft}
                  onChange={(e) => {
                    setReviewerUserDraft(e.target.value);
                    setReviewerUserMessage("");
                  }}
                  placeholder="reviewer-bot"
                  className="flex-1 min-w-0 bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
                />
                <button
                  onClick={saveReviewerUser}
                  disabled={reviewerUserSaving || reviewerUserDraft.trim() === (config.reviewer_github_user || "")}
                  className="px-3 py-1.5 text-[12px] border border-border text-text-muted hover:text-text hover:border-accent disabled:opacity-50 transition-colors"
                >
                  {reviewerUserSaving ? t.saving : t.save}
                </button>
              </div>
              {reviewerUserMessage && (
                <p className="mt-1 text-[10px] text-text-muted">{reviewerUserMessage}</p>
              )}
            </div>
            <p className="text-[10px] text-text-muted leading-snug">
              {t.reviewerAccountHelp}
            </p>
          </div>
        </div>
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

      {/* Butler Agent (#632) */}
      <section id="butler" className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.butlerAgent}</h2>
        <div className="border border-border p-3 space-y-3">
          <div className="flex items-center gap-3">
            <span className={`w-1.5 h-1.5 rounded-full ${butlerRunning ? "bg-accent" : "bg-text-muted"}`} />
            <span className="text-[11px] text-text">{butlerRunning ? t.butlerEnabled : t.butlerDisabled}</span>
            <button
              onClick={toggleButler}
              disabled={butlerBusy}
              className="px-2 py-1 text-[11px] border border-border text-text-muted hover:text-text hover:border-accent disabled:opacity-50 transition-colors"
            >
              {butlerBusy ? "…" : butlerRunning ? t.disable : t.enable}
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Select
              label={t.butlerCli}
              value={config.butler?.command || "claude"}
              onChange={(v) => {
                const models = modelsForBackend(v);
                const currentModel = config.butler?.model || "opus";
                const modelValid = models.some((m) => m.value === currentModel);
                // #937: only re-derive mcp_inject if this config actually carries
                // one — the butler spawn doesn't consume it and the wizard never
                // writes one, so we heal a stale value without fabricating a field.
                updateButler({
                  command: v,
                  model: modelValid ? currentModel : models[0].value,
                  ...(config.butler?.mcp_inject !== undefined ? { mcp_inject: injectModeForCommand(v) } : {}),
                });
              }}
              options={BACKENDS.map((b) => ({
                value: b.value,
                label: b.label + (cliStatus && !cliStatus[b.value as keyof typeof cliStatus] ? " (not installed)" : ""),
              }))}
            />
            <Select
              label={t.butlerModel}
              value={config.butler?.model || "opus"}
              onChange={(v) => updateButler({ model: v })}
              options={modelsForBackend(config.butler?.command || "claude")}
            />
            <Input
              label={t.butlerCwd}
              value={config.butler?.cwd || "~/docs/"}
              onChange={(v) => updateButler({ cwd: v })}
              placeholder="~/docs/"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.butler?.auto_start ?? false}
              onChange={(e) => updateButler({ auto_start: e.target.checked })}
              className="accent-accent"
            />
            <span className="text-[11px] text-text">{t.butlerAutoStart}</span>
          </label>
          <p className="text-[10px] text-text-muted leading-snug">{t.butlerHelp}</p>
          {butlerConfigChanged && (
            <p className="text-[10px] text-yellow-500 leading-snug mt-1">⚠ {t.butlerRestartHint}</p>
          )}
        </div>
      </section>

      {/* Cleanup commands (#212 / #189) */}
      <section className="mb-8">
        <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.cleanup}</h2>
        <div className="border border-border p-3 text-[11px] text-text-muted space-y-1">
          <p>{t.cleanupIntro}</p>
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
                {/* #814: per-project Active/Inactive status + switch (same source
                    of truth + confirmation as the sidebar). */}
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] uppercase tracking-wider ${project.idle ? "text-text-muted" : "text-accent"}`}>
                    {project.idle ? "Inactive" : "Active"}
                  </span>
                  <ActiveSwitch active={!project.idle} onToggle={() => handleToggleActive(project)} disabled={idlePending.has(project.id)} />
                </div>
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
                              onChange={(e) => {
                                // #931: changing the command must reset the model to one
                                // valid for the new backend (mirror the butler dropdown
                                // above) — otherwise a Claude model leaks onto a
                                // codex/gemini agent and is saved/spawned as invalid.
                                // #937: likewise reset mcp_inject to the new backend's
                                // mode — otherwise converting to gemini leaves a stale
                                // "flag" and the CLI crashes on launch (--mcp-config).
                                const command = e.target.value;
                                updateAgent(idx, agentId, {
                                  command,
                                  model: effectiveModel(command, agent.model),
                                  mcp_inject: injectModeForCommand(command),
                                });
                              }}
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
                              // #931: provider-aware model options that track the agent's
                              // command (codex/gemini/claude). effectiveModel shows the
                              // saved model when valid, else the backend's first option —
                              // so an unset model or a stale cross-backend value (e.g. a
                              // codex agent left on "sonnet" by the old hardcoded list)
                              // never renders blank or as the wrong model.
                              value={effectiveModel(agent.command || "claude", agent.model)}
                              onChange={(e) => updateAgent(idx, agentId, { model: e.target.value })}
                              className="bg-transparent text-[11px] text-text outline-none border border-border px-1 py-0.5 focus:border-accent"
                            >
                              {modelsForBackend(agent.command || "claude").map((m) => (
                                <option key={m.value} value={m.value} className="bg-bg-surface">{m.label}</option>
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

      {/* Sticky save bar */}
      {isDirty && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-bg-surface px-6 py-3 flex items-center justify-between z-50">
          <span className="text-[12px] text-text-muted">{t.unsavedChanges}</span>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
          >
            {saving ? t.saving : t.save}
          </button>
        </div>
      )}

      {idleConfirm && (
        <ConfirmModal
          title={idleConfirmTitle(idleConfirm.name)}
          body={IDLE_CONFIRM_BODY}
          confirmLabel="Set Inactive"
          onConfirm={() => { applyIdle(idleConfirm.id, true); setIdleConfirm(null); }}
          onCancel={() => setIdleConfirm(null)}
        />
      )}
    </div>
  );
}
