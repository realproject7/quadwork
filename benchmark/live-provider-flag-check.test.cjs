'use strict';

// #1181. Fake-CLI tests only. Every executable here is a Node script created in
// a temporary directory; no test reads, hashes, or runs a real provider CLI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
// A fake CLI in the pinned install shape: a wrapper symlink to a versioned file.
function install(directory, id, { help = id === 'codex' ? CODEX_HELP : CLAUDE_HELP, version = VERSION[id], body = 'respond();' } = {}) {
  const target = path.join(directory, id === 'codex' ? 'Caskroom/codex/0.157.1/bin/codex' : 'claude/versions/2.1.283'), wrapper = path.join(directory, 'bin', id);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(target, `#!${process.execPath}\nconst args = process.argv.slice(2).join(' ');\nconst respond = () => { if (args === '--version') process.stdout.write(${JSON.stringify(version)}); else if (args === ${JSON.stringify(HELP_ARGS[id])}) process.stdout.write(${JSON.stringify(help)}); else process.exitCode = 64; };\n${body}\n`, { mode: 0o700 });
  fs.symlinkSync(target, wrapper);
  return { adapter: core.ADAPTERS[id], executable_path: wrapper, resolved_path: target, executable_digest: sha(fs.readFileSync(target)), version_digest: sha(VERSION[id]) };
}
function spy(result) {
  const calls = [];
  return { calls, runtime: { spawn_sync: (command, args, options) => {
    calls.push({ command, args: [...args], options, home_mode: fs.statSync(options.env.HOME).mode & 0o777 });
    return result ? result(command, args, options) : spawnSync(command, args, options);
  } } };
}

test('pinned fake Codex and Claude CLIs accept every fixed flag, and the report is raw-free', { skip: !isMacSandbox }, () => {
  const directory = parent();
  try {
    const codex = flagCheck.testHooks.checkFlags(install(directory, 'codex'), directory), claude = flagCheck.testHooks.checkFlags(install(directory, 'claude'), directory);
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

test('the digest check runs first: a stale pin or changed bytes start no process and create no HOME', () => {
  const directory = parent();
  try {
    const contract = install(directory, 'codex'), observed = spy();
    assert.throws(() => flagCheck.testHooks.checkFlags({ ...contract, resolved_path: path.join(directory, 'Caskroom/codex/0.156.0/bin/codex') }, directory, observed.runtime), { message: 'live_executable_stale_pin: pinned 0.156.0, found 0.157.1' });
    assert.throws(() => flagCheck.testHooks.checkFlags({ ...contract, executable_digest: '0'.repeat(64) }, directory, observed.runtime), { message: 'live_executable_not_reviewed: pinned 0.157.1, found 0.157.1' });
    assert.equal(observed.calls.length, 0); assert.deepEqual(homes(directory), []);
  } finally { cleanup(directory); }
});

test('every process is a sandboxed, time-bounded version or help call in a fresh throwaway HOME', { skip: !isMacSandbox }, () => {
  const directory = parent(), saved = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = path.join(directory, 'inherited-codex-home'); process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'inherited-claude-config');
  try {
    const observed = spy(), contracts = { codex: install(directory, 'codex'), claude: install(directory, 'claude') };
    for (const id of ['codex', 'claude']) assert.equal(flagCheck.testHooks.checkFlags(contracts[id], directory, observed.runtime).result_class, 'flags_accepted');
    assert.deepEqual(observed.calls.map(call => call.args.slice(2)), [['/usr/bin/true'], [contracts.codex.resolved_path, '--version'], [contracts.codex.resolved_path, 'exec', '--help'], ['/usr/bin/true'], [contracts.claude.resolved_path, '--version'], [contracts.claude.resolved_path, '--help']]);
    const userHome = os.userInfo().homedir;
    for (const call of observed.calls) {
      const home = call.options.env.HOME, profile = call.args[1];
      assert.equal(call.command, flagCheck.SANDBOX_EXECUTABLE); assert.equal(call.args[0], '-p');
      assert.equal(path.dirname(home), directory); assert.match(path.basename(home), /^quadwork-flag-check-home-/); assert.notEqual(home, os.homedir()); assert.equal(call.home_mode, 0o700);
      assert.equal(call.options.cwd, home); assert.equal(call.options.env.TMPDIR, path.join(home, 'tmp')); assert.equal(call.options.env.PATH, '/usr/bin:/bin'); assert.equal(call.options.shell, false);
      assert.equal(Object.hasOwn(call.options.env, 'CODEX_HOME'), false); assert.equal(Object.hasOwn(call.options.env, 'CLAUDE_CONFIG_DIR'), false);
      assert.equal(call.options.timeout, flagCheck.CAPS.max_elapsed_ms); assert.equal(call.options.killSignal, 'SIGKILL'); assert.equal(call.options.maxBuffer <= flagCheck.CAPS.max_help_bytes, true);
      for (const rule of ['(allow default)', '(deny network*)', '(deny process-exec (literal "/usr/bin/security"))', '(deny file-write*)', `(allow file-write* (subpath "${home}") (literal "/dev/null"))`, `(deny file-read* file-write* (prefix "${userHome}/.claude") (subpath "${userHome}/.codex") (subpath "${userHome}/Library/Keychains"))`]) assert.equal(profile.includes(rule), true, rule);
      assert.equal(fs.existsSync(home), false, 'the throwaway HOME is removed after the check');
    }
    assert.equal(new Set(observed.calls.map(call => call.options.env.HOME)).size, 2, 'each adapter gets a fresh HOME');
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    cleanup(directory);
  }
});

test('a flag or value the pinned CLI no longer accepts fails the check', { skip: !isMacSandbox }, () => {
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
      const report = flagCheck.testHooks.checkFlags(install(directory, id, { help }), directory);
      assert.equal(report.result_class, 'flag_rejected', name); assert.equal(detail(report), true, name); assert.equal(report.version_digest_matched, true, name);
    } finally { cleanup(directory); }
  }
});

