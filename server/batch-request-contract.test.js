"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  BatchRequestContractError,
  parseBatchRequestAuthority,
  canonicalizeBatchRequestAuthority,
  assertBatchRequestRegistered,
} = require("./batch-request-contract");

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE_INSTALLATION = "installation_source_123456";
const TARGET_INSTALLATION = "installation_target_123456";

function authority(overrides = {}) {
  return {
    schema: "quadwork-batch-request/v1",
    request_id: REQUEST_ID,
    source_installation_id: SOURCE_INSTALLATION,
    source_project_id: "source-project",
    target_installation_id: TARGET_INSTALLATION,
    target_project_id: "target-project",
    coordination_repo: "acme/coordination",
    mode: "implementation",
    work_refs: ["acme/web#42", "acme/api#9"],
    start_policy: "next-available",
    ...overrides,
  };
}

function body(value, prose = "Human context is intentionally non-authoritative.") {
  return `${prose}\n\n\`\`\`quadwork-batch-request\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n\`\`\`\n\n## Completion report\nChanged only outside authority.`;
}

function code(fn, expected) {
  assert.throws(fn, (error) => error instanceof BatchRequestContractError && error.code === expected);
}

function route(overrides = {}) {
  return {
    coordination_repo: "acme/coordination",
    source: { installation_id: SOURCE_INSTALLATION, project_id: "source-project" },
    target: { installation_id: TARGET_INSTALLATION, project_id: "target-project" },
    registered_repositories: ["acme/coordination", "acme/web", "acme/api"],
    ...overrides,
  };
}

// A valid body has a deliberately small immutable authority surface. Prose,
// title-like text, labels, and a later completion report never enter its digest.
{
  const first = parseBatchRequestAuthority(body(authority(), "[Batch Request] target — prose one"));
  const second = parseBatchRequestAuthority(body(authority(), "Different title, labels, and constraints outside the fence"));
  assert.equal(first.digest, second.digest);
  assert.equal(first.canonical_json, JSON.stringify(authority()));
  assert.deepEqual(first.authority.work_refs, ["acme/web#42", "acme/api#9"]);
  assert.equal(Object.isFrozen(first.authority), true);
  assert.throws(() => { first.authority.mode = "verification"; }, TypeError);
}

// Insignificant JSON whitespace and object key order are not authority. The
// output always uses the schema's fixed field order and compact UTF-8 JSON.
{
  const shuffled = ` {\n  "work_refs" : [ "acme/web#42", "acme/api#9" ],\n  "target_project_id": "target-project",\n  "mode":"implementation",\n  "schema": "quadwork-batch-request/v1",\n  "source_project_id":"source-project",\n  "request_id":"${REQUEST_ID.toUpperCase()}",\n  "coordination_repo":"acme/coordination",\n  "target_installation_id":"${TARGET_INSTALLATION}",\n  "start_policy": "next-available",\n  "source_installation_id":"${SOURCE_INSTALLATION}"\n}`;
  const parsed = parseBatchRequestAuthority(body(shuffled));
  const stable = parseBatchRequestAuthority(body(authority()));
  assert.equal(parsed.digest, stable.digest);
  assert.equal(parsed.canonical_json, stable.canonical_json);
  assert.equal(parsed.authority.request_id, REQUEST_ID);
}

// Exactly one valid fence, valid UTF-8/JSON, and a unique top-level schema are
// mandatory. JSON.parse alone would hide a duplicate top-level key, so escaped
// duplicate names receive the same denial.
{
  code(() => parseBatchRequestAuthority("ordinary prose only"), "batch_request_authority_missing");
  code(() => parseBatchRequestAuthority(`${body(authority())}\n\`\`\`quadwork-batch-request\n{}\n\`\`\``), "batch_request_authority_ambiguous");
  code(() => parseBatchRequestAuthority("\`\`\`quadwork-batch-request\n{}"), "batch_request_authority_unclosed");
  code(() => parseBatchRequestAuthority(body("{ this is not JSON }")), "invalid_batch_request_json");
  code(() => parseBatchRequestAuthority(body(`{"schema":"quadwork-batch-request/v1","schema":"quadwork-batch-request/v1"}`)), "duplicate_batch_request_field");
  code(() => parseBatchRequestAuthority(body(`{"\\u0073chema":"quadwork-batch-request/v1","schema":"quadwork-batch-request/v1"}`)), "duplicate_batch_request_field");
  code(() => parseBatchRequestAuthority(Buffer.from([0xc3, 0x28])), "invalid_batch_request_utf8");
  assert.equal(parseBatchRequestAuthority(Buffer.from(body(authority()).replace(/\n/g, "\r\n"), "utf8")).digest,
    parseBatchRequestAuthority(body(authority())).digest, "valid CRLF UTF-8 input has the same canonical authority");
}

