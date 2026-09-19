#!/usr/bin/env node
'use strict';

// #1117 is the sole live authority.  Its public surface is deliberately two
// no-input functions.  Receipt creation is a PO-only, external operation; this
// file only verifies a pre-existing receipt and never creates, edits, resets,
// or removes one.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const contract = require('./reviewed-execution-contract.cjs');
const productPath = require('./v2-product-path-core.cjs');
const profiles = require('../server/reviewed-execution-profiles');

const GATE_PARENT = path.join(os.homedir(), 'Library', 'Application Support', 'QuadWork', 'reviewed-execution-gates');
const LEDGER_PARENT = path.join(os.homedir(), 'Library', 'Application Support', 'QuadWork', 'reviewed-execution-ledger-parent');
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_ELAPSED_MS = 45_000;
const MAX_GATE_AGE_MS = 15 * 60 * 1000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const mode = stat => stat.mode & 0o777;
const exact = (value, keys, code) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(code);
};
const shapeSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const shapeHead = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function checkedDirectory(directory, code) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o700 || !sameUser(stat)) throw new Error(code);
  return fs.realpathSync(directory);
}

function git(repository, args) {
  return execFileSync('/usr/bin/git', ['-c', 'credential.helper=', ...args], {
    cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 3_000,
    env: { HOME: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', PATH: process.env.PATH || '' },
  }).trim();
}

function sourceFacts(repository = path.resolve(__dirname, '..')) {
  try {
    const head = git(repository, ['rev-parse', 'HEAD']);
    const dirty = git(repository, ['status', '--porcelain=v1']);
    if (!shapeHead(head) || dirty !== '') throw new Error('state');
    return Object.freeze({ expected_head: head, candidate_digest: profiles.candidateDigest(repository) });
  } catch { throw new Error('reviewed_execution_source_drift'); }
}

function gateFilename(parent, profile, candidate) { return path.join(parent, `${profile.id}-${candidate}.json`); }

function readGateReceipt(profile, facts, gateParent = GATE_PARENT, now = Date.now(), ledgerParent = LEDGER_PARENT) {
  const parent = checkedDirectory(gateParent, 'reviewed_execution_gate_parent_unsafe');
  const filename = gateFilename(parent, profile, facts.candidate_digest);
  let stat, receipt;
  try { stat = fs.lstatSync(filename); receipt = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('reviewed_execution_gate_missing'); }
  if (!stat.isFile() || stat.isSymbolicLink() || mode(stat) !== 0o600 || !sameUser(stat)) throw new Error('reviewed_execution_gate_unsafe');
  exact(receipt, ['schema_version', 'reviewed_head', 'reviewed_candidate_digest', 'expected_head', 'candidate_digest', 'profile_id', 'authorization_id', 'recorded_at', 'actions', 'cache', 'artifacts'], 'reviewed_execution_gate_shape');
  exact(receipt.actions, ['enabled'], 'reviewed_execution_gate_shape');
  exact(receipt.cache, ['active_size_bytes'], 'reviewed_execution_gate_shape');
  exact(receipt.artifacts, ['nonexpired_size_bytes'], 'reviewed_execution_gate_shape');
  const recordedAt = Date.parse(receipt.recorded_at);
  if (receipt.schema_version !== 1 || receipt.reviewed_head !== facts.expected_head || receipt.reviewed_candidate_digest !== facts.candidate_digest || receipt.expected_head !== facts.expected_head || receipt.candidate_digest !== facts.candidate_digest || receipt.profile_id !== profile.id || !shapeHead(receipt.expected_head) || !shapeSha(receipt.candidate_digest) || !/^[a-z0-9-]{16,128}$/.test(receipt.authorization_id) || !Number.isSafeInteger(recordedAt) || recordedAt > now || now - recordedAt > MAX_GATE_AGE_MS || receipt.actions.enabled !== false || receipt.cache.active_size_bytes !== 0 || receipt.artifacts.nonexpired_size_bytes !== 0) throw new Error('reviewed_execution_gate_drift');
  const ledger = checkedDirectory(path.join(ledgerParent, contract.LEDGER_NAME), 'reviewed_execution_gate_ledger_unsafe');
  const authorization_key = contract.authorizationKey(facts.candidate_digest, profile.id, receipt.authorization_id);
  const auth = path.join(ledger, `${authorization_key}.json`); let authStat, authBody;
  try { authStat = fs.lstatSync(auth); authBody = JSON.parse(fs.readFileSync(auth, 'utf8')); } catch { throw new Error('reviewed_execution_gate_authorization_missing'); }
  if (!authStat.isFile() || authStat.isSymbolicLink() || mode(authStat) !== 0o600 || !sameUser(authStat) || authBody?.candidate_digest !== facts.candidate_digest || authBody?.profile_id !== profile.id || authBody?.authorization_id !== receipt.authorization_id || authBody?.authorization_key !== authorization_key) throw new Error('reviewed_execution_gate_authorization_invalid');
  return Object.freeze({ ledger_directory: ledger, authorization_key, digest: sha256(fs.readFileSync(filename)), receipt_digest: sha256(JSON.stringify(receipt)) });
}

function safeRoot(root) {
  const stat = fs.lstatSync(root);
  const marker = path.join(root, '.quadwork-v2-product-path-root-v1');
  const markerStat = fs.lstatSync(marker);
  if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o700 || !sameUser(stat) || !markerStat.isFile() || markerStat.isSymbolicLink() || mode(markerStat) !== 0o600 || fs.readFileSync(marker, 'utf8') !== 'quadwork-v2-product-path-v1\n') throw new Error('reviewed_execution_root_unsafe');
  return fs.realpathSync(root);
}

