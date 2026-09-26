'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const live = require('./live-provider-compatibility.cjs');
const core = require('./live-provider-compatibility-core.cjs');

function roots() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'quadwork-live-test-'));
  return { parent, root: live.createDisposableLiveCompatibilityRoot({ parent_dir: parent }), evidence: live.createDisposableLiveCompatibilityEvidenceRoot({ parent_dir: parent }) };
}
const cleanup = value => fs.rmSync(value.parent, { recursive: true, force: true });
function fake(parent, name, script, symlink = false) {
  const target = path.join(parent, symlink ? `${name}-versioned` : name), wrapper = path.join(parent, name);
  fs.writeFileSync(target, `#!/usr/bin/env node\n${script}\n`, { mode: 0o700 }); fs.chmodSync(target, 0o700); if (symlink) fs.symlinkSync(target, wrapper);
  return wrapper;
}
async function captureFake(parent, script, options = {}) {
  const executable = fake(parent, `fake-${Math.random().toString(16).slice(2)}`, script);
  return core.testHooks.captureChild(spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] }), { expected_response: 'QUADWORK_LIVE_OK', max_output_bytes: 64, timeout_ms: 2_000, ...options });
}

test('production exports have no caller-controlled reviewed contract or authorization factory', () => {
  assert.deepEqual(Object.keys(live.ADAPTERS).sort(), ['claude', 'codex']);
  for (const key of ['createReviewedExecutionAuthorization', 'runReviewedCompatibility', 'REVIEWED_EXECUTIONS']) assert.equal(Object.hasOwn(live, key), false);
});

