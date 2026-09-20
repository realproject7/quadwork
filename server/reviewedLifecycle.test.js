"use strict";

// #1157: production launch/onData/governor/child completion, with in-memory
// PTYs and owned temporary files only. No real profile, gate or provider probe
// is reachable. Private test access is compiled into memory, never exported by
// the shipped runtime.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const cases = [
  ["claude", "completed"], ["codex", "completed"],
  ["claude", "early-data"], ["codex", "no-observation"],
  ["codex", "empty-observation"], ["claude", "stale-before-data"],
  ["claude", "stale-after-data"], ["claude", "replaced-session"],
  ["claude", "wrong-sentinel"], ["codex", "wrong-sentinel"],
  ["claude", "failed-cleanup"], ["claude", "missing-observer"],
];

if (process.argv[2] !== "--fixture") {
  for (const [backend, scenario] of cases) test(`reviewed ${backend} lifecycle: ${scenario}`, () => {
    const invoked = spawnSync(process.execPath, [__filename, "--fixture", backend, scenario], {
      encoding: "utf8", timeout: 10000,
      env: { PATH: "/usr/bin:/bin", QUADWORK_SKIP_LISTEN: "1", QUADWORK_TEST_RUNTIME: "1" },
    });
    assert.equal(invoked.status, 0, `${invoked.stdout}\n${invoked.stderr}`);
    assert.match(invoked.stdout, /fixture passed/);
  });
} else {
  runFixture(process.argv[3], process.argv[4]).catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}

