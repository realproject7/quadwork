"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { fork } = require("node:child_process");
const { fixture, F, owner, clock, composeHeadDomain, createHeadControlService, createHeadControlAuditStore, createHeadControlHttpService } = require("./__tests__/delivery-execution-fixture");
const { headControlAuditStorePath } = require("./head-control-audit-store");
async function appendChild(file) {
  const { config_dir, input } = JSON.parse(fs.readFileSync(file, "utf8"));
  const store = createHeadControlAuditStore({ config_dir, fs });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const result = store.append(input); process.send({ duplicate: result.duplicate }); process.disconnect(); return; }
    catch (error) { if (error.code !== "head_control_audit_store_locked") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error("concurrent audit writer remained locked");
}
function childAppend(file) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ["--append", file], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let receipt;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("audit child timed out")); }, 5000);
    child.on("message", (value) => { receipt = value; });
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); if (code || !receipt) reject(new Error("audit child failed")); else resolve(receipt); });
  });
}
async function main() {
  const f = await fixture();
  try {
    let current = owner;
    const services = [];
    function connection(binding) {
      const controls = { read_project_status: async () => ({}), read_review_handoff: async () => ({}), project_monitor: async () => ({}), recover_worker: async () => ({}) };
      const service = createHeadControlService({ binding, domain: composeHeadDomain(binding, f.domain, controls, f.exec), audit_store: createHeadControlAuditStore({ config_dir: f.chain.config_dir, fs }) });
      services.push(service);
      const publicBinding = { project_id: binding.project_id, actor: "head", generation: binding.generation };
      const http = createHeadControlHttpService({ authenticateToken: (auth) => auth.token === `head-${binding.generation}` ? publicBinding : null,
        resolveLaunchBinding: () => ({ installation_id: current.installation_id, project_id: current.project_id, actor: "head", generation: current.generation, active: true, archived: !f.state.live }), resolveHeadControlService: () => service });
      async function run(input) {
        const args = { correlation_id: input.correlation_id, idempotency_key: input.idempotency_key };
        if (!["get_pipeline_status", "get_project_status"].includes(input.action)) Object.assign(args, { expected_revision: input.expected_revision, delivery: input.payload });
        return http.handle({ method: "POST", path: "/api/head-control", body: { version: 1, binding: publicBinding, request: { tool: input.action, arguments: args } } }, { token: `head-${binding.generation}` });
      }
      async function accepted(input) {
        const response = await run(input); assert.equal(response.ok, true, JSON.stringify(response));
        assert.ok(["accepted", "replayed"].includes(response.result.decision.kind), JSON.stringify(response)); return response.result;
      }
      return { run, accepted, service };
    }
    const status = { action: "get_pipeline_status", correlation_id: "generation_status", idempotency_key: "generation_status" };
    const first = connection(current);
    const initial = await first.accepted(status);
    const originalPath = headControlAuditStorePath(f.chain.config_dir, owner);
    const legacyPath = path.join(f.chain.config_dir, "head-control-audit", `${owner.installation_id}--${owner.project_id}.json`);
    fs.renameSync(originalPath, legacyPath); // An exact pre-upgrade layout.
    const initialBytes = fs.readFileSync(legacyPath);
    assert.equal((await connection(current).accepted(status)).decision.kind, "replayed");
    assert.deepEqual(fs.readFileSync(legacyPath), initialBytes, "same-generation upgrade must preserve replay history");
    assert.equal((await connection(current).run({ ...status, action: "get_project_status" })).ok, false, "legacy keys cannot authorize another action");
    const concurrentAudit = { ...initial.audit, correlation_id: "generation_parallel", idempotency_key: "generation_parallel" };
    const inputFile = path.join(f.chain.config_dir, "parallel-input.json");
    fs.writeFileSync(inputFile, JSON.stringify({ config_dir: f.chain.config_dir, input: { binding: owner, audit: concurrentAudit } }));
    const receipts = await Promise.all([childAppend(inputFile), childAppend(inputFile)]);
    assert.deepEqual(receipts.map((r) => r.duplicate).sort(), [false, true]);
    const store = createHeadControlAuditStore({ config_dir: f.chain.config_dir, fs });
    assert.equal(store.read(owner).length, 2);
    assert.throws(() => store.append({ binding: owner, audit: { ...concurrentAudit, idempotency_key: "different_parallel" } }), (e) => e.code === "head_control_audit_correlation_conflict");
    const declaration = { classification: "ordinary", release_intent: "approved ticket scope", rollback_group: "bounded release", isolation_reasons: [], operator_reasons: [] };
    const formed = await first.accepted(f.invoke("form_delivery", declaration));
    await first.accepted(f.invoke("publish_delivery", { expected_candidate_revision: f.candidateRevision(), plan_digest: formed.detail.plan.plan_digest }));
    const publication = f.chain.store.readSnapshot(f.ref).delivery.publication;
    const priorBytes = fs.readFileSync(legacyPath), priorRecords = store.read(owner);
    f.adoptGeneration(); current = { ...owner, generation: owner.generation + 1 };
    assert.equal((await first.run(status)).ok, false, "old authenticated binding is rejected at the actual HTTP boundary");
    const next = connection(current);
    assert.equal((await next.accepted(status)).decision.kind, "accepted");
    assert.equal((await connection(current).accepted(status)).decision.kind, "replayed");
    assert.equal((await next.run({ ...status, action: "get_project_status" })).ok, false);
    const reformed = await next.accepted(f.invoke("form_delivery", declaration));
    assert.equal(reformed.detail.plan.plan_digest, publication.plan.plan_digest);
    await next.accepted(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "before_merge", judgment: "approved", complete_scope_tasks: [] }));
    await f.merge();
    const inspected = await next.accepted(f.invoke("inspect_delivery", { expected_candidate_revision: f.candidateRevision(), phase: "after_merge", judgment: "approved", complete_scope_tasks: f.readPipeline().manifest.tasks.map((t) => t.ref) }));
    await next.accepted(f.invoke("complete_delivery", { expected_candidate_revision: f.candidateRevision(), inspection_digest: inspected.detail.inspection_digest }));
    assert.equal(f.state.pushCount, 1); assert.equal(f.state.createCount, 1); assert.equal(f.state.closeCount, 2);
    assert.deepEqual(f.chain.store.readSnapshot(f.ref).delivery.publication, publication);
    assert.deepEqual(fs.readFileSync(legacyPath), priorBytes);
    assert.deepEqual(store.read(owner), priorRecords);
    const nextPath = headControlAuditStorePath(f.chain.config_dir, current);
    assert.notEqual(nextPath, originalPath); assert.equal(fs.statSync(nextPath).mode & 0o777, 0o600);
    fs.copyFileSync(legacyPath, originalPath); fs.chmodSync(originalPath, 0o600);
    assert.throws(() => store.read(owner), (e) => e.code === "head_control_audit_store_ambiguous", "never discard either conflicting legacy/current history");
    console.log("PASS actual Head HTTP generation recovery through real Git completion, immutable legacy bytes, exact replay/collisions and concurrent legacy writers");
  } finally { f.close(); clock.value = "2026-09-08T08:00:00.000Z"; }
}
(process.argv[2] === "--append" ? appendChild(process.argv[3]) : main()).catch((error) => { console.error(error); process.exitCode = 1; });
