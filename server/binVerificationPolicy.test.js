"use strict";

const assert = require("node:assert/strict");
const { setupV2CiPolicy } = require("../bin/quadwork");

// Exercise the shipped ask/default path with a controlled readline interface.
// No provider, GitHub, config or command execution occurs in policy selection.
async function choose(answers) {
  const prompts = [];
  const rl = { question(prompt, reply) {
    prompts.push(prompt);
    assert.ok(answers.length > 0, "unexpected extra prompt");
    reply(answers.shift());
  } };
  const policy = await setupV2CiPolicy(rl);
  assert.equal(answers.length, 0);
  return { policy, prompts };
}

(async () => {
  const defaults = await choose(["", ""]);
  assert.equal(defaults.policy.mode, "ci-less");
  assert.deepEqual(defaults.policy.evidence_keys, ["unit", "typecheck", "build"]);
  assert.match(defaults.prompts[0], /Local verification.*\[ci-less\]/);
  assert.match(defaults.prompts[1], /\[unit,typecheck,build\]/);

  const external = await choose(["github-checks", "test,build", "product", "required", "control-plane", "advisory", "60", "2"]);
  assert.equal(external.policy.mode, "github-checks");
  assert.deepEqual(external.policy.checks, [
    { name: "test", kind: "product", required: true },
    { name: "build", kind: "control-plane", required: false },
  ]);
  assert.equal(external.policy.registration_grace_seconds, 60);
  assert.equal(external.policy.same_sha_retry_budget, 2);
  assert.equal((await choose(["invalid"])).policy, null);
  assert.equal((await choose(["ci-less", ","])).policy, null);
  console.log("binVerificationPolicy.test.js: actual prompt defaults, external opt-in and invalid input passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