function writeIsolatedConfig(prepared) {
  const root = safeRoot(prepared.root); const home = checkedDirectory(path.join(root, 'home'), 'reviewed_execution_home_unsafe');
  const directory = path.join(home, '.quadwork'); fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); checkedDirectory(directory, 'reviewed_execution_config_unsafe');
  const filename = path.join(directory, 'config.json');
  const encoded = JSON.stringify(prepared.config);
  fs.writeFileSync(filename, encoded, { mode: 0o600, flag: 'wx' }); fs.chmodSync(filename, 0o600);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || mode(stat) !== 0o600 || !sameUser(stat)) throw new Error('reviewed_execution_config_unsafe');
  return Object.freeze({ root, home, config_digest: sha256(encoded) });
}

// The PO-owned ledger authorization is read above.  This creates only the
// disposable root/config/sandbox around that pre-existing authorization; it
// never calls the #1115 authorization mint/consume operation.
async function prepareFromGate(profile, gate) {
  const parent = path.join(os.tmpdir(), 'quadwork-v2-reviewed-executor');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(parent, 0o700); checkedDirectory(parent, 'reviewed_execution_executor_parent_unsafe');
  const root = productPath.createDisposableProductPathRoot({ parent_dir: parent });
  const sandboxDirectory = path.join(root, 'home', '.reviewed-execution');
  fs.mkdirSync(sandboxDirectory, { mode: 0o700 }); fs.chmodSync(sandboxDirectory, 0o700);
  const sandbox = contract.createSandbox({ profile_id: profile.id, candidate_digest: profiles.candidateDigest(), disposable_root: root, ledger_directory: gate.ledger_directory, sandbox_directory: sandboxDirectory });
  const binding = Object.freeze({ candidate_digest: profiles.candidateDigest(), disposable_root: root, ledger_directory: gate.ledger_directory, authorization_key: gate.authorization_key, sandbox_profile: sandbox.path, sandbox_digest: sandbox.digest });
  const preflight = await contract.preflight({ profile_id: profile.id, ...binding, home: path.join(root, 'home') });
  const repository = path.join(root, 'repository');
  const config = Object.freeze({
    port: 18991, installation_id: 'benchmark_product_path_0001', session_token: crypto.randomBytes(32).toString('hex'), temp_cleanup: { enabled: false },
    projects: [{ id: profiles.PROJECT, name: 'Reviewed V2 product path', idle: true, chat_mode: 'file', repositories: [{ key: 'benchmark', repo: 'local/benchmark', working_dir: repository, primary: true }], agents: { [profile.role]: { cwd: repository, command: profile.executable, command_identity: profile.backend, model: profile.model, auto_approve: false, mcp_inject: 'none', reviewed_execution_id: profile.id, reviewed_execution_candidate_digest: binding.candidate_digest, reviewed_execution_root: binding.disposable_root, reviewed_execution_ledger_directory: binding.ledger_directory, reviewed_execution_authorization_key: binding.authorization_key, reviewed_execution_sandbox_profile: binding.sandbox_profile, reviewed_execution_sandbox_digest: binding.sandbox_digest } } }],
  });
  return Object.freeze({ root, binding, preflight, config });
}

