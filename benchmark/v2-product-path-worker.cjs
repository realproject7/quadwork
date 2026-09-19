#!/usr/bin/env node
'use strict';

// Runs only inside the executor-owned HOME written by v2-product-path-core.
// It imports the real V2 server, uses its unmodified buildAgentArgs/env and
// spawnAgentPty admission path, and emits one redacted JSON fact line.
const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocket } = require('ws');
const core = require('./v2-product-path-core.cjs');

const adapter = core.ADAPTERS[process.argv[2]];
const port = Number(process.env.QUADWORK_PRODUCT_PATH_PORT);
const project = 'benchmark-product-path';
const sentinel = 'QUADWORK_PRODUCT_PATH_OK';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function request(method, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { ...(token ? { 'X-Session-Token': token } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { resolve({ status: res.statusCode, body: null }); } }); });
    req.once('error', reject); if (payload) req.write(payload); req.end();
  });
}
async function waitForHealth() { for (let i = 0; i < 160; i++) { try { if ((await request('GET', '/api/health')).status === 200) return; } catch {} await sleep(25); } throw new Error('product_path_server_unavailable'); }
function terminalObservation(token) {
  return new Promise((resolve, reject) => {
    let bytes = 0, digest = crypto.createHash('sha256'), tail = '', settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(value); } };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${encodeURIComponent(project)}&agent=${encodeURIComponent(adapter.role)}&token=${encodeURIComponent(token)}`, { origin: `http://127.0.0.1:${port}` });
    const timer = setTimeout(() => finish({ seen: false, bytes, digest: digest.digest('hex'), timed_out: true }), core.CAPS.max_elapsed_ms); timer.unref?.();
    ws.once('open', () => ws.send(JSON.stringify({ type: 'replay' })));
    ws.on('message', chunk => { const data = Buffer.from(chunk); bytes += data.length; digest.update(data); tail = (tail + data.toString('utf8')).slice(-256); if (bytes > core.CAPS.max_output_bytes) return finish({ seen: false, bytes, digest: digest.digest('hex'), overflow: true }); if (tail.includes(sentinel)) finish({ seen: true, bytes, digest: digest.digest('hex') }); });
    ws.once('error', reject); ws.once('close', () => { if (!settled) finish({ seen: false, bytes, digest: digest.digest('hex'), closed: true }); });
  });
}
async function main() {
  if (!adapter || !Number.isSafeInteger(port) || port <= 0 || port >= 65536) throw new Error('product_path_worker_shape');
  const runtime = require('../server/index.js'); await waitForHealth();
  const config = require('../server/config.js').readConfig(); const agent = config.projects?.[0]?.agents?.[adapter.role];
  if (!agent || agent.auto_approve !== false || agent.mcp_inject !== 'none' || agent.command !== adapter.command || agent.model !== adapter.model_id) throw new Error('product_path_config_drift');
  const built = await runtime.buildAgentArgs(project, adapter.role); const env = runtime.buildAgentEnv(project, adapter.role); core.noUnsafeArgs(built.args, env);
  const token = config.session_token;
  const started = Date.now(); const launched = await runtime.spawnAgentPty(project, adapter.role, { lifecycleSource: 'operator_start', operatorAuthorized: true, explicitRole: true, suppressLifecycleMsg: true });
  if (!launched.ok) { await runtime.shutdown(); return { result_class: 'preflight_blocked', lifecycle_state: 'unverified', external_process_started: false, cleanup_ok: true, elapsed_ms: Date.now() - started }; }
  // Attach after admission so the server only exposes a session created by the
  // real lifecycle path. Replay is a bounded observation of that PTY only.
  const observed = terminalObservation(token);
  const written = await request('POST', `/api/agents/${project}/${adapter.role}/write`, token, { text: `${core.WORKLOAD}\n` });
  const terminal = written.status === 200 ? await observed : { seen: false, bytes: 0, digest: null };
  let lifecycleState = 'unverified';
  try {
    const durable = JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.HOME, '.quadwork', project, 'agent-lifecycle-state.json'), 'utf8'));
    if (durable?.roles?.[adapter.role]?.state === 'verified') lifecycleState = 'verified';
  } catch {}
  const stopped = await runtime.stopAgentSession(`${project}/${adapter.role}`, { suppressLifecycleMsg: true, removeEntry: true }); const shutdown = await runtime.shutdown();
  return { result_class: terminal.seen && lifecycleState === 'verified' && stopped.ok && shutdown.ok ? 'completed' : terminal.timed_out ? 'timeout' : terminal.overflow ? 'output_cap_exceeded' : 'response_contract_failed', lifecycle_state: lifecycleState, sentinel_digest: terminal.digest || null, external_process_started: true, cleanup_ok: stopped.ok && shutdown.ok, elapsed_ms: Date.now() - started };
}
main().then(result => { process.stdout.write(`PRODUCT_PATH_RESULT ${JSON.stringify(result)}\n`); process.exit(0); }, () => { process.stdout.write('PRODUCT_PATH_RESULT {"result_class":"worker_failed","cleanup_ok":false}\n'); process.exit(1); });
