"use strict";

// #1047 M1: a deliberately pure projection for resuming Head from Primary
// Chat.  The caller is responsible for reading and normalising its source.
// This module never reads a chat file, interprets message prose, mutates a
// cursor, or wakes/dispatches a session.  Structural tags are an authenticated
// server-side input; text is carried through as opaque evidence only.

const crypto = require("node:crypto");

const VERSION = 1;
const SOURCE_ID = "primary-chat";
const MAX_RECORDS = 2048;
const MAX_PAGE_SIZE = 64;
const MAX_IDLE_HIGH_SIGNAL = 24;
const MAX_TEXT_BYTES = 64 * 1024;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BATCH_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const CURSOR_SECRET_RE = /^[A-Za-z0-9._~+\/=:-]{32,512}$/;
const AGENT_SENDERS = new Set(["user", "head", "dev", "re1", "re2", "system"]);
const RAW_TYPES = new Set(["message", "system", "trusted_event"]);
const FRESHNESS = new Set(["live", "stale"]);
const TAGS = new Set([
  "operator_head_mention",
  "head_assignment",
  "head_hold",
  "head_block",
  "worker_terminal",
  "ci_terminal",
  "monitor_terminal",
  "batch_request",
  "head_lifecycle",
]);
const ACTIVE_TAGS = new Set(TAGS);
const IDLE_HIGH_SIGNAL_TAGS = new Set([
  "head_assignment",
  "head_hold",
  "head_block",
  "worker_terminal",
  "ci_terminal",
  "monitor_terminal",
  "batch_request",
  "head_lifecycle",
]);

class ChatResumeProjectionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ChatResumeProjectionError";
    this.code = code;
  }
}

function fail(code, message) { throw new ChatResumeProjectionError(code, message); }
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
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function isIsoTimestamp(value) {
  if (typeof value !== "string" || value.length !== 24 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function jsonValue(value, depth = 0) {
  if (depth > 8 || value === null || typeof value === "string" || typeof value === "boolean") return depth <= 8;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => jsonValue(item, depth + 1));
  if (!plain(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([key, child]) => typeof key === "string" && key.length <= 128 && jsonValue(child, depth + 1));
}

function parseHead(value) {
  exact(value, ["agent_id", "generation"], "chat_resume_head_invalid");
  // Project-admission generations are zero-based in the lifecycle authority.
  // A newly configured project therefore legitimately starts at generation 0;
  // rejecting it would make the reset feed unavailable until an unrelated
  // archive/unarchive transition occurred.
  if (value.agent_id !== "head" || !nonnegativeInteger(value.generation)) fail("chat_resume_head_invalid", "Head identity is invalid");
  return freeze({ agent_id: "head", generation: value.generation });
}

function parseBatch(value, source) {
  exact(value, ["state", "batch_id", "starts_after_id", "head_generation"], "chat_resume_batch_invalid");
  if (!new Set(["active", "idle"]).has(value.state) || !nonnegativeInteger(value.starts_after_id) ||
      !nonnegativeInteger(value.head_generation) || value.head_generation !== source.head_generation) {
    fail("chat_resume_batch_invalid", "batch boundary is invalid");
  }
  if (value.starts_after_id > source.max_record_id) fail("chat_resume_batch_boundary_stale", "batch boundary is newer than the source snapshot");
  if (value.state === "active") {
    if (typeof value.batch_id !== "string" || !BATCH_ID_RE.test(value.batch_id)) fail("chat_resume_batch_invalid", "active batch id is invalid");
  } else if (value.batch_id !== null || value.starts_after_id !== 0) {
    // An idle query deliberately has no implicit previous-batch boundary.
    fail("chat_resume_batch_invalid", "idle batch must not retain an active boundary");
  }
  return freeze({ ...value });
}

function parseSource(value) {
  exact(value, ["source_id", "snapshot_id", "first_record_id", "max_record_id", "freshness", "cursor_secret"], "chat_resume_source_invalid");
  if (value.source_id !== SOURCE_ID || typeof value.snapshot_id !== "string" || !SNAPSHOT_ID_RE.test(value.snapshot_id) ||
      !nonnegativeInteger(value.first_record_id) || !nonnegativeInteger(value.max_record_id) ||
      value.first_record_id > value.max_record_id || !FRESHNESS.has(value.freshness) ||
      typeof value.cursor_secret !== "string" || !CURSOR_SECRET_RE.test(value.cursor_secret)) {
    fail("chat_resume_source_invalid", "source metadata is invalid");
  }
  if ((value.max_record_id === 0) !== (value.first_record_id === 0)) fail("chat_resume_source_invalid", "empty source boundary is inconsistent");
  return freeze({ ...value });
}

function parseRaw(value) {
  const allowed = new Set(["id", "seq", "ts", "sender", "channel", "type", "text", "mentions", "attachments", "trusted_event"]);
  if (!plain(value) || !Object.keys(value).every((key) => allowed.has(key))) fail("chat_resume_raw_invalid", "raw record contains an unknown field");
  const required = ["id", "seq", "ts", "sender", "channel", "type", "text", "mentions"];
  if (!required.every((field) => Object.prototype.hasOwnProperty.call(value, field)) || !positiveInteger(value.id) || value.seq !== value.id ||
      !isIsoTimestamp(value.ts) || !AGENT_SENDERS.has(value.sender) || value.channel !== "general" || !RAW_TYPES.has(value.type) ||
      typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > MAX_TEXT_BYTES || !Array.isArray(value.mentions) ||
      value.mentions.some((mention) => !["head", "dev", "re1", "re2"].includes(mention))) {
    fail("chat_resume_raw_invalid", "raw record is invalid");
  }
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || !jsonValue(value.attachments))) fail("chat_resume_raw_invalid", "raw attachments are invalid");
  if (value.trusted_event !== undefined && !jsonValue(value.trusted_event)) fail("chat_resume_raw_invalid", "raw trusted event is invalid");
  return clone(value);
}

