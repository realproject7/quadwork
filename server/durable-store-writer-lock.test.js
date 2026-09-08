"use strict";

// #1064: a writer that dies inside its lock window must not wedge the store.
// Every block below drives a real store from a real child process: the child
// takes the store's writer lock and blocks, the parent proves the lock is
// honoured while the owner lives, kills the owner, and then expects the next
// writer to recover and commit.  Nothing here stubs a pid, a signal, or the
// lock body; the record on disk is exactly what the store wrote.
//
// #1074: the lock is no longer the existence of a file carrying an owner
// record; it is a whole-file advisory lock held on an open descriptor, and
// the `.lock` file is a permanent artifact nobody ever removes, empty when
// this code created it and otherwise carrying an inert legacy body.  Three
// blocks below are therefore successors rather than survivors:
//   - `malformedLockStaysClosed` and `unprovenOwnerStaysClosed` became
//     `lockMetadataDoesNotDecide`, which drives both directions: with no
//     holder every one of those bodies is acquired, and with a live holder
//     every one of them is refused.  Content is proven irrelevant either way,
//     instead of being proven to keep the store shut;
//   - `replacementIsNeverReaped` became
//     `identityMismatchIsRetriedThenRefused`: there is no reap to avoid, so
//     what is pinned is that a lock whose identity changed under the writer
//     is dropped and retried, bounded, and then refused;
//   - `reapRaceNeverOverlapsProtectedActions` became
//     `mutualExclusionAcrossProcesses`, a barrier race whose two children
//     both certainly reach their protected actions, plus two negative
//     controls that must report the overlap it must not.
//
// #1070: a holder child blocks forever by design, so an interrupted or
// mid-test-failed run used to strand one per store.  Six such orphans held
// locks for hours and cross-contaminated an unrelated suite.  Every holder
// this file spawns is therefore tracked by handle, and the top-level
// `finally` (and the interrupt path) kills only those handles, waits a
// bounded moment for each, and then drops the fixtures.  Nothing here ever
// consults the process table or matches a process by name.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskPipeline } = require("./work-task-pipeline");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");
const { createWorkTaskPipelineStore, workTaskPipelineStorePath } = require("./work-task-pipeline-store");
const { createBatchRequestStateStore, batchRequestStateStorePath } = require("./batch-request-state-store");
const { createDeliveryCandidateStore, deliveryCandidateStorePath } = require("./delivery-candidate-store");
const { createHeadControlAuditStore, headControlAuditStorePath } = require("./head-control-audit-store");
const { createTaskReviewRoundStore } = require("./task-review-round-store");
const { createHeadControlWorkTaskDomain, headControlWorkTaskDomainPath } = require("./head-control-work-task-domain");
const { createDurableStoreFiles, MAX_LOCK_ATTEMPTS } = require("./durable-store-files");
const { advisoryLockAdapter } = require("./durable-store-advisory-lock");

