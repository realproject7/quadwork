#!/usr/bin/env node
'use strict';

// Offline preparation only. Nothing here validates a freeze or permits a run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MAX_BYTES = 256 * 1024;
// Avoid PATH-controlled executables and the macOS Xcode selection shim.
const GIT_EXECUTABLE = process.platform === 'darwin'
  ? '/Library/Developer/CommandLineTools/usr/bin/git' : '/usr/bin/git';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const EXCLUDED = new Set([
  'operator_approval', 'independent_review', 'status',
  'mode_3_timing_permitted', 'freeze_digest',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => value != null && (
  typeof value === 'string' ? value.trim().length > 0 :
  Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : true
);

class InputError extends Error {}
function requireInput(condition, code) {
  if (!condition) throw new InputError(code);
}

function loadManifest(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    requireInput(stat.isFile(), 'manifest_not_regular_file');
    requireInput(stat.size <= MAX_BYTES, 'manifest_too_large');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    let count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) {
      size += count;
    }
    requireInput(size <= MAX_BYTES, 'manifest_too_large');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    } catch {
      throw new InputError('manifest_invalid_json');
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('manifest_unreadable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validate(manifest) {
  let nodes = 0;
  function bounded(value, depth) {
    requireInput(++nodes <= 20000 && depth <= 32, 'manifest_structure_limit');
    if (typeof value === 'string') requireInput(value.length <= 8192, 'manifest_string_limit');
    if (typeof value === 'number') requireInput(Number.isFinite(value), 'manifest_invalid_number');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        requireInput(key.length <= 128, 'manifest_key_limit');
        bounded(child, depth + 1);
      }
    }
  }
  bounded(manifest, 0);
  requireInput(object(manifest) && manifest.schema_version === 1, 'manifest_schema_version');
  requireInput(['draft_unfrozen', 'frozen'].includes(manifest.status), 'manifest_status');
  const sources = manifest.product_sources;
  requireInput(object(sources) && object(sources.v1) && object(sources.v2), 'manifest_product_sources');
  for (const value of [sources.v1.sha, sources.v2.sha, sources.v2.verified_same_tree_candidate]) {
    requireInput(typeof value === 'string' && SHA.test(value), 'manifest_product_sha');
  }
  requireInput(typeof sources.v1.tag === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(sources.v1.tag) &&
    !sources.v1.tag.includes('..') && !sources.v1.tag.includes('//') &&
    !sources.v1.tag.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) &&
    !sources.v1.tag.endsWith('/'), 'manifest_v1_tag');
  for (const key of ['harness_sha', 'workload_sha']) {
    requireInput(manifest[key] == null || (typeof manifest[key] === 'string' && SHA.test(manifest[key])), 'manifest_optional_sha');
  }
  for (const key of ['freeze_digest', 'prior_freeze_digest']) {
    requireInput(manifest[key] == null || (typeof manifest[key] === 'string' && DIGEST.test(manifest[key])), 'manifest_digest');
  }
  for (const key of ['mode_3_timing_permitted', 'actions_permitted', 'npm_publish_permitted']) {
    requireInput(manifest[key] == null || typeof manifest[key] === 'boolean', 'manifest_boolean');
  }
  for (const key of ['task_bundle', 'role_models', 'host_budget', 'run_budget', 'cache_policy', 'targets', 'operator_approval', 'independent_review']) {
    requireInput(manifest[key] == null || object(manifest[key]), 'manifest_object_field');
  }
  for (const key of ['performance_classes', 'modes', 'run_order', 'calibration_receipts']) {
    requireInput(manifest[key] == null || Array.isArray(manifest[key]), 'manifest_array_field');
  }
  const ids = new Set();
  for (const mode of manifest.modes || []) {
    requireInput(object(mode) && Number.isInteger(mode.id) && mode.id >= 1 && mode.id <= 5 && !ids.has(mode.id), 'manifest_mode');
    ids.add(mode.id);
    for (const key of ['implementation_slots', 'reviewer_slots']) {
      requireInput(mode[key] == null || (Number.isInteger(mode[key]) && mode[key] >= 1 && mode[key] <= 64), 'manifest_slots');
    }
    for (const key of ['kind', 'definition']) {
      requireInput(mode[key] == null || typeof mode[key] === 'string', 'manifest_mode_text');
    }
  }
  for (const key of ['v1_to_v2_percent', 'ablation_to_v2_percent', 'next_assignment_slo_ms']) {
    requireInput(manifest.targets?.[key] == null || (typeof manifest.targets[key] === 'number' && Number.isFinite(manifest.targets[key])), 'manifest_target_number');
  }
}

function canonicalDigest(manifest) {
  function canonical(value, root = false) {
    if (Array.isArray(value)) return '[' + value.map(item => canonical(item)).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).filter(key => !root || !EXCLUDED.has(key)).sort()
      .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  return crypto.createHash('sha256').update(canonical(manifest, true)).digest('hex');
}

