#!/usr/bin/env node
'use strict';

// Public authority is two no-input entries. The parent verifies the exact
// source-fixed worker before fork, admits it once over its private IPC pipe,
// and returns a freshly reconstructed redacted result only after child exit.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const profiles = require('../server/reviewed-execution-profiles');
const outcome = require('./reviewed-execution-live-outcome.cjs');
const MAX_IPC_BYTES = 16 * 1024;
const MAX_CHILD_MS = 60_000;
const RESULT_DRAIN_MS = 100;
const FIELDS = Object.freeze(['schema_version', 'purpose', 'profile_id', 'backend', 'model', 'expected_head', 'candidate_digest', 'gate_receipt_digest', 'result_class', 'provider_turns', 'launch_claim_state', 'failure_stage', 'launch_diagnostic', 'early_exit_diagnostic', 'pre_observer_pty_data_seen', 'pre_workload_output_seen', 'workload_write_attempted', 'workload_submitted_at_launch', 'terminal_exit_phase', 'worker_report_disposition', 'lifecycle_verified', 'sentinel_digest', 'output_bytes', 'output_capped', 'elapsed_ms', 'root_cleanup_ok', 'survivor_free', 'cleanup_attestation', 'source_rechecked_before_prompt', 'gate_rechecked_before_prompt', 'pre_root_facts', 'post_root_facts', 'credential_copy_or_store_api_used', 'keychain_immutability_claimed', 'peer_level_network_filter_available', 'release_evidence']);
const LAUNCH_DIAGNOSTICS = new Set(['none', 'pty_unavailable_after_claim', 'pty_exited_before_observation']);
const RESULTS = new Set(['completed', 'preflight_blocked', 'provider_state_unavailable', 'launch_failed', 'launch_indeterminate', 'attempt_indeterminate', 'output_cap_exceeded', 'cleanup_failed', 'worker_verification_failed', 'worker_start_failed', 'worker_timeout', 'worker_result_invalid', 'worker_exit_unverified', 'worker_cleanup_unverified', 'worker_exited_without_result']);
const CLEANUP_ATTESTATIONS = new Set(['none', 'stop', 'shutdown', 'survivor', 'root', 'environment', 'unverified']);
const PRELAUNCH_RESULTS = new Set(['preflight_blocked', 'provider_state_unavailable', 'launch_failed', 'attempt_indeterminate', 'cleanup_failed']);
// A non-zero worker exit is never a success signal.  These are the only
// post-claim child outcomes whose redacted facts are safe to preserve after
// the ACK/exit race: each is a failure the fixed child can actually produce.
const ATTESTED_CLAIMED_POSTCLAIM_FAILURES = new Set(['launch_indeterminate', 'attempt_indeterminate', 'output_cap_exceeded', 'cleanup_failed']);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
function fixedFailure(profile, result, provider_turns, candidate_digest = null, worker_report_disposition = 'none') { return Object.freeze({ schema_version: 1, purpose: 'reviewed_v2_product_path_live_attempt', profile_id: profile.id, backend: profile.backend, model: profile.model, expected_head: null, candidate_digest, gate_receipt_digest: null, result_class: result, provider_turns, launch_claim_state: provider_turns === 0 ? 'none' : 'unverified', failure_stage: 'parent_unverified', launch_diagnostic: 'none', early_exit_diagnostic: 'none', pre_observer_pty_data_seen: false, pre_workload_output_seen: false, workload_write_attempted: false, workload_submitted_at_launch: false, terminal_exit_phase: 'none', worker_report_disposition, lifecycle_verified: false, sentinel_digest: null, output_bytes: 0, output_capped: false, elapsed_ms: 0, root_cleanup_ok: false, survivor_free: false, cleanup_attestation: 'unverified', source_rechecked_before_prompt: false, gate_rechecked_before_prompt: false, pre_root_facts: null, post_root_facts: null, credential_copy_or_store_api_used: false, keychain_immutability_claimed: false, peer_level_network_filter_available: false, release_evidence: false }); }
function verifyWorker(filename) { const file = path.join(__dirname, filename), stat = fs.lstatSync(file), real = fs.realpathSync(file); if (!stat.isFile() || stat.isSymbolicLink() || !sameUser(stat) || (stat.mode & 0o022) !== 0 || real !== file) throw new Error('reviewed_execution_worker_unsafe'); const candidate_digest = profiles.candidateDigest(), worker_digest = sha256(fs.readFileSync(file)); return Object.freeze({ file, candidate_digest, worker_digest }); }
function factsShape(value) { return value === null || (!!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'changed_entry_count,entry_count,entry_digest,remote_count,root_digest' && /^[a-f0-9]{64}$/.test(value.root_digest) && /^[a-f0-9]{64}$/.test(value.entry_digest) && Number.isSafeInteger(value.entry_count) && value.entry_count >= 0 && value.remote_count === 0 && value.changed_entry_count === 0); }
const optionalHash = value => value === null || /^[a-f0-9]{64}$/.test(value);
function reportShape(value, profile, candidate_digest) {
  const claim = value?.launch_claim_state, stage = value?.failure_stage;
  const zeroTurnPrelaunch = claim === 'none' && value?.provider_turns === 0 && stage === 'prelaunch' && PRELAUNCH_RESULTS.has(value?.result_class);
  const claimedComplete = claim === 'claimed' && value?.provider_turns === 1 && stage === 'none' && value?.result_class === 'completed';
  const claimedPostlaunch = claim === 'claimed' && value?.provider_turns === 1 && stage === 'postclaim' && value?.result_class !== 'completed' && value?.result_class !== 'provider_state_unavailable';
  const unverifiedPostlaunch = claim === 'unverified' && value?.provider_turns === 1 && stage === 'postclaim' && value?.result_class !== 'completed' && value?.result_class !== 'provider_state_unavailable';
  const codexLaunchSubmission = profile?.backend === 'codex' && value?.workload_submitted_at_launch === true && value?.workload_write_attempted === false;
  const claudePtyWrite = profile?.backend === 'claude' && value?.workload_write_attempted === true && value?.workload_submitted_at_launch === false;
  const earlyExit = outcome.EARLY_EXIT_DIAGNOSTICS.includes(value?.early_exit_diagnostic) && value.early_exit_diagnostic !== 'none';
  const earlyExitConsistent = !earlyExit || (value.provider_turns === 1 && stage === 'postclaim' && value.terminal_exit_phase !== 'none' && value.sentinel_digest === null
    && ((value.result_class === 'launch_indeterminate' && value.launch_diagnostic === 'pty_exited_before_observation' && value.output_capped === false) || (value.result_class === 'output_cap_exceeded' && value.output_capped === true)));
  const childFactsConsistent = !(value?.terminal_exit_phase === 'after_workload_attempt' && !claudePtyWrite)
    && !(value?.terminal_exit_phase === 'after_launch_submission' && !codexLaunchSubmission)
    && !(value?.pre_observer_pty_data_seen === true && value?.pre_workload_output_seen !== true)
    && !(value?.provider_turns === 0 && (value?.workload_write_attempted || value?.workload_submitted_at_launch || value?.pre_observer_pty_data_seen || value?.pre_workload_output_seen || value?.terminal_exit_phase !== 'none'))
    && !(value?.result_class === 'completed' && !(codexLaunchSubmission || claudePtyWrite));
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...FIELDS].sort().join(',')
    && value.schema_version === 1 && value.purpose === 'reviewed_v2_product_path_live_attempt'
    && value.profile_id === profile.id && value.backend === profile.backend && value.model === profile.model
    && RESULTS.has(value.result_class) && LAUNCH_DIAGNOSTICS.has(value.launch_diagnostic)
    && value.candidate_digest === candidate_digest && optionalHash(value.gate_receipt_digest) && optionalHash(value.sentinel_digest)
    && Number.isInteger(value.provider_turns) && value.provider_turns >= 0 && value.provider_turns <= 1
    && (zeroTurnPrelaunch || claimedComplete || claimedPostlaunch || unverifiedPostlaunch) && childFactsConsistent && earlyExitConsistent
    && typeof value.pre_observer_pty_data_seen === 'boolean' && typeof value.pre_workload_output_seen === 'boolean'
    && typeof value.workload_write_attempted === 'boolean' && typeof value.workload_submitted_at_launch === 'boolean'
    && ['none', 'before_workload_attempt', 'after_workload_attempt', 'after_launch_submission'].includes(value.terminal_exit_phase)
    && outcome.EARLY_EXIT_DIAGNOSTICS.includes(value.early_exit_diagnostic) && value.worker_report_disposition === 'none' && typeof value.root_cleanup_ok === 'boolean' && typeof value.survivor_free === 'boolean'
    && CLEANUP_ATTESTATIONS.has(value.cleanup_attestation) && value.cleanup_attestation !== 'unverified' && (value.root_cleanup_ok === (value.cleanup_attestation === 'none'))
    && typeof value.lifecycle_verified === 'boolean' && typeof value.output_capped === 'boolean'
    && typeof value.source_rechecked_before_prompt === 'boolean' && typeof value.gate_rechecked_before_prompt === 'boolean'
    && typeof value.credential_copy_or_store_api_used === 'boolean' && typeof value.keychain_immutability_claimed === 'boolean'
    && typeof value.peer_level_network_filter_available === 'boolean' && value.credential_copy_or_store_api_used === false
    && value.keychain_immutability_claimed === false && value.peer_level_network_filter_available === false && value.release_evidence === false
    && Number.isSafeInteger(value.output_bytes) && value.output_bytes >= 0 && Number.isSafeInteger(value.elapsed_ms) && value.elapsed_ms >= 0
    && factsShape(value.pre_root_facts) && factsShape(value.post_root_facts);
}
function redact(value, worker_report_disposition = 'none') { return Object.freeze({ ...value, worker_report_disposition, pre_root_facts: value.pre_root_facts && Object.freeze({ root_digest: value.pre_root_facts.root_digest, entry_digest: value.pre_root_facts.entry_digest, entry_count: value.pre_root_facts.entry_count, remote_count: 0, changed_entry_count: 0 }), post_root_facts: value.post_root_facts && Object.freeze({ root_digest: value.post_root_facts.root_digest, entry_digest: value.post_root_facts.entry_digest, entry_count: value.post_root_facts.entry_count, remote_count: 0, changed_entry_count: 0 }) }); }
function claimedDisposition(report, exited) { if (!report) return 'report_absent'; if (report.launch_claim_state !== 'claimed') return 'none'; const cleanup_attested = report.root_cleanup_ok && report.survivor_free; const exit_attested = exited?.code === 0; if (!cleanup_attested && !exit_attested) return 'claimed_cleanup_and_exit_unattested'; if (!cleanup_attested) return 'claimed_cleanup_unattested'; return exit_attested ? 'none' : 'claimed_exit_unattested'; }
function runFixedWorker(filename) {
  const profile = filename.includes('codex') ? profiles.PROFILES.v2_codex_readonly_v1 : profiles.PROFILES.v2_claude_restricted_v1;
  let verified; try { verified = verifyWorker(filename); } catch { return Promise.resolve(fixedFailure(profile, 'worker_verification_failed', 0)); }
  return new Promise(resolve => {
    let settled = false, report = null, admitted = false, spawned = false, terminating = null, exited = null; const nonce = crypto.randomBytes(32).toString('hex'), channelSecret = crypto.randomBytes(32); let child; let escalation = null, resultDrain = null;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(escalation); clearTimeout(resultDrain); try { child?.disconnect(); } catch {} resolve(value); };
    const concludeExit = () => {
      if (!exited || settled) return;
      if (terminating) return finish(fixedFailure(profile, terminating, 1, verified.candidate_digest, claimedDisposition(report, exited)));
      // A shape-validated child report is already redacted and carries the
      // truthful prelaunch/cleanup facts. Do not replace a valid zero-turn
      // refusal with a parent-made, conservative one-turn fallback merely
      // because cleanup was unsuccessful.
      // The result is authenticated by the one-shot pipe and acknowledged
      // before the worker exits.  A claimed attempt that attests both cleanup
      // and survivor absence remains safe to report even if a later process
      // exit status is non-zero.  Do not, however, promote an unattested child
      // report: expose only the parent-owned, redacted classification.
      const disposition = claimedDisposition(report, exited);
      const attestedClaimedFailureAfterNonzeroExit = report?.launch_claim_state === 'claimed' && report.failure_stage === 'postclaim' && ATTESTED_CLAIMED_POSTCLAIM_FAILURES.has(report.result_class) && report.root_cleanup_ok && report.survivor_free;
      if (report && ((report.provider_turns === 0 && exited.code === 0) || (report.provider_turns === 1 && report.root_cleanup_ok && report.survivor_free && (exited.code === 0 || attestedClaimedFailureAfterNonzeroExit)))) return finish(redact(report, disposition));
      finish(fixedFailure(profile, report ? (report.provider_turns === 1 ? 'worker_cleanup_unverified' : 'worker_exit_unverified') : 'worker_exited_without_result', 1, verified.candidate_digest, disposition));
    };
    const terminate = result => {
      if (settled || terminating) return;
      terminating = result;
      if (exited) return concludeExit();
      try { child?.kill('SIGTERM'); } catch {}
      if (settled) return;
      escalation = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch {}
        // A missing exit event cannot leave the caller pending indefinitely.
        // Sending a signal does not attest provider cleanup or zero turns.
        finish(fixedFailure(profile, terminating, 1, verified.candidate_digest, claimedDisposition(report, exited)));
      }, 2_000);
    };
    const timer = setTimeout(() => terminate('worker_timeout'), MAX_CHILD_MS);
    try { child = fork(verified.file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe'], serialization: 'json', env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', QUADWORK_REVIEWED_EXECUTION_CHILD: '1', QUADWORK_REVIEWED_CANDIDATE_DIGEST: verified.candidate_digest, QUADWORK_REVIEWED_WORKER_DIGEST: verified.worker_digest, QUADWORK_REVIEWED_PARENT_NONCE: nonce } }); }
    catch { finish(fixedFailure(profile, 'worker_start_failed', 0)); return; }
    child.once('spawn', () => { spawned = true; });
    child.on('message', message => { if (settled || terminating) return; if (Buffer.byteLength(JSON.stringify(message)) > MAX_IPC_BYTES) return terminate('worker_result_invalid'); if (!admitted && message?.type === 'reviewed_execution_ready' && message.nonce === nonce && message.candidate_digest === verified.candidate_digest && message.worker_digest === verified.worker_digest && message.proof === crypto.createHmac('sha256', channelSecret).update(nonce).digest('hex')) { admitted = true; const admission = crypto.randomBytes(32).toString('hex'); try { child.send(Object.freeze({ type: 'reviewed_execution_admit', nonce, admission, proof: crypto.createHmac('sha256', channelSecret).update(`${nonce}:${admission}`).digest('hex') })); } catch { terminate('worker_start_failed'); } return; } if (admitted && message?.type === 'reviewed_execution_result') { if (report || !reportShape(message.report, profile, verified.candidate_digest)) return terminate('worker_result_invalid'); report = redact(message.report); try { child.send(Object.freeze({ type: 'reviewed_execution_result_ack', nonce })); } catch {} return; } terminate('worker_result_invalid'); });
    child.on('error', () => {
      if (settled) return;
      // fork() can return a ChildProcess whose spawn later fails. Such a
      // failure has no PID/spawn/admission and need not produce an exit event.
      if (!spawned && child.pid === undefined && !admitted) return finish(fixedFailure(profile, 'worker_start_failed', 0, verified.candidate_digest));
      terminate('worker_start_failed');
    });
    child.once('exit', code => { if (settled) return; exited = Object.freeze({ code }); if (terminating) return concludeExit(); resultDrain = setTimeout(concludeExit, RESULT_DRAIN_MS); });
    child.once('close', () => {
      if (settled || exited) return;
      finish(fixedFailure(profile, terminating || 'worker_exit_unverified', 1, verified.candidate_digest, claimedDisposition(report, null)));
    });
    // A pipe failure after fork returned is not proof that no worker ran.
    try { child.stdio[4].on('error', () => terminate('worker_start_failed')); child.stdio[4].end(channelSecret); }
    catch { terminate('worker_start_failed'); }
  });
}
function runReviewedCodex() { return runFixedWorker('reviewed-execution-live-worker-codex.cjs'); }
function runReviewedClaude() { return runFixedWorker('reviewed-execution-live-worker-claude.cjs'); }
module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });
