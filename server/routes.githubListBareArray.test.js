// #824 (#806 follow-up): the four GitHub list endpoints
// (/api/github/{issues,prs,closed-issues,merged-prs}) cache a BARE ARRAY as
// cached.data. The stale + rate-limited paths used to return
// `{ ...cached.data, _stale: true }` — spreading an array yields
// {"0":…,"1":…,"_stale":true}, an OBJECT, which trips GitHubPanel's
// `Array.isArray(data)` guard and silently blanks the board exactly during the
// rate-limit / stale-revalidate window when it should serve last-known data.
//
// This regression locks the contract: the body stays a JSON array on every
// path; stale/rate-limited state is signalled via response HEADERS
// (X-QuadWork-Stale / X-QuadWork-Rate-Limited), mirroring X-QuadWork-Idle.
//
// Plain node:assert script — no test runner is wired up. Run with
// `node server/routes.githubListBareArray.test.js`.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

// Feed getRepo()/isProjectIdle() a fixed config WITHOUT touching the real
// ~/.quadwork/config.json. routes.js holds the shared `fs` module object
// (const fs = require("fs")), so patching readFileSync here patches its calls.
const FAKE_CONFIG = JSON.stringify({
  projects: [{ id: "proj", repo: "owner/repo", idle: false }],
});
const realReadFileSync = fs.readFileSync;
fs.readFileSync = (p, ...rest) =>
  p === CONFIG_PATH ? FAKE_CONFIG : realReadFileSync(p, ...rest);

const routes = require("./routes");
const { serveGithubList, _ghEndpointCache, _rateLimit } = routes;

const CACHE_KEY = "issues:owner/repo";
const REPO_ARRAY = [
  { number: 1, title: "open issue", state: "OPEN", assignees: [], url: "u1" },
];

// GitHubPanel.tsx:191 (verbatim) — the guard that drops a non-array payload.
function panelAccepts(data) {
  return Array.isArray(data);
}

