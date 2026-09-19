#!/usr/bin/env node
"use strict";

// Local loopback coverage for the non-shipping #1037 HTTP harness.  No model,
// MCP client, GitHub API, git subprocess, release, package-manager, or remote
// resource is involved.  The harness uses the production V2 runtime services
// and durable stores, then removes the entire disposable directory.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// This checkout deliberately has no installed native advisory-lock package.
// The harness still composes the production build/review/durable-store code;
// this fixture substitutes only the kernel-lock adapter so a single-process
// disposable replay can exercise those services. It cannot prove the native
// lock, which has dedicated production-store coverage on an installed package.
function loadRuntimeWithSingleProcessLockFixture() {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./durable-store-advisory-lock" && parent?.filename?.endsWith(`${path.sep}durable-store-files.js`)) {
      return { AdvisoryLockError: class AdvisoryLockError extends Error {}, advisoryLockAdapter: () => ({ tryLock: () => true, unlock: () => {} }) };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    return {
      ...require("../server/work-task-manifest"),
      ...require("../server/work-task-pipeline"),
      ...require("../server/work-task-candidate"),
      ...require("../server/work-task-pipeline-store"),
      ...require("./v2-disposable-runtime-harness.cjs"),
    };
  } finally { Module._load = original; }
}
const { buildBatchManifest, freezeBatchManifest, buildWorkTaskPipeline, planWorkTaskPipelineEvent, buildWorkTaskCandidate, createWorkTaskPipelineStore, createDisposableV2RuntimeHarness, DisposableV2RuntimeHarnessError } = loadRuntimeWithSingleProcessLockFixture();

