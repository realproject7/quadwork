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
const GENERATION_QUARANTINE_RE = /^\.quadwork-generation-quarantine-([A-Za-z0-9][A-Za-z0-9._-]{0,127})-([a-f0-9]{32})$/;
const LEGACY_QUARANTINE_NAME_RE = /^(?:\.quadwork-legacy-quarantine-[a-f0-9]{32}|gemini-client-error-quadwork-quarantine-(?:nouid|\d+)-[a-f0-9]{32}\.json)$/;
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

function joinHandlePath(handleRoot, name) {
  if (typeof name !== "string" || name.length === 0 || name.includes(path.sep) || name === "." || name === "..") {
    throw new ResourceTempError("invalid_handle_entry", "descriptor-relative entry name is invalid");
  }
  return path.join(handleRoot, name);
}

function linuxRootHandleFactory({ root, fsImpl }) {
  if (process.platform !== "linux"
    || !Number.isInteger(fsImpl.constants.O_DIRECTORY)
    || !Number.isInteger(fsImpl.constants.O_NOFOLLOW)) {
    throw new ResourceTempError("descriptor_anchor_unavailable", "Linux descriptor-relative root access is unavailable");
  }
  const flags = fsImpl.constants.O_RDONLY | fsImpl.constants.O_DIRECTORY | fsImpl.constants.O_NOFOLLOW;
  const fd = fsImpl.openSync(root, flags);
  const handleRoot = `/proc/self/fd/${fd}`;
  try {
    const opened = statIdentity(fsImpl.fstatSync(fd));
    const anchored = statIdentity(fsImpl.statSync(handleRoot));
    if (!sameIdentity(opened, anchored)) {
      throw new ResourceTempError("descriptor_anchor_unavailable", "proc-fd root identity does not match the opened directory");
    }
  } catch (err) {
    try { fsImpl.closeSync(fd); } catch {}
    if (err instanceof ResourceTempError) throw err;
    throw new ResourceTempError("descriptor_anchor_unavailable", `cannot verify proc-fd root anchor: ${err.message}`);
  }
  return {
    stat: () => fsImpl.fstatSync(fd),
    statfsPath: handleRoot,
    mkdir: (name, options) => fsImpl.mkdirSync(joinHandlePath(handleRoot, name), options),
    lstat: (name) => fsImpl.lstatSync(joinHandlePath(handleRoot, name)),
    readdir: () => fsImpl.readdirSync(handleRoot),
    rename: (from, to) => fsImpl.renameSync(joinHandlePath(handleRoot, from), joinHandlePath(handleRoot, to)),
    rm: (name) => fsImpl.rmSync(joinHandlePath(handleRoot, name), { recursive: true, force: true, maxRetries: 2 }),
    close: () => fsImpl.closeSync(fd),
  };
}

