#!/usr/bin/env node
'use strict';

// Offline evidence validation only. This module never launches a provider,
// contacts a remote service, or writes a ledger. Callers persist the immutable
// value returned by appendRecord. The record hash chain detects a removed or
// rewritten prefix once a ledger digest has been retained as external evidence.
const crypto = require('node:crypto');
const fs = require('node:fs');

const MAX_BYTES = 512 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
// GitHub's limits: an owner of up to 39 and a repository of up to 100 characters.
const REPOSITORY = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// Credential shapes, each a token prefix plus its characteristic body, matched
// anywhere in a repository or model identity value: GitHub classic and
// fine-grained, OpenAI/Anthropic, Stripe, Slack, AWS, npm, GitLab, Hugging
// Face, and Google keys.
const CREDENTIAL = /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20}|hf_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35}/;
// #1182 closed text fields. Evidence refs are generated, never caller text:
// ledger-writer.cjs writes `writer/<sha256>`, and historical calibration
// executor records use `executor/<reason>/<sha256>` with its reachable reasons.
const EXECUTOR_REASONS = ['preflight', 'provider_execution_not_permitted', 'mode_1_zero_actions_feasibility_unproved', 'cap_overflow', 'environment_observation_drift', 'environment_observation_unavailable', 'calibration_executor_environment_unavailable', 'calibration_executor_environment_observation'];
const EVIDENCE_REF = new RegExp(`^(?:writer|executor/(?:${EXECUTOR_REASONS.join('|')}))/[a-f0-9]{64}$`);
// calibration-protocol.cjs's model-id rule (its TEXT pattern), bounded to 128 characters.
const MODEL_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const ROLES = new Set(['head', 'dev', 're1', 're2']);
const CACHE_POLICIES = new Set(['fresh_local_session', 'record_provider_cache_telemetry']);
const PROVENANCE = new Set(['live', 'replay', 'historical']);
const CLASSES = new Set(['pipeline_eligible', 'dependency_overlap_bound', 'safety_recovery']);
const ORIGINS = new Set(['harness', 'provider', 'local_validation', 'github_authenticated_rest']);
// A validation record is harness acceptance or the product's own local validation.
const VALIDATION_ORIGINS = new Set(['harness_acceptance', 'local_validation']);
const EVENTS = new Set([
  'run_started', 'task_ready', 'assignment', 'candidate_ready', 'review_started',
  'review_sealed', 'review_released', 'correction', 'local_validation',
  'publication', 'merge_readback', 'task_delivered', 'recovery',
  'run_complete', 'run_failed', 'run_interrupted',
]);
const TERMINAL = new Set(['run_complete', 'run_failed', 'run_interrupted']);
const REQUIRED_SUCCESS = new Set([
  'run_started', 'candidate_ready', 'review_started', 'review_sealed',
  'review_released', 'local_validation', 'task_delivered', 'run_complete',
]);

