'use strict';

// #1181. Fake-CLI tests only. Every executable here is a Node script created in
// a temporary directory; no test reads, hashes, or runs a real provider CLI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const core = require('./live-provider-compatibility-core.cjs');
const flagCheck = require('./live-provider-flag-check.cjs');

const isMacSandbox = process.platform === 'darwin' && fs.existsSync(flagCheck.SANDBOX_EXECUTABLE);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const VERSION = Object.freeze({ codex: 'codex-cli 0.157.1\n', claude: '2.1.283 (Claude Code)\n' });
const HELP_ARGS = Object.freeze({ codex: 'exec --help', claude: '--help' });
const CODEX_FLAGS = ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--color', '-m', '-C', '--output-last-message'];
const CLAUDE_FLAGS = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', '--permission-prompts', '--tools', '--output-format', '--model'];
const CODEX_HELP = `Run the agent without a terminal UI

Usage: codex exec [OPTIONS] [PROMPT]

Arguments:
  [PROMPT]
          Instructions for the agent

Options:
  -c, --config <key=value>
          Override one setting. Examples: - \`-c model="x"\`

  -m, --model <MODEL>
          Model to use

  -s, --sandbox <SANDBOX_MODE>
          Sandbox policy for shell commands

          [possible values: read-only, workspace-write, danger-full-access]

  -C, --cd <DIR>
          Working root

      --ephemeral
          Keep no session files

      --ignore-user-config
          Skip the user config file

      --ignore-rules
          Skip rules files

      --color <COLOR>
          Color output

          [default: auto]
          [possible values: always, never, auto]

  -o, --output-last-message <FILE>
          Write the last message to this file

  -h, --help
          Print help
`;
const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Fake assistant CLI

Arguments:
  prompt                                The prompt

Options:
  -p, --print                           Print one response and exit, for
                                        pipes
  --restricted                          Remove command-running tools
  --safe-mode                           Start with customizations disabled
  --strict-mcp-config                   Use only the MCP servers named by
                                        --mcp-config
  --no-session-persistence              Save no session
  --permission-mode <mode>              Permission mode (choices: "acceptEdits",
                                        "auto", "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers prompts with --print
                                        (choices: "host", "none", default:
                                        "host")
  --tools <tools...>                    Built-in tools to allow; "" allows none
  --output-format <format>              Output format for --print: "text"
                                        (default) (choices: "text", "json",
                                        "stream-json")
  --model <model>                       Model to use
  -h, --help                            Display help

Commands:
  doctor                                Check the installation
`;

function parent() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quadwork-flag-check-test-'))); }
const cleanup = directory => fs.rmSync(directory, { recursive: true, force: true });
const homes = directory => fs.readdirSync(directory).filter(entry => entry.startsWith('quadwork-flag-check-home-'));
const NODE = fs.realpathSync(process.execPath);
const settle = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// A fake CLI in the pinned install shape: a wrapper symlink to a versioned file.
function install(directory, id, { help = id === 'codex' ? CODEX_HELP : CLAUDE_HELP, version = VERSION[id], body = 'respond();' } = {}) {
  const target = path.join(directory, id === 'codex' ? 'Caskroom/codex/0.157.1/bin/codex' : 'claude/versions/2.1.283'), wrapper = path.join(directory, 'bin', id);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(target, `#!${NODE}\nconst args = process.argv.slice(2).join(' ');\nconst respond = () => { if (args === '--version') process.stdout.write(${JSON.stringify(version)}); else if (args === ${JSON.stringify(HELP_ARGS[id])}) process.stdout.write(${JSON.stringify(help)}); else process.exitCode = 64; };\n${body}\n`, { mode: 0o700 });
  fs.symlinkSync(target, wrapper);
  return { adapter: core.ADAPTERS[id], executable_path: wrapper, resolved_path: target, executable_digest: sha(fs.readFileSync(target)), version_digest: sha(VERSION[id]) };
}
// Test-only rules that let a Node-script fake start under the production
// profile: the interpreter, its own reads, and path metadata for its realpath.
const fakeRules = target => [`(allow process-exec-interpreter (literal "${NODE}"))`, `(allow file-read* (literal "${NODE}") (literal "${target}") (subpath "/System/Library/OpenSSL"))`, '(allow file-read-metadata)'];
const check = (contract, directory, runtime = {}) => flagCheck.testHooks.checkFlags(contract, directory, { test_profile_rules: fakeRules(contract.resolved_path), ...runtime });
function spy(replacement) {
  const calls = [];
  return { calls, spawn: (command, args, options) => {
    calls.push({ command, args: [...args], options, home_mode: fs.statSync(options.env.HOME).mode & 0o777 });
    return (replacement || spawn)(command, args, options);
  } };
}

