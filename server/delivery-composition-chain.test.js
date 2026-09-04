"use strict";

// #1066: the Delivery Candidate composition chain driven end to end — Head
// runtime -> composition service -> composer -> Git-object adapter -> git —
// over a real repository, a real durable store, and the same `run_git` shape
// that server/index.js injects.  It proves that the server's event loop keeps
// advancing while a candidate composes, that one Delivery Candidate composes
// at most once at a time, and that a review, clone, or durable-state change
// during an awaited observation can never become the persisted result.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { createDeliveryGitObjectAdapter } = require("./delivery-git-object-adapter");
const { createDeliveryCandidateStore } = require("./delivery-candidate-store");
const { createDeliveryCompositionService } = require("./delivery-composition-service");
const { createDeliveryCandidateRuntime } = require("./delivery-candidate-runtime");

const installation_id = "installation_delivery_chain_1066";
const project_id = "quadwork";
const TOKEN = "head-token";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).trim(); }
function write(repository, relative, content) {
  const target = path.join(repository, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}
function commit(repository, message) { git(repository, ["add", "."]); git(repository, ["commit", "-q", "-m", message]); return git(repository, ["rev-parse", "HEAD"]); }
function configDirectory() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "qw-delivery-chain-")); fs.chmodSync(value, 0o700); return value; }
function rejectsCode(fn, code) { return assert.rejects(fn, (error) => error.code === code); }

// Mirrors the `run_git` injection of server/index.js deliveryGitObjectsForProject.
function runGit(request) {
  try {
    return { ok: true, output: execFileSync("git", request.args, { cwd: request.cwd, encoding: "utf8", stdio: "pipe", timeout: 5000, maxBuffer: 4 * 1024 * 1024, ...(typeof request.input === "string" ? { input: request.input } : {}) }) };
  } catch { return { ok: false, output: "" }; }
}

function stage(ref, base_sha, candidate_sha, name) {
  const worktreePath = `/private/var/quadwork/${name}-dev`;
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: `task/${name}`, worktree: { repository_key: "web", worktree_id: `wt_web_${name}`, path: worktreePath } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: `wt_web_${name}`, canonical_path: input.expected.canonical_path, branch: `task/${name}`, base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  const opened = openTaskReviewRound({ version: 1, candidate: copy(candidate), attempt: `attempt_${name}`, round: 1, opened_at: "2026-09-04T08:01:00.000Z" }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
  const receipt = (role) => { const payload = { version: 1, review_round_ref: copy(opened.review_round_ref), receipt_id: `receipt_${role}_${name}`, verdict: "approve", findings: [] }; return { ...payload, receipt_digest: crypto.createHash("sha256").update(stable(payload), "utf8").digest("hex") }; };
  const first = submitTaskReviewReceipt(opened, receipt("re1"), { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-04T08:02:00.000Z" });
  const released = submitTaskReviewReceipt(first.round, receipt("re2"), { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-04T08:03:00.000Z" }).round;
  return { candidate, terminal_review: { status: "released", review_round_ref: copy(released.review_round_ref), round_digest: released.round_digest, candidate_digest: candidate.candidate_digest, current_sha: candidate_sha,
    receipt_anchors: released.release.receipts.map((entry) => ({ reviewer_role: entry.reviewer_role, reviewer_generation: entry.reviewer_generation, receipt_id: entry.receipt.receipt_id, receipt_digest: entry.receipt.receipt_digest, verdict: entry.receipt.verdict })).sort((left, right) => left.reviewer_role.localeCompare(right.reviewer_role)) } };
}

function repositoryFixture(directory) {
  const repository = path.join(directory, "web");
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.email", "quadwork@example.test"]);
  git(repository, ["config", "user.name", "QuadWork Test"]);
  git(repository, ["remote", "add", "origin", "git@github.com:owner/web.git"]);
  write(repository, "readme.md", "# web\n");
  for (const dir of ["alpha", "beta", "gamma"]) for (const file of ["a.js", "b.js"]) write(repository, `pkg/${dir}/${file}`, `module.exports = 'base-${dir}-${file}';\n`);
  const base_sha = commit(repository, "base");
  git(repository, ["checkout", "-q", "-b", "candidate-a", base_sha]);
  write(repository, "pkg/alpha/a.js", "module.exports = 'candidate-a';\n");
  const candidate_a = commit(repository, "candidate a");
  git(repository, ["checkout", "-q", "-b", "candidate-b", base_sha]);
  write(repository, "pkg/beta/a.js", "module.exports = 'candidate-b';\n");
  const candidate_b = commit(repository, "candidate b");
  git(repository, ["checkout", "-q", "main"]);
  write(repository, "pkg/alpha/a.js", "module.exports = 'candidate-a';\n");
  write(repository, "pkg/beta/a.js", "module.exports = 'candidate-b';\n");
  const result_sha = commit(repository, "integrated result");
  const manifest = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [
    { task_key: "a", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1061, kind: "issue" }, goal: "change a", file_boundary: ["pkg/alpha/a.js"], validation: ["node-test"], dependencies: [] },
    { task_key: "b", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1062, kind: "issue" }, goal: "change b", file_boundary: ["pkg/beta/a.js"], validation: ["node-test"], dependencies: [] },
  ] }, { resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) }; } }), "2026-09-04T08:00:00.000Z");
  const source = { version: 1, registered_repository: { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" }, frozen_batch_manifest: manifest, delivery_mode: "integrated", cut_id: "cut_delivery_chain_1066", base_sha,
    staged_tasks: [stage(manifest.tasks[0].ref, base_sha, candidate_a, "a"), stage(manifest.tasks[1].ref, base_sha, candidate_b, "b")], deferred_exclusions: [] };
  return { repository, base_sha, result_sha, source };
}

