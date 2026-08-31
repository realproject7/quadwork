"use strict";

const assert = require("assert/strict");
const {
  DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
  ResourcePolicyError,
  parseRuntimeResources,
  calculateStaticReservationMib,
  calculateConfiguredSwapMib,
  validatePolicyCapacity,
} = require("./resource-policy");

function proposal(overrides = {}) {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
    ...overrides,
  };
}

function rejects(raw, pattern) {
  assert.throws(
    () => parseRuntimeResources(raw),
    (err) => err instanceof ResourcePolicyError
      && err.code === "invalid_resource_policy"
      && pattern.test(err.message),
  );
}

// Absence never activates, injects, or persists the documented proposal.
assert.equal(parseRuntimeResources(undefined), null);
assert.equal(parseRuntimeResources(null), null);
assert(Object.isFrozen(DEFAULT_RUNTIME_RESOURCE_PROPOSAL));
assert(Object.isFrozen(DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker));

const parsed = parseRuntimeResources(proposal());
assert.notEqual(parsed, DEFAULT_RUNTIME_RESOURCE_PROPOSAL);
assert.deepEqual(parsed, DEFAULT_RUNTIME_RESOURCE_PROPOSAL);
assert(Object.isFrozen(parsed));
assert.equal(calculateStaticReservationMib(parsed), 6928);
assert.equal(calculateConfiguredSwapMib(parsed), 1792);

const capacity = validatePolicyCapacity(parsed, { physicalRamMib: 8192, swapTotalMib: 8192 });
assert.deepEqual(capacity, {
  staticReservationMib: 6928,
  staticHeadroomMib: 1264,
  configuredSwapMib: 1792,
  swapHeadroomMib: 6400,
});

rejects({ ...proposal(), future_limit_mib: 1 }, /future_limit_mib is not supported/);
rejects(proposal({ api: { ...proposal().api, memory_swap_max_mib: 1 } }), /api\.memory_swap_max_mib is not supported/);
rejects(proposal({ worker: { ...proposal().worker, cpu_weight: 100 } }), /worker\.cpu_weight is not supported/);
rejects(proposal({ control: { ...proposal().control, max_queue: 3 } }), /control\.max_queue is not supported/);

rejects(proposal({ version: 2 }), /version must be 1/);
rejects(proposal({ mode: "best-effort" }), /mode must be systemd-user-v1/);
rejects(proposal({ temp_root: "relative/tmp" }), /temp_root must be a non-empty absolute path/);
rejects(proposal({ temp_root: "/" }), /cannot be a filesystem root/);
rejects(proposal({ host_reserve_mib: 0 }), /host_reserve_mib must be a positive integer/);
rejects(proposal({ max_worker_scopes: 1.5 }), /max_worker_scopes must be a positive integer/);
rejects(proposal({ api: { memory_low_mib: 513, memory_max_mib: 512 } }), /memory_low_mib must be <= memory_max_mib/);
rejects(proposal({ worker: { ...proposal().worker, memory_high_mib: 1201 } }), /memory_high_mib must be <= memory_max_mib/);
rejects(proposal({ control: { ...proposal().control, swap_max_mib: -1 } }), /swap_max_mib must be a positive integer/);
rejects(proposal({ worker: null }), /runtime_resources.worker must be an object/);

const huge = proposal({
  max_worker_scopes: Number.MAX_SAFE_INTEGER,
  worker: { ...proposal().worker, memory_high_mib: 1, memory_max_mib: 2 },
});
rejects(huge, /static RAM reservation exceeds the supported integer range/);

const ramAdditionOverflow = proposal({
  host_reserve_mib: Number.MAX_SAFE_INTEGER,
  max_worker_scopes: 1,
  api: { memory_low_mib: 1, memory_max_mib: 1 },
  worker: { memory_high_mib: 1, memory_max_mib: 1, swap_max_mib: 1 },
  control: { memory_max_mib: 1, swap_max_mib: 1, max_concurrent_children: 1 },
  temp_min_free_mib: 1,
});
rejects(ramAdditionOverflow, /static RAM reservation exceeds the supported integer range/);

const swapAdditionOverflow = proposal({
  max_worker_scopes: 1,
  worker: { ...proposal().worker, swap_max_mib: 1 },
  control: { ...proposal().control, swap_max_mib: Number.MAX_SAFE_INTEGER },
});
rejects(swapAdditionOverflow, /configured swap reservation exceeds the supported integer range/);

assert.throws(
  () => validatePolicyCapacity(parsed, { physicalRamMib: 6927, swapTotalMib: 8192 }),
  /static RAM reservation exceeds physical RAM/,
);
assert.throws(
  () => validatePolicyCapacity(parsed, { physicalRamMib: 8192, swapTotalMib: 1791 }),
  /configured aggregate swap exceeds total swap/,
);

console.log("resource-policy.test.js: all assertions passed");
