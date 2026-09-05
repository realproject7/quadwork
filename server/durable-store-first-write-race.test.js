"use strict";

// #1070: two independent first writers can observe the same durable store
// directory missing.  Only the root of a store's chain is created
// recursively; every nested level is created one at a time, so the loser's
// `mkdirSync` raises EEXIST.  That errno was mapped nowhere outside the lock
// acquisition path, so the loser died with a bare, untyped Node error instead
// of joining the writer-lock queue.
//
// Nothing below fabricates an EEXIST.  The deterministic block drives two
// real store processes and only controls *when* the loser's real mkdir runs;
// the errno it receives comes from the kernel because the winner really
// created the directory first.  The unsynchronised block races eight real
// first writers against one another with no injected fs at all.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DIRECTORY_MODE,
  createDurableStoreFiles,
} = require("./durable-store-files");
const {
  createHeadControlAuditStore,
  headControlAuditStorePath,
} = require("./head-control-audit-store");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const binding = { installation_id, project_id, role: "head", generation: 7 };
const STORE_SUBDIRECTORY = "head-control-audit";
const CONTENDERS = 8;
const DEADLINE_MS = 30_000;

function audit(index) {
  return {
    version: 1, binding: { ...binding }, action: "put_batch_manifest",
    correlation_id: `corr_race_${index}`, idempotency_key: `idem_race_${index}`,
    expected_revision: index, decision: "accepted", code: "head_control_applied",
    result: {
      action: "put_batch_manifest", applied: true,
      status: { revision: index + 1, archived: false, manifest_digest: "a".repeat(64), pipeline_digest: "b".repeat(64), manifest_frozen: true, cut_safe: true },
    },
  };
}
// A first writer reports exactly which kind of failure it met: a typed
// refusal the owning store raised, or a raw errno that escaped the store.
function report(error) {
  if (!error) return "OK";
  const name = error.name || "Error";
  const code = error.code === undefined ? "none" : String(error.code);
  return name === "HeadControlAuditStoreError" ? `TYPED ${code}` : `RAW ${name} ${code}`;
}
function firstWrite(directory, index, fsImpl) {
  try {
    createHeadControlAuditStore({ config_dir: directory, fs: fsImpl }).append({ binding, audit: audit(index) });
    return "OK";
  } catch (error) {
    return report(error);
  }
}

// Barrier child: load every module, announce readiness, then spin until the
// parent drops the barrier file so all contenders reach `mkdirSync` together.
if (process.argv[2] === "--race-first-write") {
  const directory = process.argv[3];
  const index = Number(process.argv[4]);
  const barrier = process.argv[5];
  fs.writeSync(1, "READY\n");
  const deadline = Date.now() + DEADLINE_MS;
  while (!fs.existsSync(barrier)) {
    if (Date.now() > deadline) { fs.writeSync(1, "BARRIER-TIMEOUT\n"); process.exit(2); }
  }
  fs.writeSync(1, `${firstWrite(directory, index, fs)}\n`);
  return;
}

// Loser child: a real store on a real fs, paused inside the one call whose
// outcome the race decides.  The wrapper injects delay only — the mkdir it
// finally runs is `fs.mkdirSync`, and its errno is the kernel's.
if (process.argv[2] === "--paused-first-write") {
  const directory = process.argv[3];
  const release = process.argv[4];
  const pausing = Object.create(fs);
  pausing.mkdirSync = (target, options) => {
    if (path.basename(target) === STORE_SUBDIRECTORY) {
      fs.writeSync(1, "MKDIR-PENDING\n");
      const deadline = Date.now() + DEADLINE_MS;
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) { fs.writeSync(1, "RELEASE-TIMEOUT\n"); process.exit(2); }
      }
    }
    return fs.mkdirSync(target, options);
  };
  fs.writeSync(1, `${firstWrite(directory, 0, pausing)}\n`);
  return;
}

