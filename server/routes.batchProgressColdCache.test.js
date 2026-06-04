// #943: code-batch progress must read the PERSISTED GITHUB.md snapshot when the
// in-memory _graphqlCache is empty (e.g. just after a server restart), instead
// of firing an uncapped burst of live per-item Searches that mis-rendered queued
// items as "fetch failed". This test proves:
//   1. progressFromGithubFile reproduces the buckets from the parsed file.
//   2. Cold cache (empty _graphqlCache) + a fresh GITHUB.md → items resolve from
//      the file with ZERO gh/Search subprocess calls (AC#1, AC#5).
//   3. With an in-memory snapshot present, items it can't prove fall to the
//      live by-number fetch CONCURRENCY-CAPPED (≤ GH_MAX_CONCURRENT, AC#2), and a
//      transient failure renders a SOFT "queued (retrying)" row, never a hard
//      "fetch failed" (AC#3).
//
// Plain node:assert script — run with
// `node server/routes.batchProgressColdCache.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const GH_MAX_CONCURRENT = 2; // mirrors the const in routes.js

// ── child_process.execFile stub installed BEFORE require("./routes") ─────────
// Any gh call (issue/PR/Search/check-runs) routes through here. It (a) counts
// calls so the cold-cache test can assert ZERO live fetches, (b) tracks max
// concurrency so the capped-fallback test can assert ≤ GH_MAX_CONCURRENT, and
// (c) ALWAYS errors so progressForItemRest rejects → the route's soft row.
let ghCalls = 0;
let inFlight = 0;
let maxInFlight = 0;
const realRunner = cp.execFile;
cp.execFile = function stubRunner(file, args, opts, cb) {
  const done = typeof opts === "function" ? opts : cb;
  if (typeof done !== "function") return realRunner.apply(this, arguments);
  ghCalls++;
  inFlight++;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  // Defer the callback so genuinely-concurrent item chains overlap (a sync cb
  // would never let inFlight exceed 1, hiding the cap).
  setImmediate(() => {
    inFlight--;
    const err = new Error("test stub: gh not invoked");
    err.code = "ENOTEST";
    done(err, "", "");
  });
};

// ── fs stubs installed BEFORE require("./routes") ────────────────────────────
const real = { readFileSync: fs.readFileSync };
let cfgJson = JSON.stringify({ projects: [] });
let queueText = "";
let githubMd = "";
fs.readFileSync = function stubReadFileSync(p, ...rest) {
  if (p === CONFIG_PATH) return cfgJson;
  if (typeof p === "string" && p.endsWith("OVERNIGHT-QUEUE.md")) return queueText;
  if (typeof p === "string" && p.endsWith("GITHUB.md")) return githubMd;
  // batch-progress-cache.json absent → readBatchSnapshot null → the upstream
  // checkBatchSnapshotFreshness gh call is skipped entirely.
  if (typeof p === "string" && p.endsWith("batch-progress-cache.json")) {
    const err = new Error("ENOENT (test stub)");
    err.code = "ENOENT";
    throw err;
  }
  return real.readFileSync(p, ...rest);
};
fs.writeFileSync = () => {};
fs.mkdirSync = () => {};
fs.statSync = () => ({ mode: 0o700, isDirectory: () => true });
fs.renameSync = () => {};
fs.unlinkSync = () => {};

const routes = require("./routes");
const {
  getOrComputeBatchProgress,
  progressFromGithubFile,
  approvalsFromReviewDetail,
  softRetryingRow,
  loadGithubParsed,
  renderGithubMarkdown,
  parseGithub,
  _batchProgressCache,
  _graphqlCache,
} = routes;

// Reviews authored by the shared reviewer login, distinguished by body marker
// (the same shape refreshRepoRest stores; renderGithubMarkdown attributes them
// by role into Review Detail, which parseGithub reads back).
const review = (marker, state, ts) => ({ state, author: { login: "shared" }, submittedAt: ts, body: `${marker}: ${state}` });

// A snapshot covering every bucket, rendered to a parser-faithful GITHUB.md.
function buildGithubMd() {
  const snapshot = {
    issues: [
      { number: 100, title: "queued thing", state: "OPEN", url: "https://x/i/100", assignees: [{ login: "dev" }] },
      { number: 200, title: "in review thing", state: "OPEN", url: "https://x/i/200", assignees: [] },
      { number: 300, title: "one approval thing", state: "OPEN", url: "https://x/i/300", assignees: [] },
      { number: 400, title: "two approvals thing", state: "OPEN", url: "https://x/i/400", assignees: [] },
    ],
    prs: [
      { number: 201, title: "[#200] in review", state: "OPEN", url: "https://x/p/201", reviews: [] },
      { number: 301, title: "[#300] one approval", state: "OPEN", url: "https://x/p/301", reviews: [review("RE1", "APPROVED", "2026-06-01T00:00:00Z")] },
      { number: 401, title: "[#400] two approvals", state: "OPEN", url: "https://x/p/401", reviews: [review("RE1", "APPROVED", "2026-06-01T00:00:00Z"), review("RE2", "APPROVED", "2026-06-02T00:00:00Z")] },
    ],
    closedIssues: [
      { number: 500, title: "merged thing", state: "CLOSED", url: "https://x/i/500" },
      { number: 600, title: "closed no pr", state: "CLOSED", url: "https://x/i/600" },
    ],
    mergedPrs: [
      { number: 501, title: "[#500] merged pr", state: "MERGED", url: "https://x/p/501" },
    ],
  };
  return renderGithubMarkdown("Proj", "o/r", snapshot, { generatedAt: Date.now(), staleCycles: 0 }, "(none)");
}

