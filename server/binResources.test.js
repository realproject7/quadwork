"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL, ResourcePolicyError } = require("./resource-policy");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "qw-bin-resources-"));
const originalHome = os.homedir;
os.homedir = () => tempHome;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
});

const { runResourcesCommand } = require("../bin/quadwork");

function policy() {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
  };
}

function probes(scopeProof) {
  return {
    memory: () => ({ totalMib: 8192, availableMib: 4000, swapTotalMib: 8192, swapFreeMib: 7000 }),
    containment: () => ({ cgroupV2: true, userManager: true, systemdRun: true, scopeProof }),
    temp: () => ({
      exists: true,
      directory: true,
      symlink: false,
      owned: true,
      secureMode: true,
      diskBacked: true,
      freeMib: 5000,
      totalMib: 10000,
    }),
    api: () => ({ memoryLowMib: 512, memoryMaxMib: 1280, oomPolicy: "continue", separateFromWorkers: scopeProof }),
    activeScopes: () => 1,
  };
}

function sink() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    value: () => value,
  };
}

// A missing config stays missing: actual read-only config access must not
// create ~/.quadwork/config.json (or even its parent directory).
{
  const stdout = sink();
  const stderr = sink();
  const exitCode = runResourcesCommand(["preflight", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    createReadOnlyProbes: () => ({
      memory() { throw new Error("absent policy must short-circuit probes"); },
    }),
  });
  const report = JSON.parse(stdout.value());
  assert.equal(exitCode, 1);
  assert.equal(report.reason, "invalid_resource_policy");
  assert.equal(report.reasons[0].check, "policy_absent");
  assert.equal(stderr.value(), "");
  assert.equal(fs.existsSync(path.join(tempHome, ".quadwork")), false, "preflight performs no startup config creation");
}

// Candidate PTY/systemd support is not staging proof. The handler calls the
// adapter factory with no proof override, so its default remains false.
{
  const stdout = sink();
  let factoryArguments = null;
  const exitCode = runResourcesCommand(["preflight", "--json"], {
    stdout: stdout.stream,
    stderr: sink().stream,
    readRuntimeResources: () => policy(),
    createReadOnlyProbes(...args) {
      factoryArguments = args;
      return probes(false);
    },
  });
  const report = JSON.parse(stdout.value());
  assert.deepEqual(factoryArguments, [], "CLI cannot pass a fabricated scopeProof option");
  assert.equal(exitCode, 1);
  assert.equal(report.reason, "containment_unavailable");
  assert(report.reasons.some((reason) => reason.check === "systemd_scope_unavailable"));
  assert.deepEqual(Object.keys(report.policy), [
    "configured",
    "version",
    "mode",
    "hostReserveMib",
    "maxWorkerScopes",
    "apiMemoryLowMib",
    "apiMemoryMaxMib",
    "workerMemoryHighMib",
    "workerMemoryMaxMib",
    "workerSwapMaxMib",
    "controlMemoryMaxMib",
    "controlSwapMaxMib",
    "maxConcurrentChildren",
    "tempMinFreeMib",
  ], "JSON includes the complete redacted configured limit schema");
  assert.deepEqual(report.policy, {
    configured: true,
    version: 1,
    mode: "systemd-user-v1",
    hostReserveMib: 1536,
    maxWorkerScopes: 3,
    apiMemoryLowMib: 512,
    apiMemoryMaxMib: 1280,
    workerMemoryHighMib: 1024,
    workerMemoryMaxMib: 1200,
    workerSwapMaxMib: 512,
    controlMemoryMaxMib: 512,
    controlSwapMaxMib: 256,
    maxConcurrentChildren: 2,
    tempMinFreeMib: 4096,
  });
  assert(!stdout.value().includes(DEFAULT_RUNTIME_RESOURCE_PROPOSAL.temp_root), "JSON output contains only the redacted report");
}

