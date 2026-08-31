"use strict";

// No test in this file launches systemd, node-pty, a real child, or pressure.
// Every host-facing boundary is dependency-injected and deterministic.

const assert = require("node:assert/strict");
const path = require("node:path");
const {
  ACK_PREFIX,
  StagingProofError,
  runStagingProof,
} = require("./resource-staging-proof");
const {
  LIVE_MARKER_PREFIX,
  createGeneratedWorkerUnitBase,
  createLiveStagingAdapter,
} = require("./resource-staging-live-adapter");

const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const ACK = `${ACK_PREFIX}${MACHINE_ID}`;
const CGROUP_ROOT = "/test-cgroup-v2";
const TEMP_ROOT = "/var/lib/quadwork/tmp/generation-live-proof";
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
    tempProbe: { file: "/opt/quadwork/bin/provider-effective-temp-probe", args: ["--json-marker-v1"] },
    ...overrides,
  };
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
      this._marker({ event: "effective_temp", path: TEMP_ROOT });
      this._exit(0);
    } else if (this.scenario === "oom") {
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
  };
  const monitorProbes = {
    apiHealth: async ({ label }) => { state.monitorCalls.push(["api", label]); return { authenticated: true, healthy: true, continuous: true }; },
    primaryChatWebSocket: async ({ label }) => { state.monitorCalls.push(["chat", label]); return { authenticated: true, healthy: true, continuous: true }; },
    unrelatedWorkerHealth: async ({ label }) => { state.monitorCalls.push(["worker", label]); return { authenticated: true, healthy: true, continuous: true }; },
    apiOomCounter: async ({ label }) => { state.monitorCalls.push(["api-oom", label]); return { authenticated: true, count: 4 }; },
    globalOomCounter: async ({ label }) => { state.monitorCalls.push(["global-oom", label]); return { authenticated: true, count: 7 }; },
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
      if (value !== TEMP_ROOT) throw new Error("SECRET unexpected temp path");
      return TEMP_ROOT;
    },
    statfsSync(value, options) {
      assert.equal(value, TEMP_ROOT);
      assert.deepEqual(options, { bigint: true });
      return { type: 0xef53n, bavail: 10_000n, bsize: 4096n };
    },
  };
  const adapter = createLiveStagingAdapter({
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
    ptySpawn(file, args, options) {
      const scenario = scenarioFromArgs(args);
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
}

// Construction and module loading are inert. The full coordinator path below
// executes only injected fakes after both exact disposable gates pass.
(async () => {
  const { adapter, state } = harness();
  assert.equal(state.gateCalls, 0);
  assert.equal(state.ptyCalls.length, 0);
  assert.equal(state.monitorCalls.length, 0);

  const result = await runStagingProof({
    adapter,
    runPressure: true,
    acknowledgement: ACK,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "proof_passed");
  assert.equal(result.started_phases.length, 5);
  assert.equal(result.monitor_checkpoints, 11);
  assert.equal(state.gateCalls, 1);
  assert.equal(state.ptyCalls.length, 5);
  assert.equal(state.monitorCalls.length, 55);
  assert.deepEqual(state.resizes, [{ cols: 97, rows: 31 }]);
  assert.deepEqual(state.writes, ["go\n"]);
  assert.equal(state.disposals, 10, "both PTY listeners are disposed for every phase");

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
  assert.equal(units.size, 5, "each disposable phase uses a distinct generated unit");
  assert.equal(state.ptyCalls.find((call) => call.scenario === "temp").options.env.TMPDIR, TEMP_ROOT);

  const observationCalls = state.execCalls.filter((call) => call.args.includes("--property=ControlGroup"));
  const cleanupCalls = state.execCalls.filter((call) => call.args.includes("stop"));
  assert.equal(observationCalls.length, 2);
  assert.equal(cleanupCalls.length, 5, "every generated scope receives an exact cleanup command");
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

  // Authenticated probes are mandatory; a mere healthy boolean is not enough.
  const missingMonitor = harness({ monitorProbes: {} });
  await missingMonitor.adapter.inspectGates();
  await assert.rejects(
    missingMonitor.adapter.startContinuousMonitoring({ candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "authenticated_monitor_probes_required",
  );

  const unauthenticatedProbes = {
    ...harness().monitorProbes,
    apiHealth: async () => ({ healthy: true, continuous: true }),
  };
  const unauthenticated = harness({ monitorProbes: unauthenticatedProbes });
  await unauthenticated.adapter.inspectGates();
  const monitor = await unauthenticated.adapter.startContinuousMonitoring({ candidate: CANDIDATE });
  await assert.rejects(
    monitor.checkpoint("matrix_start"),
    (error) => error instanceof StagingProofError && error.check === "authenticated_monitor_result_invalid",
  );
  await monitor.stop();

  const gapProbeSet = {
    ...harness().monitorProbes,
    primaryChatWebSocket: async () => ({ authenticated: true, healthy: true, continuous: false }),
  };
  const gap = harness({ monitorProbes: gapProbeSet });
  await gap.adapter.inspectGates();
  const gapMonitor = await gap.adapter.startContinuousMonitoring({ candidate: CANDIDATE });
  assert.deepEqual(await gapMonitor.checkpoint("matrix_start"), { healthy: false });
  assert.equal((await gapMonitor.stop()).primary_chat_websocket_continuously_healthy, false);

  // Provider-specific effective TMPDIR evidence is never simulated. Without
  // an explicit target probe, the phase fails typed before spawning anything.
  const noTemp = harness({ target: target({ tempProbe: undefined }) });
  await noTemp.adapter.inspectGates();
  await assert.rejects(
    noTemp.adapter.runPhase("effective_temp_disk_boundary", { candidate: CANDIDATE }),
    (error) => error instanceof StagingProofError && error.check === "target_effective_temp_probe_required",
  );
  assert.equal(noTemp.state.ptyCalls.length, 0);

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

  // A probe that ignores completion is bounded and receives an abort signal.
  let probeAborted = false;
  const slowProbeSet = { ...harness().monitorProbes };
  slowProbeSet.apiHealth = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      probeAborted = true;
      resolve({ authenticated: true, healthy: true, continuous: true });
    }, { once: true });
  });
  const slowProbe = harness({ probeTimeoutMs: 10, monitorProbes: slowProbeSet });
  await slowProbe.adapter.inspectGates();
  const boundedMonitor = await slowProbe.adapter.startContinuousMonitoring({ candidate: CANDIDATE });
  await assert.rejects(
    boundedMonitor.checkpoint("matrix_start"),
    (error) => error instanceof StagingProofError && error.check === "monitor_apiHealth_unavailable",
  );
  assert.equal(probeAborted, true);
  await boundedMonitor.stop();

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
