"use strict";

// #1058: exercise the real Head entry point.  A spawned Head-control MCP shim
// performs a spec-conforming initialize handshake, then every batch-lifecycle
// tool travels shim -> loopback HTTP (the exact index.js route body) -> the
// server-composed Head-control runtime -> durable domain, stores, and review
// service.  Nothing here asserts against source text.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createHeadControlRuntime } = require("./head-control-runtime");
const { createLiveWorkTaskIdentityResolver } = require("./live-work-task-identity-resolver");
const { buildBatchManifest } = require("./work-task-manifest");
const { planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { createWorkTaskIndependentReviewService } = require("./work-task-independent-review-service");
const { createWorkTaskReviewReconciliationService } = require("./work-task-review-reconciliation-service");

const SHIM = path.join(__dirname, "mcp-head-control-shim.js");
const installation_id = "installation_e2e_0001";
const project_id = "quadwork";
const generation = 7;
const token = "head-control-e2e-token-000001";
const revision = "c".repeat(64);
const baseSha = "a".repeat(64);
const candidateSha = "b".repeat(64);
const issue = { repoKey: "web", repo: "Acme/Web", number: 42, kind: "issue" };
const web = { key: "web", repo: "Acme/Web", primary: true, cache_repo: "acme/web", ci_policy: null };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function liveReaders() {
  return {
    read_live_batch_context: () => ({
      activated: true, queueReadOk: true, installationId: installation_id, batchType: "code", project: { id: project_id },
      repositories: [copy(web)],
      parsed: { provenance: "owned", installationId: installation_id, batchNumber: 12, assignmentAttempt: "attempt_e2e_01", assignmentKey: "owned-assignment-key", errors: [], workItems: [{ ref: copy(issue), legacyUnowned: false }] },
    }),
    read_repository_state: (binding) => ({ key: binding.key, repo: binding.repo, stale: false, status: "ok" }),
    read_cached_repository_snapshot: () => ({ ts: 1_800_000_000_000, issues: [{ number: 42, contract_revision: revision }] }),
  };
}
function manifest(goalSuffix) {
  return buildBatchManifest({
    version: 1, installation_id, project_id, delivery_mode: "integrated",
    tasks: [
      { task_key: "review", repository_key: "web", work_item: copy(issue), goal: `seal two independent receipts ${goalSuffix}`, file_boundary: ["server/review.js"], validation: ["node:test"], dependencies: [] },
      { task_key: "dependent", repository_key: "web", work_item: copy(issue), goal: `build on the reviewed slice ${goalSuffix}`, file_boundary: ["server/dependent.js"], validation: ["node:test"], dependencies: [{ repository_key: "web", work_item: copy(issue), task_key: "review" }] },
      // #1071: an independent third task, so one task can hold a real sealed
      // review round while another holds the propagating one.  A declared
      // dependent cannot: a build is only assigned once its dependency is
      // accepted or staged, so `dependent` can never own a round while
      // `review` is still under review.
      { task_key: "sibling", repository_key: "web", work_item: copy(issue), goal: `seal a local-only finding ${goalSuffix}`, file_boundary: ["server/sibling.js"], validation: ["node:test"], dependencies: [] },
    ],
  }, { resolveRegisteredIdentity: createLiveWorkTaskIdentityResolver(liveReaders()) });
}
function receipt(round, id, verdict, findings = []) {
  const payload = { version: 1, review_round_ref: round, receipt_id: id, verdict, findings: copy(findings) };
  const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
  return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") };
}
function candidateFor(ref) {
  return buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha: baseSha, candidate_sha: candidateSha, branch: "worktree-dev", worktree: { repository_key: "web", worktree_id: "wt_web_dev", path: "/private/var/quadwork/web-dev" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_dev", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha: baseSha, head_sha: candidateSha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}

function startShim(port, launch = {}) {
  const proc = spawn("node", [SHIM,
    "--project", launch.project || project_id,
    "--agent", "head",
    "--generation", String(launch.generation ?? generation),
    "--port", String(port),
    "--token", token,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let buffered = "";
  const queue = [];
  const waiters = [];
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    }
  });
  function read() {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for shim response")), 8000);
      waiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }
  let nextId = 100;
  return {
    proc,
    send(message) { proc.stdin.write(JSON.stringify(message) + "\n"); return read(); },
    notify(message) { proc.stdin.write(JSON.stringify(message) + "\n"); },
    async handshake() {
      const initialized = await this.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05",
        capabilities: { roots: { listChanged: true }, sampling: {} },
        clientInfo: { name: "claude-code", version: "1.0.0" },
      } });
      assert.equal(initialized.result?.serverInfo?.name, "quadwork-head-control");
      this.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await this.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "page-one" } });
      return listed.result.tools.map((tool) => tool.name);
    },
    async call(name, argumentsValue) {
      const response = await this.send({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: argumentsValue } });
      if (response.error) return { error: response.error };
      return JSON.parse(response.result.content[0].text);
    },
    stop() { proc.stdin.end(); return new Promise((resolve) => proc.once("close", resolve)); },
  };
}

