"use strict";

// #1060 M1: pure, closed Delivery Candidate manifest. This module creates no
// worktrees and has no route, GitHub, CI, merge, or publication capability.
// It can only bind a frozen WorkTask batch cut to one server-registered
// repository, exact local candidate identities, and two released #1059 review
// receipt anchors per staged task.

const crypto = require("node:crypto");
const { assertWorkItemRef, workItemKey } = require("./work-item-ref");
const { assertWorkTaskRef, workTaskKey, assertBatchManifest } = require("./work-task-manifest");
const { assertWorkTaskCandidate } = require("./work-task-candidate");
const { assertTaskReviewRoundRef, assertTaskReviewRound } = require("./task-review-round");

const VERSION = 1;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const CUT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@+~=-]{1,240}$/;
const RECEIPT_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const REVIEWER_ROLES = new Set(["re1", "re2"]);
const VERDICTS = new Set(["approve", "request_changes"]);
const DELIVERY_MODES = new Set(["integrated", "isolated"]);
const MAX_TASKS = 64;
const MAX_BOUNDARY_PATHS = 128;

class DeliveryCandidateError extends Error {
  constructor(code, message = code) { super(message); this.name = "DeliveryCandidateError"; this.code = code; }
}

function fail(code, message) { throw new DeliveryCandidateError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function clone(value) {
  return Array.isArray(value) ? value.map(clone) : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function stable(value) {
  return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
}
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function text(value, code, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000\r\n]/.test(value)) fail(code, "text is invalid");
  return value;
}
function canonicalRepository(value, code) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) fail(code, "repository is invalid");
  return value.toLowerCase();
}
function sameWorkTask(left, right) {
  try { return workTaskKey(left) === workTaskKey(right); } catch { return false; }
}

function assertDeliveryCandidateRef(value, code = "invalid_delivery_candidate_ref") {
  exact(value, ["version", "installation_id", "project_id", "repository_key", "batch_manifest_digest", "delivery_mode", "base_sha", "result_sha", "cut_id"], code);
  if (value.version !== VERSION || !INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id) ||
      !REPOSITORY_KEY_RE.test(value.repository_key) || !SHA_RE.test(value.batch_manifest_digest) ||
      !DELIVERY_MODES.has(value.delivery_mode) || !SHA_RE.test(value.base_sha) || !SHA_RE.test(value.result_sha) ||
      !CUT_ID_RE.test(value.cut_id) || value.base_sha === value.result_sha) {
    fail(code, "delivery candidate reference is invalid");
  }
  return value;
}

function deliveryCandidateKey(value) {
  const ref = assertDeliveryCandidateRef(value);
  return JSON.stringify(["delivery-candidate-ref", VERSION, ref.installation_id, ref.project_id, ref.repository_key,
    ref.batch_manifest_digest, ref.delivery_mode, ref.base_sha, ref.result_sha, ref.cut_id]);
}

function registeredRepository(value, code = "invalid_registered_delivery_repository") {
  exact(value, ["version", "installation_id", "project_id", "repository_key", "repository"], code);
  if (value.version !== VERSION || !INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id) ||
      !REPOSITORY_KEY_RE.test(value.repository_key)) {
    fail(code, "registered repository identity is invalid");
  }
  canonicalRepository(value.repository, code);
  return {
    version: VERSION,
    installation_id: value.installation_id,
    project_id: value.project_id,
    repository_key: value.repository_key,
    repository: value.repository,
  };
}

function resolveRegisteredRepository(accessor, ref) {
  if (typeof accessor !== "function") fail("registered_delivery_repository_accessor_required", "registered repository accessor is required");
  let observed;
  const request = freeze({ version: VERSION, installation_id: ref.installation_id, project_id: ref.project_id, repository_key: ref.repository_key });
  try { observed = accessor(request); } catch { fail("registered_delivery_repository_unavailable", "registered repository accessor failed"); }
  const repository = registeredRepository(observed, "registered_delivery_repository_invalid");
  if (repository.installation_id !== ref.installation_id || repository.project_id !== ref.project_id || repository.repository_key !== ref.repository_key) {
    fail("registered_delivery_repository_mismatch", "registered repository does not match delivery candidate");
  }
  return repository;
}

function assertBatchCut(batch, ref) {
  let tasks;
  try { tasks = assertBatchManifest(batch); } catch { fail("invalid_delivery_batch_manifest", "delivery batch manifest is invalid"); }
  if (!batch.frozen) fail("delivery_batch_not_frozen", "delivery candidate requires a frozen batch manifest");
  if (batch.installation_id !== ref.installation_id || batch.project_id !== ref.project_id ||
      batch.manifest_digest !== ref.batch_manifest_digest || batch.delivery_mode !== ref.delivery_mode) {
    fail("delivery_batch_reference_mismatch", "delivery candidate is not pinned to this frozen batch cut");
  }
  return tasks;
}

