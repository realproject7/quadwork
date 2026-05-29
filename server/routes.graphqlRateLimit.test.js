// #802: GraphQL rate-limit predicate tests. Plain node:assert script — no
// test runner is wired up. Run with
// `node server/routes.graphqlRateLimit.test.js`.
//
// _graphqlRateLimit / isGraphqlRateLimited / isGraphqlRateLow are re-exported
// from server/routes.js strictly for this test. The predicates gate the
// GraphQL background poller and the /api/batch-progress GraphQL query on the
// SEPARATE GraphQL budget (REST and GraphQL are independent at GitHub).

const assert = require("node:assert/strict");
const { _graphqlRateLimit, isGraphqlRateLimited, isGraphqlRateLow } = require("./routes");

function setRemaining(n) {
  _graphqlRateLimit.remaining = n;
}

// Thresholds mirror the REST side: LOW = 200, CRITICAL = 50.

// 1) Full budget → neither low nor limited.
{
  setRemaining(5000);
  assert.equal(isGraphqlRateLow(), false, "5000 remaining is not low");
  assert.equal(isGraphqlRateLimited(), false, "5000 remaining is not critical");
}

// 2) Below LOW (200) but above CRITICAL (50) → low only.
{
  setRemaining(150);
  assert.equal(isGraphqlRateLow(), true, "150 remaining is low");
  assert.equal(isGraphqlRateLimited(), false, "150 remaining is not yet critical");
}

// 3) Below CRITICAL (50) → both low and limited (background AND on-demand stop).
{
  setRemaining(10);
  assert.equal(isGraphqlRateLow(), true, "10 remaining is low");
  assert.equal(isGraphqlRateLimited(), true, "10 remaining is critical");
}

// 4) Exhausted (0) → both true.
{
  setRemaining(0);
  assert.equal(isGraphqlRateLow(), true, "0 remaining is low");
  assert.equal(isGraphqlRateLimited(), true, "0 remaining is critical");
}

// 5) Boundary: exactly at the thresholds (strict < comparison).
{
  setRemaining(200);
  assert.equal(isGraphqlRateLow(), false, "exactly 200 is NOT low (strict <)");
  setRemaining(50);
  assert.equal(isGraphqlRateLimited(), false, "exactly 50 is NOT critical (strict <)");
}

// 6) GraphQL bucket is independent of REST: this object is a distinct bucket,
//    so draining GraphQL here cannot reflect REST state.
{
  setRemaining(0);
  assert.equal(isGraphqlRateLimited(), true, "GraphQL critical reflects only the GraphQL bucket");
}

console.log("routes.graphqlRateLimit.test.js: all assertions passed (6 cases)");
process.exit(0);
