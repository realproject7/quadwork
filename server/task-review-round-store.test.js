"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const {
  TASK_REVIEW_ROUND_STORE_DIRECTORY,
  MAX_DOCUMENT_BYTES,
  TaskReviewRoundStoreError,
  createTaskReviewRoundStore,
} = require("./task-review-round-store");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const base_sha = "a".repeat(64);
const work_item = { repoKey: "web", repo: "Owner/Product-Web", number: 1059, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error && error.code === expected, `expected ${expected}`);
}
function root(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on("exit", () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
  return directory;
}

function manifest() {
  return buildBatchManifest({
    version: 1, installation_id, project_id, delivery_mode: "isolated",
    tasks: [{
      task_key: "sealed-review", repository_key: "web", work_item: copy(work_item), goal: "review exact local candidate",
      file_boundary: ["server/task-review-round-store.js"], validation: ["node:test"], dependencies: [],
    }],
  }, {
    resolveRegisteredIdentity(input) {
      return { ...input, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) };
    },
  });
}

function candidate(candidate_sha) {
  const ref = manifest().tasks[0].ref;
  return buildWorkTaskCandidate({
    version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: "task/sealed-review",
    worktree: { repository_key: "web", worktree_id: "wt_sealed_01", path: "/var/folders/quadwork/sealed-review" },
  }, {
    canonicalizePath(request) { return { version: 1, canonical_path: request.path.replace("/var/", "/private/var/") }; },
    inspectManagedWorktree() {
      return {
        version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_sealed_01",
        canonical_path: "/private/var/folders/quadwork/sealed-review", branch: "task/sealed-review",
        base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant",
      };
    },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}

function openInput(candidateValue, attempt = "attempt_1059", round = 1) {
  return {
    version: 1, candidate: candidateValue, attempt, round, opened_at: "2026-09-01T06:00:00.000Z",
  };
}
function assignments() {
  return { version: 1, reviewers: [{ reviewer_role: "re2", reviewer_generation: 22 }, { reviewer_role: "re1", reviewer_generation: 11 }] };
}
function reviewer(role, generation, received_at) {
  return { version: 1, reviewer_role: role, reviewer_generation: generation, received_at };
}
function receipt(ref, receipt_id, verdict, findings = []) {
  const payload = { version: 1, review_round_ref: copy(ref), receipt_id, verdict, findings: copy(findings) };
  return { ...payload, receipt_digest: digest(payload) };
}
function finding(id, summary = `sealed ${id}`) {
  return { finding_id: id, severity: "blocking", propagation: "local", summary };
}
function rawStoredRound(store, ref) {
  const document = JSON.parse(fs.readFileSync(store.pathFor(ref), "utf8"));
  const records = Object.values(document.records);
  assert.equal(records.length, 1);
  return records[0].round;
}

// One receipt survives restart, and every reviewer-facing pre-release read is
// own-only.  The durable document remains 0600 under owner-only directories.
{
  const home = root("qw-task-review-round-store-");
  const store = createTaskReviewRoundStore({ homeDir: "ignored", rootDir: home, randomBytes: () => Buffer.alloc(16, 7) });
  const candidateValue = candidate("b".repeat(64));
  const opened = store.openRound(openInput(candidateValue), assignments());
  assert.deepEqual(Object.keys(opened).sort(), ["candidate_digest", "review_round_ref", "status", "version"]);
  assert.equal(opened.status, "current");

  const re2Receipt = receipt(opened.review_round_ref, "receipt_re2_01", "request_changes", [finding("finding_re2_01")]);
  const first = store.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re2Receipt, reviewer("re2", 22, "2026-09-01T06:01:00.000Z"));
  assert.equal(first.outcome, "sealed");
  assert.equal(first.view.status, "sealed");
  assert.equal(first.view.own_receipt.receipt_id, "receipt_re2_01");
  assert.doesNotMatch(JSON.stringify(first.view), /re1/);

  const retry = store.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, copy(re2Receipt), reviewer("re2", 22, "2026-09-01T06:01:00.000Z"));
  assert.equal(retry.outcome, "idempotent");
  assert.equal(retry.view.own_receipt.receipt_id, "receipt_re2_01");

  const restarted = createTaskReviewRoundStore({ rootDir: home });
  const re1View = restarted.readForTrustedReviewer(opened.review_round_ref, opened.candidate_digest, reviewer("re1", 11, "2026-09-01T06:01:01.000Z"));
  assert.deepEqual(Object.keys(re1View).sort(), ["own_receipt", "review_round_ref", "status", "version"]);
  assert.equal(re1View.own_receipt, null);
  assert.doesNotMatch(JSON.stringify(re1View), /receipt_re2_01|finding_re2_01|re2/);
  const re2View = restarted.readForTrustedReviewer(opened.review_round_ref, opened.candidate_digest, reviewer("re2", 22, "2026-09-01T06:01:01.000Z"));
  assert.equal(re2View.own_receipt.receipt_id, "receipt_re2_01");

  const statePath = restarted.pathFor(opened.review_round_ref);
  assert.equal(path.basename(path.dirname(statePath)), TASK_REVIEW_ROUND_STORE_DIRECTORY);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);

  // The second receipt's receipt+release is one file replacement.  The
  // reviewer output retains only its own receipt and a redacted release fact.
  const re1Receipt = receipt(opened.review_round_ref, "receipt_re1_01", "approve", [finding("finding_re1_01")]);
  const released = restarted.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re1Receipt, reviewer("re1", 11, "2026-09-01T06:02:00.000Z"));
  assert.equal(released.outcome, "released");
  assert.equal(released.view.status, "released");
  assert.equal(released.view.own_receipt.receipt_id, "receipt_re1_01");
  assert.deepEqual(Object.keys(released.view.release).sort(), ["candidate_digest", "released_at", "transaction", "version"]);
  assert.doesNotMatch(JSON.stringify(released.view), /receipt_re2_01|finding_re2_01|re2/);
  const reconciliation = restarted.readReleasedForReconciliation(opened.review_round_ref, opened.candidate_digest);
  assert.deepEqual(Object.keys(reconciliation).sort(), ["candidate_digest", "receipt_verdicts", "released_at", "review_round_ref", "round_digest", "version"]);
  assert.deepEqual(reconciliation.receipt_verdicts.map((entry) => [entry.reviewer_role, entry.verdict]), [["re1", "approve"], ["re2", "request_changes"]]);
  assert.doesNotMatch(JSON.stringify(reconciliation), /finding_re1_01|finding_re2_01/);
  const delivery = restarted.readReleasedForDelivery({ version: 1, work_task_ref: candidateValue.work_task_ref, candidate_digest: opened.candidate_digest });
  assert.deepEqual(Object.keys(delivery).sort(), ["candidate_digest", "current_sha", "receipt_anchors", "review_round_ref", "round_digest", "status", "version"]);
  assert.deepEqual(delivery.receipt_anchors.map((entry) => [entry.reviewer_role, entry.verdict]), [["re1", "approve"], ["re2", "request_changes"]]);
  assert.doesNotMatch(JSON.stringify(delivery), /finding_re1_01|finding_re2_01/);
  const stored = rawStoredRound(restarted, opened.review_round_ref);
  assert.equal(stored.status, "released");
  assert.equal(stored.receipts.length, 2);
  assert.equal(stored.release.receipts.length, 2, "both sealed receipts and release were committed together");
  assert.equal(stored.audit.at(-1).type, "released");
  assert.equal(restarted.openRound(openInput(candidateValue), assignments()).status, "released", "the immutable opening retries without replacing later receipt state");
}

