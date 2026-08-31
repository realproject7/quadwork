"use strict";

// No test in this file launches systemd, node-pty, a real child, or pressure.
// Every host-facing boundary is dependency-injected and deterministic.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const {
  ACK_PREFIX,
  StagingProofError,
  runStagingProof,
} = require("./resource-staging-proof");
const {
  LIVE_MARKER_PREFIX,
  TEMP_PROOF_CONTRACT,
  MAX_STAGING_MEMORY_MAX_MIB,
  MAX_STAGING_SWAP_MAX_MIB,
  MAX_OOM_ALLOCATION_MIB,
  buildMonitorProofPayload,
  buildTempProofPayload,
  buildTempFactProofPayload,
  createGeneratedWorkerUnitBase,
  createLiveStagingAdapter,
} = require("./resource-staging-live-adapter");

function loadInternalTestFactory() {
  const filename = require.resolve("./resource-staging-live-adapter");
  const instrumented = new Module(filename, module);
  instrumented.filename = filename;
  instrumented.paths = Module._nodeModulePaths(path.dirname(filename));
  instrumented._compile(
    `${fs.readFileSync(filename, "utf8")}\nmodule.exports.__testFactory = createLiveStagingAdapterForTests;`,
    filename,
  );
  return instrumented.exports.__testFactory;
}

// This test-only handle does not exist on the production module exports. It is
// obtained from an isolated in-memory compilation so phase fakes cannot become
// a runtime authority bypass.
const createLiveStagingAdapterForTests = loadInternalTestFactory();

const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const ACK = `${ACK_PREFIX}${MACHINE_ID}`;
const CGROUP_ROOT = "/test-cgroup-v2";
const TEMP_PARENT = "/var/lib/quadwork/tmp";
const TEMP_ROOT = `${TEMP_PARENT}/generation-live-proof`;
const TEMP_FACT = Object.freeze({
  available: true,
  reason: null,
  code: "ready",
  configuredRoot: TEMP_PARENT,
  canonicalRoot: TEMP_PARENT,
  diskBacked: true,
});
const MONITOR_ID = "quadwork-staging-monitor";
const TEMP_PROVIDER_ID = "quadwork-provider-temp-probe";
const monitorKeys = crypto.generateKeyPairSync("ed25519");
const tempKeys = crypto.generateKeyPairSync("ed25519");
const tempFactKeys = crypto.generateKeyPairSync("ed25519");
const CANDIDATE = Object.freeze({
  status: "candidate_pending_staging",
  executable: "systemd-run",
  fixed_args: Object.freeze(["--user", "--scope", "--collect", "--quiet"]),
  pinned: true,
});

function target(overrides = {}) {
  return {
    projectId: "quadwork",
    generationId: "generation-live-proof",
    nodeExecutable: "/usr/bin/node",
    cwd: "/srv/quadwork",
    generationTempRoot: TEMP_ROOT,
    workerLimits: { memoryHighMib: 64, memoryMaxMib: 96, swapMaxMib: 32 },
    spawnEnv: {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    },
    tempFact: TEMP_FACT,
    tempProbe: {
      file: "/opt/quadwork/bin/provider-effective-temp-probe",
      args: ["--json-marker-v1"],
      providerId: TEMP_PROVIDER_ID,
      contract: TEMP_PROOF_CONTRACT,
      publicKey: tempKeys.publicKey,
    },
    ...overrides,
  };
}

function signedMonitorResult(request, facts, privateKey = monitorKeys.privateKey) {
  const kind = Object.hasOwn(facts, "count") ? "counter" : "health";
  const result = {
    adapterId: MONITOR_ID,
    runChallenge: request.runChallenge,
    probeChallenge: request.probeChallenge,
    ...facts,
  };
  result.signature = crypto.sign(null, buildMonitorProofPayload({
    runChallenge: request.runChallenge,
    probeChallenge: request.probeChallenge,
    adapterId: MONITOR_ID,
    probeName: request.probeName,
    label: request.label,
    kind,
    ...facts,
  }), privateKey).toString("base64url");
  return result;
}

