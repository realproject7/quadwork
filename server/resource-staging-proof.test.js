"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { parseCliArgs, runStagingProof } = require("./resource-staging-proof");
const cli = require.resolve("./resource-staging-proof");
for (const args of [["--adapter", "fake"], ["--target", "http://127.0.0.1"], ["--module", "fake"], ["--command", "true"], ["--json", "--json"], ["--ack-disposable-host"]]) {
  assert.throws(() => parseCliArgs(args));
  const child = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 2);
}
for (const args of [["--json"], ["--json", "--run-pressure-matrix", "--ack-disposable-host", "DISPOSABLE-STAGING:00000000000000000000000000000000"]]) {
  const child = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, false);
  assert.deepEqual(result.started_phases, []);
  assert.equal(result.provider_model_turns, "unproved_no_credentials");
}
(async () => {
  for (const key of ["adapter", "fsImpl", "exec", "target", "trusted", "probe", "receiptBytes"]) {
    let accessed = false;
    const options = {};
    Object.defineProperty(options, key, { enumerable: true, get() { accessed = true; throw new Error("never read"); } });
    const result = await runStagingProof(options);
    assert.equal(result.reason, "proof_refused"); assert.equal(accessed, false);
  }
  console.log("resource-staging-proof: actual CLI gates and caller authority refusal passed");
})().catch((e) => { console.error(e); process.exitCode = 1; });