test('pinned fake Codex and Claude CLIs accept every fixed flag, and the report is raw-free', { skip: !isMacSandbox }, async () => {
  const directory = parent();
  try {
    const codex = await check(install(directory, 'codex'), directory), claude = await check(install(directory, 'claude'), directory);
    for (const [report, id, version, flags] of [[codex, 'codex', '0.157.1', CODEX_FLAGS], [claude, 'claude', '2.1.283', CLAUDE_FLAGS]]) {
      assert.equal(report.result_class, 'flags_accepted'); assert.equal(report.adapter, id); assert.equal(report.pinned_version, version);
      assert.equal(report.provider_support_evidence, false); assert.equal(report.version_digest_matched, true); assert.equal(report.positionals_accepted, true); assert.equal(report.external_process_started, true);
      assert.equal(report.help_digest, sha(id === 'codex' ? CODEX_HELP : CLAUDE_HELP));
      assert.deepEqual(report.flags.map(flag => flag.flag), flags); assert.equal(report.flags.every(flag => flag.accepted), true);
      const text = JSON.stringify(report);
      for (const raw of [directory, os.homedir(), 'QUADWORK_LIVE_OK', 'Sandbox policy', 'Permission mode', '.quadwork-live-codex-final-message']) assert.equal(text.includes(raw), false, raw);
    }
    assert.equal(codex.subcommand_accepted, true); assert.equal(claude.subcommand_accepted, null);
    assert.deepEqual(Object.fromEntries(codex.flags.map(flag => [flag.flag, flag.value_check])), { '--ephemeral': null, '--ignore-user-config': null, '--ignore-rules': null, '--sandbox': 'listed', '--color': 'listed', '-m': 'no_choices_listed', '-C': 'no_choices_listed', '--output-last-message': 'no_choices_listed' });
    assert.deepEqual(Object.fromEntries(claude.flags.map(flag => [flag.flag, flag.value_check])), { '-p': null, '--restricted': null, '--safe-mode': null, '--strict-mcp-config': null, '--no-session-persistence': null, '--permission-mode': 'listed', '--permission-prompts': 'listed', '--tools': 'no_choices_listed', '--output-format': 'listed', '--model': 'no_choices_listed' });
    assert.deepEqual(homes(directory), [], 'each throwaway HOME is removed');
  } finally { cleanup(directory); }
});

test('the digest check runs first: a stale pin or changed bytes start no process and create no HOME', async () => {
  const directory = parent();
  try {
    const contract = install(directory, 'codex'), observed = spy();
    await assert.rejects(() => check({ ...contract, resolved_path: path.join(directory, 'Caskroom/codex/0.156.0/bin/codex') }, directory, { spawn: observed.spawn }), { message: 'live_executable_stale_pin: pinned 0.156.0, found 0.157.1' });
    await assert.rejects(() => check({ ...contract, executable_digest: '0'.repeat(64) }, directory, { spawn: observed.spawn }), { message: 'live_executable_not_reviewed: pinned 0.157.1, found 0.157.1' });
    assert.equal(observed.calls.length, 0); assert.deepEqual(homes(directory), []);
  } finally { cleanup(directory); }
});

test('every call runs sandboxed in its own process group with a fresh throwaway HOME', { skip: !isMacSandbox }, async () => {
  const directory = parent(), saved = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = path.join(directory, 'inherited-codex-home'); process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'inherited-claude-config');
  try {
    const observed = spy(), contracts = { codex: install(directory, 'codex'), claude: install(directory, 'claude') };
    for (const id of ['codex', 'claude']) assert.equal((await check(contracts[id], directory, { spawn: observed.spawn })).result_class, 'flags_accepted');
    assert.deepEqual(observed.calls.map(call => call.args.slice(2)), [[flagCheck.PROBE_EXECUTABLE], [contracts.codex.resolved_path, '--version'], [contracts.codex.resolved_path, 'exec', '--help'], [flagCheck.PROBE_EXECUTABLE], [contracts.claude.resolved_path, '--version'], [contracts.claude.resolved_path, '--help']]);
    for (const call of observed.calls) {
      const home = call.options.env.HOME, executable = call.args[2];
      assert.equal(call.command, flagCheck.SANDBOX_EXECUTABLE); assert.equal(call.args[0], '-p'); assert.equal(call.options.detached, true, 'own process group'); assert.equal(call.options.shell, false);
      // The pinned CLI runs under the production profile; only the fake's interpreter rules are appended.
      assert.equal(call.args[1], executable === flagCheck.PROBE_EXECUTABLE ? flagCheck.testHooks.sandboxProfile(home, executable) : [flagCheck.testHooks.sandboxProfile(home, executable), ...fakeRules(executable)].join('\n'));
      assert.equal(path.dirname(home), directory); assert.match(path.basename(home), /^quadwork-flag-check-home-/); assert.notEqual(home, os.homedir()); assert.equal(call.home_mode, 0o700);
      assert.equal(call.options.cwd, home); assert.equal(call.options.env.TMPDIR, path.join(home, 'tmp')); assert.equal(call.options.env.PATH, '/usr/bin:/bin');
      assert.equal(Object.hasOwn(call.options.env, 'CODEX_HOME'), false); assert.equal(Object.hasOwn(call.options.env, 'CLAUDE_CONFIG_DIR'), false);
      assert.equal(fs.existsSync(home), false, 'the throwaway HOME is removed after the check');
    }
    assert.equal(new Set(observed.calls.map(call => call.options.env.HOME)).size, 2, 'each adapter gets a fresh HOME');
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    cleanup(directory);
  }
});

