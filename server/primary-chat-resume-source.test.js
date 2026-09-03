"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { VERSION, projectChatResume } = require("./chat-resume-projection");
const {
  PrimaryChatResumeSourceError,
  createPrimaryChatResumeSource,
} = require("./primary-chat-resume-source");

const PROJECT = "quadwork-v2";
const SECRET = "primary-chat-resume-source-secret-0000";
const BATCH = "batch-1047";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function raw(id, overrides = {}) {
  return {
    id,
    seq: id,
    ts: `2026-09-01T00:00:${String(id % 60).padStart(2, "0")}.000Z`,
    sender: "head",
    channel: "general",
    type: "message",
    text: `opaque record ${id}`,
    mentions: [],
    ...overrides,
  };
}
function structural(tag, overrides = {}) {
  return {
    version: VERSION,
    project_id: PROJECT,
    trusted: true,
    tag,
    batch_id: BATCH,
    head_generation: 7,
    target: "head",
    server_authored: false,
    ...overrides,
  };
}
function tagged(id, tag = "head_assignment", overrides = {}) {
  const defaults = {};
  if (tag === "operator_head_mention") defaults.raw = { sender: "user", type: "message", text: `@head opaque ${id}` };
  if (tag === "worker_terminal") defaults.raw = { sender: "dev", type: "message" };
  if (["ci_terminal", "monitor_terminal"].includes(tag)) {
    defaults.raw = { sender: "system", type: "trusted_event" };
    defaults.structural = { server_authored: true };
  }
  if (["review_cycle", "batch_request", "head_lifecycle"].includes(tag)) {
    defaults.raw = { sender: "system", type: "system" };
    defaults.structural = { server_authored: true };
  }
  return {
    ...raw(id, { ...(defaults.raw || {}), ...(overrides.raw || {}) }),
    resume_structural: structural(tag, { ...(defaults.structural || {}), ...(overrides.structural || {}) }),
  };
}

function window(records, overrides = {}) {
  return { freshness: "live", records, ...overrides };
}
function source(read_records, read_cursor_secret = () => SECRET) {
  const calls = [];
  const read_snapshot = createPrimaryChatResumeSource({
    read_records(project_id) {
      calls.push(["records", project_id]);
      return read_records(project_id);
    },
    read_cursor_secret(project_id) {
      calls.push(["secret", project_id]);
      return read_cursor_secret(project_id);
    },
  });
  return { read_snapshot, calls };
}
function request(overrides = {}) {
  return { project_id: PROJECT, head: { agent_id: "head", generation: 7 }, ...overrides };
}
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof PrimaryChatResumeSourceError && error.code === code);
}
function projection(snapshot) {
  return projectChatResume({
    version: VERSION,
    project_id: PROJECT,
    archived: false,
    head: { agent_id: "head", generation: 7 },
    batch: { state: "active", batch_id: BATCH, starts_after_id: 0, head_generation: 7 },
    source: snapshot.source,
    records: snapshot.records,
    cursor: null,
    limit: 64,
  });
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

{
  const review = tagged(1, "review_cycle");
  const snapshot = source(() => window([review])).read_snapshot(request());
  assert.equal(snapshot.records[0].structural.tag, "review_cycle");
  assert.deepEqual(projection(snapshot).records.map((entry) => entry.id), [1]);
  ok(true, "sealed review-cycle system records remain projection-ready evidence");
}

// A durable tag is carried exactly, while legacy prose that happens to say
// @head stays opaque and untrusted.  The returned shape goes directly into
// the existing projection without an integration-specific conversion.
{
  const records = [
    tagged(40, "head_assignment"),
    raw(41, { sender: "user", text: "@head this must not be inferred", mentions: ["head"] }),
    tagged(42, "batch_request"),
  ];
  const live = source(() => window(records));
  const snapshot = live.read_snapshot(request());
  assert.deepEqual(Object.keys(snapshot).sort(), ["records", "source"]);
  assert.deepEqual(Object.keys(snapshot.source).sort(), ["cursor_secret", "first_record_id", "freshness", "max_record_id", "snapshot_id", "source_id"]);
  assert.equal(snapshot.source.source_id, "primary-chat");
  assert.equal(snapshot.source.first_record_id, 40);
  assert.equal(snapshot.source.max_record_id, 42);
  assert.match(snapshot.source.snapshot_id, /^pcs1-[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.records[1].structural, {
    version: VERSION,
    project_id: PROJECT,
    trusted: false,
    tag: "operator_head_mention",
    batch_id: null,
    head_generation: 7,
    target: "head",
    server_authored: false,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.records[0].raw, "resume_structural"), false);
  assert.deepEqual(projection(snapshot).records.map((entry) => entry.id), [40, 42]);
  assert.equal(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.records) && Object.isFrozen(snapshot.records[0].raw), true);
  assert.deepEqual(live.calls, [["records", PROJECT], ["secret", PROJECT]]);
  ok(true, "mixed tagged and legacy windows become a bounded projection-ready immutable snapshot without prose inference");
}

// Persisted authority is project- and Head-generation-bound.  A malformed,
// foreign, or raw-incompatible tag is a source corruption, not a diagnostic
// that an integration layer could accidentally ignore.
for (const record of [
  tagged(1, "head_assignment", { structural: { project_id: "other-project" } }),
  tagged(1, "head_assignment", { structural: { head_generation: 8 } }),
  tagged(1, "head_assignment", { structural: { forged: true } }),
  tagged(1, "head_assignment", { raw: { sender: "dev" } }),
]) {
  const live = source(() => window([record]));
  throwsCode(() => live.read_snapshot(request()), "primary_chat_resume_source_invalid");
  assert.deepEqual(live.calls, [["records", PROJECT]]);
}
ok(true, "forged, foreign, malformed, and raw-incompatible persisted tags fail closed before any cursor secret read");

// The snapshot digest binds every output record and the Head generation.  It
// must change for either opaque evidence or persisted structural authority.
{
  const base = [tagged(1, "head_assignment"), tagged(2, "worker_terminal")];
  const changedRaw = copy(base);
  changedRaw[1].text = "different opaque evidence";
  const changedStructural = copy(base);
  changedStructural[1].resume_structural.batch_id = "batch-next";
  const nextGenerationRecords = copy(base);
  for (const record of nextGenerationRecords) record.resume_structural.head_generation = 8;
  const a = source(() => window(base)).read_snapshot(request()).source.snapshot_id;
  const b = source(() => window(changedRaw)).read_snapshot(request()).source.snapshot_id;
  const c = source(() => window(changedStructural)).read_snapshot(request()).source.snapshot_id;
  const nextGeneration = source(() => window(nextGenerationRecords)).read_snapshot(request({ head: { agent_id: "head", generation: 8 } })).source.snapshot_id;
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, nextGeneration);
  ok(true, "snapshot id deterministically binds raw evidence, structural authority, and Head generation");
}

