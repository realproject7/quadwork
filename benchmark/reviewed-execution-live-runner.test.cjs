'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
function loadTestRunner() {
  const filename = path.join(__dirname, 'reviewed-execution-live-runner.cjs'); let source = fs.readFileSync(filename, 'utf8');
  source = source.replace('module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });', 'module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude, testHooks: Object.freeze({ attempt, disposableRootFacts, durableStopProof, gateFilename, postRootMatches, readGateReceipt, redactedReport, sourceFacts, withEnvironment }) });');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports;
}
const runner = loadTestRunner();
const contract = require('./reviewed-execution-contract.cjs');
const profiles = require('../server/reviewed-execution-profiles');

const profile = profiles.PROFILES.v2_claude_restricted_v1;
const facts = Object.freeze({ expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) });
function gate(parent, value) { fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(parent, 0o700); fs.writeFileSync(runner.testHooks.gateFilename(parent, profile, facts.candidate_digest), JSON.stringify(value), { mode: 0o600 }); }
function receipt() { return { schema_version: 1, reviewed_head: facts.expected_head, reviewed_candidate_digest: facts.candidate_digest, expected_head: facts.expected_head, candidate_digest: facts.candidate_digest, profile_id: profile.id, authorization_id: 'po-reviewed-authorization-0001', recorded_at: '2026-09-19T00:00:00.000Z', actions: { enabled: false }, cache: { active_size_bytes: 0 }, artifacts: { nonexpired_size_bytes: 0 } }; }

test('external PO receipt is fixed-path, exact-head/candidate/profile bound, and read-only to the runner', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewed-gate-')); fs.chmodSync(parent, 0o700);
  try {
    contract.consumeAuthorization({ ledger_parent: parent, candidate_digest: facts.candidate_digest, profile_id: profile.id, authorization_id: 'po-reviewed-authorization-0001' });
    gate(parent, receipt()); const read = runner.testHooks.readGateReceipt(profile, facts, parent, Date.parse('2026-09-19T00:00:01.000Z'), parent);
    assert.match(read.receipt_digest, /^[a-f0-9]{64}$/);
    assert.throws(() => runner.testHooks.readGateReceipt(profile, facts, parent, Date.parse('2026-09-19T00:16:00.000Z'), parent), /gate_drift/);
    fs.writeFileSync(runner.testHooks.gateFilename(parent, profile, facts.candidate_digest), JSON.stringify({ ...receipt(), expected_head: 'c'.repeat(40) }), { mode: 0o600 });
    assert.throws(() => runner.testHooks.readGateReceipt(profile, facts, parent, Date.parse('2026-09-19T00:00:01.000Z'), parent), /gate_drift/);
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
    async runReviewedClaude() { calls.push(['spawn']); return { ok: true }; },
    async stopAgentSession() { calls.push(['stop']); return { ok: true }; }, async shutdown() { calls.push(['shutdown']); return { ok: true }; },
  };
  const result = await runner.testHooks.attempt(profile, {
    sourceFacts: () => facts, readGateReceipt: () => ({ receipt_digest: 'd'.repeat(64) }), removeOwnedRoot: () => true,
    writeIsolatedConfig: () => ({ home: '/tmp', config_digest: 'e'.repeat(64) }), disposableRootFacts: () => ({ root_digest: 'f'.repeat(64), entry_digest: 'f'.repeat(64), entry_count: 0, entries: [], remote_count: 0, changed_entry_count: 0 }), durableStopProof: () => true, readDurableLifecycle: () => ({ roles: { [profile.role]: { state: 'verified' } } }), runtime, runnerBridge: { runReviewedClaude: async () => { calls.push(['spawn']); return { ok: true, reviewed_session: { onData: term.onData.bind(term), writeFixedWorkload: () => term.write(profiles.WORKLOAD + '\n') } }; } },
    prepare: async () => ({ root: '/fake', preflight: { result_class: 'preflight_ready' }, config: {} }),
  });
  assert.equal(wrote, profiles.WORKLOAD + '\n'); assert.equal(result.result_class, 'completed'); assert.equal(result.provider_turns, 1);
  assert.equal(result.source_rechecked_before_prompt, true); assert.equal(result.gate_rechecked_before_prompt, true); assert.deepEqual(calls.map(item => item[0]), ['args', 'env', 'spawn', 'stop', 'shutdown']);
});

