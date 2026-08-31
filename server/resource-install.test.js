"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-install-")));
const originalHomedir = os.homedir;
os.homedir = () => tempHome;
process.on("exit", () => {
  os.homedir = originalHomedir;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
});

const {
  ResourceInstallError,
  policyProposal,
  applyPolicy,
  tempInstallProposal,
  applyTempInstall,
} = require("./resource-install");
const { DEFAULT_RUNTIME_RESOURCE_PROPOSAL } = require("./resource-policy");
const { TMPFS_MAGIC } = require("./resource-temp");

const configDir = path.join(tempHome, ".quadwork");
const configPath = path.join(configDir, "config.json");
const policyPath = path.join(tempHome, "resource-policy.json");
const diskStatfs = () => ({ type: 0xEF53n, bavail: 20_000n, bsize: 1024n * 1024n });

function policy(overrides = {}) {
  return {
    ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL,
    temp_root: path.join(configDir, "resource-tmp"),
    api: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.api },
    worker: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.worker },
    control: { ...DEFAULT_RUNTIME_RESOURCE_PROPOSAL.control },
    ...overrides,
  };
}

function writePrivate(file, value) {
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function reset(config = { port: 8400, projects: [{ id: "preserve-me" }], nested: { value: true } }, configuredPolicy = null) {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  const value = configuredPolicy ? { ...config, runtime_resources: configuredPolicy } : config;
  writePrivate(configPath, value);
  writePrivate(policyPath, policy());
}

function pathRootHandle({ root, fsImpl }) {
  return {
    stat: () => fsImpl.lstatSync(root),
    statfsPath: root,
    mkdir: (name, options) => fsImpl.mkdirSync(path.join(root, name), options),
    lstat: (name) => fsImpl.lstatSync(path.join(root, name)),
    readdir: () => fsImpl.readdirSync(root),
    rename: (from, to) => fsImpl.renameSync(path.join(root, from), path.join(root, to)),
    rm: (name) => fsImpl.rmSync(path.join(root, name), { recursive: true, force: true }),
    close: () => {},
  };
}

// Non-Linux unit-test seam. Production apply uses the Linux /proc/self/fd
// implementation; these ordinary-path operations are only used where no
// directory race is injected.
function pathConfigDirectoryHandle({ directory, fsImpl }) {
  const exchange = (from, to) => {
    const hold = `.resource-install-test-exchange-${process.pid}`;
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

// Exercise the production Linux handle on this non-Linux unit-test host by
// mapping only its /proc/self/fd/<dirfd> child paths back to the same directory.
function procFdFsAdapter(directory) {
  function mapped(value) {
    if (typeof value !== "string") return value;
    const match = value.match(/^\/proc\/self\/fd\/\d+(?:\/(.*))?$/);
    if (!match) return value;
    return match[1] ? path.join(directory, match[1]) : directory;
  }
  return new Proxy(fs, {
    get(target, property) {
      if (property === "realpathSync") return (value) => fs.realpathSync(mapped(value));
      if (property === "renameSync") return (from, to) => fs.renameSync(mapped(from), mapped(to));
      if (["openSync", "statSync", "lstatSync", "unlinkSync", "mkdirSync", "readdirSync", "rmdirSync", "rmSync"].includes(property)) {
        return (value, ...args) => fs[property](mapped(value), ...args);
      }
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

function code(expected) {
  return (err) => err instanceof ResourceInstallError && err.code === expected;
}

// Proposal validates and returns the exact strict policy and canonical token,
// but does not create config, temp paths, or temporary siblings.
reset();
{
  const configBefore = fs.readFileSync(configPath, "utf8");
  const proposal = policyProposal(policyPath);
  assert.equal(proposal.status, "proposal");
  assert.deepEqual(proposal.policy, policy());
  assert.match(proposal.acceptance.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(proposal.plan, {
    destination: "~/.quadwork/config.json#runtime_resources",
    preserves_other_config_fields: true,
    creates_missing_config: false,
    previous_config_recovery: "private_random_sibling",
  });
  assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
  assert.equal(fs.existsSync(policy().temp_root), false);
  assert.deepEqual(fs.readdirSync(configDir), ["config.json"]);
}

// Apply re-reads the policy, requires the exact token, and atomically changes
// only runtime_resources while preserving unrelated fields and mode 0600.
{
  const proposal = policyProposal(policyPath);
  const previous = fs.readFileSync(configPath, "utf8");
  const previousIdentity = fs.lstatSync(configPath);
  const helperCalls = [];
  function fakeExchangeHelper(command, args, options) {
    helperCalls.push({ command, args: [...args], options });
    assert.equal(command, "/usr/bin/python3");
    assert.equal(path.basename(args[0]), "resource-rename-exchange-helper.py");
    assert.equal(args[2], "3");
    assert.equal(options.shell, false);
    assert.equal(options.stdio[3] >= 0, true, "verified parent directory fd is inherited as child fd 3");
    if (args[1] === "probe") return "";
    assert.equal(args[1], "exchange");
    const hold = path.join(configDir, ".resource-install-helper-test-hold");
    fs.renameSync(path.join(configDir, args[3]), hold);
    fs.renameSync(path.join(configDir, args[4]), path.join(configDir, args[3]));
    fs.renameSync(hold, path.join(configDir, args[4]));
    return "";
  }
  const result = applyPolicy(
    { policyFile: policyPath, acceptanceSha256: proposal.acceptance.sha256 },
    {
      platform: "linux",
      fsImpl: procFdFsAdapter(configDir),
      execFileSyncImpl: fakeExchangeHelper,
    },
  );
  assert.deepEqual(helperCalls.map((call) => call.args[1]), ["probe", "exchange"]);
  assert.equal(result.status, "applied");
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(written.port, 8400);
  assert.deepEqual(written.projects, [{ id: "preserve-me" }]);
  assert.deepEqual(written.nested, { value: true });
  assert.deepEqual(written.runtime_resources, policy());
  assert.equal(fs.statSync(configPath).mode & 0o7777, 0o600);
  const recoveryEntry = result.result.previous_config_recovery_entry;
  assert.match(recoveryEntry, /^\.config\.json\.resource-install-\d+-[a-f0-9]{24}\.recovery$/);
  const recoveryPath = path.join(configDir, recoveryEntry);
  const recoveryIdentity = fs.lstatSync(recoveryPath);
  assert.equal(recoveryIdentity.dev, previousIdentity.dev);
  assert.equal(recoveryIdentity.ino, previousIdentity.ino);
  assert.equal(recoveryIdentity.mode & 0o7777, 0o600);
  assert.equal(fs.readFileSync(recoveryPath, "utf8"), previous);
}

// An unavailable Linux exchange primitive refuses before creating a candidate
// or changing config. A runtime exchange failure preserves the accepted config
// and the private candidate for explicit recovery.
reset();
{
  const token = policyProposal(policyPath).acceptance.sha256;
  const before = fs.readFileSync(configPath, "utf8");
  const unavailable = new Error("unavailable");
  unavailable.status = 64;
  assert.throws(
    () => applyPolicy(
      { policyFile: policyPath, acceptanceSha256: token },
      {
        platform: "linux",
        fsImpl: procFdFsAdapter(configDir),
        execFileSyncImpl() { throw unavailable; },
      },
    ),
    code("config_exchange_unavailable"),
  );
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
  assert.deepEqual(fs.readdirSync(configDir), ["config.json"]);

  let calls = 0;
  const failed = new Error("failed");
  failed.status = 65;
  assert.throws(
    () => applyPolicy(
      { policyFile: policyPath, acceptanceSha256: token },
      {
        platform: "linux",
        fsImpl: procFdFsAdapter(configDir),
        execFileSyncImpl(_command, args) {
          calls += 1;
          if (args[1] === "exchange") throw failed;
          return "";
        },
      },
    ),
    code("config_exchange_recovery_required"),
  );
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
  const recoveryEntries = fs.readdirSync(configDir).filter((name) => name.endsWith(".recovery"));
  assert.equal(recoveryEntries.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, recoveryEntries[0]), "utf8")).runtime_resources.version, 1);
}

// The policy and config inputs must not have another hardlink that can retain
// or mutate the accepted inode under an unverified name.
reset();
{
  const policyLink = path.join(tempHome, "resource-policy-hardlink.json");
  fs.linkSync(policyPath, policyLink);
  assert.throws(() => policyProposal(policyPath), code("policy_file_hardlink_unsafe"));
  fs.unlinkSync(policyLink);

  const token = policyProposal(policyPath).acceptance.sha256;
  const configLink = path.join(tempHome, "config-hardlink.json");
  fs.linkSync(configPath, configLink);
  assert.throws(
    () => applyPolicy(
      { policyFile: policyPath, acceptanceSha256: token },
      { configDirectoryHandleFactory: pathConfigDirectoryHandle },
    ),
    code("config_hardlink_unsafe"),
  );
  fs.unlinkSync(configLink);
}

// A final-path swap after the fresh config reread cannot redirect the anchored
// rename into an outside directory and cannot return a false applied result.
reset();
{
  const token = policyProposal(policyPath).acceptance.sha256;
  const movedDirectory = path.join(tempHome, "moved-config-directory");
  const outsideDirectory = path.join(tempHome, "outside-config-directory");
  let raced = false;
  function racingHandle({ directory, fsImpl }) {
    let anchoredDirectory = directory;
    return {
      stat: () => fsImpl.lstatSync(anchoredDirectory),
      path: (name) => path.join(anchoredDirectory, name),
      assertExchangeAvailable: () => {},
      exchange(from, to) {
        fsImpl.renameSync(directory, movedDirectory);
        fsImpl.mkdirSync(outsideDirectory, { mode: 0o700 });
        fsImpl.chmodSync(outsideDirectory, 0o700);
        writePrivate(path.join(outsideDirectory, "config.json"), { marker: "outside-victim" });
        fsImpl.symlinkSync(outsideDirectory, directory, "dir");
        anchoredDirectory = movedDirectory;
        const hold = path.join(anchoredDirectory, ".test-exchange-hold");
        fsImpl.renameSync(path.join(anchoredDirectory, from), hold);
        fsImpl.renameSync(path.join(anchoredDirectory, to), path.join(anchoredDirectory, from));
        fsImpl.renameSync(hold, path.join(anchoredDirectory, to));
        raced = true;
      },
      fsync: () => {},
      close: () => {},
    };
  }
  assert.throws(
    () => applyPolicy(
      { policyFile: policyPath, acceptanceSha256: token },
      { configDirectoryHandleFactory: racingHandle },
    ),
    code("config_exchange_recovery_required"),
  );
  assert.equal(raced, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outsideDirectory, "config.json"), "utf8")), {
    marker: "outside-victim",
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(movedDirectory, "config.json"), "utf8")).runtime_resources.version, 1);
  fs.unlinkSync(configDir);
  fs.rmSync(movedDirectory, { recursive: true, force: true });
  fs.rmSync(outsideDirectory, { recursive: true, force: true });
}

// The atomic exchange preserves a destination inode that appears after the
// accepted reread and refuses to report success. Both exchanged entries remain
// available for explicit recovery; no path-based cleanup follows the mismatch.
reset();
{
  const token = policyProposal(policyPath).acceptance.sha256;
  const victim = path.join(configDir, "preexisting-config-victim");
  const savedOriginal = path.join(configDir, "saved-original-config");
  writePrivate(victim, "VICTIM");
  const victimIdentity = fs.lstatSync(victim);
  let raced = false;
  function destinationRacingHandle({ directory, fsImpl }) {
    const base = pathConfigDirectoryHandle({ directory, fsImpl });
    return {
      ...base,
      exchange(from, to) {
        fsImpl.renameSync(path.join(directory, to), savedOriginal);
        fsImpl.renameSync(victim, path.join(directory, to));
        base.exchange(from, to);
        raced = true;
      },
    };
  }
  assert.throws(
    () => applyPolicy(
      { policyFile: policyPath, acceptanceSha256: token },
      { configDirectoryHandleFactory: destinationRacingHandle },
    ),
    code("config_exchange_recovery_required"),
  );
  assert.equal(raced, true);
  const entries = fs.readdirSync(configDir);
  const preservedVictim = entries.find((name) => {
    const stat = fs.lstatSync(path.join(configDir, name));
    return stat.dev === victimIdentity.dev && stat.ino === victimIdentity.ino;
  });
  assert.ok(preservedVictim, "unexpected destination inode remains recoverable");
  assert.equal(fs.readFileSync(path.join(configDir, preservedVictim), "utf8"), "VICTIM");
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).runtime_resources.version, 1);
  assert.equal(fs.existsSync(savedOriginal), true, "accepted original inode remains recoverable too");
}