// Admission generations are zero-based.  The first live Head must be able to
// obtain a source cut before an archive lifecycle transition has incremented
// that durable generation.
{
  const first = tagged(1, "head_assignment");
  first.resume_structural.head_generation = 0;
  const snapshot = source(() => window([first])).read_snapshot(request({ head: { agent_id: "head", generation: 0 } }));
  assert.equal(snapshot.records[0].structural.head_generation, 0);
  assert.match(snapshot.source.snapshot_id, /^pcs1-[a-f0-9]{64}$/);
  ok(true, "the initial zero-based admission generation remains a valid Head resume binding");
}

// A stale or malformed read is not a valid cursor cut.  Input selectors are
// likewise validated before either reader receives a project id.
for (const read_records of [
  () => window([], { freshness: "stale" }),
  () => ({ freshness: "live", records: { not: "an array" } }),
  () => { throw new Error("read failed"); },
]) {
  const live = source(read_records);
  throwsCode(() => live.read_snapshot(request()), "primary_chat_resume_source_unavailable");
  assert.deepEqual(live.calls, [["records", PROJECT]]);
}
{
  const live = source(() => window([]));
  throwsCode(() => live.read_snapshot({ ...request(), unexpected: true }), "invalid_primary_chat_resume_source_input");
  throwsCode(() => live.read_snapshot(request({ head: { agent_id: "dev", generation: 7 } })), "invalid_primary_chat_resume_source_input");
  assert.deepEqual(live.calls, []);
}
{
  const live = source(() => window([]), () => "short");
  throwsCode(() => live.read_snapshot(request()), "primary_chat_resume_source_unavailable");
  assert.deepEqual(live.calls, [["records", PROJECT], ["secret", PROJECT]]);
}
ok(true, "stale, malformed, and caller-selected source reads cannot mint a resume snapshot");

// This leaf has no ambient storage, route, network, timer, or process
// capability; its only reads are the two injected project-bound functions.
{
  const sourceText = fs.readFileSync(path.join(__dirname, "primary-chat-resume-source.js"), "utf8");
  assert.doesNotMatch(sourceText, /require\s*\(\s*["'](?:node:)?(?:fs|path|http|https|net|child_process|os)["']\s*\)/);
  assert.doesNotMatch(sourceText, /(?:Date\.now|setTimeout\s*\(|setInterval\s*\(|process\.|fetch\s*\()/);
  ok(true, "source adapter remains a pure two-reader capability boundary");
}

console.log(`\n${passed} primary chat resume source checks passed.`);