async function runFixture(backend, scenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-reviewed-lifecycle-")));
  const home = path.join(root, "home");
  const repository = path.join(root, "repository");
  const ledger = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-reviewed-lifecycle-ledger-")));
  const mkdir = directory => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); };
  mkdir(home); mkdir(repository); mkdir(path.join(home, ".quadwork"));
  fs.writeFileSync(path.join(root, ".quadwork-v2-product-path-root-v1"), "quadwork-v2-product-path-v1\n", { mode: 0o600 });
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.QUADWORK_SKIP_LISTEN = "1"; process.env.QUADWORK_TEST_RUNTIME = "1";
  const previousHome = os.homedir; os.homedir = () => home;

  // Importing the immutable constants does no I/O. Every metadata/content
  // operation on a source-fixed provider path or ancestor is forbidden even
  // if an accidental test change tries to reach the original implementations.
  const profiles = require("./reviewed-execution-profiles");
  const protectedPaths = new Set();
  for (const profile of Object.values(profiles.PROFILES)) {
    for (const filename of [profile.provider_state_file, profile.executable]) {
      for (let current = filename; current !== path.dirname(current); current = path.dirname(current)) protectedPaths.add(current);
    }
  }
  const originals = new Map(); let forbiddenAccesses = 0;
  for (const name of ["lstatSync", "statSync", "realpathSync", "readFileSync", "openSync", "accessSync", "existsSync", "readdirSync"]) {
    const original = fs[name]; originals.set(name, original);
    fs[name] = function(filename, ...args) {
      if (typeof filename === "string" && protectedPaths.has(path.resolve(filename))) {
        forbiddenAccesses += 1; throw new Error("original provider path forbidden in fixture");
      }
      return original.call(this, filename, ...args);
    };
  }
  // Assert the guard itself intercepts metadata and content before delegating.
  const protectedFile = profiles.PROFILES.v2_codex_readonly_v1.provider_state_file;
  for (const method of ["lstatSync", "realpathSync", "readFileSync", "openSync"]) assert.throws(() => fs[method](protectedFile), /original provider path forbidden/);
  forbiddenAccesses = 0;
  const childProcess = require("node:child_process"); const processOriginals = new Map();
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    processOriginals.set(name, childProcess[name]);
    childProcess[name] = () => { throw new Error("process invocation forbidden in lifecycle fixture"); };
  }

  const profile = profiles.PROFILES[backend === "codex" ? "v2_codex_readonly_v1" : "v2_claude_restricted_v1"];
  const role = profile.role, key = `${profiles.PROJECT}/${role}`;
  const candidate = "a".repeat(64), authorizationKey = "b".repeat(64);
  const binding = { candidate_digest: candidate, disposable_root: root, ledger_directory: ledger, authorization_key: authorizationKey, sandbox_profile: path.join(root, "fixture.sb"), sandbox_digest: "c".repeat(64) };
  const cfg = { installation_id: "reviewed-fixture-0001", session_token: "d".repeat(64), temp_cleanup: { enabled: false }, projects: [{ id: profiles.PROJECT, idle: true, chat_mode: "file", repositories: [{ key: "primary", repo: "fixture/local", working_dir: repository, primary: true }], agents: { [role]: { cwd: repository, command: profile.executable, command_identity: backend, reviewed_execution_id: profile.id, ...Object.fromEntries(Object.entries(binding).map(([name, value]) => [`reviewed_execution_${name === "disposable_root" ? "root" : name}`, value])) } } }] };
  fs.writeFileSync(path.join(home, ".quadwork", "config.json"), JSON.stringify(cfg), { mode: 0o600 });
  let runtime, terminal, launched, claims = 0, gates = 0;
  const sentinel = "QUADWORK_V2_PRODUCT_PATH_OK";
  const syntheticPrivate = "private-fixture-bytes";
  const dataListeners = [], exitListeners = [];
  const emitData = data => { for (const listener of dataListeners) listener(data); };
  const emitExit = () => { for (const listener of [...exitListeners]) listener({ exitCode: 0 }); };
  const staleGeneration = () => {
    const filename = path.join(home, ".quadwork", profiles.PROJECT, "agent-lifecycle-state.json");
    const state = JSON.parse(fs.readFileSync(filename, "utf8"));
    state.roles[role].generation_id = "fixture-replacement-generation";
    state.roles[role].state = "verified"; // A verified replacement still cannot satisfy the old child.
    fs.writeFileSync(filename, JSON.stringify(state), { mode: 0o600 });
  };
  const deliver = async () => {
    if (scenario === "stale-before-data") staleGeneration();
    if (!["no-observation", "empty-observation"].includes(scenario)) {
      emitData(`${syntheticPrivate}\n`);
      if (scenario === "stale-after-data") { await terminalReadiness(); staleGeneration(); }
    } else if (scenario === "empty-observation") emitData("");
    if (scenario === "replaced-session") runtime.fixtureReplaceSession(role);
    if (backend === "codex") {
      fs.writeFileSync(profiles.codexFinalMessagePath(root), scenario === "wrong-sentinel" ? "WRONG" : sentinel, { mode: 0o600 });
      emitExit();
    } else {
      emitData(`${scenario === "wrong-sentinel" ? "WRONG" : sentinel}\n`);
      if (scenario === "wrong-sentinel") emitExit();
    }
  };
  const terminalReadiness = () => launched.reviewed_session.lifecycleVerified();
  const fakePty = { spawn(command, args, options) {
    assert.equal(command, "fixture-pty"); assert.deepEqual(args, []);
    assert.equal(options.env.HOME, home); assert.equal(options.env.USERPROFILE, home);
    terminal = {
      onData(listener) { dataListeners.push(listener); if (scenario === "early-data" && dataListeners.length === 1) listener(`${syntheticPrivate}\n`); return { dispose() {} }; },
      onExit(listener) { exitListeners.push(listener); return { dispose() { const i = exitListeners.indexOf(listener); if (i >= 0) exitListeners.splice(i, 1); } }; },
      write(value) { assert.equal(value, `${profiles.WORKLOAD}\n`); queueMicrotask(() => deliver().catch(error => { console.error(error.stack); process.exitCode = 1; })); },
      kill() { if (scenario === "failed-cleanup") return false; emitExit(); return true; },
    };
    return terminal;
  } };
  const fakeProfiles = new Proxy({
    PROJECT: profiles.PROJECT, WORKLOAD: profiles.WORKLOAD, PROFILES: profiles.PROFILES,
    resolveReviewedExecution: profiles.resolveReviewedExecution,
    codexFinalMessagePath: profiles.codexFinalMessagePath,
    reviewedLaunchPlan(project, agent, id, value) {
      assert.equal(project, profiles.PROJECT); assert.equal(agent, role); assert.equal(id, profile.id); assert.deepEqual(value, binding);
      return { executable: "fixture-pty", argv: [], env: {}, repository, disposable_root: root, backend };
    },
    claimAuthorization(actual, value) {
      assert.equal(actual, profile); assert.deepEqual(value, binding); claims += 1;
      fs.writeFileSync(path.join(ledger, `${authorizationKey}.launch`), `${candidate}\n${profile.id}\n${authorizationKey}\n`, { flag: "wx", mode: 0o600 });
    },
  }, { get(target, prop) { if (!(prop in target)) throw new Error(`original profile operation forbidden: ${String(prop)}`); return target[prop]; } });
  const fakeGate = { assertReviewedExecutionGate(actual, value) { gates += 1; assert.equal(actual, profile); assert.deepEqual(value, binding); } };
  const compile = (filename, source, dependencies = {}) => {
    const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    const load = compiled.require.bind(compiled);
    compiled.require = request => Object.hasOwn(dependencies, request) ? dependencies[request] : load(request);
    compiled._compile(source, filename); return compiled.exports;
  };
  try {
    const filename = path.join(__dirname, "index.js");
    const source = fs.readFileSync(filename, "utf8");
    runtime = compile(filename, source + `\nmodule.exports.fixtureLaunch = runReviewedExecution;\nmodule.exports.fixturePrepare = profile => { reviewedPreclaimArgumentProfiles.set(profile.role, profile); installLifecycleTestFixture(REVIEWED_EXECUTION_PROJECT, profile.role, 'linux-contained'); };\nmodule.exports.fixtureInspect = role => { const s = agentSessions.get(REVIEWED_EXECUTION_PROJECT + '/' + role); return { retained: s.scrollback?.length || 0, structured: s._lifecycleStructuredConfirmed === true, state: lifecycleGovernor.snapshot(REVIEWED_EXECUTION_PROJECT, role) }; };\nmodule.exports.fixtureReplaceSession = role => { const key = REVIEWED_EXECUTION_PROJECT + '/' + role; agentSessions.set(key, { ...agentSessions.get(key) }); };\n`, {
      "node-pty": fakePty, "./reviewed-execution-profiles": fakeProfiles, "./reviewed-execution-gate": fakeGate,
    });
    runtime.fixturePrepare(profile);
    assert.equal(runtime.app.get("activeSessions"), undefined);
    assert.equal(runtime.lifecycleVerified, undefined);
    const childFilename = path.join(__dirname, "../benchmark/reviewed-execution-live-child-protocol.cjs");
    let childSource = fs.readFileSync(childFilename, "utf8");
    const injection = `module.exports = { completeFixedChild, seed(state) { fixed = Object.freeze({ ...state, cleanup_root: cleanupRootIdentity(state.root), pre: rootFacts(state.root) }); parentAdmitted = true; }, }; sourceFacts = () => fixed.facts; readGateReceipt = () => fixed.gate;`;
    assert.ok(childSource.includes("module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });"));
    childSource = childSource.replace("module.exports = Object.freeze({ prepareFixedChild, completeFixedChild, failedChildReport });", injection);
    const child = compile(childFilename, childSource, {
      "../server/reviewed-execution-profiles": fakeProfiles,
      "./reviewed-execution-contract.cjs": new Proxy({}, { get() { throw new Error("real contract probe forbidden in lifecycle fixture"); } }),
      "node:child_process": { execFileSync(command, args, options) { assert.equal(command, "/usr/bin/git"); assert.equal(options.cwd, repository); assert.deepEqual(args.slice(0, 2), ["-c", "credential.helper="]); assert.ok(["remote", "status"].includes(args[2])); return ""; } },
    });
    child.seed({ profile, facts: { expected_head: "e".repeat(40), candidate_digest: candidate }, gate: { receipt_digest: "f".repeat(64), ledger_directory: ledger, authorization_key: authorizationKey }, root, locations: { home }, previous: { HOME: home, USERPROFILE: home, QUADWORK_SKIP_LISTEN: "1" }, started: Date.now() });
    let beforeStop;
    const result = await child.completeFixedChild(role, {
      buildAgentArgs: runtime.buildAgentArgs, buildAgentEnv: runtime.buildAgentEnv,
      launch: async () => {
        launched = await runtime.fixtureLaunch(role); assert.equal(launched.ok, true, JSON.stringify(launched));
        assert.equal(Object.isFrozen(launched.reviewed_session), true);
        assert.equal(await terminalReadiness(), scenario === "early-data");
        if (backend === "codex") setImmediate(() => deliver().catch(error => { console.error(error.stack); process.exitCode = 1; }));
        if (scenario === "missing-observer") { const { lifecycleVerified, ...rest } = launched.reviewed_session; return { ...launched, reviewed_session: rest }; }
        return launched;
      },
      stopAgentSession: async (...args) => { beforeStop = runtime.fixtureInspect(role); return runtime.stopAgentSession(...args); },
      shutdown: runtime.shutdown,
    });
    assert.equal(claims, 1); assert.ok(gates >= 1);
    assert.equal(forbiddenAccesses, 0, "no original provider metadata or contents reached");
    assert.equal(beforeStop.retained, 0); assert.equal(beforeStop.structured, false);
    assert.equal(JSON.stringify(result).includes(syntheticPrivate), false);
    assert.equal(result.provider_turns, 1); assert.equal(result.launch_claim_state, "claimed");
    if (["completed", "early-data"].includes(scenario)) {
      assert.equal(result.result_class, "completed", JSON.stringify(result));
      assert.equal(result.lifecycle_verified, true); assert.equal(result.root_cleanup_ok, true); assert.equal(result.survivor_free, true);
      if (backend === "codex") assert.equal(beforeStop.state.state, "exited", "same-generation exit preserves prior accepted readiness");
    } else {
      assert.notEqual(result.result_class, "completed", JSON.stringify(result));
      if (["no-observation", "empty-observation", "stale-before-data", "stale-after-data", "replaced-session", "missing-observer"].includes(scenario)) assert.equal(result.lifecycle_verified, false);
      if (scenario === "failed-cleanup") assert.equal(result.result_class, "cleanup_failed");
    }
    assert.equal(fs.existsSync(root), false, "actual owned root removed");
    console.log("fixture passed");
  } finally {
    await runtime?.shutdown();
    for (const [name, original] of originals) fs[name] = original;
    for (const [name, original] of processOriginals) childProcess[name] = original;
    os.homedir = previousHome;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(ledger, { recursive: true, force: true });
  }
}
