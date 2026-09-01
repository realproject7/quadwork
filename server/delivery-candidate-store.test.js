"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");
const { composeDeliveryCandidate } = require("./delivery-composer");
const {
  DeliveryCandidateStoreError,
  deliveryCandidateStorePath,
  createDeliveryCandidateStore,
} = require("./delivery-candidate-store");

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
  return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : plain(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
}
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof DeliveryCandidateStoreError && error.code === expected);
}
function entry(pathName, blob_sha) { return { path: pathName, mode: "100644", blob_sha }; }
function tree(tree_sha, entries) { return { tree_sha, entries: entries.map(copy).sort((a, b) => a.path.localeCompare(b.path)) }; }
function entryMap(value) { return new Map(value.entries.map((item) => [item.path, item])); }
function sameEntry(left, right) { return left === null ? right === null : right !== null && stable(left) === stable(right); }
function diff(base, result) {
  const before = entryMap(base), after = entryMap(result);
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((pathName) => ({
    path: pathName, before: before.get(pathName) || null, after: after.get(pathName) || null,
  })).filter((item) => !sameEntry(item.before, item.after));
}
function applyToTree(input, files, tree_sha) {
  const entries = entryMap(input);
  for (const file of files) {
    if (file.after === null) entries.delete(file.path); else entries.set(file.path, copy(file.after));
  }
  return tree(tree_sha, [...entries.values()]);
}
function patch({ scope, base_sha: patchBase, result_sha: patchResult, base, result, source_worktree_path }) {
  const files = diff(base, result).map((file) => ({
    ...file,
    binary_delta: `GIT binary patch\nliteral ${file.path} ${file.after ? file.after.blob_sha : "delete"}`,
  }));
  const payload = {
    version: VERSION, format: "git_full_index_binary_v1", scope, base_sha: patchBase, result_sha: patchResult,
    base_tree_sha: base.tree_sha, result_tree_sha: result.tree_sha, source_worktree_path, files,
  };
  return { ...payload, patch_digest: digest(payload) };
}
function task(task_key, work_item, file_boundary) {
  return { task_key, repository_key: "web", work_item: copy(work_item), goal: `compose ${task_key}`, file_boundary, validation: ["node:test"], dependencies: [] };
}
function frozenBatch() {
  return freezeBatchManifest(buildBatchManifest({
    version: VERSION, installation_id, project_id, delivery_mode: "integrated",
    tasks: [task("alpha", web42, ["server/alpha.js"]), task("bravo", web43, ["server/bravo.js"])],
  }, {
    resolveRegisteredIdentity(request) {
      return {
        installation_id: request.installation_id, project_id: request.project_id, repository_key: request.repository_key,
        work_item: copy(request.work_item), issue_body_revision: request.work_item.number === 42 ? "7".repeat(64) : "8".repeat(64),
      };
    },
  }), "2026-09-01T12:00:00.000Z");
}
function candidate(ref, candidate_sha, worktree_id) {
  return buildWorkTaskCandidate({
    version: VERSION, work_task_ref: copy(ref), base_sha, candidate_sha, branch: `task/${worktree_id}`,
    worktree: { repository_key: "web", worktree_id, path: `/var/folders/quadwork/${worktree_id}` },
  }, {
    canonicalizePath(request) { return { version: VERSION, canonical_path: request.path.replace("/var/", "/private/var/") }; },
    inspectManagedWorktree() {
      return {
        version: VERSION, registered: true, readable: true, repository_key: "web", worktree_id,
        canonical_path: `/private/var/folders/quadwork/${worktree_id}`, branch: `task/${worktree_id}`,
        base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() { return { version: VERSION, installation_id, project_id, v1_state: "present" }; },
  });
}
function receipt(ref, id) {
  const payload = { version: VERSION, review_round_ref: copy(ref), receipt_id: id, verdict: "approve", findings: [] };
  return { ...payload, receipt_digest: digest(payload) };
}
function releasedRound(workCandidate, suffix) {
  const opened = openTaskReviewRound({
    version: VERSION, candidate: workCandidate, attempt: `attempt-${suffix}`, round: 1, opened_at: "2026-09-01T12:01:00.000Z",
  }, { version: VERSION, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }] });
  const first = submitTaskReviewReceipt(opened, receipt(opened.review_round_ref, `receipt-re1-${suffix}`), {
    version: VERSION, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-01T12:02:00.000Z",
  });
  return submitTaskReviewReceipt(first.round, receipt(opened.review_round_ref, `receipt-re2-${suffix}`), {
    version: VERSION, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-01T12:03:00.000Z",
  }).round;
}
function fixture() {
  const batch = frozenBatch();
  const alpha = candidate(batch.tasks[0].ref, alpha_candidate_sha, "wt-alpha");
  const bravo = candidate(batch.tasks[1].ref, bravo_candidate_sha, "wt-bravo");
  const base = tree(base_tree_sha, [entry("README.md", "3".repeat(64)), entry("server/alpha.js", "4".repeat(64)), entry("server/bravo.js", "5".repeat(64))]);
  const alphaTree = tree(alpha_tree_sha, [entry("README.md", "3".repeat(64)), entry("server/alpha.js", "6".repeat(64)), entry("server/bravo.js", "5".repeat(64))]);
  const bravoTree = tree(bravo_tree_sha, [entry("README.md", "3".repeat(64)), entry("server/alpha.js", "4".repeat(64)), entry("server/bravo.js", "7".repeat(64))]);
  const result = tree(result_tree_sha, [entry("README.md", "3".repeat(64)), entry("server/alpha.js", "6".repeat(64)), entry("server/bravo.js", "7".repeat(64))]);
  const ref = {
    version: VERSION, installation_id, project_id, repository_key: "web", batch_manifest_digest: batch.manifest_digest,
    delivery_mode: "integrated", base_sha, result_sha, cut_id: "cut-1060",
  };
  const alphaPatch = patch({ scope: "candidate", base_sha, result_sha: alpha_candidate_sha, base, result: alphaTree, source_worktree_path: alpha.managed_worktree.canonical_path });
  const bravoPatch = patch({ scope: "candidate", base_sha, result_sha: bravo_candidate_sha, base, result: bravoTree, source_worktree_path: bravo.managed_worktree.canonical_path });
  const deliveryPatch = patch({ scope: "delivery", base_sha, result_sha, base, result, source_worktree_path: null });
  const paths = ["server/alpha.js", "server/bravo.js"];
  const manifest = buildDeliveryManifest({
    version: VERSION, delivery_candidate_ref: ref, frozen_batch_manifest: batch,
    staged_tasks: [{ candidate: alpha, review_round: releasedRound(alpha, "alpha") }, { candidate: bravo, review_round: releasedRound(bravo, "bravo") }],
    deferred_exclusions: [],
    evidence: {
      boundary: { paths, boundary_digest: digest({ version: VERSION, paths }) },
      patch: { base_sha, result_sha, patch_digest: deliveryPatch.patch_digest },
      tree: { base_tree_sha, result_tree_sha, tree_digest: digest({ version: VERSION, base_tree_sha, result_tree_sha }) },
    },
  }, {
    resolveRegisteredRepository(request) {
      return { version: VERSION, installation_id: request.installation_id, project_id: request.project_id, repository_key: request.repository_key, repository: "Owner/Product-Web" };
    },
  });
  return {
    manifest,
    trees: new Map([[base.tree_sha, base], [alphaTree.tree_sha, alphaTree], [bravoTree.tree_sha, bravoTree], [result.tree_sha, result]]),
    commits: new Map([[base_sha, base.tree_sha], [result_sha, result.tree_sha], [alpha_candidate_sha, alphaTree.tree_sha], [bravo_candidate_sha, bravoTree.tree_sha]]),
    candidatePatches: new Map([[alpha_candidate_sha, alphaPatch], [bravo_candidate_sha, bravoPatch]]), deliveryPatch,
  };
}
function composerOperations(value) {
  return {
    readCommit(request) { return { version: VERSION, repository, sha: request.sha, tree_sha: value.commits.get(request.sha) }; },
    readTree(request) {
      const found = value.trees.get(request.tree_sha);
      return { version: VERSION, repository, tree_sha: request.tree_sha, entries: found ? copy(found.entries) : [] };
    },
    readReviewedTask(request) {
      const stage = value.manifest.staged_tasks[request.sequence - 1];
      return {
        version: VERSION, work_task_ref: copy(stage.work_task_ref), candidate_digest: stage.candidate.candidate_digest,
        base_sha: stage.candidate.base_sha, candidate_sha: stage.candidate.candidate_sha,
        terminal_review: copy(stage.terminal_review), source_worktree_path: stage.candidate.managed_worktree.canonical_path,
      };
    },
    readCandidatePatch(request) { return copy(value.candidatePatches.get(request.candidate_sha)); },
    readDeliveryPatch() { return copy(value.deliveryPatch); },
    applyPatch(request) {
      let output = request.patch.result_tree_sha;
      if (request.scope === "composition") {
        output = request.expected_result_tree_sha || intermediate_tree_sha;
        value.trees.set(output, applyToTree(value.trees.get(request.input_tree_sha), request.patch.files, output));
      }
      return { version: VERSION, scope: request.scope, status: "applied", input_tree_sha: request.input_tree_sha, result_tree_sha: output, applied_patch_digest: request.patch.patch_digest };
    },
  };
}
function validContracts() {
  const value = fixture();
  return { manifest: value.manifest, proof: composeDeliveryCandidate(value.manifest, composerOperations(value)) };
}
function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-delivery-store-")); }
function removeDirectory(directory) { fs.rmSync(directory, { recursive: true, force: true }); }
function store(directory, filesystem = fs) { return createDeliveryCandidateStore({ config_dir: directory, fs: filesystem }); }
function expected(ref, revision) { return { delivery_candidate_ref: copy(ref), revision }; }
function recordInput(contracts, revision = 0, correlation_id = "correlation-1060", idempotency_key = "idempotency-1060") {
  return {
    expected: expected(contracts.manifest.delivery_candidate_ref, revision), delivery_manifest: copy(contracts.manifest),
    composition_proof: copy(contracts.proof), correlation_id, idempotency_key,
  };
}

