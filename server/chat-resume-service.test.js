"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { VERSION } = require("./chat-resume-projection");
const { ChatResumeServiceError, createChatResumeService } = require("./chat-resume-service");

const BINDING = Object.freeze({
  installation_id: "installation1047a",
  project_id: "quadwork-v2",
  agent_id: "head",
  generation: 7,
});
const SECRET = "resume-service-cursor-secret-0000000";
const BATCH = "batch-1047";

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function raw(id, overrides = {}) {
  return {
    id,
    seq: id,
    ts: `2026-09-02T00:00:${String(id).padStart(2, "0")}.000Z`,
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
    project_id: BINDING.project_id,
    trusted: true,
    tag,
    batch_id: BATCH,
    head_generation: BINDING.generation,
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
    defaults.raw = { sender: "system", type: "trusted_event", trusted_event: { credential: "not-for-head" } };
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
    snapshot_id: "snapshot-1047-service-a",
    first_record_id: max ? 1 : 0,
    max_record_id: max,
    freshness: "live",
    cursor_secret: SECRET,
    ...overrides,
  };
}
function facts(overrides = {}) {
  return {
    project_id: BINDING.project_id,
    archived: false,
    head: { agent_id: "head", generation: BINDING.generation },
    batch: { state: "active", batch_id: BATCH, starts_after_id: 0, head_generation: BINDING.generation },
    ...overrides,
  };
}
function request(overrides = {}) {
  return { principal: clone(BINDING), cursor: null, limit: 2, ...overrides };
}
function service(options = {}) {
  const calls = [];
  const currentFacts = options.facts || facts();
  const currentSnapshot = options.snapshot || { source: source(4), records: [record(1), record(2), record(3), record(4)] };
  const access = options.access || {
    authorize(input) {
      calls.push({ name: "authorize", input });
      return clone(BINDING);
    },
    read_facts(input) {
      calls.push({ name: "facts", input });
      return clone(currentFacts);
    },
    read_snapshot(input) {
      calls.push({ name: "snapshot", input });
      return clone(currentSnapshot);
    },
  };
  return { core: createChatResumeService({ binding: BINDING, access }), calls };
}
function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ChatResumeServiceError && error.code === code);
}
let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// Re-proving the bound Head and archive/head/batch state happens before the
// only source read. The downstream accessors see the fixed server binding,
// never caller-selected source or project material.
{
  const { core, calls } = service();
  const result = core.resume(request());
  assert.deepEqual(calls.map((call) => call.name), ["authorize", "facts", "snapshot"]);
  assert.deepEqual(calls[1].input, BINDING);
  assert.deepEqual(calls[2].input, BINDING);
  assert.deepEqual(Object.keys(result).sort(), ["diagnostics", "freshness", "next_cursor", "records", "source_boundary", "truncated"]);
  assert.deepEqual(result.records.map((item) => item.id), [1, 2]);
  assert.equal(result.truncated, true);
  ok(Object.isFrozen(result) && Object.isFrozen(result.records[0]), "authorization, lifecycle proof, and one snapshot read occur in safe order");
}

// The public operation has no source/batch/project/secret selector. Unknown
// request keys fail before any accessor can observe or reinterpret them.
{
  for (const override of [
    { source: source(4) },
    { batch: facts().batch },
    { project_id: "other-project" },
    { cursor_secret: SECRET },
  ]) {
    const { core, calls } = service();
    expectCode(() => core.resume({ ...request(), ...override }), "chat_resume_request_invalid");
    assert.deepEqual(calls, []);
  }
  ok(true, "caller cannot override the fixed project, batch, snapshot, or cursor secret");
}

