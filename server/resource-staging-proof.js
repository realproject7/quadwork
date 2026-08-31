#!/usr/bin/env node
"use strict";

// #1038: disposable-host staging coordinator. The current systemd flags are a
// candidate only. This file does not make them supported and the default host
// adapter deliberately cannot launch pressure phases.

const fs = require("fs");
const { execFileSync } = require("child_process");
const { SYSTEMD_SCOPE_CANDIDATE } = require("./resource-controller");

const ACK_PREFIX = "DISPOSABLE-STAGING:";
const MACHINE_ID_RE = /^[a-f0-9]{32}$/;
const EXPECTED_CANDIDATE_ARGS = Object.freeze(["--user", "--scope", "--collect", "--quiet"]);
const MONITOR_CHECKS = Object.freeze([
  "api_health",
  "primary_chat_websocket",
  "unrelated_worker_health",
  "api_oom_counter",
  "global_oom_counter",
]);
const PHASES = Object.freeze([
  Object.freeze({
    id: "node_pty_controlling_tty",
    fields: Object.freeze(["controlling_tty"]),
  }),
  Object.freeze({
    id: "resize_signal_exit_propagation",
    fields: Object.freeze(["resize_propagated", "signal_propagated", "exit_propagated"]),
  }),
  Object.freeze({
    id: "descendant_cgroup_membership",
    fields: Object.freeze(["all_descendants_in_worker_cgroup"]),
    positiveIntegerFields: Object.freeze(["descendant_count"]),
  }),
  Object.freeze({
    id: "effective_temp_disk_boundary",
    fields: Object.freeze(["effective_temp_disk_backed", "effective_temp_within_generation_root"]),
  }),
  Object.freeze({
    id: "bounded_worker_oom_counter",
    fields: Object.freeze(["worker_scope_bounded"]),
    counterPair: Object.freeze(["worker_oom_counter_before", "worker_oom_counter_after"]),
  }),
]);

class StagingProofError extends Error {
  constructor(code, check) {
    super(code);
    this.name = "StagingProofError";
    this.code = code;
    this.check = check;
  }
}

function safeGet(value, key) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return value[key]; } catch { return undefined; }
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function candidateContract() {
  const fixedArgs = Array.isArray(SYSTEMD_SCOPE_CANDIDATE.fixedArgs)
    ? [...SYSTEMD_SCOPE_CANDIDATE.fixedArgs]
    : [];
  const pinned = SYSTEMD_SCOPE_CANDIDATE.status === "candidate_pending_staging"
    && SYSTEMD_SCOPE_CANDIDATE.executable === "systemd-run"
    && fixedArgs.length === EXPECTED_CANDIDATE_ARGS.length
    && fixedArgs.every((arg, index) => arg === EXPECTED_CANDIDATE_ARGS[index])
    && !fixedArgs.includes("--pipe");
  return Object.freeze({
    status: "candidate_pending_staging",
    executable: "systemd-run",
    fixed_args: EXPECTED_CANDIDATE_ARGS,
    pinned,
  });
}

function createDefaultAdapter(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const platform = options.platform || process.platform;
  const machineIdPath = options.machineIdPath || "/etc/machine-id";
  const cgroupRoot = options.cgroupRoot || "/sys/fs/cgroup";

  return Object.freeze({
    inspectGates() {
      let machineId = null;
      try {
        const value = String(fsImpl.readFileSync(machineIdPath, "utf8")).trim();
        if (MACHINE_ID_RE.test(value)) machineId = value;
      } catch {}
      const linux = platform === "linux";
      const cgroupV2 = linux && fsImpl.existsSync(`${cgroupRoot}/cgroup.controllers`);
      let userManager = false;
      if (linux && cgroupV2) {
        try {
          const output = execFileSyncImpl("systemctl", ["--user", "show", "--property=Version", "--value"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5000,
          });
          userManager = String(output).trim().length > 0;
        } catch {}
      }
      return { linux, cgroupV2, userManager, machineId };
    },

    async startContinuousMonitoring() {
      // A real adapter needs deployment-specific authenticated API, Primary
      // Chat-WebSocket, unrelated-worker, and OOM-counter probes. Guessing or
      // simulating those checks would create a false PASS.
      throw new StagingProofError("proof_unavailable", "default_live_adapter_unavailable");
    },

    async runPhase() {
      throw new StagingProofError("proof_unavailable", "default_live_adapter_unavailable");
    },
  });
}

function sanitizeGates(raw, acknowledgement, runPressure) {
  const machineId = safeGet(raw, "machineId");
  const machineIdPresent = typeof machineId === "string" && MACHINE_ID_RE.test(machineId);
  return Object.freeze({
    linux: safeGet(raw, "linux") === true,
    cgroup_v2: safeGet(raw, "cgroupV2") === true,
    user_manager: safeGet(raw, "userManager") === true,
    machine_id_present: machineIdPresent,
    acknowledgement_matches: machineIdPresent && acknowledgement === `${ACK_PREFIX}${machineId}`,
    run_requested: runPressure === true,
  });
}