test('a flag or value the pinned CLI no longer accepts fails the check', { skip: !isMacSandbox }, async () => {
  const cases = [
    ['claude', CLAUDE_HELP.replace(/^ {2}--safe-mode .*\n/m, ''), '--safe-mode', report => report.flags.find(flag => flag.flag === '--safe-mode').accepted === false],
    ['claude', CLAUDE_HELP.replace(/^ {2}--safe-mode .*\n/m, '').replace('Commands:\n', 'Commands:\n  --safe-mode                           Listed only as a command\n'), 'safe-mode outside Options', report => report.flags.find(flag => flag.flag === '--safe-mode').accepted === false],
    ['claude', CLAUDE_HELP.replace('"dontAsk", ', ''), 'unlisted --permission-mode value', report => report.flags.find(flag => flag.flag === '--permission-mode').value_check === 'unlisted'],
    ['codex', CODEX_HELP.replace('[possible values: read-only, ', '[possible values: '), 'unlisted --sandbox value', report => report.flags.find(flag => flag.flag === '--sandbox').value_check === 'unlisted'],
    ['codex', CODEX_HELP.replace('      --color <COLOR>', '      --color'), '--color no longer takes a value', report => report.positionals_accepted === false],
    ['codex', CODEX_HELP.replace('Usage: codex exec [OPTIONS]', 'Usage: codex [OPTIONS]'), 'no exec subcommand', report => report.subcommand_accepted === false],
    ['claude', 'Usage: claude [options]\n', 'no Options section', report => report.flags.every(flag => flag.accepted === false)],
  ];
  for (const [id, help, name, detail] of cases) {
    const directory = parent();
    try {
      const report = await check(install(directory, id, { help }), directory);
      assert.equal(report.result_class, 'flag_rejected', name); assert.equal(detail(report), true, name); assert.equal(report.version_digest_matched, true, name);
    } finally { cleanup(directory); }
  }
});

test('a version mismatch stops before help, and a failing, slow, or oversized help fails closed within the bound', { skip: !isMacSandbox }, async () => {
  const run = async (options, runtime) => { const directory = parent(); try { return await check(install(directory, 'codex', options), directory, runtime); } finally { cleanup(directory); } };
  const observed = spy();
  const mismatch = await run({ version: 'codex-cli 0.158.0\n' }, { spawn: observed.spawn });
  assert.equal(mismatch.result_class, 'version_failed'); assert.equal(mismatch.help_digest, null); assert.deepEqual(observed.calls.map(call => call.args.slice(3)), [[], ['--version']]);
  assert.equal((await run({ body: "if (args === '--version') respond(); else process.exitCode = 2;" })).result_class, 'help_failed');
  const startedAt = Date.now();
  assert.equal((await run({ body: "if (args === '--version') respond(); else setTimeout(respond, 60_000);" }, { test_caps: { ...flagCheck.CAPS, max_elapsed_ms: 3_000 } })).result_class, 'help_failed');
  assert.equal(Date.now() - startedAt < 20_000, true, 'the slow help call is killed at the time bound');
  assert.equal((await run({ help: CODEX_HELP + 'x'.repeat(2048) }, { test_caps: { ...flagCheck.CAPS, max_help_bytes: 1024 } })).result_class, 'help_failed');
  await assert.rejects(() => run({}, { test_caps: { ...flagCheck.CAPS, max_elapsed_ms: flagCheck.CAPS.max_elapsed_ms + 1 } }), /flag_check_caps/);
});