// A literal, not the module's own constant: an assertion imported from the
// thing it is checking moves with it and pins nothing.
const EXPECTED_LOCK_ATTEMPTS = 3;
assert.equal(MAX_LOCK_ATTEMPTS, EXPECTED_LOCK_ATTEMPTS, "the acquisition retry bound is three attempts");
const advisory = advisoryLockAdapter();
assert.equal(advisory.available, true, `the advisory lock primitive must be available: ${advisory.unavailable}`);

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const owner = { installation_id, project_id };
const binding = { installation_id, project_id, role: "head", generation: 7 };
const base_sha = "a".repeat(64);
const result_sha = "f".repeat(64);
const candidate_sha = "b".repeat(64);
const work_item = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };
// A holder is killed by its parent within milliseconds.  This bound exists
// only for a parent that died without reaping; it is far longer than any run
// of this file, so it can never stand in for the parent's own cleanup.
const HOLDER_SELF_DESTRUCT_MS = 120_000;
const REAP_TIMEOUT_MS = 2_000;
const ABORT_DEADLINE_MS = 3_000;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function resolveRegisteredIdentity(input) {
  return { installation_id: input.installation_id, project_id: input.project_id, repository_key: input.repository_key, work_item: copy(input.work_item), issue_body_revision: "c".repeat(64) };
}
function frozenManifest(delivery_mode) {
  return freezeBatchManifest(buildBatchManifest({
    version: 1, installation_id, project_id, delivery_mode,
    tasks: [{ task_key: "build", repository_key: "web", work_item: copy(work_item), goal: "hold a writer lock", file_boundary: ["server/work.js"], validation: ["node:test"], dependencies: [] }],
  }, { resolveRegisteredIdentity }), "2026-09-01T00:00:00.000Z");
}
function candidate(ref) {
  return buildWorkTaskCandidate({
    version: 1, work_task_ref: copy(ref), base_sha, candidate_sha, branch: "task/lock", worktree: { repository_key: "web", worktree_id: "wt_lock_01", path: "/var/folders/quadwork/lock" },
  }, {
    canonicalizePath(request) { return { version: 1, canonical_path: request.path.replace("/var/", "/private/var/") }; },
    inspectManagedWorktree() {
      return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_lock_01", canonical_path: "/private/var/folders/quadwork/lock", branch: "task/lock", base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" };
    },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
}
function reviewers() { return { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 11 }, { reviewer_role: "re2", reviewer_generation: 22 }] }; }
function receipt(ref, receipt_id) {
  const payload = { version: 1, review_round_ref: copy(ref), receipt_id, verdict: "approve", findings: [] };
  return { ...payload, receipt_digest: digest(payload) };
}
function deliveryManifest() {
  const batch = frozenManifest("integrated");
  const staged = candidate(batch.tasks[0].ref);
  const opened = openTaskReviewRound({ version: 1, candidate: staged, attempt: "attempt-lock", round: 1, opened_at: "2026-09-01T12:01:00.000Z" }, reviewers());
  const first = submitTaskReviewReceipt(opened, receipt(opened.review_round_ref, "receipt-re1-lock"), { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-01T12:02:00.000Z" });
  const released = submitTaskReviewReceipt(first.round, receipt(opened.review_round_ref, "receipt-re2-lock"), { version: 1, reviewer_role: "re2", reviewer_generation: 22, received_at: "2026-09-01T12:03:00.000Z" }).round;
  const paths = ["server/work.js"];
  return buildDeliveryManifest({
    version: 1,
    delivery_candidate_ref: { version: 1, installation_id, project_id, repository_key: "web", batch_manifest_digest: batch.manifest_digest, delivery_mode: "integrated", base_sha, result_sha, cut_id: "cut-lock" },
    frozen_batch_manifest: batch,
    staged_tasks: [{ candidate: staged, review_round: released }],
    deferred_exclusions: [],
    evidence: {
      boundary: { paths, boundary_digest: digest({ version: 1, paths }) },
      patch: { base_sha, result_sha, patch_digest: "1".repeat(64) },
      tree: { base_tree_sha: "2".repeat(64), result_tree_sha: "3".repeat(64), tree_digest: digest({ version: 1, base_tree_sha: "2".repeat(64), result_tree_sha: "3".repeat(64) }) },
    },
  }, {
    resolveRegisteredRepository(request) {
      return { version: 1, installation_id: request.installation_id, project_id: request.project_id, repository_key: request.repository_key, repository: "Owner/Product-Web" };
    },
  });
}
function audit(index) {
  return {
    version: 1, binding: copy(binding), action: "put_batch_manifest", correlation_id: `corr_lock_${index}`, idempotency_key: `idem_lock_${index}`,
    expected_revision: index, decision: "accepted", code: "head_control_applied",
    result: { action: "put_batch_manifest", applied: true, status: { revision: index + 1, archived: false, manifest_digest: "a".repeat(64), pipeline_digest: "b".repeat(64), manifest_frozen: true, cut_safe: true } },
  };
}

// Every store's first durable write, and the exact typed refusal each one
// raises while another writer holds its lock.  `mutate` runs in both the
// holding child and the recovering parent; `written` proves the recovery.
const STORES = {
  "work-task-pipeline-store": {
    locked: "work_task_pipeline_store_locked",
    changed: "work_task_pipeline_store_lock_failed",
    statePath: (directory) => workTaskPipelineStorePath(directory, owner),
    mutate(directory, fsImpl) {
      const manifest = frozenManifest("isolated");
      const store = createWorkTaskPipelineStore({ config_dir: directory, fs: fsImpl });
      return store.initialize({ expected: { ...owner, manifest_digest: manifest.manifest_digest, pipeline_digest: null }, manifest, pipeline: buildWorkTaskPipeline(manifest) });
    },
    written: (directory) => createWorkTaskPipelineStore({ config_dir: directory, fs }).readRecoverySnapshot(owner).manifest.frozen !== null,
  },
  "batch-request-state-store": {
    locked: "batch_request_state_store_locked",
    changed: "batch_request_state_store_lock_failed",
    statePath: (directory) => batchRequestStateStorePath(directory, owner),
    mutate(directory, fsImpl) {
      return createBatchRequestStateStore({ config_dir: directory, fs: fsImpl }).initialize({ expected: { ...owner, revision: null }, subscription_state: { version: 1, cursor: null, records: [] } });
    },
    written: (directory) => createBatchRequestStateStore({ config_dir: directory, fs }).readRecoverySnapshot(owner).revision === 0,
  },
  "delivery-candidate-store": {
    locked: "delivery_candidate_store_locked",
    changed: "delivery_candidate_store_lock_failed",
    statePath: (directory) => deliveryCandidateStorePath(directory, deliveryManifest().delivery_candidate_ref),
    mutate(directory, fsImpl) {
      const manifest = deliveryManifest();
      return createDeliveryCandidateStore({ config_dir: directory, fs: fsImpl }).initialize({ expected: { delivery_candidate_ref: copy(manifest.delivery_candidate_ref), revision: null }, delivery_manifest: manifest });
    },
    written: (directory) => createDeliveryCandidateStore({ config_dir: directory, fs }).readSnapshot(deliveryManifest().delivery_candidate_ref).lifecycle.status === "pending_composition",
  },
  "head-control-audit-store": {
    locked: "head_control_audit_store_locked",
    changed: "head_control_audit_store_lock_failed",
    statePath: (directory) => headControlAuditStorePath(directory, binding),
    mutate(directory, fsImpl) { return createHeadControlAuditStore({ config_dir: directory, fs: fsImpl }).append({ binding, audit: audit(0) }); },
    written: (directory) => createHeadControlAuditStore({ config_dir: directory, fs }).read(binding).length === 1,
  },
  "task-review-round-store": {
    locked: "task_review_round_store_locked",
    changed: "task_review_round_store_unsafe",
    statePath: (directory) => {
      const store = createTaskReviewRoundStore({ rootDir: directory });
      return store.pathFor(openTaskReviewRound({ version: 1, candidate: candidate(frozenManifest("isolated").tasks[0].ref), attempt: "attempt-lock", round: 1, opened_at: "2026-09-01T06:00:00.000Z" }, reviewers()).review_round_ref);
    },
    mutate(directory, fsImpl) {
      const store = createTaskReviewRoundStore({ rootDir: directory, fsImpl });
      return store.openRound({ version: 1, candidate: candidate(frozenManifest("isolated").tasks[0].ref), attempt: "attempt-lock", round: 1, opened_at: "2026-09-01T06:00:00.000Z" }, reviewers());
    },
    written(directory) {
      const store = createTaskReviewRoundStore({ rootDir: directory });
      const opened = openTaskReviewRound({ version: 1, candidate: candidate(frozenManifest("isolated").tasks[0].ref), attempt: "attempt-lock", round: 1, opened_at: "2026-09-01T06:00:00.000Z" }, reviewers());
      return store.readForTrustedReviewer(opened.review_round_ref, opened.candidate_digest, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-01T06:01:00.000Z" }).status === "sealed";
    },
  },
  "head-control-work-task-domain": {
    locked: "head_control_work_task_state_locked",
    changed: "head_control_work_task_state_lock_failed",
    statePath: (directory) => headControlWorkTaskDomainPath(directory, binding),
    mutate(directory, fsImpl) {
      return createHeadControlWorkTaskDomain({ binding, config_dir: directory, fs: fsImpl, resolve_registered_identity: resolveRegisteredIdentity, now: () => "2026-09-02T00:00:00.000Z" }).initialize();
    },
    written: (directory) => JSON.parse(fs.readFileSync(headControlWorkTaskDomainPath(directory, binding), "utf8")).stage === "empty",
  },
};

// Child mode: take the store's writer lock and never leave it.  The hook is
// the lock's own `lstat`, which the primitive performs to check the identity
// of the file it just locked — so it runs strictly after the kernel granted
// the lock and strictly before the store's action.  The parent therefore
// kills a process that really holds the lock and really committed nothing.
if (process.argv[2] === "--hold-writer-lock") {
  const holding = Object.create(fs);
  holding.lstatSync = (target) => {
    const stats = fs.lstatSync(target);
    if (typeof target === "string" && target.endsWith(".lock")) {
      fs.writeSync(1, `HOLDING ${process.pid}\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLDER_SELF_DESTRUCT_MS);
      // Reached only when no parent ever killed this holder.  Leaving the
      // lock on disk is exactly what the SIGKILL the parent normally sends
      // would leave, so the store's own recovery still governs it.
      process.exit(3);
    }
    return stats;
  };
  STORES[process.argv[3]].mutate(process.argv[4], holding);
  return;
}
// Contender mode: one audit append that holds the lock for a visible window,
// reporting when the lock was taken and released so the parent can prove
// mutual exclusion across processes from the wall clock alone.
if (process.argv[2] === "--contend") {
  // ENTER is the identity check the primitive runs once the kernel has
  // granted the lock; EXIT is the close of that very descriptor, which is
  // what actually hands the lock back.  Both are reported from the exact
  // syscalls, so the window printed is never wider than the window held.
  const lockDescriptors = new Set();
  let entered = false;
  const contending = Object.create(fs);
  contending.openSync = (target, ...rest) => {
    const descriptor = fs.openSync(target, ...rest);
    if (typeof target === "string" && target.endsWith(".lock")) lockDescriptors.add(descriptor);
    return descriptor;
  };
  contending.closeSync = (descriptor) => {
    const held = lockDescriptors.delete(descriptor);
    fs.closeSync(descriptor);
    if (held && entered) fs.writeSync(1, `EXIT ${Date.now()}\n`);
  };
  contending.lstatSync = (target) => {
    const stats = fs.lstatSync(target);
    if (!entered && typeof target === "string" && target.endsWith(".lock")) {
      entered = true;
      fs.writeSync(1, `ENTER ${Date.now()}\n`);
    }
    return stats;
  };
  contending.renameSync = (from, to) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    fs.renameSync(from, to);
  };
  try {
    createHeadControlAuditStore({ config_dir: process.argv[3], fs: contending }).append({ binding, audit: audit(Number(process.argv[4])) });
    fs.writeSync(1, "OK\n");
  } catch (error) {
    fs.writeSync(1, `REFUSED ${error && error.code}\n`);
  }
  return;
}

// Mutual exclusion across processes: two writers must never be inside their
// protected actions at once.  The lock is a kernel-held advisory lock on the
// `.lock` file's open descriptor, so the claim under test is precisely "the
// kernel refuses the second holder of that inode" — and the only way to
// believe an empty overlap report is to show that the same harness reports an
// overlap when the primitive is wrong in each of the two ways it can be
// wrong.  Hence three adapters driven through one identical race:
//
//   kernel         the real primitive on the real lock file  -> overlap 0
//   bypass         no kernel call at all, always grants       -> overlap > 0
//   private-inode  the real kernel call, on a file private to
//                  each process                               -> overlap > 0
//
// `private-inode` is the one that matters: it proves the exclusion comes from
// the shared inode rather than merely from the adapter having been called.
//
// Both children pass a filesystem barrier before either attempts the lock, so
// neither can win by starting first, and each reports that it saw the other
// arrive.  A child that loses retries until it wins, so both certainly reach
// their protected action and an empty overlap can never mean "one never ran".
const SECTION_PREFIX = "section-";
const RENDEZVOUS_DEADLINE_MS = 15_000;
// How long a racer stays inside its protected action.  It is a safety net,
// not the mechanism: the wait below ends as soon as the other racer has
// either completed its entry observation, been turned away, or finished.
// Publishing a section marker is not an observation: removing our marker
// before the peer snapshots it can make both entry reports miss an overlap.
// A hold that ended on a timer instead would make this
// race a question about scheduling latency, and it flaked as exactly that
// under load before the stop conditions were made explicit.
const SECTION_HOLD_MS = 5_000;
const RACE_ADAPTERS = Object.freeze(["kernel", "bypass", "private-inode"]);

class RaceStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RaceStoreError";
    this.code = code;
  }
}
const RACE_CODES = Object.freeze({
  options: "race_options",
  unreadable: "race_unreadable",
  symlink_rejected: "race_symlink",
  insecure_permissions: "race_insecure",
  write_failed: "race_write_failed",
  locked: "race_locked",
  lock_unsafe: "race_lock_unsafe",
  lock_failed: "race_lock_failed",
  lock_acquire_changed: "race_lock_acquire_changed",
  lock_release_changed: "race_lock_release_changed",
  lock_release_failed: "race_lock_release_failed",
});

function sleepBriefly() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
function waitForAny(rendezvous, names, budgetMs = RENDEZVOUS_DEADLINE_MS, onPending = () => {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    for (const name of names) {
      if (fs.existsSync(path.join(rendezvous, name))) return name;
    }
    if (Date.now() >= deadline) return null;
    onPending();
    sleepBriefly();
  }
}
// One definition of "another writer is inside its protected action right now",
// used by the race and by the negative control that proves it can see one.
// The marker is published before the snapshot is taken, so a report of
// `others` is only ever produced when both markers were on disk together.
function enterSection(rendezvous, role, beforeSnapshot = () => {}) {
  fs.writeFileSync(path.join(rendezvous, `${SECTION_PREFIX}${role}`), String(process.pid), { mode: 0o600, flag: "wx" });
  beforeSnapshot();
  const others = fs.readdirSync(rendezvous).filter((name) => name.startsWith(SECTION_PREFIX) && name !== `${SECTION_PREFIX}${role}`);
  fs.writeSync(1, `SECTION-ENTER ${role} ${JSON.stringify(others)}\n`);
  // A peer may remove its marker only after this snapshot has finished.
  fs.writeFileSync(path.join(rendezvous, `observed-${role}`), "", { mode: 0o600, flag: "wx" });
}
function exitSection(rendezvous, role) {
  try { fs.unlinkSync(path.join(rendezvous, `${SECTION_PREFIX}${role}`)); } catch { /* the marker is this process's own */ }
  fs.writeSync(1, `SECTION-EXIT ${role}\n`);
}

// The three primitives the race is run against.  Only `kernel` is the one
// the durable stores use; the other two exist to make an empty overlap
// report falsifiable, and both are deliberately wrong in a specific way.
function raceAdapter(name, rendezvous) {
  if (name === "kernel") return undefined;
  if (name === "bypass") return { tryLock: () => true, unlock() { /* nothing was ever taken */ } };
  if (name === "private-inode") {
    const descriptor = fs.openSync(path.join(rendezvous, `private-${process.pid}`), "w+", 0o600);
    return { tryLock: () => advisory.tryLock(descriptor), unlock: () => advisory.unlock(descriptor) };
  }
  throw new Error(`unknown race adapter ${name}`);
}

// Race mode: both roles drive the same real primitive over the same real
// lock file, meeting at a barrier first so neither wins by being early.
if (process.argv[2] === "--mutex-race") {
  const adapterName = process.argv[3];
  const role = process.argv[4];
  const workDirectory = process.argv[5];
  const rendezvous = process.argv[6];
  const delayedObservation = process.argv[7] === "delayed-observation";
  const other = role === "left" ? "right" : "left";
  const target = path.join(workDirectory, "state.json");
  const files = createDurableStoreFiles({
    fs, error: RaceStoreError, codes: RACE_CODES, advisory_lock: raceAdapter(adapterName, rendezvous),
  });

  fs.writeFileSync(path.join(rendezvous, `barrier-${role}`), "", { mode: 0o600 });
  if (waitForAny(rendezvous, [`barrier-${other}`]) === null) {
    fs.writeSync(1, `BARRIER-TIMEOUT ${role}\n`);
    process.exit(4);
  }
  fs.writeSync(1, `BARRIER ${role}\n`);
  if (delayedObservation && role === "right") {
    assert.equal(waitForAny(rendezvous, ["observed-left"]), "observed-left");
  }

  // A loser retries rather than giving up, so both roles certainly enter
  // their protected action and "no overlap" can never mean "never ran".
  const deadline = Date.now() + RENDEZVOUS_DEADLINE_MS;
  let refusals = 0;
  for (;;) {
    try {
      files.withWriterLock(target, () => {
        enterSection(rendezvous, role, () => {
          if (delayedObservation && role === "right") {
            // Force the old failing order: left already snapshotted an empty
            // section; right has published its marker but cannot snapshot
            // until left proves it is still waiting for that observation.
            assert.equal(waitForAny(rendezvous, ["observation-pending-left"]), "observation-pending-left");
          }
        });
        // Stay inside until the other racer's fate is settled, so a second
        // entrant is certainly seen if one is possible at all.  Exactly one
        // of these three becomes true, and which one is the whole result:
        // it finished its snapshot (a broken primitive), it was turned away
        // (a working one), or it already finished (it went first).
        const settled = waitForAny(rendezvous, [`observed-${other}`, `refused-${other}`, `${other}-done`], SECTION_HOLD_MS, () => {
          if (delayedObservation && role === "left" && fs.existsSync(path.join(rendezvous, `${SECTION_PREFIX}${other}`))) {
            fs.writeFileSync(path.join(rendezvous, "observation-pending-left"), "", { mode: 0o600 });
          }
        });
        assert.notEqual(settled, null, `${role}: peer observation or refusal never arrived`);
        exitSection(rendezvous, role);
      });
      // How many times this role was actually turned away.  With a correct
      // primitive the loser must be turned away at least once while the
      // winner sits in its section; a race where nobody was ever refused
      // never exercised exclusion at all, whatever its overlap report says.
      fs.writeSync(1, `REFUSALS ${role} ${refusals}\n`);
      fs.writeSync(1, "OK\n");
      break;
    } catch (error) {
      if (error && error.code === RACE_CODES.locked && Date.now() < deadline) {
        refusals += 1;
        // Published so the holder can stop waiting the moment exclusion is
        // observed working, instead of burning the safety net every run.
        fs.writeFileSync(path.join(rendezvous, `refused-${role}`), "", { mode: 0o600 });
        sleepBriefly();
        continue;
      }
      fs.writeSync(1, `REFUSALS ${role} ${refusals}\n`);
      fs.writeSync(1, `REFUSED ${error && error.code}\n`);
      break;
    }
  }
  fs.writeFileSync(path.join(rendezvous, `${role}-done`), "", { mode: 0o600 });
  return;
}

// Negative control: no store and no lock, two processes ordered so that their
// sections certainly overlap.  It exists so that an empty overlap report from
// the race above is evidence of exclusion rather than of a blind detector.
if (process.argv[2] === "--marker-overlap") {
  const role = process.argv[3];
  const rendezvous = process.argv[4];
  if (role === "first") {
    enterSection(rendezvous, "first");
    fs.writeFileSync(path.join(rendezvous, "first-armed"), "", { mode: 0o600 });
    waitForAny(rendezvous, ["second-done"]);
    exitSection(rendezvous, "first");
  } else {
    waitForAny(rendezvous, ["first-armed"]);
    enterSection(rendezvous, "second");
    exitSection(rendezvous, "second");
    fs.writeFileSync(path.join(rendezvous, "second-done"), "", { mode: 0o600 });
  }
  return;
}

function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error && error.code === expected, `expected ${expected}`);
}
// Every holder this process spawned, by handle.  Membership is the only
// thing that ever authorises a kill: no pattern, no name, no process table.
const holders = new Set();
const fixtures = new Set();

function live(holder) { return holder.child.exitCode === null && holder.child.signalCode === null; }
function killLiveHolders() {
  const killed = [];
  for (const holder of holders) {
    if (!live(holder)) continue;
    try { holder.child.kill("SIGKILL"); killed.push(holder); } catch { /* already gone */ }
  }
  return killed;
}
async function reapHolders() {
  const killed = killLiveHolders();
  if (killed.length === 0) return;
  const bound = new Promise((resolve) => setTimeout(resolve, REAP_TIMEOUT_MS).unref());
  await Promise.all(killed.map((holder) => Promise.race([holder.exited, bound])));
}
function removeFixtures() {
  for (const directory of fixtures) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort on teardown */ }
  }
  fixtures.clear();
}
// An interrupt cannot await, so it kills the tracked handles and drops the
// fixtures synchronously.  A SIGKILL of this process itself is beyond any
// handler; the holder's own bounded wait is the only backstop for that.
function onInterrupt(code) {
  return () => {
    killLiveHolders();
    removeFixtures();
    process.exit(code);
  };
}
process.on("SIGINT", onInterrupt(130));
process.on("SIGTERM", onInterrupt(143));

function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-writer-lock-"));
  fs.chmodSync(directory, 0o700);
  // Teardown is deliberately not per-scope.  A fixture removed while its
  // holder is still alive is exactly the ordering that stranded locks, so
  // every fixture is dropped in one place, after the holders are reaped.
  fixtures.add(directory);
  return run(directory);
}
function holdLock(name, directory) {
  const child = spawn(process.execPath, [__filename, "--hold-writer-lock", name, directory], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const holding = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = /^HOLDING (\d+)\n/m.exec(output);
      if (match) resolve(Number(match[1]));
    });
    exited.then((outcome) => reject(new Error(`holder exited before taking the lock: ${JSON.stringify(outcome)} ${output}`)));
  });
  const holder = { child, exited, holding };
  holders.add(holder);
  return holder;
}
// The `.lock` file is now a permanent artifact, so "clean" means exactly one
// lock, named for this store's own state file, held by nobody, and no
// temporary at all.  The `.tmp` half of the old assertion is kept verbatim:
// a leaked temporary is still a leak.
function artifacts(statePath) {
  return fs.readdirSync(path.dirname(statePath)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"));
}
function temporaries(statePath) {
  return fs.readdirSync(path.dirname(statePath)).filter((name) => name.endsWith(".tmp"));
}
function unheld(lockPath) {
  const descriptor = fs.openSync(lockPath, "r+");
  try {
    if (!advisory.tryLock(descriptor)) return false;
    advisory.unlock(descriptor);
    return true;
  } finally { fs.closeSync(descriptor); }
}
function assertSettled(name, statePath) {
  const lockPath = `${statePath}.lock`;
  assert.deepEqual(artifacts(statePath), [path.basename(lockPath)], `${name}: the only artifact left is the permanent lock`);
  assert.deepEqual(temporaries(statePath), [], `${name}: no temporary artifact remains`);
  assert.equal(fs.lstatSync(lockPath).size, 0, `${name}: the permanent lock carries no body`);
  assert.equal(fs.lstatSync(lockPath).mode & 0o777, 0o600, `${name}: the permanent lock stays owner-only`);
  assert.equal(unheld(lockPath), true, `${name}: the permanent lock is held by nobody`);
}
function isDead(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}

async function deadWriterIsRecovered(name) {
  const store = STORES[name];
  await withDirectory(async (directory) => {
    const statePath = store.statePath(directory);
    const lockPath = `${statePath}.lock`;
    const holder = holdLock(name, directory);
    const holderPid = await holder.holding;
    assert.equal(fs.lstatSync(lockPath).isFile(), true, `${name}: the child left a writer lock on disk`);
    assert.equal(fs.existsSync(statePath), false, `${name}: nothing was committed while the lock is held`);

    // Negative control: a live owner is honoured, and the lock is held in
    // the kernel rather than merely present on disk — a file that exists but
    // is unheld would make the refusal below prove nothing.
    throwsCode(() => store.mutate(directory, fs), store.locked);
    assert.equal(unheld(lockPath), false, `${name}: the live owner really holds the lock`);
    assert.equal(fs.lstatSync(lockPath).size, 0, `${name}: the lock carries no owner record`);

    const identity = fs.lstatSync(lockPath);
    holder.child.kill("SIGKILL");
    const outcome = await holder.exited;
    assert.equal(outcome.signal, "SIGKILL");
    assert.equal(isDead(holderPid), true, `${name}: the owner pid is gone`);
    assert.equal(fs.lstatSync(lockPath).isFile(), true, `${name}: the dead owner's lock survives its process`);
    // Nothing reclaims it: the kernel released the lock when the killed
    // process's descriptors closed, so the very same inode is free again.
    assert.equal(unheld(lockPath), true, `${name}: the dead owner's lock is free without any recovery step`);

    // The defect: the next writer must recover from the dead owner's lock
    // and commit, instead of failing closed until an operator deletes it.
    let result;
    try { result = store.mutate(directory, fs); }
    catch (error) {
      assert.fail(`${name}: dead-writer lock wedged recovery with ${error && error.code}`);
    }
    assert.ok(result, `${name}: recovery returned a snapshot`);
    assert.equal(store.written(directory), true, `${name}: the recovered write is durable and readable`);
    const recovered = fs.lstatSync(lockPath);
    assert.equal(recovered.ino, identity.ino, `${name}: recovery reused the dead owner's own lock inode`);
    assert.equal(recovered.dev, identity.dev, `${name}: recovery reused the dead owner's own lock device`);
    assertSettled(name, statePath);
  });
}

// Successor to `malformedLockStaysClosed` and `unprovenOwnerStaysClosed`.
// Under the advisory lock a lock file's body is not evidence of anything, so
// the claim worth pinning is that it is not evidence *either way*: with
// nobody holding the lock every one of these bodies is acquired, and with a
// live holder every one of them is refused.  A one-directional test would
// pass just as well against an implementation that refused everything.
const LOCK_BODIES = Object.freeze([
  "",
  "locked\n",
  `${process.pid}.${"ab".repeat(16)}`,
  "{\"pid\":0}",
  JSON.stringify({ version: 1, pid: 1, token: "0".repeat(32), host: os.hostname(), created_at: 0 }),
  JSON.stringify({ version: 1, pid: process.pid, token: crypto.randomBytes(16).toString("hex"), host: "elsewhere.invalid", created_at: Date.now() }),
]);

// Direction one: no holder.  Every body is acquired, and none is rewritten.
async function lockMetadataNeverBlocks(name) {
  const store = STORES[name];
  for (const body of LOCK_BODIES) {
    await withDirectory(async (directory) => {
      const statePath = store.statePath(directory);
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${statePath}.lock`, body, { mode: 0o600, flag: "wx" });
      const label = `${name}/${JSON.stringify(body.slice(0, 30))}`;
      let result;
      try { result = store.mutate(directory, fs); }
      catch (error) { assert.fail(`${label}: an unheld lock was refused with ${error && error.code}`); }
      assert.ok(result, `${label}: the writer committed`);
      assert.equal(store.written(directory), true, `${label}: the write is durable`);
      assert.equal(fs.readFileSync(`${statePath}.lock`, "utf8"), body, `${label}: acquiring never rewrote the lock`);
      assert.deepEqual(temporaries(statePath), [], `${label}: no temporary remains`);
    });
  }
}

// Direction two: one real holder process, and the same bodies written into
// the very lock file it holds.  The inode is untouched, so the kernel lock
// survives the rewrite; every body is refused with the store's typed code.
async function lockMetadataNeverAdmits(name) {
  const store = STORES[name];
  await withDirectory(async (directory) => {
    const statePath = store.statePath(directory);
    const lockPath = `${statePath}.lock`;
    const holder = holdLock(name, directory);
    await holder.holding;
    const identity = fs.lstatSync(lockPath);
    for (const body of LOCK_BODIES) {
      fs.writeFileSync(lockPath, body, { encoding: "utf8" });
      const label = `${name}/${JSON.stringify(body.slice(0, 30))}`;
      assert.equal(fs.lstatSync(lockPath).ino, identity.ino, `${label}: the body was rewritten in place`);
      throwsCode(() => store.mutate(directory, fs), store.locked);
      assert.equal(fs.readFileSync(lockPath, "utf8"), body, `${label}: a refusal never rewrote the lock`);
      assert.equal(fs.existsSync(statePath), false, `${label}: nothing was committed behind the holder`);
    }
    holder.child.kill("SIGKILL");
    assert.equal((await holder.exited).signal, "SIGKILL");
    // The same file, with the last of those bodies still in it, is now
    // simply acquired — which is the point: the body never decided anything.
    assert.ok(store.mutate(directory, fs), `${name}: the released lock is acquired with the same body in place`);
    assert.equal(fs.lstatSync(lockPath).ino, identity.ino, `${name}: the acquisition reused the same inode`);
  });
}

// Successor to `replacementIsNeverReaped`.  There is no reap to avoid any
// more, so what is pinned is the check that replaced it: the file the kernel
// granted the lock on must still be the file the path names.  When it is not,
// the writer drops the lock and opens the path again — bounded, and without
// touching whatever is now there — and then refuses.
//
// The stub forges exactly that disagreement: `fstat` describes the object we
// locked, the stubbed `lstat` describes a different one.
async function identityMismatchIsRetriedThenRefused(name) {
  const store = STORES[name];
  await withDirectory(async (directory) => {
    const statePath = store.statePath(directory);
    const lockPath = `${statePath}.lock`;
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, "planted", { mode: 0o600, flag: "wx" });
    let opens = 0;
    const forgingFs = Object.create(fs);
    forgingFs.openSync = (target, ...rest) => {
      if (typeof target === "string" && target === lockPath) opens += 1;
      return fs.openSync(target, ...rest);
    };
    forgingFs.lstatSync = (target) => {
      const stats = fs.lstatSync(target);
      if (typeof target === "string" && target === lockPath) stats.ino += 1;
      return stats;
    };
    const started = Date.now();
    throwsCode(() => store.mutate(directory, forgingFs), store.changed);
    assert.equal(opens, EXPECTED_LOCK_ATTEMPTS, `${name}: the mismatch is retried exactly three times`);
    assert.ok(Date.now() - started < 2000, `${name}: bounded retries never wait`);
    assert.equal(fs.readFileSync(lockPath, "utf8"), "planted", `${name}: the file at the lock path is never touched`);
    assert.equal(unheld(lockPath), true, `${name}: every abandoned attempt released its lock`);
    assert.equal(fs.existsSync(statePath), false, `${name}: nothing was written behind a mismatched lock`);
  });
}

// Concurrent contenders on one store: at most one holds the lock at any
// instant, every contender either commits or is refused with the typed
// code, every commit is readable afterwards, and nothing is left behind.
async function contendersYieldOneWriterAtATime() {
  await withDirectory(async (directory) => {
    const contenders = Array.from({ length: 6 }, (_, index) => {
      const child = spawn(process.execPath, [__filename, "--contend", directory, String(index)], { stdio: ["ignore", "pipe", "inherit"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk.toString(); });
      return new Promise((resolve) => child.on("exit", (code) => resolve({ code, output })));
    });
    const outcomes = await Promise.all(contenders);
    const windows = [];
    let committed = 0;
    for (const outcome of outcomes) {
      assert.equal(outcome.code, 0, outcome.output);
      const lines = outcome.output.trim().split("\n");
      const verdict = lines[lines.length - 1];
      if (verdict === "OK") {
        committed += 1;
        const enter = Number(/^ENTER (\d+)$/m.exec(outcome.output)[1]);
        const exit = Number(/^EXIT (\d+)$/m.exec(outcome.output)[1]);
        windows.push({ enter, exit });
      } else {
        assert.equal(verdict, "REFUSED head_control_audit_store_locked", outcome.output);
        assert.doesNotMatch(outcome.output, /^ENTER/m, "a refused contender never held the lock");
      }
    }
    assert.ok(committed >= 1, "at least one contender committed");
    windows.sort((left, right) => left.enter - right.enter);
    for (let index = 1; index < windows.length; index += 1) {
      assert.ok(windows[index - 1].exit <= windows[index].enter, `lock windows overlap: ${JSON.stringify(windows)}`);
    }
    const statePath = headControlAuditStorePath(directory, binding);
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(stored.records.length, committed, "every committed winner is durable and none was lost or duplicated");
    assert.equal(createHeadControlAuditStore({ config_dir: directory, fs }).read(binding).length, committed);
    assertSettled("head-control-audit-store", statePath);
  });
}

// Abort harness, child half: take a real holder lock, announce the pid and
// the fixture it owns, and then die the two ways a run actually dies — an
// assertion that fails mid-test, and an interrupt.  Neither path gets to
// reach the kill that the passing path performs.
const ABORT_KINDS = Object.freeze(["assertion", "interrupt"]);
async function abortHarnessChild(kind) {
  await withDirectory(async (directory) => {
    const holder = holdLock("head-control-audit-store", directory);
    fs.writeSync(1, `ABORT-HOLDER ${await holder.holding}\nABORT-FIXTURE ${directory}\n`);
    if (kind === "interrupt") {
      process.kill(process.pid, "SIGINT");
      // Keep the loop alive so the interrupt path — not this timer — is what
      // ends the process; the timer only bounds a handler that never runs.
      await new Promise(() => { setTimeout(() => { fs.writeSync(1, "ABORT-STUCK\n"); process.exit(9); }, ABORT_DEADLINE_MS); });
    }
    assert.fail("forced mid-test abort while a holder child is live");
  });
}
// Abort harness, parent half: the aborted run must leave no holder of its
// own alive and no fixture behind, and the very next check in this process
// must behave exactly as it does on a clean machine.
async function abortLeavesNoHolderBehind(kind) {
  const child = spawn(process.execPath, [__filename, "--abort-harness", kind], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", () => { /* the aborted run is expected to print its failure */ });
  const outcome = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  assert.notEqual(outcome.code, 0, `${kind}: the aborted run must fail: ${output}`);
  assert.doesNotMatch(output, /^ABORT-STUCK$/m, `${kind}: the abort path never ran`);
  const announced = /^ABORT-HOLDER (\d+)$/m.exec(output);
  const fixture = /^ABORT-FIXTURE (.+)$/m.exec(output);
  assert.ok(announced && fixture, `${kind}: the aborted run never reported its holder: ${output}`);
  const pid = Number(announced[1]);

  // Bounded far below the holder's own self-destruct wait, so only the
  // aborted run's own cleanup can satisfy this.
  const deadline = Date.now() + ABORT_DEADLINE_MS;
  while (!isDead(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(isDead(pid), true, `${kind}: the aborted run left holder ${pid} alive`);
  assert.equal(fs.existsSync(fixture[1]), false, `${kind}: the aborted run left its fixture behind`);
  await deadWriterIsRecovered("head-control-audit-store");
}


// Parent half of the reap race.  Racers are tracked exactly like holders, so
// the one top-level `finally` reaps them; nothing here matches a process by
// name or consults the process table.
function rendezvousDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-reap-race-"));
  fs.chmodSync(directory, 0o700);
  fixtures.add(directory);
  return directory;
}
function spawnTracked(args, signal) {
  const child = spawn(process.execPath, [__filename, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  let announce = null;
  const announced = new Promise((resolve) => { announce = resolve; });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (signal && output.includes(`${signal}\n`)) announce(true);
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signalCode) => resolve({ code, signal: signalCode })));
  const racer = { child, exited, announced, output: () => output };
  holders.add(racer);
  return racer;
}
// A single reported entry into a protected action, with whatever other
// writers were inside theirs at that instant.
function sectionEntries(source, output) {
  const entries = [];
  for (const line of output.split("\n")) {
    const match = /^SECTION-ENTER (\S+) (\[.*\])$/.exec(line);
    if (match) entries.push({ source, role: match[1], others: JSON.parse(match[2]) });
  }
  return entries;
}
function verdict(output) {
  const lines = output.trim().split("\n").filter((line) => /^(OK|REFUSED .*)$/.test(line));
  return lines.length === 0 ? "none" : lines[lines.length - 1];
}

// The detector must be able to see an overlap that is certainly there, or an
// empty report from the race proves nothing.
async function overlapDetectorSeesAKnownOverlap() {
  const rendezvous = rendezvousDirectory();
  const first = spawnTracked(["--marker-overlap", "first", rendezvous]);
  const second = spawnTracked(["--marker-overlap", "second", rendezvous]);
  const outcomes = [await first.exited, await second.exited];
  assert.deepEqual(outcomes.map((outcome) => outcome.code), [0, 0], `${first.output()}${second.output()}`);
  const entries = [...sectionEntries("first", first.output()), ...sectionEntries("second", second.output())];
  assert.equal(entries.length, 2, `both control processes reported an entry: ${JSON.stringify(entries)}`);
  assert.deepEqual(
    entries.filter((entry) => entry.others.length > 0),
    [{ source: "second", role: "second", others: ["section-first"] }],
    `the overlap detector missed a deliberate overlap: ${JSON.stringify(entries)}`,
  );
}

// Successor to `reapRaceNeverOverlapsProtectedActions`.  Two real processes,
// one real lock file, a barrier so neither wins by starting first, and a
// loser that retries until it wins so both certainly enter their protected
// action.  The same harness is then run against two deliberately wrong
// primitives, and both of those must report the overlap this one must not:
// without them an empty report would only prove the detector was quiet.
async function runMutexRace(adapterName, schedule = "simultaneous") {
  return withDirectory(async (directory) => {
    const rendezvous = rendezvousDirectory();
    const left = spawnTracked(["--mutex-race", adapterName, "left", directory, rendezvous, schedule]);
    const right = spawnTracked(["--mutex-race", adapterName, "right", directory, rendezvous, schedule]);
    const outcomes = { left: await left.exited, right: await right.exited };
    const output = `left=${JSON.stringify(left.output())} right=${JSON.stringify(right.output())}`;
    const entries = [...sectionEntries("left", left.output()), ...sectionEntries("right", right.output())];
    const context = `${adapterName}/${schedule}: ${JSON.stringify(outcomes)} ${output}`;

    // Both children must actually have met at the barrier and must actually
    // have entered a protected action.  Without these two, "no overlap" could
    // be produced by a child that crashed, timed out, or never got that far.
    for (const [role, racer] of [["left", left], ["right", right]]) {
      assert.equal(outcomes[role].signal, null, `${context}: the ${role} racer died on a signal`);
      assert.equal(outcomes[role].code, 0, `${context}: the ${role} racer exited non-zero`);
      assert.match(racer.output(), new RegExp(`^BARRIER ${role}$`, "m"), `${context}: the ${role} racer never reached the barrier`);
      assert.doesNotMatch(racer.output(), /^BARRIER-TIMEOUT/m, `${context}: the barrier timed out`);
      assert.equal(verdict(racer.output()), "OK", `${context}: the ${role} racer never committed`);
    }
    assert.equal(entries.length, 2, `${context}: both racers must enter a protected action`);
    if (schedule === "delayed-observation") {
      assert.ok(fs.existsSync(path.join(rendezvous, "observation-pending-left")), `${context}: the observation delay was not exercised`);
      assert.deepEqual(entries.map(({ others }) => others), [[], ["section-left"]], `${context}: right must observe left after publishing its marker`);
    }
    const refusals = [left, right].reduce((total, racer) => {
      const reported = /^REFUSALS \S+ (\d+)$/m.exec(racer.output());
      assert.ok(reported, `${context}: a racer did not report its refusals`);
      return total + Number(reported[1]);
    }, 0);
    return { entries, overlaps: entries.filter((entry) => entry.others.length > 0), refusals, context };
  });
}

// The claim: with the primitive the durable stores actually use, no two
// writers are ever inside their protected actions at once.
async function mutualExclusionAcrossProcesses() {
  const race = await runMutexRace("kernel");
  assert.deepEqual(race.overlaps, [], `two writers were inside their protected actions at once: ${race.context}`);
  // Exclusion was exercised, not merely unviolated: one racer was turned
  // away while the other held the lock.  Without this, two runs that never
  // met would report the same empty overlap as a lock that works.
  assert.ok(race.refusals >= 1, `neither racer was ever refused, so exclusion was never exercised: ${race.context}`);
}

// The two ways the claim above could be vacuous, each asserted here rather
// than checked by hand.  `bypass` never asks the kernel; `private-inode`
// asks it properly but about a file private to each process, which is what
// separates "the adapter was called" from "exclusion binds to this inode".
async function wrongPrimitiveOverlaps(adapterName, schedule) {
  const race = await runMutexRace(adapterName, schedule);
  assert.ok(race.overlaps.length > 0,
    `${adapterName} must overlap, or the race proves nothing about the correct primitive: ${race.context}`);
  assert.equal(race.refusals, 0, `${adapterName} refused a writer, so it is not the always-granting control it must be: ${race.context}`);
}

async function suite() {
  const failures = [];
  for (const name of Object.keys(STORES)) {
    for (const check of [deadWriterIsRecovered, lockMetadataNeverBlocks, lockMetadataNeverAdmits, identityMismatchIsRetriedThenRefused]) {
      try { await check(name); }
      catch (error) { failures.push(`${check.name}(${name}): ${error && error.message}`); }
    }
  }
  try { await contendersYieldOneWriterAtATime(); }
  catch (error) { failures.push(`contendersYieldOneWriterAtATime: ${error && error.message}`); }
  for (const check of [overlapDetectorSeesAKnownOverlap, mutualExclusionAcrossProcesses]) {
    try { await check(); }
    catch (error) { failures.push(`${check.name}: ${error && error.message}`); }
  }
  for (const adapterName of RACE_ADAPTERS.filter((name) => name !== "kernel")) {
    for (const schedule of ["simultaneous", "delayed-observation"]) {
      try { await wrongPrimitiveOverlaps(adapterName, schedule); }
      catch (error) { failures.push(`wrongPrimitiveOverlaps(${adapterName}, ${schedule}): ${error && error.message}`); }
    }
  }
  for (const kind of ABORT_KINDS) {
    try { await abortLeavesNoHolderBehind(kind); }
    catch (error) { failures.push(`abortLeavesNoHolderBehind(${kind}): ${error && error.message}`); }
  }
  return failures;
}

(async () => {
  let exitCode = 0;
  try {
    if (process.argv[2] === "--abort-harness") {
      await abortHarnessChild(process.argv[3]);
    } else {
      const failures = await suite();
      if (failures.length > 0) {
        console.error(failures.join("\n"));
        exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    exitCode = 1;
  } finally {
    await reapHolders();
    removeFixtures();
  }
  if (exitCode === 0 && process.argv[2] !== "--abort-harness") console.log("durable-store-writer-lock tests passed");
  process.exit(exitCode);
})();
