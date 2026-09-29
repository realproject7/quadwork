"use strict";
require("./__tests__/resource-executor-fixture").installResourceExecutorFixture({ preserveRuntimeOwner: true });

// Compose the advertised Head MCP tool, the actual HTTP route/runtime, and
// the durable review stores in a disposable HOME. No live project is touched.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-review-open-route-"));
process.env.HOME = path.join(TMP, "home");
process.env.QUADWORK_SKIP_LISTEN = "1";
const CONFIG_DIR = path.join(process.env.HOME, ".quadwork");
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({ projects: [] }));

const routes = require("./routes");
const fileChat = require("./file-chat");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline, planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createTaskReviewRoundStore } = require("./task-review-round-store");

const installation_id = "installation_review_open_route_0001";
const project_id = "quadwork";
const token = "review-open-route-head-token";
const issue = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };
const issueRevision = "c".repeat(64);
const baseSha = "a".repeat(64), candidateSha = "b".repeat(64);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({
  installation_id, projects: [{ id: project_id,
    repositories: [{ key: "web", repo: "Owner/Product-Web", primary: true, working_dir: TMP }], agents: {} }],
}));

const manifest = freezeBatchManifest(buildBatchManifest({
  version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{
    task_key: "review", repository_key: "web", work_item: copy(issue), goal: "open a review round",
    file_boundary: ["README.md"], validation: ["node-test"], dependencies: [],
  }],
}, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: issueRevision }; } }),
"2026-09-03T00:00:00.000Z");
const ref = manifest.tasks[0].ref;
const store = createWorkTaskPipelineStore({ config_dir: CONFIG_DIR, fs });
let pipeline = buildWorkTaskPipeline(manifest);
store.initialize({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline });
function apply(event) {
  const state = store.readRecoverySnapshot({ installation_id, project_id });
  store.applyPlan({ expected: { installation_id, project_id, manifest_digest: manifest.manifest_digest,
    pipeline_digest: state.pipeline.pipeline_digest }, plan: planWorkTaskPipelineEvent(state.pipeline, event), terminal_disposition: null });
}
apply({ version: 1, kind: "assign_build", event_id: "route_assign_review", work_task_ref: copy(ref), assignment_id: "route_assignment", base_sha: baseSha });
const candidate = buildWorkTaskCandidate({
  version: 1, work_task_ref: copy(ref), base_sha: baseSha, candidate_sha: candidateSha, branch: "worktree-dev",
  worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" },
}, {
  canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
  inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web",
    worktree_id: "wt_web_dev", canonical_path: input.expected.canonical_path, branch: input.expected.branch,
    base_sha: baseSha, head_sha: candidateSha, dirty: false, occupancy: "vacant" }; },
  readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
});
apply({ version: 1, kind: "record_candidate", event_id: "route_record_review", assignment_id: "route_assignment", candidate });

routes.readLiveBatchContext = (projectId) => (projectId !== project_id ? null : {
  activated: true, queueReadOk: true, installationId: installation_id, batchType: "code", project: { id: project_id },
  repositories: [{ key: "web", repo: "Owner/Product-Web", primary: true, cache_repo: "owner/product-web", ci_policy: null }],
  parsed: { provenance: "owned", installationId: installation_id, batchNumber: 1,
    assignmentAttempt: "attempt_001", assignmentKey: "route-key", errors: [],
    workItems: [{ ref: copy(issue), legacyUnowned: false }] },
});
routes.repositoryState = (binding) => ({ key: binding.key, repo: binding.repo, stale: false, status: "ok" });
routes._graphqlCache.set("owner/product-web", { ts: 1_800_000_000_000, issues: [{ number: 42, contract_revision: issueRevision }] });
const index = require("./index");
fileChat.registerShimToken(project_id, "head", token);
function session(role) { return { projectId: project_id, agentId: role, state: "running", term: {}, lifecycleState: "verified" }; }
index.agentSessions.set(`${project_id}/head`, session("head"));
index.agentSessions.set(`${project_id}/re1`, session("re1"));

