'use strict';

// Read-only verification for the externally PO-authored #1117 gate. There is
// intentionally no creation, reset, or authorization-mint API here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const profiles = require('./reviewed-execution-profiles');
const { LEDGER_NAME, authorizationKey } = require('../benchmark/reviewed-execution-contract.cjs');
const GATE_PARENT = path.join(os.homedir(), 'Library', 'Application Support', 'QuadWork', 'reviewed-execution-gates');
const LEDGER_PARENT = path.join(os.homedir(), 'Library', 'Application Support', 'QuadWork', 'reviewed-execution-ledger-parent');
const MAX_GATE_AGE_MS = 15 * 60 * 1000;
const mode = stat => stat.mode & 0o777;
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const head = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function directory(value, code) { const stat = fs.lstatSync(value); if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o700 || !sameUser(stat)) throw new Error(code); return fs.realpathSync(value); }
function git(args) { return execFileSync('/usr/bin/git', ['-c', 'credential.helper=', ...args], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', PATH: process.env.PATH || '' } }).trim(); }
function assertReviewedExecutionGate(profile, binding) {
  const candidate = profiles.candidateDigest(), current = git(['rev-parse', 'HEAD']);
  if (!head(current) || git(['status', '--porcelain=v1']) !== '') throw new Error('reviewed_execution_gate_source_drift');
  const parent = directory(GATE_PARENT, 'reviewed_execution_gate_parent_unsafe'); const filename = path.join(parent, `${profile.id}-${candidate}.json`);
  let stat, receipt; try { stat = fs.lstatSync(filename); receipt = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('reviewed_execution_gate_missing'); }
  const exact = Object.keys(receipt || {}).sort().join(',') === 'actions,artifacts,authorization_id,cache,candidate_digest,expected_head,profile_id,recorded_at,reviewed_candidate_digest,reviewed_head,schema_version';
  const at = Date.parse(receipt?.recorded_at);
  if (!stat.isFile() || stat.isSymbolicLink() || mode(stat) !== 0o600 || !sameUser(stat) || !exact || receipt.schema_version !== 1 || receipt.reviewed_head !== current || receipt.expected_head !== current || receipt.reviewed_candidate_digest !== candidate || receipt.candidate_digest !== candidate || receipt.profile_id !== profile.id || !/^[a-z0-9-]{16,128}$/.test(receipt.authorization_id) || !Number.isSafeInteger(at) || at > Date.now() || Date.now() - at > MAX_GATE_AGE_MS || receipt.actions?.enabled !== false || receipt.cache?.active_size_bytes !== 0 || receipt.artifacts?.nonexpired_size_bytes !== 0) throw new Error('reviewed_execution_gate_drift');
  const ledger = directory(path.join(LEDGER_PARENT, LEDGER_NAME), 'reviewed_execution_gate_ledger_unsafe'); const key = authorizationKey(candidate, profile.id, receipt.authorization_id);
  if (binding?.authorization_key !== key || binding?.ledger_directory !== ledger) throw new Error('reviewed_execution_gate_binding_drift');
  const auth = path.join(ledger, `${key}.json`); let authStat, body; try { authStat = fs.lstatSync(auth); body = JSON.parse(fs.readFileSync(auth, 'utf8')); } catch { throw new Error('reviewed_execution_gate_authorization_missing'); }
  if (!authStat.isFile() || authStat.isSymbolicLink() || mode(authStat) !== 0o600 || !sameUser(authStat) || body?.candidate_digest !== candidate || body?.profile_id !== profile.id || body?.authorization_id !== receipt.authorization_id || body?.authorization_key !== key) throw new Error('reviewed_execution_gate_authorization_invalid');
}
module.exports = Object.freeze({ assertReviewedExecutionGate });
