"use strict";

// Route-level coverage for POST /api/work-task-candidate.  The endpoint is
// driven over HTTP against the composed server app with a real Git base clone
// and Dev worktree, a real durable pipeline store, and only the three live
// identity readers stubbed on the routes module.  It proves the route accepts
// the eight-field WorkTaskRef a Dev actually submits and binds the project to
// the authenticated Dev token rather than to the body.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-candidate-route-"));
const TMP_HOME = path.join(TMP, "home");
process.env.HOME = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";
const CONFIG_DIR = path.join(TMP_HOME, ".quadwork");
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(CONFIG_DIR, 0o700);
fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({ projects: [] }));

const assert = require("node:assert/strict");
const index = require("./index");
const routes = require("./routes");
const fileChat = require("./file-chat");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");

const installation_id = "installation_route_candidate_0001";
const project_id = "quadwork";
const TOKEN = "dev-route-candidate-token-0001";
const REV = "c".repeat(64);
const issue = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim(); }

// Registered base clone plus the server-owned Dev worktree on its role branch.
// The repository uses the SHA-256 object format because
// assigned-work-task-candidate.js currently accepts only 64-hex candidate
// SHAs; every other module in the chain accepts 40-hex SHA-1 as well.
const base = path.join(TMP, "product-web");
fs.mkdirSync(base);
git(base, "init", "-q", "-b", "main", "--object-format=sha256");
git(base, "config", "user.email", "dev@example.com");
git(base, "config", "user.name", "Dev");
git(base, "remote", "add", "origin", "https://github.com/Owner/Product-Web.git");
fs.writeFileSync(path.join(base, "README.md"), "base\n");
git(base, "add", "README.md");
git(base, "commit", "-q", "-m", "base");
const baseSha = git(base, "rev-parse", "HEAD");
const devDir = path.join(TMP, "product-web-dev");
git(base, "worktree", "add", "-q", "-b", "worktree-dev", devDir);
fs.writeFileSync(path.join(devDir, "README.md"), "candidate\n");
git(devDir, "add", "README.md");
git(devDir, "commit", "-q", "-m", "candidate");
const candidateSha = git(devDir, "rev-parse", "HEAD");

fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({
  installation_id,
  projects: [{
    id: project_id,
    repositories: [{ key: "web", repo: "Owner/Product-Web", working_dir: base, primary: true }],
    agents: { dev: { cwd: devDir } },
  }],
}));

// Durable pipeline: frozen manifest with one task in `building`.
const store = createWorkTaskPipelineStore({ config_dir: CONFIG_DIR, fs });
const manifest = freezeBatchManifest(buildBatchManifest({
  version: 1,
  installation_id,
  project_id,
  delivery_mode: "integrated",
  tasks: [{
    task_key: "build",
    repository_key: "web",
    work_item: copy(issue),
    goal: "submit a Dev candidate through the fixed route",
    file_boundary: ["README.md"],
    validation: ["node-test"],
    dependencies: [],
  }],
}, {
  resolveRegisteredIdentity(input) {
    return { ...input, work_item: copy(input.work_item), issue_body_revision: REV };
  },
}), "2026-09-03T00:00:00.000Z");
const pipeline = buildWorkTaskPipeline(manifest);
store.initialize({
  expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null },
  manifest,
  pipeline,
});
const ref = manifest.tasks[0].ref;
store.applyPlan({
  expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: pipeline.pipeline_digest },
  plan: planWorkTaskPipelineEvent(pipeline, {
    version: 1, kind: "assign_build", event_id: "route_assign_build", work_task_ref: copy(ref), assignment_id: "route_assignment", base_sha: baseSha,
  }),
  terminal_disposition: null,
});
function persistedTask() {
  return store.readRecoverySnapshot({ installation_id, project_id }).pipeline.tasks[0];
}

// Live identity readers: the resolver reads them from the routes module at
// request time, so stubbing the module properties is the composed path.
routes.readLiveBatchContext = (projectId) => (projectId !== project_id ? null : {
  activated: true,
  queueReadOk: true,
  installationId: installation_id,
  batchType: "code",
  project: { id: project_id },
  repositories: [{ key: "web", repo: "Owner/Product-Web", primary: true, cache_repo: "owner/product-web", ci_policy: null }],
  parsed: {
    provenance: "owned",
    installationId: installation_id,
    batchNumber: 1,
    assignmentAttempt: "attempt_route_01",
    assignmentKey: "route-assignment-key",
    errors: [],
    workItems: [{ ref: copy(issue), legacyUnowned: false }],
  },
});
routes.repositoryState = (binding) => ({ key: binding.key, repo: binding.repo, stale: false, status: "ok" });
routes._graphqlCache.set("owner/product-web", { ts: 1_800_000_000_000, issues: [{ number: 42, contract_revision: REV }] });

// Authenticated, verified Dev session for this project.
fileChat.registerShimToken(project_id, "dev", TOKEN);
index.agentSessions.set(`${project_id}/dev`, {
  projectId: project_id, agentId: "dev", state: "running", term: {}, lifecycleState: "verified",
});

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}
function post(port, body, token) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1", port, path: "/api/work-task-candidate", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...(token ? { "X-Chat-Token": token } : {}),
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(raw) }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}
function submission(overrides = {}) {
  return { version: 1, event_id: "route_record_candidate", work_task_ref: copy(ref), candidate_sha: candidateSha, ...overrides };
}

(async () => {
  const server = http.createServer(index.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const anonymous = await post(port, submission(), null);
    assert.equal(anonymous.status, 403);
    assert.equal(anonymous.json.code, "work_task_candidate_forbidden");

    const foreign = await post(port, submission({ work_task_ref: { ...copy(ref), project_id: "other" } }), TOKEN);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.code, "work_task_candidate_forbidden");
    assert.equal(persistedTask().state, "building");
    ok(true, "a Dev token cannot submit a candidate against another project, and nothing is recorded");

    const stale = await post(port, submission({ work_task_ref: { ...copy(ref), issue_body_revision: "d".repeat(64) } }), TOKEN);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "stale_work_task_candidate_authority");
    assert.equal(persistedTask().state, "building");
    ok(true, "a WorkTaskRef whose Issue body revision is no longer current is refused before recording");

    const recorded = await post(port, submission(), TOKEN);
    assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
    assert.equal(recorded.json.ok, true);
    assert.equal(recorded.json.outcome, "recorded");
    assert.match(recorded.json.candidate_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(recorded.json.work_task_ref, ref);
    const task = persistedTask();
    assert.equal(task.state, "candidate_ready");
    assert.equal(task.candidate.candidate_sha, candidateSha);
    assert.equal(task.candidate.candidate_digest, recorded.json.candidate_digest);
    ok(true, "the composed route accepts a full WorkTaskRef, re-proves live identity, and records the Dev worktree HEAD");

    const retry = await post(port, submission(), TOKEN);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.outcome, "idempotent");
    ok(true, "an exact retry through the route is acknowledged idempotently");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
