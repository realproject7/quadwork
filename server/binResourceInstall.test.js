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
const {
  ResourceInstallError,
  policyProposal,
  applyPolicy,
  tempInstallProposal,
  applyTempInstall,
} = require("./resource-install");
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

// Source-owned recovery metadata is exposed as bounded exact basenames in JSON
// and human output. A public ResourceInstallError cannot mint those fields.
{
  const token = policyProposal(policyPath).acceptance.sha256;
  const probeEntries = [
    ".resource-exchange-probe-111111111111111111111111-a",
    ".resource-exchange-probe-111111111111111111111111-b",
  ];
  function failingHandle({ directory, fsImpl }) {
    return {
      ...pathConfigDirectoryHandle({ directory, fsImpl }),
      assertExchangeAvailable: () => probeEntries,
      exchange() { throw new Error("/secret/exchange token=do-not-leak"); },
    };
  }
  function applyWithFailure(input) {
    return applyPolicy(input, { configDirectoryHandleFactory: failingHandle });
  }
  const jsonOut = sink();
  assert.equal(runResourcesCommand([
    "configure", "--apply", "--policy-file", policyPath,
    "--accept-sha256", token, "--json",
  ], {
    stdout: jsonOut.stream,
    stderr: sink().stream,
    applyPolicy: applyWithFailure,
  }), 1);
  const failure = JSON.parse(jsonOut.value());
  assert.equal(failure.reason, "config_exchange_recovery_required");
  assert.deepEqual(failure.recovery_entries.slice(0, 2), probeEntries);
  assert.match(failure.recovery_entries[2], /^\.config\.json\.resource-install-\d+-[a-f0-9]{24}\.recovery$/);
  assert(!jsonOut.value().includes("secret"));

  const humanErr = sink();
  assert.equal(runResourcesCommand([
    "configure", "--apply", "--policy-file", policyPath,
    "--accept-sha256", token,
  ], {
    stdout: sink().stream,
    stderr: humanErr.stream,
    applyPolicy: applyWithFailure,
  }), 1);
  assert.match(humanErr.value(), /Recovery entries \(exact basenames; never use wildcards\):/);
  assert.match(humanErr.value(), new RegExp(probeEntries[0]));
  assert(!humanErr.value().includes("secret"));

  const untrustedOut = sink();
  assert.equal(runResourcesCommand(["temp-install", "--json"], {
    stdout: untrustedOut.stream,
    stderr: sink().stream,
    tempInstallProposal() {
      const error = new ResourceInstallError("temp_root_low_capacity", "safe");
      error.recovery_entries = ["secret-token"];
      error.recovery_scope = "operation_created_entry_unlocated";
      throw error;
    },
  }), 1);
  assert.equal(Object.hasOwn(JSON.parse(untrustedOut.value()), "recovery_entries"), false);
  assert.equal(Object.hasOwn(JSON.parse(untrustedOut.value()), "recovery_scope"), false);
  assert(!untrustedOut.value().includes("secret-token"));

  const diskStatfs = () => ({ type: 0xEF53n, bavail: 20_000n, bsize: 1024n * 1024n });
  const tempProposal = tempInstallProposal({ statfs: diskStatfs });
  const displaced = path.join(configDir, "cli-unlocated-created-root");
  const createMoveThenThrowFs = new Proxy(fs, {
    get(target, property) {
      if (property === "mkdirSync") return (targetPath, mkdirOptions) => {
        fs.mkdirSync(targetPath, mkdirOptions);
        fs.renameSync(targetPath, displaced);
        const error = new Error("PRIVATE moved root /private/temp");
        error.code = "EIO";
        throw error;
      };
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  let scopedError;
  try {
    applyTempInstall(
      { acceptanceSha256: tempProposal.acceptance.sha256 },
      {
        platform: "darwin",
        fsImpl: createMoveThenThrowFs,
        statfs: diskStatfs,
        rootHandleFactory() { throw new Error("must not reach"); },
      },
    );
  } catch (error) {
    scopedError = error;
  }
  assert(scopedError instanceof ResourceInstallError);
  assert.deepEqual(
    Reflect.ownKeys(scopedError).filter((key) => typeof key === "symbol"),
    [],
    "source-owned recovery attestation is not reflectable",
  );

  const scopedOut = sink();
  assert.equal(runResourcesCommand([
    "temp-install", "--apply", "--accept-sha256", tempProposal.acceptance.sha256, "--json",
  ], {
    stdout: scopedOut.stream,
    stderr: sink().stream,
    applyTempInstall() { throw scopedError; },
  }), 1);
  assert.deepEqual(JSON.parse(scopedOut.value()), {
    ok: false,
    status: "refused",
    reason: "temp_install_failed_cleanup_required",
    recovery_scope: "operation_created_entry_unlocated",
  });
  assert(!scopedOut.value().includes("PRIVATE"));

  const scopedHuman = sink();
  assert.equal(runResourcesCommand([
    "temp-install", "--apply", "--accept-sha256", tempProposal.acceptance.sha256,
  ], {
    stdout: sink().stream,
    stderr: scopedHuman.stream,
    applyTempInstall() { throw scopedError; },
  }), 1);
  assert.match(scopedHuman.value(), /Recovery scope: operation_created_entry_unlocated/);
  assert(!scopedHuman.value().includes("PRIVATE"));

  function assertUnattested(candidate, label) {
    const output = sink();
    assert.equal(runResourcesCommand(["temp-install", "--json"], {
      stdout: output.stream,
      stderr: sink().stream,
      tempInstallProposal() { throw candidate; },
    }), 1, label);
    assert.deepEqual(JSON.parse(output.value()), {
      ok: false,
      status: "refused",
      reason: "resource_operation_failed",
    }, label);
    assert(!output.value().includes("PRIVATE"), label);
  }

  const descriptorClone = Object.create(
    Object.getPrototypeOf(scopedError),
    Object.getOwnPropertyDescriptors(scopedError),
  );
  assertUnattested(descriptorClone, "descriptor clone");

  const clonedSymbolEntry = Symbol("resourceInstallRecoveryEntries");
  const clonedSymbolScope = Symbol("resourceInstallRecoveryScope");
  const forged = Object.create(ResourceInstallError.prototype, {
    code: { value: "temp_install_failed_cleanup_required", enumerable: true },
    [clonedSymbolEntry]: { value: ["PRIVATE-forged-entry"] },
    [clonedSymbolScope]: { value: "operation_created_entry_unlocated" },
  });
  assertUnattested(forged, "forged ResourceInstallError with cloned symbols");

  assertUnattested({
    name: "ResourceInstallError",
    code: "temp_install_failed_cleanup_required",
    recovery_entries: ["PRIVATE-lookalike"],
    recovery_scope: "operation_created_entry_unlocated",
  }, "lookalike");

  let proxyTrapCalls = 0;
  const proxied = new Proxy(scopedError, {
    get() { proxyTrapCalls += 1; throw new Error("PRIVATE proxy get"); },
    getPrototypeOf() { proxyTrapCalls += 1; throw new Error("PRIVATE proxy prototype"); },
    ownKeys() { proxyTrapCalls += 1; throw new Error("PRIVATE proxy keys"); },
  });
  assertUnattested(proxied, "proxied genuine error");
  assert.equal(proxyTrapCalls, 0);

  const revocable = Proxy.revocable(scopedError, {});
  revocable.revoke();
  assertUnattested(revocable.proxy, "revoked genuine-error proxy");
  fs.rmdirSync(displaced);
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
