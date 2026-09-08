"use strict";
const assert = require("node:assert/strict");
const { runClosedStagingMatrix } = require("./resource-staging-live-adapter");
(async () => {
  for (const input of [undefined, {}, { adapter: {} }, { runPressure: true, acknowledgement: "DISPOSABLE-STAGING:wrong" }]) {
    await assert.rejects(runClosedStagingMatrix(input), /disposable_gate_refused/);
  }
  console.log("resource-staging-live-adapter: closed entry rejects missing acknowledgement and injected authority");
})().catch((e) => { console.error(e); process.exitCode = 1; });
