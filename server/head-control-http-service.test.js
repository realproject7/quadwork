"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHeadControlAuditStore, DIRECTORY_MODE } = require("./head-control-audit-store");
const { createHeadControlService } = require("./head-control-service");
const { API_PATH, createHeadControlHttpService } = require("./head-control-http-service");

const TOKEN = "correct-token-never-returned";
const AUTH = Object.freeze({ project_id: "quadwork", actor: "head", generation: 7 });
const LIVE = Object.freeze({
  installation_id: "installationhttp001",
  project_id: "quadwork",
  actor: "head",
  generation: 7,
  active: true,
  archived: false,
});
const OWNER = Object.freeze({
  installation_id: LIVE.installation_id,
  project_id: LIVE.project_id,
  role: "head",
  generation: LIVE.generation,
});
const MANIFEST = "a".repeat(64);
const PIPELINE = "b".repeat(64);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
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

function fakeDomain() {
  let current = status();
  const calls = { get_pipeline_status: 0, put_batch_manifest: 0, freeze_batch_manifest: 0, cut_batch: 0 };
  const domain = {
    get_pipeline_status(input) {
      calls.get_pipeline_status += 1;
      assert.deepEqual(input.binding, OWNER);
      return clone(current);
    },
    put_batch_manifest(input) {
      calls.put_batch_manifest += 1;
      assert.equal(input.expected_revision, current.revision);
      current = status({ revision: current.revision + 1, manifest_digest: MANIFEST });
      return clone(current);
    },
    freeze_batch_manifest(input) {
      calls.freeze_batch_manifest += 1;
      assert.equal(input.expected_revision, current.revision);
      current = status({
        revision: current.revision + 1,
        manifest_digest: current.manifest_digest || MANIFEST,
        pipeline_digest: PIPELINE,
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
        pipeline_digest: "c".repeat(64),
        manifest_frozen: true,
        cut_safe: false,
      });
      return clone(current);
    },
  };
  return { domain, calls };
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-http-"));
  fs.chmodSync(directory, DIRECTORY_MODE);
  return directory;
}

function request(tool, argumentsValue, overrides = {}) {
  return {
    method: "POST",
    path: API_PATH,
    body: {
      version: 1,
      binding: clone(AUTH),
      request: { tool, arguments: argumentsValue },
    },
    ...overrides,
  };
}

function statusArguments(suffix = "one") {
  return { idempotency_key: `idem_http_status_${suffix}`, correlation_id: `corr_http_status_${suffix}` };
}

function createFixture(overrides = {}) {
  const fake = fakeDomain();
  const durable = createHeadControlAuditStore({ config_dir: temporaryDirectory(), fs });
  const core = createHeadControlService({ binding: OWNER, domain: fake.domain, audit_store: durable });
  const authCalls = { authenticate: 0, resolveBinding: 0, resolveService: 0 };
  const handler = createHeadControlHttpService({
    authenticateToken(context) {
      authCalls.authenticate += 1;
      if (context?.token !== TOKEN) throw new Error(`bad token ${context?.token || ""}`);
      return overrides.authenticated || AUTH;
    },
    resolveLaunchBinding(authenticated) {
      authCalls.resolveBinding += 1;
      assert.deepEqual(authenticated, AUTH);
      if (overrides.resolveLaunchBinding) return overrides.resolveLaunchBinding(authenticated);
      return LIVE;
    },
    resolveHeadControlService(binding) {
      authCalls.resolveService += 1;
      assert.deepEqual(binding, OWNER);
      if (overrides.resolveHeadControlService) return overrides.resolveHeadControlService(binding);
      return core;
    },
  });
  return { handler, authCalls, core, ...fake };
}

