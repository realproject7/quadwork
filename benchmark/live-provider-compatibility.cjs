#!/usr/bin/env node
'use strict';

// #1109. This is separate from calibration-protocol.cjs, which remains
// preparation-only and never authorizes a provider process. There is no CLI
// entry point because a reviewed in-process capability is required.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT_MARKER = '.quadwork-live-compatibility-root-v1';
const EVIDENCE_MARKER = '.quadwork-live-compatibility-evidence-v1';
const MARKER_BODY = 'quadwork-live-compatibility-v1\n';
const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITIES = new WeakSet();
const AUTHORIZATION_IDENTITIES = new WeakMap();
const SAFE_ENVIRONMENT = new Set(['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'TERM', 'TMPDIR', 'USER']);
const SCRUBBED_ENVIRONMENT = /^(?:GH|GITHUB|NPM|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN|GIT_ASKPASS|SSH_ASKPASS|GIT_TERMINAL_PROMPT|CI)_/;
const SAFE_TEXT = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000\r\n]/.test(value);

// Source-controlled profiles only. They omit QuadWork's normal MCP injection
// and broad permission-bypass flags.
const ADAPTERS = Object.freeze({
  codex: Object.freeze({ id: 'codex', model_id: 'gpt-5.6-luna', role: 'compatibility_smoke', argv: Object.freeze(['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--color', 'never', '-m', 'gpt-5.6-luna']) }),
  claude: Object.freeze({ id: 'claude', model_id: 'claude-sonnet-4-6', role: 'compatibility_smoke', argv: Object.freeze(['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', '', '--output-format', 'text', '--model', 'claude-sonnet-4-6']) }),
});
const SAFE_WORKLOAD = 'Return exactly QUADWORK_LIVE_OK. Do not use tools. Do not read, write, or change files.';
const CAPS = Object.freeze({ max_elapsed_ms: 45_000, max_output_bytes: 4_096, max_provider_turns: 1, max_version_output_bytes: 4_096 });

class LiveCompatibilityError extends Error {}
const required = (condition, code) => { if (!condition) throw new LiveCompatibilityError(code); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function exact(value, keys, code) {
  required(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  required(actual.length === expected.length && actual.every((key, index) => key === expected[index]), code);
}
const permissions = stat => stat.mode & 0o777;
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();

function sanitizedEnvironment(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) if (SAFE_ENVIRONMENT.has(key) && !SCRUBBED_ENVIRONMENT.test(key) && typeof value === 'string' && value.length <= 4096) result[key] = value;
  // Provider authentication remains in its local credential store. GitHub,
  // npm, Git prompt helpers, and arbitrary inherited values do not reach it.
  result.GIT_CONFIG_NOSYSTEM = '1'; result.GIT_CONFIG_GLOBAL = os.devNull; result.GIT_TERMINAL_PROMPT = '0';
  return result;
}

function checkedMarkedRoot(directory, marker, allowed, code) {
  required(typeof directory === 'string' && path.isAbsolute(directory) && SAFE_TEXT(directory), code);
  let stat, root, entries;
  try { stat = fs.lstatSync(directory); root = fs.realpathSync(directory); entries = fs.readdirSync(root); } catch { throw new LiveCompatibilityError(code); }
  required(!stat.isSymbolicLink() && stat.isDirectory() && permissions(stat) === 0o700 && sameUser(stat) && entries.every(entry => allowed.has(entry)) && entries.includes(marker), code);
  const filename = path.join(root, marker); let markerStat;
  try { markerStat = fs.lstatSync(filename); } catch { throw new LiveCompatibilityError(code); }
  required(!markerStat.isSymbolicLink() && markerStat.isFile() && permissions(markerStat) === 0o600 && sameUser(markerStat) && fs.readFileSync(filename, 'utf8') === MARKER_BODY, code);
  return root;
}

function localGit(runtime, cwd, args) {
  const git = runtime?.git_path || '/usr/bin/git';
  required(path.isAbsolute(git) && path.basename(git) === 'git', 'live_git_path');
  try { return (runtime?.exec_file || execFileSync)(git, ['-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 3_000, maxBuffer: 8 * 1024, env: sanitizedEnvironment() }); }
  catch { throw new LiveCompatibilityError('live_git_unavailable'); }
}

function createDisposableLiveCompatibilityRoot(value = {}, runtime) {
  exact(value, ['parent_dir'], 'live_root_create'); required(typeof value.parent_dir === 'string' && path.isAbsolute(value.parent_dir) && SAFE_TEXT(value.parent_dir), 'live_root_create');
  let parent; try { parent = fs.realpathSync(value.parent_dir); } catch { throw new LiveCompatibilityError('live_root_create'); }
  const parentStat = fs.lstatSync(parent); required(parentStat.isDirectory() && !parentStat.isSymbolicLink(), 'live_root_create');
  const root = fs.mkdtempSync(path.join(parent, 'quadwork-live-compatibility-')); fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, ROOT_MARKER), MARKER_BODY, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.chmodSync(path.join(root, ROOT_MARKER), 0o600);
  localGit(runtime, root, ['init', '--quiet']);
  // The ownership marker is harness metadata, not a candidate file. Keeping it
  // in the repository-local exclude makes the pre/post clean-tree assertion
  // meaningful without touching user/global Git configuration.
  const exclude = path.join(root, '.git', 'info', 'exclude');
  fs.appendFileSync(exclude, `${ROOT_MARKER}\n`, { encoding: 'utf8', mode: 0o600 }); fs.chmodSync(exclude, 0o600);
  return checkedMarkedRoot(root, ROOT_MARKER, new Set([ROOT_MARKER, '.git']), 'live_root_create');
}

function createDisposableLiveCompatibilityEvidenceRoot(value = {}) {
  exact(value, ['parent_dir'], 'live_evidence_create'); required(typeof value.parent_dir === 'string' && path.isAbsolute(value.parent_dir) && SAFE_TEXT(value.parent_dir), 'live_evidence_create');
  let parent; try { parent = fs.realpathSync(value.parent_dir); } catch { throw new LiveCompatibilityError('live_evidence_create'); }
  const parentStat = fs.lstatSync(parent); required(parentStat.isDirectory() && !parentStat.isSymbolicLink(), 'live_evidence_create');
  const root = fs.mkdtempSync(path.join(parent, 'quadwork-live-evidence-')); fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, EVIDENCE_MARKER), MARKER_BODY, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.chmodSync(path.join(root, EVIDENCE_MARKER), 0o600);
  return checkedMarkedRoot(root, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER]), 'live_evidence_create');
}

function createReviewedExecutionAuthorization(boundIdentity) {
  const capability = Object.freeze({});
  AUTHORIZATION_IDENTITIES.set(capability, identity(boundIdentity)); CAPABILITIES.add(capability);
  return capability;
}
function identity(value) { exact(value, ['base_digest', 'harness_digest', 'source_digest', 'workload_digest'], 'live_identity'); for (const item of Object.values(value)) required(typeof item === 'string' && SHA256.test(item), 'live_identity'); return Object.freeze({ ...value }); }
function caps(runtime) {
  const selected = runtime?.test_caps || CAPS;
  exact(selected, ['max_elapsed_ms', 'max_output_bytes', 'max_provider_turns', 'max_version_output_bytes'], 'live_caps');
  for (const key of Object.keys(CAPS)) required(Number.isSafeInteger(selected[key]) && selected[key] > 0 && selected[key] <= CAPS[key], 'live_caps');
  return Object.freeze({ ...selected });
}
function executable(adapter, filename) {
  required(typeof filename === 'string' && path.isAbsolute(filename) && SAFE_TEXT(filename), 'live_executable');
  let source, resolved, target; try { source = fs.lstatSync(filename); resolved = fs.realpathSync(filename); target = fs.statSync(resolved); } catch { throw new LiveCompatibilityError('live_executable'); }
  required((source.isFile() || source.isSymbolicLink()) && target.isFile() && (target.mode & 0o111) !== 0 && path.basename(resolved) === adapter.id, 'live_executable');
  const bytes = fs.readFileSync(resolved); required(bytes.length > 0 && bytes.length <= 128 * 1024 * 1024, 'live_executable');
  return Object.freeze({ path: resolved, digest: digest(bytes) });
}
function rootFacts(root, runtime) {
  const checked = checkedMarkedRoot(root, ROOT_MARKER, new Set([ROOT_MARKER, '.git']), 'live_unsafe_root');
  required(localGit(runtime, checked, ['remote']).trim() === '', 'live_remote_present'); required(localGit(runtime, checked, ['status', '--porcelain=v1']).trim() === '', 'live_unsafe_root');
  return Object.freeze({ entry_count: fs.readdirSync(checked).length, remote_count: 0, changed_entry_count: 0 });
}
function profile(adapter, root) { return Object.freeze(adapter.id === 'codex' ? [...adapter.argv, '-C', root, SAFE_WORKLOAD] : [...adapter.argv, SAFE_WORKLOAD]); }
function runChild(runtime, command, args, options) { return (runtime?.spawn || spawn)(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
function capture(runtime, command, args, options) {
  return new Promise((resolve, reject) => {
    let child; try { child = runChild(runtime, command, args, options); } catch (error) { reject(error); return; }
    let bytes = 0, stdoutBytes = 0, stderrBytes = 0, overflow = false, timedOut = false, settled = false; const stdout = [], outputHash = crypto.createHash('sha256');
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, options.timeout_ms); timer.unref?.();
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const observe = (chunk, stream) => { const length = Buffer.byteLength(chunk); outputHash.update(chunk); bytes += length; if (stream === 'stdout') { stdoutBytes += length; if (stdoutBytes <= 128) stdout.push(Buffer.from(chunk)); } else stderrBytes += length; if (bytes > options.max_output_bytes && !overflow) { overflow = true; try { child.kill('SIGKILL'); } catch {} } };
    child.stdout?.on('data', chunk => observe(chunk, 'stdout')); child.stderr?.on('data', chunk => observe(chunk, 'stderr')); child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } }); child.once('close', (code, signal) => { const response = Buffer.concat(stdout).toString('utf8'); const response_ok = options.expected_response === undefined ? null : stderrBytes === 0 && stdoutBytes <= 128 && (response === options.expected_response || response === `${options.expected_response}\n`); finish({ code, signal, bytes, output_digest: outputHash.digest('hex'), overflow, response_ok, timed_out: timedOut }); });
  });
}
function persistTerminal(evidenceRoot, report) {
  const root = checkedMarkedRoot(evidenceRoot, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER, 'terminal.json']), 'live_evidence_root'); const filename = path.join(root, 'terminal.json'); required(!fs.existsSync(filename), 'live_terminal_already_recorded');
  const encoded = Buffer.from(JSON.stringify(report) + '\n', 'utf8'); required(encoded.length <= 8 * 1024, 'live_evidence_report'); const temporary = path.join(root, `.terminal-${crypto.randomBytes(16).toString('hex')}.tmp`);
  try { fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, filename); fs.chmodSync(filename, 0o600); const fd = fs.openSync(root, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); } catch { try { fs.unlinkSync(temporary); } catch {} throw new LiveCompatibilityError('live_evidence_persist'); }
}
function terminalReport(contract, selectedCaps, result_class, details = {}) {
  return Object.freeze({ schema_version: 1, purpose: 'live_provider_compatibility_smoke', adapter: contract.adapter.id, model_id: contract.adapter.model_id, role: contract.adapter.role, contract_digest: contract.digest, executable_digest: contract.executable.digest, cli_version_digest: details.cli_version_digest || null, response_digest: details.response_digest || null, response_contract_passed: details.response_contract_passed === true, pre_repository_facts: contract.pre_facts, post_repository_facts: details.post_facts || null, result_class, external_process_started: details.external_process_started === true, output_bytes: Number.isSafeInteger(details.output_bytes) ? details.output_bytes : 0, elapsed_ms: Number.isSafeInteger(details.elapsed_ms) ? details.elapsed_ms : 0, provider_turn_cap: selectedCaps.max_provider_turns });
}

async function runLiveCompatibility(value, runtime) {
  exact(value, ['adapter', 'authorization', 'evidence_directory', 'executable', 'identity', 'root_directory'], 'live_run_shape'); required(CAPABILITIES.has(value.authorization), 'live_execution_not_authorized');
  const adapter = ADAPTERS[value.adapter]; required(adapter, 'live_adapter_not_supported'); const selectedCaps = caps(runtime);
  const root = checkedMarkedRoot(value.root_directory, ROOT_MARKER, new Set([ROOT_MARKER, '.git']), 'live_unsafe_root'); const evidenceRoot = checkedMarkedRoot(value.evidence_directory, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER, 'terminal.json']), 'live_evidence_root'); required(!fs.existsSync(path.join(evidenceRoot, 'terminal.json')), 'live_terminal_already_recorded');
  const runIdentity = identity(value.identity); required(JSON.stringify(AUTHORIZATION_IDENTITIES.get(value.authorization)) === JSON.stringify(runIdentity), 'live_identity_not_authorized'); const resolvedExecutable = executable(adapter, value.executable); required(typeof runtime?.assert_host_isolation === 'function' ? runtime.assert_host_isolation({ adapter: adapter.id, root }) === true : true, 'live_host_isolation_unavailable'); const preFacts = rootFacts(root, runtime); const compiled = profile(adapter, root);
  const contract = Object.freeze({ adapter, executable: resolvedExecutable, identity: runIdentity, pre_facts: preFacts, digest: digest(JSON.stringify({ adapter: adapter.id, model_id: adapter.model_id, executable_digest: resolvedExecutable.digest, identity: runIdentity, profile_digest: digest(JSON.stringify(compiled)), pre_facts: preFacts })) }); const startedAt = Date.now();
  let version; try { version = await capture(runtime, resolvedExecutable.path, ['--version'], { cwd: root, env: sanitizedEnvironment(), max_output_bytes: selectedCaps.max_version_output_bytes, timeout_ms: 5_000 }); } catch { const report = terminalReport(contract, selectedCaps, 'version_failed'); persistTerminal(evidenceRoot, report); return report; }
  const versionDigest = version.output_digest; if (version.timed_out || version.overflow || version.code !== 0 || version.signal) { const report = terminalReport(contract, selectedCaps, 'version_failed', { cli_version_digest: versionDigest, output_bytes: version.bytes, elapsed_ms: Date.now() - startedAt }); persistTerminal(evidenceRoot, report); return report; }
  let invocation; try { invocation = await capture(runtime, resolvedExecutable.path, compiled, { cwd: root, env: sanitizedEnvironment(), expected_response: 'QUADWORK_LIVE_OK', max_output_bytes: selectedCaps.max_output_bytes, timeout_ms: selectedCaps.max_elapsed_ms }); } catch { const report = terminalReport(contract, selectedCaps, 'process_failed', { cli_version_digest: versionDigest, external_process_started: true, elapsed_ms: Date.now() - startedAt }); persistTerminal(evidenceRoot, report); return report; }
  let result_class = 'completed'; if (invocation.timed_out) result_class = 'timeout'; else if (invocation.overflow) result_class = 'output_cap_exceeded'; else if (invocation.code !== 0 || invocation.signal) result_class = 'login_or_entitlement_failure'; else if (!invocation.response_ok) result_class = 'response_contract_failed'; let postFacts = null; try { postFacts = rootFacts(root, runtime); if (JSON.stringify(preFacts) !== JSON.stringify(postFacts)) result_class = 'repository_mutated'; } catch { result_class = 'repository_mutated'; }
  const report = terminalReport(contract, selectedCaps, result_class, { cli_version_digest: versionDigest, response_digest: invocation.output_digest, response_contract_passed: invocation.response_ok === true, post_facts: postFacts, external_process_started: true, output_bytes: invocation.bytes, elapsed_ms: Date.now() - startedAt }); persistTerminal(evidenceRoot, report); return report;
}

module.exports = Object.freeze({ ADAPTERS, CAPS, EVIDENCE_MARKER, LiveCompatibilityError, ROOT_MARKER, createDisposableLiveCompatibilityEvidenceRoot, createDisposableLiveCompatibilityRoot, createReviewedExecutionAuthorization, runLiveCompatibility, sanitizedEnvironment });
