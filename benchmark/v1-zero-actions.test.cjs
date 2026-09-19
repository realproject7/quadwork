'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { V1_SHA, FILES, evaluateSources, evaluatePolicy, audit, AuditError } = require('./v1-zero-actions.cjs');

const repository = path.resolve(__dirname, '..');
const git = process.platform === 'darwin' ? '/Library/Developer/CommandLineTools/usr/bin/git' : '/usr/bin/git';
function show(file) {
  const result = spawnSync(git, ['-C', repository, 'show', `${V1_SHA}:${file}`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function sources() {
  return Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, show(file.path)]));
}

test('shipped V1 source satisfies the bounded source-policy audit', () => {
  const report = audit(repository);
  assert.equal(report.source.sha, V1_SHA);
  assert.equal(report.policy.readiness_requires_two_role_approvals, true);
  assert.equal(report.policy.readiness_requires_check_result, false);
  assert.equal(report.v1_ci_less_receipt_support, false);
  assert.equal(report.mode_1_zero_actions_feasibility_proved, false);
  assert.ok(report.blockers.includes('branch_protection_and_merge_policy_not_observed'));
});

test('a change to any audited reference file fails closed by digest', () => {
  for (const key of Object.keys(FILES)) {
    const altered = sources();
    altered[key] += '\n// altered\n';
    assert.throws(() => evaluateSources(altered), new RegExp(`source_hash_mismatch_${key}`));
  }
});

test('the CLI accepts only a repository argument and never authorizes execution', () => {
  const executable = path.join(__dirname, 'v1-zero-actions.cjs');
  const good = spawnSync(process.execPath, [executable, '--repo', repository], { encoding: 'utf8', timeout: 15000 });
  assert.equal(good.status, 0, good.stderr);
  const report = JSON.parse(good.stdout);
  assert.equal(report.execution_authorized, false);
  const bad = spawnSync(process.execPath, [executable, '--repo', '--help'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).error, 'usage_expected_repo');
});

test('a source policy regression is rejected independently of the immutable digest check', () => {
  const altered = sources();
  altered.routes = altered.routes.replace('const approvals = countApprovedRoles(openPr.reviews);', 'const approvals = countApprovedRoles(openPr.reviews); const statusCheckRollup = [];');
  assert.throws(() => evaluatePolicy(altered), new RegExp('source_check_result_gate_found'));
});