test('fixed Codex and Claude profiles have no bypass and Claude receives no Codex -C flag', () => {
  assert.equal(live.ADAPTERS.codex.argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(live.ADAPTERS.codex.argv.includes('--sandbox'), true);
  assert.equal(live.ADAPTERS.claude.argv.includes('--dangerously-skip-permissions'), false);
  assert.equal(live.ADAPTERS.claude.argv.includes('--restricted'), true);
  assert.equal(live.ADAPTERS.claude.argv.includes('--safe-mode'), true);
  assert.equal(live.ADAPTERS.claude.argv.includes('-C'), false);
});

test('evidence ownership is process-issued, not reproducible from a marker file', () => {
  const value = roots();
  try {
    const forged = path.join(value.parent, 'forged'); fs.mkdirSync(forged, { mode: 0o700 }); fs.writeFileSync(path.join(forged, live.EVIDENCE_MARKER), 'quadwork-live-compatibility-v1\n', { mode: 0o600 });
    assert.throws(() => core.reserveTerminal(forged), /live_evidence_not_owned/);
  } finally { cleanup(value); }
});

test('pre-spawn terminal reservation is exclusive and forms a concurrency barrier', () => {
  const value = roots();
  try {
    const first = core.reserveTerminal(value.evidence);
    assert.throws(() => core.reserveTerminal(value.evidence), /live_terminal_already_recorded/);
    fs.closeSync(first.fd); fs.unlinkSync(first.filename);
  } finally { cleanup(value); }
});

test('public runner rejects arbitrary fields before any provider process is eligible', async () => {
  const value = roots();
  try {
    await assert.rejects(() => live.runReviewedLiveCompatibility({ adapter: 'codex', evidence_directory: value.evidence, executable: '/tmp/not-codex', root_directory: value.root, args: ['--evil'] }), /live_run_shape/);
  } finally { cleanup(value); }
});

test('an owned root with a Git remote is rejected before executable preflight', async () => {
  const value = roots();
  try {
    require('node:child_process').execFileSync('/usr/bin/git', ['remote', 'add', 'origin', 'https://example.invalid/quadwork.git'], { cwd: value.root });
    await assert.rejects(() => live.runReviewedLiveCompatibility({ adapter: 'codex', evidence_directory: value.evidence, executable: '/tmp/not-codex', root_directory: value.root }), /live_remote_present/);
  } finally { cleanup(value); }
});

test('model aliases and provider aliases fail the public exact-shape gate', async () => {
  const first = roots(), second = roots();
  try {
    await assert.rejects(() => live.runReviewedLiveCompatibility({ adapter: 'codex', evidence_directory: first.evidence, executable: '/tmp/not-codex', model: 'default', root_directory: first.root }), /live_run_shape/);
    await assert.rejects(() => live.runReviewedLiveCompatibility({ adapter: 'codex-default', evidence_directory: second.evidence, executable: '/tmp/not-codex', root_directory: second.root }), /live_adapter_not_supported/);
  } finally { cleanup(first); cleanup(second); }
});

test('compiled argv is exactly the source-controlled Codex or Claude profile', () => {
  const value = roots();
  try {
    assert.deepEqual(core.testHooks.profile(live.ADAPTERS.codex, value.root), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--color', 'never', '-m', 'gpt-5.6-luna', '-C', value.root, '--output-last-message', path.join(value.root, '.quadwork-live-codex-final-message'), 'Return exactly QUADWORK_LIVE_OK. Do not use tools. Do not read, write, or change files.']);
    assert.deepEqual(core.testHooks.profile(live.ADAPTERS.claude, value.root), ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', '', '--output-format', 'text', '--model', 'claude-sonnet-4-6', 'Return exactly QUADWORK_LIVE_OK. Do not use tools. Do not read, write, or change files.']);
  } finally { cleanup(value); }
});

test('Codex final-message adapter accepts only the sentinel and deletes transient content', () => {
  const value = roots(), filename = path.join(value.root, '.quadwork-live-codex-final-message');
  try {
    const preEntries = fs.readdirSync(value.root).sort();
    assert.equal(fs.existsSync(filename), false); core.testHooks.createCodexFinalMessage(value.root); assert.equal(fs.statSync(filename).isFile(), true); assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    fs.writeFileSync(filename, 'QUADWORK_LIVE_OK\n', { mode: 0o600 }); fs.chmodSync(filename, 0o600);
    const accepted = core.testHooks.consumeCodexFinalMessage(value.root); assert.equal(accepted.response_ok, true); assert.equal(fs.existsSync(filename), false);
    assert.deepEqual(fs.readdirSync(value.root).sort(), preEntries);
    core.testHooks.createCodexFinalMessage(value.root); fs.writeFileSync(filename, 'provider private output', { mode: 0o600 }); fs.chmodSync(filename, 0o600);
    const rejected = core.testHooks.consumeCodexFinalMessage(value.root); assert.equal(rejected.response_ok, false); assert.equal(fs.existsSync(filename), false); assert.equal(JSON.stringify(rejected).includes('private output'), false);
    core.testHooks.createCodexFinalMessage(value.root); fs.writeFileSync(filename, 'QUADWORK_LIVE_OK', { mode: 0o600 }); fs.chmodSync(filename, 0o644);
    assert.equal(core.testHooks.consumeCodexFinalMessage(value.root).response_ok, false); assert.equal(fs.existsSync(filename), false);
    fs.writeFileSync(path.join(value.parent, 'outside'), 'QUADWORK_LIVE_OK'); fs.symlinkSync(path.join(value.parent, 'outside'), filename);
    assert.equal(core.testHooks.consumeCodexFinalMessage(value.root).response_ok, false); assert.equal(fs.existsSync(filename), false);
  } finally { cleanup(value); }
});

test('failed preflight never cleans a caller-created raw root', async () => {
  const value = roots(), forged = path.join(value.parent, 'forged-root'), final = path.join(forged, '.quadwork-live-codex-final-message');
  try {
    fs.mkdirSync(forged, { mode: 0o700 }); fs.writeFileSync(path.join(forged, live.ROOT_MARKER), 'quadwork-live-compatibility-v1\n', { mode: 0o600 }); fs.mkdirSync(path.join(forged, '.git')); fs.writeFileSync(final, 'caller-private', { mode: 0o600 });
    await assert.rejects(() => core.runInstalledCompatibility({ adapter: 'codex', evidence_directory: value.evidence, executable: '/tmp/not-codex', root_directory: forged }), /live_root_not_owned/);
    assert.equal(fs.existsSync(final), true);
  } finally { cleanup(value); }
});

test('a symlinked .git directory is rejected by the local metadata guard', async () => {
  const value = roots();
  try {
    const git = path.join(value.root, '.git'), moved = path.join(value.parent, 'real-git'); fs.renameSync(git, moved); fs.symlinkSync(moved, git);
    await assert.rejects(() => core.runInstalledCompatibility({ adapter: 'codex', evidence_directory: value.evidence, executable: '/tmp/not-codex', root_directory: value.root }), /live_git_metadata|live_unsafe_root/);
  } finally { cleanup(value); }
});

test('fake CLI capture enforces the exact sentinel, timeout, and output cap without retaining raw output', async () => {
  const value = roots();
  try {
    const wrong = await captureFake(value.parent, 'console.log("wrong")'); assert.equal(wrong.response_ok, false);
    const loud = await captureFake(value.parent, 'setTimeout(() => console.log("x".repeat(1000)), 30)'); assert.equal(loud.overflow, true);
    const slow = await captureFake(value.parent, 'setTimeout(() => console.log("QUADWORK_LIVE_OK"), 4000)', { timeout_ms: 500 }); assert.equal(slow.timed_out, true);
    const report = core.testHooks.terminalReport({ adapter: live.ADAPTERS.codex, executable: { digest: 'a'.repeat(64) }, digest: 'b'.repeat(64), pre_facts: {} }, live.CAPS, 'response_contract_failed', { response_digest: wrong.output_digest, response_contract_passed: false });
    assert.equal(JSON.stringify(report).includes('wrong'), false);
  } finally { cleanup(value); }
});

test('fake Codex executable and versioned Claude wrapper require exact binary and version digests', async () => {
  const value = roots();
  try {
    const codex = fake(value.parent, 'codex', 'console.log("fake")'); const codexResolved = fs.realpathSync(codex);
    const codexContract = { executable_path: codex, resolved_path: codexResolved, executable_digest: require('node:crypto').createHash('sha256').update(fs.readFileSync(codexResolved)).digest('hex') };
    assert.equal(core.testHooks.executable(codexContract, codex).path, codexResolved);
    assert.throws(() => core.testHooks.executable({ ...codexContract, executable_digest: '0'.repeat(64) }, codex), /live_executable_not_reviewed/);
    const claude = fake(value.parent, 'claude', 'console.log("fake")', true); const claudeProfile = core.testHooks.profile(live.ADAPTERS.claude, value.root);
    assert.equal(fs.realpathSync(claude).endsWith('claude-versioned'), true); assert.equal(claudeProfile.includes('-C'), false);
    const version = await captureFake(value.parent, 'setTimeout(() => console.log("fake"), 30)', { expected_response: undefined });
    assert.equal(core.testHooks.versionMatches(version, { version_digest: version.output_digest }), true);
    assert.equal(core.testHooks.versionMatches(version, { version_digest: 'f'.repeat(64) }), false);
  } finally { cleanup(value); }
});

test('reviewed current Codex and Claude binary size classes are accepted while oversized binaries fail', () => {
  assert.equal(core.testHooks.executableSize(238_223_808), 238_223_808);
  assert.equal(core.testHooks.executableSize(225_036_032), 225_036_032);
  assert.throws(() => core.testHooks.executableSize(512 * 1024 * 1024 + 1), /live_executable/);
});

test('the registry pins exactly codex-cli 0.157.1 and Claude Code 2.1.283', () => {
  assert.deepEqual(require('./live-provider-reviewed-contracts.cjs'), {
    codex: { adapter: 'codex', executable_path: '/opt/homebrew/bin/codex', resolved_path: '/opt/homebrew/Caskroom/codex/0.157.1/bin/codex', executable_digest: '27ceb5f9b957b43a519efe4eaa3816a0bffb0a531a2c89af18840c0a3c016a7d', version_digest: 'a2af91afbeed67d4d94d7ae88f4f7864866bb5923ab435c0955d779a3e8161f1' },
    claude: { adapter: 'claude', executable_path: '/Users/cho/.local/bin/claude', resolved_path: '/Users/cho/.local/share/claude/versions/2.1.283', executable_digest: 'd8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e', version_digest: 'b211344c57abae865f3f5b379f1f813d5102cde273c025c18b42c84bbeb899ea' },
  });
});

test('a stale pin fails closed naming only the pinned and found versions, read from paths without running the binary', () => {
  const value = roots();
  try {
    const ran = path.join(value.parent, 'found-binary-ran');
    const install = (relative, name) => { const target = path.join(value.parent, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran')\n`, { mode: 0o700 }); const wrapper = path.join(value.parent, 'bin', name); fs.mkdirSync(path.dirname(wrapper), { recursive: true }); fs.symlinkSync(target, wrapper); return wrapper; };
    const sha = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const codex = install('Caskroom/codex/0.158.0/bin/codex', 'codex'), claude = install('claude/versions/2.1.290', 'claude');
    const real = fs.realpathSync(value.parent);
    const failure = (contract, wrapper) => { try { core.testHooks.executable(contract, wrapper); } catch (error) { return error; } assert.fail('the pin mismatch was accepted'); };
    const staleCodex = failure({ executable_path: codex, resolved_path: path.join(real, 'Caskroom/codex/0.157.1/bin/codex'), executable_digest: sha(codex) }, codex);
    assert.equal(staleCodex.message, 'live_executable_stale_pin: pinned 0.157.1, found 0.158.0');
    const staleClaude = failure({ executable_path: claude, resolved_path: path.join(real, 'claude/versions/2.1.283'), executable_digest: sha(claude) }, claude);
    assert.equal(staleClaude.message, 'live_executable_stale_pin: pinned 2.1.283, found 2.1.290');
    const rebuilt = failure({ executable_path: claude, resolved_path: fs.realpathSync(claude), executable_digest: '0'.repeat(64) }, claude);
    assert.equal(rebuilt.message, 'live_executable_not_reviewed: pinned 2.1.290, found 2.1.290');
    const unversioned = fake(value.parent, 'unversioned', 'process.exit(0)', true);
    assert.equal(failure({ executable_path: unversioned, resolved_path: path.join(real, 'claude/versions/2.1.283'), executable_digest: sha(unversioned) }, unversioned).message, 'live_executable_stale_pin: pinned 2.1.283, found unrecognized');
    for (const error of [staleCodex, staleClaude, rebuilt]) { assert.equal(error instanceof live.LiveCompatibilityError, true); for (const place of [value.parent, real, os.homedir()]) assert.equal(error.message.includes(place), false); }
    assert.equal(fs.existsSync(ran), false, 'the found binary was never run to learn its version');
  } finally { cleanup(value); }
});
