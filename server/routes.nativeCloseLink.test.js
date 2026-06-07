// #951: batch-progress must link CLOSED issues to PRs via GitHub's native
// close-link, not only the `[#N]` title convention. It must also keep CLOSED
// issues terminal when lookup fails, and #950's terminal cache must stop
// repeated Search calls after a settled native-linked item is cached.
//
// Plain node:assert script — run with
// `node server/routes.nativeCloseLink.test.js`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

let searchMode = "empty";
let timelineMode = "native";
let prMode = "ok";
let ghCalls = [];
const realRunner = cp.execFile;
cp.execFile = function stubRunner(file, args, opts, cb) {
  const done = typeof opts === "function" ? opts : cb;
  if (file !== "gh" || typeof done !== "function") return realRunner.apply(this, arguments);
  ghCalls.push(args.slice());
  const target = args.find((a) => typeof a === "string" && a.startsWith("repos/"));
  const ok = (json) => done(null, { stdout: JSON.stringify(json), stderr: "" });
  setImmediate(() => {
    if (target === "repos/o/r/issues/488") {
      return ok({ number: 488, title: "native closed", state: "closed", html_url: "https://x/i/488" });
    }
    if (target && target.startsWith("repos/o/r/issues/488/timeline")) {
      if (timelineMode === "fail") return done(new Error("timeline failed"), "", "timeline failed");
      return ok([
        {
          event: "closed",
          source: {
            issue: {
              number: 491,
              pull_request: { url: "https://api.github.com/repos/o/r/pulls/491", html_url: "https://x/p/491" },
            },
          },
        },
      ]);
    }
    if (target === "repos/o/r/pulls/491") {
      if (prMode === "fail") return done(new Error("pr failed"), "", "pr failed");
      return ok({ number: 491, merged: true, html_url: "https://x/p/491" });
    }
    if (target === "repos/o/r/pulls/491/reviews?per_page=100") {
      return ok([]);
    }
    if (args.includes("search/issues")) {
      if (searchMode === "fail") return done(new Error("search failed"), "", "search failed");
      return ok({ items: [] });
    }
    return done(new Error(`unexpected gh call: ${args.join(" ")}`), "", "");
  });
};

const real = { readFileSync: fs.readFileSync };
let cfgJson = JSON.stringify({ projects: [] });
let queueText = "";
let snapshotJson = null;
fs.readFileSync = function stubReadFileSync(p, ...rest) {
  if (p === CONFIG_PATH) return cfgJson;
  if (typeof p === "string" && p.endsWith("OVERNIGHT-QUEUE.md")) return queueText;
  if (typeof p === "string" && p.endsWith("batch-progress-cache.json")) {
    if (snapshotJson !== null) return snapshotJson;
    const err = new Error("ENOENT (test stub)");
    err.code = "ENOENT";
    throw err;
  }
  if (typeof p === "string" && p.endsWith("GITHUB.md")) return "";
  return real.readFileSync(p, ...rest);
};
fs.writeFileSync = function stubWriteFileSync(p, data) {
  if (typeof p === "string" && p.endsWith("batch-progress-cache.json")) snapshotJson = String(data);
};
fs.mkdirSync = () => {};
fs.statSync = () => ({ mode: 0o700, isDirectory: () => true });
fs.renameSync = () => {};
fs.unlinkSync = () => { snapshotJson = null; };

const {
  getOrComputeBatchProgress,
  pickClosingPrFromTimeline,
  progressForItemRest,
  _batchProgressCache,
  _batchProgressRefreshes,
  _graphqlCache,
} = require("./routes");

function searchCalls() {
  return ghCalls.filter((args) => args.includes("search/issues"));
}

(async () => {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  {
    const n = pickClosingPrFromTimeline([
      { event: "commented" },
      { event: "closed", source: { issue: { number: 491, pull_request: { url: "https://api.github.com/repos/o/r/pulls/491" } } } },
    ]);
    ok(n === 491, "A: timeline closed event yields native closing PR number");
    ok(pickClosingPrFromTimeline([{ event: "closed", source: { issue: {} } }]) === null, "A: timeline without PR link → null");
  }

  {
    searchMode = "empty";
    timelineMode = "native";
    ghCalls = [];
    const row = await progressForItemRest("o/r", 488);
    ok(row.status === "merged" && row.pr_number === 491, "B: CLOSED issue + native close-link PR with no title match → Merged ✓");
    ok(searchCalls().length === 1, "B: title Search ran once before native fallback");
  }

  {
    searchMode = "fail";
    timelineMode = "fail";
    prMode = "ok";
    ghCalls = [];
    const row = await progressForItemRest("o/r", 488);
    ok(row.status === "closed", "C: CLOSED issue stays terminal when Search/timeline fail");
    ok(row.label === "Closed (no PR) ✓", "C: lookup failure degrades label, not terminal status");
  }

  {
    searchMode = "empty";
    timelineMode = "native";
    prMode = "fail";
    ghCalls = [];
    const row = await progressForItemRest("o/r", 488);
    ok(row.status === "closed", "C2: CLOSED issue stays terminal when linked PR fetch fails");
    prMode = "ok";
  }

  {
    searchMode = "empty";
    timelineMode = "native";
    ghCalls = [];
    snapshotJson = null;
    _batchProgressCache.clear();
    _batchProgressRefreshes.clear();
    _graphqlCache.clear();
    cfgJson = JSON.stringify({ projects: [{ id: "native-proj", repo: "o/r", idle: false }] });
    queueText = "# Queue\n\n## Active Batch\n\n**Batch:** 951\n\n- #488 native link\n";
    _graphqlCache.set("o/r", { ts: Date.now(), issues: [], prs: [], closedIssues: [], mergedPrs: [] });

    const first = await getOrComputeBatchProgress("native-proj");
    ok(first.items[0].status === "merged" && first.items[0].pr_number === 491, "D: first compute resolves native-linked merged PR");
    ok(searchCalls().length === 1, "D: first compute did one Search");

    ghCalls = [];
    _batchProgressCache.clear();
    const second = await getOrComputeBatchProgress("native-proj");
    ok(second.items[0].status === "merged" && second.items[0].pr_number === 491, "D: second compute stays merged from terminal cache");
    ok(searchCalls().length === 0, "D: terminal cache prevents repeated Search calls after native-linked item is settled");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
