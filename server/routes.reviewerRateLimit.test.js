// #886: reviewer-token rate-limit poll tests. Verifies the second exempt
// `gh api rate_limit` poll runs as the reviewer token, exposes a `reviewer`
// payload (separate per-account budget), and is omitted on single-account
// setups. Plain node:assert script (run with `node ...`).
//
// Stubs child_process.execFile (so the gh call is observable + the GH_TOKEN env
// is captured) and fs.readFileSync (config + token file) BEFORE require.

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const FAKE_TOKEN_PATH = "/tmp/__reviewer_token_test__";

const nowSec = Math.floor(Date.now() / 1000);
const RATE_JSON = JSON.stringify({
  core: { limit: 5000, remaining: 4000, reset: nowSec + 3600 },
  graphql: { limit: 5000, remaining: 37, reset: nowSec + 3600 },
  search: { limit: 30, remaining: 30, reset: nowSec + 60 },
});

let capturedEnvToken = null;
let reviewerPollCalls = 0; // counts ONLY reviewer polls (those carrying GH_TOKEN)
function handleGh(file, args, options) {
  // Serves any `gh api rate_limit` (incl. the module-load main poll). Counts
  // only the reviewer poll, distinguished by the GH_TOKEN env it sets — the
  // main poll carries no env, so it never affects reviewerPollCalls.
  if (file === "gh" && Array.isArray(args) && args.includes("rate_limit")) {
    if (options && options.env && options.env.GH_TOKEN) {
      reviewerPollCalls++;
      capturedEnvToken = options.env.GH_TOKEN;
    }
    return { stdout: RATE_JSON, stderr: "" };
  }
  return null;
}
const realExecFile = cp.execFile;
function stub(file, args, opts, cb) {
  const done = typeof opts === "function" ? opts : cb;
  const options = typeof opts === "function" ? {} : opts || {};
  const res = handleGh(file, args, options);
  if (res) return done(null, res.stdout, res.stderr);
  return realExecFile.apply(this, arguments);
}
// routes.js uses util.promisify(execFile), which resolves via execFile's custom
// promisify symbol to { stdout, stderr }. Replicate that so the awaited result
// destructures `stdout` correctly (a plain callback stub would resolve to a
// bare string and break JSON.parse).
stub[util.promisify.custom] = (file, args, options) => {
  const res = handleGh(file, args, options);
  if (res) return Promise.resolve(res);
  return Promise.reject(new Error(`unexpected execFile in test: ${file} ${(args || []).join(" ")}`));
};
cp.execFile = stub;

// fs stubs are swapped per-scenario via these mutable refs.
let configJson = "{}";
let tokenFileContent = null; // null → ENOENT
const realRead = fs.readFileSync;
fs.readFileSync = function stubRead(p, ...rest) {
  if (p === CONFIG_PATH) return configJson;
  if (p === FAKE_TOKEN_PATH || (typeof p === "string" && p.endsWith("reviewer-token"))) {
    if (tokenFileContent === null) {
      const err = new Error("ENOENT (test stub)");
      err.code = "ENOENT";
      throw err;
    }
    return tokenFileContent;
  }
  return realRead(p, ...rest);
};

const { refreshReviewerRateLimit, reviewerRateLimitPayload } = require("./routes");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

(async () => {
  console.log("\n--- #886 reviewer-account rate-limit tests ---\n");

  // Let the module-load startRateLimitPolling() → refreshRateLimit() chain
  // (kicked off with the initial EMPTY config, so it fires no reviewer poll)
  // fully settle before we mutate the fixtures — otherwise its trailing
  // refreshReviewerRateLimit could read scenario A's token and race the counter.
  await new Promise((r) => setTimeout(r, 100));

  // ── A. Reviewer token configured → polled as the reviewer, payload present ─
  {
    capturedEnvToken = null;
    reviewerPollCalls = 0;
    configJson = JSON.stringify({ reviewer_token_path: FAKE_TOKEN_PATH, reviewer_github_user: "project7-interns" });
    tokenFileContent = "ghp_reviewerfaketoken\n";

    await refreshReviewerRateLimit();
    const payload = reviewerRateLimitPayload();

    ok(reviewerPollCalls === 1, `A: ran exactly one reviewer rate_limit poll (got ${reviewerPollCalls})`);
    ok(capturedEnvToken === "ghp_reviewerfaketoken", "A: poll used the reviewer token via GH_TOKEN env (trimmed)");
    ok(payload !== null, "A: reviewer payload present when a token is configured");
    ok(payload.login === "project7-interns", "A: payload login from cfg.reviewer_github_user");
    ok(payload.graphql && payload.graphql.remaining === 37, "A: reviewer graphql bucket surfaced (the at-risk budget)");
    ok(payload.core && payload.core.remaining === 4000, "A: reviewer core bucket surfaced");
    ok(typeof payload.graphql.resetInMinutes === "number", "A: bucketView shape (resetInMinutes) applied");
  }

  // ── B. No reviewer token (file missing) → payload null (single-account) ───
  {
    reviewerPollCalls = 0;
    configJson = "{}";
    tokenFileContent = null; // ENOENT

    await refreshReviewerRateLimit();
    ok(reviewerRateLimitPayload() === null, "B: no reviewer token → payload null (single-account, no regression)");
    ok(reviewerPollCalls === 0, "B: no reviewer token → NO second gh poll fired");
  }

  // ── C. Empty token file → treated as not configured ──────────────────────
  {
    reviewerPollCalls = 0;
    configJson = JSON.stringify({ reviewer_token_path: FAKE_TOKEN_PATH });
    tokenFileContent = "   \n";

    await refreshReviewerRateLimit();
    ok(reviewerRateLimitPayload() === null, "C: empty token file → payload null");
    ok(reviewerPollCalls === 0, "C: empty token → NO gh poll");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
