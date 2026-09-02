"use strict";

// The richer control and token cases are exercised in head-control-runtime's
// dependency-injected test. This short source guard keeps index.js as the
// sole runtime composer without requiring its listener/pollers in a unit test.

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

ok(/createHeadControlRuntime\(\{[\s\S]*?read_live_batch_context:\s*routes\.readLiveBatchContext,[\s\S]*?read_repository_state:\s*routes\.repositoryState,[\s\S]*?read_cached_repository_snapshot:\s*\(cacheRepo\)\s*=>\s*routes\._graphqlCache\.get\(cacheRepo\)/.test(source),
  "the server composes only the current routes readers into the live WorkTask identity resolver");
ok(/app\.post\("\/api\/head-control",[\s\S]*?X-Head-Control-Token[\s\S]*?headControlRuntime\.handle\(\{ method: "POST", path: req\.path, body: req\.body \}, \{ token \}\)/.test(source),
  "the fixed Head-control route forwards one token header and no caller-derived authority");
ok(/app\.get\("\/api\/work-task-batch",[\s\S]*?requireSessionToken\(req, res\)[\s\S]*?headControlRuntime\.readCurrentBatchProjection\(\{ project_id: projectId \}\)/.test(source),
  "the nested WorkTask Current Batch endpoint is session-bound and delegates identity resolution to the runtime");
ok(/app\.post\("\/api\/work-task-candidate",[\s\S]*?activeDevCandidatePrincipal\(req\)[\s\S]*?createLiveWorkTaskIdentityResolver[\s\S]*?devCandidateServiceForProject\(principal\.projectId\)\.submitDevCandidate\(req\.body\)/.test(source),
  "the fixed Dev candidate endpoint re-proves live task identity before durable local-only recording");
ok(/createWorkTaskBuildRuntime\(\{[\s\S]*?capture_project_admission:\s*captureProjectAdmission,[\s\S]*?resolve_shim_principal:\s*fileChat\.resolveShimPrincipal,[\s\S]*?agent_sessions:\s*agentSessions,[\s\S]*?create_assignment_service:\s*createWorkTaskBuildAssignmentService,[\s\S]*?read_registered_base:\s*\(projectId, request\)\s*=>\s*registeredWorkTaskBaseForProject\(projectId\)\.readRegisteredBase\(request\)/.test(source),
  "the server composes build assignment from admission, current sessions, and registered-base observation only");
ok(/app\.post\("\/api\/work-task-build",[\s\S]*?X-Chat-Token[\s\S]*?workTaskBuildRuntime\.assign\(\{ token, body: req\.body \}\)/.test(source),
  "the fixed Head build-assignment route exposes no caller-selected project, base, or worktree");
ok(/createWorkTaskReviewRuntime\(\{[\s\S]*?capture_project_admission:\s*captureProjectAdmission,[\s\S]*?resolve_shim_principal:\s*fileChat\.resolveShimPrincipal,[\s\S]*?agent_sessions:\s*agentSessions,[\s\S]*?create_review_service:\s*createWorkTaskIndependentReviewService,[\s\S]*?create_reconciliation_service:\s*createWorkTaskReviewReconciliationService/.test(source),
  "the server composes independent review transport from admission, live identity, and current sessions only");
ok(/app\.post\("\/api\/work-task-review\/open",[\s\S]*?X-Chat-Token[\s\S]*?workTaskReviewRuntime\.open\(\{ token, body: req\.body \}\)[\s\S]*?app\.post\("\/api\/work-task-review\/receipt",[\s\S]*?X-Chat-Token[\s\S]*?workTaskReviewRuntime\.submit\(\{ token, body: req\.body \}\)[\s\S]*?app\.post\("\/api\/work-task-review\/reconcile",[\s\S]*?X-Chat-Token[\s\S]*?workTaskReviewRuntime\.reconcile\(\{ token, body: req\.body \}\)/.test(source),
  "fixed Head-open, reviewer-receipt, and Head-reconcile routes expose no caller-selected project or role");
ok(/createDeliveryCandidateRuntime\(\{[\s\S]*?read_delivery_source:\s*\(request\)\s*=>\s*deliverySourceForProject\(request\.project_id\)\.readStagedSource\(request\),[\s\S]*?read_delivery_evidence:\s*\(request\)\s*=>\s*deliveryGitObjectsForProject\(request\.head_binding\.project_id\)\.readDeliveryEvidence\(request\),[\s\S]*?create_candidate_store:\s*createDeliveryCandidateStore,[\s\S]*?create_composition_service:\s*createDeliveryCompositionService,[\s\S]*?repository_objects_for:\s*\(request\)\s*=>\s*deliveryGitObjectsForProject\(request\.head_binding\.project_id\)\.repositoryObjectsFor\(request\)/.test(source),
  "the server composes Delivery Candidate state and Git objects from fixed registered-project authorities only");
ok(/app\.post\("\/api\/delivery-candidate\/prepare",[\s\S]*?X-Chat-Token[\s\S]*?deliveryCandidateRuntime\.prepare\(\{ token, body: req\.body \}\)[\s\S]*?app\.post\("\/api\/delivery-candidate\/compose",[\s\S]*?X-Chat-Token[\s\S]*?deliveryCandidateRuntime\.compose\(\{ token, body: req\.body \}\)/.test(source),
  "fixed Head Delivery Candidate routes expose neither caller-selected Git evidence nor publication authority");
ok(/function headControlMcpEntry\(projectId, agentId, serverPort, token\)\s*\{[\s\S]*?if \(agentId !== "head"\) return null;[\s\S]*?captureProjectAdmission\(projectId\)[\s\S]*?registerHeadToken/.test(source),
  "only an admitted Head receives a bound Head-control MCP launch entry");
ok(/head_control:\s*headControl/.test(source) && /mcp_servers\.head_control\.command/.test(source) && /\[mcp_servers\.head_control\]/.test(source),
  "flag, proxy, project-TOML, and environment MCP injection retain the fixed Head-control server");
ok(/mergeCleanupResult\(aggregate, headControlRuntime\.revokeProject\(projectId\), "head_control"\)/.test(source),
  "project lifecycle cleanup synchronously revokes in-memory Head-control authority");

console.log(`\n${passed} passed`);
