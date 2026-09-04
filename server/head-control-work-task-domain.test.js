"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHeadControlPlane } = require("./head-control-plane");
const { composeHeadDomain } = require("./head-control-runtime");
const {
  buildBatchManifest,
  freezeBatchManifest,
} = require("./work-task-manifest");
const {
  buildWorkTaskPipeline,
  planWorkTaskPipelineEvent,
  applyWorkTaskPipelinePlan,
} = require("./work-task-pipeline");
const {
  createWorkTaskPipelineStore,
  workTaskPipelineStorePath,
} = require("./work-task-pipeline-store");
const { createWorkTaskIndependentReviewService } = require("./work-task-independent-review-service");
const { createWorkTaskReviewReconciliationService } = require("./work-task-review-reconciliation-service");
const {
  FILE_MODE,
  DIRECTORY_MODE,
  HeadControlWorkTaskDomainError,
  headControlWorkTaskDomainPath,
  createHeadControlWorkTaskDomain,
} = require("./head-control-work-task-domain");

const binding = Object.freeze({
  installation_id: "installation_domain_0001",
  project_id: "quadwork",
  role: "head",
  generation: 7,
});
const issueBodyRevision = "c".repeat(64);
const baseSha = "a".repeat(64);
const candidateSha = "b".repeat(64);
const issue = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-domain-"));
  fs.chmodSync(directory, DIRECTORY_MODE);
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function manifest() {
  return buildBatchManifest({
    version: 1,
    installation_id: binding.installation_id,
    project_id: binding.project_id,
    delivery_mode: "integrated",
    tasks: [{
      task_key: "build",
      repository_key: "web",
      work_item: copy(issue),
      goal: "exercise durable Head control domain state",
      file_boundary: ["server/head-control-work-task-domain.js"],
      validation: ["node:test"],
      dependencies: [],
    }],
  }, { resolveRegisteredIdentity });
}
function reviewManifest() {
  return buildBatchManifest({
    version: 1,
    installation_id: binding.installation_id,
    project_id: binding.project_id,
    delivery_mode: "integrated",
    tasks: [
      { task_key: "review", repository_key: "web", work_item: copy(issue), goal: "seal two independent receipts", file_boundary: ["server/review.js"], validation: ["node:test"], dependencies: [] },
      { task_key: "dependent", repository_key: "web", work_item: copy(issue), goal: "build on the reviewed slice", file_boundary: ["server/dependent.js"], validation: ["node:test"], dependencies: [{ repository_key: "web", work_item: copy(issue), task_key: "review" }] },
    ],
  }, { resolveRegisteredIdentity });
}
function receipt(round, id, verdict, findings = []) {
  const crypto = require("node:crypto");
  const payload = { version: 1, review_round_ref: round, receipt_id: id, verdict, findings: copy(findings) };
  const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
  return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") };
}
function reviewerContext(role, at) {
  return { version: 1, reviewer_role: role, reviewer_generation: role === "re1" ? 11 : 22, received_at: at };
}
function resolveRegisteredIdentity(input) {
  return {
    installation_id: input.installation_id,
    project_id: input.project_id,
    repository_key: input.repository_key,
    work_item: copy(input.work_item),
    issue_body_revision: issueBodyRevision,
  };
}
function domain(directory, options = {}) {
  return createHeadControlWorkTaskDomain({
    binding,
    config_dir: directory,
    fs: options.fs || fs,
    resolve_registered_identity: options.resolve_registered_identity || resolveRegisteredIdentity,
    now: options.now || (() => "2026-09-02T00:00:00.000Z"),
  });
}
function request(action, expected_revision, payload = null, keys = {}) {
  return {
    version: 1,
    action,
    binding: copy(binding),
    expected_revision,
    correlation_id: keys.correlation_id || `corr_${action}_001`,
    idempotency_key: keys.idempotency_key || `idem_${action}_001`,
    payload,
  };
}
function planeRequest(action, expected_revision, payload = null, keys = {}) {
  return {
    version: 1,
    action,
    principal: copy(binding),
    expected_revision,
    correlation_id: keys.correlation_id || `corr_plane_${action}_001`,
    idempotency_key: keys.idempotency_key || `idem_plane_${action}_001`,
    payload,
  };
}
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof HeadControlWorkTaskDomainError && error.code === code);
}
// WorkTaskPipeline accepts candidates only after the existing candidate
// contract has validated them.  Reuse the tested canonical candidate helper
// shape by constructing it through the source module here.
function exactCandidate(ref) {
  const { buildWorkTaskCandidate } = require("./work-task-candidate");
  return buildWorkTaskCandidate({
    version: 1,
    work_task_ref: copy(ref),
    base_sha: baseSha,
    candidate_sha: candidateSha,
    branch: "task/work-task-build",
    worktree: { repository_key: "web", worktree_id: "wt_build_01", path: "/var/quadwork/task-build" },
  }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path.replace(/^\/var\//, "/private/var/") }; },
    inspectManagedWorktree(input) {
      return {
        version: 1,
        registered: true,
        readable: true,
        repository_key: input.expected.repository_key,
        worktree_id: input.expected.worktree_id,
        canonical_path: input.expected.canonical_path,
        branch: input.expected.branch,
        base_sha: input.expected.base_sha,
        head_sha: input.expected.candidate_sha,
        dirty: false,
        occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() { return { version: 1, installation_id: binding.installation_id, project_id: binding.project_id, v1_state: "present" }; },
  });
}
function applyPipelineEvent(directory, state, event, terminal_disposition = null) {
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const plan = planWorkTaskPipelineEvent(state.pipeline, event);
  return store.applyPlan({
    expected: {
      installation_id: binding.installation_id,
      project_id: binding.project_id,
      manifest_digest: state.manifest.manifest_digest,
      pipeline_digest: state.pipeline.pipeline_digest,
    },
    plan,
    terminal_disposition,
  });
}
function advanceToAccepted(directory, initial) {
  const ref = initial.manifest.tasks[0].ref;
  let state = applyPipelineEvent(directory, initial, {
    version: 1, kind: "assign_build", event_id: "domain_assign_build", work_task_ref: copy(ref), assignment_id: "domain_assignment", base_sha: baseSha,
  });
  const candidate = exactCandidate(ref);
  state = applyPipelineEvent(directory, state, { version: 1, kind: "record_candidate", event_id: "domain_record_candidate", assignment_id: "domain_assignment", candidate });
  state = applyPipelineEvent(directory, state, {
    version: 1, kind: "assign_independent_review", event_id: "domain_assign_review", work_task_ref: copy(ref), review_round_id: "domain_round", candidate_digest: candidate.candidate_digest,
  });
  state = applyPipelineEvent(directory, state, {
    version: 1, kind: "record_review_verdict", event_id: "domain_review_verdict", work_task_ref: copy(ref), review_round_id: "domain_round", candidate_digest: candidate.candidate_digest, verdict: "approved",
  });
  state = applyPipelineEvent(directory, state, {
    version: 1, kind: "reconcile_review", event_id: "domain_reconcile", work_task_ref: copy(ref), review_round_id: "domain_round", candidate_digest: candidate.candidate_digest, resolution: "accepted",
  });
  return { state, ref, candidate };
}

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// Initialization is explicit.  A missing, corrupt, or foreign durable domain
// cannot be interpreted as an empty pipeline, and the state file is private.
withDirectory((directory) => {
  const fresh = domain(directory);
  throwsCode(() => fresh.get_pipeline_status(request("get_pipeline_status", null)), "head_control_work_task_state_missing");
  const initialized = fresh.initialize();
  assert.equal(initialized.revision, 0);
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  assert.equal(fs.statSync(statePath).mode & 0o777, FILE_MODE);
  assert.deepEqual(fresh.get_pipeline_status(request("get_pipeline_status", null)), {
    revision: 0, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false,
  });
  throwsCode(() => fresh.get_pipeline_status({ ...request("get_pipeline_status", null), action: "publish_delivery" }),
    "invalid_head_control_work_task_input");
  throwsCode(() => fresh.get_pipeline_status(request("put_batch_manifest", 0, { manifest: { oversized: "x".repeat(128 * 1024 + 1) } })),
    "invalid_head_control_work_task_input");
  const restarted = domain(directory);
  assert.equal(restarted.initialize().revision, 0, "explicit initialization is idempotent for one exact binding");
  ok(Object.isFrozen(restarted.get_pipeline_status(request("get_pipeline_status", null))),
    "missing state fails closed while an initialized 0600 state survives restart");
});

// The first put is exact, project-bound, persisted before it is reported, and
// cannot be replaced with a frozen or foreign manifest.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const batch = manifest();
  const put = current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(batch) }));
  assert.equal(put.revision, 1);
  assert.equal(put.manifest_digest, batch.manifest_digest);
  assert.equal(put.manifest_frozen, false);
  assert.deepEqual(domain(directory).get_pipeline_status(request("get_pipeline_status", null)), put);
  throwsCode(() => current.put_batch_manifest(request("put_batch_manifest", 1, { manifest: copy(batch) }, { correlation_id: "corr_put_again", idempotency_key: "idem_put_again" })),
    "head_control_work_task_invalid_transition");
  const foreign = copy(batch);
  foreign.project_id = "other";
  throwsCode(() => current.put_batch_manifest(request("put_batch_manifest", 1, { manifest: foreign }, { correlation_id: "corr_foreign_put", idempotency_key: "idem_foreign_put" })),
    "head_control_work_task_invalid_transition");
  ok(true, "manifest put is a one-time optimistic, project-bound durable transition");
});

