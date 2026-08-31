// #950: batch-progress must not refetch terminal items every cycle, and stale
// rendered payloads should return immediately while one background refresh runs.
//
// Plain node:assert script — run with
// `node server/routes.batchProgressTerminalCache.test.js`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

let ghCalls = [];
let delayGh = false;
const realRunner = cp.execFile;
cp.execFile = function stubRunner(file, args, opts, cb) {
  const done = typeof opts === "function" ? opts : cb;
  if (file !== "gh" || typeof done !== "function") return realRunner.apply(this, arguments);
  ghCalls.push(args.slice());
  const finish = () => done(null, JSON.stringify({ number: 10 }), "");
  if (delayGh) setTimeout(finish, 80);
  else setImmediate(finish);
};

const real = { readFileSync: fs.readFileSync };
let cfgJson = JSON.stringify({ projects: [] });
let queueText = "";
let snapshotJson = null;
let githubMd = "";
fs.readFileSync = function stubReadFileSync(p, ...rest) {
  if (p === CONFIG_PATH) return cfgJson;
  if (typeof p === "string" && p.endsWith("OVERNIGHT-QUEUE.md")) return queueText;
  if (typeof p === "string" && p.endsWith("batch-progress-cache.json")) {
    if (snapshotJson !== null) return snapshotJson;
    const err = new Error("ENOENT (test stub)");
    err.code = "ENOENT";
    throw err;
  }
  if (typeof p === "string" && p.endsWith("GITHUB.md")) return githubMd;
  return real.readFileSync(p, ...rest);
};
fs.writeFileSync = function stubWriteFileSync(p, data) {
  if (typeof p === "string" && p.endsWith("batch-progress-cache.json")) {
    snapshotJson = String(data);
  }
};
fs.mkdirSync = () => {};
fs.statSync = () => ({ mode: 0o700, isDirectory: () => true });
fs.renameSync = () => {};
fs.unlinkSync = () => { snapshotJson = null; };

const {
  getOrComputeBatchProgress,
  _batchProgressCache,
  _batchProgressRefreshes,
  _graphqlCache,
  renderGithubMarkdown,
} = require("./routes");

function mergedRowsSnapshot(repo, nums) {
  _graphqlCache.set(repo, {
    ts: Date.now(),
    issues: [],
    prs: [],
    closedIssues: nums.map((n) => ({ number: n, title: `done ${n}`, url: `https://x/i/${n}` })),
    mergedPrs: nums.map((n) => ({ number: n + 1000, title: `[#${n}] done ${n}`, url: `https://x/p/${n + 1000}`, reviews: [] })),
    openPrsWindowComplete: true,
    closedPrsWindowComplete: true,
    closedPrIssueNums: nums.slice(),
  });
}

function perItemIssueFetches() {
  return ghCalls.filter((args) => {
    const target = args.find((a) => typeof a === "string" && /repos\/o\/r\/issues\/\d+$/.test(a));
    return target && !args.includes("--jq");
  });
}