function reviewAnchor(round, candidate) {
  try { assertTaskReviewRound(round); } catch { fail("invalid_delivery_review_anchor", "task review round is invalid"); }
  if (round.status !== "released" || round.release === null || round.receipts.length !== 2) {
    fail("delivery_review_not_released", "delivery task requires two terminal review receipts");
  }
  if (!sameWorkTask(round.review_round_ref.work_task_ref, candidate.work_task_ref) ||
      round.candidate_digest !== candidate.candidate_digest || round.review_round_ref.base_sha !== candidate.base_sha ||
      round.review_round_ref.candidate_sha !== candidate.candidate_sha || round.release.candidate_digest !== candidate.candidate_digest) {
    fail("stale_delivery_review_anchor", "review release is not current for the exact staged candidate");
  }
  const anchors = round.release.receipts.map((sealed) => ({
    reviewer_role: sealed.reviewer_role,
    reviewer_generation: sealed.reviewer_generation,
    receipt_id: sealed.receipt.receipt_id,
    receipt_digest: sealed.receipt.receipt_digest,
    verdict: sealed.receipt.verdict,
  })).sort((left, right) => left.reviewer_role.localeCompare(right.reviewer_role));
  return {
    status: "released",
    review_round_ref: clone(round.review_round_ref),
    round_digest: round.round_digest,
    candidate_digest: candidate.candidate_digest,
    current_sha: candidate.candidate_sha,
    receipt_anchors: anchors,
  };
}

function stagedTaskInput(value, sequence) {
  if (!plain(value)) fail("invalid_delivery_staged_task", "staged task is invalid");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "candidate,review_round" && keys !== "candidate,terminal_review") {
    fail("invalid_delivery_staged_task", "staged task has an unknown or missing field");
  }
  try { assertWorkTaskCandidate(value.candidate); } catch { fail("invalid_delivery_staged_task", "staged task candidate is invalid"); }
  const candidate = clone(value.candidate);
  const stage = {
    sequence,
    work_task_ref: clone(candidate.work_task_ref),
    work_item: clone(candidate.work_task_ref.work_item),
    candidate,
    terminal_review: null,
  };
  if (keys === "candidate,terminal_review") {
    stage.terminal_review = clone(value.terminal_review);
    assertTerminalReview(stage.terminal_review, stage, "invalid_delivery_staged_task");
    return stage;
  }
  stage.terminal_review = reviewAnchor(value.review_round, candidate);
  return stage;
}

function deferredExclusion(value) {
  exact(value, ["work_task_ref", "reason"], "invalid_delivery_deferred_exclusion");
  try { assertWorkTaskRef(value.work_task_ref); } catch { fail("invalid_delivery_deferred_exclusion", "deferred work task reference is invalid"); }
  return { work_task_ref: clone(value.work_task_ref), reason: text(value.reason, "invalid_delivery_deferred_exclusion", 160) };
}

function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function dependencyClosure(entries) {
  const byKey = new Map(entries.map((entry) => [workTaskKey(entry.ref), entry]));
  const memo = new Map();
  function dependenciesOf(key) {
    if (memo.has(key)) return memo.get(key);
    const entry = byKey.get(key);
    if (!entry) fail("invalid_delivery_batch_manifest", "batch dependency is missing");
    const found = new Set();
    for (const dependency of entry.contract.dependencies) {
      const dependencyKey = workTaskKey(dependency);
      found.add(dependencyKey);
      for (const transitive of dependenciesOf(dependencyKey)) found.add(transitive);
    }
    memo.set(key, found);
    return found;
  }
  return { byKey, dependenciesOf };
}

// #1065: the pipeline builds a same-repository dependent task from its one
// ready predecessor candidate, so that exact candidate SHA is the dependent's
// base; every other task builds from the frozen repository root base.  Two
// same-repository predecessors, or an absent one, leave no base to accept.
function expectedCandidateBase(tasks, candidates, candidate, base_sha) {
  const key = workTaskKey(candidate.work_task_ref);
  const entry = tasks.find((task) => workTaskKey(task.ref) === key);
  const predecessors = entry.contract.dependencies.filter((dependency) => dependency.repository_key === candidate.work_task_ref.repository_key);
  if (predecessors.length === 0) return base_sha;
  const predecessorKey = predecessors.length === 1 ? workTaskKey(predecessors[0]) : null;
  const predecessor = candidates.find((other) => workTaskKey(other.work_task_ref) === predecessorKey);
  return predecessor ? predecessor.candidate_sha : null;
}

