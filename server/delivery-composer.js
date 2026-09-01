"use strict";

// #1060 M2: a closed, synchronous composition proof for a frozen Delivery
// Candidate manifest.  This module deliberately has no Git, filesystem,
// subprocess, network, route, or persistence capability.  Every repository
// observation and every in-memory patch application is a narrow, injected,
// immutable request.  The caller receives a proof only after the exact base,
// reviewed candidates, binary full-index patches, tree objects, and final cut
// all agree.

const crypto = require("node:crypto");
const {
  DeliveryCandidateError,
  assertDeliveryCandidateRef,
  assertDeliveryManifest,
} = require("./delivery-candidate");
const { workTaskKey } = require("./work-task-manifest");

const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PATH_RE = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.(?:\/|$))(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@+~=-]{1,240}$/;
const ABSOLUTE_PATH_RE = /^(?!.*\/\/)(?!.*(?:^|\/)\.(?:\/|$))(?!.*(?:^|\/)\.\.(?:\/|$))\/[A-Za-z0-9._/@+~=-]{1,1024}$/;
const MODE_RE = /^(100644|100755|120000)$/;
const PATCH_FORMAT = "git_full_index_binary_v1";
const TREE_LIMIT = 16384;
const PATCH_FILE_LIMIT = 1024;
const PATCH_BYTES_LIMIT = 1024 * 1024;

class DeliveryComposerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DeliveryComposerError";
    this.code = code;
  }
}

function fail(code, message) { throw new DeliveryComposerError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
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
  return Array.isArray(value) ? "[" + value.map(stable).join(",") + "]" : plain(value)
    ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}"
    : JSON.stringify(value);
}
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function same(left, right) { return stable(left) === stable(right); }
function sha(value, code) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "exact SHA is invalid");
  return value;
}
function repository(value, code) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) fail(code, "repository is invalid");
  return value.toLowerCase();
}
function repositoryPath(value, code) {
  if (typeof value !== "string" || !PATH_RE.test(value)) fail(code, "repository path is not canonical");
  return value;
}
function canonicalAbsolutePath(value, code) {
  if (typeof value !== "string" || !ABSOLUTE_PATH_RE.test(value) || value.endsWith("/")) {
    fail(code, "absolute path is not canonical");
  }
  return value;
}

function deliveryManifest(value) {
  try { return assertDeliveryManifest(value); } catch (error) {
    if (error instanceof DeliveryCandidateError) fail("invalid_delivery_manifest", "delivery manifest is invalid");
    throw error;
  }
}
function deliveryRef(value, code) {
  try { return assertDeliveryCandidateRef(value, code); } catch (error) {
    if (error instanceof DeliveryCandidateError) fail(code, "delivery candidate reference is invalid");
    throw error;
  }
}
function sameTask(left, right) {
  try { return workTaskKey(left) === workTaskKey(right); } catch { return false; }
}
function taskKey(value, code) {
  try { return workTaskKey(value); } catch { fail(code, "work task reference is invalid"); }
}
function pathOverlaps(left, right) {
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}
function withinBoundary(path, boundaries) {
  return boundaries.some((boundary) => path === boundary || path.startsWith(boundary + "/"));
}

function composerOptions(value) {
  exact(value, ["readCommit", "readTree", "readReviewedTask", "readCandidatePatch", "readDeliveryPatch", "applyPatch"], "invalid_delivery_composer_options");
  for (const name of Object.keys(value)) {
    if (typeof value[name] !== "function") fail("invalid_delivery_composer_options", name + " accessor is required");
  }
  return value;
}
function call(options, name, request, unavailableCode) {
  let response;
  try { response = options[name](freeze(clone(request))); } catch { fail(unavailableCode, name + " accessor failed"); }
  return response;
}

