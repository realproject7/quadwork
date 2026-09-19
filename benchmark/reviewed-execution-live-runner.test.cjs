'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const runner = require('./reviewed-execution-live-runner.cjs');

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
    assert.match(source, new RegExp(`role = '${role}'`));
    assert.ok(source.indexOf('prepareFixedChild') < source.indexOf("require('../server/index.js')"));
    assert.doesNotMatch(source, /argv|prompt|command|runner-bridge/);
  }
});
test('a directly started worker has no IPC admission and exits before preparation or provider launch', () => {
  for (const file of ['reviewed-execution-live-worker-codex.cjs', 'reviewed-execution-live-worker-claude.cjs']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { env: { PATH: process.env.PATH || '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
test('server retains its launch closure and has no importable reviewed bridge', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /launch: \(\) => runReviewedExecution\(reviewedChildRole\)/);
  assert.match(server, /typeof process\.send === "function"/);
  assert.doesNotMatch(server, /reviewed-execution-runner-bridge/);
  assert.doesNotMatch(server.slice(server.indexOf('module.exports = {'), server.indexOf('module.exports.mcpProxies')), /runReviewedExecution/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'server', 'reviewed-execution-runner-bridge.js')), false);
});
test('child protocol has no test hook or caller-supplied launch surface', () => {
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-live-child-protocol.cjs'), 'utf8');
  assert.doesNotMatch(source, /testHooks|dependencies|ptySpawn/);
  assert.match(source, /rootMatches\(state\.pre, post\)/);
});
