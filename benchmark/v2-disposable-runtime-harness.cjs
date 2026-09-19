"use strict";

// #1037 Unit B: a deliberately local-only HTTP harness for the fixed V2
// WorkTask build and review transports.  It composes the same runtime and
// durable services as server/index.js, but it is not an alternate server
// entrypoint: callers must provide an empty disposable config directory and a
// synthetic local session registry. Its public start method binds loopback only.
//
// This module has no provider, MCP, GitHub, Git, npm, release, or process
// execution capability.  Its role tokens establish the server-side role
// binding exercised by the route tests; they are not provider identities and
// must never be recorded as a live benchmark authentication claim.

const http = require("node:http");
const { createWorkTaskBuildRuntime } = require("../server/work-task-build-runtime");
const { createWorkTaskReviewRuntime } = require("../server/work-task-review-runtime");
const { createLiveWorkTaskIdentityResolver } = require("../server/live-work-task-identity-resolver");
const { createWorkTaskBuildAssignmentService } = require("../server/work-task-build-assignment-service");
const { createWorkTaskIndependentReviewService } = require("../server/work-task-independent-review-service");
const { createWorkTaskReviewReconciliationService } = require("../server/work-task-review-reconciliation-service");

class DisposableV2RuntimeHarnessError extends Error {
  constructor(code, message = code) { super(message); this.name = "DisposableV2RuntimeHarnessError"; this.code = code; }
}
function fail(code, message) { throw new DisposableV2RuntimeHarnessError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail(code, "unknown or missing field");
}
function clone(value) { return Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
function token(value) { return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000\r\n]/.test(value); }
function session(value, projectId, role) {
  return plain(value) && value.projectId === projectId && value.agentId === role && value.state === "running" && !!value.term && value.lifecycleState === "verified";
}

function options(value) {
  exact(value, [
    "config_dir", "fs", "project_id", "tokens", "agent_sessions", "admission", "live_batch_context",
    "repository_state", "cached_repository_snapshot", "read_registered_base", "now",
  ], "invalid_disposable_v2_runtime_harness_options");
  if (typeof value.config_dir !== "string" || !value.config_dir.startsWith("/") || !value.fs || typeof value.project_id !== "string" ||
      !plain(value.tokens) || !value.agent_sessions || typeof value.agent_sessions.get !== "function" || !plain(value.admission) ||
      !plain(value.live_batch_context) || !plain(value.repository_state) || !plain(value.cached_repository_snapshot) ||
      typeof value.read_registered_base !== "function" || typeof value.now !== "function") {
    fail("invalid_disposable_v2_runtime_harness_options", "harness dependencies are invalid");
  }
  const expected = ["head", "re1", "re2"];
  if (Object.keys(value.tokens).length !== expected.length || expected.some((role) => !token(value.tokens[role])) ||
      new Set(Object.values(value.tokens)).size !== expected.length) {
    fail("invalid_disposable_v2_runtime_harness_options", "harness role tokens are invalid");
  }
  for (const role of ["head", "dev", "re1", "re2"]) {
    if (!session(value.agent_sessions.get(`${value.project_id}/${role}`), value.project_id, role)) {
      fail("invalid_disposable_v2_runtime_harness_options", "harness sessions must be verified");
    }
  }
  if (value.admission.project_id !== value.project_id || !Number.isSafeInteger(value.admission.generation) || value.admission.generation < 0) {
    fail("invalid_disposable_v2_runtime_harness_options", "harness admission is invalid");
  }
  return value;
}

