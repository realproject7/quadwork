"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  TMPFS_MAGIC,
  inspectTempRoot,
  ensureTempRoot,
  createGenerationTemp,
  reclaimGenerationTemp,
  sweepStaleGenerationTemps,
  removeConfinedPath,
} = require("./resource-temp");

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const DISK = { type: 0xEF53n, bavail: 10_000n, bsize: 4096n };
const diskStatfs = () => DISK;

// Portable fixture implementation of the descriptor-relative seam. Production
// uses the Linux proc-fd provider; tests inject this narrow directory adapter
// because macOS /dev/fd directory descriptors cannot be traversed as paths.
function pathRootHandle(root, fsImpl) {
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

function fixtureRootHandleFactory({ root, fsImpl }) {
  return pathRootHandle(root, fsImpl);
}

function fixture(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-"));
  const root = path.join(base, "configured", "temp");
  const facts = ensureTempRoot({
    tempRoot: root,
    statfs: options.statfs || diskStatfs,
    fsImpl: options.fsImpl,
    minimumFreeBytes: options.minimumFreeBytes,
    rootHandleFactory: options.rootHandleFactory || fixtureRootHandleFactory,
  });
  return { base, root, facts };
}

function stamp(target, hoursOld) {
  const time = new Date(NOW - hoursOld * HOUR);
  fs.utimesSync(target, time, time);
}

// Explicit legacy quarantine names are authority-bearing cleanup paths. Reject
// every non-basename or unsupported grammar before rename/rm can mutate either
// the original entry or an outside victim. Generated names use the same guard.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-quarantine-name-"));
  const root = path.join(base, "owned-root");
  const original = path.join(root, "owned-entry");
  const outside = path.join(base, "outside-victim");
  fs.mkdirSync(root);
  fs.writeFileSync(original, "owned");
  fs.writeFileSync(outside, "outside");

  for (const invalidName of [
    "../outside-victim",
    path.join(base, "absolute-victim"),
    "nested/quarantine",
    "nested\\quarantine",
    ".",
    "..",
    "quarantine\0name",
  ]) {
    assert.throws(
      () => removeConfinedPath(root, original, fs, invalidName),
      (err) => err.code === "invalid_quarantine_name",
      `invalid quarantine rejected: ${JSON.stringify(invalidName)}`,
    );
    assert.equal(fs.readFileSync(original, "utf8"), "owned", "invalid name leaves the original entry untouched");
    assert.equal(fs.readFileSync(outside, "utf8"), "outside", "invalid name leaves the outside victim untouched");
  }

  const gemini = "gemini-client-error-quadwork-quarantine-1234-0123456789abcdef0123456789abcdef.json";
  assert.equal(removeConfinedPath(root, original, fs, gemini), true, "supported internal Gemini quarantine is accepted");
  assert.ok(!fs.existsSync(original));

  const generatedSource = path.join(root, "generated-source");
  fs.writeFileSync(generatedSource, "owned");
  let generatedDestination = null;
  const observingFs = Object.create(fs);
  observingFs.renameSync = (from, to) => {
    generatedDestination = to;
    return fs.renameSync(from, to);
  };
  assert.equal(removeConfinedPath(root, generatedSource, observingFs), true);
  assert.equal(path.dirname(generatedDestination), root, "generated quarantine stays in the target directory");
  assert.match(path.basename(generatedDestination), /^\.quadwork-legacy-quarantine-[a-f0-9]{32}$/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  fs.rmSync(base, { recursive: true, force: true });
}

// Read-only facts fail closed for absence, tmpfs, and low capacity.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-facts-"));
  const missing = path.join(base, "missing");
  const before = fs.readdirSync(base);
  const absent = inspectTempRoot({ tempRoot: missing, statfs: diskStatfs });
  assert.equal(absent.reason, "temp_unavailable");
  assert.equal(absent.code, "root_missing");
  assert.deepEqual(fs.readdirSync(base), before, "inspection never creates the configured root");

  fs.mkdirSync(missing, { mode: 0o700 });
  const memoryBacked = inspectTempRoot({
    tempRoot: missing,
    statfs: () => ({ type: TMPFS_MAGIC, bavail: 10_000n, bsize: 4096n }),
  });
  assert.equal(memoryBacked.reason, "temp_unavailable");
  assert.equal(memoryBacked.code, "root_is_memory_backed");

  const lowSpace = inspectTempRoot({
    tempRoot: missing,
    statfs: () => ({ type: 0xEF53n, bavail: 1n, bsize: 4096n }),
    minimumFreeBytes: 8192,
  });
  assert.equal(lowSpace.reason, "temp_unavailable");
  assert.equal(lowSpace.code, "insufficient_free_space");
  assert.doesNotThrow(() => JSON.stringify(lowSpace), "resource facts remain API-serializable");

  if (process.platform !== "linux") {
    const unsupportedAnchor = inspectTempRoot({ tempRoot: missing, statfs: diskStatfs });
    assert.equal(unsupportedAnchor.code, "descriptor_anchor_unavailable", "no pathname mutation fallback on unsupported hosts");
  }

  const rootAlias = path.join(base, "root-alias");
  fs.symlinkSync(missing, rootAlias, "dir");
  const aliasedRoot = inspectTempRoot({ tempRoot: rootAlias, statfs: diskStatfs });
  assert.equal(aliasedRoot.code, "root_is_symlink", "the configured root itself cannot be an alias");
  fs.rmSync(base, { recursive: true, force: true });
}