// Cancellation serializes against a late receipt in the durable transition:
// archive/candidate invalidation retains the immutable prior audit and cannot
// delete or mutate a local candidate artifact it has no authority over.
{
  const home = root("qw-task-review-round-cancel-");
  const candidateFile = path.join(home, "exact-local-candidate.txt");
  fs.writeFileSync(candidateFile, "local candidate remains untouched", { mode: 0o600 });
  const store = createTaskReviewRoundStore({ rootDir: home });
  const candidateValue = candidate("d".repeat(64));
  const opened = store.openRound(openInput(candidateValue, "attempt_cancel"), assignments());
  const re1Receipt = receipt(opened.review_round_ref, "receipt_re1_cancel", "request_changes", [finding("finding_cancel")]);
  store.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re1Receipt, reviewer("re1", 11, "2026-09-01T06:03:00.000Z"));
  const cancelled = store.cancelFromTrustedState({
    version: 1, review_round_ref: copy(opened.review_round_ref), candidate_digest: opened.candidate_digest,
    cause: "candidate_invalidated", reason: "exact candidate superseded", at: "2026-09-01T06:04:00.000Z",
  });
  assert.equal(cancelled.status, "cancelled");
  throwsCode(() => store.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest,
    receipt(opened.review_round_ref, "receipt_re2_late", "approve"), reviewer("re2", 22, "2026-09-01T06:04:01.000Z")), "task_review_round_cancelled");
  assert.equal(fs.readFileSync(candidateFile, "utf8"), "local candidate remains untouched");
  const stored = rawStoredRound(store, opened.review_round_ref);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.receipts.length, 1);
  assert.deepEqual(stored.audit.map((entry) => entry.type), ["opened", "receipt_sealed", "cancelled"]);
  assert.equal(stored.receipts[0].receipt.receipt_id, "receipt_re1_cancel", "sealed audit is immutable after cancellation");

  const archiveCandidate = candidate("e".repeat(64));
  const archiveOpened = store.openRound(openInput(archiveCandidate, "attempt_archive"), assignments());
  const archived = store.cancelFromTrustedState({
    version: 1, review_round_ref: copy(archiveOpened.review_round_ref), candidate_digest: archiveOpened.candidate_digest,
    cause: "project_archived", reason: "project archived", at: "2026-09-01T06:05:00.000Z",
  });
  assert.equal(archived.status, "cancelled");
  throwsCode(() => store.submitTrustedReceipt(archiveOpened.review_round_ref, archiveOpened.candidate_digest,
    receipt(archiveOpened.review_round_ref, "receipt_after_archive", "approve"), reviewer("re1", 11, "2026-09-01T06:05:01.000Z")), "task_review_round_cancelled");
}

