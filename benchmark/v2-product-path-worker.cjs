#!/usr/bin/env node
'use strict';

// Runs only with the executor-owned HOME. It imports the unmodified V2 server
// and uses its real argument, admission, PTY, lifecycle, and stop paths.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const core = require('./v2-product-path-core.cjs');
const reviewed = require('./live-provider-reviewed-contracts.cjs');

const adapter = core.ADAPTERS[process.argv[2]];
const project = 'benchmark-product-path';
const sentinel = 'QUADWORK_PRODUCT_PATH_OK';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mode = stat => stat.mode & 0o777;
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
let port = null, abort = false, currentObservation = null, abortResolve;
const aborted = new Promise(resolve => { abortResolve = resolve; });
process.once('SIGTERM', () => { abort = true; currentObservation?.close(); abortResolve(); });

function bounded(promise, ms, code) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(code)), ms); timer.unref?.(); Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); }); }
function request(method, pathname, token, body, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { ...(token ? { 'X-Session-Token': token } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { resolve({ status: res.statusCode, body: null }); } }); });
    const timer = setTimeout(() => req.destroy(new Error('product_path_request_timeout')), timeoutMs); timer.unref?.(); req.once('error', error => { clearTimeout(timer); reject(error); }); req.once('close', () => clearTimeout(timer)); if (payload) req.write(payload); req.end();
  });
}
async function waitForHealth() { for (let i = 0; i < 160; i++) { if (abort) throw new Error('product_path_aborted'); try { if ((await request('GET', '/api/health', null, undefined, 500)).status === 200) return; } catch {} await sleep(25); } throw new Error('product_path_server_unavailable'); }
function terminalObservation(token) {
  let ws, finish;
  const { WebSocket } = require('ws');
  const result = new Promise((resolve, reject) => {
    let bytes = 0, output = crypto.createHash('sha256'), tail = '', settled = false;
    finish = value => { if (!settled) { settled = true; clearTimeout(timer); try { ws?.close(); } catch {} resolve(value); } };
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${encodeURIComponent(project)}&agent=${encodeURIComponent(adapter.role)}&token=${encodeURIComponent(token)}`, { origin: `http://127.0.0.1:${port}` });
    const timer = setTimeout(() => finish({ seen: false, bytes, digest: output.digest('hex'), timed_out: true }), core.CAPS.max_elapsed_ms); timer.unref?.();
    ws.once('open', () => ws.send(JSON.stringify({ type: 'replay' })));
    ws.on('message', chunk => { const data = Buffer.from(chunk); bytes += data.length; output.update(data); tail = (tail + data.toString('utf8')).slice(-256); if (bytes > core.CAPS.max_output_bytes) return finish({ seen: false, bytes, digest: output.digest('hex'), overflow: true }); if (tail.includes(sentinel)) finish({ seen: true, bytes, digest: output.digest('hex') }); });
    ws.once('error', reject); ws.once('close', () => { if (!settled) finish({ seen: false, bytes, digest: output.digest('hex'), closed: true }); });
  });
  return Object.freeze({ result, close: () => finish?.({ seen: false, bytes: 0, digest: null, aborted: true }) });
}
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
  if (run(['remote']).trim() !== '') throw new Error('product_path_remote_present'); if (run(['status', '--porcelain=v1']).trim() !== '') throw new Error('product_path_repository_mutated');
  return Object.freeze({ root_digest: digest(root), remote_count: 0, changed_entry_count: 0 });
}
function validateConfigHome(root, config) {
  const home = safeDirectory(process.env.HOME, root, 'product_path_home_unsafe'), configDir = safeDirectory(path.join(process.env.HOME, '.quadwork'), home, 'product_path_config_directory_unsafe'), filename = path.join(configDir, 'config.json');
  let stat; try { stat = fs.lstatSync(filename); } catch { throw new Error('product_path_config_unsafe'); }
  if (!stat.isFile() || stat.isSymbolicLink() || mode(stat) !== 0o600 || !sameUser(stat)) throw new Error('product_path_config_unsafe');
  const agent = config.projects?.[0]?.agents?.[adapter.role];
  if (!agent || agent.auto_approve !== false || agent.mcp_inject !== 'none' || agent.command !== adapter.command || agent.command_identity !== adapter.command_identity || agent.model !== adapter.model_id) throw new Error('product_path_config_drift');
}
function preflight() {
  const contract = reviewed[adapter.id]; if (!contract || adapter.command !== contract.resolved_path || adapter.model_id.length === 0) return false;
  const version = spawnSync(adapter.command, ['--version'], { cwd: process.env.HOME, env: process.env, shell: false, timeout: 5_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
  if (version.status !== 0 || version.signal || digest(Buffer.concat([version.stdout || Buffer.alloc(0), version.stderr || Buffer.alloc(0)])) !== contract.version_digest) return false;
  const auth = spawnSync(adapter.command, adapter.id === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], { cwd: process.env.HOME, env: process.env, shell: false, timeout: 5_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
  if (auth.status !== 0 || auth.signal) return false;
  if (adapter.id === 'claude') { try { return JSON.parse(String(auth.stdout)).loggedIn === true; } catch { return false; } }
  return true;
}
function lifecycleState() { try { const state = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.quadwork', project, 'agent-lifecycle-state.json'), 'utf8')); return state?.roles?.[adapter.role]?.state === 'verified' ? 'verified' : 'unverified'; } catch { return 'unverified'; } }
async function main() {
  if (!adapter) throw new Error('product_path_worker_shape'); const root = path.dirname(process.env.HOME || ''); const authorization = workerAuthorization(root); safeDirectory(process.env.HOME, root, 'product_path_home_unsafe'); validateExecutable();
  if (digest(fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'))) !== authorization.source_digest) throw new Error('product_path_source_changed');
  const config = require('../server/config.js').readConfig(); port = config.port; if (!Number.isSafeInteger(port) || port <= 0 || port >= 65536) throw new Error('product_path_port_unsafe'); validateConfigHome(root, config);
  const preFacts = rootFacts(root), base = { pre_root_facts: preFacts, external_process_started: false, lifecycle_state: 'unverified' };
  const started = Date.now(); let runtime = null, launched = null, observation = null, outcome = { ...base, result_class: 'worker_failed' };
  try {
    if (!preflight()) { outcome = { ...base, result_class: 'preflight_blocked' }; return outcome; }
    try { runtime = require('../server/index.js'); } catch { outcome = { ...base, result_class: 'initialization_blocked' }; return outcome; }
    await waitForHealth();
    const built = await runtime.buildAgentArgs(project, adapter.role), additional = runtime.buildAgentEnv(project, adapter.role), effectiveEnv = { ...process.env, ...additional }; core.noUnsafeArgs(built.args, effectiveEnv);
    const environmentEntries = Object.keys(effectiveEnv).sort().map(key => [key, effectiveEnv[key]]);
    Object.assign(base, { argument_profile_digest: digest(JSON.stringify(built.args)), environment_profile_digest: digest(JSON.stringify(environmentEntries)) });
    launched = await bounded(runtime.spawnAgentPty(project, adapter.role, { lifecycleSource: 'operator_start', operatorAuthorized: true, explicitRole: true, suppressLifecycleMsg: true }), 10_000, 'product_path_spawn_timeout');
    if (!launched.ok) { outcome = { ...base, result_class: 'preflight_blocked' }; return outcome; }
    observation = terminalObservation(config.session_token); currentObservation = observation;
    const written = await request('POST', `/api/agents/${project}/${adapter.role}/write`, config.session_token, { text: `${core.WORKLOAD}\n` });
    const terminal = written.status === 200 ? await Promise.race([observation.result, aborted.then(() => ({ seen: false, bytes: 0, digest: null, timed_out: true }))]) : { seen: false, bytes: 0, digest: null };
    const state = lifecycleState(); outcome = { ...base, result_class: terminal.seen && state === 'verified' ? 'completed' : terminal.timed_out || abort ? 'timeout' : terminal.overflow ? 'output_cap_exceeded' : 'response_contract_failed', lifecycle_state: state, sentinel_digest: terminal.digest || null, external_process_started: true, output_bytes: terminal.bytes || 0 };
    return outcome;
  } catch { return outcome; }
  finally {
    observation?.close(); currentObservation = null; let stopped = { ok: true }, shutdown = { ok: true }, postFacts = null;
    try { if (launched?.ok) stopped = await bounded(runtime.stopAgentSession(`${project}/${adapter.role}`, { suppressLifecycleMsg: true, removeEntry: true }), 6_000, 'product_path_stop_timeout'); } catch { stopped = { ok: false }; }
    try { if (runtime) shutdown = await bounded(runtime.shutdown(), 6_000, 'product_path_shutdown_timeout'); } catch { shutdown = { ok: false }; }
    try { postFacts = rootFacts(root); } catch {}
    Object.assign(outcome, { post_root_facts: postFacts, cleanup_ok: stopped.ok === true && shutdown.ok === true && postFacts !== null, elapsed_ms: Date.now() - started });
  }
}
main().then(result => { process.stdout.write(`PRODUCT_PATH_RESULT ${JSON.stringify(result)}\n`); process.exit(0); }, () => { process.stdout.write('PRODUCT_PATH_RESULT {"result_class":"worker_failed","cleanup_ok":false}\n'); process.exit(1); });
