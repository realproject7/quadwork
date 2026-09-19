#!/usr/bin/env node
'use strict';

// #1109. This is separate from calibration-protocol.cjs, which remains
// preparation-only and never authorizes a provider process. The public wrapper
// selects this module's source-controlled reviewed execution registry.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const REVIEWED_EXECUTIONS = require('./live-provider-reviewed-contracts.cjs');

const ROOT_MARKER = '.quadwork-live-compatibility-root-v1';
const EVIDENCE_MARKER = '.quadwork-live-compatibility-evidence-v1';
const MARKER_BODY = 'quadwork-live-compatibility-v1\n';
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ENVIRONMENT = new Set(['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'TERM', 'TMPDIR', 'USER']);
const SCRUBBED_ENVIRONMENT = /^(?:GH|GITHUB|NPM|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN|GIT_ASKPASS|SSH_ASKPASS|GIT_TERMINAL_PROMPT|CI)_/;
const SAFE_TEXT = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000\r\n]/.test(value);
const OWNED_ROOTS = new Set();
const OWNED_EVIDENCE_ROOTS = new Set();

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
  const checked = checkedMarkedRoot(root, ROOT_MARKER, new Set([ROOT_MARKER, '.git']), 'live_root_create'); OWNED_ROOTS.add(checked); return checked;
}

function createDisposableLiveCompatibilityEvidenceRoot(value = {}) {
  exact(value, ['parent_dir'], 'live_evidence_create'); required(typeof value.parent_dir === 'string' && path.isAbsolute(value.parent_dir) && SAFE_TEXT(value.parent_dir), 'live_evidence_create');
  let parent; try { parent = fs.realpathSync(value.parent_dir); } catch { throw new LiveCompatibilityError('live_evidence_create'); }
  const parentStat = fs.lstatSync(parent); required(parentStat.isDirectory() && !parentStat.isSymbolicLink(), 'live_evidence_create');
  const root = fs.mkdtempSync(path.join(parent, 'quadwork-live-evidence-')); fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, EVIDENCE_MARKER), MARKER_BODY, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.chmodSync(path.join(root, EVIDENCE_MARKER), 0o600);
  const checked = checkedMarkedRoot(root, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER]), 'live_evidence_create'); OWNED_EVIDENCE_ROOTS.add(checked); return checked;
}

