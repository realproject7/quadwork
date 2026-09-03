"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalizeBatchRequestAuthority } = require("./batch-request-contract");
const { VERSION, dedupeKey } = require("./batch-request-subscription");
const { BatchRequestNoticeError, batchRequestNotice } = require("./batch-request-notice");

const PROJECT = "target-project";
const REPOSITORY = "acme/coordination";
const REQUEST = "123e4567-e89b-42d3-a456-426614174000";
const AUTHORITY = {
  schema: "quadwork-batch-request/v1",
  request_id: REQUEST,
  source_installation_id: "installation_source_0001",
  source_project_id: "source-project",
  target_installation_id: "installation_target_0001",
  target_project_id: PROJECT,
  coordination_repo: REPOSITORY,
  mode: "implementation",
  work_refs: ["acme/web#42"],
  start_policy: "next-available",
};
const DIGEST = canonicalizeBatchRequestAuthority(AUTHORITY).digest;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function plan(overrides = {}) {
  return {
    version: VERSION,
    kind: "BATCH REQUEST",
    recipients: ["head"],
    correlation_key: dedupeKey(REPOSITORY, 42, REQUEST, DIGEST),
    issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/42`,
    anchors: { coordination_repo: REPOSITORY, issue_number: 42, request_id: REQUEST, authority_digest: DIGEST },
    authority: copy(AUTHORITY),
    ...overrides,
  };
}
function input(overrides = {}) {
  return { project_id: PROJECT, head_generation: 0, notification: plan(), ...overrides };
}
function code(fn, expected) {
  assert.throws(fn, (error) => error instanceof BatchRequestNoticeError && error.code === expected);
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

{
  const actual = batchRequestNotice(input());
  assert.deepEqual(Object.keys(actual).sort(), ["channel", "correlation_key", "head_generation", "project_id", "resume_structural", "sender", "text", "trusted_event", "type"]);
  assert.equal(actual.text, `@head [BATCH REQUEST] request=${REQUEST} issue=https://api.github.com/repos/${REPOSITORY}/issues/42 source=installation_source_0001 mode=implementation start=next-available`);
  assert.deepEqual(actual.resume_structural, {
    version: 1, project_id: PROJECT, trusted: true, tag: "batch_request", batch_id: null,
    head_generation: 0, target: "head", server_authored: true,
  });
  assert.deepEqual(actual.trusted_event, {
    scope: "batch_request", version: VERSION, correlation_key: plan().correlation_key,
    anchors: { coordination_repo: REPOSITORY, issue_number: 42, request_id: REQUEST, authority_digest: DIGEST },
  });
  const encoded = JSON.stringify(actual);
  assert.equal(encoded.includes("work_refs"), false);
  assert.equal(encoded.includes("source_project_id"), false);
  assert.equal(Object.isFrozen(actual) && Object.isFrozen(actual.resume_structural), true);
  ok(true, "one admitted Head plan becomes a fixed zero-based-generation Primary Chat notice without authority leakage");
}

for (const invalid of [
  input({ unexpected: true }),
  input({ notification: plan({ recipients: ["head", "dev"] }) }),
  input({ notification: plan({ issue_url: `https://github.com/${REPOSITORY}/issues/42` }) }),
  input({ notification: plan({ correlation_key: "forged" }) }),
  input({ notification: plan({ authority: { ...AUTHORITY, target_project_id: "other-project" } }) }),
]) {
  code(() => batchRequestNotice(invalid), "invalid_batch_request_notice_input");
}
ok(true, "foreign, broadened, noncanonical, and forged watcher plans cannot mint a chat notice");

{
  const source = fs.readFileSync(path.join(__dirname, "batch-request-notice.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|net|child_process|os)["']\s*\)/);
  assert.doesNotMatch(source, /(?:fetch\s*\(|setTimeout\s*\(|setInterval\s*\(|process\.)/);
  ok(true, "notice renderer owns no I/O, scheduler, storage, or worker-dispatch capability");
}

console.log(`\n${passed} batch request notice checks passed.`);