function assertTerminalReview(value, staged, code) {
  exact(value, ["status", "review_round_ref", "round_digest", "candidate_digest", "current_sha", "receipt_anchors"], code);
  if (value.status !== "released" || !SHA_RE.test(value.round_digest) || value.candidate_digest !== staged.candidate.candidate_digest ||
      value.current_sha !== staged.candidate.candidate_sha || !Array.isArray(value.receipt_anchors) || value.receipt_anchors.length !== 2) {
    fail(code, "terminal review anchor is invalid");
  }
  try { assertTaskReviewRoundRef(value.review_round_ref); } catch { fail(code, "terminal review round reference is invalid"); }
  if (!sameWorkTask(value.review_round_ref.work_task_ref, staged.work_task_ref) || value.review_round_ref.base_sha !== staged.candidate.base_sha ||
      value.review_round_ref.candidate_sha !== staged.candidate.candidate_sha) {
    fail(code, "terminal review reference is stale");
  }
  const anchors = value.receipt_anchors.map((anchor) => {
    exact(anchor, ["reviewer_role", "reviewer_generation", "receipt_id", "receipt_digest", "verdict"], code);
    if (!REVIEWER_ROLES.has(anchor.reviewer_role) || !Number.isSafeInteger(anchor.reviewer_generation) || anchor.reviewer_generation < 1 ||
        !RECEIPT_ID_RE.test(anchor.receipt_id) || !SHA_RE.test(anchor.receipt_digest) || !VERDICTS.has(anchor.verdict)) {
      fail(code, "terminal receipt anchor is invalid");
    }
    return anchor;
  });
  if (new Set(anchors.map((anchor) => anchor.reviewer_role)).size !== 2 ||
      anchors[0].reviewer_role !== "re1" || anchors[1].reviewer_role !== "re2") {
    fail(code, "terminal receipt anchors must be canonical re1/re2 pair");
  }
}

function assertStagedTask(value, sequence, code) {
  exact(value, ["sequence", "work_task_ref", "work_item", "candidate", "terminal_review"], code);
  if (value.sequence !== sequence) fail(code, "staged task order is invalid");
  try { assertWorkTaskRef(value.work_task_ref); assertWorkItemRef(value.work_item); assertWorkTaskCandidate(value.candidate); } catch {
    fail(code, "staged task provenance is invalid");
  }
  if (!sameWorkTask(value.work_task_ref, value.candidate.work_task_ref) || workItemKey(value.work_item) !== workItemKey(value.work_task_ref.work_item)) {
    fail(code, "staged task provenance does not match candidate");
  }
  assertTerminalReview(value.terminal_review, value, code);
  return value;
}

function boundaryEvidence(value, expectedPaths) {
  exact(value, ["paths", "boundary_digest"], "invalid_delivery_boundary_evidence");
  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > MAX_BOUNDARY_PATHS ||
      !value.paths.every((entry) => typeof entry === "string" && PATH_RE.test(entry)) ||
      new Set(value.paths).size !== value.paths.length ||
      stable(value.paths) !== stable(expectedPaths) || value.boundary_digest !== hash({ version: VERSION, paths: value.paths })) {
    fail("invalid_delivery_boundary_evidence", "declared boundary evidence is invalid");
  }
  return { paths: [...value.paths], boundary_digest: value.boundary_digest };
}

function assertEvidence(value, ref, expectedPaths) {
  exact(value, ["boundary", "patch", "tree"], "invalid_delivery_evidence");
  const boundary = boundaryEvidence(value.boundary, expectedPaths);
  exact(value.patch, ["base_sha", "result_sha", "patch_digest"], "invalid_delivery_patch_evidence");
  if (value.patch.base_sha !== ref.base_sha || value.patch.result_sha !== ref.result_sha || !SHA_RE.test(value.patch.patch_digest)) {
    fail("invalid_delivery_patch_evidence", "patch evidence is not pinned to delivery candidate identity");
  }
  exact(value.tree, ["base_tree_sha", "result_tree_sha", "tree_digest"], "invalid_delivery_tree_evidence");
  if (!SHA_RE.test(value.tree.base_tree_sha) || !SHA_RE.test(value.tree.result_tree_sha) || value.tree.base_tree_sha === value.tree.result_tree_sha ||
      value.tree.tree_digest !== hash({ version: VERSION, base_tree_sha: value.tree.base_tree_sha, result_tree_sha: value.tree.result_tree_sha })) {
    fail("invalid_delivery_tree_evidence", "tree evidence is invalid");
  }
  return {
    boundary,
    patch: { base_sha: value.patch.base_sha, result_sha: value.patch.result_sha, patch_digest: value.patch.patch_digest },
    tree: { base_tree_sha: value.tree.base_tree_sha, result_tree_sha: value.tree.result_tree_sha, tree_digest: value.tree.tree_digest },
  };
}

