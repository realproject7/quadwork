"use strict";

// Actual local Git commits/trees plus the real durable pipeline, released
// independent review, source, adapter and composer. No GitHub operation runs.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { buildBatchManifest, freezeBatchManifest, workTaskKey } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent, assertWorkTaskPipeline } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskIndependentReviewService } = require("./work-task-independent-review-service");
const { createWorkTaskReviewReconciliationService } = require("./work-task-review-reconciliation-service");
const { createWorkTaskDeliverySource } = require("./work-task-delivery-source");
const { createDeliveryGitObjectAdapter } = require("./delivery-git-object-adapter");
const { runDeliveryGit } = require("./delivery-git-runner");
const { buildDeliveryManifest, assertDeliveryManifest } = require("./delivery-candidate");
const { composeDeliveryCandidate } = require("./delivery-composer");
const { deriveDeliveryReviewTarget } = require("./delivery-review-target");
const { projectWorkTaskBatch } = require("./work-task-projection");

const installation_id = "installation_delivery_continue_01", project_id = "quadwork";
const owner = { installation_id, project_id };
const head = { ...owner, role: "head", generation: 1 };
const copy = (value) => JSON.parse(JSON.stringify(value));
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => crypto.createHash("sha256").update(stable(value)).digest("hex");
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
function write(root, file, text) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
function commit(root, text) { git(root, ["add", "."]); git(root, ["commit", "-m", text]); return git(root, ["rev-parse", "HEAD"]); }
const item = (number) => ({ repoKey: "web", repo: "Owner/Web", number, kind: "issue" });
const task = (key, number, dependencies = []) => ({ task_key: key, repository_key: "web", work_item: item(number), goal: `implement ${key}`,
  file_boundary: [`server/${key}.js`], validation: ["node-test"], dependencies });

