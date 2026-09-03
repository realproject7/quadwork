"use strict";

const assert = require("node:assert/strict");
const { HeadLifecycleNoticeError, headLifecycleNotice } = require("./head-lifecycle-notice");

const candidate = Object.freeze({
  version: 1,
  project_id: "quadwork-v2",
  installation_id: "installation1047a",
  head_generation: 0,
  operation_id: "operation-1047-a",
  session_generation: "generation-1047-a",
  reason: "operator_reset",
  batch_id: "batch-1047",
});

const notice = headLifecycleNotice(candidate);
assert.equal(notice.sender, "system");
assert.equal(notice.type, "system");
assert.equal(notice.text, "@head [HEAD RECOVERY] installation=installation1047a reason=operator_reset operation=operation-1047-a session=generation-1047-a");
assert.equal(notice.trusted_event.scope, "head_lifecycle");
assert.equal(notice.resume_structural.tag, "head_lifecycle");
assert.equal(notice.resume_structural.head_generation, 0);
assert.equal(notice.resume_structural.batch_id, "batch-1047");

for (const change of [
  { reason: "untrusted" },
  { head_generation: -1 },
  { batch_id: "wrong batch" },
  { unexpected: true },
]) {
  assert.throws(() => headLifecycleNotice({ ...candidate, ...change }), (error) => error instanceof HeadLifecycleNoticeError && error.code === "head_lifecycle_notice_invalid");
}

console.log("head-lifecycle-notice.test.js: all assertions passed");