// Freeze writes a private pending intent before it initializes the frozen
// WorkTask store.  A restart recovers only that exact stored manifest, not a
// redacted audit receipt or a new caller payload.
withDirectory((directory) => {
  let metadataRenames = 0;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (String(to).includes("head-control-work-task-domain")) {
      metadataRenames += 1;
      if (metadataRenames === 4) {
        const error = new Error("injected finalization failure");
        error.code = "EIO";
        throw error;
      }
    }
    return fs.renameSync(from, to);
  };
  const current = domain(directory, { fs: faultFs });
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  throwsCode(() => current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null)), "head_control_work_task_state_write_failed");
  assert.equal(metadataRenames, 4);
  const recovered = domain(directory);
  const status = recovered.get_pipeline_status(request("get_pipeline_status", null));
  assert.equal(status.revision, 2);
  assert.equal(status.manifest_frozen, true);
  assert.match(fs.readFileSync(headControlWorkTaskDomainPath(directory, binding), "utf8"), /"pending":null/);
  ok(true, "interrupted freeze resumes from exact private domain intent and durable WorkTask state");
});

// A pipeline advanced by its owning WorkTask services is re-read from the
// existing CAS store and becomes one new controller revision.  Cut then uses
// the pure planner to pin exact accepted candidate identities.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const batch = manifest();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(batch) }));
  const proposed = current.project_current_batch();
  assert.equal(proposed.frozen, false);
  assert.deepEqual(proposed.repositories[0].work_items[0].tasks.map((task) => task.state), ["queued"]);
  const frozen = current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null));
  assert.equal(frozen.revision, 2);
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const advanced = advanceToAccepted(directory, pipelineStore.readRecoverySnapshot({ installation_id: binding.installation_id, project_id: binding.project_id }));
  const observed = current.get_pipeline_status(request("get_pipeline_status", null));
  assert.equal(observed.revision, 3);
  assert.equal(observed.cut_safe, true);
  const nested = current.project_current_batch();
  assert.equal(nested.frozen, true);
  assert.equal(nested.repositories[0].work_items[0].tasks[0].state, "accepted");
  assert.equal(nested.repositories[0].work_items[0].tasks[0].candidate.candidate_sha, candidateSha);
  assert.doesNotMatch(JSON.stringify(nested), /managed_worktree|canonical_path|task-build/);
  throwsCode(() => current.cut_batch(request("cut_batch", 3, { cut: { tasks: [{ work_task_ref: copy(advanced.ref), candidate_digest: "e".repeat(64) }] } })),
    "head_control_work_task_cut_invalid");
  assert.equal(current.get_pipeline_status(request("get_pipeline_status", null)).revision, 3);
  const cut = current.cut_batch(request("cut_batch", 3, {
    cut: { tasks: [{ work_task_ref: copy(advanced.ref), candidate_digest: advanced.candidate.candidate_digest }] },
  }, { correlation_id: "corr_exact_cut", idempotency_key: "idem_exact_cut" }));
  assert.equal(cut.revision, 4);
  assert.equal(cut.cut_safe, false);
  const persisted = pipelineStore.readRecoverySnapshot({ installation_id: binding.installation_id, project_id: binding.project_id });
  assert.equal(persisted.pipeline.tasks[0].state, "staged");
  assert.equal(persisted.terminal_audit.at(-1).kind, "integrated_cut");
  ok(true, "exact WorkTask candidate cuts are planned, CAS-applied, and observed through one monotonic Head revision");
});

// Current registered identities are rechecked at each durable mutation.  A
// changed issue contract cannot be frozen merely because an older manifest was
// accepted before the restart.
withDirectory((directory) => {
  const staleResolver = (input) => ({
    installation_id: input.installation_id,
    project_id: input.project_id,
    repository_key: input.repository_key,
    work_item: copy(input.work_item),
    issue_body_revision: "f".repeat(64),
  });
  const current = domain(directory);
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  const stale = domain(directory, { resolve_registered_identity: staleResolver });
  throwsCode(() => stale.freeze_batch_manifest(request("freeze_batch_manifest", 1, null)), "head_control_work_task_manifest_stale");
  const status = current.get_pipeline_status(request("get_pipeline_status", null));
  assert.equal(status.revision, 1);
  assert.equal(status.manifest_frozen, false);
  ok(true, "stale registered WorkTask identities fail closed before freeze persistence");
});

// A corrupt or binding-foreign state is never substituted with a new domain,
// and an archived external pipeline is observed as archived before another cut
// can be attempted.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  fs.writeFileSync(statePath, "{bad-json", { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  fs.chmodSync(statePath, FILE_MODE);
  throwsCode(() => domain(directory).get_pipeline_status(request("get_pipeline_status", null)), "corrupt_head_control_work_task_state");

  // Make a separate valid state foreign by changing only its persisted Head
  // generation; generation is part of the storage identity, not a label.
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 1,
    binding: { ...binding, generation: 8 },
    revision: 0,
    stage: "empty",
    manifest: null,
    pipeline_digest: null,
    pending: null,
  }), { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  fs.chmodSync(statePath, FILE_MODE);
  throwsCode(() => domain(directory).get_pipeline_status(request("get_pipeline_status", null)), "head_control_work_task_state_identity_mismatch");
  ok(true, "corrupt and foreign controller state fail closed instead of silently reinitializing");
});

// A Head generation bump (archive then unarchive) adopts the durable state
// only through the explicit initialize() transition.  Until then, and for the
// superseded generation afterwards, the state stays exactly as unreadable as
// any other foreign binding.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  const next = { ...binding, generation: 8 };
  const successor = createHeadControlWorkTaskDomain({
    binding: next, config_dir: directory, fs, resolve_registered_identity: resolveRegisteredIdentity, now: () => "2026-09-02T00:00:00.000Z",
  });
  const successorRequest = () => ({ ...request("get_pipeline_status", null), binding: copy(next) });
  throwsCode(() => successor.get_pipeline_status(successorRequest()), "head_control_work_task_state_identity_mismatch");
  const adopted = successor.initialize();
  assert.equal(adopted.revision, 1);
  assert.equal(adopted.stage, "manifest");
  assert.deepEqual(adopted.binding, next);
  assert.equal(successor.get_pipeline_status(successorRequest()).manifest_frozen, false);
  assert.match(fs.readFileSync(headControlWorkTaskDomainPath(directory, binding), "utf8"), /"generation":8/);
  throwsCode(() => current.get_pipeline_status(request("get_pipeline_status", null)), "head_control_work_task_state_identity_mismatch");
  throwsCode(() => current.initialize(), "head_control_work_task_state_identity_mismatch");
  ok(true, "a newer Head generation adopts durable state through initialize() while the stale generation stays locked out");
});

withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null));
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const state = store.readRecoverySnapshot({ installation_id: binding.installation_id, project_id: binding.project_id });
  applyPipelineEvent(directory, state, { version: 1, kind: "set_archived", event_id: "domain_archive", archived: true }, {
    kind: "archive", event_id: "domain_archive", archived: true,
  });
  const archived = current.get_pipeline_status(request("get_pipeline_status", null));
  assert.equal(archived.archived, true);
  assert.equal(archived.revision, 3);
  throwsCode(() => current.cut_batch(request("cut_batch", 3, { cut: { tasks: [{ work_task_ref: copy(state.manifest.tasks[0].ref), candidate_digest: candidateSha }] } })),
    "head_control_work_task_archived");
  ok(true, "archived external pipeline state is surfaced and blocks further Head mutations");
});