function createDisposableV2RuntimeHarness(value) {
  const deps = options(value);
  const resolveShimPrincipal = (rawToken) => {
    for (const [agentId, expectedToken] of Object.entries(deps.tokens)) {
      if (rawToken === expectedToken) return freeze({ projectId: deps.project_id, agentId });
    }
    return null;
  };
  const captureProjectAdmission = (projectId) => {
    if (projectId !== deps.project_id) throw new TypeError("unknown disposable project");
    return freeze(clone(deps.admission));
  };
  const isAdmissionCurrent = (admission) => admission?.project_id === deps.project_id && admission.generation === deps.admission.generation;
  const identityOptions = () => ({
    read_live_batch_context: (projectId) => {
      if (projectId !== deps.project_id) throw new TypeError("unknown disposable project");
      return clone(deps.live_batch_context);
    },
    read_repository_state: (binding) => clone({ ...deps.repository_state, key: binding.key, repo: binding.repo }),
    read_cached_repository_snapshot: () => clone(deps.cached_repository_snapshot),
  });
  const build = createWorkTaskBuildRuntime({
    config_dir: deps.config_dir, fs: deps.fs, capture_project_admission: captureProjectAdmission, is_admission_current: isAdmissionCurrent,
    resolve_shim_principal: resolveShimPrincipal, agent_sessions: deps.agent_sessions,
    ...identityOptions(), create_live_identity_resolver: createLiveWorkTaskIdentityResolver,
    create_assignment_service: createWorkTaskBuildAssignmentService,
    read_registered_base: (projectId, request) => deps.read_registered_base(projectId, clone(request)),
  });
  const review = createWorkTaskReviewRuntime({
    config_dir: deps.config_dir, fs: deps.fs, capture_project_admission: captureProjectAdmission, is_admission_current: isAdmissionCurrent,
    resolve_shim_principal: resolveShimPrincipal, agent_sessions: deps.agent_sessions,
    ...identityOptions(), now: deps.now, create_live_identity_resolver: createLiveWorkTaskIdentityResolver,
    create_review_service: createWorkTaskIndependentReviewService,
    create_reconciliation_service: createWorkTaskReviewReconciliationService,
  });

  const handlers = new Map([
    ["/api/work-task-build", { action: (request) => build.assign(request), fallback: "work_task_build_unavailable" }],
    ["/api/work-task-review/open", { action: (request) => review.open(request), fallback: "work_task_review_open_unavailable" }],
    ["/api/work-task-review/receipt", { action: (request) => review.submit(request), fallback: "work_task_review_receipt_unavailable" }],
    ["/api/work-task-review/reconcile", { action: (request) => review.reconcile(request), fallback: "work_task_review_reconciliation_unavailable" }],
  ]);
  const send = (res, status, body) => {
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store" });
    res.end(bytes);
  };
  const server = http.createServer((req, res) => {
    const route = req.method === "POST" ? handlers.get(req.url) : null;
    if (!route) return send(res, 404, { ok: false, code: "not_found" });
    let bytes = 0, raw = "", tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) { tooLarge = true; return; }
      if (!tooLarge) raw += chunk;
    });
    req.on("error", () => { if (!res.writableEnded) send(res, 400, { ok: false, code: "invalid_json" }); });
    req.on("end", () => {
      if (tooLarge) return send(res, 413, { ok: false, code: "payload_too_large" });
      let body;
      try { body = JSON.parse(raw); }
      catch { return send(res, 400, { ok: false, code: "invalid_json" }); }
      try {
        const rawToken = typeof req.headers["x-chat-token"] === "string" ? req.headers["x-chat-token"] : "";
        return send(res, 200, { ok: true, ...route.action({ token: rawToken, body }) });
      } catch (error) {
        return send(res, 409, { ok: false, code: typeof error?.code === "string" ? error.code : route.fallback });
      }
    });
  });
  function start(port = 0) {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || server.listening) {
      return Promise.reject(new DisposableV2RuntimeHarnessError("invalid_disposable_v2_runtime_listen", "local harness port is unavailable"));
    }
    return new Promise((resolve, reject) => {
      const failed = (error) => { server.removeListener("listening", listening); reject(error); };
      const listening = () => { server.removeListener("error", failed); resolve(Object.freeze({ host: "127.0.0.1", port: server.address().port })); };
      server.once("error", failed); server.once("listening", listening); server.listen(port, "127.0.0.1");
    });
  }
  function stop() {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  // Keep the exact fixed route names and token transport used by server/index.js.
  // The raw Server stays private so this helper cannot accidentally listen off
  // loopback. Its only public start path binds 127.0.0.1.
  return Object.freeze({ start, stop, route_names: Object.freeze([...handlers.keys()]), purpose: "disposable_local_http_replay_only" });
}

module.exports = { DisposableV2RuntimeHarnessError, createDisposableV2RuntimeHarness };