function error(result, type) {
  assert.deepEqual(result, { ok: false, error: { type } });
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// The adapter sees the public envelope, but the binding used for the service
// is rebuilt from the authenticated and live proofs rather than caller data.
{
  const fixture = createFixture();
  const argumentsValue = statusArguments();
  const first = fixture.handler.handle(request("get_pipeline_status", argumentsValue), { token: TOKEN });
  assert.equal(first.ok, true);
  assert.equal(first.result.decision.kind, "accepted");
  assert.deepEqual(first.result.audit.binding, OWNER);
  assert.deepEqual(fixture.authCalls, { authenticate: 1, resolveBinding: 1, resolveService: 1 });
  assert.equal(fixture.calls.get_pipeline_status, 1);
  ok(true, "authenticated Head binding is re-proved before the fixed service command");

  const replay = fixture.handler.handle(request("get_pipeline_status", argumentsValue), { token: TOKEN });
  assert.equal(replay.ok, true);
  assert.equal(replay.result.decision.kind, "replayed");
  assert.equal(fixture.calls.get_pipeline_status, 1);
  ok(true, "an exact idempotent replay stays inside the service receipt and does not re-run the domain");

  const audit = fixture.handler.handle(request("recent_head_control_audit", {}), { token: TOKEN });
  assert.equal(audit.ok, true);
  assert.equal(audit.result.length, 1);
  assert.deepEqual(audit.result[0].binding, OWNER);
  ok(true, "the static audit read returns only the validated bounded durable receipt shape");
}

// Each static tool maps to exactly one M1 command.  No client action selector
// or caller-supplied principal reaches the fixed domain surface.
{
  const fixture = createFixture();
  const put = fixture.handler.handle(request("put_batch_manifest", {
    expected_revision: 0,
    idempotency_key: "idem_http_put_one",
    correlation_id: "corr_http_put_one",
    manifest: { version: 1, tasks: [] },
  }), { token: TOKEN });
  assert.equal(put.ok, true);
  assert.equal(put.result.result.action, "put_batch_manifest");
  assert.equal(fixture.calls.put_batch_manifest, 1);

  const freeze = fixture.handler.handle(request("freeze_batch_manifest", {
    expected_revision: 1,
    idempotency_key: "idem_http_freeze_one",
    correlation_id: "corr_http_freeze_one",
  }), { token: TOKEN });
  assert.equal(freeze.ok, true);
  assert.equal(fixture.calls.freeze_batch_manifest, 1);

  const cut = fixture.handler.handle(request("cut_batch", {
    expected_revision: 2,
    idempotency_key: "idem_http_cut_one",
    correlation_id: "corr_http_cut_one",
    cut: { tasks: [{ exact_task: "task-one" }] },
  }), { token: TOKEN });
  assert.equal(cut.ok, true);
  assert.equal(fixture.calls.cut_batch, 1);
  ok(true, "put, freeze, and cut preserve only their static M1 command mappings");
}

{
  const fixture = createFixture();
  const unauthorized = fixture.handler.handle(request("get_pipeline_status", statusArguments("auth")), { token: "wrong-token" });
  error(unauthorized, "authentication_failed");
  assert.equal(fixture.authCalls.resolveBinding, 0);
  assert.equal(fixture.authCalls.resolveService, 0);
  assert(!JSON.stringify(unauthorized).includes("wrong-token"));
  ok(true, "a wrong credential cannot reach either resolver and is never echoed");
}

for (const [label, mutate] of [
  ["project", (body) => { body.binding.project_id = "other"; }],
  ["actor", (body) => { body.binding.actor = "dev"; }],
  ["generation", (body) => { body.binding.generation = 8; }],
]) {
  const fixture = createFixture();
  const forged = request("get_pipeline_status", statusArguments(`forged_${label}`));
  mutate(forged.body);
  error(fixture.handler.handle(forged, { token: TOKEN }), "binding_mismatch");
  assert.equal(fixture.authCalls.resolveBinding, 0);
  assert.equal(fixture.authCalls.resolveService, 0);
  ok(true, `a forged ${label} binding is rejected before live or service resolution`);
}

{
  const fixture = createFixture();
  const malformedSelector = request("get_pipeline_status", { ...statusArguments("selector"), action: "cut_batch" });
  error(fixture.handler.handle(malformedSelector, { token: TOKEN }), "invalid_request");
  const unknownTool = request("publish_batch", {});
  error(fixture.handler.handle(unknownTool, { token: TOKEN }), "invalid_request");
  const wrongPath = fixture.handler.handle({ ...request("get_pipeline_status", statusArguments("path")), path: "/api/other" }, { token: TOKEN });
  error(wrongPath, "not_found");
  assert.equal(fixture.authCalls.resolveService, 0);
  ok(true, "unknown selectors, tools, and endpoints cannot become generic service operations");
}

for (const [label, live] of [
  ["inactive", { ...LIVE, active: false }],
  ["archived", { ...LIVE, archived: true }],
  ["stale", { ...LIVE, generation: LIVE.generation + 1 }],
]) {
  const fixture = createFixture({ resolveLaunchBinding: () => live });
  const result = fixture.handler.handle(request("get_pipeline_status", statusArguments(label)), { token: TOKEN });
  error(result, label === "stale" ? "binding_mismatch" : "binding_inactive");
  assert.equal(fixture.authCalls.resolveService, 0);
  ok(true, `${label} live launch state fails closed before the Head-control service`);
}

// A service result is another untrusted boundary.  Its malformed fields and
// thrown messages must not become an HTTP response or leak a secret.
{
  const fixture = createFixture({
    resolveHeadControlService() {
      return {
        binding: OWNER,
        execute() { return { version: 1, decision: { kind: "accepted", code: "head_control_ok" }, result: { secret: TOKEN }, audit: null }; },
        recentAudit() { return []; },
      };
    },
  });
  const malformed = fixture.handler.handle(request("get_pipeline_status", statusArguments("malformed_result")), { token: TOKEN });
  error(malformed, "service_unavailable");
  assert(!JSON.stringify(malformed).includes(TOKEN));
  ok(true, "a malformed or secret-bearing service result is redacted to one bounded error type");
}

{
  assert.throws(() => createHeadControlHttpService({
    authenticateToken() {}, resolveLaunchBinding() {}, resolveHeadControlService() {}, extra: true,
  }), TypeError);
  const source = fs.readFileSync(path.join(__dirname, "head-control-http-service.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(/);
  assert.doesNotMatch(source, /express|createServer|listen\s*\(|github|file-chat|monitor|worker|recovery|child_process|exec\s*\(|spawn\s*\(|(?:node:)?fs|shell/i);
  ok(true, "the adapter has no listener, filesystem, shell, chat, monitor, worker, or GitHub capability");
}

console.log(`\n${passed} passed`);
