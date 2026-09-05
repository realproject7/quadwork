"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createWorkTaskIndependentReviewService, WorkTaskIndependentReviewServiceError } = require("./work-task-independent-review-service");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
const { createWorkTaskReviewReconciliationService } = require("./work-task-review-reconciliation-service");

const installation_id = "installation_review_service_0001", project_id = "quadwork";
const base_sha = "a".repeat(64), candidate_sha = "b".repeat(64);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, code) { assert.throws(fn, (error) => error instanceof WorkTaskIndependentReviewServiceError && error.code === code); }
function withDirectory(run) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-independent-review-")); try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); } }
function candidateFor(ref, sha) {
  return buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha: sha, branch: "worktree-dev", worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; }, inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_dev", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: sha, dirty: false, occupancy: "vacant" }; }, readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}
function fixture(directory) {
  const reviewItem = { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" };
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [
    { task_key: "review", repository_key: "web", work_item: copy(reviewItem), goal: "seal two independent receipts", file_boundary: ["server/review.js"], validation: ["node-test"], dependencies: [] },
    { task_key: "dependent", repository_key: "web", work_item: copy(reviewItem), goal: "build on the reviewed slice", file_boundary: ["server/dependent.js"], validation: ["node-test"], dependencies: [{ repository_key: "web", work_item: copy(reviewItem), task_key: "review" }] },
    { task_key: "unrelated", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 43, kind: "issue" }, goal: "independent slice", file_boundary: ["server/unrelated.js"], validation: ["node-test"], dependencies: [] },
  ] }, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; } }), "2026-09-02T00:00:00.000Z");
  const ref = manifest.tasks[0].ref;
  let pipeline = buildWorkTaskPipeline(manifest);
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  store.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline });
  let state = store.readRecoverySnapshot({ installation_id, project_id });
  let plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "assign_build", event_id: "review_assign_build", work_task_ref: copy(ref), assignment_id: "review_assignment", base_sha });
  store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
  state = store.readRecoverySnapshot({ installation_id, project_id });
  const candidate = candidateFor(ref, candidate_sha);
  plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "record_candidate", event_id: "review_candidate", assignment_id: "review_assignment", candidate });
  store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
  return { ref, manifest, candidate, store, service: createWorkTaskIndependentReviewService({ config_dir: directory, fs }) };
}
function receipt(round, id, verdict, findings = []) { const payload = { version: 1, review_round_ref: round, receipt_id: id, verdict, findings: copy(findings) }; const crypto = require("node:crypto"); const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v); return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") }; }
function reviewers() { return [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }]; }
function sealBoth(service, opened, verdicts, at = "00") {
  service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, `receipt_re1_${at}`, verdicts[0]) }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: `2026-09-02T01:${at}:01.000Z` });
  service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, `receipt_re2_${at}`, verdicts[1]) }, { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: `2026-09-02T01:${at}:02.000Z` });
}
function applyEvent(store, manifest, nextEvent) {
  const state = store.readRecoverySnapshot({ installation_id, project_id });
  const plan = planWorkTaskPipelineEvent(state.pipeline, nextEvent);
  return store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
}

withDirectory((directory) => {
  const current = fixture(directory);
  const opened = current.service.openIndependentReview({ version: 1, event_id: "review_round_open", work_task_ref: copy(current.ref), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }], opened_at: "2026-09-02T00:01:00.000Z" });
  assert.equal(opened.outcome, "opened");
  assert.match(opened.review_round_ref.candidate_sha, /^[a-f0-9]{64}$/);
  const state = current.store.readRecoverySnapshot({ installation_id, project_id });
  assert.equal(state.pipeline.tasks[0].state, "independent_review");
  const retry = current.service.openIndependentReview({ version: 1, event_id: "review_round_open", work_task_ref: copy(current.ref), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }], opened_at: "2026-09-02T00:01:00.000Z" });
  assert.equal(retry.outcome, "idempotent");
  console.log("  PASS: an exact candidate opens one idempotent two-reviewer pipeline assignment");
  const re1 = current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re1_01", "approve") }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T00:02:00.000Z" });
  assert.equal(re1.outcome, "sealed"); assert.equal(re1.view.status, "sealed"); assert.equal(re1.view.own_receipt.receipt_id, "receipt_re1_01");
  const re2 = current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re2_01", "request_changes") }, { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-02T00:03:00.000Z" });
  assert.equal(re2.outcome, "released"); assert.equal(re2.view.status, "released"); assert.doesNotMatch(JSON.stringify(re2.view), /receipt_re1_01/);
  assert.equal(current.store.readRecoverySnapshot({ installation_id, project_id }).pipeline.tasks[0].state, "independent_review");
  console.log("  PASS: reviewers receive only their sealed view; release does not prematurely infer a delivery verdict");
  throwsCode(() => current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: "d".repeat(64), receipt: receipt(opened.review_round_ref, "receipt_bad_01", "approve") }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T00:04:00.000Z" }), "stale_work_task_review_authority");
  console.log("  PASS: stale candidate receipts cannot cross the pipeline review assignment");
});

