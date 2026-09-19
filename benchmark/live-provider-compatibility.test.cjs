'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const live = require('./live-provider-compatibility.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = () => ({ base_digest: sha('base'), harness_digest: sha('harness'), source_digest: sha('source'), workload_digest: sha('workload') });
function fixture(script = 'console.log(process.argv.includes("--version") ? "fake 1.0" : "QUADWORK_LIVE_OK");') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'quadwork-live-test-'));
  const root = live.createDisposableLiveCompatibilityRoot({ parent_dir: parent });
  const evidence = live.createDisposableLiveCompatibilityEvidenceRoot({ parent_dir: parent });
  const executable = path.join(parent, 'codex');
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${script}\n`, { mode: 0o700 }); fs.chmodSync(executable, 0o700);
  return { parent, root, evidence, executable };
}
function run(fix, extra = {}, runtime) {
  const selectedIdentity = extra.identity || identity();
  return live.runLiveCompatibility({ adapter: 'codex', authorization: live.createReviewedExecutionAuthorization(selectedIdentity), evidence_directory: fix.evidence, executable: fix.executable, identity: selectedIdentity, root_directory: fix.root, ...extra }, runtime);
}
const cleanup = fix => fs.rmSync(fix.parent, { recursive: true, force: true });

test('registry is frozen and contains only the release-required Codex and Claude adapters', () => {
  assert.deepEqual(Object.keys(live.ADAPTERS).sort(), ['claude', 'codex']);
  assert.equal(live.ADAPTERS.codex.argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(live.ADAPTERS.claude.argv.includes('--dangerously-skip-permissions'), false);
  assert.equal(live.ADAPTERS.claude.argv.includes('--tools'), true);
  assert.equal(live.ADAPTERS.codex.argv.includes('--sandbox'), true);
});

test('forged JSON capability is rejected before any child is launched', async () => {
  const fix = fixture(); let launches = 0;
  try {
    await assert.rejects(() => live.runLiveCompatibility({ adapter: 'codex', authorization: JSON.parse('{}'), evidence_directory: fix.evidence, executable: fix.executable, identity: identity(), root_directory: fix.root }, { spawn: () => { launches++; throw new Error('must not spawn'); } }), /live_execution_not_authorized/);
    assert.equal(launches, 0);
  } finally { cleanup(fix); }
});

test('arbitrary args, aliases, models, and unsupported providers are rejected before launch', async () => {
  const fix = fixture(); let launches = 0;
  const forbidden = { spawn: () => { launches++; throw new Error('must not spawn'); } };
  try {
    await assert.rejects(() => run(fix, { adapter: 'grok', args: ['--evil'] }, forbidden), /live_run_shape|live_adapter_not_supported/);
    await assert.rejects(() => live.runLiveCompatibility({ adapter: 'codex', authorization: live.createReviewedExecutionAuthorization(identity()), evidence_directory: fix.evidence, executable: fix.executable, identity: identity(), root_directory: fix.root, model: 'default' }, forbidden), /live_run_shape/);
    assert.equal(launches, 0);
  } finally { cleanup(fix); }
});

test('symlinked roots and roots with remotes fail before a provider launch', async () => {
  const fix = fixture(); let launches = 0; const forbidden = { spawn: () => { launches++; throw new Error('must not spawn'); } };
  try {
    const linked = path.join(fix.parent, 'linked-root'); fs.symlinkSync(fix.root, linked);
    await assert.rejects(() => live.runLiveCompatibility({ adapter: 'codex', authorization: live.createReviewedExecutionAuthorization(identity()), evidence_directory: fix.evidence, executable: fix.executable, identity: identity(), root_directory: linked }, forbidden), /live_unsafe_root/);
    execFileSync('/usr/bin/git', ['remote', 'add', 'origin', 'https://example.invalid/repo.git'], { cwd: fix.root });
    await assert.rejects(() => run(fix, {}, forbidden), /live_remote_present/);
    assert.equal(launches, 0);
  } finally { cleanup(fix); }
});

test('the smoke persists only sanitized facts and strips credential environment', async () => {
  const fix = fixture('if (process.argv.includes("--version")) console.log("fake 1.0"); else { if (process.env.GH_TOKEN || process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) process.exit(9); process.stderr.write("ghp_SECRET_MUST_NOT_RETAIN"); console.log("QUADWORK_LIVE_OK"); }');
  const oldGh = process.env.GH_TOKEN, oldNpm = process.env.NPM_TOKEN;
  process.env.GH_TOKEN = 'secret'; process.env.NPM_TOKEN = 'secret';
  try {
    const report = await run(fix);
    assert.equal(report.result_class, 'response_contract_failed'); assert.equal(report.external_process_started, true); assert.equal(report.model_id, 'gpt-5.6-luna');
    const saved = fs.readFileSync(path.join(fix.evidence, 'terminal.json'), 'utf8');
    assert.equal(saved.includes('SECRET'), false); assert.equal(saved.includes(fix.root), false); assert.equal(saved.includes('GH_TOKEN'), false); assert.equal(saved.includes('QUADWORK_LIVE_OK'), false);
  } finally { if (oldGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldGh; if (oldNpm === undefined) delete process.env.NPM_TOKEN; else process.env.NPM_TOKEN = oldNpm; cleanup(fix); }
});

test('timeout and output caps create terminal classes without retaining output', async () => {
  const slow = fixture('if (process.argv.includes("--version")) console.log("fake"); else setTimeout(() => console.log("late"), 1000);');
  const noisy = fixture('if (process.argv.includes("--version")) console.log("fake"); else console.log("x".repeat(10000));');
  const testCaps = { max_elapsed_ms: 500, max_output_bytes: 64, max_provider_turns: 1, max_version_output_bytes: 128 };
  try {
    const timed = await run(slow, {}, { test_caps: testCaps }); assert.equal(timed.result_class, 'timeout');
    const loud = await run(noisy, {}, { test_caps: testCaps }); assert.equal(loud.result_class, 'output_cap_exceeded');
    assert.equal(fs.readFileSync(path.join(noisy.evidence, 'terminal.json'), 'utf8').includes('xxxxx'), false);
  } finally { cleanup(slow); cleanup(noisy); }
});

test('unavailable host isolation and a second terminal record are rejected before another provider invocation', async () => {
  const fix = fixture(); let launches = 0;
  try {
    await assert.rejects(() => run(fix, {}, { assert_host_isolation: () => false, spawn: () => { launches++; throw new Error('must not spawn'); } }), /live_host_isolation_unavailable/);
    assert.equal(launches, 0);
    const first = await run(fix); assert.equal(first.result_class, 'completed');
    await assert.rejects(() => run(fix), /live_terminal_already_recorded/);
  } finally { cleanup(fix); }
});

test('a zero-exit response other than the fixed sentinel is retained as a failed smoke', async () => {
  const fix = fixture('if (process.argv.includes("--version")) console.log("fake"); else console.log("wrong response");');
  try {
    const report = await run(fix); assert.equal(report.result_class, 'response_contract_failed');
    assert.equal(fs.readFileSync(path.join(fix.evidence, 'terminal.json'), 'utf8').includes('wrong response'), false);
  } finally { cleanup(fix); }
});

test('a reviewed capability binds the immutable identity and rejects a mismatch before launch', async () => {
  const fix = fixture(); let launches = 0; const bound = identity(), forged = { ...bound, source_digest: sha('other source') };
  try {
    await assert.rejects(() => live.runLiveCompatibility({ adapter: 'codex', authorization: live.createReviewedExecutionAuthorization(bound), evidence_directory: fix.evidence, executable: fix.executable, identity: forged, root_directory: fix.root }, { spawn: () => { launches++; throw new Error('must not spawn'); } }), /live_identity_not_authorized/);
    assert.equal(launches, 0);
  } finally { cleanup(fix); }
});
