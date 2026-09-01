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
ok(/function headControlMcpEntry\(projectId, agentId, serverPort, token\)\s*\{[\s\S]*?if \(agentId !== "head"\) return null;[\s\S]*?captureProjectAdmission\(projectId\)[\s\S]*?registerHeadToken/.test(source),
  "only an admitted Head receives a bound Head-control MCP launch entry");
ok(/head_control:\s*headControl/.test(source) && /mcp_servers\.head_control\.command/.test(source) && /\[mcp_servers\.head_control\]/.test(source),
  "flag, proxy, project-TOML, and environment MCP injection retain the fixed Head-control server");
ok(/mergeCleanupResult\(aggregate, headControlRuntime\.revokeProject\(projectId\), "head_control"\)/.test(source),
  "project lifecycle cleanup synchronously revokes in-memory Head-control authority");

console.log(`\n${passed} passed`);
