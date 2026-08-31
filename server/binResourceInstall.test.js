"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-bin-resource-install-")));
const originalHomedir = os.homedir;
os.homedir = () => tempHome;
process.on("exit", () => {
  os.homedir = originalHomedir;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
});

const { runResourcesCommand } = require("../bin/quadwork");
const { ResourceInstallError, applyPolicy } = require("./resource-install");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");

const configDir = path.join(tempHome, ".quadwork");
const configPath = path.join(configDir, "config.json");
const policyPath = path.join(tempHome, "policy.json");
fs.mkdirSync(configDir, { mode: 0o700 });
fs.chmodSync(configDir, 0o700);
fs.writeFileSync(configPath, JSON.stringify({ port: 8400, preserved: "yes" }), { mode: 0o600 });
fs.writeFileSync(policyPath, JSON.stringify({
  ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
  temp_root: path.join(configDir, "tmp"),
  api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
  worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
  control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
}), { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
fs.chmodSync(policyPath, 0o600);

function sink() {
  let output = "";
  return { stream: { write(chunk) { output += String(chunk); } }, value: () => output };
}

function pathConfigDirectoryHandle({ directory, fsImpl }) {
  const exchange = (from, to) => {
    const hold = `.resource-install-cli-test-exchange-${process.pid}`;
    fsImpl.renameSync(path.join(directory, from), path.join(directory, hold));
    fsImpl.renameSync(path.join(directory, to), path.join(directory, from));
    fsImpl.renameSync(path.join(directory, hold), path.join(directory, to));
  };
  return {
    stat: () => fsImpl.lstatSync(directory),
    path: (name) => path.join(directory, name),
    assertExchangeAvailable: () => {},
    exchange,
    fsync: () => {},
    close: () => {},
  };
}

// Dry-run JSON has an exact token/policy/plan, writes nothing, and exits 0.
{
  const stdout = sink();
  const stderr = sink();
  const before = fs.readFileSync(configPath, "utf8");
  const exitCode = runResourcesCommand(["configure", "--policy-file", policyPath, "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  const result = JSON.parse(stdout.value());
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(result.status, "proposal");
  assert.equal(result.action, "configure_runtime_resources");
  assert.match(result.acceptance.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);

  const appliedOut = sink();
  assert.equal(runResourcesCommand([
    "configure",
    "--json",
    "--apply",
    "--accept-sha256",
    result.acceptance.sha256,
    "--policy-file",
    policyPath,
  ], {
    stdout: appliedOut.stream,
    stderr: sink().stream,
    applyPolicy: (input) => applyPolicy(input, { configDirectoryHandleFactory: pathConfigDirectoryHandle }),
  }), 0);
  assert.equal(JSON.parse(appliedOut.value()).status, "applied");
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(written.preserved, "yes");
  assert.equal(written.runtime_resources.version, 1);
}

// Apply flags are deliberately unmistakable: token-without-apply, apply
// without-token, duplicate flags, relative source, and unknown flags fail.
for (const args of [
  ["configure", "--policy-file", policyPath, "--accept-sha256", "0".repeat(64)],
  ["configure", "--apply", "--policy-file", policyPath],
  ["configure", "--policy-file", policyPath, "--policy-file", policyPath],
  ["configure", "--policy-file", "relative.json"],
  ["temp-install", "--unknown"],
]) {
  const stdout = sink();
  const stderr = sink();
  const exitCode = runResourcesCommand(args, { stdout: stdout.stream, stderr: stderr.stream });
  if (args.includes("relative.json")) {
    assert.equal(exitCode, 1);
    assert.equal(stdout.value(), "");
    assert.equal(stderr.value(), "QuadWork resource operation refused: policy_file_not_absolute\n");
  } else {
    assert.equal(exitCode, 2);
    assert.match(stderr.value(), /^Usage: quadwork resources /);
  }
}

// Operational errors are stable typed refusals. JSON goes to stdout and never
// includes the underlying message, path, or host detail.
{
  const stdout = sink();
  const stderr = sink();
  const exitCode = runResourcesCommand(["temp-install", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    tempInstallProposal() {
      throw new ResourceInstallError("temp_root_low_capacity", "/secret/path token=do-not-leak");
    },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout.value()), {
    ok: false,
    status: "refused",
    reason: "temp_root_low_capacity",
  });
  assert.equal(stderr.value(), "");
  assert(!stdout.value().includes("secret"));
}

// Temp plan and apply dispatch preserve the exact accepted token and output
// contracts without adding a caller-controlled path.
{
  const token = "a".repeat(64);
  const proposalResult = Object.freeze({
    ok: true,
    status: "proposal",
    action: "ensure_resource_temp_root",
    acceptance: Object.freeze({ sha256: token }),
    plan: Object.freeze({ action: "ensure_resource_temp_root", cleanup_paths: Object.freeze([]) }),
  });
  const stdout = sink();
  assert.equal(runResourcesCommand(["temp-install"], {
    stdout: stdout.stream,
    stderr: sink().stream,
    tempInstallProposal: () => proposalResult,
  }), 0);
  assert.match(stdout.value(), /Status: PROPOSAL/);
  assert.match(stdout.value(), new RegExp(token));
  assert.match(stdout.value(), /No changes were made/);

  let accepted = null;
  const applyOut = sink();
  assert.equal(runResourcesCommand(["temp-install", "--apply", "--accept-sha256", token, "--json"], {
    stdout: applyOut.stream,
    stderr: sink().stream,
    applyTempInstall(input) {
      accepted = input;
      return { ...proposalResult, status: "applied" };
    },
  }), 0);
  assert.deepEqual(accepted, { acceptanceSha256: token });
  assert.equal(JSON.parse(applyOut.value()).status, "applied");
}

// The actual executable follows the same dry-run contract under an isolated
// HOME and leaves both config and temp-root state unchanged.
{
  const before = fs.readFileSync(configPath, "utf8");
  const child = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "quadwork.js"),
    "resources",
    "configure",
    "--policy-file",
    policyPath,
    "--json",
  ], {
    env: { ...process.env, HOME: tempHome },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, "proposal");
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
  assert.equal(fs.existsSync(path.join(configDir, "tmp")), false);
}

console.log("binResourceInstall.test.js: all assertions passed");