const fixtures = new Set();
function makeDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-first-write-race-"));
  fs.chmodSync(directory, DIRECTORY_MODE);
  fixtures.add(directory);
  return directory;
}
function removeFixtures() {
  for (const directory of fixtures) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort on teardown */ }
  }
  fixtures.clear();
}
function launch(args) {
  const child = spawn(process.execPath, [__filename, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, output })));
  const sees = (pattern) => new Promise((resolve, reject) => {
    const check = () => { if (pattern.test(output)) resolve(output); };
    child.stdout.on("data", check);
    check();
    exited.then((outcome) => reject(new Error(`child exited before ${pattern}: ${JSON.stringify(outcome)}`)));
  });
  return { child, exited, sees, output: () => output };
}
function storedRecords(directory) {
  return createHeadControlAuditStore({ config_dir: directory, fs }).read(binding).length;
}

class ProbeStoreError extends Error {
  constructor(code, message = code) { super(message); this.name = "ProbeStoreError"; this.code = code; }
}
const CODES = Object.freeze({
  options: "probe_options", unreadable: "probe_unreadable", symlink_rejected: "probe_symlink",
  insecure_permissions: "probe_insecure", write_failed: "probe_write_failed", locked: "probe_locked",
  lock_unsafe: "probe_lock_unsafe", lock_failed: "probe_lock_failed",
  lock_acquire_changed: "probe_lock_acquire_changed", lock_release_changed: "probe_lock_release_changed",
  lock_release_failed: "probe_lock_release_failed",
});
function probe(fsImpl = fs) {
  return createDurableStoreFiles({ fs: fsImpl, error: ProbeStoreError, codes: CODES });
}
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof ProbeStoreError && error.code === expected, `expected ${expected}`);
}
// Hand the layer a chain whose nested level is created by `plant` in the
// window between the existence check and the mkdir: exactly what a competing
// first writer does, without any injected errno.
function racedChain(directory, plant) {
  const nested = path.join(directory, "store");
  const racingFs = Object.create(fs);
  let mkdirs = 0;
  racingFs.mkdirSync = (target, options) => {
    if (target === nested) { mkdirs += 1; plant(nested); }
    return fs.mkdirSync(target, options);
  };
  return { nested, racingFs, chain: [{ path: directory, mode: DIRECTORY_MODE }, { path: nested, mode: DIRECTORY_MODE }], mkdirs: () => mkdirs };
}

// The defect, deterministically: the winner is a separate real process that
// completes an entire first write while the loser is stopped at its mkdir.
async function losingFirstWriterJoinsTheLockQueue() {
  const directory = makeDirectory();
  const release = path.join(directory, "release");
  const open = path.join(directory, "open");
  fs.writeFileSync(open, "go", { mode: 0o600 });
  const loser = launch(["--paused-first-write", directory, release]);
  await loser.sees(/^MKDIR-PENDING$/m);
  assert.equal(fs.existsSync(path.join(directory, STORE_SUBDIRECTORY)), false, "the loser observed the store directory missing");

  const winner = await launch(["--race-first-write", directory, "1", open]).exited;
  assert.equal(winner.code, 0, winner.output);
  assert.equal(winner.output.trim().split("\n").pop(), "OK", winner.output);
  assert.equal(fs.lstatSync(path.join(directory, STORE_SUBDIRECTORY)).isDirectory(), true, "the winner really created the directory");
  assert.equal(storedRecords(directory), 1, "the winner's first write is durable");

  fs.writeFileSync(release, "go", { mode: 0o600 });
  const outcome = await loser.exited;
  assert.equal(outcome.code, 0, `the loser must survive a real EEXIST: ${outcome.output}`);
  assert.equal(outcome.output.trim().split("\n").pop(), "OK", outcome.output);
  assert.equal(storedRecords(directory), 2, "the loser went on to take the writer lock and commit");
}

