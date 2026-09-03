"use strict";

const assert = require("node:assert/strict");
const {
  dispatchTrustedBatchRequest,
  cancelProject,
  _pendingWake,
} = require("./pty-dispatcher");
const { canonicalizeBatchRequestAuthority } = require("./batch-request-contract");
const { VERSION, dedupeKey } = require("./batch-request-subscription");

const project_id = "alpha";
const repository = "acme/coordination";
const request_id = "123e4567-e89b-42d3-a456-426614174000";
const authority = {
  schema: "quadwork-batch-request/v1",
  request_id,
  source_installation_id: "installation_source_0001",
  source_project_id: "source-project",
  target_installation_id: "installation_target_0001",
  target_project_id: project_id,
  coordination_repo: repository,
  mode: "implementation",
  work_refs: ["acme/web#42"],
  start_policy: "next-available",
};
const digest = canonicalizeBatchRequestAuthority(authority).digest;
const candidate = {
  project_id,
  head_generation: 0,
  notification: {
    version: VERSION,
    kind: "BATCH REQUEST",
    recipients: ["head"],
    correlation_key: dedupeKey(repository, 42, request_id, digest),
    issue_url: `https://api.github.com/repos/${repository}/issues/42`,
    anchors: { coordination_repo: repository, issue_number: 42, request_id, authority_digest: digest },
    authority,
  },
};
const writes = [];
const term = {
  write: (text) => writes.push(text),
  onData: () => ({ dispose() {} }),
};
const sessions = new Map([["alpha/head", {
  projectId: project_id,
  agentId: "head",
  term,
  state: "running",
  lifecycleState: "verified",
  generationId: "head-session-0",
  lastOutputAt: Date.now(),
}]]);
const deps = {
  isProjectAdmitted: () => true,
  isTrustedBatchRequestCurrent: (notice, session) => notice.project_id === project_id && notice.head_generation === 0 && session.generationId === "head-session-0",
  safeWrite: (target, text) => { target.write(text); return true; },
};

const accepted = dispatchTrustedBatchRequest(project_id, candidate, sessions, deps);
assert.deepEqual(accepted, { ok: true, deferred: true, delivery_generation: "head-session-0" });
assert.equal(writes.length, 0);
assert.equal(_pendingWake.has("alpha/head"), true);
assert.equal(cancelProject(project_id).ok, true);
assert.equal(_pendingWake.has("alpha/head"), false);

sessions.get("alpha/head").lifecycleState = "spawned";
assert.equal(dispatchTrustedBatchRequest(project_id, candidate, sessions, deps).code, "batch_request_not_current");
sessions.get("alpha/head").lifecycleState = "verified";
assert.equal(dispatchTrustedBatchRequest(project_id, { ...candidate, notification: { ...candidate.notification, recipients: ["head", "dev"] } }, sessions, deps).code, "batch_request_notice_invalid");
assert.equal(writes.length, 0);

console.log("pty-dispatcher.trusted-batch-request.test.js: all assertions passed");
