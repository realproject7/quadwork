// #806: regression test for the cold-cache refresh race (re1 review on #818).
// On first load GitHubPanel fires the four /api/github list endpoints in
// parallel. The earlier refreshRepoRest skipped (returned immediately) when a
// refresh was already in flight, so the parallel callers raced ahead of the
// populated cache and 502'd. _coalesce makes concurrent callers await the SAME
// in-flight pass. Plain node:assert script.

const assert = require("node:assert/strict");
const { _coalesce } = require("./routes");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

(async () => {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // 1) N concurrent callers for the same key → fn runs ONCE, all share result.
  {
    const map = new Map();
    let calls = 0;
    const gate = deferred();
    const fn = () => { calls++; return gate.promise.then(() => ({ value: 42 })); };

    const callers = [1, 2, 3, 4].map(() => _coalesce(map, "repo", fn));
    ok(calls === 1, "fn invoked exactly once for 4 concurrent callers");
    ok(map.has("repo"), "in-flight promise is registered while pending");

    gate.resolve();
    const results = await Promise.all(callers);
    ok(results.every((r) => r.value === 42), "all 4 callers resolve to the same result");
    ok(!map.has("repo"), "map entry cleared after the pass settles");
  }

  // 2) A fresh call AFTER settle starts a new pass (no permanently-cached promise).
  {
    const map = new Map();
    let calls = 0;
    const fn = () => { calls++; return Promise.resolve("x"); };
    await _coalesce(map, "k", fn);
    await _coalesce(map, "k", fn);
    ok(calls === 2, "sequential (post-settle) calls each start a fresh pass");
  }

  // 3) Different keys do not coalesce into each other.
  {
    const map = new Map();
    let a = 0, b = 0;
    const g = deferred();
    _coalesce(map, "a", () => { a++; return g.promise; });
    _coalesce(map, "b", () => { b++; return g.promise; });
    ok(a === 1 && b === 1, "distinct keys each get their own pass");
    g.resolve();
    await Promise.resolve();
  }

  // 4) A throwing/rejecting pass still clears the in-flight entry (no stuck key).
  {
    const map = new Map();
    let threw = false;
    try {
      await _coalesce(map, "k", async () => { throw new Error("boom"); });
    } catch { threw = true; }
    ok(threw, "rejection propagates to the caller");
    ok(!map.has("k"), "map entry cleared even when the pass rejects");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
