"use strict";

const assert = require("node:assert/strict");
const {
  getRuntimeResources,
  readRuntimeResources,
} = require("./config");
const {
  DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
  ResourcePolicyError,
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

assert.equal(getRuntimeResources({ port: 8400, projects: [] }), null, "absence remains unconfigured");
assert.equal(getRuntimeResources(null), null, "an absent config does not inject a proposal");

const configured = getRuntimeResources({ runtime_resources: proposal({ temp_root: "/srv/quadwork/../quadwork/tmp" }) });
assert.equal(configured.temp_root, "/srv/quadwork/tmp", "the canonical parser normalizes the configured root");
assert(Object.isFrozen(configured));
assert(Object.isFrozen(configured.worker));

assert.throws(
  () => getRuntimeResources({ runtime_resources: proposal({ hidden_authority: true }) }),
  (err) => err instanceof ResourcePolicyError && err.code === "invalid_resource_policy",
  "unknown authority-bearing fields are rejected by the canonical schema",
);

const calls = [];
const readOnlyFs = {
  readFileSync(file, encoding) {
    calls.push(["readFileSync", file, encoding]);
    return JSON.stringify({ port: 8400, runtime_resources: proposal() });
  },
  mkdirSync() { throw new Error("writer invoked"); },
  chmodSync() { throw new Error("writer invoked"); },
  writeFileSync() { throw new Error("writer invoked"); },
  renameSync() { throw new Error("writer invoked"); },
  unlinkSync() { throw new Error("writer invoked"); },
};
const readPolicy = readRuntimeResources({ fsImpl: readOnlyFs, configPath: "/fixture/config.json" });
assert.equal(readPolicy.version, 1);
assert.deepEqual(calls, [["readFileSync", "/fixture/config.json", "utf8"]], "policy loading performs one read and no writes");

const missingCalls = [];
const missingFs = {
  readFileSync(file) {
    missingCalls.push(file);
    const err = new Error("missing");
    err.code = "ENOENT";
    throw err;
  },
  mkdirSync() { throw new Error("missing config must not be created"); },
  writeFileSync() { throw new Error("missing config must not be created"); },
};
assert.equal(readRuntimeResources({ fsImpl: missingFs, configPath: "/absent/config.json" }), null);
assert.deepEqual(missingCalls, ["/absent/config.json"], "missing config remains absent after a read-only lookup");

assert.throws(
  () => readRuntimeResources({ fsImpl: { readFileSync: () => "{" }, configPath: "/secret/config.json" }),
  (err) => err.message === "Invalid QuadWork configuration JSON" && !err.message.includes("/secret"),
  "invalid JSON fails without leaking the config path",
);

console.log("config.runtimeResources.test.js: all assertions passed");
