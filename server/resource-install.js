"use strict";

// #1038: explicit, token-bound installation for the runtime resource policy
// and its disk-backed temp root. Nothing in this module runs at startup. The
// CLI is the sole production caller and always uses CONFIG_PATH; injectable
// filesystem seams exist only so the refusal paths can be tested.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CONFIG_PATH } = require("./config");
const { parseRuntimeResources } = require("./resource-policy");
const { ensureTempRoot, TMPFS_MAGIC, RAMFS_MAGIC } = require("./resource-temp");

const POLICY_FILE_MAX_BYTES = 64 * 1024;
const CONFIG_FILE_MAX_BYTES = 4 * 1024 * 1024;
const ACCEPTANCE_RE = /^[a-f0-9]{64}$/;

class ResourceInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResourceInstallError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResourceInstallError(code, message);
}

function expectedUid(options) {
  if (Object.prototype.hasOwnProperty.call(options, "expectedUid")) return options.expectedUid;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function modeOf(stat) {
  return Number(stat.mode) & 0o7777;
}

function sameIdentity(left, right) {
  return left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && modeOf(left) === modeOf(right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameOwnedNode(left, right) {
  return left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && modeOf(left) === modeOf(right);
}

function validateOwner(stat, uid, code) {
  if (uid !== null && stat.uid !== uid) fail(code, "resource input has an unexpected owner");
}

function openNoFollow(fsImpl, filePath) {
  const constants = fsImpl.constants || fs.constants;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  return fsImpl.openSync(filePath, flags);
}

function readSecureRegularFile(filePath, { fsImpl = fs, maxBytes, kind, uid }) {
  let before;
  try {
    before = fsImpl.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") fail(`${kind}_missing`, `${kind} is missing`);
    fail(`${kind}_unreadable`, `${kind} cannot be inspected`);
  }
  if (before.isSymbolicLink() || !before.isFile()) fail(`${kind}_unsafe_type`, `${kind} must be a regular file`);
  validateOwner(before, uid, `${kind}_owner_mismatch`);
  if (modeOf(before) !== 0o600) fail(`${kind}_mode_unsafe`, `${kind} must use mode 0600`);
  if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) {
    fail(`${kind}_size_invalid`, `${kind} has an unsupported size`);
  }

  let fd;
  try {
    fd = openNoFollow(fsImpl, filePath);
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) fail(`${kind}_identity_changed`, `${kind} changed while opening`);
    const raw = fsImpl.readFileSync(fd, "utf8");
    const after = fsImpl.fstatSync(fd);
    if (!sameIdentity(opened, after) || Buffer.byteLength(raw, "utf8") !== opened.size) {
      fail(`${kind}_identity_changed`, `${kind} changed while reading`);
    }
    const named = fsImpl.lstatSync(filePath);
    if (!sameIdentity(after, named)) fail(`${kind}_identity_changed`, `${kind} changed while reading`);
    return Object.freeze({ raw, identity: after });
  } catch (err) {
    if (err instanceof ResourceInstallError) throw err;
    fail(`${kind}_unreadable`, `${kind} cannot be read securely`);
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
  }
}

function parseJsonObject(raw, code, message) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(code, message);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message);
  return value;
}

function assertSafeConfigDirectory(fsImpl, uid) {
  const dir = path.dirname(CONFIG_PATH);
  let stat;
  try {
    stat = fsImpl.lstatSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") fail("config_missing", "QuadWork configuration is missing");
    fail("config_directory_unreadable", "QuadWork configuration directory cannot be inspected");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("config_directory_unsafe_type", "QuadWork configuration directory must be a real directory");
  }
  validateOwner(stat, uid, "config_directory_owner_mismatch");
  if (modeOf(stat) !== 0o700) fail("config_directory_mode_unsafe", "QuadWork configuration directory must use mode 0700");
  return stat;
}