// #1058: the correction route and the Head-private propagation-stop read
// reach the owning review service only through this bound domain, then the
// finished batch is retired and a successor manifest is frozen for the same
// project while the retired record stays readable for provenance.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(reviewManifest()) }));
  const frozen = current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null));
  assert.equal(frozen.revision, 2);
  const owner = { installation_id: binding.installation_id, project_id: binding.project_id };
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  let state = store.readRecoverySnapshot(owner);
  const ref = state.manifest.tasks[0].ref;
  state = applyPipelineEvent(directory, state, { version: 1, kind: "assign_build", event_id: "domain_review_build", work_task_ref: copy(ref), assignment_id: "domain_review_assignment", base_sha: baseSha });
  const candidate = exactCandidate(ref);
  applyPipelineEvent(directory, state, { version: 1, kind: "record_candidate", event_id: "domain_review_candidate", assignment_id: "domain_review_assignment", candidate });
  const review = createWorkTaskIndependentReviewService({ config_dir: directory, fs });
  const opened = review.openIndependentReview({ version: 1, event_id: "domain_review_open", work_task_ref: copy(ref), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }], opened_at: "2026-09-02T00:01:00.000Z" });
  const stopRequest = (keys, taskRef = ref) => request("read_propagation_stop", null, { work_task_ref: copy(taskRef) }, keys);
  const quiet = current.read_propagation_stop(stopRequest({ correlation_id: "corr_stop_quiet", idempotency_key: "idem_stop_quiet" }));
  assert.equal(quiet.detail, null);
  assert.equal(quiet.status.revision, 3, "the externally advanced pipeline is observed as one new controller revision");
  review.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest,
    receipt: receipt(opened.review_round_ref, "receipt_re2_stop", "request_changes", [{ finding_id: "finding_shared_base", severity: "blocking", propagation: "propagating", summary: "shared base drift" }]) },
  reviewerContext("re2", "2026-09-02T00:02:00.000Z"));
  const stop = current.read_propagation_stop(stopRequest({ correlation_id: "corr_stop_pending", idempotency_key: "idem_stop_pending" }));
  assert.equal(stop.status.revision, 3);
  assert.equal(stop.detail.kind, "propagation_stop_pending");
  assert.equal(stop.detail.target, "head_private");
  assert.equal(stop.detail.candidate_digest, opened.candidate_digest);
  assert.deepEqual(stop.detail.dependency_chain.map((entry) => entry.task_key), ["dependent"]);
  assert.doesNotMatch(JSON.stringify(stop), /receipt|finding|reviewer|verdict|request_changes|shared base/);
  const foreign = { ...copy(ref), project_id: "other" };
  throwsCode(() => current.read_propagation_stop(stopRequest({ correlation_id: "corr_stop_foreign", idempotency_key: "idem_stop_foreign" }, foreign)), "head_control_work_task_binding_denied");
  ok(true, "a sealed propagating finding is readable only as the redacted Head-private stop over the declared chain, bound to this project");

  review.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re1_stop", "approve") }, reviewerContext("re1", "2026-09-02T00:03:00.000Z"));
  const reconciliation = createWorkTaskReviewReconciliationService({ config_dir: directory, fs });
  const correction = { work_task_ref: copy(ref), review_round_ref: copy(opened.review_round_ref), candidate_digest: opened.candidate_digest };
  reconciliation.reconcileReleasedReview({ version: 1, ...copy(correction) });
  assert.equal(store.readRecoverySnapshot(owner).pipeline.tasks[0].state, "changes_requested");
  assert.equal(current.get_pipeline_status(request("get_pipeline_status", null, null, { correlation_id: "corr_status_cr", idempotency_key: "idem_status_cr" })).revision, 4);
  throwsCode(() => current.queue_local_correction(request("queue_local_correction", 4, { correction: { ...copy(correction), work_task_ref: foreign } }, { correlation_id: "corr_corr_foreign", idempotency_key: "idem_corr_foreign" })), "head_control_work_task_binding_denied");
  assert.equal(store.readRecoverySnapshot(owner).pipeline.tasks[0].state, "changes_requested");
  const queued = current.queue_local_correction(request("queue_local_correction", 4, { correction: copy(correction) }));
  assert.equal(queued.status.revision, 5);
  assert.equal(queued.status.manifest_frozen, true);
  assert.equal(queued.detail.outcome, "queued");
  assert.match(queued.detail.checkpoint_id, /^checkpoint_[a-f0-9]{48}$/);
  assert.deepEqual(queued.detail.work_task_ref, ref);
  const slot = store.readRecoverySnapshot(owner).pipeline.tasks[0];
  assert.equal(slot.state, "queued");
  assert.deepEqual(slot.correction, { checkpoint_id: queued.detail.checkpoint_id, count: 1 });
  assert.equal(queued.status.pipeline_digest, store.readRecoverySnapshot(owner).pipeline.pipeline_digest);
  throwsCode(() => current.queue_local_correction(request("queue_local_correction", 5, { correction: { ...copy(correction), candidate_digest: "e".repeat(64) } }, { correlation_id: "corr_corr_stale", idempotency_key: "idem_corr_stale" })), "head_control_work_task_correction_rejected");
  ok(true, "a reconciled change request is returned to Dev as one bounded correction through the bound domain");

  const retired = current.retire_batch(request("retire_batch", 5, null));
  assert.deepEqual(retired, { revision: 6, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  assert.equal(current.project_current_batch(), null);
  assert.throws(() => store.readRecoverySnapshot(owner), (error) => error.code === "work_task_pipeline_store_missing");
  const provenance = store.readRetiredSnapshots(owner);
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].manifest.manifest_digest, frozen.manifest_digest);
  assert.equal(provenance[0].pipeline.archived, true);
  assert.equal(provenance[0].terminal_audit.at(-1).kind, "archive");
  assert.equal(provenance[0].pipeline.tasks[0].correction.count, 1);
  throwsCode(() => current.retire_batch(request("retire_batch", 6, null, { correlation_id: "corr_retire_again", idempotency_key: "idem_retire_again" })), "head_control_work_task_invalid_transition");
  const successor = copy(manifest());
  const put = current.put_batch_manifest(request("put_batch_manifest", 6, { manifest: successor }, { correlation_id: "corr_put_successor", idempotency_key: "idem_put_successor" }));
  assert.equal(put.revision, 7);
  assert.equal(put.manifest_digest, successor.manifest_digest);
  const frozenSuccessor = current.freeze_batch_manifest(request("freeze_batch_manifest", 7, null, { correlation_id: "corr_freeze_successor", idempotency_key: "idem_freeze_successor" }));
  assert.equal(frozenSuccessor.revision, 8);
  assert.equal(frozenSuccessor.manifest_frozen, true);
  assert.notEqual(frozenSuccessor.manifest_digest, frozen.manifest_digest);
  assert.equal(store.readRecoverySnapshot(owner).manifest.manifest_digest, frozenSuccessor.manifest_digest);
  assert.equal(store.readRetiredSnapshots(owner)[0].manifest.manifest_digest, frozen.manifest_digest);
  assert.deepEqual(current.project_current_batch().repositories[0].work_items[0].tasks.map((task) => task.state), ["queued"]);
  assert.equal(domain(directory).get_pipeline_status(request("get_pipeline_status", null, null, { correlation_id: "corr_status_successor", idempotency_key: "idem_status_successor" })).revision, 8);
  ok(true, "a retired batch frees the active path for a successor freeze while its retired record stays readable for provenance");
});

// Retirement refuses a batch that still holds Dev or reviewer authority, and
// a crash between the store's atomic retirement and the domain's empty write
// is healed from the retired record itself instead of reporting a missing
// pipeline forever.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null));
  const owner = { installation_id: binding.installation_id, project_id: binding.project_id };
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const state = store.readRecoverySnapshot(owner);
  applyPipelineEvent(directory, state, { version: 1, kind: "assign_build", event_id: "domain_active_build", work_task_ref: copy(state.manifest.tasks[0].ref), assignment_id: "domain_active_assignment", base_sha: baseSha });
  throwsCode(() => current.retire_batch(request("retire_batch", 3, null)), "head_control_work_task_batch_active");
  assert.equal(current.get_pipeline_status(request("get_pipeline_status", null)).manifest_frozen, true);
  assert.equal(store.readRetiredSnapshots(owner).length, 0);
  ok(true, "a batch with active build authority cannot be retired");
});
// #1071 shared fixture for the interrupted-retirement cases below.  Every one
// of them reaches the same durable point: one frozen batch at revision 2 whose
// pipeline is the freeze's initial pipeline.
function frozenBatchFor(directory, faultFs) {
  const current = domain(directory, faultFs ? { fs: faultFs } : {});
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  const frozen = current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null));
  assert.equal(frozen.revision, 2);
  return {
    current,
    frozen,
    owner: { installation_id: binding.installation_id, project_id: binding.project_id },
    store: createWorkTaskPipelineStore({ config_dir: directory, fs }),
  };
}
function persistedState(directory) {
  return JSON.parse(fs.readFileSync(headControlWorkTaskDomainPath(directory, binding), "utf8"));
}
const emptyStatus = (revision) => ({ revision, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
const statusRequest = (label) => request("get_pipeline_status", null, null, { correlation_id: `corr_status_${label}`, idempotency_key: `idem_status_${label}` });

// #1071: the retirement intent is durable before the store retirement, names
// that one transition exactly, and a crash after the store has retired the
// record is finished from the intent — not from whatever the retired records
// happen to contain.  A restart replays the same completed transition once.
withDirectory((directory) => {
  let armed = false;
  let domainWrites = 0;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("head-control-work-task-domain")) {
      domainWrites += 1;
      // Write 1 is the intent, write 2 the empty state after the store has
      // already retired the record.  Only the second is lost.
      if (domainWrites === 2) {
        const error = new Error("injected crash after store retirement");
        error.code = "EIO";
        throw error;
      }
    }
    return fs.renameSync(from, to);
  };
  const { current, frozen, owner, store } = frozenBatchFor(directory, faultFs);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 2, null)), "head_control_work_task_state_write_failed");
  assert.equal(domainWrites, 2, "the intent is written before the store retirement, the empty state after it");
  assert.equal(store.readRetiredSnapshots(owner).length, 1, "the store retirement is durable before the domain write");
  const record = store.readRetiredSnapshots(owner)[0];
  const stalled = persistedState(directory);
  assert.equal(stalled.stage, "frozen");
  assert.equal(stalled.revision, 2);
  assert.deepEqual(Object.keys(stalled.pending).sort(),
    ["action", "archived_pipeline_digest", "expected_pipeline_digest", "expected_revision", "fingerprint", "manifest_digest", "retirement_event_id"]);
  assert.equal(stalled.pending.action, "retire_batch");
  assert.equal(stalled.pending.expected_revision, 2);
  assert.equal(stalled.pending.manifest_digest, frozen.manifest_digest);
  assert.equal(stalled.pending.expected_pipeline_digest, frozen.pipeline_digest);
  assert.notEqual(stalled.pending.archived_pipeline_digest, stalled.pending.expected_pipeline_digest);
  assert.equal(stalled.pending.archived_pipeline_digest, record.pipeline.pipeline_digest,
    "the intent pins the exact digest the retired record carries");
  assert.match(stalled.pending.retirement_event_id, /^hretire_[a-f0-9]{64}$/);
  assert.deepEqual(record.terminal_audit, [{
    kind: "archive", event_id: stalled.pending.retirement_event_id, archived: true, pipeline_digest: record.pipeline.pipeline_digest,
  }]);
  const recovered = domain(directory);
  assert.deepEqual(recovered.get_pipeline_status(request("get_pipeline_status", null)), emptyStatus(3));
  assert.equal(persistedState(directory).pending, null);
  assert.deepEqual(domain(directory).get_pipeline_status(statusRequest("replay")), emptyStatus(3),
    "a second restart replays the same completed transition");
  assert.equal(store.readRetiredSnapshots(owner).length, 1, "recovery never retires a second record");
  assert.equal(recovered.put_batch_manifest(request("put_batch_manifest", 3, { manifest: copy(manifest()) }, { correlation_id: "corr_put_healed", idempotency_key: "idem_put_healed" })).revision, 4);
  ok(true, "an interrupted retirement is finished from its exact pending intent and accepts a successor manifest");
});

