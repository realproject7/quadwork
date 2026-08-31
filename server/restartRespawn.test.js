"use strict";

// #992: coverage for respawnActiveBatchAgents — the startup step that restores
// agents for projects that were MID-BATCH when the server restarted, while
// leaving idle projects untouched.
//
// respawnActiveBatchAgents takes dependency-injection seams for observations,
// current-assignment revalidation, and PTY mutation. Crafted payloads still
// flow through the real batchAutomationState join; only the live queue lookup
// behind isBatchAutomationCurrent is stubbed. spawnAgentPty is a spy — no PTY.
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

const REF = { repo_key: "repo", repo: "Acme/Repo", number: 42, kind: "issue" };
const V2_IDENTITY = {
  installation_id: "installation_0000000000000001",
  batch_number: 12,
  assignment_attempt: "attempt_1",
  provenance: "owned",
  assignment_key: "assignment-key-12",
};
const V2_ITEM = { work_item_ref: REF, ownership_key: "ownership-key-42" };
const ACTIVE = {
  admission_generation: 0,
  batch_observation_fingerprint: "v2-observation-restart-12",
  ...V2_IDENTITY,
  current: true,
  owned: true,
  multi_repository: false,
  compatibility_mode: "v2",
  assignment_items: [V2_ITEM],
  items: [{
    ...V2_IDENTITY,
    current: true,
    owned: true,
    repo_key: REF.repo_key,
    repo: REF.repo,
    number: REF.number,
    kind: REF.kind,
    work_item_ref: REF,
    ownership_key: V2_ITEM.ownership_key,
  }],
  complete: false,
  completeConfirmed: false,
};
const IDLE_COMPLETE = { ...ACTIVE, complete: true, completeConfirmed: true };
const IDLE_CLEARED = {
  ...ACTIVE,
  current: false,
  assignment_items: [],
  items: [],
  complete: false,
  completeConfirmed: false,
  liveActiveBatchCleared: true,
};
const ACTIVE_V1 = {
  admission_generation: 0,
  compatibility_mode: "v1",
  provenance: "legacy_unowned",
  owned: false,
  current: true,
  multi_repository: false,
  batch_observation_fingerprint: "legacy-observation-restart-3",
  installation_id: null,
  batch_number: 3,
  assignment_attempt: null,
  assignment_key: null,
  assignment_items: [],
  items: [{
    provenance: "legacy_unowned",
    owned: false,
    current: true,
    batch_number: 3,
    repo_key: REF.repo_key,
    repo: REF.repo,
    number: REF.number,
    kind: REF.kind,
    work_item_ref: REF,
  }],
  complete: false,
  completeConfirmed: false,
};

function spy() {
  const calls = [];
  const fn = async (projectId, agentId, opts) => { calls.push([projectId, agentId, opts]); return { ok: true, pid: 4242 }; };
  return { fn, calls };
}

const admitted = {
  isProjectArchived: () => false,
  captureProjectAdmission: (projectId) => ({ project_id: projectId, generation: 0 }),
  isAdmissionCurrent: () => true,
  isBatchAutomationCurrent: () => true,
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

  // ── 2c. Explicit pre-activation V1 compatibility remains restorable. ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "v1", working_dir: "/tmp/v1", agents: { head: {} } }] };
    await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => ACTIVE_V1, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 1, "explicit V1 compatibility batch → agent restored");
  }

  // ── 3. Unknown/malformed authority → fail-SAFE, do NOTHING. ──
  {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: "unk", working_dir: "/tmp/unk" }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => null, spawnAgentPty: spawn, agentSessions: new Map(), log: () => {},
    });
    assert.equal(calls.length, 0, "null progress → never spawns (fail-safe)");
    assert.equal(out.decisions[0].reason, "batch assignment not authoritative");
  }

  // Activated V2 foreign/stale, unowned, malformed, and sticky snapshots have
  // no startup wake authority even when they contain a non-complete item.
  for (const [label, progress, current] of [
    ["foreign", { ...ACTIVE, installation_id: "installation_foreign" }, false],
    ["stale", ACTIVE, false],
    ["unowned", { ...ACTIVE, provenance: "legacy_unowned", owned: false }, true],
    ["malformed", { ...ACTIVE, assignment_items: [] }, true],
    ["sticky", { ...ACTIVE, current: false }, true],
  ]) {
    const { fn: spawn, calls } = spy();
    const cfg = { projects: [{ id: label, working_dir: `/tmp/${label}`, agents: { head: {} } }] };
    await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => progress,
      isBatchAutomationCurrent: () => current,
      spawnAgentPty: spawn,
      agentSessions: new Map(),
      log: () => {},
    });
    assert.equal(calls.length, 0, `${label} assignment → zero startup respawn`);
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

  // ── 10. Assignment rollover after observation but before the first
  //         session mutation is revalidated and produces zero respawn. ──
  {
    const { fn: spawn, calls } = spy();
    let checks = 0;
    const cfg = { projects: [{ id: "rollover", working_dir: "/tmp/rollover", agents: { head: {}, dev: {} } }] };
    const out = await respawnActiveBatchAgents(cfg, {
      ...admitted,
      getProgress: async () => ACTIVE,
      isBatchAutomationCurrent: () => ++checks === 1,
      spawnAgentPty: spawn,
      agentSessions: new Map(),
      log: () => {},
    });
    assert.equal(checks, 2, "assignment checked after observation and again before mutation");
    assert.equal(calls.length, 0, "rollover before first session mutation → zero respawn");
    assert.deepEqual(out.decisions[0].agents, []);
  }

  console.log("restartRespawn.test.js: all assertions passed (10 groups)");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