// Strict shape prevents PR-shaped or display-shaped input from becoming
// executable authority, regardless of how plausible its prose may look.
{
  code(() => parseBatchRequestAuthority(body({ ...authority(), title: "please run this" })), "invalid_batch_request_fields");
  code(() => parseBatchRequestAuthority(body({ ...authority(), pull_request: { url: "https://example.invalid/pr/1" } })), "invalid_batch_request_fields");
  code(() => parseBatchRequestAuthority(body({ ...authority(), work_refs: ["#42"] })), "invalid_batch_request_work_ref");
  code(() => parseBatchRequestAuthority(body({ ...authority(), work_refs: ["acme/web#42", "ACME/WEB#42"] })), "duplicate_batch_request_work_ref");
  code(() => parseBatchRequestAuthority(body({ ...authority(), work_refs: Array.from({ length: 21 }, (_, index) => `acme/web#${index + 1}`) })), "invalid_batch_request_work_refs");
  code(() => parseBatchRequestAuthority(body({ ...authority(), coordination_repo: "Acme/Coordination" })), "noncanonical_batch_request_repository");
  code(() => parseBatchRequestAuthority(body({ ...authority(), mode: "auto-start" })), "invalid_batch_request_mode");
  code(() => parseBatchRequestAuthority(body({ ...authority(), start_policy: "preempt" })), "invalid_batch_request_start_policy");
}

// The parser accepts no registry itself. A later watcher can use this pure
// input/output seam to prove repository, source-peer, and target authority.
{
  const parsed = parseBatchRequestAuthority(body(authority()));
  let observed;
  const admitted = assertBatchRequestRegistered(parsed, {
    resolveRegisteredRoute(input) {
      observed = input;
      assert.equal(Object.isFrozen(input), true);
      return route();
    },
  });
  assert.equal(admitted.digest, parsed.digest);
  assert.deepEqual(observed.work_refs, ["acme/web#42", "acme/api#9"]);
  assert.equal(
    assertBatchRequestRegistered({ ...parsed, digest: "f".repeat(64), canonical_json: "{}" }, {
      resolveRegisteredRoute: () => route(),
    }).digest,
    parsed.digest,
    "admission re-canonicalizes a supplied parse receipt instead of trusting a caller digest",
  );
  code(() => assertBatchRequestRegistered(parsed, { resolveRegisteredRoute: () => route({ source: { installation_id: SOURCE_INSTALLATION, project_id: "other" } }) }), "batch_request_source_peer_mismatch");
  code(() => assertBatchRequestRegistered(parsed, { resolveRegisteredRoute: () => route({ target: { installation_id: "installation_else_123456", project_id: "target-project" } }) }), "batch_request_target_identity_mismatch");
  code(() => assertBatchRequestRegistered(parsed, { resolveRegisteredRoute: () => route({ registered_repositories: ["acme/coordination", "acme/web"] }) }), "batch_request_unregistered_repository");
  code(() => assertBatchRequestRegistered(parsed, { resolveRegisteredRoute: () => route({ registered_repositories: ["acme/coordination", "acme/web", "acme/api", "acme/api"] }) }), "invalid_batch_request_registered_route");
  code(() => assertBatchRequestRegistered(parsed, { resolveRegisteredRoute: () => route({ coordination_repo: "acme/other" }) }), "batch_request_coordination_repository_mismatch");
}

// Canonicalization accepts an already-decoded authority object only when it is
// exact; no JSON body, context, Completion report, or free-form PR field can
// sneak through this second API.
{
  const direct = canonicalizeBatchRequestAuthority(authority());
  assert.equal(direct.digest, parseBatchRequestAuthority(body(authority())).digest);
  code(() => canonicalizeBatchRequestAuthority({ ...authority(), completion: "done" }), "invalid_batch_request_fields");
}

// M1 purity guard: this is a parser/canonicalizer only. No lifecycle, route,
// GitHub, chat, watcher, or filesystem behavior may be pulled in here.
{
  const source = fs.readFileSync(path.join(__dirname, "batch-request-contract.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|http|https)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|file-chat|project-monitor|config|github)["']\s*\)/);
}

console.log("batch-request-contract.test.js: all assertions passed");
