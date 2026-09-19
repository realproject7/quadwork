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
function reportShape(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...FIELDS].sort().join(',') && value.schema_version === 1 && typeof value.result_class === 'string' && Number.isInteger(value.provider_turns) && value.provider_turns >= 0 && value.provider_turns <= 1 && typeof value.root_cleanup_ok === 'boolean' && typeof value.survivor_free === 'boolean'; }
function redact(value) { const out = {}; for (const key of FIELDS) out[key] = value[key] === undefined ? null : value[key]; return Object.freeze(out); }
function runFixedWorker(filename) {
  let verified; try { verified = verifyWorker(filename); } catch { return Promise.resolve(Object.freeze({ schema_version: 1, result_class: 'worker_verification_failed', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })); }
  return new Promise(resolve => {
    let settled = false, report = null, admitted = false; const nonce = crypto.randomBytes(32).toString('hex'); let child;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); try { child?.disconnect(); } catch {} resolve(value); };
    const terminate = result => { try { child?.kill('SIGTERM'); } catch {} finish(unknown(result)); };
    const timer = setTimeout(() => terminate('worker_timeout'), MAX_CHILD_MS);
    try { child = fork(verified.file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json', env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', QUADWORK_REVIEWED_EXECUTION_CHILD: '1', QUADWORK_REVIEWED_CANDIDATE_DIGEST: verified.candidate_digest, QUADWORK_REVIEWED_WORKER_DIGEST: verified.worker_digest, QUADWORK_REVIEWED_PARENT_NONCE: nonce } }); }
    catch { finish(Object.freeze({ schema_version: 1, result_class: 'worker_start_failed', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })); return; }
    child.on('message', message => { if (Buffer.byteLength(JSON.stringify(message)) > MAX_IPC_BYTES) return terminate('worker_result_invalid'); if (!admitted && message?.type === 'reviewed_execution_ready' && message.nonce === nonce && message.candidate_digest === verified.candidate_digest && message.worker_digest === verified.worker_digest) { admitted = true; child.send(Object.freeze({ type: 'reviewed_execution_admit', nonce, admission: crypto.randomBytes(32).toString('hex') })); return; } if (admitted && message?.type === 'reviewed_execution_result' && reportShape(message.report)) { report = redact(message.report); return; } terminate('worker_result_invalid'); });
    child.once('error', () => finish(unknown('worker_start_failed')));
    child.once('exit', code => { if (report && code === 0 && report.root_cleanup_ok && report.survivor_free) finish(report); else finish(unknown(report ? 'worker_exit_unverified' : 'worker_exited_without_result')); });
  });
}
function runReviewedCodex() { return runFixedWorker('reviewed-execution-live-worker-codex.cjs'); }
function runReviewedClaude() { return runFixedWorker('reviewed-execution-live-worker-claude.cjs'); }
module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });
