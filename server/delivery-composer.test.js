"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");
const {
  DeliveryComposerError,
  deliveryCompositionProofDigest,
  assertDeliveryCompositionProof,
  composeDeliveryCandidate,
} = require("./delivery-composer");

const VERSION = 1;
const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const repository = "owner/product-web";
const base_sha = "e".repeat(64);
const result_sha = "f".repeat(64);
const base_tree_sha = "a".repeat(64);
const alpha_tree_sha = "b".repeat(64);
const bravo_tree_sha = "c".repeat(64);
const result_tree_sha = "d".repeat(64);
const intermediate_tree_sha = "0123456789abcdef".repeat(4);
const alpha_candidate_sha = "1".repeat(64);
const bravo_candidate_sha = "2".repeat(64);
const web42 = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };
const web43 = { repoKey: "web", repo: "Owner/Product-Web", number: 43, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function stable(value) {
  return Array.isArray(value) ? "[" + value.map(stable).join(",") + "]" : plain(value)
    ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}"
    : JSON.stringify(value);
}
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof DeliveryComposerError && error.code === expected);
}
function entry(pathName, blob_sha, mode = "100644") { return { path: pathName, mode, blob_sha }; }
function tree(tree_sha, entries) { return { tree_sha, entries: entries.map(copy).sort((left, right) => left.path.localeCompare(right.path)) }; }
function entryMap(value) { return new Map(value.entries.map((item) => [item.path, item])); }
function sameEntry(left, right) { return left === null ? right === null : right !== null && stable(left) === stable(right); }
function diff(base, result) {
  const before = entryMap(base), after = entryMap(result);
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((pathName) => ({
    path: pathName,
    before: before.get(pathName) || null,
    after: after.get(pathName) || null,
  })).filter((item) => !sameEntry(item.before, item.after));
}
function applyToTree(input, files, tree_sha) {
  const entries = entryMap(input);
  for (const file of files) {
    if (file.after === null) entries.delete(file.path);
    else entries.set(file.path, copy(file.after));
  }
  return tree(tree_sha, [...entries.values()]);
}
function patch({ scope, base_sha: patchBase, result_sha: patchResult, base, result, source_worktree_path }) {
  const files = diff(base, result).map((file) => ({
    ...file,
    binary_delta: "GIT binary patch\nliteral " + file.path + " " + (file.after ? file.after.blob_sha : "delete"),
  }));
  const payload = {
    version: VERSION,
    format: "git_full_index_binary_v1",
    scope,
    base_sha: patchBase,
    result_sha: patchResult,
    base_tree_sha: base.tree_sha,
    result_tree_sha: result.tree_sha,
    source_worktree_path,
    files,
  };
  return { ...payload, patch_digest: digest(payload) };
}
function recalculatePatch(raw) {
  const payload = {
    version: raw.version,
    format: raw.format,
    scope: raw.scope,
    base_sha: raw.base_sha,
    result_sha: raw.result_sha,
    base_tree_sha: raw.base_tree_sha,
    result_tree_sha: raw.result_tree_sha,
    source_worktree_path: raw.source_worktree_path,
    files: raw.files,
  };
  return { ...raw, patch_digest: digest(payload) };
}
function task({ task_key, work_item, boundary, dependencies = [] }) {
  return {
    task_key,
    repository_key: "web",
    work_item: copy(work_item),
    goal: "compose " + task_key + " deterministically",
    file_boundary: boundary,
    validation: ["node:test"],
    dependencies,
  };
}
function dependency(work_item, task_key) {
  return { repository_key: "web", work_item: copy(work_item), task_key };
}
function frozenBatch(tasks) {
  return freezeBatchManifest(buildBatchManifest({
    version: VERSION,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks,
  }, {
    resolveRegisteredIdentity(request) {
      assert.equal(Object.isFrozen(request), true);
      return {
        installation_id: request.installation_id,
        project_id: request.project_id,
        repository_key: request.repository_key,
        work_item: copy(request.work_item),
        issue_body_revision: request.work_item.number === 42 ? "7".repeat(64) : "8".repeat(64),
      };
    },
  }), "2026-09-01T12:00:00.000Z");
}
function candidate(ref, candidate_sha, worktree_id) {
  return buildWorkTaskCandidate({
    version: VERSION,
    work_task_ref: copy(ref),
    base_sha,
    candidate_sha,
    branch: "task/" + worktree_id,
    worktree: { repository_key: "web", worktree_id, path: "/var/folders/quadwork/" + worktree_id },
  }, {
    canonicalizePath(request) {
      return { version: VERSION, canonical_path: request.path.replace("/var/", "/private/var/") };
    },
    inspectManagedWorktree() {
      return {
        version: VERSION,
        registered: true,
        readable: true,
        repository_key: "web",
        worktree_id,
        canonical_path: "/private/var/folders/quadwork/" + worktree_id,
        branch: "task/" + worktree_id,
        base_sha,
        head_sha: candidate_sha,
        dirty: false,
        occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() {
      return { version: VERSION, installation_id, project_id, v1_state: "present" };
    },
  });
}
function receipt(ref, id, verdict) {
  const payload = { version: VERSION, review_round_ref: copy(ref), receipt_id: id, verdict, findings: [] };
  return { ...payload, receipt_digest: digest(payload) };
}
function releasedRound(workCandidate, suffix) {
  const opened = openTaskReviewRound({
    version: VERSION,
    candidate: workCandidate,
    attempt: "attempt-" + suffix,
    round: 1,
    opened_at: "2026-09-01T12:01:00.000Z",
  }, {
    version: VERSION,
    reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }],
  });
  const one = submitTaskReviewReceipt(opened, receipt(opened.review_round_ref, "receipt-re1-" + suffix, "approve"), {
    version: VERSION, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-01T12:02:00.000Z",
  });
  return submitTaskReviewReceipt(one.round, receipt(opened.review_round_ref, "receipt-re2-" + suffix, "approve"), {
    version: VERSION, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-01T12:03:00.000Z",
  }).round;
}
function buildFixture({ dependent = false, actualOverlap = false } = {}) {
  const batch = frozenBatch([
    task({ task_key: "alpha", work_item: web42, boundary: ["server/alpha.js"] }),
    task({
      task_key: "bravo",
      work_item: web43,
      boundary: ["server/bravo.js"],
      dependencies: dependent ? [dependency(web42, "alpha")] : [],
    }),
  ]);
  const alpha = candidate(batch.tasks[0].ref, alpha_candidate_sha, "wt-alpha");
  const bravo = candidate(batch.tasks[1].ref, bravo_candidate_sha, "wt-bravo");
  const base = tree(base_tree_sha, [
    entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "4".repeat(64)),
    entry("server/bravo.js", "5".repeat(64)),
  ]);
  const alphaTree = tree(alpha_tree_sha, [
    entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "6".repeat(64)),
    entry("server/bravo.js", "5".repeat(64)),
  ]);
  const bravoTree = actualOverlap ? tree(bravo_tree_sha, [
    entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "7".repeat(64)),
    entry("server/bravo.js", "5".repeat(64)),
  ]) : tree(bravo_tree_sha, [
    entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "4".repeat(64)),
    entry("server/bravo.js", "7".repeat(64)),
  ]);
  const result = tree(result_tree_sha, [
    entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "6".repeat(64)),
    entry("server/bravo.js", "7".repeat(64)),
  ]);
  const ref = {
    version: VERSION,
    installation_id,
    project_id,
    repository_key: "web",
    batch_manifest_digest: batch.manifest_digest,
    delivery_mode: "integrated",
    base_sha,
    result_sha,
    cut_id: "cut-1060",
  };
  const alphaPatch = patch({
    scope: "candidate", base_sha, result_sha: alpha_candidate_sha, base, result: alphaTree,
    source_worktree_path: alpha.managed_worktree.canonical_path,
  });
  const bravoPatch = patch({
    scope: "candidate", base_sha, result_sha: bravo_candidate_sha, base, result: bravoTree,
    source_worktree_path: bravo.managed_worktree.canonical_path,
  });
  const deliveryPatch = patch({
    scope: "delivery", base_sha, result_sha, base, result, source_worktree_path: null,
  });
  const paths = ["server/alpha.js", "server/bravo.js"];
  const manifest = buildDeliveryManifest({
    version: VERSION,
    delivery_candidate_ref: ref,
    frozen_batch_manifest: batch,
    staged_tasks: [
      { candidate: alpha, review_round: releasedRound(alpha, "alpha") },
      { candidate: bravo, review_round: releasedRound(bravo, "bravo") },
    ],
    deferred_exclusions: [],
    evidence: {
      boundary: { paths, boundary_digest: digest({ version: VERSION, paths }) },
      patch: { base_sha, result_sha, patch_digest: deliveryPatch.patch_digest },
      tree: {
        base_tree_sha,
        result_tree_sha,
        tree_digest: digest({ version: VERSION, base_tree_sha, result_tree_sha }),
      },
    },
  }, {
    resolveRegisteredRepository(request) {
      return {
        version: VERSION,
        installation_id: request.installation_id,
        project_id: request.project_id,
        repository_key: request.repository_key,
        repository: "Owner/Product-Web",
      };
    },
  });
  return {
    manifest,
    trees: new Map([
      [base.tree_sha, base],
      [alphaTree.tree_sha, alphaTree],
      [bravoTree.tree_sha, bravoTree],
      [result.tree_sha, result],
    ]),
    commits: new Map([
      [base_sha, base.tree_sha],
      [result_sha, result.tree_sha],
      [alpha_candidate_sha, alphaTree.tree_sha],
      [bravo_candidate_sha, bravoTree.tree_sha],
    ]),
    candidatePatches: new Map([
      [alpha_candidate_sha, alphaPatch],
      [bravo_candidate_sha, bravoPatch],
    ]),
    deliveryPatch,
  };
}
function createOperations(fixture, overrides = {}) {
  const calls = [];
  const applyCalls = [];
  function normalCommit(request) {
    return { version: VERSION, repository, sha: request.sha, tree_sha: fixture.commits.get(request.sha) };
  }
  function normalTree(request) {
    const value = fixture.trees.get(request.tree_sha);
    return { version: VERSION, repository, tree_sha: request.tree_sha, entries: value ? copy(value.entries) : [] };
  }
  function normalReviewed(request) {
    const stage = fixture.manifest.staged_tasks[request.sequence - 1];
    return {
      version: VERSION,
      work_task_ref: copy(stage.work_task_ref),
      candidate_digest: stage.candidate.candidate_digest,
      base_sha: stage.candidate.base_sha,
      candidate_sha: stage.candidate.candidate_sha,
      terminal_review: copy(stage.terminal_review),
      source_worktree_path: stage.candidate.managed_worktree.canonical_path,
    };
  }
  function normalApply(request) {
    let outputTreeSha;
    if (request.scope === "candidate_verification" || request.scope === "delivery_verification") {
      outputTreeSha = request.patch.result_tree_sha;
    } else {
      outputTreeSha = request.expected_result_tree_sha || intermediate_tree_sha;
      const input = fixture.trees.get(request.input_tree_sha);
      fixture.trees.set(outputTreeSha, applyToTree(input, request.patch.files, outputTreeSha));
    }
    return {
      version: VERSION,
      scope: request.scope,
      status: "applied",
      input_tree_sha: request.input_tree_sha,
      result_tree_sha: outputTreeSha,
      applied_patch_digest: request.patch.patch_digest,
    };
  }
  const operations = {
    readCommit(request) {
      assert.equal(Object.isFrozen(request), true, "commit request is immutable");
      calls.push({ name: "readCommit", request: copy(request) });
      const response = normalCommit(request);
      return overrides.readCommit ? overrides.readCommit(request, response) : response;
    },
    readTree(request) {
      assert.equal(Object.isFrozen(request), true, "tree request is immutable");
      calls.push({ name: "readTree", request: copy(request) });
      const response = normalTree(request);
      return overrides.readTree ? overrides.readTree(request, response) : response;
    },
    readReviewedTask(request) {
      assert.equal(Object.isFrozen(request), true, "review request is immutable");
      calls.push({ name: "readReviewedTask", request: copy(request) });
      const response = normalReviewed(request);
      return overrides.readReviewedTask ? overrides.readReviewedTask(request, response) : response;
    },
    readCandidatePatch(request) {
      assert.equal(Object.isFrozen(request), true, "candidate patch request is immutable");
      calls.push({ name: "readCandidatePatch", request: copy(request) });
      const response = copy(fixture.candidatePatches.get(request.candidate_sha));
      return overrides.readCandidatePatch ? overrides.readCandidatePatch(request, response) : response;
    },
    readDeliveryPatch(request) {
      assert.equal(Object.isFrozen(request), true, "delivery patch request is immutable");
      calls.push({ name: "readDeliveryPatch", request: copy(request) });
      const response = copy(fixture.deliveryPatch);
      return overrides.readDeliveryPatch ? overrides.readDeliveryPatch(request, response) : response;
    },
    applyPatch(request) {
      assert.equal(Object.isFrozen(request), true, "apply request is immutable");
      calls.push({ name: "applyPatch", request: copy(request) });
      applyCalls.push(copy(request));
      const response = normalApply(request);
      return overrides.applyPatch ? overrides.applyPatch(request, response) : response;
    },
  };
  return { operations, calls, applyCalls };
}

