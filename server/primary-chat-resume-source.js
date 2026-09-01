"use strict";

// #1047 M3: turn one server-owned, bounded Primary Chat window into the
// immutable source snapshot consumed by the resume service.  This is not a
// chat reader: storage and freshness are supplied through the two fixed
// readers below.  In particular, it never derives a trusted tag from text,
// mentions, sender, or a trusted-event envelope.

const crypto = require("node:crypto");

const VERSION = 1;
const SOURCE_ID = "primary-chat";
const MAX_RECORDS = 2048;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_COPY_DEPTH = 16;
const MAX_COPY_NODES = 65536;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BATCH_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const CURSOR_SECRET_RE = /^[A-Za-z0-9._~+\/=:-]{32,512}$/;
const AGENT_SENDERS = new Set(["user", "head", "dev", "re1", "re2", "system"]);
const RAW_TYPES = new Set(["message", "system", "trusted_event"]);
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
const RAW_FIELDS = new Set(["id", "seq", "ts", "sender", "channel", "type", "text", "mentions", "attachments", "trusted_event"]);
const REQUIRED_RAW_FIELDS = ["id", "seq", "ts", "sender", "channel", "type", "text", "mentions"];
const STRUCTURAL_FIELDS = ["version", "project_id", "trusted", "tag", "batch_id", "head_generation", "target", "server_authored"];

class PrimaryChatResumeSourceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "PrimaryChatResumeSourceError";
    this.code = code;
  }
}

function fail(code, message) { throw new PrimaryChatResumeSourceError(code, message); }
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
function isIsoTimestamp(value) {
  if (typeof value !== "string" || value.length !== 24 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
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
function jsonValue(value, depth = 0) {
  if (depth > 8 || value === null || typeof value === "string" || typeof value === "boolean") return depth <= 8;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => jsonValue(item, depth + 1));
  if (!plain(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([key, child]) => typeof key === "string" && key.length <= 128 && jsonValue(child, depth + 1));
}

// Clone descriptors only.  A read boundary may hand us a mutable in-memory
// array, but accessors, hidden fields, cycles, and non-JSON objects cannot
// cross into the immutable snapshot.
function immutableCopy(value, state = { seen: new WeakSet(), nodes: 0 }, depth = 0) {
  if (depth > MAX_COPY_DEPTH || state.nodes++ > MAX_COPY_NODES) throw new Error("source is too complex");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("source number is invalid");
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
      throw new Error("source array is invalid");
    }
    state.seen.add(value);
    const copied = value.map((item) => immutableCopy(item, state, depth + 1));
    state.seen.delete(value);
    return freeze(copied);
  }
  if (!plain(value) || state.seen.has(value) || Object.getOwnPropertySymbols(value).length) throw new Error("source object is invalid");
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  if (names.length !== keys.length) throw new Error("source object has hidden fields");
  state.seen.add(value);
  const copied = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.enumerable !== true) {
      throw new Error("source object has an accessor field");
    }
    Object.defineProperty(copied, key, {
      value: immutableCopy(descriptor.value, state, depth + 1), enumerable: true, configurable: false, writable: false,
    });
  }
  state.seen.delete(value);
  return freeze(copied);
}

function input(value) {
  exact(value, ["project_id", "head"], "invalid_primary_chat_resume_source_input");
  if (typeof value.project_id !== "string" || !PROJECT_ID_RE.test(value.project_id)) {
    fail("invalid_primary_chat_resume_source_input", "project identity is invalid");
  }
  exact(value.head, ["agent_id", "generation"], "invalid_primary_chat_resume_source_input");
  if (value.head.agent_id !== "head" || !positiveInteger(value.head.generation)) {
    fail("invalid_primary_chat_resume_source_input", "Head identity is invalid");
  }
  return freeze({ project_id: value.project_id, head: freeze({ agent_id: "head", generation: value.head.generation }) });
}

function parseRaw(value) {
  if (!plain(value) || !Object.keys(value).every((key) => RAW_FIELDS.has(key)) ||
      !REQUIRED_RAW_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value, field)) ||
      !positiveInteger(value.id) || value.seq !== value.id || !isIsoTimestamp(value.ts) || !AGENT_SENDERS.has(value.sender) ||
      value.channel !== "general" || !RAW_TYPES.has(value.type) || typeof value.text !== "string" ||
      Buffer.byteLength(value.text, "utf8") > MAX_TEXT_BYTES || !Array.isArray(value.mentions) ||
      value.mentions.some((mention) => !["head", "dev", "re1", "re2"].includes(mention)) ||
      (value.attachments !== undefined && (!Array.isArray(value.attachments) || !jsonValue(value.attachments))) ||
      (value.trusted_event !== undefined && !jsonValue(value.trusted_event))) {
    fail("primary_chat_resume_source_invalid", "raw record is invalid");
  }
  const raw = {};
  for (const field of Object.keys(value)) raw[field] = value[field];
  return freeze(raw);
}

function tagMatchesRaw(raw, structural) {
  const tag = structural.tag;
  if (tag === "operator_head_mention") return raw.sender === "user" && raw.type === "message" && structural.server_authored === false;
  if (["head_assignment", "head_hold", "head_block"].includes(tag)) return raw.sender === "head" && raw.type === "message" && structural.server_authored === false;
  if (tag === "worker_terminal") return ["dev", "re1", "re2"].includes(raw.sender) && raw.type === "message" && structural.server_authored === false;
  if (["ci_terminal", "monitor_terminal"].includes(tag)) return raw.sender === "system" && raw.type === "trusted_event" && structural.server_authored === true;
  return ["batch_request", "head_lifecycle"].includes(tag) && raw.sender === "system" && raw.type === "system" && structural.server_authored === true;
}

