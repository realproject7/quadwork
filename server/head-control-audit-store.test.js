"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DIRECTORY_MODE,
  FILE_MODE,
  MAX_RECORDS,
  HeadControlAuditStoreError,
  headControlAuditStorePath,
  createHeadControlAuditStore,
} = require("./head-control-audit-store");

const BINDING = Object.freeze({
  installation_id: "installationaudit001",
  project_id: "quadwork",
  role: "head",
  generation: 7,
});
const MANIFEST_A = "a".repeat(64);
const PIPELINE_B = "b".repeat(64);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function temporaryConfigDirectory() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-audit-"));
  fs.chmodSync(configDir, DIRECTORY_MODE);
  return configDir;
}
function status(revision = 1) {
  return {
    revision,
    archived: false,
    manifest_digest: MANIFEST_A,
    pipeline_digest: PIPELINE_B,
    manifest_frozen: true,
    cut_safe: true,
  };
}
function audit(index = 1, overrides = {}) {
  const value = {
    version: 1,
    binding: clone(BINDING),
    action: "put_batch_manifest",
    correlation_id: `corr_audit_${index}`,
    idempotency_key: `idem_audit_${index}`,
    expected_revision: index - 1,
    decision: "accepted",
    code: "head_control_applied",
    result: {
      action: "put_batch_manifest",
      applied: true,
      status: status(index),
    },
  };
  return { ...value, ...overrides };
}
function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof HeadControlAuditStoreError && error.code === code);
}

function testAtomicRestartAndRedaction() {
  const configDir = temporaryConfigDirectory();
  const store = createHeadControlAuditStore({ config_dir: configDir, fs });
  const first = store.append({ binding: BINDING, audit: audit() });
  assert.equal(first.duplicate, false);
  assert.equal(first.rotated, 0);
  assert.equal(first.count, 1);
  assert.equal(Object.isFrozen(first.record), true);
  assert.deepEqual(Object.keys(first.record).sort(), [
    "action", "binding", "code", "correlation_id", "decision", "idempotency_key",
    "preconditions", "result", "version",
  ]);
  assert.deepEqual(first.record.preconditions, { expected_revision: 0 });

  const statePath = headControlAuditStorePath(configDir, BINDING);
  assert.equal(fs.statSync(configDir).mode & 0o777, DIRECTORY_MODE);
  assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, DIRECTORY_MODE);
  assert.equal(fs.statSync(statePath).mode & 0o777, FILE_MODE);

  const afterRestart = createHeadControlAuditStore({ config_dir: configDir, fs });
  const readBack = afterRestart.read(BINDING);
  assert.equal(readBack.length, 1);
  assert.deepEqual(readBack[0], first.record);
  assert.equal(Object.isFrozen(readBack), true);
  assert.equal(Object.isFrozen(readBack[0].result.status), true);
  assert.equal(Object.hasOwn(readBack[0], "expected_revision"), false);
  assert.equal(Object.hasOwn(readBack[0], "payload"), false);
  assert.equal(Object.hasOwn(readBack[0], "body"), false);

  const duplicate = afterRestart.append({ binding: BINDING, audit: audit() });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.count, 1);
  assert.deepEqual(afterRestart.read(BINDING), readBack);
}

function testIdentityConflictsAndRedactionBoundary() {
  const configDir = temporaryConfigDirectory();
  const store = createHeadControlAuditStore({ config_dir: configDir, fs });
  store.append({ binding: BINDING, audit: audit() });

  expectCode(() => store.append({
    binding: BINDING,
    audit: audit(2, { correlation_id: "corr_audit_1", idempotency_key: "idem_audit_new" }),
  }), "head_control_audit_correlation_conflict");
  expectCode(() => store.append({
    binding: BINDING,
    audit: audit(2, { correlation_id: "corr_audit_new", idempotency_key: "idem_audit_1" }),
  }), "head_control_audit_idempotency_conflict");
  expectCode(() => store.append({
    binding: BINDING,
    audit: { ...audit(3), payload: { arbitrary: "not durable" } },
  }), "invalid_head_control_audit_record");
  expectCode(() => store.append({
    binding: BINDING,
    audit: audit(3, {
      binding: { ...BINDING, generation: 8 },
    }),
  }), "head_control_audit_append_identity_mismatch");
  expectCode(() => store.append({
    binding: BINDING,
    audit: audit(3, {
      result: { ...audit(3).result, note: "arbitrary prose" },
    }),
  }), "invalid_head_control_audit_record");
}

