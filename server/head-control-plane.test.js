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
function request(action, overrides = {}) {
  const payload = action === "get_pipeline_status" || action === "freeze_batch_manifest"
    ? null
    : action === "put_batch_manifest"
      ? { manifest: { version: 1, tasks: [] } }
      : { cut: { tasks: [{ exact_task: "task-one" }] } };
  return {
    version: VERSION,
    action,
    principal: copy(binding),
    expected_revision: action === "get_pipeline_status" ? null : 0,
    idempotency_key: "idem_request_001",
    correlation_id: "corr_request_001",
    payload,
    ...overrides,
  };
}
function fakeDomain(initial = status()) {
  let current = copy(initial);
  const calls = { get_pipeline_status: 0, put_batch_manifest: 0, freeze_batch_manifest: 0, cut_batch: 0 };
  const domain = {
    get_pipeline_status(input) {
      calls.get_pipeline_status += 1;
      assert.equal(input.binding.role, "head");
      return copy(current);
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
  ok(JSON.stringify(ACTIONS) === JSON.stringify(["get_pipeline_status", "put_batch_manifest", "freeze_batch_manifest", "cut_batch"]),
    "only the four named M1 pipeline actions are exposed");
  ok(calls.get_pipeline_status === 4 && calls.put_batch_manifest === 1 && calls.freeze_batch_manifest === 1 && calls.cut_batch === 1,
    "each accepted action delegates once to its fixed owning pipeline action");

  const audit = core.auditSnapshot();
  assert.equal(audit.length, 4);
  assert.deepEqual(Object.keys(audit[0]).sort(), ["action", "binding", "code", "correlation_id", "decision", "expected_revision", "idempotency_key", "result", "version"]);
  assert.equal(audit[0].result.status.pipeline_digest, null);
  ok(Object.isFrozen(cut) && Object.isFrozen(cut.audit) && Object.isFrozen(audit),
    "decision, result, and bounded audit records are immutable fixed shapes");
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
