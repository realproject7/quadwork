'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalDigest, prepare, MAX_BYTES } = require('./preflight.cjs');

let scratch;
let repo;
let manifest;
let divergent;
let sequence = 0;
const executable = path.join(__dirname, 'preflight.cjs');
const gitExecutable = process.platform === 'darwin'
  ? '/Library/Developer/CommandLineTools/usr/bin/git' : '/usr/bin/git';

function git(...args) {
  const result = spawnSync(gitExecutable, ['-C', repo, ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function clone() { return structuredClone(manifest); }
function invoke(value, options = {}) {
  const filename = path.join(scratch, `manifest-${sequence++}.json`);
  fs.writeFileSync(filename, options.raw ? value : JSON.stringify(value));
  const args = options.args || ['--manifest', filename, '--repo', options.repo || repo];
  const result = spawnSync(process.execPath, [executable, ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
    env: options.env || process.env,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.execution_authorized, false);
  return { status: result.status, report, output: result.stdout };
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-preflight-'));
  repo = path.join(scratch, 'repo with spaces; literal');
  fs.mkdirSync(repo);
  git('init', '--quiet');
  fs.writeFileSync(path.join(repo, 'fixture'), 'baseline\n');
  git('add', 'fixture');
  git('commit', '--quiet', '-m', 'baseline');
  const v1 = git('rev-parse', 'HEAD');
  git('tag', '-a', 'v2.7.1', '-m', 'annotated fixture tag');
  fs.writeFileSync(path.join(repo, 'fixture'), 'candidate\n');
  git('add', 'fixture');
  git('commit', '--quiet', '-m', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'same tree V2');
  const v2 = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'fixture'), 'divergent\n');
  git('add', 'fixture');
  git('commit', '--quiet', '-m', 'divergent');
  divergent = git('rev-parse', 'HEAD');
  manifest = {
    schema_version: 1, status: 'draft_unfrozen',
    product_sources: {
      v1: { sha: v1, tag: 'v2.7.1', artifact_verified: false },
      v2: { sha: v2, verified_same_tree_candidate: candidate },
    },
    modes: [1, 2, 3, 4, 5].map(id => ({ id, kind: 'fixture', definition: 'local fixture', implementation_slots: 1, reviewer_slots: 2 })),
    task_bundle: null, role_models: null, host_budget: null, run_budget: null,
    cache_policy: null, run_order: null, calibration_receipts: [],
    targets: { metric: 'batch_wall_time_ms', eligible_class: 'pipeline_eligible', v1_to_v2_percent: null, ablation_to_v2_percent: null, next_assignment_slo_ms: null, derivation: null },
    operator_approval: null, independent_review: null, freeze_digest: null,
    prior_freeze_digest: null, mode_3_timing_permitted: false,
    actions_permitted: false, npm_publish_permitted: false,
  };
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('well-formed draft reports missing preparation data and verified local identities', () => {
  const { status, report } = invoke(manifest);
  assert.equal(status, 0);
  assert.equal(report.input_status, 'draft_unfrozen');
  assert.equal(report.freeze_validated, false);
  assert.equal(report.mode_3_timing_permitted, false);
  assert.ok(Object.values(report.local_identities).every(Boolean));
  for (const field of ['calibration_receipts', 'task_bundle', 'role_models', 'host_budget', 'run_budget', 'run_order', 'operator_approval', 'independent_review', 'targets.v1_to_v2_percent']) {
    assert.ok(report.missing_fields.includes(field), field);
  }
  assert.ok(report.blockers.includes('manifest_not_frozen'));
});

test('malformed and wrong-schema input exits nonzero without echoing contents', () => {
  for (const raw of ['{"secret":"DO_NOT_ECHO",', 'null', '[]', '{"schema_version":9}', '1e999']) {
    const result = invoke(raw, { raw: true });
    assert.equal(result.status, 1);
    assert.ok(result.report.error);
    assert.ok(!result.output.includes('DO_NOT_ECHO'));
  }
  for (const change of [value => { value.modes = 'wrong'; }, value => { value.role_models = true; }, value => { value.targets.v1_to_v2_percent = '20'; }]) {
    const value = clone(); change(value);
    assert.equal(invoke(value).status, 1);
  }
});

test('bounded bytes, strings and nesting fail closed', () => {
  assert.equal(invoke(' '.repeat(MAX_BYTES + 1), { raw: true }).report.error, 'manifest_too_large');
  const long = clone(); long.note = 'x'.repeat(8193);
  assert.equal(invoke(long).report.error, 'manifest_string_limit');
  const deep = clone(); let current = deep;
  for (let i = 0; i < 34; i++) current = current.nested = {};
  assert.equal(invoke(deep).report.error, 'manifest_structure_limit');
});

test('invalid SHA and malicious ref/argv cannot execute a command', () => {
  const marker = path.join(scratch, 'should-not-exist');
  for (const sha of ['HEAD', '--help', 'a'.repeat(39), `$(touch ${marker})`]) {
    const value = clone(); value.product_sources.v2.sha = sha;
    const result = invoke(value);
    assert.equal(result.status, 1);
    assert.equal(result.report.error, 'manifest_product_sha');
  }
  for (const tag of ['--help', 'v2.7.1^{tree}', `v2.7.1;touch ${marker}`, '../HEAD', 'a.lock/x']) {
    const value = clone(); value.product_sources.v1.tag = tag;
    assert.equal(invoke(value).report.error, 'manifest_v1_tag');
  }
  assert.equal(invoke(manifest, { args: ['--manifest', '--help', '--repo', repo] }).status, 1);
  assert.equal(invoke(manifest, { args: ['--manifest', 'unused', '--execute', marker] }).status, 1);
  assert.equal(invoke(manifest, { args: ['--manifest', `$(touch ${marker})`, '--repo', repo] }).report.error, 'manifest_unreadable');
  assert.equal(fs.existsSync(marker), false);
});

test('missing local commit is a nonzero identity blocker', () => {
  const value = clone(); value.product_sources.v2.sha = 'a'.repeat(40);
  const result = invoke(value);
  assert.equal(result.status, 1);
  assert.equal(result.report.local_identities.v2_commit_present, false);
  assert.ok(result.report.blockers.includes('v2_commit_present'));
});

test('V1 tag mismatch and divergent V2 candidate tree are nonzero blockers', () => {
  const wrongTag = clone(); wrongTag.product_sources.v1.sha = divergent;
  const tagResult = invoke(wrongTag);
  assert.equal(tagResult.status, 1);
  assert.equal(tagResult.report.local_identities.v1_tag_matches, false);
  const wrongTree = clone(); wrongTree.product_sources.v2.sha = divergent;
  const treeResult = invoke(wrongTree);
  assert.equal(treeResult.status, 1);
  assert.equal(treeResult.report.local_identities.v2_candidate_tree_matches, false);
});

test('repository must be the explicit working-tree root, not an ancestor-discovered repo', () => {
  const nested = path.join(repo, 'nested'); fs.mkdirSync(nested);
  assert.equal(invoke(manifest, { repo: nested }).report.error, 'repository_unavailable');
  assert.equal(invoke(manifest, { repo: scratch }).status, 1);
  assert.equal(invoke(manifest, { repo: path.join(repo, 'fixture') }).status, 1);
});

test('forged frozen status, matching digest and approval fields never authorize execution', () => {
  const value = clone();
  value.status = 'frozen'; value.mode_3_timing_permitted = true;
  value.operator_approval = { approved: true, evidence: 'DO_NOT_ECHO' };
  value.independent_review = { approved: true, evidence: 'DO_NOT_ECHO' };
  value.freeze_digest = canonicalDigest(value);
  const result = invoke(value);
  assert.equal(result.status, 0);
  assert.equal(result.report.input_status, 'frozen');
  assert.equal(result.report.freeze_digest_matches_content, true);
  assert.equal(result.report.freeze_validated, false);
  assert.equal(result.report.mode_3_timing_permitted, false);
  assert.ok(result.report.blockers.includes('approval_evidence_not_verified'));
  assert.ok(!result.output.includes('DO_NOT_ECHO'));
});

test('canonical digest ignores only root approval/derived fields and object key order', () => {
  const base = canonicalDigest(manifest);
  const changed = clone();
  Object.assign(changed, { operator_approval: { receipt: 'different' }, independent_review: {}, status: 'frozen', mode_3_timing_permitted: true, freeze_digest: 'f'.repeat(64) });
  assert.equal(canonicalDigest(changed), base);
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
  assert.equal(canonicalDigest(reverseKeys(manifest)), base);
  for (const edit of [
    value => { value.modes[0].implementation_slots = 2; },
    value => { value.task_bundle = { tasks: ['new-task'] }; },
    value => { value.run_budget = { max_cost_usd: 1 }; },
    value => { value.prior_freeze_digest = 'f'.repeat(64); },
    value => { value.task_bundle = { status: 'nested status remains hashed' }; },
    value => { value.modes.reverse(); },
  ]) { const value = clone(); edit(value); assert.notEqual(canonicalDigest(value), base); }
});

test('Git environment injection and replace refs cannot forge local identities', () => {
  const result = invoke(manifest, { env: { ...process.env, GIT_DIR: '/nonexistent', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.rev-parse', GIT_CONFIG_VALUE_0: '!false' } });
  assert.equal(result.status, 0);
  git('replace', manifest.product_sources.v2.sha, divergent);
  try { assert.equal(invoke(manifest).status, 0); }
  finally { git('replace', '-d', manifest.product_sources.v2.sha); }
});

test('report and preparation do not change repo files, refs or process environment', () => {
  const beforeStatus = git('status', '--porcelain');
  const beforeRefs = git('show-ref');
  const beforeEnvironment = { ...process.env };
  const report = prepare(clone(), repo);
  assert.equal(report.execution_authorized, false);
  assert.deepEqual({ ...process.env }, beforeEnvironment);
  assert.equal(git('status', '--porcelain'), beforeStatus);
  assert.equal(git('show-ref'), beforeRefs);
});
