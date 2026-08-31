"use strict";

const assert = require("node:assert/strict");
const {
  ACK_PREFIX,
  PHASES,
  createDefaultAdapter,
  parseCliArgs,
  runStagingProof,
} = require("./resource-staging-proof");

const MACHINE_ID = "0123456789abcdef0123456789abcdef";
const ACK = `${ACK_PREFIX}${MACHINE_ID}`;

function phaseResult(id) {
  switch (id) {
    case "node_pty_controlling_tty":
      return { status: "passed", controlling_tty: true, raw_path: "/secret/tty" };
    case "resize_signal_exit_propagation":
      return { status: "passed", resize_propagated: true, signal_propagated: true, exit_propagated: true };
    case "descendant_cgroup_membership":
      return { status: "passed", all_descendants_in_worker_cgroup: true, descendant_count: 4 };
    case "effective_temp_disk_boundary":
      return { status: "passed", effective_temp_disk_backed: true, effective_temp_within_generation_root: true };
    case "bounded_worker_oom_counter":
      return { status: "passed", worker_scope_bounded: true, worker_oom_counter_before: 10, worker_oom_counter_after: 11 };
    default:
      return { status: "unavailable" };
  }
}

function monitorSummary() {
  return {
    sample_count: 20,
    api_continuously_healthy: true,
    primary_chat_websocket_continuously_healthy: true,
    unrelated_worker_continuously_healthy: true,
    api_oom_counter_before: 5,
    api_oom_counter_after: 5,
    global_oom_counter_before: 7,
    global_oom_counter_after: 7,
    environment: "SECRET-MUST-NOT-PERSIST",
  };
}

function injectedAdapter(options = {}) {
  const events = options.events || [];
  const gates = options.gates || { linux: true, cgroupV2: true, userManager: true, machineId: MACHINE_ID };
  return {
    events,
    async inspectGates() {
      events.push("inspect");
      return gates;
    },
    async startContinuousMonitoring(contract) {
      events.push("monitor:start");
      assert.deepEqual(contract.checks, [
        "api_health",
        "primary_chat_websocket",
        "unrelated_worker_health",
        "api_oom_counter",
        "global_oom_counter",
      ]);
      return {
        async checkpoint(label) {
          events.push(`monitor:${label}`);
          if (options.unhealthyCheckpoint === label) return { healthy: false, raw_error: "/secret/health" };
          return { healthy: true, raw_body: "SECRET" };
        },
        async stop() {
          events.push("monitor:stop");
          if (options.stopThrows) throw new Error("/secret/monitor-stop");
          return options.monitorSummary || monitorSummary();
        },
      };
    },
    async runPhase(id, contract) {
      events.push(`phase:${id}`);
      assert.equal(contract.candidate.status, "candidate_pending_staging");
      assert.equal(contract.candidate.executable, "systemd-run");
      assert.deepEqual(contract.candidate.fixed_args, ["--user", "--scope", "--collect", "--quiet"]);
      assert(!contract.candidate.fixed_args.includes("--pipe"));
      if (options.throwPhase === id) throw new Error("/secret/phase token=NOLEAK");
      if (options.phaseResults && options.phaseResults[id]) return options.phaseResults[id];
      return phaseResult(id);
    },
  };
}

