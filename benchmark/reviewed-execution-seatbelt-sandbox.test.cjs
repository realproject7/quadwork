'use strict';

// #1141: This fixture intentionally launches only /usr/bin/printf and /bin/cat
// through node-pty. It never invokes a provider binary or loads provider state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const pty = require('node-pty');
const profiles = require('../server/reviewed-execution-profiles');

const isMacSandbox = process.platform === 'darwin' && fs.existsSync(profiles.SANDBOX_EXECUTABLE);
const ROOT_READ_RULE = '(allow file-read-data (literal "/"))';

function ownedDirectory(parent, name) {
  const directory = path.join(parent, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function fixtureSource(executable, candidate, root, ledger) {
  // The production registry is identity-closed.  This fixture rewrites only
  // the already-generated executable literals after that boundary has run;
  // it never constructs an alternate provider profile or provider state.
  const production = profiles.PROFILES.v2_claude_restricted_v1;
  return profiles.sandboxSource(production, candidate, root, ledger)
    .replaceAll(`\"${production.executable}\"`, `\"${executable}\"`);
}

function runFixture(profileSource, executable, argv, cwd, observe) {
  const profilePath = path.join(cwd, `fixture-${process.hrtime.bigint()}.sb`);
  fs.writeFileSync(profilePath, profileSource, { mode: 0o600 });
  fs.chmodSync(profilePath, 0o600);
  return new Promise((resolve, reject) => {
    let complete = false;
    const finish = value => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      try { fs.unlinkSync(profilePath); } catch {}
      resolve(value);
    };
    let term;
    const timeout = setTimeout(() => {
      if (complete) return;
      try { term?.kill(); } catch {}
      reject(new Error('reviewed_execution_seatbelt_fixture_timeout'));
    }, 5_000);
    try {
      term = pty.spawn(profiles.SANDBOX_EXECUTABLE, ['-f', profilePath, executable, ...argv], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
      term.onData(chunk => observe(String(chunk)));
      term.onExit(event => finish({ exitCode: event.exitCode, signal: event.signal }));
    } catch (error) {
      clearTimeout(timeout);
      try { fs.unlinkSync(profilePath); } catch {}
      reject(error);
    }
  });
}

test('macOS Seatbelt root-vnode read admits the fixed PTY sentinel but preserves no-rule failure and outside-root containment', { skip: !isMacSandbox }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'quadwork-seatbelt-fixture-'));
  fs.chmodSync(parent, 0o700);
  const root = ownedDirectory(parent, 'root');
  const ledger = ownedDirectory(parent, 'ledger');
  const outside = path.join(parent, 'outside-fixture');
  const outsideContents = 'QUADWORK_OUTSIDE_FIXTURE_CONTENT';
  fs.writeFileSync(outside, outsideContents, { mode: 0o600 });
  fs.chmodSync(outside, 0o600);
  const candidate = 'a'.repeat(64);
  try {
    const fixedSource = fixtureSource('/usr/bin/printf', candidate, root, ledger);
    assert.equal(fixedSource.includes(ROOT_READ_RULE), true);
    let fixedSentinelSeen = false;
    const fixed = await runFixture(fixedSource, '/usr/bin/printf', ['PTY_OK\\n'], root, chunk => {
      fixedSentinelSeen ||= chunk.includes('PTY_OK');
    });
    assert.equal(fixedSentinelSeen, true);
    assert.equal(fixed.exitCode, 0);
    assert.equal(fixed.signal, 0);

    const noRuleSource = fixedSource.replace(`${ROOT_READ_RULE}\n`, '');
    let noRuleOutputSeen = false;
    const noRule = await runFixture(noRuleSource, '/usr/bin/printf', ['PTY_OK\\n'], root, () => { noRuleOutputSeen = true; });
    assert.equal(noRuleOutputSeen, false);
    assert.equal(noRule.signal, 6);

    const containmentSource = fixtureSource('/bin/cat', candidate, root, ledger);
    let outsideContentSeen = false;
    const containment = await runFixture(containmentSource, '/bin/cat', [outside], root, chunk => {
      // Retain no terminal text. The boolean is enough to prove that the
      // fixture content never crossed the PTY boundary.
      outsideContentSeen ||= chunk.includes(outsideContents);
    });
    assert.equal(outsideContentSeen, false);
    assert.equal(containment.exitCode === 0 && containment.signal === 0, false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
