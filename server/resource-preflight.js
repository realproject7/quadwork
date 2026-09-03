"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  ResourcePolicyError,
  parseRuntimeResources,
  validatePolicyCapacity,
} = require("./resource-policy");

const MIB = 1024 * 1024;
const TMPFS_MAGIC = 0x01021994n;
const RAMFS_MAGIC = 0x858458f6n;

const REASON_MESSAGES = Object.freeze({
  invalid_resource_policy: "Configure and explicitly accept a valid runtime_resources v1 policy, then rerun preflight.",
  containment_unavailable: "Complete the documented user-systemd/PTY proof or explicit containment repair, then rerun preflight.",
  temp_unavailable: "Run the explicit disk-backed temp-root install or repair procedure, then rerun preflight.",
  capacity_exhausted: "Reduce configured capacity or add RAM, swap, or disk headroom; existing scopes remain untouched.",
});
const REASON_PRIORITY = Object.freeze({
  invalid_resource_policy: 0,
  containment_unavailable: 1,
  temp_unavailable: 2,
  capacity_exhausted: 3,
});

function validMib(value) {
  // Probe adapters already declare MiB units. Rounding a fractional or unsafe
  // value could turn an over-limit fact into an apparently valid one.
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function checkedNonNegativeProduct(left, right) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) return null;
  const product = left * right;
  return Number.isSafeInteger(product) ? product : null;
}

function checkedNonNegativeSum(left, right) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) return null;
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
}

function parseProcMeminfo(text) {
  const values = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]));
  }
  const requireKib = (name) => {
    const value = values.get(name);
    if (!Number.isSafeInteger(value)) throw new Error(`missing ${name}`);
    return Math.floor(value / 1024);
  };
  return Object.freeze({
    totalMib: requireKib("MemTotal"),
    availableMib: requireKib("MemAvailable"),
    swapTotalMib: requireKib("SwapTotal"),
    swapFreeMib: requireKib("SwapFree"),
  });
}

function readCgroupV2Path(text) {
  const line = String(text || "").split(/\r?\n/).find((entry) => entry.startsWith("0::"));
  if (!line) throw new Error("unified cgroup path unavailable");
  const value = line.slice(3);
  if (!value.startsWith("/")) throw new Error("invalid unified cgroup path");
  return value;
}

