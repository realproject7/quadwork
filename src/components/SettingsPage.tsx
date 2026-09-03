"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/components/LocaleProvider";
import { modelsForBackend, effectiveModel, sanitizeModel } from "@/lib/agentModels";
import { injectModeForCommand } from "@/lib/injectMode";
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
  agents: Record<string, AgentConfig>;
  repositories?: V2Repository[];
  environment_bindings?: EnvironmentBinding[];
  coordination_repo_key?: string;
  watch_batch_requests?: boolean;
  archived?: boolean;
  idle?: boolean;
}

type EnvironmentClass = "local" | "vps" | "other";

interface EnvironmentBinding {
  installation_id: string;
  project_id: string;
  label: string;
  environment_class: EnvironmentClass;
}

interface EnvironmentDraft {
  environment_bindings: EnvironmentBinding[];
  coordination_repo_key: string;
  watch_batch_requests: boolean;
}

type CiPolicyMode = "" | "github-checks" | "ci-less";

interface CiPolicyDraft {
  mode: CiPolicyMode;
  requiredChecks: string;
  advisoryChecks: string;
  checkKind: "product" | "control-plane";
  registrationGraceSeconds: string;
  sameShaRetryBudget: string;
  evidenceKeys: string;
}

interface V2Repository {
  key: string;
  repo: string;
  working_dir: string;
  primary: boolean;
  ci_policy?: Record<string, unknown>;
}

interface V2RepositoryDraft extends V2Repository {
  policy: CiPolicyDraft;
}

interface V2SetupResult {
  ok?: boolean;
  code?: string;
  reasons?: Array<{ code?: string; repo_key?: string }>;
  repositories?: Array<{
    key?: string;
    repo?: string;
    primary?: boolean;
    default_branch?: string;
    base_clone?: string;
    worktrees?: Record<string, string>;
  }>;
}

interface V2Flow {
  phase: "idle" | "verifying" | "verified" | "provisioning" | "provisioned" | "activating" | "activated" | "error";
  message?: string;
  result?: V2SetupResult;
}

const V2_ROLES = ["head", "re1", "re2", "dev"] as const;

