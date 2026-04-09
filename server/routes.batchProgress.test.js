// #350 / quadwork#350: batch-progress no-linked-PR row builder +
// summarizer tests. Plain node:assert script — run with
// `node server/routes.batchProgress.test.js`.

const assert = require("node:assert/strict");
const { buildNoPrRow, summarizeItems } = require("./routes");

// 1) #350 regression fixture: CLOSED issue with no linked PR
//    must render as 100% complete, not 0% queued.
{
  const issue = {
    number: 336,
    title: "superseded by #338",
    state: "CLOSED",
    url: "https://github.com/realproject7/quadwork/issues/336",
  };
  const row = buildNoPrRow(issue);
  assert.equal(row.status, "closed", "CLOSED with no PR → status=closed");
  assert.equal(row.progress, 100, "CLOSED with no PR → 100%");
  assert.match(row.label, /Closed.*✓/, "label has Closed and ✓ marker");
  assert.equal(row.issue_number, 336);
  assert.equal(row.url, issue.url);
}

// 2) OPEN issue with no linked PR still renders as queued.
{
  const issue = {
    number: 400,
    title: "still open",
    state: "OPEN",
    url: "https://github.com/realproject7/quadwork/issues/400",
  };
  const row = buildNoPrRow(issue);
  assert.equal(row.status, "queued", "OPEN with no PR → queued");
  assert.equal(row.progress, 0);
  assert.equal(row.label, "Issue · queued");
}

// 3) summarizeItems with a mix of merged and closed-without-PR:
//    should count both toward the complete total, label "complete"
//    when closed > 0.
{
  const items = [
    { status: "merged" },
    { status: "merged" },
    { status: "merged" },
    { status: "merged" },
    { status: "merged" },
    { status: "closed" },
    { status: "closed" },
  ];
  const out = summarizeItems(items);
  assert.equal(out, "7/7 complete", "mixed merged+closed → X/N complete");
}

// 4) summarizeItems with only merged items keeps the classic
//    "X/N merged" wording (no behavior change for PR-only batches).
{
  const items = [
    { status: "merged" },
    { status: "merged" },
    { status: "merged" },
  ];
  assert.equal(summarizeItems(items), "3/3 merged");
}

// 5) summarizeItems with a queued + closed mix: done count is
//    closed only, queued surfaces in the detail tail.
{
  const items = [
    { status: "closed" },
    { status: "queued" },
    { status: "queued" },
  ];
  assert.equal(summarizeItems(items), "1/3 complete · 2 queued");
}

// 6) summarizeItems with in-flight PR states still tallies them
//    in the detail tail and keeps the done count at merged-only.
{
  const items = [
    { status: "merged" },
    { status: "ready" },
    { status: "approved1" },
    { status: "in_review" },
    { status: "queued" },
  ];
  assert.equal(
    summarizeItems(items),
    "1/5 merged · 1 ready to merge · 1 needs 2nd approval · 1 in review · 1 queued",
  );
}

console.log("routes.batchProgress.test.js: all assertions passed (6 cases)");
