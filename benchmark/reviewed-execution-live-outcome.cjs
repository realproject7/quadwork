'use strict';

// Pure, non-launching outcome evaluator shared by the fixed child and tests.
const profiles = require('../server/reviewed-execution-profiles');
const OUTPUT_CAP_BYTES = 16 * 1024;
const WORKLOAD = `${profiles.WORKLOAD}\n`;
const SENTINEL = 'QUADWORK_V2_PRODUCT_PATH_OK';
function createObserver() { let output = '', output_bytes = 0, output_capped = false; return Object.freeze({ push(chunk) { output_bytes += Buffer.byteLength(chunk); if (output_bytes > OUTPUT_CAP_BYTES) { output_capped = true; return; } output += String(chunk); }, snapshot() { return Object.freeze({ output_bytes, output_capped, sentinel: output.split(/\r?\n/).includes(SENTINEL) }); } }); }
function observe(chunks = []) { const observer = createObserver(); for (const chunk of chunks) observer.push(chunk); return observer.snapshot(); }
function finalize(value = {}) { const provider_turns = value.provider_turns === 0 ? 0 : 1; const lifecycle_verified = value.lifecycle === 'verified'; const root_cleanup_ok = value.stop === true && value.shutdown === true && value.survivor === true && value.root === true && value.git === true && value.environment === true; const result_class = value.launch === false ? 'launch_failed' : !root_cleanup_ok ? 'cleanup_failed' : value.output_capped === true ? 'output_cap_exceeded' : value.timed_out === true ? 'attempt_indeterminate' : value.sentinel === true && lifecycle_verified ? 'completed' : 'attempt_indeterminate'; return Object.freeze({ result_class, provider_turns, lifecycle_verified, root_cleanup_ok, survivor_free: value.survivor === true }); }
module.exports = Object.freeze({ OUTPUT_CAP_BYTES, SENTINEL, WORKLOAD, createObserver, observe, finalize });
