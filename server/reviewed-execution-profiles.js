'use strict';

// #1115: This is deliberately a closed, source-controlled set.  It is not a
// configuration format and normal projects cannot opt into it.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = 'benchmark-product-path';
const SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const CODEX_HOME = '/Users/cho/.codex';
const WORKLOAD = 'Reply with exactly: QUADWORK_V2_PRODUCT_PATH_OK';
const SENTINEL_RULE = 'exact_stdout_line:QUADWORK_V2_PRODUCT_PATH_OK';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const safeAbsolutePath = value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 1024 && !/[\0\r\n"\\()]/.test(value);

const PROFILES = Object.freeze({
  v2_codex_readonly_v1: Object.freeze({
    id: 'v2_codex_readonly_v1', role: 'benchmark_codex', backend: 'codex',
    executable: '/opt/homebrew/Caskroom/codex/0.153.1/bin/codex',
    executable_digest: '62709f1e3beddf61abdc16fc6e702e7fc90ad2aed26e33e6d319ab4a5a090c7a',
    version_digest: 'd11fe443fb44b5a2250aad94b2ec3971cf2ab34e65ecc9895017ff03160add90',
    model: 'gpt-5.6-luna',
    provider_argv: Object.freeze(['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--ask-for-approval', 'never', '-c', 'model="gpt-5.6-luna"']),
    env: Object.freeze({ CODEX_HOME }),
  }),
  v2_claude_restricted_v1: Object.freeze({
    id: 'v2_claude_restricted_v1', role: 'benchmark_claude', backend: 'claude',
    executable: '/Users/cho/.local/share/claude/versions/2.1.277',
    executable_digest: '73d6a2a55c46907e49bd8bb7608e134333bd71173351ee16ddce7d7db9914b9c',
    version_digest: '57acde8af4b70a838ef099b3d1215ce7261164a836b69a79738cc73675a0ded1',
    model: 'claude-sonnet-4-6',
    provider_argv: Object.freeze(['--restricted', '--safe-mode', '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--model', 'claude-sonnet-4-6']),
    env: Object.freeze({}),
  }),
});

const CANDIDATE_FILES = Object.freeze([
  'server/index.js',
  'server/config.js',
  'server/agent-lifecycle.js',
  'server/project-lifecycle.js',
  'server/pty-dispatcher.js',
  'server/resource-runtime-owner.js',
  'server/file-chat.js',
  'server/reviewed-execution-profiles.js',
  'server/reviewed-execution-gate.js',
  'server/reviewed-execution-runner-bridge.js',
  'benchmark/live-provider-reviewed-contracts.cjs',
  'benchmark/v2-product-path-core.cjs',
  'benchmark/reviewed-execution-contract.cjs',
  'benchmark/reviewed-execution-runner.cjs',
  'benchmark/reviewed-execution-live-runner.cjs',
]);

function candidateDigest(repositoryRoot = path.resolve(__dirname, '..')) {
  const parts = [];
  for (const relative of CANDIDATE_FILES) {
    const filename = path.join(repositoryRoot, relative);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('reviewed_execution_candidate_file_unsafe');
    parts.push(`${relative}\0${sha256(fs.readFileSync(filename))}\n`);
  }
  parts.push(`workload\0${WORKLOAD}\n`, `sentinel_rule\0${SENTINEL_RULE}\n`, `sandbox_executable\0${SANDBOX_EXECUTABLE}\n`);
  return sha256(parts.join(''));
}

function resolveReviewedExecution(projectId, role, reviewedExecutionId) {
  if (projectId !== PROJECT || typeof role !== 'string' || typeof reviewedExecutionId !== 'string') return null;
  const profile = PROFILES[reviewedExecutionId];
  if (!profile || profile.role !== role) return null;
  return profile;
}

function sandboxSource(profile, candidate, disposableRoot, ledgerDirectory) {
  if (!profile || !/^[a-f0-9]{64}$/.test(candidate) || !safeAbsolutePath(disposableRoot) || !safeAbsolutePath(ledgerDirectory)) throw new Error('reviewed_execution_sandbox_shape');
  const readPaths = ['/System', '/usr/lib', '/usr/share', '/private/var/db', '/dev', profile.executable, disposableRoot, ledgerDirectory, ...(profile.backend === 'codex' ? [CODEX_HOME] : [])];
  return [
    '(version 1)',
    '; #1115 generated. Do not edit.',
    `; candidate_digest ${candidate}`,
    `(deny default)`,
    `(allow process-exec (literal \"${profile.executable}\"))`,
    '(allow process-fork)',
    '(allow process-info*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow network-outbound)',
    ...readPaths.map(item => `(allow file-read* (subpath \"${item}\"))`),
    `(allow file-write* (subpath \"${disposableRoot}\"))`,
    `(allow file-write* (subpath \"${ledgerDirectory}\"))`,
  ].join('\n') + '\n';
}

function validateSandbox(profile, candidate, disposableRoot, ledgerDirectory, sandboxPath, sandboxDigest) {
  if (!safeAbsolutePath(sandboxPath) || !/^[a-f0-9]{64}$/.test(sandboxDigest)) throw new Error('reviewed_execution_sandbox_invalid');
  const stat = fs.lstatSync(sandboxPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || !sameUser(stat)) throw new Error('reviewed_execution_sandbox_invalid');
  const source = sandboxSource(profile, candidate, disposableRoot, ledgerDirectory);
  if (sha256(source) !== sandboxDigest || sha256(fs.readFileSync(sandboxPath)) !== sandboxDigest) throw new Error('reviewed_execution_sandbox_drift');
  return sandboxPath;
}

function checkedOwnedDirectory(directory, code) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || !sameUser(stat)) throw new Error(code);
  return fs.realpathSync(directory);
}