// Unsynchronised: eight real first writers, no injected fs anywhere.  Each
// one must either commit or be refused with the owning store's typed code;
// a raw errno escaping the store is the defect.
async function concurrentFirstWritersNeverEscapeUntyped() {
  const directory = makeDirectory();
  const barrier = path.join(directory, "barrier");
  const children = Array.from({ length: CONTENDERS }, (_, index) => launch(["--race-first-write", directory, String(index), barrier]));
  await Promise.all(children.map((child) => child.sees(/^READY$/m)));
  fs.writeFileSync(barrier, "go", { mode: 0o600 });
  const outcomes = await Promise.all(children.map((child) => child.exited));
  let committed = 0;
  for (const outcome of outcomes) {
    assert.equal(outcome.code, 0, outcome.output);
    const verdict = outcome.output.trim().split("\n").pop();
    assert.doesNotMatch(verdict, /^RAW /, `a first writer escaped the store untyped: ${verdict}`);
    if (verdict === "OK") committed += 1;
    else assert.equal(verdict, "TYPED head_control_audit_store_locked", outcome.output);
  }
  assert.ok(committed >= 1, "at least one concurrent first writer committed");
  assert.equal(storedRecords(directory), committed, "every commit is durable and none was lost or duplicated");
  assert.equal(fs.lstatSync(path.join(directory, STORE_SUBDIRECTORY)).mode & 0o777, DIRECTORY_MODE, "the raced directory is owner-only");
  assert.deepEqual(
    fs.readdirSync(path.dirname(headControlAuditStorePath(directory, binding))).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")),
    [],
    "no lock or temporary artifact remains after the race",
  );
}

// A lost mkdir is revalidated, never trusted.  Only the exact owner-only
// directory continues; every other thing a winner could leave at the path
// fails closed with the owning store's own code, and no errno but EEXIST is
// ever absorbed.
function lostMkdirIsRevalidated() {
  const admitted = racedChain(makeDirectory(), (nested) => fs.mkdirSync(nested, { mode: DIRECTORY_MODE }));
  probe(admitted.racingFs).ensureDirectories(admitted.chain);
  assert.equal(admitted.mkdirs(), 1, "the losing mkdir is never retried");
  assert.equal(fs.lstatSync(admitted.nested).isDirectory(), true);

  const asFile = racedChain(makeDirectory(), (nested) => fs.writeFileSync(nested, "", { mode: 0o600, flag: "wx" }));
  throwsCode(() => probe(asFile.racingFs).ensureDirectories(asFile.chain), "probe_unreadable");

  const asSymlink = racedChain(makeDirectory(), (nested) => {
    const elsewhere = path.join(path.dirname(nested), "elsewhere");
    fs.mkdirSync(elsewhere, { mode: DIRECTORY_MODE });
    fs.symlinkSync(elsewhere, nested);
  });
  throwsCode(() => probe(asSymlink.racingFs).ensureDirectories(asSymlink.chain), "probe_symlink");

  const asWorldReadable = racedChain(makeDirectory(), (nested) => fs.mkdirSync(nested, { mode: 0o755 }));
  throwsCode(() => probe(asWorldReadable.racingFs).ensureDirectories(asWorldReadable.chain), "probe_insecure");

  // A directory some other uid owns is never admitted either.  The uid is
  // stubbed because a test process cannot mint a foreign-owned directory,
  // but the stat it stubs is the real one for every other field.
  const foreignDirectory = makeDirectory();
  const foreign = racedChain(foreignDirectory, (nested) => fs.mkdirSync(nested, { mode: DIRECTORY_MODE }));
  foreign.racingFs.lstatSync = (target) => {
    const stats = fs.lstatSync(target);
    if (target === foreign.nested && typeof process.getuid === "function") stats.uid = process.getuid() + 1;
    return stats;
  };
  throwsCode(() => probe(foreign.racingFs).ensureDirectories(foreign.chain), "probe_insecure");

  // Negative control: no other errno is absorbed, so a missing parent is
  // still never silently manufactured for a nested level.
  const root = makeDirectory();
  assert.throws(
    () => probe().ensureDirectories([{ path: path.join(root, "a") }, { path: path.join(root, "a", "b", "c"), mode: DIRECTORY_MODE }]),
    (error) => error.code === "ENOENT",
    "only EEXIST is absorbed",
  );
}

(async () => {
  let failed = false;
  try {
    lostMkdirIsRevalidated();
    await losingFirstWriterJoinsTheLockQueue();
    await concurrentFirstWritersNeverEscapeUntyped();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    failed = true;
  } finally {
    removeFixtures();
  }
  if (failed) process.exit(1);
  console.log("durable-store first-write race tests passed");
})();