// The state is tied to one full DeliveryCandidateRef, retains canonical
// /private/var provenance, and may be recovered unchanged by a new instance.
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const first = store(directory);
    const initialized = first.initialize({ expected: expected(contracts.manifest.delivery_candidate_ref, null), delivery_manifest: copy(contracts.manifest) });
    assert.equal(initialized.revision, 0);
    assert.equal(initialized.lifecycle.status, "pending_composition");
    assert.equal(Object.isFrozen(initialized), true);
    assert.match(JSON.stringify(initialized), /\/private\/var\/folders\/quadwork\/wt-alpha/);
    assert.equal(fs.statSync(path.dirname(deliveryCandidateStorePath(directory, contracts.manifest.delivery_candidate_ref))).mode & 0o777, 0o700);
    assert.equal(fs.statSync(deliveryCandidateStorePath(directory, contracts.manifest.delivery_candidate_ref)).mode & 0o777, 0o600);
    const recovered = store(directory).readSnapshot(copy(contracts.manifest.delivery_candidate_ref));
    assert.deepEqual(recovered, initialized, "restart reads the exact immutable pending snapshot");
    assert.throws(() => { recovered.revision = 99; }, TypeError);
    throwsCode(() => first.initialize({ expected: expected(contracts.manifest.delivery_candidate_ref, null), delivery_manifest: copy(contracts.manifest) }), "delivery_candidate_store_already_initialized");
  } finally { removeDirectory(directory); }
}

