"use strict";

// #1187: /api/github/rate-limit starts with full default budgets (5000/5000)
// and keeps them, or the last real values, when `gh api rate_limit` fails; the
// failure is reported in `error`. The GitHub header badge shows a budget only
// when the latest lookup succeeded, and an unknown state otherwise. Plain JS so
// the Next.js badge and `node server/run-tests.js` share one definition.

function mainRateLimitKnown(payload) {
  return !!payload && !payload.error && Number(payload.updatedAt) > 0;
}

// The reviewer block carries `error: true` when its latest lookup failed.
function reviewerRateLimitKnown(reviewer) {
  return !!reviewer && !reviewer.error;
}

module.exports = { mainRateLimitKnown, reviewerRateLimitKnown };
