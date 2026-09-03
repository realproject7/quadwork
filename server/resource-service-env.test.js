"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-service-env-")));
process.on("exit", () => {
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
});

const {
  configureServiceTempEnvironment,
  getLastServiceTempFact,
} = require("./resource-service-env");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");

const configPath = path.join(tempHome, "config.json");
const root = path.join(tempHome, "runtime-tmp");
const currentUid = typeof process.getuid === "function" ? process.getuid() : 1000;
const diskStatfs = () => ({ type: 0xEF53n, bavail: 20_000n, bsize: 1024n * 1024n });
const rootHandleFactory = () => ({ close() {} });

function writeConfig(runtimeResources = DEFAULT_RUNTIME_RESOURCE_PROPOSAL) {
  fs.writeFileSync(configPath, JSON.stringify({
    runtime_resources: runtimeResources && {
      ...runtimeResources,
      temp_root: root,
      api: { ...runtimeResources.api },
      worker: { ...runtimeResources.worker },
      control: { ...runtimeResources.control },
    },
  }));
}

function call(overrides = {}) {
  return configureServiceTempEnvironment({
    platform: "linux",
    env: {},
    fsImpl: fs,
    configPath,
    statfs: diskStatfs,
    rootHandleFactory,
    expectedUid: currentUid,
    ...overrides,
  });
}

// A genuinely installed exact root is re-verified read-only and becomes the
// process environment inherited by the server and its descendants. This fact
// explicitly is not containment-ready evidence.
fs.mkdirSync(root, { mode: 0o700 });
fs.chmodSync(root, 0o700);
writeConfig();
{
  const env = { TMPDIR: "/untrusted/inherited" };
  const fact = call({ env });
  assert.deepEqual(fact, {
    version: 1,
    status: "ready",
    reason: "service_temp_ready",
    code: "ready",
    tmpdir_applied: true,
    inherited_tmpdir_cleared: false,
    canonical_root: root,
    disk_backed: true,
    containment_ready: false,
    evidence: "service_temp_environment_only",
  });
  assert.equal(env.TMPDIR, root);
  assert.equal(getLastServiceTempFact(), fact);
  assert.equal(Object.isFrozen(fact), true);
}

// The production verifier performs no mkdir/chmod/write/rename/remove/cleanup.
// Every filesystem mutation seam fails the test if startup touches it.
{
  let mutationCalls = 0;
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (["mkdirSync", "chmodSync", "writeFileSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync"].includes(property)) {
        return () => { mutationCalls += 1; throw new Error("startup mutation forbidden"); };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = {};
  const fact = call({ env, fsImpl: guardedFs });
  assert.equal(fact.status, "ready");
  assert.equal(env.TMPDIR, root);
  assert.equal(mutationCalls, 0);
}

// Missing/invalid policy and every unsafe root state are warning facts, never
// startup exceptions. Linux clears an inherited unverified TMPDIR so children
// cannot mistake a wrapper value for accepted service-temp evidence.
{
  fs.unlinkSync(configPath);
  const missingEnv = { TMPDIR: "/untrusted/inherited" };
  const missing = call({ env: missingEnv });
  assert.equal(missing.code, "policy_absent");
  assert.equal(missing.containment_ready, false);
  assert.equal(missing.inherited_tmpdir_cleared, true);
  assert.equal(Object.hasOwn(missingEnv, "TMPDIR"), false);

  fs.writeFileSync(configPath, "{");
  assert.equal(call().code, "policy_unreadable");

  writeConfig();
  fs.chmodSync(root, 0o755);
  assert.equal(call().code, "root_mode_unsafe");
  fs.chmodSync(root, 0o700);
  assert.equal(call({ statfs: () => ({ type: 0x01021994n, bavail: 20_000n, bsize: 1024n * 1024n }) }).code, "root_is_memory_backed");
  assert.equal(call({ statfs: () => ({ type: 0xEF53n, bavail: 1n, bsize: 1024n }) }).code, "insufficient_free_space");

  fs.rmdirSync(root);
  assert.equal(call().code, "root_missing");
}

// Darwin is deliberately unsupported for this Linux service contract. Its
// launchd TMPDIR is preserved and neither config nor filesystem is inspected.
{
  let fsReads = 0;
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (["readFileSync", "lstatSync", "realpathSync", "statfsSync"].includes(property)) {
        return () => { fsReads += 1; throw new Error("Darwin inspection forbidden"); };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = { TMPDIR: "/private/var/folders/launchd" };
  const fact = configureServiceTempEnvironment({
    platform: "darwin",
    env,
    fsImpl: guardedFs,
    configPath,
    expectedUid: currentUid,
  });
  assert.equal(fact.code, "platform_unsupported");
  assert.equal(fact.containment_ready, false);
  assert.equal(env.TMPDIR, "/private/var/folders/launchd");
  assert.equal(fsReads, 0);
}

// The activation call is textually before legacy config migration and before
// the server module load that starts API/control and agent descendants.
{
  const cli = fs.readFileSync(path.join(__dirname, "..", "bin", "quadwork.js"), "utf8");
  const start = cli.slice(cli.indexOf("async function cmdStart()"), cli.indexOf("// ─── Stop Command"));
  const activateAt = start.indexOf("configureServiceTempEnvironment()");
  const configAt = start.indexOf("readConfig()");
  const serverAt = start.indexOf('require(path.join(serverDir, "index.js"))');
  assert(activateAt >= 0 && activateAt < configAt && configAt < serverAt);
  assert.match(start, /containment_ready=false/);
}

console.log("resource-service-env.test.js: all assertions passed");