function treeEntry(value, code) {
  exact(value, ["path", "mode", "blob_sha"], code);
  return {
    path: repositoryPath(value.path, code),
    mode: typeof value.mode === "string" && MODE_RE.test(value.mode) ? value.mode : fail(code, "tree mode is invalid"),
    blob_sha: sha(value.blob_sha, code),
  };
}
function treeSnapshot(value, expectedRepository, expectedTree, code) {
  exact(value, ["version", "repository", "tree_sha", "entries"], code);
  if (value.version !== VERSION || repository(value.repository, code) !== expectedRepository ||
      sha(value.tree_sha, code) !== expectedTree || !Array.isArray(value.entries) || value.entries.length > TREE_LIMIT) {
    fail(code, "tree observation is invalid");
  }
  const entries = value.entries.map((entry) => treeEntry(entry, code));
  const paths = entries.map((entry) => entry.path);
  const ordered = [...paths].sort();
  if (new Set(paths).size !== paths.length || !same(paths, ordered)) fail(code, "tree entries must be path-sorted and unique");
  return { tree_sha: value.tree_sha, entries };
}
function snapshotDigest(snapshot) {
  return hash({ version: VERSION, tree_sha: snapshot.tree_sha, entries: snapshot.entries.map(clone) });
}
function proofTree(value, code) {
  exact(value, ["tree_sha", "tree_digest", "entries"], code);
  if (!Array.isArray(value.entries) || value.entries.length > TREE_LIMIT || !SHA_RE.test(value.tree_sha) || !SHA_RE.test(value.tree_digest)) {
    fail(code, "proof tree is invalid");
  }
  const snapshot = { tree_sha: value.tree_sha, entries: value.entries.map((entry) => treeEntry(entry, code)) };
  const paths = snapshot.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || !same(paths, [...paths].sort()) || value.tree_digest !== snapshotDigest(snapshot)) {
    fail(code, "proof tree digest is invalid");
  }
  return snapshot;
}
function proofCommitTree(value, expectedCommitSha, code) {
  exact(value, ["commit_sha", "tree_sha", "tree_digest", "entries"], code);
  if (value.commit_sha !== expectedCommitSha) fail(code, "proof commit pin is invalid");
  return proofTree({ tree_sha: value.tree_sha, tree_digest: value.tree_digest, entries: value.entries }, code);
}
function entryMap(snapshot) { return new Map(snapshot.entries.map((entry) => [entry.path, entry])); }
function sameEntry(left, right) { return left === null ? right === null : right !== null && same(left, right); }
function changedFiles(base, result) {
  const baseByPath = entryMap(base);
  const resultByPath = entryMap(result);
  const paths = [...new Set([...baseByPath.keys(), ...resultByPath.keys()])].sort();
  return paths.map((path) => ({
    path,
    before: baseByPath.get(path) || null,
    after: resultByPath.get(path) || null,
  })).filter((file) => !sameEntry(file.before, file.after));
}
function expectedAppliedTree(input, files, resultSha) {
  const map = entryMap(input);
  for (const file of files) {
    if (file.after === null) map.delete(file.path);
    else map.set(file.path, clone(file.after));
  }
  return { tree_sha: resultSha, entries: [...map.values()].sort((left, right) => left.path.localeCompare(right.path)) };
}