test('the whole process group dies on completion and on timeout, so no helper can recreate the deleted HOME', { skip: !isMacSandbox }, async () => {
  // The help call starts a helper that recreates HOME/after after a delay. The
  // production profile denies forks; these test rules allow only this helper.
  const helper = delay => `if (args !== '--version') require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").mkdirSync(require("node:path").join(process.env.HOME, "after"), { recursive: true }), ${delay})'], { stdio: 'ignore' }).unref();`;
  const helperRules = target => [...fakeRules(target), '(allow process-fork)', `(allow process-exec (literal "${NODE}"))`, '(allow file-read* file-write* (literal "/dev/null"))'];
  // Control: outside the checker, the same fake's helper outlives it and recreates a deleted HOME.
  const control = parent();
  try {
    const contract = install(control, 'claude', { body: `${helper(300)} respond();` }), home = path.join(control, 'control-home'); fs.mkdirSync(home, { mode: 0o700 });
    spawnSync(contract.resolved_path, ['--help'], { env: { HOME: home }, stdio: 'ignore', timeout: 5_000 }); fs.rmSync(home, { recursive: true, force: true });
    await settle(1_500); assert.equal(fs.existsSync(path.join(home, 'after')), true, 'the helper survives an unmanaged call');
  } finally { cleanup(control); }
  for (const [name, body, runtime, expected, wait] of [
    ['completion', `${helper(1_000)} respond();`, {}, 'flags_accepted', 2_500],
    ['timeout', `${helper(4_000)} if (args === '--version') respond(); else setTimeout(respond, 60_000);`, { test_caps: { ...flagCheck.CAPS, max_elapsed_ms: 3_000 } }, 'help_failed', 2_500],
  ]) {
    const directory = parent();
    try {
      const contract = install(directory, 'claude', { body }), observed = spy();
      const report = await flagCheck.testHooks.checkFlags(contract, directory, { ...runtime, spawn: observed.spawn, test_profile_rules: helperRules(contract.resolved_path) });
      assert.equal(report.result_class, expected, name);
      await settle(wait);
      assert.equal(fs.existsSync(observed.calls[0].options.env.HOME), false, `${name}: no helper recreated the throwaway HOME`); assert.deepEqual(homes(directory), [], name);
    } finally { cleanup(directory); }
  }
});

test('a throwaway HOME that is still present after cleanup fails closed with its own result', { skip: !isMacSandbox }, async () => {
  const directory = parent();
  try {
    const body = "if (args !== '--version') { const fs = require('node:fs'), path = require('node:path'), locked = path.join(process.env.HOME, 'locked'); fs.mkdirSync(locked); fs.writeFileSync(path.join(locked, 'file'), 'x'); fs.chmodSync(locked, 0o500); } respond();";
    const report = await check(install(directory, 'codex', { body }), directory);
    assert.equal(report.result_class, 'home_cleanup_failed'); assert.equal(homes(directory).length, 1);
  } finally {
    for (const home of homes(directory)) fs.chmodSync(path.join(directory, home, 'locked'), 0o700);
    cleanup(directory);
  }
});

test('a refused sandbox reports isolation_unavailable before any pinned CLI starts', { skip: !isMacSandbox }, async () => {
  const directory = parent();
  try {
    const observed = spy((command, args, options) => spawn(process.execPath, ['-e', 'process.exit(71)'], options));
    const report = await check(install(directory, 'claude'), directory, { spawn: observed.spawn });
    assert.equal(report.result_class, 'isolation_unavailable'); assert.equal(report.external_process_started, false);
    assert.deepEqual(observed.calls.map(call => call.args.slice(2)), [[flagCheck.PROBE_EXECUTABLE]]); assert.deepEqual(homes(directory), []);
  } finally { cleanup(directory); }
});

