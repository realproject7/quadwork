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
function launchClaimState(state) { const key = state?.gate?.authorization_key; if (!/^[a-f0-9]{64}$/.test(key || '')) return 'unverified'; let filename; try { filename = path.join(checkedDirectory(state.gate.ledger_directory, 'reviewed_execution_gate_ledger_unsafe'), `${key}.launch`); } catch { return 'unverified'; } let stat; try { stat = fs.lstatSync(filename); } catch (error) { return error?.code === 'ENOENT' ? 'none' : 'unverified'; } try { const body = `${state.facts.candidate_digest}\n${state.profile.id}\n${key}\n`; return stat.isFile() && !stat.isSymbolicLink() && mode(stat) === 0o600 && sameUser(stat) && fs.readFileSync(filename, 'utf8') === body ? 'claimed' : 'unverified'; } catch { return 'unverified'; } }
function report(profile, facts, fields = {}) { const launch_claim_state = ['none', 'claimed', 'unverified'].includes(fields.launch_claim_state) ? fields.launch_claim_state : 'none'; const provider_turns = launch_claim_state === 'none' ? 0 : 1; const failure_stage = launch_claim_state === 'none' ? 'prelaunch' : fields.failure_stage === 'none' && launch_claim_state === 'claimed' ? 'none' : 'postclaim'; return Object.freeze({ schema_version: 1, purpose: 'reviewed_v2_product_path_live_attempt', profile_id: profile?.id || null, backend: profile?.backend || null, model: profile?.model || null, expected_head: facts?.expected_head || null, candidate_digest: facts?.candidate_digest || null, gate_receipt_digest: fields.gate_receipt_digest || null, result_class: fields.result_class || 'preflight_blocked', provider_turns, launch_claim_state, failure_stage, lifecycle_verified: fields.lifecycle_verified === true, sentinel_digest: fields.sentinel ? sha256('QUADWORK_V2_PRODUCT_PATH_OK') : null, output_bytes: Number.isInteger(fields.output_bytes) ? fields.output_bytes : 0, output_capped: fields.output_capped === true, elapsed_ms: Number.isInteger(fields.elapsed_ms) ? fields.elapsed_ms : 0, root_cleanup_ok: fields.root_cleanup_ok === true, survivor_free: fields.survivor_free === true, source_rechecked_before_prompt: fields.rechecked === true, gate_rechecked_before_prompt: fields.rechecked === true, pre_root_facts: fields.pre ? { root_digest: fields.pre.root_digest, entry_digest: fields.pre.entry_digest, entry_count: fields.pre.entry_count, remote_count: 0, changed_entry_count: 0 } : null, post_root_facts: fields.post ? { root_digest: fields.post.root_digest, entry_digest: fields.post.entry_digest, entry_count: fields.post.entry_count, remote_count: 0, changed_entry_count: 0 } : null, credential_copy_or_store_api_used: false, keychain_immutability_claimed: false, peer_level_network_filter_available: false, release_evidence: false }); }
function removeOwnedRoot(root) { try { safeRoot(root); fs.rmSync(root, { recursive: true, force: false, maxRetries: 0 }); return !fs.existsSync(root); } catch { return false; } }
function writeConfig(prepared) {
  const root = safeRoot(prepared.root), home = checkedDirectory(path.join(root, 'home'), 'reviewed_execution_home_unsafe'), dir = path.join(home, '.quadwork'); fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700); checkedDirectory(dir, 'reviewed_execution_config_unsafe'); const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(prepared.config), { mode: 0o600, flag: 'wx' }); fs.chmodSync(file, 0o600); return { root, home };
}
async function prepareFixedChild(profile) {
  if (!parentAdmitted || !profile || fixed) throw new Error('reviewed_execution_child_state'); const started = Date.now(); let facts, gate, prepared;
  try { facts = sourceFacts(); gate = readGateReceipt(profile, facts); const parent = path.join(os.tmpdir(), 'quadwork-v2-reviewed-executor'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chmodSync(parent, 0o700); checkedDirectory(parent, 'reviewed_execution_executor_parent_unsafe'); const root = productPath.createDisposableProductPathRoot({ parent_dir: parent }); const sandboxDirectory = path.join(root, 'home', '.reviewed-execution'); fs.mkdirSync(sandboxDirectory, { mode: 0o700 }); fs.chmodSync(sandboxDirectory, 0o700); const sandbox = contract.createSandbox({ profile_id: profile.id, candidate_digest: facts.candidate_digest, disposable_root: root, ledger_directory: gate.ledger_directory, sandbox_directory: sandboxDirectory }); const binding = Object.freeze({ candidate_digest: facts.candidate_digest, disposable_root: root, ledger_directory: gate.ledger_directory, authorization_key: gate.authorization_key, sandbox_profile: sandbox.path, sandbox_digest: sandbox.digest }); const preflight = await contract.preflight({ profile_id: profile.id, ...binding, home: path.join(root, 'home') });
    const repository = path.join(root, 'repository');
    const agent = { cwd: repository, command: profile.executable, command_identity: profile.backend, model: profile.model, auto_approve: false, mcp_inject: 'none', reviewed_execution_id: profile.id, reviewed_execution_candidate_digest: binding.candidate_digest, reviewed_execution_root: binding.disposable_root, reviewed_execution_ledger_directory: binding.ledger_directory, reviewed_execution_authorization_key: binding.authorization_key, reviewed_execution_sandbox_profile: binding.sandbox_profile, reviewed_execution_sandbox_digest: binding.sandbox_digest };
    const project = { id: profiles.PROJECT, name: 'Reviewed V2 product path', idle: true, chat_mode: 'file', repositories: [{ key: 'benchmark', repo: 'local/benchmark', working_dir: repository, primary: true }], agents: { [profile.role]: agent } };
    prepared = { root, binding, preflight, config: { port: 18991, installation_id: 'benchmark_product_path_0001', session_token: crypto.randomBytes(32).toString('hex'), temp_cleanup: { enabled: false }, projects: [project] } };
    if (preflight?.result_class !== 'preflight_ready') return report(profile, facts, { gate_receipt_digest: gate.receipt_digest, launch_claim_state: 'none', failure_stage: 'prelaunch', elapsed_ms: Date.now() - started, root_cleanup_ok: removeOwnedRoot(root), survivor_free: true });
    const locations = writeConfig(prepared); const pre = rootFacts(root); const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, QUADWORK_SKIP_LISTEN: process.env.QUADWORK_SKIP_LISTEN, QUADWORK_REVIEWED_GATE_HOME: process.env.QUADWORK_REVIEWED_GATE_HOME }; process.env.HOME = locations.home; process.env.USERPROFILE = locations.home; process.env.QUADWORK_SKIP_LISTEN = '1'; process.env.QUADWORK_REVIEWED_GATE_HOME = REVIEWED_GATE_HOME; fixed = Object.freeze({ profile, facts, gate, root, locations, pre, previous, started }); return null;
  } catch { const root_cleanup_ok = prepared?.root ? removeOwnedRoot(prepared.root) : false; return report(profile, facts, { gate_receipt_digest: gate?.receipt_digest || null, launch_claim_state: 'none', failure_stage: 'prelaunch', elapsed_ms: Date.now() - started, root_cleanup_ok, survivor_free: true }); }
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
  let provider_turns = 0, launch_claim_state = 'none', lifecycle_verified = false, rechecked = false, stopped = null, shutdown = null, post = null;
  const observer = outcome.createObserver();
  try {
    await runtime.buildAgentArgs(profiles.PROJECT, role);
    runtime.buildAgentEnv(profiles.PROJECT, role);
    const launched = await runtime.launch();
    launch_claim_state = launchClaimState(state);
    provider_turns = launch_claim_state === 'none' ? 0 : 1;
    const session = launched?.reviewed_session;
    if (!launched?.ok || !session || typeof session.onData !== 'function' || typeof session.writeFixedWorkload !== 'function') throw new Error('launch');
    session.onData(chunk => observer.push(chunk));
    const fresh = sourceFacts();
    readGateReceipt(state.profile, fresh);
    if (fresh.expected_head !== state.facts.expected_head || fresh.candidate_digest !== state.facts.candidate_digest || observer.snapshot().output_capped) throw new Error('drift');
    rechecked = true;
    session.writeFixedWorkload();
    const until = Date.now() + MAX_ELAPSED_MS;
    while (Date.now() < until && !observer.snapshot().output_capped && !observer.snapshot().sentinel) await new Promise(resolve => setTimeout(resolve, 25));
    const observed = observer.snapshot();
    try { const lifecycle = JSON.parse(fs.readFileSync(path.join(state.locations.home, '.quadwork', profiles.PROJECT, 'agent-lifecycle-state.json'), 'utf8')); lifecycle_verified = lifecycle?.roles?.[role]?.state === 'verified'; } catch {}
    stopped = await runtime.stopAgentSession(`${profiles.PROJECT}/${role}`, { suppressLifecycleMsg: true, removeEntry: true });
    shutdown = await runtime.shutdown();
    post = rootFacts(state.root);
    const survivor_free = survivorFree(stopped);
    const postcondition_ok = rootMatches(state.pre, post);
    const root_removed = removeOwnedRoot(state.root);
    const root_clean = postcondition_ok && root_removed;
    const environment_restored = restore();
    const decision = outcome.finalizeEffects({ provider_turns, lifecycle: lifecycle_verified ? 'verified' : 'unverified', sentinel: observed.sentinel, output_capped: observed.output_capped, timed_out: !observed.sentinel && !observed.output_capped, effects: { stop: () => stopped?.ok === true, shutdown: () => shutdown?.ok === true, survivor: () => survivor_free, root: () => root_clean, git: () => post !== null, environment: () => environment_restored } });
    return report(state.profile, state.facts, { gate_receipt_digest: state.gate.receipt_digest, result_class: decision.result_class, launch_claim_state, failure_stage: decision.result_class === 'completed' ? 'none' : 'postclaim', lifecycle_verified: decision.lifecycle_verified, sentinel: observed.sentinel, output_bytes: observed.output_bytes, output_capped: observed.output_capped, elapsed_ms: Date.now() - state.started, root_cleanup_ok: decision.root_cleanup_ok, survivor_free: decision.survivor_free, rechecked, pre: state.pre, post });
  } catch {
    launch_claim_state = launchClaimState(state);
    provider_turns = launch_claim_state === 'none' ? 0 : 1;
    try { if (provider_turns) stopped = await runtime.stopAgentSession(`${profiles.PROJECT}/${role}`, { suppressLifecycleMsg: true, removeEntry: true }); } catch {}
    try { if (provider_turns) shutdown = await runtime.shutdown(); } catch {}
    try { post = rootFacts(state.root); } catch {}
    const observed = observer.snapshot();
    const survivor_free = provider_turns === 0 || survivorFree(stopped);
    const postcondition_ok = rootMatches(state.pre, post);
    const root_removed = removeOwnedRoot(state.root);
    const root_clean = root_removed && postcondition_ok;
    const environment_restored = restore();
    const decision = outcome.finalizeEffects({ provider_turns, lifecycle: 'unverified', launch: provider_turns ? undefined : false, sentinel: false, output_capped: observed.output_capped, timed_out: provider_turns > 0, effects: { stop: () => provider_turns === 0 || stopped?.ok === true, shutdown: () => provider_turns === 0 || shutdown?.ok === true, survivor: () => survivor_free, root: () => root_clean, git: () => post !== null, environment: () => environment_restored } });
    return report(state.profile, state.facts, { gate_receipt_digest: state.gate.receipt_digest, result_class: decision.result_class, launch_claim_state, failure_stage: launch_claim_state === 'none' ? 'prelaunch' : 'postclaim', output_bytes: observed.output_bytes, output_capped: observed.output_capped, elapsed_ms: Date.now() - state.started, root_cleanup_ok: decision.root_cleanup_ok, survivor_free: decision.survivor_free, rechecked, pre: state.pre, post });
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
