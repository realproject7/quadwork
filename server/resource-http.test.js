"use strict";

// Pure HTTP-boundary tests: no socket, filesystem, process, probe, persistence,
// configuration, or host mutation is used.

const assert = require("node:assert/strict");
const { createResourceSnapshot } = require("./resource-state");
const { createResourceRuntimeService } = require("./resource-runtime-service");
const { createWorkerUnitBase, scopeUnitFromBase } = require("./resource-unit");
const {
  RESOURCE_HTTP_PATH,
  MAX_RESOURCE_HTTP_BYTES,
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
    counts: {
      active_worker_scopes: 1,
      active_control_children: 0,
      queued_control_children: 0,
    },
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

function invoke(service, requestValue = request()) {
  const response = new FakeResponse();
  const result = createResourceHttpHandler(service)(requestValue, response);
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

// A candidate is a valid observable state, not an HTTP error. All runtime
// additions survive the boundary and no persistence-like method is touched.
{
  const source = candidateSnapshot();
  let snapshots = 0;
  let writes = 0;
  const service = {
    snapshot() {
      snapshots += 1;
      return source;
    },
    persist() {
      writes += 1;
      throw new Error("HTTP must never persist");
    },
  };
  const response = invoke(service);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "candidate_pending_staging");
  assert.deepEqual(response.body.worker_scopes, source.worker_scopes);
  assert.deepEqual(response.body.effective_limits, source.effective_limits);
  assert.deepEqual(response.body.resource_usage, source.resource_usage);
  assert.notEqual(response.body, source, "the response is a descriptor-snapshotted copy");
  assert.equal(snapshots, 1);
  assert.equal(writes, 0);
  assert(Buffer.byteLength(JSON.stringify(response.body), "utf8") < MAX_RESOURCE_HTTP_BYTES);
}

// Direct invocation still enforces GET-only and bodyless semantics before the
// service is called. Express registration additionally publishes Allow: GET.
{
  let snapshots = 0;
  const service = { snapshot() { snapshots += 1; return candidateSnapshot(); } };
  const method = invoke(service, request({ method: "POST" }));
  assertUnavailable(method, 405, "QW_RESOURCE_HTTP_METHOD_NOT_ALLOWED");
  assert.equal(method.headers.allow, "GET");
  const body = invoke(service, request({ body: {} }));
  assertUnavailable(body, 400, "QW_RESOURCE_HTTP_BODY_NOT_ALLOWED");
  const contentLength = invoke(service, request({ headers: { "content-length": "1" } }));
  assertUnavailable(contentLength, 400, "QW_RESOURCE_HTTP_BODY_NOT_ALLOWED");
  const transfer = invoke(service, request({ headers: { "transfer-encoding": "chunked" } }));
  assertUnavailable(transfer, 400, "QW_RESOURCE_HTTP_BODY_NOT_ALLOWED");
  assert.equal(snapshots, 0);
}

// Exceptions and accessor/proxy failures collapse to one typed response. No
// raw failure string, host path, or getter-derived value is retained.
{
  const secret = "SECRET_RUNTIME_TOKEN /private/runtime/path";
  const thrown = invoke({ snapshot() { throw new Error(secret); } });
  assertUnavailable(thrown);
  assert.equal(JSON.stringify(thrown.body).includes(secret), false);

  let getterCalls = 0;
  const getterService = {};
  Object.defineProperty(getterService, "snapshot", {
    get() {
      getterCalls += 1;
      throw new Error(secret);
    },
  });
  assertUnavailable(invoke(getterService));
  assert.equal(getterCalls, 0);

  const proxyService = {
    snapshot: new Proxy(function snapshot() {}, {
      apply() { throw new Error(secret); },
    }),
  };
  assertUnavailable(invoke(proxyService));
}

// The service cannot smuggle fields through a valid-looking top-level status,
// nested metadata, toJSON hook, accessor, symbolic key, or exotic prototype.
{
  const secret = "SECRET_RESULT /sys/fs/cgroup/private";
  const attacks = [];

  attacks.push({ ...candidateSnapshot(), secret });
  const nested = candidateSnapshot();
  nested.pressure = { ...nested.pressure, secret };
  attacks.push(nested);

  const accessor = candidateSnapshot();
  let accessorCalls = 0;
  Object.defineProperty(accessor, "pressure", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return { status: "ready", reason: secret };
    },
  });
  attacks.push(accessor);

  const symbolic = candidateSnapshot();
  symbolic[Symbol("secret")] = secret;
  attacks.push(symbolic);

  const hooked = candidateSnapshot();
  hooked.toJSON = () => ({ secret });
  attacks.push(hooked);

  const exotic = Object.assign(Object.create({ secret }), candidateSnapshot());
  attacks.push(exotic);

  attacks.push(new Proxy(candidateSnapshot(), {
    ownKeys() { throw new Error(secret); },
  }));

  for (const attack of attacks) {
    const response = invoke({ snapshot() { return attack; } });
    assertUnavailable(response);
    assert.equal(JSON.stringify(response.body).includes(secret), false);
  }
  assert.equal(accessorCalls, 0);
}

