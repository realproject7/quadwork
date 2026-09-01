"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  VERSION,
  ChatResumeProjectionError,
  projectChatResume,
} = require("./chat-resume-projection");

const PROJECT = "quadwork-v2";
const SECRET = "resume-projection-cursor-secret-000000";
const BATCH = "batch-1047";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function raw(id, overrides = {}) {
  return {
    id,
    seq: id,
    ts: `2026-09-01T00:00:${String(id).padStart(2, "0")}.000Z`,
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
function record(id, tag = "head_assignment", options = {}) {
  const defaults = {};
  if (tag === "operator_head_mention") {
    defaults.raw = { sender: "user", type: "message", text: `@head opaque instruction ${id}` };
  } else if (tag === "worker_terminal") {
    defaults.raw = { sender: "dev", type: "message" };
  } else if (["ci_terminal", "monitor_terminal"].includes(tag)) {
    defaults.raw = { sender: "system", type: "trusted_event" };
    defaults.structural = { server_authored: true };
  } else if (["batch_request", "head_lifecycle"].includes(tag)) {
    defaults.raw = { sender: "system", type: "system" };
    defaults.structural = { server_authored: true };
  }
  return {
    raw: raw(id, { ...(defaults.raw || {}), ...(options.raw || {}) }),
    structural: structural(tag, { ...(defaults.structural || {}), ...(options.structural || {}) }),
  };
}
function source(max, overrides = {}) {
  return {
    source_id: "primary-chat",
    snapshot_id: "snapshot-1047-a",
    first_record_id: max ? 1 : 0,
    max_record_id: max,
    freshness: "live",
    cursor_secret: SECRET,
    ...overrides,
  };
}
function input(records, overrides = {}) {
  const max = records.length ? Math.max(...records.map((item) => item.raw.id)) : 0;
  return {
    version: VERSION,
    project_id: PROJECT,
    archived: false,
    head: { agent_id: "head", generation: 7 },
    batch: { state: "active", batch_id: BATCH, starts_after_id: 0, head_generation: 7 },
    source: source(max),
    records,
    cursor: null,
    limit: 2,
    ...overrides,
  };
}
function code(fn, expected) {
  assert.throws(fn, (error) => error instanceof ChatResumeProjectionError && error.code === expected);
}
let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// Active pages preserve source order.  The cursor is bound to the immutable
// snapshot, so a restart rebuild can safely request its second page.
{
  const records = [record(1, "operator_head_mention"), record(2, "head_assignment"), record(3, "worker_terminal"), record(4, "monitor_terminal")];
  const first = projectChatResume(input(records));
  assert.deepEqual(first.records.map((item) => item.id), [1, 2]);
  assert.equal(first.truncated, true);
  assert.match(first.next_cursor, /^qwr1\./);
  const second = projectChatResume(input(copy(records), { cursor: first.next_cursor }));
  assert.deepEqual(second.records.map((item) => item.id), [3, 4]);
  assert.equal(second.truncated, false);
  assert.equal(second.next_cursor, null);
  assert.equal(first.records[0].text, "@head opaque instruction 1");
  assert.equal(Object.isFrozen(first) && Object.isFrozen(first.records) && Object.isFrozen(first.records[0]), true);
  ok(true, "active projection pages ordered raw records without loss or duplicates across restart");
}

// A concurrent append cannot move a cursor's source cut.  Record 5 becomes
// visible only in a later fresh snapshot, never halfway through snapshot A.
{
  const stable = [record(1), record(2), record(3)];
  const first = projectChatResume(input(stable, { limit: 1 }));
  const appended = [...copy(stable), record(4), record(5)];
  const resumed = projectChatResume(input(appended, {
    source: source(3),
    cursor: first.next_cursor,
    limit: 4,
  }));
  assert.deepEqual(resumed.records.map((item) => item.id), [2, 3]);
  assert.deepEqual(resumed.source_boundary, { source_id: "primary-chat", snapshot_id: "snapshot-1047-a", first_record_id: 1, max_record_id: 3 });
  assert.ok(resumed.diagnostics.some((item) => item.record_id === 4 && item.code === "after_snapshot_boundary"));
  const fresh = projectChatResume(input(appended, { limit: 8 }));
  assert.deepEqual(fresh.records.map((item) => item.id), [1, 2, 3, 4, 5]);
  ok(true, "immutable source boundary excludes concurrent appends until a new snapshot");
}

// Structural tags, rather than prose, decide active admission.  A plain user
// message containing '@head' and a mismatched trusted type never enter Head's
// projection.
{
  const plainUser = record(1, "operator_head_mention", { structural: { trusted: false } });
  const staleBatch = record(2, "head_block", { structural: { batch_id: "batch-old" } });
  const wrongType = record(3, "ci_terminal", { raw: { type: "system" } });
  const headAsWorker = record(4, "worker_terminal", { raw: { sender: "head" } });
  const devAsHead = record(5, "head_hold", { raw: { sender: "dev" } });
  const reAsOperator = record(6, "operator_head_mention", { raw: { sender: "re1" } });
  const current = record(7, "head_hold");
  const result = projectChatResume(input([plainUser, staleBatch, wrongType, headAsWorker, devAsHead, reAsOperator, current], { limit: 8 }));
  assert.deepEqual(result.records.map((item) => item.id), [7]);
  assert.ok(result.diagnostics.some((item) => item.record_id === 1 && item.code === "untrusted_type_or_tag"));
  assert.ok(result.diagnostics.some((item) => item.record_id === 2 && item.code === "outside_active_batch"));
  assert.ok(result.diagnostics.some((item) => item.record_id === 3 && item.code === "untrusted_type_or_tag"));
  assert.ok([4, 5, 6].every((id) => result.diagnostics.some((item) => item.record_id === id && item.code === "untrusted_type_or_tag")));
  ok(true, "active projection rejects unauthorised Head, Dev, and reviewer tag/sender combinations");
}

// Only the newest server-authored lifecycle state is useful as a resume
// anchor.  It is selected without inspecting system-message text.
{
  const result = projectChatResume(input([record(1, "head_lifecycle"), record(2, "head_lifecycle"), record(3, "batch_request"), record(4, "head_assignment")], { limit: 8 }));
  assert.deepEqual(result.records.map((item) => item.id), [2, 3, 4]);
  assert.ok(result.diagnostics.some((item) => item.record_id === 1 && item.code === "superseded_head_lifecycle"));
  ok(true, "only the latest server-authored Head lifecycle is retained");
}

// Idle intentionally carries only a bounded high-signal tail plus the latest
// explicit operator instruction, even when that instruction predates the tail.
{
  const records = [record(1, "operator_head_mention", { structural: { batch_id: null } })];
  for (let id = 2; id <= 31; id += 1) records.push(record(id, "worker_terminal", { structural: { batch_id: `batch-${id}` } }));
  const result = projectChatResume(input(records, {
    batch: { state: "idle", batch_id: null, starts_after_id: 0, head_generation: 7 },
    limit: 64,
  }));
  assert.equal(result.records[0].id, 1);
  assert.deepEqual(result.records.slice(1).map((item) => item.id), Array.from({ length: 24 }, (_, index) => index + 8));
  assert.ok(result.diagnostics.some((item) => item.record_id === 2 && item.code === "idle_high_signal_bound"));
  ok(true, "idle projection is bounded while retaining the latest operator-to-Head instruction");
}

// Stale cache data remains visible as explicitly stale evidence; it is never
// quietly presented as a live source.
{
  const result = projectChatResume(input([record(1)], { source: source(1, { freshness: "stale" }) }));
  assert.equal(result.freshness, "stale");
  ok(true, "source freshness is explicit for stale cached input");
}

// Cross-project records, malformed rows, archive state, cursor substitution,
// and non-monotonic source rows each fail closed or leave an explicit receipt.
{
  const foreign = record(1, "head_assignment", { structural: { project_id: "other-project" } });
  const malformed = record(2);
  malformed.raw.text = 42;
  const current = record(3);
  const result = projectChatResume(input([foreign, malformed, current], { limit: 8 }));
  assert.deepEqual(result.records.map((item) => item.id), [3]);
  assert.ok(result.diagnostics.some((item) => item.record_id === 1 && item.code === "foreign_project_record"));
  assert.ok(result.diagnostics.some((item) => item.record_id === 2 && item.code === "chat_resume_raw_invalid"));
  code(() => projectChatResume(input([record(1)], { archived: true })), "chat_resume_archived");
  const first = projectChatResume(input([record(1), record(2)], { limit: 1 }));
  code(() => projectChatResume(input([record(1), record(2)], { source: source(2, { snapshot_id: "snapshot-1047-b" }), cursor: first.next_cursor })), "chat_resume_cursor_stale");
  code(() => projectChatResume(input([record(2), record(1)])), "chat_resume_records_nonmonotonic");
  ok(true, "corrupt, foreign, archived, and stale cursor inputs cannot create an unlabelled resume");
}

// The core is deliberately dependency-pure: it cannot pull in files, routes,
// network clients, or process state merely to build a projection.
{
  const sourceText = fs.readFileSync(path.join(__dirname, "chat-resume-projection.js"), "utf8");
  assert.equal(/require\(["'](?:node:)?(?:fs|http|https|net|child_process|process)["']\)/.test(sourceText), false);
  assert.equal(/\b(?:process|fetch)\s*(?:\.|\()/.test(sourceText), false);
  ok(true, "projection remains pure and has no file/network/route/process capability");
}

console.log(`\n${passed} chat resume projection checks passed.`);
