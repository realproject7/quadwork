"use strict";

// #924: automated coverage for the watchdog auto-respawn INTEGRATION path
// (#910/#916). The pure primitives (isPtyAlive, selfHeal.shouldRespawn) already
// have unit tests; this exercises watchdogCheck's orchestration — probe -> mark
// -> respawn, the manual-stop exclusion, the idle-project skip, and the breaker
// wiring — which was previously "verified by reading" only.
//
// watchdogCheck takes a dependency-injection seam (defaults -> real module fns),
// so we drive it with a fake agentSessions map + stubbed side-effecting deps.
// isPtyAlive and markSessionExited are the REAL functions (isPtyAlive is
// controlled via pids: our own pid = alive, a nonexistent pid = dead), so the
// probe -> mark wiring is tested end-to-end, not mocked.
//
// QUADWORK_SKIP_LISTEN + a temp HOME let us require the server module for the
// exported helper without starting the server (see #905/#910). Plain
// node:assert script — auto-discovered by the #836 runner.

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_HOME = path.join(os.tmpdir(), `quadwork-watchdog-test-${process.pid}`);
process.env.HOME = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";
fs.mkdirSync(path.join(TMP_HOME, ".quadwork"), { recursive: true });
fs.writeFileSync(path.join(TMP_HOME, ".quadwork", "config.json"), JSON.stringify({ projects: [] }));

const { watchdogCheck, isPtyAlive, markSessionExited } = require("./index");

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

const DEAD_PID = 2147483646; // not a live process → isPtyAlive returns false

// A standing session object shaped like the real agentSessions entries.
function session(over = {}) {
  const s = {
    projectId: "proj",
    agentId: "dev",
    term: { pid: process.pid }, // alive by default (our own pid)
    state: "running",
    lastOutputAt: 0,
    error: null,
    viewers: new Set(),
    exitedUnexpectedly: undefined,
  };
  return Object.assign(s, over);
}

function sessionsOf(...entries) {
  const m = new Map();
  for (const s of entries) m.set(`${s.projectId}/${s.agentId}`, s);
  return m;
}

// Stubbed, side-effect-free deps; isPtyAlive + markSessionExited are real.
function makeDeps(over = {}) {
  const calls = { spawn: [], emit: [], err: [], shouldRespawn: [] };
  const deps = {
    isPtyAlive,
    markSessionExited,
    getProjectChatMode: () => "shim",
    safeWrite: () => true,
    isProjectIdleId: () => false,
    isProjectArchived: () => false,
    captureProjectAdmission: (projectId) => ({ project_id: projectId, generation: 0 }),
    isAdmissionCurrent: () => true,
    shouldRespawn: (key, opts) => { calls.shouldRespawn.push([key, opts]); return "respawn"; },
    spawnAgentPty: async (pid, aid, opts) => { calls.spawn.push([pid, aid, opts]); return { ok: true, pid: 4242 }; },
    emitSystemMessage: (pid, msg) => calls.emit.push([pid, msg]),
    now: () => 1000,
    log: () => {},
    errorLog: (m) => calls.err.push(m),
    ...over,
  };
  return { deps, calls };
}