function patchFile(value, code) {
  exact(value, ["path", "before", "after", "binary_delta"], code);
  const path = repositoryPath(value.path, code);
  const side = (entry) => {
    if (entry === null) return null;
    return treeEntry({ path, mode: entry.mode, blob_sha: entry.blob_sha }, code);
  };
  if (typeof value.binary_delta !== "string" || value.binary_delta.length === 0 || value.binary_delta.length > PATCH_BYTES_LIMIT ||
      value.binary_delta.includes("\r") || !value.binary_delta.startsWith("GIT binary patch\n")) {
    fail(code, "binary patch payload is invalid");
  }
  const before = side(value.before);
  const after = side(value.after);
  if (before === null && after === null) fail(code, "binary patch file has no change");
  return { path, before, after, binary_delta: value.binary_delta };
}
function patchPayload(patch) {
  return {
    version: patch.version,
    format: patch.format,
    scope: patch.scope,
    base_sha: patch.base_sha,
    result_sha: patch.result_sha,
    base_tree_sha: patch.base_tree_sha,
    result_tree_sha: patch.result_tree_sha,
    source_worktree_path: patch.source_worktree_path,
    files: patch.files.map(clone),
  };
}
function binaryPatch(value, expected, code) {
  exact(value, ["version", "format", "scope", "base_sha", "result_sha", "base_tree_sha", "result_tree_sha", "source_worktree_path", "files", "patch_digest"], code);
  if (value.version !== VERSION || value.format !== PATCH_FORMAT || value.scope !== expected.scope ||
      value.base_sha !== expected.base_sha || value.result_sha !== expected.result_sha ||
      value.base_tree_sha !== expected.base_tree_sha || value.result_tree_sha !== expected.result_tree_sha ||
      value.source_worktree_path !== expected.source_worktree_path || !Array.isArray(value.files) ||
      value.files.length === 0 || value.files.length > PATCH_FILE_LIMIT || !SHA_RE.test(value.patch_digest)) {
    fail(code, "binary patch identity is invalid");
  }
  if (value.source_worktree_path !== null) canonicalAbsolutePath(value.source_worktree_path, code);
  const files = value.files.map((file) => patchFile(file, code));
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || !same(paths, [...paths].sort())) fail(code, "binary patch files must be path-sorted and unique");
  const patch = {
    version: VERSION,
    format: PATCH_FORMAT,
    scope: value.scope,
    base_sha: value.base_sha,
    result_sha: value.result_sha,
    base_tree_sha: value.base_tree_sha,
    result_tree_sha: value.result_tree_sha,
    source_worktree_path: value.source_worktree_path,
    files,
    patch_digest: value.patch_digest,
  };
  if (patch.patch_digest !== hash(patchPayload(patch))) fail(code, "binary patch digest mismatch");
  return patch;
}
function assertPatchMatchesTrees(patch, base, result, code) {
  const expected = changedFiles(base, result);
  const received = patch.files.map((file) => ({ path: file.path, before: file.before, after: file.after }));
  if (!same(received, expected)) fail(code, "binary patch does not exactly describe the two tree objects");
}
function fileFacts(files) {
  return files.map((file) => ({ path: file.path, before: file.before === null ? null : clone(file.before), after: file.after === null ? null : clone(file.after) }));
}
function proofFile(value, code) {
  exact(value, ["path", "before", "after"], code);
  const path = repositoryPath(value.path, code);
  const side = (entry) => entry === null ? null : treeEntry({ path, mode: entry.mode, blob_sha: entry.blob_sha }, code);
  const before = side(value.before);
  const after = side(value.after);
  if (before === null && after === null) fail(code, "proof file has no change");
  return { path, before, after };
}
function proofFiles(value, code) {
  if (!Array.isArray(value) || value.length === 0 || value.length > PATCH_FILE_LIMIT) fail(code, "proof files are invalid");
  const files = value.map((file) => proofFile(file, code));
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || !same(paths, [...paths].sort())) fail(code, "proof files must be path-sorted and unique");
  return files;
}

function commit(value, expectedRepository, expectedSha, code) {
  exact(value, ["version", "repository", "sha", "tree_sha"], code);
  if (value.version !== VERSION || repository(value.repository, code) !== expectedRepository ||
      value.sha !== expectedSha || !SHA_RE.test(value.tree_sha)) {
    fail(code, "commit observation is invalid");
  }
  return { sha: value.sha, tree_sha: value.tree_sha };
}
function readCommit(options, repo, value, code) {
  return commit(call(options, "readCommit", { version: VERSION, repository: repo, sha: value }, "repository_commit_unavailable"), repo, value, code);
}
function readTree(options, repo, treeSha, code) {
  return treeSnapshot(call(options, "readTree", { version: VERSION, repository: repo, tree_sha: treeSha }, "repository_tree_unavailable"), repo, treeSha, code);
}

function reviewedTask(value, stage, code) {
  exact(value, ["version", "work_task_ref", "candidate_digest", "base_sha", "candidate_sha", "terminal_review", "source_worktree_path"], code);
  if (value.version !== VERSION || !sameTask(value.work_task_ref, stage.work_task_ref) ||
      value.candidate_digest !== stage.candidate.candidate_digest || value.base_sha !== stage.candidate.base_sha ||
      value.candidate_sha !== stage.candidate.candidate_sha || !same(value.terminal_review, stage.terminal_review) ||
      value.source_worktree_path !== stage.candidate.managed_worktree.canonical_path) {
    fail("stale_reviewed_task_metadata", "reviewed task metadata is stale or changed");
  }
  canonicalAbsolutePath(value.source_worktree_path, code);
  return true;
}
function readReviewedTask(options, repo, manifest, stage) {
  const request = {
    version: VERSION,
    repository: repo,
    delivery_candidate_ref: clone(manifest.delivery_candidate_ref),
    delivery_manifest_digest: manifest.delivery_manifest_digest,
    sequence: stage.sequence,
    work_task_ref: clone(stage.work_task_ref),
    candidate_digest: stage.candidate.candidate_digest,
  };
  const observed = call(options, "readReviewedTask", request, "reviewed_task_metadata_unavailable");
  reviewedTask(observed, stage, "reviewed_task_metadata_invalid");
}

