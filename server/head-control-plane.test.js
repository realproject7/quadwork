"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  VERSION,
  ACTIONS,
  MAX_IDEMPOTENCY_RECORDS,
  HeadControlPlaneError,
  createHeadControlPlane,
} = require("./head-control-plane");

const binding = {
  installation_id: "installation_control_12345",
  project_id: "quadwork",
  role: "head",
  generation: 7,
};
const manifestDigest = "a".repeat(64);
const pipelineDigest = "b".repeat(64);

function copy(value) { return JSON.parse(JSON.stringify(value)); }
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
const taskRef = Object.freeze({ installation_id: binding.installation_id, project_id: binding.project_id, task_key: "build" });
const stopDetail = Object.freeze({ kind: "propagation_stop_pending", target: "head_private", candidate_digest: "e".repeat(64), dependency_chain: [{ task_key: "dependent" }] });
function request(action, overrides = {}) {
  const payload = action === "get_pipeline_status" || action === "freeze_batch_manifest" || action === "retire_batch"
    ? null
    : action === "put_batch_manifest"
      ? { manifest: { version: 1, tasks: [] } }
      : action === "queue_local_correction"
        ? { correction: { work_task_ref: copy(taskRef), review_round_ref: { round: 1 }, candidate_digest: "e".repeat(64) } }
        : action === "read_propagation_stop"
          ? { work_task_ref: copy(taskRef) }
          : { cut: { tasks: [{ exact_task: "task-one" }] } };
  return {
    version: VERSION,
    action,
    principal: copy(binding),
    expected_revision: action === "get_pipeline_status" || action === "read_propagation_stop" ? null : 0,
    idempotency_key: "idem_request_001",
    correlation_id: "corr_request_001",
    payload,
    ...overrides,
  };
}
function fakeDomain(initial = status()) {
  let current = copy(initial);
  const calls = { get_pipeline_status: 0, put_batch_manifest: 0, freeze_batch_manifest: 0, cut_batch: 0, retire_batch: 0, queue_local_correction: 0, read_propagation_stop: 0 };
  const domain = {
    get_pipeline_status(input) {
      calls.get_pipeline_status += 1;
      assert.equal(input.binding.role, "head");
      return copy(current);
    },
    retire_batch(input) {
      calls.retire_batch += 1;
      assert.equal(input.expected_revision, current.revision);
      assert.equal(input.payload, null);
      current = status({ revision: current.revision + 1 });
      return copy(current);
    },
    queue_local_correction(input) {
      calls.queue_local_correction += 1;
      assert.equal(input.expected_revision, current.revision);
      assert.deepEqual(Object.keys(input.payload), ["correction"]);
      current = status({ ...current, revision: current.revision + 1, pipeline_digest: "d".repeat(64), cut_safe: false });
      return { status: copy(current), detail: { outcome: "queued", work_task_ref: copy(input.payload.correction.work_task_ref), candidate_digest: input.payload.correction.candidate_digest, checkpoint_id: "checkpoint_" + "f".repeat(48) } };
    },
    read_propagation_stop(input) {
      calls.read_propagation_stop += 1;
      assert.equal(input.expected_revision, null);
      assert.deepEqual(Object.keys(input.payload), ["work_task_ref"]);
      return { status: copy(current), detail: current.cut_safe ? null : copy(stopDetail) };
    },
    put_batch_manifest(input) {
      calls.put_batch_manifest += 1;
      assert.equal(input.expected_revision, current.revision);
      assert.deepEqual(Object.keys(input.payload), ["manifest"]);
      current = status({ revision: current.revision + 1, manifest_digest: manifestDigest });
      return copy(current);
    },
    freeze_batch_manifest(input) {
      calls.freeze_batch_manifest += 1;
      assert.equal(input.expected_revision, current.revision);
      current = status({
        revision: current.revision + 1,
        manifest_digest: current.manifest_digest || manifestDigest,
        pipeline_digest: pipelineDigest,
        manifest_frozen: true,
        cut_safe: true,
      });
      return copy(current);
    },
    cut_batch(input) {
      calls.cut_batch += 1;
      assert.equal(input.expected_revision, current.revision);
      assert.ok(input.payload.cut.tasks.length > 0);
      if (!current.cut_safe) throw new Error("unsafe in owning domain");
      current = status({
        revision: current.revision + 1,
        manifest_digest: current.manifest_digest,
        pipeline_digest: "c".repeat(64),
        manifest_frozen: true,
        cut_safe: false,
      });
      return copy(current);
    },
  };
  return { domain, calls, read: () => copy(current) };
}
function plane(initial) {
  const fake = fakeDomain(initial);
  return { core: createHeadControlPlane({ binding, domain: fake.domain }), ...fake };
}

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// The four M1 actions are closed and use the owning pipeline actions in their
// semantic sequence: read, put manifest, freeze, then a demonstrably safe cut.
{
  const { core, calls } = plane();
  const observed = core.execute(request("get_pipeline_status", {
    idempotency_key: "idem_status_001", correlation_id: "corr_status_001",
  }));
  assert.equal(observed.decision.kind, "accepted");
  assert.equal(observed.decision.code, "head_control_status_observed");
  assert.equal(observed.result.applied, false);
  assert.equal(observed.result.status.revision, 0);

  const put = core.execute(request("put_batch_manifest", {
    idempotency_key: "idem_put_001", correlation_id: "corr_put_001", expected_revision: 0,
  }));
  assert.equal(put.decision.kind, "accepted");
  assert.equal(put.result.status.revision, 1);
  assert.equal(put.result.status.manifest_digest, manifestDigest);

  const frozen = core.execute(request("freeze_batch_manifest", {
    idempotency_key: "idem_freeze_001", correlation_id: "corr_freeze_001", expected_revision: 1,
  }));
  assert.equal(frozen.decision.kind, "accepted");
  assert.equal(frozen.result.status.revision, 2);
  assert.equal(frozen.result.status.manifest_frozen, true);

  const cut = core.execute(request("cut_batch", {
    idempotency_key: "idem_cut_001", correlation_id: "corr_cut_001", expected_revision: 2,
  }));
  assert.equal(cut.decision.kind, "accepted");
  assert.equal(cut.result.status.revision, 3);
  assert.equal(cut.result.status.cut_safe, false);
  ok(JSON.stringify(ACTIONS) === JSON.stringify(["get_pipeline_status", "put_batch_manifest", "freeze_batch_manifest", "cut_batch", "retire_batch", "queue_local_correction", "read_propagation_stop"]),
    "only the seven named pipeline actions are exposed");
  ok(calls.get_pipeline_status === 4 && calls.put_batch_manifest === 1 && calls.freeze_batch_manifest === 1 && calls.cut_batch === 1,
    "each accepted action delegates once to its fixed owning pipeline action");

  const audit = core.auditSnapshot();
  assert.equal(audit.length, 4);
  assert.deepEqual(Object.keys(audit[0]).sort(), ["action", "binding", "code", "correlation_id", "decision", "expected_revision", "idempotency_key", "result", "version"]);
  assert.equal(audit[0].result.status.pipeline_digest, null);
  ok(Object.isFrozen(cut) && Object.isFrozen(cut.audit) && Object.isFrozen(audit),
    "decision, result, and bounded audit records are immutable fixed shapes");
}