function assertCutContents(ref, repository, batch, staged, deferred, evidence) {
  const entries = assertBatchCut(batch, ref);
  const graph = dependencyClosure(entries);
  const stageKeys = new Set();
  const itemKeys = new Set();
  const stagedEntries = staged.map((stage, index) => {
    assertStagedTask(stage, index + 1, "invalid_delivery_staged_task");
    const key = workTaskKey(stage.work_task_ref);
    const entry = graph.byKey.get(key);
    if (!entry) fail("unknown_delivery_work_task", "staged task is not in the frozen batch");
    if (stage.work_task_ref.repository_key !== ref.repository_key || canonicalRepository(stage.work_item.repo, "invalid_delivery_staged_task") !== canonicalRepository(repository.repository, "invalid_registered_delivery_repository")) {
      fail("delivery_repository_spoof", "staged task crosses the registered delivery repository");
    }
    if (stageKeys.has(key)) fail("duplicate_delivery_work_task", "staged work task is duplicated");
    const itemKey = workItemKey(stage.work_item);
    if (itemKeys.has(itemKey)) fail("duplicate_delivery_work_item", "delivery work item is duplicated");
    stageKeys.add(key); itemKeys.add(itemKey);
    return entry;
  });
  if (staged.length === 0 || staged.length > MAX_TASKS) fail("invalid_delivery_staged_task", "delivery cut has no bounded staged tasks");

  const expectedStageOrder = entries.filter((entry) => stageKeys.has(workTaskKey(entry.ref))).map((entry) => workTaskKey(entry.ref));
  if (stable([...stageKeys]) !== stable(expectedStageOrder)) fail("invalid_delivery_task_order", "staged task order is not the frozen batch order");

  const deferredEntries = deferred.map((entry) => deferredExclusion(entry));
  const deferredKeys = new Set();
  for (const entry of deferredEntries) {
    const key = workTaskKey(entry.work_task_ref);
    if (!graph.byKey.has(key)) fail("unknown_delivery_deferred_task", "deferred task is not in the frozen batch");
    if (stageKeys.has(key) || deferredKeys.has(key)) fail("duplicate_delivery_deferred_task", "deferred task overlaps staged or deferred provenance");
    deferredKeys.add(key);
  }
  const expectedDeferredOrder = entries.filter((entry) => !stageKeys.has(workTaskKey(entry.ref))).map((entry) => workTaskKey(entry.ref));
  if (stable([...deferredKeys]) !== stable(expectedDeferredOrder)) fail("unsafe_partial_delivery_cut", "frozen batch tasks must be staged or explicitly deferred in order");

  for (const entry of stagedEntries) {
    for (const dependency of graph.dependenciesOf(workTaskKey(entry.ref))) {
      if (!stageKeys.has(dependency)) fail("unsafe_partial_delivery_cut", "staged task dependency is absent from delivery cut");
    }
  }

  for (let left = 0; left < stagedEntries.length; left += 1) for (let right = left + 1; right < stagedEntries.length; right += 1) {
    const leftKey = workTaskKey(stagedEntries[left].ref);
    const rightKey = workTaskKey(stagedEntries[right].ref);
    const related = graph.dependenciesOf(leftKey).has(rightKey) || graph.dependenciesOf(rightKey).has(leftKey);
    if (!related && stagedEntries[left].contract.file_boundary.some((a) => stagedEntries[right].contract.file_boundary.some((b) => pathOverlaps(a, b)))) {
      fail("overlapping_independent_delivery_task", "independent staged tasks have overlapping file boundaries");
    }
  }

  if (ref.delivery_mode === "integrated") {
    // An integrated cut is whole-repository, not necessarily whole-batch:
    // V2 freezes one project batch that can contain independent registered
    // repositories.  Each repository gets its own final candidate, while the
    // closed dependency check above still rejects a staged task whose required
    // predecessor is deferred in another repository.
    const repositoryEntries = entries.filter((entry) => entry.ref.repository_key === ref.repository_key);
    if (repositoryEntries.length === 0 || staged.length !== repositoryEntries.length ||
        deferredEntries.some((entry) => entry.work_task_ref.repository_key === ref.repository_key)) {
      fail("integrated_delivery_requires_complete_batch", "integrated delivery must cut every frozen task for its registered repository");
    }
    const candidates = staged.map((stage) => stage.candidate);
    if (staged.some((stage) => stage.candidate.base_sha !== expectedCandidateBase(entries, candidates, stage.candidate, ref.base_sha))) {
      fail("integrated_delivery_base_mismatch", "integrated candidates must chain exactly from the delivery base SHA");
    }
  } else {
    if (staged.length !== 1 || deferredEntries.length !== entries.length - 1) fail("isolated_delivery_requires_single_task", "isolated delivery must stage one task and defer all peers");
    if (staged[0].candidate.base_sha !== ref.base_sha || staged[0].candidate.candidate_sha !== ref.result_sha) {
      fail("isolated_delivery_identity_mismatch", "isolated delivery result must be its sole exact candidate SHA");
    }
  }

  const expectedPaths = [...new Set(stagedEntries.flatMap((entry) => entry.contract.file_boundary))].sort();
  assertEvidence(evidence, ref, expectedPaths);
  return { entries, expectedPaths };
}

