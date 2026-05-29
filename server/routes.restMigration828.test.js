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
  gatherClosedPrPages,
  selectRecentMergedPrs,
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
    const freshness = span("async function checkBatchSnapshotFreshness(");
    const all = restFallback + finder + freshness;
    ok(restFallback && finder && freshness, "located the three by-number-path functions");
    ok(!/"issue",\s*\n?\s*"view"|"pr",\s*\n?\s*"view"/.test(all), "no `gh issue view` / `gh pr view` (GraphQL) in the by-number path");
    ok(!/closedByPullRequestsReferences/.test(all), "no closedByPullRequestsReferences (GraphQL edge) in the by-number path");
    ok(finder.includes("search/issues") && finder.includes("-X") && finder.includes("GET"), "linked-PR finder uses REST Search via `gh api -X GET search/issues`");
    ok(restFallback.includes("repos/${repo}/issues/") && restFallback.includes("repos/${repo}/pulls/"), "by-number fallback fetches issue + PR via REST `gh api repos/...`");
    ok(freshness.includes("repos/${repo}/issues/"), "snapshot freshness check uses REST `gh api`, not gh issue view");
    // And progressForItemAsync (the old GraphQL fallback) is fully gone.
    ok(!src.includes("progressForItemAsync"), "the old GraphQL progressForItemAsync is removed entirely");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
