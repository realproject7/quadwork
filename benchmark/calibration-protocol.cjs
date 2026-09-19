#!/usr/bin/env node
'use strict';

// #1037 preparation only. This parser has no child-process, network, GitHub,
// npm, Git, or write API. It cannot execute a provider or mutate a repository.
const crypto = require('node:crypto');
const fs = require('node:fs');

const MAX_BYTES = 128 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const TEXT = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const MODES = new Set([1, 2]);
const CLASSES = new Set(['pipeline_eligible', 'dependency_overlap_bound']);
const CACHE = new Set(['fresh_local_session', 'record_provider_cache_telemetry']);
const ROLES = ['dev', 'head', 're1', 're2'];

class CalibrationProtocolError extends Error {}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const required = (value, code) => { if (!value) throw new CalibrationProtocolError(code); };
function exact(value, keys, code) {
  required(object(value), code);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  required(actual.length === expected.length && actual.every((key, index) => key === expected[index]), code);
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
function text(value, max, code) { required(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value), code); return value; }
function number(value, max, code, min = 0) { required(Number.isSafeInteger(value) && value >= min && value <= max, code); return value; }
function timestamp(value) {
  required(typeof value === 'string' && value.length === 24 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, 'calibration_timestamp');
  return value;
}
function role(value) {
  exact(value, ['cli_version', 'effort', 'model_id', 'provider'], 'calibration_role_identity');
  for (const key of ['provider', 'model_id', 'cli_version']) required(TEXT.test(text(value[key], 128, 'calibration_role_identity')), 'calibration_role_identity');
  required(EFFORT.test(text(value.effort, 32, 'calibration_role_identity')), 'calibration_role_identity');
  return Object.freeze({ ...value });
}
function validateProtocol(value) {
  exact(value, ['actions', 'budget', 'cache', 'created_at', 'manifest_digest', 'mode', 'mode_1_zero_actions_feasibility', 'repetition', 'role_identities', 'run_anchor', 'run_id', 'safety', 'schema_version', 'target', 'workload_class'], 'calibration_protocol_shape');
  required(value.schema_version === 1, 'calibration_protocol_version');
  required(MODES.has(value.mode), 'calibration_mode_not_allowed');
  required(ID.test(value.run_id), 'calibration_run_id');
  required(CLASSES.has(value.workload_class), 'calibration_workload_class');
  number(value.repetition, 64, 'calibration_repetition', 1);
  required(DIGEST.test(value.manifest_digest), 'calibration_manifest_digest');
  required(['proved', 'unproved'].includes(value.mode_1_zero_actions_feasibility), 'calibration_mode_1_feasibility');
  exact(value.run_anchor, ['harness_sha', 'source_sha', 'workload_sha'], 'calibration_run_anchor');
  for (const key of Object.keys(value.run_anchor)) required(SHA.test(value.run_anchor[key]), 'calibration_run_anchor');
  exact(value.target, ['base_sha', 'repository'], 'calibration_target');
  required(SHA.test(value.target.base_sha) && REPOSITORY.test(value.target.repository), 'calibration_target');
  exact(value.role_identities, ROLES, 'calibration_role_identities');
  const roles = Object.fromEntries(ROLES.map(key => [key, role(value.role_identities[key])]));
  required(`${roles.re1.provider}:${roles.re1.model_id}` !== `${roles.re2.provider}:${roles.re2.model_id}`, 'calibration_reviewers_not_distinct');
  exact(value.budget, ['max_elapsed_ms', 'max_provider_turns', 'max_recorded_tokens'], 'calibration_budget');
  number(value.budget.max_elapsed_ms, 86_400_000, 'calibration_budget', 1);
  number(value.budget.max_provider_turns, 256, 'calibration_budget', 1);
  number(value.budget.max_recorded_tokens, 10_000_000, 'calibration_budget', 1);
  exact(value.cache, ['hosted_actions_cache', 'npm_cache', 'policy', 'provider_cache'], 'calibration_cache');
  required(CACHE.has(value.cache.policy) && CACHE.has(value.cache.provider_cache) && value.cache.hosted_actions_cache === false && value.cache.npm_cache === false, 'calibration_cache');
  exact(value.actions, ['active_artifact_bytes', 'active_cache_bytes', 'enabled'], 'calibration_actions');
  required(value.actions.enabled === false, 'calibration_actions_enabled');
  number(value.actions.active_cache_bytes, Number.MAX_SAFE_INTEGER, 'calibration_actions');
  number(value.actions.active_artifact_bytes, Number.MAX_SAFE_INTEGER, 'calibration_actions');
  exact(value.safety, ['actions_permitted', 'mode_3_timing_permitted', 'npm_publish_permitted', 'provider_execution_permitted'], 'calibration_safety');
  for (const key of Object.keys(value.safety)) required(value.safety[key] === false, 'calibration_safety');
  return Object.freeze({ ...value, created_at: timestamp(value.created_at), run_anchor: Object.freeze({ ...value.run_anchor }), target: Object.freeze({ ...value.target }), role_identities: Object.freeze(roles), budget: Object.freeze({ ...value.budget }), cache: Object.freeze({ ...value.cache }), actions: Object.freeze({ ...value.actions }), safety: Object.freeze({ ...value.safety }) });
}
function prepareCalibration(value) {
  const protocol = validateProtocol(value);
  const blockers = ['preparation_protocol_has_no_executor', 'manifest_freeze_and_digest_bound_approvals_required', 'external_provider_authentication_and_budget_gate_required'];
  if (protocol.mode === 1 && protocol.mode_1_zero_actions_feasibility !== 'proved') blockers.push('mode_1_zero_actions_feasibility_unproved');
  return Object.freeze({
    report_version: 1, purpose: 'mode_1_2_calibration_preparation', protocol_digest: digest(protocol), mode: protocol.mode, run_id: protocol.run_id, workload_class: protocol.workload_class, repetition: protocol.repetition,
    role_model_identities: Object.freeze(Object.fromEntries(ROLES.map(key => [key, `${protocol.role_identities[key].provider}:${protocol.role_identities[key].model_id}@${protocol.role_identities[key].cli_version}/${protocol.role_identities[key].effort}`]))),
    budget: protocol.budget, cache: protocol.cache, actions: protocol.actions,
    provider_execution_supported: false, github_mutation_supported: false, npm_publish_supported: false, mode_3_timing_supported: false, execution_authorized: false, blockers: Object.freeze(blockers),
  });
}
function loadProtocol(filename, io = fs) {
  let fd;
  try { fd = io.openSync(filename, io.constants.O_RDONLY | io.constants.O_NONBLOCK); const stat = io.fstatSync(fd); required(stat.isFile() && stat.size <= MAX_BYTES, 'calibration_protocol_unreadable'); const bytes = Buffer.alloc(stat.size); let offset = 0; while (offset < bytes.length) { const count = io.readSync(fd, bytes, offset, bytes.length - offset, null); required(Number.isSafeInteger(count) && count > 0, 'calibration_protocol_unreadable'); offset += count; } return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { if (error instanceof CalibrationProtocolError) throw error; throw new CalibrationProtocolError('calibration_protocol_unreadable'); }
  finally { if (fd !== undefined) io.closeSync(fd); }
}
function main(argv) {
  try { required(argv.length === 2 && argv[0] === '--protocol' && typeof argv[1] === 'string' && argv[1].length > 0 && argv[1].length <= 4096 && !argv[1].startsWith('-') && !argv[1].includes('\0'), 'usage_expected_protocol'); process.stdout.write(JSON.stringify(prepareCalibration(loadProtocol(argv[1]))) + '\n'); return 0; }
  catch (error) { process.stdout.write(JSON.stringify({ report_version: 1, purpose: 'mode_1_2_calibration_preparation', execution_authorized: false, error: error instanceof CalibrationProtocolError ? error.message : 'calibration_preparation_failed' }) + '\n'); return 1; }
}
module.exports = { CalibrationProtocolError, digest, validateProtocol, prepareCalibration, loadProtocol, MAX_BYTES };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
