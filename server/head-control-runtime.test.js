"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHeadControlRuntime } = require("./head-control-runtime");

const installation_id = "installationruntime01";
const project_id = "quadwork";
const generation = 7;
const token = "head-control-runtime-token-0001";
const replacement = "head-control-runtime-token-0002";

function request(overrides = {}) {
  return {
    method: "POST",
    path: "/api/head-control",
    body: {
      version: 1,
      binding: { project_id, actor: "head", generation },
      request: {
        tool: "get_pipeline_status",
        arguments: { idempotency_key: "idem_runtime_status", correlation_id: "corr_runtime_status" },
      },
    },
    ...overrides,
  };
}

function fixture() {
  const config_dir = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-runtime-"));
  let archived = false;
  const sessions = new Map([[`${project_id}/head`, {
    projectId: project_id, agentId: "head", state: "running", term: {}, lifecycleState: "verified",
  }]]);
  const config = () => ({ installation_id, projects: [{ id: project_id, archived }] });
  const runtime = createHeadControlRuntime({
    config_dir,
    fs,
    read_config: config,
    capture_project_admission(id) {
      if (id !== project_id || archived) throw new Error("stale admission");
      return { project_id, generation };
    },
    is_project_archived(id) { return id !== project_id || archived; },
    resolve_shim_principal(candidate) {
      return candidate === token || candidate === replacement ? { projectId: project_id, agentId: "head" } : null;
    },
    agent_sessions: sessions,
    read_live_batch_context() { return null; },
    read_repository_state() { return null; },
    read_cached_repository_snapshot() { return null; },
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  return {
    runtime,
    sessions,
    archive() { archived = true; },
    cleanup() { fs.rmSync(config_dir, { recursive: true, force: true }); },
  };
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

{
  const live = fixture();
  try {
    assert.deepEqual(live.runtime.registerHeadToken({ project_id, generation, token }), { project_id, actor: "head", generation });
    const first = live.runtime.handle(request(), { token });
    assert.equal(first.ok, true);
    assert.equal(first.result.decision.kind, "accepted");
    assert.equal(first.result.result.status.revision, 0);
    const retry = live.runtime.handle(request(), { token });
    assert.equal(retry.ok, true);
    assert.equal(retry.result.decision.kind, "replayed");
    ok(true, "one current file-chat Head token composes the durable service and preserves its receipt");

    live.runtime.registerHeadToken({ project_id, generation, token: replacement });
    const old = live.runtime.handle(request(), { token });
    assert.deepEqual(old, { ok: false, error: { type: "authentication_failed" } });
    const fresh = live.runtime.handle(request({ body: {
      version: 1,
      binding: { project_id, actor: "head", generation },
      request: { tool: "get_pipeline_status", arguments: { idempotency_key: "idem_runtime_new", correlation_id: "corr_runtime_new" } },
    } }), { token: replacement });
    assert.equal(fresh.ok, true);
    ok(true, "a replacement launch revokes the preceding Head token before any service lookup");

    live.sessions.delete(`${project_id}/head`);
    const inactive = live.runtime.handle(request({ body: {
      version: 1,
      binding: { project_id, actor: "head", generation },
      request: { tool: "get_pipeline_status", arguments: { idempotency_key: "idem_runtime_idle", correlation_id: "corr_runtime_idle" } },
    } }), { token: replacement });
    assert.deepEqual(inactive, { ok: false, error: { type: "binding_inactive" } });
    ok(true, "a stopped or unverified Head has no mutable control authority");

    const revoked = live.runtime.revokeProject(project_id);
    assert.equal(revoked.ok, true);
    assert(revoked.resources.head_control_bindings >= 1);
    const after = live.runtime.handle(request({ body: {
      version: 1,
      binding: { project_id, actor: "head", generation },
      request: { tool: "get_pipeline_status", arguments: { idempotency_key: "idem_runtime_revoked", correlation_id: "corr_runtime_revoked" } },
    } }), { token: replacement });
    assert.deepEqual(after, { ok: false, error: { type: "authentication_failed" } });
    ok(true, "project cleanup removes the in-memory Head credential and cached service binding");
  } finally {
    live.cleanup();
  }
}

console.log(`\n${passed} passed`);
