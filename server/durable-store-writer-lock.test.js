"use strict";

// #1064: a writer that dies inside its lock window must not wedge the store.
// Every block below drives a real store from a real child process: the child
// takes the store's writer lock and blocks, the parent proves the lock is
// honoured while the owner lives, kills the owner, and then expects the next
// writer to recover and commit.  Nothing here stubs a pid, a signal, or the
// lock body; the record on disk is exactly what the store wrote.

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
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

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const owner = { installation_id, project_id };
const binding = { installation_id, project_id, role: "head", generation: 7 };
const base_sha = "a".repeat(64);
const result_sha = "f".repeat(64);
const candidate_sha = "b".repeat(64);
const work_item = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };

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
    statePath: (directory) => batchRequestStateStorePath(directory, owner),
    mutate(directory, fsImpl) {
      return createBatchRequestStateStore({ config_dir: directory, fs: fsImpl }).initialize({ expected: { ...owner, revision: null }, subscription_state: { version: 1, cursor: null, records: [] } });
    },
    written: (directory) => createBatchRequestStateStore({ config_dir: directory, fs }).readRecoverySnapshot(owner).revision === 0,
  },
  "delivery-candidate-store": {
    locked: "delivery_candidate_store_locked",
    statePath: (directory) => deliveryCandidateStorePath(directory, deliveryManifest().delivery_candidate_ref),
    mutate(directory, fsImpl) {
      const manifest = deliveryManifest();
      return createDeliveryCandidateStore({ config_dir: directory, fs: fsImpl }).initialize({ expected: { delivery_candidate_ref: copy(manifest.delivery_candidate_ref), revision: null }, delivery_manifest: manifest });
    },
    written: (directory) => createDeliveryCandidateStore({ config_dir: directory, fs }).readSnapshot(deliveryManifest().delivery_candidate_ref).lifecycle.status === "pending_composition",
  },
  "head-control-audit-store": {
    locked: "head_control_audit_store_locked",
    statePath: (directory) => headControlAuditStorePath(directory, binding),
    mutate(directory, fsImpl) { return createHeadControlAuditStore({ config_dir: directory, fs: fsImpl }).append({ binding, audit: audit(0) }); },
    written: (directory) => createHeadControlAuditStore({ config_dir: directory, fs }).read(binding).length === 1,
  },
  "task-review-round-store": {
    locked: "task_review_round_store_locked",
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
    statePath: (directory) => headControlWorkTaskDomainPath(directory, binding),
    mutate(directory, fsImpl) {
      return createHeadControlWorkTaskDomain({ binding, config_dir: directory, fs: fsImpl, resolve_registered_identity: resolveRegisteredIdentity, now: () => "2026-09-02T00:00:00.000Z" }).initialize();
    },
    written: (directory) => JSON.parse(fs.readFileSync(headControlWorkTaskDomainPath(directory, binding), "utf8")).stage === "empty",
  },
};