function readPolicyFile(policyFile, options = {}) {
  if (typeof policyFile !== "string" || !path.isAbsolute(policyFile) || path.normalize(policyFile) !== policyFile) {
    fail("policy_file_not_absolute", "--policy-file must be a normalized absolute path");
  }
  const fsImpl = options.fsImpl || fs;
  const uid = expectedUid(options);
  try {
    if (fsImpl.realpathSync(policyFile) !== policyFile) {
      fail("policy_file_aliased", "policy file cannot contain path aliases");
    }
  } catch (err) {
    if (err instanceof ResourceInstallError) throw err;
    fail("policy_file_unreadable", "policy file cannot be resolved securely");
  }
  const { raw } = readSecureRegularFile(policyFile, {
    fsImpl,
    maxBytes: POLICY_FILE_MAX_BYTES,
    kind: "policy_file",
    uid,
  });
  const parsed = parseJsonObject(raw, "policy_file_json_invalid", "policy file must contain one JSON object");
  try {
    const policy = parseRuntimeResources(parsed);
    if (!policy) fail("policy_absent", "policy file must contain an explicit runtime_resources v1 policy");
    return policy;
  } catch (err) {
    if (err instanceof ResourceInstallError) throw err;
    fail("invalid_resource_policy", "policy file does not contain a valid runtime_resources v1 policy");
  }
}

function policyProposal(policyFile, options = {}) {
  const policy = readPolicyFile(policyFile, options);
  return Object.freeze({
    ok: true,
    status: "proposal",
    action: "configure_runtime_resources",
    acceptance: Object.freeze({ sha256: sha256(policy) }),
    policy,
    plan: Object.freeze({
      destination: "~/.quadwork/config.json#runtime_resources",
      preserves_other_config_fields: true,
      creates_missing_config: false,
    }),
  });
}

function readConfigSecure(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const uid = expectedUid(options);
  assertSafeConfigDirectory(fsImpl, uid);
  const secure = readSecureRegularFile(CONFIG_PATH, {
    fsImpl,
    maxBytes: CONFIG_FILE_MAX_BYTES,
    kind: "config",
    uid,
  });
  const config = parseJsonObject(secure.raw, "config_json_invalid", "QuadWork configuration JSON is invalid");
  return Object.freeze({ ...secure, config });
}

function fsyncDirectory(fsImpl, directory) {
  const constants = fsImpl.constants || fs.constants;
  let fd;
  try {
    fd = fsImpl.openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
    fsImpl.fsyncSync(fd);
  } catch {
    // The file fsync + same-filesystem rename is the required atomic boundary;
    // directory fsync is best-effort on filesystems that do not expose it.
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
  }
}

function writeConfigAtomic(previous, nextConfig, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const uid = expectedUid(options);
  const directory = path.dirname(CONFIG_PATH);
  assertSafeConfigDirectory(fsImpl, uid);
  const data = JSON.stringify(nextConfig, null, 2);
  if (Buffer.byteLength(data, "utf8") > CONFIG_FILE_MAX_BYTES) {
    fail("config_size_invalid", "updated QuadWork configuration is too large");
  }
  const temporary = path.join(directory, `.config.json.resource-install-${process.pid}-${crypto.randomBytes(12).toString("hex")}.tmp`);
  const constants = fsImpl.constants || fs.constants;
  let fd;
  let committed = false;
  try {
    fd = fsImpl.openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    fsImpl.writeFileSync(fd, data, "utf8");
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    const tempStat = fsImpl.lstatSync(temporary);
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || modeOf(tempStat) !== 0o600) {
      fail("config_atomic_write_unsafe", "secure temporary configuration could not be established");
    }
    validateOwner(tempStat, uid, "config_atomic_write_owner_mismatch");

    // Re-open and compare the exact old bytes immediately before commit. A
    // stale read-modify-write never replaces a concurrent config update.
    const current = readConfigSecure(options);
    if (current.raw !== previous.raw || !sameIdentity(current.identity, previous.identity)) {
      fail("config_changed", "QuadWork configuration changed before apply");
    }
    fsImpl.renameSync(temporary, CONFIG_PATH);
    committed = true;
    fsyncDirectory(fsImpl, directory);
  } catch (err) {
    if (err instanceof ResourceInstallError) throw err;
    fail("config_write_failed", "QuadWork configuration could not be updated atomically");
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
    if (!committed) {
      try { fsImpl.unlinkSync(temporary); } catch {}
    }
  }
}

