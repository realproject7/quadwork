"use strict";

// Deterministic scheduling seam in a private child preload. At the selected
// syscall boundary a separate same-UID Node process replaces the directory.
// The production writer receives only its normal fixed command/stdin input.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const restore = require("./__tests__/resource-executor-fixture").installResourceExecutorFixture();
const { seedOwnedWorktreeFile } = require("./owned-worktree-seeds");
const writer = require.resolve("./owned-worktree-seeds");
const originalExec = cp.execFileSync;
const originalOpen = fs.openSync;
const originalClose = fs.closeSync;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-seed-parent-race-")));
const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd, ...args) => originalExec("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const swapCode = "const fs=require('fs');const [from,parked,outside,marker]=process.argv.slice(1);fs.renameSync(from,parked);fs.symlinkSync(outside,from);fs.writeFileSync(marker,'swapped');";
const preload = path.join(root, "preload.cjs");
fs.writeFileSync(preload, `
if (process.argv[1] === ${JSON.stringify(writer)}) {
  const fs = require('fs'), cp = require('child_process');
  const proof = JSON.parse(process.env.QW_PRIVATE_SEED_RACE);
  let fired = false;
  const swap = () => {
    if (fired) return;
    fired = true;
    cp.execFileSync(process.execPath, ['-e', ${JSON.stringify(swapCode)}, proof.from, proof.parked, proof.outside, proof.marker], {env: {...process.env, NODE_OPTIONS: ''}});
  };
  const open = fs.openSync, chdir = process.chdir, write = fs.writeFileSync, rename = fs.renameSync;
  fs.openSync = function(file, flags, ...args) {
    if (proof.mode === 'seed-open' && file === 'AGENTS.md' && (flags & fs.constants.O_RDWR)) swap();
    if (proof.mode === 'receipt-read' && file === 'quadwork-owned-seed-AGENTS.md.json' && flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)) swap();
    return open.call(this, file, flags, ...args);
  };
  process.chdir = function(dir) { if (proof.mode === 'admin-enter' && dir === proof.from) swap(); return chdir.call(this, dir); };
  fs.writeFileSync = function(file, ...args) { if (proof.mode === 'receipt-create' && typeof file === 'string' && file.endsWith('.tmp')) swap(); return write.call(this, file, ...args); };
  fs.renameSync = function(from, to) { if (proof.mode === 'receipt-rename' && typeof from === 'string' && from.endsWith('.tmp')) swap(); return rename.call(this, from, to); };
}
`);
let selected = null;
const heldDirectories = new Set();
fs.openSync = function (file, flags, ...rest) {
  const fd = originalOpen.call(this, file, flags, ...rest);
  if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY)) heldDirectories.add(fd);
  return fd;
};
fs.closeSync = function (fd) { heldDirectories.delete(fd); return originalClose.call(this, fd); };
cp.execFileSync = function (file, args, options) {
  if (selected && file === process.execPath && args[0] === writer) {
    assert.equal(args.length, 1, "fixed source-owned command");
    assert.ok(Buffer.byteLength(options.input) < 1024 * 1024);
    assert.equal(options.timeout, 10000); assert.equal(options.maxBuffer, 4096);
    assert.equal(heldDirectories.size, 2, "parent retains both inodes for the entire child invocation");
    if (selected.mode === "before-cwd") {
      originalExec(process.execPath, ["-e", swapCode, selected.from, selected.parked, selected.outside, selected.marker], { env });
    }
    return originalExec(file, args, { ...options, env: { ...env, NODE_OPTIONS: `--require=${preload}`, QW_PRIVATE_SEED_RACE: JSON.stringify(selected) }, stdio: ["pipe", "pipe", "pipe"] });
  }
  return originalExec(file, args, options);
};
try {
  for (const [index, [mode, updating]] of [
    ["before-cwd", false], ["seed-open", false], ["seed-open", true],
    ["admin-enter", false], ["receipt-read", true],
    ["receipt-create", false], ["receipt-rename", true],
  ].entries()) {
    const directory = path.join(root, `case-${index}`); fs.mkdirSync(directory);
    const base = path.join(directory, "base"), worktree = path.join(directory, "dev");
    fs.mkdirSync(base); git(base, "init", "-b", "main");
    fs.writeFileSync(path.join(base, "README.md"), "fixture\n"); git(base, "add", "README.md");
    git(base, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
    git(base, "remote", "add", "origin", "https://github.com/acme/fixture.git");
    git(base, "worktree", "add", "-b", "worktree-dev", worktree, "HEAD");
    const binding = { base, worktree, repo: "acme/fixture", role: "dev" };
    const runGit = (args) => git(worktree, ...args);
    if (updating) assert.deepEqual(seedOwnedWorktreeFile(binding, "AGENTS.md", "original owned\n", { runGit }), { written: true });
    const admin = fs.readFileSync(path.join(worktree, ".git"), "utf8").trim().slice("gitdir: ".length);
    const from = ["before-cwd", "seed-open"].includes(mode) ? worktree : admin;
    const outside = path.join(directory, "outside"); fs.mkdirSync(outside);
    const externalSeed = path.join(outside, "AGENTS.md");
    if (updating) fs.writeFileSync(externalSeed, "outside seed sentinel\n");
    const externalReceipt = path.join(outside, "quadwork-owned-seed-AGENTS.md.json");
    fs.writeFileSync(externalReceipt, "outside receipt sentinel\n");
    selected = { mode, from, parked: `${from}-parked`, outside, marker: path.join(directory, "swapped") };
    assert.throws(() => seedOwnedWorktreeFile(binding, "AGENTS.md", "new owned\n", { runGit }), "a raced path is never reported as a successful activation seed");
    assert.equal(heldDirectories.size, 0, "all parent descriptors close on failure before fixture cleanup");
    assert.equal(fs.existsSync(selected.marker), true, "the actual separate-process directory swap occurred");
    assert.equal(fs.readFileSync(externalReceipt, "utf8"), "outside receipt sentinel\n");
    if (updating) assert.equal(fs.readFileSync(externalSeed, "utf8"), "outside seed sentinel\n");
    else assert.equal(fs.existsSync(externalSeed), false, "no external seed creation");
    assert.equal(fs.readdirSync(outside).some((name) => name.endsWith(".tmp")), false, "no external receipt temporary file");
    if (mode === "seed-open") assert.equal(fs.readFileSync(path.join(selected.parked, "AGENTS.md"), "utf8"), "new owned\n", "post-bind write stays in the original pinned directory");
    selected = null;
    console.log(`  PASS: ${mode} (${updating ? "update" : "create"}) preserves external files and closes parent descriptors`);
  }
  assert.equal(heldDirectories.size, 0);
  console.log("owned-worktree-seeds.parentSwap.test.js: PASS (7 real separate-process parent swaps)");
} finally {
  cp.execFileSync = originalExec; fs.openSync = originalOpen; fs.closeSync = originalClose;
  restore(); fs.rmSync(root, { recursive: true, force: true });
}