test('fake source or receipt drift immediately before the fixed write is consumed and never sends a workload', async () => {
  let factReads = 0; let wrote = false; const term = { onData() {}, write() { wrote = true; } };
  const runtime = { agentSessions: new Map([[`${profiles.PROJECT}/${profile.role}`, { term, lifecycleState: 'verified' }]]), buildAgentArgs: async () => ({}), buildAgentEnv: () => ({}), runReviewedClaude: async () => ({ ok: true }), stopAgentSession: async () => ({ ok: true }), shutdown: async () => ({ ok: true }) };
  const result = await runner.testHooks.attempt(profile, {
    sourceFacts: () => (++factReads === 1 ? facts : { ...facts, expected_head: 'c'.repeat(40) }), readGateReceipt: () => ({ receipt_digest: 'd'.repeat(64) }), removeOwnedRoot: () => true,
    writeIsolatedConfig: () => ({ home: '/tmp' }), disposableRootFacts: () => ({ root_digest: 'f'.repeat(64), entry_digest: 'f'.repeat(64), entry_count: 0, entries: [], remote_count: 0, changed_entry_count: 0 }), durableStopProof: () => true, runtime, runnerBridge: { runReviewedClaude: async () => ({ ok: true, reviewed_session: { onData: term.onData.bind(term), writeFixedWorkload: () => term.write(profiles.WORKLOAD + '\n') } }) }, prepare: async () => ({ root: '/fake', preflight: { result_class: 'preflight_ready' }, config: {} }),
  });
  assert.equal(wrote, false); assert.equal(result.provider_turns, 1); assert.equal(result.result_class, 'attempt_indeterminate');
});

test('fake timeout, remote-style rejection, lifecycle failure, output cap, and cleanup failure are all non-success consumed outcomes', async () => {
  const base = (runtime, extra = {}) => runner.testHooks.attempt(profile, {
    sourceFacts: () => facts, readGateReceipt: () => ({ receipt_digest: 'd'.repeat(64) }), removeOwnedRoot: () => true,
    writeIsolatedConfig: () => ({ home: '/tmp' }), disposableRootFacts: () => ({ root_digest: 'f'.repeat(64), entry_digest: 'f'.repeat(64), entry_count: 0, entries: [], remote_count: 0, changed_entry_count: 0 }), durableStopProof: () => true,
    prepare: async () => ({ root: '/fake', preflight: { result_class: 'preflight_ready' }, config: {} }), runtime, runnerBridge: { runReviewedClaude: async () => { const session = runtime.agentSessions.get(`${profiles.PROJECT}/${profile.role}`); return session ? { ok: true, reviewed_session: { onData: session.term.onData.bind(session.term), writeFixedWorkload: () => session.term.write(profiles.WORKLOAD + '\n') } } : { ok: false }; } }, ...extra,
  });
  const rejected = { agentSessions: new Map(), buildAgentArgs: async () => ({}), buildAgentEnv: () => ({}), runReviewedClaude: async () => ({ ok: false }), stopAgentSession: async () => ({ ok: true }), shutdown: async () => ({ ok: true }) };
  assert.equal((await base(rejected)).result_class, 'launch_failed');
  const listeners = []; const term = { onData(fn) { listeners.push(fn); }, write() { for (const fn of listeners) fn('x'.repeat(16 * 1024 + 1)); } };
  const capped = { agentSessions: new Map([[`${profiles.PROJECT}/${profile.role}`, { term }]]), buildAgentArgs: async () => ({}), buildAgentEnv: () => ({}), runReviewedClaude: async () => ({ ok: true }), stopAgentSession: async () => ({ ok: true }), shutdown: async () => ({ ok: true }) };
  assert.equal((await base(capped, { readDurableLifecycle: () => ({ roles: { [profile.role]: { state: 'verified' } } }) })).result_class, 'output_cap_exceeded');
  const lifecycle = { agentSessions: new Map([[`${profiles.PROJECT}/${profile.role}`, { term: { onData() {}, write() {} } }]]), buildAgentArgs: async () => ({}), buildAgentEnv: () => ({}), runReviewedClaude: async () => ({ ok: true }), stopAgentSession: async () => ({ ok: true }), shutdown: async () => ({ ok: true }) };
  let clock = 0; assert.equal((await base(lifecycle, { now: () => (clock += 50_000), sleep: async () => {}, readDurableLifecycle: () => ({ roles: { [profile.role]: { state: 'spawned' } } }) })).result_class, 'attempt_indeterminate');
  const cleanup = { agentSessions: new Map([[`${profiles.PROJECT}/${profile.role}`, { term: { onData(fn) { this.fn = fn; }, write() { this.fn('QUADWORK_V2_PRODUCT_PATH_OK\n'); } } }]]), buildAgentArgs: async () => ({}), buildAgentEnv: () => ({}), runReviewedClaude: async () => ({ ok: true }), stopAgentSession: async () => ({ ok: false }), shutdown: async () => ({ ok: true }) };
  assert.equal((await base(cleanup, { readDurableLifecycle: () => ({ roles: { [profile.role]: { state: 'verified' } } }) })).result_class, 'cleanup_failed');
});

