'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const runner = require('./reviewed-execution-live-runner.cjs');
const profiles = require('../server/reviewed-execution-profiles');

const profile = profiles.PROFILES.v2_claude_restricted_v1;
const facts = Object.freeze({ expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) });
function gate(parent, value) { fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(parent, 0o700); fs.writeFileSync(runner.testHooks.gateFilename(parent, profile, facts.candidate_digest), JSON.stringify(value), { mode: 0o600 }); }
function receipt() { return { schema_version: 1, expected_head: facts.expected_head, candidate_digest: facts.candidate_digest, profile_id: profile.id, recorded_at: '2026-09-19T00:00:00.000Z', actions: { enabled: false }, cache: { active_size_bytes: 0 }, artifacts: { nonexpired_size_bytes: 0 } }; }

test('external PO receipt is fixed-path, exact-head/candidate/profile bound, and read-only to the runner', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewed-gate-')); fs.chmodSync(parent, 0o700);
  try {
    gate(parent, receipt()); const read = runner.testHooks.readGateReceipt(profile, facts, parent);
    assert.match(read.receipt_digest, /^[a-f0-9]{64}$/);
    fs.writeFileSync(runner.testHooks.gateFilename(parent, profile, facts.candidate_digest), JSON.stringify({ ...receipt(), expected_head: 'c'.repeat(40) }), { mode: 0o600 });
    assert.throws(() => runner.testHooks.readGateReceipt(profile, facts, parent), /gate_drift/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('fake-only zero-turn preflight failure never admits a V2 launch', async () => {
  let launched = false;
  const result = await runner.testHooks.attempt(profile, {
    sourceFacts: () => facts, readGateReceipt: () => ({ receipt_digest: 'd'.repeat(64) }), removeOwnedRoot: () => true,
    prepare: async () => ({ root: '/fake', preflight: { result_class: 'preflight_blocked' } }),
    runtime: { spawnReviewedClaude: async () => { launched = true; } },
  });
  assert.equal(result.provider_turns, 0); assert.equal(result.result_class, 'preflight_blocked'); assert.equal(launched, false);
});

test('fake-only fixed V2 chain has no caller-provided prompt/argv/env and consumes exactly one attempt', async () => {
  const listeners = []; let wrote = ''; const calls = [];
  const term = { onData(listener) { listeners.push(listener); }, write(value) { wrote = value; for (const listener of listeners) listener('QUADWORK_V2_PRODUCT_PATH_OK\n'); } };
  const runtime = {
    agentSessions: new Map([[`${profiles.PROJECT}/${profile.role}`, { term, lifecycleState: 'verified' }]]),
    async buildAgentArgs(project, role) { calls.push(['args', project, role]); return { args: [] }; },
    buildAgentEnv(project, role) { calls.push(['env', project, role]); return {}; },
    async spawnReviewedClaude() { calls.push(['spawn']); return { ok: true }; },
    async stopAgentSession() { calls.push(['stop']); return { ok: true }; }, async shutdown() { calls.push(['shutdown']); return { ok: true }; },
  };
  const result = await runner.testHooks.attempt(profile, {
    sourceFacts: () => facts, readGateReceipt: () => ({ receipt_digest: 'd'.repeat(64) }), removeOwnedRoot: () => true,
    writeIsolatedConfig: () => ({ home: '/tmp', config_digest: 'e'.repeat(64) }), disposableRootFacts: () => ({ root_digest: 'f'.repeat(64), remote_count: 0, changed_entry_count: 0 }), runtime,
    prepare: async () => ({ root: '/fake', preflight: { result_class: 'preflight_ready' }, config: {} }),
  });
  assert.equal(wrote, profiles.WORKLOAD + '\n'); assert.equal(result.result_class, 'completed'); assert.equal(result.provider_turns, 1);
  assert.equal(result.source_rechecked_before_prompt, true); assert.equal(result.gate_rechecked_before_prompt, true); assert.deepEqual(calls.map(item => item[0]), ['args', 'env', 'spawn', 'stop', 'shutdown']);
});

test('fake source or receipt drift immediately before the fixed write is consumed and never sends a workload', async () => {
  let factReads = 0; let wrote = false; const term = { onData() {}, write() { wrote = true; } };
  const runtime = { agentSessions: new Map([[`${profiles.PROJECT}/${profile.role}`, { term, lifecycleState: 'verified' }]]), buildAgentArgs: async () => ({}), buildAgentEnv: () => ({}), spawnReviewedClaude: async () => ({ ok: true }), stopAgentSession: async () => ({ ok: true }), shutdown: async () => ({ ok: true }) };
  const result = await runner.testHooks.attempt(profile, {
    sourceFacts: () => (++factReads === 1 ? facts : { ...facts, expected_head: 'c'.repeat(40) }), readGateReceipt: () => ({ receipt_digest: 'd'.repeat(64) }), removeOwnedRoot: () => true,
    writeIsolatedConfig: () => ({ home: '/tmp' }), disposableRootFacts: () => ({ root_digest: 'f'.repeat(64), remote_count: 0, changed_entry_count: 0 }), runtime, prepare: async () => ({ root: '/fake', preflight: { result_class: 'preflight_ready' }, config: {} }),
  });
  assert.equal(wrote, false); assert.equal(result.provider_turns, 1); assert.equal(result.result_class, 'attempt_indeterminate');
});

test('live source has exactly two no-input entry points, bounded in-memory output, and no receipt writer or HTTP route', () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-runner.cjs'), 'utf8');
  assert.match(source, /function runReviewedCodex\(\)/); assert.match(source, /function runReviewedClaude\(\)/);
  assert.match(source, /MAX_OUTPUT_BYTES = 16 \* 1024/); assert.match(source, /const finalFacts = factsFor\(repository\); gateReader/);
  assert.doesNotMatch(source, /createGate|writeGate|app\.post|http\.request|spawn\(/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /reviewedExecutionLaunchKeys/); assert.match(server, /spawnReviewedCodex\(\)/); assert.match(server, /reviewed_execution_caller_unauthorized/);
});
