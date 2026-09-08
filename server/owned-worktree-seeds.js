"use strict";

// Receipts live in this linked worktree's Git administration directory, never
// in the index, ignore rules, or candidate tree. Readers call this only after
// their existing repository/role checks; an unproved file remains dirty.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const NAMES = new Set(["AGENTS.md", "CLAUDE.md", "DESIGN-GUIDE.md"]);
const digest = (content) => crypto.createHash("sha256").update(content).digest("hex");

function fail(message) { throw new Error(`Owned worktree seed: ${message}`); }
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) fail("expected an unlinked regular file");
  return stat;
}
function read(file) {
  const before = regular(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 1024 * 1024) fail("file identity changed");
    const content = fs.readFileSync(fd);
    const after = regular(file);
    if (after.dev !== opened.dev || after.ino !== opened.ino) fail("file identity changed");
    return { content, dev: opened.dev, ino: opened.ino };
  } finally { fs.closeSync(fd); }
}
function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function directory(dir) {
  if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== path.resolve(dir)) fail("directory identity changed");
  return path.resolve(dir);
}
function context(binding) {
  const held = [];
  const hold = (dir) => {
    const before = fs.lstatSync(dir, { bigint: true });
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    held.push(fd);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isDirectory() || stat.dev !== before.dev || stat.ino !== before.ino) fail("directory identity changed");
    return { dev: String(stat.dev), ino: String(stat.ino) };
  };
  try {
    const worktree = directory(binding.worktree);
    const worktreeIdentity = hold(worktree);
    const base = directory(binding.base);
    const common = directory(path.join(base, ".git"));
    const pointer = read(path.join(worktree, ".git")).content.toString("utf8");
    const match = /^gitdir: ([^\r\n]+)\n?$/.exec(pointer);
    if (!match) fail("linked worktree required");
    const admin = directory(path.resolve(worktree, match[1]));
    const adminIdentity = hold(admin);
    if (path.dirname(admin) !== path.join(common, "worktrees")) fail("foreign worktree administration directory");
    directory(path.dirname(admin));
    if (path.resolve(admin, read(path.join(admin, "commondir")).content.toString("utf8").trim()) !== common ||
        path.resolve(admin, read(path.join(admin, "gitdir")).content.toString("utf8").trim()) !== path.join(worktree, ".git")) {
      fail("worktree linkage changed");
    }
    if (!/^(head|re1|re2|dev)$/.test(binding.role) || typeof binding.repo !== "string") fail("invalid binding");
    return { admin, worktreeIdentity, adminIdentity,
      binding: { worktree, base, repo: binding.repo.toLowerCase(), role: binding.role },
      close: () => held.splice(0).forEach((fd) => fs.closeSync(fd)) };
  } catch (error) { held.forEach((fd) => fs.closeSync(fd)); throw error; }
}
function receiptPath(ctx, name) {
  if (!NAMES.has(name)) fail("unsupported seed");
  return path.join(ctx.admin, `quadwork-owned-seed-${name}.json`);
}
function proved(ctx, name) {
  try {
    const receipt = JSON.parse(read(receiptPath(ctx, name)).content.toString("utf8"));
    const file = read(path.join(ctx.binding.worktree, name));
    return receipt.version === 1 && receipt.name === name &&
      JSON.stringify(receipt.binding) === JSON.stringify(ctx.binding) &&
      receipt.dev === file.dev && receipt.ino === file.ino && receipt.sha256 === digest(file.content);
  } catch { return false; }
}

function hasUnownedWorktreeChanges(status, binding) {
  if (!status.trim()) return false;
  const lines = status.trim().split("\n");
  // Never reinterpret quoted names, tracked changes, renames, or directories.
  if (lines.some((line) => !/^\?\? (AGENTS\.md|CLAUDE\.md|DESIGN-GUIDE\.md)$/.test(line))) return true;
  let ctx;
  try {
    ctx = context(binding);
    return lines.some((line) => !proved(ctx, line.slice(3)));
  } catch { return true; }
  finally { ctx?.close(); }
}

