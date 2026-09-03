"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  LIFECYCLE_FILENAME,
  createAgentLifecycleGovernor,
  projectStatePath,
} = require("./agent-lifecycle");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-agent-lifecycle-"));
process.on("exit", () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

let sequence = 0;
function uuid() {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function readySnapshot({ admitted = 0, maximum = 3 } = {}) {
  return {
    status: "ready",
    pressure: { status: "ready", reason: "ok" },
    scope_capacity: { admitted_worker_scopes: admitted, reserved_worker_scopes: maximum },
  };
}

function governor(options = {}) {
  return createAgentLifecycleGovernor({
    homeDir: home,
    platform: "darwin",
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    randomUUID: uuid,
    projectEligible: () => true,
    currentWork: async () => ({
      current: true,
      assignment: {
        assignment_key: "repo:owner/repo#42",
        assignment_attempt: "attempt-1",
        issue_contract_digest: "a".repeat(64),
      },
    }),
    ...options,
  });
}

(async () => {
  // A global serial reservation closes the "one remaining scope" race even
  // when two roles/projects call in the same event-loop turn.
  {
    const g = governor({ platform: "linux", resourceSnapshot: () => readySnapshot({ maximum: 1 }) });
    const [left, right] = await Promise.all([
      g.reserve({ projectId: "alpha", role: "dev", source: "operator_start", operatorAuthorized: true, containedLaunch: true }),
      g.reserve({ projectId: "bravo", role: "dev", source: "operator_start", operatorAuthorized: true, containedLaunch: true }),
    ]);
    assert.equal([left.status, right.status].filter((state) => state === "reserved").length, 1);
    assert.equal([left.status, right.status].filter((state) => state === "rejected").length, 1);
    assert.equal([left.reason, right.reason].filter((reason) => reason === "capacity_exhausted").length, 1);
  }

  // Linux never falls back to an uncontained PTY when #1038's live evidence
  // is candidate/unavailable. macOS remains a truthful lifecycle-only mode.
  {
    const linux = governor({ platform: "linux", resourceSnapshot: () => ({ status: "candidate_pending_staging", pressure: { reason: "staging_proof_pending" } }) });
    const rejected = await linux.reserve({ projectId: "linux", role: "dev", source: "operator_start", operatorAuthorized: true });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reason, "containment_unavailable");

    const mac = governor();
    const allowed = await mac.reserve({ projectId: "mac", role: "dev", source: "operator_start", operatorAuthorized: true });
    assert.equal(allowed.status, "reserved");
  }

  // Work-less automatic or worker starts are refused; the deliberately narrow
  // authenticated Head intake exception is still available to the operator.
  {
    const g = governor({ currentWork: async () => ({ current: false, assignment: null }) });
    const auto = await g.reserve({ projectId: "idle", role: "dev", source: "watchdog" });
    assert.equal(auto.reason, "no_current_assignment");
    const worker = await g.reserve({ projectId: "idle", role: "dev", source: "operator_start", operatorAuthorized: true });
    assert.equal(worker.reason, "no_current_assignment");
    const explicitWorker = await g.reserve({ projectId: "idle", role: "dev", source: "operator_start", operatorAuthorized: true, explicitRole: true });
    assert.equal(explicitWorker.status, "reserved");
    const head = await g.reserve({ projectId: "idle", role: "head", source: "operator_start", operatorAuthorized: true, allowHeadIntake: true });
    assert.equal(head.status, "reserved");
  }

  // Operation-id replay returns the one existing record, while stale expected
  // generation is an observation-only no-op.
  {
    const g = governor();
    const first = await g.reserve({ projectId: "idempotent", role: "dev", source: "operator_start", operatorAuthorized: true, operationId: "operator-1" });
    assert.equal(first.status, "reserved");
    const replay = await g.reserve({ projectId: "idempotent", role: "dev", source: "operator_start", operatorAuthorized: true, operationId: "operator-1" });
    assert.equal(replay.idempotent, true);
    const stale = await g.reserve({ projectId: "idempotent", role: "dev", source: "operator_start", operatorAuthorized: true, expectedGeneration: "not-current" });
    assert.equal(stale.reason, "stale_expected_generation");
  }

  // A project archive that wins while a launch callback is awaiting remains an
  // authoritative admission rejection, not a misleading generic PTY failure.
  {
    const g = governor();
    const archived = await g.launch({
      projectId: "archive-race", role: "dev", source: "operator_start", operatorAuthorized: true,
      launch: async () => ({ ok: false, code: "project_archived" }),
    });
    assert.equal(archived.status, "rejected");
    assert.equal(archived.reason, "project_archived");
    assert.equal(g.snapshot("archive-race", "dev").state, "rejected");
  }

  // A resource kill opens immediately and automatic sources cannot create a
  // hidden retry. The record retains only redacted correlation evidence.
  {
    const g = governor();
    const first = await g.reserve({ projectId: "oom", role: "dev", source: "operator_start", operatorAuthorized: true });
    const killed = await g.transition({
      projectId: "oom", role: "dev", operationId: first.operation.operation_id,
      generationId: first.operation.generation_id, status: "resource_killed", lossCorrelation: "loss-1",
    });
    assert.equal(killed.status, "resource_killed");
    const retry = await g.reserve({ projectId: "oom", role: "dev", source: "watchdog" });
    assert.equal(retry.reason, "circuit_open");
  }

  // An authenticated circuit trial names the trusted loss and its generation.
  // Repeated delivery of that same request returns the one in-flight operation
  // without ever allocating a second process. It can clear only after both a
  // real runtime observation and the structured-status confirmation.
  {
    const g = governor();
    const first = await g.reserve({ projectId: "trial", role: "dev", source: "operator_start", operatorAuthorized: true });
    await g.transition({
      projectId: "trial", role: "dev", operationId: first.operation.operation_id,
      generationId: first.operation.generation_id, status: "resource_killed", lossCorrelation: "loss-trial",
    });
    const trial = await g.reserve({
      projectId: "trial", role: "dev", source: "operator_restart", operatorAuthorized: true,
      expectedGeneration: first.operation.generation_id, lossCorrelation: "loss-trial",
    });
    assert.equal(trial.status, "reserved");
    const duplicate = await g.reserve({
      projectId: "trial", role: "dev", source: "operator_restart", operatorAuthorized: true,
      expectedGeneration: first.operation.generation_id, lossCorrelation: "loss-trial",
    });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.operation.operation_id, trial.operation.operation_id);
    await g.transition({
      projectId: "trial", role: "dev", operationId: trial.operation.operation_id,
      generationId: trial.operation.generation_id, status: "verified",
    });
    assert.equal(g.snapshot("trial", "dev").circuit.open, true);
    await g.transition({
      projectId: "trial", role: "dev", operationId: trial.operation.operation_id,
      generationId: trial.operation.generation_id, status: "verified", structuredStatus: true,
    });
    assert.equal(g.snapshot("trial", "dev").circuit.open, false);
  }

  // One automatic early-exit retry is permitted. A second identical automatic
  // recovery opens the circuit without constructing another generation.
  {
    const g = governor();
    const first = await g.reserve({ projectId: "early", role: "dev", source: "operator_start", operatorAuthorized: true });
    await g.transition({ projectId: "early", role: "dev", operationId: first.operation.operation_id, generationId: first.operation.generation_id, status: "exited" });
    const once = await g.reserve({ projectId: "early", role: "dev", source: "watchdog" });
    assert.equal(once.status, "reserved");
    await g.transition({ projectId: "early", role: "dev", operationId: once.operation.operation_id, generationId: once.operation.generation_id, status: "exited" });
    const repeated = await g.reserve({ projectId: "early", role: "dev", source: "watchdog" });
    assert.equal(repeated.reason, "circuit_open");
  }

  // State survives a fresh governor instance with mode-0600 persistence and
  // exposes no command, terminal, environment, or worktree data.
  {
    const first = governor();
    const reserved = await first.reserve({ projectId: "persist", role: "dev", source: "operator_start", operatorAuthorized: true });
    const filePath = projectStatePath(home, "persist");
    assert.equal(path.basename(filePath), LIFECYCLE_FILENAME);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    const restarted = governor();
    const snapshot = restarted.snapshot("persist", "dev");
    assert.equal(snapshot.operation_id, reserved.operation.operation_id);
    assert.equal(JSON.stringify(snapshot).includes("command"), false);
    assert.equal(JSON.stringify(snapshot).includes("TMPDIR"), false);
    const reconciled = await restarted.reserve({ projectId: "persist", role: "dev", source: "operator_start", operatorAuthorized: true, liveSession: false });
    assert.equal(reconciled.status, "reserved");
    assert.notEqual(reconciled.operation.generation_id, reserved.operation.generation_id);
  }

  console.log("agent-lifecycle.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