// Wrong trusted context, revision, and candidate identity cannot mutate a
// stored round; each is an exact-key miss or a core trusted-context rejection.
{
  const home = root("qw-task-review-round-identity-");
  const store = createTaskReviewRoundStore({ rootDir: home });
  const opened = store.openRound(openInput(candidate("f".repeat(64)), "attempt_identity"), assignments());
  const before = fs.readFileSync(store.pathFor(opened.review_round_ref), "utf8");
  throwsCode(() => store.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest,
    receipt(opened.review_round_ref, "receipt_bad_generation", "approve"), reviewer("re1", 12, "2026-09-01T06:06:00.000Z")), "task_review_reviewer_generation_mismatch");
  const staleRef = copy(opened.review_round_ref);
  staleRef.task_revision = "9".repeat(64);
  staleRef.work_task_ref.task_revision = "9".repeat(64);
  throwsCode(() => store.readForTrustedReviewer(staleRef, opened.candidate_digest, reviewer("re1", 11, "2026-09-01T06:06:00.000Z")), "task_review_round_not_found");
  const crossInstallationRef = copy(opened.review_round_ref);
  crossInstallationRef.installation_id = "installation_beta_00001";
  crossInstallationRef.work_task_ref.installation_id = "installation_beta_00001";
  throwsCode(() => store.readForTrustedReviewer(crossInstallationRef, opened.candidate_digest, reviewer("re1", 11, "2026-09-01T06:06:00.000Z")), "task_review_round_not_found");
  throwsCode(() => store.readForTrustedReviewer(opened.review_round_ref, "8".repeat(64), reviewer("re1", 11, "2026-09-01T06:06:00.000Z")), "task_review_round_not_found");
  throwsCode(() => store.readReleasedForDelivery({ version: 1, work_task_ref: staleRef.work_task_ref, candidate_digest: opened.candidate_digest }), "task_review_round_not_found");
  assert.equal(fs.readFileSync(store.pathFor(opened.review_round_ref), "utf8"), before);
}

