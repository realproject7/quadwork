// #1050: review progression is read from the live Active Batch only.

const assert = require("assert");
const { resolveDisplayedBatch } = require("./routes");

const snapshot = {
  batchNumber: 12,
  issueNumbers: [101, 102, 999],
  batch_type: "ticket-review",
  reviewItems: [
    { issue: 101, review_state: "queued", approvals: 0 },
    { issue: 102, review_state: "queued", approvals: 0 },
    { issue: 999, review_state: "approved", approvals: 2 },
  ],
};
const options = { _readSnapshot: () => snapshot, _writeSnapshot: () => {} };

function queue(lines) {
  return [
    "## Active Batch",
    "**Batch:** 12",
    "**Batch type:** ticket-review",
    ...lines,
    "",
    "## Done",
    "- #999 — approved",
  ].join("\n");
}

const inReview = resolveDisplayedBatch(queue([
  "- #101 — in-review (1/2)",
  "- #102 — queued",
]), "review-live", options);
assert.deepEqual(inReview.issueNumbers, [101, 102]);
assert.deepEqual(inReview.reviewItems.map((item) => item.review_state), ["in-review", "queued"]);

const approved = resolveDisplayedBatch(queue([
  "- #101 — approved",
  "- #102 — approved",
]), "review-live", options);
assert.deepEqual(approved.reviewItems.map((item) => item.review_state), ["approved", "approved"],
  "in-place states come from the fresh live parse");

const reduced = resolveDisplayedBatch(queue([
  "- #102 — in-review (1/2)",
]), "review-live", options);
assert.deepEqual(reduced.issueNumbers, [102], "snapshot cannot restore an item moved out of Active Batch");
assert.equal(reduced.reviewItems[0].review_state, "in-review");

const cleared = resolveDisplayedBatch(queue([]), "review-live", options);
assert.equal(cleared.batchNumber, null);
assert.deepEqual(cleared.issueNumbers, [], "snapshot and Done cannot resurrect a cleared review batch");

const code = resolveDisplayedBatch([
  "## Active Batch",
  "**Batch:** 13",
  "- #201 work",
].join("\n"), "code-live", options);
assert.equal(code.batch_type, "code");
assert.deepEqual(code.issueNumbers, [201]);

console.log("routes.reviewBatchProgression.test.js: all assertions passed");