function tempMarkerFromArgs(args, overrides = {}) {
  const runChallenge = args.find((arg) => arg.startsWith("--quadwork-run-challenge="))?.split("=")[1];
  const phaseChallenge = args.find((arg) => arg.startsWith("--quadwork-phase-challenge="))?.split("=")[1];
  const facts = {
    event: "effective_temp",
    path: TEMP_ROOT,
    provider_id: TEMP_PROVIDER_ID,
    contract: TEMP_PROOF_CONTRACT,
    run_challenge: runChallenge,
    phase_challenge: phaseChallenge,
    ...overrides,
  };
  facts.signature = crypto.sign(null, buildTempProofPayload({
    runChallenge,
    phaseChallenge,
    projectId: "quadwork",
    generationId: "generation-live-proof",
    providerId: TEMP_PROVIDER_ID,
    contract: TEMP_PROOF_CONTRACT,
    canonicalRoot: TEMP_PARENT,
    generationTempRoot: TEMP_ROOT,
    effectivePath: facts.path,
  }), tempKeys.privateKey).toString("base64url");
  return facts;
}

class FakePty {
  constructor(scenario, state) {
    this.scenario = scenario;
    this.state = state;
    this.dataHandler = null;
    this.exitHandler = null;
    this.started = false;
    this.exited = false;
  }

  onData(handler) {
    this.dataHandler = handler;
    this._scheduleStart();
    return { dispose: () => { this.state.disposals += 1; } };
  }

  onExit(handler) {
    this.exitHandler = handler;
    this._scheduleStart();
    return { dispose: () => { this.state.disposals += 1; } };
  }

  _scheduleStart() {
    if (this.started || !this.dataHandler || !this.exitHandler) return;
    this.started = true;
    queueMicrotask(() => this._start());
  }

  _marker(value) {
    this.dataHandler(`${LIVE_MARKER_PREFIX}${JSON.stringify(value)}\r\n`);
  }

  _exit(exitCode, signal = 0) {
    if (this.exited) return;
    this.exited = true;
    this.exitHandler({ exitCode, signal });
  }

  _start() {
    if (this.scenario === "tty") {
      this._marker({ event: "tty", stdin: true, stdout: true, stderr: true, tty_nr: "34817" });
      this._exit(0);
    } else if (this.scenario === "resize") {
      this._marker({ event: "ready", cols: 80, rows: 24 });
    } else if (this.scenario === "descendants") {
      this._marker({ event: "descendants", parent_pid: 101, child_pid: 202 });
    } else if (this.scenario === "temp") {
      this._marker(this.state.tempMarker);
      this._exit(0);
    } else if (this.scenario === "oom" || this.scenario === "oom-survives") {
      this._marker({ event: "oom_ready" });
    } else if (this.scenario === "oversized") {
      this.dataHandler("x".repeat(2048));
    }
  }

  resize(cols, rows) {
    this.state.resizes.push({ cols, rows });
    if (this.scenario === "resize") this._marker({ event: "resized", cols, rows });
  }

  write(value) {
    this.state.writes.push(value);
    if (this.scenario === "oom") {
      this.state.oomCounter = 1;
      this._exit(137, 9);
    } else if (this.scenario === "oom-survives") {
      this._marker({ event: "allocation_complete", allocated_mib: 144 });
    }
  }

  kill(signal) {
    this.state.kills.push({ scenario: this.scenario, signal });
    if (this.scenario === "resize" && signal === "SIGTERM") {
      this._marker({ event: "signal", signal: "SIGTERM" });
      this._exit(23);
    } else if (this.scenario === "descendants" && signal === "SIGTERM") {
      this._exit(0);
    } else {
      this._exit(137, 9);
    }
  }
}

function scenarioFromArgs(args) {
  const script = args.find((arg) => typeof arg === "string" && arg.includes(LIVE_MARKER_PREFIX));
  if (!script) return args.includes("/opt/quadwork/bin/provider-effective-temp-probe") ? "temp" : "unknown";
  if (script.includes("event:\"tty\"")) return "tty";
  if (script.includes("event:\"resized\"")) return "resize";
  if (script.includes("event:\"descendants\"")) return "descendants";
  if (script.includes("event:\"oom_ready\"")) return "oom";
  return "unknown";
}

