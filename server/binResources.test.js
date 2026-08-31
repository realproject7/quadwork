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
  assert.match(stdout.value(), /Status: PASS/);
  assert.match(stdout.value(), /Primary reason: ok/);
  assert(!stdout.value().includes(DEFAULT_RUNTIME_RESOURCE_PROPOSAL.temp_root), "human output never prints the configured temp path");
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
