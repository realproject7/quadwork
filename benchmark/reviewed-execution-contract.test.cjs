'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const contract = require('./reviewed-execution-contract.cjs');
const runner = require('./reviewed-execution-runner.cjs');
const profiles = require('../server/reviewed-execution-profiles');

function tempRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quadwork-reviewed-execution-test-')); fs.chmodSync(root, 0o700); return root; }
function makeDirectory(parent, name) { const directory = path.join(parent, name); fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); return directory; }

test('the closed profile registry contains only the reviewed Codex and Claude launches', () => {
  assert.deepEqual(Object.keys(profiles.PROFILES).sort(), ['v2_claude_restricted_v1', 'v2_codex_readonly_v1']);
  assert.deepEqual(profiles.PROFILES.v2_codex_readonly_v1.provider_argv, ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--ask-for-approval', 'never', '-c', 'model="gpt-5.6-luna"']);
  assert.deepEqual(profiles.PROFILES.v2_claude_restricted_v1.provider_argv, ['--restricted', '--safe-mode', '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--model', 'claude-sonnet-4-6']);
  assert.equal(profiles.resolveReviewedExecution('ordinary-project', 'benchmark_codex', 'v2_codex_readonly_v1'), null);
  assert.equal(profiles.resolveReviewedExecution('benchmark-product-path', 'benchmark_codex', 'v2_claude_restricted_v1'), null);
});

test('candidate input list is explicit and includes the V2 launch chain, reviewed evidence, sandbox, workload, and runner', () => {
  assert.deepEqual(profiles.CANDIDATE_FILES, [
    'server/index.js', 'server/config.js', 'server/agent-lifecycle.js', 'server/project-lifecycle.js', 'server/pty-dispatcher.js', 'server/resource-runtime-owner.js', 'server/file-chat.js', 'server/reviewed-execution-profiles.js', 'server/reviewed-execution-gate.js', 'server/reviewed-execution-runner-bridge.js', 'benchmark/live-provider-reviewed-contracts.cjs', 'benchmark/v2-product-path-core.cjs', 'benchmark/reviewed-execution-contract.cjs', 'benchmark/reviewed-execution-runner.cjs', 'benchmark/reviewed-execution-live-runner.cjs',
  ]);
  assert.match(profiles.WORKLOAD, /QUADWORK_V2_PRODUCT_PATH_OK/);
  assert.match(profiles.SENTINEL_RULE, /exact_stdout_line/);
  assert.match(profiles.candidateDigest(), /^[a-f0-9]{64}$/);
});

test('recorded version evidence is static, digest-shaped, and has no dynamic probe', () => {
  for (const profile of Object.values(profiles.PROFILES)) assert.match(profile.version_digest, /^[a-f0-9]{64}$/);
  const source = fs.readFileSync(path.join(__dirname, 'reviewed-execution-contract.cjs'), 'utf8');
  assert.doesNotMatch(source, /node-pty|child_process|--version|spawn\(/);
});

test('final PTY launch plan is exactly sandbox-exec plus the fixed profile command, argv, environment, backend, and PTY prompt rule', () => {
  const parent = tempRoot(); const root = makeDirectory(parent, 'root'); const home = makeDirectory(root, 'home'); makeDirectory(root, 'repository'); const ledgerParent = makeDirectory(parent, 'ledger-parent'); const sandboxParent = makeDirectory(home, 'sandbox');
  const profile = profiles.PROFILES.v2_codex_readonly_v1; const candidate = profiles.candidateDigest();
  const authorization = contract.consumeAuthorization({ ledger_parent: ledgerParent, candidate_digest: candidate, profile_id: profile.id, authorization_id: 'authorization-0003' }); const ledger = authorization.ledger_directory;
  const sandbox = contract.createSandbox({ profile_id: profile.id, candidate_digest: candidate, disposable_root: root, ledger_directory: ledger, sandbox_directory: sandboxParent });
  const plan = profiles.reviewedLaunchPlan('benchmark-product-path', 'benchmark_codex', profile.id, { candidate_digest: candidate, disposable_root: root, ledger_directory: ledger, authorization_key: authorization.authorization_key, sandbox_profile: sandbox.path, sandbox_digest: sandbox.digest });
  assert.equal(plan.executable, '/usr/bin/sandbox-exec');
  assert.deepEqual(plan.argv, ['-f', sandbox.path, profile.executable, ...profile.provider_argv]);
  assert.deepEqual(plan.env, { CODEX_HOME: '/Users/cho/.codex' });
  assert.equal(plan.backend, 'codex'); assert.equal(plan.prompt_delivery, 'pty_write');
  const binding = { candidate_digest: candidate, disposable_root: root, ledger_directory: ledger, authorization_key: authorization.authorization_key, sandbox_profile: sandbox.path, sandbox_digest: sandbox.digest };
  profiles.claimAuthorization(profile, binding);
  assert.throws(() => profiles.claimAuthorization(profile, binding), /authorization_claimed/);
  assert.throws(() => profiles.reviewedLaunchPlan('benchmark-product-path', 'benchmark_codex', profile.id, { candidate_digest: '0'.repeat(64), disposable_root: root, ledger_directory: ledger, authorization_key: authorization.authorization_key, sandbox_profile: sandbox.path, sandbox_digest: sandbox.digest }), /candidate_drift/);
  assert.throws(() => profiles.reviewedLaunchPlan('benchmark-product-path', 'benchmark_codex', profile.id, { candidate_digest: candidate, disposable_root: root, ledger_directory: ledger, authorization_key: '0'.repeat(64), sandbox_profile: sandbox.path, sandbox_digest: sandbox.digest }), /authorization_invalid/);
});

test('sandbox source is candidate-bound, source-generated, denies by default, and gives writes only to owned root and ledger', () => {
  const profile = profiles.PROFILES.v2_claude_restricted_v1; const source = profiles.sandboxSource(profile, 'a'.repeat(64), '/private/tmp/owned-root', '/private/tmp/owned-ledger');
  assert.match(source, /^\(version 1\)\n; #1115 generated/m); assert.match(source, /\(deny default\)/); assert.match(source, /candidate_digest a{64}/);
  assert.match(source, /file-write\* \(subpath \"\/private\/tmp\/owned-root\"\)/);
  assert.match(source, /file-write\* \(subpath \"\/private\/tmp\/owned-ledger\"\)/);
  assert.doesNotMatch(source, /\.quadwork/); assert.doesNotMatch(source, /ssh|npm|github/i);
  assert.throws(() => profiles.sandboxSource(profile, 'a'.repeat(64), '/private/tmp/owned") (allow file-write* (subpath "/"))', '/private/tmp/owned-ledger'), /sandbox_shape/);
});

test('O_EXCL ledger consumes one authorization before preflight and rejects retry or concurrent-equivalent use', () => {
  const parent = tempRoot(); const candidate = 'b'.repeat(64); const request = { ledger_parent: parent, candidate_digest: candidate, profile_id: 'v2_claude_restricted_v1', authorization_id: 'authorization-0001' };
  const first = contract.consumeAuthorization(request);
  assert.equal(fs.statSync(first.receipt).mode & 0o777, 0o600);
  assert.throws(() => contract.consumeAuthorization(request), /authorization_consumed/);
  assert.equal(fs.existsSync(first.receipt), true);
});

test('preflight is zero-turn and reports unavailable local prerequisites as preflight_blocked without a workload', async () => {
  const root = tempRoot(); const home = makeDirectory(root, 'home'); makeDirectory(root, 'repository'); const ledger = makeDirectory(root, 'ledger'); const sandboxParent = makeDirectory(home, 'sandbox');
  const profile = profiles.PROFILES.v2_claude_restricted_v1; const candidate = profiles.candidateDigest();
  const sandbox = contract.createSandbox({ profile_id: profile.id, candidate_digest: candidate, disposable_root: root, ledger_directory: ledger, sandbox_directory: sandboxParent });
  const result = await contract.preflight({ profile_id: profile.id, candidate_digest: candidate, disposable_root: root, ledger_directory: ledger, sandbox_profile: sandbox.path, sandbox_digest: crypto.createHash('sha256').update('wrong').digest('hex'), home });
  assert.deepEqual(result.provider_turns, 0); assert.equal(result.result_class, 'preflight_blocked');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'reviewed-execution-runner.cjs'), 'utf8'), /require\(['"]node:child_process|spawn\(|execFile|WORKLOAD/);
});

test('runner preparation consumes the cap and never invokes a provider workload or credential API', async () => {
  const parent = tempRoot(); const ledgerParent = makeDirectory(parent, 'ledger-parent');
  const result = await runner.testHooks.prepareReviewedExecution({ adapter: 'claude', parent_dir: parent, ledger_parent: ledgerParent, authorization_id: 'authorization-0002' });
  assert.equal(result.report.provider_turns, 0); assert.equal(result.report.credential_copy_or_store_api_used, false);
  assert.equal(result.report.keychain_immutability_claimed, false); assert.equal(result.report.peer_level_network_filter_available, false);
  assert.match(result.authorization_receipt, /quadwork-v2-reviewed-execution-ledger/);
  await assert.rejects(() => runner.testHooks.prepareReviewedExecution({ adapter: 'claude', parent_dir: parent, ledger_parent: ledgerParent, authorization_id: 'authorization-0002' }), /authorization_consumed/);
});

test('server integration uses the private resolver at args, env, and final PTY launch construction', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(source, /resolveReviewedExecution\(projectId, agentId, id\)/);
  assert.match(source, /reviewedExecution\s*\? reviewedLaunchPlan\(project, agent, reviewedExecution\.id, reviewedExecutionBinding\(agentCfg\)\)/);
  assert.match(source, /command: launchCommand/); assert.match(source, /reviewedPlan \? reviewedTerminalEnvironment\(reviewedPlan\)/);
  assert.match(source, /const REVIEWED_EXECUTION_LIVE_ENABLED = true/);
});