async function main() {
  // Full injected matrix: monitoring begins first, checkpoints bracket every
  // pressure phase, and stop occurs only after the final checkpoint.
  {
    const events = [];
    const result = await runStagingProof({
      acknowledgement: ACK,
      runPressure: true,
      adapter: injectedAdapter({ events }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "proof_passed");
    assert.equal(result.candidate.status, "candidate_pending_staging");
    assert.equal(result.candidate.pinned, true);
    assert.deepEqual(result.started_phases, PHASES.map((phase) => phase.id));
    assert.equal(result.monitor_checkpoints, PHASES.length * 2 + 1);
    assert.equal(result.evidence.length, PHASES.length + 5);
    assert(result.evidence.every((item) => item.status === "passed"));
    assert.equal(events[0], "inspect");
    assert.equal(events[1], "monitor:start");
    assert.equal(events[2], "monitor:matrix_start");
    assert.equal(events.at(-1), "monitor:stop");
    for (const phase of PHASES) {
      const before = events.indexOf(`monitor:before:${phase.id}`);
      const run = events.indexOf(`phase:${phase.id}`);
      const after = events.indexOf(`monitor:after:${phase.id}`);
      assert(before < run && run < after, `${phase.id} is continuously bracketed`);
    }
    const serialized = JSON.stringify(result);
    assert(!serialized.includes("/secret"));
    assert(!serialized.includes("SECRET"));
    assert(!serialized.includes(MACHINE_ID), "machine-id is gate input, never evidence output");
  }

  // Every gate is checked before monitoring or any child/pressure phase. A
  // missing flag, mismatch, unsupported host, or absent capability fails shut.
  for (const testCase of [
    { name: "run flag absent", runPressure: false, acknowledgement: ACK, reason: "proof_refused" },
    { name: "ack absent", runPressure: true, acknowledgement: null, reason: "proof_refused" },
    { name: "ack mismatch", runPressure: true, acknowledgement: `${ACK_PREFIX}ffffffffffffffffffffffffffffffff`, reason: "proof_refused" },
    { name: "not linux", runPressure: true, acknowledgement: ACK, gates: { linux: false, cgroupV2: true, userManager: true, machineId: MACHINE_ID }, reason: "proof_unavailable" },
    { name: "no cgroup v2", runPressure: true, acknowledgement: ACK, gates: { linux: true, cgroupV2: false, userManager: true, machineId: MACHINE_ID }, reason: "proof_unavailable" },
    { name: "no user manager", runPressure: true, acknowledgement: ACK, gates: { linux: true, cgroupV2: true, userManager: false, machineId: MACHINE_ID }, reason: "proof_unavailable" },
    { name: "invalid machine id", runPressure: true, acknowledgement: ACK, gates: { linux: true, cgroupV2: true, userManager: true, machineId: "invalid" }, reason: "proof_unavailable" },
  ]) {
    const events = [];
    const result = await runStagingProof({
      runPressure: testCase.runPressure,
      acknowledgement: testCase.acknowledgement,
      adapter: injectedAdapter({ events, gates: testCase.gates }),
    });
    assert.equal(result.reason, testCase.reason, testCase.name);
    assert.deepEqual(events, ["inspect"], `${testCase.name}: no monitor, child, service, temp, or pressure phase starts`);
    assert.deepEqual(result.started_phases, []);
  }

  // A failed phase stops the matrix immediately, but the continuous monitor is
  // always stopped. Later pressure phases are never attempted.
  {
    const events = [];
    const failedId = "descendant_cgroup_membership";
    const result = await runStagingProof({
      acknowledgement: ACK,
      runPressure: true,
      adapter: injectedAdapter({
        events,
        phaseResults: { [failedId]: { status: "failed", raw_error: "/secret/failure" } },
      }),
    });
    assert.equal(result.reason, "proof_failed");
    assert.deepEqual(result.started_phases, PHASES.slice(0, 3).map((phase) => phase.id));
    assert(!events.includes("phase:effective_temp_disk_boundary"));
    assert(!events.includes("phase:bounded_worker_oom_counter"));
    assert.equal(events.at(-1), "monitor:stop");
    assert(!JSON.stringify(result).includes("/secret"));
  }

  // Adapter inability is typed unavailable, never simulated into a pass.
  {
    const unavailableId = "resize_signal_exit_propagation";
    const result = await runStagingProof({
      acknowledgement: ACK,
      runPressure: true,
      adapter: injectedAdapter({ phaseResults: { [unavailableId]: { status: "unavailable", output: "fake pass" } } }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "proof_unavailable");
    assert.deepEqual(result.started_phases, PHASES.slice(0, 2).map((phase) => phase.id));
  }

  // A continuous-health checkpoint fails before the associated phase starts.
  {
    const events = [];
    const blockedId = "bounded_worker_oom_counter";
    const result = await runStagingProof({
      acknowledgement: ACK,
      runPressure: true,
      adapter: injectedAdapter({ events, unhealthyCheckpoint: `before:${blockedId}` }),
    });
    assert.equal(result.reason, "proof_failed");
    assert(!events.includes(`phase:${blockedId}`));
    assert.equal(events.at(-1), "monitor:stop");
  }

  // Raw thrown errors are reduced to typed output.
  {
    const result = await runStagingProof({
      acknowledgement: ACK,
      runPressure: true,
      adapter: injectedAdapter({ throwPhase: "node_pty_controlling_tty" }),
    });
    assert.equal(result.reason, "proof_unavailable");
    assert(!JSON.stringify(result).includes("NOLEAK"));
    assert(!JSON.stringify(result).includes("/secret"));
  }

  // The default adapter performs only fixed read-only gate probes and refuses
  // live execution even after an otherwise valid opt-in.
  {
    const fsCalls = [];
    const execCalls = [];
    const fakeFs = {
      readFileSync(file, encoding) {
        fsCalls.push(["read", file, encoding]);
        return `${MACHINE_ID}\n`;
      },
      existsSync(file) {
        fsCalls.push(["exists", file]);
        return file === "/cgroup/cgroup.controllers";
      },
    };
    const adapter = createDefaultAdapter({
      fsImpl: fakeFs,
      execFileSyncImpl(file, args) {
        execCalls.push([file, [...args]]);
        return "259\n";
      },
      platform: "linux",
      machineIdPath: "/machine-id",
      cgroupRoot: "/cgroup",
    });
    const result = await runStagingProof({ acknowledgement: ACK, runPressure: true, adapter });
    assert.equal(result.reason, "proof_unavailable");
    assert.deepEqual(result.started_phases, []);
    assert.deepEqual(fsCalls, [
      ["read", "/machine-id", "utf8"],
      ["exists", "/cgroup/cgroup.controllers"],
    ]);
    assert.deepEqual(execCalls, [["systemctl", ["--user", "show", "--property=Version", "--value"]]]);
  }

  assert.deepEqual(parseCliArgs([]), { acknowledgement: null, runPressure: false, json: false });
  assert.deepEqual(parseCliArgs(["--json", "--run-pressure-matrix", "--ack-disposable-host", ACK]), {
    acknowledgement: ACK,
    runPressure: true,
    json: true,
  });
  for (const args of [
    ["--scope-proof"],
    ["--run-pressure-matrix", "--run-pressure-matrix"],
    ["--ack-disposable-host"],
    ["--ack-disposable-host", "--json"],
  ]) assert.throws(() => parseCliArgs(args));

  console.log("resource-staging-proof.test.js: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
