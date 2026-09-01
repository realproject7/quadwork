"use strict";
const assert = require("node:assert/strict");
const a = "a".repeat(64), b = "b".repeat(64);
const { verifyActionContract } = require("./review-cycle-action-contract");
const cachedCycle = { cycle_id: "rc_" + "1".repeat(32), target_identity_digest: "c".repeat(64), target: { repo: "acme/web", work_item: { number: 42 }, contract_revision: a } };
(async () => {
  assert.equal(await verifyActionContract(cachedCycle, () => cachedCycle, async () => ({ contract_revision: a })), cachedCycle,
    "matching live #1033 contract admits current action");
  assert.equal(await verifyActionContract(cachedCycle, () => cachedCycle, async () => ({ contract_revision: b })), null,
    "contract changed after cache observation blocks nonce/receipt admission");
  assert.equal(await verifyActionContract(cachedCycle, () => ({ ...cachedCycle, target: { ...cachedCycle.target, contract_revision: b } }), async () => ({ contract_revision: a })), null,
    "post-read current-cycle change blocks action admission");
  console.log("review-cycle-action-contract.test.js: all assertions passed");
})().catch((error) => { console.error(error); process.exit(1); });
