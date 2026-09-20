'use strict';
const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const Module = require('node:module');
const profiles = require('../server/reviewed-execution-profiles');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const runner = require('./reviewed-execution-live-runner.cjs');
const outcome = require('./reviewed-execution-live-outcome.cjs');
const providerStateBoundary = require('./reviewed-execution-provider-state-boundary.cjs');
function reportHarness() { const filename = path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'); const source = fs.readFileSync(filename, 'utf8').replace('module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });', 'module.exports = Object.freeze({ report, launchClaimState });'); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports; }
function shapeHarness() { const filename = path.join(__dirname, 'reviewed-execution-live-runner.cjs'); const source = fs.readFileSync(filename, 'utf8').replace('module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });', 'module.exports = Object.freeze({ reportShape });'); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports; }
function finalMessageHarness() { const filename = path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'); const injected = 'module.exports = Object.freeze({ cleanupRootIdentity, createCodexFinalMessage, consumeCodexFinalMessage, cleanupCodexFinalMessage });'; const source = fs.readFileSync(filename, 'utf8').replace('module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });', injected); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports; }
function activeHarness(claimState = 'claimed') { const filename = path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'); const injected = `let __removed = 0, __match = true; sourceFacts = () => fixed.facts; readGateReceipt = () => fixed.gate; launchClaimState = () => ${JSON.stringify(claimState)}; rootFacts = () => ({ entries: ["base"], root_digest: "a".repeat(64), entry_digest: "a".repeat(64), entry_count: 1 }); rootMatches = () => __match; removeOwnedRoot = () => { __removed += 1; return true; }; module.exports = Object.freeze({ set(state, match) { fixed = state; parentAdmitted = true; __match = match; }, completeFixedChild, removed: () => __removed });`; const source = fs.readFileSync(filename, 'utf8').replace('module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });', injected); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports; }
function resultHarness(mode) {
  const filename = path.join(__dirname, 'reviewed-execution-live-runner.cjs');
  const fakeFork = `const { EventEmitter } = require('node:events');
const resultHarnessMode = ${JSON.stringify(mode)};
const fork = (file, args, options) => {
  const child = new EventEmitter(); child.pid = 12345; let secret = null;
  const secretPipe = new EventEmitter();
  secretPipe.end = value => {
    secret = Buffer.from(value);
    queueMicrotask(() => { child.emit('spawn'); child.emit('message', { type: 'reviewed_execution_ready', nonce: options.env.QUADWORK_REVIEWED_PARENT_NONCE, candidate_digest: options.env.QUADWORK_REVIEWED_CANDIDATE_DIGEST, worker_digest: options.env.QUADWORK_REVIEWED_WORKER_DIGEST, proof: crypto.createHmac('sha256', secret).update(options.env.QUADWORK_REVIEWED_PARENT_NONCE).digest('hex') }); });
  };
  child.stdio = [null, null, null, null, secretPipe];
  child.disconnect = () => {};
  child.kill = () => {};
  child.send = message => {
    if (message.type !== 'reviewed_execution_admit') return true;
    const profile = profiles.PROFILES.v2_codex_readonly_v1;
    const facts = { root_digest: 'a'.repeat(64), entry_digest: 'b'.repeat(64), entry_count: 1, remote_count: 0, changed_entry_count: 0 };
    const prelaunch = resultHarnessMode === 'prelaunch-refusal' || resultHarnessMode === 'prelaunch-cleanup-failure';
    const oneTurnUnsafe = resultHarnessMode === 'one-turn-unsafe'; const malformedClaim = resultHarnessMode === 'malformed-claim'; const invalidClaimStage = resultHarnessMode === 'invalid-claim-stage'; const zeroTurnCompleted = resultHarnessMode === 'zero-turn-completed'; const claimedNonzeroFailure = resultHarnessMode === 'claimed-nonzero-failure'; const claimedNonzeroCompleted = resultHarnessMode === 'claimed-nonzero-completed'; const unverifiedNonzeroFailure = resultHarnessMode === 'unverified-nonzero-failure'; const claimedCleanupAndExit = resultHarnessMode === 'claimed-cleanup-and-exit'; const reportAbsent = resultHarnessMode === 'report-absent'; const forgedPhase = resultHarnessMode === 'forged-phase'; const forgedDisposition = resultHarnessMode === 'forged-disposition'; const forgedAfterWithoutWrite = resultHarnessMode === 'forged-after-without-write'; const forgedPreObserver = resultHarnessMode === 'forged-pre-observer'; const forgedZeroTurnActivity = resultHarnessMode === 'forged-zero-turn-activity'; const forgedCompletedWithoutWrite = resultHarnessMode === 'forged-completed-without-write'; const forgedCleanupAttestation = resultHarnessMode === 'forged-cleanup-attestation';
    const cleanupFailure = resultHarnessMode === 'prelaunch-cleanup-failure' || oneTurnUnsafe || claimedCleanupAndExit;
    const postclaimFailure = malformedClaim || claimedNonzeroFailure || unverifiedNonzeroFailure;
    const report = { schema_version: 1, purpose: 'reviewed_v2_product_path_live_attempt', profile_id: profile.id, backend: profile.backend, model: profile.model, expected_head: null, candidate_digest: options.env.QUADWORK_REVIEWED_CANDIDATE_DIGEST, gate_receipt_digest: null, result_class: cleanupFailure ? 'cleanup_failed' : postclaimFailure ? 'attempt_indeterminate' : prelaunch ? 'preflight_blocked' : 'completed', provider_turns: prelaunch || zeroTurnCompleted ? 0 : 1, launch_claim_state: prelaunch || zeroTurnCompleted ? 'none' : malformedClaim || invalidClaimStage || unverifiedNonzeroFailure ? 'unverified' : 'claimed', failure_stage: invalidClaimStage || prelaunch || zeroTurnCompleted ? 'prelaunch' : cleanupFailure || postclaimFailure ? 'postclaim' : 'none', launch_diagnostic: 'none', early_exit_diagnostic: 'none', pre_observer_pty_data_seen: false, pre_workload_output_seen: false, workload_write_attempted: false, workload_submitted_at_launch: !prelaunch, terminal_exit_phase: 'none', worker_report_disposition: 'none', lifecycle_verified: !prelaunch && !malformedClaim, sentinel_digest: prelaunch || postclaimFailure ? null : 'c'.repeat(64), output_bytes: 0, output_capped: false, elapsed_ms: 0, root_cleanup_ok: !cleanupFailure, survivor_free: true, cleanup_attestation: cleanupFailure ? 'root' : 'none', source_rechecked_before_prompt: !prelaunch, gate_rechecked_before_prompt: !prelaunch, pre_root_facts: facts, post_root_facts: facts, credential_copy_or_store_api_used: false, keychain_immutability_claimed: false, peer_level_network_filter_available: false, release_evidence: false };
    if (forgedPhase) report.terminal_exit_phase = 'forged';
    if (forgedDisposition) report.worker_report_disposition = 'claimed_exit_unattested';
    if (forgedAfterWithoutWrite) { report.terminal_exit_phase = 'after_workload_attempt'; report.workload_write_attempted = false; }
    if (forgedPreObserver) report.pre_observer_pty_data_seen = true;
    if (forgedZeroTurnActivity) { report.provider_turns = 0; report.launch_claim_state = 'none'; report.failure_stage = 'prelaunch'; report.result_class = 'preflight_blocked'; report.workload_write_attempted = true; }
    if (forgedCompletedWithoutWrite) report.workload_submitted_at_launch = false;
    if (forgedCleanupAttestation) report.cleanup_attestation = 'unverified';
    if (resultHarnessMode === 'report-error-close') {
      queueMicrotask(() => { child.emit('message', { type: 'reviewed_execution_result', report }); child.emit('error', new Error('fake IPC failure')); child.emit('close', 0); });
    } else if (resultHarnessMode === 'exit-close-race') {
      queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); setImmediate(() => child.emit('message', { type: 'reviewed_execution_result', report })); });
    } else if (reportAbsent) {
      queueMicrotask(() => child.emit('exit', 0));
    } else if (resultHarnessMode === 'duplicate') {
      queueMicrotask(() => { child.emit('exit', 0); setImmediate(() => { child.emit('message', { type: 'reviewed_execution_result', report }); setImmediate(() => child.emit('message', { type: 'reviewed_execution_result', report: { ...report, output_bytes: 7 } })); }); });
    } else if (prelaunch) {
      queueMicrotask(() => { child.emit('message', { type: 'reviewed_execution_result', report }); child.emit('exit', 0); });
    } else {
      process.nextTick(() => { child.emit('exit', claimedNonzeroFailure || claimedNonzeroCompleted || unverifiedNonzeroFailure || claimedCleanupAndExit ? 1 : 0); setImmediate(() => child.emit('message', { type: 'reviewed_execution_result', report })); });
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
function claimedCleanupAndExitHarness() { return resultHarness('claimed-cleanup-and-exit'); }
function reportAbsentHarness() { return resultHarness('report-absent'); }
function forgedPhaseHarness() { return resultHarness('forged-phase'); }
function forgedDispositionHarness() { return resultHarness('forged-disposition'); }
function forgedAfterWithoutWriteHarness() { return resultHarness('forged-after-without-write'); }
function forgedPreObserverHarness() { return resultHarness('forged-pre-observer'); }
function forgedZeroTurnActivityHarness() { return resultHarness('forged-zero-turn-activity'); }
function forgedCompletedWithoutWriteHarness() { return resultHarness('forged-completed-without-write'); }
function forgedCleanupAttestationHarness() { return resultHarness('forged-cleanup-attestation'); }

function workerFailureHarness(mode) {
  const filename = path.join(__dirname, 'reviewed-execution-live-runner.cjs');
  const fakeFork = `const { EventEmitter } = require('node:events');
const failureMode = ${JSON.stringify(mode)};
const observations = { kills: [], disconnects: 0, admissions: 0 };
const fork = (file, args, options) => {
  const failure = () => Object.assign(new Error('private synthetic worker error'), { code: 'EAGAIN' });
  if (failureMode === 'fork-throw') throw failure();
  const child = new EventEmitter(), secretPipe = new EventEmitter();
  if (!['failed-spawn', 'failed-spawn-no-close', 'spawn-event-error', 'admission-error'].includes(failureMode)) child.pid = 12345;
  child.stdio = [null, null, null, null, secretPipe];
  child.disconnect = () => { observations.disconnects += 1; };
  child.kill = signal => { observations.kills.push(signal); };
  child.send = () => { observations.admissions += 1; throw failure(); };
  secretPipe.end = secret => {
    if (failureMode === 'pipe-throw') throw failure();
    queueMicrotask(() => {
      if (failureMode.startsWith('failed-spawn')) {
        child.emit('error', failure());
        if (failureMode === 'failed-spawn') child.emit('close', -11);
        // Late and repeated terminal events must not change the settled result.
        child.emit('error', failure());
        if (failureMode === 'failed-spawn') child.emit('exit', 0);
        return;
      }
      if (!['pid-error', 'admission-error'].includes(failureMode)) child.emit('spawn');
      if (failureMode === 'timeout') return;
      if (failureMode === 'pipe-error') { secretPipe.emit('error', failure()); return; }
      const ready = { type: 'reviewed_execution_ready', nonce: options.env.QUADWORK_REVIEWED_PARENT_NONCE, candidate_digest: options.env.QUADWORK_REVIEWED_CANDIDATE_DIGEST, worker_digest: options.env.QUADWORK_REVIEWED_WORKER_DIGEST, proof: crypto.createHmac('sha256', secret).update(options.env.QUADWORK_REVIEWED_PARENT_NONCE).digest('hex') };
      if (failureMode === 'admission-error') { child.emit('message', ready); child.emit('error', failure()); return; }
      if (failureMode === 'close-without-exit') { child.emit('close', 1); child.emit('message', ready); return; }
      child.emit('error', failure());
      // Ready after termination must never admit a new provider attempt.
      child.emit('message', ready);
      if (failureMode === 'spawned-error-exit') child.emit('exit', 1);
      if (failureMode !== 'spawned-error-stuck') child.emit('close', 1);
    });
  };
  return child;
};`;
  const source = fs.readFileSync(filename, 'utf8')
    .replace("const { fork } = require('node:child_process');", fakeFork)
    .replace('const MAX_CHILD_MS = 60_000;', 'const MAX_CHILD_MS = 20;')
    .replace('}, 2_000);', '}, 20);')
    .replace('module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });', 'module.exports = Object.freeze({ run: runReviewedCodex, observations });');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports;
}

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
test('parent drains a valid result when close follows exit before result delivery', async () => {
  const result = await resultHarness('exit-close-race').run();
  assert.equal(result.result_class, 'completed');
  assert.equal(result.provider_turns, 1);
});
test('parent never turns a claimed result followed by an IPC error into success or zero turns', async () => {
  const result = await resultHarness('report-error-close').run();
  assert.equal(result.result_class, 'worker_start_failed');
  assert.equal(result.provider_turns, 1);
  assert.equal(result.launch_claim_state, 'unverified');
  assert.equal(result.worker_report_disposition, 'claimed_exit_unattested');
  assert.equal(result.root_cleanup_ok, false);
  assert.equal(result.survivor_free, false);
});
for (const mode of ['fork-throw', 'failed-spawn', 'failed-spawn-no-close']) {
  test(`parent promptly reports proven ${mode} without waiting for exit`, { timeout: 1000 }, async () => {
    const fixture = workerFailureHarness(mode);
    const result = await fixture.run();
    assert.equal(result.result_class, 'worker_start_failed');
    assert.equal(result.provider_turns, 0);
    assert.equal(result.launch_claim_state, 'none');
    assert.equal(result.root_cleanup_ok, false);
    assert.equal(result.survivor_free, false);
    assert.equal(result.cleanup_attestation, 'unverified');
    assert.deepEqual(fixture.observations.kills, []);
    assert.equal(fixture.observations.disconnects, mode === 'fork-throw' ? 0 : 1);
    assert.equal(fixture.observations.admissions, 0);
    assert.equal(JSON.stringify(result).includes('private synthetic worker error'), false);
  });
}
for (const mode of ['pid-error', 'spawn-event-error', 'spawned-error-exit', 'spawned-error-stuck', 'close-without-exit', 'pipe-throw', 'pipe-error', 'admission-error', 'timeout']) {
  test(`parent settles ${mode} conservatively within its termination bound`, { timeout: 1000 }, async () => {
    const fixture = workerFailureHarness(mode);
    const result = await fixture.run();
    assert.equal(result.result_class, mode === 'timeout' ? 'worker_timeout' : mode === 'close-without-exit' ? 'worker_exit_unverified' : 'worker_start_failed');
    assert.equal(result.provider_turns, 1);
    assert.equal(result.launch_claim_state, 'unverified');
    assert.equal(result.failure_stage, 'parent_unverified');
    assert.equal(result.root_cleanup_ok, false);
    assert.equal(result.survivor_free, false);
    assert.equal(result.cleanup_attestation, 'unverified');
    assert.equal(fixture.observations.disconnects, 1);
    assert.equal(fixture.observations.admissions, mode === 'admission-error' ? 1 : 0);
    if (['spawned-error-stuck', 'pipe-throw', 'pipe-error', 'admission-error', 'timeout'].includes(mode)) assert.deepEqual(fixture.observations.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(JSON.stringify(result).includes('private synthetic worker error'), false);
  });
}
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
test('parent reports only redacted worker-report dispositions for every fallback combination', async () => {
  const absent = await reportAbsentHarness().run();
  assert.equal(absent.worker_report_disposition, 'report_absent');
  const cleanup = await oneTurnUnsafeHarness().run();
  assert.equal(cleanup.worker_report_disposition, 'claimed_cleanup_unattested');
  const exit = await claimedNonzeroCompletedHarness().run();
  assert.equal(exit.worker_report_disposition, 'claimed_exit_unattested');
  const both = await claimedCleanupAndExitHarness().run();
  assert.equal(both.worker_report_disposition, 'claimed_cleanup_and_exit_unattested');
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
test('parent rejects forged child phase and parent-owned disposition fields', async () => {
  for (const harness of [forgedPhaseHarness, forgedDispositionHarness]) {
    const result = await harness().run();
    assert.equal(result.result_class, 'worker_result_invalid');
  }
});
test('parent rejects logically inconsistent child phase and observation claims', async () => {
  for (const harness of [forgedAfterWithoutWriteHarness, forgedPreObserverHarness, forgedZeroTurnActivityHarness, forgedCompletedWithoutWriteHarness]) {
    const result = await harness().run();
    assert.equal(result.result_class, 'worker_result_invalid');
  }
});
test('parent rejects a child cleanup report without a specific attestation category', async () => {
  const result = await forgedCleanupAttestationHarness().run();
  assert.equal(result.result_class, 'worker_result_invalid');
  assert.equal(result.cleanup_attestation, 'unverified');
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
  assert.equal(outcome.observe([outcome.SENTINEL.slice(0, 8), `${outcome.SENTINEL.slice(8)}\n`]).sentinel, true);
  for (const chunks of [[`${outcome.SENTINEL} extra\n`], [`prefix ${outcome.SENTINEL}\n`], ['no sentinel\n']]) assert.equal(outcome.observe(chunks).sentinel, false);
});
test('production observer retains no raw terminal output while checking the fixed sentinel', () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-outcome.cjs'), 'utf8');
  assert.doesNotMatch(source, /let output\s*=/);
  const observer = outcome.createObserver(); const secretLikeOutput = 'credential=synthetic-terminal-output';
  observer.push(secretLikeOutput);
  assert.equal(JSON.stringify(observer.snapshot()).includes(secretLikeOutput), false);
});
test('early terminal diagnostics use only complete fixed signatures and never retain secret-like bytes', () => {
  assert.deepEqual(outcome.EARLY_EXIT_DIAGNOSTICS, ['none', 'provider_auth_unavailable', 'sandbox_policy_denied', 'provider_command_unavailable', 'unclassified_early_exit']);
  for (const signature of outcome.EARLY_EXIT_SIGNATURES) {
    const observer = outcome.createObserver(signature.profile_id ? profiles.PROFILES[signature.profile_id] : 'codex');
    observer.push(signature.text.slice(0, 3)); observer.push(`${signature.text.slice(3)}\r\n`);
    assert.equal(outcome.earlyExitDiagnostic(observer.snapshot()), signature.diagnostic);
  }
  const unknown = outcome.createObserver('codex'); unknown.push('unknown early terminal text\n');
  const partial = outcome.createObserver('codex'); partial.push('Authentication requ');
  const ambiguous = outcome.createObserver('codex'); ambiguous.push('Authentication required\ncredential=synthetic-terminal-output');
  const overcap = outcome.createObserver('codex'); overcap.push(`Authentication required${'x'.repeat(outcome.OUTPUT_CAP_BYTES)}`);
  for (const observer of [unknown, partial, ambiguous, overcap]) assert.equal(outcome.earlyExitDiagnostic(observer.snapshot()), 'unclassified_early_exit');
  const secret = 'credential=synthetic-terminal-output';
  const report = reportHarness().report(profiles.PROFILES.v2_codex_readonly_v1, { expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) }, { result_class: 'launch_indeterminate', launch_claim_state: 'claimed', failure_stage: 'postclaim', launch_diagnostic: 'pty_exited_before_observation', early_exit_diagnostic: outcome.earlyExitDiagnostic(ambiguous.snapshot()), workload_submitted_at_launch: true, terminal_exit_phase: 'after_launch_submission', root_cleanup_ok: true, survivor_free: true, cleanup_attestation: 'none' });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('Authentication required'), false);
  assert.equal(serialized.includes('unclassified_early_exit'), true);
});
test('pinned CLI auth lines require their exact immutable profile and canonical LF or CRLF terminator', () => {
  const pinned = outcome.EARLY_EXIT_SIGNATURES.filter(signature => signature.profile_id);
  assert.deepEqual(pinned.map(signature => ({ profile_id: signature.profile_id, backend: signature.backend, executable_digest: signature.executable_digest, diagnostic: signature.diagnostic })), [
    { profile_id: 'v2_codex_readonly_v1', backend: 'codex', executable_digest: profiles.PROFILES.v2_codex_readonly_v1.executable_digest, diagnostic: 'provider_auth_unavailable' },
    { profile_id: 'v2_claude_restricted_v1', backend: 'claude', executable_digest: profiles.PROFILES.v2_claude_restricted_v1.executable_digest, diagnostic: 'provider_auth_unavailable' },
  ]);
  for (const signature of pinned) {
    const profile = profiles.PROFILES[signature.profile_id];
    for (const terminator of ['\n', '\r\n']) {
      const observer = outcome.createObserver(profile); observer.push(`${signature.text}${terminator}`);
      assert.equal(outcome.earlyExitDiagnostic(observer.snapshot()), 'provider_auth_unavailable');
    }
    for (const variant of [signature.text, `${signature.text}\r`, `prefix ${signature.text}\n`, `${signature.text} credential=synthetic-terminal-output\n`, `${signature.text}\nextra`]) {
      const observer = outcome.createObserver(profile); observer.push(variant);
      assert.equal(outcome.earlyExitDiagnostic(observer.snapshot()), 'unclassified_early_exit');
    }
    const wrong = outcome.createObserver(profile.backend === 'codex' ? profiles.PROFILES.v2_claude_restricted_v1 : profiles.PROFILES.v2_codex_readonly_v1); wrong.push(`${signature.text}\n`);
    assert.equal(outcome.earlyExitDiagnostic(wrong.snapshot()), 'unclassified_early_exit');
    const cloned = outcome.createObserver({ ...profile }); cloned.push(`${signature.text}\n`);
    assert.equal(outcome.earlyExitDiagnostic(cloned.snapshot()), 'unclassified_early_exit');
  }
});
test('parent accepts a diagnostic only in the exact early-exit state and rejects forged enum values', () => {
  const profile = profiles.PROFILES.v2_codex_readonly_v1; const candidate = 'a'.repeat(64);
  const report = reportHarness().report(profile, { expected_head: 'b'.repeat(40), candidate_digest: candidate }, { result_class: 'launch_indeterminate', launch_claim_state: 'claimed', failure_stage: 'postclaim', launch_diagnostic: 'pty_exited_before_observation', early_exit_diagnostic: 'provider_auth_unavailable', workload_submitted_at_launch: true, terminal_exit_phase: 'after_launch_submission', root_cleanup_ok: true, survivor_free: true, cleanup_attestation: 'none' });
  assert.equal(shapeHarness().reportShape(report, profile, candidate), true);
  assert.equal(shapeHarness().reportShape({ ...report, early_exit_diagnostic: 'forged_provider_detail' }, profile, candidate), false);
  assert.equal(shapeHarness().reportShape({ ...report, terminal_exit_phase: 'none' }, profile, candidate), false);
  assert.equal(shapeHarness().reportShape({ ...report, result_class: 'attempt_indeterminate' }, profile, candidate), false);
  const childRefusal = reportHarness().report(profile, { expected_head: 'b'.repeat(40), candidate_digest: candidate }, { result_class: 'preflight_blocked', launch_claim_state: 'none', early_exit_diagnostic: 'provider_auth_unavailable' });
  assert.equal(childRefusal.early_exit_diagnostic, 'none');
});
test('production evaluator makes output cap, timeout, lifecycle, remote rejection, cleanup, root/git/env failures non-success', () => {
  assert.equal(outcome.observe(['x'.repeat(outcome.OUTPUT_CAP_BYTES + 1)]).output_capped, true);
  const baseline = { provider_turns: 1, lifecycle: 'verified', stop: true, shutdown: true, survivor: true, root: true, git: true, environment: true, sentinel: true };
  assert.equal(outcome.finalize({ ...baseline, output_capped: true }).result_class, 'output_cap_exceeded');
  assert.equal(outcome.finalize({ ...baseline, terminal_exited: true }).result_class, 'launch_indeterminate');
  assert.equal(outcome.finalize({ ...baseline, timed_out: true }).result_class, 'attempt_indeterminate');
  assert.equal(outcome.finalize({ ...baseline, lifecycle: 'spawned' }).result_class, 'attempt_indeterminate');
  assert.equal(outcome.finalize({ ...baseline, launch: false }).result_class, 'launch_failed');
  for (const field of ['stop', 'shutdown', 'survivor', 'root', 'git', 'environment']) { const value = outcome.finalize({ ...baseline, [field]: false }); assert.equal(value.result_class, 'cleanup_failed'); assert.equal(value.root_cleanup_ok, false); assert.equal(value.cleanup_attestation, field === 'git' ? 'root' : field); }
  for (const failed of ['stop', 'shutdown', 'survivor', 'root', 'git', 'environment']) { const effects = Object.fromEntries(['stop', 'shutdown', 'survivor', 'root', 'git', 'environment'].map(name => [name, () => name !== failed])); const value = outcome.finalizeEffects({ provider_turns: 1, lifecycle: 'verified', sentinel: true, effects }); assert.equal(value.result_class, 'cleanup_failed'); }
});
test('cleanup attestation is an ordered redacted category and never retains effect details', () => {
  const baseline = { stop: true, shutdown: true, survivor: true, root: true, git: true, environment: true };
  assert.equal(outcome.cleanupAttestation(baseline), 'none');
  assert.equal(outcome.cleanupAttestation({ ...baseline, stop: false, shutdown: false }), 'stop');
  assert.equal(outcome.cleanupAttestation({ ...baseline, shutdown: false, survivor: false }), 'shutdown');
  assert.equal(outcome.cleanupAttestation({ ...baseline, survivor: false, root: false }), 'survivor');
  assert.equal(outcome.finalize({ ...baseline, environment: false }).cleanup_attestation, 'environment');
});
test('provider-state boundary compares source facts without reading provider state', () => {
  const facts = providerStateBoundary.sourceFacts();
  assert.deepEqual(facts.normal_home, { home: 'inherited_safe_environment', provider_state_observed: false });
  assert.deepEqual(facts.reviewed_claude, { home: 'executor_owned_disposable', provider_state_observed: false, provider_state_read_authorized: true, provider_state_binding: 'exact_file_metadata_validated', provider_state_locator: 'fixed_claude_config_dir' });
  assert.deepEqual(facts.reviewed_codex, { home: 'executor_owned_disposable', provider_state_observed: false, provider_state_read_authorized: true, provider_state_binding: 'exact_file_metadata_validated' });
  assert.equal(facts.future_expansion_authority, providerStateBoundary.OPERATOR_CREDENTIAL_AUTHORITY);
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-provider-state-boundary.cjs'), 'utf8');
  for (const forbidden of ['readdirSync(os.homedir', 'copyFileSync', 'mount', 'keytar']) assert.equal(source.includes(forbidden), false, forbidden);
});
test('provider_state_unavailable is accepted only as a zero-turn prelaunch redacted result', () => {
  const profile = profiles.PROFILES.v2_codex_readonly_v1; const candidate = 'a'.repeat(64);
  const value = reportHarness().report(profile, { expected_head: 'b'.repeat(40), candidate_digest: candidate }, { result_class: 'provider_state_unavailable', launch_claim_state: 'none', failure_stage: 'prelaunch', root_cleanup_ok: true, survivor_free: true, cleanup_attestation: 'none' });
  assert.equal(shapeHarness().reportShape(value, profile, candidate), true);
  assert.equal(shapeHarness().reportShape({ ...value, provider_turns: 1, launch_claim_state: 'claimed', failure_stage: 'postclaim' }, profile, candidate), false);
  assert.equal(shapeHarness().reportShape({ ...value, workload_submitted_at_launch: true, terminal_exit_phase: 'after_launch_submission' }, profile, candidate), false);
});
test('non-launching production report harness redacts prompt, output, path and token fields', () => {
  const profile = profiles.PROFILES.v2_claude_restricted_v1; const report = reportHarness().report(profile, { expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) }, { prompt: profiles.WORKLOAD, output: 'token=private', path: '/private/root', token: 'private', result_class: 'attempt_indeterminate' }); const text = JSON.stringify(report);
  for (const hidden of [profiles.WORKLOAD, 'token=private', '/private/root', 'private']) assert.equal(text.includes(hidden), false);
});
test('Codex transient final-message channel accepts only an owned exact sentinel and always removes the file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-final-message-')); fs.chmodSync(root, 0o700); const marker = path.join(root, '.quadwork-v2-product-path-root-v1'); fs.writeFileSync(marker, 'quadwork-v2-product-path-v1\n', { mode: 0o600 }); fs.chmodSync(marker, 0o600);
  const final = profiles.codexFinalMessagePath(root); const outside = path.join(root, 'outside'); const channel = finalMessageHarness(); const cleanupRoot = channel.cleanupRootIdentity(root);
  try {
    channel.createCodexFinalMessage(root, cleanupRoot); assert.equal(fs.lstatSync(final).isFile(), true); assert.equal(fs.statSync(final).mode & 0o777, 0o600);
    fs.writeFileSync(final, outcome.SENTINEL, { mode: 0o600 }); fs.chmodSync(final, 0o600);
    assert.equal(channel.consumeCodexFinalMessage(root, cleanupRoot), true); assert.equal(fs.existsSync(final), false);
    channel.createCodexFinalMessage(root, cleanupRoot); fs.writeFileSync(final, 'private provider output', { mode: 0o600 }); fs.chmodSync(final, 0o600);
    const rejected = channel.consumeCodexFinalMessage(root, cleanupRoot); assert.equal(rejected, false); assert.equal(fs.existsSync(final), false); assert.equal(JSON.stringify({ rejected }).includes('private provider output'), false);
    channel.createCodexFinalMessage(root, cleanupRoot); fs.writeFileSync(final, outcome.SENTINEL, { mode: 0o600 }); fs.chmodSync(final, 0o644);
    assert.equal(channel.consumeCodexFinalMessage(root, cleanupRoot), false); assert.equal(fs.existsSync(final), false);
    fs.writeFileSync(outside, outcome.SENTINEL, { mode: 0o600 }); fs.symlinkSync(outside, final);
    assert.equal(channel.consumeCodexFinalMessage(root, cleanupRoot), false); assert.equal(fs.existsSync(final), false); assert.equal(fs.existsSync(outside), true);
    channel.createCodexFinalMessage(root, cleanupRoot); channel.cleanupCodexFinalMessage(cleanupRoot); assert.equal(fs.existsSync(final), false);
    // A provider can remove the mutable marker, but cannot replace the
    // captured root identity. The fixed final basename is still unlinked.
    fs.unlinkSync(marker); fs.chmodSync(root, 0o755); fs.writeFileSync(final, 'raw final content', { mode: 0o644 }); fs.chmodSync(final, 0o644);
    assert.equal(channel.cleanupCodexFinalMessage(cleanupRoot), true); assert.equal(fs.existsSync(final), false);
    fs.symlinkSync(outside, final); assert.equal(channel.cleanupCodexFinalMessage(cleanupRoot), true); assert.equal(fs.existsSync(final), false); assert.equal(fs.existsSync(outside), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Codex submits its fixed workload at launch and never by a later PTY write', () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'), 'utf8');
  assert.match(source, /if \(!codex\) \{ workload_write_attempted = true; session\.writeFixedWorkload\(\); \}/);
  assert.match(source, /const completion_sentinel = codex \? final_message_valid : observed\.sentinel/);
  assert.match(source, /if \(codex\) createCodexFinalMessage\(state\.root, state\.cleanup_root\)/);
  assert.match(source, /if \(codex\) cleanupCodexFinalMessage\(state\.cleanup_root\)/);
});
test('active protocol harness always attempts controlled removal and preserves cleanup_failed in normal/catch paths', async () => {
  const profile = profiles.PROFILES.v2_claude_restricted_v1; const makeState = () => ({ profile, facts: { expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) }, gate: { receipt_digest: 'c'.repeat(64) }, root: '/fake', locations: { home: '/fake-home' }, pre: { entries: ['base'] }, previous: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_SKIP_LISTEN: process.env.QUADWORK_SKIP_LISTEN }, started: Date.now() });
  const normal = activeHarness(); normal.set(makeState(), true); const listeners = []; const normalResult = await normal.completeFixedChild(profile.role, { buildAgentArgs: async () => {}, buildAgentEnv: () => ({}), launch: async () => ({ ok: true, reviewed_session: { onData: listener => listeners.push(listener), preObserverPtyDataSeen: () => false, writeFixedWorkload: () => listeners.forEach(listener => listener(`${outcome.SENTINEL}\n`)) } }), stopAgentSession: async () => ({ ok: true, resources: { ptys: 1, sessions: 1 } }), shutdown: async () => ({ ok: true }) }); assert.equal(normal.removed(), 1); assert.notEqual(normalResult.result_class, 'cleanup_failed');
  const caught = activeHarness(); caught.set(makeState(), false); const caughtResult = await caught.completeFixedChild(profile.role, { buildAgentArgs: async () => {}, buildAgentEnv: () => ({}), launch: async () => { throw new Error('remote rejected'); }, stopAgentSession: async () => ({ ok: false, resources: {} }), shutdown: async () => ({ ok: true }) }); assert.equal(caught.removed(), 1); assert.equal(caughtResult.result_class, 'cleanup_failed'); assert.equal(caughtResult.provider_turns, 1);
});
test('active child retains only redacted synthetic pre-observer PTY evidence across an early exit', async () => {
  const profile = profiles.PROFILES.v2_claude_restricted_v1;
  const makeState = () => ({ profile, facts: { expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) }, gate: { receipt_digest: 'c'.repeat(64) }, root: '/fake', locations: { home: '/fake-home' }, pre: { entries: ['base'] }, previous: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_SKIP_LISTEN: process.env.QUADWORK_SKIP_LISTEN }, started: Date.now() });
  for (const [preObserverData, label] of [[true, 'synthetic data before observer'], [false, 'synthetic no-data exit']]) {
    const active = activeHarness(); active.set(makeState(), true); let exit;
    const secretLikePreObserverChunk = 'token=pre-observer-secret';
    const result = await active.completeFixedChild(profile.role, {
      buildAgentArgs: async () => {}, buildAgentEnv: () => ({}),
      launch: async () => ({ ok: true, reviewed_session: {
        onData: () => {}, onExit: listener => { exit = listener; },
        // The synthetic server has already consumed this pre-observer chunk;
        // only its boolean evidence crosses the reviewed session boundary.
        preObserverPtyDataSeen: () => preObserverData,
        writeFixedWorkload: () => exit(),
      } }),
      stopAgentSession: async () => ({ ok: true, resources: { ptys: 1, sessions: 1 } }), shutdown: async () => ({ ok: true }),
    });
    assert.equal(result.result_class, 'launch_indeterminate', label);
    assert.equal(result.pre_observer_pty_data_seen, preObserverData, label);
    assert.equal(result.output_bytes, 0, label);
    assert.equal(result.sentinel_digest, null, label);
    assert.equal(JSON.stringify(result).includes('synthetic'), false, label);
    assert.equal(JSON.stringify(result).includes(secretLikePreObserverChunk), false, label);
  }
});
test('active child records only bounded workload and terminal phases', async () => {
  const profile = profiles.PROFILES.v2_claude_restricted_v1;
  const makeState = () => ({ profile, facts: { expected_head: 'a'.repeat(40), candidate_digest: 'b'.repeat(64) }, gate: { receipt_digest: 'c'.repeat(64) }, root: '/fake', locations: { home: '/fake-home' }, pre: { entries: ['base'] }, previous: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_SKIP_LISTEN: process.env.QUADWORK_SKIP_LISTEN }, started: Date.now() });
  for (const [exitBeforeWorkload, outputBeforeWorkload, phase, label] of [[true, false, 'before_workload_attempt', 'exit first'], [false, false, 'after_workload_attempt', 'exit after write'], [false, true, 'after_workload_attempt', 'output before write']]) {
    const active = activeHarness(); active.set(makeState(), true); let data, exit;
    const secretLikeChunk = 'credential=synthetic-pre-workload';
    const result = await active.completeFixedChild(profile.role, {
      buildAgentArgs: async () => {}, buildAgentEnv: () => ({}),
      launch: async () => ({ ok: true, reviewed_session: {
        onData: listener => { data = listener; if (outputBeforeWorkload) listener(secretLikeChunk); },
        onExit: listener => { exit = listener; if (exitBeforeWorkload) listener(); },
        preObserverPtyDataSeen: () => false,
        writeFixedWorkload: () => { if (!exitBeforeWorkload) exit(); },
      } }),
      stopAgentSession: async () => ({ ok: true, resources: { ptys: 1, sessions: 1 } }), shutdown: async () => ({ ok: true }),
    });
    assert.equal(result.workload_write_attempted, true, label);
    assert.equal(result.pre_workload_output_seen, outputBeforeWorkload, label);
    assert.equal(result.terminal_exit_phase, phase, label);
    assert.equal(result.worker_report_disposition, 'none', label);
    assert.equal(JSON.stringify(result).includes(secretLikeChunk), false, label);
    assert.equal(typeof data, 'function', label);
  }
});
test('reviewed server PTY handling returns before retention, lifecycle, self-heal, or viewer forwarding', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const start = server.indexOf('term.onData((data) => {', server.indexOf('const SCROLLBACK_SIZE'));
  const end = server.indexOf('\n    });', start);
  const handler = server.slice(start, end);
  const reviewed = handler.slice(handler.indexOf('if (session.reviewedExecution)'));
  const earlyReturn = reviewed.indexOf('return;');
  assert.ok(earlyReturn >= 0);
  assert.equal(reviewed.slice(0, earlyReturn).includes('scrollback'), false);
  assert.equal(reviewed.slice(0, earlyReturn).includes('lastOutputAt'), false);
  assert.equal(reviewed.slice(0, earlyReturn).includes('selfHeal'), false);
  assert.match(server, /if \(session\.reviewedExecution\) \{\n    ws\.close\(1008, "reviewed-session-private"\);\n    return;\n  \}\n\n  session\.viewers\.add\(ws\);/);
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
