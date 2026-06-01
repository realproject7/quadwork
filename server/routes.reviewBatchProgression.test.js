// #899: review-batch progress must NOT freeze at the snapshot's first-seen
// states. Plain node:assert script (no runner) — run with
// `node server/routes.reviewBatchProgression.test.js`.
//
// Regression for the P1 found via the #874 local dogfood: when a review batch's
// items progress in place (queued → in-review → approved) WITHOUT a batch-number
// bump or a changed issue set, pickDisplayedSource returns "snapshot", and the
// resolver used to serve — and re-persist — the stale snapshot reviewItems every
// cycle, so the progress bar froze and never reached complete. The fix refreshes
// batch_type + reviewItems from the LIVE queue whenever the Active Batch is still
// present, while keeping the snapshot authoritative only once it's cleared
// (archived). Snapshot I/O is injected so this test never touches the real
// ~/.quadwork/{id}/batch-progress-cache.json (the running orchestrator owns it).

const assert = require("node:assert/strict");
const { resolveDisplayedBatch, pickDisplayedSource } = require("./routes");

// Build a review-batch OVERNIGHT-QUEUE.md with the given per-item states.
// `states` is an array of [issueNumber, stateAnnotation] pairs. Pass
// `cleared:true` to model the Active Batch being archived (section emptied).
function reviewQueue(states, { batchNumber = 61, cleared = false } = {}) {
  if (cleared) {
    return [
      "# OVERNIGHT-QUEUE",
      "",
      "## Active Batch",
      "",
      "## Done",
      ...states.map(([n]) => `- #${n} — approved (archived)`),
      "",
    ].join("\n");
  }
  return [
    "# OVERNIGHT-QUEUE",
    "",
    "## Active Batch",
    `**Batch:** ${batchNumber}`,
    "**Batch type:** ticket-review",
    ...states.map(([n, s]) => `- #${n} — ${s}`),
    "",
    "## Done",
    "",
  ].join("\n");
}

// Mirror the route's review-batch completion rule (routes.js getOrComputeBatchProgress,
// `complete = ri.length > 0 && ri.every(r => r.review_state === "approved")`).
const isComplete = (reviewItems) =>
  reviewItems.length > 0 && reviewItems.every((r) => r.review_state === "approved");
const stateOf = (reviewItems, n) => {
  const r = reviewItems.find((x) => x.issue === n);
  return r ? r.review_state : undefined;
};

// In-memory snapshot store wired into resolveDisplayedBatch via injection.
function makeStore(initial) {
  let stored = initial;
  return {
    opts: {
      _readSnapshot: () => stored,
      _writeSnapshot: (_pid, snap) => { stored = snap; },
    },
    get: () => stored,
  };
}

function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  const ISSUES = [836, 850, 851, 855];

  // ── Sanity: pickDisplayedSource returns "snapshot" for in-place progression ──
  // (the exact path that froze the progress bar — same batch number, same issue
  // set, only states changed).
  {
    const current = { batchNumber: 61, issueNumbers: ISSUES.slice() };
    const snapshot = { batchNumber: 61, issueNumbers: ISSUES.slice(), batch_type: "ticket-review", reviewItems: ISSUES.map((n) => ({ issue: n, review_state: "queued", approvals: 0 })) };
    ok(pickDisplayedSource(current, snapshot) === "snapshot", "in-place progression (no bump, no new items) → pickDisplayedSource picks snapshot (the frozen path)");
  }

  // ── Step 1: a STALE snapshot (all queued) is on disk; the live queue shows
  //    mixed states. The resolver must surface the LIVE states, not the snapshot's. ──
  const stale = ISSUES.map((n) => ({ issue: n, review_state: "queued", approvals: 0 }));
  const store = makeStore({ batchNumber: 61, issueNumbers: ISSUES.slice(), batch_type: "ticket-review", reviewItems: stale });

  {
    const mixed = reviewQueue([[836, "approved"], [850, "in-review (1/2)"], [851, "in-review"], [855, "queued"]]);
    const res = resolveDisplayedBatch(mixed, "proj-899", store.opts);
    ok(res.batch_type === "ticket-review", "mixed: batch_type stays ticket-review");
    ok(stateOf(res.reviewItems, 836) === "approved", "mixed: #836 reflects LIVE approved (not snapshot's queued)");
    ok(stateOf(res.reviewItems, 850) === "in-review", "mixed: #850 reflects LIVE in-review");
    ok(stateOf(res.reviewItems, 855) === "queued", "mixed: #855 still queued");
    ok(isComplete(res.reviewItems) === false, "mixed: not complete (one item still queued)");
    // The snapshot must be re-persisted with the LIVE states, not the stale ones.
    ok(stateOf(store.get().reviewItems, 836) === "approved", "mixed: snapshot rewritten with live #836=approved (no stale re-persist)");
  }

  // ── Step 2: all items → approved IN PLACE (same batch, same issue set). With a
  //    snapshot still on disk, the resolver must report all-approved + complete. ──
  {
    const allApproved = reviewQueue(ISSUES.map((n) => [n, "approved"]));
    const res = resolveDisplayedBatch(allApproved, "proj-899", store.opts);
    ok(ISSUES.every((n) => stateOf(res.reviewItems, n) === "approved"), "all-approved: every item approved from the LIVE queue");
    ok(isComplete(res.reviewItems) === true, "all-approved: reaches complete even with a persisted snapshot on disk");
    ok(store.get().reviewItems.every((r) => r.review_state === "approved"), "all-approved: snapshot now holds the FINAL approved states");
  }

  // ── Step 3: archive — Active Batch cleared. Live parse is empty, so the
  //    snapshot becomes authoritative and must show the FINAL states (all
  //    approved), NOT the first-seen ones. ──
  {
    const archived = reviewQueue(ISSUES.map((n) => [n, "approved"]), { cleared: true });
    const res = resolveDisplayedBatch(archived, "proj-899", store.opts);
    ok(res.issueNumbers.length === ISSUES.length, "archive: snapshot keeps the full issue set visible (sticky view)");
    ok(res.batch_type === "ticket-review", "archive: snapshot keeps ticket-review type (no GitHub, never reinterpreted as code)");
    ok(res.reviewItems.length === ISSUES.length && res.reviewItems.every((r) => r.review_state === "approved"), "archive: sticky view shows FINAL approved states, not first-seen");
    ok(isComplete(res.reviewItems) === true, "archive: still complete");
  }

  // ── Regression guard: WITHOUT the live refresh, an all-approved live queue
  //    against a stale (queued) snapshot would have stayed frozen at queued.
  //    Re-run against a FRESH stale store to prove the fix, not Step-2 carryover. ──
  {
    const s2 = makeStore({ batchNumber: 61, issueNumbers: ISSUES.slice(), batch_type: "ticket-review", reviewItems: ISSUES.map((n) => ({ issue: n, review_state: "queued", approvals: 0 })) });
    const allApproved = reviewQueue(ISSUES.map((n) => [n, "approved"]));
    const res = resolveDisplayedBatch(allApproved, "proj-899b", s2.opts);
    ok(isComplete(res.reviewItems) === true, "fresh stale snapshot + all-approved live queue → complete (would freeze at queued without the fix)");
  }

  // ── re1 on #900: Done-moved review item must NOT be dropped. Snapshot holds
  //    [A, B] with A already approved; Head moves A to Done so the live Active
  //    Batch carries only B. B then progresses to approved. The merge must keep
  //    A (from the snapshot) AND refresh B (from the live queue) across the
  //    preserved issue set — both visible with final states through to archive. ──
  {
    const A = 836, B = 850;
    const dm = makeStore({
      batchNumber: 61,
      issueNumbers: [A, B],
      batch_type: "ticket-review",
      // A already approved (its last in-Active state, persisted before the move);
      // B mid-review at the time the snapshot was last written.
      reviewItems: [{ issue: A, review_state: "approved", approvals: 2 }, { issue: B, review_state: "in-review", approvals: 1 }],
    });
    // Live Active Batch: only B remains (A moved to Done), B now approved.
    const liveOnlyB = reviewQueue([[B, "approved"]]);
    const res = resolveDisplayedBatch(liveOnlyB, "proj-dm", dm.opts);
    ok(res.issueNumbers.length === 2 && res.issueNumbers.includes(A) && res.issueNumbers.includes(B), "done-moved: snapshot keeps BOTH issue numbers (A moved to Done, B live)");
    ok(res.reviewItems.length === 2, "done-moved: reviewItems still covers both A and B (not just the live line)");
    ok(stateOf(res.reviewItems, A) === "approved", "done-moved: A keeps its snapshot-preserved approved state (not dropped)");
    ok(stateOf(res.reviewItems, B) === "approved", "done-moved: B refreshed to its LIVE approved state");
    ok(isComplete(res.reviewItems) === true, "done-moved: complete reflects BOTH items approved (2/2, not 1/1)");
    ok(stateOf(dm.get().reviewItems, A) === "approved", "done-moved: snapshot re-persists A's approved state for the next cycle");

    // Now archive: Active Batch cleared. Sticky view must still show A AND B, both approved.
    const archived = reviewQueue([[A], [B]], { cleared: true });
    const arch = resolveDisplayedBatch(archived, "proj-dm", dm.opts);
    ok(arch.reviewItems.length === 2 && stateOf(arch.reviewItems, A) === "approved" && stateOf(arch.reviewItems, B) === "approved", "done-moved → archive: sticky view shows BOTH A and B with final approved states");
    ok(isComplete(arch.reviewItems) === true, "done-moved → archive: still complete (2/2)");
  }

  // ── Code-batch no-regression: snapshot stickiness still preserves items Head
  //    moved to Done (issueNumbers from the snapshot), and the live refresh is a
  //    no-op (batch_type "code", reviewItems []) for a code queue. ──
  {
    // Live Active Batch has 2 of the 4 (the other 2 moved to Done); snapshot has all 4.
    const codeQueue = [
      "# OVERNIGHT-QUEUE",
      "",
      "## Active Batch",
      "**Batch:** 60",
      "- #901 implement X",
      "- #902 implement Y",
      "",
      "## Done",
      "- #899 done",
      "- #900 done",
      "",
    ].join("\n");
    const cs = makeStore({ batchNumber: 60, issueNumbers: [899, 900, 901, 902], batch_type: "code", reviewItems: [] });
    const res = resolveDisplayedBatch(codeQueue, "proj-code", cs.opts);
    ok(res.batch_type === "code", "code batch: batch_type stays code (so the route uses the GitHub-derived path, never the reviewItems block)");
    ok(res.issueNumbers.length === 4 && [899, 900, 901, 902].every((n) => res.issueNumbers.includes(n)), "code batch: Done-moved items stay visible via the snapshot issue set (#316/#429 preserved)");
    // reviewItems is irrelevant for code batches — getOrComputeBatchProgress only
    // consults it when batch_type is ticket-review/pr-review. The parse mirrors
    // what the existing "live" branch already produces, so there's no behavior
    // change on the code path (state is fetched from GitHub on issueNumbers).
  }

  // ── Unreadable queue → empty state (the #316 bypass must still win). ──
  {
    const cs = makeStore({ batchNumber: 60, issueNumbers: [1, 2], batch_type: "ticket-review", reviewItems: [{ issue: 1, review_state: "approved", approvals: 2 }] });
    const res = resolveDisplayedBatch("", "proj-x", { ...cs.opts, queueReadOk: false });
    ok(res.issueNumbers.length === 0 && res.batch_type === "code" && res.reviewItems.length === 0, "queueReadOk=false → empty state, snapshot NOT healed into stale data");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