function identity(value) { exact(value, ['harness_digest', 'source_digest', 'workload_digest'], 'live_identity'); for (const item of Object.values(value)) required(typeof item === 'string' && SHA256.test(item), 'live_identity'); return Object.freeze({ ...value }); }
function reviewedContract(value) {
  exact(value, ['adapter', 'executable_digest', 'executable_path', 'resolved_path', 'version_digest'], 'live_reviewed_contract');
  const adapter = ADAPTERS[value.adapter]; required(adapter, 'live_reviewed_contract');
  for (const key of ['executable_digest', 'version_digest']) required(typeof value[key] === 'string' && SHA256.test(value[key]), 'live_reviewed_contract');
  for (const key of ['executable_path', 'resolved_path']) required(typeof value[key] === 'string' && path.isAbsolute(value[key]) && SAFE_TEXT(value[key]), 'live_reviewed_contract');
  return Object.freeze({ adapter, executable_digest: value.executable_digest, executable_path: value.executable_path, resolved_path: value.resolved_path, version_digest: value.version_digest });
}
function observedIdentity() { return Object.freeze({ harness_digest: digest(fs.readFileSync(__filename)), source_digest: digest(fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'))), workload_digest: digest(SAFE_WORKLOAD) }); }
function caps(runtime) {
  const selected = runtime?.test_caps || CAPS;
  exact(selected, ['max_elapsed_ms', 'max_output_bytes', 'max_provider_turns', 'max_version_output_bytes'], 'live_caps');
  for (const key of Object.keys(CAPS)) required(Number.isSafeInteger(selected[key]) && selected[key] > 0 && selected[key] <= CAPS[key], 'live_caps');
  return Object.freeze({ ...selected });
}
function executable(contract, filename) {
  required(typeof filename === 'string' && path.isAbsolute(filename) && SAFE_TEXT(filename), 'live_executable');
  let source, resolved, target; try { source = fs.lstatSync(filename); resolved = fs.realpathSync(filename); target = fs.statSync(resolved); } catch { throw new LiveCompatibilityError('live_executable'); }
  required((source.isFile() || source.isSymbolicLink()) && target.isFile() && (target.mode & 0o111) !== 0 && filename === contract.executable_path && resolved === contract.resolved_path, 'live_executable');
  const bytes = fs.readFileSync(resolved); required(bytes.length > 0 && bytes.length <= 128 * 1024 * 1024, 'live_executable');
  required(digest(bytes) === contract.executable_digest, 'live_executable_not_reviewed');
  return Object.freeze({ path: resolved, digest: contract.executable_digest });
}
function gitMetadataDigest(root) {
  const base = path.join(root, '.git'); const entries = [];
  const baseStat = fs.lstatSync(base); required(baseStat.isDirectory() && !baseStat.isSymbolicLink(), 'live_git_metadata');
  function walk(directory, relative) {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name), child = relative ? `${relative}/${name}` : name, stat = fs.lstatSync(filename);
      required(!stat.isSymbolicLink(), 'live_git_metadata');
      if (stat.isDirectory()) walk(filename, child);
      else { required(stat.isFile() && stat.size <= 512 * 1024, 'live_git_metadata'); entries.push(`${child}:${digest(fs.readFileSync(filename))}`); }
    }
  }
  try { walk(base, ''); } catch (error) { if (error instanceof LiveCompatibilityError) throw error; throw new LiveCompatibilityError('live_git_metadata'); }
  return digest(entries.join('\n'));
}
function rootFacts(root, runtime) {
  const checked = checkedMarkedRoot(root, ROOT_MARKER, new Set([ROOT_MARKER, '.git']), 'live_unsafe_root');
  required(OWNED_ROOTS.has(checked), 'live_root_not_owned');
  required(localGit(runtime, checked, ['remote']).trim() === '', 'live_remote_present'); required(localGit(runtime, checked, ['status', '--porcelain=v1']).trim() === '', 'live_unsafe_root');
  return Object.freeze({ entry_count: fs.readdirSync(checked).length, git_metadata_digest: gitMetadataDigest(checked), remote_count: 0, changed_entry_count: 0 });
}
function profile(adapter, root) { return Object.freeze(adapter.id === 'codex' ? [...adapter.argv, '-C', root, SAFE_WORKLOAD] : [...adapter.argv, SAFE_WORKLOAD]); }
function assertHostIsolation(adapter, compiled, root, runtime) {
  const expected = profile(adapter, root); required(JSON.stringify(compiled) === JSON.stringify(expected), 'live_host_isolation_unavailable');
  if (adapter.id === 'codex') required(compiled.includes('--sandbox') && compiled.includes('read-only') && !compiled.includes('--dangerously-bypass-approvals-and-sandbox'), 'live_host_isolation_unavailable');
  if (adapter.id === 'claude') required(compiled.includes('--restricted') && compiled.includes('--safe-mode') && compiled.includes('--strict-mcp-config') && compiled.includes('--tools') && !compiled.includes('--dangerously-skip-permissions'), 'live_host_isolation_unavailable');
  required(runtime?.test_isolation_unavailable !== true, 'live_host_isolation_unavailable');
}
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
  const root = checkedMarkedRoot(evidenceRoot, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER, 'terminal.json', '.terminal.lock']), 'live_evidence_root'); const filename = path.join(root, 'terminal.json'); required(!fs.existsSync(filename), 'live_terminal_already_recorded');
  const encoded = Buffer.from(JSON.stringify(report) + '\n', 'utf8'); required(encoded.length <= 8 * 1024, 'live_evidence_report'); let fd;
  try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); fs.writeSync(fd, encoded); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.chmodSync(filename, 0o600); const rootFd = fs.openSync(root, 'r'); fs.fsyncSync(rootFd); fs.closeSync(rootFd); } catch (error) { try { if (fd !== undefined) fs.closeSync(fd); } catch {} if (error?.code === 'EEXIST') throw new LiveCompatibilityError('live_terminal_already_recorded'); throw new LiveCompatibilityError('live_evidence_persist'); }
}
function reserveTerminal(evidenceRoot) {
  const root = checkedMarkedRoot(evidenceRoot, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER, 'terminal.json', '.terminal.lock']), 'live_evidence_root'); required(OWNED_EVIDENCE_ROOTS.has(root), 'live_evidence_not_owned');
  const filename = path.join(root, '.terminal.lock'); let fd;
  try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); fs.writeSync(fd, `${process.pid}\n`); fs.fsyncSync(fd); return { fd, filename }; }
  catch (error) { if (error?.code === 'EEXIST') throw new LiveCompatibilityError('live_terminal_already_recorded'); throw new LiveCompatibilityError('live_evidence_persist'); }
}
function releaseReservation(reservation) { try { fs.closeSync(reservation.fd); fs.unlinkSync(reservation.filename); } catch {} }
function terminalReport(contract, selectedCaps, result_class, details = {}) {
  return Object.freeze({ schema_version: 1, purpose: 'live_provider_compatibility_smoke', adapter: contract.adapter.id, model_id: contract.adapter.model_id, role: contract.adapter.role, contract_digest: contract.digest, executable_digest: contract.executable.digest, cli_version_digest: details.cli_version_digest || null, response_digest: details.response_digest || null, response_contract_passed: details.response_contract_passed === true, pre_repository_facts: contract.pre_facts, post_repository_facts: details.post_facts || null, result_class, external_process_started: details.external_process_started === true, output_bytes: Number.isSafeInteger(details.output_bytes) ? details.output_bytes : 0, elapsed_ms: Number.isSafeInteger(details.elapsed_ms) ? details.elapsed_ms : 0, provider_turn_cap: selectedCaps.max_provider_turns });
}

