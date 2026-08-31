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
} = require("./resource-controller");

let passed = 0;
const noOom = async () => ({ oomKillCount: 0 });
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
      return { oomKillCount: 0 };
    },
    now: () => times.shift(),
  });
  const normal = await normalController.runWorkerScope(workerSpec());
  ok(normal.fact.reason === "normal_exit" && normal.fact.exit_code === 0 && queryCalls === 1,
    "normal worker exit is project/generation qualified and scope-query backed");

  const signalController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGTERM" }),
    queryScope: async () => ({ oomKillCount: 0 }),
  });
  const signalled = await signalController.runWorkerScope(workerSpec());
  ok(signalled.fact.reason === "signal" && signalled.fact.signal === "SIGTERM",
    "signal terminal facts preserve the exact signal");

  const numericSignalController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: 15 }),
    queryScope: async () => ({ oomKillCount: 0n }),
  });
  const numericSignal = await numericSignalController.runWorkerScope(workerSpec());
  ok(numericSignal.fact.reason === "signal" && numericSignal.fact.signal === 15,
    "numeric node-pty signals are preserved instead of being normalized away");

  const oomController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGKILL" }),
    queryScope: async () => ({ oomKillCount: 1 }),
  });
  const oom = await oomController.runWorkerScope(workerSpec());
  ok(oom.fact.reason === "oom_kill" && oom.fact.signal === "SIGKILL",
    "confirmed cgroup OOM wins classification without dropping its signal");

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
  ok(errorExitZero === originalZeroError && errorExitZero.resourceFact?.reason === "unknown" &&
     errorExitZero.resourceFact.exit_code === 0,
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
    assert.equal(rejection.resourceFact?.reason, "unknown");
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
      scopeObservation: { oomKillCount: 1, capturedBeforeCollect: true },
    }),
    queryScope: async () => {
      durableQueryCalls += 1;
      return { oomKillCount: 0 };
    },
  });
  const durable = await durableController.runWorkerScope(workerSpec());
  ok(durable.fact.reason === "oom_kill" && durable.fact.signal === "SIGKILL" &&
     durableQueryCalls === 0,
    "durable pre-collect observation wins and skips the post-exit query fallback");

  let unmarkedFallbackCalls = 0;
  const unmarkedDurableController = new ResourceController({
    executeProcess: async () => ({
      code: null,
      signal: "SIGKILL",
      scopeObservation: { oomKillCount: 9 },
    }),
    queryScope: async () => {
      unmarkedFallbackCalls += 1;
      return { oomKillCount: 0 };
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
      scopeObservation: { capturedBeforeCollect: true, oomKillCount: -1 },
    }),
    queryScope: async () => {
      invalidDurableFallbackCalls += 1;
      return { oomKillCount: 2n };
    },
  });
  const invalidDurable = await invalidDurableController.runWorkerScope(workerSpec());
  ok(invalidDurableFallbackCalls === 1 && invalidDurable.fact.reason === "oom_kill",
    "an invalid durable counter falls back to a valid bounded-query counter");

  const invalidFallbackCases = [
    { counter: -1, result: { code: null, signal: "SIGKILL" }, reason: "signal" },
    { counter: 1.5, result: { code: 0, signal: null }, reason: "normal_exit" },
    { counter: Number.MAX_SAFE_INTEGER + 1, result: { code: 17, signal: null }, reason: "unknown" },
    { counter: "1", result: { code: 17, signal: null }, reason: "unknown" },
  ];
  for (const [index, testCase] of invalidFallbackCases.entries()) {
    const invalidFallbackController = new ResourceController({
      executeProcess: async () => testCase.result,
      queryScope: async () => ({ oomKillCount: testCase.counter, oomKilled: true }),
    });
    const classified = await invalidFallbackController.runWorkerScope(workerSpec({
      generationId: `invalid-counter-${index}`,
      unitName: `qw-worker-invalid-counter-${index}`,
    }));
    assert.equal(classified.fact.reason, testCase.reason);
  }
  ok(true, "invalid fallback counters and unverified observation flags never claim OOM");

  const rawResultFlagController = new ResourceController({
    executeProcess: async () => ({ code: null, signal: "SIGKILL", oomKilled: true }),
    queryScope: async () => ({ oomKillCount: -1 }),
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
    queryScope: async () => ({ oomKillCount: "invalid" }),
  });
  try {
    await rawErrorFlagController.runControlChild(controlSpec("88"));
  } catch (error) {
    rawErrorFlag = error;
  }
  ok(rawErrorFlag?.resourceFact?.reason === "unknown" &&
     rawErrorFlagController.snapshot().control_children.active === 0,
    "a raw executor-error OOM flag remains unknown and releases its permit");

  const throwingCounterController = new ResourceController({
    executeProcess: async () => ({ code: 0, signal: null }),
    queryScope: async () => Object.defineProperty({}, "oomKillCount", {
      get() { throw new Error("untrusted counter getter"); },
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
  ok(hostileErrorResult?.resourceFact?.reason === "unknown" &&
     hostileErrorController.snapshot().active_scopes.length === 0 &&
     hostileErrorController.snapshot().control_children.active === 0,
    "a hostile error observation getter preserves the original failure and releases state and permit");

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