function persistedStructural(value, projectId, headGeneration, raw) {
  exact(value, STRUCTURAL_FIELDS, "primary_chat_resume_source_invalid");
  if (value.version !== VERSION || value.project_id !== projectId || typeof value.trusted !== "boolean" || !TAGS.has(value.tag) ||
      value.head_generation !== headGeneration || value.target !== "head" || typeof value.server_authored !== "boolean" ||
      (value.batch_id !== null && (typeof value.batch_id !== "string" || !BATCH_ID_RE.test(value.batch_id))) ||
      !tagMatchesRaw(raw, value)) {
    fail("primary_chat_resume_source_invalid", "persisted structural metadata is invalid");
  }
  return freeze({
    version: VERSION,
    project_id: projectId,
    trusted: value.trusted,
    tag: value.tag,
    batch_id: value.batch_id,
    head_generation: headGeneration,
    target: "head",
    server_authored: value.server_authored,
  });
}

// A legacy row may remain visible as opaque evidence, but it is deliberately
// unable to select into a Head resume projection.  Its tag does not describe
// the raw row and its false trust bit is never inferred from raw prose.
function inertStructural(projectId, headGeneration) {
  return freeze({
    version: VERSION,
    project_id: projectId,
    trusted: false,
    tag: "operator_head_mention",
    batch_id: null,
    head_generation: headGeneration,
    target: "head",
    server_authored: false,
  });
}

function recordsWindow(value, projectId, headGeneration) {
  exact(value, ["freshness", "records"], "primary_chat_resume_source_unavailable");
  // The reader is the live, server-owned boundary.  A stale cache is not an
  // immutable live resume cut, so it cannot mint a cursor-bound snapshot.
  if (value.freshness !== "live" || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) {
    fail("primary_chat_resume_source_unavailable", "Primary Chat source is unavailable");
  }
  const records = [];
  let previousId = 0;
  let previousTimestamp = -Infinity;
  for (const record of value.records) {
    if (!plain(record) || Object.keys(record).some((key) => key !== "resume_structural" && !RAW_FIELDS.has(key)) ||
        !REQUIRED_RAW_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(record, field))) {
      fail("primary_chat_resume_source_invalid", "Primary Chat record is invalid");
    }
    const rawValue = {};
    for (const field of Object.keys(record)) if (field !== "resume_structural") rawValue[field] = record[field];
    const raw = parseRaw(rawValue);
    if (raw.id <= previousId || Date.parse(raw.ts) < previousTimestamp) {
      fail("primary_chat_resume_source_invalid", "Primary Chat records are not ordered");
    }
    if (previousId && raw.id !== previousId + 1) {
      fail("primary_chat_resume_source_invalid", "Primary Chat record window has a gap");
    }
    previousId = raw.id;
    previousTimestamp = Date.parse(raw.ts);
    const structural = Object.prototype.hasOwnProperty.call(record, "resume_structural")
      ? persistedStructural(record.resume_structural, projectId, headGeneration, raw)
      : inertStructural(projectId, headGeneration);
    records.push(freeze({ raw, structural }));
  }
  return freeze(records);
}

function readOrFail(reader, projectId) {
  try { return reader(projectId); }
  catch { fail("primary_chat_resume_source_unavailable", "Primary Chat source is unavailable"); }
}

function createPrimaryChatResumeSource(options) {
  exact(options, ["read_records", "read_cursor_secret"], "invalid_primary_chat_resume_source_options");
  if (typeof options.read_records !== "function" || typeof options.read_cursor_secret !== "function") {
    fail("invalid_primary_chat_resume_source_options", "Primary Chat source readers must be functions");
  }

  return function read_snapshot(value) {
    const requested = input(value);
    let window;
    try { window = immutableCopy(readOrFail(options.read_records, requested.project_id)); }
    catch (error) {
      if (error instanceof PrimaryChatResumeSourceError) throw error;
      fail("primary_chat_resume_source_unavailable", "Primary Chat source is unavailable");
    }
    const records = recordsWindow(window, requested.project_id, requested.head.generation);
    let cursor_secret;
    try { cursor_secret = readOrFail(options.read_cursor_secret, requested.project_id); }
    catch (error) {
      if (error instanceof PrimaryChatResumeSourceError) throw error;
      fail("primary_chat_resume_source_unavailable", "Primary Chat source is unavailable");
    }
    if (typeof cursor_secret !== "string" || !CURSOR_SECRET_RE.test(cursor_secret)) {
      fail("primary_chat_resume_source_unavailable", "Primary Chat cursor secret is unavailable");
    }
    const max_record_id = records.length ? records[records.length - 1].raw.id : 0;
    const first_record_id = records.length ? records[0].raw.id : 0;
    const snapshot_id = `pcs1-${digest({
      version: VERSION,
      project_id: requested.project_id,
      head_generation: requested.head.generation,
      records,
    })}`;
    return freeze({
      source: freeze({
        source_id: SOURCE_ID,
        snapshot_id,
        first_record_id,
        max_record_id,
        freshness: "live",
        cursor_secret,
      }),
      records,
    });
  };
}

module.exports = {
  PrimaryChatResumeSourceError,
  createPrimaryChatResumeSource,
};
