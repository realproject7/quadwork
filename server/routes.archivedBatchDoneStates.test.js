// #925: after a review batch is archived, the Current Batch panel must show
// each item's FINAL state (from Head's `## Done` block), not a stale snapshot
// that froze at a pre-final state. Plain node:assert script (no runner) — run
// with `node server/routes.archivedBatchDoneStates.test.js`.
//
// The bug: when the last item reaches `approved` and Head archives the batch
// BETWEEN the 30s batch-progress polls, no poll captured the final state, so
// the persisted snapshot froze at e.g. `#916 in-review (1/2)`. Once the Active
// Batch is emptied (archived), resolveDisplayedBatch serves the snapshot
// (#870 sticky display) — whose reviewItems are stale — and the panel never
// reads complete. The Done block has the authoritative final states but was
// never consulted (#870 deliberately ignores Done for progress). The fix reads
// the SINGLE Done block matching the displayed (archived) batch's number.
//
// Snapshot I/O is injected so this test never touches the real
// ~/.quadwork/{id}/batch-progress-cache.json (the running orchestrator owns it).

const assert = require("node:assert/strict");
const { resolveDisplayedBatch, parseDoneBatchReviewItems } = require("./routes");

// A realistic archived queue: Active Batch emptied, a multi-batch `## Done`
// with `**Batch:** N` markers exactly as Head writes them.
function archivedQueue() {
  return [
    "# QuadWork — Overnight Queue",
    "",
    "## Active Batch",
    "",
    "## Backlog",
    "",
    "(none)",
    "",
    "## Done",
    "",
    "**Batch:** 19",
    "**Batch type:** pr-review",
    "**Started:** 2026-06-01 07:52",
    "",
    "- #918 — approved",
    "- #916 — approved",
    "",
    "**Batch:** 18",
    "",
    "- #915 Deferred reseed only retries on server restart",
    "- #914 operator-mcp.md: operating model + never rules",
    "",
    "**Batch:** 16",
    "**Batch type:** pr-review",
    "**Started:** 2026-06-01 06:13",
    "",
    "- #906 — approved",
    "- #904 — approved",
    "",
  ].join("\n");
}

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

const isComplete = (reviewItems) =>
  reviewItems.length > 0 && reviewItems.every((r) => r.review_state === "approved");
const stateOf = (reviewItems, n) => {
  const r = reviewItems.find((x) => x.issue === n);
  return r ? r.review_state : undefined;
};