async function runInstalledCompatibility(value, runtime) {
  exact(value, ['adapter', 'evidence_directory', 'executable', 'root_directory'], 'live_run_shape'); const reviewed = REVIEWED_EXECUTIONS[value.adapter]; required(reviewed, 'live_adapter_not_supported'); const contractReview = reviewedContract(reviewed); const adapter = ADAPTERS[value.adapter]; required(adapter && adapter.id === contractReview.adapter.id, 'live_adapter_not_supported'); const selectedCaps = caps(runtime);
  const evidenceRoot = checkedMarkedRoot(value.evidence_directory, EVIDENCE_MARKER, new Set([EVIDENCE_MARKER, 'terminal.json', '.terminal.lock']), 'live_evidence_root'); const reservation = reserveTerminal(evidenceRoot);
  try {
  const root = checkedMarkedRoot(value.root_directory, ROOT_MARKER, new Set([ROOT_MARKER, '.git']), 'live_unsafe_root'); required(OWNED_ROOTS.has(root), 'live_root_not_owned'); required(!fs.existsSync(path.join(evidenceRoot, 'terminal.json')), 'live_terminal_already_recorded');
  const runIdentity = observedIdentity(); const compiled = profile(adapter, root); assertHostIsolation(adapter, compiled, root, runtime); const preFacts = rootFacts(root, runtime); const resolvedExecutable = executable(contractReview, value.executable);
  const contract = Object.freeze({ adapter, executable: resolvedExecutable, identity: runIdentity, pre_facts: preFacts, digest: digest(JSON.stringify({ adapter: adapter.id, model_id: adapter.model_id, executable_digest: resolvedExecutable.digest, identity: runIdentity, profile_digest: digest(JSON.stringify(compiled)), pre_facts: preFacts })) }); const startedAt = Date.now();
  let version; try { version = await capture(runtime, resolvedExecutable.path, ['--version'], { cwd: root, env: sanitizedEnvironment(), max_output_bytes: selectedCaps.max_version_output_bytes, timeout_ms: 5_000 }); } catch { const report = terminalReport(contract, selectedCaps, 'version_failed'); persistTerminal(evidenceRoot, report); return report; }
  const versionDigest = version.output_digest; if (version.timed_out || version.overflow || version.code !== 0 || version.signal || versionDigest !== contractReview.version_digest) { const report = terminalReport(contract, selectedCaps, 'version_failed', { cli_version_digest: versionDigest, output_bytes: version.bytes, elapsed_ms: Date.now() - startedAt }); persistTerminal(evidenceRoot, report); return report; }
  let invocation; try { invocation = await capture(runtime, resolvedExecutable.path, compiled, { cwd: root, env: sanitizedEnvironment(), expected_response: 'QUADWORK_LIVE_OK', max_output_bytes: selectedCaps.max_output_bytes, timeout_ms: selectedCaps.max_elapsed_ms }); } catch { const report = terminalReport(contract, selectedCaps, 'process_failed', { cli_version_digest: versionDigest, external_process_started: true, elapsed_ms: Date.now() - startedAt }); persistTerminal(evidenceRoot, report); return report; }
  let result_class = 'completed'; if (invocation.timed_out) result_class = 'timeout'; else if (invocation.overflow) result_class = 'output_cap_exceeded'; else if (invocation.code !== 0 || invocation.signal) result_class = 'login_or_entitlement_failure'; else if (!invocation.response_ok) result_class = 'response_contract_failed'; let postFacts = null; try { postFacts = rootFacts(root, runtime); if (JSON.stringify(preFacts) !== JSON.stringify(postFacts)) result_class = 'repository_mutated'; } catch { result_class = 'repository_mutated'; }
  const report = terminalReport(contract, selectedCaps, result_class, { cli_version_digest: versionDigest, response_digest: invocation.output_digest, response_contract_passed: invocation.response_ok === true, post_facts: postFacts, external_process_started: true, output_bytes: invocation.bytes, elapsed_ms: Date.now() - startedAt }); persistTerminal(evidenceRoot, report); return report;
  } finally { releaseReservation(reservation); }
}

module.exports = Object.freeze({ ADAPTERS, CAPS, EVIDENCE_MARKER, LiveCompatibilityError, ROOT_MARKER, createDisposableLiveCompatibilityEvidenceRoot, createDisposableLiveCompatibilityRoot, reserveTerminal, runInstalledCompatibility, sanitizedEnvironment });
