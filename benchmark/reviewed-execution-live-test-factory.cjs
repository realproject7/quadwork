'use strict';

// Test-only fake executor. It is never imported by production candidate files.
// Its deliberately small PTY model exercises the same fixed workload/result
// invariants without a provider, credential, subprocess, or runtime DI seam.
const WORKLOAD = 'Reply with exactly: QUADWORK_V2_PRODUCT_PATH_OK\n';
const SENTINEL = 'QUADWORK_V2_PRODUCT_PATH_OK';
const MAX = 16 * 1024;
async function attempt(options = {}) {
  const listeners = []; let output = '', bytes = 0, capped = false, wrote = '';
  const term = { onData(listener) { listeners.push(listener); }, write(value) { wrote = value; for (const chunk of options.chunks || []) for (const listener of listeners) listener(chunk); } };
  const session = options.launch === false ? null : { onData: term.onData.bind(term), writeFixedWorkload: () => term.write(WORKLOAD) };
  let turns = 0; if (!session) return { result_class: 'launch_failed', provider_turns: 1, wrote };
  session.onData(chunk => { bytes += Buffer.byteLength(chunk); if (bytes > MAX) capped = true; else output += String(chunk); });
  turns = 1; session.writeFixedWorkload(); const sentinel = output.split(/\r?\n/).includes(SENTINEL); const lifecycle = options.lifecycle === undefined ? 'verified' : options.lifecycle;
  const stopped = options.stop !== false, shutdown = options.shutdown !== false, survivor = options.survivor !== false, root = options.root !== false, git = options.git !== false, restored = options.restored !== false;
  const cleanup = stopped && shutdown && survivor && root && git && restored;
  const result_class = !cleanup ? 'cleanup_failed' : capped ? 'output_cap_exceeded' : options.timeout ? 'attempt_indeterminate' : sentinel && lifecycle === 'verified' ? 'completed' : 'attempt_indeterminate';
  return { result_class, provider_turns: turns, wrote, output_bytes: bytes, output_capped: capped, lifecycle_verified: lifecycle === 'verified', sentinel, root_cleanup_ok: cleanup, survivor_free: survivor, environment_restored: restored };
}
module.exports = Object.freeze({ attempt, MAX, SENTINEL, WORKLOAD });