function applyPolicy({ policyFile, acceptanceSha256 }, options = {}) {
  if (!ACCEPTANCE_RE.test(acceptanceSha256 || "")) fail("acceptance_invalid", "an exact lowercase SHA-256 acceptance token is required");
  // Re-read and re-validate the source only after the apply invocation.
  const proposal = policyProposal(policyFile, options);
  if (proposal.acceptance.sha256 !== acceptanceSha256) fail("acceptance_mismatch", "policy acceptance token does not match the current policy file");
  const previous = readConfigSecure(options);
  const nextConfig = { ...previous.config, runtime_resources: proposal.policy };
  writeConfigAtomic(previous, nextConfig, options);
  return Object.freeze({
    ok: true,
    status: "applied",
    action: proposal.action,
    acceptance: proposal.acceptance,
    policy: proposal.policy,
    plan: proposal.plan,
  });
}

function minimumFreeBytes(policy) {
  const bytes = policy.temp_min_free_mib * 1024 * 1024;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail("temp_capacity_unsupported", "configured temp capacity is outside the supported range");
  return bytes;
}

function statfsState(fsImpl, target, options) {
  const statfs = options.statfs || ((value) => fsImpl.statfsSync(value, { bigint: true }));
  let facts;
  try {
    facts = statfs(target);
  } catch {
    fail("temp_statfs_failed", "resource temp filesystem cannot be inspected");
  }
  try {
    const type = BigInt(facts.type);
    const available = BigInt(facts.bavail) * BigInt(facts.bsize);
    return { type, available };
  } catch {
    fail("temp_statfs_invalid", "resource temp filesystem facts are invalid");
  }
}

function validateTempTarget(policy, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const uid = expectedUid(options);
  const root = policy.temp_root;
  const parent = path.dirname(root);
  const requiredBytes = minimumFreeBytes(policy);
  let parentStat;
  try {
    parentStat = fsImpl.lstatSync(parent);
  } catch {
    fail("temp_parent_missing", "resource temp parent directory must already exist");
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("temp_parent_unsafe", "resource temp parent must be a real directory");
  validateOwner(parentStat, uid, "temp_parent_owner_mismatch");
  if (modeOf(parentStat) !== 0o700) fail("temp_parent_mode_unsafe", "resource temp parent must use mode 0700");
  let canonicalParent;
  try {
    canonicalParent = fsImpl.realpathSync(parent);
  } catch {
    fail("temp_parent_unreadable", "resource temp parent cannot be resolved");
  }
  if (canonicalParent !== parent) fail("temp_parent_aliased", "resource temp parent cannot contain path aliases");

  let rootStat = null;
  try {
    rootStat = fsImpl.lstatSync(root);
  } catch (err) {
    if (!err || err.code !== "ENOENT") fail("temp_root_unreadable", "resource temp root cannot be inspected");
  }
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("temp_root_unsafe", "resource temp root must be a real directory");
    validateOwner(rootStat, uid, "temp_root_owner_mismatch");
    if (modeOf(rootStat) !== 0o700) fail("temp_root_mode_unsafe", "resource temp root must use mode 0700");
    let canonicalRoot;
    try { canonicalRoot = fsImpl.realpathSync(root); } catch { fail("temp_root_unreadable", "resource temp root cannot be resolved"); }
    if (canonicalRoot !== root) fail("temp_root_aliased", "resource temp root cannot contain path aliases");
  }
  const filesystem = statfsState(fsImpl, rootStat ? root : parent, options);
  if (filesystem.type === TMPFS_MAGIC || filesystem.type === RAMFS_MAGIC) {
    fail("temp_root_memory_backed", "resource temp root must be disk-backed");
  }
  if (filesystem.available < BigInt(requiredBytes)) fail("temp_root_low_capacity", "resource temp root does not have the accepted free capacity");
  return Object.freeze({
    root,
    parent,
    parentIdentity: parentStat,
    requiredBytes,
    currentState: rootStat ? "ready" : "create",
  });
}

function rollbackEmptyCreatedRoot(fsImpl, targetPath, uid) {
  try {
    const stat = fsImpl.lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isDirectory() || modeOf(stat) !== 0o700) return false;
    if (uid !== null && stat.uid !== uid) return false;
    if (fsImpl.readdirSync(targetPath).length !== 0) return false;
    fsImpl.rmdirSync(targetPath);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "ENOENT");
  }
}