// Explicit creation produces only a private direct child of the canonical root.
{
  const { base, facts } = fixture();
  const generation = createGenerationTemp({ facts, generationId: "project-a.17" });
  assert.equal(fs.statSync(generation.path).mode & 0o777, 0o700);
  assert.equal(path.dirname(fs.realpathSync(generation.path)), facts.canonicalRoot);
  assert.throws(
    () => createGenerationTemp({ facts, generationId: "../escape" }),
    (err) => err.reason === "temp_unavailable" && err.code === "invalid_generation_id",
  );
  assert.throws(
    () => createGenerationTemp({ facts: { ...facts }, generationId: "forged" }),
    (err) => err.code === "facts_untrusted",
    "a structurally identical plain object cannot authorize admission",
  );
  fs.rmSync(base, { recursive: true, force: true });
}

// A deterministic mkdir -> symlink swap is rejected before any chmod-like
// mutation can reach the external target.
{
  const hookedFs = Object.create(fs);
  let swapTarget = null;
  let displaced = null;
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-mkdir-race-"));
  fs.chmodSync(external, 0o755);
  const originalMode = fs.statSync(external).mode & 0o7777;
  hookedFs.mkdirSync = (target, options) => {
    const result = fs.mkdirSync(target, options);
    if (target === swapTarget) {
      fs.renameSync(target, displaced);
      fs.symlinkSync(external, target, "dir");
    }
    return result;
  };
  hookedFs.chmodSync = () => { throw new Error("resource-temp must never chmod after mkdir"); };

  const { base, facts } = fixture({ fsImpl: hookedFs });
  swapTarget = path.join(facts.canonicalRoot, "generation-mkdir-race");
  displaced = path.join(facts.canonicalRoot, "displaced-created-directory");
  assert.throws(
    () => createGenerationTemp({ facts, fsImpl: hookedFs, generationId: "mkdir-race" }),
    (err) => err.code === "generation_path_unsafe",
  );
  assert.equal(fs.statSync(external).mode & 0o7777, originalMode, "external target mode is unchanged");
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
}

// The root pathname can be replaced after the conceptual descriptor open. All
// mutation remains bound to the original inode, the new generation is rolled
// back, and the external replacement receives no persistent data.
{
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-root-swap-external-"));
  const survivor = path.join(external, "must-survive");
  fs.writeFileSync(survivor, "safe");
  let pinnedRoot = null;
  function swappingFactory({ root, fsImpl }) {
    pinnedRoot = `${root}-descriptor-pinned`;
    fs.renameSync(root, pinnedRoot);
    fs.symlinkSync(external, root, "dir");
    return pathRootHandle(pinnedRoot, fsImpl);
  }
  const { base, facts } = fixture({ rootHandleFactory: swappingFactory });
  assert.throws(
    () => createGenerationTemp({ facts, generationId: "root-swap" }),
    (err) => err.code === "root_identity_changed",
  );
  assert.equal(fs.readFileSync(survivor, "utf8"), "safe");
  assert.ok(!fs.existsSync(path.join(external, "generation-root-swap")), "replacement root was never mutated");
  assert.ok(!fs.existsSync(path.join(pinnedRoot, "generation-root-swap")), "failed admission rolled back via pinned root");
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
}

