// #810: batch-progress-from-REST-snapshot tests. Plain node:assert script — no
// test runner is wired up. Run with
// `node server/routes.batchProgressSnapshot.test.js`.
//
// progressFromSnapshot / countApprovedRoles / evalBatchCompleteConfirmed are
// re-exported from server/routes.js for this test. Verifies the 5 buckets
// reproduce exactly, approval count is keyed on body-marker ROLE (not login),
// `merged` requires PR-merged AND issue-CLOSED, and completeConfirmed needs two
// distinct successful cycles.

const assert = require("node:assert/strict");
const { progressFromSnapshot, countApprovedRoles, evalBatchCompleteConfirmed } = require("./routes");

// Reviews authored by the SHARED reviewer login, distinguished by body marker.
const review = (marker, state, ts) => ({ state, author: { login: "shared" }, submittedAt: ts, body: `${marker}: ${state}` });

function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // ── countApprovedRoles: per-ROLE, not per-author ──
  {
    const both = [review("RE1", "APPROVED", "2026-05-01T00:00:00Z"), review("RE2", "APPROVED", "2026-05-02T00:00:00Z")];
    ok(countApprovedRoles(both) === 2, "two roles approved via body markers (same login) → 2 (per-author would be 1)");
    ok(countApprovedRoles([review("RE1", "APPROVED", "x")]) === 1, "one role approved → 1");
    const stale = [review("RE1", "APPROVED", "2026-05-01T00:00:00Z"), review("RE1", "CHANGES_REQUESTED", "2026-05-03T00:00:00Z")];
    ok(countApprovedRoles(stale) === 0, "latest re1 review CHANGES_REQUESTED → 0 (no stale double-count)");
    ok(countApprovedRoles([review("", "APPROVED", "x")]) === 0, "marker-less review → uncounted");
  }

  // ── progressFromSnapshot: 5 buckets ──
  const snapshot = {
    issues: [
      { number: 1, title: "queued one", state: "OPEN" },
      { number: 2, title: "in review", state: "OPEN" },
      { number: 3, title: "one approval", state: "OPEN" },
      { number: 4, title: "ready", state: "OPEN" },
      { number: 7, title: "merged-but-open", state: "OPEN" },
    ],
    prs: [
      { number: 102, title: "[#2] in review", state: "OPEN", reviews: [] },
      { number: 103, title: "[#3] one", state: "OPEN", reviews: [review("RE1", "APPROVED", "x")] },
      { number: 104, title: "[#4] ready", state: "OPEN", reviews: [review("RE1", "APPROVED", "a"), review("RE2", "APPROVED", "b")] },
    ],
    closedIssues: [
      { number: 5, title: "merged one", state: "CLOSED", url: "u5" },
      { number: 6, title: "closed no pr", state: "CLOSED", url: "u6" },
    ],
    mergedPrs: [
      { number: 105, title: "[#5] merged pr", state: "MERGED", url: "u105" },
      { number: 107, title: "[#7] merged pr", state: "MERGED", url: "u107" },
    ],
  };

  {
    ok(progressFromSnapshot(snapshot, 1).status === "queued" && progressFromSnapshot(snapshot, 1).progress === 0, "open issue, no PR → queued/0");
    const r2 = progressFromSnapshot(snapshot, 2);
    ok(r2.status === "in_review" && r2.progress === 20 && r2.pr_number === 102, "open PR, 0 approvals → in_review/20");
    const r3 = progressFromSnapshot(snapshot, 3);
    ok(r3.status === "approved1" && r3.progress === 50, "open PR, 1 role approved → approved1/50");
    const r4 = progressFromSnapshot(snapshot, 4);
    ok(r4.status === "ready" && r4.progress === 80, "open PR, 2 roles approved → ready/80");
    const r5 = progressFromSnapshot(snapshot, 5);
    ok(r5.status === "merged" && r5.progress === 100 && r5.pr_number === 105, "merged PR + CLOSED issue → merged/100");
    const r6 = progressFromSnapshot(snapshot, 6);
    ok(r6.status === "closed" && r6.progress === 100, "CLOSED issue, no PR → closed/100");
  }

  // ── merged requires PR-merged AND issue-CLOSED ──
  {
    // #7 has a merged PR but its issue is still OPEN in the snapshot → NOT merged.
    const r7 = progressFromSnapshot(snapshot, 7);
    ok(r7.status !== "merged", "merged PR but issue still OPEN → NOT merged (strict rule)");
  }

  // ── cache miss → null (caller does targeted by-number fetch) ──
  {
    ok(progressFromSnapshot(snapshot, 999) === null, "issue outside the board window → null (by-number fallback)");
    ok(progressFromSnapshot(null, 1) === null, "no snapshot → null");
  }

  // ── title linking is strict [#N] (no false-positive on substring) ──
  {
    const snap = { issues: [{ number: 80, title: "x", state: "OPEN" }], prs: [{ number: 200, title: "[#807] not 80", state: "OPEN", reviews: [] }], closedIssues: [], mergedPrs: [] };
    ok(progressFromSnapshot(snap, 80).status === "queued", "#80 not linked to PR titled [#807] — no substring false-positive");
  }

  // ── evalBatchCompleteConfirmed: two distinct successful cycles ──
  {
    const p = "proj-confirm";
    ok(evalBatchCompleteConfirmed(p, true, 1000) === false, "first complete cycle → not yet confirmed");
    ok(evalBatchCompleteConfirmed(p, true, 1000) === false, "same snapshot ts re-served → still not confirmed (no new cycle)");
    ok(evalBatchCompleteConfirmed(p, true, 2000) === true, "second DISTINCT successful complete cycle → confirmed");
    ok(evalBatchCompleteConfirmed(p, true, 3000) === true, "stays confirmed across further distinct complete cycles");
  }
  {
    const p = "proj-stale";
    ok(evalBatchCompleteConfirmed(p, true, 1000) === false, "first complete → unconfirmed");
    ok(evalBatchCompleteConfirmed(p, true, null) === false, "stale/served-expired cycle (null gen) does NOT confirm");
    ok(evalBatchCompleteConfirmed(p, true, 2000) === true, "a real distinct cycle after a stale one confirms");
  }
  {
    const p = "proj-reset";
    evalBatchCompleteConfirmed(p, true, 1000);
    ok(evalBatchCompleteConfirmed(p, true, 2000) === true, "confirmed");
    ok(evalBatchCompleteConfirmed(p, false, 3000) === false, "an incomplete cycle resets confirmation");
    ok(evalBatchCompleteConfirmed(p, true, 4000) === false, "after reset, confirmation must rebuild from one cycle");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