async function fixture(tasks, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-delivery-continuation-"));
  const repository = path.join(directory, "repo"), config = path.join(directory, "config");
  fs.mkdirSync(repository); fs.mkdirSync(config);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "QuadWork Fixture"]);
  git(repository, ["config", "user.email", "quadwork@example.test"]);
  // Registered identity metadata only: every Git operation below is local.
  git(repository, ["remote", "add", "origin", "git@github.com:owner/web.git"]);
  write(repository, "README.md", "base\n");
  const originalBase = commit(repository, "base");
  git(repository, ["branch", "target", originalBase]);
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, ...owner, delivery_mode: "integrated", tasks }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "d".repeat(64) }; },
  }), "2026-09-08T08:00:00Z");
  const store = createWorkTaskPipelineStore({ config_dir: config, fs });
  store.initialize({ expected: { ...owner, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline: buildWorkTaskPipeline(manifest) });
  const review = createWorkTaskIndependentReviewService({ config_dir: config, fs });
  const reconcile = createWorkTaskReviewReconciliationService({ config_dir: config, fs });
  const read = () => store.readRecoverySnapshot(owner);
  let serial = 0;
  function event(kind, fields) {
    const state = read(), event_id = `event_${++serial}_${kind}`;
    return store.applyPlan({ expected: { ...owner, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest },
      plan: planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind, event_id, ...fields }),
      terminal_disposition: kind === "integrated_cut" ? { kind, event_id } : null });
  }
  function assign(ref, base) {
    const assignment_id = `assignment_${++serial}`;
    event("assign_build", { work_task_ref: ref, assignment_id, base_sha: base });
    return assignment_id;
  }
  function localCandidate(ref, base, suffix, contents = `${suffix}\n`) {
    const location = path.join(directory, `worktree-${suffix}`), branch = `candidate-${suffix}`;
    git(repository, ["worktree", "add", "-b", branch, location, base]);
    write(location, `server/${ref.task_key}.js`, contents);
    const candidate_sha = commit(location, `candidate ${suffix}`), worktree_id = `wt_${suffix}`;
    const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: ref, base_sha: base, candidate_sha, branch,
      worktree: { repository_key: "web", worktree_id, path: location } }, {
      canonicalizePath(input) { return { version: 1, canonical_path: fs.realpathSync(input.path) }; },
      inspectManagedWorktree(input) {
        git(location, ["merge-base", "--is-ancestor", base, "HEAD"]);
        return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id,
          canonical_path: fs.realpathSync(location), branch: git(location, ["branch", "--show-current"]), base_sha: base,
          head_sha: git(location, ["rev-parse", "HEAD"]), dirty: git(location, ["status", "--porcelain"]).length > 0, occupancy: "vacant" };
      },
      readCanonicalInstalledState() { return { version: 1, ...owner, v1_state: "present" }; },
    });
    return { candidate, location };
  }
  function accept(ref, base, suffix, assignment = null) {
    const assignment_id = assignment || assign(ref, base);
    const local = localCandidate(ref, base, suffix);
    event("record_candidate", { assignment_id, candidate: local.candidate });
    const round = review.openIndependentReview({ version: 1, event_id: `open_${suffix}`, work_task_ref: ref,
      attempt: `attempt_${suffix}`, round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }], opened_at: "2026-09-08T08:01:00.000Z" });
    for (const reviewer_role of ["re1", "re2"]) {
      const payload = { version: 1, review_round_ref: copy(round.review_round_ref), receipt_id: `receipt_${reviewer_role}_${suffix}`, verdict: "approve", findings: [] };
      review.submitTrustedReceipt({ version: 1, review_round_ref: round.review_round_ref, candidate_digest: round.candidate_digest,
        receipt: { ...payload, receipt_digest: digest(payload) } },
      { version: 1, reviewer_role, reviewer_generation: 1, received_at: "2026-09-08T08:02:00.000Z" });
    }
    reconcile.reconcileReleasedReview({ version: 1, work_task_ref: ref, review_round_ref: round.review_round_ref, candidate_digest: round.candidate_digest });
    return local;
  }
  function cut(candidates) { return event("integrated_cut", { tasks: candidates.map((candidate) => ({ work_task_ref: candidate.work_task_ref, candidate_digest: candidate.candidate_digest })) }); }
  const registered = { version: 1, ...owner, repository_key: "web", repository: "Owner/Web" };
  const source = createWorkTaskDeliverySource({ config_dir: config, fs, read_registered_repository() { return registered; } });
  const readSource = () => source.readStagedSource({ version: 1, ...owner, repository_key: "web" });
  const adapter = createDeliveryGitObjectAdapter({ repositories: [{ key: "web", repo: "Owner/Web", working_dir: repository, primary: true }],
    primary_agent_cwds: {}, repository_worktrees: {}, canonicalize_path(input) { return fs.realpathSync(input.path); },
    run_git: runDeliveryGit, read_delivery_source: readSource });
  async function compose(result) {
    git(repository, ["checkout", "main"]);
    git(repository, ["reset", "--hard", result]);
    const current = readSource();
    const observed = await adapter.readDeliveryEvidence({ version: 1, head_binding: head, delivery_source: current });
    const ref = { version: 1, ...owner, repository_key: "web", batch_manifest_digest: manifest.manifest_digest,
      delivery_mode: "integrated", base_sha: current.base_sha, result_sha: result, cut_id: current.cut_id };
    const deliveryManifest = buildDeliveryManifest({ version: 1, delivery_candidate_ref: ref, frozen_batch_manifest: manifest,
      staged_tasks: current.staged_tasks, deferred_exclusions: current.deferred_exclusions, evidence: observed.evidence },
    { resolveRegisteredRepository() { return registered; } });
    const proof = await composeDeliveryCandidate(deliveryManifest,
      adapter.repositoryObjectsFor({ version: 1, head_binding: head, delivery_candidate_ref: ref, deadline: Date.now() + 30000 }));
    return { manifest: deliveryManifest, proof, ref };
  }
  function merged(composed, strategy) {
    git(repository, ["checkout", "target"]);
    if (strategy === "squash") { git(repository, ["merge", "--squash", composed.ref.result_sha]); commit(repository, `squash ${composed.ref.cut_id}`); }
    else git(repository, ["merge", "--no-ff", "-m", `merge ${composed.ref.cut_id}`, composed.ref.result_sha]);
    const merge_sha = git(repository, ["rev-parse", "HEAD"]), merge_tree = git(repository, ["rev-parse", "HEAD^{tree}"]);
    const result_tree = git(repository, ["rev-parse", `${composed.ref.result_sha}^{tree}`]);
    assert.notEqual(merge_sha, composed.ref.result_sha);
    assert.equal(merge_tree, result_tree);
    assert.equal(git(repository, ["rev-parse", "HEAD^1"]), composed.ref.base_sha);
    const delivery = { version: 1, receipt_digest: digest({ ref: composed.ref, merge_sha, result_tree }), candidate_ref: composed.ref,
      manifest_digest: composed.manifest.delivery_manifest_digest, base_sha: composed.ref.base_sha, result_sha: composed.ref.result_sha,
      result_tree, merge_sha, merge_tree, work_task_refs: composed.manifest.staged_tasks.map((stage) => stage.work_task_ref) };
    const state = read();
    return { expected: { ...owner, manifest_digest: manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, delivery };
  }
  try { await run({ directory, config, repository, originalBase, manifest, store, read, event, assign, accept, cut, readSource, compose, merged }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function main() {
await fixture([task("alpha", 42), task("bravo", 42, [{ repository_key: "web", work_item: item(42), task_key: "alpha" }])], async (f) => {
  const [a, b] = f.manifest.tasks.map((entry) => entry.ref);
  const alpha = f.accept(a, f.originalBase, "alpha");
  f.cut([alpha.candidate]);
  const composedA = await f.compose(alpha.candidate.candidate_sha);
  assert.equal(composedA.manifest.deferred_exclusions[0].reason, "safe_cut_deferred");
  const inFlight = f.assign(b, alpha.candidate.candidate_sha);
  const completedA = f.merged(composedA, "squash");
  assert.throws(() => f.store.recordDelivery(completedA), { code: "work_task_delivery_active_authority" });
  const oldBravo = f.accept(b, alpha.candidate.candidate_sha, "bravo_old", inFlight);
  completedA.expected.pipeline_digest = f.read().pipeline.pipeline_digest;
  // Process death after the single atomic mapping/base commit: restart uses
  // the old intent and must observe, rather than repeat, the exact completion.
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const { createWorkTaskPipelineStore } = require(${JSON.stringify(require.resolve("./work-task-pipeline-store"))});
    createWorkTaskPipelineStore({config_dir:process.argv[1],fs}).recordDelivery(JSON.parse(process.argv[2]));
    process.exit(19);
  `, f.config, JSON.stringify(completedA)], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 19, child.stderr);
  const stateA = f.store.recordDelivery(completedA);
  assert.equal(stateA.pipeline.tasks[0].state, "delivered");
  assert.equal(stateA.pipeline.tasks[1].state, "queued");
  assert.equal(stateA.pipeline.tasks[1].candidate, null);
  assert.equal(stateA.pipeline.tasks[1].invalidated_candidate.candidate_digest, oldBravo.candidate.candidate_digest);
  assert(fs.existsSync(oldBravo.location), "old candidate worktree survives invalidation");
  assert.equal(stateA.pipeline.repository_bases[0].base_sha, completedA.delivery.merge_sha);
  assert.deepEqual(stateA.manifest, f.manifest, "the partial cut retains full ticket membership");
  assert.deepEqual(projectWorkTaskBatch({ version: 1, manifest: f.manifest, pipeline: stateA.pipeline }).repositories[0].work_items[0].tasks.map((entry) => entry.state), ["delivered", "queued"]);
  const collision = copy(completedA); collision.delivery.manifest_digest = "f".repeat(64);
  assert.throws(() => f.store.recordDelivery(collision), { code: "work_task_delivery_receipt_collision" });
  assert.throws(() => f.assign(b, alpha.candidate.candidate_sha), { code: "work_task_assigned_base_mismatch" });
  assert.throws(() => f.event("replace_candidate", { candidate: oldBravo.candidate }), { code: "invalid_work_task_pipeline_state" });
  for (const kind of ["record_delivery", "advance_delivery_base"]) {
    assert.throws(() => planWorkTaskPipelineEvent(stateA.pipeline, { version: 1, kind, event_id: "forged_event", delivery: completedA.delivery }), { code: "invalid_work_task_pipeline_event" });
  }
  const bravo = f.accept(b, completedA.delivery.merge_sha, "bravo_fresh");
  f.cut([bravo.candidate]);
  const sourceB = f.readSource();
  assert.deepEqual(sourceB.staged_tasks.map((stage) => stage.candidate.work_task_ref.task_key), ["bravo"]);
  assert.equal(sourceB.deferred_exclusions[0].delivery.receipt_digest, completedA.delivery.receipt_digest);
  const composedB = await f.compose(bravo.candidate.candidate_sha);
  assert.equal(composedB.proof.steps.length, 1);
  assert.deepEqual(composedB.proof.steps[0].predecessor_handoffs, [], "A's patch is not replayed in B's composition");
  const broken = copy(composedB.manifest);
  delete broken.deferred_exclusions[0].delivery;
  assert.throws(() => assertDeliveryManifest(broken));
  const completedB = f.merged(composedB, "merge");
  const final = f.store.recordDelivery(completedB);
  assert.deepEqual(final.pipeline.tasks.map((slot) => slot.state), ["delivered", "delivered"]);
  assert.equal(final.pipeline.repository_bases[0].base_sha, completedB.delivery.merge_sha);
  assert.deepEqual(final.pipeline.deliveries.map((record) => record.merge_sha), [completedA.delivery.merge_sha, completedB.delivery.merge_sha]);
  assert.equal(f.store.recordDelivery(completedA).pipeline.pipeline_digest, final.pipeline.pipeline_digest, "earlier immutable retry returns current durable facts");
  assert.deepEqual(final.manifest, f.manifest);
  assert.throws(() => f.readSource(), { code: "work_task_delivery_staging_incomplete" });
  const forged = copy(final.pipeline); forged.tasks[1].state = "accepted";
  assert.throws(() => assertWorkTaskPipeline(forged));
  console.log("  PASS: real squash A and merge B advance by actual merge SHA, preserve ticket coverage, reject stale authority and recover after process death");
});

await fixture([task("alpha", 42), task("bravo", 42), task("charlie", 43)], async (f) => {
  const locals = f.manifest.tasks.map((entry, index) => f.accept(entry.ref, f.originalBase, `peer_${index}`));
  f.cut(locals.map((local) => local.candidate));
  for (const local of locals) git(f.repository, ["cherry-pick", local.candidate.candidate_sha]);
  const result = git(f.repository, ["rev-parse", "HEAD"]);
  const composed = await f.compose(result);
  assert.equal(composed.manifest.staged_tasks.length, 3);
  const target = deriveDeliveryReviewTarget({ delivery_manifest: composed.manifest,
    pr: { number: 8, exact_sha: result, draft: false, mergeable: true }, ci_policy: null });
  assert.deepEqual(target.identity.work_items.map((entry) => entry.number), [42, 43]);
  const completed = f.merged(composed, "squash");
  const final = f.store.recordDelivery(completed);
  assert.deepEqual(final.pipeline.tasks.map((slot) => slot.state), ["delivered", "delivered", "delivered"]);
  assert.equal(final.pipeline.deliveries.length, 1);
  console.log("  PASS: three actual task candidates from two tickets compose once with stable final-review WorkItem dedup");
});
console.log("work-task-delivery-pipeline.test.js: all assertions passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