// A test-only proven adapter exercises human output and the success exit code.
{
  const stdout = sink();
  const exitCode = runResourcesCommand(["preflight"], {
    stdout: stdout.stream,
    stderr: sink().stream,
    readRuntimeResources: () => policy(),
    createReadOnlyProbes: () => probes(true),
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout.value(), [
    "QuadWork resource preflight",
    "===========================",
    "Status: PASS",
    "Primary reason: ok",
    "Policy configured: yes",
    "Configured API limits: low 512 MiB; max 1280 MiB",
    "Configured worker limits: high 1024 MiB; max 1200 MiB; swap max 512 MiB",
    "Configured control limits: max 512 MiB; swap max 256 MiB; concurrent children 2",
    "Configured host reserve: 1536 MiB",
    "Configured worker scope ceiling: 3",
    "Configured temp free threshold: 4096 MiB",
    "Host memory: available 4000 MiB; total 8192 MiB",
    "Host swap: free 7000 MiB; total 8192 MiB",
    "Containment: cgroup v2 yes; user manager yes; systemd-run yes; scope proof yes",
    "Temp root: exists yes; directory yes; symlink no; owned yes; mode 0700 yes; disk-backed yes",
    "Temp capacity: free 5000 MiB; total 10000 MiB",
    "Observed API limits: low 512 MiB; max 1280 MiB; OOM policy continue; separate from workers yes",
    "Worker scopes: 1 active; 1 requested; 3 static ceiling",
    "Static RAM reservation: 6928 MiB",
    "Static RAM headroom: 1264 MiB",
    "Configured swap reservation: 1792 MiB",
    "Configured swap headroom: 6400 MiB",
    "Requested worker RAM: 1200 MiB",
    "Requested worker swap: 512 MiB",
    "Live RAM reserve plus request: 2736 MiB",
    "Live RAM headroom: 1264 MiB",
    "",
  ].join("\n"));
  assert(!stdout.value().includes(DEFAULT_RUNTIME_RESOURCE_PROPOSAL.temp_root), "human output never prints the configured temp path");
}

// A populated failure renders measured false/negative facts exactly instead of
// collapsing them into unavailable or optimistic values.
{
  const stdout = sink();
  const failingProbes = probes(false);
  failingProbes.memory = () => ({ totalMib: 8192, availableMib: 2000, swapTotalMib: 8192, swapFreeMib: 7000 });
  const exitCode = runResourcesCommand(["preflight"], {
    stdout: stdout.stream,
    stderr: sink().stream,
    readRuntimeResources: () => policy(),
    createReadOnlyProbes: () => failingProbes,
  });
  const lines = stdout.value().split("\n");
  assert.equal(exitCode, 1);
  assert(lines.includes("Primary reason: containment_unavailable"));
  assert(lines.includes("Containment: cgroup v2 yes; user manager yes; systemd-run yes; scope proof no"));
  assert(lines.includes("Observed API limits: low 512 MiB; max 1280 MiB; OOM policy continue; separate from workers no"));
  assert(lines.includes("Worker scopes: 1 active; 1 requested; 3 static ceiling"));
  assert(lines.includes("Live RAM headroom: -736 MiB"));
  assert(lines.includes("  - capacity_exhausted/live_memory_headroom_low: Reduce configured capacity or add RAM, swap, or disk headroom; existing scopes remain untouched."));
}

// Human failures keep the same complete shape and stable unavailable wording;
// raw config/probe errors cannot fill any displayed field.
{
  const stdout = sink();
  const exitCode = runResourcesCommand(["preflight"], {
    stdout: stdout.stream,
    stderr: sink().stream,
    readRuntimeResources() {
      throw new Error("/secret/config.json token=do-not-leak");
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.value(), [
    "QuadWork resource preflight",
    "===========================",
    "Status: FAIL",
    "Primary reason: invalid_resource_policy",
    "Policy configured: no",
    "Configured API limits: low unavailable; max unavailable",
    "Configured worker limits: high unavailable; max unavailable; swap max unavailable",
    "Configured control limits: max unavailable; swap max unavailable; concurrent children unavailable",
    "Configured host reserve: unavailable",
    "Configured worker scope ceiling: unavailable",
    "Configured temp free threshold: unavailable",
    "Host memory: available unavailable; total unavailable",
    "Host swap: free unavailable; total unavailable",
    "Containment: cgroup v2 unavailable; user manager unavailable; systemd-run unavailable; scope proof unavailable",
    "Temp root: exists unavailable; directory unavailable; symlink unavailable; owned unavailable; mode 0700 unavailable; disk-backed unavailable",
    "Temp capacity: free unavailable; total unavailable",
    "Observed API limits: low unavailable; max unavailable; OOM policy unavailable; separate from workers unavailable",
    "Worker scopes: unavailable active; unavailable requested; unavailable static ceiling",
    "Static RAM reservation: unavailable",
    "Static RAM headroom: unavailable",
    "Configured swap reservation: unavailable",
    "Configured swap headroom: unavailable",
    "Requested worker RAM: unavailable",
    "Requested worker swap: unavailable",
    "Live RAM reserve plus request: unavailable",
    "Live RAM headroom: unavailable",
    "Checks:",
    "  - invalid_resource_policy/policy_invalid: Configure and explicitly accept a valid runtime_resources v1 policy, then rerun preflight.",
    "",
  ].join("\n"));
  assert(!stdout.value().includes("/secret"));
  assert(!stdout.value().includes("do-not-leak"));
}

// Invalid policy/config reads are reduced to a stable typed report; raw errors,
// host paths, tokens, and environment details are not exposed.
{
  const stdout = sink();
  const exitCode = runResourcesCommand(["preflight", "--json"], {
    stdout: stdout.stream,
    stderr: sink().stream,
    readRuntimeResources() {
      throw new ResourcePolicyError("/secret/config token=do-not-leak");
    },
    createReadOnlyProbes() {
      throw new Error("probes must not run after a policy read failure");
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(stdout.value()).reasons[0].check, "policy_invalid");
  assert(!stdout.value().includes("/secret"));
  assert(!stdout.value().includes("do-not-leak"));
}

// Unknown flags, including any attempted proof override, fail before reading
// config or constructing probes.
{
  const stdout = sink();
  const stderr = sink();
  let calls = 0;
  const exitCode = runResourcesCommand(["preflight", "--scope-proof"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    readRuntimeResources() { calls += 1; return policy(); },
    createReadOnlyProbes() { calls += 1; return probes(true); },
  });
  assert.equal(exitCode, 2);
  assert.equal(calls, 0);
  assert.equal(stdout.value(), "");
  assert.match(stderr.value(), /^Usage: quadwork resources preflight \[--json\]/);
}

// Exercise the real process dispatch and process.exitCode contract. An empty
// HOME must remain empty; unlike the legacy readConfig path, preflight cannot
// bootstrap ~/.quadwork as a startup side effect.
{
  const childHome = fs.mkdtempSync(path.join(os.tmpdir(), "qw-bin-resources-child-"));
  const child = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "quadwork.js"), "resources", "preflight", "--json"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, HOME: childHome },
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).reasons[0].check, "policy_absent");
  assert.equal(child.stderr, "");
  assert.deepEqual(fs.readdirSync(childHome), [], "real CLI dispatch invokes no config writer");
  fs.rmSync(childHome, { recursive: true, force: true });
}

console.log("binResources.test.js: all assertions passed");
