// #839 regression: /api/batch-active must drop to active:false once a batch
// is complete, even if Head leaves a parked/blocked ticket in the
// `## Active Batch` section. The route now derives `active` from the shared
// getOrComputeBatchProgress() path so both /api/batch-progress and
// /api/batch-active see the same `complete` truth — including on cache miss
// (re1's REQUEST CHANGES on #844: the prior PR's cache-miss path still
// returned the old file-only answer, so a completed batch with a parked
// item could still pulse the sidebar before the panel had been opened once).
//
// Layers covered:
//   - isBatchActiveFromProgress(progress): pure truth-table (10 cases).
//   - getOrComputeBatchProgress(projectId) end-to-end with stubbed fs +
//     pre-populated _graphqlCache so progressFromSnapshot resolves every
//     item without touching gh (the cache-miss completed-batch path that
//     was previously uncovered).
//
// Plain node:assert script — run with
// `node server/routes.batchActiveCompletion.test.js`.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

// ── fs stubs installed BEFORE require("./routes") ──────────────────────────
// routes.js reads CONFIG_PATH via getRepo/isProjectIdle on every call, and
// reads OVERNIGHT-QUEUE.md + batch-progress-cache.json on the cache-miss
// compute path. We replace those reads with fixture values per test and
// route everything else through the real fs so module require still works.
const real = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  mkdirSync: fs.mkdirSync,
  statSync: fs.statSync,
  unlinkSync: fs.unlinkSync,
};
let cfgJson = JSON.stringify({ projects: [] });
let queueText = "";
fs.readFileSync = function stubReadFileSync(p, ...rest) {
  if (p === CONFIG_PATH) return cfgJson;
  if (typeof p === "string" && p.endsWith("OVERNIGHT-QUEUE.md")) return queueText;
  // batch-progress-cache.json absent → readBatchSnapshot returns null and the
  // upstream checkBatchSnapshotFreshness gh call is skipped entirely.
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
fs.unlinkSync = () => {};

const {
  isBatchActiveFromProgress,
  getOrComputeBatchProgress,
  _batchProgressCache,
  _graphqlCache,
} = require("./routes");

function mergedSnapshot(repo, n) {
  _graphqlCache.set(repo, {
    ts: Date.now(),
    issues: [],
    prs: [],
    closedIssues: [{ number: n, title: `feat: thing ${n}`, url: `https://x/i/${n}` }],
    mergedPrs: [{ number: n + 1, title: `[#${n}] feat: thing ${n}`, url: `https://x/p/${n + 1}`, merged_at: "2026-01-01T00:00:00Z", reviews: [] }],
    openPrsWindowComplete: true,
    closedPrsWindowComplete: true,
    closedPrIssueNums: [n],
  });
}

function inReviewSnapshot(repo, n) {
  _graphqlCache.set(repo, {
    ts: Date.now(),
    issues: [{ number: n, title: `feat: in progress ${n}`, url: `https://x/i/${n}`, labels: [], assignees: [], createdAt: "2026-01-01T00:00:00Z" }],
    prs: [{ number: n + 1, title: `[#${n}] feat: in progress ${n}`, url: `https://x/p/${n + 1}`, reviews: [] }],
    closedIssues: [],
    mergedPrs: [],
    openPrsWindowComplete: true,
    closedPrsWindowComplete: true,
    closedPrIssueNums: [],
  });
}

(async () => {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // ─────────────────────────────────────────────────────────────────────────
  // A. isBatchActiveFromProgress pure helper truth table (the #844 layer).
  // ─────────────────────────────────────────────────────────────────────────
  ok(isBatchActiveFromProgress(null) === null, "null progress → null sentinel");
  ok(isBatchActiveFromProgress(undefined) === null, "undefined progress → null sentinel");
  ok(isBatchActiveFromProgress({ items: [], complete: false }) === false, "no items, not complete → not active");
  ok(isBatchActiveFromProgress({ items: [], complete: true }) === false, "no items, complete → not active");
  ok(isBatchActiveFromProgress({ complete: false }) === false, "missing items field → not active");
  ok(isBatchActiveFromProgress({ items: [{ status: "in_review" }], complete: false }) === true, "in-review item, not complete → active");
  ok(isBatchActiveFromProgress({ items: [{ status: "merged" }, { status: "queued" }], complete: false }) === true, "mix of merged + queued, complete:false → active");
  ok(isBatchActiveFromProgress({ items: [{ status: "merged" }], complete: true }) === false, "single merged item, complete → NOT active (helper case for #839)");
  ok(isBatchActiveFromProgress({ items: [{ status: "merged" }, { status: "closed" }, { status: "merged" }], complete: true }) === false, "multi merged/closed items, complete → NOT active");
  ok(isBatchActiveFromProgress({ items: [{ status: "merged" }], complete: true, completeConfirmed: false }) === false, "complete:true overrides completeConfirmed:false");

  // ─────────────────────────────────────────────────────────────────────────
  // B. getOrComputeBatchProgress end-to-end — exercises the cache-miss
  //    completed-batch path re1 flagged as uncovered on #844.
  // ─────────────────────────────────────────────────────────────────────────

  // B1. Cache miss + all items resolve as merged from the snapshot →
  //     complete:true → active=false. THIS IS THE #839 REGRESSION TEST that
  //     was missing on the prior PR.
  {
    _batchProgressCache.clear();
    _graphqlCache.clear();
    cfgJson = JSON.stringify({ projects: [{ id: "done-proj", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 56\n\n- #100 feat: thing\n\n## Backlog\n";
    mergedSnapshot("o/r", 100);

    const data = await getOrComputeBatchProgress("done-proj");
    ok(data !== null, "B1: cache-miss compute returned data (not null)");
    ok(Array.isArray(data.items) && data.items.length === 1, `B1: one item resolved (got ${data.items?.length})`);
    ok(data.items[0].status === "merged", `B1: item resolved as merged from snapshot (got ${data.items[0]?.status})`);
    ok(data.complete === true, "B1: complete === true");
    ok(isBatchActiveFromProgress(data) === false, "B1: active === false on cache-miss completed batch (the #839 fix)");
    ok(_batchProgressCache.has("done-proj"), "B1: result was written to the shared cache");
  }

  // B2. Cache miss + in-progress (open PR, no reviews) → complete:false →
  //     active=true. Confirms the heartbeat still pulses for genuine work.
  {
    _batchProgressCache.clear();
    _graphqlCache.clear();
    cfgJson = JSON.stringify({ projects: [{ id: "active-proj", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 57\n\n- #200 feat: in progress\n";
    inReviewSnapshot("o/r", 200);

    const data = await getOrComputeBatchProgress("active-proj");
    ok(data !== null && data.items.length === 1, "B2: one item resolved for in-progress batch");
    ok(data.items[0].status === "in_review", `B2: item status === "in_review" (got ${data.items[0]?.status})`);
    ok(data.complete === false, "B2: complete === false");
    ok(isBatchActiveFromProgress(data) === true, "B2: active === true for an in-progress batch");
  }

  // B3. Cache hit with completed batch → returns cached data (no recompute,
  //     no snapshot lookup), and the heartbeat is correctly off.
  {
    _batchProgressCache.clear();
    _graphqlCache.clear(); // ensure no snapshot — proves the cache hit is what answers
    cfgJson = JSON.stringify({ projects: [{ id: "cached-proj", repo: "o/r", idle: false }] });
    _batchProgressCache.set("cached-proj", {
      ts: Date.now(),
      data: { batch_number: 42, items: [{ status: "merged" }], summary: "1/1 merged", complete: true, completeConfirmed: true },
    });

    const data = await getOrComputeBatchProgress("cached-proj");
    ok(data.batch_number === 42, "B3: cache hit returned (batch_number preserved)");
    ok(data.complete === true, "B3: complete from cache");
    ok(isBatchActiveFromProgress(data) === false, "B3: cache hit + complete → not active");
  }

  // B4. Idle project → empty items + _idle:true → not active. Confirms
  //     completion-aware semantics for parked projects (no gh fired).
  {
    _batchProgressCache.clear();
    _graphqlCache.clear();
    cfgJson = JSON.stringify({ projects: [{ id: "idle-proj", repo: "o/r", idle: true }] });
    queueText = "# Queue\n\n## Active Batch\n\n- #1 something\n"; // intentionally non-empty — idle short-circuits before this is parsed

    const data = await getOrComputeBatchProgress("idle-proj");
    ok(data !== null, "B4: idle returns a data envelope");
    ok(data._idle === true, "B4: _idle flag set");
    ok(Array.isArray(data.items) && data.items.length === 0, "B4: no items for idle project");
    ok(isBatchActiveFromProgress(data) === false, "B4: idle → not active (parked projects never pulse)");
  }

  // B5. No repo configured → null sentinel so the caller can render 400.
  {
    _batchProgressCache.clear();
    cfgJson = JSON.stringify({ projects: [{ id: "no-repo-proj", idle: false }] }); // no `repo` field

    const data = await getOrComputeBatchProgress("no-repo-proj");
    ok(data === null, "B5: missing repo → null (caller's 400)");
  }

  // B6. Empty Active Batch section → empty items → not active.
  {
    _batchProgressCache.clear();
    _graphqlCache.clear();
    cfgJson = JSON.stringify({ projects: [{ id: "empty-batch-proj", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n## Backlog\n";

    const data = await getOrComputeBatchProgress("empty-batch-proj");
    ok(data !== null && Array.isArray(data.items) && data.items.length === 0, "B6: empty Active Batch → empty items");
    ok(data.complete === false, "B6: complete === false on empty");
    ok(isBatchActiveFromProgress(data) === false, "B6: empty → not active");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
