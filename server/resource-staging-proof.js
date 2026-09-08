#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");
const { SYSTEMD_SCOPE_CANDIDATE } = require("./resource-controller");
const ACK_PREFIX = "DISPOSABLE-STAGING:";
const MONITOR_CHECKS = Object.freeze(["api_health", "primary_chat_roundtrip", "terminal_websocket", "unrelated_worker_health"]);
const PHASES = Object.freeze(["non_pressure_pty_descendants_temp", "integrated_bounded_worker_oom"]);
class StagingProofError extends Error { constructor(code, check) { super(code); this.code = code; this.check = check; } }
function optionsRecord(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new StagingProofError("proof_refused", "invalid_arguments");
  const permitted = new Set(["acknowledgement", "runPressure", "json"]);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!permitted.has(key) || !d || !("value" in d)) throw new StagingProofError("proof_refused", "invalid_arguments");
  }
  if (value.acknowledgement != null && typeof value.acknowledgement !== "string" || value.runPressure !== undefined && typeof value.runPressure !== "boolean" || value.json !== undefined && typeof value.json !== "boolean") throw new StagingProofError("proof_refused", "invalid_arguments");
  return value;
}
function parseCliArgs(args) {
  const result = { acknowledgement: null, runPressure: false, json: false }, seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (seen.has(arg)) throw new StagingProofError("proof_refused", "invalid_arguments");
    seen.add(arg);
    if (arg === "--json") result.json = true;
    else if (arg === "--run-pressure-matrix") result.runPressure = true;
    else if (arg === "--ack-disposable-host" && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--")) result.acknowledgement = args[++i];
    else throw new StagingProofError("proof_refused", "invalid_arguments");
  }
  return Object.freeze(result);
}
function gates(options) {
  let machineId = null, userManager = false;
  if (process.platform === "linux") {
    try { machineId = fs.readFileSync("/etc/machine-id", "utf8").trim(); } catch {}
    try { userManager = /^(?:25[3-9]|2[6-9]\d|[3-9]\d\d)/.test(execFileSync("systemctl", ["--user", "show", "--property=Version", "--value"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }).trim()); } catch {}
  }
  return { linux: process.platform === "linux", cgroup_v2: fs.existsSync("/sys/fs/cgroup/cgroup.controllers"), user_manager: userManager, machine_id_present: /^[a-f0-9]{32}$/.test(machineId || ""), acknowledgement_matches: !!machineId && options.acknowledgement === ACK_PREFIX + machineId, run_requested: options.runPressure === true };
}
async function runStagingProof(input = {}) {
  let options;
  try { options = optionsRecord(input); } catch { return { ok: false, reason: "proof_refused", check: "invalid_arguments", started_phases: [] }; }
  const gate = gates(options);
  const base = { version: 2, ok: false, candidate: { executable: SYSTEMD_SCOPE_CANDIDATE.executable, args: [...SYSTEMD_SCOPE_CANDIDATE.fixedArgs], support_claim: "requires_actual_integrated_matrix" }, gates: gate, started_phases: [], provider_model_turns: "unproved_no_credentials", trusted_boundary: "installed_source_and_dedicated_local_os_account" };
  if (!gate.run_requested || !gate.acknowledgement_matches) return { ...base, reason: "proof_refused" };
  if (!gate.linux || !gate.cgroup_v2 || !gate.user_manager || !gate.machine_id_present || process.env.NODE_OPTIONS || process.env.NODE_PATH) return { ...base, reason: "proof_unavailable" };
  // The runner constructs its only live implementation after all gates pass.
  // No caller target, adapter, module, command, filesystem or PASS is accepted.
  const { runClosedStagingMatrix } = require("./resource-staging-live-adapter");
  try { return { ...base, ...(await runClosedStagingMatrix(options)) }; }
  catch (error) { return { ...base, reason: "proof_failed", check: /^[a-z_]+$/.test(error.check || "") ? error.check : "live_matrix_failed" }; }
}
function renderHuman(result) { return `QuadWork disposable resource matrix: ${result.ok ? "PASS" : "NOT PASSED"}\nReason: ${result.reason}\nAuthenticated provider model turns: unproved\n`; }
async function main(args = process.argv.slice(2)) {
  let parsed; try { parsed = parseCliArgs(args); } catch { process.stderr.write("Usage: node server/resource-staging-proof.js --json --run-pressure-matrix --ack-disposable-host DISPOSABLE-STAGING:<machine-id>\n"); return 2; }
  const result = await runStagingProof(parsed);
  process.stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : renderHuman(result));
  return result.ok ? 0 : 1;
}
if (require.main === module) main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
module.exports = { ACK_PREFIX, MONITOR_CHECKS, PHASES, StagingProofError, parseCliArgs, renderHuman, runStagingProof };
