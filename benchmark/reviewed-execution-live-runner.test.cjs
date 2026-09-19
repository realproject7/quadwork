'use strict';
const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const Module = require('node:module');
const profiles = require('../server/reviewed-execution-profiles');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const runner = require('./reviewed-execution-live-runner.cjs');
const outcome = require('./reviewed-execution-live-outcome.cjs');
function reportHarness() { const filename = path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'); const source = fs.readFileSync(filename, 'utf8').replace('module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });', 'module.exports = Object.freeze({ report, launchClaimState });'); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports; }
function activeHarness(claimState = 'claimed') { const filename = path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'); const injected = `let __removed = 0, __match = true; sourceFacts = () => fixed.facts; readGateReceipt = () => fixed.gate; launchClaimState = () => ${JSON.stringify(claimState)}; rootFacts = () => ({ entries: ["base"], root_digest: "a".repeat(64), entry_digest: "a".repeat(64), entry_count: 1 }); rootMatches = () => __match; removeOwnedRoot = () => { __removed += 1; return true; }; module.exports = Object.freeze({ set(state, match) { fixed = state; parentAdmitted = true; __match = match; }, completeFixedChild, removed: () => __removed });`; const source = fs.readFileSync(filename, 'utf8').replace('module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });', injected); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports; }
function resultHarness(mode) {
  const filename = path.join(__dirname, 'reviewed-execution-live-runner.cjs');
  const fakeFork = `const { EventEmitter } = require('node:events');
const resultHarnessMode = ${JSON.stringify(mode)};
const fork = (file, args, options) => {
  const child = new EventEmitter(); let secret = null;
  child.stdio = [null, null, null, null, { end(value) {
    secret = Buffer.from(value);
    queueMicrotask(() => child.emit('message', { type: 'reviewed_execution_ready', nonce: options.env.QUADWORK_REVIEWED_PARENT_NONCE, candidate_digest: options.env.QUADWORK_REVIEWED_CANDIDATE_DIGEST, worker_digest: options.env.QUADWORK_REVIEWED_WORKER_DIGEST, proof: crypto.createHmac('sha256', secret).update(options.env.QUADWORK_REVIEWED_PARENT_NONCE).digest('hex') }));
  } }];
  child.disconnect = () => {};
  child.kill = () => {};
  child.send = message => {
    if (message.type !== 'reviewed_execution_admit') return true;
    const profile = profiles.PROFILES.v2_codex_readonly_v1;
    const facts = { root_digest: 'a'.repeat(64), entry_digest: 'b'.repeat(64), entry_count: 1, remote_count: 0, changed_entry_count: 0 };
    const prelaunch = resultHarnessMode === 'prelaunch-refusal' || resultHarnessMode === 'prelaunch-cleanup-failure';
    const oneTurnUnsafe = resultHarnessMode === 'one-turn-unsafe'; const malformedClaim = resultHarnessMode === 'malformed-claim'; const invalidClaimStage = resultHarnessMode === 'invalid-claim-stage'; const zeroTurnCompleted = resultHarnessMode === 'zero-turn-completed'; const claimedNonzeroFailure = resultHarnessMode === 'claimed-nonzero-failure'; const claimedNonzeroCompleted = resultHarnessMode === 'claimed-nonzero-completed'; const unverifiedNonzeroFailure = resultHarnessMode === 'unverified-nonzero-failure';
    const cleanupFailure = resultHarnessMode === 'prelaunch-cleanup-failure' || oneTurnUnsafe;
    const postclaimFailure = malformedClaim || claimedNonzeroFailure || unverifiedNonzeroFailure;
    const report = { schema_version: 1, purpose: 'reviewed_v2_product_path_live_attempt', profile_id: profile.id, backend: profile.backend, model: profile.model, expected_head: null, candidate_digest: options.env.QUADWORK_REVIEWED_CANDIDATE_DIGEST, gate_receipt_digest: null, result_class: cleanupFailure ? 'cleanup_failed' : postclaimFailure ? 'attempt_indeterminate' : prelaunch ? 'preflight_blocked' : 'completed', provider_turns: prelaunch || zeroTurnCompleted ? 0 : 1, launch_claim_state: prelaunch || zeroTurnCompleted ? 'none' : malformedClaim || invalidClaimStage || unverifiedNonzeroFailure ? 'unverified' : 'claimed', failure_stage: invalidClaimStage || prelaunch || zeroTurnCompleted ? 'prelaunch' : cleanupFailure || postclaimFailure ? 'postclaim' : 'none', lifecycle_verified: !prelaunch && !malformedClaim, sentinel_digest: prelaunch || postclaimFailure ? null : 'c'.repeat(64), output_bytes: 0, output_capped: false, elapsed_ms: 0, root_cleanup_ok: !cleanupFailure, survivor_free: true, source_rechecked_before_prompt: !prelaunch, gate_rechecked_before_prompt: !prelaunch, pre_root_facts: facts, post_root_facts: facts, credential_copy_or_store_api_used: false, keychain_immutability_claimed: false, peer_level_network_filter_available: false, release_evidence: false };
    if (resultHarnessMode === 'duplicate') {
      queueMicrotask(() => { child.emit('exit', 0); setImmediate(() => { child.emit('message', { type: 'reviewed_execution_result', report }); setImmediate(() => child.emit('message', { type: 'reviewed_execution_result', report: { ...report, output_bytes: 7 } })); }); });
    } else if (prelaunch) {
      queueMicrotask(() => { child.emit('message', { type: 'reviewed_execution_result', report }); child.emit('exit', 0); });
    } else {
      process.nextTick(() => { child.emit('exit', claimedNonzeroFailure || claimedNonzeroCompleted || unverifiedNonzeroFailure ? 1 : 0); setImmediate(() => child.emit('message', { type: 'reviewed_execution_result', report })); });
    }
    return true;
  };
  return child;
};`;
  const source = fs.readFileSync(filename, 'utf8')
    .replace("const { fork } = require('node:child_process');", fakeFork)
    .replace('module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });', 'module.exports = Object.freeze({ run: runReviewedCodex });');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports;
}
function exitRaceHarness() { return resultHarness('exit-race'); }
function duplicateResultHarness() { return resultHarness('duplicate'); }
function prelaunchRefusalHarness() { return resultHarness('prelaunch-refusal'); }
function prelaunchCleanupFailureHarness() { return resultHarness('prelaunch-cleanup-failure'); }
function oneTurnUnsafeHarness() { return resultHarness('one-turn-unsafe'); }
function malformedClaimHarness() { return resultHarness('malformed-claim'); }
function invalidClaimStageHarness() { return resultHarness('invalid-claim-stage'); }
function zeroTurnCompletedHarness() { return resultHarness('zero-turn-completed'); }
function claimedNonzeroFailureHarness() { return resultHarness('claimed-nonzero-failure'); }
function claimedNonzeroCompletedHarness() { return resultHarness('claimed-nonzero-completed'); }
function unverifiedNonzeroFailureHarness() { return resultHarness('unverified-nonzero-failure'); }

