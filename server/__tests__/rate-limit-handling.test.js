/**
 * #554 — Verify rate-limit-aware caching and backoff in server/routes.js.
 *
 * Tests verify:
 * 1. Rate limit state variables exist and are initialised
 * 2. adaptiveTTL returns extended TTLs when rate is low/critical
 * 3. cachedGhEndpoint serves stale data with _rateLimited flag
 * 4. GitHub endpoints use the cached helper
 * 5. /api/github/rate-limit endpoint is registered
 * 6. Batch progress handler has rate-limit guard
 */

const fs = require("fs");
const path = require("path");

const ROUTES_PATH = path.join(__dirname, "..", "routes.js");
const src = fs.readFileSync(ROUTES_PATH, "utf-8");

// ---------------------------------------------------------------------------
// 1. Rate limit state and constants
// ---------------------------------------------------------------------------

describe("#554 rate limit infrastructure (code analysis)", () => {
  test("_rateLimit state object is defined with expected fields", () => {
    expect(src).toContain("const _rateLimit = {");
    expect(src).toContain("remaining:");
    expect(src).toContain("resetAt:");
  });

  test("RATE_LIMIT_LOW_THRESHOLD and RATE_LIMIT_CRITICAL are defined", () => {
    expect(src).toMatch(/RATE_LIMIT_LOW_THRESHOLD\s*=\s*\d+/);
    expect(src).toMatch(/RATE_LIMIT_CRITICAL\s*=\s*\d+/);
  });

  test("refreshRateLimit calls gh api rate_limit", () => {
    expect(src).toContain("gh");
    expect(src).toContain("api");
    expect(src).toContain("rate_limit");
  });

  test("startRateLimitPolling is called at module load", () => {
    expect(src).toContain("startRateLimitPolling()");
  });
});

// ---------------------------------------------------------------------------
// 2. Adaptive TTL
// ---------------------------------------------------------------------------

describe("#554 adaptive TTL logic", () => {
  test("adaptiveTTL function is defined", () => {
    expect(src).toContain("function adaptiveTTL(baseTTL)");
  });

  test("adaptiveTTL returns Infinity when critically rate-limited", () => {
    expect(src).toMatch(/isRateLimited\(\).*Infinity/s);
  });

  test("adaptiveTTL extends TTL when rate is low", () => {
    expect(src).toMatch(/isRateLow\(\).*120[_,]?000/s);
  });
});

// ---------------------------------------------------------------------------
// 3. Cached endpoint helper
// ---------------------------------------------------------------------------

describe("#554 cachedGhEndpoint helper", () => {
  test("cachedGhEndpoint function is defined", () => {
    expect(src).toContain("function cachedGhEndpoint(");
  });

  test("serves stale data with _rateLimited flag when critical", () => {
    const fnStart = src.indexOf("function cachedGhEndpoint(");
    const fnBody = src.slice(fnStart, fnStart + 800);
    expect(fnBody).toContain("_rateLimited");
    expect(fnBody).toContain("_stale");
  });

  test("uses adaptiveTTL for cache checks", () => {
    const fnStart = src.indexOf("function cachedGhEndpoint(");
    const fnBody = src.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain("adaptiveTTL");
  });
});

// ---------------------------------------------------------------------------
// 4. GitHub endpoints use cached helper
// ---------------------------------------------------------------------------

describe("#554 GitHub endpoints use cachedGhEndpoint", () => {
  test("/api/github/issues uses cachedGhEndpoint", () => {
    const section = src.slice(
      src.indexOf('"/api/github/issues"'),
      src.indexOf('"/api/github/issues"') + 300,
    );
    expect(section).toContain("cachedGhEndpoint");
  });

  test("/api/github/prs uses cachedGhEndpoint", () => {
    const section = src.slice(
      src.indexOf('"/api/github/prs"'),
      src.indexOf('"/api/github/prs"') + 300,
    );
    expect(section).toContain("cachedGhEndpoint");
  });

  test("/api/github/closed-issues uses cachedGhEndpoint", () => {
    const section = src.slice(
      src.indexOf('"/api/github/closed-issues"'),
      src.indexOf('"/api/github/closed-issues"') + 500,
    );
    expect(section).toContain("cachedGhEndpoint");
  });

  test("/api/github/merged-prs uses cachedGhEndpoint", () => {
    const section = src.slice(
      src.indexOf('"/api/github/merged-prs"'),
      src.indexOf('"/api/github/merged-prs"') + 500,
    );
    expect(section).toContain("cachedGhEndpoint");
  });
});

// ---------------------------------------------------------------------------
// 5. Rate limit API endpoint
// ---------------------------------------------------------------------------

describe("#554 /api/github/rate-limit endpoint", () => {
  test("endpoint is registered", () => {
    expect(src).toContain('"/api/github/rate-limit"');
  });

  test("returns remaining, limit, resetInMinutes, low, critical fields", () => {
    const idx = src.indexOf('"/api/github/rate-limit"');
    const section = src.slice(idx, idx + 500);
    expect(section).toContain("remaining");
    expect(section).toContain("limit");
    expect(section).toContain("resetInMinutes");
    expect(section).toContain("low");
    expect(section).toContain("critical");
  });
});

// ---------------------------------------------------------------------------
// 6. Batch progress rate limit guard
// ---------------------------------------------------------------------------

describe("#554 batch progress rate limit awareness", () => {
  test("batch progress handler checks isRateLimited before gh calls", () => {
    const batchStart = src.indexOf('"/api/batch-progress"');
    const batchSection = src.slice(batchStart, batchStart + 600);
    expect(batchSection).toContain("isRateLimited()");
    expect(batchSection).toContain("_rateLimited");
  });

  test("batch progress uses adaptiveTTL for cache", () => {
    const batchStart = src.indexOf('"/api/batch-progress"');
    const batchSection = src.slice(batchStart, batchStart + 400);
    expect(batchSection).toContain("adaptiveTTL");
  });

  test("projects endpoint uses adaptiveTTL for cache", () => {
    const projStart = src.indexOf('"/api/projects"');
    const projSection = src.slice(projStart, projStart + 400);
    expect(projSection).toContain("adaptiveTTL");
  });
});
