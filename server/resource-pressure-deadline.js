"use strict";

const { performance } = require("node:perf_hooks");
const { setTimeout: wait } = require("node:timers/promises");
const { fail } = require("./resource-linux-facts");

// Scheduling only: this cannot validate a workload, OOM or runtime readiness.
// The closed coordinator supplies its own observations and monitor state.
function createPressureObservationWindow() {
  const started = performance.now(), deadline = started + 45000;
  function remaining(readFailure) {
    const failure = readFailure();
    if (failure) fail(failure);
    const left = deadline - performance.now();
    if (left <= 0) fail("pressure_observation_timeout");
    return left;
  }
  return Object.freeze({
    elapsedMs: () => Math.round(performance.now() - started),
    assertCurrent: (readFailure) => { remaining(readFailure); },
    async waitFor(read, readFailure) {
      for (;;) {
        remaining(readFailure); // Never start a read after expiration/abort.
        let settled = false, rejected = false, result;
        const observation = Promise.resolve().then(read).then(
          (value) => { result = value; settled = true; },
          (error) => { result = error; rejected = true; settled = true; },
        );
        while (!settled) {
          // A slow asynchronous read must not defer the deadline or monitor
          // abort. Its eventual rejection stays observed after this wait ends.
          const left = remaining(readFailure);
          await Promise.race([observation, wait(Math.min(25, left))]);
        }
        remaining(readFailure); // A late true result is still too late.
        if (rejected) throw result;
        if (result) return result;
        await wait(Math.min(25, remaining(readFailure)));
      }
    },
  });
}
module.exports = { createPressureObservationWindow };