function mockRes() {
  const res = { headers: {}, body: undefined, statusCode: 200 };
  res.set = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const REQ = { query: { project: "proj" } };

async function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // 0) Document the bug: spreading the bare array produces an OBJECT that the
  //    GitHubPanel guard rejects — i.e. the board would go empty.
  {
    const buggy = { ...REPO_ARRAY, _stale: true };
    ok(!Array.isArray(buggy), "spreading a bare array yields a NON-array (the #824 bug)");
    ok(!panelAccepts(buggy), "GitHubPanel guard would DROP the spread object → blank board");
    ok(panelAccepts(REPO_ARRAY), "GitHubPanel guard accepts a bare array");
  }

  // 1) Fresh cache hit → bare array, no staleness header.
  {
    _rateLimit.remaining = 5000;
    _ghEndpointCache.set(CACHE_KEY, { ts: Date.now(), data: REPO_ARRAY, stale: false });
    const res = mockRes();
    await serveGithubList(REQ, res, "issues");
    ok(Array.isArray(res.body), "fresh: body is a JSON array");
    ok(res.body.length === 1 && res.body[0].number === 1, "fresh: serves every cached row");
    ok(res.body[0].repo_key === "primary" && res.body[0].repo === "owner/repo", "fresh: adds project repository identity");
    ok(!res.headers["x-quadwork-stale"], "fresh: no X-QuadWork-Stale header");
    ok(panelAccepts(res.body), "fresh: GitHubPanel renders last-known data");
  }

  // 2) In-TTL but flagged stale → bare array + X-QuadWork-Stale header.
  {
    _rateLimit.remaining = 5000;
    _ghEndpointCache.set(CACHE_KEY, { ts: Date.now(), data: REPO_ARRAY, stale: true });
    const res = mockRes();
    await serveGithubList(REQ, res, "issues");
    ok(Array.isArray(res.body), "stale-flag: body is a JSON array (not spread into an object)");
    ok(res.headers["x-quadwork-stale"] === "1", "stale-flag: signalled via X-QuadWork-Stale header");
    ok(panelAccepts(res.body), "stale-flag: GitHubPanel still renders last-known data");
  }

  // 3) REST-rate-limited window, cache still within base TTL → bare array +
  //    X-QuadWork-Rate-Limited, but NOT flagged stale (data is genuinely fresh).
  {
    _rateLimit.remaining = 0; // < RATE_LIMIT_CRITICAL → isRateLimited()
    _ghEndpointCache.set(CACHE_KEY, { ts: Date.now(), data: REPO_ARRAY, stale: false });
    const res = mockRes();
    await serveGithubList(REQ, res, "issues");
    ok(Array.isArray(res.body), "rate-limited (fresh): body is a JSON array");
    ok(res.headers["x-quadwork-rate-limited"] === "1", "rate-limited (fresh): X-QuadWork-Rate-Limited header set");
    ok(!res.headers["x-quadwork-stale"], "rate-limited (fresh): not flagged stale while within base TTL");
    ok(panelAccepts(res.body), "rate-limited (fresh): GitHubPanel renders last-known data during the window");
  }

  // 4) RE1 #829: critical rate-limit + EXPIRED cached array + stale:false.
  //    adaptiveTTL is Infinity here, so the rate-limited branch MUST run before
  //    the adaptive cache-hit branch — otherwise the expired array goes out with
  //    no headers. Expect a bare array + BOTH headers.
  {
    _rateLimit.remaining = 0;
    // ts well past GH_ENDPOINT_CACHE_TTL (base ~30s) → expired.
    _ghEndpointCache.set(CACHE_KEY, { ts: Date.now() - 10 * 60 * 1000, data: REPO_ARRAY, stale: false });
    const res = mockRes();
    await serveGithubList(REQ, res, "issues");
    ok(Array.isArray(res.body), "rate-limited (expired): body is a JSON array (not blanked, not spread)");
    ok(res.headers["x-quadwork-rate-limited"] === "1", "rate-limited (expired): X-QuadWork-Rate-Limited header set");
    ok(res.headers["x-quadwork-stale"] === "1", "rate-limited (expired): X-QuadWork-Stale header set");
    ok(panelAccepts(res.body), "rate-limited (expired): GitHubPanel renders last-known data");
  }

  // 5) Rate-limited AND flagged stale → bare array + both headers.
  {
    _rateLimit.remaining = 0;
    _ghEndpointCache.set(CACHE_KEY, { ts: Date.now(), data: REPO_ARRAY, stale: true });
    const res = mockRes();
    await serveGithubList(REQ, res, "issues");
    ok(Array.isArray(res.body), "rate-limited+stale: body is a JSON array");
    ok(res.headers["x-quadwork-rate-limited"] === "1", "rate-limited+stale: X-QuadWork-Rate-Limited header set");
    ok(res.headers["x-quadwork-stale"] === "1", "rate-limited+stale: X-QuadWork-Stale header set");
    ok(panelAccepts(res.body), "rate-limited+stale: GitHubPanel renders last-known data");
  }

  // 6) Source guard — covers EVERY branch (incl. stale-while-revalidate, which
  //    fires a background refresh and so isn't exercised behaviourally here):
  //    serveGithubList must never spread cached.data, and must use the headers.
  {
    const src = realReadFileSync(path.join(__dirname, "routes.js"), "utf-8");
    const start = src.indexOf("async function serveGithubList(");
    const end = src.indexOf("\n}", start);
    const fnBody = src.slice(start, end);
    const headerStart = src.indexOf("function setGithubRepositoryHeaders(");
    const headerEnd = src.indexOf("\n}\n", headerStart);
    const headerBody = src.slice(headerStart, headerEnd);
    ok(!fnBody.includes("{ ...cached.data"), "serveGithubList never spreads cached.data into an object");
    ok(headerBody.includes('res.set("X-QuadWork-Stale"'), "serveGithubList signals stale via X-QuadWork-Stale header");
    ok(headerBody.includes('res.set("X-QuadWork-Rate-Limited"'), "serveGithubList signals rate-limit via X-QuadWork-Rate-Limited header");
  }

  fs.readFileSync = realReadFileSync;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