// Confirmed reclaim and stale sweep remain pinned to the original inode if the
// public root pathname is swapped between operations.
{
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-cleanup-root-swap-"));
  const survivor = path.join(external, "must-survive");
  fs.writeFileSync(survivor, "safe");
  let attack = false;
  let pinnedRoot = null;
  function switchableFactory({ root, fsImpl }) {
    if (attack && !pinnedRoot) {
      pinnedRoot = `${root}-descriptor-pinned`;
      fs.renameSync(root, pinnedRoot);
      fs.symlinkSync(external, root, "dir");
    }
    return pathRootHandle(pinnedRoot || root, fsImpl);
  }
  const { base, facts } = fixture({ rootHandleFactory: switchableFactory });
  const reclaim = createGenerationTemp({ facts, generationId: "reclaim-root-swap" });
  const stale = createGenerationTemp({ facts, generationId: "sweep-root-swap" });
  stamp(stale.path, 100);
  attack = true;
  assert.equal(reclaimGenerationTemp({
    facts,
    generationId: "reclaim-root-swap",
    confirmedProcessTreeExit: true,
  }).reclaimed, true);
  const swept = sweepStaleGenerationTemps({
    facts,
    now: NOW,
    maxAgeHours: 72,
    liveGenerationIds: [],
  });
  assert.ok(swept.removed.includes("sweep-root-swap"));
  assert.equal(fs.readFileSync(survivor, "utf8"), "safe");
  assert.deepEqual(fs.readdirSync(external), ["must-survive"], "replacement root receives no cleanup mutation");
  assert.ok(!fs.existsSync(path.join(pinnedRoot, "generation-reclaim-root-swap")));
  assert.ok(!fs.existsSync(path.join(pinnedRoot, "generation-sweep-root-swap")));
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
}

// Canonical identity handles an aliased parent (the macOS /var -> /private/var
// shape) while generation containment remains rooted in the real directory.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-alias-"));
  const actualParent = path.join(base, "actual-parent");
  const aliasParent = path.join(base, "alias-parent");
  fs.mkdirSync(actualParent);
  fs.symlinkSync(actualParent, aliasParent, "dir");
  const configuredViaAlias = path.join(aliasParent, "temp");
  const facts = ensureTempRoot({
    tempRoot: configuredViaAlias,
    statfs: diskStatfs,
    rootHandleFactory: fixtureRootHandleFactory,
  });
  assert.equal(facts.canonicalRoot, fs.realpathSync(path.join(actualParent, "temp")));
  const generation = createGenerationTemp({ facts, generationId: "alias-safe" });
  assert.equal(path.dirname(generation.path), facts.canonicalRoot);
  fs.rmSync(base, { recursive: true, force: true });
}

// A direct generation alias to an external directory is rejected on creation;
// confirmed cleanup unlinks a nested alias but never touches its target.
{
  const { base, facts } = fixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-external-"));
  const externalFile = path.join(external, "must-survive.txt");
  fs.writeFileSync(externalFile, "safe");
  const directAlias = path.join(facts.canonicalRoot, "generation-external");
  fs.symlinkSync(external, directAlias, "dir");
  assert.throws(
    () => createGenerationTemp({ facts, generationId: "external" }),
    (err) => err.code === "generation_path_unsafe",
  );
  fs.unlinkSync(directAlias);

  const generation = createGenerationTemp({ facts, generationId: "nested" });
  fs.symlinkSync(external, path.join(generation.path, "external-link"), "dir");
  fs.writeFileSync(path.join(generation.path, "owned.txt"), "owned");
  const notExited = reclaimGenerationTemp({
    facts,
    generationId: "nested",
    confirmedProcessTreeExit: false,
  });
  assert.equal(notExited.reclaimed, false);
  assert.ok(fs.existsSync(generation.path), "unconfirmed process-tree exit preserves the generation");

  const exited = reclaimGenerationTemp({
    facts,
    generationId: "nested",
    confirmedProcessTreeExit: true,
  });
  assert.equal(exited.reclaimed, true);
  assert.ok(!fs.existsSync(generation.path));
  assert.equal(fs.readFileSync(externalFile, "utf8"), "safe", "external symlink target survives cleanup");
  fs.rmSync(external, { recursive: true, force: true });
  fs.rmSync(base, { recursive: true, force: true });
}

// Admission revalidates the original root inode and permissions rather than
// trusting the previously returned fact object's visible fields.
{
  const { base, root, facts } = fixture();
  fs.chmodSync(root, 0o755);
  assert.throws(
    () => createGenerationTemp({ facts, generationId: "wrong-mode" }),
    (err) => err.code === "root_permissions_changed",
  );
  fs.chmodSync(root, 0o700);
  const oldRoot = `${root}-old`;
  fs.renameSync(root, oldRoot);
  fs.mkdirSync(root, { mode: 0o700 });
  assert.throws(
    () => createGenerationTemp({ facts, generationId: "new-inode" }),
    (err) => err.code === "root_identity_changed",
  );
  fs.rmSync(base, { recursive: true, force: true });
}

// Filesystem class is revalidated for admission and cleanup. Low free space
// blocks new admission but cannot prevent confirmed cleanup from freeing data.
{
  let type = 0xEF53n;
  let availableBlocks = 10_000n;
  const mutableStatfs = () => ({ type, bavail: availableBlocks, bsize: 4096n });
  const { base, facts } = fixture({ statfs: mutableStatfs, minimumFreeBytes: 8192 });
  const existing = createGenerationTemp({ facts, generationId: "existing" });

  type = TMPFS_MAGIC;
  assert.throws(
    () => createGenerationTemp({ facts, generationId: "wrong-filesystem" }),
    (err) => err.code === "root_filesystem_changed",
  );
  assert.throws(
    () => reclaimGenerationTemp({ facts, generationId: "existing", confirmedProcessTreeExit: true }),
    (err) => err.code === "root_filesystem_changed",
    "cleanup still requires the original safe filesystem class",
  );

  type = 0xEF53n;
  availableBlocks = 1n;
  assert.throws(
    () => createGenerationTemp({ facts, generationId: "low-space" }),
    (err) => err.code === "insufficient_free_space",
  );
  const cleanup = reclaimGenerationTemp({ facts, generationId: "existing", confirmedProcessTreeExit: true });
  assert.equal(cleanup.reclaimed, true, "confirmed cleanup proceeds while free space is low");
  assert.ok(!fs.existsSync(existing.path));
  fs.rmSync(base, { recursive: true, force: true });
}