test('environment is restored, root facts are recursive/redacted, and reports retain no prompt/output/path/token', async () => {
  const before = process.env.HOME; await runner.testHooks.withEnvironment('/private/fake-home', async () => assert.equal(process.env.HOME, '/private/fake-home')); assert.equal(process.env.HOME, before);
  assert.equal(runner.testHooks.durableStopProof('/private/not-a-real-home', profile, { ok: true, resources: { ptys: 1, sessions: 1 } }), false, 'map absence alone is never a survivor proof');
  const report = runner.testHooks.redactedReport(profile, facts, { result_class: 'completed', provider_turns: 1, pre_root_facts: { root_digest: 'a'.repeat(64), entry_digest: 'b'.repeat(64), entry_count: 3, entries: ['/secret'], remote_count: 0, changed_entry_count: 0 }, post_root_facts: { root_digest: 'c'.repeat(64), entry_digest: 'd'.repeat(64), entry_count: 3, entries: ['/secret'], remote_count: 0, changed_entry_count: 0 }, prompt: profiles.WORKLOAD, output: 'token=private', path: '/private/path' });
  const text = JSON.stringify(report); for (const hidden of [profiles.WORKLOAD, 'token=private', '/private/path', '/secret']) assert.equal(text.includes(hidden), false);
  assert.equal(runner.testHooks.postRootMatches({ entries: ['home:d:700:a', 'home/.quadwork:d:700:a'] }, { entries: ['home:d:700:a', 'home/.quadwork:d:700:a', 'home/.quadwork/benchmark-product-path:d:700:a'] }), true);
  assert.equal(runner.testHooks.postRootMatches({ entries: ['home/.quadwork/config.json:f:600:a'] }, { entries: ['home/.quadwork/config.json:f:600:b'] }), false, 'content digest detects altered isolated config');
});

test('live source has exactly two no-input entry points, bounded in-memory output, and no receipt writer or HTTP route', () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-runner.cjs'), 'utf8');
  assert.match(source, /function runReviewedCodex\(\)/); assert.match(source, /function runReviewedClaude\(\)/);
  assert.match(source, /MAX_OUTPUT_BYTES = 16 \* 1024/); assert.match(source, /const finalFacts = factsFor\(repository\); gateReader/);
  assert.doesNotMatch(source, /createGate|writeGate|app\.post|http\.request|spawn\(/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /reviewedExecutionFixedLaunches/); assert.match(server, /reviewed_execution_fixed_runner_required/); assert.match(server, /function runReviewedCodex\(\)/); assert.match(server, /function runReviewedClaude\(\)/); assert.match(server, /term\._reviewedExecution === true/); assert.doesNotMatch(server.slice(server.indexOf('module.exports = {')), /runReviewedCodex|runReviewedClaude|agentSessions/); assert.equal(Object.hasOwn(require('./reviewed-execution-live-runner.cjs'), 'testHooks'), false);
});
