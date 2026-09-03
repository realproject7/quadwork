"use strict";

// #1046 M1: strict, pure authority parsing for a GitHub Batch Request.
//
// This module deliberately has no GitHub, config, watcher, route, chat, or
// filesystem dependency.  A later watcher may supply the narrow, synchronous
// registered-route accessor below, but surrounding Markdown is never an input
// to its authority decision.

const crypto = require("node:crypto");
const { isUtf8 } = require("node:buffer");

const SCHEMA = "quadwork-batch-request/v1";
const AUTHORITY_FIELDS = Object.freeze([
  "schema",
  "request_id",
  "source_installation_id",
  "source_project_id",
  "target_installation_id",
  "target_project_id",
  "coordination_repo",
  "mode",
  "work_refs",
  "start_policy",
]);
const MODES = Object.freeze(["implementation", "ticket-review", "pr-review", "verification"]);
const START_POLICIES = Object.freeze(["next-available", "hold"]);
const MODE_SET = new Set(MODES);
const START_POLICY_SET = new Set(START_POLICIES);
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WORK_REF_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})#([1-9]\d{0,6})$/;
const MAX_AUTHORITY_BYTES = 64 * 1024;
const MAX_WORK_REFS = 20;

class BatchRequestContractError extends Error {
  constructor(code, message = code, field = null) {
    super(message);
    this.name = "BatchRequestContractError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field = null) {
  throw new BatchRequestContractError(code, message, field);
}

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function decodeBody(value) {
  if (Buffer.isBuffer(value)) {
    if (!isUtf8(value)) fail("invalid_batch_request_utf8", "request body is not valid UTF-8");
    return value.toString("utf8");
  }
  if (typeof value !== "string") fail("invalid_batch_request_body", "request body must be a UTF-8 string or buffer");
  // JavaScript strings can contain unpaired UTF-16 surrogates, which have no
  // lossless UTF-8 representation.  Reject rather than silently replacing one
  // before the digest is computed.
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    fail("invalid_batch_request_utf8", "request body is not valid UTF-8");
  }
  return value;
}

function authorityFence(body) {
  const open = /(?:^|\n)[ \t]*```quadwork-batch-request[ \t]*(?:\r?\n|$)/g;
  const openings = [];
  let match;
  while ((match = open.exec(body)) !== null) {
    openings.push({ contentStart: open.lastIndex });
  }
  if (openings.length !== 1) {
    fail(openings.length === 0 ? "batch_request_authority_missing" : "batch_request_authority_ambiguous",
      openings.length === 0 ? "exactly one batch request authority fence is required" : "a second batch request authority fence is not allowed");
  }
  const close = /(?:^|\n)[ \t]*```[ \t]*(?=\r?\n|$)/g;
  close.lastIndex = openings[0].contentStart;
  const closing = close.exec(body);
  if (!closing) fail("batch_request_authority_unclosed", "batch request authority fence is not closed");
  const closeStart = closing.index + (closing[0].startsWith("\n") ? 1 : 0);
  return body.slice(openings[0].contentStart, closeStart);
}

function skipWhitespace(source, index) {
  while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  return index;
}

function stringEnd(source, index) {
  if (source[index] !== '"') fail("invalid_batch_request_json", "authority JSON is invalid");
  let escaped = false;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') return cursor + 1;
  }
  fail("invalid_batch_request_json", "authority JSON string is not closed");
}

// JSON.parse intentionally remains the grammar authority.  This small lexer
// only preserves top-level key occurrence before JSON.parse would collapse a
// duplicate key (including escaped aliases such as "a" and "\\u0061").
function topLevelKeys(source) {
  let cursor = skipWhitespace(source, 0);
  if (source[cursor] !== "{") fail("invalid_batch_request_json", "authority JSON must be an object");
  cursor = skipWhitespace(source, cursor + 1);
  const keys = [];
  if (source[cursor] === "}") return keys;
  for (;;) {
    cursor = skipWhitespace(source, cursor);
    const keyStart = cursor;
    const keyEnd = stringEnd(source, cursor);
    let key;
    try { key = JSON.parse(source.slice(keyStart, keyEnd)); }
    catch { fail("invalid_batch_request_json", "authority JSON key is invalid"); }
    keys.push(key);
    cursor = skipWhitespace(source, keyEnd);
    if (source[cursor] !== ":") fail("invalid_batch_request_json", "authority JSON member is invalid");
    cursor = skipWhitespace(source, cursor + 1);

    // Walk one value until the root object's next delimiter, respecting nested
    // arrays/objects and quoted strings. JSON.parse below validates the exact
    // grammar, number syntax, and all nesting.
    let nesting = 0;
    let quoted = false;
    let escaped = false;
    let foundDelimiter = false;
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{" || character === "[") { nesting += 1; continue; }
      if (character === "}" || character === "]") {
        if (nesting > 0) { nesting -= 1; continue; }
        if (character === "}") { foundDelimiter = true; break; }
      }
      if (character === "," && nesting === 0) { foundDelimiter = true; break; }
    }
    if (!foundDelimiter) fail("invalid_batch_request_json", "authority JSON is invalid");
    if (source[cursor] === "}") return keys;
    cursor = skipWhitespace(source, cursor + 1);
  }
}

function parseAuthorityJson(content) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0 || bytes > MAX_AUTHORITY_BYTES) fail("invalid_batch_request_json", "authority JSON is empty or too large");
  const keys = topLevelKeys(content);
  const duplicates = new Set();
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  if (duplicates.size) fail("duplicate_batch_request_field", "authority JSON contains a duplicate top-level key", [...duplicates][0]);
  let value;
  try { value = JSON.parse(content); }
  catch { fail("invalid_batch_request_json", "authority JSON is invalid"); }
  if (!plain(value)) fail("invalid_batch_request_json", "authority JSON must be an object");
  return value;
}

