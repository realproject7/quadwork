"use strict";

const assert = require("assert/strict");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");
const {
  parseProcMeminfo,
  createReadOnlyProbes,
  runResourcePreflight,
} = require("./resource-preflight");

function policy() {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
  };
}

function healthyProbes(overrides = {}) {
  return {
    memory: () => ({ totalMib: 8192, availableMib: 4000, swapTotalMib: 8192, swapFreeMib: 7000 }),
    containment: () => ({ cgroupV2: true, userManager: true, systemdRun: true, scopeProof: true }),
    temp: () => ({
      exists: true,
      directory: true,
      symlink: false,
      owned: true,
      secureMode: true,
      diskBacked: true,
      freeMib: 5000,
      totalMib: 10000,
    }),
    api: () => ({ memoryLowMib: 512, memoryMaxMib: 1280, oomPolicy: "continue", separateFromWorkers: true }),
    activeScopes: () => 1,
    ...overrides,
  };
}

const meminfo = parseProcMeminfo([
  "MemTotal:        8388608 kB",
  "MemAvailable:    4194304 kB",
  "SwapTotal:       8388608 kB",
  "SwapFree:        7340032 kB",
  "",
].join("\n"));
assert.deepEqual(meminfo, { totalMib: 8192, availableMib: 4096, swapTotalMib: 8192, swapFreeMib: 7168 });
assert.throws(() => parseProcMeminfo("MemTotal: 1024 kB\n"), /missing MemAvailable/);

const ok = runResourcePreflight({ runtimeResources: policy(), probes: healthyProbes() });
assert.equal(ok.ok, true);
assert.equal(ok.reason, "ok");
assert.deepEqual(ok.policy, {
  configured: true,
  version: 1,
  mode: "systemd-user-v1",
  hostReserveMib: 1536,
  maxWorkerScopes: 3,
  apiMemoryLowMib: 512,
  apiMemoryMaxMib: 1280,
  workerMemoryHighMib: 1024,
  workerMemoryMaxMib: 1200,
  workerSwapMaxMib: 512,
  controlMemoryMaxMib: 512,
  controlSwapMaxMib: 256,
  maxConcurrentChildren: 2,
  tempMinFreeMib: 4096,
});
assert.equal(ok.capacity.staticReservationMib, 6928);
assert.equal(ok.capacity.configuredSwapMib, 1792);
assert.equal(ok.capacity.requestedMemoryMib, 1200);
assert.equal(ok.capacity.liveRequiredMib, 2736);
assert.equal(ok.capacity.liveHeadroomMib, 1264);
assert.deepEqual(ok.scopes, { admitted: 1, staticCeiling: 3, requested: 1 });
assert(!JSON.stringify(ok).includes(DEFAULT_RUNTIME_RESOURCE_PROPOSAL.temp_root), "report must redact configured host paths");

const absent = runResourcePreflight({ runtimeResources: undefined, probes: healthyProbes() });
assert.equal(absent.ok, false);
assert.equal(absent.reason, "invalid_resource_policy");
assert.equal(absent.reasons[0].check, "policy_absent");

const noProof = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    containment: () => ({ cgroupV2: true, userManager: true, systemdRun: true, scopeProof: false }),
  }),
});
assert.equal(noProof.reason, "containment_unavailable");
assert(noProof.reasons.some((item) => item.check === "systemd_scope_unavailable"));

const unsafeApiInteger = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    api: () => ({ memoryLowMib: 512, memoryMaxMib: null, oomPolicy: "continue", separateFromWorkers: false }),
  }),
});
assert(unsafeApiInteger.reasons.some((item) => item.code === "containment_unavailable" && item.check === "api_limits_unprotected"));

const tmpfs = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    temp: () => ({ exists: true, directory: true, symlink: false, owned: true, secureMode: true, diskBacked: false, freeMib: 9000, totalMib: 10000 }),
  }),
});
assert.equal(tmpfs.reason, "temp_unavailable");
assert(tmpfs.reasons.some((item) => item.check === "temp_root_unsafe"));

const lowDisk = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    temp: () => ({ exists: true, directory: true, symlink: false, owned: true, secureMode: true, diskBacked: true, freeMib: 4095, totalMib: 10000 }),
  }),
});
assert(lowDisk.reasons.some((item) => item.code === "temp_unavailable" && item.check === "temp_space_low"));

const lowSwap = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    memory: () => ({ totalMib: 8192, availableMib: 4000, swapTotalMib: 1791, swapFreeMib: 1791 }),
  }),
});
assert(lowSwap.reasons.some((item) => item.code === "capacity_exhausted" && item.check === "static_capacity_invalid"));

const lowFreeSwap = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    memory: () => ({ totalMib: 8192, availableMib: 4000, swapTotalMib: 8192, swapFreeMib: 511 }),
  }),
});
assert.equal(lowFreeSwap.reason, "capacity_exhausted");
assert.equal(lowFreeSwap.capacity.requestedSwapMib, 512);
assert(lowFreeSwap.reasons.some((item) => item.code === "capacity_exhausted" && item.check === "live_swap_headroom_low"));

const exactFreeSwapBoundary = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    memory: () => ({ totalMib: 8192, availableMib: 4000, swapTotalMib: 8192, swapFreeMib: 512 }),
  }),
});
assert.equal(exactFreeSwapBoundary.reasons.some((item) => item.check === "live_swap_headroom_low"), false);

const ceiling = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({ activeScopes: () => 3 }),
});
assert(ceiling.reasons.some((item) => item.code === "capacity_exhausted" && item.check === "worker_scope_ceiling_reached"));
assert.equal(ceiling.scopes.admitted, 3);

const lowLiveRam = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    memory: () => ({ totalMib: 8192, availableMib: 2735, swapTotalMib: 8192, swapFreeMib: 7000 }),
  }),
});
assert(lowLiveRam.reasons.some((item) => item.code === "capacity_exhausted" && item.check === "live_memory_headroom_low"));

for (const [field, badValue] of [
  ["totalMib", 8192.5],
  ["availableMib", Number.MAX_SAFE_INTEGER + 1],
  ["swapTotalMib", -1],
  ["swapFreeMib", Infinity],
]) {
  const invalidMib = runResourcePreflight({
    runtimeResources: policy(),
    probes: healthyProbes({
      memory: () => ({
        totalMib: 8192,
        availableMib: 4000,
        swapTotalMib: 8192,
        swapFreeMib: 7000,
        [field]: badValue,
      }),
    }),
  });
  assert.equal(invalidMib.capacity, null, `${field} must not be rounded or used in capacity arithmetic`);
  assert(invalidMib.reasons.some((item) => item.check === "host_memory_unavailable"), `${field} fails closed`);
}

const availableExceedsTotal = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    memory: () => ({ totalMib: 8192, availableMib: 8193, swapTotalMib: 8192, swapFreeMib: 7000 }),
  }),
});
assert.equal(availableExceedsTotal.capacity, null);
assert(availableExceedsTotal.reasons.some((item) => item.check === "host_memory_contradictory"));

const swapFreeExceedsTotal = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    memory: () => ({ totalMib: 8192, availableMib: 4000, swapTotalMib: 8192, swapFreeMib: 8193 }),
  }),
});
assert.equal(swapFreeExceedsTotal.capacity, null);
assert(swapFreeExceedsTotal.reasons.some((item) => item.check === "host_memory_contradictory"));

const tempFreeExceedsTotal = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    temp: () => ({ exists: true, directory: true, symlink: false, owned: true, secureMode: true, diskBacked: true, freeMib: 10001, totalMib: 10000 }),
  }),
});
assert(tempFreeExceedsTotal.reasons.some((item) => item.code === "temp_unavailable" && item.check === "temp_capacity_contradictory"));

const fractionalTemp = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    temp: () => ({ exists: true, directory: true, symlink: false, owned: true, secureMode: true, diskBacked: true, freeMib: 5000.5, totalMib: 10000 }),
  }),
});
assert(fractionalTemp.reasons.some((item) => item.check === "temp_capacity_contradictory"));

const unsafeTempTotal = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    temp: () => ({ exists: true, directory: true, symlink: false, owned: true, secureMode: true, diskBacked: true, freeMib: 5000, totalMib: Number.MAX_SAFE_INTEGER + 1 }),
  }),
});
assert(unsafeTempTotal.reasons.some((item) => item.check === "temp_capacity_contradictory"));

const fractionalApi = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    api: () => ({ memoryLowMib: 512.5, memoryMaxMib: 1280, oomPolicy: "continue", separateFromWorkers: true }),
  }),
});
assert(fractionalApi.reasons.some((item) => item.code === "containment_unavailable" && item.check === "api_limits_unprotected"));

const unsafeApi = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({
    api: () => ({ memoryLowMib: 512, memoryMaxMib: Number.MAX_SAFE_INTEGER + 1, oomPolicy: "continue", separateFromWorkers: true }),
  }),
});
assert(unsafeApi.reasons.some((item) => item.code === "containment_unavailable" && item.check === "api_limits_unprotected"));

const multiplicationOverflow = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes(),
  requestedWorkerScopes: Number.MAX_SAFE_INTEGER,
});
assert.equal(multiplicationOverflow.capacity, null);
assert(multiplicationOverflow.reasons.some((item) => item.check === "requested_scope_overflow"));

const tinyPolicy = policy();
Object.assign(tinyPolicy, {
  host_reserve_mib: 1,
  max_worker_scopes: 1,
  api: { memory_low_mib: 1, memory_max_mib: 1 },
  worker: { memory_high_mib: 1, memory_max_mib: 1, swap_max_mib: 1 },
  control: { memory_max_mib: 1, swap_max_mib: 1, max_concurrent_children: 1 },
  temp_min_free_mib: 1,
});
const hugeMemoryProbes = healthyProbes({
  memory: () => ({
    totalMib: Number.MAX_SAFE_INTEGER,
    availableMib: Number.MAX_SAFE_INTEGER,
    swapTotalMib: Number.MAX_SAFE_INTEGER,
    swapFreeMib: Number.MAX_SAFE_INTEGER,
  }),
  temp: () => ({ exists: true, directory: true, symlink: false, owned: true, secureMode: true, diskBacked: true, freeMib: 1, totalMib: 1 }),
  api: () => ({ memoryLowMib: 1, memoryMaxMib: 1, oomPolicy: "continue", separateFromWorkers: true }),
  activeScopes: () => 0,
});
const liveAdditionOverflow = runResourcePreflight({
  runtimeResources: tinyPolicy,
  probes: hugeMemoryProbes,
  requestedWorkerScopes: Number.MAX_SAFE_INTEGER,
});
assert.equal(liveAdditionOverflow.capacity, null);
assert(liveAdditionOverflow.reasons.some((item) => item.check === "live_memory_arithmetic_overflow"));

const scopeAdditionOverflow = runResourcePreflight({
  runtimeResources: tinyPolicy,
  probes: { ...hugeMemoryProbes, activeScopes: () => 2 },
  requestedWorkerScopes: Number.MAX_SAFE_INTEGER - 1,
});
assert.equal(scopeAdditionOverflow.capacity, null);
assert(scopeAdditionOverflow.reasons.some((item) => item.check === "scope_count_overflow"));

const secretProbeFailure = runResourcePreflight({
  runtimeResources: policy(),
  probes: healthyProbes({ temp: () => { throw new Error("/secret/path token=do-not-leak"); } }),
});
const serializedFailure = JSON.stringify(secretProbeFailure);
assert.equal(secretProbeFailure.reason, "temp_unavailable");
assert(!serializedFailure.includes("/secret/path"));
assert(!serializedFailure.includes("do-not-leak"));