// A valid frozen integrated cut is completely deterministic, starts exactly
// at the DeliveryCandidate base, follows manifest order, and never mutates
// either the manifest or injected request data.
{
  const fixture = buildFixture();
  const input = copy(fixture.manifest);
  const first = createOperations(fixture);
  const proof = composeDeliveryCandidate(fixture.manifest, first.operations);
  assert.deepEqual(fixture.manifest, input, "composition does not mutate the manifest");
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(assertDeliveryCompositionProof(proof, fixture.manifest), proof);
  assert.equal(proof.delivery_patch.patch_digest, fixture.manifest.evidence.patch.patch_digest);
  assert.deepEqual(proof.steps.map((step) => step.sequence), [1, 2]);
  assert.deepEqual(proof.steps.map((step) => step.work_task_ref.task_key), ["alpha", "bravo"]);
  assert.deepEqual(proof.steps.map((step) => step.predecessor_handoffs), [[], []]);
  assert.equal(proof.steps[0].output_tree_sha, intermediate_tree_sha,
    "the first composed tree is the adapter-observed object ID, not a synthesized hash");
  assert.equal(proof.result.tree_sha, result_tree_sha);
  assert.equal(first.applyCalls.filter((request) => request.scope === "composition").length, 2);
  const composeRequests = first.applyCalls.filter((request) => request.scope === "composition");
  assert.equal(composeRequests[0].expected_result_tree_sha, null,
    "intermediate composition does not invent a Git object ID");
  assert.equal(composeRequests[1].expected_result_tree_sha, result_tree_sha,
    "only the final composition step is pinned to the Delivery Candidate result tree");

  const secondFixture = buildFixture();
  const second = createOperations(secondFixture);
  const repeated = composeDeliveryCandidate(secondFixture.manifest, second.operations);
  assert.deepEqual(repeated, proof, "same exact objects and patches produce an identical proof");
}

// A frozen dependency becomes an explicit predecessor handoff in the
// composition request and proof; it cannot be silently skipped or reordered.
{
  const fixture = buildFixture({ dependent: true });
  const operations = createOperations(fixture);
  const proof = composeDeliveryCandidate(fixture.manifest, operations.operations);
  assert.equal(proof.steps[1].predecessor_handoffs.length, 1);
  assert.equal(proof.steps[1].predecessor_handoffs[0].work_task_ref.task_key, "alpha");
  const dependencyApply = operations.applyCalls.find((request) => request.scope === "composition" && request.sequence === 2);
  assert.deepEqual(dependencyApply.predecessor_handoffs, proof.steps[1].predecessor_handoffs);
  assert.equal(proof.steps[0].output_tree_sha, intermediate_tree_sha);
}

// Even if a malicious object adapter presents two independent patches with
// the same path, composition stops before an application attempt.
{
  const fixture = buildFixture({ actualOverlap: true });
  const operations = createOperations(fixture);
  throwsCode(() => composeDeliveryCandidate(fixture.manifest, operations.operations), "overlapping_independent_composition_patch");
  assert.equal(operations.applyCalls.length, 0);
}

// The adapter fails closed for stale review metadata before it invokes any
// patch application.  It therefore has no mutation channel on invalidation.
{
  const fixture = buildFixture();
  const operations = createOperations(fixture, {
    readReviewedTask(request, response) {
      return request.sequence === 1 ? { ...response, candidate_sha: "0".repeat(64) } : response;
    },
  });
  throwsCode(() => composeDeliveryCandidate(fixture.manifest, operations.operations), "stale_reviewed_task_metadata");
  assert.equal(operations.applyCalls.length, 0);
}

// Full-index patch digest, canonical /private/var worktree identity, patch
// tree/blob facts, and pinned base all reject independently before a proof.
{
  const invalidDigestFixture = buildFixture();
  const invalidDigest = createOperations(invalidDigestFixture, {
    readCandidatePatch(request, response) {
      return request.sequence === 1 ? { ...response, patch_digest: "0".repeat(64) } : response;
    },
  });
  throwsCode(() => composeDeliveryCandidate(invalidDigestFixture.manifest, invalidDigest.operations), "candidate_patch_invalid");

  const pathFixture = buildFixture();
  const pathMismatch = createOperations(pathFixture, {
    readCandidatePatch(request, response) {
      if (request.sequence !== 1) return response;
      return recalculatePatch({ ...response, source_worktree_path: response.source_worktree_path.replace("/private/var/", "/var/") });
    },
  });
  throwsCode(() => composeDeliveryCandidate(pathFixture.manifest, pathMismatch.operations), "candidate_patch_invalid");

  const treeFixture = buildFixture();
  const treeMismatch = createOperations(treeFixture, {
    readCandidatePatch(request, response) {
      if (request.sequence !== 1) return response;
      const changed = copy(response);
      changed.files[0].after.blob_sha = "0".repeat(64);
      return recalculatePatch(changed);
    },
  });
  throwsCode(() => composeDeliveryCandidate(treeFixture.manifest, treeMismatch.operations), "candidate_patch_tree_mismatch");

  const baseFixture = buildFixture();
  const baseMismatch = createOperations(baseFixture, {
    readCommit(request, response) {
      return request.sha === base_sha ? { ...response, tree_sha: "0".repeat(64) } : response;
    },
  });
  throwsCode(() => composeDeliveryCandidate(baseFixture.manifest, baseMismatch.operations), "delivery_base_tree_mismatch");
}

