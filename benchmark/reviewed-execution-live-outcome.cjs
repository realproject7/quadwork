'use strict';

// Pure, non-launching outcome evaluator shared by the fixed child and tests.
const profiles = require('../server/reviewed-execution-profiles');
const OUTPUT_CAP_BYTES = 16 * 1024;
const WORKLOAD = `${profiles.WORKLOAD}\n`;
const SENTINEL = 'QUADWORK_V2_PRODUCT_PATH_OK';
const CLEANUP_ATTESTATIONS = Object.freeze(['none', 'stop', 'shutdown', 'survivor', 'root', 'environment', 'unverified']);
const EARLY_EXIT_DIAGNOSTICS = Object.freeze(['none', 'provider_auth_unavailable', 'sandbox_policy_denied', 'provider_command_unavailable', 'unclassified_early_exit']);
// These exact, complete messages are deliberately narrow and source-owned.
// The recognizer never retains a chunk, line, substring, digest, or path; it
// keeps only candidate-state integers and emits a closed category on exit.
const EARLY_EXIT_SIGNATURES = Object.freeze([
  Object.freeze({ backends: Object.freeze(['codex', 'claude']), diagnostic: 'provider_auth_unavailable', text: 'Authentication required' }),
  Object.freeze({ backends: Object.freeze(['codex', 'claude']), diagnostic: 'provider_auth_unavailable', text: 'Not logged in' }),
  Object.freeze({ backends: Object.freeze(['codex', 'claude']), diagnostic: 'sandbox_policy_denied', text: 'sandbox-exec: sandbox_apply: Operation not permitted' }),
  Object.freeze({ backends: Object.freeze(['codex', 'claude']), diagnostic: 'provider_command_unavailable', text: 'command not found' }),
]);

function createEarlyExitRecognizer(backend) {
  const candidates = EARLY_EXIT_SIGNATURES.filter(item => item.backends.includes(backend)).map(item => Object.freeze({ item, index: 0 }));
  let active = candidates, matched = null, invalid = candidates.length === 0, trailing_cr = false, line_ended = false, finished = false;
  return Object.freeze({
    push(character) {
      if (invalid) return;
      if (finished) {
        if (trailing_cr && character === '\n') { trailing_cr = false; line_ended = true; return; }
        invalid = true; return;
      }
      const next = [];
      for (const candidate of active) {
        if (candidate.item.text[candidate.index] !== character) continue;
        const index = candidate.index + 1;
        if (index === candidate.item.text.length) {
          if (matched && matched !== candidate.item.diagnostic) { invalid = true; return; }
          matched = candidate.item.diagnostic; finished = true;
        } else next.push(Object.freeze({ item: candidate.item, index }));
      }
      active = next;
      if (!finished && active.length === 0) invalid = true;
    },
    endLine(character) {
      if (invalid) return;
      if (!finished) { invalid = true; return; }
      if (trailing_cr) { if (character === '\n') { trailing_cr = false; line_ended = true; return; } invalid = true; return; }
      if (line_ended) { invalid = true; return; }
      if (character === '\r' && !trailing_cr) { trailing_cr = true; return; }
      if (character === '\n' && !trailing_cr) { line_ended = true; return; }
      invalid = true;
    },
    snapshot() { return !invalid && matched && !trailing_cr ? matched : 'unclassified_early_exit'; },
  });
}

function earlyExitDiagnostic(snapshot) {
  if (!snapshot || snapshot.output_capped === true || !EARLY_EXIT_DIAGNOSTICS.includes(snapshot.early_exit_match) || snapshot.early_exit_match === 'none') return 'unclassified_early_exit';
  return snapshot.early_exit_match;
}

function createObserver(backend) {
  let output_bytes = 0, output_capped = false, sentinel = false, at_line_start = true, match_index = 0, sentinel_cr = false;
  const early = createEarlyExitRecognizer(backend);
  const resetLine = () => { at_line_start = true; match_index = 0; sentinel_cr = false; };
  const observeCharacter = character => {
    if (character === '\n' || character === '\r') early.endLine(character); else early.push(character);
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
  return Object.freeze({ push(chunk) { output_bytes += Buffer.byteLength(chunk); if (output_bytes > OUTPUT_CAP_BYTES) { output_capped = true; return; } for (const character of String(chunk)) observeCharacter(character); }, snapshot() { return Object.freeze({ output_bytes, output_capped, sentinel: sentinel || match_index === SENTINEL.length, early_exit_match: output_capped ? 'unclassified_early_exit' : early.snapshot() }); } });
}
function observe(chunks = []) { const observer = createObserver(); for (const chunk of chunks) observer.push(chunk); return observer.snapshot(); }
// This is deliberately a category, not a detail channel: it records only the
// first failed pre-existing cleanup attestation. `root` includes the existing
// root-facts/git postcondition, whose digests stay in their existing redacted
// fields. It never includes an error, path, exit status, or provider output.
function cleanupAttestation(value = {}) {
  if (value.stop !== true) return 'stop';
  if (value.shutdown !== true) return 'shutdown';
  if (value.survivor !== true) return 'survivor';
  if (value.root !== true || value.git !== true) return 'root';
  if (value.environment !== true) return 'environment';
  return 'none';
}
function finalize(value = {}) { const provider_turns = value.provider_turns === 0 ? 0 : 1; const lifecycle_verified = value.lifecycle === 'verified'; const cleanup_attestation = cleanupAttestation(value); const root_cleanup_ok = cleanup_attestation === 'none'; const result_class = value.launch === false ? 'launch_failed' : !root_cleanup_ok ? 'cleanup_failed' : value.output_capped === true ? 'output_cap_exceeded' : value.terminal_exited === true ? 'launch_indeterminate' : value.timed_out === true ? 'attempt_indeterminate' : value.sentinel === true && lifecycle_verified ? 'completed' : 'attempt_indeterminate'; return Object.freeze({ result_class, provider_turns, lifecycle_verified, root_cleanup_ok, survivor_free: value.survivor === true, cleanup_attestation }); }
function finalizeEffects(value = {}) { const effect = name => { try { return value.effects?.[name]?.() === true; } catch { return false; } }; return finalize({ provider_turns: value.provider_turns, lifecycle: value.lifecycle, launch: value.launch, sentinel: value.sentinel, output_capped: value.output_capped, terminal_exited: value.terminal_exited, timed_out: value.timed_out, stop: effect('stop'), shutdown: effect('shutdown'), survivor: effect('survivor'), root: effect('root'), git: effect('git'), environment: effect('environment') }); }
module.exports = Object.freeze({ OUTPUT_CAP_BYTES, SENTINEL, WORKLOAD, CLEANUP_ATTESTATIONS, EARLY_EXIT_DIAGNOSTICS, EARLY_EXIT_SIGNATURES, createObserver, earlyExitDiagnostic, observe, cleanupAttestation, finalize, finalizeEffects });
