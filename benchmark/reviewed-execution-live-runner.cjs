#!/usr/bin/env node
'use strict';

// #1117 public authority: exactly two no-input functions. The parent has no
// server import, PTY, prompt, config, or launch callback. It can only start a
// source-fixed child and accept one bounded, redacted IPC report.
const path = require('node:path');
const { fork } = require('node:child_process');
const MAX_IPC_BYTES = 16 * 1024;
const MAX_CHILD_MS = 60_000;
function reportShape(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && value.schema_version === 1 && typeof value.result_class === 'string' && Number.isInteger(value.provider_turns) && value.provider_turns >= 0 && value.provider_turns <= 1 && typeof value.root_cleanup_ok === 'boolean' && typeof value.survivor_free === 'boolean'; }
function runFixedWorker(filename, dependencies = {}) {
  const start = dependencies.fork || fork;
  return new Promise((resolve) => {
    let settled = false; let child;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); try { child?.disconnect(); } catch {} resolve(value); };
    const timer = setTimeout(() => { try { child?.kill('SIGTERM'); } catch {} finish(Object.freeze({ schema_version: 1, result_class: 'worker_timeout', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })); }, MAX_CHILD_MS);
    try { child = start(path.join(__dirname, filename), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json', env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', QUADWORK_REVIEWED_EXECUTION_CHILD: '1' } }); }
    catch { finish(Object.freeze({ schema_version: 1, result_class: 'worker_start_failed', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })); return; }
    child.once('message', message => { const bytes = Buffer.byteLength(JSON.stringify(message)); if (bytes > MAX_IPC_BYTES || message?.type !== 'reviewed_execution_result' || !reportShape(message.report)) return finish(Object.freeze({ schema_version: 1, result_class: 'worker_result_invalid', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })); finish(Object.freeze(message.report)); });
    child.once('error', () => finish(Object.freeze({ schema_version: 1, result_class: 'worker_start_failed', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })));
    child.once('exit', () => finish(Object.freeze({ schema_version: 1, result_class: 'worker_exited_without_result', provider_turns: 0, root_cleanup_ok: false, survivor_free: false })));
  });
}
function runReviewedCodex() { return runFixedWorker('reviewed-execution-live-worker-codex.cjs'); }
function runReviewedClaude() { return runFixedWorker('reviewed-execution-live-worker-claude.cjs'); }
module.exports = Object.freeze({ runReviewedCodex, runReviewedClaude });