// #1058: retirement, the correction route, and the propagation-stop read use
// the same bound authority, replay window, and fixed audit record.  A detail
// travels beside the fixed result and never enters the audit.
{
  const { core, calls } = plane(status({ revision: 3, manifest_digest: manifestDigest, pipeline_digest: pipelineDigest, manifest_frozen: true, cut_safe: false }));
  const stop = core.execute(request("read_propagation_stop", { idempotency_key: "idem_stop_001", correlation_id: "corr_stop_001" }));
  assert.equal(stop.decision.code, "head_control_stop_observed");
  assert.equal(stop.result.applied, false);
  assert.deepEqual(stop.detail, stopDetail);
  assert.equal(Object.hasOwn(stop.audit, "detail"), false);
  assert.deepEqual(Object.keys(stop.audit.result).sort(), ["action", "applied", "status"]);
  const stopReplay = core.execute(request("read_propagation_stop", { idempotency_key: "idem_stop_001", correlation_id: "corr_stop_001" }));
  assert.equal(stopReplay.decision.kind, "replayed");
  assert.deepEqual(stopReplay.detail, stopDetail);
  assert.equal(calls.read_propagation_stop, 1);
  ok(true, "the propagation-stop read returns its redacted detail beside the fixed status and replays without a second domain read");

  const correction = core.execute(request("queue_local_correction", { idempotency_key: "idem_corr_001", correlation_id: "corr_corr_001", expected_revision: 3 }));
  assert.equal(correction.decision.code, "head_control_applied");
  assert.equal(correction.result.status.revision, 4);
  assert.equal(correction.detail.outcome, "queued");
  assert.match(correction.detail.checkpoint_id, /^checkpoint_/);
  assert.equal(Object.hasOwn(correction.audit, "detail"), false);
  assert.equal(calls.queue_local_correction, 1);
  ok(true, "a queued local correction is one revisioned mutation whose detail stays out of the audit record");

  const retired = core.execute(request("retire_batch", { idempotency_key: "idem_retire_001", correlation_id: "corr_retire_001", expected_revision: 4 }));
  assert.equal(retired.decision.code, "head_control_applied");
  assert.equal(retired.result.status.revision, 5);
  assert.equal(retired.result.status.manifest_digest, null);
  assert.equal(retired.detail, null);
  assert.equal(calls.retire_batch, 1);
  const unsafeStop = core.execute(request("read_propagation_stop", { idempotency_key: "idem_stop_empty", correlation_id: "corr_stop_empty" }));
  assert.equal(unsafeStop.decision.code, "head_control_stop_unavailable");
  const unsafeRetire = core.execute(request("retire_batch", { idempotency_key: "idem_retire_empty", correlation_id: "corr_retire_empty", expected_revision: 5 }));
  assert.equal(unsafeRetire.decision.code, "head_control_retire_unsafe");
  const unsafeCorrection = core.execute(request("queue_local_correction", { idempotency_key: "idem_corr_empty", correlation_id: "corr_corr_empty", expected_revision: 5 }));
  assert.equal(unsafeCorrection.decision.code, "head_control_correction_unsafe");
  assert.equal(calls.retire_batch, 1);
  assert.equal(calls.read_propagation_stop, 1);
  assert.equal(calls.queue_local_correction, 1);
  ok(true, "retirement returns the batch to empty, after which no retire, correction, or stop read reaches the domain");

  const archived = plane(status({ revision: 6, archived: true, manifest_digest: manifestDigest, pipeline_digest: pipelineDigest, manifest_frozen: true, cut_safe: false }));
  const archivedRetire = archived.core.execute(request("retire_batch", { idempotency_key: "idem_retire_archived", correlation_id: "corr_retire_archived", expected_revision: 6 }));
  assert.equal(archivedRetire.decision.code, "head_control_applied");
  const archivedCorrection = archived.core.execute(request("queue_local_correction", { idempotency_key: "idem_corr_archived", correlation_id: "corr_corr_archived", expected_revision: 7 }));
  assert.equal(archivedCorrection.decision.code, "head_control_correction_unsafe");
  ok(archived.calls.retire_batch === 1 && archived.calls.queue_local_correction === 0,
    "an archived batch can still be retired but cannot queue a correction");

  const broken = fakeDomain(status({ revision: 3, manifest_digest: manifestDigest, pipeline_digest: pipelineDigest, manifest_frozen: true, cut_safe: false }));
  broken.domain.read_propagation_stop = () => ({ status: broken.read(), detail: "leaked text" });
  const brokenCore = createHeadControlPlane({ binding, domain: broken.domain });
  const malformedDetail = brokenCore.execute(request("read_propagation_stop", { idempotency_key: "idem_stop_bad", correlation_id: "corr_stop_bad" }));
  assert.equal(malformedDetail.decision.code, "head_control_domain_invalid_status");
  broken.domain.retire_batch = () => status({ revision: 4, manifest_digest: manifestDigest, pipeline_digest: pipelineDigest, manifest_frozen: true });
  const notEmptied = brokenCore.execute(request("retire_batch", { idempotency_key: "idem_retire_bad", correlation_id: "corr_retire_bad", expected_revision: 3 }));
  ok(notEmptied.decision.code === "head_control_domain_invalid_transition" && malformedDetail.detail === null,
    "a non-object detail or a retirement that keeps its manifest fails closed");

  for (const action of ["retire_batch", "queue_local_correction", "read_propagation_stop"]) {
    const foreign = plane(status({ revision: 3, manifest_digest: manifestDigest, pipeline_digest: pipelineDigest, manifest_frozen: true }));
    const dev = foreign.core.execute(request(action, { principal: { ...binding, role: "dev" }, expected_revision: action === "read_propagation_stop" ? null : 3 }));
    const other = foreign.core.execute(request(action, { principal: { ...binding, project_id: "other" }, expected_revision: action === "read_propagation_stop" ? null : 3, idempotency_key: "idem_other", correlation_id: "corr_other" }));
    const stale = foreign.core.execute(request(action, { principal: { ...binding, generation: 6 }, expected_revision: action === "read_propagation_stop" ? null : 3, idempotency_key: "idem_stale", correlation_id: "corr_stale" }));
    assert.equal(dev.decision.code, "head_control_role_denied");
    assert.equal(other.decision.code, "head_control_project_denied");
    assert.equal(stale.decision.code, "head_control_generation_stale");
    assert.equal(foreign.calls[action], 0);
    assert.equal(foreign.calls.get_pipeline_status, 0);
  }
  ok(true, "Dev, cross-project, and stale-generation principals never reach retirement, correction, or the stop read");
  assert.throws(() => core.execute(request("read_propagation_stop", { idempotency_key: "idem_stop_rev", correlation_id: "corr_stop_rev", expected_revision: 3 })),
    (error) => error instanceof HeadControlPlaneError && error.code === "invalid_head_control_request");
  assert.throws(() => core.execute(request("queue_local_correction", { idempotency_key: "idem_corr_pl", correlation_id: "corr_corr_pl", expected_revision: 3, payload: { correction: [] } })),
    (error) => error instanceof HeadControlPlaneError && error.code === "invalid_head_control_request");
  assert.throws(() => core.execute(request("retire_batch", { idempotency_key: "idem_retire_pl", correlation_id: "corr_retire_pl", expected_revision: 3, payload: { anything: true } })),
    (error) => error instanceof HeadControlPlaneError && error.code === "invalid_head_control_request");
  ok(true, "read actions cannot pin a revision and mutations take only their fixed payload shape");
}

