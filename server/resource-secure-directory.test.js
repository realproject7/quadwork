"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SecureResourceDirectoryError,
  createLinuxSecureDirectoryHandle,
} = require("./resource-secure-directory");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-secure-directory-")));
fs.chmodSync(root, 0o700);
process.on("exit", () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

// Unit tests run on every developer platform. This adapter maps only the
// descriptor path exposed to the source-owned Linux handle back to this test's
// already accepted directory; production never receives this adapter.
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
      if (["openSync", "statSync", "lstatSync"].includes(property)) {
        return (value, ...args) => fs[property](mapped(value), ...args);
      }
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

function privateFile(name, bytes) {
  const target = path.join(root, name);
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return fs.lstatSync(target);
}

function helperThatCommits(calls) {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(command, "/usr/bin/python3");
    assert.equal(args[0], "-I");
    assert.equal(path.basename(args[1]), "resource-rename-exchange-helper.py");
    assert.equal(args[3], "3");
    assert.equal(options.shell, false);
    assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" });
    assert.equal(options.stdio[3] >= 0, true);
    if (args[2] === "available") {
      assert.equal(args.length, 6);
      return "";
    }
    assert.equal(args.length, 11);
    const source = path.join(root, args[4]);
    const destination = path.join(root, args[5]);
    const sourceStat = fs.lstatSync(source);
    assert.deepEqual(args.slice(6, 8), [String(sourceStat.dev), String(sourceStat.ino)]);
    assert.equal(args[10], String(process.getuid()));
    if (args[2] === "noreplace") {
      assert.deepEqual(args.slice(8, 10), ["0", "0"]);
      assert.equal(fs.existsSync(destination), false);
      fs.renameSync(source, destination);
      return "";
    }
    assert.equal(args[2], "exchange");
    const destinationStat = fs.lstatSync(destination);
    assert.deepEqual(args.slice(8, 10), [String(destinationStat.dev), String(destinationStat.ino)]);
    const hold = path.join(root, ".secure-directory-test-hold");
    fs.renameSync(source, hold);
    fs.renameSync(destination, source);
    fs.renameSync(hold, destination);
    return "";
  };
}

// Both commit forms carry exact dev/inode/uid authority through fixed argv.
// No shell, inherited environment, or pathname outside the pinned directory is
// available to the helper.
{
  const calls = [];
  const handle = createLinuxSecureDirectoryHandle({
    directory: root,
    directoryIdentity: fs.lstatSync(root),
    fsImpl: procFdFsAdapter(root),
    execFileSyncImpl: helperThatCommits(calls),
    platform: "linux",
  });
  handle.assertAvailable();
  const first = privateFile(".resource-state.json.previous", "first\n");
  handle.commit({
    mode: "noreplace",
    source: ".resource-state.json.previous",
    destination: "resource-state.json",
    sourceIdentity: first,
    expectedUid: process.getuid(),
  });
  assert.equal(fs.readFileSync(path.join(root, "resource-state.json"), "utf8"), "first\n");

  const second = privateFile(".resource-state.json.previous", "second\n");
  const current = fs.lstatSync(path.join(root, "resource-state.json"));
  handle.commit({
    mode: "exchange",
    source: ".resource-state.json.previous",
    destination: "resource-state.json",
    sourceIdentity: second,
    destinationIdentity: current,
    expectedUid: process.getuid(),
  });
  assert.equal(fs.readFileSync(path.join(root, "resource-state.json"), "utf8"), "second\n");
  assert.equal(fs.readFileSync(path.join(root, ".resource-state.json.previous"), "utf8"), "first\n");
  assert.deepEqual(calls.map((call) => call.args[2]), ["available", "noreplace", "exchange"]);
  handle.close();
}

// Helper refusal and post-commit ambiguity are typed and never trigger a
// pathname cleanup. The exact current and recovery entries remain untouched.
{
  const adapter = procFdFsAdapter(root);
  const unavailable = createLinuxSecureDirectoryHandle({
    directory: root,
    directoryIdentity: fs.lstatSync(root),
    fsImpl: adapter,
    execFileSyncImpl() {
      const error = new Error("PRIVATE helper path");
      error.status = 64;
      throw error;
    },
    platform: "linux",
  });
  assert.throws(
    () => unavailable.assertAvailable(),
    (error) => error instanceof SecureResourceDirectoryError
      && error.code === "rename_unavailable"
      && !error.message.includes("PRIVATE"),
  );
  unavailable.close();

  const beforeCurrent = fs.readFileSync(path.join(root, "resource-state.json"), "utf8");
  const beforePrevious = fs.readFileSync(path.join(root, ".resource-state.json.previous"), "utf8");
  const recovery = createLinuxSecureDirectoryHandle({
    directory: root,
    directoryIdentity: fs.lstatSync(root),
    fsImpl: adapter,
    execFileSyncImpl() {
      const error = new Error("PRIVATE ambiguous receipt");
      error.status = 67;
      throw error;
    },
    platform: "linux",
  });
  assert.throws(
    () => recovery.commit({
      mode: "exchange",
      source: ".resource-state.json.previous",
      destination: "resource-state.json",
      sourceIdentity: fs.lstatSync(path.join(root, ".resource-state.json.previous")),
      destinationIdentity: fs.lstatSync(path.join(root, "resource-state.json")),
      expectedUid: process.getuid(),
    }),
    (error) => error instanceof SecureResourceDirectoryError
      && error.code === "recovery_required"
      && error.recoveryEntries.length === 2
      && !error.message.includes("PRIVATE"),
  );
  assert.equal(fs.readFileSync(path.join(root, "resource-state.json"), "utf8"), beforeCurrent);
  assert.equal(fs.readFileSync(path.join(root, ".resource-state.json.previous"), "utf8"), beforePrevious);
  recovery.close();
}

// Basename validation runs before helper invocation.
{
  let helperCalls = 0;
  const handle = createLinuxSecureDirectoryHandle({
    directory: root,
    directoryIdentity: fs.lstatSync(root),
    fsImpl: procFdFsAdapter(root),
    execFileSyncImpl() { helperCalls += 1; },
    platform: "linux",
  });
  for (const invalid of ["../outside", "/absolute", "nested/name", ".", "..", "nul\0name"] ) {
    assert.throws(() => handle.path(invalid), (error) => error.code === "entry_invalid");
  }
  assert.equal(helperCalls, 0);
  handle.close();
}

console.log("resource-secure-directory.test.js: all assertions passed");
