"use strict";

// Only the monotonic clock dependency is controlled. The actual scheduling
// helper runs asynchronous predicates; no staging or resource PASS is minted.
const assert = require("node:assert/strict");
const Module = require("node:module");
const modulePath = require.resolve("./resource-pressure-deadline");
let now = 0;
const originalLoad = Module._load;
Module._load = function (request, parent, main) {
  if (parent?.filename === modulePath && request === "node:perf_hooks") return { performance: { now: () => now } };
  return originalLoad.call(this, request, parent, main);
};
const { createPressureObservationWindow } = require(modulePath);
Module._load = originalLoad;
const healthy = () => null;
const expired = (e) => e.check === "pressure_observation_timeout";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let window = createPressureObservationWindow();
  assert.equal(await window.waitFor(async () => { now = 4000; return "full dispatch"; }, healthy), "full dispatch", "dispatch after the old3s cutoff can still be observed");
  assert.equal(await window.waitFor(async () => { now = 44999; return "independent OOM"; }, healthy), "independent OOM");
  assert.equal(window.elapsedMs(), 44999);
  let called = false; now = 45000;
  await assert.rejects(window.waitFor(() => { called = true; return true; }, healthy), expired);
  assert.equal(called, false, "an already-true observation after expiration is never executed");
  assert.throws(() => window.assertCurrent(healthy), expired, "release cannot start at the deadline");
  now = 0; window = createPressureObservationWindow();
  window.assertCurrent(healthy);
  assert.throws(() => window.assertCurrent(() => "continuous_monitor_failed"), (e) => e.check === "continuous_monitor_failed", "release rechecks monitor abort");

  now = 0; window = createPressureObservationWindow();
  await window.waitFor(() => { now = 40000; return true; }, healthy);
  await assert.rejects(window.waitFor(async () => { await Promise.resolve(); now = 45000; return true; }, healthy), expired, "second wait has only5s remaining, including async read time");
  assert.equal(window.elapsedMs(), 45000);

  now = 0; window = createPressureObservationWindow();
  await assert.rejects(window.waitFor(() => { now = 45001; return true; }, healthy), expired, "synchronous predicates are checked again too");
  now = 0; window = createPressureObservationWindow();
  const originalWallClock = Date.now; Date.now = () => -9000000000000;
  try { now = 1000; assert.equal(await window.waitFor(() => true, healthy), true); assert.equal(window.elapsedMs(), 1000); }
  finally { Date.now = originalWallClock; }

  now = 0; window = createPressureObservationWindow();
  const stalled = window.waitFor(() => new Promise(() => {}), healthy);
  await pause(1); now = 45000;
  await assert.rejects(stalled, expired, "a never-settling predicate cannot extend the deadline");

  now = 0; window = createPressureObservationWindow();
  let monitorFailure = null, cleanupReleased, cleanupEntered, completed = false;
  const cleanupGate = new Promise((resolve) => { cleanupReleased = resolve; });
  const cleanupStarted = new Promise((resolve) => { cleanupEntered = resolve; });
  const operation = (async () => {
    try { await window.waitFor(() => new Promise(() => {}), () => monitorFailure); }
    finally { cleanupEntered(); await cleanupGate; completed = true; }
  })();
  // The caller owns cleanup. Observation abort must neither swallow its cause
  // nor finish the caller before that owned cleanup has actually completed.
  const rejection = assert.rejects(operation, (e) => e.check === "continuous_monitor_failed");
  await pause(1); monitorFailure = "continuous_monitor_failed";
  await cleanupStarted; assert.equal(completed, false); cleanupReleased(); await rejection; assert.equal(completed, true);

  now = 0; window = createPressureObservationWindow();
  let originalError; try { await window.waitFor(() => Promise.reject(0), healthy); } catch (e) { originalError = e; }
  assert.equal(originalError, 0, "falsey asynchronous rejection is not converted into a retry");
  console.log("resource-pressure-deadline: late dispatch, shared remainder, before/after-read expiry, monotonic clock and awaited abort cleanup passed");
})().catch((e) => { console.error(e); process.exitCode = 1; });
