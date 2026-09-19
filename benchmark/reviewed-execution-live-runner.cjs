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
const preparation = require('./reviewed-execution-runner.cjs');
const profiles = require('../server/reviewed-execution-profiles');

const GATE_PARENT = path.join(os.homedir(), 'Library', 'Application Support', 'QuadWork', 'reviewed-execution-gates');
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_ELAPSED_MS = 45_000;
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

function readGateReceipt(profile, facts, gateParent = GATE_PARENT) {
  const parent = checkedDirectory(gateParent, 'reviewed_execution_gate_parent_unsafe');
  const filename = gateFilename(parent, profile, facts.candidate_digest);
  let stat, receipt;
  try { stat = fs.lstatSync(filename); receipt = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('reviewed_execution_gate_missing'); }
  if (!stat.isFile() || stat.isSymbolicLink() || mode(stat) !== 0o600 || !sameUser(stat)) throw new Error('reviewed_execution_gate_unsafe');
  exact(receipt, ['schema_version', 'expected_head', 'candidate_digest', 'profile_id', 'recorded_at', 'actions', 'cache', 'artifacts'], 'reviewed_execution_gate_shape');
  exact(receipt.actions, ['enabled'], 'reviewed_execution_gate_shape');
  exact(receipt.cache, ['active_size_bytes'], 'reviewed_execution_gate_shape');
  exact(receipt.artifacts, ['nonexpired_size_bytes'], 'reviewed_execution_gate_shape');
  if (receipt.schema_version !== 1 || receipt.expected_head !== facts.expected_head || receipt.candidate_digest !== facts.candidate_digest || receipt.profile_id !== profile.id || !shapeHead(receipt.expected_head) || !shapeSha(receipt.candidate_digest) || typeof receipt.recorded_at !== 'string' || receipt.actions.enabled !== false || receipt.cache.active_size_bytes !== 0 || receipt.artifacts.nonexpired_size_bytes !== 0) throw new Error('reviewed_execution_gate_drift');
  return Object.freeze({ digest: sha256(fs.readFileSync(filename)), receipt_digest: sha256(JSON.stringify(receipt)) });
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

function removeOwnedRoot(root) {
  try { safeRoot(root); fs.rmSync(root, { recursive: true, force: false, maxRetries: 0 }); return !fs.existsSync(root); }
  catch { return false; }
}

function disposableRootFacts(root) {
  const checked = safeRoot(root); const repository = checkedDirectory(path.join(checked, 'repository'), 'reviewed_execution_repository_unsafe');
  if (git(repository, ['remote']) !== '' || git(repository, ['status', '--porcelain=v1']) !== '') throw new Error('reviewed_execution_repository_changed');
  const entries = fs.readdirSync(checked).sort().map(name => {
    const stat = fs.lstatSync(path.join(checked, name));
    if (stat.isSymbolicLink()) throw new Error('reviewed_execution_root_unsafe');
    return `${name}:${stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : 'o'}:${mode(stat).toString(8)}`;
  });
  return Object.freeze({ root_digest: sha256(entries.join('\n')), remote_count: 0, changed_entry_count: 0 });
}

function redactedReport(profile, facts, fields = {}) {
  return Object.freeze({
    schema_version: 1, purpose: 'reviewed_v2_product_path_live_attempt', profile_id: profile.id, backend: profile.backend, model: profile.model,
    expected_head: facts.expected_head, candidate_digest: facts.candidate_digest, gate_receipt_digest: fields.gate_receipt_digest || null,
    result_class: fields.result_class || 'preflight_blocked', provider_turns: Number.isInteger(fields.provider_turns) ? fields.provider_turns : 0,
    lifecycle_verified: fields.lifecycle_verified === true, sentinel_digest: fields.sentinel_digest || null,
    output_bytes: Number.isInteger(fields.output_bytes) ? fields.output_bytes : 0, output_capped: fields.output_capped === true,
    elapsed_ms: Number.isInteger(fields.elapsed_ms) ? fields.elapsed_ms : 0, root_cleanup_ok: fields.root_cleanup_ok === true,
    source_rechecked_before_prompt: fields.source_rechecked_before_prompt === true, gate_rechecked_before_prompt: fields.gate_rechecked_before_prompt === true,
    pre_root_facts: fields.pre_root_facts || null, post_root_facts: fields.post_root_facts || null,
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
  const prepare = dependencies.prepare || (profile.backend === 'codex' ? preparation.prepareReviewedCodex : preparation.prepareReviewedClaude);
  let prepared; let root = null; let runtime = null; let preRootFacts = null; let providerTurns = 0; let outputBytes = 0; let capped = false; let lifecycleVerified = false; let sentinel = false; let rechecked = false;
  try {
    prepared = await prepare(); root = prepared.root;
    if (prepared.preflight?.result_class !== 'preflight_ready') return redactedReport(profile, facts, { gate_receipt_digest: gate.receipt_digest, result_class: 'preflight_blocked', provider_turns: 0, elapsed_ms: now() - started, root_cleanup_ok: cleanupRoot(root) });
    const locations = (dependencies.writeIsolatedConfig || writeIsolatedConfig)(prepared); preRootFacts = (dependencies.disposableRootFacts || disposableRootFacts)(root);
    runtime = dependencies.runtime || await withEnvironment(locations.home, async () => require('../server/index.js'));
    const run = async () => {
      // These are the unmodified V2 public construction/admission APIs.  The
      // runner passes no command, argv, environment, config, lifecycle, or PTY input.
      await runtime.buildAgentArgs(profiles.PROJECT, profile.role); runtime.buildAgentEnv(profiles.PROJECT, profile.role);
      providerTurns = 1;
      const launched = await (profile.backend === 'codex' ? runtime.spawnReviewedCodex() : runtime.spawnReviewedClaude());
      if (!launched?.ok) return { result_class: 'launch_failed' };
      const session = runtime.agentSessions?.get(`${profiles.PROJECT}/${profile.role}`);
      if (!session?.term || typeof session.term.onData !== 'function') return { result_class: 'launch_indeterminate' };
      session.term.onData(chunk => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > MAX_OUTPUT_BYTES) capped = true; if (String(chunk).includes('QUADWORK_V2_PRODUCT_PATH_OK')) sentinel = true; });
      // Re-read both facts immediately before the one fixed private PTY write.
      const finalFacts = factsFor(repository); gateReader(profile, finalFacts, dependencies.gate_parent || GATE_PARENT);
      if (finalFacts.expected_head !== facts.expected_head || finalFacts.candidate_digest !== facts.candidate_digest || capped) return { result_class: 'attempt_indeterminate' };
      rechecked = true;
      try { session.term.write(profiles.WORKLOAD + '\n'); } catch { return { result_class: 'attempt_indeterminate' }; }
      const deadline = now() + MAX_ELAPSED_MS;
      while (now() < deadline && !capped && !sentinel) { await new Promise(resolve => setTimeout(resolve, 25)); }
      lifecycleVerified = session.lifecycleState === 'verified';
      return { result_class: capped ? 'output_cap_exceeded' : sentinel && lifecycleVerified ? 'completed' : 'attempt_indeterminate' };
    };
    const outcome = await withEnvironment(locations.home, run);
    const stopped = await runtime.stopAgentSession(`${profiles.PROJECT}/${profile.role}`, { suppressLifecycleMsg: true, removeEntry: true });
    const shutdown = await runtime.shutdown();
    let postRootFacts = null; try { postRootFacts = (dependencies.disposableRootFacts || disposableRootFacts)(root); } catch {}
    const removed = cleanupRoot(root); const cleanup = stopped?.ok === true && shutdown?.ok !== false && removed;
    return redactedReport(profile, facts, { gate_receipt_digest: gate.receipt_digest, ...outcome, provider_turns: providerTurns, lifecycle_verified: lifecycleVerified, sentinel_digest: sentinel ? sha256(profiles.SENTINEL_RULE) : null, output_bytes: outputBytes, output_capped: capped, elapsed_ms: now() - started, root_cleanup_ok: cleanup, source_rechecked_before_prompt: rechecked, gate_rechecked_before_prompt: rechecked, pre_root_facts: preRootFacts, post_root_facts: postRootFacts });
  } catch {
    if (runtime && providerTurns) {
      try { await runtime.stopAgentSession(`${profiles.PROJECT}/${profile.role}`, { suppressLifecycleMsg: true, removeEntry: true }); } catch {}
      try { await runtime.shutdown(); } catch {}
    }
    const cleanup = root ? cleanupRoot(root) : true;
    return redactedReport(profile, facts, { gate_receipt_digest: gate.receipt_digest, result_class: providerTurns ? 'attempt_indeterminate' : 'preflight_blocked', provider_turns: providerTurns, output_bytes: outputBytes, output_capped: capped, elapsed_ms: now() - started, root_cleanup_ok: cleanup, source_rechecked_before_prompt: rechecked, gate_rechecked_before_prompt: rechecked, pre_root_facts: preRootFacts });
  }
}

function runReviewedCodex() { return attempt(profiles.PROFILES.v2_codex_readonly_v1); }
function runReviewedClaude() { return attempt(profiles.PROFILES.v2_claude_restricted_v1); }

module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude, testHooks: Object.freeze({ attempt, disposableRootFacts, gateFilename, readGateReceipt, redactedReport, sourceFacts }) });
