"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { VERSION, HeadControlPlaneError } = require("./head-control-plane");
const { DIRECTORY_MODE, createHeadControlAuditStore } = require("./head-control-audit-store");
const { HeadControlServiceError, createHeadControlService } = require("./head-control-service");

const BINDING = Object.freeze({
  installation_id: "installationservice001",
  project_id: "quadwork",
  role: "head",
  generation: 11,
});
const MANIFEST_A = "a".repeat(64);
const PIPELINE_B = "b".repeat(64);
const PIPELINE_C = "c".repeat(64);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function configDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-service-"));
  fs.chmodSync(directory, DIRECTORY_MODE);
  return directory;
}
function status(overrides = {}) {
  return {
    revision: 0,
    archived: false,
    manifest_digest: null,
    pipeline_digest: null,
    manifest_frozen: false,
    cut_safe: false,
    ...overrides,
  };
}
function request(action, overrides = {}) {
  const payload = action === "get_pipeline_status" || action === "freeze_batch_manifest" || action === "retire_batch"
    ? null
    : action === "put_batch_manifest"
      ? { manifest: { version: 1, tasks: [] } }
      : action === "queue_local_correction"
        ? { correction: { work_task_ref: { task_key: "build" }, review_round_ref: { round: 1 }, candidate_digest: PIPELINE_C } }
        : action === "read_propagation_stop"
          ? { work_task_ref: { task_key: "build" } }
          : { cut: { tasks: [{ exact_task: "task-one" }] } };
  return {
    version: VERSION,
    action,
    principal: clone(BINDING),
    expected_revision: action === "get_pipeline_status" || action === "read_propagation_stop" ? null : 0,
    idempotency_key: "idem_service_001",
    correlation_id: "corr_service_001",
    payload,
    ...overrides,
  };
}
function domain(initial = status()) {
  let current = clone(initial);
  const calls = { get_pipeline_status: 0, put_batch_manifest: 0, freeze_batch_manifest: 0, cut_batch: 0, retire_batch: 0, queue_local_correction: 0, read_propagation_stop: 0, get_project_status: 0, review_handoff: 0, project_monitor: 0, recover_worker: 0 };
  const actions = {
    get_pipeline_status(input) {
      calls.get_pipeline_status += 1;
      assert.equal(input.binding.generation, BINDING.generation);
      return clone(current);
    },
    get_project_status() {
      calls.get_project_status += 1;
      return { status: clone(current), detail: { assignment: null, monitor: { mode: "suspended" }, workers: {}, capacity: { platform: "test" } } };
    },
    review_handoff() {
      calls.review_handoff += 1;
      return { status: clone(current), detail: { cycle: null } };
    },
    async project_monitor(input) {
      calls.project_monitor += 1;
      return { status: clone(current), detail: { applied: true, command: input.payload.command, mode: input.payload.command === "stop" ? "suspended" : "enabled" } };
    },
    async recover_worker(input) {
      calls.recover_worker += 1;
      return { status: clone(current), detail: { applied: false, outcome: "rejected", reason: "no_loss_evidence", recovered: false, agent: input.payload.recovery.agent } };
    },
    retire_batch(input) {
      calls.retire_batch += 1;
      assert.equal(input.expected_revision, current.revision);
      current = status({ revision: current.revision + 1 });
      return clone(current);
    },
    queue_local_correction(input) {
      calls.queue_local_correction += 1;
      assert.equal(input.expected_revision, current.revision);
      current = status({ ...current, revision: current.revision + 1, pipeline_digest: PIPELINE_C, cut_safe: false });
      return { status: clone(current), detail: { outcome: "queued", checkpoint_id: "checkpoint_" + "f".repeat(48) } };
    },
    read_propagation_stop() {
      calls.read_propagation_stop += 1;
      return { status: clone(current), detail: { kind: "propagation_stop_pending", dependency_chain: [] } };
    },
    put_batch_manifest(input) {
      calls.put_batch_manifest += 1;
      assert.equal(input.expected_revision, current.revision);
      current = status({ revision: current.revision + 1, manifest_digest: MANIFEST_A });
      return clone(current);
    },
    freeze_batch_manifest(input) {
      calls.freeze_batch_manifest += 1;
      assert.equal(input.expected_revision, current.revision);
      current = status({
        revision: current.revision + 1,
        manifest_digest: current.manifest_digest || MANIFEST_A,
        pipeline_digest: PIPELINE_B,
        manifest_frozen: true,
        cut_safe: true,
      });
      return clone(current);
    },
    cut_batch(input) {
      calls.cut_batch += 1;
      assert.equal(input.expected_revision, current.revision);
      current = status({
        revision: current.revision + 1,
        manifest_digest: current.manifest_digest,
        pipeline_digest: PIPELINE_C,
        manifest_frozen: true,
        cut_safe: false,
      });
      return clone(current);
    },
  };
  return { actions, calls, current: () => clone(current) };
}
function service(initial) {
  const fake = domain(initial);
  const auditStore = createHeadControlAuditStore({ config_dir: configDirectory(), fs });
  return {
    core: createHeadControlService({ binding: BINDING, domain: fake.actions, audit_store: auditStore }),
    auditStore,
    ...fake,
  };
}
function expectServiceFailure(fn) {
  return assert.rejects(fn, (error) => error instanceof HeadControlServiceError && error.code === "head_control_audit_unavailable");
}
function expectServiceCode(fn, code) {
  return assert.rejects(fn, (error) => error instanceof HeadControlServiceError && error.code === code);
}

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

