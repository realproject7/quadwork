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
function copyActiveChildFixture(directory) {
  const copy = source => fs.cpSync(path.join(root, source), path.join(directory, source), { recursive: true, filter: filename => !filename.endsWith('.test.js') && !filename.includes(`${path.sep}__tests__${path.sep}`) });
  copy('server'); copy('benchmark'); copy('src');
  const runner = path.join(directory, 'benchmark', 'reviewed-execution-live-runner.cjs');
  const runnerSource = fs.readFileSync(runner, 'utf8');
  const runnerChanged = runnerSource.replace("env: { PATH: process.env.PATH || '/usr/bin:/bin'", "env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_REVIEWED_FIXTURE_PRECLAIM: process.env.QUADWORK_REVIEWED_FIXTURE_PRECLAIM, QUADWORK_REVIEWED_FIXTURE_ADMISSION_MARKER: process.env.QUADWORK_REVIEWED_FIXTURE_ADMISSION_MARKER, QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER: process.env.QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER, QUADWORK_REVIEWED_FIXTURE_CLAIMED_RUN: process.env.QUADWORK_REVIEWED_FIXTURE_CLAIMED_RUN, QUADWORK_REVIEWED_FIXTURE_CLAIMED_SPAWN_FAILURE: process.env.QUADWORK_REVIEWED_FIXTURE_CLAIMED_SPAWN_FAILURE, QUADWORK_REVIEWED_FIXTURE_FORCE_NONZERO_EXIT: process.env.QUADWORK_REVIEWED_FIXTURE_FORCE_NONZERO_EXIT, QUADWORK_REVIEWED_FIXTURE_STOP_MARKER: process.env.QUADWORK_REVIEWED_FIXTURE_STOP_MARKER, QUADWORK_REVIEWED_FIXTURE_SHUTDOWN_MARKER: process.env.QUADWORK_REVIEWED_FIXTURE_SHUTDOWN_MARKER, PATH: process.env.PATH || '/usr/bin:/bin'");
  assert.notEqual(runnerChanged, runnerSource, 'fixture forwards only its disposable fixture controls to its fixed child');
  fs.writeFileSync(runner, runnerChanged, { mode: 0o600 }); fs.chmodSync(runner, 0o600);
  const server = path.join(directory, 'server', 'index.js');
  const serverSource = fs.readFileSync(server, 'utf8');
  const failBuild = "let fixturePreclaimBuildCalls = 0;\nasync function buildAgentArgs(projectId, agentId) {\n  if (process.env.QUADWORK_REVIEWED_FIXTURE_PRECLAIM === '1' && projectId === REVIEWED_EXECUTION_PROJECT && ++fixturePreclaimBuildCalls === 2) fs.lstatSync('/definitely-unavailable/quadwork-reviewed-preclaim');";
  const observeAdmission = "async function runReviewedExecution(role) {\n  if (process.env.QUADWORK_REVIEWED_FIXTURE_ADMISSION_MARKER) { const built = await buildAgentArgs(REVIEWED_EXECUTION_PROJECT, role); const env = buildAgentEnv(REVIEWED_EXECUTION_PROJECT, role); fs.writeFileSync(process.env.QUADWORK_REVIEWED_FIXTURE_ADMISSION_MARKER, JSON.stringify({ role, args: built.args, env })); return { ok: false, code: 'fixture_preclaim_complete' }; }";
  const recordArgs = "if (preclaimProfile) { if (process.env.QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER) fs.appendFileSync(process.env.QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER, JSON.stringify({ kind: 'args', role: agentId, args: [...preclaimProfile.provider_argv] }) + '\\n'); return { args: [...preclaimProfile.provider_argv] }; }";
  const recordEnv = "if (preclaimProfile) { if (process.env.QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER) fs.appendFileSync(process.env.QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER, JSON.stringify({ kind: 'env', role: agentId, env: { ...preclaimProfile.env } }) + '\\n'); return { ...preclaimProfile.env }; }";
  const interceptedClaim = "const { PROJECT: REVIEWED_EXECUTION_PROJECT, WORKLOAD: REVIEWED_EXECUTION_WORKLOAD, PROFILES: REVIEWED_EXECUTION_PROFILES, claimAuthorization: profileClaimAuthorization, resolveReviewedExecution, reviewedLaunchPlan } = require(\"./reviewed-execution-profiles\");\nconst claimAuthorization = (...args) => { if (process.env.QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER) { fs.appendFileSync(process.env.QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER, JSON.stringify({ kind: 'claim', profile_id: args[0]?.id }) + '\\n'); throw new Error('fixture_claim_boundary'); } return profileClaimAuthorization(...args); };";
  const observedFinalizers = "stopAgentSession: (...args) => { if (process.env.QUADWORK_REVIEWED_FIXTURE_STOP_MARKER) fs.writeFileSync(process.env.QUADWORK_REVIEWED_FIXTURE_STOP_MARKER, 'called'); return stopAgentSession(...args); },\n    shutdown: (...args) => { if (process.env.QUADWORK_REVIEWED_FIXTURE_SHUTDOWN_MARKER) fs.writeFileSync(process.env.QUADWORK_REVIEWED_FIXTURE_SHUTDOWN_MARKER, 'called'); return shutdown(...args); },";
  const serverChanged = serverSource.replace('const { PROJECT: REVIEWED_EXECUTION_PROJECT, WORKLOAD: REVIEWED_EXECUTION_WORKLOAD, PROFILES: REVIEWED_EXECUTION_PROFILES, claimAuthorization, resolveReviewedExecution, reviewedLaunchPlan } = require("./reviewed-execution-profiles");', interceptedClaim).replace('async function buildAgentArgs(projectId, agentId) {', failBuild).replace('if (preclaimProfile) return { args: [...preclaimProfile.provider_argv] };', recordArgs).replace('if (preclaimProfile) return { ...preclaimProfile.env };', recordEnv).replace('async function runReviewedExecution(role) {', observeAdmission).replace('const reviewedChild = require("../benchmark/reviewed-execution-live-child-protocol.cjs");', "if (process.env.QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER) installLifecycleTestFixture(REVIEWED_EXECUTION_PROJECT, reviewedChildRole, 'linux-contained');\n  const reviewedChild = require(\"../benchmark/reviewed-execution-live-child-protocol.cjs\");").replace('stopAgentSession,\n    shutdown,', observedFinalizers).replace('sendReviewedResultAndAwaitParent(report, 0);', "sendReviewedResultAndAwaitParent(report, process.env.QUADWORK_REVIEWED_FIXTURE_FORCE_NONZERO_EXIT === '1' ? 1 : 0);");
  assert.notEqual(serverChanged, serverSource, 'fixture injects only a fixed missing preclaim prerequisite and finalizer observation');
  fs.writeFileSync(server, serverChanged, { mode: 0o600 }); fs.chmodSync(server, 0o600);
  const modules = {
    express: "function app(){return Object.assign(function(){},{use(){},get(){},post(){},put(){},delete(){},patch(){},options(){},set(){},listen(){return {on(){},close(){}}}})};app.Router=app;app.json=()=>((a,b,c)=>c&&c());app.static=()=>((a,b,c)=>c&&c());module.exports=app;",
    ws: "class W { on(){return this} once(){return this} send(){} close(){} }; module.exports={WebSocketServer:W,WebSocket:W};",
    // The claimed-run fixture uses a source-local terminal which can only emit
    // the fixed sentinel.  It cannot exec, receive argv, or contact a provider.
    'node-pty': "module.exports={spawn(){if(process.env.QUADWORK_REVIEWED_FIXTURE_CLAIMED_SPAWN_FAILURE==='1')throw new Error('fixed fixture PTY spawn failure');if(process.env.QUADWORK_REVIEWED_FIXTURE_CLAIMED_RUN!=='1')throw new Error('fixture PTY launch is forbidden');let data,onexit;return {onData(fn){data=fn;return {dispose(){}}},onExit(fn){onexit=fn;return {dispose(){}}},write(){queueMicrotask(()=>data&&data('QUADWORK_V2_PRODUCT_PATH_OK\\n'))},kill(){queueMicrotask(()=>onexit&&onexit({exitCode:0}));return true}}}};",
    multer: "function m(){return {single(){return (a,b,c)=>c&&c()}}};m.diskStorage=x=>x;module.exports=m;",
  };
  for (const [name, source] of Object.entries(modules)) { const target = path.join(directory, 'node_modules', name, 'index.js'); mkdir(path.dirname(target)); fs.writeFileSync(target, source, { mode: 0o600 }); }
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: directory }); execFileSync('/usr/bin/git', ['config', 'user.email', 'quadwork-test@invalid'], { cwd: directory }); execFileSync('/usr/bin/git', ['config', 'user.name', 'QuadWork test'], { cwd: directory }); execFileSync('/usr/bin/git', ['add', '.'], { cwd: directory }); execFileSync('/usr/bin/git', ['commit', '-qm', 'fixture'], { cwd: directory });
  return require(path.join(directory, 'server', 'reviewed-execution-profiles.js'));
}
function gateFixture(home, profiles, expectedHead, candidateDigest, profileId = 'v2_codex_readonly_v1') {
  const support = path.join(home, 'Library', 'Application Support', 'QuadWork');
  const gateParent = path.join(support, 'reviewed-execution-gates');
  const ledgerParent = path.join(support, 'reviewed-execution-ledger-parent');
  const ledger = path.join(ledgerParent, authorization.LEDGER_NAME);
  mkdir(gateParent); mkdir(ledgerParent); mkdir(ledger);
  const profile = profiles.PROFILES[profileId];
  const authorization_id = `${profile.backend}-preflight-authorization-0001`;
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
    assert.equal(result.launch_claim_state, 'none');
    assert.equal(result.failure_stage, 'prelaunch');
    assert.equal(result.survivor_free, true);
    assert.equal(result.candidate_digest, candidateDigest);
    assert.equal(fs.existsSync(path.join(gate.ledger, `${gate.authorization_key}.launch`)), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('source-fixed active child reaches server runReviewedExecution/buildAgentArgs, fails a fixed missing preclaim prerequisite, and reports zero turns', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-active-source-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-active-home-'));
  const stopMarker = path.join(home, 'stop-called'); const shutdownMarker = path.join(home, 'shutdown-called');
  try {
    const profiles = copyActiveChildFixture(fixture);
    const expectedHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    const candidateDigest = profiles.candidateDigest(fixture);
    const gate = gateFixture(home, profiles, expectedHead, candidateDigest);
    const runner = path.join(fixture, 'benchmark', 'reviewed-execution-live-runner.cjs');
    const invoked = spawnSync(process.execPath, ['-e', "require(process.argv[1]).runReviewedCodex().then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.stack); process.exit(1); });", runner], { cwd: fixture, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, USERPROFILE: home, QUADWORK_REVIEWED_FIXTURE_PRECLAIM: '1', QUADWORK_REVIEWED_FIXTURE_STOP_MARKER: stopMarker, QUADWORK_REVIEWED_FIXTURE_SHUTDOWN_MARKER: shutdownMarker } });
    assert.equal(invoked.status, 0, `${invoked.stdout}\n${invoked.stderr}`);
    const result = JSON.parse(invoked.stdout);
    assert.equal(result.result_class, 'launch_failed');
    assert.equal(result.provider_turns, 0);
    assert.equal(result.launch_claim_state, 'none');
    assert.equal(result.failure_stage, 'prelaunch');
    assert.equal(fs.existsSync(path.join(gate.ledger, `${gate.authorization_key}.launch`)), false);
    assert.equal(fs.existsSync(stopMarker), false);
    assert.equal(fs.existsSync(shutdownMarker), false);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});
test('source-fixed Codex and Claude children use only their closed preclaim argument profiles before any claim or PTY', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-preclaim-args-source-'));
  try {
    const profiles = copyActiveChildFixture(fixture);
    const expectedHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    const candidateDigest = profiles.candidateDigest(fixture);
    const runner = path.join(fixture, 'benchmark', 'reviewed-execution-live-runner.cjs');
    for (const [profileId, entry] of Object.entries(profiles.PROFILES)) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `qw-reviewed-${entry.backend}-home-`));
      const marker = path.join(home, 'preclaim-admission.json'); const stopMarker = path.join(home, 'stop-called'); const shutdownMarker = path.join(home, 'shutdown-called');
      try {
        const gate = gateFixture(home, profiles, expectedHead, candidateDigest, profileId);
        const method = entry.role === 'benchmark_codex' ? 'runReviewedCodex' : 'runReviewedClaude';
        const invoked = spawnSync(process.execPath, ['-e', "require(process.argv[1])[process.argv[2]]().then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.stack); process.exit(1); });", runner, method], { cwd: fixture, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, USERPROFILE: home, QUADWORK_REVIEWED_FIXTURE_ADMISSION_MARKER: marker, QUADWORK_REVIEWED_FIXTURE_STOP_MARKER: stopMarker, QUADWORK_REVIEWED_FIXTURE_SHUTDOWN_MARKER: shutdownMarker } });
        assert.equal(invoked.status, 0, `${entry.backend}: ${invoked.stdout}\n${invoked.stderr}`);
        const result = JSON.parse(invoked.stdout); const admitted = JSON.parse(fs.readFileSync(marker, 'utf8'));
        assert.deepEqual(admitted, { role: entry.role, args: [...entry.provider_argv], env: { ...entry.env } });
        assert.equal(result.result_class, 'launch_failed'); assert.equal(result.provider_turns, 0); assert.equal(result.launch_claim_state, 'none'); assert.equal(result.failure_stage, 'prelaunch');
        assert.equal(fs.existsSync(path.join(gate.ledger, `${gate.authorization_key}.launch`)), false);
        assert.equal(fs.existsSync(stopMarker), false); assert.equal(fs.existsSync(shutdownMarker), false);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
test('source-fixed Codex and Claude revalidate their exact preclaim args and env inside spawnAgentPty before the claim boundary', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-second-preclaim-source-'));
  try {
    const profiles = copyActiveChildFixture(fixture);
    const expectedHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    const candidateDigest = profiles.candidateDigest(fixture);
    const runner = path.join(fixture, 'benchmark', 'reviewed-execution-live-runner.cjs');
    for (const [profileId, entry] of Object.entries(profiles.PROFILES)) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `qw-reviewed-second-${entry.backend}-home-`));
      const marker = path.join(home, 'claim-boundary.jsonl'); const stopMarker = path.join(home, 'stop-called'); const shutdownMarker = path.join(home, 'shutdown-called');
      try {
        const gate = gateFixture(home, profiles, expectedHead, candidateDigest, profileId);
        const method = entry.role === 'benchmark_codex' ? 'runReviewedCodex' : 'runReviewedClaude';
        const invoked = spawnSync(process.execPath, ['-e', "require(process.argv[1])[process.argv[2]]().then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.stack); process.exit(1); });", runner, method], { cwd: fixture, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, USERPROFILE: home, QUADWORK_REVIEWED_FIXTURE_CLAIM_MARKER: marker, QUADWORK_REVIEWED_FIXTURE_STOP_MARKER: stopMarker, QUADWORK_REVIEWED_FIXTURE_SHUTDOWN_MARKER: shutdownMarker } });
        assert.equal(invoked.status, 0, `${entry.backend}: ${invoked.stdout}\n${invoked.stderr}`);
        const result = JSON.parse(invoked.stdout);
        const events = fs.readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(events, [
          { kind: 'args', role: entry.role, args: [...entry.provider_argv] },
          { kind: 'env', role: entry.role, env: { ...entry.env } },
          { kind: 'env', role: entry.role, env: { ...entry.env } },
          { kind: 'args', role: entry.role, args: [...entry.provider_argv] },
          { kind: 'claim', profile_id: entry.id },
        ]);
        assert.equal(result.result_class, 'launch_failed'); assert.equal(result.provider_turns, 0); assert.equal(result.launch_claim_state, 'none'); assert.equal(result.failure_stage, 'prelaunch');
        assert.equal(fs.existsSync(path.join(gate.ledger, `${gate.authorization_key}.launch`)), false);
        assert.equal(fs.existsSync(stopMarker), false); assert.equal(fs.existsSync(shutdownMarker), false);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
test('source-fixed claimed run returns an attested redacted failure after its result is ACKed even when the worker exits non-zero', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-claimed-result-source-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-claimed-result-home-'));
  try {
    const profiles = copyActiveChildFixture(fixture);
    const expectedHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    const candidateDigest = profiles.candidateDigest(fixture);
    const gate = gateFixture(home, profiles, expectedHead, candidateDigest);
    const runner = path.join(fixture, 'benchmark', 'reviewed-execution-live-runner.cjs');
    const invoked = spawnSync(process.execPath, ['-e', "require(process.argv[1]).runReviewedCodex().then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.stack); process.exit(1); });", runner], {
      cwd: fixture, encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, USERPROFILE: home, QUADWORK_REVIEWED_FIXTURE_CLAIMED_RUN: '1', QUADWORK_REVIEWED_FIXTURE_FORCE_NONZERO_EXIT: '1' },
    });
    assert.equal(invoked.status, 0, `${invoked.stdout}\n${invoked.stderr}`);
    const result = JSON.parse(invoked.stdout);
    assert.equal(result.provider_turns, 1);
    assert.equal(result.launch_claim_state, 'claimed');
    assert.equal(result.failure_stage, 'postclaim');
    assert.equal(result.root_cleanup_ok, true);
    assert.equal(result.survivor_free, true);
    assert.equal(result.result_class, 'attempt_indeterminate');
    assert.equal(fs.existsSync(path.join(gate.ledger, `${gate.authorization_key}.launch`)), true);
    const encoded = JSON.stringify(result);
    for (const secret of [profiles.WORKLOAD, home, fixture]) assert.equal(encoded.includes(secret), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('source-fixed claim followed by a pre-terminal PTY failure attests removal of its term-less session and returns the child failure', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-claimed-spawn-failure-source-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-reviewed-claimed-spawn-failure-home-'));
  try {
    const profiles = copyActiveChildFixture(fixture);
    const expectedHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
    const candidateDigest = profiles.candidateDigest(fixture);
    const gate = gateFixture(home, profiles, expectedHead, candidateDigest);
    const runner = path.join(fixture, 'benchmark', 'reviewed-execution-live-runner.cjs');
    const invoked = spawnSync(process.execPath, ['-e', "require(process.argv[1]).runReviewedCodex().then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.stack); process.exit(1); });", runner], {
      cwd: fixture, encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, USERPROFILE: home, QUADWORK_REVIEWED_FIXTURE_CLAIMED_SPAWN_FAILURE: '1' },
    });
    assert.equal(invoked.status, 0, `${invoked.stdout}\n${invoked.stderr}`);
    const result = JSON.parse(invoked.stdout);
    assert.equal(result.result_class, 'attempt_indeterminate');
    assert.equal(result.provider_turns, 1);
    assert.equal(result.launch_claim_state, 'claimed');
    assert.equal(result.failure_stage, 'postclaim');
    assert.equal(result.root_cleanup_ok, true);
    assert.equal(result.survivor_free, true);
    assert.equal(fs.existsSync(path.join(gate.ledger, `${gate.authorization_key}.launch`)), true);
    const encoded = JSON.stringify(result);
    for (const secret of [profiles.WORKLOAD, 'fixed fixture PTY spawn failure', home, fixture]) assert.equal(encoded.includes(secret), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
