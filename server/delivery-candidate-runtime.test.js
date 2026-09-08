"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { COMPOSITION_DEADLINE_MS, DeliveryCandidateRuntimeError, createDeliveryCandidateRuntime } = require("./delivery-candidate-runtime");

const installation_id = "installation_runtime_1060", project_id = "quadwork", base_sha = "a".repeat(40), candidate_sha = "b".repeat(40), result_sha = "c".repeat(40);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function rejectsCode(fn, code) { return assert.rejects(fn, (error) => error instanceof DeliveryCandidateRuntimeError && error.code === code); }
function candidate(ref) {
  return buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: "task/runtime", worktree: { repository_key: "web", worktree_id: "wt_runtime", path: "/var/quadwork/runtime" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path.replace("/var/", "/private/var/") }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_runtime", canonical_path: input.expected.canonical_path, branch: "task/runtime", base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}
function released(work) {
  const opened = openTaskReviewRound({ version: 1, candidate: work, attempt: "attempt_runtime", round: 1, opened_at: "2026-09-02T05:00:00.000Z" }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
  const receipt = (role) => { const input = { version: 1, review_round_ref: copy(opened.review_round_ref), receipt_id: `receipt_${role}_runtime`, verdict: "approve", findings: [] }; return { ...input, receipt_digest: digest(input) }; };
  const first = submitTaskReviewReceipt(opened, receipt("re1"), { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T05:01:00.000Z" });
  return submitTaskReviewReceipt(first.round, receipt("re2"), { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T05:02:00.000Z" }).round;
}
function fixture() {
  const batch = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{ task_key: "runtime", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1060, kind: "issue" }, goal: "prepare a server-owned delivery candidate", file_boundary: ["server/runtime.js"], validation: ["node-test"], dependencies: [] }] }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "d".repeat(64) }; },
  }), "2026-09-02T05:00:00.000Z");
  const work = candidate(batch.tasks[0].ref);
  return { version: 1, registered_repository: { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" }, frozen_batch_manifest: batch, delivery_mode: "integrated", cut_id: "cut_runtime_1060", base_sha, staged_tasks: [{ candidate: work, review_round: released(work) }], deferred_exclusions: [] };
}
function evidence() {
  const paths = ["server/runtime.js"], base_tree_sha = "e".repeat(40), result_tree_sha = "f".repeat(40);
  return { version: 1, installation_id, project_id, repository_key: "web", result_sha, evidence: { boundary: { paths, boundary_digest: digest({ version: 1, paths }) }, patch: { base_sha, result_sha, patch_digest: "1".repeat(64) }, tree: { base_tree_sha, result_tree_sha, tree_digest: digest({ version: 1, base_tree_sha, result_tree_sha }) } } };
}
// `overrides.compose` lets a test hold a composition open: it receives the
// service input and returns the record (or a promise of it) the mock returns.
function runtime(overrides = {}) {
  const calls = { source: 0, evidence: 0, initialize: [], compose: [], deadlines: [] };
  const sessions = new Map([[`${project_id}/head`, { projectId: project_id, agentId: "head", state: "running", term: {}, lifecycleState: "verified" }]]);
  const value = createDeliveryCandidateRuntime({
    config_dir: "/private/var/quadwork", fs, read_config() { return { installation_id, projects: [{ id: project_id, archived: false }] }; },
    capture_project_admission() { return { project_id, generation: 7 }; }, is_admission_current() { return true; },
    resolve_shim_principal(token) { return token === "head-token" ? { projectId: project_id, agentId: "head" } : null; }, agent_sessions: sessions,
    read_delivery_source(request) { calls.source += 1; assert.equal(Object.isFrozen(request), true); return overrides.source || fixture(); },
    read_delivery_evidence(request) { calls.evidence += 1; assert.equal(Object.isFrozen(request), true); return Promise.resolve(overrides.evidence || evidence()); },
    create_candidate_store() { return {}; },
    repository_objects_for(request) { assert.equal(Object.isFrozen(request), true); calls.deadlines.push(request.deadline); return {}; },
    create_composition_service(options) {
      assert.equal(options.deadline, calls.deadlines.at(-1), "the objects handle and the service share one deadline");
      return {
        initializeCandidate(input) { calls.initialize.push(copy(input)); return { kind: "delivery_candidate_initialized", record: { delivery_candidate_ref: input.delivery_candidate_ref, delivery_manifest_digest: input.delivery_manifest.delivery_manifest_digest } }; },
        composeCandidate(input) { calls.compose.push(copy(input)); const record = { kind: "delivery_candidate_composed", record: { delivery_candidate_ref: input.delivery_candidate_ref } }; return overrides.compose ? overrides.compose(input, record) : record; },
      };
    },
  });
  return { value, calls };
}
function composeBody(ref, correlation_id, idempotency_key, expected_revision = 0) {
  return { token: "head-token", body: { delivery_candidate_ref: ref, expected_revision, correlation_id, idempotency_key } };
}

async function main() {
  {
    const subject = runtime();
    const before = Date.now();
    const prepared = await subject.value.prepare({ token: "head-token", body: { repository_key: "web" } });
    assert.equal(prepared.kind, "delivery_candidate_initialized");
    assert.equal(subject.calls.source, 1); assert.equal(subject.calls.evidence, 1);
    assert.equal(subject.calls.initialize[0].delivery_manifest.delivery_candidate_ref.result_sha, result_sha);
    assert.equal(subject.calls.initialize[0].delivery_manifest.staged_tasks.length, 1);
    const composed = await subject.value.compose(composeBody(prepared.record.delivery_candidate_ref, "compose-runtime-1060", "compose-runtime-1060"));
    assert.equal(composed.kind, "delivery_candidate_composed");
    assert.equal(subject.calls.compose[0].head_binding.generation, 7);
    assert.equal(COMPOSITION_DEADLINE_MS, 30_000);
    assert.equal(subject.calls.deadlines.length, 2);
    assert.ok(subject.calls.deadlines.every((deadline) => Number.isSafeInteger(deadline) && deadline >= before + COMPOSITION_DEADLINE_MS && deadline <= Date.now() + COMPOSITION_DEADLINE_MS),
      "every objects handle and service receives the same absolute deadline, one composition budget from its own start");
    console.log("  PASS: authenticated Head derives Delivery Candidate provenance and evidence without caller paths, bases, reviews, or patches");
  }

  {
    const subject = runtime();
    await rejectsCode(() => subject.value.prepare({ token: "other", body: { repository_key: "web" } }), "delivery_candidate_principal_unavailable");
    await rejectsCode(() => subject.value.prepare({ token: "head-token", body: { repository_key: "web", result_sha } }), "invalid_delivery_candidate_prepare_request");
    assert.equal(subject.calls.source, 0);
    console.log("  PASS: caller cannot select result SHA or bypass the verified Head principal");
  }

  // #1066: one Delivery Candidate composes at most once at a time.  While a
  // composition is held open, an exact duplicate joins it, a partially
  // matching identity collides, and an unrelated identity is refused busy;
  // none of them reaches the composition service.  Settling clears the slot.
  {
    const holds = [];
    const subject = runtime({ compose: (input, record) => new Promise((resolve) => { holds.push(() => resolve(record)); }) });
    const ref = (await subject.value.prepare({ token: "head-token", body: { repository_key: "web" } })).record.delivery_candidate_ref;
    const first = subject.value.compose(composeBody(ref, "flight-1066", "flight-1066"));
    const joined = subject.value.compose(composeBody(ref, "flight-1066", "flight-1066"));
    let settled = false;
    first.then(() => { settled = true; });
    await rejectsCode(() => subject.value.compose(composeBody(ref, "flight-1066", "other-1066")), "delivery_composition_identity_collision");
    await rejectsCode(() => subject.value.compose(composeBody(ref, "other-1066", "flight-1066")), "delivery_composition_identity_collision");
    await rejectsCode(() => subject.value.compose(composeBody(ref, "flight-1066", "flight-1066", 1)), "delivery_composition_identity_collision");
    await rejectsCode(() => subject.value.compose(composeBody(ref, "second-1066", "second-1066")), "delivery_candidate_compose_busy");
    await rejectsCode(() => subject.value.compose({ token: "head-token", body: { delivery_candidate_ref: ref, expected_revision: 0 } }), "invalid_delivery_candidate_compose_request");
    await rejectsCode(() => subject.value.compose(composeBody(ref, "other", "flight-1066")).then(() => {}, (error) => { throw error; }), "delivery_composition_identity_collision");
    assert.equal(settled, false, "the held composition is still in flight after every refusal");
    assert.equal(subject.calls.compose.length, 1, "no refused or joined request reached the composition service");
    assert.equal(holds.length, 1);
    holds[0]();
    const [left, right] = await Promise.all([first, joined]);
    assert.equal(left, right, "the joined request observes the one composition's result");
    assert.equal(left.kind, "delivery_candidate_composed");
    await rejectsCode(() => subject.value.compose({ token: "other", body: { delivery_candidate_ref: ref, expected_revision: 0, correlation_id: "x-1066", idempotency_key: "x-1066" } }), "delivery_candidate_principal_unavailable");
    const next = subject.value.compose(composeBody(ref, "second-1066", "second-1066"));
    assert.equal(holds.length, 2, "once settled, the next composition for the candidate launches again");
    holds[1]();
    assert.equal((await next).kind, "delivery_candidate_composed");
    assert.equal(subject.calls.compose.length, 2);
    console.log("  PASS: per-candidate single flight joins an exact duplicate and refuses conflicting identities without a second composition");
  }

  // A composition that fails clears the slot as well, and its service code
  // reaches the caller unchanged.
  {
    const subject = runtime({ compose: () => Promise.reject(Object.assign(new Error("stale"), { code: "stale_delivery_candidate_revision" })) });
    const ref = (await subject.value.prepare({ token: "head-token", body: { repository_key: "web" } })).record.delivery_candidate_ref;
    const pending = subject.value.compose(composeBody(ref, "fail-1066", "fail-1066"));
    await rejectsCode(() => subject.value.compose(composeBody(ref, "next-1066", "next-1066")), "delivery_candidate_compose_busy");
    await rejectsCode(() => pending, "stale_delivery_candidate_revision");
    await rejectsCode(() => subject.value.compose(composeBody(ref, "next-1066", "next-1066")), "stale_delivery_candidate_revision");
    assert.equal(subject.calls.compose.length, 2);
    console.log("  PASS: a failed composition settles the slot and surfaces its own code");
  }

  {
    const source = fs.readFileSync(path.join(__dirname, "delivery-candidate-runtime.js"), "utf8");
    assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:child_process|http|https|net|os)["']\s*\)/);
    assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp-chat-shim)["']\s*\)/);
    assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|push|pull_request|\bmerge\b|deploy|writeFile)/);
    console.log("  PASS: Delivery Candidate runtime is a fixed Head bridge with no process, transport, or publication authority");
  }
}

let finished = false;
process.on("exit", (code) => { if (!finished && code === 0) { console.error("delivery-candidate-runtime.test.js: did not run to completion"); process.exitCode = 1; } });
main().then(() => { finished = true; console.log("delivery-candidate-runtime.test.js: all assertions passed"); }, (error) => { console.error(error); process.exit(1); });