function removeOwnedRoot(root) {
  try { safeRoot(root); fs.rmSync(root, { recursive: true, force: false, maxRetries: 0 }); return !fs.existsSync(root); }
  catch { return false; }
}

function disposableRootFacts(root) {
  const checked = safeRoot(root); const repository = checkedDirectory(path.join(checked, 'repository'), 'reviewed_execution_repository_unsafe');
  if (git(repository, ['remote']) !== '' || git(repository, ['status', '--porcelain=v1']) !== '') throw new Error('reviewed_execution_repository_changed');
  const top = fs.readdirSync(checked).sort();
  if (top.join(',') !== '.quadwork-v2-product-path-root-v1,evidence,home,repository') throw new Error('reviewed_execution_root_layout_changed');
  const entries = [];
  const walk = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name), child = relative ? `${relative}/${name}` : name, stat = fs.lstatSync(filename);
      const gitMetadata = child === 'repository/.git' || child.startsWith('repository/.git/');
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || !sameUser(stat) || (!gitMetadata && mode(stat) !== 0o700 && mode(stat) !== 0o600) || (gitMetadata && (mode(stat) & 0o022) !== 0)) throw new Error('reviewed_execution_root_unsafe');
      entries.push(`${child}:${stat.isDirectory() ? 'd' : 'f'}:${mode(stat).toString(8)}:${stat.isFile() ? sha256(fs.readFileSync(filename)) : '-'}`);
      if (stat.isDirectory()) walk(filename, child);
    }
  };
  walk(checked);
  return Object.freeze({ root_digest: sha256(entries.join('\n')), entry_digest: sha256(entries.join('\n')), entry_count: entries.length, entries: Object.freeze(entries), remote_count: 0, changed_entry_count: 0 });
}

function postRootMatches(pre, post) {
  if (!pre || !post || !Array.isArray(pre.entries) || !Array.isArray(post.entries)) return false;
  const after = new Set(post.entries);
  if (!pre.entries.every(entry => after.has(entry))) return false;
  return post.entries.every(entry => pre.entries.includes(entry) || /^home\/\.quadwork\/benchmark-product-path(?:\/[^/]+)*:(?:d|f):[67]00:[a-f0-9-]+$/.test(entry));
}

function durableStopProof(home, profile, stopped) {
  if (stopped?.ok !== true || stopped?.resources?.ptys !== 1 || stopped?.resources?.sessions !== 1) return false;
  try { const value = JSON.parse(fs.readFileSync(path.join(home, '.quadwork', profiles.PROJECT, 'agent-lifecycle-state.json'), 'utf8')); return value?.roles?.[profile.role]?.state === 'stopped'; } catch { return false; }
}

function redactedReport(profile, facts, fields = {}) {
  return Object.freeze({
    schema_version: 1, purpose: 'reviewed_v2_product_path_live_attempt', profile_id: profile.id, backend: profile.backend, model: profile.model,
    expected_head: facts.expected_head, candidate_digest: facts.candidate_digest, gate_receipt_digest: fields.gate_receipt_digest || null,
    result_class: fields.result_class || 'preflight_blocked', provider_turns: Number.isInteger(fields.provider_turns) ? fields.provider_turns : 0,
    lifecycle_verified: fields.lifecycle_verified === true, sentinel_digest: fields.sentinel_digest || null,
    output_bytes: Number.isInteger(fields.output_bytes) ? fields.output_bytes : 0, output_capped: fields.output_capped === true,
    elapsed_ms: Number.isInteger(fields.elapsed_ms) ? fields.elapsed_ms : 0, root_cleanup_ok: fields.root_cleanup_ok === true,
    survivor_free: fields.survivor_free === true,
    source_rechecked_before_prompt: fields.source_rechecked_before_prompt === true, gate_rechecked_before_prompt: fields.gate_rechecked_before_prompt === true,
    pre_root_facts: fields.pre_root_facts ? { root_digest: fields.pre_root_facts.root_digest, entry_digest: fields.pre_root_facts.entry_digest, entry_count: fields.pre_root_facts.entry_count, remote_count: 0, changed_entry_count: 0 } : null,
    post_root_facts: fields.post_root_facts ? { root_digest: fields.post_root_facts.root_digest, entry_digest: fields.post_root_facts.entry_digest, entry_count: fields.post_root_facts.entry_count, remote_count: 0, changed_entry_count: 0 } : null,
    credential_copy_or_store_api_used: false, keychain_immutability_claimed: false, peer_level_network_filter_available: false, release_evidence: false,
  });
}