const unavailable = runResourcePreflight({ runtimeResources: policy(), probes: {} });
assert.equal(unavailable.reason, "containment_unavailable", "primary failure reason is stable and containment-first");
assert(unavailable.reasons.some((item) => item.code === "temp_unavailable"));
assert(unavailable.reasons.some((item) => item.code === "capacity_exhausted"));

// Exercise the built-in read-only adapter with fake filesystem/process probes.
// The fake deliberately exposes no mkdir/write/rm methods: using one would fail.
const files = new Map([
  ["/proc/meminfo", [
    "MemTotal:        8388608 kB",
    "MemAvailable:    4194304 kB",
    "SwapTotal:       8388608 kB",
    "SwapFree:        7340032 kB",
  ].join("\n")],
  ["/proc/self/cgroup", "0::/system.slice/pm2-quadwork.service\n"],
  ["/cgroup/system.slice/pm2-quadwork.service/memory.low", String(512 * 1024 * 1024)],
  ["/cgroup/system.slice/pm2-quadwork.service/memory.max", String(1280 * 1024 * 1024)],
]);
const fsCalls = [];
const fakeFs = {
  readFileSync(file) {
    fsCalls.push(["read", file]);
    if (!files.has(file)) throw new Error("not found");
    return files.get(file);
  },
  existsSync(file) {
    fsCalls.push(["exists", file]);
    return file === "/cgroup/cgroup.controllers";
  },
  lstatSync(file) {
    fsCalls.push(["lstat", file]);
    return { uid: 1000, mode: 0o40700, isSymbolicLink: () => false, isDirectory: () => true };
  },
  realpathSync(file) {
    fsCalls.push(["realpath", file]);
    return file;
  },
  statfsSync(file) {
    fsCalls.push(["statfs", file]);
    return { type: 0xef53n, bavail: 6000n, bsize: 1048576n, blocks: 10000n };
  },
};
const execCalls = [];
function fakeExec(command, args) {
  execCalls.push([command, [...args]]);
  if (command === "systemd-run") return "systemd 259";
  if (args.includes("list-units")) {
    return "quadwork-worker-a.scope loaded active running A\nquadwork-worker-b.scope loaded active running B\nother.scope loaded active running Other\n";
  }
  if (args.includes("--property=OOMPolicy")) return "continue";
  return "259";
}
const adapter = createReadOnlyProbes({
  fsImpl: fakeFs,
  execFileSyncImpl: fakeExec,
  procRoot: "/proc",
  cgroupRoot: "/cgroup",
  uid: 1000,
  scopeProof: true,
});
const adapterReport = runResourcePreflight({ runtimeResources: policy(), probes: adapter });
assert.equal(adapterReport.ok, true);
assert.equal(adapterReport.scopes.admitted, 2);
assert(fsCalls.every(([kind]) => ["read", "exists", "lstat", "realpath", "statfs"].includes(kind)));
assert(execCalls.every(([command, args]) => {
  if (command === "systemd-run") return args.join(" ") === "--user --version";
  return command === "systemctl" && !args.some((arg) => ["start", "stop", "set-property", "enable", "disable"].includes(arg));
}));
assert(execCalls.some(([command, args]) => command === "systemctl"
  && args.join(" ") === "--user --property=Version --value show"));
assert(execCalls.some(([command, args]) => command === "systemctl"
  && args.join(" ") === "--property=OOMPolicy --value show pm2-quadwork.service"));
assert(execCalls.some(([command, args]) => command === "systemctl"
  && args.join(" ") === "--user --type=scope --state=running --no-legend --plain list-units"));

files.set(
  "/cgroup/system.slice/pm2-quadwork.service/memory.max",
  String(BigInt(1280 * 1024 * 1024) + 1n),
);
const inexactCgroupBytes = runResourcePreflight({ runtimeResources: policy(), probes: adapter });
assert.equal(inexactCgroupBytes.api, null, "1280 MiB + 1 byte must not be rounded down to 1280 MiB");
assert(inexactCgroupBytes.reasons.some((item) => item.code === "containment_unavailable" && item.check === "api_limits_unprotected"));

console.log("resource-preflight.test.js: all assertions passed");