// Circular and oversized graphs fail before res.json sees them. Invalid
// version/status/missing keys and Promise-like service results are also 503.
{
  const circular = candidateSnapshot();
  circular.pressure.self = circular;
  const oversized = candidateSnapshot();
  oversized.worker_scopes[0].project_id = "x".repeat(MAX_RESOURCE_HTTP_BYTES + 1);
  const invalidVersion = { ...candidateSnapshot(), version: 2 };
  const invalidStatus = { ...candidateSnapshot(), status: "supported" };
  const fakeReady = {
    ...candidateSnapshot(),
    status: "ready",
    pressure: { status: "ready", reason: "ok" },
    effective_limits: null,
    resource_usage: null,
  };
  const missing = candidateSnapshot();
  delete missing.resource_usage;
  for (const value of [
    circular, oversized, invalidVersion, invalidStatus, fakeReady, missing,
    Promise.resolve(candidateSnapshot()),
  ]) {
    assertUnavailable(invoke({ snapshot() { return value; } }));
  }
}

// Registration is a pure mount operation and returns the exact handler for
// later composition by index/routes without collecting a snapshot.
{
  let mounted;
  let snapshots = 0;
  const app = {
    get(path, handler) {
      mounted = { path, handler };
    },
  };
  const service = { snapshot() { snapshots += 1; return candidateSnapshot(); } };
  const handler = registerResourceHttp(app, service);
  assert.equal(mounted.path, RESOURCE_HTTP_PATH);
  assert.equal(mounted.handler, handler);
  assert.equal(snapshots, 0);
  const response = new FakeResponse();
  handler(request(), response);
  assert.equal(response.statusCode, 200);
  assert.equal(snapshots, 1);
  assert.throws(() => registerResourceHttp({}, service), /app\.get must be a function/);
}

// The production service's canonical invalid-policy snapshot is still a valid
// read-only observation and therefore remains HTTP 200 rather than being
// confused with a service/serialization failure.
{
  const service = createResourceRuntimeService({
    runtimeResources: null,
    probes: {},
    controllerAdapter: { snapshot() { return null; } },
    observationProvider: {
      observeApiSelf() { return null; },
      observeControlAggregate() { return null; },
      observeWorker() { return null; },
    },
  });
  const response = invoke(service);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "invalid_resource_policy");
  assert.equal(response.body.pressure.reason, "policy_invalid_or_absent");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleUnhandledTurn() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// Native async results are never awaited and can never send a late response,
// but both settlement paths are consumed so they cannot create a process-level
// unhandled rejection. Caller-owned thenables are rejected without invocation.
(async () => {
  const secret = "ASYNC-SNAPSHOT-SECRET /private/provider/path";
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const rejected = invoke({ async snapshot() { throw new Error(secret); } });
    assertUnavailable(rejected);

    const lateResolve = deferred();
    const resolvedResponse = invoke({ snapshot() { return lateResolve.promise; } });
    const resolvedBody = resolvedResponse.body;
    lateResolve.resolve(candidateSnapshot());

    const lateReject = deferred();
    const rejectedResponse = invoke({ snapshot() { return lateReject.promise; } });
    const rejectedBody = rejectedResponse.body;
    lateReject.reject(new Error(secret));

    let nativeThenGetterCalls = 0;
    const accessorPromise = Promise.reject(new Error(secret));
    Object.defineProperty(accessorPromise, "then", {
      configurable: true,
      get() {
        nativeThenGetterCalls += 1;
        throw new Error(secret);
      },
    });
    const accessorPromiseResponse = invoke({ snapshot() { return accessorPromise; } });

    let thenCalls = 0;
    let thenableMutations = 0;
    const customThenable = {
      then() {
        thenCalls += 1;
        thenableMutations += 1;
        throw new Error(secret);
      },
    };
    const customResponse = invoke({ snapshot() { return customThenable; } });

    let accessorCalls = 0;
    const accessorThenable = {};
    Object.defineProperty(accessorThenable, "then", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error(secret);
      },
    });
    const accessorResponse = invoke({ snapshot() { return accessorThenable; } });

    const hostileProxy = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error(secret); },
      getPrototypeOf() { throw new Error(secret); },
    });
    const proxyResponse = invoke({ snapshot() { return hostileProxy; } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const revokedResponse = invoke({ snapshot() { return revoked.proxy; } });

    await settleUnhandledTurn();
    assert.deepEqual(unhandled, []);
    assert.equal(nativeThenGetterCalls, 0, "native Promise consumption bypasses hostile own then accessors");
    assert.equal(thenCalls, 0, "caller-owned thenables are identified without assimilation");
    assert.equal(thenableMutations, 0);
    assert.equal(accessorCalls, 0, "then accessors are rejected without invocation");
    for (const [response, originalBody] of [
      [rejected, rejected.body],
      [resolvedResponse, resolvedBody],
      [rejectedResponse, rejectedBody],
      [accessorPromiseResponse, accessorPromiseResponse.body],
      [customResponse, customResponse.body],
      [accessorResponse, accessorResponse.body],
      [proxyResponse, proxyResponse.body],
      [revokedResponse, revokedResponse.body],
    ]) {
      assertUnavailable(response);
      assert.equal(response.jsonCalls, 1);
      assert.equal(response.body, originalBody, "late settlement cannot replace the sent body");
      assert.equal(JSON.stringify(response.body).includes(secret), false);
    }
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  console.log("resource-http.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
