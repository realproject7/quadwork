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
function reportHarness() { const filename = path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'); const source = fs.readFileSync(filename, 'utf8').replace('module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });', 'module.exports = Object.freeze({ report });'); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports; }

test('public parent exposes only fixed no-input provider entries', () => {
  assert.deepEqual(Object.keys(runner).sort(), ['runReviewedClaude', 'runReviewedCodex']);
  for (const entry of Object.values(runner)) assert.equal(entry.length, 0);
});
test('parent has no server import, bridge, PTY, prompt, config or caller-controlled launch authority', () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-runner.cjs'), 'utf8');
  for (const forbidden of ['../server/index.js', 'runner-bridge', 'node-pty', 'WORKLOAD', 'buildAgentArgs', 'spawnAgentPty', 'reviewed_session']) assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(source, /verifyWorker\(filename\)/); assert.match(source, /fork\(verified\.file/); assert.match(source, /MAX_IPC_BYTES = 16 \* 1024/);
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
test('child protocol has no test hook or caller-supplied launch surface and direct import cannot prepare', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'), 'utf8');
  assert.doesNotMatch(source, /testHooks|dependencies|ptySpawn/);
  assert.match(source, /rootMatches\(state\.pre, post\)/);
  const protocol = require('./reviewed-execution-live-child-protocol.cjs');
  await assert.rejects(() => protocol.prepareFixedChild({}), /child_state/);
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