test('public parent exposes only fixed no-input provider entries', () => {
  assert.deepEqual(Object.keys(runner).sort(), ['runReviewedClaude', 'runReviewedCodex']);
  for (const entry of Object.values(runner)) assert.equal(entry.length, 0);
});
test('parent has no server import, bridge, PTY, prompt, config or caller-controlled launch authority', () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-runner.cjs'), 'utf8');
  for (const forbidden of ['../server/index.js', 'runner-bridge', 'node-pty', 'WORKLOAD', 'buildAgentArgs', 'spawnAgentPty', 'reviewed_session']) assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(source, /verifyWorker\(filename\)/); assert.match(source, /fork\(verified\.file/); assert.match(source, /MAX_IPC_BYTES = 16 \* 1024/);
});
test('parent accepts a valid redacted result that is delivered adjacent to worker exit', async () => {
  const result = await exitRaceHarness().run();
  assert.equal(result.result_class, 'completed');
  assert.equal(result.provider_turns, 1);
  assert.equal(result.root_cleanup_ok, true);
  assert.equal(result.survivor_free, true);
});
test('parent preserves an attested claimed failure result after a later non-zero worker exit', async () => {
  const result = await claimedNonzeroFailureHarness().run();
  assert.equal(result.result_class, 'attempt_indeterminate');
  assert.equal(result.provider_turns, 1);
  assert.equal(result.launch_claim_state, 'claimed');
  assert.equal(result.root_cleanup_ok, true);
  assert.equal(result.survivor_free, true);
});
test('parent rejects claimed completion and unverified failure after a non-zero worker exit', async () => {
  for (const harness of [claimedNonzeroCompletedHarness, unverifiedNonzeroFailureHarness]) {
    const result = await harness().run();
    assert.equal(result.result_class, 'worker_cleanup_unverified');
    assert.equal(result.provider_turns, 1);
    assert.equal(result.launch_claim_state, 'unverified');
    assert.equal(result.failure_stage, 'parent_unverified');
    assert.equal(result.root_cleanup_ok, false);
    assert.equal(result.survivor_free, false);
  }
});
test('parent fails closed on a second valid terminal result and selects neither', async () => {
  const result = await duplicateResultHarness().run();
  assert.equal(result.result_class, 'worker_result_invalid');
  assert.equal(result.provider_turns, 1);
  assert.equal(result.root_cleanup_ok, false);
  assert.equal(result.survivor_free, false);
  assert.equal(result.output_bytes, 0);
});
test('parent returns valid zero-turn prelaunch refusal and cleanup failure reports unchanged', async () => {
  const refusal = await prelaunchRefusalHarness().run();
  assert.equal(refusal.result_class, 'preflight_blocked');
  assert.equal(refusal.provider_turns, 0);
  assert.equal(refusal.survivor_free, true);
  const cleanup = await prelaunchCleanupFailureHarness().run();
  assert.equal(cleanup.result_class, 'cleanup_failed');
  assert.equal(cleanup.provider_turns, 0);
  assert.equal(cleanup.root_cleanup_ok, false);
  assert.equal(cleanup.survivor_free, true);
});
test('parent refuses an unsafe one-turn report even when its IPC shape is valid', async () => {
  const result = await oneTurnUnsafeHarness().run();
  assert.equal(result.result_class, 'worker_cleanup_unverified');
  assert.equal(result.provider_turns, 1);
  assert.equal(result.root_cleanup_ok, false);
  assert.equal(result.survivor_free, false);
});
test('parent treats malformed launch claims as conservative postclaim one-turn reports', async () => {
  const result = await malformedClaimHarness().run();
  assert.equal(result.provider_turns, 1);
  assert.equal(result.launch_claim_state, 'unverified');
  assert.equal(result.failure_stage, 'postclaim');
});
test('parent rejects a contradictory claim state, turn, and failure stage', async () => {
  const result = await invalidClaimStageHarness().run();
  assert.equal(result.result_class, 'worker_result_invalid');
  assert.equal(result.launch_claim_state, 'unverified');
  assert.equal(result.failure_stage, 'parent_unverified');
});
test('parent rejects a fake zero-turn prelaunch completion before it can be selected', async () => {
  const result = await zeroTurnCompletedHarness().run();
  assert.equal(result.result_class, 'worker_result_invalid');
  assert.equal(result.provider_turns, 1);
  assert.equal(result.launch_claim_state, 'unverified');
  assert.equal(result.failure_stage, 'parent_unverified');
});
test('fixed workers carry source-fixed roles and prepare before loading the server', () => {
  for (const [file, role] of [['reviewed-execution-live-worker-codex.cjs', 'benchmark_codex'], ['reviewed-execution-live-worker-claude.cjs', 'benchmark_claude']]) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(source, new RegExp(`QUADWORK_REVIEWED_EXECUTION_CHILD_ROLE = '${role}'`));
    assert.match(source, /require\('\.\/reviewed-execution-live-child-protocol\.cjs'\)/);
    assert.doesNotMatch(source, /argv|prompt|command|runner-bridge|prepareFixedChild/);
  }
});
test('a directly started worker has no IPC admission and exits before preparation or provider launch', () => {
  for (const file of ['reviewed-execution-live-worker-codex.cjs', 'reviewed-execution-live-worker-claude.cjs']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { env: { PATH: process.env.PATH || '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
test('self-supplied IPC nonce, candidate, and worker hash still cannot admit without the parent-only pipe secret', async () => {
  const file = path.join(__dirname, 'reviewed-execution-live-worker-claude.cjs');
  const child = fork(file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH || '/usr/bin:/bin', QUADWORK_REVIEWED_EXECUTION_CHILD: '1', QUADWORK_REVIEWED_PARENT_NONCE: 'a'.repeat(64), QUADWORK_REVIEWED_CANDIDATE_DIGEST: profiles.candidateDigest(), QUADWORK_REVIEWED_WORKER_DIGEST: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } });
  const result = await new Promise(resolve => { let messages = 0; child.on('message', () => { messages += 1; }); child.once('exit', code => resolve({ code, messages })); });
  assert.deepEqual(result, { code: 1, messages: 0 });
});
test('server retains its launch closure and has no importable reviewed bridge', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /launch: \(\) => runReviewedExecution\(reviewedChildRole\)/);
  assert.match(server, /typeof process\.send === "function"/);
  assert.doesNotMatch(server, /reviewed-execution-runner-bridge/);
  assert.doesNotMatch(server.slice(server.indexOf('module.exports = {'), server.indexOf('module.exports.mcpProxies')), /runReviewedExecution/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'server', 'reviewed-execution-runner-bridge.js')), false);
});
test('legacy inspection is snapshot-only and rejects reviewed sessions', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /function inspectLegacySession\(key\)/);
  assert.match(server, /session\.reviewedExecution === true\) return null/);
  assert.match(server, /scrollback: Buffer\.isBuffer\(session\.scrollback\) \? session\.scrollback\.toString/);
  assert.doesNotMatch(server.slice(server.indexOf('module.exports = {'), server.indexOf('module.exports.mcpProxies')), /agentSessions/);
});
test('legacy mutable facade is guarded by the exact test flag and denies reviewed overwrite', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /process\.env\.QUADWORK_TEST_RUNTIME === "1"/);
  assert.match(server, /if \(!visible\(session\) \|\| !visible\(existing\) && existing\)/);
  assert.match(server, /module\.exports\.agentSessions = runtimeTestHooks\.agentSessions/);
});
test('child protocol has no test hook or caller-supplied launch surface and direct import cannot prepare', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'), 'utf8');
  assert.doesNotMatch(source, /testHooks|dependencies|ptySpawn/);
  assert.match(source, /rootMatches\(state\.pre, post\)/);
  const protocol = require('./reviewed-execution-live-child-protocol.cjs');
  await assert.rejects(() => protocol.prepareFixedChild({}), /child_state/);
});
test('fixed children wait for the parent result receipt before exiting', () => {
  const protocol = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(protocol, /function sendResultAndAwaitParent\(reportValue, exitCode\)/);
  assert.match(protocol, /reviewed_execution_result_ack/);
  assert.match(server, /const sendReviewedResultAndAwaitParent = \(report, exitCode\)/);
  assert.match(server, /reviewed_execution_result_ack/);
});

