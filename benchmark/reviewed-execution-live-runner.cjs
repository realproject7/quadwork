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
const MAX_IPC_BYTES = 16 * 1024;
const MAX_CHILD_MS = 60_000;
const FIELDS = Object.freeze(['schema_version', 'purpose', 'profile_id', 'backend', 'model', 'expected_head', 'candidate_digest', 'gate_receipt_digest', 'result_class', 'provider_turns', 'lifecycle_verified', 'sentinel_digest', 'output_bytes', 'output_capped', 'elapsed_ms', 'root_cleanup_ok', 'survivor_free', 'source_rechecked_before_prompt', 'gate_rechecked_before_prompt', 'pre_root_facts', 'post_root_facts', 'credential_copy_or_store_api_used', 'keychain_immutability_claimed', 'peer_level_network_filter_available', 'release_evidence']);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
function unknown(result) { return Object.freeze({ schema_version: 1, result_class: result, provider_turns: 1, root_cleanup_ok: false, survivor_free: false }); }
function verifyWorker(filename) { const file = path.join(__dirname, filename), stat = fs.lstatSync(file), real = fs.realpathSync(file); if (!stat.isFile() || stat.isSymbolicLink() || !sameUser(stat) || (stat.mode & 0o022) !== 0 || real !== file) throw new Error('reviewed_execution_worker_unsafe'); const candidate_digest = profiles.candidateDigest(), worker_digest = sha256(fs.readFileSync(file)); return Object.freeze({ file, candidate_digest, worker_digest }); }
function factsShape(value) { return value === null || (!!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'changed_entry_count,entry_count,entry_digest,remote_count,root_digest' && /^[a-f0-9]{64}$/.test(value.root_digest) && /^[a-f0-9]{64}$/.test(value.entry_digest) && Number.isSafeInteger(value.entry_count) && value.entry_count >= 0 && value.remote_count === 0 && value.changed_entry_count === 0); }
function reportShape(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...FIELDS].sort().join(',') && value.schema_version === 1 && value.purpose === 'reviewed_v2_product_path_live_attempt' && typeof value.result_class === 'string' && Number.isInteger(value.provider_turns) && value.provider_turns >= 0 && value.provider_turns <= 1 && typeof value.root_cleanup_ok === 'boolean' && typeof value.survivor_free === 'boolean' && typeof value.lifecycle_verified === 'boolean' && typeof value.output_capped === 'boolean' && Number.isSafeInteger(value.output_bytes) && value.output_bytes >= 0 && Number.isSafeInteger(value.elapsed_ms) && value.elapsed_ms >= 0 && factsShape(value.pre_root_facts) && factsShape(value.post_root_facts); }
function redact(value) { const out = {}; for (const key of FIELDS) { if (key === 'pre_root_facts' || key === 'post_root_facts') out[key] = value[key] && Object.freeze({ root_digest: value[key].root_digest, entry_digest: value[key].entry_digest, entry_count: value[key].entry_count, remote_count: 0, changed_entry_count: 0 }); else out[key] = value[key] === undefined ? null : value[key]; } return Object.freeze(out); }
function runFixedWorker(filename) {
  let verified; try { verified = verifyWorker(filename); } catch { return Promise.resolve(Object.freeze({ schema_version: 1, result_class: 'worker_verification_failed', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })); }
  return new Promise(resolve => {
    let settled = false, report = null, admitted = false, terminating = null; const nonce = crypto.randomBytes(32).toString('hex'), channelSecret = crypto.randomBytes(32); let child; let escalation = null;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(escalation); try { child?.disconnect(); } catch {} resolve(value); };
    const terminate = result => { if (terminating) return; terminating = result; try { child?.kill('SIGTERM'); } catch {} escalation = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 2_000); };
    const timer = setTimeout(() => terminate('worker_timeout'), MAX_CHILD_MS);
    try { child = fork(verified.file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe'], serialization: 'json', env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', QUADWORK_REVIEWED_EXECUTION_CHILD: '1', QUADWORK_REVIEWED_CANDIDATE_DIGEST: verified.candidate_digest, QUADWORK_REVIEWED_WORKER_DIGEST: verified.worker_digest, QUADWORK_REVIEWED_PARENT_NONCE: nonce } }); child.stdio[4].end(channelSecret); }
    catch { finish(Object.freeze({ schema_version: 1, result_class: 'worker_start_failed', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })); return; }
    child.on('message', message => { if (Buffer.byteLength(JSON.stringify(message)) > MAX_IPC_BYTES) return terminate('worker_result_invalid'); if (!admitted && message?.type === 'reviewed_execution_ready' && message.nonce === nonce && message.candidate_digest === verified.candidate_digest && message.worker_digest === verified.worker_digest && message.proof === crypto.createHmac('sha256', channelSecret).update(nonce).digest('hex')) { admitted = true; const admission = crypto.randomBytes(32).toString('hex'); child.send(Object.freeze({ type: 'reviewed_execution_admit', nonce, admission, proof: crypto.createHmac('sha256', channelSecret).update(`${nonce}:${admission}`).digest('hex') })); return; } if (admitted && message?.type === 'reviewed_execution_result' && reportShape(message.report)) { report = redact(message.report); return; } terminate('worker_result_invalid'); });
    child.once('error', () => { if (child) terminate('worker_start_failed'); else finish(unknown('worker_start_failed')); });
    child.once('exit', code => { if (terminating) return finish(unknown(terminating)); if (report && code === 0 && report.root_cleanup_ok && report.survivor_free) finish(report); else finish(unknown(report ? 'worker_exit_unverified' : 'worker_exited_without_result')); });
  });
}
function runReviewedCodex() { return runFixedWorker('reviewed-execution-live-worker-codex.cjs'); }
function runReviewedClaude() { return runFixedWorker('reviewed-execution-live-worker-claude.cjs'); }
module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });
