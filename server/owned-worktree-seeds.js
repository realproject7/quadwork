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
  const worktree = directory(binding.worktree);
  const base = directory(binding.base);
  const common = directory(path.join(base, ".git"));
  const pointer = read(path.join(worktree, ".git")).content.toString("utf8");
  const match = /^gitdir: ([^\r\n]+)\n?$/.exec(pointer);
  if (!match) fail("linked worktree required");
  const admin = directory(path.resolve(worktree, match[1]));
  if (path.dirname(admin) !== path.join(common, "worktrees")) fail("foreign worktree administration directory");
  directory(path.dirname(admin));
  if (path.resolve(admin, read(path.join(admin, "commondir")).content.toString("utf8").trim()) !== common ||
      path.resolve(admin, read(path.join(admin, "gitdir")).content.toString("utf8").trim()) !== path.join(worktree, ".git")) {
    fail("worktree linkage changed");
  }
  if (!/^(head|re1|re2|dev)$/.test(binding.role) || typeof binding.repo !== "string") fail("invalid binding");
  return { admin, binding: { worktree, base, repo: binding.repo.toLowerCase(), role: binding.role } };
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
  try {
    const ctx = context(binding);
    return lines.some((line) => !proved(ctx, line.slice(3)));
  } catch { return true; }
}

function seedOwnedWorktreeFile(binding, name, content, { runGit, adoptExact = false } = {}) {
  const ctx = context(binding);
  const run = (args) => String(runGit(args)).trim();
  if (path.resolve(run(["rev-parse", "--show-toplevel"])) !== ctx.binding.worktree ||
      path.resolve(ctx.binding.worktree, run(["rev-parse", "--git-common-dir"])) !== path.join(ctx.binding.base, ".git") ||
      run(["branch", "--show-current"]) !== `worktree-${ctx.binding.role}`) fail("repository or role identity changed");
  const remote = run(["remote", "get-url", "origin"]);
  const repo = remote.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/)?.[1]?.toLowerCase();
  if (repo !== ctx.binding.repo) fail("repository origin changed");
  const receiptFile = receiptPath(ctx, name);
  const target = path.join(ctx.binding.worktree, name);
  // Tracked instructions belong to the repository, even if their text happens
  // to equal a shipped template. Never refresh or claim them.
  if (run(["ls-files", "--stage", "--", name])) return { skipped: "tracked" };
  const fresh = Buffer.from(content, "utf8");
  const present = exists(target);
  const hasReceipt = exists(receiptFile);
  if (hasReceipt) regular(receiptFile);
  let before;
  if (present) {
    before = read(target);
    if (!proved(ctx, name) && !(adoptExact && !hasReceipt && before.content.equals(fresh))) {
      fail(`${name} has foreign or modified content; preserved`);
    }
  }
  // Hold a no-follow descriptor and check identity before modifying an owned
  // file. Missing files use exclusive creation; no user file is removed.
  const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW |
    (present ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(target, flags, 0o600);
  let file;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (before && (before.ino !== stat.ino || before.dev !== stat.dev))) fail("file identity changed");
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, fresh);
    file = read(target);
    if (file.ino !== stat.ino || file.dev !== stat.dev || !file.content.equals(fresh)) fail("seed write could not be verified");
  } finally { fs.closeSync(fd); }
  const receipt = { version: 1, binding: ctx.binding, name, dev: file.dev, ino: file.ino, sha256: digest(fresh) };
  const temporary = `${receiptFile}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, receiptFile);
  } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
  return { written: true };
}

module.exports = { hasUnownedWorktreeChanges, seedOwnedWorktreeFile };