function buildTempInstallProposal(options = {}) {
  const current = readConfigSecure(options);
  let policy;
  try {
    policy = parseRuntimeResources(current.config.runtime_resources);
  } catch {
    fail("invalid_resource_policy", "persisted runtime_resources policy is invalid");
  }
  if (!policy) fail("policy_absent", "an explicitly accepted runtime_resources policy is required");
  const target = validateTempTarget(policy, options);
  const plan = Object.freeze({
    action: "ensure_resource_temp_root",
    version: 1,
    temp_root: target.root,
    mode: "0700",
    minimum_free_bytes: target.requiredBytes,
    current_state: target.currentState,
    cleanup_paths: Object.freeze([]),
    failure_rollback: "empty_created_root_only",
  });
  const proposal = Object.freeze({
    ok: true,
    status: "proposal",
    action: plan.action,
    acceptance: Object.freeze({ sha256: sha256(plan) }),
    plan,
  });
  return Object.freeze({ proposal, policy, target, configSnapshot: current });
}

function tempInstallProposal(options = {}) {
  return buildTempInstallProposal(options).proposal;
}

function applyTempInstall({ acceptanceSha256 }, options = {}) {
  if (!ACCEPTANCE_RE.test(acceptanceSha256 || "")) fail("acceptance_invalid", "an exact lowercase SHA-256 acceptance token is required");
  const built = buildTempInstallProposal(options);
  const { proposal, policy, target } = built;
  if (proposal.acceptance.sha256 !== acceptanceSha256) fail("acceptance_mismatch", "temp-root acceptance token does not match current policy and host state");
  const platform = options.platform || process.platform;
  if (platform !== "linux" && typeof options.rootHandleFactory !== "function") {
    fail("temp_platform_unsupported", "secure resource temp installation requires the Linux descriptor anchor");
  }
  const current = readConfigSecure(options);
  if (current.raw !== built.configSnapshot.raw || !sameIdentity(current.identity, built.configSnapshot.identity)) {
    fail("config_changed", "QuadWork configuration changed before temp-root apply");
  }
  let facts;
  let parentFd;
  let ensureRoot = proposal.plan.temp_root;
  let failure = null;
  try {
    if (platform === "linux") {
      const fsImpl = options.fsImpl || fs;
      const constants = fsImpl.constants || fs.constants;
      parentFd = fsImpl.openSync(
        target.parent,
        constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
      );
      const anchoredParent = fsImpl.fstatSync(parentFd);
      if (!anchoredParent.isDirectory() || !sameOwnedNode(target.parentIdentity, anchoredParent)) {
        fail("temp_parent_identity_changed", "resource temp parent changed before apply");
      }
      ensureRoot = `/proc/self/fd/${parentFd}/${path.basename(proposal.plan.temp_root)}`;
    }
    facts = (options.ensureTempRoot || ensureTempRoot)({
      tempRoot: ensureRoot,
      minimumFreeBytes: proposal.plan.minimum_free_bytes,
      fsImpl: options.fsImpl,
      statfs: options.statfs,
      rootHandleFactory: options.rootHandleFactory,
      expectedUid: expectedUid(options),
    });
    if (!facts || facts.available !== true || facts.canonicalRoot !== policy.temp_root || facts.mode !== 0o700 || facts.diskBacked !== true) {
      fail("temp_install_unverified", "resource temp root installation could not be verified");
    }
    let finalParent;
    try { finalParent = (options.fsImpl || fs).lstatSync(target.parent); } catch { fail("temp_parent_identity_changed", "resource temp parent changed during apply"); }
    if (!sameOwnedNode(target.parentIdentity, finalParent)) fail("temp_parent_identity_changed", "resource temp parent changed during apply");
  } catch (err) {
    failure = err instanceof ResourceInstallError
      ? err
      : new ResourceInstallError("temp_install_failed", "resource temp root could not be installed securely");
    if (target.currentState === "create"
      && !rollbackEmptyCreatedRoot(options.fsImpl || fs, ensureRoot, expectedUid(options))) {
      failure = new ResourceInstallError(
        "temp_install_failed_cleanup_required",
        "resource temp installation failed and its exact empty-root rollback could not be verified",
      );
    }
  } finally {
    if (parentFd !== undefined) {
      try { (options.fsImpl || fs).closeSync(parentFd); } catch {}
    }
  }
  if (failure) throw failure;
  return Object.freeze({
    ...proposal,
    status: "applied",
    result: Object.freeze({ ready: true, mode: "0700", disk_backed: true }),
  });
}

module.exports = {
  ResourceInstallError,
  canonicalJson,
  sha256,
  policyProposal,
  applyPolicy,
  tempInstallProposal,
  applyTempInstall,
};