// Child mode: take the store's writer lock and never leave it.  The hook is
// the chmod every store applies to its freshly created `.lock` right after
// writing the owner record, so the record on disk is complete when the
// parent kills this process.
if (process.argv[2] === "--hold-writer-lock") {
  const holding = Object.create(fs);
  holding.chmodSync = (target, mode) => {
    fs.chmodSync(target, mode);
    if (target.endsWith(".lock")) {
      fs.writeSync(1, `HOLDING ${process.pid}\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  };
  STORES[process.argv[3]].mutate(process.argv[4], holding);
  return;
}
// Contender mode: one audit append that holds the lock for a visible window,
// reporting when the lock was taken and released so the parent can prove
// mutual exclusion across processes from the wall clock alone.
if (process.argv[2] === "--contend") {
  const contending = Object.create(fs);
  contending.chmodSync = (target, mode) => {
    fs.chmodSync(target, mode);
    if (target.endsWith(".lock")) fs.writeSync(1, `ENTER ${Date.now()}\n`);
  };
  contending.renameSync = (from, to) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    fs.renameSync(from, to);
  };
  contending.unlinkSync = (target) => {
    fs.unlinkSync(target);
    if (target.endsWith(".lock")) fs.writeSync(1, `EXIT ${Date.now()}\n`);
  };
  try {
    createHeadControlAuditStore({ config_dir: process.argv[3], fs: contending }).append({ binding, audit: audit(Number(process.argv[4])) });
    fs.writeSync(1, "OK\n");
  } catch (error) {
    fs.writeSync(1, `REFUSED ${error && error.code}\n`);
  }
  return;
}

function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error && error.code === expected, `expected ${expected}`);
}
function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-writer-lock-"));
  fs.chmodSync(directory, 0o700);
  return run(directory).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
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
  return { child, exited, holding };
}
function artifacts(statePath) {
  return fs.readdirSync(path.dirname(statePath)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"));
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

    // Negative control: a live owner is honoured, whatever its lock says.
    throwsCode(() => store.mutate(directory, fs), store.locked);
    assert.equal(fs.readFileSync(lockPath, "utf8").includes(String(holderPid)), true, `${name}: the lock record names the live owner pid`);

    holder.child.kill("SIGKILL");
    const outcome = await holder.exited;
    assert.equal(outcome.signal, "SIGKILL");
    assert.equal(isDead(holderPid), true, `${name}: the owner pid is gone`);
    assert.equal(fs.lstatSync(lockPath).isFile(), true, `${name}: the dead owner's lock survives its process`);

    // The defect: the next writer must recover from the dead owner's lock
    // and commit, instead of failing closed until an operator deletes it.
    let result;
    try { result = store.mutate(directory, fs); }
    catch (error) {
      assert.fail(`${name}: dead-writer lock wedged recovery with ${error && error.code}`);
    }
    assert.ok(result, `${name}: recovery returned a snapshot`);
    assert.equal(store.written(directory), true, `${name}: the recovered write is durable and readable`);
    assert.deepEqual(artifacts(statePath), [], `${name}: no lock or temporary artifact remains after recovery`);
  });
}

// Malformed or untrusted lock content can never identify an owner, so it is
// never reaped: the store stays fail-closed for an explicit operator check.
async function malformedLockStaysClosed(name) {
  const store = STORES[name];
  await withDirectory(async (directory) => {
    const statePath = store.statePath(directory);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    for (const body of ["", "locked\n", `${process.pid}.${"ab".repeat(16)}`, "{\"pid\":0}", JSON.stringify({ version: 1, pid: 0, token: "0".repeat(32), host: os.hostname(), created_at: 0 })]) {
      fs.writeFileSync(`${statePath}.lock`, body, { mode: 0o600, flag: "wx" });
      throwsCode(() => store.mutate(directory, fs), store.locked);
      assert.equal(fs.readFileSync(`${statePath}.lock`, "utf8"), body, `${name}: an unidentifiable lock is left untouched`);
      fs.unlinkSync(`${statePath}.lock`);
    }
  });
}

// A record that parses but names an owner this host cannot prove dead is
// honoured: a live unrelated pid (the shape PID reuse produces), a pid the
// probe refuses with EPERM (alive, not gone), and a lock minted on another
// host.  None of them is touched.
function deadPid() {
  const exited = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(exited.status, 0);
  assert.equal(isDead(exited.pid), true, "the probe pid belongs to a process that has exited");
  return exited.pid;
}
function record(fields) {
  return JSON.stringify({ version: 1, pid: process.pid, token: crypto.randomBytes(16).toString("hex"), host: os.hostname(), created_at: Date.now(), ...fields });
}
async function unprovenOwnerStaysClosed(name) {
  const store = STORES[name];
  await withDirectory(async (directory) => {
    const statePath = store.statePath(directory);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    let init = null;
    try { process.kill(1, 0); } catch (error) { init = error.code; }
    assert.ok(init === null || init === "EPERM", `pid 1 is alive for this user (${init})`);
    for (const body of [record({}), record({ pid: 1 }), record({ pid: deadPid(), host: "elsewhere.invalid" })]) {
      fs.writeFileSync(`${statePath}.lock`, body, { mode: 0o600, flag: "wx" });
      throwsCode(() => store.mutate(directory, fs), store.locked);
      assert.equal(fs.readFileSync(`${statePath}.lock`, "utf8"), body, `${name}: a live, refused, or foreign owner's lock is left untouched`);
      fs.unlinkSync(`${statePath}.lock`);
    }
  });
}

// Linux reuses inode numbers eagerly, so a dead owner's lock that is
// replaced between judgement and unlink can report the original dev+ino.
// The stubbed lstat forces exactly that; only the exact record proves the
// replacement, and the replacement's live owner is honoured.
async function replacementIsNeverReaped(name) {
  const store = STORES[name];
  await withDirectory(async (directory) => {
    const statePath = store.statePath(directory);
    const lockPath = `${statePath}.lock`;
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, record({ pid: deadPid() }), { mode: 0o600, flag: "wx" });
    const replacement = record({});
    let inspections = 0;
    let original = null;
    const replacingFs = Object.create(fs);
    replacingFs.lstatSync = (target) => {
      if (target !== lockPath) return fs.lstatSync(target);
      inspections += 1;
      if (inspections === 1) {
        original = fs.lstatSync(target);
        return original;
      }
      if (inspections === 2) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, replacement, { mode: 0o600, flag: "wx" });
      }
      const stats = fs.lstatSync(target);
      stats.dev = original.dev;
      stats.ino = original.ino;
      return stats;
    };
    throwsCode(() => store.mutate(directory, replacingFs), store.locked);
    assert.equal(inspections, 2, `${name}: the dead owner's lock is re-inspected exactly once before any unlink`);
    assert.equal(fs.readFileSync(lockPath, "utf8"), replacement, `${name}: the live replacement is never unlinked`);
    assert.equal(fs.existsSync(statePath), false, `${name}: no write happened behind the replacement's owner`);
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
    assert.deepEqual(artifacts(statePath), [], "no lock or temporary artifact remains after contention");
  });
}

(async () => {
  const failures = [];
  for (const name of Object.keys(STORES)) {
    for (const check of [deadWriterIsRecovered, malformedLockStaysClosed, unprovenOwnerStaysClosed, replacementIsNeverReaped]) {
      try { await check(name); }
      catch (error) { failures.push(`${check.name}(${name}): ${error && error.message}`); }
    }
  }
  try { await contendersYieldOneWriterAtATime(); }
  catch (error) { failures.push(`contendersYieldOneWriterAtATime: ${error && error.message}`); }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("durable-store-writer-lock tests passed");
})();