// Principal binding is exact.  A mismatched role, project, or generation is a
// normal fail-closed decision and cannot even read the owning pipeline state.
{
  const { core, calls } = plane();
  const wrongRole = core.execute(request("get_pipeline_status", {
    principal: { ...binding, role: "dev" }, idempotency_key: "idem_role_001", correlation_id: "corr_role_001",
  }));
  const wrongProject = core.execute(request("get_pipeline_status", {
    principal: { ...binding, project_id: "other" }, idempotency_key: "idem_project_001", correlation_id: "corr_project_001",
  }));
  const staleGeneration = core.execute(request("get_pipeline_status", {
    principal: { ...binding, generation: 6 }, idempotency_key: "idem_generation_001", correlation_id: "corr_generation_001",
  }));
  assert.equal(wrongRole.decision.code, "head_control_role_denied");
  assert.equal(wrongProject.decision.code, "head_control_project_denied");
  assert.equal(staleGeneration.decision.code, "head_control_generation_stale");
  ok(calls.get_pipeline_status === 0, "wrong Head binding is denied before any domain read or mutation");
}

// Archive, stale optimistic revision, and unsafe cut are all explicit semantic
// denials.  They never rely on a generic catch-all permission callback.
{
  const archived = plane(status({ archived: true }));
  const archivedPut = archived.core.execute(request("put_batch_manifest", {
    idempotency_key: "idem_archived_001", correlation_id: "corr_archived_001", expected_revision: 0,
  }));
  assert.equal(archivedPut.decision.code, "head_control_archived");
  assert.equal(archived.calls.put_batch_manifest, 0);

  const stale = plane(status({ revision: 2 }));
  const stalePut = stale.core.execute(request("put_batch_manifest", {
    idempotency_key: "idem_stale_001", correlation_id: "corr_stale_001", expected_revision: 1,
  }));
  assert.equal(stalePut.decision.code, "head_control_stale_revision");
  assert.equal(stale.calls.put_batch_manifest, 0);

  const unsafe = plane(status({ revision: 4, manifest_digest: manifestDigest, pipeline_digest: pipelineDigest, manifest_frozen: true, cut_safe: false }));
  const unsafeCut = unsafe.core.execute(request("cut_batch", {
    idempotency_key: "idem_unsafe_cut_001", correlation_id: "corr_unsafe_cut_001", expected_revision: 4,
  }));
  assert.equal(unsafeCut.decision.code, "head_control_unsafe_cut");
  ok(unsafe.calls.cut_batch === 0, "core denies a not-cut-safe pipeline before invoking the owning cut action");
}

