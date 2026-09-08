"use strict";

const { deliveryCandidateKey } = require("./delivery-candidate");
const { createDeliveryPublicationPlanService } = require("./delivery-publication-plan");
const { workTaskKey } = require("./work-task-manifest");
const { issueContractRevision } = require("./issue-contract-revision");
const { normalizeCiPolicy, deriveCiPolicyIdentity } = require("./ci-evidence-policy");
const C = require("./delivery-execution-contract");
const same = (a, b) => C.stable(a) === C.stable(b);
const uniqueItems = (manifest) => [...new Map(manifest.staged_tasks.map((s) => [C.digest(s.work_item), s.work_item])).values()];

function createDeliveryExecutor(deps) {
  const { binding, domain, store, remote } = deps;
  function guard() { if (!deps.is_current(binding)) C.fail("delivery_admission_changed"); }
  function owned(ref) {
    if (binding.role !== "head" || ref.installation_id !== binding.installation_id || ref.project_id !== binding.project_id) C.fail("delivery_binding_denied");
    guard();
  }
  function composed(ref) {
    const value = store.readSnapshot(ref);
    if (value.lifecycle.status !== "composed") C.fail("delivery_not_composed");
    return value;
  }
  function basePlan(snapshot) {
    return createDeliveryPublicationPlanService({ read_candidate_snapshot: () => ({
      delivery_candidate_ref: snapshot.delivery_candidate_ref, lifecycle: snapshot.lifecycle,
      delivery_manifest: snapshot.delivery_manifest, composition_proof: snapshot.composition_proof,
    }) }).plan({ version: 1, head_binding: binding, delivery_candidate_ref: snapshot.delivery_candidate_ref });
  }
  async function facts(snapshot) {
    const ref = snapshot.delivery_candidate_ref, manifest = snapshot.delivery_manifest;
    const before = domain.delivery_context();
    if (before.state.manifest.manifest_digest !== ref.batch_manifest_digest) C.fail("delivery_batch_changed");
    const source = deps.read_source({ version: 1, installation_id: ref.installation_id, project_id: ref.project_id, repository_key: ref.repository_key });
    if (source.cut_id !== ref.cut_id || source.base_sha !== ref.base_sha || source.registered_repository.repository.toLowerCase() !== manifest.registered_repository.repository.toLowerCase() ||
      !same(source.staged_tasks, manifest.staged_tasks.map((s) => ({ candidate: s.candidate, terminal_review: s.terminal_review }))) ||
      !same(source.deferred_exclusions, manifest.deferred_exclusions)) C.fail("delivery_cut_changed");
    const scopeBefore = deps.read_scope(ref);
    const revisions = [], operatorHolds = [];
    for (const item of uniqueItems(manifest)) {
      const issue = await remote.issue(item.number);
      const revision = issueContractRevision(issue.body);
      if (manifest.staged_tasks.filter((s) => s.work_item.number === item.number).some((s) => s.work_task_ref.issue_body_revision !== revision)) C.fail("delivery_issue_revision_changed");
      revisions.push({ work_item: item, issue_body_revision: revision });
      if (issue.operator_hold === true || /<!--\s*quadwork:operator-gate\s*-->/.test(issue.body)) operatorHolds.push(item);
    }
    guard();
    const after = domain.delivery_context(), scope = deps.read_scope(ref);
    if (after.status.pipeline_digest !== before.status.pipeline_digest || !same(scopeBefore, scope)) C.fail("delivery_scope_changed");
    const policy = normalizeCiPolicy(scope.policy);
    const object = await remote.object(ref.result_sha);
    if (object.tree !== manifest.evidence.tree.result_tree_sha) C.fail("delivery_composition_changed");
    await remote.object(ref.base_sha);
    return { manifest_digest: ref.batch_manifest_digest, pipeline_digest: before.status.pipeline_digest,
      cut_id: ref.cut_id, delivery_manifest_digest: manifest.delivery_manifest_digest, source_digest: C.digest(source),
      assignment_digest: scope.assignment_digest, policy: deriveCiPolicyIdentity(policy), policy_value: policy,
      task_refs: manifest.staged_tasks.map((s) => s.work_task_ref), task_receipts_digest: C.digest(source.staged_tasks), revisions, operator_holds: operatorHolds };
  }
  async function formation(snapshot) {
    const current = await facts(snapshot);
    const receipt = domain.delivery_context().state.delivery_formation;
    if (!receipt) C.fail("delivery_formation_required");
    C.assertSeal(receipt);
    if (!same(receipt.binding, binding) || !same(receipt.facts, current) || !same(receipt.declaration.delivery_candidate_ref, snapshot.delivery_candidate_ref)) C.fail("delivery_formation_stale");
    if (receipt.declaration.classification !== "ordinary" || current.operator_holds.length || receipt.declaration.operator_reasons.length) C.fail("operator_gate_required");
    if (receipt.declaration.isolation_reasons.length && snapshot.delivery_candidate_ref.delivery_mode !== "isolated") C.fail("delivery_isolation_required");
    return receipt;
  }
  async function plan(ref) {
    owned(ref);
    const snapshot = composed(ref), form = await formation(snapshot);
    await remote.validate(); const base = await remote.base();
    if (base.sha !== ref.base_sha) C.fail("delivery_base_drift");
    const old = basePlan(snapshot);
    const content = { ...old, kind: "delivery_publication_ready", operator_approval_required: false,
      base_branch: base.branch, base_sha: base.sha, formation_digest: form.digest };
    return { ...content, plan_digest: C.digest(content) };
  }
  function readOperation(snapshot, command) {
    const operations = snapshot.delivery?.operations || [];
    const byKey = operations.find((op) => op.idempotency_key === command.idempotency_key);
    const byCorrelation = operations.find((op) => op.correlation_id === command.correlation_id);
    if (!byKey && !byCorrelation) return null;
    if (!byKey || byKey !== byCorrelation || byKey.fingerprint !== C.digest(command)) C.fail("delivery_idempotency_collision");
    return byKey;
  }
  async function execute(command) {
    C.assertPayload(command.action, command.payload);
    if (!same(command.binding, binding)) C.fail("delivery_binding_denied");
    const ref = command.payload.delivery_candidate_ref; owned(ref);
    const deadline = Date.now() + 60000;
    if (remote.setDeadline) remote.setDeadline(deadline);
    return store.withExecution(ref, async () => {
      let snapshot = composed(ref);
      let op = readOperation(snapshot, command);
      if (op) op = C.clone(op);
      if (op?.result) return C.clone(op.result);
      if (!op && command.action !== "form_delivery" && snapshot.revision !== command.payload.expected_candidate_revision) C.fail("delivery_candidate_revision_stale");
      if (!op && domain.delivery_context().status.revision !== command.expected_revision) C.fail("delivery_domain_revision_stale");
      domain.record_delivery_intent(command);
      let delivery = C.clone(snapshot.delivery || C.initialDelivery());
      if (!op) {
        if (delivery.operations.length >= 64) C.fail("delivery_operation_history_full");
        op = { action: command.action, idempotency_key: command.idempotency_key, correlation_id: command.correlation_id,
          fingerprint: C.digest(command), step: "intent", checkpoint: null, result: null, failure: null };
        delivery.operations.push(op);
        snapshot = store.recordDelivery(ref, snapshot.revision, delivery);
      }
      const save = (step) => {
        op.step = step; op.failure = null;
        delivery.operations = delivery.operations.map((entry) => entry.idempotency_key === op.idempotency_key ? C.clone(op) : entry);
        snapshot = store.recordDelivery(ref, snapshot.revision, delivery);
      };
      const done = (result) => { op.result = C.sealed({ version: 1, action: command.action, delivery_candidate_ref: ref, ...result }); save("complete"); return C.clone(op.result); };
      const mutationReady = async (planValue) => {
        guard(); if (Date.now() >= deadline) C.fail("delivery_deadline_exceeded");
        const form = await formation(snapshot);
        if (form.digest !== planValue.formation_digest) C.fail("delivery_formation_stale");
        await remote.validate();
        const base = await remote.base();
        if (base.branch !== planValue.base_branch || base.sha !== ref.base_sha) C.fail("delivery_base_drift");
        guard();
      };
      try {
        if (command.action === "form_delivery") {
          const current = await facts(snapshot);
          if (current.operator_holds.length || command.payload.classification !== "ordinary" || command.payload.operator_reasons.length) C.fail("operator_gate_required");
          if (command.payload.isolation_reasons.length && ref.delivery_mode !== "isolated") C.fail("delivery_isolation_required");
          const form = domain.record_delivery_formation(command, current);
          const result = await plan(ref);
          return done({ formation_digest: form.digest, plan: result, candidate_revision: snapshot.revision + 1 });
        }
        if (command.action === "publish_delivery") {
          if (delivery.publication) {
            if (delivery.publication.plan.plan_digest !== command.payload.plan_digest) C.fail("delivery_plan_changed");
          }
          const currentPlan = await plan(ref);
          if (currentPlan.plan_digest !== command.payload.plan_digest) C.fail("delivery_plan_changed");
          op.checkpoint = C.sealed({ plan: currentPlan, branch_sha: null });
          save("publication_preflight");
          await mutationReady(currentPlan);
          let oid = await remote.branch(currentPlan.branch);
          if (oid !== null && oid !== ref.result_sha) C.fail("delivery_branch_collision");
          if (oid === null) {
            save("push_intent"); await mutationReady(currentPlan);
            await remote.push(currentPlan.branch, ref.result_sha);
          }
          oid = await remote.branch(currentPlan.branch);
          if (oid !== ref.result_sha) C.fail("delivery_branch_readback_failed");
          op.checkpoint = C.sealed({ plan: currentPlan, branch_sha: oid });
          save("branch_observed");
          // Remote effects that completed during archive remain factual history;
          // this guard prevents the next effect, never erases the branch.
          guard();
          const matches = await remote.findPulls(currentPlan.branch);
          if (matches.length > 1) C.fail("delivery_pull_ambiguous");
          let pull = matches[0];
          if (!pull) {
            save("pull_intent"); await mutationReady(currentPlan);
            if (await remote.branch(currentPlan.branch) !== ref.result_sha) C.fail("delivery_branch_collision");
            pull = await remote.createPull(currentPlan);
          }
          pull = await remote.readPull(pull.number);
          assertPull(pull, currentPlan, ref);
          delivery.publication = C.sealed({ version: 1, plan: currentPlan, pull, branch_sha: oid, observed_at: deps.now() });
          save("published"); guard();
          await deps.observe_review(ref, pull.number);
          return done({ publication_digest: delivery.publication.digest, pr_number: pull.number, url: pull.url, candidate_revision: snapshot.revision + 1 });
        }
        if (!delivery.publication) C.fail("delivery_publication_required");
        const publication = delivery.publication;
        if (command.action === "inspect_delivery" && command.payload.phase === "before_merge") {
          await mutationReady(publication.plan);
          assertPull(await remote.readPull(publication.pull.number), publication.plan, ref);
          const evidence = await deps.read_merge_gate(ref, publication.pull.number);
          if (!evidence || evidence.ready !== true || evidence.target.identity.exact_sha !== ref.result_sha || evidence.target.identity.delivery_candidate_ref.base_sha !== ref.base_sha ||
              evidence.target.identity.delivery_manifest_digest !== snapshot.delivery_manifest.delivery_manifest_digest || evidence.target.identity.policy_digest !== publication.plan.policy_digest && publication.plan.policy_digest !== undefined) C.fail("delivery_merge_gate_pending");
          if (!evidence.reviews || Object.keys(evidence.reviews).sort().join(",") !== "re1,re2" || Object.values(evidence.reviews).some((r) => !r || r.verdict !== "approved" || r.target_identity_digest !== evidence.target.target_identity_digest) || evidence.reviews.re1.review_id === evidence.reviews.re2.review_id) C.fail("delivery_merge_reviews_invalid");
          const form = await formation(snapshot);
          if (evidence.target.identity.policy_digest !== form.facts.policy.policy_digest) C.fail("delivery_policy_changed");
          await mutationReady(publication.plan);
          assertPull(await remote.readPull(publication.pull.number), publication.plan, ref);
          const seal = C.sealed({ version: 1, ref, manifest_digest: snapshot.delivery_manifest.delivery_manifest_digest, formation_digest: form.digest,
            publication_digest: publication.digest, base_branch: publication.plan.base_branch, result_tree: snapshot.delivery_manifest.evidence.tree.result_tree_sha,
            evidence: C.clone(evidence), binding, observed_at: deps.now() });
          if (delivery.premerge_seals.length >= 16) C.fail("delivery_seal_history_full");
          delivery.premerge_seals.push(seal);
          return done({ premerge_seal_digest: seal.digest, exact_sha: ref.result_sha, base_sha: ref.base_sha, candidate_revision: snapshot.revision + 1 });
        }
        const merged = await verifyMerged(snapshot, delivery);
        if (command.action === "inspect_delivery") {
          const all = snapshot.delivery_manifest.frozen_batch_manifest.tasks.map((s) => s.ref);
          const requested = command.payload.complete_scope_tasks;
          if (new Set(requested.map(workTaskKey)).size !== requested.length || requested.some((r) => !all.some((x) => same(r, x)))) C.fail("delivery_ticket_scope_invalid");
          delivery.inspection = C.sealed({ version: 1, merge: merged, complete_scope_tasks: requested, judgment: "approved", binding, observed_at: deps.now() });
          return done({ inspection_digest: delivery.inspection.digest, merge_sha: merged.merge_sha, candidate_revision: snapshot.revision + 1 });
        }
        if (!delivery.inspection || delivery.inspection.digest !== command.payload.inspection_digest || delivery.inspection.merge.merge_sha !== merged.merge_sha) C.fail("delivery_inspection_required");
        const manifest = snapshot.delivery_manifest;
        if (!delivery.completion) {
          const pipeline = deps.read_pipeline();
          delivery.completion = C.sealed({ version: 1, inspection_digest: delivery.inspection.digest, merge: merged,
            expected: { installation_id: ref.installation_id, project_id: ref.project_id, manifest_digest: ref.batch_manifest_digest, pipeline_digest: pipeline.pipeline.pipeline_digest },
            inspection: C.clone(delivery.inspection), tasks: manifest.staged_tasks.map((s) => s.work_task_ref), issues: [], pipeline_recorded: false });
          save("completion_intent");
        }
        guard();
        const completion = C.clone(delivery.completion);
        const proof = C.sealed({ version: 1, inspection_digest: completion.inspection_digest, merge: completion.merge, tasks: completion.tasks });
        const pipeline = deps.record_delivery({ expected: completion.expected, delivery: { version: 1, receipt_digest: proof.digest,
          candidate_ref: ref, manifest_digest: manifest.delivery_manifest_digest, base_sha: ref.base_sha, result_sha: ref.result_sha,
          result_tree: manifest.evidence.tree.result_tree_sha, merge_sha: merged.merge_sha, merge_tree: merged.merge_tree, work_task_refs: completion.tasks } });
        completion.pipeline_recorded = true;
        completion.closure_inspection_digest = delivery.inspection.digest;
        delete completion.digest; delivery.completion = C.sealed(completion); save("tasks_delivered");
        for (const item of uniqueItems(manifest)) {
          const required = manifest.frozen_batch_manifest.tasks.filter((t) => same(t.ref.work_item, item)).map((t) => t.ref);
          const existing = completion.issues.find((x) => same(x.work_item, item));
          if (existing?.state === "closed") continue;
          let reason = null;
          if (required.some((r) => !pipeline.pipeline.tasks.some((slot) => same(slot.work_task_ref, r) && slot.state === "delivered"))) reason = "tasks_remaining";
          if (required.some((r) => !delivery.inspection.complete_scope_tasks.some((attested) => same(attested, r)))) reason = "full_scope_attestation_required";
          let record = { work_item: item, state: "open", reason, inspection_digest: delivery.inspection.digest };
          if (!reason) {
            guard();
            const fresh = await remote.issue(item.number);
            if (required.some((r) => r.issue_body_revision !== issueContractRevision(fresh.body))) record.reason = "issue_revision_changed";
            else {
              record.state = "close_intent";
              completion.issues = completion.issues.filter((x) => !same(x.work_item, item)).concat([record]);
              delivery.completion = C.sealed(completion); save("issue_close_intent");
              guard(); await verifyMerged(snapshot, delivery);
              const immediatelyBefore = await remote.issue(item.number);
              if (required.some((r) => r.issue_body_revision !== issueContractRevision(immediatelyBefore.body))) C.fail("delivery_issue_revision_changed");
              guard(); if (immediatelyBefore.state !== "closed") await remote.closeIssue(item.number);
              const readback = await remote.issue(item.number);
              if (readback.state !== "closed" || required.some((r) => r.issue_body_revision !== issueContractRevision(readback.body))) C.fail("delivery_issue_close_unknown");
              record = { work_item: item, state: "closed", reason: null, inspection_digest: delivery.inspection.digest };
            }
          }
          completion.issues = completion.issues.filter((x) => !same(x.work_item, item)).concat([record]);
          delivery.completion = C.sealed(completion); save("issue_observed");
        }
        return done({ completion_digest: delivery.completion.digest, merge_sha: merged.merge_sha, issues: completion.issues, candidate_revision: snapshot.revision + 1 });
      } catch (error) {
        if (error?.code === "merged_unverified" && error.facts) op.checkpoint = C.sealed({ merge_observation: error.facts });
        op.failure = /^[a-z][a-z0-9_]{2,127}$/.test(error?.code || "") ? error.code : "delivery_operation_unknown";
        delivery.operations = delivery.operations.map((entry) => entry.idempotency_key === op.idempotency_key ? C.clone(op) : entry);
        store.recordDelivery(ref, snapshot.revision, delivery);
        throw error;
      }
    }, deadline);
  }
  function unverified(pull, object = null) {
    const error = new C.DeliveryExecutionError("merged_unverified");
    error.facts = { pr_number: pull.number, state: pull.state, original_head: pull.head,
      base_branch: pull.base_branch, merge_sha: pull.merge_sha, merged_at: pull.merged_at,
      merge_tree: object?.tree || null };
    throw error;
  }
  async function verifyMerged(snapshot, delivery) {
    guard();
    const ref = snapshot.delivery_candidate_ref, publication = delivery.publication;
    const pull = await remote.readPull(publication.pull.number);
    const seal = [...delivery.premerge_seals].reverse().find((entry) => Date.parse(entry.observed_at) < Date.parse(pull.merged_at));
    if (!seal || pull.state !== "MERGED" || pull.head !== ref.result_sha || pull.repository !== publication.plan.repository || pull.base_branch !== publication.plan.base_branch || pull.head_branch !== publication.plan.branch) unverified(pull);
    C.assertSeal(seal);
    if (seal.ref.result_sha !== ref.result_sha || seal.ref.base_sha !== ref.base_sha || seal.manifest_digest !== snapshot.delivery_manifest.delivery_manifest_digest || seal.publication_digest !== publication.digest) unverified(pull);
    if (Object.values(seal.evidence.reviews).some((r) => Date.parse(r.submitted_at) > Date.parse(seal.observed_at))) unverified(pull);
    await deps.revalidate_sealed_reviews(seal.evidence, pull);
    const object = await remote.mergedObjects(pull.merge_sha, pull.base_branch);
    if (!object.reachable || object.tree !== seal.result_tree || object.parents[0] !== ref.base_sha ||
        !(object.parents.length === 1 || object.parents.length === 2 && object.parents[1] === ref.result_sha)) unverified(pull, object);
    guard();
    return { version: 1, premerge_seal_digest: seal.digest, pr_number: pull.number, merge_sha: object.sha,
      merge_tree: object.tree, parents: object.parents, merged_at: pull.merged_at, original_head: pull.head, target_tip: object.target_tip };
  }
  async function replay(command) {
    C.assertPayload(command.action, command.payload); if (!same(command.binding, binding)) C.fail("delivery_binding_denied");
    owned(command.payload.delivery_candidate_ref);
    const op = readOperation(composed(command.payload.delivery_candidate_ref), command);
    if (!op?.result) C.fail("delivery_replay_unproven");
    return C.clone(op.result);
  }
  async function resume(command) {
    C.assertPayload(command.action, command.payload);
    if (!same(command.binding, binding)) C.fail("delivery_binding_denied");
    owned(command.payload.delivery_candidate_ref);
    if (!readOperation(composed(command.payload.delivery_candidate_ref), command)) C.fail("delivery_replay_unproven");
    return execute(command);
  }
  return Object.freeze({ execute, plan, replay, resume });
}
function assertPull(pull, plan, ref) {
  if (pull.repository !== plan.repository || pull.head_branch !== plan.branch || pull.base_branch !== plan.base_branch || pull.head !== ref.result_sha || pull.base !== ref.base_sha || pull.draft || pull.state !== "OPEN" ||
      !pull.body.includes(`Delivery manifest: ${plan.delivery_manifest_digest}`) || !pull.body.includes(`Delivery candidate: ${deliveryCandidateKey(ref)}`)) C.fail("delivery_pull_readback_failed");
}
module.exports = { createDeliveryExecutor, assertDeliveryPublishedPull: assertPull };