function listFromInput(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function blankPolicy(): CiPolicyDraft {
  return {
    mode: "",
    requiredChecks: "",
    advisoryChecks: "",
    checkKind: "product",
    registrationGraceSeconds: "300",
    sameShaRetryBudget: "0",
    evidenceKeys: "",
  };
}

function blankRepository(key = "primary", primary = true): V2RepositoryDraft {
  return { key, repo: "", working_dir: "", primary, policy: blankPolicy() };
}

function policyDraftFromRepository(repository: V2Repository): CiPolicyDraft {
  const policy = repository.ci_policy;
  if (policy?.mode === "ci-less" && Array.isArray(policy.evidence_keys)) {
    return { ...blankPolicy(), mode: "ci-less", evidenceKeys: policy.evidence_keys.filter((key): key is string => typeof key === "string").join(", ") };
  }
  if (policy?.mode === "github-checks" && Array.isArray(policy.checks)) {
    const checks = policy.checks.filter((check): check is { name: string; required: boolean; kind: "product" | "control-plane" } =>
      !!check && typeof check === "object" && typeof check.name === "string" && typeof check.required === "boolean" &&
      (check.kind === "product" || check.kind === "control-plane"),
    );
    return {
      ...blankPolicy(),
      mode: "github-checks",
      requiredChecks: checks.filter((check) => check.required).map((check) => check.name).join(", "),
      advisoryChecks: checks.filter((check) => !check.required).map((check) => check.name).join(", "),
      checkKind: checks[0]?.kind || "product",
      registrationGraceSeconds: String(policy.registration_grace_seconds ?? 300),
      sameShaRetryBudget: String(policy.same_sha_retry_budget ?? 0),
    };
  }
  return blankPolicy();
}

function repositoryDraftFromConfig(repositories: V2Repository[] | undefined): V2RepositoryDraft[] {
  if (!Array.isArray(repositories) || repositories.length === 0) return [blankRepository()];
  return repositories.map((repository) => ({ ...repository, policy: policyDraftFromRepository(repository) }));
}

function environmentDraftFromConfig(project: ProjectConfig): EnvironmentDraft {
  const environment_bindings = Array.isArray(project.environment_bindings)
    ? project.environment_bindings
      .filter((binding): binding is EnvironmentBinding => !!binding && typeof binding === "object" &&
        typeof binding.installation_id === "string" && typeof binding.project_id === "string" &&
        typeof binding.label === "string" && (binding.environment_class === "local" || binding.environment_class === "vps" || binding.environment_class === "other"))
      .map((binding) => ({ ...binding }))
    : [];
  return {
    environment_bindings,
    coordination_repo_key: typeof project.coordination_repo_key === "string" ? project.coordination_repo_key : "",
    watch_batch_requests: project.watch_batch_requests === true,
  };
}

function blankEnvironmentBinding(): EnvironmentBinding {
  return { installation_id: "", project_id: "", label: "", environment_class: "other" };
}

function environmentFieldId(projectId: string, field?: string): string {
  const bindingField = /^environment_bindings\[(\d+)\]\.(installation_id|project_id|label|environment_class)$/.exec(field || "");
  if (bindingField) return `environment-${projectId}-${bindingField[2]}-${bindingField[1]}`;
  if (field === "coordination_repo_key") return `environment-${projectId}-coordination-repo`;
  if (field === "watch_batch_requests") return `environment-${projectId}-watch-batch-requests`;
  return `environment-${projectId}-save`;
}

function policyFromDraft(draft: CiPolicyDraft): Record<string, unknown> | undefined {
  if (draft.mode === "ci-less") {
    const evidenceKeys = listFromInput(draft.evidenceKeys);
    return evidenceKeys.length > 0 ? { version: 1, mode: "ci-less", evidence_keys: evidenceKeys } : undefined;
  }
  if (draft.mode === "github-checks") {
    const required = listFromInput(draft.requiredChecks);
    const advisory = listFromInput(draft.advisoryChecks);
    const grace = Number(draft.registrationGraceSeconds);
    const retryBudget = Number(draft.sameShaRetryBudget);
    return required.length > 0 && Number.isSafeInteger(grace) && grace >= 0 && Number.isSafeInteger(retryBudget) && retryBudget >= 0
      ? {
        version: 1,
        mode: "github-checks",
        registration_grace_seconds: grace,
        same_sha_retry_budget: retryBudget,
        checks: [
          ...required.map((name) => ({ name, required: true, kind: draft.checkKind })),
          ...advisory.map((name) => ({ name, required: false, kind: draft.checkKind })),
        ],
      }
      : undefined;
  }
  return undefined;
}

function requestRepositories(drafts: V2RepositoryDraft[]): V2Repository[] {
  return drafts.map((draft) => {
    // Rebuild the exact policy payload from visible draft fields. Retaining a
    // prior persisted ci_policy here would let a cleared/edited form submit a
    // stale topology field through the explicit transaction.
    const repository = {
      key: draft.key,
      repo: draft.repo,
      working_dir: draft.working_dir,
      primary: draft.primary,
    };
    const ciPolicy = policyFromDraft(draft.policy);
    return ciPolicy ? { ...repository, ci_policy: ciPolicy } : repository;
  });
}

function v2Message(result: V2SetupResult): string {
  const code = result.reasons?.[0]?.code || result.code || "setup_request_failed";
  const labels: Record<string, string> = {
    legacy_scalar: "Replace the legacy repository record through this V2 setup flow.",
    repositories_required: "Add at least one repository.",
    missing_policy: "Choose and complete a CI evidence policy for every repository.",
    invalid_ci_policy: "Complete the selected CI evidence policy with valid values.",
    invalid_primary_repository_count: "Select exactly one primary repository.",
    repository_push_access_required: "GitHub write, maintain, or admin access is required.",
    repository_identity_mismatch: "GitHub returned a different canonical repository identity.",
    active_session: "Stop the active role session before changing repository topology.",
    project_not_quiesced: "Quiesce this project before changing repository topology.",
    first_activation_legacy_project_blocked: "Quiesce the identified legacy project, then retry the first V2 activation.",
    operator_confirmation_required: "Confirm final V2 activation before continuing.",
  };
  return labels[code] || `V2 setup needs attention [${code}].`;
}

interface Config {
  port: number;
  default_backend?: string;
  reviewer_github_user?: string;
  // #405 / quadwork#278: display name used as the chat sender for
  // dashboard-originated messages. Defaults to "user" server-side.
  operator_name?: string;
  projects: ProjectConfig[];
}

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
    lifecycleFailed: "Project lifecycle operation failed",
    retryCleanup: "Retry cleanup",
    newProject: "New Project",
    unsavedChanges: "Unsaved changes",
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
    lifecycleFailed: "프로젝트 상태 변경에 실패했습니다",
    retryCleanup: "정리 다시 시도",
    newProject: "새 프로젝트",
    unsavedChanges: "저장되지 않은 변경사항",
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [config, setConfig] = useState<Config | null>(null);
  // #973: distinguish "still loading" from "load failed" so a failed
  // initial /api/config read shows an error + Retry instead of the
  // "Loading..." placeholder spinning forever (the .catch swallowed it).
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedConfigRef = useRef<string>("");
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
  const [projectLifecyclePending, setProjectLifecyclePending] = useState<Record<string, "archive" | "restore" | "remove">>({});
  const [projectLifecycleErrors, setProjectLifecycleErrors] = useState<Record<string, string>>({});
  const [v2Drafts, setV2Drafts] = useState<Record<string, V2RepositoryDraft[]>>({});
  const [v2Flows, setV2Flows] = useState<Record<string, V2Flow>>({});
  const [v2ActivationConfirmations, setV2ActivationConfirmations] = useState<Record<string, boolean>>({});
  const [environmentDrafts, setEnvironmentDrafts] = useState<Record<string, EnvironmentDraft>>({});
  const [environmentSaving, setEnvironmentSaving] = useState<Record<string, boolean>>({});
  const [environmentMessages, setEnvironmentMessages] = useState<Record<string, { text: string; error: boolean }>>({});
  const [environmentRemovalConfirm, setEnvironmentRemovalConfirm] = useState<{ projectId: string; index: number } | null>(null);
  // #1023: was {claude, codex} — gemini was already missing and grok would have
  // been too, so every `cliStatus[b.value]` lookup below leaned on a cast.
  const [cliStatus, setCliStatus] = useState<{ claude: boolean; codex: boolean; gemini: boolean; grok: boolean } | null>(null);
  // #419 / quadwork#308: draft-string mirror for the dashboard port
  // field so the operator can clear it and retype without
  // `parseInt("") || 8400` clobbering the buffer mid-keystroke.
  // Kept in sync with config.port on load + blur commit.
  const [portDraft, setPortDraft] = useState<string>("8400");

  // Environment bindings are intentionally saved through their narrow endpoint
  // rather than the generic Settings form. Warn before a browser navigation can
  // discard a typed peer record that has not reached that atomic boundary yet.
  useEffect(() => {
    if (!config) return;
    const hasUnsavedEnvironmentDraft = config.projects.some((project) =>
      JSON.stringify(environmentDrafts[project.id] || environmentDraftFromConfig(project)) !==
      JSON.stringify(environmentDraftFromConfig(project)));
    if (!hasUnsavedEnvironmentDraft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [config, environmentDrafts]);

  const load = useCallback((options?: { preserveV2Flow?: boolean }) => {
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
        };
        setV2Drafts(Object.fromEntries(cfg.projects.map((project: ProjectConfig) => [
          project.id,
          repositoryDraftFromConfig(project.repositories),
        ])));
        setEnvironmentDrafts(Object.fromEntries(cfg.projects.map((project: ProjectConfig) => [
          project.id,
          environmentDraftFromConfig(project),
        ])));
        setEnvironmentMessages({});
        setEnvironmentRemovalConfirm(null);
        if (!options?.preserveV2Flow) setV2Flows({});
        setV2ActivationConfirmations({});
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

  useEffect(() => {
    refreshReviewerTokenStatus();
    refreshKeepAwake();
  }, [refreshReviewerTokenStatus, refreshKeepAwake]);

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

  // Project topology is created only through the explicit V2 setup route;
  // preserve old deep links by taking the operator to that route instead of
  // creating a generic PATCH-able scalar project here.
  useEffect(() => {
    if (searchParams.get("add") === "true") {
      router.replace("/setup");
    }
  }, [router, searchParams]);

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
      // the Telegram Bridge widget in the Operator Features panel (#211), which writes
      // its own env-references via /api/telegram?action=save-config.
      // The Settings save path no longer needs to migrate bot tokens.
      // #931: normalize every per-agent model to one valid for its command
      // before persisting. This is the catch-all the AC requires ("Saving
      // persists a model valid for that agent's CLI") — it heals a model left
      // invalid by the old hardcoded dropdown (e.g. a codex agent saved with
      // "sonnet"). sanitizeModel keeps "" (CLI default) as-is.
      // #937: reconcile mcp_inject the same way. Every agent carries one (the
      // wizard writes it and the spawn path reads it), so always re-derive it
      // from the command — this heals a stale "flag" left on an agent converted
      // to gemini before this fix, which would otherwise crash the CLI.
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
      };
      // #971: save via the section-merge PATCH (no whole-config PUT). Send only
      // the sections Settings owns — strip the field-scoped-owned keys so the
      // payload can never carry a stale flag/pin the server owns via its own
      // endpoints. The server merges into the freshest config under updateConfig.
      const patchBody: Record<string, unknown> = { ...normalizedConfig };
      for (const k of ["pinned_projects", "sidebar_groups", "reviewer_github_user", "session_token"]) {
        delete patchBody[k];
      }
      patchBody.projects = normalizedConfig.projects.map((project) => ({
        // Settings owns only project metadata and agent configuration. An
        // allowlist, rather than stripping scalar fields after a spread,
        // guarantees the generic PATCH can never carry repository topology.
        id: project.id,
        name: project.name,
        agents: project.agents,
      }));
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


  const updateV2Repository = (projectId: string, repositoryIndex: number, updates: Partial<V2RepositoryDraft>) => {
    setV2Drafts((previous) => {
      const entries = [...(previous[projectId] || [blankRepository()])];
      entries[repositoryIndex] = { ...entries[repositoryIndex], ...updates };
      return { ...previous, [projectId]: entries };
    });
    setV2Flows((previous) => ({ ...previous, [projectId]: { phase: "idle" } }));
  };

  const updateV2Policy = (projectId: string, repositoryIndex: number, updates: Partial<CiPolicyDraft>) => {
    setV2Drafts((previous) => {
      const entries = [...(previous[projectId] || [blankRepository()])];
      const current = entries[repositoryIndex] || blankRepository();
      entries[repositoryIndex] = { ...current, policy: { ...current.policy, ...updates } };
      return { ...previous, [projectId]: entries };
    });
    setV2Flows((previous) => ({ ...previous, [projectId]: { phase: "idle" } }));
  };

  const addV2Repository = (projectId: string) => {
    setV2Drafts((previous) => {
      const entries = previous[projectId] || [blankRepository()];
      const nextKey = `repo-${entries.length + 1}`;
      return { ...previous, [projectId]: [...entries, blankRepository(nextKey, false)] };
    });
    setV2Flows((previous) => ({ ...previous, [projectId]: { phase: "idle" } }));
  };

  const removeV2Repository = (projectId: string, repositoryIndex: number) => {
    setV2Drafts((previous) => {
      const entries = (previous[projectId] || [blankRepository()]).filter((_, index) => index !== repositoryIndex);
      return { ...previous, [projectId]: entries.length > 0 ? entries : [blankRepository()] };
    });
    setV2Flows((previous) => ({ ...previous, [projectId]: { phase: "idle" } }));
  };

  const setPrimaryV2Repository = (projectId: string, repositoryIndex: number) => {
    setV2Drafts((previous) => ({
      ...previous,
      [projectId]: (previous[projectId] || [blankRepository()]).map((repository, index) => ({ ...repository, primary: index === repositoryIndex })),
    }));
    setV2Flows((previous) => ({ ...previous, [projectId]: { phase: "idle" } }));
  };

  const updateEnvironmentDraft = (projectId: string, update: (current: EnvironmentDraft) => EnvironmentDraft) => {
    setEnvironmentDrafts((previous) => {
      const current = previous[projectId] || { environment_bindings: [], coordination_repo_key: "", watch_batch_requests: false };
      return { ...previous, [projectId]: update(current) };
    });
    setEnvironmentMessages((previous) => {
      const next = { ...previous };
      delete next[projectId];
      return next;
    });
  };

  const updateEnvironmentBinding = (projectId: string, bindingIndex: number, updates: Partial<EnvironmentBinding>) => {
    updateEnvironmentDraft(projectId, (current) => ({
      ...current,
      environment_bindings: current.environment_bindings.map((binding, index) =>
        index === bindingIndex ? { ...binding, ...updates } : binding),
    }));
  };

  const saveEnvironmentSettings = async (project: ProjectConfig) => {
    const projectId = project.id;
    const draft = environmentDrafts[projectId] || environmentDraftFromConfig(project);
    setEnvironmentSaving((previous) => ({ ...previous, [projectId]: true }));
    setEnvironmentMessages((previous) => {
      const next = { ...previous };
      delete next[projectId];
      return next;
    });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/environment-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          environment_bindings: draft.environment_bindings.map((binding) => ({
            installation_id: binding.installation_id,
            project_id: binding.project_id,
            label: binding.label,
            environment_class: binding.environment_class,
          })),
          coordination_repo_key: draft.coordination_repo_key || null,
          watch_batch_requests: draft.watch_batch_requests,
        }),
      });
      const result = await response.json().catch(() => ({})) as {
        ok?: boolean;
        code?: string;
        field?: string;
        error?: string;
        environment_bindings?: EnvironmentBinding[];
        coordination_repo_key?: string | null;
        watch_batch_requests?: boolean;
      };
      if (!response.ok || result.ok !== true) {
        const message = result.error || `Project Environments need attention${result.code ? ` [${result.code}]` : ""}.`;
        setEnvironmentMessages((previous) => ({ ...previous, [projectId]: { text: message, error: true } }));
        window.requestAnimationFrame(() => document.getElementById(environmentFieldId(projectId, result.field))?.focus());
        return;
      }
      const committed: EnvironmentDraft = {
        environment_bindings: Array.isArray(result.environment_bindings) ? result.environment_bindings.map((binding) => ({ ...binding })) : [],
        coordination_repo_key: typeof result.coordination_repo_key === "string" ? result.coordination_repo_key : "",
        watch_batch_requests: result.watch_batch_requests === true,
      };
      setEnvironmentDrafts((previous) => ({ ...previous, [projectId]: committed }));
      setConfig((previous) => previous ? {
        ...previous,
        projects: previous.projects.map((entry) => entry.id === projectId ? {
          ...entry,
          environment_bindings: committed.environment_bindings,
          coordination_repo_key: committed.coordination_repo_key || undefined,
          watch_batch_requests: committed.watch_batch_requests,
        } : entry),
      } : previous);
      try {
        const saved = JSON.parse(savedConfigRef.current || "{}") as Config;
        const savedProject = saved.projects?.find((entry) => entry.id === projectId);
        if (savedProject) {
          savedProject.environment_bindings = committed.environment_bindings;
          savedProject.coordination_repo_key = committed.coordination_repo_key || undefined;
          savedProject.watch_batch_requests = committed.watch_batch_requests;
          savedConfigRef.current = JSON.stringify(saved);
        }
      } catch { /* UI draft remains usable; a later general save remains scoped */ }
      setEnvironmentMessages((previous) => ({ ...previous, [projectId]: { text: "Project Environments saved.", error: false } }));
    } catch {
      setEnvironmentMessages((previous) => ({ ...previous, [projectId]: { text: "Could not save Project Environments. Check the connection and retry.", error: true } }));
    } finally {
      setEnvironmentSaving((previous) => {
        const next = { ...previous };
        delete next[projectId];
        return next;
      });
    }
  };

  const runV2Flow = async (project: ProjectConfig, step: "verify-repositories" | "provision-repositories" | "activate-v2") => {
    const projectId = project.id;
    const drafts = v2Drafts[projectId] || [blankRepository()];
    const phase = step === "verify-repositories" ? "verifying" : step === "provision-repositories" ? "provisioning" : "activating";
    setV2Flows((previous) => ({ ...previous, [projectId]: { phase } }));
    try {
      const response = await fetch(`/api/setup?step=${step}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: project.id,
          name: project.name,
          repositories: requestRepositories(drafts),
          ...(step === "activate-v2" ? { confirm: true } : {}),
        }),
      });
      const result = await response.json() as V2SetupResult;
      if (!result.ok) {
        setV2Flows((previous) => ({ ...previous, [projectId]: { phase: "error", message: v2Message(result), result } }));
        return;
      }
      const nextPhase = step === "verify-repositories" ? "verified" : step === "provision-repositories" ? "provisioned" : "activated";
      setV2Flows((previous) => ({ ...previous, [projectId]: { phase: nextPhase, result } }));
      if (step === "activate-v2") {
        setConfig((previous) => previous ? {
          ...previous,
          projects: previous.projects.map((entry) => entry.id === projectId
            ? { ...entry, repositories: requestRepositories(drafts) }
            : entry),
        } : previous);
        // Reload the authoritative committed array-only configuration without
        // discarding the activation receipt currently visible to the operator.
        load({ preserveV2Flow: true });
      }
    } catch {
      setV2Flows((previous) => ({ ...previous, [projectId]: { phase: "error", message: "V2 setup request failed [network_error]." } }));
    }
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

  const lifecycleErrorMessage = (payload: Record<string, unknown>, status: number) => {
    const cleanupErrors = Array.isArray(payload.cleanup_errors) ? payload.cleanup_errors : [];
    if (cleanupErrors.length > 0) {
      return cleanupErrors.map((entry) => {
        const error = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        const resource = typeof error.resource === "string" ? error.resource : "project";
        const code = typeof error.code === "string" ? error.code : "cleanup_failed";
        const message = typeof error.message === "string" ? error.message : t.lifecycleFailed;
        return `${resource} [${code}]: ${message}`;
      }).join(" · ");
    }
    const message = typeof payload.error === "string" ? payload.error : t.lifecycleFailed;
    const code = typeof payload.code === "string" ? payload.code : `http_${status}`;
    const field = typeof payload.field === "string" ? ` · ${payload.field}` : "";
    const owner = typeof payload.owner_project_id === "string" ? ` · owner: ${payload.owner_project_id}` : "";
    return `${message} [${code}]${field}${owner}`;
  };

  const commitLifecycleState = (projectId: string, update: { archived?: boolean; removed?: boolean }) => {
    setConfig((prev) => prev ? {
      ...prev,
      projects: update.removed
        ? prev.projects.filter((project) => project.id !== projectId)
        : prev.projects.map((project) => project.id === projectId && typeof update.archived === "boolean"
          ? { ...project, archived: update.archived }
          : project),
    } : prev);
    try {
      const saved = JSON.parse(savedConfigRef.current);
      if (Array.isArray(saved.projects)) {
        saved.projects = update.removed
          ? saved.projects.filter((project: { id: string }) => project.id !== projectId)
          : saved.projects.map((project: ProjectConfig) => project.id === projectId && typeof update.archived === "boolean"
            ? { ...project, archived: update.archived }
            : project);
        savedConfigRef.current = JSON.stringify(saved);
      }
    } catch { /* dirty-tracking best-effort */ }
  };

  const setLifecycleError = (projectId: string, message?: string) => {
    setProjectLifecycleErrors((prev) => {
      const next = { ...prev };
      if (message) next[projectId] = message;
      else delete next[projectId];
      return next;
    });
  };

  const setProjectArchived = async (idx: number, archived: boolean) => {
    if (!config) return;
    const target = config.projects[idx];
    if (!target || projectLifecyclePending[target.id]) return;
    setProjectLifecyclePending((prev) => ({ ...prev, [target.id]: archived ? "archive" : "restore" }));
    setLifecycleError(target.id);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(target.id)}/archive`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (typeof payload.archived === "boolean") commitLifecycleState(target.id, { archived: payload.archived });
      if (!res.ok || payload.ok !== true) setLifecycleError(target.id, lifecycleErrorMessage(payload, res.status));
    } catch {
      setLifecycleError(target.id, `${t.lifecycleFailed} [network_error]`);
    } finally {
      setProjectLifecyclePending((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
    }
  };

  const archiveProject = (idx: number) => setProjectArchived(idx, true);
  const restoreProject = (idx: number) => setProjectArchived(idx, false);

  // #971: removal persists immediately via the field-scoped DELETE endpoint
  // (the section-merge save never drops projects). Local state + the saved
  // snapshot both drop it, so any OTHER pending edits stay correctly marked dirty.
  const removeProject = async (idx: number) => {
    if (!config) return;
    const target = config.projects[idx];
    if (!target || projectLifecyclePending[target.id]) return;
    setConfirmDelete(null);
    setProjectLifecyclePending((prev) => ({ ...prev, [target.id]: "remove" }));
    setLifecycleError(target.id);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (payload.removed === true) commitLifecycleState(target.id, { removed: true });
      else if (typeof payload.archived === "boolean") commitLifecycleState(target.id, { archived: payload.archived });
      if (!res.ok || payload.ok !== true || payload.removed !== true) {
        setLifecycleError(target.id, lifecycleErrorMessage(payload, res.status));
      }
    } catch {
      setLifecycleError(target.id, `${t.lifecycleFailed} [network_error]`);
    } finally {
      setProjectLifecyclePending((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
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
          onClick={() => load()}
          className="px-3 py-1.5 text-[12px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
        >
          {t.retry}
        </button>
      </div>
    );
  }
  if (!config) return <div className="p-6 text-text-muted text-xs">{t.loading}</div>;

  const isDirty = savedConfigRef.current !== "" && JSON.stringify(config) !== savedConfigRef.current;
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
          const lifecyclePending = projectLifecyclePending[project.id];
          const repositoryDrafts = v2Drafts[project.id] || [blankRepository()];
          const v2Flow = v2Flows[project.id] || { phase: "idle" as const };
          const isV2Configured = Array.isArray(project.repositories) && project.repositories.length > 0;
          const activationConfirmed = v2ActivationConfirmations[project.id] === true;
          const environmentDraft = environmentDrafts[project.id] || environmentDraftFromConfig(project);
          const environmentMessage = environmentMessages[project.id];
          const environmentIsSaving = environmentSaving[project.id] === true;

          return (
            <div key={project.id} id={`project-${project.id}`} className="border border-border mb-3 scroll-mt-4">
              {/* Header — #212: no accordion, body always visible */}
              <div className="flex items-center justify-between px-3 py-2">
                <span className="min-w-0 truncate text-[12px] text-text font-semibold" title={project.name}>{project.name}</span>
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    <Input
                      label={t.projectName}
                      value={project.name}
                      onChange={(v) => renameProject(idx, v)}
                    />
                  </div>

                  <div className="mt-4 border border-border bg-bg-surface p-3" aria-describedby={`v2-repository-help-${project.id}`}>
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-[10px] text-text-muted uppercase tracking-wider">V2 repository setup</h3>
                        <p id={`v2-repository-help-${project.id}`} className="mt-1 text-[10px] text-text-muted leading-snug">
                          {isV2Configured || v2Flow.phase === "activated"
                            ? "Repository topology is managed through this explicit V2 flow, not the generic Settings save."
                            : "This legacy project needs an explicit repository topology and CI policy before V2 activation."}
                        </p>
                      </div>
                      <span className={`shrink-0 text-[10px] ${isV2Configured || v2Flow.phase === "activated" ? "text-accent" : "text-[#ffcc00]"}`}>
                        {isV2Configured || v2Flow.phase === "activated" ? "V2 configured" : "V2 setup required"}
                      </span>
                    </div>

                    <div className="mt-3 space-y-3">
                      {repositoryDrafts.map((repository, repositoryIndex) => (
                        <div key={`${project.id}-${repositoryIndex}`} className="border border-border p-3 min-w-0">
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                            <span className="text-[11px] text-text font-semibold">Repository {repositoryIndex + 1}</span>
                            <div className="flex items-center gap-3">
                              <label className="flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer">
                                <input type="radio" name={`primary-repository-${project.id}`} checked={repository.primary} onChange={() => setPrimaryV2Repository(project.id, repositoryIndex)} className="accent-accent" />
                                Primary
                              </label>
                              {repositoryDrafts.length > 1 && (
                                <button type="button" onClick={() => removeV2Repository(project.id, repositoryIndex)} className="text-[10px] text-error hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent transition-colors">Remove</button>
                              )}
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`repo-key-${project.id}-${repositoryIndex}`}>Repository key
                              <input id={`repo-key-${project.id}-${repositoryIndex}`} value={repository.key} onChange={(e) => updateV2Repository(project.id, repositoryIndex, { key: e.target.value })} placeholder="primary" className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" />
                            </label>
                            <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`repo-name-${project.id}-${repositoryIndex}`}>Canonical GitHub repository
                              <input id={`repo-name-${project.id}-${repositoryIndex}`} value={repository.repo} onChange={(e) => updateV2Repository(project.id, repositoryIndex, { repo: e.target.value })} placeholder="owner/repo" className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" />
                            </label>
                            <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`repo-base-${project.id}-${repositoryIndex}`}>Verified base clone
                              <input id={`repo-base-${project.id}-${repositoryIndex}`} value={repository.working_dir} onChange={(e) => updateV2Repository(project.id, repositoryIndex, { working_dir: e.target.value })} placeholder="/absolute/path/to/repository" className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text font-mono outline-none focus:border-accent" />
                            </label>
                          </div>
                          <div className="border-t border-border mt-3 pt-3">
                            <label className="text-[10px] text-text-muted block mb-1" htmlFor={`policy-mode-${project.id}-${repositoryIndex}`}>CI evidence policy</label>
                            <select id={`policy-mode-${project.id}-${repositoryIndex}`} value={repository.policy.mode} onChange={(e) => updateV2Policy(project.id, repositoryIndex, { mode: e.target.value as CiPolicyMode })} className="w-full md:w-72 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent">
                              <option value="" className="bg-bg-surface">Choose evidence policy…</option>
                              <option value="github-checks" className="bg-bg-surface">GitHub exact check registry</option>
                              <option value="ci-less" className="bg-bg-surface">CI-less Dev evidence receipt</option>
                            </select>
                            {repository.policy.mode === "github-checks" && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                                <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`required-checks-${project.id}-${repositoryIndex}`}>Required exact check names
                                  <input id={`required-checks-${project.id}-${repositoryIndex}`} value={repository.policy.requiredChecks} onChange={(e) => updateV2Policy(project.id, repositoryIndex, { requiredChecks: e.target.value })} placeholder="unit, typecheck" className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" />
                                </label>
                                <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`advisory-checks-${project.id}-${repositoryIndex}`}>Advisory exact check names
                                  <input id={`advisory-checks-${project.id}-${repositoryIndex}`} value={repository.policy.advisoryChecks} onChange={(e) => updateV2Policy(project.id, repositoryIndex, { advisoryChecks: e.target.value })} placeholder="coverage" className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" />
                                </label>
                                <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`check-kind-${project.id}-${repositoryIndex}`}>Required check ownership
                                  <select id={`check-kind-${project.id}-${repositoryIndex}`} value={repository.policy.checkKind} onChange={(e) => updateV2Policy(project.id, repositoryIndex, { checkKind: e.target.value as "product" | "control-plane" })} className="bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent">
                                    <option value="product" className="bg-bg-surface">Product</option>
                                    <option value="control-plane" className="bg-bg-surface">Control plane</option>
                                  </select>
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                  <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`grace-${project.id}-${repositoryIndex}`}>Registration grace
                                    <input id={`grace-${project.id}-${repositoryIndex}`} inputMode="numeric" value={repository.policy.registrationGraceSeconds} onChange={(e) => updateV2Policy(project.id, repositoryIndex, { registrationGraceSeconds: e.target.value })} className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" />
                                  </label>
                                  <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`retry-${project.id}-${repositoryIndex}`}>Same-SHA retry budget
                                    <input id={`retry-${project.id}-${repositoryIndex}`} inputMode="numeric" value={repository.policy.sameShaRetryBudget} onChange={(e) => updateV2Policy(project.id, repositoryIndex, { sameShaRetryBudget: e.target.value })} className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" />
                                  </label>
                                </div>
                              </div>
                            )}
                            {repository.policy.mode === "ci-less" && (
                              <div className="mt-2 max-w-md">
                                <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`evidence-keys-${project.id}-${repositoryIndex}`}>Required Dev evidence keys
                                  <input id={`evidence-keys-${project.id}-${repositoryIndex}`} value={repository.policy.evidenceKeys} onChange={(e) => updateV2Policy(project.id, repositoryIndex, { evidenceKeys: e.target.value })} placeholder="unit, typecheck" className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" />
                                </label>
                                <p className="mt-1 text-[10px] text-text-muted">Comma-separated data identifiers; evidence is not a command.</p>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    <button type="button" onClick={() => addV2Repository(project.id)} className="mt-3 px-2 py-1 text-[10px] border border-border text-text-muted hover:text-text hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent transition-colors">Add repository</button>

                    <div className="mt-3 border-t border-border pt-3 flex flex-col sm:flex-row sm:items-center gap-2">
                      <button type="button" onClick={() => runV2Flow(project, "verify-repositories")} disabled={["verifying", "provisioning", "activating"].includes(v2Flow.phase)} className="px-3 py-1.5 text-[11px] font-semibold border border-border text-text hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 transition-colors">
                        {v2Flow.phase === "verifying" ? "Verifying V2 access…" : v2Flow.phase === "verified" ? "V2 access verified" : "Verify V2 repository access"}
                      </button>
                      <button type="button" onClick={() => runV2Flow(project, "provision-repositories")} disabled={v2Flow.phase !== "verified"} className="px-3 py-1.5 text-[11px] font-semibold bg-accent text-bg hover:bg-accent-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 transition-colors">
                        {v2Flow.phase === "provisioning" ? "Provisioning V2 worktrees…" : v2Flow.phase === "provisioned" ? "V2 worktrees provisioned" : "Provision four role worktrees"}
                      </button>
                    </div>
                    <label className="mt-3 flex items-start gap-2 cursor-pointer">
                      <input type="checkbox" checked={activationConfirmed} onChange={(e) => setV2ActivationConfirmations((previous) => ({ ...previous, [project.id]: e.target.checked }))} className="mt-0.5 accent-accent" />
                      <span className="text-[10px] text-text-muted">I confirm this topology is correct and the project is quiesced. Activate V2 without starting agents.</span>
                    </label>
                    <button type="button" onClick={() => runV2Flow(project, "activate-v2")} disabled={v2Flow.phase !== "provisioned" || !activationConfirmed} className="mt-2 px-3 py-1.5 text-[11px] font-semibold border border-accent text-accent hover:bg-accent hover:text-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 transition-colors">
                      {v2Flow.phase === "activating" ? "Activating V2…" : v2Flow.phase === "activated" ? "V2 activated" : "Confirm and activate V2"}
                    </button>
                    {(v2Flow.message || v2Flow.phase === "activated") && (
                      <p role={v2Flow.message ? "alert" : "status"} aria-live="polite" className={`mt-3 text-[10px] ${v2Flow.message ? "text-error" : "text-accent"}`}>
                        {v2Flow.message || "V2 configuration activated. No agent was started or restarted."}
                      </p>
                    )}
                    {v2Flow.result?.repositories && (
                      <div className="mt-3 border-t border-border pt-3 space-y-2">
                        <p className="text-[10px] uppercase tracking-wider text-text-muted">Verified repository topology</p>
                        {v2Flow.result.repositories.map((repository) => (
                          <div key={repository.key || repository.repo} className="min-w-0 text-[10px]">
                            <p className="truncate text-text" title={repository.repo}>{repository.repo || repository.key}</p>
                            <p className="truncate text-text-muted font-mono" title={repository.base_clone}>{repository.base_clone || "Base clone pending"}{repository.default_branch ? ` · ${repository.default_branch}` : ""}</p>
                            <p className="mt-0.5 text-text-muted">Roles: {V2_ROLES.map((role) => repository.worktrees?.[role] ? role.toUpperCase() : `${role.toUpperCase()} pending`).join(" · ")}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* #1045: persisted peer bindings only. This intentionally
                      has no discovery, capability, reachability, remote-control,
                      or watcher-runtime controls; it configures local metadata. */}
                  <div className="mt-4 border border-border bg-bg-surface p-3" aria-describedby={`environment-help-${project.id}`}>
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-[10px] text-text-muted uppercase tracking-wider">Project Environments</h3>
                        <p id={`environment-help-${project.id}`} className="mt-1 text-[10px] text-text-muted leading-snug break-words">
                          Register ordered peer identities and the local coordination repository. Saving writes local settings only; it does not discover or control remote environments.
                        </p>
                      </div>
                      <span className="shrink-0 text-[10px] text-text-muted">Local metadata</span>
                    </div>

                    {!isV2Configured ? (
                      <p className="mt-3 text-[10px] text-[#ffcc00]" role="status" aria-live="polite">
                        Activate V2 repository setup before configuring Project Environments.
                      </p>
                    ) : (
                      <>
                        <div className="mt-3 space-y-2">
                          {environmentDraft.environment_bindings.map((binding, bindingIndex) => {
                            const confirmRemoval = environmentRemovalConfirm?.projectId === project.id && environmentRemovalConfirm.index === bindingIndex;
                            return (
                              <div key={`${project.id}-environment-${bindingIndex}`} className="border border-border p-2 min-w-0">
                                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                  <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`environment-${project.id}-installation_id-${bindingIndex}`}>Installation ID
                                    <input id={`environment-${project.id}-installation_id-${bindingIndex}`} name={`environment-${project.id}-installation-${bindingIndex}`} autoComplete="off" spellCheck={false} value={binding.installation_id} onChange={(event) => updateEnvironmentBinding(project.id, bindingIndex, { installation_id: event.target.value })} className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text font-mono outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
                                  </label>
                                  <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`environment-${project.id}-project_id-${bindingIndex}`}>Project ID
                                    <input id={`environment-${project.id}-project_id-${bindingIndex}`} name={`environment-${project.id}-project-${bindingIndex}`} autoComplete="off" spellCheck={false} value={binding.project_id} onChange={(event) => updateEnvironmentBinding(project.id, bindingIndex, { project_id: event.target.value })} className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text font-mono outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
                                  </label>
                                  <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`environment-${project.id}-label-${bindingIndex}`}>Display label
                                    <input id={`environment-${project.id}-label-${bindingIndex}`} name={`environment-${project.id}-label-${bindingIndex}`} autoComplete="off" value={binding.label} onChange={(event) => updateEnvironmentBinding(project.id, bindingIndex, { label: event.target.value })} className="min-w-0 bg-transparent border border-border px-2 py-1.5 text-[11px] text-text outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
                                  </label>
                                  <label className="text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`environment-${project.id}-environment_class-${bindingIndex}`}>Environment class
                                    <select id={`environment-${project.id}-environment_class-${bindingIndex}`} name={`environment-${project.id}-class-${bindingIndex}`} value={binding.environment_class} onChange={(event) => updateEnvironmentBinding(project.id, bindingIndex, { environment_class: event.target.value as EnvironmentClass })} className="min-w-0 bg-bg-surface border border-border px-2 py-1.5 text-[11px] text-text outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                                      <option value="local">Local</option>
                                      <option value="vps">VPS</option>
                                      <option value="other">Other</option>
                                    </select>
                                  </label>
                                </div>
                                <div className="mt-2 flex items-center justify-end gap-2">
                                  {confirmRemoval ? (
                                    <>
                                      <span className="min-w-0 text-[10px] text-error break-words">Remove this local peer binding? Save to apply.</span>
                                      <button type="button" onClick={() => { updateEnvironmentDraft(project.id, (current) => ({ ...current, environment_bindings: current.environment_bindings.filter((_, index) => index !== bindingIndex) })); setEnvironmentRemovalConfirm(null); }} className="px-2 py-1 text-[10px] bg-error text-bg font-semibold hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Confirm removal</button>
                                      <button type="button" onClick={() => setEnvironmentRemovalConfirm(null)} className="px-2 py-1 text-[10px] border border-border text-text-muted hover:text-text hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Cancel</button>
                                    </>
                                  ) : (
                                    <button type="button" onClick={() => setEnvironmentRemovalConfirm({ projectId: project.id, index: bindingIndex })} className="text-[10px] text-error hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Remove peer</button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <button type="button" onClick={() => updateEnvironmentDraft(project.id, (current) => ({ ...current, environment_bindings: [...current.environment_bindings, blankEnvironmentBinding()] }))} className="mt-3 px-2 py-1 text-[10px] border border-border text-text-muted hover:text-text hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Add peer environment</button>

                        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 mt-3 border-t border-border pt-3">
                          <label className="min-w-0 text-[10px] text-text-muted flex flex-col gap-1" htmlFor={`environment-${project.id}-coordination-repo`}>Coordination repository
                            <select id={`environment-${project.id}-coordination-repo`} name={`environment-${project.id}-coordination-repo`} value={environmentDraft.coordination_repo_key} onChange={(event) => updateEnvironmentDraft(project.id, (current) => ({ ...current, coordination_repo_key: event.target.value, watch_batch_requests: event.target.value ? current.watch_batch_requests : false }))} className="min-w-0 bg-bg-surface border border-border px-2 py-1.5 text-[11px] text-text outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                              <option value="">No coordination repository</option>
                              {(project.repositories || []).map((repository) => (
                                <option key={repository.key} value={repository.key}>{repository.key} · {repository.repo}</option>
                              ))}
                            </select>
                          </label>
                          <label className="mt-5 flex min-w-0 items-start gap-2 cursor-pointer text-[10px] text-text-muted">
                            <input id={`environment-${project.id}-watch-batch-requests`} name={`environment-${project.id}-watch-batch-requests`} type="checkbox" checked={environmentDraft.watch_batch_requests} disabled={!environmentDraft.coordination_repo_key} onChange={(event) => updateEnvironmentDraft(project.id, (current) => ({ ...current, watch_batch_requests: event.target.checked }))} className="mt-0.5 accent-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50" />
                            <span className="min-w-0 break-words">Watch Batch Request Tickets on this local environment</span>
                          </label>
                        </div>

                        <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
                          <button id={`environment-${project.id}-save`} type="button" onClick={() => saveEnvironmentSettings(project)} disabled={environmentIsSaving} className="px-3 py-1.5 text-[11px] font-semibold border border-accent text-accent hover:bg-accent hover:text-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
                            {environmentIsSaving ? "Saving…" : "Save Project Environments"}
                          </button>
                          <span className="text-[10px] text-text-muted">Peer removal only blocks future local validation; it never changes remote work.</span>
                        </div>
                        {environmentMessage && (
                          <p role="status" aria-live="polite" className={`mt-2 text-[10px] break-words ${environmentMessage.error ? "text-error" : "text-accent"}`}>
                            {environmentMessage.text}
                          </p>
                        )}
                      </>
                    )}
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
                                // valid for the new backend — otherwise a Claude model leaks onto a
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
                       widgets in the Operator Features
                       panel (#210 + #211). Configure them from
                       the project page. */}

                  {/* Remove project */}
                  {projectLifecycleErrors[project.id] && (
                    <div role="alert" className="mt-4 border border-error/30 bg-error/5 px-3 py-2 text-[10px] text-error break-words">
                      {projectLifecycleErrors[project.id]}
                    </div>
                  )}
                  <div className="mt-4 flex justify-end gap-3">
                    {project.archived ? (
                      <button
                        onClick={() => restoreProject(idx)}
                        disabled={!!lifecyclePending}
                        className="text-[11px] text-accent hover:underline disabled:opacity-50 disabled:no-underline"
                      >
                        {lifecyclePending === "restore" ? `${t.restoreProject}…` : t.restoreProject}
                      </button>
                    ) : (
                      <button
                        onClick={() => archiveProject(idx)}
                        disabled={!!lifecyclePending}
                        className="text-[11px] text-text-muted hover:text-text transition-colors disabled:opacity-50"
                      >
                        {lifecyclePending === "archive" ? `${t.archive}…` : t.archive}
                      </button>
                    )}
                    {confirmDelete === project.id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-error">{t.removeQuestion}</span>
                        <button
                          onClick={() => removeProject(idx)}
                          disabled={!!lifecyclePending}
                          className="px-2 py-1 text-[11px] bg-error text-bg font-semibold disabled:opacity-50"
                        >
                          {lifecyclePending === "remove" ? `${t.confirm}…` : t.confirm}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          disabled={!!lifecyclePending}
                          className="px-2 py-1 text-[11px] text-text-muted border border-border disabled:opacity-50"
                        >
                          {t.cancel}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(project.id)}
                        disabled={!!lifecyclePending}
                        className="text-[11px] text-error hover:text-text transition-colors disabled:opacity-50"
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

        {/* New repository topology is always created in the explicit V2 flow. */}
        <button
          type="button"
          onClick={() => router.push("/setup")}
          className="w-full border border-dashed border-border py-2 text-[12px] text-text-muted hover:text-text hover:border-text-muted transition-colors"
        >
          {t.addProject} (V2 setup)
        </button>

        {/* Archived projects */}
        {config.projects.some((p) => p.archived) && (
          <>
            <hr className="border-border my-4" />
            <h2 className="text-[11px] text-text-muted uppercase tracking-wider mb-3">{t.archived}</h2>
            {config.projects.filter((p) => p.archived).map((project) => {
              const idx = config.projects.indexOf(project);
              const lifecyclePending = projectLifecyclePending[project.id];
              return (
                <div key={project.id} className="border border-border mb-3 opacity-60">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-[12px] text-text-muted">{project.name}</span>
                    <div className="flex items-center gap-2">
                      {projectLifecycleErrors[project.id] && (
                        <button
                          onClick={() => archiveProject(idx)}
                          disabled={!!lifecyclePending}
                          className="text-[11px] text-text-muted hover:text-text hover:underline disabled:opacity-50"
                        >
                          {lifecyclePending === "archive" ? `${t.retryCleanup}…` : t.retryCleanup}
                        </button>
                      )}
                      <button
                        onClick={() => restoreProject(idx)}
                        disabled={!!lifecyclePending}
                        className="text-[11px] text-accent hover:underline disabled:opacity-50 disabled:no-underline"
                      >
                        {lifecyclePending === "restore" ? `${t.restore}…` : t.restore}
                      </button>
                      {confirmDelete === project.id ? (
                        <>
                          <button
                            onClick={() => removeProject(idx)}
                            disabled={!!lifecyclePending}
                            className="px-2 py-1 text-[11px] bg-error text-bg font-semibold disabled:opacity-50"
                          >
                            {lifecyclePending === "remove" ? `${t.confirmRemove}…` : t.confirmRemove}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            disabled={!!lifecyclePending}
                            className="px-2 py-1 text-[11px] text-text-muted border border-border disabled:opacity-50"
                          >
                            {t.cancel}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(project.id)}
                          disabled={!!lifecyclePending}
                          className="text-[11px] text-error hover:underline disabled:opacity-50"
                        >
                          {t.remove}
                        </button>
                      )}
                    </div>
                  </div>
                  {projectLifecycleErrors[project.id] && (
                    <div role="alert" className="mx-3 mb-3 border border-error/30 bg-error/5 px-3 py-2 text-[10px] text-error break-words">
                      {projectLifecycleErrors[project.id]}
                    </div>
                  )}
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