function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // ── The exact Batch 19 incident: snapshot froze with #916 at in-review (1/2)
  //    because the final approval + archive happened between polls. ──
  {
    const store = makeStore({
      batchNumber: 19,
      issueNumbers: [918, 916],
      batch_type: "pr-review",
      reviewItems: [
        { issue: 918, review_state: "approved", approvals: 2 },
        { issue: 916, review_state: "in-review", approvals: 1 }, // FROZEN pre-final
      ],
    });
    const res = resolveDisplayedBatch(archivedQueue(), "proj-925", store.opts);
    ok(res.issueNumbers.length === 2 && res.issueNumbers.includes(918) && res.issueNumbers.includes(916), "archived: sticky view keeps both issue numbers");
    ok(res.batch_type === "pr-review", "archived: batch_type stays pr-review");
    ok(stateOf(res.reviewItems, 918) === "approved", "archived: #918 approved (from Done block)");
    ok(stateOf(res.reviewItems, 916) === "approved", "archived: #916 reads FINAL approved from Done block, not the frozen in-review");
    ok(isComplete(res.reviewItems) === true, "archived: batch reads as COMPLETE (was stuck at 1/2 before the fix)");
    // Self-heal: the snapshot is re-persisted with the final states.
    ok(store.get().reviewItems.every((r) => r.review_state === "approved"), "archived: snapshot re-persisted with final approved states (self-heals next poll)");
  }

  // ── Regression guard: WITHOUT the Done-block read, this exact frozen snapshot
  //    would have served #916 = in-review and never reached complete. The Done
  //    block is the only source of #916's approved state here. ──
  {
    const frozen = makeStore({
      batchNumber: 19,
      issueNumbers: [918, 916],
      batch_type: "pr-review",
      reviewItems: [
        { issue: 918, review_state: "approved", approvals: 2 },
        { issue: 916, review_state: "in-review", approvals: 1 },
      ],
    });
    const res = resolveDisplayedBatch(archivedQueue(), "proj-925b", frozen.opts);
    ok(stateOf(res.reviewItems, 916) === "approved" && isComplete(res.reviewItems), "frozen snapshot + Done block → complete (would freeze at 1/2 without the fix)");
  }

  // ── Only the Done block matching the displayed batch number is read; other
  //    Done batches stay ignored (#870). Snapshot batchNumber 16 → reads the
  //    Batch 16 block, not Batch 19's. ──
  {
    const b16 = makeStore({
      batchNumber: 16,
      issueNumbers: [906, 904],
      batch_type: "pr-review",
      reviewItems: [
        { issue: 906, review_state: "in-review", approvals: 1 },
        { issue: 904, review_state: "queued", approvals: 0 },
      ],
    });
    const res = resolveDisplayedBatch(archivedQueue(), "proj-925c", b16.opts);
    ok(res.issueNumbers.length === 2 && res.issueNumbers.includes(906) && res.issueNumbers.includes(904), "matching-block: Batch 16 issue set preserved");
    ok(stateOf(res.reviewItems, 906) === "approved" && stateOf(res.reviewItems, 904) === "approved", "matching-block: states read from the Batch 16 Done block (both approved)");
    ok(!res.reviewItems.some((r) => r.issue === 918 || r.issue === 916), "matching-block: Batch 19's items do NOT leak into the Batch 16 display");
  }

  // ── No matching Done block (snapshot batch not in Done) → fall back to the
  //    snapshot reviewItems unchanged (graceful — never invents states). ──
  {
    const orphan = makeStore({
      batchNumber: 99,
      issueNumbers: [700],
      batch_type: "pr-review",
      reviewItems: [{ issue: 700, review_state: "in-review", approvals: 1 }],
    });
    const res = resolveDisplayedBatch(archivedQueue(), "proj-925d", orphan.opts);
    ok(stateOf(res.reviewItems, 700) === "in-review", "no-match: snapshot reviewItems preserved when no Done block matches (no fabricated state)");
  }

  // ── Code-batch no-regression: an archived CODE batch's Done block carries no
  //    state annotations (and no `**Batch type:**`) → parsed as "code" → the
  //    #925 override is skipped; batch_type stays code, reviewItems stays []. ──
  {
    const codeStore = makeStore({ batchNumber: 18, issueNumbers: [915, 914], batch_type: "code", reviewItems: [] });
    const res = resolveDisplayedBatch(archivedQueue(), "proj-925e", codeStore.opts);
    ok(res.batch_type === "code", "code batch: batch_type stays code (uses the GitHub-derived path, not reviewItems)");
    ok(res.reviewItems.length === 0, "code batch: reviewItems stays [] (Done-block override not applied to code batches)");
    ok(res.issueNumbers.length === 2 && res.issueNumbers.includes(915) && res.issueNumbers.includes(914), "code batch: Done-moved issue set still sticky-visible");
  }

  // ── parseDoneBatchReviewItems unit checks ──
  {
    const q = archivedQueue();
    const b19 = parseDoneBatchReviewItems(q, 19);
    ok(b19 && b19.batch_type === "pr-review" && b19.reviewItems.length === 2, "parse: Batch 19 block → pr-review, 2 items");
    ok(b19.reviewItems.every((r) => r.review_state === "approved"), "parse: Batch 19 items both approved");
    const b18 = parseDoneBatchReviewItems(q, 18);
    ok(b18 && b18.batch_type === "code" && b18.reviewItems.length === 2, "parse: Batch 18 (code) block → code, 2 items, states default queued");
    ok(b18.reviewItems.every((r) => r.review_state === "queued"), "parse: Batch 18 code lines have no annotation → queued");
    ok(parseDoneBatchReviewItems(q, 99) === null, "parse: missing batch number → null");
    ok(parseDoneBatchReviewItems(q, null) === null, "parse: non-integer batch number → null");
    ok(parseDoneBatchReviewItems("", 19) === null, "parse: empty queue → null");
    // Isolation: the Batch 16 block must NOT bleed Batch 18's lines or vice versa.
    const b16 = parseDoneBatchReviewItems(q, 16);
    ok(b16 && b16.reviewItems.length === 2 && b16.reviewItems.every((r) => r.issue === 906 || r.issue === 904), "parse: Batch 16 block isolated to its own two items");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
