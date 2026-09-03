// #1038: argument-array systemd scope candidate, leaf-only control semaphore,
// redacted observations, and terminal-fact classification. No real systemd or
// node-pty process is used here; the disposable VPS staging matrix owns that
// evidence before this candidate can become the supported launcher contract.

"use strict";

const assert = require("node:assert/strict");
const {
  SYSTEMD_SCOPE_CANDIDATE,
  SYSTEMD_CONTROL_CLASS_CANDIDATE,
  DEFAULT_CONTROL_CLASS_NAME,
  ResourceController,
  buildWorkerScopeInvocation,
  buildControlClassConfiguration,
  buildControlScopeInvocation,
  validateUnitName,
  getResourceRejectionMetadata,
} = require("./resource-controller");

let passed = 0;
const OBSERVED_AT = "2026-08-31T00:00:00.000Z";
function observation(oomKillCount, extras = {}) {
  return { oomKillCount, observedAt: OBSERVED_AT, ...extras };
}
const noOom = async () => observation(0);
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

function workerSpec(overrides = {}) {
  return {
    projectId: "quadwork",
    generationId: "gen-7",
    unitName: "qw-worker-quadwork-gen-7",
    command: "/opt/Quad Work/bin/codex",
    args: ["exec", "ticket; echo-not-a-shell"],
    limits: { memoryHighMib: 1024, memoryMaxMib: 1200, swapMaxMib: 512 },
    ...overrides,
  };
}

function controlSpec(index, overrides = {}) {
  return {
    projectId: "quadwork",
    generationId: `refresh-${index}`,
    unitName: `qw-control-${index}`,
    command: "gh",
    args: ["api", `repos/realproject7/quadwork/issues/${index}`],
    controlClassName: DEFAULT_CONTROL_CLASS_NAME,
    ...overrides,
  };
}