test('production pure evaluator accepts only the exact newline-delimited sentinel and binds the profile workload/cap', () => {
  const success = outcome.observe(['banner\n', `${outcome.SENTINEL}\n`]);
  assert.equal(outcome.WORKLOAD, `${profiles.WORKLOAD}\n`); assert.equal(outcome.OUTPUT_CAP_BYTES, 16 * 1024); assert.equal(success.sentinel, true);
  for (const chunks of [[`${outcome.SENTINEL} extra\n`], [`prefix ${outcome.SENTINEL}\n`], ['no sentinel\n']]) assert.equal(outcome.observe(chunks).sentinel, false);
});
test('production evaluator makes output cap, timeout, lifecycle, remote rejection, cleanup, root/git/env failures non-success', () => {
  assert.equal(outcome.observe(['x'.repeat(outcome.OUTPUT_CAP_BYTES + 1)]).output_capped, true);
  const baseline = { provider_turns: 1, lifecycle: 'verified', stop: true, shutdown: true, survivor: true, root: true, git: true, environment: true, sentinel: true };
  assert.equal(outcome.finalize({ ...baseline, output_capped: true }).result_class, 'output_cap_exceeded');
  assert.equal(outcome.finalize({ ...baseline, timed_out: true }).result_class, 'attempt_indeterminate');
  assert.equal(outcome.finalize({ ...baseline, lifecycle: 'spawned' }).result_class, 'attempt_indeterminate');
  assert.equal(outcome.finalize({ ...baseline, launch: false }).result_class, 'launch_failed');
  for (const field of ['stop', 'shutdown', 'survivor', 'root', 'git', 'environment']) { const value = outcome.finalize({ ...baseline, [field]: false }); assert.equal(value.result_class, 'cleanup_failed'); assert.equal(value.root_cleanup_ok, false); }
  for (const failed of ['stop', 'shutdown', 'survivor', 'root', 'git', 'environment']) { const effects = Object.fromEntries(['stop', 'shutdown', 'survivor', 'root', 'git', 'environment'].map(name => [name, () => name !== failed])); const value = outcome.finalizeEffects({ provider_turns: 1, lifecycle: 'verified', sentinel: true, effects }); assert.equal(value.result_class, 'cleanup_failed'); }
});
test('non-launching production report harness redacts prompt, output, path and token fields', () => {
  const profile = profiles.PROFILES.v2_claude_restricted_v1; const report = reportHarness().report(profile, { expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) }, { prompt: profiles.WORKLOAD, output: 'token=private', path: '/private/root', token: 'private', result_class: 'attempt_indeterminate' }); const text = JSON.stringify(report);
  for (const hidden of [profiles.WORKLOAD, 'token=private', '/private/root', 'private']) assert.equal(text.includes(hidden), false);
});
test('active protocol harness always attempts controlled removal and preserves cleanup_failed in normal/catch paths', async () => {
  const profile = profiles.PROFILES.v2_claude_restricted_v1; const makeState = () => ({ profile, facts: { expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) }, gate: { receipt_digest: 'c'.repeat(64) }, root: '/fake', locations: { home: '/fake-home' }, pre: { entries: ['base'] }, previous: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_SKIP_LISTEN: process.env.QUADWORK_SKIP_LISTEN }, started: Date.now() });
  const normal = activeHarness(); normal.set(makeState(), true); const listeners = []; const normalResult = await normal.completeFixedChild(profile.role, { buildAgentArgs: async () => {}, buildAgentEnv: () => ({}), launch: async () => ({ ok: true, reviewed_session: { onData: listener => listeners.push(listener), writeFixedWorkload: () => listeners.forEach(listener => listener(`${outcome.SENTINEL}\n`)) } }), stopAgentSession: async () => ({ ok: true, resources: { ptys: 1, sessions: 1 } }), shutdown: async () => ({ ok: true }) }); assert.equal(normal.removed(), 1); assert.notEqual(normalResult.result_class, 'cleanup_failed');
  const caught = activeHarness(); caught.set(makeState(), false); const caughtResult = await caught.completeFixedChild(profile.role, { buildAgentArgs: async () => {}, buildAgentEnv: () => ({}), launch: async () => { throw new Error('remote rejected'); }, stopAgentSession: async () => ({ ok: false, resources: {} }), shutdown: async () => ({ ok: true }) }); assert.equal(caught.removed(), 1); assert.equal(caughtResult.result_class, 'cleanup_failed'); assert.equal(caughtResult.provider_turns, 1);
});
test('claim evidence distinguishes absent, claimed, and malformed files without exposing a path', () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qw-reviewed-claim-'));
  try {
    fs.chmodSync(directory, 0o700);
    const profile = profiles.PROFILES.v2_codex_readonly_v1;
    const state = { profile, facts: { candidate_digest: 'a'.repeat(64) }, gate: { ledger_directory: directory, authorization_key: 'b'.repeat(64) } };
    const claims = reportHarness(); const launch = path.join(directory, `${state.gate.authorization_key}.launch`);
    assert.equal(claims.launchClaimState(state), 'none');
    fs.writeFileSync(launch, `${state.facts.candidate_digest}\n${profile.id}\n${state.gate.authorization_key}\n`, { mode: 0o600 }); fs.chmodSync(launch, 0o600);
    assert.equal(claims.launchClaimState(state), 'claimed');
    fs.writeFileSync(launch, 'malformed\n', { mode: 0o600 }); fs.chmodSync(launch, 0o600);
    assert.equal(claims.launchClaimState(state), 'unverified');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('active child makes preclaim and malformed-claim launch failures respectively zero-turn and conservative one-turn', async () => {
  const profile = profiles.PROFILES.v2_codex_readonly_v1;
  const makeState = () => ({ profile, facts: { expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) }, gate: { receipt_digest: 'c'.repeat(64) }, root: '/fake', locations: { home: '/fake-home' }, pre: { entries: ['base'] }, previous: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_SKIP_LISTEN: process.env.QUADWORK_SKIP_LISTEN }, started: Date.now() });
  for (const [claim, turns, stage] of [['none', 0, 'prelaunch'], ['unverified', 1, 'postclaim']]) {
    const active = activeHarness(claim); active.set(makeState(), true); let stops = 0, shutdowns = 0;
    const value = await active.completeFixedChild(profile.role, { buildAgentArgs: async () => {}, buildAgentEnv: () => ({}), launch: async () => { throw new Error('immutable local prerequisite unavailable'); }, stopAgentSession: async () => { stops += 1; return { ok: true, resources: { ptys: 1, sessions: 1 } }; }, shutdown: async () => { shutdowns += 1; return { ok: true }; } });
    assert.equal(value.provider_turns, turns); assert.equal(value.launch_claim_state, claim); assert.equal(value.failure_stage, stage); assert.equal(active.removed(), 1);
    assert.equal(stops, turns); assert.equal(shutdowns, turns);
  }
});
