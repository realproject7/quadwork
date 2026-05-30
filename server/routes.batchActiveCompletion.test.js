// #839 regression: /api/batch-active must drop to active:false once a batch
// is complete, even if Head leaves a parked/blocked ticket in the
// `## Active Batch` section. The route now derives `active` from the cached
// /api/batch-progress payload via isBatchActiveFromProgress(progress), so the
// sidebar heartbeat agrees with the Current Batch panel. Plain node:assert
// script — run with `node server/routes.batchActiveCompletion.test.js`.

const { isBatchActiveFromProgress } = require("./routes");

function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // 1) No progress payload → null sentinel so the caller falls back to the
  //    cheap file-only branch (a project whose batch-progress has never run).
  ok(isBatchActiveFromProgress(null) === null, "null progress → null (caller should fall back to file-only)");
  ok(isBatchActiveFromProgress(undefined) === null, "undefined progress → null");

  // 2) Empty items list → not active. Covers the empty-state branch in
  //    /api/batch-progress (issueNumbers.length === 0 → items:[]) and idle
  //    projects' cached empty payload.
  ok(isBatchActiveFromProgress({ items: [], complete: false }) === false, "no items, not complete → not active");
  ok(isBatchActiveFromProgress({ items: [], complete: true }) === false, "no items, complete → not active");
  ok(isBatchActiveFromProgress({ complete: false }) === false, "missing items field → not active (treated as [])");

  // 3) In-progress batch (items present, not complete) → active. The endpoint
  //    must still pulse for genuinely in-progress batches.
  ok(isBatchActiveFromProgress({ items: [{ status: "in_review" }], complete: false }) === true, "one in-review item, not complete → active");
  ok(isBatchActiveFromProgress({ items: [{ status: "merged" }, { status: "queued" }], complete: false }) === true, "mix of merged + queued, complete:false → active");

  // 4) Completed batch (items present, complete:true) → NOT active. This is
  //    the exact bug from #839 — heartbeat must stop here even though the
  //    `## Active Batch` section still lists issues.
  ok(isBatchActiveFromProgress({ items: [{ status: "merged" }], complete: true }) === false, "single merged item, complete → NOT active (the #839 bug fix)");
  ok(isBatchActiveFromProgress({ items: [{ status: "merged" }, { status: "closed" }, { status: "merged" }], complete: true }) === false, "multiple merged/closed items, complete → NOT active");

  // 5) Defensive: completeConfirmed is irrelevant to this decision (use the
  //    immediate `complete` per the issue spec). A completeConfirmed:false
  //    on a complete batch should still stop the pulse.
  ok(isBatchActiveFromProgress({ items: [{ status: "merged" }], complete: true, completeConfirmed: false }) === false, "complete:true overrides completeConfirmed:false — pulse stops on the immediate observation");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
