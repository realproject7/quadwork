"use strict";

// #1046 M9: the closed Primary Chat representation of one already-admitted
// Batch Request.  This is intentionally separate from the watcher and the
// chat store: it accepts only the watcher/runtime's exact Head plan and emits
// a small server-owned notice.  Human Issue prose, work refs, labels, ETags,
// and the full authority block never cross this boundary.

const {
  BatchRequestContractError,
  canonicalizeBatchRequestAuthority,
} = require("./batch-request-contract");
const { VERSION, dedupeKey } = require("./batch-request-subscription");

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const ISSUE_NUMBER_RE = /^[1-9]\d{0,6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MODES = new Set(["implementation", "ticket-review", "pr-review", "verification"]);
const START_POLICIES = new Set(["next-available", "hold"]);

class BatchRequestNoticeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "BatchRequestNoticeError";
    this.code = code;
  }
}

function fail(code, message) { throw new BatchRequestNoticeError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has unknown or missing fields");
  }
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function project(value, code) {
  if (typeof value !== "string" || !PROJECT_RE.test(value)) fail(code, "project identity is invalid");
  return value;
}
function generation(value, code) {
  // `captureProjectAdmission` is zero-based for a newly configured project.
  if (!Number.isSafeInteger(value) || value < 0) fail(code, "Head generation is invalid");
  return value;
}
function repository(value, code) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) fail(code, "coordination repository is invalid");
  return value;
}
function issueNumber(value, code) {
  if (!Number.isSafeInteger(value) || !ISSUE_NUMBER_RE.test(String(value))) fail(code, "Issue identity is invalid");
  return value;
}
function canonicalIssueUrl(value, repositoryValue, number, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) fail(code, "Issue URL is invalid");
  let parsed;
  try { parsed = new URL(value); }
  catch { fail(code, "Issue URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.host !== "api.github.com" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== `/repos/${repositoryValue}/issues/${number}` || parsed.toString() !== value) {
    fail(code, "Issue URL is invalid");
  }
  return value;
}
function authority(value, code) {
  let parsed;
  try { parsed = canonicalizeBatchRequestAuthority(value); }
  catch (error) {
    if (error instanceof BatchRequestContractError) fail(code, "Batch Request authority is invalid");
    throw error;
  }
  return parsed;
}

function notification(value, projectId, code) {
  exact(value, ["version", "kind", "recipients", "correlation_key", "issue_url", "anchors", "authority"], code);
  if (value.version !== VERSION || value.kind !== "BATCH REQUEST" || !Array.isArray(value.recipients) ||
      value.recipients.length !== 1 || value.recipients[0] !== "head") {
    fail(code, "notification is not an exact Head-only Batch Request");
  }
  exact(value.anchors, ["coordination_repo", "issue_number", "request_id", "authority_digest"], code);
  const coordinationRepository = repository(value.anchors.coordination_repo, code);
  const number = issueNumber(value.anchors.issue_number, code);
  if (typeof value.anchors.request_id !== "string" || !UUID_RE.test(value.anchors.request_id) ||
      typeof value.anchors.authority_digest !== "string" || !SHA_RE.test(value.anchors.authority_digest)) {
    fail(code, "notification anchors are invalid");
  }
  const issueUrl = canonicalIssueUrl(value.issue_url, coordinationRepository, number, code);
  const parsed = authority(value.authority, code);
  const source = parsed.authority;
  if (source.target_project_id !== projectId || source.request_id !== value.anchors.request_id ||
      source.coordination_repo !== coordinationRepository || parsed.digest !== value.anchors.authority_digest ||
      !MODES.has(source.mode) || !START_POLICIES.has(source.start_policy) ||
      value.correlation_key !== dedupeKey(coordinationRepository, number, source.request_id, parsed.digest)) {
    fail(code, "notification authority does not bind its target or anchors");
  }
  return freeze({
    correlation_key: value.correlation_key,
    issue_url: issueUrl,
    coordination_repo: coordinationRepository,
    issue_number: number,
    request_id: source.request_id,
    authority_digest: parsed.digest,
    source_installation_id: source.source_installation_id,
    mode: source.mode,
    start_policy: source.start_policy,
  });
}

function batchRequestNotice(value) {
  exact(value, ["project_id", "head_generation", "notification"], "invalid_batch_request_notice_input");
  const projectId = project(value.project_id, "invalid_batch_request_notice_input");
  const headGeneration = generation(value.head_generation, "invalid_batch_request_notice_input");
  const plan = notification(value.notification, projectId, "invalid_batch_request_notice_input");
  const anchors = freeze({
    coordination_repo: plan.coordination_repo,
    issue_number: plan.issue_number,
    request_id: plan.request_id,
    authority_digest: plan.authority_digest,
  });
  const metadata = freeze({
    scope: "batch_request",
    version: VERSION,
    correlation_key: plan.correlation_key,
    anchors,
  });
  return freeze({
    project_id: projectId,
    head_generation: headGeneration,
    correlation_key: plan.correlation_key,
    sender: "system",
    channel: "general",
    type: "system",
    text: `@head [BATCH REQUEST] request=${plan.request_id} issue=${plan.issue_url} source=${plan.source_installation_id} mode=${plan.mode} start=${plan.start_policy}`,
    trusted_event: metadata,
    resume_structural: freeze({
      version: 1,
      project_id: projectId,
      trusted: true,
      tag: "batch_request",
      batch_id: null,
      head_generation: headGeneration,
      target: "head",
      server_authored: true,
    }),
  });
}

module.exports = {
  BatchRequestNoticeError,
  batchRequestNotice,
};