// Fixed executable/commands, validated object names, no shell or inherited Git
// configuration/environment. Disable lazy object fetching and all transports.
function git(repo, args) {
  const result = spawnSync(GIT_EXECUTABLE, [
    '--no-pager', '--no-optional-locks', '-c', 'protocol.allow=never',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args,
  ], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true,
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

function localIdentities(manifest, repository) {
  const repo = path.resolve(repository);
  try {
    requireInput(fs.statSync(repo).isDirectory() && fs.existsSync(path.join(repo, '.git')), 'repository_unavailable');
    const top = git(repo, ['rev-parse', '--show-toplevel']);
    requireInput(top !== null && fs.realpathSync(top) === fs.realpathSync(repo), 'repository_unavailable');
  } catch {
    throw new InputError('repository_unavailable');
  }
  const { v1, v2 } = manifest.product_sources;
  const commit = sha => git(repo, ['cat-file', '-t', sha]) === 'commit';
  const v1Present = commit(v1.sha);
  const v2Present = commit(v2.sha);
  const candidatePresent = commit(v2.verified_same_tree_candidate);
  const tag = git(repo, ['rev-parse', '--verify', '--end-of-options', `refs/tags/${v1.tag}^{commit}`]);
  const v2Tree = v2Present ? git(repo, ['rev-parse', '--verify', '--end-of-options', `${v2.sha}^{tree}`]) : null;
  const candidateTree = candidatePresent ? git(repo, ['rev-parse', '--verify', '--end-of-options', `${v2.verified_same_tree_candidate}^{tree}`]) : null;
  return {
    v1_commit_present: v1Present,
    v2_commit_present: v2Present,
    candidate_commit_present: candidatePresent,
    v1_tag_matches: v1Present && tag === v1.sha,
    v2_candidate_tree_matches: Boolean(v2Tree && candidateTree && v2Tree === candidateTree),
  };
}

function prepare(manifest, repository) {
  validate(manifest);
  const digest = canonicalDigest(manifest);
  const identities = localIdentities(manifest, repository);
  const missing = [];
  for (const key of [
    'harness_sha', 'workload_sha', 'task_bundle', 'performance_classes',
    'role_models', 'host_budget', 'run_budget', 'cache_policy', 'run_order',
    'calibration_receipts', 'operator_approval', 'independent_review', 'freeze_digest',
  ]) if (!nonempty(manifest[key])) missing.push(key);
  for (const key of ['metric', 'eligible_class', 'v1_to_v2_percent', 'ablation_to_v2_percent', 'next_assignment_slo_ms', 'derivation']) {
    if (!nonempty(manifest.targets?.[key])) missing.push(`targets.${key}`);
  }
  for (let id = 1; id <= 5; id++) {
    const mode = manifest.modes?.find(item => item.id === id);
    if (!mode) missing.push(`modes.${id}`);
    else for (const key of ['kind', 'definition', 'implementation_slots', 'reviewer_slots']) {
      if (!nonempty(mode[key])) missing.push(`modes.${id}.${key}`);
    }
  }
  const blockers = ['preparation_only_no_execution_authority'];
  if (manifest.status !== 'frozen') blockers.push('manifest_not_frozen');
  if (missing.length) blockers.push('missing_preparation_fields');
  for (const [key, pass] of Object.entries(identities)) if (!pass) blockers.push(key);
  if (manifest.mode_1_zero_actions_feasibility !== 'proved') blockers.push('mode_1_zero_actions_feasibility_unproved');
  if (manifest.product_sources.v1.artifact_verified !== true) blockers.push('v1_installed_artifact_unverified');
  if (manifest.actions_permitted !== false || manifest.npm_publish_permitted !== false) blockers.push('safety_policy_not_disabled');
  if (manifest.freeze_digest && manifest.freeze_digest !== digest) blockers.push('freeze_digest_mismatch');
  blockers.push('calibration_and_nested_contract_not_validated', 'approval_evidence_not_verified');
  return {
    report_version: 1,
    purpose: 'offline_preparation_review',
    input_status: manifest.status,
    content_digest: digest,
    digest_algorithm: 'sha256_sorted_json_v1',
    freeze_digest_matches_content: manifest.freeze_digest ? manifest.freeze_digest === digest : null,
    local_identities: identities,
    missing_fields: missing,
    blockers,
    execution_authorized: false,
    freeze_validated: false,
    mode_3_timing_permitted: false,
  };
}

function main(argv) {
  try {
    requireInput(argv.length === 4, 'usage_expected_manifest_and_repo');
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index];
      const value = argv[index + 1];
      requireInput(['--manifest', '--repo'].includes(key) && !options[key] &&
        typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
        !value.startsWith('-') && !value.includes('\0'), 'usage_expected_manifest_and_repo');
      options[key] = value;
    }
    requireInput(options['--manifest'] && options['--repo'], 'usage_expected_manifest_and_repo');
    const report = prepare(loadManifest(options['--manifest']), options['--repo']);
    process.stdout.write(JSON.stringify(report) + '\n');
    return Object.values(report.local_identities).every(Boolean) ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({
      report_version: 1, purpose: 'offline_preparation_review', execution_authorized: false,
      error: error instanceof InputError ? error.message : 'preparation_failed',
    }) + '\n');
    return 1;
  }
}

module.exports = { prepare, canonicalDigest, loadManifest, MAX_BYTES };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
