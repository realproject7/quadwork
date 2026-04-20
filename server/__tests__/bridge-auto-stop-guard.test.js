/**
 * #542 — Verify bridge auto-stop fires only on the transition from
 * incomplete → complete, not on every polling tick.
 *
 * Since autoStopPollingTick is tightly coupled to HTTP calls, we test
 * the guard logic by reading server/index.js and verifying the code
 * structure, then simulating the guard in isolation.
 */

const fs = require("fs");
const path = require("path");

const SERVER_PATH = path.join(__dirname, "..", "index.js");
const src = fs.readFileSync(SERVER_PATH, "utf-8");

// ---------------------------------------------------------------------------
// 1. Code-structure assertions — verify the guard exists in source
// ---------------------------------------------------------------------------

describe("#542 bridge auto-stop transition guard (code analysis)", () => {
  test("autoStopBridges in polling path is guarded by prev.complete check", () => {
    // Find the autoStopPollingTick function body
    const fnStart = src.indexOf("async function autoStopPollingTick()");
    expect(fnStart).toBeGreaterThan(-1);

    // Extract the function body (up to the next top-level function or setInterval)
    const fnBody = src.slice(fnStart, src.indexOf("setInterval(autoStopPollingTick"));

    // The autoStopBridges call must be guarded by a prev.complete check
    const stopIdx = fnBody.indexOf("autoStopBridges(project.id");
    expect(stopIdx).toBeGreaterThan(-1);

    // Look at the surrounding context — the guard should appear before the call
    const guardRegion = fnBody.slice(Math.max(0, stopIdx - 200), stopIdx);
    expect(guardRegion).toMatch(/!prev\.complete/);
  });

  test("autoStartBridges in polling path is still transition-guarded", () => {
    const fnStart = src.indexOf("async function autoStopPollingTick()");
    const fnBody = src.slice(fnStart, src.indexOf("setInterval(autoStopPollingTick"));
    const startIdx = fnBody.indexOf("autoStartBridges(");
    expect(startIdx).toBeGreaterThan(-1);

    const guardRegion = fnBody.slice(Math.max(0, startIdx - 200), startIdx);
    expect(guardRegion).toMatch(/isNewBatch/);
  });

  test("_bridgeBatchPrev.set is called before the guard checks", () => {
    const fnStart = src.indexOf("async function autoStopPollingTick()");
    const fnBody = src.slice(fnStart, src.indexOf("setInterval(autoStopPollingTick"));

    const setIdx = fnBody.indexOf("_bridgeBatchPrev.set(");
    const stopIdx = fnBody.indexOf("autoStopBridges(project.id");
    expect(setIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(stopIdx);
  });

  test("autoStopBridges in sendTriggerMessage is guarded by prev.complete check", () => {
    const fnStart = src.indexOf("async function sendTriggerMessage(");
    expect(fnStart).toBeGreaterThan(-1);

    // Extract until the next top-level function
    const fnBody = src.slice(fnStart, fnStart + 2000);

    const stopIdx = fnBody.indexOf("autoStopBridges(");
    expect(stopIdx).toBeGreaterThan(-1);

    // The guard should appear before the call
    const guardRegion = fnBody.slice(Math.max(0, stopIdx - 300), stopIdx);
    expect(guardRegion).toMatch(/!prev\.complete/);
  });

  test("sendTriggerMessage updates _bridgeBatchPrev before the guard", () => {
    const fnStart = src.indexOf("async function sendTriggerMessage(");
    const fnBody = src.slice(fnStart, fnStart + 2000);

    const setIdx = fnBody.indexOf("_bridgeBatchPrev.set(");
    const stopIdx = fnBody.indexOf("autoStopBridges(");
    expect(setIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(stopIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. Guard-logic simulation — mirrors the if-condition in autoStopPollingTick
// ---------------------------------------------------------------------------

describe("#542 bridge auto-stop transition guard (logic simulation)", () => {
  function shouldAutoStop(bp, prev) {
    // Mirrors the production guard:
    //   if (hasBridgeAuto && (!prev || !prev.complete)) { autoStopBridges(...) }
    if (!(bp && bp.complete)) return false;
    return !prev || !prev.complete;
  }

  test("fires on first tick when batch is already complete (no prev)", () => {
    expect(shouldAutoStop({ complete: true }, undefined)).toBe(true);
  });

  test("fires on transition from incomplete to complete", () => {
    expect(shouldAutoStop({ complete: true }, { complete: false, hasItems: true })).toBe(true);
  });

  test("does NOT fire on repeated complete ticks", () => {
    expect(shouldAutoStop({ complete: true }, { complete: true, hasItems: true })).toBe(false);
  });

  test("does NOT fire when batch is not complete", () => {
    expect(shouldAutoStop({ complete: false }, undefined)).toBe(false);
    expect(shouldAutoStop({ complete: false }, { complete: false })).toBe(false);
  });

  test("manually restarted bridges survive repeated complete ticks", () => {
    // Simulates: batch completes → tick 1 stops bridges → operator restarts →
    // tick 2 should NOT stop again because prev.complete is already true
    const tick1 = shouldAutoStop({ complete: true }, undefined);
    expect(tick1).toBe(true); // first transition fires

    // After tick 1, prev = { complete: true }
    const tick2 = shouldAutoStop({ complete: true }, { complete: true });
    expect(tick2).toBe(false); // no repeated stop
  });

  test("auto-stop fires again for a new batch cycle", () => {
    // batch 1 completes → new batch starts → new batch completes
    const batch1Complete = shouldAutoStop({ complete: true }, { complete: false });
    expect(batch1Complete).toBe(true);

    // new batch is in progress (prev was complete from batch 1)
    // then new batch completes
    const batch2Complete = shouldAutoStop({ complete: true }, { complete: false });
    expect(batch2Complete).toBe(true);
  });
});
