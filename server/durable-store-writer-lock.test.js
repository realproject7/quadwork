"use strict";

// #1064: a writer that dies inside its lock window must not wedge the store.
// Every block below drives a real store from a real child process: the child
// takes the store's writer lock and blocks, the parent proves the lock is
// honoured while the owner lives, kills the owner, and then expects the next
// writer to recover and commit.  Nothing here stubs a pid, a signal, or the
// lock body; the record on disk is exactly what the store wrote.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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
function digest(value) { return require("node:crypto").createHash("sha256").update(stable(value), "utf8").digest("hex"); }
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
      return store.readForTrustedReviewer(opened.review_round_ref, opened.candidate_digest, { version: 1, reviewer_role: "re1", reviewer_generation: 11, received_at: "2026-09-01T06:01:00.000Z" }).status === "current";
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

(async () => {
  const failures = [];
  for (const name of Object.keys(STORES)) {
    for (const check of [deadWriterIsRecovered, malformedLockStaysClosed]) {
      try { await check(name); }
      catch (error) { failures.push(`${check.name}(${name}): ${error && error.message}`); }
    }
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("durable-store-writer-lock tests passed");
})();