// Failed rename preserves the prior state and does not consume the late
// receipt.  A fresh normal instance can submit it exactly once afterwards.
{
  const home = root("qw-task-review-round-rename-");
  const normal = createTaskReviewRoundStore({ rootDir: home, randomBytes: () => Buffer.alloc(16, 3) });
  const opened = normal.openRound(openInput(candidate("1".repeat(64)), "attempt_rename"), assignments());
  const re1Receipt = receipt(opened.review_round_ref, "receipt_re1_before_crash", "approve", [finding("finding_before_crash")]);
  normal.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re1Receipt, reviewer("re1", 11, "2026-09-01T06:07:00.000Z"));
  const re2Receipt = receipt(opened.review_round_ref, "receipt_re2_after_crash", "approve", [finding("finding_after_crash")]);
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") return () => { throw new Error("simulated crash before replace"); };
      return Reflect.get(target, property);
    },
  });
  const failing = createTaskReviewRoundStore({ rootDir: home, fsImpl: failingFs, randomBytes: () => Buffer.alloc(16, 4) });
  throwsCode(() => failing.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re2Receipt,
    reviewer("re2", 22, "2026-09-01T06:08:00.000Z")), "task_review_round_store_persist_failed");
  const afterFailure = createTaskReviewRoundStore({ rootDir: home });
  const stillSealed = afterFailure.readForTrustedReviewer(opened.review_round_ref, opened.candidate_digest, reviewer("re1", 11, "2026-09-01T06:08:01.000Z"));
  assert.equal(stillSealed.status, "sealed");
  assert.equal(stillSealed.own_receipt.receipt_id, "receipt_re1_before_crash");
  assert.equal(rawStoredRound(afterFailure, opened.review_round_ref).receipts.length, 1);
  assert.equal(fs.readdirSync(path.dirname(afterFailure.pathFor(opened.review_round_ref))).some((name) => name.endsWith(".tmp")), false);
  assert.equal(afterFailure.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re2Receipt,
    reviewer("re2", 22, "2026-09-01T06:08:00.000Z")).outcome, "released");
}

// Two store instances may be live in separate server processes.  The first
// writer retains the project lock across read → pure transition → atomic
// replace, so an interleaved peer cannot read a stale one-receipt document and
// overwrite it.  Its explicit retry then produces the sole two-receipt release.
{
  const home = root("qw-task-review-round-writer-lock-");
  const normal = createTaskReviewRoundStore({ rootDir: home });
  const candidateValue = candidate("6".repeat(64));
  const opened = normal.openRound(openInput(candidateValue, "attempt_writer_lock"), assignments());
  const statePath = normal.pathFor(opened.review_round_ref);
  const re1Receipt = receipt(opened.review_round_ref, "receipt_re1_interleaved", "approve", [finding("finding_re1_interleaved")]);
  const re2Receipt = receipt(opened.review_round_ref, "receipt_re2_interleaved", "request_changes", [finding("finding_re2_interleaved")]);
  let interleaved = false;
  const interleavingFs = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") return (from, to) => {
        if (!interleaved && to === statePath) {
          interleaved = true;
          throwsCode(() => normal.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re2Receipt,
            reviewer("re2", 22, "2026-09-01T06:09:01.000Z")), "task_review_round_store_locked");
        }
        return target.renameSync(from, to);
      };
      return Reflect.get(target, property);
    },
  });
  const firstWriter = createTaskReviewRoundStore({ rootDir: home, fsImpl: interleavingFs });
  assert.equal(firstWriter.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re1Receipt,
    reviewer("re1", 11, "2026-09-01T06:09:00.000Z")).outcome, "sealed");
  assert.equal(interleaved, true, "the competing writer was attempted while the first lock remained held");
  assert.equal(normal.submitTrustedReceipt(opened.review_round_ref, opened.candidate_digest, re2Receipt,
    reviewer("re2", 22, "2026-09-01T06:09:01.000Z")).outcome, "released");
  const stored = rawStoredRound(normal, opened.review_round_ref);
  assert.deepEqual(stored.receipts.map((entry) => entry.reviewer_role), ["re1", "re2"]);
  assert.equal(stored.release.receipts.length, 2);
  assert.equal(stored.audit.filter((entry) => entry.type === "released").length, 1);

  // A stale-looking 0600 lock is never silently reaped.  All three mutation
  // entry points reject it, preserving an explicit operator recovery gate.
  const lockPath = `${statePath}.lock`;
  fs.writeFileSync(lockPath, "", { mode: 0o600 });
  throwsCode(() => normal.openRound(openInput(candidateValue, "attempt_writer_lock"), assignments()), "task_review_round_store_locked");
  throwsCode(() => normal.cancelFromTrustedState({
    version: 1, review_round_ref: copy(opened.review_round_ref), candidate_digest: opened.candidate_digest,
    cause: "candidate_invalidated", reason: "operator checks stale lock", at: "2026-09-01T06:09:02.000Z",
  }), "task_review_round_store_locked");
  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
  fs.unlinkSync(lockPath);
}