// Active paging survives a new service instance because the opaque cursor is
// bound to a stable snapshot.  The projection still owns all cursor signing.
{
  const stable = { source: source(4), records: [record(1), record(2), record(3), record(4)] };
  const first = service({ snapshot: stable }).core.resume(request({ limit: 2 }));
  const restarted = service({ snapshot: clone(stable) }).core.resume(request({ cursor: first.next_cursor, limit: 4 }));
  assert.deepEqual(first.records.map((item) => item.id), [1, 2]);
  assert.deepEqual(restarted.records.map((item) => item.id), [3, 4]);
  assert.equal(restarted.next_cursor, null);
  ok(true, "active Head pages resume deterministically after a service restart");
}

// Project-admission lifecycle generations start at zero. The integration must
// therefore be able to construct the same Head-only service before an archive
// transition has ever occurred.
{
  const zeroBinding = { ...BINDING, generation: 0 };
  const zeroRecord = record(1);
  zeroRecord.structural.head_generation = 0;
  const core = createChatResumeService({
    binding: zeroBinding,
    access: {
      authorize: () => clone(zeroBinding),
      read_facts: () => ({
        project_id: BINDING.project_id,
        archived: false,
        head: { agent_id: "head", generation: 0 },
        batch: { state: "active", batch_id: BATCH, starts_after_id: 0, head_generation: 0 },
      }),
      read_snapshot: () => ({ source: source(1), records: [zeroRecord] }),
    },
  });
  assert.deepEqual(core.resume({ principal: zeroBinding, cursor: null, limit: 2 }).records.map((entry) => entry.id), [1]);
  ok(true, "the initial zero-based admission generation is a valid service binding");
}

// Idle is intentionally not an unbounded transcript replay. It retains the
// latest operator instruction plus the projection's bounded high-signal tail.
{
  const records = [record(1, "operator_head_mention", { structural: { batch_id: null } })];
  for (let id = 2; id <= 31; id += 1) records.push(record(id, "worker_terminal", { structural: { batch_id: `batch-${id}` } }));
  const idleFacts = facts({ batch: { state: "idle", batch_id: null, starts_after_id: 0, head_generation: BINDING.generation } });
  const result = service({ facts: idleFacts, snapshot: { source: source(31), records } }).core.resume(request({ limit: 64 }));
  assert.equal(result.records[0].id, 1);
  assert.deepEqual(result.records.slice(1).map((item) => item.id), Array.from({ length: 24 }, (_, index) => index + 8));
  ok(true, "idle Head receives only the bounded high-signal resume page");
}

// A concurrent append cannot move an already-issued source boundary.  The
// service snapshots source metadata and structural records together once.
{
  const stable = { source: source(3), records: [record(1), record(2), record(3)] };
  const first = service({ snapshot: stable }).core.resume(request({ limit: 1 }));
  const appended = { source: source(3), records: [record(1), record(2), record(3), record(4), record(5)] };
  const resumed = service({ snapshot: appended }).core.resume(request({ cursor: first.next_cursor, limit: 4 }));
  const fresh = service({ snapshot: { source: source(5, { snapshot_id: "snapshot-1047-service-b" }), records: appended.records } }).core.resume(request({ limit: 8 }));
  assert.deepEqual(resumed.records.map((item) => item.id), [2, 3]);
  assert.deepEqual(resumed.source_boundary, { source_id: "primary-chat", snapshot_id: "snapshot-1047-service-a", first_record_id: 1, max_record_id: 3 });
  assert.deepEqual(fresh.records.map((item) => item.id), [1, 2, 3, 4, 5]);
  ok(true, "concurrent append stays outside an immutable cursor snapshot until a fresh boundary");
}

// Stale cache data is visible as stale, while a stale/corrupt declared source
// boundary fails closed rather than silently falling back to another read.
{
  const stale = service({ snapshot: { source: source(1, { freshness: "stale" }), records: [record(1)] } }).core.resume(request());
  assert.equal(stale.freshness, "stale");
  expectCode(() => service({ snapshot: { source: source(3), records: [record(1), record(2)] } }).core.resume(request()), "chat_resume_source_boundary_stale");
  ok(true, "stale freshness is explicit and stale source boundaries fail closed");
}