function shimCall(proc, id, name, args) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { proc.stdout.off("data", onData); reject(new Error("MCP review-open timeout")); }, 5000);
    function onData(data) {
      proc.mcpBuffer = (proc.mcpBuffer || "") + data.toString();
      const end = proc.mcpBuffer.indexOf("\n");
      if (end < 0) return;
      const line = proc.mcpBuffer.slice(0, end);
      proc.mcpBuffer = proc.mcpBuffer.slice(end + 1);
      clearTimeout(timeout); proc.stdout.off("data", onData);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    }
    proc.stdout.on("data", onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: name === "tools/list" ? name : "tools/call",
      ...(name === "tools/list" ? {} : { params: { name, arguments: args } }) }) + "\n");
  });
}

(async () => {
  const forwarded = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/api/work-task-review/open") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => { forwarded.push(JSON.parse(raw)); });
    }
    index.app(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = spawn(process.execPath, [path.join(__dirname, "mcp-chat-shim.js"), "--project", project_id,
    "--agent", "head", "--port", String(server.address().port), "--token", token], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const listed = await shimCall(shim, 1, "tools/list");
    const schema = listed.result.tools.find((tool) => tool.name === "open_work_task_independent_review")?.inputSchema;
    assert.deepEqual(schema.required, ["event_id", "work_task_ref", "attempt", "round"]);
    assert.equal(schema.additionalProperties, false);

    const request = { event_id: "route_open_review", work_task_ref: copy(ref), attempt: "attempt_001", round: 1 };
    const unavailable = await shimCall(shim, 2, "open_work_task_independent_review", request);
    assert.equal(unavailable.error?.message, "work_task_reviewer_assignment_unavailable");
    assert.equal(store.readRecoverySnapshot({ installation_id, project_id }).pipeline.tasks[0].state, "candidate_ready");

    index.agentSessions.set(`${project_id}/re2`, session("re2"));
    const openedRpc = await shimCall(shim, 3, "open_work_task_independent_review", request);
    assert.equal(openedRpc.error, undefined);
    const opened = JSON.parse(openedRpc.result.content[0].text);
    assert.equal(opened.outcome, "opened");
    assert.equal(opened.candidate_digest, candidate.candidate_digest);
    assert.deepEqual(forwarded, [request, request]);
    const state = store.readRecoverySnapshot({ installation_id, project_id });
    assert.equal(state.pipeline.tasks[0].state, "independent_review");
    assert.equal(state.pipeline.tasks[0].review_assignment.candidate_digest, candidate.candidate_digest);
    const rounds = createTaskReviewRoundStore({ rootDir: CONFIG_DIR, fsImpl: fs });
    const re1View = rounds.readForTrustedReviewer(opened.review_round_ref, opened.candidate_digest,
      { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: new Date().toISOString() });
    assert.equal(re1View.status, "sealed");
    const re2View = rounds.readForTrustedReviewer(opened.review_round_ref, opened.candidate_digest,
      { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: new Date().toISOString() });
    assert.equal(re2View.status, "sealed");
    assert.throws(() => rounds.readForTrustedReviewer(opened.review_round_ref, opened.candidate_digest,
      { version: 1, reviewer_role: "re2", reviewer_generation: 2, received_at: new Date().toISOString() }),
    (error) => error.code === "task_review_reviewer_generation_mismatch");
    assert.deepEqual(opened.review_round_ref.work_task_ref, ref);
    assert.equal(opened.review_round_ref.attempt, request.attempt);
    assert.equal(opened.review_round_ref.round, request.round);

    const retry = await shimCall(shim, 4, "open_work_task_independent_review", request);
    assert.equal(JSON.parse(retry.result.content[0].text).outcome, "idempotent");
    assert.equal(store.readRecoverySnapshot({ installation_id, project_id }).pipeline.history.filter((entry) => entry.kind === "assign_independent_review").length, 1);
    console.log("index.workTaskReviewOpen.test.js: MCP schema, bounded rejection, durable open, and idempotent retry passed");
  } finally {
    shim.stdin.end();
    await new Promise((resolve) => shim.once("close", resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); fs.rmSync(TMP, { recursive: true, force: true }); process.exitCode = 1; });