function cgroupValueToMib(raw) {
  const text = String(raw).trim();
  if (text === "max") return null;
  if (!/^\d+$/.test(text)) throw new Error("invalid cgroup memory value");
  const bytes = BigInt(text);
  const mibBytes = BigInt(MIB);
  if (bytes % mibBytes !== 0n) throw new Error("cgroup memory value is not an exact MiB value");
  const mib = bytes / mibBytes;
  if (mib > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cgroup memory value is too large");
  return Number(mib);
}

function createReadOnlyProbes(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const procRoot = options.procRoot || "/proc";
  const cgroupRoot = options.cgroupRoot || "/sys/fs/cgroup";
  const scopePrefix = options.scopePrefix || "quadwork-worker-";
  // Capability is not proof. The integration/staging layer must explicitly
  // supply true only after the fixed PTY/descendant matrix has passed.
  const scopeProof = options.scopeProof === true;
  const uid = options.uid !== undefined
    ? options.uid
    : (typeof process.getuid === "function" ? process.getuid() : null);

  function execText(command, args) {
    return String(execFileSyncImpl(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    })).trim();
  }

  function commandWorks(command, args) {
    try {
      return execText(command, args).length > 0;
    } catch {
      return false;
    }
  }

  function resolveSelfCgroup() {
    const relative = readCgroupV2Path(fsImpl.readFileSync(path.join(procRoot, "self", "cgroup"), "utf8"));
    const resolved = path.resolve(cgroupRoot, `.${relative}`);
    const root = path.resolve(cgroupRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("cgroup path escaped the unified hierarchy");
    }
    return { relative, resolved };
  }

  return Object.freeze({
    memory() {
      return parseProcMeminfo(fsImpl.readFileSync(path.join(procRoot, "meminfo"), "utf8"));
    },

    containment() {
      return {
        cgroupV2: fsImpl.existsSync(path.join(cgroupRoot, "cgroup.controllers")),
        userManager: commandWorks("systemctl", ["--user", "--property=Version", "--value", "show"]),
        systemdRun: commandWorks("systemd-run", ["--user", "--version"]),
        scopeProof,
      };
    },

    temp(tempRoot) {
      const stat = fsImpl.lstatSync(tempRoot);
      const canonicalRoot = path.resolve(tempRoot);
      const realRoot = path.resolve(fsImpl.realpathSync(tempRoot));
      // Reject a symlink at any component, not only at the final path element.
      const symlink = stat.isSymbolicLink() || canonicalRoot !== realRoot;
      const owned = uid !== null && Number(stat.uid) === Number(uid);
      const secureMode = (Number(stat.mode) & 0o777) === 0o700;
      if (symlink || !stat.isDirectory()) {
        return { exists: true, directory: false, symlink, owned, secureMode, diskBacked: false, freeMib: 0, totalMib: 0 };
      }
      const statfs = fsImpl.statfsSync(tempRoot, { bigint: true });
      const fsType = BigInt.asUintN(32, BigInt(statfs.type));
      const memoryBacked = fsType === TMPFS_MAGIC || fsType === RAMFS_MAGIC;
      return {
        exists: true,
        directory: true,
        symlink: false,
        owned,
        secureMode,
        diskBacked: !memoryBacked,
        freeMib: Number((statfs.bavail * statfs.bsize) / BigInt(MIB)),
        totalMib: Number((statfs.blocks * statfs.bsize) / BigInt(MIB)),
      };
    },

    api() {
      const cgroup = resolveSelfCgroup();
      const memoryLowMib = cgroupValueToMib(fsImpl.readFileSync(path.join(cgroup.resolved, "memory.low"), "utf8"));
      const memoryMaxMib = cgroupValueToMib(fsImpl.readFileSync(path.join(cgroup.resolved, "memory.max"), "utf8"));
      let oomPolicy;
      const unit = path.posix.basename(cgroup.relative);
      if (/\.(?:service|scope)$/.test(unit)) {
        try { oomPolicy = execText("systemctl", ["--property=OOMPolicy", "--value", "show", unit]); } catch {}
      }
      return {
        memoryLowMib,
        memoryMaxMib,
        oomPolicy,
        separateFromWorkers: scopeProof,
      };
    },

    activeScopes() {
      const output = execText("systemctl", [
        "--user",
        "--type=scope",
        "--state=running",
        "--no-legend",
        "--plain",
        "list-units",
      ]);
      if (!output) return 0;
      return output.split(/\r?\n/).filter((line) => {
        const unit = line.trim().split(/\s+/, 1)[0];
        return unit.startsWith(scopePrefix) && unit.endsWith(".scope");
      }).length;
    },
  });
}

function safeProbe(probes, name, arg) {
  try {
    if (!probes || typeof probes[name] !== "function") return null;
    return probes[name](arg);
  } catch {
    // Probe errors are intentionally reduced to typed checks. Raw errors may
    // contain host paths, unit names, command output, or environment details.
    return null;
  }
}

function addReason(reasons, code, check) {
  if (!reasons.some((item) => item.code === code && item.check === check)) {
    reasons.push(Object.freeze({ code, check, message: REASON_MESSAGES[code] }));
  }
}

function redactedPolicy(policy) {
  return Object.freeze({
    configured: true,
    version: policy.version,
    mode: policy.mode,
    hostReserveMib: policy.host_reserve_mib,
    maxWorkerScopes: policy.max_worker_scopes,
    apiMemoryLowMib: policy.api.memory_low_mib,
    apiMemoryMaxMib: policy.api.memory_max_mib,
    workerMemoryHighMib: policy.worker.memory_high_mib,
    workerMemoryMaxMib: policy.worker.memory_max_mib,
    workerSwapMaxMib: policy.worker.swap_max_mib,
    controlMemoryMaxMib: policy.control.memory_max_mib,
    controlSwapMaxMib: policy.control.swap_max_mib,
    maxConcurrentChildren: policy.control.max_concurrent_children,
    tempMinFreeMib: policy.temp_min_free_mib,
  });
}

