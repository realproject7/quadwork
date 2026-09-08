"use strict";
const assert = require("node:assert/strict");
const { fixture, F, C, clock, owner, command, composeHeadDomain, createHeadControlService, createHeadControlAuditStore, createHeadControlHttpService } = require("./__tests__/delivery-execution-fixture");
async function main() {
  {
    const f = await fixture();
    try {
      await assert.rejects(() => f.exec.plan(f.ref), (e) => e.code === "delivery_formation_required");
      const declaration = { classification: "ordinary", release_intent: "approved ticket scope", rollback_group: "bounded release", isolation_reasons: [], operator_reasons: [] };
      await assert.rejects(() => f.exec.execute(f.invoke("form_delivery", { ...declaration, classification: "operator_gated" })), (e) => e.code === "operator_gate_required");
      f.state.issues.get(1061).operator_hold = true;
      await assert.rejects(() => f.form(), (e) => e.code === "operator_gate_required");
      f.state.issues.get(1061).operator_hold = false;
      await assert.rejects(() => f.exec.execute(f.invoke("form_delivery", { ...declaration, isolation_reasons: ["schema_migration"] })), (e) => e.code === "delivery_isolation_required");
      const formed = await f.form();
      f.state.issues.get(1061).body = "Scope changed";
      await assert.rejects(() => f.exec.plan(f.ref), (e) => e.code === "delivery_issue_revision_changed");
      f.state.issues.get(1061).body = "Approved complete scope";
      f.state.scope.assignment_digest = "2".repeat(64);
      await assert.rejects(() => f.exec.plan(f.ref), (e) => e.code === "delivery_formation_stale");
      f.state.scope.assignment_digest = "1".repeat(64);
      const base = f.remote.base; f.remote.base = async () => ({ branch: "main", sha: "8".repeat(40) });
      await assert.rejects(() => f.exec.plan(f.ref), (e) => e.code === "delivery_base_drift"); f.remote.base = base;
      assert.equal(f.state.pushCount, 0); assert.equal(f.state.createCount, 0);
      const input = f.invoke("publish_delivery", { expected_candidate_revision: f.candidateRevision(), plan_digest: formed.plan.plan_digest });
      f.domain.record_delivery_intent(input);
      const other = F.copy(input); other.payload.delivery_candidate_ref.cut_id = "different_cut";
      assert.throws(() => f.domain.record_delivery_intent(other), (e) => e.code === "head_control_delivery_identity_collision");
      await f.exec.execute(input);
      const origin = f.chain.store.readSnapshot(f.ref).delivery.publication;
      const oldExecutor = f.exec;
      f.adoptGeneration();
      await assert.rejects(() => oldExecutor.replay(input), (e) => e.code === "delivery_admission_changed");
      await assert.rejects(() => f.exec.plan(f.ref), (e) => e.code === "delivery_formation_stale");
      const adopted = await f.form();
      assert.equal(adopted.plan.plan_digest, origin.plan.plan_digest);
      await f.exec.execute(f.invoke("publish_delivery", { expected_candidate_revision: f.candidateRevision(), plan_digest: adopted.plan.plan_digest }));
      assert.deepEqual(f.chain.store.readSnapshot(f.ref).delivery.publication, origin, "republication preserves immutable origin");
      assert.equal(f.state.pushCount, 1); assert.equal(f.state.createCount, 1);
      await f.seal(); const merged = await f.merge(); const target = await f.advanceTarget(merged);
      assert.notEqual(target, merged);
      const mergedObjects = f.remote.mergedObjects;
      for (const change of [{ tree: "a".repeat(40) }, { parents: ["b".repeat(40)] }, { reachable: false }]) {
        f.remote.mergedObjects = async (...args) => ({ ...await mergedObjects(...args), ...change });
        await assert.rejects(() => f.exec.execute(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: [] })), (e) => e.code === "merged_unverified" && e.facts.merge_sha === merged);
      }
      f.remote.mergedObjects = mergedObjects;
      const partial = await f.exec.execute(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: [] }));
      const incomplete = await f.exec.execute(f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: partial.inspection_digest }));
      assert.equal(incomplete.issues.every((r) => r.reason === "full_scope_attestation_required"), true); assert.equal(f.state.closeCount, 0);
      const full = await f.exec.execute(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: f.readPipeline().manifest.tasks.map((t) => t.ref) }));
      await f.exec.execute(f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: full.inspection_digest }));
      assert.equal(f.state.closeCount, 2);
      console.log("PASS formation/gate/base/collision refusals, fresh Head adoption, immutable publication, real later target, merge integrity and complete-scope inspection");
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
