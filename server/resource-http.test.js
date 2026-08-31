"use strict";

// Pure boundary tests use fake Express objects and read-only fs/exec fixtures.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CONFIG_PATH } = require("./config");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");
const { createResourceSnapshot } = require("./resource-state");
const { createWorkerUnitBase, scopeUnitFromBase } = require("./resource-unit");
const {
  ResourceRuntimeOwner,
  ResourceRuntimeOwnerError,
  createResourceRuntimeOwner,
  resourceStateFilePath,
} = require("./resource-runtime-owner");
const {
  RESOURCE_HTTP_PATH,
  MAX_RESOURCE_HTTP_BYTES,
  captureResourceHttpSnapshot,
  createResourceHttpHandler,
  registerResourceHttp,
} = require("./resource-http");

const OBSERVED_AT = "2026-08-31T05:00:00.000Z";

function finite(bytes) {
  return { kind: "finite", bytes: String(bytes) };
}

function infinite() {
  return { kind: "infinite" };
}

function limitSet({ low = finite(0), high = infinite(), max = finite(536870912), swap = finite(0) } = {}) {
  return {
    memory_low: low,
    memory_high: high,
    memory_max: max,
    memory_swap_max: swap,
  };
}

function observationUsage(current = "1048576", peak = "2097152") {
  return {
    memory_current_bytes: current,
    memory_peak_bytes: peak,
    memory_swap_current_bytes: "0",
  };
}

function candidateSnapshot() {
  const projectId = "quadwork";
  const generationId = "generation-http";
  const unitBase = createWorkerUnitBase({ projectId, generationId });
  const state = createResourceSnapshot({
    status: "candidate_pending_staging",
    counts: { active_worker_scopes: 1, active_control_children: 0, queued_control_children: 0 },
    limits: {
      host_reserve_mib: 1024,
      max_worker_scopes: 3,
      max_control_children: 2,
      worker_memory_high_mib: 1536,
      worker_memory_max_mib: 2048,
      worker_swap_max_mib: 1024,
      control_memory_max_mib: 512,
      control_swap_max_mib: 512,
      api_memory_low_mib: 384,
      api_memory_max_mib: 768,
      temp_min_free_mib: 4096,
    },
    usage: {
      host_memory_total_mib: 8192,
      host_memory_available_mib: 5000,
      swap_total_mib: 8192,
      swap_free_mib: 7000,
      worker_memory_mib: 1,
      control_memory_mib: 1,
      static_reservation_mib: 8448,
      static_headroom_mib: 0,
      configured_swap_mib: 3584,
      swap_headroom_mib: 4608,
    },
    temp: { disk_backed: true, free_mib: 6000, total_mib: 12000 },
    last_cgroup_oom: null,
    terminal_facts: [],
  });
  const workerLimits = limitSet({
    high: finite(1610612736),
    max: finite(2147483648),
    swap: finite(1073741824),
  });
  return {
    ...state,
    pressure: { status: "candidate_pending_staging", reason: "staging_proof_pending" },
    effective_limits: {
      control: limitSet({ max: finite(536870912), swap: finite(536870912) }),
      worker: { observed_scopes: 1, limits: workerLimits },
    },
    resource_usage: {
      control: observationUsage(),
      worker: {
        observed_scopes: 1,
        memory_current_bytes: "1048576",
        sum_of_scope_peaks_bytes: "2097152",
        memory_swap_current_bytes: "0",
      },
    },
    scope_capacity: {
      admitted_worker_scopes: 1,
      reserved_worker_scopes: 3,
      requested_worker_scopes: 0,
    },
    worker_scopes: [{
      project_id: projectId,
      generation_id: generationId,
      unit_base: unitBase,
      unit_name: scopeUnitFromBase(unitBase),
      observed_at: OBSERVED_AT,
      usage: observationUsage(),
      effective_limits: workerLimits,
    }],
  };
}