async function run() {
  let passed = 0;
  function ok(value, message) { assert.ok(value, message); passed += 1; console.log(`  PASS: ${message}`); }

  const config_dir = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-e2e-"));
  let principalRole = "head";
  const sessions = new Map([[`${project_id}/head`, { projectId: project_id, agentId: "head", state: "running", term: {}, lifecycleState: "verified" }]]);
  const runtime = createHeadControlRuntime({
    config_dir,
    fs,
    read_config: () => ({ installation_id, projects: [{ id: project_id, archived: false }] }),
    capture_project_admission(id) { if (id !== project_id) throw new Error("stale admission"); return { project_id, generation }; },
    is_project_archived: (id) => id !== project_id,
    resolve_shim_principal: (candidate) => candidate === token ? { projectId: project_id, agentId: principalRole } : null,
    agent_sessions: sessions,
    ...liveReaders(),
    now: () => new Date("2026-09-02T00:00:00.000Z"),
    project_controls: {
      read_project_status: () => ({ assignment: null, monitor: { mode: "suspended" }, workers: {}, capacity: { platform: "test" } }),
      read_review_handoff: () => ({ cycle: null }),
      project_monitor: async () => ({ applied: false, reason: "not_exercised_here" }),
      recover_worker: async () => ({ applied: false, outcome: "rejected", reason: "not_exercised_here", recovered: false }),
    },
  });
  runtime.registerHeadToken({ project_id, generation, token });

  // The exact body of index.js's `app.post("/api/head-control", ...)`.
  const statuses = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      let response;
      try {
        const header = req.headers["x-head-control-token"];
        const headerToken = typeof header === "string" ? header : null;
        response = await runtime.handle({ method: req.method, path: req.url, body: JSON.parse(raw) }, { token: headerToken });
      } catch {
        response = { ok: false, error: { type: "service_unavailable" } };
      }
      const type = response?.error?.type;
      const status = response?.ok === true ? 200 : type === "not_found" ? 404 : type === "authentication_failed" ? 401 : 400;
      statuses.push({ status, type: type || null });
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const shim = startShim(port);
  const foreignProject = startShim(port, { project: "other" });
  const staleGeneration = startShim(port, { generation: generation + 1 });
  try {
    console.log("\n--- Head-control end-to-end (shim -> route -> runtime -> durable domain) ---\n");
    const tools = await shim.handshake();
    assert.deepEqual(tools, ["get_pipeline_status", "put_batch_manifest", "freeze_batch_manifest", "cut_batch", "retire_batch", "abandon_batch_manifest", "queue_local_correction", "read_propagation_stop", "get_project_status", "review_handoff", "project_monitor", "recover_worker", "recent_head_control_audit"]);
    const empty = await shim.call("get_pipeline_status", { idempotency_key: "idem_e2e_status_0", correlation_id: "corr_e2e_status_0" });
    assert.equal(empty.decision.code, "head_control_status_observed");
    assert.equal(empty.result.status.revision, 0);
    ok(true, "a spec-conforming initialize/tools-list handshake reaches the real runtime and reads the bootstrapped domain");

    const first = manifest("one");
    const put = await shim.call("put_batch_manifest", { expected_revision: 0, idempotency_key: "idem_e2e_put_1", correlation_id: "corr_e2e_put_1", manifest: copy(first) });
    assert.equal(put.decision.code, "head_control_applied");
    const frozen = await shim.call("freeze_batch_manifest", { expected_revision: 1, idempotency_key: "idem_e2e_freeze_1", correlation_id: "corr_e2e_freeze_1" });
    assert.equal(frozen.decision.code, "head_control_applied");
    assert.equal(frozen.result.status.manifest_frozen, true);
    assert.equal(frozen.result.status.revision, 2);
    const owner = { installation_id, project_id };
    const store = createWorkTaskPipelineStore({ config_dir, fs });
    let state = store.readRecoverySnapshot(owner);
    assert.equal(state.manifest.manifest_digest, frozen.result.status.manifest_digest);
    ok(true, "put and freeze produce the durable frozen pipeline store through the real entry point");

    // Dev builds, reviewers are assigned, and re2 seals a propagating finding.
    const reviewRef = state.manifest.tasks[0].ref;
    const dependentRef = state.manifest.tasks[1].ref;
    const siblingRef = state.manifest.tasks[2].ref;
    const apply = (event) => {
      state = store.readRecoverySnapshot(owner);
      store.applyPlan({ expected: { ...owner, manifest_digest: state.manifest.manifest_digest, pipeline_digest: state.pipeline.pipeline_digest }, plan: planWorkTaskPipelineEvent(state.pipeline, event), terminal_disposition: null });
    };
    const review = createWorkTaskIndependentReviewService({ config_dir, fs });
    // #1071 (test quality): the sibling gets an ACTUAL review round of its own,
    // still current, carrying a sealed receipt whose only finding is `local`.
    // Its stop read must be null because of what that round says and whose it
    // is -- not because the task has no round to look at.
    apply({ version: 1, kind: "assign_build", event_id: "e2e_sibling_build", work_task_ref: copy(siblingRef), assignment_id: "e2e_sibling_assignment", base_sha: baseSha });
    apply({ version: 1, kind: "record_candidate", event_id: "e2e_sibling_candidate", assignment_id: "e2e_sibling_assignment", candidate: candidateFor(siblingRef) });
    const siblingOpened = review.openIndependentReview({ version: 1, event_id: "e2e_sibling_open", work_task_ref: copy(siblingRef), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }], opened_at: "2026-09-02T00:00:30.000Z" });
    const siblingSealed = review.submitTrustedReceipt({ version: 1, review_round_ref: siblingOpened.review_round_ref, candidate_digest: siblingOpened.candidate_digest,
      receipt: receipt(siblingOpened.review_round_ref, "receipt_re2_sibling", "request_changes", [{ finding_id: "finding_sibling_local", severity: "blocking", propagation: "local", summary: "local only" }]) },
    { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-02T00:00:40.000Z" });
    // The round the sibling stop read will consult really is open and sealed:
    // "sealed" (not "released") is exactly the pre-release state a propagation
    // stop is derived from, and the pipeline slot holds the review authority.
    assert.equal(siblingSealed.outcome, "sealed");
    assert.equal(store.readRecoverySnapshot(owner).pipeline.tasks[2].state, "independent_review");

    apply({ version: 1, kind: "assign_build", event_id: "e2e_review_build", work_task_ref: copy(reviewRef), assignment_id: "e2e_review_assignment", base_sha: baseSha });
    apply({ version: 1, kind: "record_candidate", event_id: "e2e_review_candidate", assignment_id: "e2e_review_assignment", candidate: candidateFor(reviewRef) });
    const opened = review.openIndependentReview({ version: 1, event_id: "e2e_review_open", work_task_ref: copy(reviewRef), attempt: "attempt_001", round: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }], opened_at: "2026-09-02T00:01:00.000Z" });
    review.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest,
      receipt: receipt(opened.review_round_ref, "receipt_re2_stop", "request_changes", [{ finding_id: "finding_shared_base", severity: "blocking", propagation: "propagating", summary: "shared base drift" }]) },
    { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-02T00:02:00.000Z" });

    const stop = await shim.call("read_propagation_stop", { idempotency_key: "idem_e2e_stop_1", correlation_id: "corr_e2e_stop_1", work_task_ref: copy(reviewRef) });
    assert.equal(stop.decision.code, "head_control_stop_observed");
    assert.equal(stop.result.status.revision, 3);
    assert.equal(stop.detail.kind, "propagation_stop_pending");
    assert.equal(stop.detail.candidate_digest, opened.candidate_digest);
    assert.deepEqual(stop.detail.dependency_chain.map((entry) => entry.task_key), ["dependent"]);
    // The stop that came back names the task that owns it.
    assert.equal(stop.detail.review_round_ref.work_task_ref.task_key, "review");
    assert.doesNotMatch(JSON.stringify(stop), /receipt|finding|reviewer|verdict|request_changes|shared base/);
    // #1071 (test quality): the sibling holds its own current sealed round, and
    // the propagating stop above is still observable at the same moment, so a
    // null here is the classification of the sibling's OWN finding plus task
    // binding -- not the absence of a round.
    const siblingStop = await shim.call("read_propagation_stop", { idempotency_key: "idem_e2e_stop_4", correlation_id: "corr_e2e_stop_4", work_task_ref: copy(siblingRef) });
    assert.equal(siblingStop.decision.code, "head_control_stop_observed");
    assert.equal(siblingStop.detail, null);
    assert.doesNotMatch(JSON.stringify(siblingStop), /receipt|finding|reviewer|verdict|request_changes|local only/);
    const stopAgain = await shim.call("read_propagation_stop", { idempotency_key: "idem_e2e_stop_5", correlation_id: "corr_e2e_stop_5", work_task_ref: copy(reviewRef) });
    assert.equal(stopAgain.detail.kind, "propagation_stop_pending");
    assert.equal(stopAgain.detail.review_round_ref.work_task_ref.task_key, "review");
    // A task with no round at all is null too, for the weaker reason.
    const dependentStop = await shim.call("read_propagation_stop", { idempotency_key: "idem_e2e_stop_2", correlation_id: "corr_e2e_stop_2", work_task_ref: copy(dependentRef) });
    assert.equal(dependentStop.detail, null);
    const foreignStop = await shim.call("read_propagation_stop", { idempotency_key: "idem_e2e_stop_3", correlation_id: "corr_e2e_stop_3", work_task_ref: { ...copy(reviewRef), project_id: "other" } });
    assert.equal(foreignStop.decision.code, "head_control_domain_rejected");
    ok(true, "Head observes the pending propagation stop as a redacted detail over the declared chain, while a peer task's own sealed local-only round reads null and a foreign task ref is denied");

    // Release and reconcile the sibling's round so it no longer holds review
    // authority; retirement below refuses a batch that still does.
    review.submitTrustedReceipt({ version: 1, review_round_ref: siblingOpened.review_round_ref, candidate_digest: siblingOpened.candidate_digest, receipt: receipt(siblingOpened.review_round_ref, "receipt_re1_sibling", "approve") },
      { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T00:00:50.000Z" });
    createWorkTaskReviewReconciliationService({ config_dir, fs }).reconcileReleasedReview({ version: 1, work_task_ref: copy(siblingRef), review_round_ref: copy(siblingOpened.review_round_ref), candidate_digest: siblingOpened.candidate_digest });
    assert.equal(store.readRecoverySnapshot(owner).pipeline.tasks[2].state, "changes_requested");

    review.submitTrustedReceipt({ version: 1, review_round_ref: opened.review_round_ref, candidate_digest: opened.candidate_digest, receipt: receipt(opened.review_round_ref, "receipt_re1_stop", "approve") }, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-02T00:03:00.000Z" });
    const correction = { work_task_ref: copy(reviewRef), review_round_ref: copy(opened.review_round_ref), candidate_digest: opened.candidate_digest };
    createWorkTaskReviewReconciliationService({ config_dir, fs }).reconcileReleasedReview({ version: 1, ...copy(correction) });
    assert.equal(store.readRecoverySnapshot(owner).pipeline.tasks[0].state, "changes_requested");
    const correctionArguments = { expected_revision: 4, idempotency_key: "idem_e2e_corr_1", correlation_id: "corr_e2e_corr_1", correction: copy(correction) };
    const queued = await shim.call("queue_local_correction", correctionArguments);
    assert.equal(queued.decision.code, "head_control_applied");
    assert.equal(queued.result.status.revision, 5);
    assert.equal(queued.detail.outcome, "queued");
    assert.match(queued.detail.checkpoint_id, /^checkpoint_[a-f0-9]{48}$/);
    const corrected = store.readRecoverySnapshot(owner).pipeline.tasks[0];
    assert.equal(corrected.state, "queued");
    assert.deepEqual(corrected.correction, { checkpoint_id: queued.detail.checkpoint_id, count: 1 });
    const replayed = await shim.call("queue_local_correction", correctionArguments);
    assert.equal(replayed.decision.kind, "replayed");
    assert.equal(replayed.detail.checkpoint_id, queued.detail.checkpoint_id);
    assert.equal(store.readRecoverySnapshot(owner).pipeline.history.filter((entry) => entry.kind === "queue_local_correction").length, 1);
    ok(true, "a released change request is returned to Dev as exactly one bounded local correction, replayable without a second mutation");

    const retired = await shim.call("retire_batch", { expected_revision: 5, idempotency_key: "idem_e2e_retire_1", correlation_id: "corr_e2e_retire_1" });
    assert.equal(retired.decision.code, "head_control_applied");
    assert.deepEqual(retired.result.status, { revision: 6, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
    assert.throws(() => store.readRecoverySnapshot(owner), (error) => error.code === "work_task_pipeline_store_missing");
    assert.deepEqual(runtime.readCurrentBatchProjection({ project_id }), { active: false, projection: null });
    const second = manifest("two");
    assert.notEqual(second.manifest_digest, first.manifest_digest);
    const decidedAgainst = await shim.call("put_batch_manifest", { expected_revision: 6, idempotency_key: "idem_e2e_put_2", correlation_id: "corr_e2e_put_2", manifest: copy(second) });
    assert.equal(decidedAgainst.decision.code, "head_control_applied");
    assert.equal(decidedAgainst.result.status.revision, 7);
    // #1069: Head walks away from the never-frozen manifest through the real
    // route; the retired record and the empty active path are untouched.
    const abandoned = await shim.call("abandon_batch_manifest", { expected_revision: 7, idempotency_key: "idem_e2e_abandon_1", correlation_id: "corr_e2e_abandon_1" });
    assert.equal(abandoned.decision.code, "head_control_applied");
    assert.deepEqual(abandoned.result.status, { revision: 8, archived: false, manifest_digest: null, pipeline_digest: null, manifest_frozen: false, cut_safe: false });
    assert.equal(store.readRetiredSnapshots(owner).length, 1);
    assert.throws(() => store.readRecoverySnapshot(owner), (error) => error.code === "work_task_pipeline_store_missing");
    assert.deepEqual(runtime.readCurrentBatchProjection({ project_id }), { active: false, projection: null });
    const abandonedReplay = await shim.call("abandon_batch_manifest", { expected_revision: 7, idempotency_key: "idem_e2e_abandon_1", correlation_id: "corr_e2e_abandon_1" });
    assert.equal(abandonedReplay.decision.kind, "replayed");
    ok(true, "a put-but-never-frozen manifest is abandoned through the real entry point without touching retired provenance");
    const putAgain = await shim.call("put_batch_manifest", { expected_revision: 8, idempotency_key: "idem_e2e_put_3", correlation_id: "corr_e2e_put_3", manifest: copy(second) });
    assert.equal(putAgain.decision.code, "head_control_applied");
    const frozenAgain = await shim.call("freeze_batch_manifest", { expected_revision: 9, idempotency_key: "idem_e2e_freeze_2", correlation_id: "corr_e2e_freeze_2" });
    assert.equal(frozenAgain.decision.code, "head_control_applied");
    assert.equal(frozenAgain.result.status.revision, 10);
    const frozenAbandon = await shim.call("abandon_batch_manifest", { expected_revision: 10, idempotency_key: "idem_e2e_abandon_2", correlation_id: "corr_e2e_abandon_2" });
    assert.equal(frozenAbandon.decision.code, "head_control_abandon_unsafe");
    assert.equal(frozenAgain.result.status.manifest_frozen, true);
    assert.equal(store.readRecoverySnapshot(owner).manifest.manifest_digest, frozenAgain.result.status.manifest_digest);
    const provenance = store.readRetiredSnapshots(owner);
    assert.equal(provenance.length, 1);
    assert.equal(provenance[0].manifest.manifest_digest, frozen.result.status.manifest_digest);
    assert.equal(provenance[0].pipeline.archived, true);
    assert.equal(provenance[0].pipeline.tasks[0].correction.count, 1);
    assert.equal(runtime.readCurrentBatchProjection({ project_id }).projection.frozen, true);
    ok(true, "the finished batch is retired and a successor manifest is frozen for the same project while the retired record stays readable");

    const audit = await shim.call("recent_head_control_audit", {});
    assert.deepEqual(audit.map((record) => record.action), [
      "get_pipeline_status", "put_batch_manifest", "freeze_batch_manifest", "read_propagation_stop", "read_propagation_stop", "read_propagation_stop", "read_propagation_stop", "read_propagation_stop",
      "queue_local_correction", "retire_batch", "put_batch_manifest", "abandon_batch_manifest", "put_batch_manifest", "freeze_batch_manifest", "abandon_batch_manifest",
    ]);
    assert.ok(audit.every((record) => !Object.hasOwn(record, "detail") && !Object.hasOwn(record, "payload")));
    assert.doesNotMatch(JSON.stringify(audit), /checkpoint_|dependency_chain|propagation_stop_pending|review_round_ref/);
    ok(true, "every new operation is a redacted durable audit record with no detail or payload");

    assert.deepEqual(await foreignProject.handshake(), tools);
    const crossProject = await foreignProject.call("retire_batch", { expected_revision: 10, idempotency_key: "idem_e2e_foreign", correlation_id: "corr_e2e_foreign" });
    assert.equal(crossProject.error?.code, -32000);
    assert.deepEqual(await staleGeneration.handshake(), tools);
    const stale = await staleGeneration.call("queue_local_correction", { ...correctionArguments, expected_revision: 10, idempotency_key: "idem_e2e_stale", correlation_id: "corr_e2e_stale" });
    assert.equal(stale.error?.code, -32000);
    assert.deepEqual(statuses.slice(-2), [{ status: 400, type: "binding_mismatch" }, { status: 400, type: "binding_mismatch" }]);
    principalRole = "dev";
    const dev = await shim.call("read_propagation_stop", { idempotency_key: "idem_e2e_dev", correlation_id: "corr_e2e_dev", work_task_ref: copy(reviewRef) });
    assert.equal(dev.error?.code, -32000);
    assert.deepEqual(statuses.at(-1), { status: 401, type: "authentication_failed" });
    principalRole = "head";
    assert.equal(store.readRetiredSnapshots(owner).length, 1);
    assert.equal(store.readRecoverySnapshot(owner).manifest.manifest_digest, second.manifest_digest);
    ok(true, "cross-project, stale-generation, and Dev-principal callers are refused at the route before any domain read or mutation");
  } finally {
    await Promise.all([shim.stop(), foreignProject.stop(), staleGeneration.stop()]);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(config_dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