function parseStructural(value) {
  exact(value, ["version", "project_id", "trusted", "tag", "batch_id", "head_generation", "target", "server_authored"], "chat_resume_structural_invalid");
  if (value.version !== VERSION || typeof value.project_id !== "string" || !PROJECT_ID_RE.test(value.project_id) || typeof value.trusted !== "boolean" ||
      !TAGS.has(value.tag) || !nonnegativeInteger(value.head_generation) || value.target !== "head" || typeof value.server_authored !== "boolean" ||
      (value.batch_id !== null && (typeof value.batch_id !== "string" || !BATCH_ID_RE.test(value.batch_id)))) {
    fail("chat_resume_structural_invalid", "structural tag is invalid");
  }
  return freeze({ ...value });
}

function tagMatchesRaw(raw, structural) {
  const tag = structural.tag;
  if (tag === "operator_head_mention") return raw.sender === "user" && raw.type === "message" && structural.server_authored === false;
  if (["head_assignment", "head_hold", "head_block"].includes(tag)) return raw.sender === "head" && raw.type === "message" && structural.server_authored === false;
  if (tag === "worker_terminal") return ["dev", "re1", "re2"].includes(raw.sender) && raw.type === "message" && structural.server_authored === false;
  if (["ci_terminal", "monitor_terminal"].includes(tag)) return raw.sender === "system" && raw.type === "trusted_event" && structural.server_authored === true;
  if (tag === "batch_request") return raw.sender === "system" && raw.type === "system" && structural.server_authored === true;
  return tag === "head_lifecycle" && raw.sender === "system" && raw.type === "system" && structural.server_authored === true;
}

function diagnostic(recordId, code) {
  return freeze({ record_id: recordId, code });
}