// One revision-CAS transition records the exact proof; an exact retry is a
// no-op receipt, while a stale CAS or identifier reuse cannot create another
// candidate state.
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const candidateRef = contracts.manifest.delivery_candidate_ref;
    const instance = store(directory);
    instance.initialize({ expected: expected(candidateRef, null), delivery_manifest: copy(contracts.manifest) });
    throwsCode(() => instance.recordComposed(recordInput(contracts, 1, "correlation-stale", "idempotency-stale")), "stale_delivery_candidate_store_revision");
    const first = instance.recordComposed(recordInput(contracts));
    assert.equal(first.persisted, true);
    assert.equal(first.snapshot.revision, 1);
    assert.equal(first.snapshot.lifecycle.status, "composed");
    assert.equal(first.snapshot.composition_proof.composition_proof_digest, contracts.proof.composition_proof_digest);
    const replay = store(directory).recordComposed(recordInput(contracts));
    assert.equal(replay.persisted, false, "an exact replay never duplicates durable state");
    throwsCode(() => instance.recordComposed(recordInput(contracts, 0, "correlation-1060", "idempotency-other")), "delivery_candidate_store_idempotency_collision");
    throwsCode(() => instance.recordComposed(recordInput(contracts, 0, "correlation-other", "idempotency-other")), "delivery_candidate_store_already_composed");
  } finally { removeDirectory(directory); }
}

// A proof, manifest, or expected candidate that is stale/spoofed is rejected
// before a writer can change the initialized pending snapshot.
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const candidateRef = contracts.manifest.delivery_candidate_ref;
    const instance = store(directory);
    instance.initialize({ expected: expected(candidateRef, null), delivery_manifest: copy(contracts.manifest) });
    const staleProof = copy(contracts.proof);
    staleProof.delivery_manifest_digest = "0".repeat(64);
    throwsCode(() => instance.recordComposed({ ...recordInput(contracts), composition_proof: staleProof }), "invalid_delivery_candidate_store_record");
    const foreignRef = copy(candidateRef);
    foreignRef.repository_key = "other";
    throwsCode(() => instance.initialize({ expected: expected(foreignRef, null), delivery_manifest: copy(contracts.manifest) }), "invalid_delivery_candidate_store_initialization");
    const mismatchedManifest = copy(contracts.manifest);
    mismatchedManifest.delivery_manifest_digest = "0".repeat(64);
    throwsCode(() => instance.recordComposed({ ...recordInput(contracts), delivery_manifest: mismatchedManifest }), "invalid_delivery_candidate_store_record");
    assert.equal(instance.readSnapshot(candidateRef).lifecycle.status, "pending_composition");
    throwsCode(() => createDeliveryCandidateStore({ config_dir: directory, fs, publish: () => {} }), "invalid_delivery_candidate_store_options");
  } finally { removeDirectory(directory); }
}

