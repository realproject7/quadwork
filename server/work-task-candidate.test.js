"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildBatchManifest } = require("./work-task-manifest");
const {
  WorkTaskCandidateError,
  assertWorkTaskCandidate,
  workTaskCandidateKey,
  buildWorkTaskCandidate,
  planCandidateInvalidation,
  assertCandidateInvalidationPlan,
  rejectTaskCandidatePublication,
} = require("./work-task-candidate");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);
const candidate_sha = "b".repeat(64);
const web42 = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof WorkTaskCandidateError && error.code === expected);
}
function resolveRegisteredIdentity(input) {
  return {
    installation_id: input.installation_id,
    project_id: input.project_id,
    repository_key: input.repository_key,
    work_item: copy(input.work_item),
    issue_body_revision: "c".repeat(64),
  };
}
function manifest() {
  return buildBatchManifest({
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "isolated",
    tasks: [{
      task_key: "build",
      repository_key: "web",
      work_item: copy(web42),
      goal: "implement local exact candidate",
      file_boundary: ["server/work.js"],
      validation: ["node:test"],
      dependencies: [],
    }],
  }, { resolveRegisteredIdentity });
}
function candidateInput(ref, worktreePath = "/var/folders/quadwork/task-build") {
  return {
    version: 1,
    work_task_ref: copy(ref),
    base_sha,
    candidate_sha,
    branch: "task/work-task-build",
    worktree: { repository_key: "web", worktree_id: "wt_build_01", path: worktreePath },
  };
}
function canonicalizePath(request) {
  assert.equal(Object.isFrozen(request), true, "path authority receives an immutable request");
  assert.deepEqual(Object.keys(request).sort(), ["path", "version"]);
  return {
    version: 1,
    canonical_path: request.path.replace(/^\/var\//, "/private/var/"),
  };
}
function observed(overrides = {}) {
  return {
    version: 1,
    registered: true,
    readable: true,
    repository_key: "web",
    worktree_id: "wt_build_01",
    canonical_path: "/private/var/folders/quadwork/task-build",
    branch: "task/work-task-build",
    base_sha,
    head_sha: candidate_sha,
    dirty: false,
    occupancy: "vacant",
    ...overrides,
  };
}
function options(overrides = {}) {
  return {
    canonicalizePath,
    inspectManagedWorktree(request) {
      assert.equal(Object.isFrozen(request), true, "worktree read-back receives an immutable request");
      assert.deepEqual(Object.keys(request).sort(), ["expected", "version", "work_task_ref"]);
      assert.deepEqual(request.expected, {
        repository_key: "web",
        worktree_id: "wt_build_01",
        canonical_path: "/private/var/folders/quadwork/task-build",
        branch: "task/work-task-build",
        base_sha,
        candidate_sha,
      });
      return observed();
    },
    readCanonicalInstalledState(identity) {
      assert.equal(Object.isFrozen(identity), true, "installed-state read receives an immutable identity");
      assert.deepEqual(identity, { version: 1, installation_id, project_id });
      return { version: 1, installation_id, project_id, v1_state: "present" };
    },
    ...overrides,
  };
}
function buildCandidate(overrides = {}) {
  const ref = manifest().tasks[0].ref;
  return buildWorkTaskCandidate(candidateInput(ref), options(overrides));
}

// A /var input path is canonicalized via the injected authority, then the
// registered managed worktree must read back the exact canonical path, base,
// branch and clean candidate SHA.  The result has no remote delivery ability.
{
  const source = candidateInput(manifest().tasks[0].ref);
  const original = copy(source);
  const candidate = buildWorkTaskCandidate(source, options());
  assert.deepEqual(source, original);
  assert.equal(candidate.managed_worktree.canonical_path, "/private/var/folders/quadwork/task-build");
  assert.equal(candidate.managed_worktree.head_sha, candidate_sha);
  assert.equal(candidate.migration.v1_present, true);
  assert.deepEqual(candidate.publication, { scope: "local_worktree_only", push: false, pull_request: false, ci: false, release: false });
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(assertWorkTaskCandidate(candidate), candidate);
  assert.match(candidate.candidate_digest, /^[a-f0-9]{64}$/);
  assert.equal(workTaskCandidateKey(candidate), workTaskCandidateKey(copy(candidate)));
}

// Every untrusted or uncertain managed-worktree read-back condition is a
// closed failure. No cleanup, reset, or mutation capability exists here.
for (const [label, patch, expected] of [
  ["unregistered", { registered: false }, "managed_worktree_unregistered"],
  ["unreadable", { readable: false }, "managed_worktree_unreadable"],
  ["dirty", { dirty: true }, "managed_worktree_dirty"],
  ["occupied", { occupancy: "occupied" }, "managed_worktree_occupied"],
  ["repository mismatch", { repository_key: "api" }, "managed_worktree_identity_mismatch"],
  ["canonical read-back mismatch", { canonical_path: "/private/var/folders/quadwork/other" }, "managed_worktree_identity_mismatch"],
  ["branch mismatch", { branch: "task/other" }, "managed_worktree_identity_mismatch"],
  ["base mismatch", { base_sha: "d".repeat(64) }, "work_task_candidate_base_mismatch"],
  ["head mismatch", { head_sha: "e".repeat(64) }, "work_task_candidate_sha_mismatch"],
]) {
  throwsCode(() => buildCandidate({ inspectManagedWorktree() { return observed(patch); } }), expected);
  console.log(`  PASS: ${label} fails closed`);
}
throwsCode(() => buildCandidate({ canonicalizePath() { return { version: 1, canonical_path: "/private/var/folders/quadwork/../escape" }; } }), "canonical_worktree_path_invalid");
throwsCode(() => buildCandidate({ readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "unknown" }; } }), "canonical_installed_state_invalid");

