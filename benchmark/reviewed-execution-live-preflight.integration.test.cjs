'use strict';

// This is an authenticated process-level test of the fixed worker's real
// prepare -> unavailable-preflight -> result ACK path.  Its disposable source
// copy deliberately names a missing binary, so it cannot launch a provider.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const candidateFiles = require('../server/reviewed-execution-profiles').CANDIDATE_FILES;
const authorization = require('./reviewed-execution-contract.cjs');

function mkdir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}
function copyCandidateFixture(directory) {
  for (const relative of candidateFiles) {
    const target = path.join(directory, relative);
    mkdir(path.dirname(target));
    fs.copyFileSync(path.join(root, relative), target, fs.constants.COPYFILE_EXCL);
  }
  const profiles = path.join(directory, 'server', 'reviewed-execution-profiles.js');
  const source = fs.readFileSync(profiles, 'utf8');
  const changed = source.replace("executable: '/opt/homebrew/Caskroom/codex/0.153.1/bin/codex'", "executable: '/definitely-unavailable/quadwork-reviewed-codex'");
  assert.notEqual(changed, source, 'fixture replaced the local prerequisite only');
  fs.writeFileSync(profiles, changed, { mode: 0o600 });
  fs.chmodSync(profiles, 0o600);
  const runner = path.join(directory, 'benchmark', 'reviewed-execution-live-runner.cjs');
  const runnerSource = fs.readFileSync(runner, 'utf8');
  const runnerChanged = runnerSource.replace("env: { PATH: process.env.PATH || '/usr/bin:/bin'", "env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH || '/usr/bin:/bin'");
  assert.notEqual(runnerChanged, runnerSource, 'fixture forwards only its disposable HOME to its fixed child');
  fs.writeFileSync(runner, runnerChanged, { mode: 0o600 });
  fs.chmodSync(runner, 0o600);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: directory });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'quadwork-test@invalid'], { cwd: directory });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'QuadWork test'], { cwd: directory });
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: directory });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'fixture'], { cwd: directory });
  return require(path.join(directory, 'server', 'reviewed-execution-profiles.js'));
}
function gateFixture(home, profiles, expectedHead, candidateDigest) {
  const support = path.join(home, 'Library', 'Application Support', 'QuadWork');
  const gateParent = path.join(support, 'reviewed-execution-gates');
  const ledgerParent = path.join(support, 'reviewed-execution-ledger-parent');
  const ledger = path.join(ledgerParent, authorization.LEDGER_NAME);
  mkdir(gateParent); mkdir(ledgerParent); mkdir(ledger);
  const profile = profiles.PROFILES.v2_codex_readonly_v1;
  const authorization_id = 'preflight-refusal-authorization-0001';
  const authorization_key = authorization.authorizationKey(candidateDigest, profile.id, authorization_id);
  const receipt = {
    schema_version: 1,
    reviewed_head: expectedHead,
    reviewed_candidate_digest: candidateDigest,
    expected_head: expectedHead,
    candidate_digest: candidateDigest,
    profile_id: profile.id,
    authorization_id,
    recorded_at: new Date().toISOString(),
    actions: { enabled: false },
    cache: { active_size_bytes: 0 },
    artifacts: { nonexpired_size_bytes: 0 },
  };
  fs.writeFileSync(path.join(gateParent, `${profile.id}-${candidateDigest}.json`), JSON.stringify(receipt), { mode: 0o600 });
  fs.writeFileSync(path.join(ledger, `${authorization_key}.json`), JSON.stringify({ schema_version: 1, candidate_digest: candidateDigest, profile_id: profile.id, authorization_id, authorization_key }), { mode: 0o600 });
  return { ledger, authorization_key, profile };
}

test('source-fixed parent and authenticated child return an actual zero-turn unavailable-preflight report without a launch claim', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-preflight-source-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-preflight-home-'));
  try {
    const profiles = copyCandidateFixture(fixture);
    const expectedHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    const candidateDigest = profiles.candidateDigest(fixture);
    const gate = gateFixture(home, profiles, expectedHead, candidateDigest);
    const runner = path.join(fixture, 'benchmark', 'reviewed-execution-live-runner.cjs');
    const invoked = spawnSync(process.execPath, ['-e', "require(process.argv[1]).runReviewedCodex().then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.stack); process.exit(1); });", runner], {
      cwd: fixture, encoding: 'utf8', timeout: 5_000,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, USERPROFILE: home },
    });
    assert.equal(invoked.status, 0, `${invoked.stdout}\n${invoked.stderr}`);
    const result = JSON.parse(invoked.stdout);
    assert.equal(result.result_class, 'preflight_blocked');
    assert.equal(result.provider_turns, 0);
    assert.equal(result.survivor_free, true);
    assert.equal(result.candidate_digest, candidateDigest);
    assert.equal(fs.existsSync(path.join(gate.ledger, `${gate.authorization_key}.launch`)), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