// Corrupt, foreign, symlinked, insecure, locked, and failed-atomic state is
// never accepted or silently replaced.  The injected fs only affects this
// disposable test directory.
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const ref = contracts.manifest.delivery_candidate_ref;
    const statePath = deliveryCandidateStorePath(directory, ref);
    const instance = store(directory);
    throwsCode(() => instance.readSnapshot(ref), "delivery_candidate_store_missing");
    instance.initialize({ expected: expected(ref, null), delivery_manifest: copy(contracts.manifest) });
    fs.writeFileSync(statePath, "{not-json}\n", { mode: 0o600 });
    throwsCode(() => instance.readSnapshot(ref), "corrupt_delivery_candidate_store");
  } finally { removeDirectory(directory); }
}
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const ref = contracts.manifest.delivery_candidate_ref;
    const statePath = deliveryCandidateStorePath(directory, ref);
    const instance = store(directory);
    instance.initialize({ expected: expected(ref, null), delivery_manifest: copy(contracts.manifest) });
    const foreign = JSON.parse(fs.readFileSync(statePath, "utf8"));
    foreign.delivery_candidate_ref.project_id = "other-project";
    fs.writeFileSync(statePath, `${JSON.stringify(foreign)}\n`, { mode: 0o600 });
    throwsCode(() => instance.readSnapshot(ref), "delivery_candidate_store_identity_mismatch");
  } finally { removeDirectory(directory); }
}
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const ref = contracts.manifest.delivery_candidate_ref;
    const statePath = deliveryCandidateStorePath(directory, ref);
    const instance = store(directory);
    instance.initialize({ expected: expected(ref, null), delivery_manifest: copy(contracts.manifest) });
    fs.chmodSync(statePath, 0o644);
    throwsCode(() => instance.readSnapshot(ref), "delivery_candidate_store_insecure_permissions");
    fs.chmodSync(statePath, 0o600);
    fs.unlinkSync(statePath);
    fs.symlinkSync("/definitely-not-a-delivery-state", statePath);
    throwsCode(() => instance.readSnapshot(ref), "delivery_candidate_store_symlink_rejected");
  } finally { removeDirectory(directory); }
}
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const ref = contracts.manifest.delivery_candidate_ref;
    const statePath = deliveryCandidateStorePath(directory, ref);
    const instance = store(directory);
    instance.initialize({ expected: expected(ref, null), delivery_manifest: copy(contracts.manifest) });
    fs.writeFileSync(`${statePath}.lock`, "locked", { mode: 0o600, flag: "wx" });
    throwsCode(() => instance.recordComposed(recordInput(contracts)), "delivery_candidate_store_locked");
  } finally { removeDirectory(directory); }
}
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const ref = contracts.manifest.delivery_candidate_ref;
    const initial = store(directory);
    initial.initialize({ expected: expected(ref, null), delivery_manifest: copy(contracts.manifest) });
    const failingFs = { ...fs, renameSync() { const error = new Error("injected rename failure"); error.code = "EIO"; throw error; } };
    throwsCode(() => store(directory, failingFs).recordComposed(recordInput(contracts)), "delivery_candidate_store_write_failed");
    assert.equal(initial.readSnapshot(ref).revision, 0, "failed rename leaves prior pending snapshot intact");
  } finally { removeDirectory(directory); }
}
{
  const directory = temporaryDirectory();
  try {
    const contracts = validContracts();
    const ref = contracts.manifest.delivery_candidate_ref;
    const initial = store(directory);
    initial.initialize({ expected: expected(ref, null), delivery_manifest: copy(contracts.manifest) });
    const statePath = deliveryCandidateStorePath(directory, ref);
    let lockStats = 0;
    const replacingFs = {
      ...fs,
      lstatSync(target) {
        if (target === `${statePath}.lock`) {
          lockStats += 1;
          if (lockStats === 2) {
            fs.unlinkSync(target);
            fs.writeFileSync(target, "replacement", { mode: 0o600, flag: "wx" });
          }
        }
        return fs.lstatSync(target);
      },
    };
    throwsCode(() => store(directory, replacingFs).recordComposed(recordInput(contracts)), "delivery_candidate_store_lock_release_failed");
    assert.equal(initial.readSnapshot(ref).revision, 1, "replacement after atomic commit is never unlinked by the old writer");
  } finally { removeDirectory(directory); }
}

console.log("delivery-candidate-store tests passed");
