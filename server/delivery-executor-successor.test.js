"use strict";
const assert = require("node:assert/strict");
const { fixture, F, C, clock, owner, command, composeHeadDomain, createHeadControlService, createHeadControlAuditStore, createHeadControlHttpService } = require("./__tests__/delivery-execution-fixture");
async function main() {
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
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