function invalidReport(check) {
  const reason = Object.freeze({
    code: "invalid_resource_policy",
    check,
    message: REASON_MESSAGES.invalid_resource_policy,
  });
  return Object.freeze({ ok: false, reason: reason.code, reasons: Object.freeze([reason]), policy: Object.freeze({ configured: false }) });
}

function runResourcePreflight({ runtimeResources, probes, requestedWorkerScopes = 1 } = {}) {
  let policy;
  try {
    policy = parseRuntimeResources(runtimeResources);
  } catch (err) {
    if (err instanceof ResourcePolicyError) return invalidReport("policy_invalid");
    throw err;
  }
  if (!policy) return invalidReport("policy_absent");
  if (!Number.isSafeInteger(requestedWorkerScopes) || requestedWorkerScopes < 0) {
    return invalidReport("requested_scope_invalid");
  }

  const reasons = [];
  const memoryRaw = safeProbe(probes, "memory");
  const containmentRaw = safeProbe(probes, "containment");
  const tempRaw = safeProbe(probes, "temp", policy.temp_root);
  const apiRaw = safeProbe(probes, "api");
  const activeRaw = safeProbe(probes, "activeScopes");

  const memory = memoryRaw ? {
    totalMib: validMib(memoryRaw.totalMib),
    availableMib: validMib(memoryRaw.availableMib),
    swapTotalMib: validMib(memoryRaw.swapTotalMib),
    swapFreeMib: validMib(memoryRaw.swapFreeMib),
  } : null;
  const memoryValuesValid = memory && !Object.values(memory).some((value) => value === null);
  const memoryFactsConsistent = memoryValuesValid
    && memory.availableMib <= memory.totalMib
    && memory.swapFreeMib <= memory.swapTotalMib;
  if (!memoryValuesValid) {
    addReason(reasons, "capacity_exhausted", "host_memory_unavailable");
  } else if (!memoryFactsConsistent) {
    addReason(reasons, "capacity_exhausted", "host_memory_contradictory");
  }

  const containment = containmentRaw ? {
    cgroupV2: containmentRaw.cgroupV2 === true,
    userManager: containmentRaw.userManager === true,
    systemdRun: containmentRaw.systemdRun === true,
    scopeProof: containmentRaw.scopeProof === true,
  } : null;
  if (!containment || !containment.cgroupV2 || !containment.userManager || !containment.systemdRun || !containment.scopeProof) {
    addReason(reasons, "containment_unavailable", "systemd_scope_unavailable");
  }

  const temp = tempRaw ? {
    exists: tempRaw.exists === true,
    directory: tempRaw.directory === true,
    symlink: tempRaw.symlink === true,
    owned: tempRaw.owned === true,
    secureMode: tempRaw.secureMode === true,
    diskBacked: tempRaw.diskBacked === true,
    freeMib: validMib(tempRaw.freeMib),
    totalMib: validMib(tempRaw.totalMib),
  } : null;
  if (!temp || !temp.exists || !temp.directory || temp.symlink || !temp.owned || !temp.secureMode || !temp.diskBacked) {
    addReason(reasons, "temp_unavailable", "temp_root_unsafe");
  } else if (temp.freeMib === null || temp.totalMib === null || temp.freeMib > temp.totalMib) {
    addReason(reasons, "temp_unavailable", "temp_capacity_contradictory");
  } else if (temp.freeMib < policy.temp_min_free_mib) {
    addReason(reasons, "temp_unavailable", "temp_space_low");
  }

  const api = apiRaw ? {
    memoryLowMib: validMib(apiRaw.memoryLowMib),
    memoryMaxMib: validMib(apiRaw.memoryMaxMib),
    oomPolicy: apiRaw.oomPolicy === "continue" ? "continue" : "unverified",
    separateFromWorkers: apiRaw.separateFromWorkers === true,
  } : null;
  if (!api
    || api.memoryLowMib !== policy.api.memory_low_mib
    || api.memoryMaxMib !== policy.api.memory_max_mib
    || api.oomPolicy !== "continue"
    || !api.separateFromWorkers) {
    addReason(reasons, "containment_unavailable", "api_limits_unprotected");
  }

  const activeScopes = Array.isArray(activeRaw) ? activeRaw.length : activeRaw;
  const admittedScopes = Number.isSafeInteger(activeScopes) && activeScopes >= 0 ? activeScopes : null;
  if (admittedScopes === null) {
    addReason(reasons, "containment_unavailable", "active_scopes_unavailable");
  }

  let capacity = null;
  if (memoryFactsConsistent && admittedScopes !== null) {
    try {
      const configured = validatePolicyCapacity(policy, {
        physicalRamMib: memory.totalMib,
        swapTotalMib: memory.swapTotalMib,
      });
      const requestedMemoryMib = checkedNonNegativeProduct(requestedWorkerScopes, policy.worker.memory_max_mib);
      const requestedSwapMib = checkedNonNegativeProduct(requestedWorkerScopes, policy.worker.swap_max_mib);
      if (requestedMemoryMib === null || requestedSwapMib === null) {
        addReason(reasons, "capacity_exhausted", "requested_scope_overflow");
      } else {
        const liveRequiredMib = checkedNonNegativeSum(policy.host_reserve_mib, requestedMemoryMib);
        const requestedAndAdmittedScopes = checkedNonNegativeSum(admittedScopes, requestedWorkerScopes);
        if (liveRequiredMib === null) {
          addReason(reasons, "capacity_exhausted", "live_memory_arithmetic_overflow");
        }
        if (requestedAndAdmittedScopes === null) {
          addReason(reasons, "capacity_exhausted", "scope_count_overflow");
        }
        if (liveRequiredMib !== null && requestedAndAdmittedScopes !== null) {
          const liveHeadroomMib = memory.availableMib - liveRequiredMib;
          const liveSwapHeadroomMib = memory.swapFreeMib - requestedSwapMib;
          capacity = {
            staticReservationMib: configured.staticReservationMib,
            staticHeadroomMib: configured.staticHeadroomMib,
            configuredSwapMib: configured.configuredSwapMib,
            swapHeadroomMib: configured.swapHeadroomMib,
            requestedWorkerScopes,
            requestedMemoryMib,
            requestedSwapMib,
            liveRequiredMib,
            liveHeadroomMib,
            liveSwapHeadroomMib,
          };
          if (liveHeadroomMib < 0) addReason(reasons, "capacity_exhausted", "live_memory_headroom_low");
          if (liveSwapHeadroomMib < 0) {
            addReason(reasons, "capacity_exhausted", "live_swap_headroom_low");
          }
          if (requestedAndAdmittedScopes > policy.max_worker_scopes) {
            addReason(reasons, "capacity_exhausted", "worker_scope_ceiling_reached");
          }
        }
      }
    } catch (err) {
      if (err instanceof ResourcePolicyError) addReason(reasons, "capacity_exhausted", "static_capacity_invalid");
      else throw err;
    }
  }

  // Keep the primary reason stable even if probe implementation/order changes.
  // Individual checks retain their original order within each reason class.
  reasons.sort((a, b) => REASON_PRIORITY[a.code] - REASON_PRIORITY[b.code]);
  const report = {
    ok: reasons.length === 0,
    reason: reasons.length === 0 ? "ok" : reasons[0].code,
    reasons: Object.freeze(reasons),
    policy: redactedPolicy(policy),
    host: memory ? Object.freeze(memory) : null,
    containment: containment ? Object.freeze(containment) : null,
    temp: temp ? Object.freeze(temp) : null,
    api: api ? Object.freeze(api) : null,
    scopes: Object.freeze({
      admitted: admittedScopes,
      staticCeiling: policy.max_worker_scopes,
      requested: requestedWorkerScopes,
    }),
    capacity: capacity ? Object.freeze(capacity) : null,
  };
  return Object.freeze(report);
}

module.exports = {
  REASON_MESSAGES,
  parseProcMeminfo,
  createReadOnlyProbes,
  runResourcePreflight,
};
