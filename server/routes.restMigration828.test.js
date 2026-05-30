// #828 (#810/#806 follow-up): REST migration gap fixes. Plain node:assert
// script — no test runner is wired up. Run with
// `node server/routes.restMigration828.test.js`.
//
// Covers:
//  P1 — REST/Search linked-PR picker (strict [#N], no GraphQL in the path).
//  P3 — merged-PR pagination: gather closed pages until ≥5 merged / cap, and
//       select the latest 5 merged across pages regardless of intervening
//       closed-unmerged PRs.
// (P1 queued-from-complete-window + truncated→null and P2 batch-scoped
//  completeConfirmed live in routes.batchProgressSnapshot.test.js.)

const fs = require("fs");
const path = require("path");
const {
  pickLinkedPrFromSearch,
  findLinkedPrByTitle,
  gatherClosedPrPages,
  selectRecentMergedPrs,
  closedPagesComplete,
  closedPrIssueNumsFromPages,
} = require("./routes");

const page = (data) => ({ status: "ok", data });
const closedPr = (number, mergedAt) => ({ number, title: `pr ${number}`, html_url: `u${number}`, merged_at: mergedAt, user: { login: "x" } });
const unmergedPr = (number) => ({ number, title: `pr ${number}`, html_url: `u${number}`, merged_at: null });

async function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // ── P1: pickLinkedPrFromSearch — strict [#N], freshest wins ──
  {
    const items = [
      { number: 200, title: "[#807] not eighty" },     // loose search hit, must be rejected for n=80
      { number: 210, title: "[#80] real one" },
      { number: 215, title: "[#80] newer one" },
      { number: 99, title: "Fix [#80] mid-title" },     // [#80] not at start → rejected
    ];
    ok(pickLinkedPrFromSearch(items, 80) === 215, "strict [#80] at title start, freshest (highest #) wins; [#807] + mid-title rejected");
    ok(pickLinkedPrFromSearch([{ number: 1, title: "[#807] x" }], 80) === null, "only a [#807] hit for n=80 → null (no false substring match)");
    ok(pickLinkedPrFromSearch([], 80) === null, "no items → null");
    ok(pickLinkedPrFromSearch(null, 80) === null, "non-array → null");
    ok(pickLinkedPrFromSearch([{ number: 5, title: "  [#42] leading ws" }], 42) === 5, "leading whitespace before [#N] still matches");
  }

  // ── #864: duplicate strict [#N] matches — prefer the MERGED one over a later
  //    closed-unmerged duplicate ONLY for CLOSED issues. RE1 review: applying
  //    merged-first globally would let an older merged PR beat a newer active
  //    duplicate / reopen PR on an OPEN issue. The picker now takes the
  //    calling issue's state so the merged-preference is scoped to the only
  //    shape it's needed for (closed-and-done with a stale duplicate).
  //    Concrete CLOSED shape: issue #836 closed, merged PR #850, later
  //    closed-unmerged duplicate PR #851 with the same `[#836]` title prefix.
  {
    const items = [
      { number: 850, title: "[#836] real fix", pull_request: { merged_at: "2026-05-20T10:00:00Z" } },
      { number: 851, title: "[#836] duplicate", pull_request: { merged_at: null } },
    ];
    ok(pickLinkedPrFromSearch(items, 836, { issueState: "CLOSED" }) === 850, "CLOSED issue: merged PR #850 wins over later closed-unmerged duplicate #851 (#864)");
    // Reversed input order: merged should still win regardless of search-result ordering.
    ok(pickLinkedPrFromSearch([...items].reverse(), 836, { issueState: "CLOSED" }) === 850, "CLOSED issue: merged-preferred selection is order-independent");
    // Multiple merged + multiple unmerged on a CLOSED issue → among merged, highest # still wins.
    const multi = [
      { number: 700, title: "[#42] old merge", pull_request: { merged_at: "2026-01-01T00:00:00Z" } },
      { number: 705, title: "[#42] newer merge", pull_request: { merged_at: "2026-02-01T00:00:00Z" } },
      { number: 800, title: "[#42] later dup",  pull_request: { merged_at: null } },
    ];
    ok(pickLinkedPrFromSearch(multi, 42, { issueState: "CLOSED" }) === 705, "CLOSED issue: among merged matches, highest PR number still wins; unmerged duplicate ignored");
    // Zero merged matches on a CLOSED issue → fall back to highest-PR-number across all matches.
    const noMerged = [
      { number: 300, title: "[#9] open", pull_request: { merged_at: null } },
      { number: 305, title: "[#9] newer open", pull_request: { merged_at: null } },
    ];
    ok(pickLinkedPrFromSearch(noMerged, 9, { issueState: "CLOSED" }) === 305, "CLOSED issue: no merged candidates → freshest (highest #) wins (legacy fallback)");
    // Items without `pull_request` (defensive) treated as not-merged.
    const noPrShape = [
      { number: 500, title: "[#5] missing pr field" },
      { number: 510, title: "[#5] also missing" },
    ];
    ok(pickLinkedPrFromSearch(noPrShape, 5, { issueState: "CLOSED" }) === 510, "CLOSED issue: missing pull_request field treated as not-merged → falls back to highest #");

    // ── #864/RE1: OPEN issue with an older merged PR + newer active duplicate
    //    (e.g. a reopened issue where someone is finishing the work in a new
    //    PR). The picker MUST keep legacy freshest-wins so the active PR's
    //    in_review/approval status surfaces, not the stale merged PR's data.
    //    Without this gate, progressForItemRest would pick the merged PR,
    //    skip the `merged && CLOSED` branch (issue is OPEN), and fall through
    //    to in_review with the WRONG PR's review data.
    const openWithStaleMerge = [
      { number: 850, title: "[#836] old, merged then reopened", pull_request: { merged_at: "2026-05-20T10:00:00Z" } },
      { number: 870, title: "[#836] new active fix",            pull_request: { merged_at: null } },
    ];
    ok(pickLinkedPrFromSearch(openWithStaleMerge, 836, { issueState: "OPEN" }) === 870, "OPEN issue: newer active duplicate wins over older merged PR (legacy freshest-wins preserved)");
    // Default (no opts) preserves legacy back-compat for any external caller
    // that hasn't been updated to pass issueState (also exercises the test-only
    // direct callers in this file's existing P1 block).
    ok(pickLinkedPrFromSearch(openWithStaleMerge, 836) === 870, "no opts (legacy call shape): freshest-wins preserved → newer active PR (back-compat)");
  }

  // ── #828 / RE1 #830: a Search FAILURE must NOT collapse to an authoritative
  //    no-PR (which would render an out-of-window OPEN issue as queued, or a
  //    CLOSED issue with a merged PR as closed). findLinkedPrByTitle returns
  //    null ONLY on a SUCCESSFUL empty search; on failure it THROWS so the
  //    caller drops the item to the non-authoritative "fetch failed" row. ──
  {
    const empty = await findLinkedPrByTitle("o/r", 80, async () => []);
    ok(empty === null, "Search SUCCEEDED with no [#N] match → null (authoritative no-PR)");
    const hit = await findLinkedPrByTitle("o/r", 80, async () => [{ number: 210, title: "[#80] real" }, { number: 5, title: "[#807] x" }]);
    ok(hit === 210, "Search SUCCEEDED with a strict [#N] match → that PR number");
    let threw = false;
    try {
      await findLinkedPrByTitle("o/r", 80, async () => { throw new Error("rate limited"); });
    } catch {
      threw = true;
    }
    ok(threw, "Search FAILURE throws (→ fetch-failed/unknown), NEVER a false queued/closed");
  }

  // ── P3: gatherClosedPrPages — fetch more pages only when page 1 is FULL and
  //    short on merges; stop at ≥RECENT_DISPLAY_LIMIT merged or the page cap ──
  {
    // Page 1 not full (3 items) → never page beyond it, even with <5 merged.
    {
      const requested = [];
      const fetchPage = async (p) => { requested.push(p); return page([]); };
      const pages = await gatherClosedPrPages(page([closedPr(1, "2026-05-01T00:00:00Z"), unmergedPr(2), unmergedPr(3)]), fetchPage);
      ok(pages.length === 1 && requested.length === 0, "page 1 short (not full) → no further pages fetched");
    }
    // Page 1 full (100) but already ≥5 merged → stop, no page 2.
    {
      const requested = [];
      const fetchPage = async (p) => { requested.push(p); return page([]); };
      const full5 = Array.from({ length: 100 }, (_, i) => i < 5 ? closedPr(i + 1, `2026-05-0${i + 1}T00:00:00Z`) : unmergedPr(1000 + i));
      const pages = await gatherClosedPrPages(page(full5), fetchPage);
      ok(pages.length === 1 && requested.length === 0, "page 1 full but ≥5 merged → no extra pages");
    }
    // Page 1 full of UNMERGED (0 merged) → fetch page 2, which supplies merges.
    {
      const requested = [];
      const full0 = Array.from({ length: 100 }, (_, i) => unmergedPr(i + 1));
      const page2 = Array.from({ length: 100 }, (_, i) => i < 6 ? closedPr(2000 + i, `2026-04-0${(i % 9) + 1}T00:00:00Z`) : unmergedPr(3000 + i));
      const fetchPage = async (p) => { requested.push(p); return page(page2); };
      const pages = await gatherClosedPrPages(page(full0), fetchPage);
      ok(requested.length === 1 && requested[0] === 2, "page 1 full + 0 merged → page 2 fetched");
      ok(pages.length === 2, "gathered both pages");
    }
    // Page cap: every page full and unmerged → stop at MERGED_PAGE_CAP (3).
    {
      const requested = [];
      const fullUnmerged = Array.from({ length: 100 }, (_, i) => unmergedPr(i + 1));
      const fetchPage = async (p) => { requested.push(p); return page(fullUnmerged); };
      const pages = await gatherClosedPrPages(page(fullUnmerged), fetchPage);
      ok(pages.length === 3 && requested.join(",") === "2,3", "never exceeds the page cap (3 pages: 1 + pages 2,3)");
    }
  }

  // ── P3: selectRecentMergedPrs — latest 5 merged across pages, newest first ──
  {
    const p1 = page([unmergedPr(1), closedPr(2, "2026-01-10T00:00:00Z"), unmergedPr(3)]);
    const p2 = page([
      closedPr(10, "2026-05-09T00:00:00Z"),
      closedPr(11, "2026-05-08T00:00:00Z"),
      closedPr(12, "2026-05-07T00:00:00Z"),
      closedPr(13, "2026-05-06T00:00:00Z"),
      closedPr(14, "2026-05-05T00:00:00Z"),
    ]);
    const merged = selectRecentMergedPrs([p1, p2]);
    ok(merged.length === 5, "caps the merged slice at RECENT_DISPLAY_LIMIT (5)");
    ok(merged[0].number === 10 && merged[0].state === "MERGED", "newest merge first, canonical MERGED shape");
    // The old PR #2 (Jan) is pushed out by the 5 fresher page-2 merges — proves
    // recently-closed-unmerged PRs on page 1 don't bury real merges on page 2.
    ok(!merged.some((m) => m.number === 2), "an older merge is correctly excluded once 5 fresher merges exist on a later page");
    ok(merged.every((m) => m.mergedAt), "every selected row carries mergedAt");
  }

  // ── #834: closedPagesComplete — the closed-PR window is PROVEN complete only
  //    when the LAST fetched page came back reliably AND had < 100 items. ──
  {
    const full = Array.from({ length: 100 }, (_, i) => unmergedPr(i + 1));
    const short = [unmergedPr(1), unmergedPr(2)];
    ok(closedPagesComplete([page(short)]) === true, "single short (<100) ok page → complete (genuine end)");
    ok(closedPagesComplete([page(full)]) === false, "single full (===100) ok page → NOT complete (more may exist)");
    ok(closedPagesComplete([page(full), page(short)]) === true, "last page short → complete regardless of earlier full pages");
    ok(closedPagesComplete([page(full), page(full)]) === false, "cap-hit/early-stop with a full LAST page → NOT complete");
    ok(closedPagesComplete([{ status: "error", data: null }]) === false, "error last page → NOT complete (can't prove the end)");
    ok(closedPagesComplete([page(full), { status: "error", data: short }]) === false, "error last page even with short stale data → NOT complete");
    // A 304 carries the unchanged real data — a short 304 page is a genuine end.
    ok(closedPagesComplete([{ status: "unchanged", data: short }]) === true, "304 (unchanged) short page → complete (its data is the real, unchanged tail)");
    ok(closedPagesComplete([{ status: "unchanged", data: full }]) === false, "304 full page → NOT complete");
  }

  // ── #834: closedPrIssueNumsFromPages — every [#N] linked issue across ALL
  //    scanned closed pages (strict, start-anchored), not just the displayed 5. ──
  {
    const p1 = page([{ title: "[#5] merged a" }, { title: "[#7] closed b" }, { title: "no link here" }]);
    const p2 = page([{ title: "[#8] merged out-of-window" }, { title: "Fix [#9] mid-title (rejected)" }]);
    const nums = closedPrIssueNumsFromPages([p1, p2]);
    ok(nums.includes(5) && nums.includes(7) && nums.includes(8), "collects [#N] across all pages (incl. beyond the displayed 5)");
    ok(!nums.includes(9), "mid-title [#9] (not start-anchored) is NOT collected");
    ok(closedPrIssueNumsFromPages([{ status: "error", data: null }]).length === 0, "error/no-data page contributes nothing");
  }

  // ── P1/P3 acceptance guard: ZERO `gh issue view` / `gh pr view` (GraphQL)
  //    remains anywhere in the batch-progress resolution path; the by-number
  //    fallback and snapshot freshness use REST (`gh api`) + Search. ──
  {
    const src = fs.readFileSync(path.join(__dirname, "routes.js"), "utf-8");
    const span = (name) => {
      const s = src.indexOf(name);
      const e = src.indexOf("\n}", s);
      return s === -1 ? "" : src.slice(s, e);
    };
    const restFallback = span("async function progressForItemRest(");
    const finder = span("async function findLinkedPrByTitle(");
    const search = span("async function _searchLinkedPrItems(");
    const freshness = span("async function checkBatchSnapshotFreshness(");
    const all = restFallback + finder + search + freshness;
    ok(restFallback && finder && search && freshness, "located the by-number-path functions");
    ok(!/"issue",\s*\n?\s*"view"|"pr",\s*\n?\s*"view"/.test(all), "no `gh issue view` / `gh pr view` (GraphQL) in the by-number path");
    ok(!/closedByPullRequestsReferences/.test(all), "no closedByPullRequestsReferences (GraphQL edge) in the by-number path");
    ok(search.includes("search/issues") && search.includes("-X") && search.includes("GET"), "linked-PR search uses REST `gh api -X GET search/issues`");
    // RE1 #830: the finder must NOT swallow a Search failure into null — only
    // pickLinkedPrFromSearch may yield null (on a successful empty result).
    ok(!finder.includes("catch") && !finder.includes("return null"), "findLinkedPrByTitle does not catch/return-null — a Search failure propagates (throws)");
    ok(restFallback.includes("repos/${repo}/issues/") && restFallback.includes("repos/${repo}/pulls/"), "by-number fallback fetches issue + PR via REST `gh api repos/...`");
    ok(freshness.includes("repos/${repo}/issues/"), "snapshot freshness check uses REST `gh api`, not gh issue view");
    // And progressForItemAsync (the old GraphQL fallback) is fully gone.
    ok(!src.includes("progressForItemAsync"), "the old GraphQL progressForItemAsync is removed entirely");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