// A changed uid from the same filesystem adapter is rejected independently of
// the immutable public facts.
{
  const hookedFs = Object.create(fs);
  let rootPath = null;
  let spoofUid = false;
  hookedFs.lstatSync = (target) => {
    const st = fs.lstatSync(target);
    if (!spoofUid || target !== rootPath) return st;
    return new Proxy(st, {
      get(object, property) {
        if (property === "uid") return Number(object.uid) + 1;
        const value = Reflect.get(object, property);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  };
  const { base, facts } = fixture({ fsImpl: hookedFs });
  rootPath = facts.canonicalRoot;
  spoofUid = true;
  assert.throws(
    () => createGenerationTemp({ facts, fsImpl: hookedFs, generationId: "wrong-owner" }),
    (err) => err.code === "root_permissions_changed",
  );
  fs.rmSync(base, { recursive: true, force: true });
}

// A failed post-detach disposal leaves an owner-qualified quarantine. A later
// authoritative sweep preserves it for a live generation, then retries it once
// the generation is non-live and stale.
{
  let failDisposal = true;
  function failingDisposerFactory({ root, fsImpl }) {
    const handle = pathRootHandle(root, fsImpl);
    return {
      ...handle,
      rm(name) {
        if (failDisposal && name.startsWith(".quadwork-generation-quarantine-")) {
          failDisposal = false;
          throw new Error("injected disposal failure");
        }
        return handle.rm(name);
      },
    };
  }
  const { base, facts } = fixture({ rootHandleFactory: failingDisposerFactory });
  const generation = createGenerationTemp({ facts, generationId: "orphan-retry" });
  assert.throws(
    () => reclaimGenerationTemp({ facts, generationId: "orphan-retry", confirmedProcessTreeExit: true }),
    (err) => err.code === "quarantine_pending",
  );
  assert.ok(!fs.existsSync(generation.path), "failed disposal is already detached from the active generation name");
  const quarantine = fs.readdirSync(facts.canonicalRoot)
    .find((name) => name.startsWith(".quadwork-generation-quarantine-orphan-retry-"));
  assert.ok(quarantine, "owner-qualified quarantine remains discoverable");
  stamp(path.join(facts.canonicalRoot, quarantine), 100);

  const stillLive = sweepStaleGenerationTemps({
    facts,
    now: NOW,
    maxAgeHours: 72,
    liveGenerationIds: ["orphan-retry"],
  });
  assert.deepEqual(stillLive.pendingQuarantines, ["orphan-retry"]);
  assert.ok(fs.existsSync(path.join(facts.canonicalRoot, quarantine)));

  const recovered = sweepStaleGenerationTemps({
    facts,
    now: NOW,
    maxAgeHours: 72,
    liveGenerationIds: [],
  });
  assert.deepEqual(recovered.recoveredQuarantines, ["orphan-retry"]);
  assert.ok(!fs.existsSync(path.join(facts.canonicalRoot, quarantine)));
  fs.rmSync(base, { recursive: true, force: true });
}

// Stale cleanup refuses to infer that no generations are live.
{
  const { base, facts } = fixture();
  const stale = createGenerationTemp({ facts, generationId: "needs-authority" });
  stamp(stale.path, 100);
  assert.throws(
    () => sweepStaleGenerationTemps({ facts, now: NOW, maxAgeHours: 72 }),
    (err) => err.code === "live_generation_set_required",
  );
  assert.throws(
    () => sweepStaleGenerationTemps({ facts, now: NOW, maxAgeHours: 72, liveGenerationIds: "none" }),
    (err) => err.code === "live_generation_set_required",
  );
  assert.throws(
    () => sweepStaleGenerationTemps({ facts, now: NOW, maxAgeHours: 72, liveGenerationIds: ["../invalid"] }),
    (err) => err.code === "invalid_generation_id",
  );
  assert.ok(fs.existsSync(stale.path), "invalid or absent authority causes no cleanup");
  const result = sweepStaleGenerationTemps({
    facts,
    now: NOW,
    maxAgeHours: 72,
    liveGenerationIds: new Set(),
  });
  assert.deepEqual(result.removed, ["needs-authority"]);
  fs.rmSync(base, { recursive: true, force: true });
}

// Deterministic target swap after stale lstat: quarantine moves and removes
// only the swapped alias. It never readdir/unlinks through the external target.
{
  const hookedFs = Object.create(fs);
  let watched = null;
  let displaced = null;
  let swapped = false;
  const readdirCalls = [];
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-delete-race-"));
  const survivor = path.join(external, "must-survive");
  fs.writeFileSync(survivor, "safe");
  hookedFs.lstatSync = (target) => {
    const st = fs.lstatSync(target);
    if (!swapped && target === watched) {
      swapped = true;
      fs.renameSync(target, displaced);
      fs.symlinkSync(external, target, "dir");
    }
    return st;
  };
  hookedFs.readdirSync = (target, options) => {
    readdirCalls.push(target);
    return fs.readdirSync(target, options);
  };
  const { base, facts } = fixture({ fsImpl: hookedFs });
  const stale = createGenerationTemp({ facts, fsImpl: hookedFs, generationId: "delete-race" });
  fs.writeFileSync(path.join(stale.path, "owned"), "x");
  stamp(stale.path, 100);
  watched = stale.path;
  displaced = path.join(facts.canonicalRoot, "attacker-displaced-original");

  const result = sweepStaleGenerationTemps({
    facts,
    fsImpl: hookedFs,
    now: NOW,
    maxAgeHours: 72,
    liveGenerationIds: [],
  });
  assert.ok(result.removed.includes("delete-race"));
  assert.equal(fs.readFileSync(survivor, "utf8"), "safe", "external target survives lstat/delete swap");
  assert.ok(fs.existsSync(displaced), "the swapped-out original was not reached through an alias");
  assert.deepEqual(readdirCalls, [facts.canonicalRoot], "cleanup never performs a custom walk beneath the root");
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
}

// Crash-leftover sweep is direct-root-only and excludes known-live generations.
{
  const { base, facts } = fixture();
  const stale = createGenerationTemp({ facts, generationId: "stale" });
  const live = createGenerationTemp({ facts, generationId: "live" });
  const fresh = createGenerationTemp({ facts, generationId: "fresh" });
  fs.writeFileSync(path.join(stale.path, "data"), "x");
  stamp(stale.path, 100);
  stamp(live.path, 100);
  stamp(fresh.path, 1);

  const unrelated = path.join(facts.canonicalRoot, "not-a-generation");
  fs.mkdirSync(unrelated);
  stamp(unrelated, 100);

  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-temp-stale-external-"));
  const survivor = path.join(external, "must-survive");
  fs.writeFileSync(survivor, "safe");
  fs.symlinkSync(external, path.join(facts.canonicalRoot, "generation-stale-alias"), "dir");

  const result = sweepStaleGenerationTemps({
    facts,
    now: NOW,
    maxAgeHours: 72,
    liveGenerationIds: ["live"],
  });
  assert.ok(result.removed.includes("stale"));
  assert.ok(result.removed.includes("stale-alias"), "stale alias entry itself is reclaimed");
  assert.ok(fs.existsSync(live.path), "known-live generation is excluded regardless of age");
  assert.ok(fs.existsSync(fresh.path), "fresh generation is kept");
  assert.ok(fs.existsSync(unrelated), "non-generation root data is outside sweep ownership");
  assert.equal(fs.readFileSync(survivor, "utf8"), "safe", "stale cleanup never follows an external alias");
  fs.rmSync(external, { recursive: true, force: true });
  fs.rmSync(base, { recursive: true, force: true });
}

console.log("resource-temp.test.js: all assertions passed");