// Read-only inspection. It deliberately does not create, chmod, or clean any
// path. Call ensureTempRoot explicitly when host mutation is intended.
function inspectTempRoot(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const statfsProbe = options.statfs || ((target) => fsImpl.statfsSync(target, { bigint: true }));
  const rootHandleFactory = options.rootHandleFactory
    || (process.platform === "linux" ? linuxRootHandleFactory : null);
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
  if (typeof rootHandleFactory !== "function") {
    return unavailable(configuredRoot, "descriptor_anchor_unavailable", {
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
    rootHandleFactory,
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

function withRootHandle(facts, fsImpl, { requireFreeSpace }, operation) {
  const state = requireAvailableFacts(facts, fsImpl);
  let handle;
  try {
    handle = state.rootHandleFactory({ root: facts.canonicalRoot, fsImpl });
  } catch (err) {
    if (err instanceof ResourceTempError) throw err;
    throw new ResourceTempError("descriptor_anchor_unavailable", `cannot open resource temp root descriptor: ${err.message}`, facts);
  }
  let st;
  let identity;
  let filesystem;
  try {
    st = handle.stat();
    identity = statIdentity(st);
    filesystem = readFilesystemState(state.statfsProbe, handle.statfsPath);
  } catch (err) {
    try { handle.close(); } catch {}
    throw new ResourceTempError("root_identity_lost", `resource temp root is no longer available: ${err.message}`, facts);
  }
  if (!st.isDirectory() || !sameIdentity(identity, state.identity)) {
    try { handle.close(); } catch {}
    throw new ResourceTempError("root_identity_changed", "resource temp root identity changed", facts);
  }
  if (identity.uid !== state.identity.uid
    || (state.expectedUid !== null && identity.uid !== state.expectedUid)
    || identity.mode !== 0o700) {
    try { handle.close(); } catch {}
    throw new ResourceTempError("root_permissions_changed", "resource temp root ownership or mode changed", facts);
  }
  if (!filesystem.diskBacked || filesystem.typeBig !== state.filesystemTypeBig) {
    try { handle.close(); } catch {}
    throw new ResourceTempError("root_filesystem_changed", "resource temp filesystem class changed", facts);
  }
  if (requireFreeSpace && filesystem.availableBytesBig < state.minimumFreeBytesBig) {
    try { handle.close(); } catch {}
    throw new ResourceTempError("insufficient_free_space", "resource temp root no longer has required free space", facts);
  }
  try {
    return operation(handle, state);
  } finally {
    try { handle.close(); } catch {}
  }
}

function namespaceStillOwnsRoot(facts, state, fsImpl) {
  try {
    const st = fsImpl.lstatSync(facts.canonicalRoot);
    const identity = statIdentity(st);
    return !st.isSymbolicLink()
      && st.isDirectory()
      && sameIdentity(identity, state.identity)
      && identity.uid === state.identity.uid
      && identity.mode === 0o700
      && realpathSync(fsImpl, facts.canonicalRoot) === facts.canonicalRoot;
  } catch {
    return false;
  }
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
  const generationId = validateGenerationId(options.generationId);
  const entryName = `${GENERATION_PREFIX}${generationId}`;
  const target = generationPath(facts, generationId);
  return withRootHandle(facts, fsImpl, { requireFreeSpace: true }, (handle, state) => {
    try {
      handle.mkdir(entryName, { recursive: false, mode: 0o700 });
      const st = handle.lstat(entryName);
      const identity = statIdentity(st);
      if (st.isSymbolicLink()
        || !st.isDirectory()
        || identity.mode !== 0o700
        || identity.uid !== state.identity.uid
        || identity.dev !== state.identity.dev) {
        throw new ResourceTempError("generation_path_unsafe", "generation temp path is not a real directory", facts);
      }
      if (!namespaceStillOwnsRoot(facts, state, fsImpl)) {
        try { handle.rm(entryName); } catch {}
        throw new ResourceTempError("root_identity_changed", "resource temp root pathname changed during generation creation", facts);
      }
    } catch (err) {
      if (err instanceof ResourceTempError) throw err;
      let code = "generation_create_failed";
      if (err && err.code === "EEXIST") {
        try {
          code = handle.lstat(entryName).isSymbolicLink() ? "generation_path_unsafe" : "generation_exists";
        } catch {
          code = "generation_exists";
        }
      }
      throw new ResourceTempError(code, `cannot create generation temp directory: ${err.message}`, facts);
    }
    return Object.freeze({ generationId, path: target, mode: 0o700 });
  });
}

function generationQuarantineName(generationId) {
  return `.quadwork-generation-quarantine-${validateGenerationId(generationId)}-${crypto.randomBytes(16).toString("hex")}`;
}

// Detach and dispose using only descriptor-relative direct-child operations.
// If disposal fails, the exact reserved quarantine grammar preserves the
// generation owner for a later authoritative stale sweep.
function detachGeneration(handle, generationId) {
  const source = `${GENERATION_PREFIX}${validateGenerationId(generationId)}`;
  const quarantine = generationQuarantineName(generationId);
  try {
    handle.rename(source, quarantine);
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
  try {
    handle.rm(quarantine);
  } catch {
    throw new ResourceTempError("quarantine_pending", "generation was detached but quarantine disposal remains pending");
  }
  return true;
}

// Legacy cleanup compatibility. V2 generation lifecycle never calls this
// pathname helper; it is descriptor-anchored by detachGeneration above.
function validateLegacyQuarantineName(name) {
  if (typeof name !== "string"
    || name.length === 0
    || name.includes("\0")
    || name.includes("/")
    || name.includes("\\")
    || name === "."
    || name === ".."
    || path.isAbsolute(name)
    || path.basename(name) !== name
    || !LEGACY_QUARANTINE_NAME_RE.test(name)) {
    throw new ResourceTempError("invalid_quarantine_name", "cleanup quarantine name is not supported");
  }
  return name;
}

function removeConfinedPath(root, target, fsImpl = fs, quarantineName = null) {
  if (!path.isAbsolute(root) || !path.isAbsolute(target) || !isWithin(root, target)) {
    throw new ResourceTempError("cleanup_outside_root", "cleanup target is outside the configured root");
  }
  const quarantineDir = path.dirname(target);
  if (quarantineDir !== root && !isWithin(root, quarantineDir)) {
    throw new ResourceTempError("cleanup_outside_root", "cleanup quarantine is outside the configured root");
  }
  const explicitName = quarantineName === null ? null : validateLegacyQuarantineName(quarantineName);
  const resolvedRoot = path.resolve(root);
  const resolvedQuarantineDir = path.resolve(quarantineDir);
  let quarantine = null;
  let renamed = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidateName = explicitName
      || validateLegacyQuarantineName(`.quadwork-legacy-quarantine-${crypto.randomBytes(16).toString("hex")}`);
    quarantine = path.resolve(resolvedQuarantineDir, candidateName);
    if (path.dirname(quarantine) !== resolvedQuarantineDir || !isWithin(resolvedRoot, quarantine)) {
      throw new ResourceTempError("cleanup_outside_root", "cleanup quarantine is outside the configured root");
    }
    try {
      fsImpl.renameSync(target, quarantine);
      renamed = true;
      break;
    } catch (err) {
      if (err && err.code === "ENOENT") return false;
      if (err && ["EEXIST", "ENOTEMPTY"].includes(err.code) && explicitName === null) continue;
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
  return withRootHandle(facts, fsImpl, { requireFreeSpace: false }, (handle) => {
    const removed = detachGeneration(handle, generationId);
    return Object.freeze({ generationId, reclaimed: true, alreadyAbsent: !removed });
  });
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
  const now = typeof options.now === "number" ? options.now : Date.now();
  const maxAgeHours = Number.isFinite(options.maxAgeHours) && options.maxAgeHours > 0
    ? options.maxAgeHours
    : DEFAULT_STALE_HOURS;
  const cutoffMs = now - maxAgeHours * 60 * 60 * 1000;
  return withRootHandle(facts, fsImpl, { requireFreeSpace: false }, (handle, state) => {
    const result = { removed: [], kept: [], recoveredQuarantines: [], pendingQuarantines: [], errors: [] };
    let names;
    try {
      names = handle.readdir();
    } catch (err) {
      result.errors.push(err.message);
      return result;
    }
    for (const name of names) {
      const quarantineMatch = name.match(GENERATION_QUARANTINE_RE);
      if (quarantineMatch) {
        const generationId = quarantineMatch[1];
        try {
          const st = handle.lstat(name);
          const identity = statIdentity(st);
          if (identity.uid !== state.identity.uid || identity.dev !== state.identity.dev) {
            result.errors.push(`${generationId}: quarantine ownership mismatch`);
            continue;
          }
          if (live.has(generationId) || newestTimeMs(st) >= cutoffMs) {
            result.pendingQuarantines.push(generationId);
          } else {
            handle.rm(name);
            result.recoveredQuarantines.push(generationId);
          }
        } catch (err) {
          result.errors.push(`${generationId}: ${err.message}`);
        }
        continue;
      }
      if (!name.startsWith(GENERATION_PREFIX)) continue;
      const generationId = name.slice(GENERATION_PREFIX.length);
      if (!GENERATION_ID_RE.test(generationId)) continue;
      try {
        const st = handle.lstat(name);
        const identity = statIdentity(st);
        if (identity.uid !== state.identity.uid
          || identity.dev !== state.identity.dev
          || (!st.isSymbolicLink() && (!st.isDirectory() || identity.mode !== 0o700))) {
          result.errors.push(`${generationId}: generation ownership mismatch`);
          continue;
        }
        if (live.has(generationId) || newestTimeMs(st) >= cutoffMs) {
          result.kept.push(generationId);
          continue;
        }
        detachGeneration(handle, generationId);
        result.removed.push(generationId);
      } catch (err) {
        result.errors.push(`${generationId}: ${err.message}`);
      }
    }
    return result;
  });
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