// A fuzzy or conflicted injected apply is never accepted as a composition
// result, even when its tree and patch fields otherwise look plausible.
{
  const fixture = buildFixture();
  const operations = createOperations(fixture, {
    applyPatch(request, response) {
      return request.scope === "delivery_verification" ? { ...response, status: "conflicted" } : response;
    },
  });
  throwsCode(() => composeDeliveryCandidate(fixture.manifest, operations.operations), "delivery_apply_not_clean");
}

// Intermediate composition output IDs are adapter-observed, but the last
// output is always pinned to the candidate result tree and cannot drift.
{
  const fixture = buildFixture();
  const operations = createOperations(fixture, {
    applyPatch(request, response) {
      return request.scope === "composition" && request.sequence === 2
        ? { ...response, result_tree_sha: intermediate_tree_sha }
        : response;
    },
  });
  throwsCode(() => composeDeliveryCandidate(fixture.manifest, operations.operations), "composition_apply_not_clean");
}

// The manifest's frozen order is checked by its M1 validator before the
// adapter reads an object.  A reordering cannot get a new composition proof.
{
  const fixture = buildFixture();
  const reordered = copy(fixture.manifest);
  reordered.staged_tasks.reverse();
  const operations = createOperations(fixture);
  throwsCode(() => composeDeliveryCandidate(reordered, operations.operations), "invalid_delivery_manifest");
  assert.equal(operations.calls.length, 0);
}

// Validator/digest are independently useful at the runtime boundary and the
// source remains a pure dependency-injected adapter with no host capability.
{
  const fixture = buildFixture();
  const proof = composeDeliveryCandidate(fixture.manifest, createOperations(fixture).operations);
  assert.equal(deliveryCompositionProofDigest(proof), proof.composition_proof_digest);
  const tampered = copy(proof);
  tampered.steps[1].predecessor_handoffs = [{
    sequence: 1,
    work_task_ref: copy(tampered.steps[0].work_task_ref),
    candidate_digest: tampered.steps[0].candidate_digest,
    output_tree_sha: "0".repeat(64),
  }];
  tampered.composition_proof_digest = deliveryCompositionProofDigest(tampered);
  throwsCode(() => assertDeliveryCompositionProof(tampered, fixture.manifest), "composition_proof_manifest_mismatch");

  const wrongFinal = copy(proof);
  wrongFinal.steps[1].output_tree_sha = intermediate_tree_sha;
  wrongFinal.steps[1].output_tree_digest = wrongFinal.steps[0].output_tree_digest;
  wrongFinal.composition_proof_digest = deliveryCompositionProofDigest(wrongFinal);
  throwsCode(() => assertDeliveryCompositionProof(wrongFinal, fixture.manifest), "composition_proof_manifest_mismatch");

  const source = fs.readFileSync(path.join(__dirname, "delivery-composer.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'](?:node:)?(?:fs|child_process|net|http|https)["']\)/);
  assert.doesNotMatch(source, /execFile|spawn\(|git\s+apply/);
}

console.log("delivery-composer.test.js: all assertions passed");