function testBoundedRotationRetainsCurrentCorrelation() {
  const configDir = temporaryConfigDirectory();
  const store = createHeadControlAuditStore({ config_dir: configDir, fs });
  for (let index = 1; index <= MAX_RECORDS; index += 1) {
    const result = store.append({ binding: BINDING, audit: audit(index) });
    assert.equal(result.duplicate, false);
    assert.equal(result.count, index);
  }
  const current = store.append({ binding: BINDING, audit: audit(MAX_RECORDS + 1) });
  assert.equal(current.rotated, 1);
  assert.equal(current.count, MAX_RECORDS);
  const records = store.read(BINDING);
  assert.equal(records.length, MAX_RECORDS);
  assert.equal(records[0].correlation_id, "corr_audit_2");
  assert.equal(records.at(-1).correlation_id, `corr_audit_${MAX_RECORDS + 1}`);
  assert.equal(records.some((record) => record.correlation_id === current.record.correlation_id), true);
}

function testCorruptSymlinkAndPermissionsFailClosed() {
  const configDir = temporaryConfigDirectory();
  const store = createHeadControlAuditStore({ config_dir: configDir, fs });
  store.append({ binding: BINDING, audit: audit() });
  const statePath = headControlAuditStorePath(configDir, BINDING);

  fs.writeFileSync(statePath, "not-json\n", { mode: FILE_MODE });
  fs.chmodSync(statePath, FILE_MODE);
  expectCode(() => store.read(BINDING), "corrupt_head_control_audit_store");

  fs.writeFileSync(statePath, JSON.stringify({ schema_version: 1, binding: BINDING, records: [] }), { mode: FILE_MODE });
  fs.chmodSync(statePath, 0o644);
  expectCode(() => store.read(BINDING), "head_control_audit_store_insecure_permissions");
  fs.chmodSync(statePath, FILE_MODE);

  const target = path.join(configDir, "external-state.json");
  fs.writeFileSync(target, "{}\n", { mode: FILE_MODE });
  fs.unlinkSync(statePath);
  fs.symlinkSync(target, statePath);
  expectCode(() => store.read(BINDING), "head_control_audit_store_symlink_rejected");
}

function testDirectorySymlinkAndStaleLockFailClosed() {
  const configDir = temporaryConfigDirectory();
  const auditDirectory = path.join(configDir, "head-control-audit");
  const unrelatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-audit-other-"));
  fs.chmodSync(unrelatedDirectory, DIRECTORY_MODE);
  fs.symlinkSync(unrelatedDirectory, auditDirectory);
  const store = createHeadControlAuditStore({ config_dir: configDir, fs });
  expectCode(() => store.read(BINDING), "head_control_audit_store_symlink_rejected");

  const separateConfig = temporaryConfigDirectory();
  const separateStore = createHeadControlAuditStore({ config_dir: separateConfig, fs });
  separateStore.append({ binding: BINDING, audit: audit() });
  const lockPath = `${headControlAuditStorePath(separateConfig, BINDING)}.lock`;
  fs.writeFileSync(lockPath, "locked\n", { mode: FILE_MODE, flag: "wx" });
  fs.chmodSync(lockPath, FILE_MODE);
  expectCode(() => separateStore.append({ binding: BINDING, audit: audit(2) }), "head_control_audit_store_locked");
}

// Linux reuses inode numbers eagerly, so a lock replaced after this writer
// closed its descriptor can report the original dev+ino. The stubbed lstat
// forces exactly that; only the lock token can then prove the replacement.
function testForcedInodeReuseFailsClosedOnRelease() {
  const configDir = temporaryConfigDirectory();
  const lockPath = `${headControlAuditStorePath(configDir, BINDING)}.lock`;
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
      fs.writeFileSync(lockPath, "replacement-writer-lock", { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    }
    const stats = fs.lstatSync(target);
    stats.dev = original.dev;
    stats.ino = original.ino;
    return stats;
  };
  const store = createHeadControlAuditStore({ config_dir: configDir, fs: replacingFs });
  expectCode(() => store.append({ binding: BINDING, audit: audit() }), "head_control_audit_store_lock_release_failed");
  assert.equal(inspections, 2);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement-writer-lock");
}

function testNoTransportOrProcessSurface() {
  const source = fs.readFileSync(path.join(__dirname, "head-control-audit-store.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'](?:express|http|child_process|\.\/mcp-chat-shim)["']\)/);
  assert.doesNotMatch(source, /\b(?:setInterval|setTimeout|spawn|exec|fetch)\s*\(/);
}

testAtomicRestartAndRedaction();
testIdentityConflictsAndRedactionBoundary();
testBoundedRotationRetainsCurrentCorrelation();
testCorruptSymlinkAndPermissionsFailClosed();
testDirectorySymlinkAndStaleLockFailClosed();
testForcedInodeReuseFailsClosedOnRelease();
testNoTransportOrProcessSurface();
console.log("head-control-audit-store tests passed");
