#!/usr/bin/env node
'use strict';

// #1113. The preparation executor intentionally cannot launch a provider.
// This is a separate, local-only product-path boundary: it creates the only
// QuadWork HOME/config used by the child process and asks the real server to
// admit exactly one static Codex or Claude role. It has no caller supplied
// command, model, argv, pty, lifecycle, or config seam.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const REVIEWED = require('./live-provider-reviewed-contracts.cjs');

const ROOT_MARKER = '.quadwork-v2-product-path-root-v1';
const EVIDENCE_MARKER = '.quadwork-v2-product-path-evidence-v1';
const MARKER_BODY = 'quadwork-v2-product-path-v1\n';
const SHA256 = /^[a-f0-9]{64}$/;
const OWNED_ROOTS = new Set();
const OWNED_EVIDENCE = new Set();
const CAPS = Object.freeze({ max_elapsed_ms: 45_000, max_output_bytes: 16 * 1024, max_provider_turns: 1 });
const WORKLOAD = 'Return exactly QUADWORK_PRODUCT_PATH_OK. Do not use tools. Do not read, write, or change files.';

const ADAPTERS = Object.freeze({
  // The config uses the reviewed resolved executable, never an updatable
  // wrapper/symlink. command_identity preserves V2's known CLI argument
  // grammar when a versioned executable has no provider-shaped basename.
  codex: Object.freeze({ id: 'codex', role: 'benchmark_codex', model_id: 'gpt-5.6-luna', command: REVIEWED.codex.resolved_path, command_identity: 'codex' }),
  claude: Object.freeze({ id: 'claude', role: 'benchmark_claude', model_id: 'claude-sonnet-4-6', command: REVIEWED.claude.resolved_path, command_identity: 'claude' }),
});

