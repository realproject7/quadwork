"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const F = require("./__tests__/delivery-executor-fixture");
const C = require("./delivery-execution-contract");
const { createDeliveryExecutor } = require("./delivery-executor");
const { createHeadControlWorkTaskDomain } = require("./head-control-work-task-domain");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskDeliverySource } = require("./work-task-delivery-source");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
const { composeHeadDomain } = require("./head-control-runtime");
const { createHeadControlService } = require("./head-control-service");
const { createHeadControlAuditStore } = require("./head-control-audit-store");
const { createHeadControlHttpService } = require("./head-control-http-service");
const { createDeliveryFinalReviewService } = require("./delivery-final-review-service");
const { issueContractRevision } = require("./issue-contract-revision");
const { deriveCiPolicyIdentity } = require("./ci-evidence-policy");
const policy = { version: 1, mode: "ci-less", evidence_keys: ["unit", "typecheck", "build"] };
const clock = { value: "2026-09-08T08:00:00.000Z" };
const owner = F.owner;
let serial = 0;
function command(action, revision, payload) { const key = `delivery_${++serial}`; return { version: 1, action, binding: owner, expected_revision: revision, correlation_id: key, idempotency_key: key, payload }; }
async function fixture({ prefix = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-delivery-executor-"));
  const repo = F.repositoryFixture(directory), configDir = F.configDirectory();
  const domain = createHeadControlWorkTaskDomain({ binding: owner, config_dir: configDir, fs,
    resolve_registered_identity: (input) => ({ ...input, issue_body_revision: issueContractRevision("Approved complete scope") }), now: () => clock.value });
  domain.initialize();
  const draft = { ...F.copy(repo.source.frozen_batch_manifest), frozen: null, history: [] };
  domain.put_batch_manifest(command("put_batch_manifest", 0, { manifest: draft }));
  domain.freeze_batch_manifest(command("freeze_batch_manifest", 1, null));
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: configDir, fs });
  const readPipeline = () => pipelineStore.readRecoverySnapshot({ installation_id: owner.installation_id, project_id: owner.project_id });
  const rounds = createTaskReviewRoundStore({ rootDir: configDir, fsImpl: fs });
  function apply(kind, fields) {
    const current = readPipeline(), event = { version: 1, kind, event_id: `pipeline_${++serial}`, ...fields };
    return pipelineStore.applyPlan({ expected: { installation_id: owner.installation_id, project_id: owner.project_id, manifest_digest: current.manifest.manifest_digest, pipeline_digest: current.pipeline.pipeline_digest }, plan: planWorkTaskPipelineEvent(current.pipeline, event), terminal_disposition: null });
  }
  function admitStage(stage, suffix = "") {
    const candidate = stage.candidate, ref = candidate.work_task_ref, name = ref.task_key;
    const assignment = `assignment_${name}${suffix}`, reviewRound = `round_${name}${suffix}`;
    apply("assign_build", { work_task_ref: ref, assignment_id: assignment, base_sha: candidate.base_sha });
    apply("record_candidate", { assignment_id: assignment, candidate });
    apply("assign_independent_review", { work_task_ref: ref, review_round_id: reviewRound, candidate_digest: candidate.candidate_digest });
    apply("record_review_verdict", { work_task_ref: ref, review_round_id: reviewRound, candidate_digest: candidate.candidate_digest, verdict: "approved" });
    apply("reconcile_review", { work_task_ref: ref, review_round_id: reviewRound, candidate_digest: candidate.candidate_digest, resolution: "accepted" });
    rounds.openRound({ version: 1, candidate, attempt: stage.terminal_review.review_round_ref.attempt, round: 1, opened_at: "2026-09-04T08:01:00.000Z" }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
    for (const [index, role] of ["re1", "re2"].entries()) {
      const payload = { version: 1, review_round_ref: stage.terminal_review.review_round_ref, receipt_id: stage.terminal_review.receipt_anchors.find((anchor) => anchor.reviewer_role === role).receipt_id, verdict: "approve", findings: [] };
      rounds.submitTrustedReceipt(stage.terminal_review.review_round_ref, candidate.candidate_digest, { ...payload, receipt_digest: C.digest(payload) }, { version: 1, reviewer_role: role, reviewer_generation: 1, received_at: `2026-09-04T08:0${index + 2}:00.000Z` });
    }
  }
  for (const stage of repo.source.staged_tasks) admitStage(stage);
  domain.cut_batch(command("cut_batch", domain.get_pipeline_status(command("get_pipeline_status", null, null)).revision,
    { cut: { tasks: repo.source.staged_tasks.filter((s) => !prefix || s.candidate.work_task_ref.task_key === "a").map((s) => ({ work_task_ref: s.candidate.work_task_ref, candidate_digest: s.candidate.candidate_digest })) } }));
  const sourceReader = createWorkTaskDeliverySource({ config_dir: configDir, fs, read_registered_repository: () => repo.source.registered_repository });
  repo.source = sourceReader.readStagedSource({ version: 1, installation_id: owner.installation_id, project_id: owner.project_id, repository_key: "web" });
  if (prefix) F.git(repo.repository, ["checkout", "-q", "candidate-a"]);
  const chain = F.chain(repo, null, configDir);
  let ref = await F.prepared(chain);
  await chain.compose(ref, "executor_compose", "executor_compose");
  const bare = path.join(directory, "remote.git");
  F.git(directory, ["init", "-q", "--bare", bare]);
  F.git(repo.repository, ["push", "-q", bare, `${repo.base_sha}:refs/heads/main`]);
  const state = { live: true, pulls: [], pushCount: 0, createCount: 0, closeCount: 0, dispatchCount: 0, issues: new Map(), failPush: false, failCreate: false, gateReady: true, failClose: null };
  for (const item of repo.source.frozen_batch_manifest.tasks) state.issues.set(item.ref.work_item.number, { state: "open", body: "Approved complete scope" });
  const object = async (oid) => {
    const [sha, tree, parents = ""] = F.git(repo.repository, ["show", "-s", "--format=%H%n%T%n%P", oid]).split("\n");
    return { sha, tree, parents: parents.split(" ").filter(Boolean) };
  };
  const branch = async (name) => { try { return F.git(directory, ["--git-dir", bare, "rev-parse", "--verify", `refs/heads/${name}`]); } catch { return null; } };
  const remote = {
    validate: async () => "owner/web", branch, base: async () => ({ branch: "main", sha: await branch("main") }), object,
    push: async (name, sha) => { state.pushCount++; F.git(repo.repository, ["push", "-q", `--force-with-lease=refs/heads/${name}:`, bare, `${sha}:refs/heads/${name}`]); if (state.failPush) { state.failPush = false; C.fail("response_lost"); } },
    findPulls: async (branchName) => F.copy(state.pulls.filter((pull) => pull.head_branch === branchName)),
    readPull: async (number) => F.copy(state.pulls.find((p) => p.number === number)),
    createPull: async (plan) => { state.createCount++; const pull = { number: 100 + state.pulls.length, repository: "owner/web", node_id: "PR_test", url: "https://github.com/owner/web/pull/100", head: ref.result_sha, head_branch: plan.branch, base: ref.base_sha, base_branch: "main", body: plan.body, draft: false, state: "OPEN", merged_at: null, merge_sha: null };
      state.pulls.push(pull); if (state.failCreate) { state.failCreate = false; C.fail("response_lost"); } return F.copy(pull); },
    mergedObjects: async (oid) => { F.git(directory, ["--git-dir", bare, "merge-base", "--is-ancestor", oid, "main"]); return { ...await object(oid), target_tip: await branch("main"), reachable: true }; },
    issue: async (number) => ({ number, ...F.copy(state.issues.get(number)) }),
    closeIssue: async (number) => { state.closeCount++; if (state.failClose === number) C.fail("close_unknown"); state.issues.get(number).state = "closed"; },
  };
  let sealedEvidence;
  function executor() {
    return createDeliveryExecutor({ binding: owner, domain, store: chain.store, remote, read_source: (request) => sourceReader.readStagedSource(request),
      is_current: () => state.live, now: () => clock.value, read_scope: () => ({ assignment_digest: "1".repeat(64), policy }),
      observe_review: async () => { state.dispatchCount++; },
      read_merge_gate: async (requestedRef, prNumber) => {
        const snapshot = chain.store.readSnapshot(requestedRef);
        const target = createDeliveryFinalReviewService({ read_candidate_snapshot: () => ({ delivery_candidate_ref: ref, lifecycle: snapshot.lifecycle, delivery_manifest: snapshot.delivery_manifest, composition_proof: snapshot.composition_proof }), read_pr: () => ({ number: prNumber, exact_sha: ref.result_sha, draft: false, mergeable: true }), read_ci_policy: () => policy }).open({ version: 1, head_binding: owner, delivery_candidate_ref: ref, pr_number: prNumber });
        sealedEvidence = { ready: state.gateReady, target, cycle_id: "cycle_test", policy, verification: { identity: { exact_sha: ref.result_sha, base_sha: ref.base_sha, policy_digest: deriveCiPolicyIdentity(policy).policy_digest }, results: ["unit", "typecheck", "build"].map((name) => ({ name, exit_code: 0 })), verification: { environment: "disposable-test", scope: "entire-candidate" } }, reviews: Object.fromEntries(["re1", "re2"].map((role, i) => [role, { reviewer_role: role, review_id: String(i + 1), verdict: "approved", submitted_at: "2026-09-08T07:00:00.000Z", target_identity_digest: target.target_identity_digest }])) };
        return sealedEvidence;
      },
      revalidate_sealed_reviews: async (evidence) => { assert.equal(evidence.verification.results.length, 3); },
      read_pipeline: readPipeline, record_delivery: (input) => pipelineStore.recordDelivery(input),
    });
  }
  const exec = executor();
  const revision = () => domain.get_pipeline_status(command("get_pipeline_status", null, null)).revision;
  const invoke = (action, payload) => command(action, revision(), { delivery_candidate_ref: ref, ...payload });
  const candidateRevision = () => chain.store.readSnapshot(ref).revision;
  async function form() {
    return exec.execute(invoke("form_delivery", { classification: "ordinary", release_intent: "approved ticket scope", rollback_group: "bounded release", isolation_reasons: [], operator_reasons: [] }));
  }
  async function publish() { const formed = await form(); const input = invoke("publish_delivery", { expected_candidate_revision: candidateRevision(), plan_digest: formed.plan.plan_digest }); return { input, result: await exec.execute(input) }; }
  async function seal() { return exec.execute(invoke("inspect_delivery", { expected_candidate_revision: candidateRevision(), phase: "before_merge", judgment: "approved", complete_scope_tasks: [] })); }
  async function merge() {
    const tree = (await object(ref.result_sha)).tree;
    const mergeSha = F.git(repo.repository, ["commit-tree", tree, "-p", ref.base_sha, "-p", ref.result_sha, "-m", "verified merge"]);
    assert.notEqual(mergeSha, ref.result_sha);
    F.git(repo.repository, ["push", "-q", bare, `${mergeSha}:refs/heads/main`]);
    const mergeTime = new Date(Date.parse(clock.value) + 60000).toISOString();
    Object.assign(state.pulls.find((pull) => pull.head === ref.result_sha), { state: "MERGED", merged_at: mergeTime, merge_sha: mergeSha });
    clock.value = new Date(Date.parse(mergeTime) + 60000).toISOString();
    return mergeSha;
  }
  async function successor(mergeSha) {
    const batch = readPipeline().manifest;
    for (const [key, folder] of [["b", "beta"], ["c", "gamma"]]) {
      F.git(repo.repository, ["checkout", "-q", "-B", `successor-${key}`, mergeSha]);
      F.write(repo.repository, `pkg/${folder}/a.js`, `module.exports = 'candidate-${key}';\n`);
      const sha = F.commit(repo.repository, `successor ${key}`);
      const stage = F.stage(batch.tasks.find((entry) => entry.ref.task_key === key).ref, mergeSha, sha, `${key}_next`);
      admitStage(stage, "_next");
    }
    F.git(repo.repository, ["checkout", "-q", "-B", "successor-result", mergeSha]);
    F.write(repo.repository, "pkg/beta/a.js", "module.exports = 'candidate-b';\n");
    F.write(repo.repository, "pkg/gamma/a.js", "module.exports = 'candidate-c';\n");
    F.commit(repo.repository, "successor integrated result");
    const current = readPipeline();
    domain.cut_batch(command("cut_batch", revision(), { cut: { tasks: current.pipeline.tasks.filter((slot) => slot.state === "accepted").map((slot) => ({ work_task_ref: slot.work_task_ref, candidate_digest: slot.candidate.candidate_digest })) } }));
    repo.source = sourceReader.readStagedSource({ version: 1, installation_id: owner.installation_id, project_id: owner.project_id, repository_key: "web" });
    ref = await F.prepared(chain); await chain.compose(ref, "successor_compose", "successor_compose");
    return ref;
  }
  return { get ref() { return ref; }, successor, state, exec, executor, chain, domain, readPipeline, invoke, candidateRevision, form, publish, seal, merge, remote,
    evidence: () => sealedEvidence, close() { chain.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
async function main() {
  {
    const f = await fixture();
    try {
      const form = await f.form();
      assert.equal(f.readPipeline().pipeline.tasks.length, 3); assert.equal(form.plan.work_items.length, 2);
      const input = f.invoke("publish_delivery", { expected_candidate_revision: f.candidateRevision(), plan_digest: form.plan.plan_digest });
      f.state.failPush = true;
      await assert.rejects(() => f.exec.execute(input), (e) => e.code === "response_lost");
      const published = await f.executor().execute(input);
      assert.equal(published.pr_number, 100); assert.equal(f.state.pushCount, 1); assert.equal(f.state.createCount, 1);
      assert.deepEqual(await f.executor().execute(input), published);
      const different = { ...F.copy(input), payload: { ...input.payload, plan_digest: "e".repeat(64) } };
      await assert.rejects(() => f.executor().execute(different), (e) => e.code === "delivery_idempotency_collision");
      f.state.gateReady = false;
      await assert.rejects(() => f.seal(), (e) => e.code === "delivery_merge_gate_pending");
      f.state.gateReady = true; await f.seal();
      const mergeSha = await f.merge();
      // Mutable upstream evidence cannot rewrite the candidate's sealed copy.
      f.evidence().verification.results[0].exit_code = 1;
      const inspected = await f.exec.execute(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: f.readPipeline().manifest.tasks.map((t) => t.ref) }));
      assert.equal(inspected.merge_sha, mergeSha);
      {
        const complete = f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: inspected.inspection_digest });
        const result = await f.exec.execute(complete);
        assert.equal(f.readPipeline().pipeline.tasks.every((s) => s.state === "delivered"), true);
        assert.equal(result.issues.every((item) => item.state === "closed"), true);
        assert.equal(f.state.closeCount, 2);
        assert.deepEqual(await f.executor().execute(complete), result);
      }
      console.log("PASS real Git publication, lost push recovery, identity collision and sealed merge SHA distinct from candidate");
    } finally { f.close(); clock.value = "2026-09-08T08:00:00.000Z"; }
  }
  {
    const f = await fixture();
    try {
      const formed = await f.form();
      const input = f.invoke("publish_delivery", { expected_candidate_revision: f.candidateRevision(), plan_digest: formed.plan.plan_digest });
      f.state.failCreate = true;
      await assert.rejects(() => f.exec.execute(input), (e) => e.code === "response_lost");
      await f.executor().execute(input);
      assert.equal(f.state.createCount, 1); assert.equal(f.state.pushCount, 1);
      await f.merge();
      await assert.rejects(() => f.exec.execute(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: [] })), (e) => e.code === "merged_unverified");
      assert.equal(f.state.closeCount, 0);
      console.log("PASS lost PR response reuses one PR; a merge without a premerge seal cannot complete");
    } finally { f.close(); clock.value = "2026-09-08T08:00:00.000Z"; }
  }
  {
    const f = await fixture();
    try {
      await f.publish(); await f.seal(); await f.merge();
      const inspected = await f.exec.execute(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: f.readPipeline().manifest.tasks.map((t) => t.ref) }));
      const complete = f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: inspected.inspection_digest });
      f.state.failClose = 1062;
      await assert.rejects(() => f.exec.execute(complete), (e) => e.code === "close_unknown");
      assert.equal(f.state.issues.get(1061).state, "closed"); assert.equal(f.state.issues.get(1062).state, "open");
      assert.equal(f.readPipeline().pipeline.tasks.every((s) => s.state === "delivered"), true);
      f.state.failClose = null;
      await f.executor().execute(complete);
      assert.equal(f.state.closeCount, 3, "the closed first issue was not rewritten on recovery");
      console.log("PASS partial closure survives restart with task mapping intact and one close per completed issue");
    } finally { f.close(); clock.value = "2026-09-08T08:00:00.000Z"; }
  }
  {
    const f = await fixture();
    try {
      const form = await f.form();
      const push = f.remote.push; f.remote.push = async (...args) => { await push(...args); f.state.live = false; };
      await assert.rejects(() => f.exec.execute(f.invoke("publish_delivery", { expected_candidate_revision: f.candidateRevision(), plan_digest: form.plan.plan_digest })), (e) => e.code === "delivery_admission_changed");
      assert.equal(f.state.createCount, 0);
      const op = f.chain.store.readSnapshot(f.ref).delivery.operations.at(-1);
      assert.equal(op.checkpoint.branch_sha, f.ref.result_sha);
      console.log("PASS archive after push records the factual branch and blocks the next remote mutation");
    } finally { f.close(); }
  }
  {
    const f = await fixture({ prefix: true });
    try {
      await f.publish(); await f.seal(); const firstMerge = await f.merge();
      const firstRef = f.ref;
      const firstInspection = await f.exec.execute(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: f.readPipeline().manifest.tasks.filter((t) => t.ref.task_key === "a").map((t) => t.ref) }));
      const firstDone = await f.exec.execute(f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: firstInspection.inspection_digest }));
      assert.equal(firstDone.issues[0].state, "open"); assert.equal(f.state.closeCount, 0);
      assert.equal(f.readPipeline().pipeline.repository_bases[0].base_sha, firstMerge);
      await f.successor(firstMerge);
      assert.equal(f.ref.base_sha, firstMerge); assert.notEqual(f.ref.base_sha, firstRef.result_sha);
      await f.publish(); await f.seal(); const secondMerge = await f.merge();
      assert.notEqual(secondMerge, f.ref.result_sha);
      const secondInspection = await f.exec.execute(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: f.readPipeline().manifest.tasks.map((t) => t.ref) }));
      const secondDone = await f.exec.execute(f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: secondInspection.inspection_digest }));
      assert.equal(secondDone.issues.every((r) => r.state === "closed"), true); assert.equal(f.state.closeCount, 2);
      assert.equal(f.state.pushCount, 2); assert.equal(f.state.createCount, 2);
      console.log("PASS real Git safe cut A→B: actual merge bases, partial ticket remains open, final required tasks close it once");
    } finally { f.close(); clock.value = "2026-09-08T08:00:00.000Z"; }
  }
  {
    const f = await fixture();
    try {
      const controls = { read_project_status: async () => ({}), read_review_handoff: async () => ({}), project_monitor: async () => ({}), recover_worker: async () => ({}) };
      const service = createHeadControlService({ binding: owner, domain: composeHeadDomain(owner, f.domain, controls, f.exec), audit_store: createHeadControlAuditStore({ config_dir: f.chain.config_dir, fs }) });
      const http = createHeadControlHttpService({ authenticateToken: (auth) => auth.token === "head-test" ? { project_id: owner.project_id, actor: "head", generation: owner.generation } : null,
        resolveLaunchBinding: () => ({ installation_id: owner.installation_id, project_id: owner.project_id, actor: "head", generation: owner.generation, active: true, archived: !f.state.live }), resolveHeadControlService: () => service });
      const input = f.invoke("form_delivery", { classification: "ordinary", release_intent: "bounded scope", rollback_group: "one release", isolation_reasons: [], operator_reasons: [] });
      const request = { method: "POST", path: "/api/head-control", body: { version: 1, binding: { project_id: owner.project_id, actor: "head", generation: owner.generation }, request: { tool: "form_delivery", arguments: { expected_revision: input.expected_revision, correlation_id: input.correlation_id, idempotency_key: input.idempotency_key, delivery: input.payload } } } };
      const denied = await http.handle(request, { token: "dev-test" }); assert.equal(denied.ok, false);
      const accepted = await http.handle(request, { token: "head-test" });
      assert.equal(accepted.ok, true, JSON.stringify(accepted)); assert.equal(accepted.result.detail.action, "form_delivery");
      const restarted = createHeadControlService({ binding: owner, domain: composeHeadDomain(owner, f.domain, controls, f.executor()), audit_store: createHeadControlAuditStore({ config_dir: f.chain.config_dir, fs }) });
      const { binding: ignoredBinding, ...rest } = input;
      const replayed = await restarted.execute({ ...rest, principal: owner });
      assert.equal(replayed.decision.kind, "replayed");
      const publication = f.invoke("publish_delivery", { expected_candidate_revision: f.candidateRevision(), plan_digest: accepted.result.detail.plan.plan_digest });
      const publicationRequest = F.copy(request);
      publicationRequest.body.request = { tool: "publish_delivery", arguments: { expected_revision: publication.expected_revision, correlation_id: publication.correlation_id, idempotency_key: publication.idempotency_key, delivery: publication.payload } };
      f.state.failCreate = true;
      const lost = await http.handle(publicationRequest, { token: "head-test" });
      assert.equal(lost.result.decision.kind, "denied");
      f.state.live = false;
      assert.equal((await http.handle(publicationRequest, { token: "head-test" })).ok, false);
      f.state.live = true;
      const changed = F.copy(publicationRequest); changed.body.request.arguments.delivery.plan_digest = "9".repeat(64);
      assert.equal((await http.handle(changed, { token: "head-test" })).ok, false);
      const recovered = await http.handle(publicationRequest, { token: "head-test" });
      assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(recovered.result.decision.code, "head_control_delivery_reconciled");
      assert.equal(f.state.pushCount, 1); assert.equal(f.state.createCount, 1);
      const audit = service.recentAudit();
      assert.equal(audit.find((r) => r.idempotency_key === publication.idempotency_key).decision, "denied");
      assert.equal(audit.filter((r) => r.code === "head_control_delivery_reconciled").length, 1);
      assert.equal((await http.handle(publicationRequest, { token: "head-test" })).result.decision.kind, "replayed");
      console.log("PASS authenticated Head HTTP formation, immutable failed audit and exact lost-response reconciliation");
    } finally { f.close(); }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
