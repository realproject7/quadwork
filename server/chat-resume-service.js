"use strict";

// #1047 M2: the read-only runtime boundary for Head's Primary Chat resume.
//
// This adapter deliberately owns no chat storage, transport, filesystem, or
// session lifecycle capability.  The integration layer supplies three narrow
// project-bound reads.  We prove the fixed Head binding and archive state
// before asking for a snapshot, clone that snapshot once, and then hand the
// immutable copy to the pure projection.

const {
  ChatResumeProjectionError,
  projectChatResume,
} = require("./chat-resume-projection");

const SOURCE_ID = "primary-chat";
const MAX_PAGE_SIZE = 64;
const MAX_RECORDS = 2048;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const BATCH_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SNAPSHOT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const CURSOR_SECRET_RE = /^[A-Za-z0-9._~+\/=:-]{32,512}$/;
const MAX_COPY_DEPTH = 16;
const MAX_COPY_NODES = 65536;
const SAFE_PROJECTION_CODES = new Set([
  "chat_resume_cursor_invalid",
  "chat_resume_cursor_stale",
  "chat_resume_source_boundary_stale",
  "chat_resume_source_gap",
  "chat_resume_records_nonmonotonic",
  "chat_resume_batch_boundary_stale",
]);

class ChatResumeServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ChatResumeServiceError";
    this.code = code;
  }
}

function fail(code, message) { throw new ChatResumeServiceError(code, message); }
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
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function sameBinding(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id &&
    left.agent_id === right.agent_id && left.generation === right.generation;
}

function binding(value, code, fixedHead = false) {
  exact(value, ["installation_id", "project_id", "agent_id", "generation"], code);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) ||
      typeof value.agent_id !== "string" || !AGENT_RE.test(value.agent_id) || !positiveInteger(value.generation)) {
    fail(code, "Head binding is invalid");
  }
  if (fixedHead && value.agent_id !== "head") fail(code, "service must be bound to Head");
  return freeze({
    installation_id: value.installation_id,
    project_id: value.project_id,
    agent_id: value.agent_id,
    generation: value.generation,
  });
}

// Snapshot accessors may be implemented over a mutable file/chat cache.  A
// descriptor-only clone rejects getters, proxies with hidden fields, circular
// structures, and non-JSON authorities before the projection can see them.
function immutableCopy(value, state = { seen: new WeakSet(), nodes: 0 }, depth = 0) {
  if (depth > MAX_COPY_DEPTH || state.nodes++ > MAX_COPY_NODES) throw new Error("snapshot is too complex");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("snapshot number is invalid");
    return value;
  }
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (state.seen.has(value) || value.length > MAX_RECORDS || Object.getOwnPropertySymbols(value).length || names.length !== value.length + 1 ||
        !names.includes("length") || keys.length !== value.length || keys.some((key, index) => key !== String(index)) ||
        keys.some((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.enumerable !== true;
        })) {
      throw new Error("snapshot array is invalid");
    }
    state.seen.add(value);
    const copied = value.map((item) => immutableCopy(item, state, depth + 1));
    state.seen.delete(value);
    return freeze(copied);
  }
  if (!plain(value) || state.seen.has(value) || Object.getOwnPropertySymbols(value).length) throw new Error("snapshot object is invalid");
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  if (names.length !== keys.length) throw new Error("snapshot object has hidden fields");
  state.seen.add(value);
  const copied = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.enumerable !== true) {
      throw new Error("snapshot object has an accessor field");
    }
    Object.defineProperty(copied, key, {
      value: immutableCopy(descriptor.value, state, depth + 1), enumerable: true, configurable: false, writable: false,
    });
  }
  state.seen.delete(value);
  return freeze(copied);
}