class ProductPathError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new ProductPathError(code); };
const required = (condition, code) => { if (!condition) fail(code); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const mode = stat => stat.mode & 0o777;
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
function exact(value, keys, code) {
  required(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  required(actual.length === expected.length && actual.every((key, index) => key === expected[index]), code);
}
function safePath(value) { return typeof value === 'string' && path.isAbsolute(value) && value.length > 0 && value.length <= 1024 && !/[\u0000\r\n]/.test(value); }
function checkedRoot(directory, marker, allowed, code) {
  required(safePath(directory), code);
  let stat, root, entries, markerStat;
  try { stat = fs.lstatSync(directory); root = fs.realpathSync(directory); entries = fs.readdirSync(root); markerStat = fs.lstatSync(path.join(root, marker)); } catch { fail(code); }
  required(stat.isDirectory() && !stat.isSymbolicLink() && mode(stat) === 0o700 && sameUser(stat), code);
  required(entries.every(entry => allowed.has(entry)) && entries.includes(marker), code);
  required(markerStat.isFile() && !markerStat.isSymbolicLink() && mode(markerStat) === 0o600 && sameUser(markerStat), code);
  let body; try { body = fs.readFileSync(path.join(root, marker), 'utf8'); } catch { fail(code); }
  required(body === MARKER_BODY, code);
  return root;
}
function git(root, args) {
  try { return execFileSync('/usr/bin/git', ['-c', 'credential.helper=', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 3000, env: { HOME: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', PATH: process.env.PATH || '' } }); }
  catch { fail('product_path_git_unavailable'); }
}
function repositoryFacts(root) {
  required(OWNED_ROOTS.has(root), 'product_path_root_not_owned'); const repository = path.join(root, 'repository');
  let stat; try { stat = fs.lstatSync(repository); } catch { fail('product_path_repository_unsafe'); }
  required(stat.isDirectory() && !stat.isSymbolicLink() && mode(stat) === 0o700 && sameUser(stat), 'product_path_repository_unsafe');
  required(git(repository, ['remote']).trim() === '', 'product_path_remote_present');
  required(git(repository, ['status', '--porcelain=v1']).trim() === '', 'product_path_repository_dirty');
  return Object.freeze({ remote_count: 0, changed_entry_count: 0 });
}
function createRoot(value = {}) {
  exact(value, ['parent_dir'], 'product_path_root_create'); required(safePath(value.parent_dir), 'product_path_root_create');
  let parent, parentStat; try { parent = fs.realpathSync(value.parent_dir); parentStat = fs.lstatSync(parent); } catch { fail('product_path_root_create'); }
  required(parentStat.isDirectory() && !parentStat.isSymbolicLink(), 'product_path_root_create');
  const root = fs.mkdtempSync(path.join(parent, 'quadwork-v2-product-path-')); fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, ROOT_MARKER), MARKER_BODY, { mode: 0o600, flag: 'wx' }); fs.chmodSync(path.join(root, ROOT_MARKER), 0o600);
  for (const entry of ['home', 'repository', 'evidence']) { fs.mkdirSync(path.join(root, entry), { mode: 0o700 }); fs.chmodSync(path.join(root, entry), 0o700); }
  git(path.join(root, 'repository'), ['init', '--quiet']);
  const checked = checkedRoot(root, ROOT_MARKER, new Set([ROOT_MARKER, 'home', 'repository', 'evidence']), 'product_path_root_create'); OWNED_ROOTS.add(checked); return checked;
}
function workerAuthorization(root) {
  required(OWNED_ROOTS.has(root), 'product_path_root_not_owned'); const nonce = crypto.randomBytes(32).toString('hex'), filename = path.join(root, '.worker-authority');
  fs.writeFileSync(filename, `${digest(nonce)}\n`, { mode: 0o600, flag: 'wx' }); fs.chmodSync(filename, 0o600); return Object.freeze({ nonce, digest: digest(nonce) });
}
function createEvidence(root) {
  required(OWNED_ROOTS.has(root), 'product_path_root_not_owned'); const evidence = path.join(root, 'evidence');
  fs.writeFileSync(path.join(evidence, EVIDENCE_MARKER), MARKER_BODY, { mode: 0o600, flag: 'wx' }); fs.chmodSync(path.join(evidence, EVIDENCE_MARKER), 0o600);
  const checked = checkedRoot(evidence, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER]), 'product_path_evidence_create'); OWNED_EVIDENCE.add(checked); return checked;
}
function executable(adapter) {
  const reviewed = REVIEWED[adapter.id]; required(reviewed && reviewed.resolved_path === adapter.command, 'product_path_adapter_unreviewed');
  let listed, resolved, target, bytes; try { listed = fs.lstatSync(adapter.command); resolved = fs.realpathSync(adapter.command); target = fs.statSync(resolved); bytes = fs.readFileSync(resolved); } catch { fail('product_path_executable_unavailable'); }
  required(listed.isFile() && !listed.isSymbolicLink() && target.isFile() && (target.mode & 0o111) !== 0 && resolved === reviewed.resolved_path && digest(bytes) === reviewed.executable_digest, 'product_path_executable_unreviewed');
  return Object.freeze({ path: resolved, digest: reviewed.executable_digest, version_digest: reviewed.version_digest });
}
function configFor(adapter, root, port) {
  required(ADAPTERS[adapter.id] === adapter && Number.isSafeInteger(port) && port > 0 && port < 65536, 'product_path_config_invalid');
  const repository = path.join(root, 'repository');
  return Object.freeze({
    port,
    installation_id: 'benchmark_product_path_0001',
    session_token: crypto.randomBytes(32).toString('hex'),
    temp_cleanup: { enabled: false },
    projects: [{ id: 'benchmark-product-path', name: 'Benchmark product path', idle: true, chat_mode: 'file', repositories: [{ key: 'benchmark', repo: 'local/benchmark', working_dir: repository, primary: true }], agents: { [adapter.role]: { cwd: repository, command: adapter.command, command_identity: adapter.command_identity, model: adapter.model_id, auto_approve: false, mcp_inject: 'none' } } }],
  });
}
function safeChild(parent, child, code) {
  let parentPath, parentStat, childStat, real;
  try { parentPath = fs.realpathSync(parent); parentStat = fs.lstatSync(parentPath); childStat = fs.lstatSync(child); real = fs.realpathSync(child); } catch { fail(code); }
  required(parentStat.isDirectory() && !parentStat.isSymbolicLink() && childStat.isDirectory() && !childStat.isSymbolicLink() && path.dirname(real) === parentPath && mode(childStat) === 0o700 && sameUser(childStat), code);
  return real;
}
function writeConfig(root, config) {
  required(OWNED_ROOTS.has(root), 'product_path_root_not_owned'); checkedRoot(root, ROOT_MARKER, new Set([ROOT_MARKER, 'home', 'repository', 'evidence', '.worker-authority']), 'product_path_root_unsafe'); const home = safeChild(root, path.join(root, 'home'), 'product_path_home_unsafe'), directory = path.join(home, '.quadwork'), filename = path.join(directory, 'config.json');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); safeChild(home, directory, 'product_path_config_directory_unsafe'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600, flag: 'wx' }); const stat = fs.lstatSync(filename); required(stat.isFile() && !stat.isSymbolicLink() && mode(stat) === 0o600 && sameUser(stat), 'product_path_config_unsafe');
  return Object.freeze({ home, config: filename });
}
function safeEnvironment(home) {
  required(safePath(home), 'product_path_environment');
  const out = { HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', LANG: 'C', LC_ALL: 'C', TERM: 'xterm-256color', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' };
  // Deliberately omit GH/GITHUB/NPM/SSH/Git credential helpers and all arbitrary
  // inherited variables. Provider credentials are not copied into evidence or
  // configuration; an unavailable entitlement is a blocked preflight.
  return Object.freeze(out);
}
function freePort() { return new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(error => error ? reject(error) : resolve(port)); }); }); }
function noUnsafeArgs(args, env) {
  required(Array.isArray(args) && env && typeof env === 'object', 'product_path_argument_shape');
  const serialized = JSON.stringify({ args, env });
  required(!/(?:mcp|token|proxy|--dangerously|--yolo|--trust|always-approve|permission-bypass|(?:^|[^a-z])port(?:$|[^a-z])|:\d{2,5}(?:\D|$))/i.test(serialized), 'product_path_unsafe_arguments');
}
function redactedReport(adapter, exec, result) {
  const fields = result && typeof result === 'object' ? result : {};
  const fact = value => value && typeof value === 'object' && Number.isSafeInteger(value.remote_count) && Number.isSafeInteger(value.changed_entry_count) && typeof value.root_digest === 'string' && SHA256.test(value.root_digest) ? Object.freeze({ root_digest: value.root_digest, remote_count: value.remote_count, changed_entry_count: value.changed_entry_count }) : null;
  const out = { schema_version: 1, purpose: 'v2_product_path_smoke', adapter: adapter.id, model_id: adapter.model_id, role: adapter.role, executable_digest: exec.digest, version_digest: exec.version_digest, source_digest: typeof fields.source_digest === 'string' && SHA256.test(fields.source_digest) ? fields.source_digest : null, argument_profile_digest: typeof fields.argument_profile_digest === 'string' && SHA256.test(fields.argument_profile_digest) ? fields.argument_profile_digest : null, environment_profile_digest: typeof fields.environment_profile_digest === 'string' && SHA256.test(fields.environment_profile_digest) ? fields.environment_profile_digest : null, result_class: typeof fields.result_class === 'string' ? fields.result_class : 'worker_failed', lifecycle_state: fields.lifecycle_state === 'verified' ? 'verified' : 'unverified', sentinel_digest: typeof fields.sentinel_digest === 'string' && SHA256.test(fields.sentinel_digest) ? fields.sentinel_digest : null, pre_root_facts: fact(fields.pre_root_facts), post_root_facts: fact(fields.post_root_facts), elapsed_ms: Number.isSafeInteger(fields.elapsed_ms) && fields.elapsed_ms >= 0 ? fields.elapsed_ms : 0, output_bytes: Number.isSafeInteger(fields.output_bytes) && fields.output_bytes >= 0 ? fields.output_bytes : 0, external_process_started: fields.external_process_started === true, provider_turn_cap: CAPS.max_provider_turns, config_isolated: fields.config_isolated === true, cleanup_ok: fields.cleanup_ok === true };
  return Object.freeze(out);
}
function persist(evidence, report) {
  const checked = checkedRoot(evidence, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER, 'terminal.json']), 'product_path_evidence_unsafe'); required(OWNED_EVIDENCE.has(checked), 'product_path_evidence_not_owned'); safeChild(path.dirname(evidence), evidence, 'product_path_evidence_unsafe');
  const filename = path.join(checked, 'terminal.json'), encoded = Buffer.from(JSON.stringify(report) + '\n'); required(encoded.length <= 4096, 'product_path_report_invalid');
  try { fs.writeFileSync(filename, encoded, { mode: 0o600, flag: 'wx' }); fs.chmodSync(filename, 0o600); } catch { fail('product_path_report_persist'); }
}
function workerResult(child, timeoutMs) {
  return new Promise(resolve => {
    let bytes = 0, overflow = false, buffer = ''; let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let escalating = false;
    const gracefulStop = () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { if (child.exitCode === null) { escalating = true; try { child.kill('SIGKILL'); } catch {} } }, 5_000).unref?.(); };
    const timer = setTimeout(() => { gracefulStop(); }, timeoutMs); timer.unref?.();
    const observe = chunk => { bytes += Buffer.byteLength(chunk); if (bytes > CAPS.max_output_bytes) { overflow = true; gracefulStop(); return; } buffer += chunk.toString('utf8'); };
    child.stdout.on('data', observe); child.stderr.on('data', observe);
    child.once('error', () => finish({ result_class: 'worker_failed', cleanup_ok: false, output_bytes: bytes }));
    child.once('exit', () => { if (overflow) return finish({ result_class: 'output_cap_exceeded', cleanup_ok: false, output_bytes: bytes }); const line = buffer.split('\n').find(item => item.startsWith('PRODUCT_PATH_RESULT ')); if (!line || escalating) return finish({ result_class: 'worker_failed', cleanup_ok: false, output_bytes: bytes }); try { const parsed = JSON.parse(line.slice('PRODUCT_PATH_RESULT '.length)); finish({ ...parsed, output_bytes: bytes }); } catch { finish({ result_class: 'worker_failed', cleanup_ok: false, output_bytes: bytes }); } });
  });
}
async function runReviewedProductPath(value) {
  exact(value, ['adapter', 'parent_dir'], 'product_path_run_shape'); const adapter = ADAPTERS[value.adapter]; required(adapter, 'product_path_adapter_not_supported'); required(safePath(value.parent_dir), 'product_path_run_shape');
  const root = createRoot({ parent_dir: value.parent_dir }); const evidence = createEvidence(root); const exec = executable(adapter); const authorization = workerAuthorization(root); repositoryFacts(root); const port = await freePort(); const config = configFor(adapter, root, port); const locations = writeConfig(root, config); const sourceDigest = digest(fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'))); const started = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, 'v2-product-path-worker.cjs'), adapter.id], { cwd: path.join(__dirname, '..'), env: safeEnvironment(locations.home), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }); child.stdin.end(JSON.stringify({ nonce: authorization.nonce, source_digest: sourceDigest }) + '\n');
  const result = await workerResult(child, CAPS.max_elapsed_ms + 15_000); const report = redactedReport(adapter, exec, { ...result, source_digest: sourceDigest, elapsed_ms: Date.now() - started, config_isolated: fs.existsSync(locations.config) && path.dirname(locations.config) !== path.join(os.homedir(), '.quadwork') }); persist(evidence, report);
  return Object.freeze({ evidence_directory: evidence, report });
}

module.exports = Object.freeze({ ADAPTERS, CAPS, EVIDENCE_MARKER, ProductPathError, ROOT_MARKER, WORKLOAD, createDisposableProductPathRoot: createRoot, noUnsafeArgs, runReviewedProductPath, safeEnvironment, testHooks: Object.freeze({ checkedRoot, configFor, createEvidence, executable, persist, redactedReport, repositoryFacts, safeChild, workerAuthorization, workerResult, writeConfig }) });