async function main() {
  ok(SYSTEMD_SCOPE_CANDIDATE.status === "candidate_pending_staging",
    "systemd user-scope flags are explicitly marked as a staging candidate");

  const worker = buildWorkerScopeInvocation(workerSpec());
  assert.deepEqual(worker.args, [
    "--user", "--scope", "--collect", "--quiet",
    "--unit=qw-worker-quadwork-gen-7",
    "-p", "MemoryHigh=1024M",
    "-p", "MemoryMax=1200M",
    "-p", "MemorySwapMax=512M",
    "--", "/opt/Quad Work/bin/codex", "exec", "ticket; echo-not-a-shell",
  ]);
  ok(worker.file === "systemd-run" && !worker.args.includes("--pipe"),
    "worker invocation is the exact no-pipe candidate flag set");
  ok(worker.args.at(-1) === "ticket; echo-not-a-shell" && !worker.shell,
    "command data remains one argument and no shell option exists");

  const controlClass = buildControlClassConfiguration({
    controlClassName: DEFAULT_CONTROL_CLASS_NAME,
    limits: { memoryMaxMib: 512, swapMaxMib: 256 },
  });
  assert.deepEqual(controlClass.args, [
    "--user", "--runtime", "set-property", "quadwork-control.slice",
    "MemoryMax=512M", "MemorySwapMax=256M",
  ]);
  ok(controlClass.file === "systemctl" &&
     controlClass.candidateStatus === SYSTEMD_CONTROL_CLASS_CANDIDATE.status,
    "control aggregate limits have one separate explicit candidate builder");

  const control = buildControlScopeInvocation(controlSpec(1));
  assert.deepEqual(control.args.slice(0, 8), [
    "--user", "--scope", "--collect", "--quiet", "--unit=qw-control-1",
    "--slice=quadwork-control.slice", "--", "gh",
  ]);
  ok(!control.args.some((arg) => /^Memory(?:High|Max|SwapMax)=/.test(arg)),
    "a control child joins the shared class without repeating aggregate limits");
  assert.throws(() => buildControlScopeInvocation(controlSpec(2, {
    limits: { memoryMaxMib: 512, swapMaxMib: 256 },
  })), { code: "QW_INVALID_RESOURCE_ARGUMENT" });
  ok(true, "per-child control limits are rejected instead of being silently duplicated");

  for (const bad of ["", "Upper", "has space", "has/slash", "x;rm", `a${"b".repeat(63)}`]) {
    assert.throws(() => validateUnitName(bad), { code: "QW_INVALID_RESOURCE_ARGUMENT" });
  }
  ok(true, "unsafe, uppercase, path-like, shell-like, and overlong unit names are rejected");
  assert.throws(() => buildWorkerScopeInvocation(workerSpec({ projectId: "../other" })),
    { code: "QW_INVALID_RESOURCE_ARGUMENT" });
  assert.throws(() => buildWorkerScopeInvocation(workerSpec({ limits: { memoryHighMib: 1300, memoryMaxMib: 1200, swapMaxMib: 512 } })),
    { code: "QW_INVALID_RESOURCE_ARGUMENT" });
  ok(true, "project qualification and high <= max are validated before execution");
  assert.throws(() => new ResourceController({ executeProcess: async () => ({ code: 0 }) }),
    { code: "QW_INVALID_RESOURCE_ARGUMENT" });
  ok(true, "scope querying is a required dependency rather than an implicit no-observation fallback");

  // High-level recursive fan-out never owns permits; only its actual process
  // leaves call runControlChild. With limit=2 this must complete and never run
  // more than two fake children concurrently.
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const controlInvocations = [];
  const fanoutController = new ResourceController({
    maxControlChildren: 2,
    executeProcess: async ({ args }) => {
      controlInvocations.push(args);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return { code: 0, signal: null };
    },
    queryScope: noOom,
  });
  function nestedFanout(depth, prefix) {
    if (depth === 0) return fanoutController.runControlChild(controlSpec(prefix));
    return Promise.all([
      nestedFanout(depth - 1, `${prefix}1`),
      nestedFanout(depth - 1, `${prefix}2`),
    ]);
  }
  const fanout = nestedFanout(2, "1");
  await new Promise((resolve) => setImmediate(resolve));
  ok(fanoutController.snapshot().control_children.active === 2 &&
     fanoutController.snapshot().control_children.queued === 2,
    "nested high-level fan-out queues only leaf children at the host-wide limit");
  assert.equal(controlInvocations.length, 2);
  for (const args of controlInvocations) {
    assert.ok(args.includes("--slice=quadwork-control.slice"));
    assert.ok(!args.some((arg) => /^Memory(?:High|Max|SwapMax)=/.test(arg)));
  }
  ok(true, "two simultaneous control children share one slice without multiplying its limits");
  while (releases.length > 0) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await fanout;
  ok(maxActive === 2 && fanoutController.snapshot().control_children.active === 0,
    "nested fan-out completes without deadlock and releases every permit");

  let queryCalls = 0;
  const times = [
    "2026-08-31T00:00:00.000Z", "2026-08-31T00:00:01.000Z",
    "2026-08-31T00:00:02.000Z", "2026-08-31T00:00:03.000Z",
  ];
  const normalController = new ResourceController({
    executeProcess: async ({ file, args }) => {
      assert.equal(file, "systemd-run");
      assert.ok(Array.isArray(args));
      return { code: 0, signal: null };
    },
    queryScope: async ({ projectId, generationId, unitName }) => {
      queryCalls += 1;
      assert.equal(projectId, "quadwork");
      assert.equal(generationId, "gen-7");
      assert.equal(unitName, "qw-worker-quadwork-gen-7");
      return observation(0);
    },
    now: () => times.shift(),
  });
  const normal = await normalController.runWorkerScope(workerSpec());
  ok(normal.fact.reason === "normal_exit" && normal.fact.exit_code === 0 && queryCalls === 1,
    "normal worker exit is project/generation qualified and scope-query backed");
  assert.equal(Object.hasOwn(normal.fact, "oom_kill_count"), false);
  assert.equal(Object.hasOwn(normal.fact, "oom_observed_at"), false);
  assert.equal(normal.cgroup_oom_observation.oom_kill_count, "0");
  assert.equal(normalController.snapshot().last_cgroup_oom.oom_kill_count, "0");

  let releaseIsoExecution;
  const isoTimes = ["2026-08-31T09:00:00+09:00", "2026-08-31T09:00:01+09:00"];
  const isoController = new ResourceController({
    executeProcess: async () => new Promise((resolve) => {
      releaseIsoExecution = () => resolve({ code: 0, signal: null });
    }),
    queryScope: noOom,
    now: () => isoTimes.shift(),
  });
  const isoRun = isoController.runWorkerScope(workerSpec());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isoController.snapshot().active_scopes[0].started_at, "2026-08-31T00:00:00.000Z");
  releaseIsoExecution();
  const isoResult = await isoRun;
  assert.equal(isoResult.fact.finished_at, "2026-08-31T00:00:01.000Z");
  ok(true, "started and finished timestamps cross the controller boundary as canonical ISO values");

  const signalController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGTERM" }),
    queryScope: noOom,
  });
  const signalled = await signalController.runWorkerScope(workerSpec());
  ok(signalled.fact.reason === "signal" && signalled.fact.signal === "SIGTERM",
    "signal terminal facts preserve the exact signal");

  const numericSignalController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: 15 }),
    queryScope: async () => observation(0n),
  });
  const numericSignal = await numericSignalController.runWorkerScope(workerSpec());
  ok(numericSignal.fact.reason === "signal" && numericSignal.fact.signal === 15,
    "numeric node-pty signals are preserved instead of being normalized away");

  for (const [index, invalidSignal] of [
    "TERM", "sigterm", "SIG", "SIGTERM!", `SIG${"A".repeat(31)}`,
    0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined,
  ].entries()) {
    const invalidSignalController = new ResourceController({
      executeProcess: async () => ({ code: null, signal: invalidSignal }),
      queryScope: noOom,
    });
    const invalidSignalResult = await invalidSignalController.runWorkerScope(workerSpec({
      generationId: `invalid-signal-${index}`,
      unitName: `qw-worker-invalid-signal-${index}`,
    }));
    assert.equal(invalidSignalResult.fact.reason, "unknown");
    assert.equal(invalidSignalResult.fact.signal, null);
  }
  ok(true, "signals outside the state-compatible name/integer boundary become null unknown facts");

  for (const [index, invalidCode] of [
    -1, 256, 1.5, Number.MAX_SAFE_INTEGER + 1, "0", undefined,
  ].entries()) {
    const invalidCodeController = new ResourceController({
      executeProcess: async () => ({ code: invalidCode, signal: null }),
      queryScope: noOom,
    });
    const invalidCodeResult = await invalidCodeController.runWorkerScope(workerSpec({
      generationId: `invalid-exit-${index}`,
      unitName: `qw-worker-invalid-exit-${index}`,
    }));
    assert.equal(invalidCodeResult.fact.reason, "unknown");
    assert.equal(invalidCodeResult.fact.exit_code, null);
  }
  const exit255Controller = new ResourceController({
    executeProcess: async () => ({ code: 255, signal: null }),
    queryScope: noOom,
  });
  const exit255 = await exit255Controller.runWorkerScope(workerSpec());
  assert.equal(exit255.fact.reason, "unknown");
  assert.equal(exit255.fact.exit_code, 255);
  ok(true, "exit codes normalize once to null or the inclusive safe 0..255 range");

  const oomController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
    queryScope: async () => observation(1, {
      observedAt: "2026-08-31T09:30:00+09:00",
      secret: "must-not-survive-normalization",
    }),
  });
  const oom = await oomController.runWorkerScope(workerSpec());
  ok(oom.fact.reason === "oom_kill" && oom.fact.signal === "SIGKILL",
    "confirmed cgroup OOM wins classification without dropping its signal");
  assert.equal(oom.fact.oom_kill_count, "1");
  assert.equal(oom.fact.oom_observed_at, "2026-08-31T00:30:00.000Z");
  assert.deepEqual(oom.cgroup_oom_observation, {
    project_id: "quadwork",
    generation_id: "gen-7",
    resource_class: "worker",
    unit_name: "qw-worker-quadwork-gen-7",
    oom_kill_count: "1",
    observed_at: "2026-08-31T00:30:00.000Z",
  });
  assert.deepEqual(oomController.snapshot().last_cgroup_oom, oom.cgroup_oom_observation);
  ok(!JSON.stringify(oomController.snapshot()).includes("must-not-survive-normalization"),
    "qualified OOM provenance maps directly to resource-state without injected-field leakage");

  const invalidTerminalOomController = new ResourceController({
    executeProcess: async () => ({ code: 999, signal: "KILL" }),
    queryScope: async () => observation(1),
  });
  const invalidTerminalOom = await invalidTerminalOomController.runWorkerScope(workerSpec());
  assert.equal(invalidTerminalOom.fact.reason, "unknown");
  assert.equal(invalidTerminalOom.fact.exit_code, null);
  assert.equal(invalidTerminalOom.fact.signal, null);
  assert.equal(Object.hasOwn(invalidTerminalOom.fact, "oom_kill_count"), false);
  assert.equal(Object.hasOwn(invalidTerminalOom.fact, "oom_observed_at"), false);
  assert.equal(invalidTerminalOom.cgroup_oom_observation.oom_kill_count, "1");
  ok(true, "valid OOM evidence cannot override invalid terminal metadata");

  for (const [index, count] of [0, 1].entries()) {
    const contradictoryController = new ResourceController({
      executeProcess: async () => ({ code: 143, signal: "SIGTERM" }),
      queryScope: async () => observation(count),
    });
    const contradictory = await contradictoryController.runWorkerScope(workerSpec({
      generationId: `contradictory-${index}`,
      unitName: `qw-worker-contradictory-${index}`,
    }));
    assert.equal(contradictory.fact.reason, "unknown");
    assert.equal(contradictory.fact.exit_code, 143);
    assert.equal(contradictory.fact.signal, "SIGTERM");
    assert.equal(contradictoryController.snapshot().terminal_facts[0].reason, "unknown");
  }
  ok(true, "contradictory code and signal facts stay unknown across the controller-to-state boundary");

  const unknownController = new ResourceController({
    executeProcess: async () => ({ code: 17, signal: null }),
    queryScope: async () => { throw new Error("private host path /secret"); },
  });
  const unknown = await unknownController.runWorkerScope(workerSpec());
  ok(unknown.fact.reason === "unknown" && unknown.fact.exit_code === 17,
    "unclassified non-zero exit is unknown and query failures stay internal");

  let errorExitZero;
  const originalZeroError = new Error("executor rejected despite zero exit metadata");
  originalZeroError.exitCode = 0;
  const rejectedZeroController = new ResourceController({
    executeProcess: async () => {
      throw originalZeroError;
    },
    queryScope: noOom,
  });
  try {
    await rejectedZeroController.runControlChild(controlSpec("90"));
  } catch (error) {
    errorExitZero = error;
  }
  const zeroErrorMetadata = getResourceRejectionMetadata(errorExitZero);
  ok(errorExitZero === originalZeroError && zeroErrorMetadata?.resourceFact.reason === "unknown" &&
     zeroErrorMetadata.resourceFact.exit_code === 0,
    "an Error rejection preserves the original Error and remains unknown at exitCode=0");

  const rejectedSecret = "REJECTED-VALUE-MUST-NOT-LEAK";
  const nonErrorRejections = [null, undefined, false, 0, rejectedSecret];
  for (const [index, rejectedValue] of nonErrorRejections.entries()) {
    let calls = 0;
    const nonErrorController = new ResourceController({
      maxControlChildren: 1,
      executeProcess: async () => {
        calls += 1;
        if (calls === 1) return Promise.reject(rejectedValue);
        return { code: 0, signal: null };
      },
      queryScope: noOom,
    });
    const spec = controlSpec(`nonerror-${index}`);
    let rejection;
    try {
      await nonErrorController.runControlChild(spec);
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection instanceof Error);
    assert.equal(rejection.name, "ResourceExecutionError");
    assert.equal(rejection.code, "QW_RESOURCE_EXECUTION_REJECTED");
    assert.equal(rejection.message, "resource process execution rejected with a non-Error value");
    assert.equal(getResourceRejectionMetadata(rejection)?.resourceFact.reason, "unknown");
    assert.equal(nonErrorController.snapshot().active_scopes.length, 0);
    assert.equal(nonErrorController.snapshot().control_children.active, 0);
    assert.ok(!JSON.stringify(nonErrorController.snapshot()).includes(rejectedSecret));
    assert.ok(!rejection.message.includes(rejectedSecret));

    const reused = await nonErrorController.runControlChild(spec);
    assert.equal(reused.fact.reason, "normal_exit", "the same unit is reusable after non-Error rejection");
    assert.equal(nonErrorController.snapshot().control_children.active, 0);
  }
  ok(true, "null, undefined, false, zero, and secret-bearing non-Error rejections stay rejected without leaks");

  let durableQueryCalls = 0;
  const durableController = new ResourceController({
    executeProcess: async () => ({
      code: null,
      signal: "SIGKILL",
      scopeObservation: observation(1, {
        capturedBeforeCollect: true,
        observedAt: "2026-08-30T23:59:59Z",
      }),
    }),
    queryScope: async () => {
      durableQueryCalls += 1;
      return observation(0);
    },
  });
  const durable = await durableController.runWorkerScope(workerSpec());
  ok(durable.fact.reason === "oom_kill" && durable.fact.signal === "SIGKILL" &&
     durableQueryCalls === 0,
    "durable pre-collect observation wins and skips the post-exit query fallback");
  assert.equal(durable.cgroup_oom_observation.oom_kill_count, "1");
  assert.equal(durable.cgroup_oom_observation.observed_at, "2026-08-30T23:59:59.000Z");

  let unmarkedFallbackCalls = 0;
  const unmarkedDurableController = new ResourceController({
    executeProcess: async () => ({
      code: null,
      signal: "SIGKILL",
      scopeObservation: observation(9),
    }),
    queryScope: async () => {
      unmarkedFallbackCalls += 1;
      return observation(0);
    },
  });
  const unmarkedDurable = await unmarkedDurableController.runWorkerScope(workerSpec());
  ok(unmarkedFallbackCalls === 1 && unmarkedDurable.fact.reason === "signal",
    "an unmarked executor observation cannot skip the bounded fallback or claim OOM");

  let invalidDurableFallbackCalls = 0;
  const invalidDurableController = new ResourceController({
    executeProcess: async () => ({
      code: 17,
      signal: null,
      scopeObservation: observation(-1, { capturedBeforeCollect: true }),
    }),
    queryScope: async () => {
      invalidDurableFallbackCalls += 1;
      return observation(2n);
    },
  });
  const invalidDurable = await invalidDurableController.runWorkerScope(workerSpec());
  ok(invalidDurableFallbackCalls === 1 && invalidDurable.fact.reason === "oom_kill",
    "an invalid durable counter falls back to a valid bounded-query counter");

  let invalidTimeFallbackCalls = 0;
  const invalidTimeController = new ResourceController({
    executeProcess: async () => ({
      code: null,
      signal: "SIGKILL",
      scopeObservation: observation(7, {
        capturedBeforeCollect: true,
        observedAt: "not-a-time",
      }),
    }),
    queryScope: async () => {
      invalidTimeFallbackCalls += 1;
      return observation(3, { observedAt: "2026-08-31T03:04:05Z" });
    },
  });
  const invalidTimeFallback = await invalidTimeController.runWorkerScope(workerSpec());
  assert.equal(invalidTimeFallbackCalls, 1);
  assert.equal(invalidTimeFallback.fact.reason, "oom_kill");
  assert.equal(invalidTimeFallback.cgroup_oom_observation.oom_kill_count, "3");
  assert.equal(invalidTimeFallback.cgroup_oom_observation.observed_at, "2026-08-31T03:04:05.000Z");
  ok(true, "a durable observation with invalid time has no authority and uses the validated fallback");

  const hugeCounter = (1n << 64n) - 1n;
  const hugeController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
    queryScope: async () => observation(hugeCounter),
  });
  const huge = await hugeController.runWorkerScope(workerSpec());
  assert.equal(huge.fact.reason, "oom_kill");
  assert.equal(huge.cgroup_oom_observation.oom_kill_count, "18446744073709551615");
  assert.doesNotThrow(() => JSON.stringify(hugeController.snapshot()));
  ok(true, "the full uint64 OOM counter survives output and snapshot JSON without precision loss");

  let hostileTimeFallbackCalls = 0;
  const hostileTime = observation(4, { capturedBeforeCollect: true });
  Object.defineProperty(hostileTime, "observedAt", {
    get() { throw new Error("HOSTILE-TIME-MUST-NOT-LEAK"); },
  });
  const hostileTimeController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGKILL", scopeObservation: hostileTime }),
    queryScope: async () => {
      hostileTimeFallbackCalls += 1;
      return observation(0);
    },
  });
  const hostileTimeResult = await hostileTimeController.runWorkerScope(workerSpec());
  assert.equal(hostileTimeFallbackCalls, 1);
  assert.equal(hostileTimeResult.fact.reason, "signal");
  assert.equal(hostileTimeResult.cgroup_oom_observation.oom_kill_count, "0");
  assert.ok(!JSON.stringify(hostileTimeController.snapshot()).includes("HOSTILE-TIME-MUST-NOT-LEAK"));
  ok(true, "hostile observation getters fail closed, fall back, and do not leak their errors");

  const invalidFallbackCases = [
    { counter: -1, result: { code: null, signal: "SIGKILL" }, reason: "signal" },
    { counter: 1.5, result: { code: 0, signal: null }, reason: "normal_exit" },
    { counter: Number.MAX_SAFE_INTEGER + 1, result: { code: 17, signal: null }, reason: "unknown" },
    { counter: "01", result: { code: 17, signal: null }, reason: "unknown" },
    { counter: 1n << 64n, result: { code: 17, signal: null }, reason: "unknown" },
  ];
  for (const [index, testCase] of invalidFallbackCases.entries()) {
    const invalidFallbackController = new ResourceController({
      executeProcess: async () => testCase.result,
      queryScope: async () => observation(testCase.counter, { oomKilled: true }),
    });
    const classified = await invalidFallbackController.runWorkerScope(workerSpec({
      generationId: `invalid-counter-${index}`,
      unitName: `qw-worker-invalid-counter-${index}`,
    }));
    assert.equal(classified.fact.reason, testCase.reason);
  }
  ok(true, "invalid fallback counters and unverified observation flags never claim OOM");

  const invalidFallbackTimeController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
    queryScope: async () => ({
      oomKillCount: 5,
      observedAt: "invalid",
      detail: "PRIVATE-OBSERVATION-DETAIL",
    }),
  });
  const invalidFallbackTime = await invalidFallbackTimeController.runWorkerScope(workerSpec());
  assert.equal(invalidFallbackTime.fact.reason, "signal");
  assert.equal(invalidFallbackTime.cgroup_oom_observation, null);
  assert.equal(invalidFallbackTimeController.snapshot().last_cgroup_oom, null);
  assert.ok(!JSON.stringify(invalidFallbackTimeController.snapshot()).includes("PRIVATE-OBSERVATION-DETAIL"));
  ok(true, "an invalid fallback timestamp cannot authorize or emit OOM provenance");

  const retainedObservationController = new ResourceController({
    executeProcess: async ({ generationId }) => generationId === "global-g1"
      ? { code: null, signal: "SIGKILL" }
      : { code: 0, signal: null },
    queryScope: async ({ generationId }) => generationId === "global-g1"
      ? observation(4)
      : { oomKillCount: 9, observedAt: "invalid" },
  });
  const globalG1 = await retainedObservationController.runWorkerScope(workerSpec({
    generationId: "global-g1",
    unitName: "qw-worker-global-g1",
  }));
  const globalG2 = await retainedObservationController.runWorkerScope(workerSpec({
    generationId: "global-g2",
    unitName: "qw-worker-global-g2",
  }));
  assert.equal(globalG1.cgroup_oom_observation.generation_id, "global-g1");
  assert.equal(globalG2.cgroup_oom_observation, null);
  assert.equal(Object.hasOwn(globalG2, "last_cgroup_oom"), false);
  assert.equal(retainedObservationController.snapshot().last_cgroup_oom.generation_id, "global-g1");
  assert.equal(retainedObservationController.snapshot().last_cgroup_oom.oom_kill_count, "4");
  ok(true, "current observation output is distinct from the retained latest global provenance");

  const oomThenZeroController = new ResourceController({
    executeProcess: async ({ generationId }) => generationId === "oom-zero-g1"
      ? { code: null, signal: "SIGKILL" }
      : { code: 0, signal: null },
    queryScope: async ({ generationId }) => generationId === "oom-zero-g1"
      ? observation(2, { observedAt: "2026-08-31T09:10:00+09:00" })
      : observation(0, { observedAt: "2026-08-31T00:11:00Z" }),
  });
  await oomThenZeroController.runWorkerScope(workerSpec({
    generationId: "oom-zero-g1",
    unitName: "qw-worker-oom-zero-g1",
  }));
  await oomThenZeroController.runWorkerScope(workerSpec({
    generationId: "oom-zero-g2",
    unitName: "qw-worker-oom-zero-g2",
  }));
  const oomThenZero = oomThenZeroController.snapshot();
  assert.equal(oomThenZero.last_cgroup_oom.generation_id, "oom-zero-g2");
  assert.equal(oomThenZero.last_cgroup_oom.oom_kill_count, "0");
  assert.equal(oomThenZero.last_cgroup_oom.observed_at, "2026-08-31T00:11:00.000Z");
  assert.equal(oomThenZero.terminal_facts[0].reason, "oom_kill");
  assert.equal(oomThenZero.terminal_facts[0].oom_kill_count, "2");
  assert.equal(oomThenZero.terminal_facts[0].oom_observed_at, "2026-08-31T00:10:00.000Z");
  assert.equal(oomThenZero.terminal_facts[1].reason, "normal_exit");
  assert.equal(Object.hasOwn(oomThenZero.terminal_facts[1], "oom_kill_count"), false);
  assert.equal(Object.hasOwn(oomThenZero.terminal_facts[1], "oom_observed_at"), false);
  const oomThenZeroJson = JSON.parse(JSON.stringify(oomThenZero));
  assert.equal(oomThenZeroJson.terminal_facts[0].oom_kill_count, "2");
  assert.equal(oomThenZeroJson.terminal_facts[0].oom_observed_at, "2026-08-31T00:10:00.000Z");
  ok(true, "an OOM fact retains its own canonical authority after a later zero observation becomes global latest");

  const oomThenOomController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
    queryScope: async ({ generationId }) => generationId === "oom-oom-g1"
      ? observation(3, { observedAt: "2026-08-31T00:20:00Z" })
      : observation(7, { observedAt: "2026-08-31T00:21:00Z" }),
  });
  await oomThenOomController.runWorkerScope(workerSpec({
    generationId: "oom-oom-g1",
    unitName: "qw-worker-oom-oom-g1",
  }));
  await oomThenOomController.runWorkerScope(workerSpec({
    generationId: "oom-oom-g2",
    unitName: "qw-worker-oom-oom-g2",
  }));
  const oomThenOom = oomThenOomController.snapshot();
  assert.deepEqual(oomThenOom.terminal_facts.map((fact) => ({
    generation_id: fact.generation_id,
    oom_kill_count: fact.oom_kill_count,
    oom_observed_at: fact.oom_observed_at,
  })), [
    { generation_id: "oom-oom-g1", oom_kill_count: "3", oom_observed_at: "2026-08-31T00:20:00.000Z" },
    { generation_id: "oom-oom-g2", oom_kill_count: "7", oom_observed_at: "2026-08-31T00:21:00.000Z" },
  ]);
  assert.equal(oomThenOom.last_cgroup_oom.generation_id, "oom-oom-g2");
  assert.equal(oomThenOom.last_cgroup_oom.oom_kill_count, "7");
  ok(true, "successive generation OOM facts carry independent canonical provenance pairs");

  const retainedFactController = new ResourceController({
    terminalFactLimit: 1,
    executeProcess: async ({ generationId }) => generationId === "retention-g1"
      ? { code: null, signal: "SIGKILL" }
      : { code: 0, signal: null },
    queryScope: async ({ generationId }) => generationId === "retention-g1"
      ? observation(1, { observedAt: "2026-08-31T00:30:00Z" })
      : observation(0, { observedAt: "2026-08-31T00:31:00Z" }),
  });
  await retainedFactController.runWorkerScope(workerSpec({
    generationId: "retention-g1",
    unitName: "qw-worker-retention-g1",
  }));
  await retainedFactController.runWorkerScope(workerSpec({
    generationId: "retention-g2",
    unitName: "qw-worker-retention-g2",
  }));
  const retainedFact = retainedFactController.snapshot();
  assert.equal(retainedFact.terminal_facts.length, 1);
  assert.equal(retainedFact.terminal_facts[0].generation_id, "retention-g2");
  assert.equal(Object.hasOwn(retainedFact.terminal_facts[0], "oom_kill_count"), false);
  assert.equal(retainedFact.last_cgroup_oom.generation_id, "retention-g2");
  assert.equal(retainedFact.last_cgroup_oom.oom_kill_count, "0");
  ok(true, "terminal retention truncates whole per-fact OOM authority while global latest still advances to zero");

  const rawResultFlagController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGKILL", oomKilled: true }),
    queryScope: async () => observation(-1),
  });
  const rawResultFlag = await rawResultFlagController.runWorkerScope(workerSpec());
  ok(rawResultFlag.fact.reason === "signal",
    "a raw executor-result OOM flag cannot replace validated cgroup observation provenance");

  let rawErrorFlag;
  const rawErrorFlagController = new ResourceController({
    executeProcess: async () => {
      const error = new Error("raw error OOM assertion");
      error.exitCode = 0;
      error.oomKilled = true;
      throw error;
    },
    queryScope: async () => observation("invalid"),
  });
  try {
    await rawErrorFlagController.runControlChild(controlSpec("88"));
  } catch (error) {
    rawErrorFlag = error;
  }
  ok(getResourceRejectionMetadata(rawErrorFlag)?.resourceFact.reason === "unknown" &&
     rawErrorFlagController.snapshot().control_children.active === 0,
    "a raw executor-error OOM flag remains unknown and releases its permit");

  const terminalGetterSecret = "TERMINAL-GETTER-MUST-NOT-LEAK";
  const hostileSuccessResult = { scopeObservation: null };
  Object.defineProperties(hostileSuccessResult, {
    code: { get() { throw new Error(terminalGetterSecret); } },
    signal: { get() { throw new Error(terminalGetterSecret); } },
  });
  const hostileSuccessController = new ResourceController({
    executeProcess: async () => hostileSuccessResult,
    queryScope: noOom,
  });
  const hostileSuccess = await hostileSuccessController.runWorkerScope(workerSpec());
  assert.equal(hostileSuccess.result, hostileSuccessResult);
  assert.equal(hostileSuccess.fact.reason, "unknown");
  assert.equal(hostileSuccess.fact.exit_code, null);
  assert.equal(hostileSuccess.fact.signal, null);
  assert.ok(!JSON.stringify(hostileSuccessController.snapshot()).includes(terminalGetterSecret));

  const hostileTerminalError = new Error("original executor failure");
  Object.defineProperties(hostileTerminalError, {
    exitCode: { get() { throw new Error(terminalGetterSecret); } },
    signal: { get() { throw new Error(terminalGetterSecret); } },
    scopeObservation: { value: observation(1, { capturedBeforeCollect: true }) },
  });
  const hostileTerminalErrorController = new ResourceController({
    executeProcess: async () => { throw hostileTerminalError; },
    queryScope: async () => { throw new Error("durable observation should skip fallback"); },
  });
  let preservedHostileError;
  try {
    await hostileTerminalErrorController.runWorkerScope(workerSpec());
  } catch (error) {
    preservedHostileError = error;
  }
  assert.equal(preservedHostileError, hostileTerminalError);
  const hostileTerminalMetadata = getResourceRejectionMetadata(preservedHostileError);
  assert.equal(hostileTerminalMetadata.resourceFact.reason, "unknown");
  assert.equal(hostileTerminalMetadata.resourceFact.exit_code, null);
  assert.equal(hostileTerminalMetadata.resourceFact.signal, null);
  assert.equal(hostileTerminalMetadata.cgroup_oom_observation.oom_kill_count, "1");
  assert.ok(!JSON.stringify(hostileTerminalErrorController.snapshot()).includes(terminalGetterSecret));
  ok(true, "hostile success/Error terminal getters normalize to null without replacing or leaking the original Error");

  const rejectedOomError = new Error("PRIVATE-EXECUTOR-FAILURE");
  rejectedOomError.exitCode = null;
  rejectedOomError.signal = "SIGKILL";
  rejectedOomError.scopeObservation = observation("18446744073709551615", {
    capturedBeforeCollect: true,
  });
  const rejectedOomController = new ResourceController({
    executeProcess: async () => { throw rejectedOomError; },
    queryScope: async () => { throw new Error("fallback must not run"); },
  });
  let rejectedOom;
  try {
    await rejectedOomController.runWorkerScope(workerSpec());
  } catch (error) {
    rejectedOom = error;
  }
  assert.equal(rejectedOom, rejectedOomError);
  const rejectedOomMetadata = getResourceRejectionMetadata(rejectedOom);
  assert.equal(rejectedOomMetadata.resourceFact.reason, "oom_kill");
  assert.equal(rejectedOomMetadata.cgroup_oom_observation.oom_kill_count, "18446744073709551615");
  assert.deepEqual(rejectedOomController.snapshot().last_cgroup_oom,
    rejectedOomMetadata.cgroup_oom_observation);
  assert.ok(!JSON.stringify(rejectedOomController.snapshot()).includes("PRIVATE-EXECUTOR-FAILURE"));
  ok(true, "a rejected execution carries validated durable provenance without leaking its error text");

  let metadataSetterCalls = 0;
  let metadataProxySetCalls = 0;
  let metadataProxyDefineCalls = 0;
  const frozenError = new Error("frozen executor failure");
  frozenError.exitCode = 9;
  frozenError.signal = null;
  Object.freeze(frozenError);
  const nonExtensibleError = new Error("non-extensible executor failure");
  nonExtensibleError.exitCode = null;
  nonExtensibleError.signal = "SIGTERM";
  Object.preventExtensions(nonExtensibleError);
  const setterError = new Error("setter executor failure");
  setterError.exitCode = 8;
  setterError.signal = null;
  Object.defineProperties(setterError, {
    resourceFact: { set() { metadataSetterCalls += 1; throw new Error("setter must not run"); } },
    cgroup_oom_observation: { set() { metadataSetterCalls += 1; throw new Error("setter must not run"); } },
  });
  const proxyTargetError = new Error("proxy executor failure");
  proxyTargetError.exitCode = null;
  proxyTargetError.signal = "SIGTERM";
  const proxyError = new Proxy(proxyTargetError, {
    set() {
      metadataProxySetCalls += 1;
      throw new Error("proxy set trap must not run");
    },
    defineProperty() {
      metadataProxyDefineCalls += 1;
      throw new Error("proxy define trap must not run");
    },
  });
  const hardenedErrors = [frozenError, nonExtensibleError, setterError, proxyError];
  let hardenedErrorIndex = 0;
  const hardenedErrorController = new ResourceController({
    maxControlChildren: 1,
    executeProcess: async () => { throw hardenedErrors[hardenedErrorIndex++]; },
    queryScope: noOom,
  });
  for (const [index, expectedError] of hardenedErrors.entries()) {
    let actualError;
    try {
      await hardenedErrorController.runControlChild(controlSpec(`metadata-${index}`));
    } catch (error) {
      actualError = error;
    }
    assert.equal(actualError, expectedError);
    const metadata = getResourceRejectionMetadata(actualError);
    assert.ok(metadata && Object.isFrozen(metadata) && Object.isFrozen(metadata.resourceFact));
    assert.equal(metadata.resourceFact.reason,
      expectedError.signal === "SIGTERM" ? "signal" : "unknown");
    assert.equal(hardenedErrorController.snapshot().active_scopes.length, 0);
    assert.equal(hardenedErrorController.snapshot().control_children.active, 0);
  }
  assert.equal(metadataSetterCalls, 0);
  assert.equal(metadataProxySetCalls, 0);
  assert.equal(metadataProxyDefineCalls, 0);
  assert.equal(getResourceRejectionMetadata({}), null);
  ok(true, "frozen, non-extensible, setter-backed, and proxied Errors retain identity and release state without mutation");

  const throwingCounterController = new ResourceController({
    executeProcess: async () => ({ code: 0, signal: null }),
    queryScope: async () => Object.defineProperties({}, {
      oomKillCount: { get() { throw new Error("untrusted counter getter"); } },
      observedAt: { value: OBSERVED_AT },
    }),
  });
  const throwingCounter = await throwingCounterController.runWorkerScope(workerSpec());
  ok(throwingCounter.fact.reason === "normal_exit" &&
     throwingCounterController.snapshot().active_scopes.length === 0,
    "an unreadable fallback counter is invalid and cannot strand active state");

  const hostileResultObservation = { code: 0, signal: null };
  Object.defineProperty(hostileResultObservation, "scopeObservation", {
    get() { throw new Error("hostile result observation getter"); },
  });
  const hostileResultController = new ResourceController({
    executeProcess: async () => hostileResultObservation,
    queryScope: noOom,
  });
  const hostileResult = await hostileResultController.runControlChild(controlSpec("87"));
  ok(hostileResult.fact.reason === "normal_exit" &&
     hostileResultController.snapshot().active_scopes.length === 0 &&
     hostileResultController.snapshot().control_children.active === 0,
    "a hostile result observation getter falls back without retaining state or permit");

  let hostileErrorResult;
  const hostileErrorController = new ResourceController({
    executeProcess: async () => {
      const error = new Error("hostile error observation getter");
      error.exitCode = 9;
      Object.defineProperty(error, "scopeObservation", {
        get() { throw new Error("must stay inside observation boundary"); },
      });
      throw error;
    },
    queryScope: noOom,
  });
  try {
    await hostileErrorController.runControlChild(controlSpec("86"));
  } catch (error) {
    hostileErrorResult = error;
  }
  ok(getResourceRejectionMetadata(hostileErrorResult)?.resourceFact.reason === "unknown" &&
     hostileErrorController.snapshot().active_scopes.length === 0 &&
     hostileErrorController.snapshot().control_children.active === 0,
    "a hostile error observation getter preserves the original failure and releases state and permit");

  const timestampSecret = "TIMESTAMP-TOSTRING-MUST-NOT-RUN";
  for (const [index, invalidCalendarTime] of [
    "2026-02-29T00:00:00Z",
    "2024-02-30T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-01-32T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+01:60",
    "2026-01-01T00:00:00+24:00",
  ].entries()) {
    let executeCalls = 0;
    const invalidCalendarController = new ResourceController({
      executeProcess: async () => { executeCalls += 1; return { code: 0, signal: null }; },
      queryScope: noOom,
      now: () => invalidCalendarTime,
    });
    await assert.rejects(
      invalidCalendarController.runWorkerScope(workerSpec({
        generationId: `invalid-calendar-${index}`,
        unitName: `qw-worker-invalid-calendar-${index}`,
      })),
      (error) => error?.code === "QW_INVALID_RESOURCE_TIMESTAMP" && error?.field === "started_at",
    );
    assert.equal(executeCalls, 0);
    assert.equal(invalidCalendarController.snapshot().active_scopes.length, 0);
  }
  const leapCalendarController = new ResourceController({
    executeProcess: async () => ({ code: 0, signal: null }),
    queryScope: noOom,
    now: () => "2024-02-29T23:59:59.123Z",
  });
  const leapCalendar = await leapCalendarController.runWorkerScope(workerSpec());
  assert.equal(leapCalendar.fact.finished_at, "2024-02-29T23:59:59.123Z");
  let impossibleFinishClockCalls = 0;
  const impossibleFinishController = new ResourceController({
    executeProcess: async () => ({ code: 0, signal: null }),
    queryScope: noOom,
    now: () => ++impossibleFinishClockCalls === 1
      ? "2024-02-29T23:59:59Z"
      : "2024-02-30T00:00:00Z",
  });
  await assert.rejects(
    impossibleFinishController.runControlChild(controlSpec("impossible-finish")),
    (error) => error?.code === "QW_INVALID_RESOURCE_TIMESTAMP" && error?.field === "finished_at",
  );
  assert.equal(impossibleFinishController.snapshot().active_scopes.length, 0);
  assert.equal(impossibleFinishController.snapshot().control_children.active, 0);
  assert.equal(impossibleFinishController.snapshot().terminal_facts.length, 0);
  const invalidObservationCalendarController = new ResourceController({
    executeProcess: async () => ({
      code: null,
      signal: "SIGKILL",
      scopeObservation: observation(7, {
        capturedBeforeCollect: true,
        observedAt: "2024-02-30T00:00:00Z",
      }),
    }),
    queryScope: noOom,
  });
  const invalidObservationCalendar = await invalidObservationCalendarController.runWorkerScope(workerSpec());
  assert.equal(invalidObservationCalendar.fact.reason, "signal");
  assert.equal(invalidObservationCalendar.cgroup_oom_observation.oom_kill_count, "0");
  ok(true, "impossible ISO calendar dates fail closed while valid leap-day timestamps remain canonical");

  const nonIsoStartController = new ResourceController({
    executeProcess: async () => ({ code: 0, signal: null }),
    queryScope: noOom,
    now: () => "August 31, 2026",
  });
  await assert.rejects(nonIsoStartController.runWorkerScope(workerSpec()), (error) =>
    error?.code === "QW_INVALID_RESOURCE_TIMESTAMP" && error?.field === "started_at");

  let invalidStartExecuteCalls = 0;
  const invalidStartController = new ResourceController({
    executeProcess: async () => {
      invalidStartExecuteCalls += 1;
      return { code: 0, signal: null };
    },
    queryScope: noOom,
    now: () => ({ toString() { throw new Error(timestampSecret); } }),
  });
  let invalidStartError;
  try {
    await invalidStartController.runWorkerScope(workerSpec());
  } catch (error) {
    invalidStartError = error;
  }
  assert.equal(invalidStartError?.code, "QW_INVALID_RESOURCE_TIMESTAMP");
  assert.equal(invalidStartError?.field, "started_at");
  assert.ok(!invalidStartError.message.includes(timestampSecret));
  assert.equal(invalidStartExecuteCalls, 0);
  assert.equal(invalidStartController.snapshot().active_scopes.length, 0);

  let invalidFinishClockCalls = 0;
  const invalidFinishController = new ResourceController({
    executeProcess: async () => ({ code: 0, signal: null }),
    queryScope: noOom,
    now: () => {
      invalidFinishClockCalls += 1;
      return invalidFinishClockCalls === 1 ? OBSERVED_AT : { private: timestampSecret };
    },
  });
  let invalidFinishError;
  try {
    await invalidFinishController.runControlChild(controlSpec("bad-time"));
  } catch (error) {
    invalidFinishError = error;
  }
  assert.equal(invalidFinishError?.code, "QW_INVALID_RESOURCE_TIMESTAMP");
  assert.equal(invalidFinishError?.field, "finished_at");
  assert.equal(invalidFinishController.snapshot().active_scopes.length, 0);
  assert.equal(invalidFinishController.snapshot().control_children.active, 0);
  assert.equal(invalidFinishController.snapshot().terminal_facts.length, 0);
  assert.ok(!JSON.stringify(invalidFinishController.snapshot()).includes(timestampSecret));
  ok(true, "invalid timestamp values fail closed with typed redacted errors and release active state");

  let factClockCalls = 0;
  const terminalThrowController = new ResourceController({
    executeProcess: async () => ({ code: 0, signal: null }),
    queryScope: noOom,
    now: () => {
      factClockCalls += 1;
      if (factClockCalls === 2) throw new Error("terminal fact clock failed");
      return "2026-08-31T00:00:00.000Z";
    },
  });
  await assert.rejects(
    terminalThrowController.runControlChild(controlSpec("85")),
    /terminal fact clock failed/,
  );
  assert.equal(terminalThrowController.snapshot().active_scopes.length, 0);
  assert.equal(terminalThrowController.snapshot().control_children.active, 0);
  const afterTerminalThrow = await terminalThrowController.runControlChild(controlSpec("84"));
  ok(afterTerminalThrow.fact.reason === "normal_exit" &&
     terminalThrowController.snapshot().control_children.active === 0,
    "terminal-fact failure releases outer active state and the leaf permit for the next child");

  let queryAbortObserved = false;
  const hungQueryController = new ResourceController({
    maxControlChildren: 1,
    scopeQueryTimeoutMs: 10,
    executeProcess: async () => ({ code: 0, signal: null }),
    queryScope: async ({ signal }) => new Promise(() => {
      signal.addEventListener("abort", () => { queryAbortObserved = true; }, { once: true });
    }),
  });
  const afterHungQuery = await hungQueryController.runControlChild(controlSpec("89"));
  ok(afterHungQuery.fact.reason === "normal_exit" && queryAbortObserved &&
     hungQueryController.snapshot().control_children.active === 0 &&
     hungQueryController.snapshot().active_scopes.length === 0,
    "a never-resolving scope query is cancelled and cannot retain active state or a permit");

  const secret = "TOKEN-DO-NOT-LEAK";
  let unblock;
  const redactedController = new ResourceController({
    executeProcess: async () => new Promise((resolve) => { unblock = () => resolve({ code: 0, signal: null }); }),
    queryScope: noOom,
  });
  const running = redactedController.runControlChild(controlSpec("91", {
    args: [secret, "/private/operator/path"],
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const liveSnapshot = redactedController.snapshot();
  const liveJson = JSON.stringify(liveSnapshot);
  ok(liveSnapshot.active_scopes[0].project_id === "quadwork" &&
     liveSnapshot.active_scopes[0].generation_id === "refresh-91",
    "active snapshots are project and generation qualified");
  ok(!liveJson.includes(secret) && !liveJson.includes("/private/operator/path") &&
     !liveJson.includes("command") && !liveJson.includes("args"),
    "snapshots expose class and identity without command, arguments, environment, or paths");
  unblock();
  await running;

  let failFirst = true;
  const recoveryController = new ResourceController({
    maxControlChildren: 1,
    executeProcess: async () => {
      if (failFirst) {
        failFirst = false;
        const error = new Error(`execution failed with ${secret}`);
        error.exitCode = 9;
        throw error;
      }
      return { code: 0, signal: null };
    },
    queryScope: noOom,
  });
  await assert.rejects(recoveryController.runControlChild(controlSpec("92")), /execution failed/);
  const afterError = await recoveryController.runControlChild(controlSpec("93"));
  ok(afterError.fact.reason === "normal_exit" && recoveryController.snapshot().control_children.active === 0,
    "execution errors record an unknown fact and release the permit for the next leaf");
  ok(!JSON.stringify(recoveryController.snapshot()).includes(secret),
    "execution error text is not retained in redacted terminal snapshots");

  let releaseHeld;
  const cancelController = new ResourceController({
    maxControlChildren: 1,
    executeProcess: async () => new Promise((resolve) => { releaseHeld = () => resolve({ code: 0, signal: null }); }),
    queryScope: noOom,
  });
  const held = cancelController.runControlChild(controlSpec("94"));
  await new Promise((resolve) => setImmediate(resolve));
  const abort = new AbortController();
  const cancelled = cancelController.runControlChild(controlSpec("95", { signal: abort.signal }));
  abort.abort();
  await assert.rejects(cancelled, { name: "AbortError", code: "ABORT_ERR" });
  ok(cancelController.snapshot().control_children.queued === 0,
    "a cancelled queued child is removed without consuming or leaking a permit");
  releaseHeld();
  await held;
  ok(cancelController.snapshot().control_children.active === 0,
    "the active permit is released after a neighbouring queued cancellation");

  let activeCancelCalls = 0;
  const activeCancelController = new ResourceController({
    maxControlChildren: 1,
    executeProcess: ({ signal }) => {
      activeCancelCalls += 1;
      if (activeCancelCalls > 1) return Promise.resolve({ code: 0, signal: null });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          error.exitCode = null;
          error.signal = "SIGTERM";
          reject(error);
        }, { once: true });
      });
    },
    queryScope: noOom,
  });
  const activeAbort = new AbortController();
  const activeCancelled = activeCancelController.runControlChild(controlSpec("96", { signal: activeAbort.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  activeAbort.abort();
  await assert.rejects(activeCancelled, { name: "AbortError" });
  const afterCancel = await activeCancelController.runControlChild(controlSpec("97"));
  ok(afterCancel.fact.reason === "normal_exit" &&
     activeCancelController.snapshot().control_children.active === 0,
    "an actively cancelled child records its signal and releases the permit for the next leaf");
  ok(activeCancelController.snapshot().terminal_facts[0].reason === "signal" &&
     activeCancelController.snapshot().terminal_facts[0].signal === "SIGTERM",
    "active cancellation preserves its terminal signal without deciding a retry");

  assert.deepEqual(
    new Set(recoveryController.snapshot().terminal_facts.map((fact) => fact.reason)),
    new Set(["unknown", "normal_exit"]),
  );
  ok(true, "success and error terminal facts remain separately observable with no retry decision");

  console.log(`\n${passed} passed`);
  console.log("server/resource-controller.test.js: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