function sanitizePhaseResult(phase, raw) {
  const status = safeGet(raw, "status");
  if (status === "unavailable") {
    return Object.freeze({ check: phase.id, status: "unavailable", facts: Object.freeze({}) });
  }
  if (status !== "passed") {
    return Object.freeze({ check: phase.id, status: "failed", facts: Object.freeze({}) });
  }
  const facts = {};
  for (const field of phase.fields || []) {
    if (safeGet(raw, field) !== true) {
      return Object.freeze({ check: phase.id, status: "failed", facts: Object.freeze({}) });
    }
    facts[field] = true;
  }
  for (const field of phase.positiveIntegerFields || []) {
    const value = nonNegativeInteger(safeGet(raw, field));
    if (value === null || value === 0) {
      return Object.freeze({ check: phase.id, status: "failed", facts: Object.freeze({}) });
    }
    facts[field] = value;
  }
  if (phase.counterPair) {
    const before = nonNegativeInteger(safeGet(raw, phase.counterPair[0]));
    const after = nonNegativeInteger(safeGet(raw, phase.counterPair[1]));
    if (before === null || after === null || after <= before) {
      return Object.freeze({ check: phase.id, status: "failed", facts: Object.freeze({}) });
    }
    facts.worker_oom_counter_before = before;
    facts.worker_oom_counter_after = after;
    facts.worker_oom_counter_delta = after - before;
  }
  return Object.freeze({ check: phase.id, status: "passed", facts: Object.freeze(facts) });
}

function sanitizeMonitorSummary(raw, checkpointCount) {
  const sampleCount = nonNegativeInteger(safeGet(raw, "sample_count"));
  const apiBefore = nonNegativeInteger(safeGet(raw, "api_oom_counter_before"));
  const apiAfter = nonNegativeInteger(safeGet(raw, "api_oom_counter_after"));
  const globalBefore = nonNegativeInteger(safeGet(raw, "global_oom_counter_before"));
  const globalAfter = nonNegativeInteger(safeGet(raw, "global_oom_counter_after"));
  const common = sampleCount !== null && sampleCount >= 2 && checkpointCount >= (PHASES.length * 2 + 1);
  return Object.freeze([
    Object.freeze({
      check: "continuous_api_health",
      status: common && safeGet(raw, "api_continuously_healthy") === true ? "passed" : "failed",
      facts: Object.freeze({ sample_count: sampleCount }),
    }),
    Object.freeze({
      check: "continuous_primary_chat_websocket",
      status: common && safeGet(raw, "primary_chat_websocket_continuously_healthy") === true ? "passed" : "failed",
      facts: Object.freeze({ sample_count: sampleCount }),
    }),
    Object.freeze({
      check: "continuous_unrelated_worker_health",
      status: common && safeGet(raw, "unrelated_worker_continuously_healthy") === true ? "passed" : "failed",
      facts: Object.freeze({ sample_count: sampleCount }),
    }),
    Object.freeze({
      check: "api_oom_unchanged",
      status: common && apiBefore !== null && apiAfter === apiBefore ? "passed" : "failed",
      facts: Object.freeze({ counter_delta: apiBefore !== null && apiAfter !== null ? apiAfter - apiBefore : null }),
    }),
    Object.freeze({
      check: "global_oom_absent",
      status: common && globalBefore !== null && globalAfter === globalBefore ? "passed" : "failed",
      facts: Object.freeze({ counter_delta: globalBefore !== null && globalAfter !== null ? globalAfter - globalBefore : null }),
    }),
  ]);
}

function failureCode(error, fallback = "proof_unavailable") {
  return error instanceof StagingProofError && ["proof_unavailable", "proof_failed"].includes(error.code)
    ? error.code
    : fallback;
}

function report({ ok = false, reason, gates, evidence = [], startedPhases = [], checkpointCount = 0 }) {
  return Object.freeze({
    ok,
    reason,
    candidate: candidateContract(),
    gates,
    evidence: Object.freeze([...evidence]),
    started_phases: Object.freeze([...startedPhases]),
    monitor_checkpoints: checkpointCount,
  });
}