// One real chain per section: a fresh config directory (durable store), the
// real adapter over the shared repository, and the real Head runtime.  `hook`
// runs before every Git call with the 1-based call ordinal and the request.
function chain(fixture, hook = null) {
  const config_dir = configDirectory();
  const calls = [];
  const adapter = createDeliveryGitObjectAdapter({
    repositories: [{ key: "web", repo: "Owner/Web", working_dir: fixture.repository, primary: true }],
    primary_agent_cwds: {}, repository_worktrees: {},
    canonicalize_path: (request) => fs.realpathSync(request.path),
    run_git: (request) => { calls.push(request.args[0]); if (hook) hook(request, calls.length); return runGit(request); },
    read_delivery_source: () => copy(fixture.source),
  });
  const sessions = new Map([[`${project_id}/head`, { projectId: project_id, agentId: "head", state: "running", term: {}, lifecycleState: "verified" }]]);
  const runtime = createDeliveryCandidateRuntime({
    config_dir, fs,
    read_config() { return { installation_id, projects: [{ id: project_id, archived: false }] }; },
    capture_project_admission() { return { project_id, generation: 4 }; },
    is_admission_current() { return true; },
    resolve_shim_principal(token) { return token === TOKEN ? { projectId: project_id, agentId: "head" } : null; },
    agent_sessions: sessions,
    read_delivery_source: () => copy(fixture.source),
    read_delivery_evidence: (request) => adapter.readDeliveryEvidence(request),
    create_candidate_store: createDeliveryCandidateStore,
    create_composition_service: createDeliveryCompositionService,
    repository_objects_for: (request) => adapter.repositoryObjectsFor(request),
  });
  const store = createDeliveryCandidateStore({ config_dir, fs });
  const compose = (ref, correlation_id, idempotency_key, expected_revision = 0) =>
    runtime.compose({ token: TOKEN, body: { delivery_candidate_ref: copy(ref), expected_revision, correlation_id, idempotency_key } });
  return { config_dir, calls, runtime, store, compose, close() { fs.rmSync(config_dir, { recursive: true, force: true }); } };
}
async function prepared(subject) {
  const record = await subject.runtime.prepare({ token: TOKEN, body: { repository_key: "web" } });
  assert.equal(record.kind, "delivery_candidate_initialized");
  subject.calls.length = 0;
  return record.record.delivery_candidate_ref;
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-delivery-chain-repo-"));
  const fixture = repositoryFixture(directory);
  const refsBefore = git(fixture.repository, ["show-ref"]);
  let soloCalls = 0;
  let persistedProof = null;
  try {
    // Responsiveness: a timer and an immediate scheduled while a composition
    // is in flight must run before it settles.  A composition that holds the
    // loop for its whole Git chain leaves both at zero.
    {
      const subject = chain(fixture);
      try {
        const ref = await prepared(subject);
        let ticks = 0, marker = false;
        const interval = setInterval(() => { ticks += 1; }, 1);
        const started = Date.now();
        const pending = subject.compose(ref, "compose-chain-1066", "compose-chain-1066");
        setImmediate(() => { marker = true; });
        const composed = await pending;
        const wall = Date.now() - started;
        clearInterval(interval);
        assert.equal(composed.kind, "delivery_candidate_composed");
        assert.equal(composed.replayed, false);
        assert.equal(subject.store.readSnapshot(ref).revision, 1);
        soloCalls = subject.calls.length;
        persistedProof = copy(subject.store.readSnapshot(ref).composition_proof);
        assert.ok(marker, `an immediate scheduled at compose start ran before composition settled (git calls=${soloCalls}, wall=${wall}ms)`);
        assert.ok(ticks > 0, `the event loop advanced during composition (ticks=${ticks}, git calls=${soloCalls}, wall=${wall}ms)`);
        console.log(`  PASS: the event loop advanced ${ticks} times while ${soloCalls} Git calls composed the candidate in ${wall}ms`);
      } finally { subject.close(); }
    }

    // Single flight: an exact duplicate joins the one in-flight composition,
    // and both callers observe the one persisted result.
    {
      const subject = chain(fixture);
      try {
        const ref = await prepared(subject);
        const [left, right] = await Promise.all([subject.compose(ref, "join-1066", "join-1066"), subject.compose(ref, "join-1066", "join-1066")]);
        assert.equal(left.kind, "delivery_candidate_composed");
        assert.deepEqual(copy(left), copy(right));
        assert.equal(subject.calls.length, soloCalls, "two identical concurrent requests ran exactly one Git chain");
        assert.equal(subject.store.readSnapshot(ref).lifecycle.accepted_operation.idempotency_key, "join-1066");
        console.log("  PASS: an exact duplicate compose joins the in-flight composition instead of starting a second Git chain");
      } finally { subject.close(); }
    }

    // Single flight: a conflicting identity for the same candidate fails
    // immediately, launches nothing, and the in-flight entry clears on settle.
    {
      const subject = chain(fixture);
      try {
        const ref = await prepared(subject);
        const first = subject.compose(ref, "first-1066", "first-1066");
        await rejectsCode(() => subject.compose(ref, "first-1066", "other-1066"), "delivery_composition_identity_collision");
        await rejectsCode(() => subject.compose(ref, "second-1066", "second-1066"), "delivery_candidate_compose_busy");
        assert.equal((await first).kind, "delivery_candidate_composed");
        assert.equal(subject.calls.length, soloCalls, "conflicting concurrent requests did not launch a second Git chain");
        await rejectsCode(() => subject.compose(ref, "second-1066", "second-1066"), "delivery_candidate_already_composed");
        assert.equal((await subject.compose(ref, "first-1066", "first-1066")).replayed, true);
        assert.equal(subject.calls.length, soloCalls, "after settle, the durable receipt answers without another Git chain");
        console.log("  PASS: conflicting concurrent composes fail busy or collision, and the durable receipt takes over after settle");
      } finally { subject.close(); }
    }

    // A review that changes after the first reviewed-task read, while the
    // chain is awaiting a Git object write, cannot reach the durable write.
    {
      const original = copy(fixture.source.staged_tasks[0].terminal_review);
      const subject = chain(fixture, (request, ordinal) => {
        if (request.args[0] === "mktree" && fixture.source.staged_tasks[0].terminal_review.round_digest === original.round_digest) {
          fixture.source.staged_tasks[0].terminal_review.round_digest = "0".repeat(64);
          assert.ok(ordinal > 1, "the review changed after the chain had already read it");
        }
      });
      try {
        const ref = await prepared(subject);
        await rejectsCode(() => subject.compose(ref, "review-1066", "review-1066"), "delivery_composition_rejected");
        assert.ok(subject.calls.includes("mktree"), "the review changed while a composition apply was in flight");
        const snapshot = subject.store.readSnapshot(ref);
        assert.equal(snapshot.revision, 0);
        assert.equal(snapshot.composition_proof, null);
        console.log("  PASS: a review changed during an awaited apply fails closed before the durable write");
      } finally { fixture.source.staged_tasks[0].terminal_review = original; subject.close(); }
    }

    // A registered clone whose HEAD moves during an awaited apply stops the
    // chain at the next current-clone recheck and persists nothing.
    {
      let moved = false;
      const subject = chain(fixture, (request) => {
        if (request.args[0] === "mktree" && !moved) { moved = true; git(fixture.repository, ["commit", "-q", "--allow-empty", "-m", "moved during composition"]); }
      });
      try {
        const ref = await prepared(subject);
        await rejectsCode(() => subject.compose(ref, "clone-1066", "clone-1066"), "delivery_composition_rejected");
        assert.ok(moved && subject.calls.length < soloCalls, `the chain stopped after the clone moved (${subject.calls.length} of ${soloCalls} calls)`);
        assert.equal(subject.store.readSnapshot(ref).revision, 0);
        console.log("  PASS: a clone HEAD moved during an awaited apply fails closed at the next current-clone recheck");
      } finally { git(fixture.repository, ["reset", "-q", "--hard", fixture.result_sha]); subject.close(); }
      assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), fixture.result_sha);
    }

    // Durable state written by another writer while the chain is awaiting a
    // Git call wins; the in-flight, now stale, composition cannot replace it.
    {
      let recorded = false;
      let subject = null;
      subject = chain(fixture, (request) => {
        if (request.args[0] !== "mktree" || recorded) return;
        recorded = true;
        subject.store.recordComposed({ expected: { delivery_candidate_ref: copy(subject.ref), revision: 0 }, delivery_manifest: copy(subject.store.readSnapshot(subject.ref).delivery_manifest),
          composition_proof: copy(persistedProof), correlation_id: "other-writer-1066", idempotency_key: "other-writer-1066" });
      });
      try {
        subject.ref = await prepared(subject);
        await rejectsCode(() => subject.compose(subject.ref, "stale-1066", "stale-1066"), "delivery_candidate_already_composed");
        assert.ok(recorded, "another writer recorded the candidate while the chain was in flight");
        const snapshot = subject.store.readSnapshot(subject.ref);
        assert.equal(snapshot.revision, 1);
        assert.equal(snapshot.lifecycle.accepted_operation.correlation_id, "other-writer-1066");
        console.log("  PASS: a candidate recorded by another writer during an await keeps that result; stale in-flight work does not win");
      } finally { subject.close(); }
    }

    assert.equal(git(fixture.repository, ["show-ref"]), refsBefore, "the chain moved no ref");
    assert.equal(git(fixture.repository, ["status", "--porcelain", "--untracked-files=all"]), "");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log("delivery-composition-chain.test.js: all assertions passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
