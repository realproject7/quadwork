"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  NOTIFICATION_SOUND_OPTIONS,
  type NotificationSoundChoice,
  getNotificationEnabled,
  setNotificationEnabled,
  getNotificationChoice,
  setNotificationChoice,
  getNotificationBackgroundOnly,
  setNotificationBackgroundOnly,
} from "../lib/notificationSound";
import { useLocale } from "@/components/LocaleProvider";

const COPY = {
  en: {
    server: {
      title: "Server",
      stop: "Stop",
      confirmStop: "Confirm Stop?",
      restart: "Restart",
      resetAgents: "Reset Agents",
      healthGaveUp: "AC auto-restart failed 3x — manual restart required",
      healthRestarted: (time: string) => `AC auto-restarted at ${time}`,
      stopped: "Stopped",
      failed: "Failed",
      error: "Error",
      acRestarted: (pid: number) => `AC restarted (PID: ${pid}) — resetting agents...`,
      acAndAgentsRestarted: (restarted: number) => `AC + ${restarted} agent${restarted !== 1 ? "s" : ""} restarted`,
      agentResetFailed: "AC restarted — agent reset failed",
      resetResult: (restarted: number, total: number) => `Reset — ${restarted} of ${total} agent${total !== 1 ? "s" : ""} restarted`,
    },
    system: {
      keepAwake: "Keep Mac Awake",
      keepAwakeAbout: "About Keep Mac Awake",
      keepAwakeHelp: <><b>Keep Mac Awake</b> runs macOS <code>caffeinate</code> to stop the screen, disk, and system idle timers from sleeping your Mac during an overnight run. Make sure the laptop is plugged in — caffeinate blocks sleep but not battery drain.</>,
      autoAwakeOn: "Auto-awake ON: caffeinate starts/stops with batch lifecycle",
      autoAwakeOff: "Auto-awake OFF: manual Start/Stop only",
      awakeFor: (time: string) => `Awake for ${time} more — keep Mac plugged in`,
      awakeIndefinitely: "Awake indefinitely — keep Mac plugged in",
      awakeDesc: "Prevents your Mac from sleeping during overnight runs.",
      awake: "Awake",
      start: "Start",
      on: "on",
      sound: "Notification Sound",
      soundAbout: "About Notification Sound",
      soundHelp: <><b>Notification Sound</b> plays a brief chime when an agent posts a new message (not your own sends, not system events). Sound choice picks one of the bundled chimes. Background-only mode suppresses the chime while the tab is focused — ding only when you&apos;re looking elsewhere. All prefs persist in localStorage.</>,
      soundDesc: "Plays a chime when an agent posts a new message.",
      soundLabel: "Sound",
      soundBgOnly: "Only when tab is in background",
      awakeStatusActive: "Batch active — auto-started caffeinate.",
      awakeStatusComplete: "Batch complete — awake paused.",
      awakeStatusNew: "New batch detected — auto-started caffeinate.",
      keepAwakeModalTitle: "Keep Awake",
      keepAwakeModalAbout: "About Keep Awake",
      keepAwakeModalHelp: <><b>Keep Awake</b> prevents your Mac from sleeping for the duration you set. Use this when you want agents to keep working overnight.<br /><br />Under the hood, this runs macOS&apos;s <code>caffeinate</code> command. While it&apos;s active your screen, disk, and system idle timers are all paused — make sure your Mac is <b>plugged in</b> to avoid draining the battery.</>,
      makeSurePluggedIn: "Make sure Mac is plugged in",
      for: "for",
      hours: "hours",
      untilStopped: "Until stopped (no expiry)",
    },
  },
  ko: {
    server: {
      title: "서버",
      stop: "중지",
      confirmStop: "정말 중지?",
      restart: "재시작",
      resetAgents: "에이전트 초기화",
      healthGaveUp: "AC 자동 재시작 3회 실패 — 수동 재시작이 필요합니다",
      healthRestarted: (time: string) => `AC가 ${time}에 자동 재시작되었습니다`,
      stopped: "중지됨",
      failed: "실패",
      error: "오류",
      acRestarted: (pid: number) => `AC 재시작됨 (PID: ${pid}) — 에이전트 초기화 중...`,
      acAndAgentsRestarted: (restarted: number) => `AC 및 ${restarted}개 에이전트 재시작됨`,
      agentResetFailed: "AC 재시작됨 — 에이전트 초기화 실패",
      resetResult: (restarted: number, total: number) => `초기화 완료 — ${total}개 중 ${restarted}개 에이전트 재시작됨`,
    },
    system: {
      keepAwake: "Mac 절전 방지",
      keepAwakeAbout: "Mac 절전 방지 정보",
      keepAwakeHelp: <><b>Mac 절전 방지</b>는 macOS의 <code>caffeinate</code>를 실행해 야간 작업 중 Mac이 절전 상태로 들어가는 것을 막습니다. 충전기를 연결해 두세요. caffeinate는 절전은 막지만 배터리 소모를 막아주지는 않습니다.</>,
      autoAwakeOn: "자동 절전 방지 켬: 배치 상태에 따라 caffeinate 시작/종료",
      autoAwakeOff: "자동 절전 방지 끔: 수동 시작/종료만 가능",
      awakeFor: (time: string) => `앞으로 ${time} 동안 절전 방지 — 전원을 연결해 두세요`,
      awakeIndefinitely: "무기한 절전 방지 중 — 전원을 연결해 두세요",
      awakeDesc: "야간 작업 중 Mac이 잠들지 않도록 합니다.",
      awake: "절전 방지 중",
      start: "시작",
      on: "켬",
      sound: "알림음",
      soundAbout: "알림음 정보",
      soundHelp: <><b>알림음</b>은 에이전트가 새 메시지를 보낼 때 짧은 알림음을 재생합니다. 내 메시지나 시스템 이벤트에는 울리지 않습니다. 사운드 선택으로 내장 알림음 중 하나를 고를 수 있고, 백그라운드 전용 모드는 탭이 포커스된 동안에는 알림음을 막습니다. 모든 설정은 localStorage에 저장됩니다.</>,
      soundDesc: "에이전트가 새 메시지를 보낼 때 알림음을 재생합니다.",
      soundLabel: "알림음",
      soundBgOnly: "탭이 백그라운드에 있을 때만",
      awakeStatusActive: "배치 실행 중 — caffeinate를 자동으로 시작했습니다.",
      awakeStatusComplete: "배치 완료 — 절전 방지를 일시 중단했습니다.",
      awakeStatusNew: "새 배치 감지 — caffeinate를 자동으로 시작했습니다.",
      keepAwakeModalTitle: "절전 방지",
      keepAwakeModalAbout: "절전 방지 정보",
      keepAwakeModalHelp: <><b>절전 방지</b>는 설정한 시간 동안 Mac이 절전 상태로 들어가는 것을 막습니다. 에이전트가 밤새 작업하게 하려면 이 기능을 사용하세요.<br /><br />내부적으로는 macOS의 <code>caffeinate</code> 명령을 실행합니다. 실행 중에는 화면, 디스크, 시스템 유휴 타이머가 모두 정지됩니다. 배터리 소모를 막으려면 Mac에 <b>전원을 연결</b>해 두세요.</>,
      makeSurePluggedIn: "전원을 연결해 두세요",
      for: "시간:",
      hours: "시간",
      untilStopped: "중지할 때까지 (만료 없음)",
    },
  },
} as const;

