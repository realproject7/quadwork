"use strict";

// Narrow Linux-only directory descriptor primitive shared by resource setup
// and durable resource state. Callers own policy/schema decisions; this module
// only validates one canonical owner-only directory and invokes the packaged
// renameat2 helper through an inherited directory fd.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RENAME_HELPER = path.join(__dirname, "resource-rename-exchange-helper.py");
const HELPER_ENV = Object.freeze({ LANG: "C", LC_ALL: "C" });
const MAX_RECOVERY_ENTRIES = 8;
const MAX_ENTRY_BYTES = 255;

class SecureResourceDirectoryError extends Error {
  constructor(code, message, recoveryEntries = []) {
    super(message);
    this.name = "SecureResourceDirectoryError";
    this.code = code;
    Object.defineProperty(this, "recoveryEntries", {
      configurable: false,
      enumerable: false,
      value: normalizeRecoveryEntries(recoveryEntries),
      writable: false,
    });
  }
}

function normalizeRecoveryEntries(entries) {
  if (!Array.isArray(entries)) return Object.freeze([]);
  const accepted = [];
  const seen = new Set();
  for (const entry of entries) {
    if (accepted.length >= MAX_RECOVERY_ENTRIES) break;
    try {
      validateEntryName(entry);
    } catch {
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    accepted.push(entry);
  }
  return Object.freeze(accepted);
}

function validateEntryName(name) {
  if (typeof name !== "string"
    || name.length === 0
    || Buffer.byteLength(name, "utf8") > MAX_ENTRY_BYTES
    || name === "."
    || name === ".."
    || name.includes("\0")
    || name.includes("/")
    || name.includes("\\")
    || path.basename(name) !== name) {
    throw new SecureResourceDirectoryError(
      "entry_invalid",
      "secure resource entry name is invalid",
    );
  }
  return name;
}

function modeOf(stat) {
  return Number(stat.mode) & 0o7777;
}

function hasSingleLink(stat) {
  return stat && (stat.nlink === undefined || Number(stat.nlink) === 1);
}

function sameOwnedNode(left, right) {
  return Boolean(left && right
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && Number(left.uid) === Number(right.uid)
    && modeOf(left) === modeOf(right));
}

function sameRegularNode(left, right) {
  return sameOwnedNode(left, right)
    && left.isFile()
    && right.isFile()
    && hasSingleLink(left)
    && hasSingleLink(right);
}

function validateCanonicalDirectory(directory, { fsImpl = fs, expectedUid = null } = {}) {
  if (typeof directory !== "string"
    || !path.isAbsolute(directory)
    || path.normalize(directory) !== directory) {
    throw new SecureResourceDirectoryError(
      "directory_invalid",
      "secure resource directory must be a normalized absolute path",
    );
  }
  let inspected;
  let canonical;
  try {
    inspected = fsImpl.lstatSync(directory);
    canonical = fsImpl.realpathSync(directory);
  } catch {
    throw new SecureResourceDirectoryError(
      "directory_unavailable",
      "secure resource directory cannot be inspected",
    );
  }
  if (inspected.isSymbolicLink()
    || !inspected.isDirectory()
    || modeOf(inspected) !== 0o700
    || (expectedUid !== null && Number(inspected.uid) !== expectedUid)
    || canonical !== directory) {
    throw new SecureResourceDirectoryError(
      "directory_unsafe",
      "secure resource directory is not a canonical owner-only directory",
    );
  }
  return inspected;
}

function helperError(mode, status, recoveryEntries) {
  if (status === 64) {
    return new SecureResourceDirectoryError(
      "rename_unavailable",
      "secure resource rename primitive is unavailable",
      recoveryEntries,
    );
  }
  if (status === 66) {
    return new SecureResourceDirectoryError(
      "destination_exists",
      "secure resource destination already exists",
      recoveryEntries,
    );
  }
  if (status === 67) {
    return new SecureResourceDirectoryError(
      "recovery_required",
      "secure resource rename requires explicit recovery",
      recoveryEntries,
    );
  }
  return new SecureResourceDirectoryError(
    mode === "probe" ? "rename_probe_failed" : "rename_failed",
    mode === "probe"
      ? "secure resource rename probe requires explicit recovery"
      : "secure resource rename failed",
    recoveryEntries,
  );
}

function runRenameHelper(fd, mode, names, {
  execFileSyncImpl = execFileSync,
  sourceIdentity = null,
  destinationIdentity = null,
  expectedUid = null,
} = {}) {
  const accepted = names.map(validateEntryName);
  const args = ["-I", RENAME_HELPER, mode, "3", ...accepted];
  if (mode === "exchange" || mode === "noreplace") {
    if (!sourceIdentity
      || expectedUid === null
      || !Number.isSafeInteger(expectedUid)
      || expectedUid < 0
      || (mode === "exchange" && !destinationIdentity)) {
      throw new SecureResourceDirectoryError(
        "rename_identity_invalid",
        "secure resource rename identity is invalid",
        accepted,
      );
    }
    args.push(
      String(sourceIdentity.dev),
      String(sourceIdentity.ino),
      destinationIdentity === null ? "0" : String(destinationIdentity.dev),
      destinationIdentity === null ? "0" : String(destinationIdentity.ino),
      String(expectedUid),
    );
  }
  try {
    execFileSyncImpl("/usr/bin/python3", args, {
      encoding: "utf8",
      env: HELPER_ENV,
      maxBuffer: 4 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", fd],
      timeout: 5_000,
      windowsHide: true,
    });
  } catch (error) {
    let status = 65;
    try {
      const observed = Number(error && error.status);
      if (Number.isInteger(observed)) status = observed;
    } catch {}
    throw helperError(mode, status, accepted);
  }
}

function createLinuxSecureDirectoryHandle({
  directory,
  directoryIdentity,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
  platform = process.platform,
} = {}) {
  if (platform !== "linux") {
    throw new SecureResourceDirectoryError(
      "descriptor_anchor_unavailable",
      "secure resource directory descriptors require Linux",
    );
  }
  const constants = fsImpl.constants || fs.constants;
  if (!Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
    throw new SecureResourceDirectoryError(
      "descriptor_anchor_unavailable",
      "secure resource directory descriptor flags are unavailable",
    );
  }
  let fd;
  try {
    fd = fsImpl.openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const handleRoot = `/proc/self/fd/${fd}`;
    const opened = fsImpl.fstatSync(fd);
    const anchored = fsImpl.statSync(handleRoot);
    const canonical = fsImpl.realpathSync(handleRoot);
    if (!opened.isDirectory()
      || !sameOwnedNode(opened, anchored)
      || !sameOwnedNode(opened, directoryIdentity)
      || canonical !== directory) {
      throw new SecureResourceDirectoryError(
        "descriptor_anchor_changed",
        "secure resource directory descriptor identity changed",
      );
    }
    let closed = false;
    const ensureOpen = () => {
      if (closed) {
        throw new SecureResourceDirectoryError(
          "descriptor_anchor_closed",
          "secure resource directory descriptor is closed",
        );
      }
    };
    return {
      stat() {
        ensureOpen();
        return fsImpl.fstatSync(fd);
      },
      path(name) {
        ensureOpen();
        return path.join(handleRoot, validateEntryName(name));
      },
      assertAvailable() {
        ensureOpen();
        const token = `.resource-rename-available-${process.pid}`;
        runRenameHelper(fd, "available", [token, `${token}-peer`], { execFileSyncImpl });
      },
      probeExchange(source, destination) {
        ensureOpen();
        runRenameHelper(fd, "probe", [source, destination], { execFileSyncImpl });
      },
      commit({ mode, source, destination, sourceIdentity, destinationIdentity = null, expectedUid }) {
        ensureOpen();
        if (mode !== "exchange" && mode !== "noreplace") {
          throw new SecureResourceDirectoryError(
            "rename_mode_invalid",
            "secure resource rename mode is invalid",
          );
        }
        runRenameHelper(fd, mode, [source, destination], {
          execFileSyncImpl,
          sourceIdentity,
          destinationIdentity,
          expectedUid,
        });
      },
      fsync() {
        ensureOpen();
        fsImpl.fsyncSync(fd);
      },
      close() {
        if (closed) return;
        closed = true;
        fsImpl.closeSync(fd);
      },
    };
  } catch (error) {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
    if (error instanceof SecureResourceDirectoryError) throw error;
    throw new SecureResourceDirectoryError(
      "descriptor_anchor_unavailable",
      "secure resource directory descriptor could not be opened",
    );
  }
}

module.exports = {
  MAX_RECOVERY_ENTRIES,
  SecureResourceDirectoryError,
  createLinuxSecureDirectoryHandle,
  hasSingleLink,
  modeOf,
  normalizeRecoveryEntries,
  sameOwnedNode,
  sameRegularNode,
  validateCanonicalDirectory,
  validateEntryName,
};