class EvidenceError extends Error {}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireEvidence(condition, code) { if (!condition) throw new EvidenceError(code); }
function exact(value, keys, code) {
  requireEvidence(object(value), code);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  requireEvidence(actual.length === expected.length && actual.every((key, index) => key === expected[index]), code);
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function timestamp(value) {
  requireEvidence(typeof value === 'string' && value.length === 24 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, 'evidence_timestamp');
  return value;
}
function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }
function runAnchor(value) {
  exact(value, ['harness_sha', 'source_sha', 'workload_sha'], 'evidence_run_anchor');
  for (const key of ['harness_sha', 'source_sha', 'workload_sha']) requireEvidence(matches(value[key], SHA), 'evidence_run_anchor');
  return Object.freeze({ ...value });
}
function deliveryIdentity(value, event) {
  exact(value, ['base_sha', 'candidate_sha', 'repository'], 'evidence_delivery_identity');
  requireEvidence(matches(value.repository, REPOSITORY) && !CREDENTIAL.test(value.repository), 'evidence_delivery_identity');
  requireEvidence(matches(value.base_sha, SHA), 'evidence_delivery_identity');
  const beforeCandidate = new Set(['run_started', 'task_ready', 'assignment']);
  const candidateOptional = new Set(['recovery', 'run_failed', 'run_interrupted']);
  requireEvidence(beforeCandidate.has(event) ? value.candidate_sha === null : candidateOptional.has(event) ? value.candidate_sha === null || matches(value.candidate_sha, SHA) : matches(value.candidate_sha, SHA), 'evidence_delivery_identity');
  return Object.freeze({ ...value });
}
function record(value, ledgerProvenance) {
  exact(value, ['attempt_id', 'cache_policy', 'delivery_identity', 'event', 'evidence_ref', 'mode', 'model_identity', 'monotonic_ms', 'observed_at', 'origin', 'prior_record_digest', 'provenance', 'repetition', 'role', 'role_generation', 'run_anchor', 'run_id', 'sequence', 'task_id', 'workload_class'], 'evidence_record_shape');
  requireEvidence(Number.isSafeInteger(value.sequence) && value.sequence > 0, 'evidence_sequence');
  requireEvidence(matches(value.run_id, ID), 'evidence_run_id');
  requireEvidence(Number.isSafeInteger(value.mode) && value.mode >= 1 && value.mode <= 5, 'evidence_mode');
  requireEvidence(CLASSES.has(value.workload_class), 'evidence_workload_class');
  requireEvidence(Number.isSafeInteger(value.repetition) && value.repetition >= 1 && value.repetition <= 64, 'evidence_repetition');
  requireEvidence(EVENTS.has(value.event), 'evidence_event');
  requireEvidence(PROVENANCE.has(value.provenance) && value.provenance === ledgerProvenance, 'evidence_provenance_mixed');
  requireEvidence((value.event === 'local_validation' ? VALIDATION_ORIGINS : ORIGINS).has(value.origin), 'evidence_origin'); requireEvidence(ROLES.has(value.role), 'evidence_role');
  requireEvidence(matches(value.model_identity, MODEL_IDENTITY) && !CREDENTIAL.test(value.model_identity), 'evidence_model_identity');
  requireEvidence(matches(value.task_id, ID), 'evidence_task_id'); requireEvidence(matches(value.attempt_id, ID), 'evidence_attempt_id');
  requireEvidence(Number.isSafeInteger(value.role_generation) && value.role_generation >= 1 && value.role_generation <= 64, 'evidence_role_generation');
  requireEvidence(value.prior_record_digest === null || matches(value.prior_record_digest, DIGEST), 'evidence_prior_digest');
  requireEvidence(CACHE_POLICIES.has(value.cache_policy), 'evidence_cache_policy');
  requireEvidence(Number.isSafeInteger(value.monotonic_ms) && value.monotonic_ms >= 0, 'evidence_monotonic_ms'); timestamp(value.observed_at);
  requireEvidence(typeof value.evidence_ref === 'string' && EVIDENCE_REF.test(value.evidence_ref), 'evidence_ref');
  return Object.freeze({ ...value, run_anchor: runAnchor(value.run_anchor), delivery_identity: deliveryIdentity(value.delivery_identity, value.event) });
}
function ledger(value) {
  exact(value, ['manifest_digest', 'provenance', 'records', 'schema_version'], 'evidence_ledger_shape');
  requireEvidence(value.schema_version === 1, 'evidence_schema_version'); requireEvidence(matches(value.manifest_digest, DIGEST), 'evidence_manifest_digest');
  requireEvidence(PROVENANCE.has(value.provenance), 'evidence_provenance'); requireEvidence(Array.isArray(value.records) && value.records.length <= 2048, 'evidence_records');
  return Object.freeze({ schema_version: 1, manifest_digest: value.manifest_digest, provenance: value.provenance, records: Object.freeze(value.records.map(item => record(item, value.provenance))) });
}
function sameAnchor(left, right) { return stable(left) === stable(right); }
function validateLedger(value) {
  const normalized = ledger(value); const runs = new Map(); let previousSequence = 0; let previousRecord = null;
  for (const item of normalized.records) {
    requireEvidence(item.sequence === previousSequence + 1, 'evidence_sequence_gap'); previousSequence = item.sequence;
    requireEvidence(item.prior_record_digest === (previousRecord ? digest(previousRecord) : null), 'evidence_chain_broken');
    let run = runs.get(item.run_id);
    if (!run) { run = { run_anchor: item.run_anchor, monotonic_ms: -1, observed_at: '', events: new Set(), terminal: null, event_tasks: new Set(), mode: item.mode, workload_class: item.workload_class, repetition: item.repetition }; runs.set(item.run_id, run); }
    requireEvidence(!run.terminal, 'evidence_after_terminal');
    requireEvidence(sameAnchor(run.run_anchor, item.run_anchor) && run.mode === item.mode && run.workload_class === item.workload_class && run.repetition === item.repetition, 'evidence_run_identity_changed');
    requireEvidence(item.monotonic_ms >= run.monotonic_ms, 'evidence_monotonic_regression'); requireEvidence(item.observed_at >= run.observed_at, 'evidence_timestamp_regression');
    const eventTask = `${item.event}:${item.task_id}:${item.role}:${item.role_generation}:${item.attempt_id}:${item.delivery_identity.repository}:${item.delivery_identity.candidate_sha ?? 'none'}${item.event === 'local_validation' ? `:${item.origin}` : ''}`;
    requireEvidence(!run.event_tasks.has(eventTask) || item.event === 'recovery', 'evidence_duplicate_event');
    // Harness acceptance never satisfies the product's own validation requirement.
    run.monotonic_ms = item.monotonic_ms; run.observed_at = item.observed_at; if (item.event !== 'local_validation' || item.origin === 'local_validation') run.events.add(item.event); run.event_tasks.add(eventTask); if (TERMINAL.has(item.event)) run.terminal = item.event; previousRecord = item;
  }
  return Object.freeze({ ledger: normalized, runs });
}
function summarizeLedger(value) {
  const { ledger: normalized, runs } = validateLedger(value); const run_reports = []; let complete = 0;
  for (const [run_id, run] of runs) {
    const missing = [...REQUIRED_SUCCESS].filter(event => !run.events.has(event)); const successful = run.terminal === 'run_complete' && missing.length === 0;
    if (successful) complete += 1;
    run_reports.push({ run_id, mode: run.mode, workload_class: run.workload_class, repetition: run.repetition, terminal: run.terminal, missing_required_events: missing, structurally_complete: successful, eligible_for_speed_result: false });
  }
  run_reports.sort((left, right) => left.run_id.localeCompare(right.run_id));
  return Object.freeze({ report_version: 1, purpose: 'offline_evidence_validation', ledger_digest: digest(normalized), manifest_digest: normalized.manifest_digest, provenance: normalized.provenance, record_count: normalized.records.length, run_count: run_reports.length, structurally_complete_run_count: complete, speed_result_authorized: false, eligible_speed_run_count: 0, run_reports });
}
function appendRecord(value, next) {
  const normalized = validateLedger(value).ledger;
  requireEvidence(object(next) && !Object.hasOwn(next, 'prior_record_digest'), 'evidence_append_shape');
  const candidate = record({ ...next, prior_record_digest: normalized.records.length ? digest(normalized.records.at(-1)) : null }, normalized.provenance);
  requireEvidence(candidate.sequence === normalized.records.length + 1, 'evidence_append_sequence');
  return validateLedger({ schema_version: normalized.schema_version, manifest_digest: normalized.manifest_digest, provenance: normalized.provenance, records: [...normalized.records, candidate] }).ledger;
}
function loadLedger(filename, io = fs) {
  let fd;
  try { fd = io.openSync(filename, io.constants.O_RDONLY | io.constants.O_NONBLOCK); const stat = io.fstatSync(fd); requireEvidence(stat.isFile() && stat.size <= MAX_BYTES, 'evidence_ledger_unreadable'); const bytes = Buffer.alloc(stat.size); let offset = 0; while (offset < bytes.length) { const count = io.readSync(fd, bytes, offset, bytes.length - offset, null); requireEvidence(Number.isSafeInteger(count) && count > 0, 'evidence_ledger_unreadable'); offset += count; } return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { if (error instanceof EvidenceError) throw error; throw new EvidenceError('evidence_ledger_unreadable'); }
  finally { if (fd !== undefined) io.closeSync(fd); }
}
function main(argv) {
  try { requireEvidence(argv.length === 2 && argv[0] === '--ledger' && typeof argv[1] === 'string' && argv[1].length > 0 && argv[1].length <= 4096 && !argv[1].startsWith('-') && !argv[1].includes('\0'), 'usage_expected_ledger'); process.stdout.write(JSON.stringify(summarizeLedger(loadLedger(argv[1]))) + '\n'); return 0; }
  catch (error) { process.stdout.write(JSON.stringify({ report_version: 1, purpose: 'offline_evidence_validation', error: error instanceof EvidenceError ? error.message : 'evidence_validation_failed' }) + '\n'); return 1; }
}
module.exports = { EvidenceError, digest, validateLedger, summarizeLedger, appendRecord, loadLedger, MAX_BYTES, EVENTS: Object.freeze([...EVENTS]) };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
