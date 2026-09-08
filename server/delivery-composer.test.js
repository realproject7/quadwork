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
// #1066: composition is awaited; a refusal is the same typed code, rejected.
function rejectsCode(fn, expected) {
  return assert.rejects(fn, (error) => error instanceof DeliveryComposerError && error.code === expected);
}
function entry(pathName, blob_sha, mode = "100644") { return { path: pathName, mode, blob_sha }; }
// Observed trees arrive in Git's byte order, which the composer itself checks
// (code-unit sort is byte order for the ASCII-only paths it accepts).
function tree(tree_sha, entries) { return { tree_sha, entries: entries.map(copy).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) }; }
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
function candidate(ref, candidate_sha, worktree_id, base = base_sha) {
  return buildWorkTaskCandidate({
    version: VERSION,
    work_task_ref: copy(ref),
    base_sha: base,
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
        base_sha: base,
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
// `chain` is the shape the pipeline actually stages (#1065): bravo depends on
// alpha, is built from alpha's exact candidate SHA, and by default declares a
// boundary that overlaps alpha's and rewrites alpha's file on top of alpha's
// change.  The older `dependent` flag keeps bravo on the repository root base,
// a state the pipeline can never produce.
function buildFixture({ dependent = false, actualOverlap = false, chain = false, overlap = true, undeclaredPath = false, root = false } = {}) {
  // `root` adds a lowercase root directory beside `README.md`: Git orders
  // `README.md` first (byte order), a locale order puts `bin` first.
  const rootEntries = root ? [entry("bin/cli.js", "2".repeat(64))] : [];
  const batch = frozenBatch([
    task({ task_key: "alpha", work_item: web42, boundary: ["server/alpha.js"] }),
    task({
      task_key: "bravo",
      work_item: web43,
      boundary: chain && overlap ? ["server/alpha.js", "server/bravo.js"] : ["server/bravo.js"],
      dependencies: dependent || chain ? [dependency(web42, "alpha")] : [],
    }),
  ]);
  const alpha = candidate(batch.tasks[0].ref, alpha_candidate_sha, "wt-alpha");
  const bravo = candidate(batch.tasks[1].ref, bravo_candidate_sha, "wt-bravo", chain ? alpha_candidate_sha : base_sha);
  const base = tree(base_tree_sha, [
    ...rootEntries, entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "4".repeat(64)),
    entry("server/bravo.js", "5".repeat(64)),
  ]);
  const alphaTree = tree(alpha_tree_sha, [
    ...rootEntries, entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "6".repeat(64)),
    entry("server/bravo.js", "5".repeat(64)),
  ]);
  const bravoTree = chain ? tree(bravo_tree_sha, [
    ...rootEntries, entry("README.md", (undeclaredPath ? "9" : "3").repeat(64)),
    entry("server/alpha.js", (overlap ? "7" : "6").repeat(64)),
    entry("server/bravo.js", "7".repeat(64)),
  ]) : actualOverlap ? tree(bravo_tree_sha, [
    ...rootEntries, entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "7".repeat(64)),
    entry("server/bravo.js", "5".repeat(64)),
  ]) : tree(bravo_tree_sha, [
    ...rootEntries, entry("README.md", "3".repeat(64)),
    entry("server/alpha.js", "4".repeat(64)),
    entry("server/bravo.js", "7".repeat(64)),
  ]);
  const result = tree(result_tree_sha, chain ? bravoTree.entries : [
    ...rootEntries, entry("README.md", "3".repeat(64)),
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
    scope: "candidate", base_sha: bravo.base_sha, result_sha: bravo_candidate_sha, base: chain ? alphaTree : base, result: bravoTree,
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

async function main() {
// A valid frozen integrated cut is completely deterministic, starts exactly
// at the DeliveryCandidate base, follows manifest order, and never mutates
// either the manifest or injected request data.
{
  const fixture = buildFixture();
  const input = copy(fixture.manifest);
  const first = createOperations(fixture);
  const proof = await composeDeliveryCandidate(fixture.manifest, first.operations);
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
  const repeated = await composeDeliveryCandidate(secondFixture.manifest, second.operations);
  assert.deepEqual(repeated, proof, "same exact objects and patches produce an identical proof");
}

// #1065: a frozen dependency is staged as the chain the pipeline built (bravo
// from alpha's exact candidate SHA, rewriting alpha's file).  Its patch is read
// and verified against alpha's tree, composed onto the accumulated tree, and
// becomes an explicit predecessor handoff in the composition request and proof.
{
  const fixture = buildFixture({ chain: true });
  const operations = createOperations(fixture);
  const proof = await composeDeliveryCandidate(fixture.manifest, operations.operations);
  assert.equal(proof.steps[1].predecessor_handoffs.length, 1);
  assert.equal(proof.steps[1].predecessor_handoffs[0].work_task_ref.task_key, "alpha");
  const dependencyApply = operations.applyCalls.find((request) => request.scope === "composition" && request.sequence === 2);
  assert.deepEqual(dependencyApply.predecessor_handoffs, proof.steps[1].predecessor_handoffs);
  assert.equal(proof.steps[0].output_tree_sha, intermediate_tree_sha);
  const bravoPatchRequest = operations.calls.find((call) => call.name === "readCandidatePatch" && call.request.sequence === 2).request;
  assert.equal(bravoPatchRequest.base_sha, alpha_candidate_sha, "the dependent patch is requested against its own base commit");
  assert.equal(bravoPatchRequest.base_tree_sha, alpha_tree_sha, "the dependent patch is requested against its own base tree");
  const bravoVerification = operations.applyCalls.find((request) => request.scope === "candidate_verification" && request.sequence === 2);
  assert.equal(bravoVerification.input_tree_sha, alpha_tree_sha, "the dependent candidate is verified from its own base tree");
  assert.deepEqual(proof.steps[1].changed_files.map((file) => [file.path, file.before.blob_sha[0], file.after.blob_sha[0]]),
    [["server/alpha.js", "6", "7"], ["server/bravo.js", "5", "7"]], "the overlap composes on top of alpha's change, not the root blob");
  assert.equal(dependencyApply.input_tree_sha, intermediate_tree_sha, "the dependent composes onto the accumulated tree");
  assert.equal(proof.result.tree_sha, result_tree_sha);
}

// #1065 negative controls around the chain.
{
  // The old dependent fixture (bravo depends on alpha but is based on the
  // repository root) is a state the pipeline cannot produce; the manifest
  // validator now refuses it instead of composing it.
  assert.throws(() => buildFixture({ dependent: true }), (error) => error.code === "integrated_delivery_base_mismatch");

  // A non-overlapping dependent still chains from, and hands off, alpha.
  const disjoint = buildFixture({ chain: true, overlap: false });
  const disjointOperations = createOperations(disjoint);
  const disjointProof = await composeDeliveryCandidate(disjoint.manifest, disjointOperations.operations);
  assert.deepEqual(disjointProof.steps[1].predecessor_handoffs.map((entry) => entry.work_task_ref.task_key), ["alpha"]);
  assert.deepEqual(disjointProof.steps[1].changed_files.map((file) => file.path), ["server/bravo.js"]);
  assert.equal(disjointOperations.calls.find((call) => call.name === "readCandidatePatch" && call.request.sequence === 2).request.base_sha, alpha_candidate_sha);

  // A dependent that changes a path outside its declared boundary is refused
  // before any apply, even though the change composes cleanly on alpha.
  const undeclared = buildFixture({ chain: true, undeclaredPath: true });
  const undeclaredOperations = createOperations(undeclared);
  await rejectsCode(() => composeDeliveryCandidate(undeclared.manifest, undeclaredOperations.operations), "candidate_patch_boundary_violation");
  assert.equal(undeclaredOperations.applyCalls.length, 0);

  // A dependent patch described against the root blob (the pre-#1065 reading)
  // no longer matches the dependent's own base tree.
  const staleFixture = buildFixture({ chain: true });
  const stale = createOperations(staleFixture, {
    readCandidatePatch(request, response) {
      if (request.sequence !== 2) return response;
      const changed = copy(response);
      changed.files.find((file) => file.path === "server/alpha.js").before.blob_sha = "4".repeat(64);
      return recalculatePatch(changed);
    },
  });
  await rejectsCode(() => composeDeliveryCandidate(staleFixture.manifest, stale.operations), "candidate_patch_tree_mismatch");
  assert.equal(stale.applyCalls.length, 0);

  // Even when an adapter presents a base tree and patch that agree with each
  // other, a `before` blob that is not the accumulated composition blob is
  // refused before that composition apply is attempted.
  const driftFixture = buildFixture({ chain: true });
  let alphaTreeReads = 0;
  const drift = createOperations(driftFixture, {
    readTree(request, response) {
      if (request.tree_sha !== alpha_tree_sha || (alphaTreeReads += 1) !== 2) return response;
      const entries = copy(response.entries);
      entries.find((item) => item.path === "server/alpha.js").blob_sha = "8".repeat(64);
      return { ...response, entries };
    },
    readCandidatePatch(request, response) {
      if (request.sequence !== 2) return response;
      const changed = copy(response);
      changed.files.find((file) => file.path === "server/alpha.js").before.blob_sha = "8".repeat(64);
      return recalculatePatch(changed);
    },
  });
  await rejectsCode(() => composeDeliveryCandidate(driftFixture.manifest, drift.operations), "composition_apply_not_clean");
  assert.equal(drift.applyCalls.filter((request) => request.scope === "composition").length, 1, "alpha composed; bravo's composition apply was never requested");

  // The final chain output stays pinned to the Delivery Candidate result.
  const finalFixture = buildFixture({ chain: true });
  const finalDrift = createOperations(finalFixture, {
    applyPatch(request, response) {
      return request.scope === "composition" && request.sequence === 2 ? { ...response, result_tree_sha: intermediate_tree_sha } : response;
    },
  });
  await rejectsCode(() => composeDeliveryCandidate(finalFixture.manifest, finalDrift.operations), "composition_apply_not_clean");
}

// Even if a malicious object adapter presents two independent patches with
// the same path, composition stops before an application attempt.  This is
// the independent counterpart of the #1065 chain: same overlap, no dependency.
{
  const fixture = buildFixture({ actualOverlap: true });
  const operations = createOperations(fixture);
  await rejectsCode(() => composeDeliveryCandidate(fixture.manifest, operations.operations), "overlapping_independent_composition_patch");
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
  await rejectsCode(() => composeDeliveryCandidate(fixture.manifest, operations.operations), "stale_reviewed_task_metadata");
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
  await rejectsCode(() => composeDeliveryCandidate(invalidDigestFixture.manifest, invalidDigest.operations), "candidate_patch_invalid");

  const pathFixture = buildFixture();
  const pathMismatch = createOperations(pathFixture, {
    readCandidatePatch(request, response) {
      if (request.sequence !== 1) return response;
      return recalculatePatch({ ...response, source_worktree_path: response.source_worktree_path.replace("/private/var/", "/var/") });
    },
  });
  await rejectsCode(() => composeDeliveryCandidate(pathFixture.manifest, pathMismatch.operations), "candidate_patch_invalid");

  const treeFixture = buildFixture();
  const treeMismatch = createOperations(treeFixture, {
    readCandidatePatch(request, response) {
      if (request.sequence !== 1) return response;
      const changed = copy(response);
      changed.files[0].after.blob_sha = "0".repeat(64);
      return recalculatePatch(changed);
    },
  });
  await rejectsCode(() => composeDeliveryCandidate(treeFixture.manifest, treeMismatch.operations), "candidate_patch_tree_mismatch");

  const baseFixture = buildFixture();
  const baseMismatch = createOperations(baseFixture, {
    readCommit(request, response) {
      return request.sha === base_sha ? { ...response, tree_sha: "0".repeat(64) } : response;
    },
  });
  await rejectsCode(() => composeDeliveryCandidate(baseFixture.manifest, baseMismatch.operations), "delivery_base_tree_mismatch");
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
  await rejectsCode(() => composeDeliveryCandidate(fixture.manifest, operations.operations), "delivery_apply_not_clean");
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
  await rejectsCode(() => composeDeliveryCandidate(fixture.manifest, operations.operations), "composition_apply_not_clean");
}

// The manifest's frozen order is checked by its M1 validator before the
// adapter reads an object.  A reordering cannot get a new composition proof.
{
  const fixture = buildFixture();
  const reordered = copy(fixture.manifest);
  reordered.staged_tasks.reverse();
  const operations = createOperations(fixture);
  await rejectsCode(() => composeDeliveryCandidate(reordered, operations.operations), "invalid_delivery_manifest");
  assert.equal(operations.calls.length, 0);
}

// Validator/digest are independently useful at the runtime boundary and the
// source remains a pure dependency-injected adapter with no host capability.
{
  const fixture = buildFixture();
  const proof = await composeDeliveryCandidate(fixture.manifest, createOperations(fixture).operations);
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

// #1066: every injected observation is awaited in manifest order, one at a
// time, and the loop turns between them; a review that changes after the
// first reads is re-observed last and refuses the proof before it exists.
{
  const fixture = buildFixture({ chain: true });
  const order = [];
  let turns = 0;
  const marker = setInterval(() => { turns += 1; }, 0);
  const operations = createOperations(fixture, {
    readReviewedTask(request, response) { order.push(`review:${request.sequence}`); return new Promise((resolve) => setImmediate(() => resolve(response))); },
    applyPatch(request, response) { order.push(`apply:${request.scope}:${request.sequence}`); return new Promise((resolve) => setImmediate(() => resolve(response))); },
  });
  const proof = await composeDeliveryCandidate(fixture.manifest, operations.operations);
  clearInterval(marker);
  assert.equal(proof.steps.length, 2);
  assert.ok(turns > 0, `the loop turned ${turns} times while observations were awaited`);
  assert.deepEqual(order.slice(0, 2), ["review:1", "review:2"], "reviews are read first");
  assert.deepEqual(order.slice(-2), ["review:1", "review:2"], "reviews are re-read last, after the final composition apply");
  assert.equal(order.filter((entry) => entry.startsWith("apply:")).length, 5);
  const lastCommit = operations.calls.at(-1);
  assert.equal(lastCommit.name, "readCommit");
  assert.equal(lastCommit.request.sha, result_sha, "the pinned result commit is the last observation before the proof");

  const revoked = buildFixture();
  let reviewReads = 0;
  const revokedOperations = createOperations(revoked, {
    readReviewedTask(request, response) {
      reviewReads += 1;
      return reviewReads > 2 && request.sequence === 1 ? { ...response, terminal_review: { ...response.terminal_review, round_digest: "0".repeat(64) } } : response;
    },
  });
  await rejectsCode(() => composeDeliveryCandidate(revoked.manifest, revokedOperations.operations), "stale_reviewed_task_metadata");
  assert.equal(revokedOperations.applyCalls.filter((request) => request.scope === "composition").length, 2, "the change landed only after every composition apply");

  const moved = buildFixture();
  let resultReads = 0;
  const movedOperations = createOperations(moved, {
    readCommit(request, response) {
      if (request.sha !== result_sha) return response;
      resultReads += 1;
      return resultReads === 2 ? { ...response, tree_sha: intermediate_tree_sha } : response;
    },
  });
  await rejectsCode(() => composeDeliveryCandidate(moved.manifest, movedOperations.operations), "delivery_result_tree_mismatch");
  assert.equal(resultReads, 2, "the pinned result is re-read once more after composition");
}

// Git orders tree entries by byte value: `README.md` precedes `bin/cli.js`,
// where a locale order reverses them.  The composer's expected applied tree
// must agree with the observed Git order, or a correct apply is refused as
// `composition_apply_tree_mismatch`.
{
  const fixture = buildFixture({ root: true });
  const gitOrder = ["README.md", "bin/cli.js", "server/alpha.js", "server/bravo.js"];
  assert.deepEqual(fixture.trees.get(base_tree_sha).entries.map((item) => item.path), gitOrder);
  assert.notDeepEqual([...gitOrder].sort((left, right) => left.localeCompare(right)), gitOrder, "this root is a locale/byte divergence");
  const operations = createOperations(fixture);
  const proof = await composeDeliveryCandidate(fixture.manifest, operations.operations);
  assert.deepEqual(proof.result.entries.map((item) => item.path), gitOrder, "the proof carries entries in Git order");
  assert.deepEqual(fixture.trees.get(intermediate_tree_sha).entries.map((item) => item.path), gitOrder, "the intermediate composed tree is read back in Git order");
  assert.equal(operations.applyCalls.filter((request) => request.scope === "composition").length, 2);
}
}

let finished = false;
process.on("exit", (code) => { if (!finished && code === 0) { console.error("delivery-composer.test.js: did not run to completion"); process.exitCode = 1; } });
main().then(() => { finished = true; console.log("delivery-composer.test.js: all assertions passed"); }, (error) => { console.error(error); process.exit(1); });
