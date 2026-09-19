'use strict';

// #1115 authorization primitives. This module never launches a provider.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const profiles = require('../server/reviewed-execution-profiles');

const LEDGER_NAME = 'quadwork-v2-reviewed-execution-ledger';
const MAX_PREFLIGHT_MS = 5_000;
const MAX_PREFLIGHT_OUTPUT_BYTES = 4 * 1024;
const sha256 = profiles.sha256;
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 1024 && !/[\0\r\n]/.test(value);
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();

function checkedDirectory(directory, mode, code) {
  if (!safePath(directory)) throw new Error(code);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode || !sameUser(stat)) throw new Error(code);
  return fs.realpathSync(directory);
}

function ledgerDirectory(parent) {
  const resolvedParent = checkedDirectory(parent, 0o700, 'reviewed_execution_ledger_parent_unsafe');
  const directory = path.join(resolvedParent, LEDGER_NAME);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  fs.chmodSync(directory, 0o700);
  return checkedDirectory(directory, 0o700, 'reviewed_execution_ledger_unsafe');
}

function authorizationKey(candidateDigest, profileId, authorizationId) {
  if (!/^[a-f0-9]{64}$/.test(candidateDigest) || !Object.prototype.hasOwnProperty.call(profiles.PROFILES, profileId) || !/^[a-z0-9-]{16,128}$/.test(authorizationId)) throw new Error('reviewed_execution_authorization_shape');
  return sha256(`${candidateDigest}\0${profileId}\0${authorizationId}`);
}

function consumeAuthorization({ ledger_parent, candidate_digest, profile_id, authorization_id }) {
  const directory = ledgerDirectory(ledger_parent);
  const key = authorizationKey(candidate_digest, profile_id, authorization_id);
  const filename = path.join(directory, `${key}.json`);
  const body = JSON.stringify({ schema_version: 1, candidate_digest, profile_id, authorization_id, authorization_key: key }) + '\n';
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, body, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('reviewed_execution_authorization_consumed');
    throw new Error('reviewed_execution_authorization_persist_failed');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || !sameUser(stat) || fs.readFileSync(filename, 'utf8') !== body) throw new Error('reviewed_execution_authorization_persist_failed');
  return Object.freeze({ ledger_directory: directory, receipt: filename, authorization_key: key });
}

function createSandbox({ profile_id, candidate_digest, disposable_root, ledger_directory, sandbox_directory }) {
  const profile = profiles.PROFILES[profile_id];
  const parent = checkedDirectory(sandbox_directory, 0o700, 'reviewed_execution_sandbox_parent_unsafe');
  const root = checkedDirectory(disposable_root, 0o700, 'reviewed_execution_root_unsafe');
  const ledger = checkedDirectory(ledger_directory, 0o700, 'reviewed_execution_ledger_unsafe');
  const source = profiles.sandboxSource(profile, candidate_digest, root, ledger);
  const digest = sha256(source);
  const filename = path.join(parent, `${profile_id}-${digest}.sb`);
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, source, { encoding: 'utf8' }); fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('reviewed_execution_sandbox_create_failed');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || !sameUser(stat) || sha256(fs.readFileSync(filename)) !== digest) throw new Error('reviewed_execution_sandbox_create_failed');
  return Object.freeze({ path: filename, digest });
}

function safeEnvironment(home, profile) {
  if (!safePath(home) || !profile) throw new Error('reviewed_execution_environment_invalid');
  return Object.freeze({ HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', LANG: 'C', LC_ALL: 'C', TERM: 'xterm-256color', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...profile.env });
}

function preflight({ profile_id, candidate_digest, disposable_root, ledger_directory, authorization_key, sandbox_profile, sandbox_digest, home }) {
  const started = Date.now();
  try {
    const profile = profiles.PROFILES[profile_id];
    if (!profile || candidate_digest !== profiles.candidateDigest()) throw new Error('candidate');
    profiles.reviewedLaunchPlan(profiles.PROJECT, profile.role, profile.id, { candidate_digest, disposable_root, ledger_directory, authorization_key, sandbox_profile, sandbox_digest });
    checkedDirectory(disposable_root, 0o700, 'root'); checkedDirectory(ledger_directory, 0o700, 'ledger'); checkedDirectory(home, 0o700, 'home');
    const binary = fs.lstatSync(profile.executable);
    if (!binary.isFile() || binary.isSymbolicLink() || !sameUser(binary) || sha256(fs.readFileSync(profile.executable)) !== profile.executable_digest) throw new Error('binary');
    if (!fs.existsSync(profiles.SANDBOX_EXECUTABLE)) throw new Error('sandbox');
    // No credential is read. Codex only checks that its static read-only source
    // exists; Claude authentication is provider-managed Keychain state.
    if (profile.backend === 'codex' && !fs.existsSync(profiles.CODEX_HOME)) throw new Error('auth_source');
    if (!/^[a-f0-9]{64}$/.test(profile.version_digest)) throw new Error('version_evidence');
    if (Date.now() - started > MAX_PREFLIGHT_MS) throw new Error('timeout');
    return Object.freeze({ result_class: 'preflight_ready', provider_turns: 0, elapsed_ms: Date.now() - started });
  } catch {
    return Object.freeze({ result_class: 'preflight_blocked', provider_turns: 0, elapsed_ms: Date.now() - started });
  }
}

function redactedReport(input = {}) {
  const profile = profiles.PROFILES[input.profile_id];
  return Object.freeze({ schema_version: 1, purpose: 'reviewed_v2_product_path_authorization', candidate_digest: /^[a-f0-9]{64}$/.test(input.candidate_digest || '') ? input.candidate_digest : null, profile_id: profile?.id || null, backend: profile?.backend || null, model: profile?.model || null, result_class: typeof input.result_class === 'string' ? input.result_class : 'preflight_blocked', provider_turns: Number.isInteger(input.provider_turns) ? input.provider_turns : 0, credential_copy_or_store_api_used: false, keychain_immutability_claimed: false, peer_level_network_filter_available: false, network_policy: 'fixed_binary_fixed_argv_fixed_model_no_tools_only', release_evidence: false });
}

module.exports = Object.freeze({ LEDGER_NAME, MAX_PREFLIGHT_MS, MAX_PREFLIGHT_OUTPUT_BYTES, authorizationKey, consumeAuthorization, createSandbox, ledgerDirectory, preflight, redactedReport, safeEnvironment, testHooks: Object.freeze({ checkedDirectory }) });