async function runStagingProof(options = {}) {
  const adapter = options.adapter || createDefaultAdapter();
  const acknowledgement = options.acknowledgement;
  const runPressure = options.runPressure === true;
  let rawGates;
  try {
    rawGates = await adapter.inspectGates();
  } catch {
    const gates = sanitizeGates({}, acknowledgement, runPressure);
    return report({ reason: "proof_unavailable", gates });
  }
  const gates = sanitizeGates(rawGates, acknowledgement, runPressure);
  const candidate = candidateContract();
  if (!candidate.pinned || !gates.linux || !gates.cgroup_v2 || !gates.user_manager || !gates.machine_id_present) {
    return report({ reason: "proof_unavailable", gates });
  }
  if (!gates.run_requested || !gates.acknowledgement_matches) {
    return report({ reason: "proof_refused", gates });
  }
  if (typeof adapter.startContinuousMonitoring !== "function" || typeof adapter.runPhase !== "function") {
    return report({ reason: "proof_unavailable", gates });
  }

  let monitor;
  try {
    monitor = await adapter.startContinuousMonitoring(Object.freeze({
      checks: MONITOR_CHECKS,
      candidate,
    }));
  } catch (error) {
    return report({ reason: failureCode(error), gates });
  }
  if (!monitor || typeof monitor.checkpoint !== "function" || typeof monitor.stop !== "function") {
    try { if (monitor && typeof monitor.stop === "function") await monitor.stop(); } catch {}
    return report({ reason: "proof_unavailable", gates });
  }

  const evidence = [];
  const startedPhases = [];
  let checkpointCount = 0;
  let failureReason = null;
  let monitorSummary = null;
  const checkpoint = async (label) => {
    const current = await monitor.checkpoint(label);
    checkpointCount += 1;
    if (!current || safeGet(current, "healthy") !== true) {
      throw new StagingProofError("proof_failed", "continuous_monitor_unhealthy");
    }
  };

  try {
    await checkpoint("matrix_start");
    for (const phase of PHASES) {
      await checkpoint(`before:${phase.id}`);
      startedPhases.push(phase.id);
      let phaseResult;
      try {
        phaseResult = sanitizePhaseResult(phase, await adapter.runPhase(phase.id, Object.freeze({ candidate })));
      } catch (error) {
        failureReason = failureCode(error);
        break;
      }
      evidence.push(phaseResult);
      if (phaseResult.status !== "passed") {
        failureReason = phaseResult.status === "unavailable" ? "proof_unavailable" : "proof_failed";
        break;
      }
      await checkpoint(`after:${phase.id}`);
    }
  } catch (error) {
    failureReason = failureCode(error, "proof_failed");
  } finally {
    try {
      monitorSummary = await monitor.stop();
    } catch {
      if (!failureReason) failureReason = "proof_unavailable";
    }
  }

  if (!failureReason && startedPhases.length === PHASES.length) {
    const monitoringEvidence = sanitizeMonitorSummary(monitorSummary, checkpointCount);
    evidence.push(...monitoringEvidence);
    if (monitoringEvidence.some((item) => item.status !== "passed")) failureReason = "proof_failed";
  }
  return report({
    ok: failureReason === null && startedPhases.length === PHASES.length,
    reason: failureReason || "proof_passed",
    gates,
    evidence,
    startedPhases,
    checkpointCount,
  });
}

function parseCliArgs(args) {
  const parsed = { acknowledgement: null, runPressure: false, json: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (seen.has(arg)) throw new StagingProofError("proof_refused", "invalid_arguments");
    if (arg === "--json") {
      parsed.json = true;
      seen.add(arg);
    } else if (arg === "--run-pressure-matrix") {
      parsed.runPressure = true;
      seen.add(arg);
    } else if (arg === "--ack-disposable-host") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw new StagingProofError("proof_refused", "invalid_arguments");
      }
      parsed.acknowledgement = value;
      seen.add(arg);
      index += 1;
    } else {
      throw new StagingProofError("proof_refused", "invalid_arguments");
    }
  }
  return Object.freeze(parsed);
}

function renderHuman(result) {
  const lines = [
    "QuadWork disposable resource staging matrix",
    "===========================================",
    `Status: ${result.ok ? "PASS" : "NOT PASSED"}`,
    `Reason: ${result.reason}`,
    `Controller flags: ${result.candidate.status}`,
    `Gates: linux=${result.gates.linux} cgroup-v2=${result.gates.cgroup_v2} user-manager=${result.gates.user_manager} acknowledgement=${result.gates.acknowledgement_matches} run=${result.gates.run_requested}`,
  ];
  for (const item of result.evidence) lines.push(`  ${item.status}: ${item.check}`);
  return `${lines.join("\n")}\n`;
}

async function main(args = process.argv.slice(2), streams = process) {
  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch {
    streams.stderr.write("Usage: node server/resource-staging-proof.js [--json] [--run-pressure-matrix --ack-disposable-host DISPOSABLE-STAGING:<machine-id>]\n");
    return 2;
  }
  const result = await runStagingProof(parsed);
  streams.stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : renderHuman(result));
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}

module.exports = {
  ACK_PREFIX,
  MONITOR_CHECKS,
  PHASES,
  StagingProofError,
  createDefaultAdapter,
  parseCliArgs,
  renderHuman,
  runStagingProof,
};