class FakeResponse {
  constructor() {
    this.statusCode = null;
    this.headers = Object.create(null);
    this.body = null;
    this.jsonCalls = 0;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(body) {
    this.jsonCalls += 1;
    this.body = body;
    return this;
  }
}

function request(overrides = {}) {
  return { method: "GET", headers: {}, ...overrides };
}

function fakeApp() {
  const registrations = [];
  return {
    registrations,
    get(routePath, handler) { registrations.push({ routePath, handler }); },
  };
}

function missingConfigOwner() {
  const fsImpl = Object.create(fs);
  Object.defineProperty(fsImpl, "readFileSync", {
    value(target, ...args) {
      if (String(target) === CONFIG_PATH) {
        const error = new Error("missing config");
        error.code = "ENOENT";
        throw error;
      }
      return fs.readFileSync(target, ...args);
    },
  });
  return createResourceRuntimeOwner({ fsImpl, homeDir: "/tmp" });
}

function configuredOwner(homeDir) {
  const fsImpl = Object.create(fs);
  Object.defineProperty(fsImpl, "readFileSync", {
    value(target, ...args) {
      if (String(target) === CONFIG_PATH) {
        return JSON.stringify({ runtime_resources: DEFAULT_RUNTIME_RESOURCE_PROPOSAL });
      }
      return fs.readFileSync(target, ...args);
    },
  });
  return createResourceRuntimeOwner({
    fsImpl,
    homeDir,
    execFileSyncImpl() {
      const error = new Error("read-only provider unavailable");
      error.code = "ENOENT";
      throw error;
    },
  });
}

function mount(owner, app = fakeApp()) {
  const handler = registerResourceHttp(app, owner);
  assert.equal(app.registrations.length, 1);
  assert.equal(app.registrations[0].routePath, RESOURCE_HTTP_PATH);
  assert.equal(app.registrations[0].handler, handler);
  return { app, handler };
}

function invoke(handler, requestValue = request()) {
  const response = new FakeResponse();
  const result = handler(requestValue, response);
  assert.equal(result, response);
  assert.equal(response.jsonCalls, 1);
  assert.equal(response.headers["cache-control"], "no-store, no-cache, must-revalidate");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.expires, "0");
  return response;
}

function assertUnavailable(response, expectedStatus = 503, expectedCode = "QW_RESOURCE_SNAPSHOT_UNAVAILABLE") {
  assert.equal(response.statusCode, expectedStatus);
  assert.deepEqual(response.body, {
    version: 1,
    status: "unavailable",
    code: expectedCode,
    reason: expectedCode === "QW_RESOURCE_HTTP_METHOD_NOT_ALLOWED"
      ? "method_not_allowed"
      : expectedCode === "QW_RESOURCE_HTTP_BODY_NOT_ALLOWED"
        ? "request_body_not_allowed"
        : "resource_snapshot_unavailable",
  });
}

// Schema capture is a pure, authority-free operation. A valid candidate is
// copied without dropping runtime fields and remains within the response cap.
{
  const source = candidateSnapshot();
  const captured = captureResourceHttpSnapshot(source);
  assert(captured);
  assert.notEqual(captured, source);
  assert.equal(captured.status, "candidate_pending_staging");
  assert.deepEqual(captured.worker_scopes, source.worker_scopes);
  assert.deepEqual(captured.effective_limits, source.effective_limits);
  assert(Buffer.byteLength(JSON.stringify(captured), "utf8") < MAX_RESOURCE_HTTP_BYTES);
}

