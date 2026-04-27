"use client";

import { useEffect, useRef, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import { useLocale } from "@/components/LocaleProvider";

const COPY = {
  en: {
    title: "Project History",
    tooltip: (
      <>
        <b>Project History</b> — export or import the full AgentChattr chat history for this project. Useful for backup, migration, or resuming after a fresh install.
      </>
    ),
    export: (projectId: string) => `Export ${projectId} chat`,
    import: "Import history…",
    importing: "Importing…",
    autoRestore: "Auto-restore newest snapshot after AC restart",
    autoSnapshots: "Auto-snapshots (before restart)",
    restore: "Restore",
    restoreConfirm: (name: string) => `Restore snapshot ${name}? This will replay every message through AgentChattr (tagged by the original sender) and may duplicate history already in the chat. Continue?`,
    importMismatchConfirm: (source: string, target: string) => `This export is from project '${source}' but you're importing into '${target}'. Continue anyway?`,
    importReservedConfirm: (senders: string) => `This export contains messages attributed to reserved agent/system identities (${senders}). Importing will replay them as those agents — only do this for a legitimate disaster-recovery restore. Continue?`,
    importDuplicateConfirm: (error: string) => `${error}\n\nThis file looks like it was already imported. Re-import will duplicate every message. Continue anyway?`,
    importStatus: (imported: number, total: number, skipped: number, errors: number) => (
      <>
        Imported {imported} / {total}
        {skipped > 0 && ` · skipped ${skipped}`}
        {errors > 0 && ` · ${errors} errors`}
      </>
    ),
  },
  ko: {
    title: "프로젝트 히스토리",
    tooltip: (
      <>
        <b>프로젝트 히스토리</b> - 이 프로젝트의 전체 AgentChattr 채팅 기록을 내보내거나 가져옵니다. 백업, 마이그레이션, 재설치 후 복구에 유용합니다.
      </>
    ),
    export: (projectId: string) => `${projectId} 채팅 내보내기`,
    import: "히스토리 가져오기…",
    importing: "가져오는 중…",
    autoRestore: "AC 재시작 후 최신 스냅샷 자동 복구",
    autoSnapshots: "자동 스냅샷 (재시작 전)",
    restore: "복구",
    restoreConfirm: (name: string) => `스냅샷 ${name}을(를) 복구할까요? 모든 메시지가 AgentChattr를 통해 재생되며(원본 발신자 표시), 채팅에 이미 있는 내용이 중복될 수 있습니다. 계속하시겠습니까?`,
    importMismatchConfirm: (source: string, target: string) => `이 내보내기 파일은 '${source}' 프로젝트에서 생성되었지만, 현재 '${target}' 프로젝트로 가져오려 합니다. 계속하시겠습니까?`,
    importReservedConfirm: (senders: string) => `이 파일에는 예약된 에이전트/시스템 식별자(${senders})가 발신자로 표시된 메시지가 포함되어 있습니다. 가져오기를 진행하면 해당 에이전트가 말하는 것처럼 메시지가 재생됩니다. 재난 복구 상황에서만 사용하세요. 계속하시겠습니까?`,
    importDuplicateConfirm: (error: string) => `${error}\n\n이 파일은 이미 가져온 것 같습니다. 다시 가져오면 모든 메시지가 중복됩니다. 계속하시겠습니까?`,
    importStatus: (imported: number, total: number, skipped: number, errors: number) => (
      <>
        가져옴: {imported} / {total}
        {skipped > 0 && ` · 건너뜀 ${skipped}`}
        {errors > 0 && ` · 오류 ${errors}`}
      </>
    ),
  },
} as const;

interface ProjectHistoryWidgetProps {
  projectId: string;
}

interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  total: number;
  errors: string[];
}

// #424 / quadwork#304 Phase 4: auto-snapshot list for the restore
// UI. Files live at ~/.quadwork/{id}/history-snapshots/{ISO}.json
// and are created by snapshotProjectHistory() in server/index.js
// before every restart/update.
interface SnapshotEntry {
  name: string;
  size: number;
  mtime: number;
}

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * #412 / quadwork#279: per-project chat history export + import.
 *
 * Export downloads a JSON file from `/api/project-history?project=ID`
 * with the metadata envelope the server stamps on it. Import takes a
 * JSON file, validates the shape + size client-side before POSTing,
 * shows a warning if the file's project_id doesn't match the current
 * project, and renders a small progress / result block.
 */
