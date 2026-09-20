'use strict';

// Pure, non-launching outcome evaluator shared by the fixed child and tests.
const profiles = require('../server/reviewed-execution-profiles');
const OUTPUT_CAP_BYTES = 16 * 1024;
const WORKLOAD = `${profiles.WORKLOAD}\n`;
const SENTINEL = 'QUADWORK_V2_PRODUCT_PATH_OK';
function createObserver() {
  let output_bytes = 0, output_capped = false, sentinel = false, at_line_start = true, match_index = 0, sentinel_cr = false;
  const resetLine = () => { at_line_start = true; match_index = 0; sentinel_cr = false; };
  const observeCharacter = character => {
    if (character === '\n') {
      if (match_index === SENTINEL.length || sentinel_cr) sentinel = true;
      resetLine();
      return;
    }
    if (sentinel_cr) { match_index = -1; sentinel_cr = false; }
    if (match_index === SENTINEL.length) { if (character === '\r') { sentinel_cr = true; return; } match_index = -1; return; }
    if (at_line_start) { at_line_start = false; match_index = character === SENTINEL[0] ? 1 : -1; return; }
    if (match_index >= 0 && match_index < SENTINEL.length) match_index = character === SENTINEL[match_index] ? match_index + 1 : -1;
  };
  return Object.freeze({ push(chunk) { output_bytes += Buffer.byteLength(chunk); if (output_bytes > OUTPUT_CAP_BYTES) { output_capped = true; return; } for (const character of String(chunk)) observeCharacter(character); }, snapshot() { return Object.freeze({ output_bytes, output_capped, sentinel: sentinel || match_index === SENTINEL.length }); } });
}
function observe(chunks = []) { const observer = createObserver(); for (const chunk of chunks) observer.push(chunk); return observer.snapshot(); }
function finalize(value = {}) { const provider_turns = value.provider_turns === 0 ? 0 : 1; const lifecycle_verified = value.lifecycle === 'verified'; const root_cleanup_ok = value.stop === true && value.shutdown === true && value.survivor === true && value.root === true && value.git === true && value.environment === true; const result_class = value.launch === false ? 'launch_failed' : !root_cleanup_ok ? 'cleanup_failed' : value.output_capped === true ? 'output_cap_exceeded' : value.terminal_exited === true ? 'launch_indeterminate' : value.timed_out === true ? 'attempt_indeterminate' : value.sentinel === true && lifecycle_verified ? 'completed' : 'attempt_indeterminate'; return Object.freeze({ result_class, provider_turns, lifecycle_verified, root_cleanup_ok, survivor_free: value.survivor === true }); }
function finalizeEffects(value = {}) { const effect = name => { try { return value.effects?.[name]?.() === true; } catch { return false; } }; return finalize({ provider_turns: value.provider_turns, lifecycle: value.lifecycle, launch: value.launch, sentinel: value.sentinel, output_capped: value.output_capped, terminal_exited: value.terminal_exited, timed_out: value.timed_out, stop: effect('stop'), shutdown: effect('shutdown'), survivor: effect('survivor'), root: effect('root'), git: effect('git'), environment: effect('environment') }); }
module.exports = Object.freeze({ OUTPUT_CAP_BYTES, SENTINEL, WORKLOAD, createObserver, observe, finalize, finalizeEffects });
