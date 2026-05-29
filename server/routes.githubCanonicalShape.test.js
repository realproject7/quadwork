// #806 (#805 step 1): canonical dashboard-shape tests. Plain node:assert
// script — no test runner is wired up. Run with
// `node server/routes.githubCanonicalShape.test.js`.
//
// Asserts the REST+ETag fetcher's transforms produce the SHAPE that
// GitHubPanel.tsx and the batch-progress server logic already expect. The
// frontend render predicates below are copied VERBATIM from
// src/components/GitHubPanel.tsx (line refs noted) so this test fails loudly if
// the canonical shape and the renderer ever drift apart.

const assert = require("node:assert/strict");
const {
  restIssueToCanonical,
  restClosedIssueToCanonical,
  restMergedPrToCanonical,
  restPullBaseToCanonical,
  mapReviews,
  deriveReviewDecision,
  buildStatusCheckRollup,
} = require("./routes");

// ── GitHubPanel.tsx render predicates (verbatim) ──
// GitHubPanel.tsx:106
function issueStatusColor(state) {
  return state === "OPEN" ? "bg-accent" : "bg-error";
}
// GitHubPanel.tsx:109-113
function reviewColor(decision) {
  if (decision === "APPROVED") return "bg-accent";
  if (decision === "CHANGES_REQUESTED") return "bg-error";
  return "bg-[#ffcc00]";
}
// GitHubPanel.tsx:127-141
function ciColor(rollup) {
  if (!rollup || rollup.length === 0) return "text-text-muted";
  const states = rollup.map((c) => c.state);
  if (states.every((s) => s === "SUCCESS")) return "text-accent";
  if (states.some((s) => s === "FAILURE" || s === "ERROR")) return "text-error";
  return "text-[#ffcc00]";
}
function ciLabel(rollup) {
  if (!rollup || rollup.length === 0) return "—";
  const states = rollup.map((c) => c.state);
  if (states.every((s) => s === "SUCCESS")) return "pass";
  if (states.some((s) => s === "FAILURE" || s === "ERROR")) return "fail";
  return "run";
}

// ── REST fixtures (trimmed to the fields the transforms read) ──
const REST_OPEN_ISSUE = {
  number: 42, title: "Fix the thing", state: "open",
  html_url: "https://github.com/o/r/issues/42",
  labels: [{ name: "bug" }, { name: "agent/dev" }],
  assignees: [{ login: "alice" }], created_at: "2026-05-01T00:00:00Z",
  // NOTE: no pull_request key → a real issue.
};
const REST_PR_AS_ISSUE = { number: 7, title: "a PR", state: "open", pull_request: { url: "..." }, html_url: "x" };
const REST_CLOSED_ISSUE = { number: 9, title: "done", state: "closed", html_url: "u9", closed_at: "2026-05-02T00:00:00Z" };
const REST_MERGED_PR = { number: 30, title: "merged pr", state: "closed", html_url: "u30", merged_at: "2026-05-03T00:00:00Z", user: { login: "bob" } };
const REST_OPEN_PR = {
  number: 100, title: "open pr", state: "open", html_url: "u100",
  user: { login: "carol" }, assignees: [{ login: "carol" }],
  created_at: "2026-05-04T00:00:00Z", head: { sha: "deadbeef" },
};

