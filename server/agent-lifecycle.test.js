"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  LIFECYCLE_FILENAME,
  MAX_HEAD_TRIALS_PER_ASSIGNMENT,
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

  // #1044: the server-assigned `head_recovery` source may take the single
  // explicit circuit trial when it names the open circuit's loss correlation
  // and current expected generation.  A duplicate observes the live trial,
  // automatic sources stay refused throughout, a failed Head trial cannot be
  // chained by Head, and only a fresh operator action authorizes another.
  {
    const g = governor();
    const first = await g.reserve({ projectId: "headtrial", role: "dev", source: "operator_start", operatorAuthorized: true });
    await g.transition({
      projectId: "headtrial", role: "dev", operationId: first.operation.operation_id,
      generationId: first.operation.generation_id, status: "resource_killed", lossCorrelation: "loss-head",
    });
    assert.equal((await g.reserve({ projectId: "headtrial", role: "dev", source: "watchdog" })).reason, "circuit_open");
    const wrongGeneration = await g.reserve({ projectId: "headtrial", role: "dev", source: "head_recovery", expectedGeneration: "not-the-lost-one", lossCorrelation: "loss-head" });
    assert.equal(wrongGeneration.reason, "circuit_open");
    const wrongLoss = await g.reserve({ projectId: "headtrial", role: "dev", source: "head_recovery", expectedGeneration: first.operation.generation_id, lossCorrelation: "loss-other" });
    assert.equal(wrongLoss.reason, "circuit_open");
    const trial = await g.reserve({ projectId: "headtrial", role: "dev", source: "head_recovery", expectedGeneration: first.operation.generation_id, lossCorrelation: "loss-head" });
    assert.equal(trial.status, "reserved");
    assert.equal(trial.operation.circuit.open, true);
    assert.equal(trial.operation.circuit.trial_operation_id, trial.operation.operation_id);
    assert.equal(trial.operation.circuit.head_trial_operation_id, trial.operation.operation_id);
    assert.equal(trial.operation.circuit.automatic_retries, 0, "the explicit trial is not an automatic retry");
    const duplicate = await g.reserve({ projectId: "headtrial", role: "dev", source: "head_recovery", expectedGeneration: first.operation.generation_id, lossCorrelation: "loss-head" });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.operation.operation_id, trial.operation.operation_id);
    for (const source of ["watchdog", "startup_restore", "self_heal", "reseed"]) {
      const automatic = await g.reserve({ projectId: "headtrial", role: "dev", source, expectedGeneration: first.operation.generation_id, lossCorrelation: "loss-head" });
      assert.equal(automatic.reason, "circuit_open", `${source} is refused while the Head trial is live`);
    }
    assert.equal(g.snapshot("headtrial", "dev").operation_id, trial.operation.operation_id, "no second process was reserved");
    await g.transition({ projectId: "headtrial", role: "dev", operationId: trial.operation.operation_id, generationId: trial.operation.generation_id, status: "spawned" });
    await g.transition({ projectId: "headtrial", role: "dev", operationId: trial.operation.operation_id, generationId: trial.operation.generation_id, status: "exited" });
    const afterFailure = g.snapshot("headtrial", "dev");
    assert.equal(afterFailure.circuit.open, true);
    assert.equal(afterFailure.circuit.expected_generation, trial.operation.generation_id);
    assert.equal(afterFailure.circuit.trial_operation_id, null);
    assert.equal(afterFailure.circuit.head_trial_operation_id, trial.operation.operation_id);
    const chained = await g.reserve({ projectId: "headtrial", role: "dev", source: "head_recovery", expectedGeneration: trial.operation.generation_id, lossCorrelation: "loss-head" });
    assert.equal(chained.reason, "head_trial_consumed");
    assert.equal((await g.reserve({ projectId: "headtrial", role: "dev", source: "watchdog" })).reason, "circuit_open");
    const operator = await g.reserve({ projectId: "headtrial", role: "dev", source: "operator_restart", operatorAuthorized: true, expectedGeneration: trial.operation.generation_id, lossCorrelation: "loss-head" });
    assert.equal(operator.status, "reserved");
    assert.equal(operator.operation.circuit.trial_operation_id, operator.operation.operation_id);
    await g.transition({ projectId: "headtrial", role: "dev", operationId: operator.operation.operation_id, generationId: operator.operation.generation_id, status: "verified", structuredStatus: true });
    const cleared = g.snapshot("headtrial", "dev").circuit;
    assert.equal(cleared.open, false);
    assert.equal(cleared.head_trial_operation_id, null);
  }

  // #1073: a Head trial whose generation posts and then crashes clears the
  // circuit exactly like a healthy post, but Head's trials are budgeted per
  // assignment identity: at most MAX_HEAD_TRIALS_PER_ASSIGNMENT (= 1) over
  // every failure signature that assignment's circuits re-open with, so
  // alternating resource_killed / early_exit cannot re-arm Head.  The budget
  // resets on exactly two boundaries: a circuit of a different assignment
  // identity, and an operator trial that clears the circuit.  A failed
  // operator trial, banner-only bytes, restarts, and Head's own post do not.
  {
    assert.equal(MAX_HEAD_TRIALS_PER_ASSIGNMENT, 1, "the documented cap");
    const g = governor();
    const ids = (r) => ({ projectId: "postcrash", role: "dev", operationId: r.operation.operation_id, generationId: r.operation.generation_id });
    const headTrial = (lost, correlation) => g.reserve({ projectId: "postcrash", role: "dev", source: "head_recovery", expectedGeneration: lost.operation.generation_id, lossCorrelation: correlation });
    const operatorTrial = (lost, correlation) => g.reserve({ projectId: "postcrash", role: "dev", source: "operator_restart", operatorAuthorized: true, expectedGeneration: lost.operation.generation_id, lossCorrelation: correlation });
    const watchdog = () => g.reserve({ projectId: "postcrash", role: "dev", source: "watchdog" });
    const post = (r) => g.transition({ ...ids(r), status: "verified", structuredStatus: true });
    // Crash by early exit: the closed circuit admits one automatic retry,
    // which exits, and the next automatic attempt re-opens on early_exit.
    const crashByEarlyExit = async (r) => {
      await g.transition({ ...ids(r), status: "exited" });
      const retry = await watchdog();
      assert.equal(retry.status, "reserved");
      await g.transition({ ...ids(retry), status: "exited" });
      const opened = await watchdog();
      assert.equal(opened.reason, "circuit_open");
      return { lost: retry, correlation: opened.operation.circuit.loss_correlation };
    };
    const first = await g.reserve({ projectId: "postcrash", role: "dev", source: "operator_start", operatorAuthorized: true });
    const killed = await g.transition({ ...ids(first), status: "resource_killed" });
    const R = killed.operation.circuit.loss_correlation;
    assert.match(R, /^[a-f0-9]{32}:resource_killed$/);

    // Head's one trial: banner bytes leave it open and consumed; the post
    // clears everything except the budget, which persists.
    const trial = await headTrial(first, R);
    assert.equal(trial.status, "reserved");
    assert.equal(trial.operation.circuit.head_trials, MAX_HEAD_TRIALS_PER_ASSIGNMENT, "the trial spends the whole budget");
    assert.match(trial.operation.circuit.head_trial_assignment, /^[a-f0-9]{32}:head_trial$/);
    const budget = trial.operation.circuit.head_trial_assignment;
    await g.transition({ ...ids(trial), status: "spawned" });
    await g.transition({ ...ids(trial), status: "verified" });
    assert.equal(g.snapshot("postcrash", "dev").circuit.open, true, "first PTY bytes do not clear");
    const posted = await post(trial);
    assert.deepEqual({ ...posted.operation.circuit }, {
      open: false, reason: null, automatic_retries: 0, loss_correlation: null, expected_generation: null,
      trial_operation_id: null, head_trial_operation_id: null, head_trial_assignment: budget, head_trials: 1,
    });
    assert.deepEqual([governor().snapshot("postcrash", "dev").circuit.head_trial_assignment, governor().snapshot("postcrash", "dev").circuit.head_trials], [budget, 1], "the budget is persisted");

    // Alternating signatures on the one assignment: R -> E -> R.
    const early = await crashByEarlyExit(trial);
    const E = early.correlation;
    assert.match(E, /^[a-f0-9]{32}:early_exit$/);
    assert.notEqual(E, R);
    assert.equal(E.slice(0, 32), R.slice(0, 32), "same assignment, different signature");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      assert.equal((await headTrial(early.lost, E)).reason, "head_trial_consumed", `E attempt ${attempt}: the budget spent on R covers E`);
    }
    assert.equal((await governor().reserve({ projectId: "postcrash", role: "dev", source: "head_recovery", expectedGeneration: early.lost.operation.generation_id, lossCorrelation: E })).reason, "head_trial_consumed", "nor after a restart");
    assert.equal(g.snapshot("postcrash", "dev").operation_id, early.lost.operation.operation_id, "no process was reserved");
    assert.equal((await watchdog()).reason, "circuit_open");
    // Operator takes E's trial, posts, and is then killed: back on R.
    const clearingOperator = await operatorTrial(early.lost, E);
    assert.equal(clearingOperator.status, "reserved");
    await g.transition({ ...ids(clearingOperator), status: "spawned" });
    const clearedByOperator = await post(clearingOperator);
    assert.deepEqual([clearedByOperator.operation.circuit.open, clearedByOperator.operation.circuit.head_trial_assignment, clearedByOperator.operation.circuit.head_trials], [false, null, 0], "an operator's clearing trial resets the budget");
    const killedAgain = await g.transition({ ...ids(clearingOperator), status: "resource_killed" });
    assert.equal(killedAgain.operation.circuit.loss_correlation, R);
    const second = await headTrial(clearingOperator, R);
    assert.equal(second.status, "reserved", "the reset budget admits Head on R");
    assert.deepEqual([second.operation.circuit.head_trial_assignment, second.operation.circuit.head_trials], [budget, 1]);
    await g.transition({ ...ids(second), status: "spawned" });
    await post(second);
    const earlyAgain = await crashByEarlyExit(second);
    assert.equal(earlyAgain.correlation, E);
    assert.equal((await headTrial(earlyAgain.lost, E)).reason, "head_trial_consumed", "R -> post -> E: refused");
    // The required regression from the review, in one unbroken run: on this
    // assignment, R -> Head trial + post -> E -> Head trial + post -> R must
    // refuse the third Head reservation without spawning.
    const failedOperator = await operatorTrial(earlyAgain.lost, E);
    await g.transition({ ...ids(failedOperator), status: "spawned" });
    await g.transition({ ...ids(failedOperator), status: "exited" });
    assert.equal((await headTrial(failedOperator, E)).reason, "head_trial_consumed", "a failed operator trial does not reset the budget");
    const resetOperator = await operatorTrial(failedOperator, E);
    await g.transition({ ...ids(resetOperator), status: "spawned" });
    await post(resetOperator);
    const r1 = await g.transition({ ...ids(resetOperator), status: "resource_killed" });
    assert.equal(r1.operation.circuit.loss_correlation, R);
    const firstHead = await headTrial(resetOperator, R);
    assert.equal(firstHead.status, "reserved", "R: first Head trial");
    await g.transition({ ...ids(firstHead), status: "spawned" });
    await post(firstHead);
    const e1 = await crashByEarlyExit(firstHead);
    assert.equal(e1.correlation, E);
    assert.equal((await headTrial(e1.lost, E)).reason, "head_trial_consumed", "E: second Head trial refused by the assignment budget");
  }

  // #1073 regression exactly as reproduced on review: one assignment, a fresh
  // governor, R -> Head trial + post -> E -> Head trial + post -> R.  The
  // third Head reservation must be refused and must not create a process.
  {
    const g = governor();
    const P = "alternate";
    const ids = (r) => ({ projectId: P, role: "dev", operationId: r.operation.operation_id, generationId: r.operation.generation_id });
    const head = (lost, correlation) => g.reserve({ projectId: P, role: "dev", source: "head_recovery", expectedGeneration: lost.operation.generation_id, lossCorrelation: correlation });
    const first = await g.reserve({ projectId: P, role: "dev", source: "operator_start", operatorAuthorized: true });
    const R = (await g.transition({ ...ids(first), status: "resource_killed" })).operation.circuit.loss_correlation;
    const firstHead = await head(first, R);
    assert.equal(firstHead.status, "reserved", "first_head");
    await g.transition({ ...ids(firstHead), status: "spawned" });
    await g.transition({ ...ids(firstHead), status: "verified", structuredStatus: true });
    await g.transition({ ...ids(firstHead), status: "exited" });
    const retry = await g.reserve({ projectId: P, role: "dev", source: "watchdog" });
    await g.transition({ ...ids(retry), status: "exited" });
    const openedE = await g.reserve({ projectId: P, role: "dev", source: "watchdog" });
    const E = openedE.operation.circuit.loss_correlation;
    assert.match(E, /:early_exit$/);
    const secondHead = await head(retry, E);
    assert.equal(secondHead.reason, "head_trial_consumed", "second_head on E is already over the per-assignment cap");
    // Let an operator spend E instead so the sequence reaches R again with a
    // Head trial having posted on the way (the reviewer's exact shape has the
    // second Head trial admitted; under the cap it is refused here, and the
    // operator path is the only way to continue).
    const operatorE = await g.reserve({ projectId: P, role: "dev", source: "operator_restart", operatorAuthorized: true, expectedGeneration: retry.operation.generation_id, lossCorrelation: E });
    assert.equal(operatorE.status, "reserved");
    await g.transition({ ...ids(operatorE), status: "spawned" });
    await g.transition({ ...ids(operatorE), status: "verified", structuredStatus: true });
    const backToR = await g.transition({ ...ids(operatorE), status: "resource_killed" });
    assert.equal(backToR.operation.circuit.loss_correlation, R, "back_to_R");
    const thirdHead = await head(operatorE, R);
    assert.equal(thirdHead.status, "reserved", "operator's clearing trial re-armed Head for R");
    await g.transition({ ...ids(thirdHead), status: "spawned" });
    await g.transition({ ...ids(thirdHead), status: "verified", structuredStatus: true });
    await g.transition({ ...ids(thirdHead), status: "exited" });
    const retry2 = await g.reserve({ projectId: P, role: "dev", source: "watchdog" });
    await g.transition({ ...ids(retry2), status: "exited" });
    assert.equal((await g.reserve({ projectId: P, role: "dev", source: "watchdog" })).operation.circuit.loss_correlation, E);
    const fourthHead = await head(retry2, E);
    assert.equal(fourthHead.reason, "head_trial_consumed", "R spent by Head -> E refused: the flip never re-arms");
    assert.equal(g.snapshot(P, "dev").operation_id, retry2.operation.operation_id, "no process for the refused reservation");
    // The other direction: Head spends the budget on E, posts, is killed, and
    // R re-opens.  Refused, no process.
    const operatorE2 = await g.reserve({ projectId: P, role: "dev", source: "operator_restart", operatorAuthorized: true, expectedGeneration: retry2.operation.generation_id, lossCorrelation: E });
    await g.transition({ ...ids(operatorE2), status: "spawned" });
    await g.transition({ ...ids(operatorE2), status: "verified", structuredStatus: true });
    await g.transition({ ...ids(operatorE2), status: "exited" });
    const retry3 = await g.reserve({ projectId: P, role: "dev", source: "watchdog" });
    await g.transition({ ...ids(retry3), status: "exited" });
    assert.equal((await g.reserve({ projectId: P, role: "dev", source: "watchdog" })).operation.circuit.loss_correlation, E);
    const headOnE = await head(retry3, E);
    assert.equal(headOnE.status, "reserved", "E: Head trial on the operator-reset budget");
    await g.transition({ ...ids(headOnE), status: "spawned" });
    await g.transition({ ...ids(headOnE), status: "verified", structuredStatus: true });
    assert.equal((await g.transition({ ...ids(headOnE), status: "resource_killed" })).operation.circuit.loss_correlation, R);
    assert.equal((await head(headOnE, R)).reason, "head_trial_consumed", "E spent by Head -> R refused: the flip never re-arms");
    assert.equal(g.snapshot(P, "dev").operation_id, headOnE.operation.operation_id, "no process for the refused reservation");
  }

  // #1073 reset boundary 1: a different assignment identity is a different
  // budget.  After Head's trial posted and ran to the end of its work, a
  // loss on the next assignment opens a circuit whose budget starts empty.
  {
    let key = "repo:owner/repo#42";
    const g = governor({ currentWork: async () => ({ current: true, assignment: { assignment_key: key, assignment_attempt: "attempt-1", issue_contract_digest: null } }) });
    const ids = (r) => ({ projectId: "nextwork", role: "dev", operationId: r.operation.operation_id, generationId: r.operation.generation_id });
    const first = await g.reserve({ projectId: "nextwork", role: "dev", source: "operator_start", operatorAuthorized: true });
    const killed = await g.transition({ ...ids(first), status: "resource_killed" });
    const trial = await g.reserve({ projectId: "nextwork", role: "dev", source: "head_recovery", expectedGeneration: first.operation.generation_id, lossCorrelation: killed.operation.circuit.loss_correlation });
    assert.equal(trial.status, "reserved");
    const oldBudget = trial.operation.circuit.head_trial_assignment;
    await g.transition({ ...ids(trial), status: "spawned" });
    await g.transition({ ...ids(trial), status: "verified", structuredStatus: true });
    key = "repo:owner/repo#43";
    await g.transition({ ...ids(trial), status: "exited" });
    const retry = await g.reserve({ projectId: "nextwork", role: "dev", source: "watchdog" });
    assert.equal(retry.status, "reserved");
    await g.transition({ ...ids(retry), status: "exited" });
    const opened = await g.reserve({ projectId: "nextwork", role: "dev", source: "watchdog" });
    assert.equal(opened.reason, "circuit_open");
    assert.notEqual(opened.operation.circuit.loss_correlation.slice(0, 32), killed.operation.circuit.loss_correlation.slice(0, 32), "different work is a different identity");
    assert.deepEqual([opened.operation.circuit.head_trial_assignment, opened.operation.circuit.head_trials], [oldBudget, 1], "the old budget is still recorded");
    const next = await g.reserve({ projectId: "nextwork", role: "dev", source: "head_recovery", expectedGeneration: retry.operation.generation_id, lossCorrelation: opened.operation.circuit.loss_correlation });
    assert.equal(next.status, "reserved", "Head's one trial on the new assignment is not charged to the old one");
    assert.notEqual(next.operation.circuit.head_trial_assignment, oldBudget);
    assert.equal(next.operation.circuit.head_trials, 1, "the new budget starts from zero and is now spent");
  }

  // A circuit opened by an exhausted automatic retry leaves the lost
  // generation recorded as `rejected`; Head's trial is still admitted against
  // that exact generation, the bounded counter is not advanced, and the
  // record round-trips through persistence with the counter intact.
  {
    const g = governor();
    const first = await g.reserve({ projectId: "headearly", role: "dev", source: "operator_start", operatorAuthorized: true });
    await g.transition({ projectId: "headearly", role: "dev", operationId: first.operation.operation_id, generationId: first.operation.generation_id, status: "exited" });
    const retry = await g.reserve({ projectId: "headearly", role: "dev", source: "head_recovery", expectedGeneration: first.operation.generation_id });
    assert.equal(retry.status, "reserved", "the one bounded automatic retry is still available to head_recovery");
    await g.transition({ projectId: "headearly", role: "dev", operationId: retry.operation.operation_id, generationId: retry.operation.generation_id, status: "exited" });
    const opened = await g.reserve({ projectId: "headearly", role: "dev", source: "head_recovery", expectedGeneration: retry.operation.generation_id });
    assert.equal(opened.reason, "circuit_open");
    assert.equal(opened.operation.state, "rejected");
    assert.equal(opened.operation.circuit.reason, "early_exit");
    const trial = await governor().reserve({
      projectId: "headearly", role: "dev", source: "head_recovery",
      expectedGeneration: retry.operation.generation_id, lossCorrelation: opened.operation.circuit.loss_correlation,
    });
    assert.equal(trial.status, "reserved");
    assert.equal(trial.operation.circuit.automatic_retries, 1);
    assert.equal(governor().snapshot("headearly", "dev").circuit.automatic_retries, 1);
  }

  // A production assignment key is hundreds of characters.  The circuit's
  // loss correlation derived from it must survive persistence (the record
  // bound is 128 chars) so an explicit trial can actually name it; both the
  // early-exit and resource-kill openings derive the same bounded anchor.
  {
    const longKey = `["batch-assignment",1,"${"x".repeat(300)}"]`;
    const g = governor({ currentWork: async () => ({ current: true, assignment: { assignment_key: longKey, assignment_attempt: "attempt-1", issue_contract_digest: null } }) });
    const first = await g.reserve({ projectId: "longkey", role: "dev", source: "operator_start", operatorAuthorized: true });
    await g.transition({ projectId: "longkey", role: "dev", operationId: first.operation.operation_id, generationId: first.operation.generation_id, status: "exited" });
    const retry = await g.reserve({ projectId: "longkey", role: "dev", source: "watchdog" });
    await g.transition({ projectId: "longkey", role: "dev", operationId: retry.operation.operation_id, generationId: retry.operation.generation_id, status: "exited" });
    const opened = await g.reserve({ projectId: "longkey", role: "dev", source: "watchdog" });
    assert.equal(opened.reason, "circuit_open");
    const persisted = governor().snapshot("longkey", "dev").circuit;
    assert.equal(typeof persisted.loss_correlation, "string", "the persisted circuit keeps its loss correlation");
    assert.equal(persisted.loss_correlation, opened.operation.circuit.loss_correlation);
    assert.match(persisted.loss_correlation, /^[a-f0-9]{32}:early_exit$/);
    const trial = await governor().reserve({
      projectId: "longkey", role: "dev", source: "operator_restart", operatorAuthorized: true,
      expectedGeneration: retry.operation.generation_id, lossCorrelation: persisted.loss_correlation,
    });
    assert.equal(trial.status, "reserved", "an operator can name the persisted correlation");
    const killed = await g.transition({ projectId: "longkey", role: "dev", operationId: trial.operation.operation_id, generationId: trial.operation.generation_id, status: "resource_killed" });
    assert.match(killed.operation.circuit.loss_correlation, /^[a-f0-9]{32}:resource_killed$/);
    assert.equal(governor().snapshot("longkey", "dev").circuit.loss_correlation, killed.operation.circuit.loss_correlation);
  }

  // A circuit persisted by a pre-digest server kept the raw
  // `${assignment_key}:<reason>` correlation, which the 128-char record bound
  // drops on read.  Upgrading must make that circuit nameable again by the
  // same digest a fresh opening writes, for both the operator and Head, while
  // a correlation that survived the bound is kept verbatim, a closed circuit
  // gains none, and a second read derives the identical value.
  {
    const longKey = `["batch-assignment",1,"${"y".repeat(300)}"]`;
    const shortKey = `repo:owner/repo#${"7".repeat(70)}`;
    const digest = (projectId, role, key, reason) => `${crypto.createHash("sha256").update(`${projectId}\n${role}\n${key}`).digest("hex").slice(0, 32)}:${reason}`;
    const legacyRecord = (key, reason, open) => ({
      operation_id: "op-legacy", generation_id: "gen-lost", state: open ? "rejected" : "exited", source: "watchdog",
      expected_assignment: { assignment_key: key, assignment_attempt: "attempt-1", issue_contract_digest: null },
      circuit: { open, reason, automatic_retries: 1, loss_correlation: open ? `${key}:${reason}` : null, expected_generation: open ? "gen-lost" : null, trial_operation_id: null, head_trial_operation_id: null },
      last_observation: { at: "2026-08-01T00:00:00.000Z", health: "unknown" }, unresolved_loss: null,
    });
    const filePath = projectStatePath(home, "legacy");
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, roles: {
      dev: legacyRecord(longKey, "early_exit", true),
      re1: legacyRecord(longKey, "resource_killed", true),
      re2: legacyRecord(shortKey, "early_exit", true),
      head: legacyRecord(longKey, "early_exit", false),
    } }), { mode: 0o600 });
    assert.ok(`${longKey}:early_exit`.length > 128, "the seeded raw correlation exceeds the record bound");
    assert.ok(`${shortKey}:early_exit`.length <= 128, "the control correlation fits the record bound");

    const healed = governor().snapshot("legacy", "dev").circuit;
    assert.equal(healed.loss_correlation, digest("legacy", "dev", longKey, "early_exit"), "the dropped correlation is re-derived as the fresh digest");
    assert.equal(governor().snapshot("legacy", "re1").circuit.loss_correlation, digest("legacy", "re1", longKey, "resource_killed"));
    assert.equal(governor().snapshot("legacy", "dev").circuit.loss_correlation, healed.loss_correlation, "a second read derives the identical value");
    assert.equal(governor().snapshot("legacy", "re2").circuit.loss_correlation, `${shortKey}:early_exit`, "a correlation that survived the bound is not rewritten");
    assert.equal(governor().snapshot("legacy", "head").circuit.open, false);
    assert.equal(governor().snapshot("legacy", "head").circuit.loss_correlation, null, "a closed circuit gains no correlation");

    const operator = await governor().reserve({ projectId: "legacy", role: "dev", source: "operator_restart", operatorAuthorized: true, expectedGeneration: "gen-lost", lossCorrelation: healed.loss_correlation });
    assert.equal(operator.status, "reserved", "the operator can take the trial on a pre-upgrade circuit");
    assert.equal(governor().snapshot("legacy", "dev").circuit.loss_correlation, healed.loss_correlation, "the persisted trial record carries the healed correlation");
    const head = await governor().reserve({ projectId: "legacy", role: "re1", source: "head_recovery", expectedGeneration: "gen-lost", lossCorrelation: digest("legacy", "re1", longKey, "resource_killed") });
    assert.equal(head.status, "reserved", "Head can take the trial on a pre-upgrade circuit");
    const wrongName = await governor().reserve({ projectId: "legacy", role: "re2", source: "operator_restart", operatorAuthorized: true, expectedGeneration: "gen-lost", lossCorrelation: digest("legacy", "re2", shortKey, "early_exit") });
    assert.equal(wrongName.reason, "circuit_trial_authorization_required", "a surviving raw correlation is still the only name that authorizes its trial");
    const control = await governor().reserve({ projectId: "legacy", role: "re2", source: "operator_restart", operatorAuthorized: true, expectedGeneration: "gen-lost", lossCorrelation: `${shortKey}:early_exit` });
    assert.equal(control.status, "reserved");
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