test('a version mismatch stops before help, and a failing, slow, or oversized help fails closed within the bound', { skip: !isMacSandbox }, () => {
  const run = (options, runtime) => { const directory = parent(); try { return flagCheck.testHooks.checkFlags(install(directory, 'codex', options), directory, runtime); } finally { cleanup(directory); } };
  const observed = spy();
  const mismatch = run({ version: 'codex-cli 0.158.0\n' }, observed.runtime);
  assert.equal(mismatch.result_class, 'version_failed'); assert.equal(mismatch.help_digest, null); assert.deepEqual(observed.calls.map(call => call.args.slice(3)), [[], ['--version']]);
  assert.equal(run({ body: "if (args === '--version') respond(); else process.exitCode = 2;" }).result_class, 'help_failed');
  const bound = { test_caps: { ...flagCheck.CAPS, max_elapsed_ms: 3_000 } }, startedAt = Date.now();
  assert.equal(run({ body: "if (args === '--version') respond(); else setTimeout(respond, 60_000);" }, bound).result_class, 'help_failed');
  assert.equal(Date.now() - startedAt < 20_000, true, 'the slow help call is killed at the time bound');
  assert.equal(run({ help: CODEX_HELP + 'x'.repeat(2048) }, { test_caps: { ...flagCheck.CAPS, max_help_bytes: 1024 } }).result_class, 'help_failed');
  assert.throws(() => run({}, { test_caps: { ...flagCheck.CAPS, max_elapsed_ms: flagCheck.CAPS.max_elapsed_ms + 1 } }), /flag_check_caps/);
});

test('a refused sandbox reports isolation_unavailable before any pinned CLI starts', { skip: !isMacSandbox }, () => {
  const directory = parent();
  try {
    const observed = spy(() => ({ status: 71, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from('sandbox_apply: Operation not permitted\n') }));
    const report = flagCheck.testHooks.checkFlags(install(directory, 'claude'), directory, observed.runtime);
    assert.equal(report.result_class, 'isolation_unavailable'); assert.equal(report.external_process_started, false);
    assert.deepEqual(observed.calls.map(call => call.args.slice(2)), [['/usr/bin/true']]); assert.deepEqual(homes(directory), []);
  } finally { cleanup(directory); }
});