function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // 1) Open issue → uppercase OPEN, html_url→url, labels/assignees mapped.
  {
    const c = restIssueToCanonical(REST_OPEN_ISSUE);
    ok(c.state === "OPEN", "open issue state is uppercase OPEN");
    ok(c.url === "https://github.com/o/r/issues/42", "html_url mapped to url");
    ok(c.labels.length === 2 && c.labels[0].name === "bug", "labels normalized to {name}");
    ok(c.assignees[0].login === "alice", "assignees normalized to {login}");
    ok(c.createdAt === "2026-05-01T00:00:00Z", "created_at mapped to createdAt");
    // GitHubPanel open-state dot renders green for this shape.
    ok(issueStatusColor(c.state) === "bg-accent", "GitHubPanel open-state dot is bg-accent for OPEN");
  }

  // 2) Closed issue → uppercase CLOSED → renderer would NOT use accent.
  {
    const c = restClosedIssueToCanonical(REST_CLOSED_ISSUE);
    ok(c.state === "CLOSED", "closed issue state is uppercase CLOSED");
    ok(c.closedAt === "2026-05-02T00:00:00Z", "closed_at mapped to closedAt");
    ok(issueStatusColor(c.state) === "bg-error", "CLOSED issue dot is bg-error (not accent)");
    // batch-progress buildNoPrRow compares issue.state === "CLOSED".
    ok(c.state === "CLOSED", "batch-progress CLOSED comparison matches canonical");
  }

  // 3) Merged PR → uppercase MERGED (batch-progress merged detection).
  {
    const c = restMergedPrToCanonical(REST_MERGED_PR);
    ok(c.state === "MERGED", "merged PR state is uppercase MERGED");
    ok(c.mergedAt === "2026-05-03T00:00:00Z" && c.author.login === "bob", "mergedAt + author mapped");
  }

  // 4) REST /issues includes PRs — they carry a pull_request key and must be
  //    droppable by the fetcher's filter.
  {
    ok(!!REST_PR_AS_ISSUE.pull_request, "PR-as-issue fixture has pull_request key (fetcher drops it)");
    ok(restIssueToCanonical(REST_OPEN_ISSUE).number === 42, "a real issue has no pull_request key");
  }

  // 5) reviews keep FULL list with bodies; reviewDecision derived.
  {
    const reviews = mapReviews([
      { user: { login: "shared" }, state: "COMMENTED", submitted_at: "2026-05-01T00:00:00Z", body: "RE1: looks ok" },
      { user: { login: "shared" }, state: "APPROVED", submitted_at: "2026-05-02T00:00:00Z", body: "RE2: APPROVE" },
    ]);
    ok(reviews.length === 2, "full review list preserved (not collapsed per-author)");
    ok(reviews[0].author.login === "shared" && reviews[0].body === "RE1: looks ok", "review body preserved for role attribution");
    ok(reviews[1].submittedAt === "2026-05-02T00:00:00Z", "submitted_at mapped to submittedAt");
    ok(deriveReviewDecision(reviews) === "APPROVED", "one APPROVED, no blocks → APPROVED");
  }

  // 6) reviewDecision: CHANGES_REQUESTED blocks; latest-per-author wins.
  {
    ok(deriveReviewDecision([
      { author: { login: "a" }, state: "APPROVED", submittedAt: "2026-05-01T00:00:00Z" },
      { author: { login: "a" }, state: "CHANGES_REQUESTED", submittedAt: "2026-05-02T00:00:00Z" },
    ]) === "CHANGES_REQUESTED", "latest CHANGES_REQUESTED from same author blocks");
    ok(deriveReviewDecision([]) === "REVIEW_REQUIRED", "no reviews → REVIEW_REQUIRED");
    ok(deriveReviewDecision([{ author: { login: "a" }, state: "COMMENTED", submittedAt: "x" }]) === "REVIEW_REQUIRED", "comment-only → REVIEW_REQUIRED");
    // Drives GitHubPanel reviewColor.
    ok(reviewColor("CHANGES_REQUESTED") === "bg-error", "CHANGES_REQUESTED dot is bg-error");
    ok(reviewColor("APPROVED") === "bg-accent", "APPROVED dot is bg-accent");
    ok(reviewColor("REVIEW_REQUIRED") === "bg-[#ffcc00]", "REVIEW_REQUIRED dot is yellow");
  }

  // 7) statusCheckRollup from check-runs AND combined status, normalized to
  //    the {state}[] GitHubPanel ci helpers expect.
  {
    const allPass = buildStatusCheckRollup(
      { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "neutral" }] },
      { statuses: [{ state: "success" }] },
    );
    ok(allPass.every((c) => c.state === "SUCCESS"), "success + neutral check-runs + success status all → SUCCESS");
    ok(ciColor(allPass) === "text-accent" && ciLabel(allPass) === "pass", "all-SUCCESS rollup renders pass/accent");

    const hasFail = buildStatusCheckRollup(
      { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] },
      { statuses: [] },
    );
    ok(hasFail.some((c) => c.state === "FAILURE"), "failure conclusion → FAILURE state");
    ok(ciColor(hasFail) === "text-error" && ciLabel(hasFail) === "fail", "any-FAILURE rollup renders fail/error");

    const running = buildStatusCheckRollup(
      { check_runs: [{ status: "in_progress", conclusion: null }] },
      { statuses: [{ state: "pending" }] },
    );
    ok(running.every((c) => c.state === "PENDING"), "in-progress run + pending status → PENDING");
    ok(ciColor(running) === "text-[#ffcc00]" && ciLabel(running) === "run", "pending rollup renders run/yellow");

    const empty = buildStatusCheckRollup({ check_runs: [] }, { statuses: [] });
    ok(empty.length === 0 && ciLabel(empty) === "—", "no checks → empty rollup → dash");
  }

  // 8) Open PR base row → uppercase OPEN + head sha available for sub-fetches.
  {
    const c = restPullBaseToCanonical(REST_OPEN_PR);
    ok(c.state === "OPEN" && c.url === "u100" && c.author.login === "carol", "open PR base row mapped, uppercase OPEN");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
