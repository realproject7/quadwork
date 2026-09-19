'use strict';

// The benchmark runner is the only consumer of these two fixed no-input
// entries. Server initialization supplies the closure-private implementation;
// this module never mints a permit or accepts a command, config, prompt, or PTY.
let codex = null;
let claude = null;
function installFixedRunnerEntries(entries) {
  if (codex || claude || !entries || typeof entries.codex !== 'function' || typeof entries.claude !== 'function') throw new Error('reviewed_execution_bridge_init');
  codex = entries.codex; claude = entries.claude;
}
function runReviewedCodex() { if (!codex) throw new Error('reviewed_execution_bridge_unavailable'); return codex(); }
function runReviewedClaude() { if (!claude) throw new Error('reviewed_execution_bridge_unavailable'); return claude(); }
module.exports = Object.freeze({ installFixedRunnerEntries, runReviewedCodex, runReviewedClaude });
