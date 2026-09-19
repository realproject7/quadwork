#!/usr/bin/env node
'use strict';

// #1113 is fake-only. This worker deliberately stops after source, root, and
// binary integrity validation. It neither authenticates a provider nor loads
// the V2 server, opens HTTP/WS, creates a PTY, or sends a workload.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('./v2-product-path-core.cjs');
const reviewed = require('./live-provider-reviewed-contracts.cjs');

const adapter = core.ADAPTERS[process.argv[2]];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const mode = stat => stat.mode & 0o777;
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();

function safeDirectory(directory, parent, code) {
  let stat, real, parentReal; try { stat = fs.lstatSync(directory); real = fs.realpathSync(directory); parentReal = fs.realpathSync(parent); } catch { throw new Error(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o700 || !sameUser(stat) || path.dirname(real) !== parentReal) throw new Error(code);
  return real;
}
function workerAuthorization(root) {
  let rootStat, entries, marker, authority, message;
  try { rootStat = fs.lstatSync(root); entries = fs.readdirSync(root).sort(); marker = fs.lstatSync(path.join(root, core.ROOT_MARKER)); authority = fs.lstatSync(path.join(root, '.worker-authority')); message = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { throw new Error('product_path_worker_authorization'); }
  const expected = ['.worker-authority', core.ROOT_MARKER, 'evidence', 'home', 'repository'].sort();
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || mode(rootStat) !== 0o700 || !sameUser(rootStat) || JSON.stringify(entries) !== JSON.stringify(expected) || !marker.isFile() || marker.isSymbolicLink() || mode(marker) !== 0o600 || fs.readFileSync(path.join(root, core.ROOT_MARKER), 'utf8') !== 'quadwork-v2-product-path-v1\n' || !authority.isFile() || authority.isSymbolicLink() || mode(authority) !== 0o600 || !message || Object.keys(message).sort().join(',') !== 'nonce,source_digest' || typeof message.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(message.nonce) || typeof message.source_digest !== 'string' || !/^[a-f0-9]{64}$/.test(message.source_digest) || fs.readFileSync(path.join(root, '.worker-authority'), 'utf8') !== `${digest(message.nonce)}\n`) throw new Error('product_path_worker_authorization');
  return Object.freeze({ source_digest: message.source_digest });
}
function validateExecutable() {
  const contract = reviewed[adapter.id]; let stat, real, bytes;
  try { stat = fs.lstatSync(adapter.command); real = fs.realpathSync(adapter.command); bytes = fs.readFileSync(real); } catch { throw new Error('product_path_executable_unreviewed'); }
  if (!contract || adapter.command !== contract.resolved_path || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 || real !== contract.resolved_path || digest(bytes) !== contract.executable_digest) throw new Error('product_path_executable_unreviewed');
}
function rootFacts(root) {
  const repository = safeDirectory(path.join(root, 'repository'), root, 'product_path_repository_unsafe');
  const run = args => execFileSync('/usr/bin/git', ['-c', 'credential.helper=', ...args], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 3_000, env: { HOME: os.devNull, PATH: process.env.PATH || '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' } });
  if (run(['remote']).trim() !== '' || run(['status', '--porcelain=v1']).trim() !== '') throw new Error('product_path_repository_changed');
  return Object.freeze({ root_digest: digest(root), remote_count: 0, changed_entry_count: 0 });
}
function main() {
  if (!adapter) throw new Error('product_path_worker_shape'); const root = path.dirname(process.env.HOME || ''), authorization = workerAuthorization(root);
  safeDirectory(process.env.HOME, root, 'product_path_home_unsafe'); validateExecutable();
  if (digest(fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'))) !== authorization.source_digest) throw new Error('product_path_source_changed');
  const facts = rootFacts(root);
  return { result_class: 'preflight_blocked', lifecycle_state: 'unverified', pre_root_facts: facts, post_root_facts: facts, external_process_started: false, cleanup_ok: true, elapsed_ms: 0 };
}
try { process.stdout.write(`PRODUCT_PATH_RESULT ${JSON.stringify(main())}\n`); process.exit(0); } catch { process.stdout.write('PRODUCT_PATH_RESULT {"result_class":"worker_failed","cleanup_ok":false}\n'); process.exit(1); }
