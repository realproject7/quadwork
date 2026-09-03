"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHeadControlPlane } = require("./head-control-plane");
const { composeHeadDomain } = require("./head-control-runtime");
const {
  buildBatchManifest,
} = require("./work-task-manifest");
const {
  planWorkTaskPipelineEvent,
} = require("./work-task-pipeline");
const {
  createWorkTaskPipelineStore,
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
withDirectory((directory) => {
  let armed = false;
  const faultFs = Object.create(fs);
  faultFs.renameSync = (from, to) => {
    if (armed && String(to).includes("head-control-work-task-domain")) {
      const error = new Error("injected crash after store retirement");
      error.code = "EIO";
      throw error;
    }
    return fs.renameSync(from, to);
  };
  const current = domain(directory, { fs: faultFs });
  current.initialize();
  current.put_batch_manifest(request("put_batch_manifest", 0, { manifest: copy(manifest()) }));
  current.freeze_batch_manifest(request("freeze_batch_manifest", 1, null));
  const owner = { installation_id: binding.installation_id, project_id: binding.project_id };
  const store = createWorkTaskPipelineStore({ config_dir: directory, fs });
  armed = true;
  throwsCode(() => current.retire_batch(request("retire_batch", 2, null)), "head_control_work_task_state_write_failed");
  assert.equal(store.readRetiredSnapshots(owner).length, 1, "the store retirement is durable before the domain write");
  assert.match(fs.readFileSync(headControlWorkTaskDomainPath(directory, binding), "utf8"), /"stage":"frozen"/);
  const recovered = domain(directory);
  assert.deepEqual(recovered.get_pipeline_status(request("get_pipeline_status", null)), { revision: 3, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
  assert.equal(recovered.put_batch_manifest(request("put_batch_manifest", 3, { manifest: copy(manifest()) }, { correlation_id: "corr_put_healed", idempotency_key: "idem_put_healed" })).revision, 4);
  ok(true, "an interrupted retirement heals to empty from the retired record and accepts a successor manifest");
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
  const plane = createHeadControlPlane({ binding, domain: composeHeadDomain(binding, workTaskDomain, {
    read_project_status: () => ({ monitor: { mode: "suspended" } }),
    read_review_handoff: () => ({ cycle: null }),
    project_monitor: async ({ command }) => ({ applied: true, command }),
    recover_worker: async () => ({ applied: false, outcome: "rejected", reason: "no_loss_evidence", recovered: false }),
  }) });
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
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log(`\n${passed} passed`);
})().catch((error) => { console.error(error); process.exit(1); });