function accessors(value) {
  exact(value, ["authorize", "read_facts", "read_snapshot"], "invalid_chat_resume_service_options");
  if (typeof value.authorize !== "function" || typeof value.read_facts !== "function" || typeof value.read_snapshot !== "function") {
    fail("invalid_chat_resume_service_options", "chat resume accessors must be functions");
  }
  return value;
}
function request(value) {
  exact(value, ["principal", "cursor", "limit"], "chat_resume_request_invalid");
  const principal = binding(value.principal, "chat_resume_request_invalid");
  if (value.cursor !== null && (typeof value.cursor !== "string" || value.cursor.length > 2048)) {
    fail("chat_resume_request_invalid", "cursor is invalid");
  }
  if (!positiveInteger(value.limit) || value.limit > MAX_PAGE_SIZE) fail("chat_resume_request_invalid", "page limit is invalid");
  return freeze({ principal, cursor: value.cursor, limit: value.limit });
}
function assertRequestedHead(principal, owner) {
  if (principal.project_id !== owner.project_id) fail("chat_resume_project_denied", "principal project is not bound to this service");
  if (principal.agent_id !== "head" || principal.installation_id !== owner.installation_id) {
    fail("chat_resume_principal_denied", "only the bound Head may resume chat");
  }
  if (principal.generation !== owner.generation) fail("chat_resume_generation_stale", "Head generation is stale");
}
function authorizeOrFail(access, principal, owner) {
  let proof;
  try {
    proof = access.authorize(freeze({ principal: freeze({ ...principal }), binding: freeze({ ...owner }) }));
  } catch {
    fail("chat_resume_authorization_unavailable", "Head authorization cannot be proved");
  }
  let verified;
  try { verified = binding(proof, "chat_resume_authorization_unavailable", true); }
  catch { fail("chat_resume_authorization_unavailable", "Head authorization cannot be proved"); }
  if (!sameBinding(verified, owner) || !sameBinding(verified, principal)) {
    fail("chat_resume_authorization_denied", "Head authorization does not match this service binding");
  }
}
function parseHeadFact(value) {
  exact(value, ["agent_id", "generation"], "chat_resume_facts_unavailable");
  if (value.agent_id !== "head" || !positiveInteger(value.generation)) fail("chat_resume_facts_unavailable", "Head fact is invalid");
  return freeze({ agent_id: "head", generation: value.generation });
}
function parseBatchFact(value, generation) {
  exact(value, ["state", "batch_id", "starts_after_id", "head_generation"], "chat_resume_facts_unavailable");
  if (!new Set(["active", "idle"]).has(value.state) || !nonnegativeInteger(value.starts_after_id) ||
      !positiveInteger(value.head_generation) || value.head_generation !== generation) {
    fail("chat_resume_facts_unavailable", "batch fact is invalid");
  }
  if (value.state === "active") {
    if (typeof value.batch_id !== "string" || !BATCH_RE.test(value.batch_id)) fail("chat_resume_facts_unavailable", "active batch is invalid");
  } else if (value.batch_id !== null || value.starts_after_id !== 0) {
    fail("chat_resume_facts_unavailable", "idle batch has an active boundary");
  }
  return freeze({ state: value.state, batch_id: value.batch_id, starts_after_id: value.starts_after_id, head_generation: value.head_generation });
}
function factsOrFail(access, owner) {
  let value;
  try { value = access.read_facts(freeze({ ...owner })); }
  catch { fail("chat_resume_facts_unavailable", "Head lifecycle facts cannot be read"); }
  try {
    exact(value, ["project_id", "archived", "head", "batch"], "chat_resume_facts_unavailable");
    if (value.project_id !== owner.project_id || typeof value.archived !== "boolean") fail("chat_resume_facts_unavailable", "project facts are invalid");
    const head = parseHeadFact(value.head);
    if (head.generation !== owner.generation) fail("chat_resume_generation_stale", "active Head generation changed");
    const batch = parseBatchFact(value.batch, head.generation);
    return freeze({ archived: value.archived, head, batch });
  } catch (error) {
    if (error instanceof ChatResumeServiceError) throw error;
    fail("chat_resume_facts_unavailable", "Head lifecycle facts cannot be read");
  }
}
function sourceMetadata(value) {
  exact(value, ["source_id", "snapshot_id", "first_record_id", "max_record_id", "freshness", "cursor_secret"], "chat_resume_source_unavailable");
  if (value.source_id !== SOURCE_ID || typeof value.snapshot_id !== "string" || !SNAPSHOT_RE.test(value.snapshot_id) ||
      !nonnegativeInteger(value.first_record_id) || !nonnegativeInteger(value.max_record_id) ||
      value.first_record_id > value.max_record_id || !new Set(["live", "stale"]).has(value.freshness) ||
      typeof value.cursor_secret !== "string" || !CURSOR_SECRET_RE.test(value.cursor_secret) ||
      (value.max_record_id === 0) !== (value.first_record_id === 0)) {
    fail("chat_resume_source_unavailable", "snapshot metadata is invalid");
  }
  return value;
}
function snapshotOrFail(access, owner, batch) {
  let value;
  try { value = access.read_snapshot(freeze({ ...owner })); }
  catch { fail("chat_resume_source_unavailable", "Primary Chat snapshot cannot be read"); }
  let snapshot;
  try {
    snapshot = immutableCopy(value);
    exact(snapshot, ["source", "records"], "chat_resume_source_unavailable");
    const source = sourceMetadata(snapshot.source);
    if (!Array.isArray(snapshot.records) || snapshot.records.length > MAX_RECORDS) {
      fail("chat_resume_source_unavailable", "snapshot record collection is invalid");
    }
    if (batch.starts_after_id > source.max_record_id) {
      fail("chat_resume_batch_boundary_stale", "batch boundary is newer than this snapshot");
    }
  } catch (error) {
    if (error instanceof ChatResumeServiceError) throw error;
    fail("chat_resume_source_unavailable", "Primary Chat snapshot cannot be read");
  }
  return snapshot;
}
function projectionOrFail(input) {
  try { return projectChatResume(input); }
  catch (error) {
    if (error instanceof ChatResumeProjectionError && SAFE_PROJECTION_CODES.has(error.code)) fail(error.code, "chat resume projection rejected the immutable source");
    fail("chat_resume_projection_unavailable", "chat resume projection cannot be built");
  }
}

