#!/usr/bin/env node
'use strict';

// Read-only source audit for the shipped V1 reference. It establishes only
// whether the tagged source's merge-ready predicate requires check results.
// It cannot observe GitHub branch protection, create a PR, or prove a delivery.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const V1_SHA = '59198955480c2224e1980e1645690d34a8ec0db3';
const V1_TAG = 'v2.7.1';
const FILES = Object.freeze({
  index: { path: 'server/index.js', sha256: 'b4c80e462d57330661c88f76179192420b355de7fa9118edc7cfd812e8dc4e1a' },
  routes: { path: 'server/routes.js', sha256: '2d11b413edcd0fdd9adaef9fce5e7de32e843ea185f20a39ba7c8e8b7978ab17' },
  package: { path: 'package.json', sha256: 'e3c6dff3472c6987d66133e47589058edcf236a38fec1eaf2ae9d87ea50cf6e1' },
});
const GIT = process.platform === 'darwin' ? '/Library/Developer/CommandLineTools/usr/bin/git' : '/usr/bin/git';
const SHA = /^[a-f0-9]{40}$/;

class AuditError extends Error {}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const required = (condition, code) => { if (!condition) throw new AuditError(code); };

function git(repository, args) {
  const result = spawnSync(GIT, [
    '--no-pager', '--no-optional-locks', '-c', 'protocol.allow=never',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repository, ...args,
  ], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return !result.error && result.status === 0 ? result.stdout : null;
}

function sourceBody(source, start, end) {
  const from = source.indexOf(start);
  const until = source.indexOf(end, from + start.length);
  return from >= 0 && until >= 0 ? source.slice(from, until) : null;
}

function evaluateSources(sources) {
  required(sources && typeof sources === 'object', 'source_audit_invalid_input');
  for (const [key, expected] of Object.entries(FILES)) {
    required(typeof sources[key] === 'string' && hash(sources[key]) === expected.sha256, `source_hash_mismatch_${key}`);
  }
  return evaluatePolicy(sources);
}

function evaluatePolicy(sources) {
  required(sources && typeof sources === 'object', 'source_audit_invalid_input');
  const readiness = sourceBody(sources.routes, 'function progressFromSnapshot(snapshot, n) {', 'function approvalsFromReviewDetail(');
  required(readiness !== null, 'source_readiness_predicate_missing');
  required(readiness.includes('const approvals = countApprovedRoles(openPr.reviews);'), 'source_role_approval_missing');
  required(readiness.includes('if (approvals >= 2) return') && readiness.includes('status: "ready"'), 'source_two_approval_ready_missing');
  required(!readiness.includes('statusCheckRollup') && !readiness.includes('check_runs') && !readiness.includes('required_check'), 'source_check_result_gate_found');
  required(sources.index.includes('Head: Merge any PR with both current-revision approvals, assign next from queue.'), 'source_trigger_merge_policy_missing');
  const packageJson = JSON.parse(sources.package);
  required(packageJson && packageJson.version === '2.7.1', 'source_package_version_mismatch');
  return Object.freeze({
    source_hashes_match: true,
    readiness_requires_two_role_approvals: true,
    readiness_requires_check_result: false,
    trigger_merge_policy_requires_two_role_approvals: true,
  });
}

function audit(repository) {
  const repo = path.resolve(repository);
  try {
    required(fs.statSync(repo).isDirectory() && fs.existsSync(path.join(repo, '.git')), 'repository_unavailable');
    required(fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim()) === fs.realpathSync(repo), 'repository_unavailable');
  } catch (error) {
    if (error instanceof AuditError) throw error;
    throw new AuditError('repository_unavailable');
  }
  const tagged = git(repo, ['rev-parse', '--verify', '--end-of-options', `refs/tags/${V1_TAG}^{commit}`]);
  required(typeof tagged === 'string' && tagged.trim() === V1_SHA, 'v1_tag_identity_mismatch');
  required(git(repo, ['cat-file', '-t', V1_SHA])?.trim() === 'commit', 'v1_commit_unavailable');
  const sources = {};
  for (const [key, file] of Object.entries(FILES)) {
    const value = git(repo, ['show', '--no-textconv', '--end-of-options', `${V1_SHA}:${file.path}`]);
    required(typeof value === 'string', `v1_source_unavailable_${key}`);
    sources[key] = value;
  }
  const policy = evaluateSources(sources);
  const ciLessPresent = git(repo, ['cat-file', '-e', `${V1_SHA}:server/ci-less-evidence.js`]) === '';
  return Object.freeze({
    report_version: 1,
    purpose: 'v1_zero_actions_source_policy_audit',
    source: { tag: V1_TAG, sha: V1_SHA, files: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, file.sha256])) },
    policy,
    v1_ci_less_receipt_support: ciLessPresent,
    conclusion: 'source_policy_compatible_delivery_unproved',
    actions_execution: 'not_attempted',
    blockers: [
      'no_disposable_repository_delivery_observed',
      'branch_protection_and_merge_policy_not_observed',
      'v1_has_no_ci_less_receipt_support',
    ],
    execution_authorized: false,
    mode_1_zero_actions_feasibility_proved: false,
  });
}

function main(argv) {
  try {
    required(argv.length === 2 && argv[0] === '--repo' && typeof argv[1] === 'string' && argv[1].length > 0 && argv[1].length <= 4096 && !argv[1].startsWith('-') && !argv[1].includes('\0'), 'usage_expected_repo');
    process.stdout.write(JSON.stringify(audit(argv[1])) + '\n');
    return 0;
  } catch (error) {
    process.stdout.write(JSON.stringify({ report_version: 1, purpose: 'v1_zero_actions_source_policy_audit', execution_authorized: false, error: error instanceof AuditError ? error.message : 'source_audit_failed' }) + '\n');
    return 1;
  }
}

module.exports = { AuditError, V1_SHA, V1_TAG, FILES, evaluateSources, evaluatePolicy, audit };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
