#!/usr/bin/env node
'use strict';

// #1181. A verification step that runs before any live compatibility pass. It
// confirms that each pinned CLI still accepts every fixed flag of its
// compatibility argv profile. It runs only after the smoke's own digest check,
// and it only parses help output in a deny-by-default sandbox, time-bounded,
// with a throwaway HOME. It never sends a workload or makes a provider
// request, so its result is not provider-support evidence.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const core = require('./live-provider-compatibility-core.cjs');
const REVIEWED_EXECUTIONS = require('./live-provider-reviewed-contracts.cjs');

const { LiveCompatibilityError } = core;
const SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const PROBE_EXECUTABLE = '/usr/bin/true';
const CAPS = Object.freeze({ max_elapsed_ms: 5_000, max_help_bytes: 64 * 1024, max_version_output_bytes: core.CAPS.max_version_output_bytes });
// A flag signature in the Options section, in commander's `  -p, --print  text`
// or clap's `  -s, --sandbox <MODE>` layout. Wrapped description lines are
// indented further and are never read as a signature.
const OPTION_SIGNATURE = /^ {2,6}(-{1,2}[A-Za-z0-9][\w-]*(?:, -{1,2}[A-Za-z0-9][\w-]*)*)(?:[ =](<[^>]*>|\[[^\]]*\])(?:\.\.\.)?)?(?: {2,}\S.*)?\s*$/;
const required = (condition, code) => { if (!condition) throw new LiveCompatibilityError(code); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sandboxSafePath = value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 1024 && !/[\0\r\n"\\()]/.test(value);

function caps(runtime) {
  const selected = runtime?.test_caps || CAPS;
  required(selected !== null && typeof selected === 'object' && Object.keys(selected).sort().join(',') === Object.keys(CAPS).sort().join(','), 'flag_check_caps');
  for (const key of Object.keys(CAPS)) required(Number.isSafeInteger(selected[key]) && selected[key] > 0 && selected[key] <= CAPS[key], 'flag_check_caps');
  return Object.freeze({ ...selected });
}
function checkedParent(directory) {
  required(sandboxSafePath(directory), 'flag_check_home_parent');
  let real, stat; try { real = fs.realpathSync(directory); stat = fs.lstatSync(real); } catch { throw new LiveCompatibilityError('flag_check_home_parent'); }
  required(stat.isDirectory() && sandboxSafePath(real), 'flag_check_home_parent');
  return real;
}
function sandboxAvailable() {
  if (process.platform !== 'darwin') return false;
  try { const stat = fs.lstatSync(SANDBOX_EXECUTABLE); return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0 && (stat.mode & 0o022) === 0; } catch { return false; }
}
// Deny-by-default, in the style of server/reviewed-execution-profiles.js. The
// pinned CLIs print --version and help with only these allowances, and each one
// was needed on 2026-09-26: exec of the pinned file, sysctl reads, the root
// vnode read, /usr/share, and the throwaway HOME. Network, forks, every other
// executable (so /usr/bin/security, which Claude's startup runs to read the
// Keychain), mach lookups, and all other reads and writes stay denied.
function sandboxProfile(home, executable) {
  required(sandboxSafePath(home) && sandboxSafePath(executable), 'flag_check_isolation_unavailable');
  return [
    '(version 1)',
    '(deny default)',
    `(allow process-exec (literal "${executable}"))`,
    '(allow sysctl-read)',
    '(allow file-read-data (literal "/"))',
    '(allow file-read* (subpath "/usr/share"))',
    `(allow file-read* file-write* (subpath "${home}"))`,
  ].join('\n');
}
function createHome(parent) {
  try {
    const home = fs.mkdtempSync(path.join(parent, 'quadwork-flag-check-home-')); fs.chmodSync(home, 0o700);
    const tmp = path.join(home, 'tmp'); fs.mkdirSync(tmp, { mode: 0o700 }); fs.chmodSync(tmp, 0o700);
    return Object.freeze({ home, tmp });
  } catch { throw new LiveCompatibilityError('flag_check_home'); }
}
// Each call runs in its own process group. The whole group is killed on
// timeout and again when the direct child exits, so no process it started
// outlives the call. The fixed PATH resolves a bare `security` only to the
// denied command.
function run(runtime, profileText, command, args, place, maxBytes, timeout) {
  return new Promise(resolve => {
    const stdout = [], stderr = []; let child, timer, bytes = 0, timedOut = false, overflow = false, settled = false;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const finish = (code, signal, failed) => {
      if (settled) return; settled = true; clearTimeout(timer); killGroup();
      resolve(Object.freeze({ code, signal, failed: failed || timedOut || overflow, timed_out: timedOut, overflow, output_digest: digest(Buffer.concat([...stdout, ...stderr])), stdout: Buffer.concat(stdout) }));
    };
    try { child = (runtime?.spawn || spawn)(SANDBOX_EXECUTABLE, ['-p', profileText, command, ...args], { cwd: place.home, detached: true, env: { ...core.sanitizedEnvironment(), HOME: place.home, PATH: '/usr/bin:/bin', TMPDIR: place.tmp }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { finish(null, null, true); return; }
    timer = setTimeout(() => { timedOut = true; killGroup(); child.stdout?.destroy(); child.stderr?.destroy(); finish(null, 'SIGKILL', true); }, timeout);
    const observe = (list, chunk) => { bytes += chunk.length; if (bytes <= maxBytes) list.push(chunk); else if (!overflow) { overflow = true; killGroup(); } };
    child.stdout.on('data', chunk => observe(stdout, chunk)); child.stderr.on('data', chunk => observe(stderr, chunk));
    child.once('error', () => finish(null, null, true)); child.once('exit', killGroup); child.once('close', (code, signal) => finish(code, signal, false));
  });
}
function listedChoices(text) {
  const commander = /\(choices: ((?:"[^"]*"(?:, )?)+)/.exec(text);
  if (commander) return Object.freeze([...commander[1].matchAll(/"([^"]*)"/g)].map(match => match[1]));
  const clap = /\[possible values: ([^\]]+)\]/.exec(text);
  return clap ? Object.freeze(clap[1].split(', ')) : null;
}
function helpOptions(text) {
  const options = new Map(), blocks = []; let inOptions = false, current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inOptions = line.trimEnd() === 'Options:'; current = null; continue; }
    if (!inOptions) continue;
    const match = OPTION_SIGNATURE.exec(line);
    if (match) {
      current = { value: match[2] === undefined ? null : match[2].startsWith('<') ? 'required' : 'optional', text: [] }; blocks.push(current);
      for (const flag of match[1].split(', ')) if (!options.has(flag)) options.set(flag, current);
    }
    if (current) current.text.push(line.trim());
  }
  for (const block of blocks) block.choices = listedChoices(block.text.join(' '));
  return options;
}
// Walks the compiled argv exactly as the smoke passes it. Only flag names and
// value-check classes are reported, never a path, prompt, or help text.
function walk(argv, options) {
  const flags = [], positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-')) { positionals.push(index); continue; }
    const option = options.get(token); let accepted = option !== undefined, value_check = null;
    if (option?.value) {
      const value = argv[index + 1];
      if (option.value === 'required' || (value !== undefined && !value.startsWith('-'))) {
        index += 1;
        if (value === undefined) accepted = false;
        else value_check = option.choices === null ? 'no_choices_listed' : option.choices.includes(value) ? 'listed' : 'unlisted';
        if (value_check === 'unlisted') accepted = false;
      }
    }
    flags.push(Object.freeze({ flag: token, accepted, value_check }));
  }
  return Object.freeze({ flags, positionals });
}

// Returns the report fields for one pinned CLI inside its throwaway HOME. The
// test-only rules let Node-script fakes run; the public entry never has them.
async function inspect(runtime, contract, reviewed, place, selected) {
  const testRules = runtime?.test_profile_rules || [];
  required(Array.isArray(testRules) && testRules.every(rule => typeof rule === 'string'), 'flag_check_test_rules');
  // A nested or refused sandbox fails here, before any pinned CLI starts.
  const probe = await run(runtime, sandboxProfile(place.home, PROBE_EXECUTABLE), PROBE_EXECUTABLE, [], place, 1024, selected.max_elapsed_ms);
  if (probe.failed || probe.code !== 0 || probe.signal) return {};
  const profileText = [sandboxProfile(place.home, reviewed.path), ...testRules].join('\n'), adapter = contract.adapter;
  const version = await run(runtime, profileText, reviewed.path, ['--version'], place, selected.max_version_output_bytes, selected.max_elapsed_ms);
  if (!core.testHooks.versionMatches(version, contract)) return { result_class: 'version_failed', external_process_started: true };
  const subcommand = adapter.argv[0].startsWith('-') ? null : adapter.argv[0];
  const help = await run(runtime, profileText, reviewed.path, subcommand ? [subcommand, '--help'] : ['--help'], place, selected.max_help_bytes, selected.max_elapsed_ms);
  if (help.failed || help.code !== 0 || help.signal) return { result_class: 'help_failed', version_digest_matched: true, external_process_started: true };
  const text = help.stdout.toString('utf8'), options = helpOptions(text);
  const argv = core.testHooks.profile(adapter, place.home), walked = walk(argv, options);
  const usage = text.split(/\r?\n/).find(line => line.startsWith('Usage: '));
  const subcommand_accepted = subcommand === null ? null : usage !== undefined && usage.split(' ')[2] === subcommand;
  const positionals_accepted = JSON.stringify(walked.positionals) === JSON.stringify(subcommand ? [0, argv.length - 1] : [argv.length - 1]);
  const accepted = options.size > 0 && walked.flags.every(flag => flag.accepted) && positionals_accepted && subcommand_accepted !== false;
  return { version_digest_matched: true, help_digest: digest(help.stdout), subcommand_accepted, positionals_accepted, flags: Object.freeze(walked.flags), result_class: accepted ? 'flags_accepted' : 'flag_rejected', external_process_started: true };
}

async function checkFlags(contract, homeParent, runtime) {
  const reviewed = core.testHooks.executable(contract, contract.executable_path);
  const parent = checkedParent(homeParent), selected = caps(runtime), startedAt = Date.now();
  const report = fields => Object.freeze({ schema_version: 1, purpose: 'live_provider_flag_check', provider_support_evidence: false, adapter: contract.adapter.id, pinned_version: core.testHooks.pathVersion(contract.resolved_path), executable_digest: reviewed.digest, version_digest_matched: false, help_digest: null, subcommand_accepted: null, positionals_accepted: false, flags: Object.freeze([]), result_class: 'isolation_unavailable', external_process_started: false, elapsed_ms: Date.now() - startedAt, ...fields });
  if (!sandboxAvailable()) return report({});
  const place = createHome(parent); let fields;
  try { fields = await inspect(runtime, contract, reviewed, place, selected); }
  finally { try { fs.rmSync(place.home, { recursive: true, force: true }); } catch {} }
  // Every process group is dead by now, so a HOME that still exists fails closed.
  return report(fs.existsSync(place.home) ? { ...fields, result_class: 'home_cleanup_failed' } : fields);
}

async function runFlagCheck(value = {}) {
  required(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join(',') === 'home_parent', 'flag_check_shape');
  checkedParent(value.home_parent);
  const results = [];
  for (const id of ['codex', 'claude']) {
    const reviewed = REVIEWED_EXECUTIONS[id]; required(reviewed?.adapter === id && core.ADAPTERS[id], 'live_adapter_not_supported');
    try { results.push(await checkFlags({ ...reviewed, adapter: core.ADAPTERS[id] }, value.home_parent)); }
    catch (error) {
      if (!(error instanceof LiveCompatibilityError)) throw error;
      results.push(Object.freeze({ schema_version: 1, purpose: 'live_provider_flag_check', provider_support_evidence: false, adapter: id, pinned_version: core.testHooks.pathVersion(reviewed.resolved_path), result_class: 'not_checked', reason: error.message, external_process_started: false }));
    }
  }
  return Object.freeze(results);
}

async function main(argv) {
  let results;
  try {
    required(argv.length === 2 && argv[0] === '--home-parent', 'flag_check_usage');
    results = await runFlagCheck({ home_parent: argv[1] });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error instanceof LiveCompatibilityError ? error.message : 'flag_check_failed' })}\n`); process.exitCode = 2; return;
  }
  process.stdout.write(`${JSON.stringify({ schema_version: 1, purpose: 'live_provider_flag_check', provider_support_evidence: false, results }, null, 2)}\n`);
  process.exitCode = results.every(result => result.result_class === 'flags_accepted') ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = Object.freeze({ CAPS, PROBE_EXECUTABLE, SANDBOX_EXECUTABLE, runFlagCheck, testHooks: Object.freeze({ checkFlags, helpOptions, sandboxProfile, walk }) });
