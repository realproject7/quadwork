'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const live = require('./live-provider-compatibility.cjs');
const core = require('./live-provider-compatibility-core.cjs');

function roots() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'quadwork-live-test-'));
  return { parent, root: live.createDisposableLiveCompatibilityRoot({ parent_dir: parent }), evidence: live.createDisposableLiveCompatibilityEvidenceRoot({ parent_dir: parent }) };
}
const cleanup = value => fs.rmSync(value.parent, { recursive: true, force: true });

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

test('a symlinked .git directory is rejected by the local metadata guard', async () => {
  const value = roots();
  try {
    const git = path.join(value.root, '.git'), moved = path.join(value.parent, 'real-git'); fs.renameSync(git, moved); fs.symlinkSync(moved, git);
    await assert.rejects(() => core.runInstalledCompatibility({ adapter: 'codex', evidence_directory: value.evidence, executable: '/tmp/not-codex', root_directory: value.root }), /live_git_metadata|live_unsafe_root/);
  } finally { cleanup(value); }
});
