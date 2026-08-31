// #1038: argument-array systemd scope candidate, leaf-only control semaphore,
// redacted observations, and terminal-fact classification. No real systemd or
// node-pty process is used here; the disposable VPS staging matrix owns that
// evidence before this candidate can become the supported launcher contract.

"use strict";

const assert = require("node:assert/strict");
const {
  SYSTEMD_SCOPE_CANDIDATE,
  ResourceController,
  buildWorkerScopeInvocation,
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
    limits: { memoryMaxMib: 512, swapMaxMib: 256 },
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

  const control = buildControlScopeInvocation(controlSpec(1));
  assert.deepEqual(control.args.slice(0, 10), [
    "--user", "--scope", "--collect", "--quiet", "--unit=qw-control-1",
    "-p", "MemoryMax=512M", "-p", "MemorySwapMax=256M", "--",
  ]);
  ok(!control.args.some((arg) => arg.startsWith("MemoryHigh=")),
    "control class applies only its configured max and swap limits");

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
  const fanoutController = new ResourceController({
    maxControlChildren: 2,
    executeProcess: async () => {
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
    "snapshots expose limits and identity without command, arguments, environment, or paths");
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