// Record shape failures are isolated with a diagnostic.  Ordering and source
// boundary failures are not recoverable: accepting them could make an opaque
// forward cursor silently drop or repeat a real message.
function parseRecords(records, projectId, source) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) fail("chat_resume_records_invalid", "records must be a bounded array");
  const valid = [];
  const diagnostics = [];
  let previousId = 0;
  let previousTimestamp = -Infinity;
  let seenSnapshot = source.max_record_id === 0;
  for (const item of records) {
    const roughId = plain(item) && plain(item.raw) && positiveInteger(item.raw.id) ? item.raw.id : null;
    if (roughId === null) {
      diagnostics.push(diagnostic(null, "malformed_record"));
      continue;
    }
    if (roughId <= previousId) fail("chat_resume_records_nonmonotonic", "record ids must be strictly increasing");
    previousId = roughId;
    let raw;
    let structural;
    try {
      if (!plain(item) || !Object.keys(item).every((key) => key === "raw" || key === "structural")) fail("chat_resume_record_invalid");
      raw = parseRaw(item.raw);
      structural = parseStructural(item.structural);
    } catch (error) {
      if (error instanceof ChatResumeProjectionError) {
        diagnostics.push(diagnostic(roughId, error.code));
        continue;
      }
      throw error;
    }
    const timestamp = Date.parse(raw.ts);
    if (timestamp < previousTimestamp) fail("chat_resume_records_nonmonotonic", "record timestamps must not move backwards");
    previousTimestamp = timestamp;
    if (raw.id === source.max_record_id) seenSnapshot = true;
    if (raw.id >= source.first_record_id && raw.id <= source.max_record_id && raw.id !== source.first_record_id + valid.length) {
      // A malformed row still occupies a sequence position, so continuity is
      // checked separately below against raw source ids rather than `valid`.
      // This branch deliberately does nothing.
    }
    valid.push(freeze({ raw: freeze(raw), structural }));
  }
  if (source.max_record_id > 0 && !seenSnapshot) fail("chat_resume_source_boundary_stale", "snapshot boundary record is absent");
  const inSnapshot = valid.filter((item) => item.raw.id >= source.first_record_id && item.raw.id <= source.max_record_id);
  if (source.max_record_id > 0) {
    const expectedCount = source.max_record_id - source.first_record_id + 1;
    // A malformed row is represented by one outer record with a usable id,
    // so it must still be in `valid` only after raw+structural validation.
    // Count raw ids directly to distinguish corruption from an intentional
    // diagnostic skip.
    const rawIds = records.map((item) => plain(item) && plain(item.raw) && positiveInteger(item.raw.id) ? item.raw.id : null)
      .filter((id) => id !== null && id >= source.first_record_id && id <= source.max_record_id);
    if (rawIds.length !== expectedCount || rawIds.some((id, index) => id !== source.first_record_id + index)) {
      fail("chat_resume_source_gap", "source snapshot is not a complete ordered range");
    }
  }
  return freeze({ records: freeze(valid), diagnostics: freeze(diagnostics) });
}

function activeEligible(item, batch, projectId) {
  const { raw, structural } = item;
  if (raw.id <= batch.starts_after_id || structural.project_id !== projectId || structural.head_generation !== batch.head_generation ||
      structural.batch_id !== batch.batch_id || !ACTIVE_TAGS.has(structural.tag) || !tagMatchesRaw(raw, structural)) return false;
  return true;
}

function idleEligible(item, batch, projectId) {
  const { raw, structural } = item;
  if (structural.project_id !== projectId || structural.head_generation !== batch.head_generation || !tagMatchesRaw(raw, structural)) return false;
  return structural.tag === "operator_head_mention" || IDLE_HIGH_SIGNAL_TAGS.has(structural.tag);
}