test('the sandbox denies network, the Keychain command, and writes outside the throwaway HOME', { skip: !isMacSandbox }, async () => {
  const directory = parent(), outside = path.join(directory, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
  let connections = 0; const server = net.createServer(socket => { connections += 1; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = `const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process'); const breaches = []; let done = false;
try { cp.execFileSync('/usr/bin/security', ['-h'], { stdio: 'ignore' }); breaches.push('security'); } catch {}
try { fs.writeFileSync(${JSON.stringify(path.join(outside, 'written'))}, 'x'); breaches.push('write'); } catch {}
const finish = () => { if (done) return; done = true; if (breaches.length) process.stdout.write('isolation breached: ' + breaches.join(',')); else respond(); };
const socket = net.connect(${server.address().port}, '127.0.0.1'); socket.on('connect', () => { breaches.push('network'); socket.destroy(); finish(); }); socket.on('error', finish);`;
    const contract = install(directory, 'claude', { body });
    // spawnSync blocks this event loop, so accepted connections are counted
    // only after it yields.
    const settle = async (expected = 0) => { for (let waited = 0; connections < expected && waited < 5_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50)); await new Promise(resolve => setTimeout(resolve, 300)); };
    // Control: outside the sandbox the same fake detects all three breaches.
    const control = spawnSync(contract.resolved_path, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    await settle(1); assert.equal(control.stdout, 'isolation breached: security,write,network'); assert.equal(connections, 1);
    fs.rmSync(path.join(outside, 'written')); connections = 0;
    const report = flagCheck.testHooks.checkFlags(contract, directory);
    await settle(); assert.equal(report.result_class, 'flags_accepted'); assert.equal(connections, 0); assert.deepEqual(fs.readdirSync(outside), []);
  } finally { server.close(); cleanup(directory); }
});

test('the sandbox profile keeps provider-state and Keychain paths under the user home unreadable', { skip: !isMacSandbox }, () => {
  const directory = parent(), userHome = path.join(directory, 'user-home'), home = path.join(directory, 'throwaway');
  const guarded = ['.claude.json', '.claude/settings.json', '.claude-extra', '.codex/auth.json', 'Library/Keychains/login.keychain-db'];
  try {
    for (const relative of [...guarded, 'visible.txt']) { fs.mkdirSync(path.dirname(path.join(userHome, relative)), { recursive: true }); fs.writeFileSync(path.join(userHome, relative), 'fixture'); }
    fs.mkdirSync(home, { mode: 0o700 });
    const probe = `const fs = require('node:fs'), path = require('node:path'); const result = {};
for (const relative of ${JSON.stringify([...guarded, 'visible.txt'])}) { try { fs.readFileSync(path.join(${JSON.stringify(userHome)}, relative)); result[relative] = 'read'; } catch (error) { result[relative] = error.code; } }
for (const [name, file] of [['home', ${JSON.stringify(path.join(home, 'w'))}], ['user_home', ${JSON.stringify(path.join(userHome, 'w'))}]]) { try { fs.writeFileSync(file, 'x'); result[name] = 'written'; } catch (error) { result[name] = error.code; } }
process.stdout.write(JSON.stringify(result));`;
    const control = JSON.parse(spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).stdout);
    assert.equal(Object.values(control).every(value => value === 'read' || value === 'written'), true, 'without the sandbox every probe succeeds');
    fs.rmSync(path.join(home, 'w')); fs.rmSync(path.join(userHome, 'w'));
    const sandboxed = spawnSync(flagCheck.SANDBOX_EXECUTABLE, ['-p', flagCheck.testHooks.sandboxProfile(home, userHome), process.execPath, '-e', probe], { encoding: 'utf8', timeout: 5_000 });
    assert.deepEqual(JSON.parse(sandboxed.stdout), { ...Object.fromEntries(guarded.map(relative => [relative, 'EPERM'])), 'visible.txt': 'read', home: 'written', user_home: 'EPERM' });
  } finally { cleanup(directory); }
});

test('the CLI and public entry reject a bad invocation before any digest check', () => {
  const script = path.join(__dirname, 'live-provider-flag-check.cjs');
  for (const [args, code] of [[[], 'flag_check_usage'], [['--home-parent'], 'flag_check_usage'], [['--home-parent', 'relative/dir'], 'flag_check_home_parent'], [['--home-parent', path.join(os.tmpdir(), 'quadwork-flag-check-missing-parent-x7')], 'flag_check_home_parent']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 2, args.join(' ')); assert.deepEqual(JSON.parse(result.stdout), { error: code });
  }
  assert.throws(() => flagCheck.runFlagCheck({ home_parent: os.tmpdir(), adapter: 'codex' }), /flag_check_shape/);
});
