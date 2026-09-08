"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const F = require("./__tests__/work-task-review-service-fixture");
const { createWorkTaskReviewRuntime } = require("./work-task-review-runtime");
const { createWorkTaskIndependentReviewService, reviewRoundId } = require("./work-task-independent-review-service");
const { createWorkTaskReviewReconciliationService } = require("./work-task-review-reconciliation-service");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-review-opening-recovery-"));
  const f = F.fixture(directory), rounds = createTaskReviewRoundStore({ rootDir: directory, fsImpl: fs });
  const state = { now: new Date("2026-09-02T00:01:00.000Z"), generation: 10, current: true, failMapping: false, issueRevision: f.ref.issue_body_revision };
  const sessions = new Map(["head", "re1", "re2"].map((role) => [`${F.project_id}/${role}`, { projectId: F.project_id, agentId: role, state: "running", term: {}, lifecycleState: "verified" }]));
  const injectedFs = new Proxy(fs, { get(target, key) {
    if (key === "renameSync") return (from, to) => { if (state.failMapping && String(to).includes("work-task-pipelines")) { state.failMapping = false; throw Object.assign(new Error("one lost pipeline write"), { code: "EIO" }); } return target.renameSync(from, to); };
    return Reflect.get(target, key);
  } });
  function runtime() {
    return createWorkTaskReviewRuntime({ config_dir: directory, fs: injectedFs,
      capture_project_admission: () => ({ project_id: F.project_id, generation: state.generation }), is_admission_current: () => state.current,
      resolve_shim_principal: (token) => ["head", "re1", "re2"].includes(token) ? { projectId: F.project_id, agentId: token } : null,
      agent_sessions: sessions, read_live_batch_context: () => ({}), read_repository_state: () => ({}), read_cached_repository_snapshot: () => ({}), now: () => state.now,
      create_live_identity_resolver: () => (input) => ({ ...input, issue_body_revision: state.issueRevision }),
      create_review_service: (options) => createWorkTaskIndependentReviewService(options), create_reconciliation_service: (options) => createWorkTaskReviewReconciliationService(options),
    });
  }
  const body = { event_id: "recover_open_event", work_task_ref: f.ref, attempt: "attempt_001", round: 1 };
  const scope = { installation_id: F.installation_id, project_id: F.project_id };
  function document() { const anchor = rounds.listCurrentRoundAnchors(scope)[0]; return JSON.parse(fs.readFileSync(rounds.pathFor(anchor.review_round_ref), "utf8")); }
  return { ...f, directory, rounds, state, sessions, runtime, body, document, scope, close() { fs.rmSync(directory, { recursive: true, force: true }); } };
}
function rejects(action, code) { assert.throws(action, (error) => error.code === code, code); }
function main() {
  {
    const f = setup();
    try {
      f.state.failMapping = true;
      rejects(() => f.runtime().open({ token: "head", body: f.body }), "work_task_pipeline_store_write_failed");
      assert.equal(f.store.readRecoverySnapshot(f.scope).pipeline.tasks[0].state, "candidate_ready");
      const original = Object.values(f.document().records)[0], originalBytes = fs.readFileSync(f.rounds.pathFor(original.round.review_round_ref));
      assert.equal(original.round.opened_at, "2026-09-02T00:01:00.000Z");
      assert.equal(original.pipeline_opening.event_id, f.body.event_id);
      f.state.now = new Date("2026-09-02T00:02:00.000Z");
      for (const patch of [{ event_id: "different_event" }, { attempt: "attempt_002" }, { round: 2 }, { event_id: "different_event", attempt: "attempt_002" }]) {
        rejects(() => f.runtime().open({ token: "head", body: { ...f.body, ...patch } }), "task_review_round_conflict");
      }
      f.state.generation++;
      rejects(() => f.runtime().open({ token: "head", body: f.body }), "task_review_round_conflict"); f.state.generation--;
      f.state.current = false;
      rejects(() => f.runtime().open({ token: "head", body: f.body }), "work_task_review_principal_unavailable"); f.state.current = true;
      f.state.issueRevision = "e".repeat(64);
      rejects(() => f.runtime().open({ token: "head", body: f.body }), "stale_work_task_review_authority"); f.state.issueRevision = f.ref.issue_body_revision;
      const changed = F.candidateFor(f.ref, "d".repeat(64));
      F.applyEvent(f.store, f.manifest, { version: 1, kind: "replace_candidate", event_id: "candidate_changed", candidate: changed });
      rejects(() => f.runtime().open({ token: "head", body: f.body }), "task_review_round_conflict");
      F.applyEvent(f.store, f.manifest, { version: 1, kind: "replace_candidate", event_id: "candidate_restored", candidate: f.candidate });
      const opened = f.runtime().open({ token: "head", body: f.body });
      assert.equal(opened.outcome, "opened");
      assert.deepEqual(fs.readFileSync(f.rounds.pathFor(opened.review_round_ref)), originalBytes, "recovery must not rewrite the opening audit or timestamp");
      f.state.now = new Date("2026-09-02T00:03:00.000Z");
      assert.equal(f.runtime().open({ token: "head", body: f.body }).outcome, "idempotent");
      assert.equal(f.store.readRecoverySnapshot(f.scope).pipeline.history.filter((e) => e.kind === "assign_independent_review").length, 1);
      for (const [index, role] of ["re1", "re2"].entries()) {
        f.state.now = new Date(`2026-09-02T00:0${index + 4}:00.000Z`);
        f.runtime().submit({ token: role, body: { review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: F.receipt(opened.review_round_ref, `receipt_${role}_recover`, "approve") } });
      }
      const stored = JSON.parse(fs.readFileSync(f.rounds.pathFor(opened.review_round_ref), "utf8"));
      assert.equal(Object.keys(stored.records).length, 1);
      const released = Object.values(stored.records)[0];
      assert.deepEqual(released.pipeline_opening, original.pipeline_opening);
      assert.equal(released.round.opened_at, original.round.opened_at); assert.deepEqual(released.round.audit[0], original.round.audit[0]);
      assert.equal(released.round.status, "released");
      rejects(() => f.rounds.openPipelineRound({ version: 1, candidate: f.candidate, attempt: "attempt_002", round: 1, opened_at: f.state.now.toISOString() },
        { version: 1, reviewers: ["re1", "re2"].map((role) => ({ reviewer_role: role, reviewer_generation: 11 })) }, "different_released_event"), "task_review_round_conflict");
      f.runtime().reconcile({ token: "head", body: { work_task_ref: f.ref, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest } });
      assert.equal(f.rounds.readReleasedForDelivery({ version: 1, work_task_ref: f.ref, candidate_digest: opened.candidate_digest }).status, "released");
      assert.equal(f.store.readRecoverySnapshot(f.scope).pipeline.tasks[0].state, "accepted");
      console.log("PASS actual advancing runtime clock, real round-before-pipeline failure, exact restart recovery, one unambiguous released delivery round and drift refusals");
    } finally { f.close(); }
  }
  {
    const f = setup();
    try {
      const opening = { version: 1, candidate: f.candidate, attempt: f.body.attempt, round: f.body.round, opened_at: f.state.now.toISOString() };
      const assignments = { version: 1, reviewers: ["re1", "re2"].map((role) => ({ reviewer_role: role, reviewer_generation: 11 })) };
      const legacy = f.rounds.openRound(opening, assignments);
      f.state.now = new Date("2026-09-02T00:02:00.000Z");
      rejects(() => f.runtime().open({ token: "head", body: f.body }), "task_review_round_conflict");
      assert.equal(Object.keys(f.document().records).length, 1, "an unsupported legacy orphan is never adopted with a new event");
      F.applyEvent(f.store, f.manifest, { version: 1, kind: "assign_independent_review", event_id: f.body.event_id, work_task_ref: f.ref, review_round_id: reviewRoundId(legacy.review_round_ref), candidate_digest: f.candidate.candidate_digest });
      const bytes = fs.readFileSync(f.rounds.pathFor(legacy.review_round_ref));
      assert.equal(f.runtime().open({ token: "head", body: f.body }).outcome, "idempotent", "existing legacy mapping proves its original event");
      assert.deepEqual(fs.readFileSync(f.rounds.pathFor(legacy.review_round_ref)), bytes);
      console.log("PASS legacy applied opening replay is retained while an unproven legacy orphan remains closed");
    } finally { f.close(); }
  }
  {
    const f = setup();
    try {
      const opened = f.runtime().open({ token: "head", body: f.body });
      const before = Object.values(f.document().records)[0];
      f.rounds.cancelFromTrustedState({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, cause: "project_archived", reason: "project archived", at: "2026-09-02T00:02:00.000Z" });
      const record = Object.values(JSON.parse(fs.readFileSync(f.rounds.pathFor(opened.review_round_ref), "utf8")).records)[0];
      assert.deepEqual(record.pipeline_opening, before.pipeline_opening);
      assert.equal(record.round.opened_at, before.round.opened_at);
      rejects(() => f.runtime().open({ token: "head", body: f.body }), "task_review_round_conflict");
      assert.equal(record.round.status, "cancelled");
      console.log("PASS cancellation retains immutable opening identity and cannot reopen its cancelled assignment");
    } finally { f.close(); }
  }
}
try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