// A crash before the intent reaches disk retires nothing: the store keeps its
// active record, the domain keeps its frozen batch, and a retry retires once.
withDirectory((directory) => {
  let armed = false;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("head-control-work-task-domain")) {
      const error = new Error("injected crash before the retirement intent");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const { current, frozen, owner, store } = frozenBatchFor(directory, faultFs);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 2, null)), "head_control_work_task_state_write_failed");
  armed = false;
  assert.equal(store.readRetiredSnapshots(owner).length, 0);
  assert.equal(store.readRecoverySnapshot(owner).pipeline.archived, false);
  const stalled = persistedState(directory);
  assert.equal(stalled.stage, "frozen");
  assert.equal(stalled.pending, null, "no intent means nothing to recover");
  assert.deepEqual(domain(directory).get_pipeline_status(statusRequest("no_intent")), {
    revision: 2, archived: false, manifest_digest: frozen.manifest_digest, pipeline_digest: frozen.pipeline_digest, manifest_frozen: true, cut_safe: false,
  });
  assert.deepEqual(current.retire_batch(request("retire_batch", 2, null, { correlation_id: "corr_retire_retry", idempotency_key: "idem_retire_retry" })), emptyStatus(3));
  assert.equal(store.readRetiredSnapshots(owner).length, 1);
  ok(true, "a crash before the retirement intent retires nothing and leaves the frozen batch retryable");
});

// A crash after the intent but before the store retirement leaves the active
// record untouched; recovery re-drives that exact retirement to completion.
withDirectory((directory) => {
  let armed = false;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("work-task-pipelines") && !/\.retired\.\d{4}\.json$/.test(String(to))) {
      const error = new Error("injected crash before the store retirement");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const { current, frozen, owner, store } = frozenBatchFor(directory, faultFs);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 2, null)), "head_control_work_task_pipeline_unavailable");
  armed = false;
  assert.equal(store.readRetiredSnapshots(owner).length, 0);
  assert.equal(store.readRecoverySnapshot(owner).pipeline.archived, false);
  assert.equal(store.readRecoverySnapshot(owner).pipeline.pipeline_digest, frozen.pipeline_digest);
  const stalled = persistedState(directory);
  assert.equal(stalled.pending.action, "retire_batch");
  assert.equal(stalled.pending.expected_pipeline_digest, frozen.pipeline_digest);
  const recovered = domain(directory);
  assert.deepEqual(recovered.get_pipeline_status(request("get_pipeline_status", null)), emptyStatus(3));
  const record = store.readRetiredSnapshots(owner);
  assert.equal(record.length, 1);
  assert.equal(record[0].pipeline.archived, true);
  assert.equal(record[0].terminal_audit.at(-1).event_id, stalled.pending.retirement_event_id,
    "recovery replays the intent's own deterministic retirement event, never a second one");
  ok(true, "a crash before the store retirement is re-driven from the intent under the same retirement event");
});

// A crash after the store archived the record but before it renamed it away
// leaves the active record at the intent's pinned archived digest; recovery
// finishes the rename instead of treating it as a foreign pipeline.
withDirectory((directory) => {
  let armed = false;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && /\.retired\.\d{4}\.json$/.test(String(to))) {
      const error = new Error("injected crash between the archive and the retired rename");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const { current, frozen, owner, store } = frozenBatchFor(directory, faultFs);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 2, null)), "head_control_work_task_pipeline_unavailable");
  armed = false;
  assert.equal(store.readRetiredSnapshots(owner).length, 0);
  const stranded = store.readRecoverySnapshot(owner);
  assert.equal(stranded.pipeline.archived, true);
  const stalled = persistedState(directory);
  assert.notEqual(stranded.pipeline.pipeline_digest, frozen.pipeline_digest);
  assert.equal(stalled.pending.archived_pipeline_digest, stranded.pipeline.pipeline_digest);
  const recovered = domain(directory);
  assert.deepEqual(recovered.get_pipeline_status(request("get_pipeline_status", null)), emptyStatus(3));
  assert.equal(store.readRetiredSnapshots(owner).length, 1);
  assert.equal(store.readRetiredSnapshots(owner)[0].pipeline.pipeline_digest, stalled.pending.archived_pipeline_digest);
  ok(true, "an archived-but-unrenamed record is finished under the intent's pinned archived digest");
});

// A competing writer that advances the pipeline after the intent is durable
// changes it into a batch the intent never named.  Recovery fails closed the
// same way an interrupted cut does, and touches neither store nor state.
withDirectory((directory) => {
  let armed = false;
  const owner = { installation_id: binding.installation_id, project_id: binding.project_id };
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    const result = fs.renameSync(from, to);
    if (armed && String(to).includes("head-control-work-task-domain")) {
      armed = false;
      const live = store.readRecoverySnapshot(owner);
      applyPipelineEvent(directory, live, {
        version: 1, kind: "assign_build", event_id: "domain_competing_build", work_task_ref: copy(live.manifest.tasks[0].ref),
        assignment_id: "domain_competing_assignment", base_sha: baseSha,
      });
    }
    return result;
  };
  const { current, frozen } = frozenBatchFor(directory, faultFs);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 2, null)), "head_control_work_task_pipeline_stale");
  assert.equal(store.readRetiredSnapshots(owner).length, 0);
  assert.equal(store.readRecoverySnapshot(owner).pipeline.archived, false);
  assert.equal(store.readRecoverySnapshot(owner).pipeline.tasks[0].state, "building");
  const stalled = persistedState(directory);
  assert.equal(stalled.stage, "frozen");
  assert.equal(stalled.revision, 2);
  assert.equal(stalled.pending.action, "retire_batch");
  assert.equal(stalled.pending.expected_pipeline_digest, frozen.pipeline_digest);
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("competing")), "head_control_work_task_pipeline_stale");
  ok(true, "a pipeline a competing writer moved after the intent is refused, never retired from the intent");
});

// The pending retirement belongs to the durable state, not to the Head that
// wrote it: a superseded generation is locked out and only the generation that
// adopted the state through initialize() finishes that exact transition.
withDirectory((directory) => {
  let armed = false;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("work-task-pipelines") && !/\.retired\.\d{4}\.json$/.test(String(to))) {
      const error = new Error("injected crash before the store retirement");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const { current, owner, store } = frozenBatchFor(directory, faultFs);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 2, null)), "head_control_work_task_pipeline_unavailable");
  armed = false;
  const next = { ...binding, generation: 8 };
  const successor = createHeadControlWorkTaskDomain({ binding: next, config_dir: directory, fs, resolve_registered_identity: resolveRegisteredIdentity, now: () => "2026-09-02T00:00:00.000Z" });
  assert.equal(successor.initialize().stage, "frozen");
  throwsCode(() => current.get_pipeline_status(statusRequest("stale_generation")), "head_control_work_task_state_identity_mismatch");
  assert.equal(store.readRetiredSnapshots(owner).length, 0);
  assert.deepEqual(successor.get_pipeline_status({ ...statusRequest("adopting_generation"), binding: copy(next) }), emptyStatus(3));
  assert.equal(store.readRetiredSnapshots(owner).length, 1);
  ok(true, "a superseded generation cannot finish a pending retirement; the adopting generation finishes it once");
});

// A project archive can archive a frozen batch before Head retires it.  The
// store renames such a record untouched rather than archiving it twice, so the
// intent pins the digest the record already carries and an interrupted
// retirement is still finished from that exact record.
withDirectory((directory) => {
  let armed = false;
  let domainWrites = 0;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("head-control-work-task-domain")) {
      domainWrites += 1;
      if (domainWrites === 2) {
        const error = new Error("injected crash after store retirement");
        error.code = "EIO";
        throw error;
      }
    }
    return fs.renameSync(from, to);
  };
  const { current, frozen, owner, store } = frozenBatchFor(directory, faultFs);
  applyPipelineEvent(directory, store.readRecoverySnapshot(owner),
    { version: 1, kind: "set_archived", event_id: "domain_project_archive", archived: true },
    { kind: "archive", event_id: "domain_project_archive", archived: true });
  const archivedDigest = store.readRecoverySnapshot(owner).pipeline.pipeline_digest;
  assert.notEqual(archivedDigest, frozen.pipeline_digest);
  assert.equal(current.get_pipeline_status(statusRequest("archived")).archived, true);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 3, null)), "head_control_work_task_state_write_failed");
  armed = false;
  const intent = persistedState(directory).pending;
  assert.equal(intent.expected_pipeline_digest, archivedDigest);
  assert.equal(intent.archived_pipeline_digest, archivedDigest, "an already-archived record is renamed untouched");
  const record = store.readRetiredSnapshots(owner);
  assert.equal(record.length, 1);
  assert.equal(record[0].pipeline.pipeline_digest, archivedDigest);
  assert.deepEqual(record[0].terminal_audit, [
    { kind: "archive", event_id: "domain_project_archive", archived: true, pipeline_digest: archivedDigest },
    { kind: "archive", event_id: intent.retirement_event_id, archived: true, pipeline_digest: archivedDigest },
  ], "the retirement adds no second archive event, but does record its own marker beside the project archive");
  assert.deepEqual(domain(directory).get_pipeline_status(statusRequest("archived_recovered")), emptyStatus(4));
  ok(true, "an already-archived batch is retired and recovered under the digest it already carries");
});

