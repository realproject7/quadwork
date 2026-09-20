'use strict';

// The parent runner never imports the server and never receives a PTY.  This
// module is process-local state for one fixed child entry only.  It does not
// export a launch function: the only launch callback is created in
// server/index.js' closure after this child has installed its isolated HOME.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const contract = require('./reviewed-execution-contract.cjs');
const productPath = require('./v2-product-path-core.cjs');
const profiles = require('../server/reviewed-execution-profiles');
const outcome = require('./reviewed-execution-live-outcome.cjs');

const REVIEWED_GATE_HOME = os.homedir();
const GATE_PARENT = path.join(os.homedir(), 'Library', 'Application Support', 'QuadWork', 'reviewed-execution-gates');
const LEDGER_PARENT = path.join(os.homedir(), 'Library', 'Application Support', 'QuadWork', 'reviewed-execution-ledger-parent');
const MAX_OUTPUT_BYTES = outcome.OUTPUT_CAP_BYTES;
const MAX_ELAPSED_MS = 45_000;
const MAX_GATE_AGE_MS = 15 * 60 * 1000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const mode = stat => stat.mode & 0o777;
const sameUser = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
let fixed = null;
let channelSecret = null;
let parentAdmitted = false;

function checkedDirectory(directory, code) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o700 || !sameUser(stat)) throw new Error(code);
  return fs.realpathSync(directory);
}
function git(repository, args) {
  return execFileSync('/usr/bin/git', ['-c', 'credential.helper=', ...args], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 3000, env: { HOME: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', PATH: process.env.PATH || '' } }).trim();
}
function sourceFacts(repository = path.resolve(__dirname, '..')) {
  try { const expected_head = git(repository, ['rev-parse', 'HEAD']); if (!/^[a-f0-9]{40}$/.test(expected_head) || git(repository, ['status', '--porcelain=v1']) !== '') throw new Error('state'); return Object.freeze({ expected_head, candidate_digest: profiles.candidateDigest(repository) }); }
  catch { throw new Error('reviewed_execution_source_drift'); }
}
function gateFilename(parent, profile, candidate) { return path.join(parent, `${profile.id}-${candidate}.json`); }
function readGateReceipt(profile, facts, gateParent = GATE_PARENT, now = Date.now(), ledgerParent = LEDGER_PARENT) {
  const parent = checkedDirectory(gateParent, 'reviewed_execution_gate_parent_unsafe'); const file = gateFilename(parent, profile, facts.candidate_digest);
  let stat, receipt; try { stat = fs.lstatSync(file); receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('reviewed_execution_gate_missing'); }
  const keys = ['schema_version', 'reviewed_head', 'reviewed_candidate_digest', 'expected_head', 'candidate_digest', 'profile_id', 'authorization_id', 'recorded_at', 'actions', 'cache', 'artifacts'];
  if (!stat.isFile() || stat.isSymbolicLink() || mode(stat) !== 0o600 || !sameUser(stat) || Object.keys(receipt).sort().join(',') !== keys.sort().join(',') || receipt.schema_version !== 1 || receipt.reviewed_head !== facts.expected_head || receipt.reviewed_candidate_digest !== facts.candidate_digest || receipt.expected_head !== facts.expected_head || receipt.candidate_digest !== facts.candidate_digest || receipt.profile_id !== profile.id || receipt.actions?.enabled !== false || receipt.cache?.active_size_bytes !== 0 || receipt.artifacts?.nonexpired_size_bytes !== 0 || !/^[a-z0-9-]{16,128}$/.test(receipt.authorization_id)) throw new Error('reviewed_execution_gate_drift');
  const recorded = Date.parse(receipt.recorded_at); if (!Number.isSafeInteger(recorded) || recorded > now || now - recorded > MAX_GATE_AGE_MS) throw new Error('reviewed_execution_gate_drift');
  const ledger = checkedDirectory(path.join(ledgerParent, contract.LEDGER_NAME), 'reviewed_execution_gate_ledger_unsafe'); const authorization_key = contract.authorizationKey(facts.candidate_digest, profile.id, receipt.authorization_id); const authorization = path.join(ledger, `${authorization_key}.json`);
  let auth; try { const authStat = fs.lstatSync(authorization); if (!authStat.isFile() || authStat.isSymbolicLink() || mode(authStat) !== 0o600 || !sameUser(authStat)) throw new Error('bad'); auth = JSON.parse(fs.readFileSync(authorization, 'utf8')); } catch { throw new Error('reviewed_execution_gate_authorization_missing'); }
  if (auth?.candidate_digest !== facts.candidate_digest || auth?.profile_id !== profile.id || auth?.authorization_id !== receipt.authorization_id || auth?.authorization_key !== authorization_key) throw new Error('reviewed_execution_gate_authorization_invalid');
  return Object.freeze({ ledger_directory: ledger, authorization_key, receipt_digest: sha256(fs.readFileSync(file)) });
}
function safeRoot(root) {
  const stat = fs.lstatSync(root), marker = path.join(root, '.quadwork-v2-product-path-root-v1'), markerStat = fs.lstatSync(marker);
  if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o700 || !sameUser(stat) || !markerStat.isFile() || markerStat.isSymbolicLink() || mode(markerStat) !== 0o600 || fs.readFileSync(marker, 'utf8') !== 'quadwork-v2-product-path-v1\n') throw new Error('reviewed_execution_root_unsafe');
  return fs.realpathSync(root);
}
function rootFacts(root) {
  const checked = safeRoot(root); const repository = checkedDirectory(path.join(checked, 'repository'), 'reviewed_execution_repository_unsafe');
  if (git(repository, ['remote']) !== '' || git(repository, ['status', '--porcelain=v1']) !== '') throw new Error('reviewed_execution_repository_changed');
  const entries = []; const walk = (dir, relative = '') => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name), rel = relative ? `${relative}/${name}` : name, stat = fs.lstatSync(file), gitMetadata = rel === 'repository/.git' || rel.startsWith('repository/.git/'); if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || !sameUser(stat) || (!gitMetadata && mode(stat) !== 0o700 && mode(stat) !== 0o600) || (gitMetadata && (mode(stat) & 0o022) !== 0)) throw new Error('reviewed_execution_root_unsafe'); entries.push(`${rel}:${stat.isDirectory() ? 'd' : 'f'}:${mode(stat).toString(8)}:${stat.isFile() ? sha256(fs.readFileSync(file)) : '-'}`); if (stat.isDirectory()) walk(file, rel); } }; walk(checked); const digest = sha256(entries.join('\n')); return Object.freeze({ root_digest: digest, entry_digest: digest, entry_count: entries.length, entries: Object.freeze(entries) });
}
function rootMatches(pre, post) {
  if (!pre || !post || !Array.isArray(pre.entries) || !Array.isArray(post.entries)) return false;
  const after = new Set(post.entries); if (!pre.entries.every(entry => after.has(entry))) return false;
  return post.entries.every(entry => pre.entries.includes(entry) || /^home\/\.quadwork\/benchmark-product-path:d:700:-$/.test(entry) || /^home\/\.quadwork\/benchmark-product-path\/agent-lifecycle-state\.json:f:600:[a-f0-9]{64}$/.test(entry));
}
function cleanupRootIdentity(root) {
  const checked = safeRoot(root), stat = fs.lstatSync(checked);
  return Object.freeze({ root: checked, device: stat.dev, inode: stat.ino });
}
function checkedCleanupRoot(identity) {
  if (!identity || typeof identity.root !== 'string' || !Number.isSafeInteger(identity.device) || !Number.isSafeInteger(identity.inode)) throw new Error('reviewed_execution_cleanup_root_unsafe');
  const stat = fs.lstatSync(identity.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameUser(stat) || stat.dev !== identity.device || stat.ino !== identity.inode || fs.realpathSync(identity.root) !== identity.root) throw new Error('reviewed_execution_cleanup_root_unsafe');
  return identity.root;
}
function cleanupCodexFinalMessage(identity) {
  // Cleanup deliberately does not re-check the mutable root marker.  The
  // captured directory identity is sufficient to unlink only the fixed
  // basename. lstat/unlink never follows a final-message symlink.
  let filename;
  try {
    filename = profiles.codexFinalMessagePath(checkedCleanupRoot(identity));
    const stat = fs.lstatSync(filename);
    if ((!stat.isFile() && !stat.isSymbolicLink()) || !sameUser(stat)) return false;
    fs.unlinkSync(filename);
    return !fs.existsSync(filename);
  } catch (error) { return error?.code === 'ENOENT'; }
}
// Codex's final-message file is a transient completion channel.  It is
// created only after pre-root facts have been captured, never follows a
// symlink, and is removed before every post-root observation.  Its contents
// are reduced immediately to a boolean/digest fact and never leave this child.
function createCodexFinalMessage(root, cleanup_root) {
  let fd;
  try {
    const filename = profiles.codexFinalMessagePath(safeRoot(root));
    fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.chmodSync(filename, 0o600);
  } catch {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    cleanupCodexFinalMessage(cleanup_root);
    throw new Error('reviewed_execution_final_message_create');
  }
}
function consumeCodexFinalMessage(root, cleanup_root) {
  const expected = Buffer.from(outcome.SENTINEL, 'utf8'); let fd;
  try {
    const filename = profiles.codexFinalMessagePath(safeRoot(root));
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || mode(stat) !== 0o600 || !sameUser(stat) || stat.size !== expected.length) return false;
    const bytes = Buffer.alloc(expected.length); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (count <= 0) return false; offset += count; }
    return crypto.timingSafeEqual(bytes, expected);
  } catch { return false; }
  finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    cleanupCodexFinalMessage(cleanup_root);
  }
}
function launchClaimState(state) { const key = state?.gate?.authorization_key; if (!/^[a-f0-9]{64}$/.test(key || '')) return 'unverified'; let filename; try { filename = path.join(checkedDirectory(state.gate.ledger_directory, 'reviewed_execution_gate_ledger_unsafe'), `${key}.launch`); } catch { return 'unverified'; } let stat; try { stat = fs.lstatSync(filename); } catch (error) { return error?.code === 'ENOENT' ? 'none' : 'unverified'; } try { const body = `${state.facts.candidate_digest}\n${state.profile.id}\n${key}\n`; return stat.isFile() && !stat.isSymbolicLink() && mode(stat) === 0o600 && sameUser(stat) && fs.readFileSync(filename, 'utf8') === body ? 'claimed' : 'unverified'; } catch { return 'unverified'; } }
function report(profile, facts, fields = {}) {
  const launch_claim_state = ['none', 'claimed', 'unverified'].includes(fields.launch_claim_state) ? fields.launch_claim_state : 'none';
  const provider_turns = launch_claim_state === 'none' ? 0 : 1;
  const failure_stage = launch_claim_state === 'none' ? 'prelaunch' : fields.failure_stage === 'none' && launch_claim_state === 'claimed' ? 'none' : 'postclaim';
  const launch_diagnostic = ['none', 'pty_unavailable_after_claim', 'pty_exited_before_observation'].includes(fields.launch_diagnostic) ? fields.launch_diagnostic : 'none';
  const terminal_exit_phase = ['none', 'before_workload_attempt', 'after_workload_attempt', 'after_launch_submission'].includes(fields.terminal_exit_phase) ? fields.terminal_exit_phase : 'none';
  const result_class = fields.result_class || 'preflight_blocked';
  const requested_early_exit = outcome.EARLY_EXIT_DIAGNOSTICS.includes(fields.early_exit_diagnostic) ? fields.early_exit_diagnostic : 'none';
  const early_exit_context = provider_turns === 1 && failure_stage === 'postclaim' && terminal_exit_phase !== 'none'
    && ((result_class === 'launch_indeterminate' && launch_diagnostic === 'pty_exited_before_observation' && fields.output_capped !== true) || (result_class === 'output_cap_exceeded' && fields.output_capped === true));
  const early_exit_diagnostic = requested_early_exit !== 'none' && early_exit_context ? requested_early_exit : 'none';
  const cleanup_attestation = outcome.CLEANUP_ATTESTATIONS.includes(fields.cleanup_attestation) ? fields.cleanup_attestation : fields.root_cleanup_ok === true ? 'none' : 'unverified';
  return Object.freeze({ schema_version: 1, purpose: 'reviewed_v2_product_path_live_attempt', profile_id: profile?.id || null, backend: profile?.backend || null, model: profile?.model || null, expected_head: facts?.expected_head || null, candidate_digest: facts?.candidate_digest || null, gate_receipt_digest: fields.gate_receipt_digest || null, result_class, provider_turns, launch_claim_state, failure_stage, launch_diagnostic, early_exit_diagnostic, pre_observer_pty_data_seen: fields.pre_observer_pty_data_seen === true, pre_workload_output_seen: fields.pre_workload_output_seen === true, workload_write_attempted: fields.workload_write_attempted === true, workload_submitted_at_launch: fields.workload_submitted_at_launch === true, terminal_exit_phase, worker_report_disposition: 'none', lifecycle_verified: fields.lifecycle_verified === true, sentinel_digest: fields.sentinel ? sha256('QUADWORK_V2_PRODUCT_PATH_OK') : null, output_bytes: Number.isInteger(fields.output_bytes) ? fields.output_bytes : 0, output_capped: fields.output_capped === true, elapsed_ms: Number.isInteger(fields.elapsed_ms) ? fields.elapsed_ms : 0, root_cleanup_ok: fields.root_cleanup_ok === true, survivor_free: fields.survivor_free === true, cleanup_attestation, source_rechecked_before_prompt: fields.rechecked === true, gate_rechecked_before_prompt: fields.rechecked === true, pre_root_facts: fields.pre ? { root_digest: fields.pre.root_digest, entry_digest: fields.pre.entry_digest, entry_count: fields.pre.entry_count, remote_count: 0, changed_entry_count: 0 } : null, post_root_facts: fields.post ? { root_digest: fields.post.root_digest, entry_digest: fields.post.entry_digest, entry_count: fields.post.entry_count, remote_count: 0, changed_entry_count: 0 } : null, credential_copy_or_store_api_used: false, keychain_immutability_claimed: false, peer_level_network_filter_available: false, release_evidence: false });
}
function removeOwnedRoot(root) { try { safeRoot(root); fs.rmSync(root, { recursive: true, force: false, maxRetries: 0 }); return !fs.existsSync(root); } catch { return false; } }
function writeConfig(prepared) {
  const root = safeRoot(prepared.root), home = checkedDirectory(path.join(root, 'home'), 'reviewed_execution_home_unsafe'), dir = path.join(home, '.quadwork'); fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700); checkedDirectory(dir, 'reviewed_execution_config_unsafe'); const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(prepared.config), { mode: 0o600, flag: 'wx' }); fs.chmodSync(file, 0o600); return { root, home };
}
async function prepareFixedChild(profile) {
  if (!parentAdmitted || !profile || fixed) throw new Error('reviewed_execution_child_state'); const started = Date.now(); let facts, gate, prepared;
  try { facts = sourceFacts(); gate = readGateReceipt(profile, facts); const parent = path.join(os.tmpdir(), 'quadwork-v2-reviewed-executor'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(parent, 0o700); checkedDirectory(parent, 'reviewed_execution_executor_parent_unsafe'); const root = productPath.createDisposableProductPathRoot({ parent_dir: parent }); prepared = { root }; const sandboxDirectory = path.join(root, 'home', '.reviewed-execution'); fs.mkdirSync(sandboxDirectory, { mode: 0o700 }); fs.chmodSync(sandboxDirectory, 0o700); const sandbox = contract.createSandbox({ profile_id: profile.id, candidate_digest: facts.candidate_digest, disposable_root: root, ledger_directory: gate.ledger_directory, sandbox_directory: sandboxDirectory }); const binding = Object.freeze({ candidate_digest: facts.candidate_digest, disposable_root: root, ledger_directory: gate.ledger_directory, authorization_key: gate.authorization_key, sandbox_profile: sandbox.path, sandbox_digest: sandbox.digest }); const preflight = await contract.preflight({ profile_id: profile.id, ...binding, home: path.join(root, 'home') });
    const repository = path.join(root, 'repository');
    const agent = { cwd: repository, command: profile.executable, command_identity: profile.backend, model: profile.model, auto_approve: false, mcp_inject: 'none', reviewed_execution_id: profile.id, reviewed_execution_candidate_digest: binding.candidate_digest, reviewed_execution_root: binding.disposable_root, reviewed_execution_ledger_directory: binding.ledger_directory, reviewed_execution_authorization_key: binding.authorization_key, reviewed_execution_sandbox_profile: binding.sandbox_profile, reviewed_execution_sandbox_digest: binding.sandbox_digest };
    const project = { id: profiles.PROJECT, name: 'Reviewed V2 product path', idle: true, chat_mode: 'file', repositories: [{ key: 'benchmark', repo: 'local/benchmark', working_dir: repository, primary: true }], agents: { [profile.role]: agent } };
    prepared = { root, binding, preflight, config: { port: 18991, installation_id: 'benchmark_product_path_0001', session_token: crypto.randomBytes(32).toString('hex'), temp_cleanup: { enabled: false }, projects: [project] } };
    if (preflight?.result_class !== 'preflight_ready') { const root_cleanup_ok = removeOwnedRoot(root); return report(profile, facts, { gate_receipt_digest: gate.receipt_digest, result_class: preflight?.result_class === 'provider_state_unavailable' ? 'provider_state_unavailable' : 'preflight_blocked', launch_claim_state: 'none', failure_stage: 'prelaunch', elapsed_ms: Date.now() - started, root_cleanup_ok, survivor_free: true, cleanup_attestation: root_cleanup_ok ? 'none' : 'root' }); }
    const locations = writeConfig(prepared); const pre = rootFacts(root); const cleanup_root = cleanupRootIdentity(root); const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_SKIP_LISTEN: process.env.QUADWORK_SKIP_LISTEN, QUADWORK_REVIEWED_GATE_HOME: process.env.QUADWORK_REVIEWED_GATE_HOME }; process.env.HOME = locations.home; process.env.USERPROFILE = locations.home; process.env.QUADWORK_SKIP_LISTEN = '1'; process.env.QUADWORK_REVIEWED_GATE_HOME = REVIEWED_GATE_HOME; fixed = Object.freeze({ profile, facts, gate, root, cleanup_root, locations, pre, previous, started }); return null;
  } catch (error) { const root_cleanup_ok = prepared?.root ? removeOwnedRoot(prepared.root) : false; return report(profile, facts, { gate_receipt_digest: gate?.receipt_digest || null, result_class: error?.message === 'reviewed_execution_provider_state_unavailable' ? 'provider_state_unavailable' : 'preflight_blocked', launch_claim_state: 'none', failure_stage: 'prelaunch', elapsed_ms: Date.now() - started, root_cleanup_ok, survivor_free: true, cleanup_attestation: root_cleanup_ok ? 'none' : 'root' }); }
}
function restore() { if (!fixed) return false; for (const [key, value] of Object.entries(fixed.previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } return process.env.HOME === fixed.previous.HOME && process.env.USERPROFILE === fixed.previous.USERPROFILE && process.env.QUADWORK_SKIP_LISTEN === fixed.previous.QUADWORK_SKIP_LISTEN && process.env.QUADWORK_REVIEWED_GATE_HOME === fixed.previous.QUADWORK_REVIEWED_GATE_HOME; }
// A claimed launch can fail before node-pty hands back a terminal.  The server
// records that state as a term-less session; successful removal of that one
// session is an attestation that no owned terminal survives, not a missing
// cleanup observation.  Any other count remains unverified.
function survivorFree(stopped) { return stopped?.ok === true && stopped?.resources?.sessions === 1 && (stopped?.resources?.ptys === 0 || stopped?.resources?.ptys === 1); }
async function completeFixedChild(role, runtime) {
  const state = fixed;
  if (!parentAdmitted || !state || state.profile.role !== role || !runtime || typeof runtime.launch !== 'function') throw new Error('reviewed_execution_child_state');
  let provider_turns = 0, launch_claim_state = 'none', lifecycle_verified = false, rechecked = false, stopped = null, shutdown = null, post = null, launch_diagnostic = 'none';
  const observer = outcome.createObserver(state.profile); const codex = state.profile.backend === 'codex'; let terminal_exited = false, pre_observer_pty_data_seen = false, pre_workload_output_seen = false, workload_write_attempted = false, workload_submitted_at_launch = false, terminal_exit_phase = 'none';
  try {
    await runtime.buildAgentArgs(profiles.PROJECT, role);
    runtime.buildAgentEnv(profiles.PROJECT, role);
    // This must be after the pre-root snapshot from prepareFixedChild().  The
    // fixed argv already names this path; creation cannot be influenced by a
    // terminal write or by provider output.
    if (codex) createCodexFinalMessage(state.root, state.cleanup_root);
    const launched = await runtime.launch();
    launch_claim_state = launchClaimState(state);
    provider_turns = launch_claim_state === 'none' ? 0 : 1;
    workload_submitted_at_launch = codex && launched?.ok === true;
    const session = launched?.reviewed_session;
    if (launched?.reviewed_launch_diagnostic === 'pty_unavailable_after_claim') launch_diagnostic = 'pty_unavailable_after_claim';
    if (!launched?.ok || !session || typeof session.onData !== 'function' || typeof session.preObserverPtyDataSeen !== 'function' || (!codex && typeof session.writeFixedWorkload !== 'function')) throw new Error('launch');
    session.onData(chunk => observer.push(chunk));
    pre_observer_pty_data_seen = session.preObserverPtyDataSeen() === true;
    pre_workload_output_seen = pre_observer_pty_data_seen || observer.snapshot().output_bytes > 0;
    if (typeof session.onExit === 'function') session.onExit(() => { terminal_exited = true; terminal_exit_phase = workload_write_attempted ? 'after_workload_attempt' : workload_submitted_at_launch ? 'after_launch_submission' : 'before_workload_attempt'; });
    const fresh = sourceFacts();
    readGateReceipt(state.profile, fresh);
    if (fresh.expected_head !== state.facts.expected_head || fresh.candidate_digest !== state.facts.candidate_digest || observer.snapshot().output_capped) throw new Error('drift');
    rechecked = true;
    pre_workload_output_seen = pre_workload_output_seen || observer.snapshot().output_bytes > 0;
    if (!codex) { workload_write_attempted = true; session.writeFixedWorkload(); }
    const until = Date.now() + MAX_ELAPSED_MS;
    while (Date.now() < until && !terminal_exited && !observer.snapshot().output_capped && (codex || !observer.snapshot().sentinel)) await new Promise(resolve => setTimeout(resolve, 25));
    // Stop/shutdown itself emits a terminal exit. Freeze the observation
    // before cleanup so that expected teardown cannot masquerade as a launch
    // exit which occurred before any provider observation.
    const observed = observer.snapshot(), terminal_exited_before_observation = terminal_exited;
    // Terminal bytes are never a Codex completion signal.  Only the regular,
    // owned, exact-sentinel final-message file can set this fact, and consume
    // removes that file before root facts are captured below.
    const final_message_valid = codex ? consumeCodexFinalMessage(state.root, state.cleanup_root) : false;
    // The server observes the exact launched PTY and confirms its durable
    // generation. A status-only file read could accept a different generation
    // or lose a real ready observation when Codex exits before this check.
    try { lifecycle_verified = typeof session.lifecycleVerified === 'function' && await session.lifecycleVerified() === true; } catch {}
    stopped = await runtime.stopAgentSession(`${profiles.PROJECT}/${role}`, { suppressLifecycleMsg: true, removeEntry: true });
    shutdown = await runtime.shutdown();
    post = rootFacts(state.root);
    const survivor_free = survivorFree(stopped);
    const postcondition_ok = rootMatches(state.pre, post);
    const root_removed = removeOwnedRoot(state.root);
    const root_clean = postcondition_ok && root_removed;
    const environment_restored = restore();
    const completion_sentinel = codex ? final_message_valid : observed.sentinel;
    const early_exit_diagnostic = terminal_exited_before_observation && !completion_sentinel ? outcome.earlyExitDiagnostic(observed) : 'none';
    if (terminal_exited_before_observation && !completion_sentinel && !observed.output_capped) launch_diagnostic = 'pty_exited_before_observation';
    const decision = outcome.finalizeEffects({ provider_turns, lifecycle: lifecycle_verified ? 'verified' : 'unverified', sentinel: completion_sentinel, output_capped: observed.output_capped, terminal_exited: terminal_exited_before_observation && !completion_sentinel && !observed.output_capped, timed_out: !terminal_exited_before_observation && !completion_sentinel && !observed.output_capped, effects: { stop: () => stopped?.ok === true, shutdown: () => shutdown?.ok === true, survivor: () => survivor_free, root: () => root_clean, git: () => post !== null, environment: () => environment_restored } });
    return report(state.profile, state.facts, { gate_receipt_digest: state.gate.receipt_digest, result_class: decision.result_class, launch_claim_state, failure_stage: decision.result_class === 'completed' ? 'none' : 'postclaim', launch_diagnostic, early_exit_diagnostic, pre_observer_pty_data_seen, pre_workload_output_seen, workload_write_attempted, workload_submitted_at_launch, terminal_exit_phase, lifecycle_verified: decision.lifecycle_verified, sentinel: completion_sentinel, output_bytes: observed.output_bytes, output_capped: observed.output_capped, elapsed_ms: Date.now() - state.started, root_cleanup_ok: decision.root_cleanup_ok, survivor_free: decision.survivor_free, cleanup_attestation: decision.cleanup_attestation, rechecked, pre: state.pre, post });
  } catch {
    launch_claim_state = launchClaimState(state);
    provider_turns = launch_claim_state === 'none' ? 0 : 1;
    try { if (provider_turns) stopped = await runtime.stopAgentSession(`${profiles.PROJECT}/${role}`, { suppressLifecycleMsg: true, removeEntry: true }); } catch {}
    try { if (provider_turns) shutdown = await runtime.shutdown(); } catch {}
    if (codex) cleanupCodexFinalMessage(state.cleanup_root);
    try { post = rootFacts(state.root); } catch {}
    const observed = observer.snapshot();
    const survivor_free = provider_turns === 0 || survivorFree(stopped);
    const postcondition_ok = rootMatches(state.pre, post);
    const root_removed = removeOwnedRoot(state.root);
    const root_clean = root_removed && postcondition_ok;
    const environment_restored = restore();
    const decision = outcome.finalizeEffects({ provider_turns, lifecycle: 'unverified', launch: provider_turns ? undefined : false, sentinel: false, output_capped: observed.output_capped, terminal_exited: launch_diagnostic === 'pty_unavailable_after_claim', timed_out: provider_turns > 0 && launch_diagnostic === 'none', effects: { stop: () => provider_turns === 0 || stopped?.ok === true, shutdown: () => provider_turns === 0 || shutdown?.ok === true, survivor: () => survivor_free, root: () => root_clean, git: () => post !== null, environment: () => environment_restored } });
    return report(state.profile, state.facts, { gate_receipt_digest: state.gate.receipt_digest, result_class: decision.result_class, launch_claim_state, failure_stage: launch_claim_state === 'none' ? 'prelaunch' : 'postclaim', launch_diagnostic, pre_observer_pty_data_seen, pre_workload_output_seen, workload_write_attempted, workload_submitted_at_launch, terminal_exit_phase, output_bytes: observed.output_bytes, output_capped: observed.output_capped, elapsed_ms: Date.now() - state.started, root_cleanup_ok: decision.root_cleanup_ok, survivor_free: decision.survivor_free, cleanup_attestation: decision.cleanup_attestation, rechecked, pre: state.pre, post });
  } finally { fixed = null; }
}
function failedChildReport(role) { const profile = Object.values(profiles.PROFILES).find(entry => entry.role === role); return report(profile, null, { result_class: 'attempt_indeterminate' }); }
function sendResultAndAwaitParent(reportValue, exitCode) {
  const nonce = process.env.QUADWORK_REVIEWED_PARENT_NONCE;
  let done = false;
  const finish = code => { if (done) return; done = true; clearTimeout(timer); process.exit(code); };
  const timer = setTimeout(() => finish(1), 2_000);
  timer.unref();
  process.once('message', message => {
    if (message?.type === 'reviewed_execution_result_ack' && message.nonce === nonce) finish(exitCode);
  });
  try { process.send(Object.freeze({ type: 'reviewed_execution_result', report: reportValue }), error => { if (error) finish(1); }); }
  catch { finish(1); }
}
function bootstrapFixedWorker() {
  const role = process.env.QUADWORK_REVIEWED_EXECUTION_CHILD_ROLE; const profile = Object.values(profiles.PROFILES).find(entry => entry.role === role); const nonce = process.env.QUADWORK_REVIEWED_PARENT_NONCE; const candidate = process.env.QUADWORK_REVIEWED_CANDIDATE_DIGEST;
  let selfDigest; try { selfDigest = sha256(fs.readFileSync(process.argv[1])); } catch { return process.exit(1); }
  if (!profile || typeof process.send !== 'function' || !/^[a-f0-9]{64}$/.test(nonce) || candidate !== profiles.candidateDigest() || selfDigest !== process.env.QUADWORK_REVIEWED_WORKER_DIGEST) return process.exit(1);
  try { channelSecret = Buffer.alloc(32); if (fs.readSync(4, channelSecret, 0, 32, null) !== 32) throw new Error('short'); } catch { return process.exit(1); }
  process.send({ type: 'reviewed_execution_ready', nonce, candidate_digest: candidate, worker_digest: process.env.QUADWORK_REVIEWED_WORKER_DIGEST, proof: crypto.createHmac('sha256', channelSecret).update(nonce).digest('hex') });
  process.once('message', message => { if (message?.type !== 'reviewed_execution_admit' || message.nonce !== nonce || !/^[a-f0-9]{64}$/.test(message.admission) || message.proof !== crypto.createHmac('sha256', channelSecret).update(`${nonce}:${message.admission}`).digest('hex')) return process.exit(1); parentAdmitted = true; void prepareFixedChild(profile).then(value => { if (value) sendResultAndAwaitParent(value, 0); else require('../server/index.js'); }).catch(() => sendResultAndAwaitParent(failedChildReport(role), 1)); });
}
// This private module is reachable only from fixed worker/server files. It is
// intentionally absent from the public runner surface and has no test hooks.
module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });
if (process.env.QUADWORK_REVIEWED_EXECUTION_CHILD === '1') bootstrapFixedWorker();