function exactFields(value) {
  if (!plain(value)) fail("invalid_batch_request_fields", "authority JSON must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...AUTHORITY_FIELDS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("invalid_batch_request_fields", "authority JSON contains unknown or missing fields");
  }
}

function canonicalRepository(value, field) {
  if (typeof value !== "string" || value.length > 201 || value.trim() !== value) {
    fail("invalid_batch_request_repository", "repository is invalid", field);
  }
  const [owner, repo, extra] = value.split("/");
  if (extra !== undefined || !REPOSITORY_PART_RE.test(owner || "") || !REPOSITORY_PART_RE.test(repo || "")) {
    fail("invalid_batch_request_repository", "repository is invalid", field);
  }
  return `${owner}/${repo}`.toLowerCase();
}

function identifier(value, field, expression, code) {
  if (typeof value !== "string" || !expression.test(value)) fail(code, `${field} is invalid`, field);
  return value;
}

function canonicalWorkRef(value, index) {
  if (typeof value !== "string" || value.length > 208 || value.trim() !== value) {
    fail("invalid_batch_request_work_ref", "work reference is invalid", `work_refs[${index}]`);
  }
  const match = WORK_REF_RE.exec(value);
  if (!match) fail("invalid_batch_request_work_ref", "work reference must be owner/repo#number", `work_refs[${index}]`);
  return `${match[1].toLowerCase()}#${Number(match[2])}`;
}

function normalizeAuthority(value) {
  exactFields(value);
  if (value.schema !== SCHEMA) fail("invalid_batch_request_schema", "schema is invalid", "schema");
  const requestId = identifier(value.request_id, "request_id", UUID_RE, "invalid_batch_request_id").toLowerCase();
  if (requestId === "00000000-0000-0000-0000-000000000000") {
    fail("invalid_batch_request_id", "request_id must not be nil", "request_id");
  }
  const sourceInstallationId = identifier(value.source_installation_id, "source_installation_id", INSTALLATION_ID_RE, "invalid_batch_request_source");
  const sourceProjectId = identifier(value.source_project_id, "source_project_id", PROJECT_ID_RE, "invalid_batch_request_source");
  const targetInstallationId = identifier(value.target_installation_id, "target_installation_id", INSTALLATION_ID_RE, "invalid_batch_request_target");
  const targetProjectId = identifier(value.target_project_id, "target_project_id", PROJECT_ID_RE, "invalid_batch_request_target");
  const coordinationRepo = canonicalRepository(value.coordination_repo, "coordination_repo");
  if (coordinationRepo !== value.coordination_repo) {
    fail("noncanonical_batch_request_repository", "coordination_repo must be canonical lowercase owner/repo", "coordination_repo");
  }
  if (typeof value.mode !== "string" || !MODE_SET.has(value.mode)) fail("invalid_batch_request_mode", "mode is invalid", "mode");
  if (!Array.isArray(value.work_refs) || value.work_refs.length === 0 || value.work_refs.length > MAX_WORK_REFS) {
    fail("invalid_batch_request_work_refs", "work_refs must contain 1 through 20 entries", "work_refs");
  }
  const workRefs = value.work_refs.map(canonicalWorkRef);
  if (new Set(workRefs).size !== workRefs.length) fail("duplicate_batch_request_work_ref", "work_refs contains a duplicate reference", "work_refs");
  if (typeof value.start_policy !== "string" || !START_POLICY_SET.has(value.start_policy)) {
    fail("invalid_batch_request_start_policy", "start_policy is invalid", "start_policy");
  }
  return freeze({
    schema: SCHEMA,
    request_id: requestId,
    source_installation_id: sourceInstallationId,
    source_project_id: sourceProjectId,
    target_installation_id: targetInstallationId,
    target_project_id: targetProjectId,
    coordination_repo: coordinationRepo,
    mode: value.mode,
    work_refs: freeze(workRefs),
    start_policy: value.start_policy,
  });
}

