"use strict";

const assert = require("node:assert/strict");
const {
  _batchRequestReaderInput,
  _batchRequestIssueRows,
  batchRequestRefreshProjectIds,
} = require("./routes");
const { REQUEST_LABEL } = require("./batch-request-subscription");

const request = {
  version: 1,
  target: { installation_id: "installation_target_0001", project_id: "target-project" },
  coordination_repository: "acme/coordination",
  request_label: REQUEST_LABEL,
  cache: { etag: null, cursor: null },
};

{
  const actual = _batchRequestReaderInput(request);
  assert.deepEqual(actual, request);
  assert.equal(Object.isFrozen(actual) && Object.isFrozen(actual.target) && Object.isFrozen(actual.cache), true);
  for (const invalid of [
    { ...request, unexpected: true },
    { ...request, coordination_repository: "Acme/Coordination" },
    { ...request, request_label: "other" },
    { ...request, cache: { etag: "ok", cursor: 42 } },
  ]) {
    assert.throws(() => _batchRequestReaderInput(invalid), TypeError);
  }
  console.log("PASS: fixed Batch Request reader rejects caller-selected query authority");
}

{
  const rows = _batchRequestIssueRows("acme/coordination", [{
    number: 42,
    title: "untrusted title",
    body: "```quadwork-batch-request\\n{}\\n```",
    labels: [{ name: REQUEST_LABEL }, { name: "other" }, { name: ["bad", "label"].join(String.fromCharCode(10)) }],
    pull_request: { url: "untrusted" },
    html_url: "https://github.com/acme/coordination/issues/42",
  }], 'W/"one"');
  assert.deepEqual(rows, [{
    repository: "acme/coordination",
    issue_number: 42,
    issue_url: "https://api.github.com/repos/acme/coordination/issues/42",
    pull_request: {},
    labels: [REQUEST_LABEL, "other"],
    body: "```quadwork-batch-request\\n{}\\n```",
    etag: 'W/"one"',
    cursor: "open-labelled-issues-v1",
  }]);
  assert.equal(Object.isFrozen(rows[0]), true);
  assert.throws(() => _batchRequestIssueRows("acme/coordination", [{ number: 1 }, { number: 1 }], null), TypeError);
  console.log("PASS: reader maps only the bounded contract fields and preserves PR shape for fail-closed rejection");
}

{
  const ids = batchRequestRefreshProjectIds({
    projects: [
      { id: "idle-opted-in", idle: true, watch_batch_requests: true },
      { id: "active-opted-out", watch_batch_requests: false },
      { id: "archived", archived: true, watch_batch_requests: true },
      { id: "idle-opted-in", watch_batch_requests: true },
    ],
  });
  assert.deepEqual(ids, ["idle-opted-in"]);
  console.log("PASS: explicit Batch Request opt-in remains observable without an active dashboard batch");
}

console.log("routes.batch-request-reader.test.js: all assertions passed");
