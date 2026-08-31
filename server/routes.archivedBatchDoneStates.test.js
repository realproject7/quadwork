// #1050: Done/history and persisted progress rows are never Current Batch
// authority. Plain node:assert script.

const assert = require("assert");
const { resolveDisplayedBatch } = require("./routes");

function archivedQueue() {
  return [
    "# Overnight Queue",
    "",
    "## Active Batch",
    "",
    "(none)",
    "",
    "## Holds",
    "",
    "- #370 — held",
    "",
    "## Done",
    "",
    "**Batch:** 139",
    "**Batch type:** ticket-review",
    "- #589 — approved",
  ].join("\n");
}

const stickySnapshot = {
  batchNumber: 139,
  issueNumbers: [589, 370],
  batch_type: "ticket-review",
  reviewItems: [
    { issue: 589, review_state: "approved", approvals: 2 },
    { issue: 370, review_state: "in-review", approvals: 1 },
  ],
};

const empty = resolveDisplayedBatch(archivedQueue(), "batch-139", {
  _readSnapshot: () => stickySnapshot,
  _writeSnapshot: () => { throw new Error("history residue must not be republished"); },
});
assert.deepEqual(empty, {
  batchNumber: null,
  issueNumbers: [],
  batch_type: "code",
  reviewItems: [],
});

const metadataOnly = resolveDisplayedBatch([
  "## Active Batch",
  "**Batch:** 139",
  "**Batch type:** ticket-review",
  "",
  "## Done",
  "- #589 — approved",
].join("\n"), "batch-139-metadata", { _readSnapshot: () => stickySnapshot });
assert.equal(metadataOnly.batchNumber, null, "metadata without a live item is not a Current Batch");
assert.deepEqual(metadataOnly.issueNumbers, []);

const live = resolveDisplayedBatch([
  "## Active Batch",
  "**Batch:** 140",
  "**Batch type:** ticket-review",
  "- #600 — in-review (1/2)",
  "",
  "## Done",
  "**Batch:** 139",
  "- #589 — approved",
].join("\n"), "batch-140", { _readSnapshot: () => stickySnapshot });
assert.equal(live.batchNumber, 140);
assert.deepEqual(live.issueNumbers, [600], "only the live Active Batch item is current");
assert.equal(live.reviewItems[0].review_state, "in-review");

const unreadable = resolveDisplayedBatch("", "missing-queue", {
  queueReadOk: false,
  _readSnapshot: () => stickySnapshot,
});
assert.equal(unreadable.batchNumber, null);
assert.deepEqual(unreadable.issueNumbers, []);

console.log("routes.archivedBatchDoneStates.test.js: all assertions passed");
