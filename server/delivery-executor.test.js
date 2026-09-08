"use strict";
const assert = require("node:assert/strict");
const { fixture, F, C, clock, owner, command, composeHeadDomain, createHeadControlService, createHeadControlAuditStore, createHeadControlHttpService } = require("./__tests__/delivery-execution-fixture");
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
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
