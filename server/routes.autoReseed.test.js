// #856 tests for autoReseedOnStartup + the per-project state file.
//
// Layers covered:
//   - _loadReseedState / _saveReseedState round-trip + corruption tolerance.
//   - _readPackageVersion fallback on missing/malformed package.json.
//   - autoReseedOnStartup decision matrix with injected `getProgress` and
//     `performWrites`:
//       * project already at current version → skip (no write to state).
//       * project at older version, batch idle → reseed (state advanced).
//       * project at older version, batch active → defer (state UNCHANGED
//         so the next startup retries).
//       * project at older version, batch state unknown (null result OR
//         throw) → defer (fail-closed gate, state UNCHANGED).
//       * project with no working_dir → silently skipped.
//       * write throws → state UNCHANGED (so retry on next startup).
//       * deferred-then-resolved across two boots → second boot re-seeds
//         AND advances state for that project; already-current projects
//         from boot 1 remain skipped on boot 2.
//   - End-to-end with real `_performReseedWrites` against temp worktree
//     dirs — verifies the upgrade flow actually writes new templates AND
//     the resulting AGENTS.md has GITHUB.md discovery (the #856 user
//     observable: "existing upgraded users get GITHUB.md as primary").
//
// Plain node:assert script — auto-discovered by the #836 runner. Run
// directly with `node server/routes.autoReseed.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  autoReseedOnStartup,
  _loadReseedState,
  _saveReseedState,
  _readPackageVersion,
  _performReseedWrites,
} = require("./routes");

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qw-856-${label}-`));
}

function quietLog() {
  const lines = [];
  return { log: (m) => lines.push(m), lines };
}

(async () => {
  // ── State file: missing → empty default ──────────────────────────────────
  {
    const missing = path.join(tmp("state-missing"), "absent.json");
    assert.deepEqual(_loadReseedState(missing), { completedByProjectVersion: {} });
  }

  // ── State file: malformed JSON → empty default (don't crash boot) ────────
  {
    const dir = tmp("state-bad");
    const p = path.join(dir, "state.json");
    fs.writeFileSync(p, "not-json-at-all{");
    assert.deepEqual(_loadReseedState(p), { completedByProjectVersion: {} });
  }

  // ── State file: wrong-shape value (array, number, missing key) → empty ──
  {
    const dir = tmp("state-wrong");
    const p = path.join(dir, "state.json");
    fs.writeFileSync(p, JSON.stringify({ completedByProjectVersion: [1, 2, 3] }));
    assert.deepEqual(_loadReseedState(p), { completedByProjectVersion: {} });

    fs.writeFileSync(p, JSON.stringify({ somethingElse: { x: "y" } }));
    assert.deepEqual(_loadReseedState(p), { completedByProjectVersion: {} });

    // Non-string version values get stripped (defensive against a future
    // writer that puts numbers/objects in — never compares equal to a
    // package.json string).
    fs.writeFileSync(p, JSON.stringify({ completedByProjectVersion: { a: "1.0.0", b: 2, c: { v: "3" } } }));
    assert.deepEqual(_loadReseedState(p), { completedByProjectVersion: { a: "1.0.0" } });
  }

  // ── State file: round-trip ───────────────────────────────────────────────
  {
    const dir = tmp("state-roundtrip");
    const p = path.join(dir, "state.json");
    _saveReseedState({ completedByProjectVersion: { proj1: "2.1.0", proj2: "2.0.5" } }, p);
    assert.deepEqual(_loadReseedState(p), { completedByProjectVersion: { proj1: "2.1.0", proj2: "2.0.5" } });
  }

  // ── _readPackageVersion ──────────────────────────────────────────────────
  {
    const dir = tmp("pkg");
    // Missing → 0.0.0 fallback.
    assert.equal(_readPackageVersion(path.join(dir, "missing.json")), "0.0.0");
    // Malformed → 0.0.0.
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    assert.equal(_readPackageVersion(bad), "0.0.0");
    // Missing version field → 0.0.0.
    const noVer = path.join(dir, "no-ver.json");
    fs.writeFileSync(noVer, JSON.stringify({ name: "x" }));
    assert.equal(_readPackageVersion(noVer), "0.0.0");
    // Valid version → returned verbatim.
    const ok = path.join(dir, "ok.json");
    fs.writeFileSync(ok, JSON.stringify({ name: "x", version: "9.9.9" }));
    assert.equal(_readPackageVersion(ok), "9.9.9");
  }

  // ── Decision matrix with injected deps ───────────────────────────────────
  // Use a fake `performWrites` so we don't touch any real fs in this section
  // — we're testing the orchestration, not the write loop (which #845/#854/#855
  // already cover end-to-end).
  function makeRun(opts) {
    const dir = tmp("run");
    const statePath = path.join(dir, "state.json");
    if (opts.initialState) _saveReseedState(opts.initialState, statePath);
    const writes = [];
    const performWrites = opts.performWrites || ((project) => {
      writes.push(project.id);
      return { reseeded: [`head/AGENTS.md`], skipped: [], preserved: {} };
    });
    const getProgress = opts.getProgress || (async () => ({ items: [], complete: false }));
    const isActiveFromProgress = opts.isActiveFromProgress || ((p) => {
      if (!p) return null;
      if (!Array.isArray(p.items)) return null;
      return p.items.some((i) => i && i.status !== "merged" && i.status !== "closed");
    });
    const { log, lines } = quietLog();
    return {
      statePath, writes, log, lines,
      run: () => autoReseedOnStartup(opts.cfg, {
        version: opts.version,
        statePath, getProgress, isActiveFromProgress, performWrites, log,
      }),
    };
  }

  // 1. Already current — no performWrites call, no state mutation.
  {
    const cfg = { projects: [{ id: "p1", working_dir: "/tmp/p1" }] };
    const ctx = makeRun({
      cfg, version: "2.1.0",
      initialState: { completedByProjectVersion: { p1: "2.1.0" } },
    });
    const out = await ctx.run();
    assert.equal(out.decisions.length, 1);
    assert.deepEqual(out.decisions[0], { projectId: "p1", action: "skip", reason: "already current" });
    assert.deepEqual(ctx.writes, []);
    // State unchanged.
    assert.deepEqual(_loadReseedState(ctx.statePath), { completedByProjectVersion: { p1: "2.1.0" } });
  }

  // 2. Out-of-date, batch idle → reseed AND state advanced.
  {
    const cfg = { projects: [{ id: "p2", working_dir: "/tmp/p2" }] };
    const ctx = makeRun({
      cfg, version: "2.1.0",
      initialState: { completedByProjectVersion: { p2: "2.0.0" } },
    });
    const out = await ctx.run();
    assert.equal(out.decisions[0].action, "reseeded");
    assert.deepEqual(ctx.writes, ["p2"]);
    assert.equal(_loadReseedState(ctx.statePath).completedByProjectVersion.p2, "2.1.0");
  }

  // 3. Fresh install (no state file at all) → reseeds everything, then is
  //    no-op on subsequent run.
  {
    const cfg = { projects: [{ id: "a", working_dir: "/tmp/a" }, { id: "b", working_dir: "/tmp/b" }] };
    const ctx = makeRun({ cfg, version: "2.1.0" });
    const out1 = await ctx.run();
    assert.equal(out1.decisions.length, 2);
    assert.equal(out1.decisions[0].action, "reseeded");
    assert.equal(out1.decisions[1].action, "reseeded");
    assert.deepEqual(ctx.writes, ["a", "b"]);
    assert.deepEqual(_loadReseedState(ctx.statePath).completedByProjectVersion, { a: "2.1.0", b: "2.1.0" });
    // Subsequent run: both skip.
    ctx.writes.length = 0;
    const out2 = await ctx.run();
    assert.ok(out2.decisions.every((d) => d.action === "skip"));
    assert.deepEqual(ctx.writes, []);
  }

  // 4. Batch active → DEFERRED, state UNCHANGED. The exact #856 contract
  //    ("Per-project reseed state is load-bearing").
  {
    const cfg = { projects: [{ id: "busy", working_dir: "/tmp/busy" }] };
    const ctx = makeRun({
      cfg, version: "2.1.0",
      getProgress: async () => ({ items: [{ status: "in_review" }], complete: false }),
    });
    const out = await ctx.run();
    assert.deepEqual(out.decisions[0], { projectId: "busy", action: "deferred", reason: "batch active" });
    assert.deepEqual(ctx.writes, []);
    assert.deepEqual(_loadReseedState(ctx.statePath), { completedByProjectVersion: {} });
    assert.ok(ctx.lines.some((l) => /will retry on next startup/.test(l)),
      "deferral is logged with retry hint");
  }

  // 5. Batch state unknown (null result) → defer.
  {
    const cfg = { projects: [{ id: "?", working_dir: "/tmp/q" }] };
    const ctx = makeRun({
      cfg, version: "2.1.0",
      getProgress: async () => null,
    });
    const out = await ctx.run();
    assert.equal(out.decisions[0].action, "deferred");
    assert.deepEqual(ctx.writes, []);
  }

  // 6. Batch progress call throws → defer (fail-closed gate, same contract
  //    as the #853 manual endpoint).
  {
    const cfg = { projects: [{ id: "x", working_dir: "/tmp/x" }] };
    const ctx = makeRun({
      cfg, version: "2.1.0",
      getProgress: async () => { throw new Error("network blip"); },
    });
    const out = await ctx.run();
    assert.equal(out.decisions[0].action, "deferred");
    assert.match(out.decisions[0].reason, /network blip/);
    assert.deepEqual(_loadReseedState(ctx.statePath), { completedByProjectVersion: {} });
  }

  // 7. write throws → state UNCHANGED, decision recorded as error.
  {
    const cfg = { projects: [{ id: "boom", working_dir: "/tmp/boom" }] };
    const ctx = makeRun({
      cfg, version: "2.1.0",
      performWrites: () => { throw new Error("missing seed"); },
    });
    const out = await ctx.run();
    assert.equal(out.decisions[0].action, "error");
    assert.equal(out.decisions[0].error, "missing seed");
    assert.deepEqual(_loadReseedState(ctx.statePath), { completedByProjectVersion: {} });
  }

  // 8. Mix: one skip, one deferred, one reseeded — independent decisions,
  //    only the reseeded project's state advances.
  {
    const cfg = { projects: [
      { id: "ok-already", working_dir: "/tmp/ok-already" },
      { id: "busy",       working_dir: "/tmp/busy" },
      { id: "needs",      working_dir: "/tmp/needs" },
    ]};
    const ctx = makeRun({
      cfg, version: "2.1.0",
      initialState: { completedByProjectVersion: { "ok-already": "2.1.0", needs: "1.9.0" } },
      getProgress: async (id) => id === "busy"
        ? { items: [{ status: "in_review" }], complete: false }
        : { items: [], complete: false },
    });
    const out = await ctx.run();
    const byId = Object.fromEntries(out.decisions.map((d) => [d.projectId, d.action]));
    assert.deepEqual(byId, { "ok-already": "skip", busy: "deferred", needs: "reseeded" });
    const after = _loadReseedState(ctx.statePath).completedByProjectVersion;
    assert.deepEqual(after, { "ok-already": "2.1.0", needs: "2.1.0" });
    assert.equal(after.busy, undefined, "deferred project does NOT get a state entry");
  }

  // 9. Deferred-then-resolved across two boots — the #856 retry contract.
  //    Boot 1: busy project deferred. Boot 2: batch idle, project re-seeds.
  //    Other already-current project remains a skip both boots.
  {
    const cfg = { projects: [
      { id: "current", working_dir: "/tmp/current" },
      { id: "later",   working_dir: "/tmp/later" },
    ]};
    const dir = tmp("two-boots");
    const statePath = path.join(dir, "state.json");
    _saveReseedState({ completedByProjectVersion: { current: "2.1.0" } }, statePath);

    let batchActive = true;
    const writes = [];
    const performWrites = (p) => { writes.push(p.id); return { reseeded: ["head/AGENTS.md"], skipped: [], preserved: {} }; };
    const getProgress = async (id) => id === "later" && batchActive
      ? { items: [{ status: "in_review" }], complete: false }
      : { items: [], complete: false };
    const { log } = quietLog();

    // Boot 1.
    const boot1 = await autoReseedOnStartup(cfg, { version: "2.1.0", statePath, getProgress, performWrites, log });
    const boot1ById = Object.fromEntries(boot1.decisions.map((d) => [d.projectId, d.action]));
    assert.deepEqual(boot1ById, { current: "skip", later: "deferred" });
    assert.deepEqual(writes, []);
    // State unchanged for `later` — the load-bearing per-project state.
    assert.equal(_loadReseedState(statePath).completedByProjectVersion.later, undefined);

    // Boot 2: batch idle now.
    batchActive = false;
    const boot2 = await autoReseedOnStartup(cfg, { version: "2.1.0", statePath, getProgress, performWrites, log });
    const boot2ById = Object.fromEntries(boot2.decisions.map((d) => [d.projectId, d.action]));
    assert.deepEqual(boot2ById, { current: "skip", later: "reseeded" });
    assert.deepEqual(writes, ["later"], "only `later` reseeded on boot 2 — `current` stayed up-to-date");
    assert.equal(_loadReseedState(statePath).completedByProjectVersion.later, "2.1.0");
  }

  // 10. Project without working_dir is silently skipped (no decision row, no
  //     state mutation, no log line).
  {
    const cfg = { projects: [
      { id: "good", working_dir: "/tmp/good" },
      { id: "bare" },        // no working_dir
      { id: "bare2", working_dir: "" },
    ]};
    const ctx = makeRun({ cfg, version: "2.1.0" });
    const out = await ctx.run();
    assert.equal(out.decisions.length, 1);
    assert.equal(out.decisions[0].projectId, "good");
  }

  // ── End-to-end: real _performReseedWrites against temp worktrees ─────────
  // This is the "existing upgraded users get GITHUB.md" user-visible check.
  // Pre-#809 AGENTS.md content is replaced by the current template (which
  // references GITHUB.md), and the project's state advances to the new
  // version. Asserts the auto-reseed + write path fits together end-to-end.
  {
    const projId = `e2e-${crypto.randomBytes(4).toString("hex")}`;
    const root = tmp("e2e");
    const workingDir = path.join(root, "proj");
    fs.mkdirSync(workingDir, { recursive: true });
    const re1Dir = path.join(root, "proj-re1");
    const re2Dir = path.join(root, "proj-re2");
    fs.mkdirSync(re1Dir, { recursive: true });
    fs.mkdirSync(re2Dir, { recursive: true });
    // Pre-#809 stale re1 AGENTS.md: positive `gh pr list` discovery
    // instruction (the exact thing #809 replaced with GITHUB.md). The
    // heading matches the current template heading so the #845 merger
    // overwrites the body — which is precisely how a real pre-#809 file
    // got upgraded: the section was always called the same thing, only
    // the body content changed.
    const stale = [
      "# Reviewer 1",
      "",
      "## GitHub State (discovery)",
      "Use `gh pr list` to find open PRs in this repo. Filter by your username.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(re1Dir, "AGENTS.md"), stale);
    fs.writeFileSync(path.join(re2Dir, "AGENTS.md"),
      stale.replace("# Reviewer 1", "# Reviewer 2"));

    const cfg = { projects: [{
      id: projId, name: "E2E", working_dir: workingDir,
      agents: { re1: { cwd: re1Dir }, re2: { cwd: re2Dir } },
    }] };
    const dir = tmp("e2e-state");
    const statePath = path.join(dir, "state.json");
    const { log } = quietLog();

    const out = await autoReseedOnStartup(cfg, {
      version: "9.9.9", statePath, log,
      // No batch infra in this temp project — short-circuit to "idle".
      getProgress: async () => ({ items: [], complete: false }),
    });
    assert.equal(out.decisions[0].action, "reseeded");
    assert.equal(_loadReseedState(statePath).completedByProjectVersion[projId], "9.9.9");

    const re1After = fs.readFileSync(path.join(re1Dir, "AGENTS.md"), "utf-8");
    const re2After = fs.readFileSync(path.join(re2Dir, "AGENTS.md"), "utf-8");
    // The user-visible #856 outcome: existing upgraded users see GITHUB.md
    // discovery, not the stale pre-#809 positive `gh pr list` instruction.
    assert.ok(re1After.includes("GITHUB.md"), "re1 has GITHUB.md after auto-reseed");
    assert.ok(re2After.includes("GITHUB.md"), "re2 has GITHUB.md after auto-reseed");
    // The stale positive-instruction sentence is gone (only anti-instruction
    // and fallback mentions of `gh pr list` may remain — those live in the
    // fresh template's `**fallback only**` sentence).
    assert.ok(!re1After.includes("Use `gh pr list` to find open PRs in this repo."),
      "re1 stale positive instruction replaced");

    // Second auto-reseed call → no-op.
    const writesAgain = [];
    await autoReseedOnStartup(cfg, {
      version: "9.9.9", statePath, log,
      getProgress: async () => ({ items: [], complete: false }),
      performWrites: (p) => { writesAgain.push(p.id); return _performReseedWrites(p, cfg); },
    });
    assert.deepEqual(writesAgain, [], "second startup at same version skips already-current projects");
  }

  console.log("routes.autoReseed.test.js: all assertions passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