function handoff(value, code) {
  exact(value, ["sequence", "work_task_ref", "candidate_digest", "output_tree_sha"], code);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !SHA_RE.test(value.candidate_digest) || !SHA_RE.test(value.output_tree_sha)) {
    fail(code, "predecessor handoff identity is invalid");
  }
  taskKey(value.work_task_ref, code);
  return {
    sequence: value.sequence,
    work_task_ref: clone(value.work_task_ref),
    candidate_digest: value.candidate_digest,
    output_tree_sha: value.output_tree_sha,
  };
}
function applyResult(value, expected, code) {
  exact(value, ["version", "scope", "status", "input_tree_sha", "result_tree_sha", "applied_patch_digest"], code);
  if (value.version !== VERSION || value.scope !== expected.scope || value.status !== "applied" ||
      value.input_tree_sha !== expected.input_tree_sha || !SHA_RE.test(value.result_tree_sha) ||
      (expected.result_tree_sha !== null && value.result_tree_sha !== expected.result_tree_sha) ||
      value.applied_patch_digest !== expected.patch_digest) {
    fail(code, "patch application was not an exact clean apply");
  }
  return { result_tree_sha: value.result_tree_sha };
}
function applyPatch(options, repo, manifest, stage, patch, input, expectedResult, scope, predecessorHandoffs, code) {
  const request = {
    version: VERSION,
    repository: repo,
    scope,
    delivery_candidate_ref: clone(manifest.delivery_candidate_ref),
    delivery_manifest_digest: manifest.delivery_manifest_digest,
    sequence: stage === null ? 0 : stage.sequence,
    work_task_ref: stage === null ? null : clone(stage.work_task_ref),
    input_tree_sha: input.tree_sha,
    // Intermediate Git tree object IDs are not predictable from a patch
    // digest.  The adapter must return its observed object ID, which this
    // module immediately reads and checks against the deterministic file map.
    // Only candidate verification, full delivery verification, and the final
    // composition output have an exact known result-tree pin.
    expected_result_tree_sha: expectedResult === null ? null : expectedResult.tree_sha,
    patch: clone(patch),
    predecessor_handoffs: predecessorHandoffs.map(clone),
  };
  const observed = call(options, "applyPatch", request, "composition_apply_unavailable");
  return applyResult(observed, {
    scope,
    input_tree_sha: input.tree_sha,
    result_tree_sha: expectedResult === null ? null : expectedResult.tree_sha,
    patch_digest: patch.patch_digest,
  }, code);
}

function manifestContracts(manifest) {
  const byKey = new Map();
  for (const entry of manifest.frozen_batch_manifest.tasks) {
    const key = taskKey(entry.ref, "invalid_delivery_manifest");
    byKey.set(key, entry.contract);
  }
  const stages = manifest.staged_tasks.map((stage) => {
    const key = taskKey(stage.work_task_ref, "invalid_delivery_manifest");
    const contract = byKey.get(key);
    if (!contract) fail("invalid_delivery_manifest", "staged task is absent from frozen manifest");
    if (!contract.file_boundary.every((path) => PATH_RE.test(path))) {
      fail("delivery_composer_boundary_not_canonical", "frozen boundary cannot be composed canonically");
    }
    return { stage, key, contract };
  });
  return { byKey, stages };
}
function dependencyRelated(left, right, byKey, memo = new Map()) {
  const cacheKey = left + "|" + right;
  if (memo.has(cacheKey)) return memo.get(cacheKey);
  const contract = byKey.get(left);
  if (!contract) return false;
  const result = contract.dependencies.some((dependency) => {
    const key = taskKey(dependency, "invalid_delivery_manifest");
    return key === right || dependencyRelated(key, right, byKey, memo);
  });
  memo.set(cacheKey, result);
  return result;
}
function assertIndependentPatchOverlap(entries, byKey) {
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const related = dependencyRelated(entries[left].key, entries[right].key, byKey) ||
        dependencyRelated(entries[right].key, entries[left].key, byKey);
      if (!related && entries[left].patch.files.some((a) => entries[right].patch.files.some((b) => pathOverlaps(a.path, b.path)))) {
        fail("overlapping_independent_composition_patch", "independent patches overlap");
      }
    }
  }
}
function expectedHandoffs(contract, completed, sequenceByKey) {
  const dependencies = contract.dependencies.map((dependency) => {
    const key = taskKey(dependency, "invalid_delivery_manifest");
    const predecessor = completed.get(key);
    if (!predecessor) fail("dependent_predecessor_not_handed_off", "dependent task precedes a required frozen predecessor");
    return predecessor;
  }).sort((left, right) => left.sequence - right.sequence);
  if (new Set(dependencies.map((entry) => entry.sequence)).size !== dependencies.length ||
      dependencies.some((entry) => sequenceByKey.get(taskKey(entry.work_task_ref, "invalid_composition_proof")) !== entry.sequence)) {
    fail("dependent_predecessor_not_handed_off", "predecessor handoff is inconsistent");
  }
  return dependencies.map(clone);
}

