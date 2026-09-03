"use strict";

// #1038: read-only service TMPDIR activation.
//
// Resource policy/temp installation is an explicit operator action. Startup
// must never repair the host, but it may re-verify the already accepted root
// before any server module or agent child is loaded. A successful check only
// proves the inherited service temp environment; it is deliberately not V2
// containment-ready evidence.

const fs = require("fs");
const path = require("path");
const { CONFIG_PATH, readRuntimeResources } = require("./config");
const { inspectTempRoot } = require("./resource-temp");

const SERVICE_TEMP_FACT_VERSION = 1;
let lastServiceTempFact = null;

function serviceTempFact({
  status,
  code,
  tmpdirApplied = false,
  inheritedTmpdirCleared = false,
  canonicalRoot = null,
  diskBacked = null,
}) {
  return Object.freeze({
    version: SERVICE_TEMP_FACT_VERSION,
    status,
    reason: status === "ready" ? "service_temp_ready" : "service_temp_unavailable",
    code,
    tmpdir_applied: tmpdirApplied,
    inherited_tmpdir_cleared: inheritedTmpdirCleared,
    canonical_root: canonicalRoot,
    disk_backed: diskBacked,
    containment_ready: false,
    evidence: "service_temp_environment_only",
  });
}

function remember(fact) {
  lastServiceTempFact = fact;
  return fact;
}

function clearUnverifiedLinuxTmpdir(env, platform) {
  if (platform !== "linux" || !Object.prototype.hasOwnProperty.call(env, "TMPDIR")) return false;
  try {
    return delete env.TMPDIR;
  } catch {
    return false;
  }
}

function unavailable(code, env, platform, diskBacked = null) {
  return remember(serviceTempFact({
    status: "warning",
    code,
    inheritedTmpdirCleared: clearUnverifiedLinuxTmpdir(env, platform),
    diskBacked,
  }));
}

function minimumFreeBytes(policy) {
  const bytes = policy.temp_min_free_mib * 1024 * 1024;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function configureServiceTempEnvironment(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  const configPath = options.configPath || CONFIG_PATH;

  // The supported service boundary is Linux. In particular, do not disturb
  // launchd's per-user TMPDIR on macOS merely because V2 containment is not a
  // supported Darwin launch path.
  if (platform !== "linux") return unavailable("platform_unsupported", env, platform);

  let policy;
  try {
    policy = readRuntimeResources({ fsImpl, configPath });
  } catch {
    return unavailable("policy_unreadable", env, platform);
  }
  if (!policy) return unavailable("policy_absent", env, platform);

  const expectedUid = Object.prototype.hasOwnProperty.call(options, "expectedUid")
    ? options.expectedUid
    : (typeof process.getuid === "function" ? process.getuid() : null);
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    return unavailable("owner_identity_unavailable", env, platform);
  }
  const requiredBytes = minimumFreeBytes(policy);
  if (requiredBytes === null) return unavailable("policy_capacity_invalid", env, platform);

  let facts;
  try {
    facts = inspectTempRoot({
      tempRoot: policy.temp_root,
      minimumFreeBytes: requiredBytes,
      expectedUid,
      fsImpl,
      statfs: options.statfs,
      rootHandleFactory: options.rootHandleFactory,
    });
  } catch {
    return unavailable("root_inspection_failed", env, platform);
  }
  if (!facts || facts.available !== true) {
    const code = facts && typeof facts.code === "string" ? facts.code : "root_unavailable";
    return unavailable(code, env, platform, facts && facts.diskBacked === true ? true : null);
  }
  if (facts.canonicalRoot !== policy.temp_root || !path.isAbsolute(facts.canonicalRoot)) {
    return unavailable("root_not_canonical", env, platform, facts.diskBacked === true);
  }
  if (facts.mode !== 0o700
    || facts.ownerUid !== expectedUid
    || facts.diskBacked !== true
    || facts.availableBytes < requiredBytes) {
    return unavailable("root_facts_invalid", env, platform, facts.diskBacked === true);
  }

  try {
    env.TMPDIR = facts.canonicalRoot;
  } catch {
    return unavailable("tmpdir_assignment_failed", env, platform, true);
  }
  if (env.TMPDIR !== facts.canonicalRoot) {
    return unavailable("tmpdir_assignment_failed", env, platform, true);
  }

  return remember(serviceTempFact({
    status: "ready",
    code: "ready",
    tmpdirApplied: true,
    canonicalRoot: facts.canonicalRoot,
    diskBacked: true,
  }));
}

function getLastServiceTempFact() {
  return lastServiceTempFact;
}

module.exports = {
  SERVICE_TEMP_FACT_VERSION,
  configureServiceTempEnvironment,
  getLastServiceTempFact,
};