function projectionCandidates(parsed, projectId, batch, source) {
  const diagnostics = [...parsed.diagnostics];
  const admitted = [];
  for (const item of parsed.records) {
    const { raw, structural } = item;
    if (raw.id > source.max_record_id) {
      diagnostics.push(diagnostic(raw.id, "after_snapshot_boundary"));
      continue;
    }
    if (raw.id < source.first_record_id) {
      diagnostics.push(diagnostic(raw.id, "before_source_boundary"));
      continue;
    }
    if (structural.project_id !== projectId) {
      diagnostics.push(diagnostic(raw.id, "foreign_project_record"));
      continue;
    }
    if (structural.trusted !== true || !tagMatchesRaw(raw, structural)) {
      diagnostics.push(diagnostic(raw.id, "untrusted_type_or_tag"));
      continue;
    }
    if (structural.head_generation !== batch.head_generation) {
      diagnostics.push(diagnostic(raw.id, "foreign_head_generation"));
      continue;
    }
    const eligible = batch.state === "active" ? activeEligible(item, batch, projectId) : idleEligible(item, batch, projectId);
    if (!eligible) {
      diagnostics.push(diagnostic(raw.id, batch.state === "active" ? "outside_active_batch" : "not_idle_high_signal"));
      continue;
    }
    admitted.push(item);
  }

  let selected;
  if (batch.state === "active") {
    const lifecycle = admitted.filter((item) => item.structural.tag === "head_lifecycle");
    const newestLifecycleId = lifecycle.length ? lifecycle[lifecycle.length - 1].raw.id : null;
    selected = admitted.filter((item) => item.structural.tag !== "head_lifecycle" || item.raw.id === newestLifecycleId);
    for (const item of lifecycle) {
      if (item.raw.id !== newestLifecycleId) diagnostics.push(diagnostic(item.raw.id, "superseded_head_lifecycle"));
    }
  } else {
    const instructions = admitted.filter((item) => item.structural.tag === "operator_head_mention");
    const newestInstruction = instructions.length ? instructions[instructions.length - 1] : null;
    const lifecycle = admitted.filter((item) => item.structural.tag === "head_lifecycle");
    const newestLifecycleId = lifecycle.length ? lifecycle[lifecycle.length - 1].raw.id : null;
    const highSignal = admitted.filter((item) => item.structural.tag !== "operator_head_mention" &&
      (item.structural.tag !== "head_lifecycle" || item.raw.id === newestLifecycleId));
    const bounded = highSignal.slice(-MAX_IDLE_HIGH_SIGNAL);
    const byId = new Map(bounded.map((item) => [item.raw.id, item]));
    if (newestInstruction) byId.set(newestInstruction.raw.id, newestInstruction);
    selected = [...byId.values()].sort((left, right) => left.raw.id - right.raw.id);
    for (const item of lifecycle) if (item.raw.id !== newestLifecycleId) diagnostics.push(diagnostic(item.raw.id, "superseded_head_lifecycle"));
    for (const item of highSignal.slice(0, Math.max(0, highSignal.length - MAX_IDLE_HIGH_SIGNAL))) {
      diagnostics.push(diagnostic(item.raw.id, "idle_high_signal_bound"));
    }
    for (const item of instructions) if (!newestInstruction || item.raw.id !== newestInstruction.raw.id) {
      diagnostics.push(diagnostic(item.raw.id, "superseded_operator_instruction"));
    }
  }
  const ids = new Set();
  for (const item of selected) {
    if (ids.has(item.raw.id)) fail("chat_resume_projection_duplicate", "projection contains a duplicate record");
    ids.add(item.raw.id);
  }
  return freeze({ selected: freeze(selected), diagnostics: freeze(diagnostics) });
}