export default function ProjectHistoryWidget({ projectId }: ProjectHistoryWidgetProps) {
  const { locale } = useLocale();
  const t = COPY[locale];
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  // #424 / quadwork#304 Phase 3: per-project auto-restore flag.
  // Default OFF. When enabled, the server auto-restores the newest
  // snapshot after every restart (handleAgentChattr reads the flag
  // pre-restart so an in-flight toggle can't starve the replay).
  const [autoRestore, setAutoRestore] = useState<boolean>(false);
  const [autoRestoreSaving, setAutoRestoreSaving] = useState(false);
  useEffect(() => {
    fetch(`/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg || !Array.isArray(cfg.projects)) return;
        const proj = cfg.projects.find((p: { id: string }) => p.id === projectId);
        if (proj) setAutoRestore(!!proj.auto_restore_after_restart);
      })
      .catch(() => {});
  }, [projectId]);
  const saveAutoRestore = async (next: boolean) => {
    setAutoRestoreSaving(true);
    try {
      const r = await fetch(`/api/config`);
      if (!r.ok) throw new Error(`GET /api/config ${r.status}`);
      const cfg = await r.json();
      const idx = cfg.projects?.findIndex((p: { id: string }) => p.id === projectId) ?? -1;
      if (idx < 0) throw new Error("project not found");
      cfg.projects[idx] = { ...cfg.projects[idx], auto_restore_after_restart: next };
      const pr = await fetch(`/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!pr.ok) throw new Error(`PUT /api/config ${pr.status}`);
    } finally {
      setAutoRestoreSaving(false);
    }
  };

  const loadSnapshots = () => {
    fetch(`/api/project-history/snapshots?project=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.snapshots)) setSnapshots(d.snapshots);
      })
      .catch(() => {});
  };
  useEffect(() => {
    loadSnapshots();
    // Refresh the list every 15s so a restart-triggered snapshot
    // shows up without the operator reloading the dashboard.
    const id = setInterval(loadSnapshots, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const restoreSnapshot = async (name: string) => {
    const ok = window.confirm(t.restoreConfirm(name));
    if (!ok) return;
    setBusy("restore");
    setError(null);
    setResult(null);
    try {
      const r = await fetch(
        `/api/project-history/restore?project=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`,
        { method: "POST" },
      );
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
      if (data && typeof data.imported === "number") setResult(data as ImportResult);
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(null);
      loadSnapshots();
    }
  };

  const exportHistory = async () => {
    setBusy("export");
    setError(null);
    setResult(null);
    try {
      const r = await fetch(`/api/project-history?project=${encodeURIComponent(projectId)}`);
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${detail.slice(0, 200)}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `${projectId}-history-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(null);
    }
  };

  const triggerPicker = () => {
    setError(null);
    setResult(null);
    fileRef.current?.click();
  };

  const importFile = async (file: File) => {
    if (file.size > MAX_BYTES) {
      setError(`File too large (${file.size} bytes; limit ${MAX_BYTES})`);
      return;
    }
    setBusy("import");
    setError(null);
    setResult(null);
    let parsed: { project_id?: string; messages?: unknown[] } & Record<string, unknown>;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (err) {
      setBusy(null);
      setError(`Invalid JSON: ${(err as Error).message || String(err)}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
      setBusy(null);
      setError("File missing 'messages' array");
      return;
    }
    // Project mismatch confirmation. The server enforces this too via
    // a 409 unless allow_project_mismatch is set; the client checks
    // here so the operator can opt in once instead of seeing a
    // confusing 409 in the error block.
    let allowMismatch = false;
    if (parsed.project_id && parsed.project_id !== projectId) {
      const ok = window.confirm(t.importMismatchConfirm(parsed.project_id, projectId));
      if (!ok) {
        setBusy(null);
        return;
      }
      allowMismatch = true;
    }
    // #414 / quadwork#297: pre-scan for reserved agent senders so
    // we can prompt once instead of after a server 400. The same
    // RESERVED set lives in server/routes.js — keep them in sync.
    // Current + legacy agent slugs — legacy names kept so imported
    // histories with old senders are still flagged. Mirrors
    // RESERVED_HISTORY_SENDERS in server/routes.js.
    const RESERVED_SENDERS = new Set(["head", "dev", "reviewer1", "reviewer2", "re1", "re2", "t1", "t2a", "t2b", "t3", "system"]);
    let allowAgentSenders = false;
    const offenders = new Set<string>();
    for (const m of parsed.messages) {
      if (m && typeof m === "object") {
        const sender = (m as { sender?: unknown }).sender;
        if (typeof sender === "string" && RESERVED_SENDERS.has(sender.toLowerCase())) {
          offenders.add(sender);
          if (offenders.size >= 5) break;
        }
      }
    }
    if (offenders.size > 0) {
      const ok = window.confirm(t.importReservedConfirm([...offenders].join(", ")));
      if (!ok) {
        setBusy(null);
        return;
      }
      allowAgentSenders = true;
    }
    // Server-side duplicate detection sends a 409 the first time;
    // we forward allow_duplicate after asking the operator. We can't
    // pre-check this client-side since we don't store the marker
    // here — let the server tell us, then re-POST with the flag.
    let allowDuplicate = false;
    const post = (extra: Record<string, unknown>) =>
      fetch(`/api/project-history?project=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...parsed,
          allow_project_mismatch: allowMismatch,
          allow_agent_senders: allowAgentSenders,
          allow_duplicate: allowDuplicate,
          ...extra,
        }),
      });
    try {
      let r = await post({});
      let data = await r.json().catch(() => null);
      if (r.status === 409 && data && typeof data.error === "string" && /already imported/i.test(data.error)) {
        const ok = window.confirm(t.importDuplicateConfirm(data.error));
        if (!ok) {
          setBusy(null);
          return;
        }
        allowDuplicate = true;
        r = await post({ allow_duplicate: true });
        data = await r.json().catch(() => null);
      }
      if (!r.ok) {
        throw new Error((data && data.error) || `HTTP ${r.status}`);
      }
      setResult(data as ImportResult);
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="border border-border rounded p-2 text-[11px] font-mono">
      <div className="flex items-center gap-1.5 text-text-muted uppercase tracking-wider mb-1.5">
        {t.title}
        <InfoTooltip>
          {t.tooltip}
        </InfoTooltip>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={exportHistory}
          disabled={busy !== null}
          className="px-2 py-0.5 text-[10px] text-accent border border-accent/40 rounded hover:bg-accent/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Download a JSON snapshot of this project's chat history"
        >
          {busy === "export" ? "…" : t.export(projectId)}
        </button>
        <button
          type="button"
          onClick={triggerPicker}
          disabled={busy !== null}
          className="px-2 py-0.5 text-[10px] text-text-muted border border-border rounded hover:text-text hover:border-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Restore a previously exported chat history (JSON)"
        >
          {busy === "import" ? t.importing : t.import}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) void importFile(f);
          }}
        />
      </div>
      {error && (
        <div className="mt-1 text-[10px] text-red-400">{error}</div>
      )}
      {result && (
        <div className="mt-1 text-[10px] text-text-muted">
          {t.importStatus(result.imported, result.total, result.skipped, result.errors.length)}
        </div>
      )}
      <label className="mt-2 flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer select-none">
        <input
          type="checkbox"
          checked={autoRestore}
          disabled={autoRestoreSaving}
          onChange={(e) => {
            const next = e.target.checked;
            setAutoRestore(next);
            saveAutoRestore(next).catch(() => setAutoRestore(!next));
          }}
        />
        {t.autoRestore}
      </label>
      {snapshots.length > 0 && (
        <div className="mt-2 border-t border-border/50 pt-1.5">
          <div className="text-[9px] text-text-muted uppercase tracking-wider mb-0.5">
            {t.autoSnapshots}
          </div>
          {snapshots.map((s) => {
            const date = new Date(s.mtime);
            const label = date.toLocaleString();
            return (
              <div
                key={s.name}
                className="flex items-center gap-1.5 text-[10px] py-0.5"
              >
                <span className="text-text-muted tabular-nums flex-1 truncate" title={s.name}>
                  {label}
                </span>
                <span className="text-text-muted tabular-nums shrink-0">
                  {Math.round(s.size / 1024)}KB
                </span>
                <button
                  type="button"
                  onClick={() => restoreSnapshot(s.name)}
                  disabled={busy !== null}
                  className="px-1.5 py-0.5 text-[10px] text-accent border border-accent/40 rounded hover:bg-accent/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={`Restore ${s.name}`}
                >
                  {busy === "restore" ? "…" : t.restore}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