// Corrupt/unknown or oversized durable state fails closed for a new mutation.
// The module does not repair, overwrite, prune, or delete the unsafe document.
{
  const home = root("qw-task-review-round-corrupt-");
  const store = createTaskReviewRoundStore({ rootDir: home });
  const opened = store.openRound(openInput(candidate("2".repeat(64)), "attempt_corrupt"), assignments());
  const statePath = store.pathFor(opened.review_round_ref);
  fs.writeFileSync(statePath, '{"version":1,"unknown":true}', { mode: 0o600 });
  const corruptBefore = fs.readFileSync(statePath, "utf8");
  throwsCode(() => store.openRound(openInput(candidate("3".repeat(64)), "attempt_after_corrupt"), assignments()), "task_review_round_store_invalid");
  assert.equal(fs.readFileSync(statePath, "utf8"), corruptBefore);

  const oversizedHome = root("qw-task-review-round-oversized-");
  const oversizedStore = createTaskReviewRoundStore({ rootDir: oversizedHome });
  const oversizedCandidate = candidate("4".repeat(64));
  const oversizedRef = openInput(oversizedCandidate, "attempt_oversized").candidate.work_task_ref;
  const oversizedPath = oversizedStore.pathFor({
    version: 1, installation_id, project_id, work_task_ref: oversizedRef,
    task_revision: oversizedRef.task_revision, base_sha, candidate_sha: oversizedCandidate.candidate_sha, attempt: "attempt_oversized", round: 1,
  });
  fs.mkdirSync(path.dirname(oversizedPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(oversizedPath), 0o700);
  fs.writeFileSync(oversizedPath, "x".repeat(MAX_DOCUMENT_BYTES + 1), { mode: 0o600 });
  const oversizedBefore = fs.statSync(oversizedPath).size;
  throwsCode(() => oversizedStore.openRound(openInput(oversizedCandidate, "attempt_oversized"), assignments()), "task_review_round_store_invalid");
  assert.equal(fs.statSync(oversizedPath).size, oversizedBefore);
}

// An unsafe store directory cannot redirect a project document through a
// symlink; the external directory is never populated.
{
  const home = root("qw-task-review-round-symlink-");
  const external = root("qw-task-review-round-external-");
  fs.symlinkSync(external, path.join(home, TASK_REVIEW_ROUND_STORE_DIRECTORY));
  const store = createTaskReviewRoundStore({ rootDir: home });
  throwsCode(() => store.openRound(openInput(candidate("5".repeat(64)), "attempt_symlink"), assignments()), "task_review_round_store_unsafe");
  assert.deepEqual(fs.readdirSync(external), []);
}

// The durable layer may use filesystem primitives and an internal redacted
// released-anchor read, but has no route, config, MCP, chat, pipeline,
// publication, or pruning API.
{
  const source = fs.readFileSync(path.join(__dirname, "task-review-round-store.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|config|mcp|file-chat|work-task-pipeline|review-cycle)["']\s*\)/);
  assert.doesNotMatch(source, /(?:push|pull_request|release|delivery|prune)Round\s*\(/);
  assert.doesNotMatch(source, /(?:unlinkSync\([^)]*candidate|rmSync|rmdirSync)/);
  assert.equal(TaskReviewRoundStoreError.name, "TaskReviewRoundStoreError");
}

console.log("task-review-round-store.test.js: all assertions passed");