// An exact duplicate is replayed from its immutable receipt, while reusing
// either key for a different request fails closed and cannot double-apply.
{
  const { core, calls } = plane();
  const firstRequest = request("put_batch_manifest", {
    idempotency_key: "idem_retry_001", correlation_id: "corr_retry_001", expected_revision: 0,
  });
  const first = core.execute(firstRequest);
  const replay = core.execute(copy(firstRequest));
  assert.equal(first.decision.kind, "accepted");
  assert.equal(replay.decision.kind, "replayed");
  assert.equal(replay.decision.code, "head_control_duplicate_retry");
  assert.equal(replay.result.status.revision, 1);
  assert.equal(calls.put_batch_manifest, 1);

  const correlationReuse = core.execute(request("freeze_batch_manifest", {
    idempotency_key: "idem_retry_second", correlation_id: "corr_retry_001", expected_revision: 1,
  }));
  const idempotencyReuse = core.execute(request("freeze_batch_manifest", {
    idempotency_key: "idem_retry_001", correlation_id: "corr_retry_second", expected_revision: 1,
  }));
  assert.equal(correlationReuse.decision.code, "head_control_correlation_reused");
  assert.equal(idempotencyReuse.decision.code, "head_control_idempotency_reused");
  ok(calls.freeze_batch_manifest === 0 && core.auditSnapshot().length === 3,
    "duplicate retries and key collisions are audited without a second domain mutation");
}