// #1058 steps 6-8 / #1059 correction: a reconciled `changes_requested` round
// routes the exact candidate back to Dev as one bounded local correction. The
// corrected candidate is a new identity, both sealed first-pass receipts stay
// intact and independent, and re-review binds only to the new SHA.
withDirectory((directory) => {
  const current = fixture(directory);
  const owner = { installation_id, project_id };
  const rounds = createTaskReviewRoundStore({ rootDir: directory, fsImpl: fs });
  const reconciliation = createWorkTaskReviewReconciliationService({ config_dir: directory, fs });
  const opened = current.service.openIndependentReview({ version: 1, event_id: "correction_open_1", work_task_ref: copy(current.ref), attempt: "attempt_001", round: 1, reviewers: reviewers(), opened_at: "2026-09-02T01:00:00.000Z" });
  const correction = { version: 1, work_task_ref: copy(current.ref), review_round_ref: copy(opened.review_round_ref), candidate_digest: opened.candidate_digest };
  throwsCode(() => current.service.queueLocalCorrection(correction), "task_review_round_not_released");
  sealBoth(current.service, opened, ["approve", "request_changes"], "00");
  throwsCode(() => current.service.queueLocalCorrection(correction), "stale_work_task_review_authority");
  reconciliation.reconcileReleasedReview(correction);
  assert.equal(current.store.readRecoverySnapshot(owner).pipeline.tasks[0].state, "changes_requested");

  const queued = current.service.queueLocalCorrection(correction);
  assert.equal(queued.outcome, "queued");
  assert.match(queued.checkpoint_id, /^checkpoint_[a-f0-9]{48}$/);
  let slot = current.store.readRecoverySnapshot(owner).pipeline.tasks[0];
  assert.equal(slot.state, "queued");
  assert.deepEqual(slot.correction, { checkpoint_id: queued.checkpoint_id, count: 1 });
  assert.equal(slot.candidate.candidate_digest, opened.candidate_digest);
  assert.equal(slot.history.at(-1).kind, "queue_local_correction");
  assert.equal(current.service.queueLocalCorrection(correction).outcome, "idempotent");
  assert.equal(current.store.readRecoverySnapshot(owner).pipeline.history.filter((entry) => entry.kind === "queue_local_correction").length, 1);
  console.log("  PASS: a reconciled change request queues exactly one bounded local correction for Dev");

  // Dev takes the correction on the original base and submits a new exact SHA.
  applyEvent(current.store, current.manifest, { version: 1, kind: "assign_build", event_id: "correction_assign_2", work_task_ref: copy(current.ref), assignment_id: "review_assignment", base_sha });
  const corrected = candidateFor(current.ref, "d".repeat(64));
  applyEvent(current.store, current.manifest, { version: 1, kind: "record_candidate", event_id: "correction_candidate_2", assignment_id: "review_assignment", candidate: corrected });
  slot = current.store.readRecoverySnapshot(owner).pipeline.tasks[0];
  assert.equal(slot.state, "candidate_ready");
  assert.equal(slot.correction, null);
  assert.notEqual(corrected.candidate_digest, opened.candidate_digest);
  assert.equal(slot.candidate.candidate_digest, corrected.candidate_digest);

  // The first-pass round is untouched: both sealed receipts remain, and
  // neither its verdict nor a late receipt can reach the corrected candidate.
  const firstRound = rounds.readReleasedForReconciliation(opened.review_round_ref, opened.candidate_digest);
  assert.deepEqual(firstRound.receipt_verdicts.map((entry) => [entry.reviewer_role, entry.receipt_id, entry.verdict]), [["re1", "receipt_re1_00", "approve"], ["re2", "receipt_re2_00", "request_changes"]]);
  assert.throws(() => reconciliation.reconcileReleasedReview(correction), (error) => error.code === "stale_work_task_review_authority");
  assert.equal(current.service.queueLocalCorrection(correction).outcome, "idempotent");
  assert.equal(current.store.readRecoverySnapshot(owner).pipeline.tasks[0].state, "candidate_ready");
  const reopened = current.service.openIndependentReview({ version: 1, event_id: "correction_open_2", work_task_ref: copy(current.ref), attempt: "attempt_001", round: 2, reviewers: reviewers(), opened_at: "2026-09-02T01:10:00.000Z" });
  assert.equal(reopened.outcome, "opened");
  assert.equal(reopened.review_round_ref.candidate_sha, "d".repeat(64));
  assert.equal(reopened.candidate_digest, corrected.candidate_digest);
  assert.notEqual(reopened.review_round_ref.candidate_sha, opened.review_round_ref.candidate_sha);
  throwsCode(() => current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re1_late", "approve") }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T01:11:00.000Z" }), "stale_work_task_review_authority");
  sealBoth(current.service, reopened, ["approve", "approve"], "12");
  const accepted = reconciliation.reconcileReleasedReview({ version: 1, work_task_ref: copy(current.ref), review_round_ref: copy(reopened.review_round_ref), candidate_digest: reopened.candidate_digest });
  assert.equal(accepted.resolution, "accepted");
  assert.equal(current.store.readRecoverySnapshot(owner).pipeline.tasks[0].state, "accepted");
  throwsCode(() => current.service.queueLocalCorrection({ ...correction, review_round_ref: copy(reopened.review_round_ref), candidate_digest: reopened.candidate_digest }), "work_task_correction_not_requested");
  assert.deepEqual(rounds.readReleasedForReconciliation(opened.review_round_ref, opened.candidate_digest), firstRound);
  console.log("  PASS: the corrected candidate is a new identity; first-pass receipts stay sealed and an old-SHA verdict never carries forward");
});

// #1070: the correction cap holds on the Dev correction route itself. Three
// reconciled change requests each queue one correction even though every
// corrected candidate clears the checkpoint; the fourth is refused with the
// typed limit before the pipeline store changes, a replayed request stays
// idempotent, and a round bound to a superseded candidate cannot spend one.
withDirectory((directory) => {
  const current = fixture(directory);
  const owner = { installation_id, project_id };
  const reconciliation = createWorkTaskReviewReconciliationService({ config_dir: directory, fs });
  let candidate = current.candidate;
  const requests = [];
  const requestChanges = (round) => {
    const opened = current.service.openIndependentReview({ version: 1, event_id: `cap_open_${round}`, work_task_ref: copy(current.ref), attempt: "attempt_001", round, reviewers: reviewers(), opened_at: `2026-09-02T03:0${round}:00.000Z` });
    assert.equal(opened.candidate_digest, candidate.candidate_digest);
    sealBoth(current.service, opened, ["request_changes", "request_changes"], `2${round}`);
    const request = { version: 1, work_task_ref: copy(current.ref), review_round_ref: copy(opened.review_round_ref), candidate_digest: opened.candidate_digest };
    assert.equal(reconciliation.reconcileReleasedReview(request).resolution, "changes_requested");
    return request;
  };
  for (const round of [1, 2, 3]) {
    const request = requestChanges(round);
    assert.equal(current.service.queueLocalCorrection(request).outcome, "queued");
    let slot = current.store.readRecoverySnapshot(owner).pipeline.tasks[0];
    assert.equal(slot.correction.count, round);
    assert.equal(slot.correction_count, round);
    applyEvent(current.store, current.manifest, { version: 1, kind: "assign_build", event_id: `cap_assign_${round}`, work_task_ref: copy(current.ref), assignment_id: "review_assignment", base_sha });
    candidate = candidateFor(current.ref, "def"[round - 1].repeat(64));
    applyEvent(current.store, current.manifest, { version: 1, kind: "record_candidate", event_id: `cap_candidate_${round}`, assignment_id: "review_assignment", candidate });
    slot = current.store.readRecoverySnapshot(owner).pipeline.tasks[0];
    assert.equal(slot.correction, null);
    assert.equal(slot.correction_count, round);
    assert.equal(current.service.queueLocalCorrection(request).outcome, "idempotent");
    requests.push(request);
  }
  const fourth = requestChanges(4);
  const before = current.store.readRecoverySnapshot(owner);
  assert.equal(before.pipeline.tasks[0].state, "changes_requested");
  assert.equal(before.pipeline.tasks[0].correction_count, 3);
  throwsCode(() => current.service.queueLocalCorrection(fourth), "work_task_checkpoint_limit");
  throwsCode(() => current.service.queueLocalCorrection({ ...fourth, candidate_digest: requests[2].candidate_digest }), "task_review_round_not_found");
  assert.equal(current.service.queueLocalCorrection(requests[2]).outcome, "idempotent");
  assert.deepEqual(current.store.readRecoverySnapshot(owner), before);
  assert.equal(before.pipeline.history.filter((entry) => entry.kind === "queue_local_correction").length, 3);
  console.log("  PASS: the Dev correction route admits exactly MAX_CHECKPOINTS corrections per task and refuses the fourth before any pipeline write");
});

