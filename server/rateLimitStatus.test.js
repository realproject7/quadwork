"use strict";

// #1187: when `gh api rate_limit` fails, the GitHub header badge must show an
// unknown state, not the server's default 5000/5000 budget. This drives the
// real /api/github/rate-limit handler with a failing, then succeeding, then
// failing gh fixture and feeds every response to the same predicates that
// GitHubRateLimitBadge renders from, so the server fields and the badge's
// reading of them are checked against each other.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

let ghFails = true;
const nowSec = Math.floor(Date.now() / 1000);
const RATE_JSON = JSON.stringify({
  core: { limit: 5000, remaining: 4321, reset: nowSec + 3600 },
  graphql: { limit: 5000, remaining: 3999, reset: nowSec + 3600 },
  search: { limit: 30, remaining: 29, reset: nowSec + 60 },
});
require("./__tests__/resource-executor-fixture").installResourceExecutorFixture({
  runControlChild: (command, args) => {
    if (command === "gh" && Array.isArray(args) && args.includes("rate_limit")) {
      return ghFails
        ? Promise.reject(new Error("gh: not logged in (test fixture)"))
        : Promise.resolve({ stdout: RATE_JSON, stderr: "" });
    }
    return Promise.reject(new Error(`unexpected control child in test: ${command}`));
  },
});

// Never read the operator's ~/.quadwork: a fixed config, and a reviewer token
// that exists only while a scenario sets it.
const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const TOKEN_PATH = path.join(os.homedir(), ".quadwork", "reviewer-token");
let reviewerToken = null;
const realRead = fs.readFileSync;
fs.readFileSync = function stubRead(p, ...rest) {
  if (p === CONFIG_PATH) return JSON.stringify({ projects: [] });
  if (p === TOKEN_PATH && reviewerToken !== null) return reviewerToken;
  if (typeof p === "string" && (p === TOKEN_PATH || p.endsWith("reviewer-token"))) {
    const err = new Error("ENOENT (test stub)");
    err.code = "ENOENT";
    throw err;
  }
  return realRead.call(this, p, ...rest);
};

const routes = require("./routes");
const { mainRateLimitKnown, reviewerRateLimitKnown } = require("../src/lib/rateLimitStatus");

const layer = routes.stack.find((l) => l.route && l.route.path === "/api/github/rate-limit");
assert.ok(layer, "the rate-limit route is registered");
async function getRateLimit() {
  let body;
  await layer.route.stack[0].handle({ query: {} }, { json: (b) => { body = b; } });
  return body;
}

let passed = 0;
const pass = (message) => { passed++; console.log(`  PASS: ${message}`); };

(async () => {
  // The module-load refresh runs with the failing fixture.
  await new Promise((resolve) => setTimeout(resolve, 50));

  let body = await getRateLimit();
  assert.ok(body.error, "the failed lookup is reported");
  assert.equal(body.core.remaining, 5000, "the server still carries its default budget");
  assert.equal(body.core.limit, 5000);
  assert.equal(mainRateLimitKnown(body), false);
  assert.equal("reviewer" in body, false, "no reviewer token, no reviewer block");
  pass("a failed first lookup reads as unknown, not the 5000/5000 default");

  ghFails = false;
  await routes.refreshRateLimit();
  body = await getRateLimit();
  assert.equal(body.error, null);
  assert.equal(mainRateLimitKnown(body), true);
  assert.equal(body.core.remaining, 4321);
  assert.equal(body.graphql.remaining, 3999);
  pass("a successful lookup reads as known with the real budget");

  ghFails = true;
  await routes.refreshRateLimit();
  body = await getRateLimit();
  assert.equal(body.core.remaining, 4321, "the server keeps the last values after a failure");
  assert.equal(mainRateLimitKnown(body), false);
  pass("a later failed lookup reads as unknown instead of the last values");

  assert.equal(mainRateLimitKnown({ error: null, updatedAt: 0, core: { limit: 5000, remaining: 5000 } }), false);
  assert.equal(mainRateLimitKnown(null), false);
  pass("a lookup that has not run yet reads as unknown");

  // Reviewer account: its own token and its own lookup.
  reviewerToken = "placeholder-not-a-token\n";
  ghFails = false;
  body = await getRateLimit();
  assert.equal(reviewerRateLimitKnown(body.reviewer), true);
  assert.equal(body.reviewer.graphql.remaining, 3999);
  pass("a successful reviewer lookup reads as known");

  // Each reviewer re-poll below happens after the 60s per-token cache window.
  const realNow = Date.now;
  const getRateLimitAfter = async (offsetMs) => {
    Date.now = () => realNow() + offsetMs;
    try { return await getRateLimit(); } finally { Date.now = realNow; }
  };

  ghFails = true;
  body = await getRateLimitAfter(61_000);
  assert.equal(body.reviewer.error, true);
  assert.equal("graphql" in body.reviewer, false, "the retained buckets are not sent as current");
  assert.equal(reviewerRateLimitKnown(body.reviewer), false);
  pass("a failed reviewer lookup reads as unknown instead of the last values");

  reviewerToken = null;
  body = await getRateLimitAfter(122_000);
  assert.equal("reviewer" in body, false);
  pass("removing the reviewer token drops the reviewer block");

  console.log(`\n${passed} passed, 0 failed\n`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
