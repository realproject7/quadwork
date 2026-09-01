"use strict";

const assert = require("node:assert/strict");
const { createChatResumeRuntime } = require("./chat-resume-runtime");

const PROJECT = "quadwork-v2";
const INSTALLATION = "installation1047a";
const TOKEN = "head-token-for-chat-resume-1047";
const SECRET = "chat-resume-runtime-cursor-secret-1047";
let archived = false;
let generation = 0;
let active = false;
let sourceReads = 0;
const sessions = new Map([[`${PROJECT}/head`, {
  projectId: PROJECT, agentId: "head", state: "running", term: {}, lifecycleState: "verified",
}]]);

function raw(id, overrides = {}) {
  const lifecycle = id === 1;
  return {
    id, seq: id, ts: `2026-08-30T00:00:0${id}.000Z`, sender: lifecycle ? "system" : "dev", channel: "general", type: lifecycle ? "system" : "message",
    text: lifecycle ? `@head [HEAD RECOVERY] ${id}` : "worker terminal status", mentions: lifecycle ? ["head"] : [],
    resume_structural: {
      version: 1, project_id: PROJECT, trusted: true, tag: lifecycle ? "head_lifecycle" : "worker_terminal", batch_id: "batch-1047",
      head_generation: generation, target: "head", server_authored: lifecycle,
    },
    ...overrides,
  };
}

const runtime = createChatResumeRuntime({
  read_config: () => ({ installation_id: INSTALLATION, projects: [{ id: PROJECT, archived }] }),
  capture_project_admission: (projectId) => ({ project_id: projectId, generation }),
  is_admission_current: (admission) => admission?.project_id === PROJECT && admission.generation === generation && !archived,
  is_project_archived: (_projectId, config) => config.projects[0].archived === true,
  resolve_shim_principal: (token) => token === TOKEN ? { projectId: PROJECT, agentId: "head" } : null,
  agent_sessions: sessions,
  read_live_batch_context: () => active ? {
    activated: true, queueReadOk: true, installationId: INSTALLATION,
    parsed: { provenance: "owned", batchNumber: 1047, errors: [], workItems: [{ ref: { number: 1 } }] },
  } : null,
  read_primary_chat_source: () => {
    sourceReads += 1;
    return { freshness: "live", records: [raw(1), raw(2)] };
  },
  find_active_batch_start: () => 0,
  read_cursor_secret: () => SECRET,
});

function call(token = TOKEN, body = { cursor: null, limit: 1 }) {
  return runtime.handle({ method: "POST", path: "/api/chat-resume", body }, { token });
}

const idle = call();
assert.equal(idle.ok, true);
assert.deepEqual(idle.records.map((record) => record.id), [1]);
assert.equal(idle.truncated, true);
assert.equal(idle.records[0].resume_structural, undefined);
assert.equal(JSON.stringify(idle).includes(SECRET), false);

const pageTwo = call(TOKEN, { cursor: idle.next_cursor, limit: 1 });
assert.equal(pageTwo.ok, true);
assert.deepEqual(pageTwo.records.map((record) => record.id), [2]);
assert.equal(pageTwo.next_cursor, null);

active = true;
const activeResult = call();
assert.equal(activeResult.ok, true);
assert.deepEqual(activeResult.records.map((record) => record.id), [1]);

const readsBeforeDenied = sourceReads;
assert.deepEqual(call("dev-token-for-chat-resume-1047"), { ok: false, error: { type: "chat_resume_unavailable" } });
assert.equal(sourceReads, readsBeforeDenied);
archived = true;
assert.deepEqual(call(), { ok: false, error: { type: "chat_resume_unavailable" } });
assert.equal(sourceReads, readsBeforeDenied);
archived = false;
const oldGeneration = generation;
generation = oldGeneration + 1;
assert.deepEqual(call(TOKEN, { cursor: idle.next_cursor, limit: 1 }), { ok: false, error: { type: "chat_resume_unavailable" } });
assert.deepEqual(runtime.revokeProject(PROJECT), { ok: true, resources: { chat_resume_services: 2 }, cleanup_errors: [] });
assert.deepEqual(runtime.revokeProject("bad/project"), {
  ok: false, resources: {}, cleanup_errors: [{ resource: "chat_resume", code: "invalid_project" }],
});

console.log("chat-resume-runtime.test.js: all assertions passed");