// Same-content successor: a successor repeats its predecessor's manifest digest
// AND its initial pipeline digest byte for byte.  The intent binds revision,
// manifest, and pipeline digest together, and the retirement event it names is
// revision-bound, so the predecessor's retired record cannot answer for the
// successor even under an identical invocation.
withDirectory((directory) => {
  let armed = false;
  let domainWrites = 0;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("head-control-work-task-domain")) {
      domainWrites += 1;
      if (domainWrites === 2) {
        const error = new Error("injected crash after store retirement");
        error.code = "EIO";
        throw error;
      }
    }
    return fs.renameSync(from, to);
  };
  const { current, frozen, owner, store } = frozenBatchFor(directory, faultFs);
  const retireKeys = { correlation_id: "corr_retire_shared", idempotency_key: "idem_retire_shared" };
  assert.deepEqual(current.retire_batch(request("retire_batch", 2, null, retireKeys)), emptyStatus(3));
  const predecessor = store.readRetiredSnapshots(owner)[0];
  current.put_batch_manifest(request("put_batch_manifest", 3, { manifest: copy(manifest()) }, { correlation_id: "corr_put_same", idempotency_key: "idem_put_same" }));
  const successor = current.freeze_batch_manifest(request("freeze_batch_manifest", 4, null, { correlation_id: "corr_freeze_same", idempotency_key: "idem_freeze_same" }));
  assert.equal(successor.revision, 5);
  assert.equal(successor.manifest_digest, frozen.manifest_digest, "the successor repeats the manifest digest exactly");
  assert.equal(successor.pipeline_digest, frozen.pipeline_digest, "and starts from a byte-identical pipeline");
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const withIntent = (pending) => fs.writeFileSync(statePath, JSON.stringify({ ...stored, pending }), { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  const exactIntent = {
    action: "retire_batch",
    expected_revision: 5,
    fingerprint: "a".repeat(64),
    manifest_digest: successor.manifest_digest,
    expected_pipeline_digest: successor.pipeline_digest,
    archived_pipeline_digest: predecessor.pipeline.pipeline_digest,
    retirement_event_id: predecessor.terminal_audit.at(-1).event_id,
  };
  withIntent({ ...exactIntent, expected_revision: 2 });
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("intent_stale_revision")), "corrupt_head_control_work_task_state");
  withIntent({ ...exactIntent, manifest_digest: "e".repeat(64) });
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("intent_other_manifest")), "corrupt_head_control_work_task_state");
  withIntent({ ...exactIntent, expected_pipeline_digest: "e".repeat(64) });
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("intent_other_pipeline")), "corrupt_head_control_work_task_state");
  assert.match(fs.readFileSync(statePath, "utf8"), /"revision":5,"stage":"frozen"/, "no stale or mismatched intent retires the successor");
  fs.writeFileSync(statePath, JSON.stringify(stored), { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  domainWrites = 0;
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 5, null, retireKeys)), "head_control_work_task_state_write_failed");
  armed = false;
  const own = persistedState(directory).pending;
  assert.notEqual(own.retirement_event_id, exactIntent.retirement_event_id,
    "the same invocation at a later revision names a different retirement event");
  assert.notEqual(own.archived_pipeline_digest, exactIntent.archived_pipeline_digest,
    "so the successor's intent can never be satisfied by its predecessor's retired record");
  assert.equal(store.readRetiredSnapshots(owner).length, 2);
  assert.deepEqual(domain(directory).get_pipeline_status(statusRequest("successor_recovered")), emptyStatus(6));
  ok(true, "a same-content successor is separated from its predecessor's retired record by revision, never by content");
});

// #1071 (review): the pinned archived pipeline digest is not proof on its own.
// A project archive derives its event from owner and manifest digest alone
// (server/project-archive-transition.js), with no revision in it, so a
// predecessor and a same-content successor archived that way hold byte-
// identical pipelines and byte-identical pipeline digests.  Retirement takes no
// archive transition from such a batch, so nothing revision-bound reaches its
// history either.  Only the retirement's own durable marker separates them: a
// successor whose active record vanished before its marker was ever written
// must fail closed, not be answered for by its predecessor's record.
withDirectory((directory) => {
  // One literal event id for both batches: this is exactly what
  // `archiveEventId(owner, manifest_digest)` yields for two same-content ones.
  const archiveEvent = "parch_shared_same_content_archive";
  const projectArchive = (target) => applyPipelineEvent(directory, target,
    { version: 1, kind: "set_archived", event_id: archiveEvent, archived: true },
    { kind: "archive", event_id: archiveEvent, archived: true });
  let armed = false;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("work-task-pipelines")) {
      const error = new Error("injected crash before the retirement marker and rename");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const { current, owner, store } = frozenBatchFor(directory, faultFs);
  projectArchive(store.readRecoverySnapshot(owner));
  assert.equal(current.get_pipeline_status(statusRequest("predecessor_archived")).revision, 3);
  assert.deepEqual(current.retire_batch(request("retire_batch", 3, null, { correlation_id: "corr_retire_arch_pred", idempotency_key: "idem_retire_arch_pred" })), emptyStatus(4));
  const predecessor = store.readRetiredSnapshots(owner)[0];
  current.put_batch_manifest(request("put_batch_manifest", 4, { manifest: copy(manifest()) }, { correlation_id: "corr_put_arch_same", idempotency_key: "idem_put_arch_same" }));
  assert.equal(current.freeze_batch_manifest(request("freeze_batch_manifest", 5, null, { correlation_id: "corr_freeze_arch_same", idempotency_key: "idem_freeze_arch_same" })).revision, 6);
  projectArchive(store.readRecoverySnapshot(owner));
  assert.equal(current.get_pipeline_status(statusRequest("successor_archived")).revision, 7);
  assert.equal(store.readRecoverySnapshot(owner).pipeline.pipeline_digest, predecessor.pipeline.pipeline_digest,
    "the successor's archived pipeline is byte-identical to the retired predecessor's");
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 7, null, { correlation_id: "corr_retire_arch_succ", idempotency_key: "idem_retire_arch_succ" })),
    "head_control_work_task_pipeline_unavailable");
  armed = false;
  const intent = persistedState(directory).pending;
  assert.equal(intent.action, "retire_batch");
  assert.equal(intent.archived_pipeline_digest, predecessor.pipeline.pipeline_digest,
    "so the successor's intent pins the very digest the predecessor's record carries");
  assert.notEqual(intent.retirement_event_id, predecessor.terminal_audit.at(-1).event_id);
  assert.equal(store.readRetiredSnapshots(owner).length, 1);
  fs.unlinkSync(workTaskPipelineStorePath(directory, owner));
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("arch_successor_lost")), "head_control_work_task_pipeline_missing");
  const persisted = persistedState(directory);
  assert.equal(persisted.stage, "frozen");
  assert.equal(persisted.revision, 7);
  assert.equal(persisted.pending.action, "retire_batch");
  assert.equal(store.readRetiredSnapshots(owner).length, 1, "the predecessor's record is untouched and answers for nobody");
  ok(true, "a project-archived predecessor cannot answer for a same-content successor whose retirement never marked a record");
});

// The marker is durable before the rename, so a retirement interrupted between
// those two writes replays: the record is renamed and the marker is not added
// a second time (a duplicate event id would make the stored record invalid).
withDirectory((directory) => {
  let armed = false;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && /\.retired\.\d{4}\.json$/.test(String(to))) {
      const error = new Error("injected crash between the marker and the retired rename");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const { current, owner, store } = frozenBatchFor(directory, faultFs);
  applyPipelineEvent(directory, store.readRecoverySnapshot(owner),
    { version: 1, kind: "set_archived", event_id: "domain_project_archive", archived: true },
    { kind: "archive", event_id: "domain_project_archive", archived: true });
  const archivedDigest = store.readRecoverySnapshot(owner).pipeline.pipeline_digest;
  assert.equal(current.get_pipeline_status(statusRequest("replay_archived")).revision, 3);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 3, null)), "head_control_work_task_pipeline_unavailable");
  armed = false;
  const intent = persistedState(directory).pending;
  const stranded = store.readRecoverySnapshot(owner);
  assert.equal(stranded.pipeline.pipeline_digest, archivedDigest, "recording the marker leaves the pipeline itself untouched");
  const audit = [
    { kind: "archive", event_id: "domain_project_archive", archived: true, pipeline_digest: archivedDigest },
    { kind: "archive", event_id: intent.retirement_event_id, archived: true, pipeline_digest: archivedDigest },
  ];
  assert.deepEqual(stranded.terminal_audit, audit, "the retirement marker is durable before the rename");
  assert.deepEqual(domain(directory).get_pipeline_status(statusRequest("replay_recovered")), emptyStatus(4));
  const record = store.readRetiredSnapshots(owner);
  assert.equal(record.length, 1);
  assert.deepEqual(record[0].terminal_audit, audit, "the replayed retirement adds no second marker");
  ok(true, "a retirement replayed after its marker was written renames the record without duplicating the marker");
});

