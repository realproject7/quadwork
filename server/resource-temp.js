"use strict";

// #1038: confined, generation-scoped worker temporary storage.
//
// This module only establishes a directory boundary. A future spawn governor
// (#1053) may pass a returned directory as TMPDIR, but must prove the effective
// temp location for each real agent in staging. In particular, Claude may
// override TMPDIR; creating a directory here is not evidence of relocation.

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const TMPFS_MAGIC = 0x01021994n;
const RAMFS_MAGIC = 0x858458f6n;
const DEFAULT_STALE_HOURS = 72;
const GENERATION_PREFIX = "generation-";
const GENERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const QUARANTINE_PREFIX = ".quadwork-delete-";
const FACT_STATE = new WeakMap();

class ResourceTempError extends Error {
  constructor(code, message, facts = null) {
    super(message);
    this.name = "ResourceTempError";
    this.reason = "temp_unavailable";
    this.code = code;
    this.facts = facts;
  }
}

function realpathSync(fsImpl, value) {
  const realpath = fsImpl.realpathSync && fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native.bind(fsImpl.realpathSync)
    : fsImpl.realpathSync.bind(fsImpl);
  return realpath(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function unavailable(configuredRoot, code, extra = {}) {
  return Object.freeze({
    available: false,
    reason: "temp_unavailable",
    code,
    configuredRoot,
    canonicalRoot: null,
    ...extra,
  });
}

function numberToBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  throw new TypeError("filesystem fact is not numeric");
}

function statIdentity(st) {
  if (st.dev === undefined || st.ino === undefined) throw new TypeError("filesystem identity is unavailable");
  return Object.freeze({
    dev: String(st.dev),
    ino: String(st.ino),
    uid: st.uid === undefined ? null : Number(st.uid),
    mode: Number(st.mode) & 0o7777,
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readFilesystemState(statfsProbe, target) {
  const statfs = statfsProbe(target);
  const filesystemTypeBig = BigInt.asUintN(32, numberToBigInt(statfs.type));
  const availableBytesBig = numberToBigInt(statfs.bavail) * numberToBigInt(statfs.bsize);
  if (availableBytesBig < 0n || availableBytesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("filesystem capacity is outside the supported range");
  }
  return Object.freeze({
    typeBig: filesystemTypeBig,
    type: `0x${filesystemTypeBig.toString(16)}`,
    availableBytesBig,
    availableBytes: Number(availableBytesBig),
    diskBacked: filesystemTypeBig !== TMPFS_MAGIC && filesystemTypeBig !== RAMFS_MAGIC,
  });
}

// Read-only inspection. It deliberately does not create, chmod, or clean any
// path. Call ensureTempRoot explicitly when host mutation is intended.
function inspectTempRoot(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const statfsProbe = options.statfs || ((target) => fsImpl.statfsSync(target, { bigint: true }));
  const configuredRoot = options.tempRoot;
  const minimumFreeBytesBig = Number.isFinite(options.minimumFreeBytes) && options.minimumFreeBytes >= 0
    ? BigInt(Math.trunc(options.minimumFreeBytes))
    : (typeof options.minimumFreeBytes === "bigint" && options.minimumFreeBytes >= 0n
      ? options.minimumFreeBytes
      : 0n);
  const minimumFreeBytes = Number(minimumFreeBytesBig);

  if (typeof configuredRoot !== "string" || !path.isAbsolute(configuredRoot)) {
    return unavailable(configuredRoot || null, "root_not_absolute", { minimumFreeBytes });
  }

  let rootStat;
  try {
    rootStat = fsImpl.lstatSync(configuredRoot);
  } catch (err) {
    return unavailable(configuredRoot, err && err.code === "ENOENT" ? "root_missing" : "root_unreadable", {
      minimumFreeBytes,
    });
  }
  if (rootStat.isSymbolicLink()) {
    return unavailable(configuredRoot, "root_is_symlink", { minimumFreeBytes });
  }
  if (!rootStat.isDirectory()) {
    return unavailable(configuredRoot, "root_not_directory", { minimumFreeBytes });
  }

  let canonicalRoot;
  try {
    // This also normalizes platform aliases such as /var versus /private/var
    // before any descendant-containment decision is made.
    canonicalRoot = realpathSync(fsImpl, configuredRoot);
  } catch {
    return unavailable(configuredRoot, "root_realpath_failed", { minimumFreeBytes });
  }

  const mode = rootStat.mode & 0o7777;
  if (mode !== 0o700) {
    return unavailable(configuredRoot, "root_mode_unsafe", {
      canonicalRoot,
      mode,
      minimumFreeBytes,
    });
  }

  const expectedUid = Object.prototype.hasOwnProperty.call(options, "expectedUid")
    ? options.expectedUid
    : (typeof process.getuid === "function" ? process.getuid() : null);
  if (expectedUid !== null && rootStat.uid !== expectedUid) {
    return unavailable(configuredRoot, "root_owner_mismatch", {
      canonicalRoot,
      ownerUid: rootStat.uid,
      expectedUid,
      minimumFreeBytes,
    });
  }

  let filesystem;
  try {
    filesystem = readFilesystemState(statfsProbe, canonicalRoot);
  } catch {
    return unavailable(configuredRoot, "statfs_failed", { canonicalRoot, minimumFreeBytes });
  }
  let finalStat;
  let finalIdentity;
  let finalRealpath;
  try {
    finalStat = fsImpl.lstatSync(canonicalRoot);
    finalIdentity = statIdentity(finalStat);
    finalRealpath = realpathSync(fsImpl, canonicalRoot);
  } catch {
    return unavailable(configuredRoot, "root_identity_lost", { canonicalRoot, minimumFreeBytes });
  }
  const initialIdentity = statIdentity(rootStat);
  if (!sameIdentity(initialIdentity, finalIdentity)
    || initialIdentity.uid !== finalIdentity.uid
    || initialIdentity.mode !== finalIdentity.mode
    || finalStat.isSymbolicLink()
    || !finalStat.isDirectory()
    || finalRealpath !== canonicalRoot) {
    return unavailable(configuredRoot, "root_identity_changed", { canonicalRoot, minimumFreeBytes });
  }
  if (!filesystem.diskBacked) {
    return unavailable(configuredRoot, "root_is_memory_backed", {
      canonicalRoot,
      filesystemType: filesystem.type,
      availableBytes: filesystem.availableBytes,
      minimumFreeBytes,
      diskBacked: false,
    });
  }
  if (filesystem.availableBytesBig < minimumFreeBytesBig) {
    return unavailable(configuredRoot, "insufficient_free_space", {
      canonicalRoot,
      filesystemType: filesystem.type,
      availableBytes: filesystem.availableBytes,
      minimumFreeBytes,
      diskBacked: true,
    });
  }

  const facts = Object.freeze({
    available: true,
    reason: null,
    code: "ready",
    configuredRoot,
    canonicalRoot,
    mode,
    ownerUid: rootStat.uid,
    filesystemType: filesystem.type,
    availableBytes: filesystem.availableBytes,
    minimumFreeBytes,
    diskBacked: true,
  });
  FACT_STATE.set(facts, Object.freeze({
    fsImpl,
    statfsProbe,
    identity: initialIdentity,
    expectedUid,
    filesystemTypeBig: filesystem.typeBig,
    minimumFreeBytesBig,
  }));
  return facts;
}

function throwFromFacts(facts) {
  throw new ResourceTempError(facts.code, `resource temp unavailable: ${facts.code}`, facts);
}

// Explicit host mutation. The caller supplies the fixed absolute root and is
// responsible for presenting/accepting that configuration before this call.
function ensureTempRoot(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const configuredRoot = options.tempRoot;
  if (typeof configuredRoot !== "string" || !path.isAbsolute(configuredRoot)) {
    throwFromFacts(unavailable(configuredRoot || null, "root_not_absolute"));
  }
  try {
    fsImpl.mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
    const st = fsImpl.lstatSync(configuredRoot);
    if (st.isSymbolicLink()) {
      throw new ResourceTempError("root_is_symlink", "resource temp root must not be a symlink");
    }
    if (!st.isDirectory()) {
      throw new ResourceTempError("root_not_directory", "resource temp root is not a directory");
    }
    const expectedUid = Object.prototype.hasOwnProperty.call(options, "expectedUid")
      ? options.expectedUid
      : (typeof process.getuid === "function" ? process.getuid() : null);
    if (expectedUid !== null && st.uid !== expectedUid) {
      throw new ResourceTempError("root_owner_mismatch", "resource temp root has an unexpected owner");
    }
    if ((Number(st.mode) & 0o7777) !== 0o700) {
      throw new ResourceTempError("root_mode_unsafe", "resource temp root must be created with mode 0700");
    }
  } catch (err) {
    if (err instanceof ResourceTempError) throw err;
    throw new ResourceTempError("root_create_failed", `cannot create resource temp root: ${err.message}`);
  }
  const facts = inspectTempRoot(options);
  if (!facts.available) throwFromFacts(facts);
  return facts;
}

function validateGenerationId(generationId) {
  if (typeof generationId !== "string" || !GENERATION_ID_RE.test(generationId)) {
    throw new ResourceTempError("invalid_generation_id", "generation id contains unsupported path characters");
  }
  return generationId;
}

function requireAvailableFacts(facts, fsImpl) {
  const state = facts && FACT_STATE.get(facts);
  if (!state || facts.available !== true || !path.isAbsolute(facts.canonicalRoot || "")) {
    throw new ResourceTempError("facts_untrusted", "authentic available resource temp facts are required", null);
  }
  if (state.fsImpl !== fsImpl) {
    throw new ResourceTempError("facts_filesystem_mismatch", "resource temp facts belong to a different filesystem adapter", facts);
  }
  return state;
}

function assertRootSafety(facts, fsImpl, { requireFreeSpace }) {
  const state = requireAvailableFacts(facts, fsImpl);
  let st;
  let identity;
  let currentRealpath;
  let filesystem;
  try {
    st = fsImpl.lstatSync(facts.canonicalRoot);
    identity = statIdentity(st);
    currentRealpath = realpathSync(fsImpl, facts.canonicalRoot);
    filesystem = readFilesystemState(state.statfsProbe, facts.canonicalRoot);
  } catch (err) {
    throw new ResourceTempError("root_identity_lost", `resource temp root is no longer available: ${err.message}`, facts);
  }
  if (st.isSymbolicLink()
    || !st.isDirectory()
    || currentRealpath !== facts.canonicalRoot
    || !sameIdentity(identity, state.identity)) {
    throw new ResourceTempError("root_identity_changed", "resource temp root identity changed", facts);
  }
  if (identity.uid !== state.identity.uid
    || (state.expectedUid !== null && identity.uid !== state.expectedUid)
    || identity.mode !== 0o700) {
    throw new ResourceTempError("root_permissions_changed", "resource temp root ownership or mode changed", facts);
  }
  if (!filesystem.diskBacked || filesystem.typeBig !== state.filesystemTypeBig) {
    throw new ResourceTempError("root_filesystem_changed", "resource temp filesystem class changed", facts);
  }
  if (requireFreeSpace && filesystem.availableBytesBig < state.minimumFreeBytesBig) {
    throw new ResourceTempError("insufficient_free_space", "resource temp root no longer has required free space", facts);
  }
  return state;
}

function generationPath(facts, generationId) {
  validateGenerationId(generationId);
  const candidate = path.join(facts.canonicalRoot, `${GENERATION_PREFIX}${generationId}`);
  if (!isWithin(facts.canonicalRoot, candidate)) {
    throw new ResourceTempError("generation_outside_root", "generation path escapes the configured root", facts);
  }
  return candidate;
}

function createGenerationTemp(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const facts = options.facts;
  const state = assertRootSafety(facts, fsImpl, { requireFreeSpace: true });
  const generationId = validateGenerationId(options.generationId);
  const target = generationPath(facts, generationId);
  try {
    fsImpl.mkdirSync(target, { recursive: false, mode: 0o700 });
    const st = fsImpl.lstatSync(target);
    const identity = statIdentity(st);
    if (st.isSymbolicLink()
      || !st.isDirectory()
      || identity.mode !== 0o700
      || identity.uid !== state.identity.uid
      || identity.dev !== state.identity.dev) {
      throw new ResourceTempError("generation_path_unsafe", "generation temp path is not a real directory", facts);
    }
    const canonicalTarget = realpathSync(fsImpl, target);
    if (!isWithin(facts.canonicalRoot, canonicalTarget)) {
      throw new ResourceTempError("generation_outside_root", "generation path resolves outside the configured root", facts);
    }
  } catch (err) {
    if (err instanceof ResourceTempError) throw err;
    let code = "generation_create_failed";
    if (err && err.code === "EEXIST") {
      try {
        code = fsImpl.lstatSync(target).isSymbolicLink() ? "generation_path_unsafe" : "generation_exists";
      } catch {
        code = "generation_exists";
      }
    }
    throw new ResourceTempError(code, `cannot create generation temp directory: ${err.message}`, facts);
  }
  return Object.freeze({ generationId, path: target, mode: 0o700 });
}

// Atomically detach an owned entry from its caller-visible path, then delegate
// recursive disposal to Node's native fs.rm implementation. Unlike a custom
// lstat/readdir/unlink walk, the native primitive treats symlinks as entries
// and does not recurse through their targets. A swap before rename moves the
// swapped entry into quarantine; a swap after rename can only replace the
// unguessable quarantine entry and is likewise removed as an entry.
function removeConfinedPath(root, target, fsImpl = fs) {
  if (!path.isAbsolute(root) || !path.isAbsolute(target) || !isWithin(root, target)) {
    throw new ResourceTempError("cleanup_outside_root", "cleanup target is outside the configured root");
  }
  let quarantine = null;
  let renamed = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    quarantine = path.join(root, `${QUARANTINE_PREFIX}${process.pid}-${crypto.randomBytes(16).toString("hex")}`);
    try {
      fsImpl.renameSync(target, quarantine);
      renamed = true;
      break;
    } catch (err) {
      if (err && err.code === "ENOENT") return false;
      if (err && ["EEXIST", "ENOTEMPTY"].includes(err.code)) continue;
      throw err;
    }
  }
  if (!renamed || !quarantine) {
    throw new ResourceTempError("cleanup_quarantine_failed", "could not quarantine cleanup target");
  }
  fsImpl.rmSync(quarantine, { recursive: true, force: true, maxRetries: 2 });
  return true;
}

function reclaimGenerationTemp(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const facts = options.facts;
  requireAvailableFacts(facts, fsImpl);
  const generationId = validateGenerationId(options.generationId);
  if (options.confirmedProcessTreeExit !== true) {
    return Object.freeze({
      generationId,
      reclaimed: false,
      reason: "process_tree_exit_unconfirmed",
    });
  }
  assertRootSafety(facts, fsImpl, { requireFreeSpace: false });
  const target = generationPath(facts, generationId);
  const removed = removeConfinedPath(facts.canonicalRoot, target, fsImpl);
  return Object.freeze({ generationId, reclaimed: true, alreadyAbsent: !removed });
}

function newestTimeMs(st) {
  return Math.max(st.mtimeMs || 0, st.atimeMs || 0, st.ctimeMs || 0);
}

// Crash-recovery sweep. Only direct `generation-*` entries beneath the fixed
// root are candidates; known-live generations are excluded even if old.
function sweepStaleGenerationTemps(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const facts = options.facts;
  requireAvailableFacts(facts, fsImpl);
  const suppliedLive = options.liveGenerationIds;
  if (!Array.isArray(suppliedLive) && !(suppliedLive instanceof Set)) {
    throw new ResourceTempError("live_generation_set_required", "an authoritative array or Set of live generation ids is required", facts);
  }
  const live = new Set();
  for (const generationId of suppliedLive) live.add(validateGenerationId(generationId));
  assertRootSafety(facts, fsImpl, { requireFreeSpace: false });
  const now = typeof options.now === "number" ? options.now : Date.now();
  const maxAgeHours = Number.isFinite(options.maxAgeHours) && options.maxAgeHours > 0
    ? options.maxAgeHours
    : DEFAULT_STALE_HOURS;
  const cutoffMs = now - maxAgeHours * 60 * 60 * 1000;
  const result = { removed: [], kept: [], errors: [] };

  let names;
  try {
    names = fsImpl.readdirSync(facts.canonicalRoot);
  } catch (err) {
    result.errors.push(err.message);
    return result;
  }
  for (const name of names) {
    if (!name.startsWith(GENERATION_PREFIX)) continue;
    const generationId = name.slice(GENERATION_PREFIX.length);
    if (!GENERATION_ID_RE.test(generationId)) continue;
    const target = path.join(facts.canonicalRoot, name);
    try {
      const st = fsImpl.lstatSync(target);
      if (live.has(generationId) || newestTimeMs(st) >= cutoffMs) {
        result.kept.push(generationId);
        continue;
      }
      removeConfinedPath(facts.canonicalRoot, target, fsImpl);
      result.removed.push(generationId);
    } catch (err) {
      result.errors.push(`${generationId}: ${err.message}`);
    }
  }
  return result;
}

module.exports = {
  ResourceTempError,
  TMPFS_MAGIC,
  RAMFS_MAGIC,
  inspectTempRoot,
  ensureTempRoot,
  createGenerationTemp,
  reclaimGenerationTemp,
  sweepStaleGenerationTemps,
  removeConfinedPath,
};
