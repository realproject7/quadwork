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
const { progressFromSnapshot, countApprovedRoles, evalBatchCompleteConfirmed, buildNoPrRow } = require("./routes");

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
    // PR-backed buckets the snapshot CAN prove (matching in-window PR):
    const r2 = progressFromSnapshot(snapshot, 2);
    ok(r2.status === "in_review" && r2.progress === 20 && r2.pr_number === 102, "open PR, 0 approvals → in_review/20");
    const r3 = progressFromSnapshot(snapshot, 3);
    ok(r3.status === "approved1" && r3.progress === 50, "open PR, 1 role approved → approved1/50");
    const r4 = progressFromSnapshot(snapshot, 4);
    ok(r4.status === "ready" && r4.progress === 80, "open PR, 2 roles approved → ready/80");
    const r5 = progressFromSnapshot(snapshot, 5);
    ok(r5.status === "merged" && r5.progress === 100 && r5.pr_number === 105, "merged PR + CLOSED issue → merged/100");
  }

  // ── queued / closed buckets come from buildNoPrRow on the by-number path ──
  // (progressFromSnapshot never guesses these — see the null cases below).
  {
    ok(buildNoPrRow({ number: 1, title: "q", state: "OPEN" }).status === "queued", "buildNoPrRow OPEN → queued/0");
    ok(buildNoPrRow({ number: 1, title: "q", state: "OPEN" }).progress === 0, "queued is 0%");
    ok(buildNoPrRow({ number: 6, title: "c", state: "CLOSED" }).status === "closed", "buildNoPrRow CLOSED → closed/100");
    ok(buildNoPrRow({ number: 6, title: "c", state: "CLOSED" }).progress === 100, "closed is 100%");
  }

  // ── merged requires PR-merged AND issue-CLOSED ──
  {
    // #7 has a merged PR in-window but its issue is still OPEN → NOT merged, and
    // since no OPEN PR matches, the snapshot can't prove the state → null.
    ok(progressFromSnapshot(snapshot, 7) === null, "merged PR but issue still OPEN → null (by-number resolves it)");
  }

  // ── re1 regression: issue PRESENT in snapshot but its PR is OUTSIDE the
  //    window → null, so the route runs the authoritative by-number fetch
  //    (must NEVER under-report a real in_review/ready/merged item as queued).
  //    Window completeness is UNKNOWN on this fixture (no openPrsWindowComplete
  //    flag → treated as possibly-truncated). ──
  {
    ok(progressFromSnapshot(snapshot, 1) === null, "open issue in snapshot, no in-window PR, window unknown → null (NOT queued — PR may be out of window)");
    ok(progressFromSnapshot(snapshot, 6) === null, "closed issue in snapshot, no in-window PR → null (by-number confirms merged-vs-closed)");
  }

  // ── #828 P1: queued classified from the snapshot ONLY when the open-PR
  //    window is provably complete (openPrsWindowComplete) — and NEVER when it
  //    may be truncated. No GraphQL/network in either case. ──
  {
    const complete = { ...snapshot, openPrsWindowComplete: true };
    const r1 = progressFromSnapshot(complete, 1);
    ok(r1 && r1.status === "queued" && r1.progress === 0, "window complete + OPEN issue + no matching PR → queued/0 (no by-number fetch)");
    ok(r1 && r1.issue_number === 1 && r1.title === "queued one", "queued row carries the snapshot issue's number + title");
    // Truncated/unknown window must NOT guess queued — falls through to null.
    ok(progressFromSnapshot({ ...snapshot, openPrsWindowComplete: false }, 1) === null, "window NOT complete → null even for an OPEN no-PR issue (by-number fallback)");
    // A matching in-window PR still wins over the queued shortcut.
    ok(progressFromSnapshot(complete, 2).status === "in_review", "window complete but a matching open PR exists → in_review (PR proof wins)");
    // merged-but-open edge: matching merged PR in-window + issue OPEN → still
    // null (NOT queued) so by-number resolves the merged-vs-in_review state.
    ok(progressFromSnapshot(complete, 7) === null, "window complete + merged PR in-window but issue OPEN → null (merged-but-open edge, not queued)");
    // CLOSED issue with no in-window PR → null even when window complete
    // (open-PR completeness says nothing about merged-out-of-window).
    ok(progressFromSnapshot(complete, 6) === null, "window complete + CLOSED issue + no in-window PR → null (closed-no-PR vs merged-out-of-window needs by-number)");
    // Issue absent from the snapshot entirely → null regardless of the flag.
    ok(progressFromSnapshot(complete, 999) === null, "window complete but issue absent from snapshot → null (by-number fallback)");
  }

  // ── cache miss → null (caller does targeted by-number fetch) ──
  {
    ok(progressFromSnapshot(snapshot, 999) === null, "issue outside the board window → null (by-number fallback)");
    ok(progressFromSnapshot(null, 1) === null, "no snapshot → null");
  }

  // ── title linking is strict [#N] (no false-positive on substring) ──
  {
    const snap = { issues: [{ number: 80, title: "x", state: "OPEN" }], prs: [{ number: 200, title: "[#807] not 80", state: "OPEN", reviews: [] }], closedIssues: [], mergedPrs: [] };
    ok(progressFromSnapshot(snap, 80) === null, "#80 not linked to PR titled [#807] (no substring match) → null, not a false in_review");
  }

  // ── evalBatchCompleteConfirmed: two distinct successful cycles (#828 P2:
  //    now keyed by projectId + batchKey) ──
  {
    const p = "proj-confirm", b = "7::824,828";
    ok(evalBatchCompleteConfirmed(p, b, true, 1000) === false, "first complete cycle → not yet confirmed");
    ok(evalBatchCompleteConfirmed(p, b, true, 1000) === false, "same snapshot ts re-served → still not confirmed (no new cycle)");
    ok(evalBatchCompleteConfirmed(p, b, true, 2000) === true, "second DISTINCT successful complete cycle → confirmed");
    ok(evalBatchCompleteConfirmed(p, b, true, 3000) === true, "stays confirmed across further distinct complete cycles");
  }
  {
    const p = "proj-stale", b = "7::824";
    ok(evalBatchCompleteConfirmed(p, b, true, 1000) === false, "first complete → unconfirmed");
    ok(evalBatchCompleteConfirmed(p, b, true, null) === false, "stale/served-expired cycle (null gen) does NOT confirm");
    ok(evalBatchCompleteConfirmed(p, b, true, 2000) === true, "a real distinct cycle after a stale one confirms");
  }
  {
    const p = "proj-reset", b = "7::824";
    evalBatchCompleteConfirmed(p, b, true, 1000);
    ok(evalBatchCompleteConfirmed(p, b, true, 2000) === true, "confirmed");
    ok(evalBatchCompleteConfirmed(p, b, false, 3000) === false, "an incomplete cycle resets confirmation");
    ok(evalBatchCompleteConfirmed(p, b, true, 4000) === false, "after reset, confirmation must rebuild from one cycle");
  }

  // ── #828 P2: confirmation is BATCH-scoped — a new already-complete batch
  //    must NOT inherit the prior batch's streak and confirm in one tick. ──
  {
    const p = "proj-batchscope";
    // Batch A confirms complete over two distinct cycles.
    ok(evalBatchCompleteConfirmed(p, "7::824,828", true, 1000) === false, "batch A: first complete cycle → unconfirmed");
    ok(evalBatchCompleteConfirmed(p, "7::824,828", true, 2000) === true, "batch A: second distinct cycle → confirmed");
    // Batch B is complete on its FIRST observation, no intervening incomplete.
    // Different batchKey → fresh streak → must NOT confirm yet (the bug: it
    // would inherit A's cycle and auto-stop prematurely).
    ok(evalBatchCompleteConfirmed(p, "8::830,831", true, 3000) === false, "batch B (new identity) complete on first sight → NOT confirmed (no inheritance)");
    ok(evalBatchCompleteConfirmed(p, "8::830,831", true, 4000) === true, "batch B confirms only after its OWN second distinct cycle");
  }
  {
    // Same batch number but a DIFFERENT issue set is a different identity too.
    const p = "proj-issueset";
    ok(evalBatchCompleteConfirmed(p, "9::900", true, 1000) === false, "issue-set X: first cycle unconfirmed");
    ok(evalBatchCompleteConfirmed(p, "9::900", true, 2000) === true, "issue-set X: confirmed");
    ok(evalBatchCompleteConfirmed(p, "9::901", true, 3000) === false, "same batch number, changed issue set → identity change → streak resets");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
