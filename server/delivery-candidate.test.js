"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const {
  DeliveryCandidateError,
  assertDeliveryCandidateRef,
  deliveryCandidateKey,
  assertDeliveryManifest,
  buildDeliveryManifest,
} = require("./delivery-candidate");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);
const web42 = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };
const web43 = { repoKey: "web", repo: "Owner/Product-Web", number: 43, kind: "issue" };
const api42 = { repoKey: "api", repo: "Owner/Product-Api", number: 42, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function stable(value) {
  return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
}
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof DeliveryCandidateError && error.code === expected);
}
function resolveRegisteredIdentity(input) {
  const revisions = { 42: "c".repeat(64), 43: "d".repeat(64) };
  return {
    installation_id: input.installation_id,
    project_id: input.project_id,
    repository_key: input.repository_key,
    work_item: copy(input.work_item),
    issue_body_revision: input.repository_key === "api" ? "e".repeat(64) : revisions[input.work_item.number],
  };
}
function task({ task_key, work_item, boundary, dependencies = [] }) {
  return {
    task_key,
    repository_key: work_item.repoKey,
    work_item: copy(work_item),
    goal: `deliver ${task_key} as a bounded candidate`,
    file_boundary: boundary,
    validation: ["node:test"],
    dependencies,
  };
}
function dependency(work_item, task_key) {
  return { repository_key: work_item.repoKey, work_item: copy(work_item), task_key };
}
function frozenBatch(tasks, delivery_mode = "integrated") {
  return freezeBatchManifest(buildBatchManifest({
    version: 1, installation_id, project_id, delivery_mode, tasks,
  }, { resolveRegisteredIdentity }), "2026-09-01T10:00:00.000Z");
}
function candidate(ref, candidate_sha, worktree_id) {
  return buildWorkTaskCandidate({
    version: 1,
    work_task_ref: copy(ref),
    base_sha,
    candidate_sha,
    branch: `task/delivery-${worktree_id}`,
    worktree: { repository_key: ref.repository_key, worktree_id, path: `/var/folders/quadwork/${worktree_id}` },
  }, {
    canonicalizePath(request) { return { version: 1, canonical_path: request.path.replace("/var/", "/private/var/") }; },
    inspectManagedWorktree() {
      return {
        version: 1, registered: true, readable: true, repository_key: ref.repository_key, worktree_id,
        canonical_path: `/private/var/folders/quadwork/${worktree_id}`,
        branch: `task/delivery-${worktree_id}`,
        base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}
function receipt(ref, receipt_id, verdict, findings = []) {
  const payload = { version: 1, review_round_ref: copy(ref), receipt_id, verdict, findings: copy(findings) };
  return { ...payload, receipt_digest: digest(payload) };
}
function releasedRound(workCandidate, suffix) {
  const opened = openTaskReviewRound({
    version: 1, candidate: workCandidate, attempt: `attempt-${suffix}`, round: 1, opened_at: "2026-09-01T10:01:00.000Z",
  }, {
    version: 1,
    reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }],
  });
  const sealed = submitTaskReviewReceipt(opened, receipt(opened.review_round_ref, `receipt-re1-${suffix}`, "approve", [{
    finding_id: `finding-${suffix}`, severity: "non_blocking", propagation: "local", summary: `private finding ${suffix}`,
  }]), { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-01T10:02:00.000Z" });
  return submitTaskReviewReceipt(sealed.round, receipt(opened.review_round_ref, `receipt-re2-${suffix}`, "request_changes"), {
    version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-01T10:03:00.000Z",
  }).round;
}
function candidateRef(batch, delivery_mode, result_sha, cut_id = "cut-1060") {
  return {
    version: 1,
    installation_id,
    project_id,
    repository_key: "web",
    batch_manifest_digest: batch.manifest_digest,
    delivery_mode,
    base_sha,
    result_sha,
    cut_id,
  };
}
function evidence(ref, paths) {
  const sorted = [...paths].sort();
  const base_tree_sha = "8".repeat(64);
  const result_tree_sha = "9".repeat(64);
  return {
    boundary: { paths: sorted, boundary_digest: digest({ version: 1, paths: sorted }) },
    patch: { base_sha: ref.base_sha, result_sha: ref.result_sha, patch_digest: "7".repeat(64) },
    tree: {
      base_tree_sha,
      result_tree_sha,
      tree_digest: digest({ version: 1, base_tree_sha, result_tree_sha }),
    },
  };
}
function options(overrides = {}) {
  return {
    resolveRegisteredRepository(request) {
      assert.equal(Object.isFrozen(request), true, "registered-repository authority receives immutable request");
      assert.deepEqual(request, { version: 1, installation_id, project_id, repository_key: "web" });
      return { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Product-Web" };
    },
    ...overrides,
  };
}
function integratedFixture() {
  const batch = frozenBatch([
    task({ task_key: "alpha", work_item: web42, boundary: ["server/alpha.js"] }),
    task({ task_key: "bravo", work_item: web43, boundary: ["server/bravo.js"] }),
  ]);
  const alpha = candidate(batch.tasks[0].ref, "b".repeat(64), "wt_alpha");
  const bravo = candidate(batch.tasks[1].ref, "c".repeat(64), "wt_bravo");
  const ref = candidateRef(batch, "integrated", "f".repeat(64));
  return {
    batch, alpha, bravo, ref,
    input: {
      version: 1,
      delivery_candidate_ref: ref,
      frozen_batch_manifest: batch,
      staged_tasks: [
        { candidate: alpha, review_round: releasedRound(alpha, "alpha") },
        { candidate: bravo, review_round: releasedRound(bravo, "bravo") },
      ],
      deferred_exclusions: [],
      evidence: evidence(ref, ["server/alpha.js", "server/bravo.js"]),
    },
  };
}

// A valid integrated cut is immutable, digest-stable, in frozen Batch order,
// and retains only two released receipt anchors per task (not raw findings).
{
  const fixture = integratedFixture();
  const source = copy(fixture.input);
  const manifest = buildDeliveryManifest(fixture.input, options());
  assert.deepEqual(fixture.input, source, "builder does not mutate delivery input");
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(assertDeliveryManifest(manifest), manifest);
  assert.match(manifest.delivery_manifest_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.staged_tasks.map((entry) => entry.sequence), [1, 2]);
  assert.deepEqual(manifest.staged_tasks.map((entry) => entry.work_item.number), [42, 43]);
  assert.deepEqual(manifest.staged_tasks[0].terminal_review.receipt_anchors.map((anchor) => anchor.reviewer_role), ["re1", "re2"]);
  assert.equal(manifest.staged_tasks[0].terminal_review.current_sha, fixture.alpha.candidate_sha);
  assert.doesNotMatch(JSON.stringify(manifest), /private finding alpha/, "delivery anchor never exposes raw reviewer findings");
  assert.equal(deliveryCandidateKey(manifest.delivery_candidate_ref), deliveryCandidateKey(copy(manifest.delivery_candidate_ref)));
  assert.equal(assertDeliveryCandidateRef(copy(manifest.delivery_candidate_ref)).cut_id, "cut-1060");
  assert.deepEqual(buildDeliveryManifest(copy(fixture.input), options()), manifest, "same frozen provenance yields same digest");
}

// An isolated cut is one exact candidate/result with every frozen-batch peer
// listed as an explicit deferred exclusion; it cannot quietly absorb a peer.
{
  const batch = frozenBatch([
    task({ task_key: "alpha", work_item: web42, boundary: ["server/alpha.js"] }),
    task({ task_key: "bravo", work_item: web43, boundary: ["server/bravo.js"] }),
  ], "isolated");
  const alpha = candidate(batch.tasks[0].ref, "b".repeat(64), "wt_isolated");
  const ref = candidateRef(batch, "isolated", alpha.candidate_sha, "cut-isolated");
  const manifest = buildDeliveryManifest({
    version: 1, delivery_candidate_ref: ref, frozen_batch_manifest: batch,
    staged_tasks: [{ candidate: alpha, review_round: releasedRound(alpha, "isolated") }],
    deferred_exclusions: [{ work_task_ref: copy(batch.tasks[1].ref), reason: "separate isolated candidate" }],
    evidence: evidence(ref, ["server/alpha.js"]),
  }, options());
  assert.equal(manifest.delivery_candidate_ref.delivery_mode, "isolated");
  assert.equal(manifest.deferred_exclusions.length, 1);
  assert.equal(manifest.staged_tasks[0].candidate.candidate_sha, manifest.delivery_candidate_ref.result_sha);
}

// Cross-project/repository claims, missing released proof, and unknown
// authority fields fail before any manifest can be constructed.
{
  const fixture = integratedFixture();
  throwsCode(() => buildDeliveryManifest({ ...fixture.input, untrusted_authority: "chat" }, options()), "invalid_delivery_manifest_input");
  throwsCode(() => buildDeliveryManifest(fixture.input, options({
    resolveRegisteredRepository() {
      return { version: 1, installation_id, project_id, repository_key: "api", repository: "Owner/Product-Api" };
    },
  })), "registered_delivery_repository_mismatch");
  throwsCode(() => buildDeliveryManifest(fixture.input, options({
    resolveRegisteredRepository() {
      return { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Product-Web", extra: true };
    },
  })), "registered_delivery_repository_invalid");
  const crossProject = copy(fixture.input);
  crossProject.delivery_candidate_ref.project_id = "other-project";
  throwsCode(() => buildDeliveryManifest(crossProject, options({
    resolveRegisteredRepository() {
      return { version: 1, installation_id, project_id: "other-project", repository_key: "web", repository: "Owner/Product-Web" };
    },
  })), "delivery_batch_reference_mismatch");
  throwsCode(() => buildDeliveryManifest(fixture.input, options({
    resolveRegisteredRepository() {
      return { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Other-Repository" };
    },
  })), "delivery_repository_spoof");
  const currentRound = openTaskReviewRound({
    version: 1, candidate: fixture.alpha, attempt: "attempt-current", round: 2, opened_at: "2026-09-01T10:10:00.000Z",
  }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }] });
  const missingTerminal = copy(fixture.input);
  missingTerminal.staged_tasks[0].review_round = currentRound;
  throwsCode(() => buildDeliveryManifest(missingTerminal, options()), "delivery_review_not_released");
  const stale = copy(fixture.input);
  stale.staged_tasks[0].candidate = candidate(fixture.batch.tasks[0].ref, "d".repeat(64), "wt_stale");
  throwsCode(() => buildDeliveryManifest(stale, options()), "stale_delivery_review_anchor");
}

// Integrated cuts must cover one repository's entire frozen batch. Duplicate
// tasks, reordered provenance, and undeclared peers cannot become a partial cut.
{
  const fixture = integratedFixture();
  const duplicate = copy(fixture.input);
  duplicate.staged_tasks.push(copy(duplicate.staged_tasks[1]));
  throwsCode(() => buildDeliveryManifest(duplicate, options()), "duplicate_delivery_work_task");
  const partial = copy(fixture.input);
  partial.staged_tasks.pop();
  partial.deferred_exclusions = [{ work_task_ref: copy(fixture.batch.tasks[1].ref), reason: "not allowed in integrated cut" }];
  partial.evidence = evidence(fixture.ref, ["server/alpha.js"]);
  throwsCode(() => buildDeliveryManifest(partial, options()), "integrated_delivery_requires_complete_batch");
  const reversed = copy(fixture.input);
  reversed.staged_tasks.reverse();
  throwsCode(() => buildDeliveryManifest(reversed, options()), "invalid_delivery_task_order");
}

// Independent WorkTasks may not claim the same declared boundary. A staged
// dependent task also cannot omit its prerequisite in an isolated cut.
{
  const overlapBatch = frozenBatch([
    task({ task_key: "left", work_item: web42, boundary: ["server/shared.js"] }),
    task({ task_key: "right", work_item: web43, boundary: ["server/shared.js"] }),
  ]);
  const left = candidate(overlapBatch.tasks[0].ref, "b".repeat(64), "wt_left");
  const right = candidate(overlapBatch.tasks[1].ref, "c".repeat(64), "wt_right");
  const overlapRef = candidateRef(overlapBatch, "integrated", "f".repeat(64), "cut-overlap");
  throwsCode(() => buildDeliveryManifest({
    version: 1, delivery_candidate_ref: overlapRef, frozen_batch_manifest: overlapBatch,
    staged_tasks: [{ candidate: left, review_round: releasedRound(left, "left") }, { candidate: right, review_round: releasedRound(right, "right") }],
    deferred_exclusions: [], evidence: evidence(overlapRef, ["server/shared.js"]),
  }, options()), "overlapping_independent_delivery_task");

  const dependentBatch = frozenBatch([
    task({ task_key: "base", work_item: web42, boundary: ["server/base.js"] }),
    task({ task_key: "dependent", work_item: web43, boundary: ["server/dependent.js"], dependencies: [dependency(web42, "base")] }),
  ], "isolated");
  const dependent = candidate(dependentBatch.tasks[1].ref, "c".repeat(64), "wt_dependent");
  const dependentRef = candidateRef(dependentBatch, "isolated", dependent.candidate_sha, "cut-dependent");
  throwsCode(() => buildDeliveryManifest({
    version: 1, delivery_candidate_ref: dependentRef, frozen_batch_manifest: dependentBatch,
    staged_tasks: [{ candidate: dependent, review_round: releasedRound(dependent, "dependent") }],
    deferred_exclusions: [{ work_task_ref: copy(dependentBatch.tasks[0].ref), reason: "unsafe omitted prerequisite" }],
    evidence: evidence(dependentRef, ["server/dependent.js"]),
  }, options()), "unsafe_partial_delivery_cut");
}

// The output is a closed audited manifest: a spoofed WorkItem or evidence
// change fails validation even before the digest can be trusted.
{
  const manifest = buildDeliveryManifest(integratedFixture().input, options());
  const spoofedItem = copy(manifest);
  spoofedItem.staged_tasks[0].work_item.repo = "Owner/Other";
  throwsCode(() => assertDeliveryManifest(spoofedItem), "invalid_delivery_staged_task");
  const spoofedEvidence = copy(manifest);
  spoofedEvidence.evidence.patch.base_sha = "d".repeat(64);
  throwsCode(() => assertDeliveryManifest(spoofedEvidence), "invalid_delivery_patch_evidence");
}

// Purity guard: this M1 foundation has no filesystem, network, route, Git, or
// process authority; the sole runtime dependency beyond other pure contracts
// is deterministic hashing.
{
  const source = fs.readFileSync(path.join(__dirname, "delivery-candidate.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https|os)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|config|mcp|work-task-pipeline-store|task-review-round-store)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn|git worktree|pull_request|gh\s|fetch\()/);
}

console.log("delivery-candidate.test.js: all assertions passed");