// Defence in depth: the two halves are required together, so a retired record
// whose marker and pipeline disagree — a forged or corrupted record, not one
// this store can write — answers for nothing.  Each half is checked by making
// exactly the other half of the record wrong.
withDirectory((directory) => {
  let armed = false;
  let domainWrites = 0;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("head-control-work-task-domain")) {
      domainWrites += 1;
      if (domainWrites === 2) {
        const error = new Error("injected crash after store retirement");
        error.code = "EIO";
        throw error;
      }
    }
    return fs.renameSync(from, to);
  };
  const { current, owner, store } = frozenBatchFor(directory, faultFs);
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 2, null)), "head_control_work_task_state_write_failed");
  armed = false;
  const intent = persistedState(directory).pending;
  const pipelineDirectory = path.dirname(workTaskPipelineStorePath(directory, owner));
  const retiredNames = fs.readdirSync(pipelineDirectory).filter((name) => name.includes(".retired."));
  assert.equal(retiredNames.length, 1);
  const retiredPath = path.join(pipelineDirectory, retiredNames[0]);
  const record = JSON.parse(fs.readFileSync(retiredPath, "utf8"));
  const rewrite = (value) => fs.writeFileSync(retiredPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  const markerIndex = record.terminal_audit.findIndex((entry) => entry.event_id === intent.retirement_event_id);
  assert.equal(markerIndex, 0);
  assert.equal(record.terminal_audit[markerIndex].pipeline_digest, record.pipeline.pipeline_digest);

  // (a) the marker names a pipeline the record does not hold.
  const forgedMarker = copy(record);
  forgedMarker.terminal_audit[markerIndex].pipeline_digest = "e".repeat(64);
  rewrite(forgedMarker);
  assert.equal(store.readRetiredSnapshots(owner)[0].pipeline.pipeline_digest, intent.archived_pipeline_digest,
    "the forged record still carries the pinned pipeline, so only the marker can refuse it");
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("forged_marker")), "head_control_work_task_pipeline_missing");

  // (d) the marker records an un-archive rather than the retirement's archive.
  const forgedFlag = copy(record);
  forgedFlag.terminal_audit[markerIndex].archived = false;
  rewrite(forgedFlag);
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("forged_flag")), "head_control_work_task_pipeline_missing");

  // (b) the record holds a pipeline the marker does not name.
  const forgedPipeline = copy(record);
  forgedPipeline.pipeline = applyWorkTaskPipelinePlan(record.pipeline,
    planWorkTaskPipelineEvent(record.pipeline, { version: 1, kind: "set_archived", event_id: "forged_second_archive", archived: true }));
  assert.notEqual(forgedPipeline.pipeline.pipeline_digest, intent.archived_pipeline_digest);
  rewrite(forgedPipeline);
  assert.deepEqual(store.readRetiredSnapshots(owner)[0].terminal_audit[markerIndex], record.terminal_audit[markerIndex],
    "the forged record still carries this retirement's exact marker, so only the pipeline digest can refuse it");
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("forged_pipeline")), "head_control_work_task_pipeline_missing");

  // (e) the marker's `kind` never reaches this domain's check: an audit entry
  // that is not an archive disposition cannot carry `archived` at all, so the
  // store's own validator refuses the whole record first.  Proven, not assumed.
  const forgedKind = copy(record);
  forgedKind.terminal_audit[markerIndex].kind = "contract_change";
  rewrite(forgedKind);
  assert.throws(() => store.readRetiredSnapshots(owner), (error) => error.code === "corrupt_work_task_pipeline_store");
  throwsCode(() => domain(directory).get_pipeline_status(statusRequest("forged_kind")), "head_control_work_task_pipeline_missing");

  // (c) the record as the store actually wrote it finishes the retirement.
  rewrite(record);
  assert.deepEqual(domain(directory).get_pipeline_status(statusRequest("intact_record")), emptyStatus(3));
  ok(true, "recovery needs the pinned pipeline digest and the exact retirement marker together, never either alone");
});

// #1071: `manifestDigest` covers only the version, identity, delivery mode and
// task refs, so a successor batch whose content repeats an already-retired
// predecessor carries the exact same manifest digest.  If that successor's own
// active store record is lost — a frozen store write that did not survive the
// crash, or a partially restored config directory — recovery must not read the
// predecessor's archived retired record as proof that THIS batch was retired.
// Nothing retired the successor, so recovery has to fail closed and leave the
// frozen state on disk instead of emptying it from historical content.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const owner = { installation_id: binding.installation_id, project_id: binding.project_id };
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const predecessor = manifest();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(predecessor) }));
  current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null));
  assert.equal(current.retire_batch(request("retire_batch", 2, null)).revision, 3);
  assert.equal(store.readRetiredSnapshots(owner).length, 1);
  const successor = manifest();
  assert.equal(successor.manifest_digest, predecessor.manifest_digest,
    "a same-content successor shares its retired predecessor's manifest digest");
  current.put_batch_manifest(request("put_batch_manifest", 3, { manifest: copy(successor) },
    { correlation_id: "corr_put_same_content", idempotency_key: "idem_put_same_content" }));
  const frozenSuccessor = current.freeze_batch_manifest(request("freeze_batch_manifest", 4, null,
    { correlation_id: "corr_freeze_same_content", idempotency_key: "idem_freeze_same_content" }));
  assert.equal(frozenSuccessor.revision, 5);
  assert.equal(frozenSuccessor.manifest_frozen, true);
  assert.equal(store.readRecoverySnapshot(owner).pipeline.pipeline_digest, frozenSuccessor.pipeline_digest);
  fs.unlinkSync(workTaskPipelineStorePath(directory, owner));
  throwsCode(() => domain(directory).get_pipeline_status(request("get_pipeline_status", null, null,
    { correlation_id: "corr_status_lost", idempotency_key: "idem_status_lost" })), "head_control_work_task_pipeline_missing");
  const persisted = fs.readFileSync(headControlWorkTaskDomainPath(directory, binding), "utf8");
  assert.match(persisted, /"stage":"frozen"/);
  assert.match(persisted, /"revision":5/);
  assert.match(persisted, new RegExp(successor.manifest_digest));
  assert.equal(store.readRetiredSnapshots(owner).length, 1, "the predecessor's retired record is untouched");
  ok(true, "a same-content successor whose active store is lost fails closed instead of being retired by its predecessor's record");
});

// Linux reuses inode numbers eagerly, so a lock replaced after this writer
// closed its descriptor can report the original dev+ino. The stubbed lstat
// forces exactly that; only the lock token can then prove the replacement.
withDirectory((directory) => {
  domain(directory).initialize();
  const lockPath = `${headControlWorkTaskDomainPath(directory, binding)}.lock`;
  let inspections = 0;
  let original = null;
  const replacingFs = Object.create(fs);
  replacingFs.lstatSync = (target) => {
    if (target !== lockPath) return fs.lstatSync(target);
    inspections += 1;
    if (inspections === 1) {
      original = fs.lstatSync(target);
      return original;
    }
    if (inspections === 2) {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, "replacement-writer-lock", { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    }
    const stats = fs.lstatSync(target);
    stats.dev = original.dev;
    stats.ino = original.ino;
    return stats;
  };
  const current = domain(directory, { fs: replacingFs });
  throwsCode(() => current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) })), "head_control_work_task_state_lock_release_failed");
  assert.equal(inspections, 2);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement-writer-lock");
  ok(true, "a replacement lock carrying the original dev+ino is never unlinked by the original writer");
});

// #1069: a manifest that was put but never frozen wedges the domain.  Put
// demands `empty`, retirement demands `frozen`, and nothing else touches the
// `manifest` stage, so Head can neither replace nor walk away from a manifest
// it decided against, and no successor can be started for the project.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const decidedAgainst = manifest();
  const put = current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(decidedAgainst) }));
  assert.equal(put.revision, 1);
  assert.equal(put.manifest_frozen, false);
  const successor = copy(reviewManifest());
  assert.notEqual(successor.manifest_digest, decidedAgainst.manifest_digest);
  throwsCode(() => current.put_batch_manifest(request("put_batch_manifest", 1, { manifest: copy(successor) }, { correlation_id: "corr_wedged_put", idempotency_key: "idem_wedged_put" })),
    "head_control_work_task_invalid_transition");
  throwsCode(() => current.retire_batch(request("retire_batch", 1, null, { correlation_id: "corr_wedged_retire", idempotency_key: "idem_wedged_retire" })),
    "head_control_work_task_invalid_transition");
  const wedged = current.get_pipeline_status(request("get_pipeline_status", null));
  assert.equal(wedged.revision, 1);
  assert.equal(wedged.manifest_digest, decidedAgainst.manifest_digest);
  const abandoned = current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null));
  assert.deepEqual(abandoned, { revision: 2, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  const replaced = current.put_batch_manifest(request("put_batch_manifest", 2, { manifest: copy(successor) }, { correlation_id: "corr_successor_put", idempotency_key: "idem_successor_put" }));
  assert.equal(replaced.revision, 3);
  assert.equal(replaced.manifest_digest, successor.manifest_digest);
  ok(true, "Head can abandon a never-frozen manifest it decided against so a successor can be put");
});

