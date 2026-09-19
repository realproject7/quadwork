#!/usr/bin/env node
'use strict';

// #1107 bounded calibration executor. This non-shipping layer never launches a
// provider, shell, Git, GitHub, npm, or network process and never persists a ledger.
const { digest, validateProtocol } = require('./calibration-protocol.cjs');
const { appendRecord, validateLedger, digest: evidenceDigest } = require('./evidence.cjs');

const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const EXECUTABLE = 'quadwork-calibration-provider';
const INPUTS = ['adapter', 'harness', 'protocol', 'source', 'workload'];
class CalibrationExecutorError extends Error {}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function required(value, code) { if (!value) throw new CalibrationExecutorError(code); }
function exact(value, keys, code) { required(object(value), code); const actual = Object.keys(value).sort(), expected = [...keys].sort(); required(actual.length === expected.length && actual.every((key, index) => key === expected[index]), code); }
function nonnegative(value, code) { required(Number.isSafeInteger(value) && value >= 0, code); return value; }
function positive(value, code) { required(Number.isSafeInteger(value) && value > 0, code); return value; }
function same(left, right) { return digest(left) === digest(right); }
function inputDigests(value, code) { exact(value, INPUTS, code); for (const key of INPUTS) required(typeof value[key] === 'string' && DIGEST.test(value[key]), code); return Object.freeze({ ...value }); }
function target(value, code) { exact(value, ['base_sha', 'kind', 'repository', 'root_digest'], code); required(SHA.test(value.base_sha) && REPOSITORY.test(value.repository) && DIGEST.test(value.root_digest) && value.kind === 'executor_created_disposable', code); return Object.freeze({ ...value }); }
function identity(value, protocol) {
  exact(value, ['manifest_digest', 'run_anchor', 'target'], 'calibration_executor_identity');
  required(value.manifest_digest === protocol.manifest_digest && same(value.run_anchor, protocol.run_anchor), 'calibration_executor_identity');
  exact(value.target, ['base_sha', 'repository'], 'calibration_executor_identity');
  required(value.target.base_sha === protocol.target.base_sha && value.target.repository === protocol.target.repository, 'calibration_executor_identity');
  return Object.freeze({ manifest_digest: value.manifest_digest, run_anchor: Object.freeze({ ...value.run_anchor }), target: Object.freeze({ ...value.target }) });
}
function caps(value, protocol) { exact(value, ['max_elapsed_ms', 'max_provider_turns', 'max_recorded_tokens'], 'calibration_executor_caps'); for (const key of Object.keys(value)) required(positive(value[key], 'calibration_executor_caps') === protocol.budget[key], 'calibration_executor_caps'); return Object.freeze({ ...value }); }
function observations(value, protocol) {
  exact(value, ['actions', 'storage', 'usage'], 'calibration_executor_observations'); exact(value.actions, ['enabled'], 'calibration_executor_actions'); required(value.actions.enabled === false && protocol.actions.enabled === false, 'calibration_executor_actions');
  exact(value.storage, ['active_artifact_bytes', 'active_cache_bytes'], 'calibration_executor_storage'); required(nonnegative(value.storage.active_cache_bytes, 'calibration_executor_storage') === protocol.actions.active_cache_bytes && nonnegative(value.storage.active_artifact_bytes, 'calibration_executor_storage') === protocol.actions.active_artifact_bytes, 'calibration_executor_storage');
  exact(value.usage, ['elapsed_ms', 'provider_turns', 'recorded_tokens'], 'calibration_executor_usage'); for (const key of Object.keys(value.usage)) nonnegative(value.usage[key], 'calibration_executor_usage');
  return Object.freeze({ actions: Object.freeze({ ...value.actions }), storage: Object.freeze({ ...value.storage }), usage: Object.freeze({ ...value.usage }) });
}
function command(value, mode) { exact(value, ['argv', 'executable'], 'calibration_executor_command'); required(value.executable === EXECUTABLE && Array.isArray(value.argv) && value.argv.length === 4 && value.argv.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 64 && !/[\u0000\r\n]/.test(arg)), 'calibration_executor_command'); required(value.argv[0] === 'execute' && value.argv[1] === '--mode' && value.argv[2] === String(mode) && value.argv[3] === '--noninteractive', 'calibration_executor_command'); return Object.freeze({ executable: value.executable, argv: Object.freeze([...value.argv]) }); }
function mode2Route(value, mode) { exact(value, ['adapter', 'harness', 'transport'], 'calibration_executor_mode_2_route'); if (mode === 2) required(value.adapter === 'v2-workload-adapter' && value.harness === 'v2-disposable-runtime-harness' && value.transport === 'loopback', 'calibration_executor_mode_2_route'); else required(value.adapter === null && value.harness === null && value.transport === 'none', 'calibration_executor_mode_2_route'); return Object.freeze({ ...value }); }
function validateExecutorRun(value) {
  exact(value, ['caps', 'command', 'identity', 'input_digests', 'mode_2_route', 'observations', 'protocol', 'protocol_digest', 'schema_version', 'target'], 'calibration_executor_shape'); required(value.schema_version === 1, 'calibration_executor_version');
  const protocol = validateProtocol(value.protocol); required(value.protocol_digest === digest(protocol), 'calibration_executor_protocol_digest'); const boundIdentity = identity(value.identity, protocol); const boundTarget = target(value.target, 'calibration_executor_target'); required(boundTarget.base_sha === protocol.target.base_sha && boundTarget.repository === protocol.target.repository, 'calibration_executor_target'); const boundInputs = inputDigests(value.input_digests, 'calibration_executor_input_digests'); required(boundInputs.protocol === value.protocol_digest, 'calibration_executor_input_digests');
  return Object.freeze({ schema_version: 1, protocol, protocol_digest: value.protocol_digest, identity: boundIdentity, target: boundTarget, input_digests: boundInputs, caps: caps(value.caps, protocol), observations: observations(value.observations, protocol), command: command(value.command, protocol.mode), mode_2_route: mode2Route(value.mode_2_route, protocol.mode) });
}
function recordFor(run, event, reason, sequence) { const role = 'head', identity = run.protocol.role_identities[role]; return { sequence, run_id: run.protocol.run_id, mode: run.protocol.mode, workload_class: run.protocol.workload_class, repetition: run.protocol.repetition, event, provenance: 'live', origin: 'local_validation', role, model_identity: `${identity.provider}.${identity.model_id}`, role_generation: 1, task_id: 'calibration', attempt_id: 'preflight', run_anchor: run.protocol.run_anchor, delivery_identity: { repository: run.target.repository, base_sha: run.target.base_sha, candidate_sha: null }, cache_policy: run.protocol.cache.policy, monotonic_ms: sequence - 1, observed_at: '2026-09-19T00:00:00.000Z', evidence_ref: `executor/${reason}` }; }
function usageExceeds(run) { const usage = run.observations.usage, caps = run.caps; return usage.elapsed_ms > caps.max_elapsed_ms || usage.provider_turns > caps.max_provider_turns || usage.recorded_tokens > caps.max_recorded_tokens; }
function redactReport(run, ledger, reason) { return Object.freeze({ report_version: 1, purpose: 'bounded_mode_1_2_calibration_executor', run_id: run.protocol.run_id, mode: run.protocol.mode, status: 'blocked', reason, external_execution_started: false, provider_output_retained: false, npm_publish_authorized: false, github_mutation_authorized: false, mode_3_timing_authorized: false, ledger_digest: evidenceDigest(ledger), record_count: ledger.records.length }); }
function attemptCalibration(value, currentLedger, observedDigests) {
  const run = validateExecutorRun(value), ledger = validateLedger(currentLedger).ledger; required(ledger.provenance === 'live' && ledger.manifest_digest === run.protocol.manifest_digest, 'calibration_executor_ledger_identity'); const observed = inputDigests(observedDigests, 'calibration_executor_observed_digests');
  let next = appendRecord(ledger, recordFor(run, 'run_started', 'preflight', ledger.records.length + 1)); let reason;
  if (!same(observed, run.input_digests)) reason = 'input_digest_drift'; else if (usageExceeds(run)) reason = 'cap_overflow'; else if (run.protocol.mode === 1) reason = 'mode_1_zero_actions_feasibility_unproved'; else reason = 'provider_execution_not_implemented';
  next = appendRecord(next, recordFor(run, 'run_failed', reason, next.records.length + 1)); return Object.freeze({ ledger: next, report: redactReport(run, next, reason) });
}
module.exports = { CalibrationExecutorError, EXECUTABLE, validateExecutorRun, attemptCalibration };