function canonicalizeBatchRequestAuthority(value) {
  const authority = normalizeAuthority(value);
  const canonical_json = JSON.stringify(authority);
  return freeze({
    authority,
    canonical_json,
    digest: crypto.createHash("sha256").update(canonical_json, "utf8").digest("hex"),
  });
}

function parseBatchRequestAuthority(body) {
  const content = authorityFence(decodeBody(body));
  return canonicalizeBatchRequestAuthority(parseAuthorityJson(content));
}

function exact(value, fields, code) {
  if (!plain(value)) fail(code, "registered route result must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, "registered route result has an invalid shape");
  }
}

// The seam is deliberately synchronous and input/output only. It lets a later
// watcher prove its currently registered coordination repository, source peer,
// target identity, and every referenced repository without this contract layer
// acquiring a config, network, or lifecycle dependency.
function assertBatchRequestRegistered(contract, options = {}) {
  // Re-canonicalize supplied parse receipts rather than trusting their digest
  // or a caller-provided `canonical_json` field. This keeps admission tied to
  // the exact schema even when it is called across an in-memory boundary.
  const parsed = canonicalizeBatchRequestAuthority(
    plain(contract) && Object.prototype.hasOwnProperty.call(contract, "authority") ? contract.authority : contract,
  );
  if (typeof options.resolveRegisteredRoute !== "function") {
    fail("batch_request_registration_accessor_required", "registered route accessor is required");
  }
  const input = freeze({
    coordination_repo: parsed.authority.coordination_repo,
    source: freeze({ installation_id: parsed.authority.source_installation_id, project_id: parsed.authority.source_project_id }),
    target: freeze({ installation_id: parsed.authority.target_installation_id, project_id: parsed.authority.target_project_id }),
    work_refs: freeze([...parsed.authority.work_refs]),
  });
  let route;
  try { route = options.resolveRegisteredRoute(input); }
  catch { fail("batch_request_registration_unavailable", "registered route accessor failed"); }
  exact(route, ["coordination_repo", "source", "target", "registered_repositories"], "invalid_batch_request_registered_route");
  const registeredCoordinationRepo = canonicalRepository(route.coordination_repo, "coordination_repo");
  if (registeredCoordinationRepo !== route.coordination_repo || registeredCoordinationRepo !== parsed.authority.coordination_repo) {
    fail("batch_request_coordination_repository_mismatch", "coordination repository is not currently registered");
  }
  exact(route.source, ["installation_id", "project_id"], "invalid_batch_request_registered_route");
  exact(route.target, ["installation_id", "project_id"], "invalid_batch_request_registered_route");
  if (route.source.installation_id !== parsed.authority.source_installation_id || route.source.project_id !== parsed.authority.source_project_id) {
    fail("batch_request_source_peer_mismatch", "source peer is not currently registered");
  }
  if (route.target.installation_id !== parsed.authority.target_installation_id || route.target.project_id !== parsed.authority.target_project_id) {
    fail("batch_request_target_identity_mismatch", "target identity does not match this installation/project");
  }
  if (!Array.isArray(route.registered_repositories) || route.registered_repositories.length === 0) {
    fail("invalid_batch_request_registered_route", "registered repositories are invalid");
  }
  const registered = new Set(route.registered_repositories.map((repository, index) => {
    const canonical = canonicalRepository(repository, `registered_repositories[${index}]`);
    if (canonical !== repository) fail("invalid_batch_request_registered_route", "registered repository must be canonical");
    return canonical;
  }));
  if (registered.size !== route.registered_repositories.length) {
    fail("invalid_batch_request_registered_route", "registered repositories are duplicated");
  }
  if (!registered.has(parsed.authority.coordination_repo) || parsed.authority.work_refs.some((reference) => !registered.has(reference.slice(0, reference.lastIndexOf("#"))))) {
    fail("batch_request_unregistered_repository", "authority references an unregistered repository");
  }
  return freeze({
    authority: parsed.authority,
    canonical_json: parsed.canonical_json,
    digest: parsed.digest,
  });
}

module.exports = {
  SCHEMA,
  AUTHORITY_FIELDS,
  MODES,
  START_POLICIES,
  BatchRequestContractError,
  parseBatchRequestAuthority,
  canonicalizeBatchRequestAuthority,
  assertBatchRequestRegistered,
};