// Abandonment is not a delete or a reset.  It is impossible once a freeze has
// begun, once a pipeline exists, and after retirement, and it never consults
// or touches the retired records that hold frozen and cut provenance.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const owner = { installation_id: binding.installation_id, project_id: binding.project_id };
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 0, null, { correlation_id: "corr_abandon_empty", idempotency_key: "idem_abandon_empty" })), "head_control_work_task_invalid_transition");
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null));
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 2, null, { correlation_id: "corr_abandon_frozen", idempotency_key: "idem_abandon_frozen" })), "head_control_work_task_invalid_transition");
  const advanced = advanceToAccepted(directory, store.readRecoverySnapshot(owner));
  current.cut_batch(request("cut_batch", 3, { cut: { tasks: [{ work_task_ref: copy(advanced.ref), candidate_digest: advanced.candidate.candidate_digest }] } }));
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 4, null, { correlation_id: "corr_abandon_cut", idempotency_key: "idem_abandon_cut" })), "head_control_work_task_invalid_transition");
  const retired = current.retire_batch(request("retire_batch", 4, null));
  assert.equal(retired.revision, 5);
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 5, null, { correlation_id: "corr_abandon_retired", idempotency_key: "idem_abandon_retired" })), "head_control_work_task_invalid_transition");
  const provenanceBefore = JSON.stringify(store.readRetiredSnapshots(owner));
  assert.equal(store.readRetiredSnapshots(owner).length, 1);
  const decidedAgainst = copy(reviewManifest());
  current.put_batch_manifest(request("put_batch_manifest", 5, { manifest: decidedAgainst }, { correlation_id: "corr_put_after_retire", idempotency_key: "idem_put_after_retire" }));
  const abandoned = current.abandon_batch_manifest(request("abandon_batch_manifest", 6, null));
  assert.equal(abandoned.revision, 7);
  assert.equal(JSON.stringify(store.readRetiredSnapshots(owner)), provenanceBefore, "the retired record with its cut history is byte-for-value untouched");
  assert.throws(() => store.readRecoverySnapshot(owner), (error) => error.code === "work_task_pipeline_store_missing");
  assert.doesNotMatch(fs.readFileSync(headControlWorkTaskDomainPath(directory, binding), "utf8"), new RegExp(decidedAgainst.manifest_digest));
  ok(true, "abandonment is refused for empty, frozen, cut, and retired states and leaves retired provenance untouched");
});

// Stale generation: after an archive/unarchive bump adopted the state, the
// superseded Head cannot abandon; a stale revision is refused the same way.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const decidedAgainst = manifest();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(decidedAgainst) }));
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 0, null, { correlation_id: "corr_abandon_stale_rev", idempotency_key: "idem_abandon_stale_rev" })), "head_control_work_task_stale_revision");
  const next = { ...binding, generation: 8 };
  const successor = createHeadControlWorkTaskDomain({ binding: next, config_dir: directory, fs, resolve_registered_identity: resolveRegisteredIdentity, now: () => "2026-09-02T00:00:00.000Z" });
  assert.equal(successor.initialize().stage, "manifest");
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null)), "head_control_work_task_state_identity_mismatch");
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  assert.match(fs.readFileSync(statePath, "utf8"), /"stage":"manifest"/);
  assert.match(fs.readFileSync(statePath, "utf8"), new RegExp(decidedAgainst.manifest_digest));
  const adopted = successor.abandon_batch_manifest({ ...request("abandon_batch_manifest", 1, null, { correlation_id: "corr_abandon_gen8", idempotency_key: "idem_abandon_gen8" }), binding: copy(next) });
  assert.deepEqual(adopted, { revision: 2, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  ok(true, "a stale generation or stale revision cannot abandon; only the adopting Head generation can");
});

// Archive during the transition: the intent is durable, then the project is
// archived and unarchived (a generation bump adopts the state) before the
// finalize.  The superseded Head's finalize is refused, and the adopting
// generation completes that exact intent once.
withDirectory((directory) => {
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  const lockPath = `${statePath}.lock`;
  const next = { ...binding, generation: 8 };
  const successor = createHeadControlWorkTaskDomain({ binding: next, config_dir: directory, fs, resolve_registered_identity: resolveRegisteredIdentity, now: () => "2026-09-02T00:00:00.000Z" });
  let lockAcquisitions = 0;
  let armed = false;
  let adoptedDuring = false;
  const racingFs = Object.create(fs);
  racingFs.openSync = (target, flags, mode) => {
    if (armed && target === lockPath && flags === "wx") {
      lockAcquisitions += 1;
      // prepared() takes the lock twice, the intent write is the third, and
      // the finalize is the fourth: adopt the durable intent just before it.
      if (lockAcquisitions === 4) {
        assert.match(fs.readFileSync(statePath, "utf8"), /"pending":\{"action":"abandon_batch_manifest"/);
        assert.equal(successor.initialize().binding.generation, 8);
        adoptedDuring = true;
      }
    }
    return fs.openSync(target, flags, mode);
  };
  const current = domain(directory, { fs: racingFs });
  current.initialize();
  const decidedAgainst = manifest();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(decidedAgainst) }));
  armed = true;
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null)), "head_control_work_task_state_identity_mismatch");
  armed = false;
  assert.equal(adoptedDuring, true);
  assert.equal(lockAcquisitions, 4);
  assert.equal(fs.existsSync(lockPath), false, "the refused finalize released its writer lock");
  assert.match(fs.readFileSync(statePath, "utf8"), /"generation":8/);
  assert.match(fs.readFileSync(statePath, "utf8"), /"pending":\{"action":"abandon_batch_manifest","expected_revision":1,"fingerprint":"[a-f0-9]{64}","manifest_digest":"[a-f0-9]{64}"\}/);
  const successorRequest = (keys) => ({ ...request("get_pipeline_status", null, null, keys), binding: copy(next) });
  assert.deepEqual(successor.get_pipeline_status(successorRequest({ correlation_id: "corr_adopt_status", idempotency_key: "idem_adopt_status" })),
    { revision: 2, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  assert.match(fs.readFileSync(statePath, "utf8"), /"pending":null/);
  assert.equal(successor.get_pipeline_status(successorRequest({ correlation_id: "corr_adopt_again", idempotency_key: "idem_adopt_again" })).revision, 2, "the recovered intent is not applied twice");
  throwsCode(() => current.get_pipeline_status(request("get_pipeline_status", null)), "head_control_work_task_state_identity_mismatch");
  ok(true, "an archive/unarchive bump during the transition hands the exact durable intent to the adopting generation, which completes it once");
});

// Competing writers: a live foreign writer lock refuses the abandon outright,
// and a second Head process that abandons first leaves the other's optimistic
// revision stale so the state is never advanced twice.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  const lockPath = `${statePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ version: 1, pid: process.pid, token: "f".repeat(32), host: require("node:os").hostname(), created_at: Date.now() }), { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null)), "head_control_work_task_state_locked");
  assert.match(fs.readFileSync(statePath, "utf8"), /"stage":"manifest"/);
  assert.match(fs.readFileSync(statePath, "utf8"), /"pending":null/);
  fs.unlinkSync(lockPath);
  const other = domain(directory);
  assert.equal(other.abandon_batch_manifest(request("abandon_batch_manifest", 1, null, { correlation_id: "corr_abandon_other", idempotency_key: "idem_abandon_other" })).revision, 2);
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null, { correlation_id: "corr_abandon_lost", idempotency_key: "idem_abandon_lost" })), "head_control_work_task_stale_revision");
  assert.equal(current.get_pipeline_status(request("get_pipeline_status", null)).revision, 2, "the losing writer did not advance the state a second time");
  ok(true, "a live competing writer lock refuses abandonment and a lost race is a stale revision, never a second abandonment");
});

// Same-content successor: the intent binds the revision and the digest
// together.  A stale intent carrying the right digest but an earlier revision,
// or the right revision but another digest, is corrupt and never clears the
// manifest; only the exact pair resumes.
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const content = manifest();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(content) }));
  assert.equal(current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null)).revision, 2);
  const again = current.put_batch_manifest(request("put_batch_manifest", 2, { manifest: copy(content) }, { correlation_id: "corr_put_same", idempotency_key: "idem_put_same" }));
  assert.equal(again.revision, 3);
  assert.equal(again.manifest_digest, content.manifest_digest, "the successor has the same content digest as the abandoned manifest");
  assert.deepEqual(domain(directory).get_pipeline_status(request("get_pipeline_status", null)), again);
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const withIntent = (intent) => fs.writeFileSync(statePath, JSON.stringify({ ...stored, pending: intent }), { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  withIntent({ action: "abandon_batch_manifest", expected_revision: 1, fingerprint: "a".repeat(64), manifest_digest: content.manifest_digest });
  throwsCode(() => domain(directory).get_pipeline_status(request("get_pipeline_status", null)), "corrupt_head_control_work_task_state");
  assert.match(fs.readFileSync(statePath, "utf8"), /"revision":3,"stage":"manifest"/, "a stale intent with a matching digest never clears the same-content successor");
  withIntent({ action: "abandon_batch_manifest", expected_revision: 3, fingerprint: "a".repeat(64), manifest_digest: "e".repeat(64) });
  throwsCode(() => domain(directory).get_pipeline_status(request("get_pipeline_status", null)), "corrupt_head_control_work_task_state");
  assert.match(fs.readFileSync(statePath, "utf8"), /"revision":3,"stage":"manifest"/, "an intent naming another digest at the right revision never clears the manifest");
  withIntent({ action: "abandon_batch_manifest", expected_revision: 3, fingerprint: "a".repeat(64), manifest_digest: content.manifest_digest });
  assert.deepEqual(domain(directory).get_pipeline_status(request("get_pipeline_status", null)),
    { revision: 4, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false }, "only the exact revision+digest pair resumes");
  ok(true, "a same-content successor is distinguished from the abandoned manifest by revision, never by content digest alone");
});