function harness(overrides = {}) {
  const state = {
    gateCalls: 0,
    monitorCalls: [],
    ptyCalls: [],
    execCalls: [],
    readCalls: [],
    resizes: [],
    writes: [],
    kills: [],
    disposals: 0,
    oomCounter: 0,
    tempMarker: null,
  };
  const monitorProbes = {
    apiHealth: async (request) => { state.monitorCalls.push(["api", request.label]); return signedMonitorResult(request, { healthy: true, continuous: true }); },
    primaryChatWebSocket: async (request) => { state.monitorCalls.push(["chat", request.label]); return signedMonitorResult(request, { healthy: true, continuous: true }); },
    unrelatedWorkerHealth: async (request) => { state.monitorCalls.push(["worker", request.label]); return signedMonitorResult(request, { healthy: true, continuous: true }); },
    apiOomCounter: async (request) => { state.monitorCalls.push(["api-oom", request.label]); return signedMonitorResult(request, { count: 4 }); },
    globalOomCounter: async (request) => { state.monitorCalls.push(["global-oom", request.label]); return signedMonitorResult(request, { count: 7 }); },
  };
  const fsImpl = {
    readFileSync(filePath, encoding) {
      state.readCalls.push({ filePath, encoding });
      if (filePath.endsWith("/cgroup.procs")) return "101\n202\n303\n";
      if (filePath.endsWith("/memory.events.local")) return `oom 0\noom_kill ${state.oomCounter}\n`;
      const error = new Error(`SECRET PATH ${filePath}`);
      error.code = "ENOENT";
      throw error;
    },
    realpathSync(value) {
      if (![TEMP_PARENT, TEMP_ROOT].includes(value)) throw new Error("SECRET unexpected temp path");
      return value;
    },
    statfsSync(value, options) {
      assert.equal(value, TEMP_ROOT);
      assert.deepEqual(options, { bigint: true });
      return { type: 0xef53n, bavail: 10_000n, bsize: 4096n };
    },
  };
  const adapter = createLiveStagingAdapterForTests({
    runPressure: true,
    acknowledgement: ACK,
    target: target(),
    cgroupRoot: CGROUP_ROOT,
    phaseTimeoutMs: 2000,
    probeTimeoutMs: 1000,
    cleanupTimeoutMs: 100,
    maximumOutputBytes: 4096,
    gateProbe: async () => {
      state.gateCalls += 1;
      return { linux: true, cgroupV2: true, userManager: true, machineId: MACHINE_ID };
    },
    monitorProbes,
    monitorAuthority: { adapterId: MONITOR_ID, publicKey: monitorKeys.publicKey },
    tempFactAuthority: {
      authorityId: "quadwork-resource-temp",
      publicKey: tempFactKeys.publicKey,
      verify(request) {
        const valid = request.fact === TEMP_FACT;
        const payload = buildTempFactProofPayload({
          runChallenge: request.runChallenge,
          authorityId: "quadwork-resource-temp",
          projectId: request.projectId,
          generationId: request.generationId,
          canonicalRoot: TEMP_PARENT,
          generationTempRoot: request.generationTempRoot,
          available: true,
          code: "ready",
          diskBacked: true,
        });
        return {
          valid,
          authorityId: "quadwork-resource-temp",
          runChallenge: request.runChallenge,
          signature: crypto.sign(null, payload, tempFactKeys.privateKey).toString("base64url"),
        };
      },
    },
    ptySpawn(file, args, options) {
      const scenario = scenarioFromArgs(args);
      if (scenario === "temp") state.tempMarker = tempMarkerFromArgs(args);
      state.ptyCalls.push({ file, args, options, scenario });
      return new FakePty(scenario, state);
    },
    execFileSyncImpl(file, args, options) {
      state.execCalls.push({ file, args, options });
      if (args.includes("stop")) return "";
      const unitName = args.at(-1);
      return `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}\n`;
    },
    fsImpl,
    ...overrides,
  });
  return { adapter, state, monitorProbes, fsImpl };
}