// Dev/reviewer, cross-project, and old-generation identities are denied
// before authorization can obtain project facts or read chat source.
{
  for (const principal of [
    { ...BINDING, agent_id: "dev" },
    { ...BINDING, agent_id: "re1" },
    { ...BINDING, project_id: "other-project" },
    { ...BINDING, generation: BINDING.generation - 1 },
  ]) {
    const { core, calls } = service();
    expectCode(() => core.resume(request({ principal })), principal.project_id === "other-project" ? "chat_resume_project_denied" :
      principal.generation !== BINDING.generation ? "chat_resume_generation_stale" : "chat_resume_principal_denied");
    assert.deepEqual(calls, []);
  }
  const archived = service({ facts: facts({ archived: true }) });
  expectCode(() => archived.core.resume(request()), "chat_resume_archived");
  assert.deepEqual(archived.calls.map((call) => call.name), ["authorize", "facts"]);
  const staleHead = service({ facts: facts({ head: { agent_id: "head", generation: 8 }, batch: { state: "active", batch_id: BATCH, starts_after_id: 0, head_generation: 8 } }) });
  expectCode(() => staleHead.core.resume(request()), "chat_resume_generation_stale");
  assert.deepEqual(staleHead.calls.map((call) => call.name), ["authorize", "facts"]);
  ok(true, "identity, archive, and current Head-generation negatives cannot reach the source read");
}

// Invalid injected accessors and accessor exceptions have one redacted service
// error. Their raw failure messages, paths, and cursor secret do not cross the
// Head-facing boundary.
{
  expectCode(() => createChatResumeService({ binding: BINDING, access: { authorize() {}, read_facts() {} } }), "invalid_chat_resume_service_options");
  const badAuth = service({ access: {
    authorize() { throw new Error(`secret=${SECRET} path=/private/chat`); },
    read_facts() { assert.fail("must not run"); },
    read_snapshot() { assert.fail("must not run"); },
  } }).core;
  expectCode(() => badAuth.resume(request()), "chat_resume_authorization_unavailable");
  const badSnapshot = service({ access: {
    authorize() { return clone(BINDING); },
    read_facts() { return facts(); },
    read_snapshot() { throw new Error(`token=${SECRET}`); },
  } }).core;
  let error;
  try { badSnapshot.resume(request()); } catch (caught) { error = caught; }
  assert.equal(error.code, "chat_resume_source_unavailable");
  assert.equal(String(error).includes(SECRET), false);
  ok(true, "invalid and failing accessors are rejected before a transcript/result can leak");
}

// Optional raw authority is consumed only by the projection. It is not part
// of the service result, alongside source secret, structural tags, or a full
// transcript. The service itself has no filesystem/process/network import.
{
  const rich = record(1, "monitor_terminal", { raw: { attachments: [{ path: "/private/token.txt" }] } });
  const result = service({ snapshot: { source: source(1), records: [rich] } }).core.resume(request());
  assert.deepEqual(Object.keys(result.records[0]).sort(), ["channel", "id", "mentions", "sender", "seq", "text", "ts", "type"]);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(SECRET), false);
  assert.equal(encoded.includes('"trusted_event":'), false);
  assert.equal(encoded.includes('"attachments":'), false);
  assert.equal(encoded.includes("structural"), false);
  const sourceText = fs.readFileSync(path.join(__dirname, "chat-resume-service.js"), "utf8");
  assert.equal(/require\(["'](?:node:)?(?:fs|http|https|net|child_process|process)["']\)/.test(sourceText), false);
  assert.equal(/\b(?:process|fetch)\s*(?:\.|\()/.test(sourceText), false);
  ok(true, "public resume evidence excludes source credentials and raw authority without ambient I/O capability");
}

console.log(`\n${passed} chat resume service checks passed.`);