// Interrupted write then restart, in both halves of the transition, and the
// recovery refusing to clear a manifest that a pipeline came to hold.
withDirectory((directory) => {
  let domainRenames = 0;
  let failAt = 0;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (String(to).includes("head-control-work-task-domain")) {
      domainRenames += 1;
      if (domainRenames === failAt) {
        const error = new Error("injected crash");
        error.code = "EIO";
        throw error;
      }
    }
    return fs.renameSync(from, to);
  };
  const current = domain(directory, { fs: faultFs });
  current.initialize();
  const content = manifest();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(content) }));
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  // Crash before the intent is durable: nothing happened, and a retry works.
  domainRenames = 0;
  failAt = 1;
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null)), "head_control_work_task_state_write_failed");
  assert.match(fs.readFileSync(statePath, "utf8"), /"revision":1,"stage":"manifest"/);
  assert.match(fs.readFileSync(statePath, "utf8"), /"pending":null/);
  assert.equal(domain(directory).get_pipeline_status(request("get_pipeline_status", null)).manifest_digest, content.manifest_digest);
  // Crash after the intent is durable but before the empty write: a restart
  // resumes exactly that intent, once.
  domainRenames = 0;
  failAt = 2;
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null, { correlation_id: "corr_abandon_retry", idempotency_key: "idem_abandon_retry" })), "head_control_work_task_state_write_failed");
  assert.equal(domainRenames, 2);
  assert.match(fs.readFileSync(statePath, "utf8"), /"revision":1,"stage":"manifest"/);
  assert.match(fs.readFileSync(statePath, "utf8"), new RegExp(`"pending":\\{"action":"abandon_batch_manifest","expected_revision":1,"fingerprint":"[a-f0-9]{64}","manifest_digest":"${content.manifest_digest}"\\}`));
  const restarted = domain(directory);
  assert.deepEqual(restarted.get_pipeline_status(request("get_pipeline_status", null)),
    { revision: 2, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  assert.match(fs.readFileSync(statePath, "utf8"), /"pending":null/);
  const same = restarted.put_batch_manifest(request("put_batch_manifest", 2, { manifest: copy(content) }, { correlation_id: "corr_put_after_crash", idempotency_key: "idem_put_after_crash" }));
  assert.equal(same.revision, 3);
  assert.equal(domain(directory).get_pipeline_status(request("get_pipeline_status", null)).revision, 3, "the healed intent never reaches the same-content successor");
  ok(true, "an interrupted abandon resumes from its exact durable intent after restart, and a crash before the intent leaves the manifest in place");
});
withDirectory((directory) => {
  const current = domain(directory);
  current.initialize();
  const content = manifest();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(content) }));
  const statePath = headControlWorkTaskDomainPath(directory, binding);
  const frozen = freezeBatchManifest(content, "2026-09-02T00:00:00.000Z");
  createWorkTaskPipelineStore({ config_dir: directory, fs }).initialize({
    expected: { installation_id: binding.installation_id, project_id: binding.project_id, manifest_digest: frozen.manifest_digest, pipeline_digest: null },
    manifest: copy(frozen),
    pipeline: buildWorkTaskPipeline(frozen),
  });
  throwsCode(() => current.abandon_batch_manifest(request("abandon_batch_manifest", 1, null)), "head_control_work_task_batch_active");
  assert.match(fs.readFileSync(statePath, "utf8"), /"revision":1,"stage":"manifest"/);
  assert.match(fs.readFileSync(statePath, "utf8"), /"pending":null/, "no intent is written while a pipeline holds authority");
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.writeFileSync(statePath, JSON.stringify({ ...stored, pending: { action: "abandon_batch_manifest", expected_revision: 1, fingerprint: "a".repeat(64), manifest_digest: content.manifest_digest } }), { encoding: "utf8", mode: FILE_MODE, flag: "w" });
  throwsCode(() => domain(directory).get_pipeline_status(request("get_pipeline_status", null)), "head_control_work_task_batch_active");
  assert.match(fs.readFileSync(statePath, "utf8"), /"revision":1,"stage":"manifest"/);
  assert.match(fs.readFileSync(statePath, "utf8"), /"pending":\{"action":"abandon_batch_manifest"/);
  ok(true, "neither a new abandon nor a durable abandon intent clears a manifest once a pipeline holds authority over the project");
});

const source = fs.readFileSync(path.join(__dirname, "head-control-work-task-domain.js"), "utf8");
assert.doesNotMatch(source, /head-control-audit-store|require\s*\(\s*["'](?:node:)?(?:http|https|net|child_process)["']\s*\)/);
assert.doesNotMatch(source, /(?:setInterval\s*\(|setTimeout\s*\(|publish_delivery|createServer|registerAction)/);
ok(true, "domain has no audit-only recovery, transport, timer, delivery, or generic-action authority");

// The bridge accepts the exact immutable invocation produced by the existing
// plane, not a look-alike direct API. This covers all four fixed callbacks
// without adding a fifth action or a route-level adapter.
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-domain-"));
  fs.chmodSync(directory, DIRECTORY_MODE);
  try {
  const workTaskDomain = domain(directory);
  workTaskDomain.initialize();
  // #1036/#1044: the plane now also exacts the beside-the-pipeline controls,
  // which the server composes around this durable domain.  The controls here
  // only prove composition; the plane's status preflight for every action
  // still lands on this domain's own get_pipeline_status.
  const composed = composeHeadDomain(binding, workTaskDomain, {
    read_project_status: () => ({ monitor: { mode: "suspended" } }),
    read_review_handoff: () => ({ cycle: null }),
    project_monitor: async ({ command }) => ({ applied: true, command }),
    recover_worker: async () => ({ applied: false, outcome: "rejected", reason: "no_loss_evidence", recovered: false }),
  });
  let abandonInvocations = 0;
  const plane = createHeadControlPlane({ binding, domain: { ...composed, abandon_batch_manifest(invocation) { abandonInvocations += 1; return composed.abandon_batch_manifest(invocation); } } });
  const observed = await plane.execute(planeRequest("get_pipeline_status", null));
  const put = await plane.execute(planeRequest("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  const frozen = await plane.execute(planeRequest("freeze_batch_manifest", 1, null));
  assert.equal(observed.result.status.revision, 0);
  assert.equal(put.result.status.revision, 1);
  assert.equal(frozen.result.status.revision, 2);
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  const advanced = advanceToAccepted(directory, store.readRecoverySnapshot({ installation_id: binding.installation_id, project_id: binding.project_id }));
  const ready = await plane.execute(planeRequest("get_pipeline_status", null, null, { correlation_id: "corr_plane_ready", idempotency_key: "idem_plane_ready" }));
  assert.equal(ready.result.status.revision, 3);
  assert.equal(ready.result.status.cut_safe, true);
  const cut = await plane.execute(planeRequest("cut_batch", 3, {
    cut: { tasks: [{ work_task_ref: copy(advanced.ref), candidate_digest: advanced.candidate.candidate_digest }] },
  }, { correlation_id: "corr_plane_cut", idempotency_key: "idem_plane_cut" }));
  assert.equal(cut.decision.kind, "accepted");
  assert.equal(cut.result.status.revision, 4);
  const beside = await plane.execute(planeRequest("get_project_status", null, null, { correlation_id: "corr_plane_project", idempotency_key: "idem_plane_project" }));
  assert.equal(beside.decision.code, "head_control_project_observed");
  assert.equal(beside.result.status.revision, 4, "a beside-the-pipeline read preflights status through this durable domain");
  ok(true, "all fixed Head-control plane callbacks bind to the durable WorkTask domain, including the composed monitor/recovery controls");

  // #1069: two identical abandons in flight at once are one domain invocation
  // through the plane, and the durable state advances exactly once.
  assert.equal((await plane.execute(planeRequest("retire_batch", 4, null, { correlation_id: "corr_plane_retire", idempotency_key: "idem_plane_retire" }))).result.status.revision, 5);
  assert.equal((await plane.execute(planeRequest("put_batch_manifest", 5, { manifest: copy(manifest()) }, { correlation_id: "corr_plane_put_again", idempotency_key: "idem_plane_put_again" }))).result.status.revision, 6);
  const racing = planeRequest("abandon_batch_manifest", 6, null, { correlation_id: "corr_plane_abandon_race", idempotency_key: "idem_plane_abandon_race" });
  const [first, second] = await Promise.all([plane.execute(racing), plane.execute(copy(racing))]);
  assert.equal(first.decision.code, "head_control_applied");
  assert.equal(second.decision.kind, "replayed");
  assert.equal(second.audit, first.audit);
  assert.equal(abandonInvocations, 1);
  assert.deepEqual(workTaskDomain.get_pipeline_status(request("get_pipeline_status", null, null, { correlation_id: "corr_race_status", idempotency_key: "idem_race_status" })),
    { revision: 7, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  ok(true, "competing identical abandons through the plane share one domain invocation and advance the durable state once");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log(`\n${passed} passed`);
})().catch((error) => { console.error(error); process.exit(1); });