// ─── Server Controls ─────────────────────────────────────────────────────────

function ServerSection({ projectId }: { projectId: string }) {
  const { locale } = useLocale();
  const t = COPY[locale].server;
  const [loading, setLoading] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  // #416: AC health monitor status — poll every 30s to surface
  // auto-restart events and persistent errors in the dashboard.
  const [healthNote, setHealthNote] = useState<string | null>(null);

  useEffect(() => {
    const pollHealth = () => {
      fetch(`/api/agentchattr/${encodeURIComponent(projectId)}/health`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) { setHealthNote(null); return; }
          if (d.autoRestart?.gaveUp) {
            setHealthNote(t.healthGaveUp);
          } else if (d.autoRestart?.lastRestart) {
            const ago = Math.round((Date.now() - d.autoRestart.lastRestart) / 1000);
            if (ago < 300) {
              const time = new Date(d.autoRestart.lastRestart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              setHealthNote(t.healthRestarted(time));
            } else {
              setHealthNote(null);
            }
          } else {
            setHealthNote(null);
          }
        })
        .catch(() => setHealthNote(null));
    };
    pollHealth();
    const interval = setInterval(pollHealth, 30000);
    return () => clearInterval(interval);
  }, [projectId, t]);

  const clearFeedback = () => {
    setTimeout(() => setFeedback(null), 3000);
  };

  // Auto-reset confirmation after 4s if user doesn't follow through
  useEffect(() => {
    if (!confirmStop) return;
    const timer = setTimeout(() => setConfirmStop(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmStop]);

  const handleStop = async () => {
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setConfirmStop(false);
    setLoading("stop");
    try {
      const r = await fetch(
        `/api/agentchattr/${encodeURIComponent(projectId)}/stop`,
        { method: "POST" }
      );
      const d = await r.json();
      setFeedback(d.ok ? t.stopped : t.failed);
    } catch {
      setFeedback(t.error);
    }
    setLoading(null);
    clearFeedback();
  };

  const handleRestart = async () => {
    setLoading("restart");
    try {
      const r = await fetch(
        `/api/agentchattr/${encodeURIComponent(projectId)}/restart`,
        { method: "POST" }
      );
      const d = await r.json();
      if (d.ok && d.pid) {
        setFeedback(t.acRestarted(d.pid));
        // #417: After AC restart, also reset all agents so they get
        // fresh MCP tokens. Without this, agents stay stuck with stale
        // connections from the pre-restart session.
        try {
          const resetRes = await fetch(
            `/api/agents/${encodeURIComponent(projectId)}/reset`,
            { method: "POST" }
          );
          const resetData = await resetRes.json();
          if (resetData.ok) {
            setFeedback(t.acAndAgentsRestarted(resetData.restarted));
          } else {
            setFeedback(t.agentResetFailed);
          }
        } catch {
          setFeedback(t.agentResetFailed);
        }
      } else {
        setFeedback(d.error || t.failed);
      }
    } catch {
      setFeedback(t.error);
    }
    setLoading(null);
    clearFeedback();
  };

  const handleReset = async () => {
    setLoading("reset");
    try {
      const r = await fetch(
        `/api/agents/${encodeURIComponent(projectId)}/reset`,
        { method: "POST" }
      );
      const d = await r.json();
      setFeedback(
        d.ok ? t.resetResult(d.restarted, d.total) : (d.error || t.failed)
      );
    } catch {
      setFeedback(t.error);
    }
    setLoading(null);
    clearFeedback();
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">
        {t.title}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={handleStop}
          disabled={!!loading}
          className={`px-1.5 py-0.5 text-[10px] border transition-colors disabled:opacity-50 ${
            confirmStop
              ? "text-error border-error/60 bg-error/10 hover:bg-error/20"
              : "text-text-muted border-border hover:text-error hover:border-error/40"
          }`}
        >
          {loading === "stop" ? "..." : confirmStop ? t.confirmStop : t.stop}
        </button>
        <button
          onClick={handleRestart}
          disabled={!!loading}
          className="px-1.5 py-0.5 text-[10px] text-text-muted border border-border hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
        >
          {loading === "restart" ? "..." : t.restart}
        </button>
        <button
          onClick={handleReset}
          disabled={!!loading}
          className="px-1.5 py-0.5 text-[10px] text-text-muted border border-border hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
        >
          {loading === "reset" ? "..." : t.resetAgents}
        </button>
      </div>
      {feedback && (
        <div className="text-[10px] text-accent">{feedback}</div>
      )}
      {healthNote && !feedback && (
        <div className={`text-[10px] ${healthNote.includes("failed") || healthNote.includes("\uc2e4\ud328") ? "text-error" : "text-[#ffcc00]"}`}>
          {healthNote}
        </div>
      )}
    </div>
  );
}

// ─── System (Caffeinate) ─────────────────────────────────────────────────────

// #407 / quadwork#270: free-typed hours input replaces the fixed
// preset list. Same default/min/max/step pattern as the Scheduled
// Trigger custom-hours fix in #406. The "Until stopped" option is
// preserved here (issue requires it) as a separate checkbox.
const KEEP_AWAKE_HOURS_DEFAULT = 3;
const KEEP_AWAKE_HOURS_MIN = 0.1;
const KEEP_AWAKE_HOURS_MAX = 24;
function clampKeepAwakeHours(h: number): number {
  if (!Number.isFinite(h)) return KEEP_AWAKE_HOURS_DEFAULT;
  return Math.min(Math.max(h, KEEP_AWAKE_HOURS_MIN), KEEP_AWAKE_HOURS_MAX);
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const AWAKE_AUTO_POLL_MS = 30_000;
const AWAKE_AUTO_DEFAULT_HOURS = 8;

function SystemSection({ projectId }: { projectId: string }) {
  const { locale } = useLocale();
  const t = COPY[locale].system;
  const [active, setActive] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [platform, setPlatform] = useState<string>("");
  const [showPresets, setShowPresets] = useState(false);
  // #407 / quadwork#270: free-typed hours draft + "Until stopped"
  // override. Same draft-string pattern as #406 so decimals stay
  // typeable.
  const [hoursDraft, setHoursDraft] = useState<string>(String(KEEP_AWAKE_HOURS_DEFAULT));
  const [untilStopped, setUntilStopped] = useState<boolean>(false);
  const [showHelp, setShowHelp] = useState(false);

  // #441: Auto toggle — auto-start/stop caffeinate linked to batch lifecycle
  const [awakeAuto, setAwakeAuto] = useState(false);
  const [awakeAutoStatus, setAwakeAutoStatus] = useState<string | null>(null);
  const awakeAutoRef = useRef(false);
  const prevBatchRef = useRef<{ complete: boolean; hasItems: boolean } | null>(null);
  // Track manual stop so auto doesn't re-start until next batch transition
  const manualStopRef = useRef(false);
  const activeRef = useRef(false);
  activeRef.current = active;
  awakeAutoRef.current = awakeAuto;
  // #425 / quadwork#311: per-subsection header-level help popovers.
  // These replace the old `?` that lived inside the Keep Awake
  // presets popup (which disappeared while Awake was active) and
  // satisfy the ticket's "each subsection has its own (?) tooltip
  // with deeper detail" requirement for Notification Sound too.
  const [showKeepAwakeHelp, setShowKeepAwakeHelp] = useState(false);
  const [showSoundHelp, setShowSoundHelp] = useState(false);
  // #409 / quadwork#273: notification sound prefs. Hydrated from
  // localStorage on first render so the toggle/dropdown reflect the
  // value the chat panel is reading.
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(true);
  const [soundChoice, setSoundChoiceState] = useState<NotificationSoundChoice>("soft-chime");
  const [soundBgOnly, setSoundBgOnlyState] = useState<boolean>(true);
  useEffect(() => {
    setSoundEnabledState(getNotificationEnabled());
    setSoundChoiceState(getNotificationChoice());
    setSoundBgOnlyState(getNotificationBackgroundOnly());
  }, []);
  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabledState(next);
    setNotificationEnabled(next);
  };
  const updateChoice = (v: NotificationSoundChoice) => {
    setSoundChoiceState(v);
    setNotificationChoice(v);
    // Quick preview so the operator hears what they picked.
    if (soundEnabled) {
      try {
        const audio = new Audio(`/sounds/${v}.mp3`);
        audio.volume = 0.6;
        void audio.play().catch(() => {});
      } catch {}
    }
  };
  const toggleBgOnly = (v: boolean) => {
    setSoundBgOnlyState(v);
    setNotificationBackgroundOnly(v);
  };

  const poll = useCallback(() => {
    fetch("/api/caffeinate/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setActive(data.active);
        setRemaining(data.remaining);
        setPlatform(data.platform);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  const start = (seconds: number) => {
    fetch("/api/caffeinate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration: seconds }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setActive(true);
          setRemaining(seconds || null);
        }
      })
      .catch(() => {});
    setShowPresets(false);
  };

  const stop = () => {
    // #441: track manual stop so auto doesn't re-start until next batch transition
    manualStopRef.current = true;
    fetch("/api/caffeinate/stop", { method: "POST" })
      .then(() => {
        setActive(false);
        setRemaining(null);
      })
      .catch(() => {});
  };

  // #441: Auto toggle — load persisted state from config.
  // Reset all auto state on project switch so stale refs from the
  // previous project don't leak.
  useEffect(() => {
    setAwakeAuto(false);
    setAwakeAutoStatus(null);
    prevBatchRef.current = null;
    manualStopRef.current = false;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
        if (entry?.awake_auto) setAwakeAuto(true);
      })
      .catch(() => {});
  }, [projectId]);

  // #441: Toggle + persist awake_auto
  const toggleAwakeAuto = useCallback(async () => {
    const next = !awakeAuto;
    setAwakeAuto(next);
    if (!next) {
      setAwakeAutoStatus(null);
      prevBatchRef.current = null;
      manualStopRef.current = false;
    }
    try {
      const r = await fetch("/api/config");
      if (!r.ok) return;
      const cfg = await r.json();
      const entry = (cfg.projects || []).find((p: { id: string }) => p.id === projectId);
      if (entry) {
        entry.awake_auto = next;
        await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cfg),
        });
      }
    } catch { /* non-fatal */ }
  }, [awakeAuto, projectId]);

  // #441: Auto start helper — uses configured hours or 8h default
  const autoStart = useCallback(() => {
    const raw = parseFloat(hoursDraft);
    const hours = Number.isFinite(raw) ? clampKeepAwakeHours(raw) : AWAKE_AUTO_DEFAULT_HOURS;
    const seconds = Math.round(hours * 3600);
    fetch("/api/caffeinate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration: seconds }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setActive(true);
          setRemaining(seconds);
          manualStopRef.current = false;
        }
      })
      .catch(() => {});
  }, [hoursDraft]);

  // #441: Auto stop helper
  const autoStop = useCallback(() => {
    fetch("/api/caffeinate/stop", { method: "POST" })
      .then(() => {
        setActive(false);
        setRemaining(null);
      })
      .catch(() => {});
  }, []);

  // #441: Batch lifecycle polling (same pattern as ScheduledTriggerWidget)
  useEffect(() => {
    if (!awakeAuto) return;
    const check = async () => {
      if (!awakeAutoRef.current) return;
      try {
        const r = await fetch(`/api/batch-progress?project=${encodeURIComponent(projectId)}`);
        if (!r.ok) return;
        const data = await r.json();
        const hasItems = data.items.length > 0;
        const prev = prevBatchRef.current;
        prevBatchRef.current = { complete: data.complete, hasItems };

        // First poll — active batch + not already awake → auto-start
        if (!prev) {
          if (hasItems && !data.complete && !activeRef.current) {
            autoStart();
            setAwakeAutoStatus(t.awakeStatusActive);
          }
          // #462: First poll — batch already complete but caffeinate still running → auto-stop
          if (hasItems && data.complete && activeRef.current) {
            autoStop();
            setAwakeAutoStatus(t.awakeStatusComplete);
          }
          return;
        }

        // Batch just completed → auto-stop
        if (hasItems && data.complete && !prev.complete && activeRef.current) {
          autoStop();
          setAwakeAutoStatus(t.awakeStatusComplete);
          manualStopRef.current = false;
        }

        // New batch started (complete→active or empty→active) → auto-start
        if (hasItems && !data.complete && (prev.complete || !prev.hasItems) && !activeRef.current && !manualStopRef.current) {
          autoStart();
          setAwakeAutoStatus(t.awakeStatusNew);
        }
      } catch { /* non-fatal */ }
    };
    check();
    const interval = setInterval(check, AWAKE_AUTO_POLL_MS);
    return () => clearInterval(interval);
  }, [awakeAuto, projectId, autoStart, autoStop, t]);

  // #425 / quadwork#311: Keep Awake is now a standalone subsection
  // and renders even on non-darwin (the button just hides). The
  // Notification Sound subsection sits below a small divider so the
  // two controls no longer look like they share a feature.

  const showKeepAwakeSubsection = !platform || platform === "darwin";

  return (
    // #369: Keep Awake + Notification Sound now sit side-by-side at
    // md+ widths so ControlBar can present three real columns
    // (Server | Keep Mac Awake | Notification Sound) separated by
    // vertical dividers, instead of the stacked-row layout PR #345
    // landed. Below md the layout collapses back to stacked rows so
    // narrow split-views still fit. Keep Awake hides entirely on
    // non-darwin and Notification Sound takes the full subsection
    // width on its own.
    <div className="flex flex-col md:flex-row md:items-start gap-2 md:gap-6 relative">
      {showKeepAwakeSubsection && (
        <div className="flex flex-col gap-0.5 relative">
          <div className="flex items-center gap-1 text-[10px] text-text-muted uppercase tracking-wider font-semibold">
            <span>{t.keepAwake}</span>
            <button
              type="button"
              aria-label={t.keepAwakeAbout}
              onClick={() => setShowKeepAwakeHelp((s) => !s)}
              className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
            >?</button>
            {/* #441: Auto toggle — linked to batch lifecycle */}
            <button
              type="button"
              onClick={toggleAwakeAuto}
              title={awakeAuto ? t.autoAwakeOn : t.autoAwakeOff}
              className={`ml-1 px-1.5 py-0.5 text-[10px] border transition-colors ${
                awakeAuto
                  ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
                  : "border-border text-text-muted hover:text-text hover:border-accent"
              }`}
            >
              Auto {awakeAuto ? "●" : "○"}
            </button>
          </div>
          {showKeepAwakeHelp && (
            <div className="absolute left-0 top-4 z-30 w-64 p-2 text-[10px] leading-snug text-text bg-bg-surface border border-border rounded shadow-lg">
              {t.keepAwakeHelp}
            </div>
          )}
          {awakeAutoStatus && (
            <div className="text-[10px] text-accent bg-accent/5 border border-border/50 px-1.5 py-0.5 mt-0.5">
              {awakeAutoStatus}
            </div>
          )}
          <div className="text-[10px] text-text-muted leading-tight">
            {active && remaining !== null && remaining > 0
              ? t.awakeFor(formatTime(remaining))
              : active && remaining === null
                ? t.awakeIndefinitely
                : t.awakeDesc}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            <button
              onClick={() => (active ? stop() : setShowPresets(!showPresets))}
              title="Keep Mac awake (caffeinate)"
              className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
                active
                  ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
                  : "border-border text-text-muted hover:text-text hover:border-accent"
              }`}
            >
              {active ? t.awake : t.start}
              {active && remaining !== null && remaining > 0 && (
                <span className="ml-1 text-accent/70">{formatTime(remaining)}</span>
              )}
              {active && remaining === null && (
                <span className="ml-1 text-accent/70">{t.on}</span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* #369: vertical divider between Keep Awake and Notification
          Sound at md+; horizontal divider in the stacked fallback so
          the two subsections still read as distinct on narrow widths. */}
      {showKeepAwakeSubsection && (
        <div className="border-t border-border/40 md:border-t-0 md:w-px md:h-auto md:self-stretch md:bg-border" />
      )}

      {/* #409 / quadwork#273 + #425 / quadwork#311: notification sound
          is now its own subsection with an always-visible descriptor. */}
      <div className="flex flex-col gap-0.5 relative">
        <div className="flex items-center gap-1 text-[10px] text-text-muted uppercase tracking-wider font-semibold">
          <span>{t.sound}</span>
          <button
            type="button"
            aria-label={t.soundAbout}
            onClick={() => setShowSoundHelp((s) => !s)}
            className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
          >?</button>
        </div>
        {showSoundHelp && (
          <div className="absolute left-0 top-4 z-30 w-64 p-2 text-[10px] leading-snug text-text bg-bg-surface border border-border rounded shadow-lg">
            {t.soundHelp}
          </div>
        )}
        <div className="text-[10px] text-text-muted leading-tight">
          {t.soundDesc}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          <button
            type="button"
            onClick={toggleSound}
            title={soundEnabled ? "Notification sound on (click to mute)" : "Notification sound off (click to unmute)"}
            className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
              soundEnabled
                ? "border-accent/50 text-accent bg-accent/10 hover:bg-accent/20"
                : "border-border text-text-muted hover:text-text hover:border-accent"
            }`}
          >
            {soundEnabled ? "🔔" : "🔕"} {t.soundLabel}
          </button>
          {soundEnabled && (
            <select
              value={soundChoice}
              onChange={(e) => updateChoice(e.target.value as NotificationSoundChoice)}
              title="Notification sound"
              className="bg-transparent border border-border px-1 py-0.5 text-[10px] text-text outline-none focus:border-accent cursor-pointer"
            >
              {NOTIFICATION_SOUND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} className="bg-bg-surface">{o.label}</option>
              ))}
            </select>
          )}
        </div>
        {soundEnabled && (
          <label className="flex items-center gap-1 text-[10px] text-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={soundBgOnly}
              onChange={(e) => toggleBgOnly(e.target.checked)}
            />
            {t.soundBgOnly}
          </label>
        )}
      </div>

      {showPresets && !active && (
        <div className="absolute bottom-full left-0 mb-1 p-2 border border-border bg-bg-surface z-20 min-w-[220px] flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">{t.keepAwakeModalTitle}</span>
            <button
              type="button"
              aria-label={t.keepAwakeModalAbout}
              onClick={() => setShowHelp((s) => !s)}
              className="w-3.5 h-3.5 rounded-full border border-border text-[9px] leading-none text-text-muted hover:text-accent hover:border-accent inline-flex items-center justify-center"
            >?</button>
          </div>
          {showHelp && (
            <div className="p-1.5 text-[10px] leading-snug text-text bg-bg border border-border/60 rounded">
              {t.keepAwakeModalHelp}
            </div>
          )}
          <p className="text-[10px] text-[#ffcc00]">
            {t.makeSurePluggedIn}
          </p>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-text-muted">{t.for}</span>
            <input
              type="number"
              value={hoursDraft}
              onChange={(e) => setHoursDraft(e.target.value)}
              onBlur={() => {
                const raw = parseFloat(hoursDraft);
                const hours = Number.isFinite(raw) ? clampKeepAwakeHours(raw) : KEEP_AWAKE_HOURS_DEFAULT;
                setHoursDraft(String(Math.round(hours * 10) / 10));
              }}
              disabled={untilStopped}
              min={KEEP_AWAKE_HOURS_MIN}
              max={KEEP_AWAKE_HOURS_MAX}
              step={0.1}
              className="w-14 bg-transparent border border-border px-1 py-0.5 text-text outline-none focus:border-accent text-center disabled:opacity-40"
            />
            <span className="text-text-muted">{t.hours}</span>
          </div>
          <label className="flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={untilStopped}
              onChange={(e) => setUntilStopped(e.target.checked)}
            />
            {t.untilStopped}
          </label>
          <button
            type="button"
            onClick={() => {
              if (untilStopped) {
                start(0);
                return;
              }
              const raw = parseFloat(hoursDraft);
              const hours = Number.isFinite(raw) ? clampKeepAwakeHours(raw) : KEEP_AWAKE_HOURS_DEFAULT;
              start(Math.round(hours * 3600));
            }}
            className="self-start px-2 py-0.5 text-[10px] text-accent border border-accent/40 rounded hover:bg-accent/10 transition-colors"
          >
            {t.start}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main ControlBar ─────────────────────────────────────────────────────────

interface ControlBarProps {
  projectId: string;
}

export default function ControlBar({ projectId }: ControlBarProps) {
  // #210: Keep Alive moved to the Scheduled Trigger widget in the
  // bottom-right Operator Features quadrant. ControlBar now only
  // carries the server lifecycle + system controls.
  return (
    <div className="border-t border-border px-3 py-2">
      {/* #369 / quadwork#369: revert the #337 stacked-row interpretation.
          Lay out SERVER | KEEP MAC AWAKE | NOTIFICATION SOUND as three
          horizontally arranged columns separated by vertical w-px
          dividers. SystemSection internally renders the right two
          columns (Keep Awake hides on non-darwin so the row collapses
          to two columns naturally). At narrow widths (< md) the
          whole layout collapses back to stacked rows with horizontal
          dividers so cramped split-views still fit. */}
      <div className="flex flex-col md:flex-row md:items-start gap-2 md:gap-6">
        <ServerSection projectId={projectId} />
        <div className="border-t border-border/40 md:border-t-0 md:w-px md:h-auto md:self-stretch md:bg-border" />
        <SystemSection projectId={projectId} />
      </div>
    </div>
  );
}
