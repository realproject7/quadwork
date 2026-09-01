"use strict";

// Dependency-injected runtime-owner tests cover behavior. These guards keep
// the shared server composition narrow: no public route, no extra interval,
// and no worker-facing dispatch path may be introduced around #1046.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

ok(/createBatchRequestRuntimeOwner\(\{[\s\S]*?read_coordination_issues:\s*routes\.readBatchRequestIssues,[\s\S]*?append_trusted_batch_request_once:[\s\S]*?fileChat\.appendTrustedBatchRequestOnce/.test(source),
  "the server composes the fixed REST reader and closed Primary Chat append seam");
ok(/routes\.setBatchRequestRefreshObserver\(\(projectId\)\s*=>\s*batchRequestRuntimeOwner\.reconcileProject\(projectId\)\)/.test(source),
  "Batch Request reconciliation reuses the existing GitHub refresh observer rather than creating a timer");
ok(/dispatchTrustedBatchRequest\(candidate\.project_id, candidate, agentSessions,[\s\S]*?isTrustedBatchRequestCurrent:\s*currentBatchRequestNotice/.test(source),
  "only the current verified Head receives the optional deferred wake");
ok(/mergeCleanupResult\(aggregate, batchRequestRuntimeOwner\.revokeProject\(projectId\), "batch_request"\)/.test(source),
  "project archive synchronously revokes in-memory Batch Request runtime authority");
ok(!/app\.(?:get|post|put|delete)\("\/api\/batch-request/.test(source),
  "the watcher exposes no public inbound Batch Request route");

console.log(`\n${passed} passed`);