function sourceBoundary(source) {
  return freeze({ source_id: source.source_id, snapshot_id: source.snapshot_id, first_record_id: source.first_record_id, max_record_id: source.max_record_id });
}
function selectionDigest(selected) {
  return digest(selected.map((item) => ({ id: item.raw.id, structural: item.structural })));
}
function hmac(secret, body) { return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64url"); }
function encodeCursor(payload, secret) {
  const body = Buffer.from(JSON.stringify(canonical(payload)), "utf8").toString("base64url");
  return `qwr1.${body}.${hmac(secret, body)}`;
}
function decodeCursor(value, secret) {
  if (typeof value !== "string" || value.length > 2048) fail("chat_resume_cursor_invalid", "cursor is invalid");
  const pieces = value.split(".");
  if (pieces.length !== 3 || pieces[0] !== "qwr1" || !/^[A-Za-z0-9_-]+$/.test(pieces[1]) || !/^[A-Za-z0-9_-]{43}$/.test(pieces[2]) ||
      !crypto.timingSafeEqual(Buffer.from(pieces[2]), Buffer.from(hmac(secret, pieces[1])))) {
    fail("chat_resume_cursor_invalid", "cursor signature is invalid");
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8")); }
  catch { fail("chat_resume_cursor_invalid", "cursor body is invalid"); }
  exact(parsed, ["version", "project_id", "source_id", "snapshot_id", "first_record_id", "max_record_id", "batch_state", "batch_id", "head_generation", "selection_digest", "after_id"], "chat_resume_cursor_invalid");
  if (parsed.version !== VERSION || typeof parsed.project_id !== "string" || !PROJECT_ID_RE.test(parsed.project_id) || parsed.source_id !== SOURCE_ID ||
      typeof parsed.snapshot_id !== "string" || !SNAPSHOT_ID_RE.test(parsed.snapshot_id) || !nonnegativeInteger(parsed.first_record_id) ||
      !nonnegativeInteger(parsed.max_record_id) || !new Set(["active", "idle"]).has(parsed.batch_state) ||
      (parsed.batch_id !== null && (typeof parsed.batch_id !== "string" || !BATCH_ID_RE.test(parsed.batch_id))) || !nonnegativeInteger(parsed.head_generation) ||
      typeof parsed.selection_digest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.selection_digest) || !nonnegativeInteger(parsed.after_id)) {
    fail("chat_resume_cursor_invalid", "cursor payload is invalid");
  }
  return parsed;
}

function cursorPayload(projectId, source, batch, selected, afterId) {
  return freeze({
    version: VERSION,
    project_id: projectId,
    source_id: source.source_id,
    snapshot_id: source.snapshot_id,
    first_record_id: source.first_record_id,
    max_record_id: source.max_record_id,
    batch_state: batch.state,
    batch_id: batch.batch_id,
    head_generation: batch.head_generation,
    selection_digest: selectionDigest(selected),
    after_id: afterId,
  });
}

function assertCursorCurrent(cursor, projectId, source, batch, selected) {
  const expected = cursorPayload(projectId, source, batch, selected, cursor.after_id);
  for (const field of Object.keys(expected)) {
    if (cursor[field] !== expected[field]) fail("chat_resume_cursor_stale", "cursor does not bind this immutable source boundary");
  }
  if (cursor.after_id !== 0 && !selected.some((item) => item.raw.id === cursor.after_id)) {
    fail("chat_resume_cursor_stale", "cursor does not point at a projected record");
  }
}

function projectChatResume(input) {
  exact(input, ["version", "project_id", "archived", "head", "batch", "source", "records", "cursor", "limit"], "chat_resume_input_invalid");
  if (input.version !== VERSION || typeof input.project_id !== "string" || !PROJECT_ID_RE.test(input.project_id) || typeof input.archived !== "boolean") {
    fail("chat_resume_input_invalid", "projection input is invalid");
  }
  if (input.archived) fail("chat_resume_archived", "archived projects cannot resume Head chat");
  const head = parseHead(input.head);
  const source = parseSource(input.source);
  const batch = parseBatch(input.batch, { ...source, head_generation: head.generation });
  if (!positiveInteger(input.limit) || input.limit > MAX_PAGE_SIZE || (input.cursor !== null && typeof input.cursor !== "string")) {
    fail("chat_resume_input_invalid", "pagination input is invalid");
  }
  const parsed = parseRecords(input.records, input.project_id, source);
  const projection = projectionCandidates(parsed, input.project_id, batch, source);
  const selected = projection.selected;
  const cursor = input.cursor === null ? null : decodeCursor(input.cursor, source.cursor_secret);
  const afterId = cursor ? (assertCursorCurrent(cursor, input.project_id, source, batch, selected), cursor.after_id) : 0;
  const remaining = selected.filter((item) => item.raw.id > afterId);
  const page = remaining.slice(0, input.limit);
  const truncated = remaining.length > page.length;
  const nextCursor = truncated ? encodeCursor(cursorPayload(input.project_id, source, batch, selected, page[page.length - 1].raw.id), source.cursor_secret) : null;
  return freeze({
    version: VERSION,
    project_id: input.project_id,
    records: freeze(page.map((item) => freeze(clone(item.raw)))),
    source_boundary: sourceBoundary(source),
    next_cursor: nextCursor,
    truncated,
    freshness: source.freshness,
    diagnostics: projection.diagnostics,
  });
}

module.exports = {
  VERSION,
  SOURCE_ID,
  MAX_IDLE_HIGH_SIGNAL,
  ChatResumeProjectionError,
  projectChatResume,
};
