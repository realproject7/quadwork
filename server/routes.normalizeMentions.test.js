// #788: normalizeMentions(text, skipName) tests. Plain node:assert script —
// no test runner is wired up. Run with
// `node server/routes.normalizeMentions.test.js`.
//
// normalizeMentions is re-exported from server/routes.js (#693).

const assert = require("node:assert/strict");
const { normalizeMentions } = require("./routes");

// 1) #788: an agent's own name is NOT converted to a self-mention.
{
  assert.equal(
    normalizeMentions("head received the batch request", "head"),
    "head received the batch request",
    "sender's own bare name is left untouched",
  );
}

// 2) #788: OTHER agent names are still converted when a sender is skipped.
{
  assert.equal(
    normalizeMentions("dev will notify head and re1", "dev"),
    "dev will notify @head and @re1",
    "non-sender names still normalize; only the sender is skipped",
  );
}

// 3) No skipName (user / bridge sender) → every name normalizes, including head.
{
  assert.equal(
    normalizeMentions("head and dev please review", null),
    "@head and @dev please review",
    "user/bridge messages normalize all names",
  );
  assert.equal(
    normalizeMentions("head and dev please review"),
    "@head and @dev please review",
    "omitted skipName behaves like the legacy single-arg call",
  );
}

// 4) Already-prefixed mentions are not doubled, even for the sender.
{
  assert.equal(
    normalizeMentions("@head done; pinging dev", "head"),
    "@head done; pinging @dev",
    "existing @mention preserved; other name still normalized",
  );
}

// 5) Code spans are still preserved (skipName path keeps the guard).
{
  assert.equal(
    normalizeMentions("ran `git checkout head` then told dev", "re1"),
    "ran `git checkout head` then told @dev",
    "names inside code spans are not touched",
  );
}

console.log("routes.normalizeMentions.test.js: all assertions passed (5 cases)");
process.exit(0);