test('under the checker a fake cannot reach the network, start a process, or write outside its HOME', { skip: !isMacSandbox }, async () => {
  const directory = parent(), outside = path.join(directory, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
  let connections = 0; const server = net.createServer(socket => { connections += 1; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = `const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process'); const breaches = []; let done = false;
if (!cp.spawnSync('/usr/bin/security', ['-h'], { stdio: 'ignore' }).error) breaches.push('security');
if (!cp.spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).error) breaches.push('fork');
try { fs.writeFileSync(${JSON.stringify(path.join(outside, 'written'))}, 'x'); breaches.push('write'); } catch {}
const finish = () => { if (done) return; done = true; if (breaches.length) process.stdout.write('isolation breached: ' + breaches.join(',')); else respond(); };
const socket = net.connect(${server.address().port}, '127.0.0.1'); socket.on('connect', () => { breaches.push('network'); socket.destroy(); finish(); }); socket.on('error', finish);`;
    const contract = install(directory, 'claude', { body });
    // Control: outside the sandbox the same fake detects every breach.
    const control = spawnSync(contract.resolved_path, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    for (let waited = 0; connections < 1 && waited < 5_000; waited += 50) await settle(50);
    assert.equal(control.stdout, 'isolation breached: security,fork,write,network'); assert.equal(connections, 1);
    fs.rmSync(path.join(outside, 'written')); connections = 0;
    const report = await check(contract, directory);
    await settle(300); assert.equal(report.result_class, 'flags_accepted'); assert.equal(connections, 0); assert.deepEqual(fs.readdirSync(outside), []);
  } finally { server.close(); cleanup(directory); }
});

test('the production profile is deny-by-default and alone denies network, other programs, forks, and outside reads and writes', { skip: !isMacSandbox }, async () => {
  assert.deepEqual(flagCheck.testHooks.sandboxProfile('/throwaway/home', '/pinned/cli').split('\n'), ['(version 1)', '(deny default)', '(allow process-exec (literal "/pinned/cli"))', '(allow sysctl-read)', '(allow file-read-data (literal "/"))', '(allow file-read* (subpath "/usr/share"))', '(allow file-read* file-write* (subpath "/throwaway/home"))']);
  const directory = parent(), home = path.join(directory, 'throwaway'), userHome = path.join(directory, 'user-home');
  let connections = 0; const server = net.createServer(socket => { connections += 1; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.mkdirSync(home, { mode: 0o700 }); fs.writeFileSync(path.join(home, 'inside.txt'), 'inside');
    const guarded = ['.claude.json', '.claude/settings.json', '.codex/auth.json', 'Library/Keychains/login.keychain-db'].map(relative => path.join(userHome, relative));
    for (const file of guarded) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
    // Each probe binary is itself the only executable the generated profile allows.
    const sandboxed = (binary, ...args) => spawnSync(flagCheck.SANDBOX_EXECUTABLE, ['-p', flagCheck.testHooks.sandboxProfile(home, binary), binary, ...args], { cwd: home, encoding: 'utf8', timeout: 5_000 });
    assert.equal(sandboxed('/bin/cat', path.join(home, 'inside.txt')).stdout, 'inside'); assert.equal(sandboxed('/usr/bin/touch', path.join(home, 'written')).status, 0);
    const denied = result => result.status !== 0 && /Operation not permitted/.test(result.stderr);
    for (const file of guarded) { assert.equal(spawnSync('/bin/cat', [file], { encoding: 'utf8' }).stdout, 'fixture'); assert.equal(denied(sandboxed('/bin/cat', file)), true, file); }
    assert.equal(denied(sandboxed('/usr/bin/touch', path.join(userHome, 'written'))), true); assert.equal(fs.existsSync(path.join(userHome, 'written')), false);
    assert.equal(denied(sandboxed('/usr/bin/env', '/usr/bin/security', '-h')), true, 'no other executable, so no Keychain command');
    // `time` names itself when fork fails and names the program when only exec fails.
    assert.equal(spawnSync('/usr/bin/time', ['/usr/bin/true']).status, 0); assert.match(sandboxed('/usr/bin/time', '/usr/bin/true').stderr, /^time: time: Operation not permitted/, 'no fork');
    const port = String(server.address().port);
    assert.equal(denied(sandboxed('/usr/bin/nc', '-v', '-z', '-w', '2', '127.0.0.1', port)), true, 'no network'); await settle(300); assert.equal(connections, 0);
    assert.equal(spawnSync('/usr/bin/nc', ['-z', '-w', '2', '127.0.0.1', port]).status, 0); for (let waited = 0; connections < 1 && waited < 5_000; waited += 50) await settle(50); assert.equal(connections, 1);
  } finally { server.close(); cleanup(directory); }
});

test('the CLI and public entry reject a bad invocation before any digest check', async () => {
  // The missing parent lives inside a directory this test creates, so it can
  // never exist and the invocation can never reach a pinned CLI.
  const directory = parent(), script = path.join(__dirname, 'live-provider-flag-check.cjs');
  try {
    for (const [args, code] of [[[], 'flag_check_usage'], [['--home-parent'], 'flag_check_usage'], [['--home-parent', 'relative/dir'], 'flag_check_home_parent'], [['--home-parent', path.join(directory, 'missing-parent')], 'flag_check_home_parent']]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 2, args.join(' ')); assert.deepEqual(JSON.parse(result.stdout), { error: code });
    }
    await assert.rejects(() => flagCheck.runFlagCheck({ home_parent: directory, adapter: 'codex' }), /flag_check_shape/);
  } finally { cleanup(directory); }
});