// Unknown fields, accessors, exotic prototypes, proxies, invalid state, cycles,
// and oversized values fail schema capture without invoking accessors/toJSON.
{
  const secret = "SECRET_SCHEMA /private/runtime";
  const attacks = [];
  attacks.push({ ...candidateSnapshot(), secret });
  const nested = candidateSnapshot();
  nested.pressure = { ...nested.pressure, secret };
  attacks.push(nested);
  const accessor = candidateSnapshot();
  let accessorCalls = 0;
  Object.defineProperty(accessor, "pressure", {
    enumerable: true,
    get() { accessorCalls += 1; throw new Error(secret); },
  });
  attacks.push(accessor);
  const symbolic = candidateSnapshot();
  symbolic[Symbol("secret")] = secret;
  attacks.push(symbolic);
  const hooked = candidateSnapshot();
  hooked.toJSON = () => ({ secret });
  attacks.push(hooked);
  attacks.push(Object.assign(Object.create({ secret }), candidateSnapshot()));
  attacks.push(new Proxy(candidateSnapshot(), { ownKeys() { throw new Error(secret); } }));
  const circular = candidateSnapshot();
  circular.pressure.self = circular;
  attacks.push(circular);
  const oversized = candidateSnapshot();
  oversized.worker_scopes[0].project_id = "x".repeat(MAX_RESOURCE_HTTP_BYTES + 1);
  attacks.push(oversized);
  attacks.push({ ...candidateSnapshot(), version: 2 });
  attacks.push({ ...candidateSnapshot(), status: "supported" });
  const fakeReady = {
    ...candidateSnapshot(),
    status: "ready",
    pressure: { status: "ready", reason: "ok" },
    effective_limits: null,
    resource_usage: null,
  };
  attacks.push(fakeReady);
  const missing = candidateSnapshot();
  delete missing.resource_usage;
  attacks.push(missing);
  for (const attack of attacks) assert.equal(captureResourceHttpSnapshot(attack), null);
  assert.equal(accessorCalls, 0);
}

// A genuine missing-policy owner publishes one canonical synchronous snapshot.
// Method/body rejection occurs before publication and always sets no-cache.
{
  const owner = missingConfigOwner();
  const { handler } = mount(owner);
  const response = invoke(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "invalid_resource_policy");
  assert.equal(response.body.pressure.reason, "policy_invalid_or_absent");

  const method = invoke(handler, request({ method: "POST" }));
  assertUnavailable(method, 405, "QW_RESOURCE_HTTP_METHOD_NOT_ALLOWED");
  assert.equal(method.headers.allow, "GET");
  assertUnavailable(invoke(handler, request({ body: {} })), 400, "QW_RESOURCE_HTTP_BODY_NOT_ALLOWED");
  assertUnavailable(
    invoke(handler, request({ headers: { "content-length": "1" } })),
    400,
    "QW_RESOURCE_HTTP_BODY_NOT_ALLOWED",
  );
  assertUnavailable(
    invoke(handler, request({ headers: { "transfer-encoding": "chunked" } })),
    400,
    "QW_RESOURCE_HTTP_BODY_NOT_ALLOWED",
  );
}

// Registration is owner- and app-idempotent. The same owner cannot move to a
// second app and the same app cannot be rebound to a second owner.
{
  const owner = missingConfigOwner();
  const app = fakeApp();
  const first = registerResourceHttp(app, owner);
  assert.equal(registerResourceHttp(app, owner), first);
  assert.equal(app.registrations.length, 1);
  assert.throws(
    () => registerResourceHttp(fakeApp(), owner),
    (error) => error.code === "QW_RESOURCE_HTTP_ALREADY_REGISTERED",
  );
  assert.throws(
    () => registerResourceHttp(app, missingConfigOwner()),
    (error) => error.code === "QW_RESOURCE_HTTP_ALREADY_REGISTERED",
  );
  assert.throws(() => registerResourceHttp({}, owner), /app\.get must be a function/);
}

