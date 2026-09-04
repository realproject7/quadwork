"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");
const { DeliveryComposerError, composeDeliveryCandidate } = require("./delivery-composer");
const {
  DeliveryGitObjectAdapterError,
  createDeliveryGitObjectAdapter,
} = require("./delivery-git-object-adapter");

const installation_id = "installation_delivery_git_01";
const project_id = "quadwork";
const owner = { installation_id, project_id, role: "head", generation: 4 };
const manifest_digest_placeholder = "d".repeat(64);
// #1066: every objects handle runs under one absolute composition deadline.
const deadline = () => Date.now() + 30_000;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function git(cwd, args, input) {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).trim();
}
function write(repository, relative, content) {
  const target = path.join(repository, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}
function commit(repository, message) {
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}
// #1066: adapter refusals are awaited; the typed code is unchanged.
function rejectsAdapter(fn, code) {
  return assert.rejects(fn, (error) => error instanceof DeliveryGitObjectAdapterError && error.code === code);
}
function stage(ref, base_sha, candidate_sha, pathName) {
  const worktreePath = `/private/var/quadwork/${pathName}-dev`;
  const candidate = buildWorkTaskCandidate({
    version: 1,
    work_task_ref: copy(ref),
    base_sha,
    candidate_sha,
    branch: `task/${pathName}`,
    worktree: { repository_key: "web", worktree_id: `wt_web_${pathName}`, path: worktreePath },
  }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) {
      return {
        version: 1, registered: true, readable: true, repository_key: "web", worktree_id: `wt_web_${pathName}`,
        canonical_path: input.expected.canonical_path, branch: `task/${pathName}`, base_sha, head_sha: candidate_sha,
        dirty: false, occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  const opened = openTaskReviewRound({
    version: 1, candidate: copy(candidate), attempt: `attempt_${pathName}`, round: 1, opened_at: "2026-09-02T08:01:00.000Z",
  }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
  const receipt = (role) => {
    const payload = { version: 1, review_round_ref: copy(opened.review_round_ref), receipt_id: `receipt_${role}_${pathName}`, verdict: "approve", findings: [] };
    return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") };
  };
  const first = submitTaskReviewReceipt(opened, receipt("re1"), { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T08:02:00.000Z" });
  const released = submitTaskReviewReceipt(first.round, receipt("re2"), { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T08:03:00.000Z" }).round;
  return {
    candidate,
    terminal_review: {
      status: "released",
      review_round_ref: copy(released.review_round_ref),
      round_digest: released.round_digest,
      candidate_digest: candidate.candidate_digest,
      current_sha: candidate_sha,
      receipt_anchors: released.release.receipts.map((entry) => ({
        reviewer_role: entry.reviewer_role,
        reviewer_generation: entry.reviewer_generation,
        receipt_id: entry.receipt.receipt_id,
        receipt_digest: entry.receipt.receipt_digest,
        verdict: entry.receipt.verdict,
      })).sort((left, right) => left.reviewer_role.localeCompare(right.reviewer_role)),
    },
  };
}
function requestForPatch(ref, manifestDigest, workTaskRef, stageValue, baseTree, candidateTree, sequence) {
  return {
    version: 1,
    repository: "owner/web",
    delivery_candidate_ref: copy(ref),
    delivery_manifest_digest: manifestDigest,
    sequence,
    work_task_ref: copy(workTaskRef),
    candidate_digest: stageValue.candidate.candidate_digest,
    base_sha: stageValue.candidate.base_sha,
    candidate_sha: stageValue.candidate.candidate_sha,
    base_tree_sha: baseTree,
    candidate_tree_sha: candidateTree,
    source_worktree_path: stageValue.candidate.managed_worktree.canonical_path,
  };
}
function applyRequest(ref, manifestDigest, scope, sequence, workTaskRef, inputTree, expectedResultTree, patch) {
  return {
    version: 1,
    repository: "owner/web",
    scope,
    delivery_candidate_ref: copy(ref),
    delivery_manifest_digest: manifestDigest,
    sequence,
    work_task_ref: workTaskRef === null ? null : copy(workTaskRef),
    input_tree_sha: inputTree,
    expected_result_tree_sha: expectedResultTree,
    patch: copy(patch),
    predecessor_handoffs: [],
  };
}

async function withRepository(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-delivery-git-"));
  const repository = path.join(directory, "web");
  try {
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.email", "quadwork@example.test"]);
    git(repository, ["config", "user.name", "QuadWork Test"]);
    git(repository, ["remote", "add", "origin", "git@github.com:owner/web.git"]);
    write(repository, "server/a.js", "module.exports = 'base-a';\n");
    write(repository, "server/b.js", "module.exports = 'base-b';\n");
    const base_sha = commit(repository, "base");

    git(repository, ["checkout", "-b", "candidate-a", base_sha]);
    write(repository, "server/a.js", "module.exports = 'candidate-a';\n");
    const candidate_a = commit(repository, "candidate a");

    git(repository, ["checkout", "-b", "candidate-b", base_sha]);
    write(repository, "server/b.js", "module.exports = 'candidate-b';\n");
    const candidate_b = commit(repository, "candidate b");

    git(repository, ["checkout", "main"]);
    write(repository, "server/a.js", "module.exports = 'candidate-a';\n");
    write(repository, "server/b.js", "module.exports = 'candidate-b';\n");
    const result_sha = commit(repository, "integrated result");
    return await run({ directory, repository, base_sha, candidate_a, candidate_b, result_sha });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
await withRepository(async ({ repository, base_sha, candidate_a, candidate_b, result_sha }) => {
  const manifest = freezeBatchManifest(buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [
      { task_key: "a", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1061, kind: "issue" }, goal: "change a", file_boundary: ["server/a.js"], validation: ["node-test"], dependencies: [] },
      { task_key: "b", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1062, kind: "issue" }, goal: "change b", file_boundary: ["server/b.js"], validation: ["node-test"], dependencies: [] },
    ],
  }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; },
  }), "2026-09-02T08:00:00.000Z");
  const stages = [stage(manifest.tasks[0].ref, base_sha, candidate_a, "a"), stage(manifest.tasks[1].ref, base_sha, candidate_b, "b")];
  const deliverySource = {
    version: 1,
    registered_repository: { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" },
    frozen_batch_manifest: manifest,
    delivery_mode: "integrated",
    cut_id: "cut_delivery_git_01",
    base_sha,
    staged_tasks: stages,
    deferred_exclusions: [],
  };
  const calls = [];
  // The runner resolves on a later loop turn, as the server's does; `delay`
  // lets one test hold every call long enough for a short deadline to pass.
  let delay = 0;
  const adapter = createDeliveryGitObjectAdapter({
    repositories: [{ key: "web", repo: "Owner/Web", working_dir: repository, primary: true }],
    primary_agent_cwds: {}, repository_worktrees: {},
    canonicalize_path(request) { return fs.realpathSync(request.path); },
    run_git(request) {
      calls.push(copy({ args: request.args, input: request.input || null }));
      return new Promise((resolve) => setTimeout(() => {
        try {
          resolve({ ok: true, output: execFileSync("git", request.args, {
            cwd: request.cwd, encoding: "utf8", input: request.input, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
          }) });
        } catch {
          resolve({ ok: false, output: "" });
        }
      }, delay));
    },
    read_delivery_source(request) {
      assert.equal(Object.isFrozen(request), true);
      assert.equal(request.repository_key, "web");
      return copy(deliverySource);
    },
  });
  const refsBefore = git(repository, ["show-ref"]);

  const observed = await adapter.readDeliveryEvidence({ version: 1, head_binding: owner, delivery_source: copy(deliverySource) });
  assert.equal(observed.result_sha, result_sha);
  assert.deepEqual(observed.evidence.boundary.paths, ["server/a.js", "server/b.js"]);
  assert.match(observed.evidence.patch.patch_digest, /^[a-f0-9]{64}$/);

  const ref = {
    version: 1,
    installation_id,
    project_id,
    repository_key: "web",
    batch_manifest_digest: manifest.manifest_digest,
    delivery_mode: "integrated",
    base_sha,
    result_sha,
    cut_id: deliverySource.cut_id,
  };
  const manifestDigest = manifest_digest_placeholder;
  const objects = adapter.repositoryObjectsFor({ version: 1, head_binding: owner, delivery_candidate_ref: ref, deadline: deadline() });
  const deliveryManifest = buildDeliveryManifest({
    version: 1,
    delivery_candidate_ref: ref,
    frozen_batch_manifest: manifest,
    staged_tasks: copy(stages),
    deferred_exclusions: [],
    evidence: copy(observed.evidence),
  }, {
    resolveRegisteredRepository() { return copy(deliverySource.registered_repository); },
  });
  const base = await objects.readCommit({ version: 1, repository: "owner/web", sha: base_sha });
  const result = await objects.readCommit({ version: 1, repository: "owner/web", sha: result_sha });
  const candidateA = await objects.readCommit({ version: 1, repository: "owner/web", sha: candidate_a });
  const candidateB = await objects.readCommit({ version: 1, repository: "owner/web", sha: candidate_b });
  const baseTree = await objects.readTree({ version: 1, repository: "owner/web", tree_sha: base.tree_sha });
  const resultTree = await objects.readTree({ version: 1, repository: "owner/web", tree_sha: result.tree_sha });
  assert.equal(baseTree.entries.length, 2);
  assert.equal(resultTree.entries.length, 2);

  const fullPatch = await objects.readDeliveryPatch({
    version: 1, repository: "owner/web", delivery_candidate_ref: ref, delivery_manifest_digest: manifestDigest,
    base_sha, result_sha, base_tree_sha: base.tree_sha, result_tree_sha: result.tree_sha,
  });
  assert.equal(fullPatch.files.length, 2);
  assert.ok(fullPatch.files.every((entry) => entry.binary_delta.startsWith("GIT binary patch\n")));
  const patchA = await objects.readCandidatePatch(requestForPatch(ref, manifestDigest, manifest.tasks[0].ref, stages[0], base.tree_sha, candidateA.tree_sha, 1));
  const patchB = await objects.readCandidatePatch(requestForPatch(ref, manifestDigest, manifest.tasks[1].ref, stages[1], base.tree_sha, candidateB.tree_sha, 2));
  assert.equal(patchA.files[0].path, "server/a.js");
  assert.equal(patchB.files[0].path, "server/b.js");

  const reviewed = objects.readReviewedTask({
    version: 1, repository: "owner/web", delivery_candidate_ref: ref, delivery_manifest_digest: manifestDigest,
    sequence: 1, work_task_ref: copy(manifest.tasks[0].ref), candidate_digest: stages[0].candidate.candidate_digest,
  });
  assert.equal(reviewed.candidate_sha, candidate_a);
  assert.equal(reviewed.source_worktree_path, stages[0].candidate.managed_worktree.canonical_path);

  const fullApplied = await objects.applyPatch(applyRequest(ref, manifestDigest, "delivery_verification", 0, null, base.tree_sha, result.tree_sha, fullPatch));
  assert.equal(fullApplied.result_tree_sha, result.tree_sha);
  const candidateApplied = await objects.applyPatch(applyRequest(ref, manifestDigest, "candidate_verification", 1, manifest.tasks[0].ref, base.tree_sha, candidateA.tree_sha, patchA));
  assert.equal(candidateApplied.result_tree_sha, candidateA.tree_sha);
  const first = await objects.applyPatch(applyRequest(ref, manifestDigest, "composition", 1, manifest.tasks[0].ref, base.tree_sha, null, patchA));
  const final = await objects.applyPatch(applyRequest(ref, manifestDigest, "composition", 2, manifest.tasks[1].ref, first.result_tree_sha, result.tree_sha, patchB));
  assert.equal(final.result_tree_sha, result.tree_sha);
  const proof = await composeDeliveryCandidate(deliveryManifest, objects);
  assert.equal(proof.result.commit_sha, result_sha);
  assert.equal(proof.steps.length, 2);
  assert.equal(git(repository, ["status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(git(repository, ["show-ref"]), refsBefore, "adapter did not move a ref");
  assert.ok(calls.every((entry) => !["checkout", "add", "commit", "reset", "merge", "push", "apply"].includes(entry.args[0])));
  assert.ok(calls.some((entry) => entry.args[0] === "mktree"));
  console.log("  PASS: registered Git adapter derives evidence and composes only unattached tree objects from native SHA-1 commits");

  write(repository, "untracked.txt", "dirty\n");
  await rejectsAdapter(() => objects.readCommit({ version: 1, repository: "owner/web", sha: base_sha }), "delivery_git_commit_dirty");
  fs.unlinkSync(path.join(repository, "untracked.txt"));
  console.log("  PASS: every object operation fails closed when the registered base clone becomes dirty");

  // #1066: Git calls run one at a time on later loop turns, and the handle's
  // deadline stops further calls: an expired handle spawns nothing, and a
  // handle that expires mid-operation refuses the next call and never yields
  // a tree.  The composer surfaces that as the accessor's unavailability.
  assert.throws(() => adapter.repositoryObjectsFor({ version: 1, head_binding: owner, delivery_candidate_ref: ref }),
    (error) => error instanceof DeliveryGitObjectAdapterError && error.code === "invalid_delivery_git_objects_request");
  assert.throws(() => adapter.repositoryObjectsFor({ version: 1, head_binding: owner, delivery_candidate_ref: ref, deadline: 0 }),
    (error) => error instanceof DeliveryGitObjectAdapterError && error.code === "invalid_delivery_git_objects_request");
  const expired = adapter.repositoryObjectsFor({ version: 1, head_binding: owner, delivery_candidate_ref: ref, deadline: Date.now() - 1 });
  const before = calls.length;
  await rejectsAdapter(() => expired.readCommit({ version: 1, repository: "owner/web", sha: base_sha }), "delivery_git_deadline_exceeded");
  await rejectsAdapter(() => expired.applyPatch(applyRequest(ref, manifestDigest, "composition", 1, manifest.tasks[0].ref, base.tree_sha, null, patchA)), "delivery_git_deadline_exceeded");
  assert.equal(calls.length, before, "an expired handle spawns no Git process");
  delay = 25;
  const short = adapter.repositoryObjectsFor({ version: 1, head_binding: owner, delivery_candidate_ref: ref, deadline: Date.now() + 60 });
  await rejectsAdapter(() => short.applyPatch(applyRequest(ref, manifestDigest, "composition", 1, manifest.tasks[0].ref, base.tree_sha, null, patchA)), "delivery_git_deadline_exceeded");
  const spawned = calls.length - before;
  assert.ok(spawned >= 1 && spawned <= 3, `the clone recheck stopped at the deadline after ${spawned} of its 4 calls`);
  assert.ok(!calls.slice(before).some((entry) => entry.args[0] === "mktree"), "no tree object was written after the deadline");
  await rejectsAdapter(() => short.readTree({ version: 1, repository: "owner/web", tree_sha: base.tree_sha }), "delivery_git_deadline_exceeded");
  assert.equal(calls.length, before + spawned, "every later call on the expired handle is refused before spawning");
  const stalled = adapter.repositoryObjectsFor({ version: 1, head_binding: owner, delivery_candidate_ref: ref, deadline: Date.now() + 60 });
  await assert.rejects(() => composeDeliveryCandidate(deliveryManifest, stalled),
    (error) => error instanceof DeliveryComposerError && error.code === "repository_commit_unavailable");
  delay = 0;
  assert.equal(git(repository, ["show-ref"]), refsBefore, "deadline refusals moved no ref");
  console.log("  PASS: the objects handle deadline refuses further Git calls before they spawn, mid-operation and for the composer");
});

// #1065: the reviewed chain the pipeline actually produces.  Candidate B is
// committed on top of candidate A (its base), rewrites the file A changed, and
// the registered result HEAD is exactly that composition.
async function withChainRepository(run, { resultDrift = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-delivery-git-chain-"));
  const repository = path.join(directory, "web");
  try {
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.email", "quadwork@example.test"]);
    git(repository, ["config", "user.name", "QuadWork Test"]);
    git(repository, ["remote", "add", "origin", "git@github.com:owner/web.git"]);
    write(repository, "server/a.js", "module.exports = 'base-a';\n");
    write(repository, "server/b.js", "module.exports = 'base-b';\n");
    const base_sha = commit(repository, "base");

    git(repository, ["checkout", "-b", "candidate-a", base_sha]);
    write(repository, "server/a.js", "module.exports = 'candidate-a';\n");
    const candidate_a = commit(repository, "candidate a");

    git(repository, ["checkout", "-b", "candidate-b", candidate_a]);
    write(repository, "server/a.js", "module.exports = 'candidate-b';\n");
    write(repository, "server/b.js", "module.exports = 'candidate-b';\n");
    const candidate_b = commit(repository, "candidate b");

    // Same content as candidate b, but committed off the root rather than A.
    git(repository, ["checkout", "-b", "candidate-b-off-root", base_sha]);
    write(repository, "server/a.js", "module.exports = 'candidate-b';\n");
    write(repository, "server/b.js", "module.exports = 'candidate-b';\n");
    const candidate_b_off_root = commit(repository, "candidate b off root");

    git(repository, ["checkout", "main"]);
    write(repository, "server/a.js", "module.exports = 'candidate-b';\n");
    if (!resultDrift) write(repository, "server/b.js", "module.exports = 'candidate-b';\n");
    const result_sha = commit(repository, "integrated chain result");
    return await run({ directory, repository, base_sha, candidate_a, candidate_b, candidate_b_off_root, result_sha });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function chainManifest() {
  const a = { repoKey: "web", repo: "Owner/Web", number: 1061, kind: "issue" };
  return freezeBatchManifest(buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "integrated",
    tasks: [
      { task_key: "a", repository_key: "web", work_item: copy(a), goal: "change a", file_boundary: ["server/a.js"], validation: ["node-test"], dependencies: [] },
      { task_key: "b", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1062, kind: "issue" }, goal: "change a and b on top of a", file_boundary: ["server/a.js", "server/b.js"], validation: ["node-test"], dependencies: [{ repository_key: "web", work_item: copy(a), task_key: "a" }] },
    ],
  }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; },
  }), "2026-09-02T08:00:00.000Z");
}
function chainAdapter(repository, deliverySource) {
  const calls = [];
  const adapter = createDeliveryGitObjectAdapter({
    repositories: [{ key: "web", repo: "Owner/Web", working_dir: repository, primary: true }],
    primary_agent_cwds: {}, repository_worktrees: {},
    canonicalize_path(request) { return fs.realpathSync(request.path); },
    run_git(request) {
      calls.push(copy({ args: request.args, input: request.input || null }));
      try {
        return { ok: true, output: execFileSync("git", request.args, {
          cwd: request.cwd, encoding: "utf8", input: request.input, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
        }) };
      } catch {
        return { ok: false, output: "" };
      }
    },
    read_delivery_source(request) {
      assert.equal(request.repository_key, "web");
      return copy(deliverySource);
    },
  });
  return { adapter, calls };
}

await withChainRepository(async ({ repository, base_sha, candidate_a, candidate_b, candidate_b_off_root, result_sha }) => {
  const manifest = chainManifest();
  const stages = [stage(manifest.tasks[0].ref, base_sha, candidate_a, "a"), stage(manifest.tasks[1].ref, candidate_a, candidate_b, "b")];
  const deliverySource = {
    version: 1,
    registered_repository: { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" },
    frozen_batch_manifest: manifest,
    delivery_mode: "integrated",
    cut_id: "cut_delivery_git_chain_01",
    base_sha,
    staged_tasks: stages,
    deferred_exclusions: [],
  };
  const { adapter, calls } = chainAdapter(repository, deliverySource);
  const refsBefore = git(repository, ["show-ref"]);

  const observed = await adapter.readDeliveryEvidence({ version: 1, head_binding: owner, delivery_source: copy(deliverySource) });
  assert.equal(observed.result_sha, result_sha);
  assert.deepEqual(observed.evidence.boundary.paths, ["server/a.js", "server/b.js"], "an overlapping dependent boundary is declared once");

  const ref = {
    version: 1, installation_id, project_id, repository_key: "web", batch_manifest_digest: manifest.manifest_digest,
    delivery_mode: "integrated", base_sha, result_sha, cut_id: deliverySource.cut_id,
  };
  const deliveryManifest = buildDeliveryManifest({
    version: 1, delivery_candidate_ref: ref, frozen_batch_manifest: manifest, staged_tasks: copy(stages), deferred_exclusions: [], evidence: copy(observed.evidence),
  }, { resolveRegisteredRepository() { return copy(deliverySource.registered_repository); } });
  assert.equal(deliveryManifest.staged_tasks[1].candidate.base_sha, candidate_a);
  const objects = adapter.repositoryObjectsFor({ version: 1, head_binding: owner, delivery_candidate_ref: ref, deadline: deadline() });
  const proof = await composeDeliveryCandidate(deliveryManifest, objects);
  assert.equal(proof.result.commit_sha, result_sha);
  assert.deepEqual(proof.steps.map((step) => step.predecessor_handoffs.map((entry) => entry.work_task_ref.task_key)), [[], ["a"]]);
  assert.equal(proof.steps[1].candidate_sha, candidate_b);
  const rewritten = proof.steps[1].changed_files.find((file) => file.path === "server/a.js");
  assert.equal(rewritten.before.blob_sha, proof.steps[0].changed_files[0].after.blob_sha, "B's patch is described against A's blob, not the root blob");
  assert.equal(git(repository, ["status", "--porcelain", "--untracked-files=all"]), "");
  assert.equal(git(repository, ["show-ref"]), refsBefore, "adapter did not move a ref");
  assert.ok(calls.every((entry) => !["checkout", "add", "commit", "reset", "merge", "push", "apply"].includes(entry.args[0])));
  console.log("  PASS: registered Git adapter composes a pipeline-built same-repository dependent chain from native commits");

  // #1065 negative controls against real Git objects.
  const manifestDigest = deliveryManifest.delivery_manifest_digest;
  const base = await objects.readCommit({ version: 1, repository: "owner/web", sha: base_sha });
  const candidateA = await objects.readCommit({ version: 1, repository: "owner/web", sha: candidate_a });
  const candidateB = await objects.readCommit({ version: 1, repository: "owner/web", sha: candidate_b });
  const baseTree = await objects.readTree({ version: 1, repository: "owner/web", tree_sha: base.tree_sha });
  const patchA = await objects.readCandidatePatch(requestForPatch(ref, manifestDigest, manifest.tasks[0].ref, stages[0], base.tree_sha, candidateA.tree_sha, 1));
  const patchB = await objects.readCandidatePatch(requestForPatch(ref, manifestDigest, manifest.tasks[1].ref, stages[1], candidateA.tree_sha, candidateB.tree_sha, 2));
  assert.deepEqual(patchB.files.map((file) => file.path), ["server/a.js", "server/b.js"]);

  // The dependent's patch cannot be requested against the root base.
  await rejectsAdapter(() => objects.readCandidatePatch(requestForPatch(ref, manifestDigest, manifest.tasks[1].ref,
    { candidate: { ...stages[1].candidate, base_sha } }, base.tree_sha, candidateB.tree_sha, 2)), "delivery_git_candidate_patch_stale");

  // A stale `before` blob: B described against the root blob of server/a.js
  // (the pre-#1065 reading) does not apply onto the accumulated tree after A,
  // while B described against A's blob does and yields the pinned result.
  const afterA = await objects.applyPatch(applyRequest(ref, manifestDigest, "composition", 1, manifest.tasks[0].ref, base.tree_sha, null, patchA));
  const stale = {
    ...copy(patchB), base_sha, base_tree_sha: base.tree_sha,
    files: patchB.files.map((file) => file.path === "server/a.js"
      ? { ...copy(file), before: copy(baseTree.entries.find((entry) => entry.path === "server/a.js")) } : copy(file)),
  };
  stale.patch_digest = crypto.createHash("sha256").update(stable({
    version: stale.version, format: stale.format, scope: stale.scope, base_sha: stale.base_sha, result_sha: stale.result_sha,
    base_tree_sha: stale.base_tree_sha, result_tree_sha: stale.result_tree_sha, source_worktree_path: stale.source_worktree_path, files: stale.files,
  }), "utf8").digest("hex");
  await rejectsAdapter(() => objects.applyPatch(applyRequest(ref, manifestDigest, "composition", 2, manifest.tasks[1].ref, afterA.result_tree_sha, null, stale)), "delivery_git_apply_not_clean");
  const composed = await objects.applyPatch(applyRequest(ref, manifestDigest, "composition", 2, manifest.tasks[1].ref, afterA.result_tree_sha, null, patchB));
  assert.equal(composed.result_tree_sha, (await objects.readCommit({ version: 1, repository: "owner/web", sha: result_sha })).tree_sha);

  // The final composed tree stays pinned to the expected result object.
  await rejectsAdapter(() => objects.applyPatch(applyRequest(ref, manifestDigest, "composition", 2, manifest.tasks[1].ref, afterA.result_tree_sha, candidateA.tree_sha, patchB)), "delivery_git_apply_not_clean");

  // A dependent staged on the root base is the state the pipeline can never
  // produce; evidence derivation refuses it before any object is read for it.
  const rootBased = { ...copy(deliverySource), staged_tasks: [copy(stages[0]), stage(manifest.tasks[1].ref, base_sha, candidate_b, "b")] };
  await rejectsAdapter(() => adapter.readDeliveryEvidence({ version: 1, head_binding: owner, delivery_source: rootBased }), "delivery_git_evidence_candidate_invalid");
  // A candidate that claims base A but was not committed on top of A is not
  // the reviewed chain either, even with identical content.
  const offRoot = { ...copy(deliverySource), staged_tasks: [copy(stages[0]), stage(manifest.tasks[1].ref, candidate_a, candidate_b_off_root, "b")] };
  await rejectsAdapter(() => adapter.readDeliveryEvidence({ version: 1, head_binding: owner, delivery_source: offRoot }), "delivery_git_evidence_candidate_invalid");
  assert.equal(git(repository, ["show-ref"]), refsBefore, "negative controls did not move a ref");
  console.log("  PASS: real Git objects refuse a root-based dependent, a stale before blob, and an unpinned final tree");
});

// #1065: a registered result HEAD that is not the chain composition (B's
// server/b.js change is missing) fails closed inside the composer.
await withChainRepository(async ({ repository, base_sha, candidate_a, candidate_b, result_sha }) => {
  const manifest = chainManifest();
  const stages = [stage(manifest.tasks[0].ref, base_sha, candidate_a, "a"), stage(manifest.tasks[1].ref, candidate_a, candidate_b, "b")];
  const deliverySource = {
    version: 1,
    registered_repository: { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" },
    frozen_batch_manifest: manifest, delivery_mode: "integrated", cut_id: "cut_delivery_git_chain_02", base_sha, staged_tasks: stages, deferred_exclusions: [],
  };
  const { adapter } = chainAdapter(repository, deliverySource);
  const observed = await adapter.readDeliveryEvidence({ version: 1, head_binding: owner, delivery_source: copy(deliverySource) });
  assert.equal(observed.result_sha, result_sha);
  const ref = {
    version: 1, installation_id, project_id, repository_key: "web", batch_manifest_digest: manifest.manifest_digest,
    delivery_mode: "integrated", base_sha, result_sha, cut_id: deliverySource.cut_id,
  };
  const deliveryManifest = buildDeliveryManifest({
    version: 1, delivery_candidate_ref: ref, frozen_batch_manifest: manifest, staged_tasks: copy(stages), deferred_exclusions: [], evidence: copy(observed.evidence),
  }, { resolveRegisteredRepository() { return copy(deliverySource.registered_repository); } });
  const objects = adapter.repositoryObjectsFor({ version: 1, head_binding: owner, delivery_candidate_ref: ref, deadline: deadline() });
  await assert.rejects(() => composeDeliveryCandidate(deliveryManifest, objects),
    (error) => error instanceof DeliveryComposerError && error.code === "composition_apply_unavailable");
  console.log("  PASS: a result HEAD that is not the chain composition cannot obtain a composition proof");
}, { resultDrift: true });

{
  const source = fs.readFileSync(path.join(__dirname, "delivery-git-object-adapter.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:child_process|http|https|net|os|fs)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|writeFile|unlinkSync|["'](?:checkout|add|commit|reset|merge|push|pull)["'])/);
  console.log("  PASS: Git-object adapter has no direct process/filesystem or ref/worktree/publication authority");
}
}

let finished = false;
process.on("exit", (code) => { if (!finished && code === 0) { console.error("delivery-git-object-adapter.test.js: did not run to completion"); process.exitCode = 1; } });
main().then(() => { finished = true; console.log("delivery-git-object-adapter.test.js: all assertions passed"); }, (error) => { console.error(error); process.exit(1); });