// With all source-owned pin sets empty, the public factory refuses at the
// construction boundary before it reads options or can call any host adapter.
{
  let optionReads = 0;
  let boundaryCalls = 0;
  const options = new Proxy({
    gateProbe() { boundaryCalls += 1; },
    ptySpawn() { boundaryCalls += 1; },
    execFileSyncImpl() { boundaryCalls += 1; },
    fsImpl: { readFileSync() { boundaryCalls += 1; } },
  }, {
    get(targetValue, key, receiver) {
      optionReads += 1;
      return Reflect.get(targetValue, key, receiver);
    },
  });
  assert.throws(
    () => createLiveStagingAdapter(options),
    (error) => error instanceof StagingProofError
      && error.code === "proof_unavailable"
      && error.check === "live_staging_authorities_unpinned",
  );
  assert.equal(optionReads, 0);
  assert.equal(boundaryCalls, 0);
  assert.equal(Object.hasOwn(require("./resource-staging-live-adapter"), "createLiveStagingAdapterForTests"), false);
}

// Unit identities use the same domain-separated worker format, remain bounded,
// and do not admit delimiter ambiguity or plausible sample collisions.
{
  const first = createGeneratedWorkerUnitBase("quadwork", "generation-1");
  assert.equal(first, createGeneratedWorkerUnitBase("quadwork", "generation-1"));
  assert.match(first, /^quadwork-worker-[a-f0-9]{40}$/);
  assert(first.length <= 63);
  assert.notEqual(
    createGeneratedWorkerUnitBase("a", "b-c"),
    createGeneratedWorkerUnitBase("a-b", "c"),
  );
  const identities = new Set();
  for (let index = 0; index < 1000; index += 1) {
    identities.add(createGeneratedWorkerUnitBase(`project-${index}`, `generation-${index}`));
  }
  assert.equal(identities.size, 1000);

  assert.throws(() => harness({
    target: target({ spawnEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require=/tmp/forged.js" } }),
  }), /may not alter the staging probe runtime/);
  assert.throws(() => harness({ target: target({ generationTempRoot: "/" }) }), /normalized non-root/);
  assert.throws(
    () => harness({ target: target({ generationTempRoot: "/var/lib/quadwork/tmp/../tmp/generation-live-proof" }) }),
    /normalized non-root/,
  );
  assert.throws(
    () => harness({ target: target({ workerLimits: { memoryHighMib: 64, memoryMaxMib: MAX_STAGING_MEMORY_MAX_MIB + 1, swapMaxMib: 1 } }) }),
    /supported integer range/,
  );
  assert.throws(
    () => harness({ target: target({ workerLimits: { memoryHighMib: 64, memoryMaxMib: 96, swapMaxMib: MAX_STAGING_SWAP_MAX_MIB + 1 } }) }),
    /supported integer range/,
  );
  assert.throws(
    () => harness({ target: target({ tempProbe: { file: "/bin/echo", args: [] } }) }),
    /providerId/,
  );
}

// Construction and module loading are inert. The full coordinator path below
// executes only injected fakes after both exact disposable gates pass.
(async () => {
  const { adapter, state } = harness();
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(Object.getPrototypeOf(adapter)), true);
  assert.deepEqual(Object.keys(adapter), []);
  for (const [key, forged] of [
    ["runPressure", false],
    ["acknowledgement", `${ACK}x`],
    ["target", target({ nodeExecutable: "/tmp/forged-node" })],
    ["monitorAuthority", { trusted: true }],
    ["tempFactAuthority", { trusted: true }],
    ["ptySpawn", () => { throw new Error("forged"); }],
  ]) {
    assert.equal(Reflect.set(adapter, key, forged), false, `${key} cannot shadow private adapter state`);
  }
  assert.throws(() => Object.defineProperty(adapter, "gates", { value: {
    linux: true, cgroupV2: true, userManager: true, machineId: MACHINE_ID,
  } }), TypeError);
  assert.equal(state.gateCalls, 0);
  assert.equal(state.ptyCalls.length, 0);
  assert.equal(state.monitorCalls.length, 0);

  const result = await runStagingProof({
    adapter,
    runPressure: true,
    acknowledgement: ACK,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "proof_unavailable");
  assert.equal(result.started_phases.length, 0);
  assert.equal(result.monitor_checkpoints, 0);
  assert.equal(state.gateCalls, 1);
  assert.equal(state.ptyCalls.length, 0);
  assert.equal(state.monitorCalls.length, 0);

  // Until reviewed authority fingerprints are pinned in source, the public
  // factory is deliberately incapable of a PASS. Non-provider machinery is
  // still exercised directly behind the exact gate with injected fakes.
  for (const phaseId of [
    "node_pty_controlling_tty",
    "resize_signal_exit_propagation",
    "descendant_cgroup_membership",
    "bounded_worker_oom_counter",
  ]) {
    assert.equal((await adapter.runPhase(phaseId, { candidate: CANDIDATE })).status, "passed");
  }
  await assert.rejects(
    adapter.runPhase("effective_temp_disk_boundary", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "resource_temp_fact_authority_unpinned",
  );
  assert.equal(state.ptyCalls.length, 4);
  assert.deepEqual(state.resizes, [{ cols: 97, rows: 31 }]);
  assert.deepEqual(state.writes, ["go\n"]);
  assert.equal(state.disposals, 8, "both PTY listeners are disposed for every launched phase");
  assert.equal(typeof adapter._cleanupScope, "undefined", "arbitrary public cleanup is not exposed");

  const units = new Set();
  for (const call of state.ptyCalls) {
    assert.equal(call.file, "systemd-run");
    assert.deepEqual(call.args.slice(0, 4), ["--user", "--scope", "--collect", "--quiet"]);
    assert.equal(call.args.includes("--pipe"), false);
    const unitArg = call.args.find((arg) => arg.startsWith("--unit="));
    assert.match(unitArg, /^--unit=quadwork-worker-[a-f0-9]{40}$/);
    units.add(unitArg);
    assert.equal(call.options.cwd, "/srv/quadwork");
    assert.equal(call.options.env.PATH, "/usr/bin:/bin");
    assert.equal(Object.hasOwn(call.options, "shell"), false);
  }
  assert.equal(units.size, 4, "each disposable phase uses a distinct generated unit");
  const oomCall = state.ptyCalls.find((call) => call.scenario === "oom");
  const oomScriptText = oomCall.args.find((arg) => typeof arg === "string" && arg.includes("allocationLimitBytes"));
  assert.match(oomScriptText, /allocationLimitBytes = 144 \* 1024 \* 1024/);
  assert.match(oomScriptText, /while \(allocated < allocationLimitBytes\)/);
  assert.equal(oomScriptText.includes("setInterval(() => allocations.push"), false);
  assert(144 <= MAX_OOM_ALLOCATION_MIB);

  const observationCalls = state.execCalls.filter((call) => call.args.includes("--property=ControlGroup"));
  const cleanupCalls = state.execCalls.filter((call) => call.args.includes("stop"));
  assert.equal(observationCalls.length, 2);
  assert.equal(cleanupCalls.length, 4, "every registered scope receives an exact cleanup command");
  for (const call of observationCalls) {
    assert.equal(call.file, "systemctl");
    assert.deepEqual(call.args.slice(0, 4), ["--user", "--property=ControlGroup", "--value", "show"]);
    assert.match(call.args[4], /^quadwork-worker-[a-f0-9]{40}\.scope$/);
    assert.equal(Object.hasOwn(call.options, "shell"), false);
    assert.equal(call.options.timeout, 1000);
    assert.equal(call.options.maxBuffer, 4096);
  }
  for (const call of cleanupCalls) {
    assert.equal(call.file, "systemctl");
    assert.deepEqual(call.args.slice(0, 2), ["--user", "stop"]);
    assert.match(call.args[2], /^quadwork-worker-[a-f0-9]{40}\.scope$/);
    assert.equal(Object.hasOwn(call.options, "shell"), false);
    assert.equal(call.options.timeout, 100);
  }
  assert(state.readCalls.every((call) => call.filePath.startsWith(`${CGROUP_ROOT}${path.sep}`)));
  const serialized = JSON.stringify(result);
  for (const secret of [TEMP_ROOT, "/srv/quadwork", "DBUS_SESSION_BUS_ADDRESS", "user-1000.slice"]) {
    assert.equal(serialized.includes(secret), false);
  }

  // A wrong adapter acknowledgement blocks direct phase and monitor use even
  // if a caller supplies otherwise-valid coordinator context.
  const wrong = harness({ acknowledgement: `${ACK}x` });
  await wrong.adapter.inspectGates();
  await assert.rejects(
    wrong.adapter.runPhase("node_pty_controlling_tty", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError
      && error.code === "proof_refused"
      && error.check === "disposable_gate_required",
  );
  assert.equal(wrong.state.ptyCalls.length, 0);
  assert.equal(wrong.state.monitorCalls.length, 0);

  const disabled = harness({ runPressure: false });
  await disabled.adapter.inspectGates();
  await assert.rejects(
    disabled.adapter.startContinuousMonitoring({ candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.code === "proof_refused",
  );
  assert.equal(disabled.state.monitorCalls.length, 0);

  const drifted = harness();
  await drifted.adapter.inspectGates();
  await assert.rejects(
    drifted.adapter.runPhase("node_pty_controlling_tty", {
      candidate: { ...CANDIDATE, fixed_args: [...CANDIDATE.fixed_args, "--pipe"] },
    }),
    (error) => error instanceof StagingProofError && error.check === "candidate_contract_mismatch",
  );
  assert.equal(drifted.state.ptyCalls.length, 0);

  // Underscore-named helpers cannot bypass the public gate: the module-private
  // token is required before any PTY or cleanup-capable path is entered.
  const bypass = harness();
  await bypass.adapter.inspectGates();
  await assert.rejects(
    async () => bypass.adapter._ttyPhase("node_pty_controlling_tty"),
    (error) => error instanceof StagingProofError && error.check === "internal_phase_boundary_required",
  );
  await assert.rejects(
    async () => bypass.adapter._withPty("node_pty_controlling_tty", { file: "/bin/true", args: [] }, async () => ({})),
    (error) => error instanceof StagingProofError && error.check === "internal_phase_boundary_required",
  );
  assert.equal(bypass.state.ptyCalls.length, 0);
  assert.equal(bypass.state.execCalls.length, 0);

  const spawnFailure = harness({ ptySpawn() { throw new Error("SECRET partial spawn"); } });
  await spawnFailure.adapter.inspectGates();
  await assert.rejects(
    spawnFailure.adapter.runPhase("node_pty_controlling_tty", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "pty_spawn_unavailable",
  );
  assert.equal(spawnFailure.state.execCalls.length, 0, "unreturned spawn never authorizes a predicted-unit stop");

  const uniqueRunA = harness();
  const uniqueRunB = harness();
  await uniqueRunA.adapter.inspectGates();
  await uniqueRunB.adapter.inspectGates();
  await uniqueRunA.adapter.runPhase("node_pty_controlling_tty", { candidate: CANDIDATE });
  await uniqueRunB.adapter.runPhase("node_pty_controlling_tty", { candidate: CANDIDATE });
  const uniqueUnitA = uniqueRunA.state.ptyCalls[0].args.find((arg) => arg.startsWith("--unit="));
  const uniqueUnitB = uniqueRunB.state.ptyCalls[0].args.find((arg) => arg.startsWith("--unit="));
  assert.notEqual(uniqueUnitA, uniqueUnitB, "per-run challenge makes cleanup ownership unpredictable");

  // Authenticated probes are mandatory; booleans and echoed challenges are not
  // authority without the independently pinned adapter signature.
  const missingMonitor = harness({ monitorProbes: {} });
  await missingMonitor.adapter.inspectGates();
  await assert.rejects(
    missingMonitor.adapter.startContinuousMonitoring({ candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "authenticated_monitor_probes_required",
  );

  // Supplying a fresh key and matching signer is still self-assertion. The
  // source-owned fingerprint set is intentionally empty, so the public factory
  // stops before invoking any such probe.
  const selfAsserted = harness();
  await selfAsserted.adapter.inspectGates();
  await assert.rejects(
    selfAsserted.adapter.startContinuousMonitoring({ candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "staging_monitor_authority_unpinned",
  );
  assert.equal(selfAsserted.state.monitorCalls.length, 0);

  const noMonitorAuthority = harness({ monitorAuthority: null });
  await noMonitorAuthority.adapter.inspectGates();
  await assert.rejects(
    noMonitorAuthority.adapter.startContinuousMonitoring({ candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "authenticated_monitor_probes_required",
  );

  const firstPayload = buildMonitorProofPayload({
    runChallenge: "a".repeat(64), probeChallenge: "b".repeat(64), adapterId: MONITOR_ID,
    probeName: "apiHealth", label: "first", kind: "health", healthy: true, continuous: true,
  });
  const secondPayload = buildMonitorProofPayload({
    runChallenge: "a".repeat(64), probeChallenge: "c".repeat(64), adapterId: MONITOR_ID,
    probeName: "apiHealth", label: "second", kind: "health", healthy: true, continuous: true,
  });
  const firstSignature = crypto.sign(null, firstPayload, monitorKeys.privateKey);
  assert.equal(crypto.verify(null, secondPayload, monitorKeys.publicKey, firstSignature), false,
    "a signed probe response cannot replay across challenge or checkpoint");

  // Provider-specific effective TMPDIR evidence is never simulated. Without
  // an explicit target probe, the phase fails typed before spawning anything.
  const noTemp = harness({ target: target({ tempProbe: undefined }) });
  await noTemp.adapter.inspectGates();
  await assert.rejects(
    noTemp.adapter.runPhase("effective_temp_disk_boundary", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "target_effective_temp_probe_required",
  );
  assert.equal(noTemp.state.ptyCalls.length, 0);

  const invalidTempFact = harness({ target: target({ tempFact: { ...TEMP_FACT, diskBacked: false } }) });
  await invalidTempFact.adapter.inspectGates();
  await assert.rejects(
    invalidTempFact.adapter.runPhase("effective_temp_disk_boundary", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "resource_temp_fact_invalid",
  );
  assert.equal(invalidTempFact.state.ptyCalls.length, 0);

  const identityRealpathFs = {
    ...harness().fsImpl,
    realpathSync(value) { return value; },
  };
  const outsideTemp = harness({
    target: target({ generationTempRoot: "/outside/generation-live-proof" }),
    fsImpl: identityRealpathFs,
  });
  await outsideTemp.adapter.inspectGates();
  await assert.rejects(
    outsideTemp.adapter.runPhase("effective_temp_disk_boundary", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "generation_temp_boundary_invalid",
  );
  assert.equal(outsideTemp.state.ptyCalls.length, 0);

  const aliasPath = `${TEMP_PARENT}/generation-alias`;
  const aliasTemp = harness({
    target: target({ generationTempRoot: aliasPath }),
    fsImpl: {
      ...harness().fsImpl,
      realpathSync(value) { return value === aliasPath ? TEMP_ROOT : value; },
    },
  });
  await aliasTemp.adapter.inspectGates();
  await assert.rejects(
    aliasTemp.adapter.runPhase("effective_temp_disk_boundary", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "generation_temp_boundary_invalid",
  );
  assert.equal(aliasTemp.state.ptyCalls.length, 0);

  const rootFact = Object.freeze({ ...TEMP_FACT, configuredRoot: "/", canonicalRoot: "/" });
  const rootBoundary = harness({
    target: target({ tempFact: rootFact }),
    tempFactAuthority: {
      authorityId: "root-fact",
      publicKey: tempFactKeys.publicKey,
      verify({ fact }) { return fact === rootFact; },
    },
  });
  await rootBoundary.adapter.inspectGates();
  await assert.rejects(
    rootBoundary.adapter.runPhase("effective_temp_disk_boundary", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "resource_temp_fact_invalid",
  );
  assert.equal(rootBoundary.state.ptyCalls.length, 0);

  const tempPayload = buildTempProofPayload({
    runChallenge: "d".repeat(64), phaseChallenge: "e".repeat(64),
    projectId: "quadwork", generationId: "generation-live-proof",
    providerId: TEMP_PROVIDER_ID, contract: TEMP_PROOF_CONTRACT,
    canonicalRoot: TEMP_PARENT, generationTempRoot: TEMP_ROOT, effectivePath: TEMP_ROOT,
  });
  const tempSignature = crypto.sign(null, tempPayload, tempKeys.privateKey);
  const replayedTempPayload = buildTempProofPayload({
    runChallenge: "d".repeat(64), phaseChallenge: "f".repeat(64),
    projectId: "quadwork", generationId: "generation-live-proof",
    providerId: TEMP_PROVIDER_ID, contract: TEMP_PROOF_CONTRACT,
    canonicalRoot: TEMP_PARENT, generationTempRoot: TEMP_ROOT, effectivePath: TEMP_ROOT,
  });
  assert.equal(crypto.verify(null, replayedTempPayload, tempKeys.publicKey, tempSignature), false,
    "a static provider marker cannot replay across the unpredictable phase challenge");

  // A mismatched unit path is unavailable, never read, and the live PTY is
  // killed and disposed exactly on the failure path without leaking raw data.
  const mismatch = harness({
    execFileSyncImpl() { return `/user.slice/app.slice/quadwork-worker-${"0".repeat(40)}.scope\n`; },
  });
  await mismatch.adapter.inspectGates();
  await assert.rejects(
    mismatch.adapter.runPhase("descendant_cgroup_membership", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "control_group_invalid",
  );
  assert.equal(mismatch.state.readCalls.length, 0);
  assert.deepEqual(mismatch.state.kills, [{ scenario: "descendants", signal: "SIGKILL" }]);
  assert.equal(mismatch.state.disposals, 2);

  const oomWithoutContainment = harness({
    execFileSyncImpl(file, args) {
      if (args.includes("stop")) return "";
      return `/user.slice/app.slice/quadwork-worker-${"0".repeat(40)}.scope\n`;
    },
  });
  await oomWithoutContainment.adapter.inspectGates();
  await assert.rejects(
    oomWithoutContainment.adapter.runPhase("bounded_worker_oom_counter", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "control_group_invalid",
  );
  assert.equal(oomWithoutContainment.state.writes.length, 0, "allocator never starts without exact containment");
  assert.equal(oomWithoutContainment.state.disposals, 2);

  // Bounded output aborts and cleans up a noisy PTY without echoing its bytes.
  const noisy = harness({
    maximumOutputBytes: 1024,
    ptySpawn() { return new FakePty("oversized", noisy.state); },
  });
  await noisy.adapter.inspectGates();
  await assert.rejects(
    noisy.adapter.runPhase("node_pty_controlling_tty", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "pty_output_invalid",
  );
  assert.deepEqual(noisy.state.kills, [{ scenario: "oversized", signal: "SIGKILL" }]);
  assert.equal(noisy.state.disposals, 2);

  const silent = harness({
    phaseTimeoutMs: 10,
    ptySpawn() { return new FakePty("unknown", silent.state); },
  });
  await silent.adapter.inspectGates();
  await assert.rejects(
    silent.adapter.runPhase("node_pty_controlling_tty", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "node_pty_controlling_tty_timeout",
  );
  assert.deepEqual(silent.state.kills, [{ scenario: "unknown", signal: "SIGKILL" }]);
  assert.equal(silent.state.disposals, 2);

  const survivedPressure = harness({
    ptySpawn() { return new FakePty("oom-survives", survivedPressure.state); },
  });
  await survivedPressure.adapter.inspectGates();
  await assert.rejects(
    survivedPressure.adapter.runPhase("bounded_worker_oom_counter", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "bounded_allocator_survived_without_oom",
  );
  assert.deepEqual(survivedPressure.state.kills, [{ scenario: "oom-survives", signal: "SIGKILL" }]);
  assert.equal(survivedPressure.state.disposals, 2);

  // Cleanup cannot be waved through: if stop fails and the unit is still
  // loaded/active, an otherwise-successful phase is unavailable.
  const cleanupFailure = harness({
    execFileSyncImpl(file, args) {
      assert.equal(file, "systemctl");
      if (args.includes("stop")) throw new Error("SECRET stop failed");
      if (args.includes("--property=LoadState")) return "loaded\nactive\n";
      throw new Error("unexpected systemctl call");
    },
  });
  await cleanupFailure.adapter.inspectGates();
  await assert.rejects(
    cleanupFailure.adapter.runPhase("node_pty_controlling_tty", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "node_pty_controlling_tty_cleanup_failed",
  );
  assert.equal(cleanupFailure.state.disposals, 2);

  console.log("resource-staging-live-adapter.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