// The replay window is bounded by oldest-first eviction, never by refusing
// service: after more than MAX_IDEMPOTENCY_RECORDS commands the plane still
// answers, recent duplicates still replay, and evicted keys are reusable.
{
  const { core, calls } = plane();
  const total = MAX_IDEMPOTENCY_RECORDS + 8;
  const statusRequest = (index) => request("get_pipeline_status", {
    idempotency_key: `idem_window_${index}`, correlation_id: `corr_window_${index}`,
  });
  for (let index = 0; index < total; index += 1) {
    assert.equal(core.execute(statusRequest(index)).decision.code, "head_control_status_observed");
  }
  assert.equal(calls.get_pipeline_status, total);
  const recent = core.execute(statusRequest(total - 1));
  assert.equal(recent.decision.kind, "replayed");
  assert.equal(calls.get_pipeline_status, total);
  const evicted = core.execute(statusRequest(0));
  assert.equal(evicted.decision.code, "head_control_status_observed");
  assert.equal(calls.get_pipeline_status, total + 1);
  const crossed = core.execute(request("get_pipeline_status", {
    idempotency_key: "idem_window_fresh", correlation_id: `corr_window_${total - 1}`,
  }));
  assert.equal(crossed.decision.code, "head_control_correlation_reused");
  ok(true, "the plane keeps serving past MAX_IDEMPOTENCY_RECORDS by evicting the oldest replay record from both key maps");
}

// Domain result shape is a security boundary too.  A malformed result is
// retained as a fixed denial, instead of being interpreted as a success.
{
  const fake = fakeDomain();
  fake.domain.put_batch_manifest = () => ({ revision: 1, archived: false });
  const core = createHeadControlPlane({ binding, domain: fake.domain });
  const result = core.execute(request("put_batch_manifest", {
    idempotency_key: "idem_bad_domain_001", correlation_id: "corr_bad_domain_001", expected_revision: 0,
  }));
  assert.equal(result.decision.code, "head_control_domain_invalid_status");
  ok(result.decision.kind === "denied", "malformed owning-domain result fails closed");

  const transition = fakeDomain();
  transition.domain.put_batch_manifest = () => status({ revision: 1 });
  const transitionCore = createHeadControlPlane({ binding, domain: transition.domain });
  const transitionResult = transitionCore.execute(request("put_batch_manifest", {
    idempotency_key: "idem_bad_transition_001", correlation_id: "corr_bad_transition_001", expected_revision: 0,
  }));
  ok(transitionResult.decision.code === "head_control_domain_invalid_transition",
    "domain response cannot claim a manifest mutation without its fixed postcondition");
}

// Unsupported actions are rejected at the typed request boundary; M1 cannot
// register dynamic controls or reach routes/MCP/process/delivery surfaces.
{
  assert.throws(() => createHeadControlPlane({ binding, domain: {} }),
    (error) => error instanceof HeadControlPlaneError && error.code === "invalid_head_control_options");
  assert.throws(() => plane().core.execute({ ...request("get_pipeline_status"), action: "publish_delivery" }),
    (error) => error instanceof HeadControlPlaneError && error.code === "head_control_action_unsupported");
  assert.throws(() => plane().core.execute(request("put_batch_manifest", {
    payload: { manifest: { oversized: "x".repeat(128 * 1024 + 1) } },
  })), (error) => error instanceof HeadControlPlaneError && error.code === "invalid_head_control_request");
  assert.throws(() => plane().core.execute(request("put_batch_manifest", {
    payload: { manifest: { invalid: Number.NaN } },
  })), (error) => error instanceof HeadControlPlaneError && error.code === "invalid_head_control_request");
  const source = fs.readFileSync(path.join(__dirname, "head-control-plane.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|child_process|net)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|mcp-chat-shim|project-monitor|file-chat)["']\s*\)/);
  assert.doesNotMatch(source, /(?:setInterval\s*\(|setTimeout\s*\(|compose_delivery|publish_delivery|registerAction)/);
  ok(true, "M1 has no dynamic registration, transport, delivery, or process-control authority");
}

console.log(`\n${passed} passed`);
