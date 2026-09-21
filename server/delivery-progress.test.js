"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fixture, F, C, clock, composeHeadDomain, createHeadControlService, createHeadControlAuditStore, createHeadControlHttpService } = require("./__tests__/delivery-execution-fixture");
function httpFor(f) {
  const owner = f.owner;
  const controls = { read_project_status: async () => ({}), read_review_handoff: async () => ({}), project_monitor: async () => ({}), recover_worker: async () => ({}), begin_ticket_review: async () => ({ applied: false }) };
  const service = createHeadControlService({ binding: owner, domain: composeHeadDomain(owner, f.domain, controls, f.exec), audit_store: createHeadControlAuditStore({ config_dir: f.chain.config_dir, fs }) });
  const binding = { project_id: owner.project_id, actor: "head", generation: owner.generation };
  const http = createHeadControlHttpService({ authenticateToken: (auth) => auth.token === "head-progress" ? binding : null,
    resolveLaunchBinding: () => ({ installation_id: owner.installation_id, ...binding, active: true, archived: !f.state.live }), resolveHeadControlService: () => service });
  async function run(input) {
    return http.handle({ method: "POST", path: "/api/head-control", body: { version: 1, binding, request: { tool: input.action, arguments: {
      expected_revision: input.expected_revision, correlation_id: input.correlation_id, idempotency_key: input.idempotency_key, delivery: input.payload,
    } } } }, { token: "head-progress" });
  }
  async function accepted(input) {
    const response = await run(input);
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.ok(["accepted", "replayed"].includes(response.result.decision.kind), JSON.stringify(response));
    return response.result.detail;
  }
  const form = () => accepted(f.invoke("form_delivery", { classification: "ordinary", release_intent: "approved ticket scope", rollback_group: "bounded release", isolation_reasons: [], operator_reasons: [] }));
  const inspect = (phase, tasks = []) => accepted(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase, judgment: "approved", complete_scope_tasks: tasks }));
  return { run, accepted, form, inspect, service };
}
async function main() {
  {
    const f = await fixture({ prefix: true, otherRepository: true });
    try {
      const http = httpFor(f), formed = await http.form();
      await http.accepted(f.invoke("publish_delivery", { expected_candidate_revision: f.candidateRevision(), plan_digest: formed.plan.plan_digest }));
      const origin = f.chain.store.readSnapshot(f.ref).delivery.publication;
      f.transition("block", "b", { block_code: "validation" });
      f.transition("block", "c", { block_code: "validation" });
      assert.equal(f.readPipeline().pipeline.tasks.find((t) => t.work_task_ref.task_key === "c").work_task_ref.repository_key, "api");
      f.state.scope.policy.evidence_keys = ["unit"];
      const policyDrift = await http.run(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "before_merge", judgment: "approved", complete_scope_tasks: [] }));
      assert.equal(policyDrift.result.decision.kind, "denied");
      f.state.scope.policy.evidence_keys = ["unit", "typecheck", "build"];
      const object = f.remote.object; let once = true;
      f.remote.object = async (...args) => { const value = await object(...args); if (once) { once = false; f.transition("unblock", "b"); } return value; };
      const raced = await http.run(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "before_merge", judgment: "approved", complete_scope_tasks: [] }));
      assert.equal(raced.result.detail.code, "delivery_scope_changed");
      f.remote.object = object;
      await http.inspect("before_merge");
      const reformed = await http.form();
      assert.equal(reformed.plan.plan_digest, origin.plan.plan_digest);
      assert.deepEqual(f.chain.store.readSnapshot(f.ref).delivery.publication, origin);
      await http.inspect("before_merge");
      const merge = await f.merge();
      const inspected = await http.inspect("after_merge", [f.readPipeline().manifest.tasks[0].ref]);
      await http.accepted(f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: inspected.inspection_digest }));
      assert.equal(f.readPipeline().pipeline.repository_bases.find((r) => r.repository_key === "web").base_sha, merge);
      assert.equal(f.state.pushCount, 1); assert.equal(f.state.createCount, 1); assert.equal(f.state.closeCount, 0);
      console.log("PASS actual Head HTTP: safe A retains standing across same/other repository progress and same-generation re-form, immutable publication, one branch/PR");
    } finally { f.close(); clock.value = "2026-09-08T08:00:00.000Z"; }
  }
  {
    const f = await fixture({ prefix: true });
    try {
      const http = httpFor(f); await f.publish(); await f.seal(); await f.merge();
      const inspected = await http.inspect("after_merge", [f.readPipeline().manifest.tasks[0].ref]);
      const input = f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: inspected.inspection_digest });
      f.state.failMappingBefore = true;
      const failed = await http.run(input);
      assert.equal(failed.result.decision.kind, "denied");
      const originalIntent = f.chain.store.readSnapshot(f.ref).delivery.completion;
      f.transition("block", "b", { block_code: "validation" });
      f.state.scope.assignment_digest = "9".repeat(64);
      assert.equal((await httpFor(f).run(input)).ok, false, "a fresh CAS cannot waive relevant assignment drift");
      f.state.scope.assignment_digest = "1".repeat(64);
      f.state.issues.get(1061).body = "Changed approved scope";
      assert.equal((await httpFor(f).run(input)).ok, false, "a fresh CAS cannot waive the issue revision");
      f.state.issues.get(1061).body = "Approved complete scope";
      f.transition("block", "a", { block_code: "validation" });
      assert.equal((await httpFor(f).run(input)).ok, false, "the exact current cut must remain valid");
      f.transition("unblock", "a");
      const result = await httpFor(f).accepted(input);
      const completed = f.chain.store.readSnapshot(f.ref).delivery.completion;
      assert.deepEqual(completed.expected, originalIntent.expected);
      assert.deepEqual(completed.inspection, originalIntent.inspection);
      assert.deepEqual(completed.merge, originalIntent.merge);
      assert.deepEqual(f.state.mappingInputs[0].delivery, f.state.mappingInputs[1].delivery);
      assert.notEqual(f.state.mappingInputs[0].expected.pipeline_digest, f.state.mappingInputs[1].expected.pipeline_digest);
      assert.equal(f.readPipeline().pipeline.deliveries.length, 1);
      assert.equal(f.readPipeline().pipeline.tasks[0].state, "delivered");
      assert.deepEqual(await httpFor(f).accepted(input), result);
      assert.equal(f.state.pushCount, 1); assert.equal(f.state.createCount, 1);
      console.log("PASS actual Head HTTP restart: immutable completion intent/receipt reobserves one bounded CAS after unrelated progress and maps once");
    } finally { f.close(); clock.value = "2026-09-08T08:00:00.000Z"; }
  }
  {
    const f = await fixture({ prefix: true });
    try {
      const http = httpFor(f); await f.publish(); await f.seal(); await f.merge();
      const inspected = await http.inspect("after_merge");
      // Replacing B revokes its accepted state; a legitimate new review then
      // remains active until the owning pipeline reconciles that review.
      const b = f.readPipeline().pipeline.tasks.find((t) => t.work_task_ref.task_key === "b");
      const replacement = F.stage(b.work_task_ref, b.candidate.base_sha, f.ref.result_sha, "b_progress").candidate;
      f.transition("replace_candidate", "b", { candidate: replacement });
      f.transition("assign_independent_review", "b", { review_round_id: "review_progress", candidate_digest: replacement.candidate_digest });
      const input = f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: inspected.inspection_digest });
      const denied = await http.run(input);
      assert.equal(denied.result.decision.kind, "denied");
      assert.equal(denied.result.detail.code, "work_task_delivery_active_authority");
      const original = f.chain.store.readSnapshot(f.ref).delivery.completion.expected;
      f.transition("record_review_verdict", "b", { review_round_id: "review_progress", candidate_digest: replacement.candidate_digest, verdict: "approved" });
      f.transition("reconcile_review", "b", { review_round_id: "review_progress", candidate_digest: replacement.candidate_digest, resolution: "accepted" });
      await httpFor(f).accepted(input);
      assert.deepEqual(f.chain.store.readSnapshot(f.ref).delivery.completion.expected, original);
      assert.equal(f.readPipeline().pipeline.deliveries.length, 1);
      console.log("PASS active same-repository review refusal recovers through its real verdict/reconciliation without resetting delivery intent");
    } finally { f.close(); clock.value = "2026-09-08T08:00:00.000Z"; }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