(async () => {
  // ── 1. probe -> mark -> respawn in ONE cycle: a session reads `running` but
  //     its PTY process is dead → marked stopped (probe), then auto-respawned
  //     (non-idle), all in a single watchdogCheck pass. ──
  {
    const s = session({ term: { pid: DEAD_PID }, exitedUnexpectedly: undefined });
    const sessions = sessionsOf(s);
    const { deps, calls } = makeDeps({ agentSessions: sessions });
    await watchdogCheck(deps);
    assert(s.state === "stopped", "probe: dead-pid running session is marked stopped");
    assert(s.term === null, "probe: stale term cleared");
    assert(calls.spawn.length === 1, "respawn: marked-exited session is respawned in the same cycle");
    assert(calls.spawn[0][0] === "proj" && calls.spawn[0][1] === "dev", "respawn: spawn called with (projectId, agentId)");
    assert(calls.spawn[0][2] && calls.spawn[0][2].suppressLifecycleMsg === true, "respawn: spawn suppresses the join lifecycle message");
    assert(s.exitedUnexpectedly === false, "respawn: the exitedUnexpectedly flag is consumed");
    assert(calls.emit.some(([, m]) => /auto-respawned/.test(m)), "respawn: emits the 'auto-respawned' system message");
  }

  // ── 2. manual-stop exclusion: a session the operator stopped has
  //     exitedUnexpectedly=false → never collected, never respawned. ──
  {
    const s = session({ state: "stopped", term: null, exitedUnexpectedly: false });
    const sessions = sessionsOf(s);
    const { deps, calls } = makeDeps({ agentSessions: sessions });
    await watchdogCheck(deps);
    assert(calls.spawn.length === 0, "manual-stop: operator-stopped agent is NOT respawned");
    assert(s.exitedUnexpectedly === false, "manual-stop: flag stays false");
  }

  // ── 3. idle-project skip: an exited agent in a parked/idle project is left
  //     stopped (not respawned), and its flag is NOT consumed (so it can respawn
  //     once the project is un-parked). ──
  {
    const s = session({ state: "stopped", term: null, exitedUnexpectedly: true });
    const sessions = sessionsOf(s);
    const { deps, calls } = makeDeps({ agentSessions: sessions, isProjectIdleId: () => true });
    await watchdogCheck(deps);
    assert(calls.spawn.length === 0, "idle-skip: exited agent in an idle project is NOT respawned");
    assert(s.exitedUnexpectedly === true, "idle-skip: flag preserved (respawnable once un-parked)");
    assert(calls.shouldRespawn.length === 0, "idle-skip: breaker is not even consulted for an idle project");
  }

  // ── 4. breaker wiring: when shouldRespawn returns 'breaker', the agent is
  //     left stopped (no spawn) and the one-shot notify fires via onBreaker. ──
  {
    const s = session({ state: "stopped", term: null, exitedUnexpectedly: true });
    const sessions = sessionsOf(s);
    const { deps, calls } = makeDeps({
      agentSessions: sessions,
      shouldRespawn: (key, opts) => { calls.shouldRespawn.push([key, opts]); if (opts.onBreaker) opts.onBreaker("paused — manual attention needed"); return "breaker"; },
    });
    await watchdogCheck(deps);
    assert(calls.spawn.length === 0, "breaker: tripped breaker leaves the agent stopped (no respawn)");
    assert(calls.emit.some(([, m]) => /manual attention/.test(m)), "breaker: onBreaker emits the notify message");
    assert(s.exitedUnexpectedly === true, "breaker: flag NOT consumed when the breaker trips (so it re-attempts after the window)");
    assert(typeof calls.shouldRespawn[0][1].now === "number", "breaker: shouldRespawn is passed a numeric `now` (window math can't silently break)");
  }

  // ── 5. clean exit, non-idle → respawned + 'auto-respawned' message (the
  //     onExit path, where markSessionExited already ran without a probe). ──
  {
    const s = session({ state: "stopped", term: null, exitedUnexpectedly: true });
    const sessions = sessionsOf(s);
    const { deps, calls } = makeDeps({ agentSessions: sessions });
    await watchdogCheck(deps);
    assert(calls.spawn.length === 1, "clean-exit: a cleanly-exited non-idle agent is respawned");
    assert(s.exitedUnexpectedly === false, "clean-exit: flag consumed");
  }

  // ── 6. spawn failure is logged, not thrown, and the flag stays consumed
  //     (one attempt per exit). ──
  {
    const s = session({ state: "stopped", term: null, exitedUnexpectedly: true });
    const sessions = sessionsOf(s);
    const { deps, calls } = makeDeps({
      agentSessions: sessions,
      spawnAgentPty: async () => ({ ok: false, error: "registration failed" }),
    });
    await watchdogCheck(deps); // must not throw
    assert(calls.err.some((m) => /auto-respawn failed/.test(m)), "spawn-fail: failure is logged via errorLog");
    assert(calls.emit.every(([, m]) => !/auto-respawned/.test(m)), "spawn-fail: no 'auto-respawned' message on failure");
    assert(s.exitedUnexpectedly === false, "spawn-fail: flag consumed (one attempt per exit, not loop-retried)");
  }

  // ── 7. healthy running agent (alive pid, recent output) → untouched: not
  //     marked stopped, not respawned. ──
  {
    const s = session({ term: { pid: process.pid }, lastOutputAt: 999, state: "running" });
    const sessions = sessionsOf(s);
    const { deps, calls } = makeDeps({ agentSessions: sessions }); // now()=1000, so 1ms since output
    await watchdogCheck(deps);
    assert(s.state === "running", "healthy: a live running agent stays running (probe doesn't mark it)");
    assert(calls.spawn.length === 0, "healthy: a live running agent is not respawned");
  }

  // ── 8. stuck-agent Ctrl+C nudge: running + alive + no output past the 10m
  //     threshold (non-file chat) → write \x03, no respawn. ──
  {
    const s = session({ term: { pid: process.pid }, lastOutputAt: 1, state: "running" });
    const sessions = sessionsOf(s);
    const writes = [];
    const { deps, calls } = makeDeps({
      agentSessions: sessions,
      safeWrite: (term, data) => { writes.push(data); return true; },
      now: () => 11 * 60 * 1000, // 11m since lastOutputAt:1 → past the 10m threshold
    });
    await watchdogCheck(deps);
    assert(writes.includes("\x03"), "stuck: a silent-past-threshold running agent gets a Ctrl+C nudge");
    assert(s.state === "running", "stuck: nudged agent stays running (not respawned)");
    assert(calls.spawn.length === 0, "stuck: nudge path does not respawn");
  }

  // ── 9. file-chat projects are exempt from the stuck nudge (idle is normal). ──
  {
    const s = session({ term: { pid: process.pid }, lastOutputAt: 1, state: "running" });
    const sessions = sessionsOf(s);
    const writes = [];
    const { deps } = makeDeps({
      agentSessions: sessions,
      getProjectChatMode: () => "file",
      safeWrite: (term, data) => { writes.push(data); return true; },
      now: () => 11 * 60 * 1000,
    });
    await watchdogCheck(deps);
    assert(!writes.includes("\x03"), "file-chat: silent agent is NOT nudged (PTY dispatch wakes it)");
  }

  // ── 10. Archived projects are entirely inert: no liveness mutation,
  //        Ctrl+C nudge, breaker decision, or respawn. ──
  {
    const s = session({ state: "stopped", term: null, exitedUnexpectedly: true });
    const sessions = sessionsOf(s);
    const writes = [];
    const { deps, calls } = makeDeps({
      agentSessions: sessions,
      isProjectArchived: () => true,
      safeWrite: (_term, data) => { writes.push(data); return true; },
    });
    await watchdogCheck(deps);
    assert(calls.spawn.length === 0, "#1034 archived: watchdog never respawns an agent");
    assert(calls.shouldRespawn.length === 0, "#1034 archived: respawn breaker is not consulted");
    assert(writes.length === 0, "#1034 archived: watchdog never writes to PTY");
    assert(s.exitedUnexpectedly === true, "#1034 archived: stopped state stays untouched");
  }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
