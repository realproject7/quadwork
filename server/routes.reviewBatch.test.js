// #870: review-batch server tests — batch-type marker + queue-driven
// completion, with ZERO GitHub calls. Plain node:assert-style script (run with
// `node server/routes.reviewBatch.test.js`).
//
// Mirrors routes.batchActiveCompletion.test.js's harness: stub child_process
// (so any gh call is observable) and fs (CONFIG_PATH / OVERNIGHT-QUEUE.md /
// batch-progress-cache.json / GITHUB.md) BEFORE require("./routes").

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

// Count gh invocations so review paths can assert ZERO. The stub also throws,
// so any accidental gh call on the review path would corrupt the item rows
// (proving the no-network contract two ways).
let ghCalls = 0;
const realRunner = cp.execFile;
cp.execFile = function stubRunner(file, args, opts, cb) {
  ghCalls++;
  const done = typeof opts === "function" ? opts : cb;
  const err = new Error("test stub: gh must not be invoked on the review path");
  err.code = "ENOTEST";
  if (typeof done === "function") return done(err, "", "");
  return realRunner.apply(this, arguments);
};

const real = { readFileSync: fs.readFileSync };
let cfgJson = JSON.stringify({ projects: [] });
let queueText = "";
let snapshotJson = null;
let githubMd = null;
let snapshotWrites = [];
fs.readFileSync = function stubReadFileSync(p, ...rest) {
  if (p === CONFIG_PATH) return cfgJson;
  if (typeof p === "string" && p.endsWith("OVERNIGHT-QUEUE.md")) return queueText;
  if (typeof p === "string" && p.endsWith("batch-progress-cache.json")) {
    if (snapshotJson !== null) return snapshotJson;
    const err = new Error("ENOENT (test stub)");
    err.code = "ENOENT";
    throw err;
  }
  if (typeof p === "string" && p.endsWith("GITHUB.md")) {
    if (githubMd !== null) return githubMd;
    const err = new Error("ENOENT (test stub)");
    err.code = "ENOENT";
    throw err;
  }
  return real.readFileSync(p, ...rest);
};
// Capture snapshot writes so we can assert batch_type/reviewItems are persisted.
fs.writeFileSync = function stubWrite(p, data) {
  if (typeof p === "string" && p.endsWith("batch-progress-cache.json")) {
    snapshotWrites.push(typeof data === "string" ? data : String(data));
  }
};
fs.mkdirSync = () => {};
fs.statSync = () => ({ mode: 0o700, isDirectory: () => true });
fs.unlinkSync = () => {};

const {
  parseBatchType,
  parseReviewItems,
  parseReviewState,
  isBatchActiveFromProgress,
  getOrComputeBatchProgress,
  _batchProgressCache,
  _graphqlCache,
} = require("./routes");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

function reset() {
  _batchProgressCache.clear();
  _graphqlCache.clear();
  snapshotJson = null;
  githubMd = null;
  snapshotWrites = [];
  ghCalls = 0;
}

