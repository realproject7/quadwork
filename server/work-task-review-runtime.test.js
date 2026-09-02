"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWorkTaskReviewRuntime, WorkTaskReviewRuntimeError } = require("./work-task-review-runtime");

const installation_id = "installation_review_runtime_0001";
const project_id = "quadwork";
const ref = {
  version: 1,
  installation_id,
  project_id,
  repository_key: "web",
  work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" },
  issue_body_revision: "c".repeat(64),
  task_key: "runtime",
  task_revision: "d".repeat(64),
};
const review_round_ref = {
  version: 1, installation_id, project_id, work_task_ref: ref, task_revision: ref.task_revision,
  base_sha: "a".repeat(64), candidate_sha: "b".repeat(64), attempt: "attempt_001", round: 1,
};

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(run, code) {
  assert.throws(run, (error) => error instanceof WorkTaskReviewRuntimeError && error.code === code);
}
function session(role, verified = true) {
  return {
    projectId: project_id, agentId: role, state: "running", term: { pid: 123 },
    lifecycleState: verified ? "verified" : "spawned",
  };
}
function fixture(options = {}) {
  const calls = [];
  const sessions = new Map([
    [`${project_id}/head`, session("head")],
    [`${project_id}/re1`, session("re1")],
    [`${project_id}/re2`, session("re2")],
  ]);
  const principals = new Map([["head-token", { projectId: project_id, agentId: "head" }], ["re1-token", { projectId: project_id, agentId: "re1" }], ["re2-token", { projectId: project_id, agentId: "re2" }]]);
  const runtime = createWorkTaskReviewRuntime({
    config_dir: "/tmp/quadwork-review-runtime", fs,
    capture_project_admission: () => ({ project_id, generation: options.generation ?? 0 }),
    is_admission_current: () => options.current !== false,
    resolve_shim_principal: (token) => principals.get(token) || null,
    agent_sessions: sessions,
    read_live_batch_context: () => ({}), read_repository_state: () => ({}), read_cached_repository_snapshot: () => ({}),
    now: () => new Date("2026-09-02T00:01:00.000Z"),
    create_live_identity_resolver: () => (input) => options.identity || {
      installation_id: input.installation_id, project_id: input.project_id, repository_key: input.repository_key,
      work_item: copy(input.work_item), issue_body_revision: ref.issue_body_revision,
    },
    create_review_service: () => ({
      openIndependentReview: (input) => { calls.push({ kind: "open", input: copy(input) }); return { outcome: "opened", review_round_ref: copy(review_round_ref), candidate_digest: "e".repeat(64) }; },
      submitTrustedReceipt: (input, context) => { calls.push({ kind: "submit", input: copy(input), context: copy(context) }); return { outcome: "sealed", view: { status: "sealed" } }; },
    }),
  });
  return { runtime, calls, sessions };
}

{
  const current = fixture();
  const opened = current.runtime.open({ token: "head-token", body: {
    event_id: "open_runtime_001", work_task_ref: copy(ref), attempt: "attempt_001", round: 1,
    // A caller-supplied reviewer list is intentionally ignored by the fixed
    // adapter; it cannot select an identity or generation.
    reviewers: [{ reviewer_role: "re1", reviewer_generation: 999 }],
  } });
  assert.equal(opened.outcome, "opened");
  assert.equal(current.calls.length, 1);
  assert.deepEqual(current.calls[0].input.reviewers, [
    { reviewer_role: "re1", reviewer_generation: 1 },
    { reviewer_role: "re2", reviewer_generation: 1 },
  ]);
  assert.equal(current.calls[0].input.opened_at, "2026-09-02T00:01:00.000Z");
  console.log("  PASS: Head opens a round with server-derived, positive reviewer epochs");
}

{
  const current = fixture({ generation: 7 });
  const receipt = { version: 1, review_round_ref: copy(review_round_ref), receipt_id: "receipt_re1_01", verdict: "approve", receipt_digest: "f".repeat(64), findings: [] };
  const submitted = current.runtime.submit({ token: "re1-token", body: { review_round_ref: copy(review_round_ref), candidate_digest: "e".repeat(64), receipt } });
  assert.equal(submitted.outcome, "sealed");
  assert.equal(current.calls.length, 1);
  assert.equal(current.calls[0].kind, "submit");
  assert.deepEqual(current.calls[0].context, {
    version: 1, reviewer_role: "re1", reviewer_generation: 8, received_at: "2026-09-02T00:01:00.000Z",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(current.calls[0].input, "reviewer_role"), false);
  console.log("  PASS: receipt context is bound only from the authenticated reviewer token");
}

{
  const current = fixture();
  current.sessions.set(`${project_id}/re2`, session("re2", false));
  throwsCode(() => current.runtime.open({ token: "head-token", body: { event_id: "open_runtime_002", work_task_ref: copy(ref), attempt: "attempt_001", round: 1 } }), "work_task_reviewer_assignment_unavailable");
  assert.equal(current.calls.length, 0);
  console.log("  PASS: opening fails closed until both independent reviewers are verified");
}

{
  const stale = fixture({ identity: { installation_id, project_id, repository_key: "web", work_item: copy(ref.work_item), issue_body_revision: "e".repeat(64) } });
  throwsCode(() => stale.runtime.open({ token: "head-token", body: { event_id: "open_runtime_003", work_task_ref: copy(ref), attempt: "attempt_001", round: 1 } }), "stale_work_task_review_authority");
  assert.equal(stale.calls.length, 0);
  const revoked = fixture({ current: false });
  throwsCode(() => revoked.runtime.submit({ token: "re1-token", body: { review_round_ref: copy(review_round_ref), candidate_digest: "e".repeat(64), receipt: {} } }), "work_task_review_principal_unavailable");
  assert.equal(revoked.calls.length, 0);
  console.log("  PASS: stale task contracts and revoked principals cannot reach sealing service");
}

{
  const source = fs.readFileSync(path.join(__dirname, "work-task-review-runtime.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|reconcile_review|record_review_verdict)/);
  console.log("  PASS: fixed review transport has no publication, process, or reconciliation authority");
}

console.log("work-task-review-runtime.test.js: all assertions passed");
