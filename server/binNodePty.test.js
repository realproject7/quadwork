"use strict";

// #1173: `node-pty` is required at the top of server/index.js and
// server/resource-linux-launcher.js. Before this fix, a broken load or a PTY
// that couldn't spawn only surfaced as a raw throw deep in that require
// chain — after `quadwork start` had already scheduled the browser-open
// timer. `checkNodePty` is the single check both `start` (fail + exit before
// opening a browser or requiring the server) and `doctor` (report, don't
// exit) now run.
//
// This file tests three separate things:
//   1. `checkNodePty` / `spawnPtyProbe` as pure functions, with injected
//      fakes for the load-failure, spawn-failure and spawn-timeout branches
//      (no genuinely broken host needed).
//   2. The real, non-mocked check against this worktree's actual
//      `node_modules/node-pty` — the one path a test double can never prove.
//   3. That `start` and `doctor` are actually wired to the check, by driving
//      the real CLI as a subprocess with `node-pty`'s load forced to fail
//      (via a `--require` preload, the same technique binNodeVersion.test.js
//      uses for the Node-floor gate) and asserting: exit code, the exact fix
//      text, and — for `start` — that failure happens before "Dashboard:" is
//      ever logged, i.e. before the browser-open timer is scheduled and
//      before server/index.js is required. Both subprocess runs use a
//      throwaway HOME, per the hard environment rule against touching the
//      operator's real ~/.quadwork or port 8400; neither ever binds a port,
//      since the forced failure exits before the server is loaded.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  checkNodePty,
  spawnPtyProbe,
  loadNodePty,
  NODE_PTY_FIX,
} = require("../bin/quadwork");

const BIN_PATH = path.join(__dirname, "..", "bin", "quadwork.js");

// ─── 1. spawnPtyProbe against fakes ─────────────────────────────────────────