(async () => {
  console.log("\n--- #870 review-batch server tests ---\n");

  // ── parseBatchType ──────────────────────────────────────────────────────
  ok(parseBatchType("## Active Batch\n\n**Batch:** 1\n\n- #1 — queued\n") === "code", "absent marker → code");
  ok(parseBatchType("## Active Batch\n\n**Batch:** 1\n**Batch type:** ticket-review\n\n- #1 — queued\n") === "ticket-review", "ticket-review parsed");
  ok(parseBatchType("## Active Batch\n\n**Batch:** 1\n**Batch type:** pr-review\n\n- #1 — queued\n") === "pr-review", "pr-review parsed");
  ok(parseBatchType("## Active Batch\n**Batch type:** banana\n\n- #1\n") === "code", "unrecognized type → code");
  // marker only counts inside Active Batch, not e.g. Done
  ok(parseBatchType("## Active Batch\n\n(none)\n\n## Done\n\n**Batch type:** pr-review\n") === "code", "marker outside Active Batch ignored");

  // ── parseReviewState ────────────────────────────────────────────────────
  ok(parseReviewState("— approved").review_state === "approved", "approved state");
  ok(parseReviewState("in-review (1/2)").approvals === 1, "in-review (1/2) → approvals 1");
  ok(parseReviewState("in-review").approvals === 0 && parseReviewState("in-review").review_state === "in-review", "in-review → 0 approvals");
  ok(parseReviewState("changes-requested").review_state === "changes-requested", "changes-requested state");
  ok(parseReviewState("queued").review_state === "queued", "queued state");
  ok(parseReviewState("garbage").review_state === "queued", "unrecognized → queued");

  // ── parseReviewItems (scoped to Active Batch, with states) ──────────────
  {
    const q = [
      "# Queue", "", "## Active Batch", "", "**Batch:** 7", "**Batch type:** ticket-review", "",
      "- #870 — approved", "- #871 — in-review (1/2)", "- #872 — queued", "",
      "## Done", "", "**Batch:** 6", "- #800 — approved", "",
    ].join("\n");
    const items = parseReviewItems(q);
    ok(items.length === 3, `parseReviewItems scoped to Active Batch (got ${items.length}, must exclude Done's #800)`);
    ok(items[0].issue === 870 && items[0].review_state === "approved", "item 0 = #870 approved");
    ok(items[1].issue === 871 && items[1].approvals === 1, "item 1 = #871 in-review 1/2");
    ok(items[2].issue === 872 && items[2].review_state === "queued", "item 2 = #872 queued");
  }

  // ── B. Review batch end-to-end: 3 items, 1 approved → not complete ──────
  {
    reset();
    cfgJson = JSON.stringify({ projects: [{ id: "rev", repo: "o/r", idle: false }] });
    queueText = [
      "# Queue", "", "## Active Batch", "", "**Batch:** 7", "**Batch type:** ticket-review", "",
      "- #870 — approved", "- #871 — in-review (1/2)", "- #872 — queued", "", "## Backlog", "",
    ].join("\n");
    const data = await getOrComputeBatchProgress("rev");
    ok(ghCalls === 0, `B: review compute made ZERO gh calls (got ${ghCalls})`);
    ok(data.batch_type === "ticket-review", "B: batch_type === ticket-review");
    ok(data.items.length === 3, "B: three items");
    ok(data.items[0].review_state === "approved" && data.items[0].progress === 100, "B: #870 approved → progress 100");
    ok(data.items[1].review_state === "in-review" && data.items[1].progress === 50 && data.items[1].approvals === 1, "B: #871 in-review(1/2) → progress 50");
    ok(data.items[2].review_state === "queued" && data.items[2].progress === 0, "B: #872 queued → progress 0");
    ok(data.items[0].issue_number === 870 && !("pr_number" in data.items[0]), "B: ticket-review item keeps issue_number, OMITS pr_number");
    ok(data.complete === false && data.completeConfirmed === false, "B: not all approved → not complete");
    ok(isBatchActiveFromProgress(data) === true, "B: in-progress review batch is active");
  }

  // ── C. All approved → complete && completeConfirmed (queue authoritative) ─
  {
    reset();
    cfgJson = JSON.stringify({ projects: [{ id: "rev", repo: "o/r", idle: false }] });
    queueText = [
      "# Queue", "", "## Active Batch", "", "**Batch:** 7", "**Batch type:** pr-review", "",
      "- #870 — approved", "- #871 — approved", "", "## Backlog", "",
    ].join("\n");
    const data = await getOrComputeBatchProgress("rev");
    ok(ghCalls === 0, `C: still ZERO gh calls (got ${ghCalls})`);
    ok(data.complete === true, "C: all approved → complete");
    ok(data.completeConfirmed === true, "C: completeConfirmed === complete (no two-cycle gate)");
    ok(data.items[0].pr_number === 870, "C: pr-review item sets pr_number = n");
    ok(isBatchActiveFromProgress(data) === false, "C: completed review batch → not active");
  }

  // ── D. Done-scoping: old approved items in ## Done don't count ──────────
  {
    reset();
    cfgJson = JSON.stringify({ projects: [{ id: "rev", repo: "o/r", idle: false }] });
    queueText = [
      "# Queue", "", "## Active Batch", "", "**Batch:** 8", "**Batch type:** ticket-review", "",
      "- #900 — in-review", "", "## Done", "", "**Batch:** 7", "- #870 — approved", "- #871 — approved", "",
    ].join("\n");
    const data = await getOrComputeBatchProgress("rev");
    ok(data.items.length === 1 && data.items[0].issue_number === 900, "D: only the current Active item counts (Done excluded)");
    ok(data.complete === false, "D: current item not approved → not complete (Done's approved ignored)");
  }

  // ── E. Archive interaction: completed review batch moved to Done →
  //      still renders from the snapshot, NO gh call, never reverts to code ──
  {
    reset();
    cfgJson = JSON.stringify({ projects: [{ id: "rev", repo: "o/r", idle: false }] });
    // Persisted snapshot from when the batch was active (review + states).
    snapshotJson = JSON.stringify({
      batchNumber: 7,
      issueNumbers: [870, 871],
      batch_type: "ticket-review",
      reviewItems: [
        { issue: 870, review_state: "approved", approvals: 2 },
        { issue: 871, review_state: "approved", approvals: 2 },
      ],
    });
    // Head archived the block to Done; live Active Batch is cleared (no marker).
    queueText = [
      "# Queue", "", "## Active Batch", "", "(no active batch yet)", "",
      "## Done", "", "**Batch:** 7", "**Batch type:** ticket-review",
      "- #870 — approved", "- #871 — approved", "",
    ].join("\n");
    const data = await getOrComputeBatchProgress("rev");
    ok(ghCalls === 0, `E: archived review batch made ZERO gh calls (got ${ghCalls}) — not reinterpreted as code`);
    ok(data.batch_type === "ticket-review", "E: batch_type stays ticket-review from the snapshot (never reverts to code)");
    ok(data.items.length === 2, "E: still renders the 2 review items from the snapshot");
    ok(data.items.every((it) => it.review_state === "approved"), "E: items keep their review_state (not code merge-progress)");
    ok(data.complete === true, "E: archived completed review batch reads complete");
    ok(isBatchActiveFromProgress(data) === false, "E: lifecycle — cleared Active Batch → not active (sticky display only)");
    ok(data.liveActiveBatchCleared === true, "E: liveActiveBatchCleared follows the operator's clear");
  }

  // ── F. Regression: a code batch is unchanged + carries batch_type 'code' ─
  {
    reset();
    cfgJson = JSON.stringify({ projects: [{ id: "code", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 9\n\n- #100 feat: thing\n\n## Backlog\n";
    // Provide a merged snapshot so the code path resolves the item via the
    // (stubbed-gh-free) #806 cache, exactly like batchActiveCompletion B1.
    _graphqlCache.set("o/r", {
      ts: Date.now(), issues: [], prs: [],
      closedIssues: [{ number: 100, title: "feat: thing", url: "https://x/i/100" }],
      mergedPrs: [{ number: 101, title: "[#100] feat: thing", url: "https://x/p/101", merged_at: "2026-01-01T00:00:00Z", reviews: [] }],
      openPrsWindowComplete: true, closedPrsWindowComplete: true, closedPrIssueNums: [100],
    });
    const data = await getOrComputeBatchProgress("code");
    ok(data.batch_type === "code", "F: code batch → batch_type 'code'");
    ok(data.items.length === 1 && data.items[0].status === "merged", "F: code item still resolves as merged (no regression)");
    ok(!("review_state" in data.items[0]), "F: code item has NO review_state field");
    ok(data.complete === true, "F: code batch completion unchanged");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