function seedOwnedWorktreeFile(binding, name, content, { runGit, adoptExact = false } = {}) {
  const ctx = context(binding);
  try {
    const run = (args) => String(runGit(args)).trim();
    if (path.resolve(run(["rev-parse", "--show-toplevel"])) !== ctx.binding.worktree ||
        path.resolve(ctx.binding.worktree, run(["rev-parse", "--git-common-dir"])) !== path.join(ctx.binding.base, ".git") ||
        run(["branch", "--show-current"]) !== `worktree-${ctx.binding.role}`) fail("repository or role identity changed");
    const remote = run(["remote", "get-url", "origin"]);
    const repo = remote.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/)?.[1]?.toLowerCase();
    if (repo !== ctx.binding.repo) fail("repository origin changed");
    receiptPath(ctx, name); // fixed seed-name allowlist
    if (run(["ls-files", "--stage", "--", name])) return { skipped: "tracked" };
    if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) fail("invalid seed content");
    // Keep both directory descriptors open until the child exits: their
    // inodes cannot be recycled while the child compares its kernel cwd.
    // No descriptor forwarding/systemd changes or new worker are required.
    const { getSharedResourceRuntimeOwner } = require("./resource-runtime-owner");
    const input = JSON.stringify({
      admin: ctx.admin, binding: ctx.binding, worktreeIdentity: ctx.worktreeIdentity,
      adminIdentity: ctx.adminIdentity, name, content, adoptExact,
    });
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) fail("seed request too large");
    getSharedResourceRuntimeOwner().runControlChildSync(process.execPath, [__filename], {
      cwd: ctx.binding.worktree, input, encoding: "utf8", stdio: "pipe", timeout: 10000, maxBuffer: 4096,
    });
    // This is a success-report check, not the race defense. Every child write
    // was relative to a pinned kernel cwd, even if a parent path moved.
    for (const [dir, expected] of [[ctx.binding.worktree, ctx.worktreeIdentity], [ctx.admin, ctx.adminIdentity]]) {
      directory(dir);
      const actual = fs.statSync(dir, { bigint: true });
      if (String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino) fail("directory changed during seed write");
    }
    if (!proved(ctx, name)) fail("seed receipt could not be verified");
    return { written: true };
  } finally { ctx.close(); }
}

// One-shot source-owned control child. A process cwd is a kernel directory
// reference: renaming any ancestor after chdir cannot redirect a basename
// open/rename. A swap before chdir is rejected by the retained inode proof.
function writeFromPinnedDirectories(input) {
  const { binding, name, content, admin, worktreeIdentity, adminIdentity, adoptExact } = input;
  if (!NAMES.has(name) || typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) fail("invalid seed request");
  const assertCwd = (expected) => {
    const actual = fs.statSync(".", { bigint: true });
    if (!actual.isDirectory() || String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino) fail("pinned directory identity changed");
  };
  const enter = (dir, expected) => { process.chdir(dir); assertCwd(expected); };
  assertCwd(worktreeIdentity);
  enter(admin, adminIdentity);
  const receiptName = `quadwork-owned-seed-${name}.json`;
  const hasReceipt = exists(receiptName);
  const receipt = hasReceipt ? JSON.parse(read(receiptName).content.toString("utf8")) : null;
  enter(binding.worktree, worktreeIdentity);
  const fresh = Buffer.from(content, "utf8");
  const present = exists(name);
  const before = present ? read(name) : null;
  if (before) {
    const owned = receipt?.version === 1 && receipt.name === name &&
      JSON.stringify(receipt.binding) === JSON.stringify(binding) && receipt.dev === before.dev &&
      receipt.ino === before.ino && receipt.sha256 === digest(before.content);
    if (!owned && !(adoptExact === true && !hasReceipt && before.content.equals(fresh))) {
      fail(`${name} has foreign or modified content; preserved`);
    }
  }
  const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW |
    (present ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(name, flags, 0o600);
  let file;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (before && (before.ino !== stat.ino || before.dev !== stat.dev ||
        !fs.readFileSync(fd).equals(before.content)))) fail("file identity or content changed");
    fs.ftruncateSync(fd, 0);
    for (let offset = 0; offset < fresh.length;) {
      const count = fs.writeSync(fd, fresh, offset, fresh.length - offset, offset);
      if (count === 0) fail("seed write stopped before completion");
      offset += count;
    }
    file = read(name);
    if (file.ino !== stat.ino || file.dev !== stat.dev || !file.content.equals(fresh)) fail("seed write could not be verified");
  } finally { fs.closeSync(fd); }
  enter(admin, adminIdentity);
  // All receipt operations also use basenames in the pinned admin cwd.
  if (exists(receiptName)) regular(receiptName);
  const next = { version: 1, binding, name, dev: file.dev, ino: file.ino, sha256: digest(fresh) };
  const temporary = `${receiptName}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, receiptName);
  } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) fail("unexpected writer arguments");
    const parts = [], chunk = Buffer.alloc(64 * 1024);
    let size = 0, count;
    while ((count = fs.readSync(0, chunk, 0, chunk.length, null)) > 0) {
      size += count;
      if (size > 2 * 1024 * 1024) fail("seed request too large");
      parts.push(Buffer.from(chunk.subarray(0, count)));
    }
    writeFromPinnedDirectories(JSON.parse(Buffer.concat(parts).toString("utf8")));
    process.stdout.write("ok\n");
  } catch (error) {
    process.stderr.write(`Owned worktree seed writer failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { hasUnownedWorktreeChanges, seedOwnedWorktreeFile };