function proofPayload(proof) {
  return {
    version: proof.version,
    delivery_candidate_ref: clone(proof.delivery_candidate_ref),
    delivery_manifest_digest: proof.delivery_manifest_digest,
    repository: proof.repository,
    base: clone(proof.base),
    result: clone(proof.result),
    delivery_patch: clone(proof.delivery_patch),
    steps: proof.steps.map(clone),
  };
}
function deliveryCompositionProofDigest(proof) {
  if (!plain(proof)) fail("invalid_composition_proof", "composition proof is invalid");
  return hash(proofPayload(proof));
}
function proofStep(value, sequence, code) {
  exact(value, ["sequence", "work_task_ref", "candidate_digest", "candidate_sha", "candidate_tree_sha", "candidate_tree_digest", "candidate_patch_digest", "input_tree_sha", "input_tree_digest", "output_tree_sha", "output_tree_digest", "changed_files", "predecessor_handoffs"], code);
  if (value.sequence !== sequence || !SHA_RE.test(value.candidate_digest) || !SHA_RE.test(value.candidate_sha) ||
      !SHA_RE.test(value.candidate_tree_sha) || !SHA_RE.test(value.candidate_tree_digest) ||
      !SHA_RE.test(value.candidate_patch_digest) || !SHA_RE.test(value.input_tree_sha) ||
      !SHA_RE.test(value.input_tree_digest) || !SHA_RE.test(value.output_tree_sha) || !SHA_RE.test(value.output_tree_digest) ||
      !Array.isArray(value.predecessor_handoffs)) {
    fail(code, "composition step is invalid");
  }
  taskKey(value.work_task_ref, code);
  const changed = proofFiles(value.changed_files, code);
  const predecessors = value.predecessor_handoffs.map((entry) => handoff(entry, code));
  const sequences = predecessors.map((entry) => entry.sequence);
  if (new Set(sequences).size !== sequences.length || sequences.some((entry) => entry >= sequence) ||
      !same(sequences, [...sequences].sort((left, right) => left - right))) {
    fail(code, "predecessor handoffs must be prior and sequence-sorted");
  }
  return { ...clone(value), changed_files: changed, predecessor_handoffs: predecessors };
}
function proofDeliveryPatch(value, base, result, code) {
  exact(value, ["patch_digest", "changed_files"], code);
  if (!SHA_RE.test(value.patch_digest)) fail(code, "delivery patch digest is invalid");
  const files = proofFiles(value.changed_files, code);
  if (!same(files, changedFiles(base, result))) fail(code, "delivery patch facts do not match proof trees");
  return { patch_digest: value.patch_digest, changed_files: files };
}
function assertDeliveryCompositionProof(value, manifest = null) {
  exact(value, ["version", "composition_proof_digest", "delivery_candidate_ref", "delivery_manifest_digest", "repository", "base", "result", "delivery_patch", "steps"], "invalid_composition_proof");
  if (value.version !== VERSION || !SHA_RE.test(value.composition_proof_digest) || !SHA_RE.test(value.delivery_manifest_digest) ||
      !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 64) {
    fail("invalid_composition_proof", "composition proof is invalid");
  }
  const ref = deliveryRef(value.delivery_candidate_ref, "invalid_composition_proof");
  const repo = repository(value.repository, "invalid_composition_proof");
  const base = proofCommitTree(value.base, ref.base_sha, "invalid_composition_proof");
  const result = proofCommitTree(value.result, ref.result_sha, "invalid_composition_proof");
  const deliveryPatch = proofDeliveryPatch(value.delivery_patch, base, result, "invalid_composition_proof");
  const steps = value.steps.map((step, index) => proofStep(step, index + 1, "invalid_composition_proof"));
  if (new Set(steps.map((step) => taskKey(step.work_task_ref, "invalid_composition_proof"))).size !== steps.length ||
      !same(value.composition_proof_digest, deliveryCompositionProofDigest(value))) {
    fail("invalid_composition_proof", "composition proof digest is invalid");
  }
  if (manifest !== null) assertProofAgainstManifest(value, manifest, { ref, repo, base, result, deliveryPatch, steps });
  return value;
}
function assertProofAgainstManifest(proof, manifestValue, prepared = null) {
  const manifest = deliveryManifest(manifestValue);
  const details = prepared || {
    ref: deliveryRef(proof.delivery_candidate_ref, "invalid_composition_proof"),
    repo: repository(proof.repository, "invalid_composition_proof"),
    base: proofCommitTree(proof.base, proof.delivery_candidate_ref.base_sha, "invalid_composition_proof"),
    result: proofCommitTree(proof.result, proof.delivery_candidate_ref.result_sha, "invalid_composition_proof"),
    deliveryPatch: proofDeliveryPatch(proof.delivery_patch,
      proofCommitTree(proof.base, proof.delivery_candidate_ref.base_sha, "invalid_composition_proof"),
      proofCommitTree(proof.result, proof.delivery_candidate_ref.result_sha, "invalid_composition_proof"), "invalid_composition_proof"),
    steps: proof.steps.map((step, index) => proofStep(step, index + 1, "invalid_composition_proof")),
  };
  if (proof.delivery_manifest_digest !== manifest.delivery_manifest_digest || !same(proof.delivery_candidate_ref, manifest.delivery_candidate_ref) ||
      details.repo !== repository(manifest.registered_repository.repository, "invalid_delivery_manifest") ||
      details.base.tree_sha !== manifest.evidence.tree.base_tree_sha || details.result.tree_sha !== manifest.evidence.tree.result_tree_sha ||
      details.deliveryPatch.patch_digest !== manifest.evidence.patch.patch_digest) {
    fail("composition_proof_manifest_mismatch", "composition proof is not pinned to this delivery manifest");
  }
  const contracts = manifestContracts(manifest);
  if (details.steps.length !== contracts.stages.length) fail("composition_proof_manifest_mismatch", "proof task count differs from frozen delivery cut");
  const byProofKey = new Map(details.steps.map((step) => [taskKey(step.work_task_ref, "invalid_composition_proof"), step]));
  const sequenceByKey = new Map(contracts.stages.map((entry) => [entry.key, entry.stage.sequence]));
  for (let index = 0; index < details.steps.length; index += 1) {
    const step = details.steps[index];
    const prior = index === 0 ? {
      tree_sha: details.base.tree_sha,
      tree_digest: snapshotDigest(details.base),
    } : {
      tree_sha: details.steps[index - 1].output_tree_sha,
      tree_digest: details.steps[index - 1].output_tree_digest,
    };
    if (step.input_tree_sha !== prior.tree_sha || step.input_tree_digest !== prior.tree_digest) {
      fail("composition_proof_manifest_mismatch", "proof composition tree chain is disconnected");
    }
    if (index === details.steps.length - 1 &&
        (step.output_tree_sha !== details.result.tree_sha || step.output_tree_digest !== snapshotDigest(details.result))) {
      fail("composition_proof_manifest_mismatch", "proof final composition tree is not the pinned delivery result");
    }
  }
  for (const entry of contracts.stages) {
    const step = byProofKey.get(entry.key);
    if (!step || step.sequence !== entry.stage.sequence || step.candidate_digest !== entry.stage.candidate.candidate_digest ||
        step.candidate_sha !== entry.stage.candidate.candidate_sha || step.candidate_tree_sha === details.base.tree_sha ||
        !step.changed_files.every((file) => withinBoundary(file.path, entry.contract.file_boundary))) {
      fail("composition_proof_manifest_mismatch", "proof step does not match frozen reviewed task provenance");
    }
    const expected = expectedHandoffs(entry.contract, new Map(details.steps
      .filter((candidate) => candidate.sequence < step.sequence)
      .map((candidate) => [taskKey(candidate.work_task_ref, "invalid_composition_proof"), {
        sequence: candidate.sequence, work_task_ref: candidate.work_task_ref,
        candidate_digest: candidate.candidate_digest, output_tree_sha: candidate.output_tree_sha,
      }])), sequenceByKey);
    if (!same(step.predecessor_handoffs, expected)) fail("composition_proof_manifest_mismatch", "proof predecessor handoff is not exact");
  }
  const patchEntries = contracts.stages.map((entry) => ({ key: entry.key, patch: { files: byProofKey.get(entry.key).changed_files } }));
  assertIndependentPatchOverlap(patchEntries, contracts.byKey);
  return proof;
}