(async () => {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // ───────────────────────────────────────────────────────────────────────────
  // A. progressFromGithubFile — pure buckets from the parsed file.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const parsed = parseGithub(buildGithubMd());
    ok(parsed && parsed.ok, "A: GITHUB.md fixture parses ok");
    const r100 = progressFromGithubFile(parsed, 100);
    ok(r100.status === "queued" && r100.progress === 0, "A: OPEN issue, no PR → queued/0");
    const r200 = progressFromGithubFile(parsed, 200);
    ok(r200.status === "in_review" && r200.progress === 20 && r200.pr_number === 201, "A: open PR, 0 approvals → in_review/20");
    const r300 = progressFromGithubFile(parsed, 300);
    ok(r300.status === "approved1" && r300.progress === 50, "A: open PR, 1 role approved → approved1/50");
    const r400 = progressFromGithubFile(parsed, 400);
    ok(r400.status === "ready" && r400.progress === 80, "A: open PR, 2 roles approved → ready/80");
    const r500 = progressFromGithubFile(parsed, 500);
    ok(r500.status === "merged" && r500.progress === 100 && r500.pr_number === 501, "A: merged PR + CLOSED issue → merged/100");
    const r600 = progressFromGithubFile(parsed, 600);
    ok(r600.status === "closed" && r600.progress === 100, "A: CLOSED issue, no PR → closed/100");
    ok(progressFromGithubFile(parsed, 999) === null, "A: issue absent from file → null (caller soft-retries)");
    ok(progressFromGithubFile(null, 1) === null, "A: no parse → null");
    ok(progressFromGithubFile({ ok: false }, 1) === null, "A: failed parse → null");
  }

  // A2. merged-but-still-OPEN ambiguity → null (defers to the snapshot), mirroring
  //     progressFromSnapshot. A merged [#N] PR whose issue is still OPEN must not
  //     be guessed as queued from the file.
  {
    // Titles are in the persisted (bracket-stripped) form parseGithub produces.
    const parsed = {
      ok: true,
      openIssues: [{ number: 7, title: "merged but open", url: "u7" }],
      openPRs: [], closedIssues: [],
      mergedPrs: [{ number: 70, title: "#7 merged", url: "u70" }],
      reviewDetail: {},
    };
    ok(progressFromGithubFile(parsed, 7) === null, "A2: OPEN issue with an in-window merged #N PR → null (merged-but-open ambiguity)");
    // #80 must NOT match issue 8 (word-boundary guard).
    const parsed8 = { ok: true, openIssues: [{ number: 8, title: "eight", url: "u8" }], openPRs: [{ number: 800, title: "#80 not eight", url: "u800" }], closedIssues: [], mergedPrs: [], reviewDetail: {} };
    ok(progressFromGithubFile(parsed8, 8).status === "queued", "A2: '#80' PR title does NOT link to issue 8 → 8 stays queued (no false in_review)");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // B. approvalsFromReviewDetail + softRetryingRow units.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const rd = { 301: { re1: { state: "APPROVED" } }, 401: { re1: { state: "APPROVED" }, re2: { state: "APPROVED" } }, 501: { re1: { state: "CHANGES_REQUESTED" } } };
    ok(approvalsFromReviewDetail(rd, 301) === 1, "B: one role APPROVED → 1");
    ok(approvalsFromReviewDetail(rd, 401) === 2, "B: two roles APPROVED → 2");
    ok(approvalsFromReviewDetail(rd, 501) === 0, "B: CHANGES_REQUESTED → 0");
    ok(approvalsFromReviewDetail(rd, 999) === 0, "B: unknown PR → 0");
    ok(approvalsFromReviewDetail(undefined, 1) === 0, "B: no reviewDetail → 0");
    const soft = softRetryingRow(42);
    ok(soft.status === "queued" && soft.label === "queued (retrying)" && soft.progress === 0, "B: softRetryingRow → status queued, label 'queued (retrying)', 0%");
    ok(softRetryingRow(42).title === "#42", "B: softRetryingRow default title");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C. AC#1 / AC#5 — cold in-memory cache + fresh GITHUB.md resolves every item
  //    from the file with ZERO gh/Search subprocess calls.
  // ───────────────────────────────────────────────────────────────────────────
  {
    _batchProgressCache.clear();
    _graphqlCache.clear(); // cold: in-memory snapshot empty (the post-restart state)
    cfgJson = JSON.stringify({ projects: [{ id: "cold-proj", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 26\n\n- #100 queued\n- #200 in review\n- #300 one approval\n- #400 two approvals\n- #500 merged\n- #600 closed no pr\n\n## Backlog\n";
    githubMd = buildGithubMd();
    ghCalls = 0;

    const data = await getOrComputeBatchProgress("cold-proj");
    ok(data !== null && Array.isArray(data.items) && data.items.length === 6, `C: six items resolved (got ${data.items?.length})`);
    const byNum = Object.fromEntries(data.items.map((it) => [it.issue_number, it]));
    ok(byNum[100].status === "queued", "C: #100 queued from file");
    ok(byNum[200].status === "in_review", "C: #200 in_review from file");
    ok(byNum[300].status === "approved1", "C: #300 approved1 from file");
    ok(byNum[400].status === "ready", "C: #400 ready from file");
    ok(byNum[500].status === "merged", "C: #500 merged from file");
    ok(byNum[600].status === "closed", "C: #600 closed from file");
    ok(!data.items.some((it) => it.label === "fetch failed"), "C: NO 'fetch failed' row");
    ok(!data.items.some((it) => it.label === "queued (retrying)"), "C: NO soft 'queued (retrying)' row — every item proven from the file");
    ok(ghCalls === 0, `C: ZERO live gh/Search subprocess calls on the cold-cache path (got ${ghCalls})`);
    ok(data.complete === false, "C: not complete (queued + in-review items present)");
  }

  // C2. Cold cache + ALL items merged/closed from file → complete:true, still
  //     zero gh calls (the restart-after-batch-done case).
  {
    _batchProgressCache.clear();
    _graphqlCache.clear();
    cfgJson = JSON.stringify({ projects: [{ id: "cold-done", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 27\n\n- #500 merged\n- #600 closed\n";
    githubMd = buildGithubMd();
    ghCalls = 0;

    const data = await getOrComputeBatchProgress("cold-done");
    ok(data.items.every((it) => it.status === "merged" || it.status === "closed"), "C2: both items merged/closed from file");
    ok(data.complete === true, "C2: complete === true from the persisted file");
    ok(ghCalls === 0, "C2: zero gh calls");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // D. AC#2 / AC#3 — with an in-memory snapshot present that can't prove items,
  //    the live by-number fallback is concurrency-capped and soft-fails.
  // ───────────────────────────────────────────────────────────────────────────
  {
    _batchProgressCache.clear();
    _graphqlCache.clear();
    cfgJson = JSON.stringify({ projects: [{ id: "warm-proj", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 28\n\n- #1 a\n- #2 b\n- #3 c\n- #4 d\n- #5 e\n";
    // Snapshot present but window-incomplete (no completeness flags) → every
    // OPEN issue returns null from progressFromSnapshot → live by-number fetch.
    _graphqlCache.set("o/r", {
      ts: Date.now(),
      issues: [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `t${n}`, state: "OPEN", url: `u${n}` })),
      prs: [], closedIssues: [], mergedPrs: [],
      // openPrsWindowComplete / closedPrsWindowComplete intentionally absent.
    });
    ghCalls = 0; maxInFlight = 0; inFlight = 0;

    const data = await getOrComputeBatchProgress("warm-proj");
    ok(data.items.length === 5, "D: five items");
    ok(data.items.every((it) => it.status === "queued" && it.label === "queued (retrying)"), "D: every failed by-number fetch → soft 'queued (retrying)' (AC#3)");
    ok(!data.items.some((it) => it.label === "fetch failed"), "D: NO hard 'fetch failed' row (AC#3)");
    ok(ghCalls > 0, "D: the live by-number fallback DID run (snapshot couldn't prove the items)");
    ok(maxInFlight <= GH_MAX_CONCURRENT, `D: per-item fallback concurrency-capped at ≤ ${GH_MAX_CONCURRENT} (observed max ${maxInFlight}) (AC#2)`);
    ok(data.complete === false, "D: soft-queued items keep the batch incomplete (no false complete)");
  }

  // D2. loadGithubParsed returns null when the file is missing/unparseable.
  {
    const prev = githubMd;
    githubMd = "not a github file";
    ok(loadGithubParsed("any") === null, "D2: unparseable GITHUB.md → loadGithubParsed null");
    githubMd = prev;
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