(async () => {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // A. First compute resolves terminal rows from the in-memory board snapshot
  // and persists them to batch-progress-cache.json.
  {
    _batchProgressCache.clear();
    _batchProgressRefreshes.clear();
    _graphqlCache.clear();
    ghCalls = [];
    snapshotJson = null;
    cfgJson = JSON.stringify({ projects: [{ id: "terminal-proj", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 950\n\n- #10 done\n- #11 done\n- #12 done\n";
    mergedRowsSnapshot("o/r", [10, 11, 12]);

    const data = await getOrComputeBatchProgress("terminal-proj");
    ok(data.items.length === 3, "A: three items resolved");
    ok(data.items.every((it) => it.status === "merged"), "A: all rows are terminal merged rows");
    ok(snapshotJson && JSON.parse(snapshotJson).terminalItems["10"].status === "merged", "A: terminal row persisted to batch-progress-cache.json");
    ok(perItemIssueFetches().length === 0, "A: first snapshot-proven compute made no per-item REST issue fetches");
  }

  // B1. Next compute has no fresh per-item evidence, so the persisted terminal
  // rows short-circuit REST fallback; only the existing one-shot snapshot
  // freshness probe is allowed.
  {
    _batchProgressCache.clear();
    _batchProgressRefreshes.clear();
    _graphqlCache.clear();
    ghCalls = [];
    _graphqlCache.set("o/r", {
      ts: Date.now(),
      issues: [],
      prs: [],
      closedIssues: [],
      mergedPrs: [],
    });

    const data = await getOrComputeBatchProgress("terminal-proj");
    ok(data.items.every((it) => it.status === "merged"), "B1: persisted terminal rows fill missing snapshot evidence");
    ok(perItemIssueFetches().length === 0, "B1: terminal-cache reuse made zero per-item REST issue fetches");
    ok(ghCalls.length === 1 && ghCalls[0].includes("--jq"), "B1: only the snapshot freshness probe ran");
  }

  // B2. Fresh snapshot evidence wins over stale terminal cache. A reopened item
  // must not remain complete indefinitely, and its stale terminal row is evicted
  // from the persistent cache.
  {
    _batchProgressCache.clear();
    _batchProgressRefreshes.clear();
    _graphqlCache.clear();
    ghCalls = [];
    _graphqlCache.set("o/r", {
      ts: Date.now(),
      issues: [{ number: 10, title: "reopened 10", state: "OPEN", url: "https://x/i/10" }],
      prs: [],
      closedIssues: [],
      mergedPrs: [],
      openPrsWindowComplete: true,
      closedPrsWindowComplete: true,
      closedPrIssueNums: [],
    });

    const data = await getOrComputeBatchProgress("terminal-proj");
    const row10 = data.items.find((it) => it.issue_number === 10);
    ok(row10.status === "queued", `B2: fresh reopened snapshot overrides terminal cache (got ${row10.status})`);
    ok(row10.status !== "merged" && row10.status !== "closed", "B2: reopened item is no longer terminal");
    ok(!JSON.parse(snapshotJson).terminalItems["10"], "B2: stale terminal row evicted from persistent cache");
  }

  // B3. The persisted GITHUB.md cold-cache path also wins over stale terminal
  // cache when it proves an item is open/nonterminal.
  {
    _batchProgressCache.clear();
    _batchProgressRefreshes.clear();
    _graphqlCache.clear();
    ghCalls = [];
    snapshotJson = JSON.stringify({
      batchNumber: 950,
      issueNumbers: [10],
      batch_type: "code",
      reviewItems: [],
      terminalItems: {
        10: { issue_number: 10, title: "done 10", url: "https://x/i/10", pr_number: 1010, status: "merged", progress: 100, label: "Merged ✓" },
      },
    });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 950\n\n- #10 reopened\n";
    githubMd = renderGithubMarkdown(
      "Proj",
      "o/r",
      { issues: [{ number: 10, title: "reopened 10", state: "OPEN", url: "https://x/i/10", assignees: [] }], prs: [], closedIssues: [], mergedPrs: [] },
      { generatedAt: Date.now(), staleCycles: 0 },
      "(none)",
    );

    const data = await getOrComputeBatchProgress("terminal-proj");
    const row10 = data.items.find((it) => it.issue_number === 10);
    ok(row10.status === "queued", `B3: persisted GITHUB.md reopened row overrides terminal cache (got ${row10.status})`);
    ok(!JSON.parse(snapshotJson).terminalItems["10"], "B3: GITHUB.md nonterminal row evicts stale terminal cache");
    githubMd = "";
  }

  // C. A stale rendered payload returns immediately and starts exactly one
  // background refresh. This keeps the panel responsive on large batches.
  {
    _batchProgressCache.clear();
    _batchProgressRefreshes.clear();
    _graphqlCache.clear();
    ghCalls = [];
    delayGh = true;
    _batchProgressCache.set("terminal-proj", {
      ts: Date.now() - 60_000,
      data: { batch_number: 950, items: [{ issue_number: 10, status: "merged" }], summary: "1/1 merged", complete: true, completeConfirmed: true, batch_type: "code" },
    });

    const start = Date.now();
    const data = await getOrComputeBatchProgress("terminal-proj");
    const elapsed = Date.now() - start;
    ok(elapsed < 50, `C: stale cache returned immediately (${elapsed}ms)`);
    ok(data._stale === true && data._refreshing === true, "C: stale response is marked refreshing");
    ok(_batchProgressRefreshes.has("terminal-proj"), "C: background refresh started");

    const again = await getOrComputeBatchProgress("terminal-proj");
    ok(_batchProgressRefreshes.size === 1, "C: second stale poll did not start another refresh");
    ok(again._refreshing === true, "C: second stale poll still serves cache");

    await _batchProgressRefreshes.get("terminal-proj").promise;
    ok(!_batchProgressRefreshes.has("terminal-proj"), "C: refresh gate clears after completion");
    delayGh = false;
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