(async () => {
// The service adds durable receipts without gaining command authority: every
// M1 action still reaches its static owning domain action through the plane.
{
  const { core, calls } = service();
  const observed = await core.execute(request("get_pipeline_status", {
    idempotency_key: "idem_status_001", correlation_id: "corr_status_001",
  }));
  const put = await core.execute(request("put_batch_manifest", {
    idempotency_key: "idem_put_001", correlation_id: "corr_put_001", expected_revision: 0,
  }));
  const frozen = await core.execute(request("freeze_batch_manifest", {
    idempotency_key: "idem_freeze_001", correlation_id: "corr_freeze_001", expected_revision: 1,
  }));
  const cut = await core.execute(request("cut_batch", {
    idempotency_key: "idem_cut_001", correlation_id: "corr_cut_001", expected_revision: 2,
  }));
  assert.equal(observed.decision.code, "head_control_status_observed");
  assert.equal(put.result.status.revision, 1);
  assert.equal(frozen.result.status.revision, 2);
  assert.equal(cut.result.status.revision, 3);
  assert.deepEqual(calls, { get_pipeline_status: 4, put_batch_manifest: 1, freeze_batch_manifest: 1, cut_batch: 1, retire_batch: 0, queue_local_correction: 0, read_propagation_stop: 0, get_project_status: 0, review_handoff: 0, project_monitor: 0, recover_worker: 0 });
  const records = core.recentAudit();
  assert.equal(records.length, 4);
  assert.deepEqual(Object.keys(records[0]).sort(), [
    "action", "binding", "code", "correlation_id", "decision", "idempotency_key",
    "preconditions", "result", "version",
  ]);
  assert.equal(Object.hasOwn(records[1], "payload"), false);
  assert.equal(Object.isFrozen(records), true);
  assert.equal(Object.isFrozen(records[0].result.status), true);
  ok(Object.isFrozen(cut) && Object.isFrozen(core.binding),
    "the static M1 service returns only immutable decisions and redacted durable receipts");
}

// #1058: the correction route, stop read, and retirement are audited through
// the same durable receipt.  The receipt stays redacted (no detail), the
// payloadless retirement replays after restart, and the payload-bearing
// correction stays ambiguous after restart exactly like put/cut.
{
  const fake = domain(status({ revision: 2, manifest_digest: MANIFEST_A, pipeline_digest: PIPELINE_B, manifest_frozen: true, cut_safe: true }));
  const configDir = configDirectory();
  const first = createHeadControlService({ binding: BINDING, domain: fake.actions, audit_store: createHeadControlAuditStore({ config_dir: configDir, fs }) });
  const stop = await first.execute(request("read_propagation_stop", { idempotency_key: "idem_stop_001", correlation_id: "corr_stop_001" }));
  assert.equal(stop.decision.code, "head_control_stop_observed");
  assert.equal(stop.detail.kind, "propagation_stop_pending");
  const correctionRequest = request("queue_local_correction", { idempotency_key: "idem_corr_001", correlation_id: "corr_corr_001", expected_revision: 2 });
  const correction = await first.execute(correctionRequest);
  assert.equal(correction.decision.code, "head_control_applied");
  assert.equal(correction.detail.outcome, "queued");
  const correctionReplay = await first.execute(clone(correctionRequest));
  assert.equal(correctionReplay.decision.kind, "replayed");
  assert.equal(correctionReplay.detail.outcome, "queued");
  const stopReplay = await first.execute(request("read_propagation_stop", { idempotency_key: "idem_stop_001", correlation_id: "corr_stop_001" }));
  assert.equal(stopReplay.decision.kind, "replayed");
  assert.equal(stopReplay.detail.kind, "propagation_stop_pending");
  const retireRequest = request("retire_batch", { idempotency_key: "idem_retire_001", correlation_id: "corr_retire_001", expected_revision: 3 });
  const retired = await first.execute(retireRequest);
  assert.equal(retired.decision.code, "head_control_applied");
  assert.equal(retired.result.status.manifest_digest, null);
  const records = first.recentAudit();
  assert.deepEqual(records.map((record) => record.action), ["read_propagation_stop", "queue_local_correction", "retire_batch"]);
  assert.ok(records.every((record) => !Object.hasOwn(record, "detail") && !Object.hasOwn(record.result, "detail")));
  assert.doesNotMatch(JSON.stringify(records), /checkpoint_|dependency_chain|propagation_stop_pending/);
  assert.deepEqual([fake.calls.read_propagation_stop, fake.calls.queue_local_correction, fake.calls.retire_batch], [1, 1, 1]);
  const afterRestart = createHeadControlService({ binding: BINDING, domain: fake.actions, audit_store: createHeadControlAuditStore({ config_dir: configDir, fs }) });
  const retireReplay = await afterRestart.execute(clone(retireRequest));
  assert.equal(retireReplay.decision.kind, "replayed");
  assert.equal(retireReplay.detail, null);
  await expectServiceCode(() => afterRestart.execute(clone(correctionRequest)), "head_control_durable_replay_ambiguous");
  assert.deepEqual([fake.calls.queue_local_correction, fake.calls.retire_batch], [1, 1]);
  ok(true, "retirement, correction, and stop read share one redacted durable receipt with the fixed restart-replay rules");
}

// Principal and optimistic-revision denials are persisted too, but cannot
// invoke an owning mutation before their Head binding is checked by the plane.
{
  const { core, calls } = service(status({ revision: 2 }));
  const wrongProject = await core.execute(request("get_pipeline_status", {
    principal: { ...BINDING, project_id: "other" },
    idempotency_key: "idem_project_001", correlation_id: "corr_project_001",
  }));
  const staleGeneration = await core.execute(request("get_pipeline_status", {
    principal: { ...BINDING, generation: 10 },
    idempotency_key: "idem_generation_001", correlation_id: "corr_generation_001",
  }));
  const staleRevision = await core.execute(request("put_batch_manifest", {
    expected_revision: 1, idempotency_key: "idem_stale_001", correlation_id: "corr_stale_001",
  }));
  assert.equal(wrongProject.decision.code, "head_control_project_denied");
  assert.equal(staleGeneration.decision.code, "head_control_generation_stale");
  assert.equal(staleRevision.decision.code, "head_control_stale_revision");
  assert.equal(calls.get_pipeline_status, 1);
  assert.equal(calls.put_batch_manifest, 0);
  assert.equal(core.recentAudit().length, 3);
  ok(true, "binding and stale-revision denials are durable and fail closed before mutation");
}

// An exact retry reuses the plane receipt and causes a store-level duplicate,
// so it remains deterministic and does not make a second domain mutation.
{
  const { core, auditStore, calls } = service();
  const firstRequest = request("put_batch_manifest", {
    idempotency_key: "idem_retry_001", correlation_id: "corr_retry_001", expected_revision: 0,
  });
  const first = await core.execute(firstRequest);
  const replay = await core.execute(clone(firstRequest));
  assert.equal(first.decision.kind, "accepted");
  assert.equal(replay.decision.kind, "replayed");
  assert.equal(calls.put_batch_manifest, 1);
  const once = core.recentAudit();
  const again = core.recentAudit();
  assert.deepEqual(again, once);
  assert.equal(auditStore.read(BINDING).length, 1);

  // A one-sided reused identity is rejected by the durable preflight before
  // either the plane or the owning freeze action can run.
  await expectServiceCode(() => core.execute(request("freeze_batch_manifest", {
    expected_revision: 1, idempotency_key: "idem_retry_001", correlation_id: "corr_collision_001",
  })), "head_control_durable_identity_collision");
  assert.equal(calls.freeze_batch_manifest, 0);
  assert.equal(core.recentAudit().length, 1);
  ok(true, "duplicate retries re-read one durable receipt while identity collisions fail closed");
}

// Combining the correlation from one receipt with the idempotency key from
// another cannot name a replay and is stopped before an owned status read.
{
  const { core, calls } = service();
  await core.execute(request("get_pipeline_status", {
    idempotency_key: "idem_identity_one", correlation_id: "corr_identity_one",
  }));
  await core.execute(request("get_pipeline_status", {
    idempotency_key: "idem_identity_two", correlation_id: "corr_identity_two",
  }));
  await expectServiceCode(() => core.execute(request("get_pipeline_status", {
    idempotency_key: "idem_identity_two", correlation_id: "corr_identity_one",
  })), "head_control_durable_identity_collision");
  assert.equal(calls.get_pipeline_status, 2);
  ok(true, "split durable correlation and idempotency identities cannot reach the domain");
}

// Restart safety is stricter than the in-memory plane. A payload-bearing
// durable receipt cannot prove that an arriving payload matches it, so a new
// service rejects even a byte-for-byte retry before the domain. A changed
// payload with the same identities is rejected by the same fail-closed gate.
{
  const fake = domain();
  const configDir = configDirectory();
  const firstStore = createHeadControlAuditStore({ config_dir: configDir, fs });
  const first = createHeadControlService({ binding: BINDING, domain: fake.actions, audit_store: firstStore });
  const firstRequest = request("put_batch_manifest", {
    idempotency_key: "idem_restart_001", correlation_id: "corr_restart_001", expected_revision: 0,
  });
  await first.execute(firstRequest);
  assert.equal(fake.calls.put_batch_manifest, 1);
  const secondStore = createHeadControlAuditStore({ config_dir: configDir, fs });
  const afterRestart = createHeadControlService({ binding: BINDING, domain: fake.actions, audit_store: secondStore });
  await expectServiceCode(() => afterRestart.execute(clone(firstRequest)), "head_control_durable_replay_ambiguous");
  await expectServiceCode(() => afterRestart.execute({
    ...clone(firstRequest),
    payload: { manifest: { version: 1, tasks: [{ exact_task: "changed-payload" }] } },
  }), "head_control_durable_replay_ambiguous");
  assert.equal(fake.calls.put_batch_manifest, 1);
  const readBack = afterRestart.recentAudit();
  assert.equal(readBack.length, 1);
  assert.equal(readBack[0].correlation_id, "corr_restart_001");
  assert.equal(Object.hasOwn(readBack[0], "expected_revision"), false);
  assert.equal(Object.hasOwn(readBack[0], "payload"), false);
  ok(true, "restart retries and changed-payload identity collisions cannot reach the domain");
}

// The redacted receipt fully represents successful no-payload commands, so
// those can be re-read deterministically after restart without a domain read.
{
  const fake = domain();
  const configDir = configDirectory();
  const firstStore = createHeadControlAuditStore({ config_dir: configDir, fs });
  const first = createHeadControlService({ binding: BINDING, domain: fake.actions, audit_store: firstStore });
  const statusRequest = request("get_pipeline_status", {
    idempotency_key: "idem_status_restart", correlation_id: "corr_status_restart",
  });
  await first.execute(statusRequest);
  assert.equal(fake.calls.get_pipeline_status, 1);
  const afterRestart = createHeadControlService({
    binding: BINDING,
    domain: fake.actions,
    audit_store: createHeadControlAuditStore({ config_dir: configDir, fs }),
  });
  const replay = await afterRestart.execute(clone(statusRequest));
  assert.equal(replay.decision.kind, "replayed");
  assert.equal(replay.result.status.revision, 0);
  assert.equal(fake.calls.get_pipeline_status, 1);
  ok(true, "a fully provable payloadless receipt replays safely after restart");
}

// An unavailable or malformed audit state is checked before the plane can
// reach the domain. If a later append fails, an exact retry persists the
// already-held plane receipt rather than applying the domain action twice.
{
  const fake = domain();
  const unavailableStore = Object.freeze({
    read() { throw new Error("storage unavailable"); },
    append() { throw new Error("must not append"); },
  });
  const unavailable = createHeadControlService({ binding: BINDING, domain: fake.actions, audit_store: unavailableStore });
  await expectServiceFailure(() => unavailable.execute(request("put_batch_manifest", {
    idempotency_key: "idem_unavailable_001", correlation_id: "corr_unavailable_001", expected_revision: 0,
  })));
  assert.equal(fake.calls.get_pipeline_status, 0);
  assert.equal(fake.calls.put_batch_manifest, 0);

  const real = service();
  let permitAppend = false;
  const retryStore = Object.freeze({
    read(bindingValue) { return real.auditStore.read(bindingValue); },
    append(input) {
      if (!permitAppend) throw new Error("temporary audit failure");
      return real.auditStore.append(input);
    },
  });
  const retry = createHeadControlService({ binding: BINDING, domain: real.actions, audit_store: retryStore });
  const retryRequest = request("put_batch_manifest", {
    idempotency_key: "idem_append_001", correlation_id: "corr_append_001", expected_revision: 0,
  });
  await expectServiceFailure(() => retry.execute(retryRequest));
  assert.equal(real.calls.put_batch_manifest, 1);
  permitAppend = true;
  const replay = await retry.execute(clone(retryRequest));
  assert.equal(replay.decision.kind, "replayed");
  assert.equal(real.calls.put_batch_manifest, 1);
  assert.equal(retry.recentAudit().length, 1);
  ok(true, "audit failure never returns an unaudited result and exact retry cannot double-apply");
}

// The adapter itself accepts no action registration or capability surface. It
// only composes the two fixed local modules and leaves unsupported actions to
// the closed plane's typed request boundary.
{
  const { core, auditStore, actions } = service();
  assert.throws(() => createHeadControlService({ binding: BINDING, domain: actions, audit_store: auditStore, register_action() {} }),
    (error) => error instanceof HeadControlServiceError && error.code === "invalid_head_control_service_options");
  assert.throws(() => createHeadControlService({ binding: BINDING, domain: actions, audit_store: { read() {}, append() {}, fetch() {} } }),
    (error) => error instanceof HeadControlServiceError && error.code === "invalid_head_control_service_options");
  await assert.rejects(() => core.execute({ ...request("get_pipeline_status", {
    idempotency_key: "idem_unsupported_001", correlation_id: "corr_unsupported_001",
  }), action: "publish_delivery" }),
  (error) => error instanceof HeadControlPlaneError && error.code === "head_control_action_unsupported");
  const source = fs.readFileSync(path.join(__dirname, "head-control-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|child_process|net)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|mcp-chat-shim|project-monitor|file-chat)["']\s*\)/);
  assert.doesNotMatch(source, /(?:setInterval\s*\(|setTimeout\s*\(|compose_delivery|publish_delivery|registerAction)/);
  ok(true, "the service has no dynamic registration, transport, monitor, delivery, or process authority");
}

console.log(`\n${passed} passed`);
})().catch((error) => { console.error(error); process.exit(1); });