// Candidate invalidation is one immutable atomic plan: it pins the exact
// local candidate and every receipt to be retired, with no partial event plan.
{
  const candidate = buildCandidate();
  const review = { version: 1, receipt_kind: "review_receipt", receipt_id: "receipt_review_01", work_task_ref: copy(candidate.work_task_ref), candidate_digest: candidate.candidate_digest };
  const validation = { version: 1, receipt_kind: "validation_receipt", receipt_id: "receipt_validation_01", work_task_ref: copy(candidate.work_task_ref), candidate_digest: candidate.candidate_digest };
  const plan = planCandidateInvalidation({ version: 1, candidate, receipts: [validation, review], reason: "exact candidate superseded" });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(plan.transaction, "candidate_and_downstream_receipts");
  assert.equal(plan.events[0].type, "candidate_invalidated");
  assert.deepEqual(plan.events.slice(1).map((event) => event.type), ["downstream_receipt_invalidated", "downstream_receipt_invalidated"]);
  assert.equal(assertCandidateInvalidationPlan(plan), true);
  throwsCode(() => planCandidateInvalidation({ version: 1, candidate, receipts: [review, review], reason: "duplicate" }), "duplicate_downstream_receipt");
  throwsCode(() => planCandidateInvalidation({
    version: 1,
    candidate,
    receipts: [{ ...review, candidate_digest: "f".repeat(64) }],
    reason: "wrong candidate",
  }), "downstream_receipt_candidate_mismatch");
  const tampered = copy(plan);
  tampered.events.shift();
  throwsCode(() => assertCandidateInvalidationPlan(tampered), "invalid_candidate_invalidation_plan");
}

// Publication is rejected only when the intent targets this candidate's exact
// repository/branch; unrelated local branches have no authority inferred by
// this narrow candidate capability.
{
  const candidate = buildCandidate();
  for (const operation of ["push", "pull_request", "ci", "release"]) {
    throwsCode(() => rejectTaskCandidatePublication(candidate, {
      version: 1, operation, repository_key: "web", branch: "task/work-task-build",
    }), `work_task_candidate_${operation}_prohibited`);
  }
  assert.equal(rejectTaskCandidatePublication(candidate, {
    version: 1, operation: "push", repository_key: "web", branch: "task/other-local-work",
  }), true);
}

// Purity guard: M2 contains only deterministic contracts plus injected read
// seams. It does not load transport, configuration, process, or filesystem
// dependencies and cannot execute a managed-worktree mutation.
{
  const source = fs.readFileSync(path.join(__dirname, "work-task-candidate.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|config|mcp|review-cycle|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn|worktree add|reset --hard|unlink|rm -rf)/);
}

console.log("work-task-candidate.test.js: all assertions passed");