function validateProfileExecutable(profile) {
  const stat = fs.lstatSync(profile.executable);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 || !sameUser(stat) || sha256(fs.readFileSync(profile.executable)) !== profile.executable_digest) throw new Error('reviewed_execution_binary_drift');
  const sandbox = fs.lstatSync(SANDBOX_EXECUTABLE);
  if (!sandbox.isFile() || sandbox.isSymbolicLink() || (sandbox.mode & 0o111) === 0 || (sandbox.mode & 0o022) !== 0) throw new Error('reviewed_execution_sandbox_unavailable');
}

function validateAuthorization(profile, candidate, ledgerDirectory, authorizationKey) {
  if (!/^[a-f0-9]{64}$/.test(authorizationKey)) throw new Error('reviewed_execution_authorization_invalid');
  const filename = path.join(ledgerDirectory, `${authorizationKey}.json`);
  let stat;
  try { stat = fs.lstatSync(filename); } catch { throw new Error('reviewed_execution_authorization_invalid'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || !sameUser(stat)) throw new Error('reviewed_execution_authorization_invalid');
  let record;
  try { record = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('reviewed_execution_authorization_invalid'); }
  if (!record || record.schema_version !== 1 || record.candidate_digest !== candidate || record.profile_id !== profile.id || record.authorization_key !== authorizationKey || typeof record.authorization_id !== 'string') throw new Error('reviewed_execution_authorization_invalid');
}

function claimAuthorization(profile, binding) {
  const ledger = checkedOwnedDirectory(binding.ledger_directory, 'reviewed_execution_ledger_invalid');
  validateAuthorization(profile, binding.candidate_digest, ledger, binding.authorization_key);
  const filename = path.join(ledger, `${binding.authorization_key}.launch`);
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, `${binding.candidate_digest}\n${profile.id}\n${binding.authorization_key}\n`, 'utf8'); fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('reviewed_execution_authorization_claimed');
    throw new Error('reviewed_execution_authorization_claim_failed');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  const ledgerFd = fs.openSync(ledger, fs.constants.O_RDONLY); try { fs.fsyncSync(ledgerFd); } finally { fs.closeSync(ledgerFd); }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || !sameUser(stat)) throw new Error('reviewed_execution_authorization_claim_failed');
}

function reviewedLaunchPlan(projectId, role, reviewedExecutionId, binding) {
  const profile = resolveReviewedExecution(projectId, role, reviewedExecutionId);
  if (!profile) return null;
  if (!binding || binding.candidate_digest !== candidateDigest() || !safeAbsolutePath(binding.disposable_root) || !safeAbsolutePath(binding.ledger_directory)) throw new Error('reviewed_execution_candidate_drift');
  const root = checkedOwnedDirectory(binding.disposable_root, 'reviewed_execution_root_invalid');
  const home = checkedOwnedDirectory(path.join(root, 'home'), 'reviewed_execution_root_invalid');
  const repository = checkedOwnedDirectory(path.join(root, 'repository'), 'reviewed_execution_root_invalid');
  const ledger = checkedOwnedDirectory(binding.ledger_directory, 'reviewed_execution_ledger_invalid');
  validateAuthorization(profile, binding.candidate_digest, ledger, binding.authorization_key);
  validateProfileExecutable(profile);
  const sandbox = validateSandbox(profile, binding.candidate_digest, root, ledger, binding.sandbox_profile, binding.sandbox_digest);
  return Object.freeze({
    executable: SANDBOX_EXECUTABLE,
    argv: Object.freeze(['-f', sandbox, profile.executable, ...profile.provider_argv]),
    env: Object.freeze({ ...profile.env }),
    backend: profile.backend,
    prompt_delivery: 'pty_write',
    profile_id: profile.id,
    disposable_root: root,
    repository,
    home,
  });
}

module.exports = Object.freeze({ CANDIDATE_FILES, CODEX_HOME, PROJECT, PROFILES, SANDBOX_EXECUTABLE, SENTINEL_RULE, WORKLOAD, candidateDigest, claimAuthorization, resolveReviewedExecution, reviewedLaunchPlan, sandboxSource, sha256 });