const installation_id = "benchmark_installation_0001";
const project_id = "benchmark-local";
const revision = "c".repeat(64);
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);
const copy = (value) => JSON.parse(JSON.stringify(value));
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const receipt = (round, id) => {
  const payload = { version: 1, review_round_ref: copy(round), receipt_id: id, verdict: "approve", findings: [] };
  return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") };
};
function session(role) { return { projectId: project_id, agentId: role, state: "running", term: { pid: 1 }, lifecycleState: "verified" }; }
function request(port, route, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(token ? { "X-Chat-Token": token } : {}),
    } }, (res) => {
      let data = ""; res.on("data", (part) => { data += part; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject); req.end(payload);
  });
}
function fixture(root) {
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{
    task_key: "a1", repository_key: "catalog", work_item: { repoKey: "catalog", repo: "Example/Catalog", number: 101, kind: "issue" },
    goal: "disposable local HTTP replay", file_boundary: ["src/parse.js"], validation: ["node-test"], dependencies: [],
  }] }, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: revision }; } }), "2026-09-19T00:00:00.000Z");
  const ref = manifest.tasks[0].ref;
  const store = createWorkTaskPipelineStore({ config_dir: root, fs });
  store.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline: buildWorkTaskPipeline(manifest) });
  const sessions = new Map(["head", "dev", "re1", "re2"].map((role) => [`${project_id}/${role}`, session(role)]));
  const tokens = { head: "head-local-token", re1: "re1-local-token", re2: "re2-local-token" };
  const live_batch_context = { activated: true, queueReadOk: true, installationId: installation_id, batchType: "code", project: { id: project_id },
    parsed: { provenance: "owned", installationId: installation_id, batchNumber: 1, assignmentAttempt: "attempt_001", assignmentKey: "benchmark-local", errors: [], workItems: [copy(ref.work_item)] },
    repositories: [{ key: "catalog", repo: "Example/Catalog", cache_repo: "example/catalog" }] };
  const harness = createDisposableV2RuntimeHarness({ config_dir: root, fs, project_id, tokens, agent_sessions: sessions,
    admission: { project_id, generation: 0 }, live_batch_context, repository_state: { key: "catalog", repo: "Example/Catalog", stale: false },
    cached_repository_snapshot: { ts: 1, issues: [{ number: 101, contract_revision: revision }] },
    read_registered_base: () => ({ version: 1, repository_key: "catalog", base_sha }), now: () => new Date("2026-09-19T00:01:00.000Z"),
  });
  return { ref, store, harness, tokens };
}
function recordCandidate(current, root) {
  const state = current.store.readRecoverySnapshot({ installation_id, project_id });
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(current.ref), base_sha, candidate_sha, branch: "benchmark-dev", worktree: { repository_key: "catalog", worktree_id: "wt_catalog_dev", path: path.join(root, "worktree") } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "catalog", worktree_id: "wt_catalog_dev", canonical_path: input.expected.canonical_path, branch: "benchmark-dev", base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  const plan = planWorkTaskPipelineEvent(state.pipeline, { version: 1, kind: "record_candidate", event_id: "candidate_benchmark_001", assignment_id: state.pipeline.tasks[0].build_assignment.assignment_id, candidate });
  current.store.applyPlan({ expected: { installation_id, project_id, manifest_digest: state.manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan, terminal_disposition: null });
}

test("disposable HTTP routes bind build and reviewer roles through production V2 runtime services", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-v2-disposable-http-"));
  let harness;
  try {
    const current = fixture(root); harness = current.harness; const listener = await harness.start();
    const denied = await request(listener.port, "/api/work-task-build", { event_id: "build_benchmark_001", work_task_ref: copy(current.ref) });
    assert.deepEqual({ status: denied.status, ok: denied.body.ok, code: denied.body.code }, { status: 409, ok: false, code: "work_task_build_principal_unavailable" });
    const built = await request(listener.port, "/api/work-task-build", { event_id: "build_benchmark_001", work_task_ref: copy(current.ref), ignored: "rejected-by-runtime" }, current.tokens.head);
    assert.equal(built.status, 200, JSON.stringify(built.body)); assert.equal(built.body.outcome, "assigned"); assert.equal(built.body.base_sha, base_sha);
    recordCandidate(current, root);
    const opened = await request(listener.port, "/api/work-task-review/open", { event_id: "open_benchmark_001", work_task_ref: copy(current.ref), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 999 }] }, current.tokens.head);
    assert.equal(opened.status, 200); assert.equal(opened.body.outcome, "opened");
    const first = await request(listener.port, "/api/work-task-review/receipt", { review_round_ref: opened.body.review_round_ref, candidate_digest: opened.body.candidate_digest, receipt: receipt(opened.body.review_round_ref, "receipt_re1_01") }, current.tokens.re1);
    assert.equal(first.status, 200); assert.equal(first.body.outcome, "sealed");
    const duplicateRole = await request(listener.port, "/api/work-task-review/receipt", { review_round_ref: opened.body.review_round_ref, candidate_digest: opened.body.candidate_digest, receipt: receipt(opened.body.review_round_ref, "receipt_re1_02") }, current.tokens.re1);
    assert.deepEqual({ status: duplicateRole.status, ok: duplicateRole.body.ok }, { status: 409, ok: false });
    const second = await request(listener.port, "/api/work-task-review/receipt", { review_round_ref: opened.body.review_round_ref, candidate_digest: opened.body.candidate_digest, receipt: receipt(opened.body.review_round_ref, "receipt_re2_01") }, current.tokens.re2);
    assert.equal(second.status, 200); assert.equal(second.body.outcome, "released");
    const reconciled = await request(listener.port, "/api/work-task-review/reconcile", { work_task_ref: copy(current.ref), review_round_ref: opened.body.review_round_ref, candidate_digest: opened.body.candidate_digest }, current.tokens.head);
    assert.equal(reconciled.status, 200); assert.equal(reconciled.body.resolution, "accepted");
    assert.equal(current.store.readRecoverySnapshot({ installation_id, project_id }).pipeline.tasks[0].state, "accepted");
  } finally {
    if (harness) await harness.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("harness refuses non-verified sessions before any loopback route exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-v2-disposable-invalid-"));
  try {
    const sessions = new Map(["head", "dev", "re1", "re2"].map((role) => [`${project_id}/${role}`, session(role)]));
    sessions.get(`${project_id}/re2`).lifecycleState = "spawned";
    assert.throws(() => createDisposableV2RuntimeHarness({ config_dir: root, fs, project_id, tokens: { head: "head", re1: "re1", re2: "re2" }, agent_sessions: sessions,
      admission: { project_id, generation: 0 }, live_batch_context: {}, repository_state: {}, cached_repository_snapshot: {}, read_registered_base: () => ({}), now: () => new Date(),
    }), (error) => error instanceof DisposableV2RuntimeHarnessError && error.code === "invalid_disposable_v2_runtime_harness_options");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("harness source has no provider, remote mutation, release, or process capability", () => {
  const source = fs.readFileSync(path.join(__dirname, "v2-disposable-runtime-harness.cjs"), "utf8");
  assert.doesNotMatch(source, /require\(\s*["'](?:child_process|\.\/\.\/server\/index|\.\/\.\/server\/routes)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|npm\s+publish|gh\s+(?:api|pr|release)|https?:\/\/)/i);
  assert.match(source, /api\/work-task-build/); assert.match(source, /api\/work-task-review\/receipt/);
});