// Structural tags, attachments, and trusted-event envelopes are input-only
// authority.  Head receives a bounded evidence page, never that authority,
// source credentials, source paths, or the rest of the transcript.
function publicRecord(value) {
  const required = ["id", "seq", "ts", "sender", "channel", "type", "text", "mentions"];
  const allowed = new Set([...required, "attachments", "trusted_event"]);
  if (!plain(value) || !required.every((field) => Object.prototype.hasOwnProperty.call(value, field)) ||
      Object.keys(value).some((field) => !allowed.has(field))) {
    fail("chat_resume_projection_unavailable", "projection record is invalid");
  }
  return freeze({
    id: value.id,
    seq: value.seq,
    ts: value.ts,
    sender: value.sender,
    channel: value.channel,
    type: value.type,
    text: value.text,
    mentions: freeze([...value.mentions]),
  });
}
function publicResult(value) {
  try {
    exact(value, ["version", "project_id", "records", "source_boundary", "next_cursor", "truncated", "freshness", "diagnostics"], "chat_resume_projection_unavailable");
    exact(value.source_boundary, ["source_id", "snapshot_id", "first_record_id", "max_record_id"], "chat_resume_projection_unavailable");
    if (!Array.isArray(value.records) || !Array.isArray(value.diagnostics) || typeof value.truncated !== "boolean" ||
        (value.next_cursor !== null && typeof value.next_cursor !== "string") || !new Set(["live", "stale"]).has(value.freshness)) {
      fail("chat_resume_projection_unavailable", "projection result is invalid");
    }
    return freeze({
      records: freeze(value.records.map(publicRecord)),
      source_boundary: freeze({
        source_id: value.source_boundary.source_id,
        snapshot_id: value.source_boundary.snapshot_id,
        first_record_id: value.source_boundary.first_record_id,
        max_record_id: value.source_boundary.max_record_id,
      }),
      next_cursor: value.next_cursor,
      truncated: value.truncated,
      freshness: value.freshness,
      diagnostics: freeze(value.diagnostics.map((item) => {
        exact(item, ["record_id", "code"], "chat_resume_projection_unavailable");
        return freeze({ record_id: item.record_id, code: item.code });
      })),
    });
  } catch (error) {
    if (error instanceof ChatResumeServiceError) throw error;
    fail("chat_resume_projection_unavailable", "projection result is invalid");
  }
}

function createChatResumeService(options) {
  exact(options, ["binding", "access"], "invalid_chat_resume_service_options");
  const owner = binding(options.binding, "invalid_chat_resume_service_options", true);
  const access = accessors(options.access);

  function resume(input) {
    const query = request(input);
    // Keep all caller-controlled identity out of downstream reads.  In
    // particular, no source, batch, project, generation, or cursor secret can
    // select what a project-bound accessor returns.
    assertRequestedHead(query.principal, owner);
    authorizeOrFail(access, query.principal, owner);
    const facts = factsOrFail(access, owner);
    if (facts.archived) fail("chat_resume_archived", "archived projects cannot resume Head chat");
    const snapshot = snapshotOrFail(access, owner, facts.batch);
    const projected = projectionOrFail(freeze({
      version: 1,
      project_id: owner.project_id,
      archived: false,
      head: facts.head,
      batch: facts.batch,
      source: snapshot.source,
      records: snapshot.records,
      cursor: query.cursor,
      limit: query.limit,
    }));
    return publicResult(projected);
  }

  return freeze({ resume });
}

module.exports = {
  ChatResumeServiceError,
  createChatResumeService,
};