async function withEnvironment(home, run) {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_SKIP_LISTEN: process.env.QUADWORK_SKIP_LISTEN };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.QUADWORK_SKIP_LISTEN = '1';
  try { return await run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

async function attempt(profile, dependencies = {}) {
  const now = dependencies.now || Date.now; const repository = dependencies.repository || path.resolve(__dirname, '..');
  const factsFor = dependencies.sourceFacts || sourceFacts; const gateReader = dependencies.readGateReceipt || readGateReceipt; const cleanupRoot = dependencies.removeOwnedRoot || removeOwnedRoot;
  const facts = factsFor(repository); const gate = gateReader(profile, facts, dependencies.gate_parent || GATE_PARENT); const started = now();
  const prepare = dependencies.prepare || (() => prepareFromGate(profile, gate));
  let prepared; let root = null; let locations = null; let runtime = null; let preRootFacts = null; let stopped = null; let shutdown = null; let stopFailed = false; let shutdownFailed = false; let providerTurns = 0; let outputBytes = 0; let output = ''; let capped = false; let lifecycleVerified = false; let sentinel = false; let rechecked = false;
  try {
    prepared = await prepare(); root = prepared.root;
    if (prepared.preflight?.result_class !== 'preflight_ready') return redactedReport(profile, facts, { gate_receipt_digest: gate.receipt_digest, result_class: 'preflight_blocked', provider_turns: 0, elapsed_ms: now() - started, root_cleanup_ok: cleanupRoot(root) });
    locations = (dependencies.writeIsolatedConfig || writeIsolatedConfig)(prepared); preRootFacts = (dependencies.disposableRootFacts || disposableRootFacts)(root);
    runtime = dependencies.runtime || await withEnvironment(locations.home, async () => require('../server/index.js'));
    const run = async () => {
      // These are the unmodified V2 public construction/admission APIs.  The
      // runner passes no command, argv, environment, config, lifecycle, or PTY input.
      await runtime.buildAgentArgs(profiles.PROJECT, profile.role); runtime.buildAgentEnv(profiles.PROJECT, profile.role);
      providerTurns = 1;
      const launched = await runtime.spawnAgentPty(profiles.PROJECT, profile.role, { lifecycleSource: 'operator_start', operatorAuthorized: true, explicitRole: true, suppressLifecycleMsg: true });
      if (!launched?.ok) return { result_class: 'launch_failed' };
      const session = runtime.agentSessions?.get(`${profiles.PROJECT}/${profile.role}`);
      if (!session?.term || typeof session.term.onData !== 'function') return { result_class: 'launch_indeterminate' };
      session.term.onData(chunk => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > MAX_OUTPUT_BYTES) { capped = true; return; } output += String(chunk); });
      // Re-read both facts immediately before the one fixed private PTY write.
      const finalFacts = factsFor(repository); gateReader(profile, finalFacts, dependencies.gate_parent || GATE_PARENT);
      if (finalFacts.expected_head !== facts.expected_head || finalFacts.candidate_digest !== facts.candidate_digest || capped) return { result_class: 'attempt_indeterminate' };
      rechecked = true;
      try { session.term.write(profiles.WORKLOAD + '\n'); } catch { return { result_class: 'attempt_indeterminate' }; }
      const deadline = now() + MAX_ELAPSED_MS;
      while (now() < deadline && !capped && !sentinel) { sentinel = output.split(/\r?\n/).includes('QUADWORK_V2_PRODUCT_PATH_OK'); await (dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(25); }
      // The durable lifecycle file is the source of truth. An in-memory state
      // is only a hint and cannot make a report successful on its own.
      const lifecycleFile = path.join(locations.home, '.quadwork', profiles.PROJECT, 'agent-lifecycle-state.json');
      try { const lifecycle = dependencies.readDurableLifecycle ? dependencies.readDurableLifecycle(lifecycleFile, profile) : JSON.parse(fs.readFileSync(lifecycleFile, 'utf8')); lifecycleVerified = lifecycle?.roles?.[profile.role]?.state === 'verified'; } catch { lifecycleVerified = false; }
      return { result_class: capped ? 'output_cap_exceeded' : sentinel && lifecycleVerified ? 'completed' : 'attempt_indeterminate' };
    };
    const outcome = await withEnvironment(locations.home, run);
    try { stopped = await runtime.stopAgentSession(`${profiles.PROJECT}/${profile.role}`, { suppressLifecycleMsg: true, removeEntry: true }); } catch (error) { stopFailed = true; throw error; }
    try { shutdown = await runtime.shutdown(); } catch (error) { shutdownFailed = true; throw error; }
    let postRootFacts = null; try { postRootFacts = (dependencies.disposableRootFacts || disposableRootFacts)(root); } catch {}
    const survivorFree = (dependencies.durableStopProof || durableStopProof)(locations.home, profile, stopped);
    const removed = cleanupRoot(root); const cleanup = !stopFailed && !shutdownFailed && stopped?.ok === true && shutdown?.ok === true && survivorFree && removed && postRootMatches(preRootFacts, postRootFacts);
    const result_class = cleanup && outcome.result_class === 'completed' ? 'completed' : cleanup ? outcome.result_class : 'cleanup_failed';
    return redactedReport(profile, facts, { gate_receipt_digest: gate.receipt_digest, ...outcome, result_class, provider_turns: providerTurns, lifecycle_verified: lifecycleVerified, sentinel_digest: sentinel ? sha256('QUADWORK_V2_PRODUCT_PATH_OK') : null, output_bytes: outputBytes, output_capped: capped, elapsed_ms: now() - started, root_cleanup_ok: cleanup, survivor_free: survivorFree, source_rechecked_before_prompt: rechecked, gate_rechecked_before_prompt: rechecked, pre_root_facts: preRootFacts, post_root_facts: postRootFacts });
  } catch {
    if (runtime && providerTurns) {
      try { stopped = await runtime.stopAgentSession(`${profiles.PROJECT}/${profile.role}`, { suppressLifecycleMsg: true, removeEntry: true }); } catch { stopped = null; stopFailed = true; }
      try { shutdown = await runtime.shutdown(); } catch { shutdown = null; shutdownFailed = true; }
    }
    let postRootFacts = null; try { if (root) postRootFacts = (dependencies.disposableRootFacts || disposableRootFacts)(root); } catch {}
    const removed = root ? cleanupRoot(root) : true; const survivorFree = locations && stopped ? (dependencies.durableStopProof || durableStopProof)(locations.home, profile, stopped) : providerTurns === 0;
    const cleanup = removed && (providerTurns === 0 || !stopFailed && !shutdownFailed && stopped?.ok === true && shutdown?.ok === true && survivorFree && postRootMatches(preRootFacts, postRootFacts));
    return redactedReport(profile, facts, { gate_receipt_digest: gate.receipt_digest, result_class: providerTurns && !cleanup ? 'cleanup_failed' : providerTurns ? 'attempt_indeterminate' : 'preflight_blocked', provider_turns: providerTurns, output_bytes: outputBytes, output_capped: capped, elapsed_ms: now() - started, root_cleanup_ok: cleanup, survivor_free: survivorFree, source_rechecked_before_prompt: rechecked, gate_rechecked_before_prompt: rechecked, pre_root_facts: preRootFacts, post_root_facts: postRootFacts });
  }
}

function runReviewedCodex() { return attempt(profiles.PROFILES.v2_codex_readonly_v1); }
function runReviewedClaude() { return attempt(profiles.PROFILES.v2_claude_restricted_v1); }

module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });
