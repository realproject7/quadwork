"use strict";

// #1047: a closed, durable recovery receipt for one actual Head session
// generation.  The launcher supplies only lifecycle authority it already owns;
// this module reconstructs the user-visible record and the opaque resume tag.

const VERSION = 1;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const LIFECYCLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const BATCH_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const REASONS = new Set([
  "operator_start",
  "operator_reset",
  "operator_restart",
  "self_heal",
  "watchdog",
  "startup_restore",
]);

class HeadLifecycleNoticeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "HeadLifecycleNoticeError";
    this.code = code;
  }
}

function fail(code, message) { throw new HeadLifecycleNoticeError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }

function input(value) {
  exact(value, [
    "version", "project_id", "installation_id", "head_generation", "operation_id",
    "session_generation", "reason", "batch_id",
  ], "head_lifecycle_notice_invalid");
  if (value.version !== VERSION || typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) ||
      typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      !nonnegativeInteger(value.head_generation) || typeof value.operation_id !== "string" || !LIFECYCLE_ID_RE.test(value.operation_id) ||
      typeof value.session_generation !== "string" || !LIFECYCLE_ID_RE.test(value.session_generation) ||
      typeof value.reason !== "string" || !REASONS.has(value.reason) ||
      (value.batch_id !== null && (typeof value.batch_id !== "string" || !BATCH_RE.test(value.batch_id)))) {
    fail("head_lifecycle_notice_invalid", "Head lifecycle receipt is invalid");
  }
  return Object.freeze({
    version: VERSION,
    project_id: value.project_id,
    installation_id: value.installation_id,
    head_generation: value.head_generation,
    operation_id: value.operation_id,
    session_generation: value.session_generation,
    reason: value.reason,
    batch_id: value.batch_id,
  });
}

function headLifecycleNotice(value) {
  const event = input(value);
  const correlation_key = `head-lifecycle:${event.project_id}:${event.operation_id}:${event.session_generation}`;
  return Object.freeze({
    project_id: event.project_id,
    correlation_key,
    sender: "system",
    channel: "general",
    type: "system",
    text: `@head [HEAD RECOVERY] installation=${event.installation_id} reason=${event.reason} operation=${event.operation_id} session=${event.session_generation}`,
    trusted_event: Object.freeze({
      version: VERSION,
      scope: "head_lifecycle",
      correlation_key,
      anchors: Object.freeze({
        installation_id: event.installation_id,
        operation_id: event.operation_id,
        session_generation: event.session_generation,
        reason: event.reason,
      }),
    }),
    resume_structural: Object.freeze({
      version: VERSION,
      project_id: event.project_id,
      trusted: true,
      tag: "head_lifecycle",
      batch_id: event.batch_id,
      head_generation: event.head_generation,
      target: "head",
      server_authored: true,
    }),
  });
}

module.exports = {
  VERSION,
  REASONS,
  HeadLifecycleNoticeError,
  headLifecycleNotice,
};