// #1059 propagation stop: a sealed propagating first-pass receipt is visible
// only through the Head-only read, as identity plus the server-derived
// declared dependent chain. The peer reviewer's path shows nothing, and the
// combined release retires the pending stop.
withDirectory((directory) => {
  const current = fixture(directory);
  const stopRequest = { version: 1, work_task_ref: copy(current.ref) };
  assert.equal(current.service.readPropagationStopPending(stopRequest), null);
  const opened = current.service.openIndependentReview({ version: 1, event_id: "stop_open", work_task_ref: copy(current.ref), attempt: "attempt_001", round: 1, reviewers: reviewers(), opened_at: "2026-09-02T02:00:00.000Z" });
  assert.equal(current.service.readPropagationStopPending(stopRequest), null);
  const propagating = { finding_id: "finding_re2_shared_base", severity: "blocking", propagation: "propagating", summary: "shared base drift" };
  const sealed = current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re2_stop", "request_changes", [propagating]) }, { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-02T02:01:00.000Z" });
  assert.equal(sealed.outcome, "sealed");
  assert.deepEqual(Object.keys(sealed).sort(), ["outcome", "version", "view"]);
  const stop = current.service.readPropagationStopPending(stopRequest);
  assert.equal(stop.kind, "propagation_stop_pending");
  assert.equal(stop.target, "head_private");
  assert.deepEqual(stop.review_round_ref, opened.review_round_ref);
  assert.equal(stop.candidate_digest, opened.candidate_digest);
  assert.deepEqual(stop.dependency_chain.map((entry) => entry.task_key), ["dependent"]);
  assert.doesNotMatch(JSON.stringify(stop), /receipt|finding|reviewer|verdict|request_changes|re2|shared base/);
  const peer = current.service.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re1_stop", "approve") }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T02:00:30.000Z" });
  assert.equal(peer.outcome, "released");
  assert.doesNotMatch(JSON.stringify(peer.view), /receipt_re2_stop|finding_re2_shared_base|propagat|shared base/);
  assert.equal(current.service.readPropagationStopPending(stopRequest), null);
  assert.equal(current.service.readPropagationStopPending({ version: 1, work_task_ref: copy(current.manifest.tasks[2].ref) }), null);
  console.log("  PASS: a sealed propagating finding yields a redacted Head-only stop over the declared chain and never a peer-visible event");
});

{
  const source = fs.readFileSync(path.join(__dirname, "work-task-independent-review-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|mcp|file-chat|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:record_review_verdict|reconcile_review|push|pull_request|merge|deploy|execFile|spawn)/);
  console.log("  PASS: receipt sealing has no transport, publication, or premature verdict-reconciliation authority");
}

console.log("work-task-independent-review-service.test.js: all assertions passed");