// A source change makes the proposal stale; no config bytes are replaced.
reset();
{
  const token = policyProposal(policyPath).acceptance.sha256;
  writePrivate(policyPath, policy({ host_reserve_mib: 1600 }));
  const before = fs.readFileSync(configPath, "utf8");
  assert.throws(() => applyPolicy({ policyFile: policyPath, acceptanceSha256: token }), code("acceptance_mismatch"));
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
  assert.deepEqual(fs.readdirSync(configDir), ["config.json"]);
}

// Policy source and fixed destination reject aliases and unsafe permissions.
reset();
{
  fs.chmodSync(policyPath, 0o644);
  assert.throws(() => policyProposal(policyPath), code("policy_file_mode_unsafe"));
  fs.chmodSync(policyPath, 0o600);
  const alias = path.join(tempHome, "policy-alias.json");
  fs.symlinkSync(policyPath, alias);
  assert.throws(() => policyProposal(alias), code("policy_file_aliased"));
  fs.unlinkSync(alias);

  const token = policyProposal(policyPath).acceptance.sha256;
  fs.chmodSync(configPath, 0o644);
  assert.throws(
    () => applyPolicy({ policyFile: policyPath, acceptanceSha256: token }),
    code("config_mode_unsafe"),
  );
  fs.chmodSync(configPath, 0o600);
  fs.chmodSync(configDir, 0o755);
  assert.throws(
    () => applyPolicy({ policyFile: policyPath, acceptanceSha256: token }),
    code("config_directory_mode_unsafe"),
  );
  fs.chmodSync(configDir, 0o700);
  const aliasedFs = new Proxy(fs, {
    get(target, property) {
      if (property === "realpathSync") {
        return (value) => value === configDir ? `${configDir}-alias-target` : fs.realpathSync(value);
      }
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  assert.throws(
    () => applyPolicy(
      { policyFile: policyPath, acceptanceSha256: token },
      { fsImpl: aliasedFs, configDirectoryHandleFactory: pathConfigDirectoryHandle },
    ),
    code("config_directory_aliased"),
  );
}

// Missing config is never silently created by either proposal or apply.
reset();
{
  fs.unlinkSync(configPath);
  const token = policyProposal(policyPath).acceptance.sha256;
  assert.throws(() => applyPolicy({ policyFile: policyPath, acceptanceSha256: token }), code("config_missing"));
  assert.equal(fs.existsSync(configPath), false);
}

// Temp proposal derives an exact, bounded plan only from the already persisted
// policy and current read-only host facts. It does not create the target.
reset(undefined, policy());
{
  const configBefore = fs.readFileSync(configPath, "utf8");
  const proposal = tempInstallProposal({ statfs: diskStatfs });
  assert.equal(proposal.status, "proposal");
  assert.deepEqual(proposal.plan, {
    action: "ensure_resource_temp_root",
    version: 1,
    temp_root: policy().temp_root,
    mode: "0700",
    minimum_free_bytes: 4096 * 1024 * 1024,
    current_state: "create",
    cleanup_paths: [],
    failure_rollback: "none_preserve_created_root",
  });
  assert.match(proposal.acceptance.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(policy().temp_root), false);
  assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
}

// Mismatch, tmpfs, low capacity, and symlink refusals happen before mutation.
{
  const configBefore = fs.readFileSync(configPath, "utf8");
  assert.throws(
    () => applyTempInstall({ acceptanceSha256: "0".repeat(64) }, { statfs: diskStatfs, platform: "linux" }),
    code("acceptance_mismatch"),
  );
  assert.equal(fs.existsSync(policy().temp_root), false);
  assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);

  assert.throws(
    () => tempInstallProposal({ statfs: () => ({ type: TMPFS_MAGIC, bavail: 20_000n, bsize: 1024n * 1024n }) }),
    code("temp_root_memory_backed"),
  );
  assert.equal(fs.existsSync(policy().temp_root), false);
  assert.throws(
    () => tempInstallProposal({ statfs: () => ({ type: 0xEF53n, bavail: 1n, bsize: 1024n }) }),
    code("temp_root_low_capacity"),
  );
  assert.equal(fs.existsSync(policy().temp_root), false);

  const outside = fs.mkdtempSync(path.join(tempHome, "outside-temp-"));
  fs.symlinkSync(outside, policy().temp_root, "dir");
  assert.throws(() => tempInstallProposal({ statfs: diskStatfs }), code("temp_root_unsafe"));
  fs.unlinkSync(policy().temp_root);
  fs.rmSync(outside, { recursive: true, force: true });
}

// A post-acceptance installer failure performs no path-based deletion. The
// exact operation-created root remains available for explicit recovery.
{
  const proposal = tempInstallProposal({ statfs: diskStatfs });
  assert.throws(
    () => applyTempInstall(
      { acceptanceSha256: proposal.acceptance.sha256 },
      {
        statfs: diskStatfs,
        rootHandleFactory: pathRootHandle,
        ensureTempRoot() { throw new Error("injected verification failure"); },
      },
    ),
    code("temp_install_failed_cleanup_required"),
  );
  assert.equal(fs.existsSync(policy().temp_root), true, "failed install preserves its created root");
  assert.deepEqual(fs.readdirSync(policy().temp_root), []);
  fs.rmdirSync(policy().temp_root);
}

// A would-be quarantine-name replacement cannot authorize deletion because
// failure recovery creates no quarantine and calls no rmdir at all.
{
  const proposal = tempInstallProposal({ statfs: diskStatfs });
  const victim = path.join(configDir, "preexisting-empty-quarantine-victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  const victimIdentity = fs.lstatSync(victim);
  let quarantineCreateCalls = 0;
  let rmdirCalls = 0;
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (property === "mkdirSync") return (targetPath, options) => {
        if (path.basename(targetPath).startsWith(".quadwork-resource-install-rollback-")) {
          quarantineCreateCalls += 1;
        }
        return fs.mkdirSync(targetPath, options);
      };
      if (property === "rmdirSync") return (...args) => { rmdirCalls += 1; return fs.rmdirSync(...args); };
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  assert.throws(
    () => applyTempInstall(
      { acceptanceSha256: proposal.acceptance.sha256 },
      {
        platform: "darwin",
        fsImpl: guardedFs,
        statfs: diskStatfs,
        rootHandleFactory: pathRootHandle,
        ensureTempRoot() { throw new Error("force preserved recovery"); },
      },
    ),
    code("temp_install_failed_cleanup_required"),
  );
  const victimAfter = fs.lstatSync(victim);
  assert.equal(victimAfter.dev, victimIdentity.dev);
  assert.equal(victimAfter.ino, victimIdentity.ino);
  assert.equal(quarantineCreateCalls, 0);
  assert.equal(rmdirCalls, 0);
  assert.equal(fs.existsSync(policy().temp_root), true);
  fs.rmdirSync(policy().temp_root);
  fs.rmdirSync(victim);
}

// A host-state change also stales the token; the installer will not reinterpret
// an accepted create plan as an already-ready repair.
{
  const proposal = tempInstallProposal({ statfs: diskStatfs });
  fs.mkdirSync(policy().temp_root, { mode: 0o700 });
  assert.throws(
    () => applyTempInstall(
      { acceptanceSha256: proposal.acceptance.sha256 },
      { statfs: diskStatfs, rootHandleFactory: pathRootHandle },
    ),
    code("acceptance_mismatch"),
  );
  fs.rmSync(policy().temp_root, { recursive: true, force: true });
}

// Rollback is bound to the exact inode created by this apply. If an attacker
// swaps another empty owner-only directory into the accepted name, it remains
// untouched and the displaced transaction inode is reported for recovery.
{
  const proposal = tempInstallProposal({ statfs: diskStatfs });
  const victim = path.join(configDir, "preexisting-empty-victim");
  const displaced = path.join(configDir, "displaced-created-root");
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.chmodSync(victim, 0o700);
  const victimIdentity = fs.lstatSync(victim);
  assert.throws(
    () => applyTempInstall(
      { acceptanceSha256: proposal.acceptance.sha256 },
      {
        statfs: diskStatfs,
        rootHandleFactory: pathRootHandle,
        ensureTempRoot({ tempRoot }) {
          fs.renameSync(tempRoot, displaced);
          fs.renameSync(victim, tempRoot);
          throw new Error("injected root-name replacement");
        },
      },
    ),
    code("temp_install_failed_cleanup_required"),
  );
  const preserved = fs.lstatSync(policy().temp_root);
  assert.equal(preserved.dev, victimIdentity.dev);
  assert.equal(preserved.ino, victimIdentity.ino);
  assert.equal(fs.existsSync(displaced), true);
  fs.rmdirSync(policy().temp_root);
  fs.rmdirSync(displaced);
}

// Exact acceptance creates and verifies only the policy-owned root. The config
// remains byte-identical and no cleanup path is accepted or executed.
{
  const configBefore = fs.readFileSync(configPath, "utf8");
  const proposal = tempInstallProposal({ statfs: diskStatfs });
  const linuxFs = procFdFsAdapter(configDir);
  const result = applyTempInstall(
    { acceptanceSha256: proposal.acceptance.sha256 },
    {
      platform: "linux",
      fsImpl: linuxFs,
      statfs: diskStatfs,
      rootHandleFactory: pathRootHandle,
    },
  );
  assert.equal(result.status, "applied");
  assert.deepEqual(result.result, { ready: true, mode: "0700", disk_backed: true });
  assert.equal(fs.statSync(policy().temp_root).mode & 0o7777, 0o700);
  assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
  assert.deepEqual(fs.readdirSync(policy().temp_root), []);
}

console.log("resource-install.test.js: all assertions passed");
