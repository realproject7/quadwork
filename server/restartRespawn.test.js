"use strict";

// #992: coverage for respawnActiveBatchAgents — the startup step that restores
// agents for projects that were MID-BATCH when the server restarted, while
// leaving idle projects untouched.
//
// respawnActiveBatchAgents takes a dependency-injection seam (getProgress /
// isActiveFromProgress / spawnAgentPty / agentSessions / log — defaults wire to
// the real module fns), so we drive it with stubbed side-effect-free deps and
// the REAL isBatchActiveFromProgress (via an injected getProgress that returns
// crafted progress payloads) so the actual active-batch determination is
// exercised, not mocked. spawnAgentPty is a spy — no real pty.
//
// QUADWORK_SKIP_LISTEN + a temp HOME let us require the server module for the
// exported helper without starting the server (see watchdog.test.js). Plain
// node:assert script — auto-discovered by the #836 runner.

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_HOME = path.join(os.tmpdir(), `quadwork-respawn-test-${process.pid}`);
process.env.HOME = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";
fs.mkdirSync(path.join(TMP_HOME, ".quadwork"), { recursive: true });
fs.writeFileSync(path.join(TMP_HOME, ".quadwork", "config.json"), JSON.stringify({ projects: [] }));

const assert = require("node:assert/strict");
const { respawnActiveBatchAgents } = require("./index");
const routes = require("./routes");

// The real active-batch predicate — crafted progress payloads flow through it.
const ACTIVE = { items: [{ id: 1 }], complete: false };          // → true
const IDLE_COMPLETE = { items: [{ id: 1 }], complete: true };    // → false
const IDLE_CLEARED = { liveActiveBatchCleared: true, items: [{ id: 1 }] }; // → false
// null progress → isBatchActiveFromProgress returns null (unknown)

// Sanity: our payloads mean what we think under the REAL predicate.
assert.equal(routes.isBatchActiveFromProgress(ACTIVE), true);
assert.equal(routes.isBatchActiveFromProgress(IDLE_COMPLETE), false);
assert.equal(routes.isBatchActiveFromProgress(IDLE_CLEARED), false);
assert.equal(routes.isBatchActiveFromProgress(null), null);

function spy() {
  const calls = [];
  const fn = async (projectId, agentId, opts) => { calls.push([projectId, agentId, opts]); return { ok: true, pid: 4242 }; };
  return { fn, calls };
}

const admitted = {
  isProjectArchived: () => false,
  captureProjectAdmission: (projectId) => ({ project_id: projectId, generation: 0 }),
  isAdmissionCurrent: () => true,
};

(async () => {
  // ── 1. Active-batch project → all 4 agents respawned, with suppressed
  //       lifecycle msg; decision recorded. ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "act", working_dir: "/tmp/act", agents: { head: {}, re1: {}, re2: {}, dev: {} } }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => ACTIVE, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 4, "active batch → 4 agents spawned");
    assert.deepEqual(calls.map((c) => c[1]).sort(), ["dev", "head", "re1", "re2"], "spawned head/re1/re2/dev");
    assert.equal(calls[0][0], "act", "spawn called with projectId");
    assert.ok(calls.every((c) => c[2] && c[2].suppressLifecycleMsg === true), "lifecycle msg suppressed on restore");
    assert.equal(out.decisions[0].action, "respawned");
    assert.deepEqual(out.decisions[0].agents.sort(), ["dev", "head", "re1", "re2"]);
  }

  // ── 2. Idle project (batch complete) → NOT spawned (unchanged behavior). ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "idle", working_dir: "/tmp/idle", agents: { head: {}, re1: {}, re2: {}, dev: {} } }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => IDLE_COMPLETE, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 0, "idle (complete) project → no agents spawned");
    assert.equal(out.decisions[0].action, "skip");
    assert.equal(out.decisions[0].reason, "no active batch");
  }

  // ── 2b. Idle project (Active Batch section explicitly cleared) → NOT spawned. ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "cleared", working_dir: "/tmp/cleared" }] };
    await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => IDLE_CLEARED, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 0, "cleared active-batch → no agents spawned");
  }

  // ── 3. Unknown batch state (null progress) → fail-SAFE, do NOTHING. ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "unk", working_dir: "/tmp/unk" }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => null, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 0, "null progress → never spawns (fail-safe)");
    assert.equal(out.decisions[0].reason, "batch state unknown");
  }

  // ── 4. getProgress throws → skip that project, never spawn, never crash. ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "err", working_dir: "/tmp/err" }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => { throw new Error("gh down"); }, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 0, "throwing batch-state check → no spawn");
    assert.match(out.decisions[0].reason, /batch-state check threw: gh down/);
  }

  // ── 5. Config opt-out (restart_respawn.enabled:false) → nothing spawned. ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { restart_respawn: { enabled: false }, projects: [{ id: "act", working_dir: "/tmp/act" }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => ACTIVE, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 0, "opt-out → no agents spawned even for an active batch");
    assert.equal(out.decisions.length, 0, "opt-out → no per-project decisions");
  }

  // ── 6. Idempotent: an already-live agent is NOT re-spawned; the rest are. ──
  {
    const { fn: spawn, calls } = spy();
    // A session whose term.pid is our own pid → isPtyAlive returns true.
    const sessions = new Map([["act/head", { term: { pid: process.pid } }]]);
    const cfg = { projects: [{ id: "act", working_dir: "/tmp/act", agents: { head: {}, re1: {}, re2: {}, dev: {} } }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => ACTIVE, spawnAgentPty: spawn, agentSessions: sessions, log: () => {},
    });
    assert.deepEqual(calls.map((c) => c[1]).sort(), ["dev", "re1", "re2"], "already-live head NOT re-spawned; re1/re2/dev are");
    assert.deepEqual(out.decisions[0].agents.sort(), ["dev", "re1", "re2"]);
  }

  // ── 7. A failing spawn is logged, doesn't crash, and isn't counted restored. ──
  {
    const calls = [];
    const spawn = async (pid, aid) => { calls.push(aid); return aid === "re1" ? { ok: false, error: "boom" } : { ok: true }; };
    const logs = [];
    const cfg = { projects: [{ id: "act", working_dir: "/tmp/act", agents: { head: {}, re1: {}, re2: {}, dev: {} } }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => ACTIVE, spawnAgentPty: spawn, agentSessions: new Map(), log: (m) => logs.push(m),
    });
    assert.ok(!out.decisions[0].agents.includes("re1"), "failed spawn not counted as restored");
    assert.ok(logs.some((m) => /re1: spawn failed: boom/.test(m)), "failed spawn is logged");
  }

  // ── 8. Projects without working_dir / id are ignored (no throw). ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "nowd" }, { working_dir: "/tmp/x" }, null] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => ACTIVE, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 0, "projects missing id/working_dir are skipped");
    assert.equal(out.decisions.length, 0);
  }

  // ── 9. Archive wins while batch progress is awaiting: no agent spawn. ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "archiving", working_dir: "/tmp/archiving", agents: { head: {} } }] };
    const out = await respawnActiveBatchAgents(cfg, {
      getProgress: async () => ACTIVE,
      isProjectArchived: () => false,
      captureProjectAdmission: (projectId) => ({ project_id: projectId, generation: 0 }),
      isAdmissionCurrent: () => false,
      spawnAgentPty: spawn,
      agentSessions: new Map(),
      log: () => {},
    });
    assert.equal(calls.length, 0, "archive during batch-progress await → zero startup spawn");
    assert.equal(out.decisions[0].reason, "project archived");
  }

  console.log("restartRespawn.test.js: all assertions passed (9 cases)");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