(async () => {
  // A pty module whose spawn() returns a process that exits 0 — success.
  {
    const fakePty = {
      spawn: () => ({
        onExit(cb) { setImmediate(() => cb({ exitCode: 0 })); },
        kill() {},
      }),
    };
    const result = await spawnPtyProbe(fakePty, { timeoutMs: 1000 });
    assert.deepEqual(result, { ok: true }, "exit code 0 is success");
  }

  // A nonzero exit is a spawn failure, not a load failure.
  {
    const fakePty = {
      spawn: () => ({
        onExit(cb) { setImmediate(() => cb({ exitCode: 1 })); },
        kill() {},
      }),
    };
    const result = await spawnPtyProbe(fakePty, { timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "node_pty_spawn_nonzero_exit");
    assert.match(result.message, /exited with code 1/);
  }

  // spawn() itself throwing (e.g. ENOENT for the probe binary) is caught,
  // not left to crash the caller.
  {
    const fakePty = { spawn: () => { throw new Error("ENOENT: no such file"); } };
    const result = await spawnPtyProbe(fakePty, { timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "node_pty_spawn_threw");
    assert.match(result.message, /ENOENT/);
  }

  // A process that never exits must not hang the check forever — the
  // timeout is what makes this a preflight check rather than a possible
  // indefinite hang inside `quadwork start`.
  {
    let killed = false;
    const fakePty = {
      spawn: () => ({
        onExit() { /* never calls back */ },
        kill() { killed = true; },
      }),
    };
    const started = Date.now();
    const result = await spawnPtyProbe(fakePty, { timeoutMs: 50 });
    assert.ok(Date.now() - started < 2000, "the probe returns promptly on timeout, not eventually");
    assert.equal(result.ok, false);
    assert.equal(result.code, "node_pty_spawn_timeout");
    assert.equal(killed, true, "a timed-out probe process is killed rather than left running");
  }

  console.log("  PASS: spawnPtyProbe success, nonzero exit, throw, and timeout branches");
})().then(runLoadFailureAndRealChecks, (err) => {
  process.exitCode = 1;
  console.error(err);
});

// ─── 2. checkNodePty composing loadPty + spawnProbe ─────────────────────────

async function runLoadFailureAndRealChecks() {
  // A load failure is reported as its own code, distinct from a spawn
  // failure, and never calls spawnProbe.
  {
    let spawnProbeCalled = false;
    const result = await checkNodePty({
      loadPty: () => { throw new Error("Cannot find module 'node-pty'"); },
      spawnProbe: async () => { spawnProbeCalled = true; return { ok: true }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "node_pty_load_failed");
    assert.match(result.message, /Cannot find module/);
    assert.equal(spawnProbeCalled, false, "a load failure short-circuits before probing spawn");
  }

  // A spawn failure surfaces spawnProbe's own code/message unchanged.
  {
    const result = await checkNodePty({
      loadPty: () => ({}),
      spawnProbe: async () => ({ ok: false, code: "node_pty_spawn_nonzero_exit", message: "fake spawn failure" }),
    });
    assert.deepEqual(result, { ok: false, code: "node_pty_spawn_nonzero_exit", message: "fake spawn failure" });
  }

  // 3. The real, non-mocked path: this worktree's actual node_modules/node-pty
  // loads, and a real PTY spawn of /bin/echo succeeds. This is the one
  // assertion a test double can never stand in for.
  {
    const pty = loadNodePty();
    assert.equal(typeof pty.spawn, "function", "the real node-pty module exposes spawn()");
    const result = await checkNodePty();
    assert.deepEqual(result, { ok: true }, "the real node-pty in this worktree loads and spawns a PTY");
  }

  assert.match(NODE_PTY_FIX, /npm install -g quadwork@latest --allow-scripts=node-pty --ignore-scripts=false/, "the fix names the exact remedy command, including the .npmrc ignore-scripts override");
  assert.match(NODE_PTY_FIX, /docs\/troubleshooting\.md/, "the fix points at the documented section");

  console.log("  PASS: checkNodePty load-failure short-circuit, spawn-failure passthrough, and the real worktree node-pty");

  runSubprocessWiringChecks();
}

// ─── 3. Wiring: the real CLI, run as a subprocess, with node-pty's load
// forced to fail via a --require preload (same technique as
// binNodeVersion.test.js's Node-floor gate test). Confirms `start` and
// `doctor` actually call the check, and that `start` fails before it ever
// logs "Dashboard:" (i.e. before the browser-open timer is scheduled and
// before server/index.js — which itself requires node-pty — is required). ──

function runSubprocessWiringChecks() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-node-pty-wiring-"));
  const preload = path.join(scratch, "force-node-pty-failure.js");
  fs.writeFileSync(preload, `
    const Module = require("module");
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (request) {
      if (request === "node-pty") {
        throw new Error("QUADWORK_TEST_FORCED_NODE_PTY_LOAD_FAILURE");
      }
      return originalRequire.apply(this, arguments);
    };
  `);
  const tempHome = fs.mkdtempSync(path.join(scratch, "home-"));

  const runCli = (...args) => spawnSync(
    process.execPath,
    ["-r", preload, BIN_PATH, ...args],
    { encoding: "utf8", env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome }, timeout: 15000 },
  );
  // No forced-failure preload: exercises the real, unmocked node-pty in this
  // worktree, so the success path is asserted end to end too, not just the
  // failure path above.
  const runCliClean = (...args) => spawnSync(
    process.execPath,
    [BIN_PATH, ...args],
    { encoding: "utf8", env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome }, timeout: 15000 },
  );

  try {
    // `start`: must fail closed, with the fix text, and never reach the
    // point where it logs the dashboard URL (that happens after the
    // browser-open timer is scheduled and right before requiring
    // server/index.js — both of which must not have run).
    const started = runCli("start");
    assert.equal(started.status, 1, `start must exit 1 on a forced node-pty load failure: ${started.stdout}${started.stderr}`);
    assert.match(started.stderr, /node-pty is unusable \[node_pty_load_failed\]/, started.stderr);
    assert.match(started.stderr, /QUADWORK_TEST_FORCED_NODE_PTY_LOAD_FAILURE/, "the underlying require error is surfaced");
    assert.match(started.stderr, /npm install -g quadwork@latest --allow-scripts=node-pty/, "the exact fix is printed");
    assert.doesNotMatch(started.stdout + started.stderr, /Dashboard:/, "start must fail before scheduling the browser-open timer");

    // `doctor`: reports the same failure but keeps printing the rest of the
    // report (the project-enumeration line still appears) and signals
    // failure via exit code rather than a hard `process.exit`.
    const doctored = runCli("doctor");
    assert.equal(doctored.status, 1, `doctor must exit non-zero on a forced node-pty load failure: ${doctored.stdout}${doctored.stderr}`);
    assert.match(doctored.stdout, /no projects in config\.json/, "doctor keeps reporting the rest of its checks");
    assert.match(doctored.stderr, /node-pty is unusable \[node_pty_load_failed\]/, doctored.stderr);
    assert.match(doctored.stderr, /npm install -g quadwork@latest --allow-scripts=node-pty/, "the exact fix is printed");

    // Negative control: the same preload, run against a command that never
    // touches node-pty, reaches its normal output — so the failures above
    // are the check's doing, not the harness breaking every command.
    const usage = runCli("not-a-command");
    assert.match(usage.stdout, /Usage: quadwork/, "an unrelated command is unaffected by the forced node-pty failure");

    // Success path, no forced failure: `doctor` exits 0 and reports the
    // check passed, using this worktree's real node-pty.
    const doctorOk = runCliClean("doctor");
    assert.equal(doctorOk.status, 0, `doctor must exit 0 when node-pty genuinely works: ${doctorOk.stdout}${doctorOk.stderr}`);
    assert.match(doctorOk.stdout, /node-pty loads and can spawn a PTY\./, doctorOk.stdout);
    assert.doesNotMatch(doctorOk.stdout + doctorOk.stderr, /node-pty is unusable/, "no failure is reported on the success path");

    console.log("  PASS: start and doctor are wired to checkNodePty; start fails before opening a browser or requiring the server; doctor exits 0 on success");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // Source-level pin: the call site in `cmdStart` must stay before both the
  // browser-open timer and the require of server/index.js. This is the kind
  // of ordering a later refactor could silently break while every branch
  // above still passes (the subprocess test above proves today's binary
  // behaves correctly, not that a future edit can't move the call after the
  // require without any test noticing at the behavior level alone).
  {
    const source = fs.readFileSync(BIN_PATH, "utf8");
    const startBody = source.slice(source.indexOf("async function cmdStart()"), source.indexOf("// ─── Stop Command"));
    const ptyCheckIndex = startBody.indexOf("await checkNodePty()");
    const timerIndex = startBody.indexOf("setTimeout(() => {");
    const serverRequireIndex = startBody.indexOf('require(path.join(serverDir, "index.js"))');
    assert.ok(ptyCheckIndex > -1, "cmdStart calls checkNodePty()");
    assert.ok(timerIndex > -1 && serverRequireIndex > -1, "found the browser timer and the server require to compare against");
    assert.ok(ptyCheckIndex < timerIndex, "the node-pty check runs before the browser-open timer is scheduled");
    assert.ok(ptyCheckIndex < serverRequireIndex, "the node-pty check runs before server/index.js (which itself requires node-pty) is required");
  }

  console.log("\nbinNodePty tests passed\n");
}
