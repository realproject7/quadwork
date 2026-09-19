#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const core = require('./v2-product-path-core.cjs');

function parent() { return fs.mkdtempSync(path.join(os.tmpdir(), 'quadwork-product-path-test-')); }
function cleanup(directory) { fs.rmSync(directory, { recursive: true, force: true }); }

test('product-path registry has exactly the currently reviewed Codex and Claude identities', () => {
  assert.deepEqual(Object.keys(core.ADAPTERS).sort(), ['claude', 'codex']);
  for (const adapter of Object.values(core.ADAPTERS)) {
    assert.equal(adapter.command.startsWith('/'), true); assert.equal(adapter.role.startsWith('benchmark_'), true);
    assert.equal(adapter.model_id.length > 0, true); assert.equal(adapter.command, require('./live-provider-reviewed-contracts.cjs')[adapter.id].resolved_path);
  }
});

test('executor-owned root creates a local Git repository, isolated HOME config, and exact safe role profile', () => {
  const directory = parent();
  try {
    const root = core.createDisposableProductPathRoot({ parent_dir: directory });
    const config = core.testHooks.configFor(core.ADAPTERS.codex, root, 19001);
    const places = core.testHooks.writeConfig(root, config); const disk = JSON.parse(fs.readFileSync(places.config, 'utf8'));
    assert.equal(fs.statSync(root).mode & 0o777, 0o700); assert.equal(fs.statSync(path.dirname(places.config)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(places.config).mode & 0o777, 0o600); assert.equal(disk.projects[0].agents.benchmark_codex.auto_approve, false);
    assert.equal(disk.projects[0].agents.benchmark_codex.mcp_inject, 'none'); assert.equal(disk.projects[0].agents.benchmark_codex.command_identity, 'codex'); assert.equal(fs.existsSync(path.join(root, 'repository', '.git')), true);
    assert.notEqual(places.config, path.join(os.homedir(), '.quadwork', 'config.json'), 'the test uses its own HOME/config path');
  } finally { cleanup(directory); }
});

test('argument validator rejects MCP, token, proxy, and permission-bypass surfaces', () => {
  core.noUnsafeArgs(['-c', 'model="gpt-5.6-luna"'], {});
  for (const value of [['--mcp-config', '/tmp/mcp.json'], ['--dangerously-skip-permissions'], ['--always-approve'], ['--proxy', 'http://127.0.0.1']]) {
    assert.throws(() => core.noUnsafeArgs(value, {}), /product_path_unsafe_arguments/);
  }
  for (const environment of [{ TOKEN: 'x' }, { SAFE: 'http://proxy.invalid' }, { SAFE: 'token=private' }, { PORT: '8400' }, { SAFE: 'http://127.0.0.1:8400' }]) assert.throws(() => core.noUnsafeArgs([], environment), /product_path_unsafe_arguments/);
});

test('marker forgery, caller roots, and a repository remote fail before a live child can be admitted', () => {
  const directory = parent();
  try {
    const forged = path.join(directory, 'forged'); fs.mkdirSync(forged, { mode: 0o700 }); fs.writeFileSync(path.join(forged, core.ROOT_MARKER), 'quadwork-v2-product-path-v1\n', { mode: 0o600 });
    assert.throws(() => core.testHooks.createEvidence(forged), /product_path_root_not_owned/);
    const root = core.createDisposableProductPathRoot({ parent_dir: directory });
    require('node:child_process').execFileSync('/usr/bin/git', ['remote', 'add', 'origin', 'https://example.invalid/not-allowed'], { cwd: path.join(root, 'repository') });
    assert.throws(() => core.testHooks.repositoryFacts(root), /product_path_remote_present/);
  } finally { cleanup(directory); }
});

test('redacted reports never retain prompt, output, path, token, or raw lifecycle detail', () => {
  const facts = { root_digest: 'd'.repeat(64), remote_count: 0, changed_entry_count: 0 };
  const report = core.testHooks.redactedReport(core.ADAPTERS.claude, { digest: 'a'.repeat(64), version_digest: 'b'.repeat(64) }, { result_class: 'completed', lifecycle_state: 'verified', sentinel_digest: 'c'.repeat(64), source_digest: 'e'.repeat(64), argument_profile_digest: 'f'.repeat(64), environment_profile_digest: '0'.repeat(64), pre_root_facts: facts, post_root_facts: facts, output: 'private output', token: 'private-token', absolute_path: '/private/path', elapsed_ms: 1, output_bytes: 2, external_process_started: true, cleanup_ok: true });
  const text = JSON.stringify(report); for (const secret of ['private output', 'private-token', '/private/path']) assert.equal(text.includes(secret), false);
  assert.equal(report.lifecycle_state, 'verified'); assert.equal(report.external_process_started, true); assert.deepEqual(report.pre_root_facts, facts); assert.equal(report.source_digest, 'e'.repeat(64));
});

test('public runner rejects test seams, arbitrary command/model/argv, and an unknown provider', async () => {
  const directory = parent();
  try {
    await assert.rejects(() => core.runReviewedProductPath({ adapter: 'codex', parent_dir: directory, command: '/bin/sh' }), /product_path_run_shape/);
    await assert.rejects(() => core.runReviewedProductPath({ adapter: 'grok', parent_dir: directory }), /product_path_adapter_not_supported/);
  } finally { cleanup(directory); }
});

test('worker source has no provider-configurable pty or admission dependency seam', () => {
  const source = fs.readFileSync(path.join(__dirname, 'v2-product-path-worker.cjs'), 'utf8');
  assert.match(source, /runtime\.spawnAgentPty/); assert.match(source, /runtime\.buildAgentArgs/);
  assert.doesNotMatch(source, /ptySpawn|buildAgentArgs:\s*|spawnAgentPty:\s*|REVIEWED_EXECUTIONS|createReviewedExecutionAuthorization/);
  assert.match(source, /if \(!preflight\(\)\).*preflight_blocked[\s\S]*spawnAgentPty/);
  assert.match(source, /finally[\s\S]*stopAgentSession[\s\S]*runtime\.shutdown[\s\S]*postFacts/);
  assert.match(source, /workerAuthorization\(root\)[\s\S]*validateExecutable\(\)[\s\S]*product_path_source_changed[\s\S]*require\('\.\.\/server\/index\.js'\)/);
});

test('worker authorization is one-shot, root-owned, and its marker becomes part of the exact root layout', () => {
  const directory = parent();
  try {
    const root = core.createDisposableProductPathRoot({ parent_dir: directory });
    const authorization = core.testHooks.workerAuthorization(root);
    assert.match(authorization.nonce, /^[a-f0-9]{64}$/); assert.equal(fs.readFileSync(path.join(root, '.worker-authority'), 'utf8').trim().length, 64);
    fs.writeFileSync(path.join(root, '.worker-authority'), '0'.repeat(64) + '\n', { mode: 0o600 });
    assert.notEqual(fs.readFileSync(path.join(root, '.worker-authority'), 'utf8'), require('node:crypto').createHash('sha256').update(authorization.nonce).digest('hex') + '\n');
  } finally { cleanup(directory); }
});

test('fake CLI traverses the real V2 spawnAgentPty admission and PTY lifecycle without a fixture seam', () => {
  const directory = parent();
  try {
    const home = path.join(directory, 'home'), configDir = path.join(home, '.quadwork'), repository = path.join(directory, 'repository'), fake = path.join(directory, 'fake-cli');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
    fs.writeFileSync(fake, '#!/usr/bin/env node\nrequire("fs").writeFileSync(require("path").join(process.env.HOME,"fake-pid"),String(process.pid)); process.stdout.write("fake-ready\\n"); setInterval(() => {}, 1000);\n', { mode: 0o700 }); fs.chmodSync(fake, 0o700);
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ port: 18999, installation_id: 'benchmark_product_path_0001', temp_cleanup: { enabled: false }, projects: [{ id: 'benchmark-product-path', name: 'fixture', idle: true, chat_mode: 'file', repositories: [{ key: 'fixture', repo: 'local/fixture', working_dir: repository, primary: true }], agents: { benchmark_claude: { cwd: repository, command: fake, command_identity: 'claude', model: 'claude-sonnet-4-6', auto_approve: false, mcp_inject: 'none' } } }] }), { mode: 0o600 });
    const script = [
      "const fs=require('fs'), path=require('path');",
      "const runtime=require('./server/index.js');",
      "(async()=>{ const built=await runtime.buildAgentArgs('benchmark-product-path','benchmark_claude'); if (JSON.stringify(built.args)!==JSON.stringify(['--model','claude-sonnet-4-6'])) throw new Error('unexpected args'); const launched=await runtime.spawnAgentPty('benchmark-product-path','benchmark_claude',{lifecycleSource:'operator_start',operatorAuthorized:true,explicitRole:true,suppressLifecycleMsg:true}); if(!launched.ok) throw new Error('launch failed'); let durable; for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,25)); durable=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.quadwork','benchmark-product-path','agent-lifecycle-state.json'),'utf8')); if(durable.roles.benchmark_claude.state==='verified') break; } if(durable.roles.benchmark_claude.state!=='verified') throw new Error('not verified'); const stopped=await runtime.stopAgentSession('benchmark-product-path/benchmark_claude',{suppressLifecycleMsg:true,removeEntry:true}); if(!stopped.ok) throw new Error('stop failed'); await runtime.shutdown(); process.exit(0); })().catch(e=>{console.error(e.stack);process.exit(1)});",
    ].join('');
    const moduleRoots = [path.join(process.cwd(), 'node_modules'), path.join(path.dirname(process.cwd()), 'quadwork', 'node_modules')].filter(fs.existsSync);
    const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: home, USERPROFILE: home, QUADWORK_SKIP_LISTEN: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, NODE_PATH: moduleRoots.join(path.delimiter) || (process.env.NODE_PATH || '') }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const pid = Number(fs.readFileSync(path.join(home, 'fake-pid'), 'utf8')); assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'real V2 stopAgentSession leaves no fake PTY child alive');
  } finally { cleanup(directory); }
});