function composeDeliveryCandidate(manifestValue, optionsValue) {
  const manifest = deliveryManifest(manifestValue);
  const options = composerOptions(optionsValue);
  const ref = manifest.delivery_candidate_ref;
  const repo = repository(manifest.registered_repository.repository, "invalid_delivery_manifest");
  const contracts = manifestContracts(manifest);

  // Read all current review metadata first.  A stale candidate or sealed
  // receipt aborts before this adapter attempts even an injected patch apply.
  for (const entry of contracts.stages) readReviewedTask(options, repo, manifest, entry.stage);

  const baseCommit = readCommit(options, repo, ref.base_sha, "delivery_base_commit_invalid");
  const resultCommit = readCommit(options, repo, ref.result_sha, "delivery_result_commit_invalid");
  if (baseCommit.tree_sha !== manifest.evidence.tree.base_tree_sha) fail("delivery_base_tree_mismatch", "pinned base commit tree differs from manifest evidence");
  if (resultCommit.tree_sha !== manifest.evidence.tree.result_tree_sha) fail("delivery_result_tree_mismatch", "pinned result commit tree differs from manifest evidence");
  const baseTree = readTree(options, repo, baseCommit.tree_sha, "delivery_base_tree_invalid");
  const resultTree = readTree(options, repo, resultCommit.tree_sha, "delivery_result_tree_invalid");

  const deliveryPatchRequest = {
    version: VERSION,
    repository: repo,
    delivery_candidate_ref: clone(ref),
    delivery_manifest_digest: manifest.delivery_manifest_digest,
    base_sha: ref.base_sha,
    result_sha: ref.result_sha,
    base_tree_sha: baseTree.tree_sha,
    result_tree_sha: resultTree.tree_sha,
  };
  const deliveryPatch = binaryPatch(call(options, "readDeliveryPatch", deliveryPatchRequest, "delivery_patch_unavailable"), {
    scope: "delivery",
    base_sha: ref.base_sha,
    result_sha: ref.result_sha,
    base_tree_sha: baseTree.tree_sha,
    result_tree_sha: resultTree.tree_sha,
    source_worktree_path: null,
  }, "delivery_patch_invalid");
  assertPatchMatchesTrees(deliveryPatch, baseTree, resultTree, "delivery_patch_tree_mismatch");
  if (deliveryPatch.patch_digest !== manifest.evidence.patch.patch_digest) fail("delivery_patch_manifest_mismatch", "full delivery patch digest differs from manifest evidence");

  const prepared = contracts.stages.map((entry) => {
    const stage = entry.stage;
    const candidateCommit = readCommit(options, repo, stage.candidate.candidate_sha, "candidate_commit_invalid");
    const candidateTree = readTree(options, repo, candidateCommit.tree_sha, "candidate_tree_invalid");
    const request = {
      version: VERSION,
      repository: repo,
      delivery_candidate_ref: clone(ref),
      delivery_manifest_digest: manifest.delivery_manifest_digest,
      sequence: stage.sequence,
      work_task_ref: clone(stage.work_task_ref),
      candidate_digest: stage.candidate.candidate_digest,
      base_sha: stage.candidate.base_sha,
      candidate_sha: stage.candidate.candidate_sha,
      base_tree_sha: baseTree.tree_sha,
      candidate_tree_sha: candidateTree.tree_sha,
      source_worktree_path: stage.candidate.managed_worktree.canonical_path,
    };
    const patch = binaryPatch(call(options, "readCandidatePatch", request, "candidate_patch_unavailable"), {
      scope: "candidate",
      base_sha: stage.candidate.base_sha,
      result_sha: stage.candidate.candidate_sha,
      base_tree_sha: baseTree.tree_sha,
      result_tree_sha: candidateTree.tree_sha,
      source_worktree_path: stage.candidate.managed_worktree.canonical_path,
    }, "candidate_patch_invalid");
    assertPatchMatchesTrees(patch, baseTree, candidateTree, "candidate_patch_tree_mismatch");
    return { ...entry, candidateTree, patch };
  });
  assertIndependentPatchOverlap(prepared, contracts.byKey);
  for (let index = 0; index < prepared.length; index += 1) {
    const entry = prepared[index];
    if (!entry.patch.files.every((file) => withinBoundary(file.path, entry.contract.file_boundary))) {
      fail("candidate_patch_boundary_violation", "candidate patch changes a path outside its frozen boundary");
    }
  }

  const deliveryApply = applyPatch(options, repo, manifest, null, deliveryPatch, baseTree, resultTree, "delivery_verification", [], "delivery_apply_not_clean");
  if (deliveryApply.result_tree_sha !== resultTree.tree_sha) fail("delivery_apply_not_clean", "full delivery patch did not produce pinned result tree");

  let currentTree = baseTree;
  const completed = new Map();
  const sequenceByKey = new Map(prepared.map((entry) => [entry.key, entry.stage.sequence]));
  const steps = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const entry = prepared[index];
    const stage = entry.stage;
    const candidateApplied = applyPatch(options, repo, manifest, stage, entry.patch, baseTree, entry.candidateTree,
      "candidate_verification", [], "candidate_apply_not_clean");
    if (candidateApplied.result_tree_sha !== entry.candidateTree.tree_sha) fail("candidate_apply_not_clean", "candidate patch did not produce exact candidate tree");

    const predecessorHandoffs = expectedHandoffs(entry.contract, completed, sequenceByKey);
    const finalOutput = index === prepared.length - 1 ? resultTree : null;
    const applied = applyPatch(options, repo, manifest, stage, entry.patch, currentTree, finalOutput,
      "composition", predecessorHandoffs, "composition_apply_not_clean");
    const outputTree = readTree(options, repo, applied.result_tree_sha, "composition_output_tree_invalid");
    const expectedTree = expectedAppliedTree(currentTree, entry.patch.files, outputTree.tree_sha);
    if (!same(outputTree.entries, expectedTree.entries)) fail("composition_apply_tree_mismatch", "composition apply changed an unexpected blob or path");
    const step = {
      sequence: stage.sequence,
      work_task_ref: clone(stage.work_task_ref),
      candidate_digest: stage.candidate.candidate_digest,
      candidate_sha: stage.candidate.candidate_sha,
      candidate_tree_sha: entry.candidateTree.tree_sha,
      candidate_tree_digest: snapshotDigest(entry.candidateTree),
      candidate_patch_digest: entry.patch.patch_digest,
      input_tree_sha: currentTree.tree_sha,
      input_tree_digest: snapshotDigest(currentTree),
      output_tree_sha: outputTree.tree_sha,
      output_tree_digest: snapshotDigest(outputTree),
      changed_files: fileFacts(entry.patch.files),
      predecessor_handoffs: predecessorHandoffs,
    };
    steps.push(step);
    completed.set(entry.key, {
      sequence: step.sequence,
      work_task_ref: clone(step.work_task_ref),
      candidate_digest: step.candidate_digest,
      output_tree_sha: step.output_tree_sha,
    });
    currentTree = outputTree;
  }
  if (!same(currentTree.entries, resultTree.entries) || currentTree.tree_sha !== resultTree.tree_sha) {
    fail("composition_result_tree_mismatch", "ordered candidate composition does not produce pinned delivery result tree");
  }

  const proof = {
    version: VERSION,
    delivery_candidate_ref: clone(ref),
    delivery_manifest_digest: manifest.delivery_manifest_digest,
    repository: repo,
    base: { commit_sha: ref.base_sha, tree_sha: baseTree.tree_sha, tree_digest: snapshotDigest(baseTree), entries: baseTree.entries.map(clone) },
    result: { commit_sha: ref.result_sha, tree_sha: resultTree.tree_sha, tree_digest: snapshotDigest(resultTree), entries: resultTree.entries.map(clone) },
    delivery_patch: { patch_digest: deliveryPatch.patch_digest, changed_files: fileFacts(deliveryPatch.files) },
    steps: steps.map(clone),
  };
  const finalized = freeze({ composition_proof_digest: hash(proofPayload(proof)), ...proof });
  assertDeliveryCompositionProof(finalized, manifest);
  return finalized;
}

module.exports = {
  VERSION,
  DeliveryComposerError,
  deliveryCompositionProofDigest,
  assertDeliveryCompositionProof,
  composeDeliveryCandidate,
};