function deliveryManifestPayload(manifest) {
  return {
    version: manifest.version,
    delivery_candidate_ref: clone(manifest.delivery_candidate_ref),
    registered_repository: clone(manifest.registered_repository),
    frozen_batch_manifest: clone(manifest.frozen_batch_manifest),
    staged_tasks: manifest.staged_tasks.map(clone),
    deferred_exclusions: manifest.deferred_exclusions.map(clone),
    evidence: clone(manifest.evidence),
  };
}

function assertDeliveryManifest(value) {
  exact(value, ["version", "delivery_manifest_digest", "delivery_candidate_ref", "registered_repository", "frozen_batch_manifest", "staged_tasks", "deferred_exclusions", "evidence"], "invalid_delivery_manifest");
  if (value.version !== VERSION || !SHA_RE.test(value.delivery_manifest_digest) || !Array.isArray(value.staged_tasks) ||
      !Array.isArray(value.deferred_exclusions)) fail("invalid_delivery_manifest", "delivery manifest is invalid");
  const ref = assertDeliveryCandidateRef(value.delivery_candidate_ref, "invalid_delivery_manifest");
  const repository = registeredRepository(value.registered_repository, "invalid_delivery_manifest");
  if (repository.installation_id !== ref.installation_id || repository.project_id !== ref.project_id || repository.repository_key !== ref.repository_key) {
    fail("invalid_delivery_manifest", "registered repository does not match delivery candidate");
  }
  assertCutContents(ref, repository, value.frozen_batch_manifest, value.staged_tasks, value.deferred_exclusions, value.evidence);
  if (value.delivery_manifest_digest !== hash(deliveryManifestPayload(value))) fail("invalid_delivery_manifest", "delivery manifest digest mismatch");
  return value;
}

function buildDeliveryManifest(input, options = {}) {
  exact(input, ["version", "delivery_candidate_ref", "frozen_batch_manifest", "staged_tasks", "deferred_exclusions", "evidence"], "invalid_delivery_manifest_input");
  exact(options, ["resolveRegisteredRepository"], "invalid_delivery_manifest_options");
  if (input.version !== VERSION || !Array.isArray(input.staged_tasks) || !Array.isArray(input.deferred_exclusions)) {
    fail("invalid_delivery_manifest_input", "delivery manifest input is invalid");
  }
  const ref = assertDeliveryCandidateRef(input.delivery_candidate_ref, "invalid_delivery_manifest_input");
  const repository = resolveRegisteredRepository(options.resolveRegisteredRepository, ref);
  const manifest = {
    version: VERSION,
    delivery_candidate_ref: clone(ref),
    registered_repository: repository,
    frozen_batch_manifest: clone(input.frozen_batch_manifest),
    staged_tasks: input.staged_tasks.map((entry, index) => stagedTaskInput(entry, index + 1)),
    deferred_exclusions: input.deferred_exclusions.map(deferredExclusion),
    evidence: clone(input.evidence),
  };
  const { expectedPaths } = assertCutContents(ref, repository, manifest.frozen_batch_manifest, manifest.staged_tasks, manifest.deferred_exclusions, manifest.evidence);
  manifest.evidence = assertEvidence(manifest.evidence, ref, expectedPaths);
  const finalized = freeze({ delivery_manifest_digest: hash(deliveryManifestPayload(manifest)), ...manifest });
  assertDeliveryManifest(finalized);
  return finalized;
}

module.exports = {
  VERSION,
  DeliveryCandidateError,
  assertDeliveryCandidateRef,
  deliveryCandidateKey,
  expectedCandidateBase,
  assertDeliveryManifest,
  buildDeliveryManifest,
};