// The public registrar cannot brand arbitrary providers or owner lookalikes.
// Low-level handler construction remains inert and never invokes them.
{
  let providerCalls = 0;
  const provider = { snapshot() { providerCalls += 1; return candidateSnapshot(); } };
  const lookalike = Object.create(ResourceRuntimeOwner.prototype);
  const proxy = new Proxy(missingConfigOwner(), {});
  const revoked = Proxy.revocable(missingConfigOwner(), {});
  revoked.revoke();
  for (const candidate of [provider, function fakeOwner() {}, lookalike, proxy, revoked.proxy]) {
    const app = fakeApp();
    assert.throws(
      () => registerResourceHttp(app, candidate),
      (error) => error instanceof ResourceRuntimeOwnerError
        && error.code === "QW_RESOURCE_OWNER_INVALID",
    );
    assert.equal(app.registrations.length, 0);
  }
  const lowLevel = createResourceHttpHandler(provider);
  assertUnavailable(invoke(lowLevel));
  assert.equal(providerCalls, 0);
}

// A configured genuine owner remains synchronous and read-only at HTTP: its
// typed non-ready snapshot is HTTP 200 and GET never creates durable state.
{
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-http-owner-"));
  fs.mkdirSync(path.join(homeDir, ".quadwork"), { mode: 0o700 });
  const owner = configuredOwner(homeDir);
  const statePath = resourceStateFilePath(homeDir);
  const { handler } = mount(owner);
  const response = invoke(handler);
  assert.equal(response.statusCode, 200);
  assert.notEqual(response.body.status, "invalid_resource_policy");
  assert.equal(fs.existsSync(statePath), false);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

async function settleUnhandledTurn() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// Post-mount prototype replacement is ignored because the handler owns the
// private attestation closure. Rejected-Promise factories on unrecognized
// providers are never invoked, so constructor/species access and unhandled
// rejection events remain at zero.
(async () => {
  const secret = "PRIVATE_ASYNC /private/provider";
  const unhandled = [];
  const handledLate = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  const onHandledLate = (promise) => handledLate.push(promise);
  process.on("unhandledRejection", onUnhandled);
  process.on("rejectionHandled", onHandledLate);
  const originalSnapshot = ResourceRuntimeOwner.prototype.snapshot;
  try {
    const owner = missingConfigOwner();
    const { handler } = mount(owner);
    let replacementCalls = 0;
    ResourceRuntimeOwner.prototype.snapshot = function hostileReplacement() {
      replacementCalls += 1;
      return Promise.reject(new Error(secret));
    };
    const response = invoke(handler);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "invalid_resource_policy");
    assert.equal(replacementCalls, 0);

    const calls = { provider: 0, constructor: 0, species: 0 };
    const constructorProvider = {
      snapshot() {
        calls.provider += 1;
        const promise = Promise.reject(new Error(secret));
        Object.defineProperty(promise, "constructor", {
          get() { calls.constructor += 1; throw new Error(secret); },
        });
        return promise;
      },
    };
    const speciesProvider = {
      snapshot() {
        calls.provider += 1;
        const constructor = Object.defineProperty({}, Symbol.species, {
          get() { calls.species += 1; throw new Error(secret); },
        });
        const promise = Promise.reject(new Error(secret));
        Object.defineProperty(promise, "constructor", { value: constructor });
        return promise;
      },
    };
    for (const provider of [
      constructorProvider,
      speciesProvider,
      { async snapshot() { calls.provider += 1; throw new Error(secret); } },
      { snapshot() { calls.provider += 1; return Promise.reject(new Error(secret)); } },
    ]) {
      assert.throws(
        () => registerResourceHttp(fakeApp(), provider),
        (error) => error.code === "QW_RESOURCE_OWNER_INVALID",
      );
      assertUnavailable(invoke(createResourceHttpHandler(provider)));
    }

    await settleUnhandledTurn();
    assert.deepEqual(calls, { provider: 0, constructor: 0, species: 0 });
    assert.deepEqual(unhandled, []);
    assert.deepEqual(handledLate, []);
    assert.equal(response.jsonCalls, 1);
    assert.equal(JSON.stringify(response.body).includes(secret), false);
  } finally {
    ResourceRuntimeOwner.prototype.snapshot = originalSnapshot;
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("rejectionHandled", onHandledLate);
  }
  console.log("resource-http.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
