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

const playbookSeed = fs.readFileSync(path.join(__dirname, "..", "templates", "seeds", "HEAD-PO-PLAYBOOK.md"), "utf-8");
const playbookVersion = playbookSeed.match(/^\*\*Playbook version:\*\*\s+(\d+\.\d+\.\d+)$/m);
assert.ok(playbookVersion, "canonical playbook seed carries a semantic version");

const {
  autoReseedOnStartup: autoReseedOnStartupRaw,
  _loadReseedState,
  _saveReseedState,
  _readPackageVersion,
  _performReseedWrites,
  _periodicDeferStreak,
  PERIODIC_DEFER_LOG_EVERY,
} = require("./routes");

const autoReseedOnStartup = (cfg, options = {}) => autoReseedOnStartupRaw(cfg, {
  captureAdmission: (projectId) => ({ project_id: projectId, generation: 0 }),
  admissionCurrent: () => true,
  ...options,
});

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
    assert.ok(ctx.lines.some((l) => /will retry automatically once the batch clears/.test(l)),
      "deferral is logged with the no-restart retry hint");
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
      id: projId, name: "E2E",
      repositories: [{ key: "primary", repo: "Acme/E2E", working_dir: workingDir, primary: true }],
      agents: { re1: { cwd: re1Dir }, re2: { cwd: re2Dir } },
    }] };
    const dir = tmp("e2e-state");
    const statePath = path.join(dir, "state.json");
    const { log } = quietLog();
    const projectConfigDir = path.join(root, ".quadwork");
    const installedPlaybook = path.join(projectConfigDir, projId, "HEAD-PO-PLAYBOOK.md");
    fs.mkdirSync(path.dirname(installedPlaybook), { recursive: true });
    fs.writeFileSync(installedPlaybook, [
      "# Old Head Playbook",
      "",
      "## 1. Operating model",
      "stale canonical instructions",
      "",
      "## Operator Runbook Notes",
      "keep this deployment-specific note",
      "",
    ].join("\n"));

    const out = await autoReseedOnStartup(cfg, {
      version: "9.9.9", statePath, log,
      // No batch infra in this temp project — short-circuit to "idle".
      getProgress: async () => ({ items: [], complete: false }),
      performWrites: (p) => _performReseedWrites(p, cfg, { configDir: projectConfigDir }),
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
    const playbookAfter = fs.readFileSync(installedPlaybook, "utf-8");
    assert.ok(playbookAfter.includes(playbookVersion[0]),
      `auto-reseed refreshes the canonical Head PO playbook version (${playbookVersion[1]})`);
    assert.ok(!playbookAfter.includes("stale canonical instructions"),
      "auto-reseed replaces canonical playbook sections");
    assert.ok(playbookAfter.includes("keep this deployment-specific note"),
      "auto-reseed preserves operator-added playbook sections");

    // Second auto-reseed call → no-op.
    const writesAgain = [];
    await autoReseedOnStartup(cfg, {
      version: "9.9.9", statePath, log,
      getProgress: async () => ({ items: [], complete: false }),
      performWrites: (p) => {
        writesAgain.push(p.id);
        return _performReseedWrites(p, cfg, { configDir: projectConfigDir });
      },
    });
    assert.deepEqual(writesAgain, [], "second startup at same version skips already-current projects");
  }

  // 11. #915: deferred (active) → periodic retry once the batch clears re-seeds
  //     WITHOUT a server restart. Simulates the recurring reseedRetryTick:
  //     same statePath re-used across calls, no boot in between.
  {
    const cfg = { projects: [{ id: "busy915", working_dir: "/tmp/busy915" }] };
    const dir = tmp("periodic-retry");
    const statePath = path.join(dir, "state.json");
    let batchActive = true;
    const writes = [];
    const performWrites = (p) => { writes.push(p.id); return { reseeded: ["head/AGENTS.md"], skipped: [], preserved: {} }; };
    const getProgress = async () => batchActive
      ? { items: [{ status: "in_review" }], complete: false }
      : { items: [], complete: false };
    const { log, lines } = quietLog();
    const tick = () => autoReseedOnStartup(cfg, { version: "2.1.0", statePath, getProgress, performWrites, log, periodic: true });

    // Tick 1 + 2 while the batch is active: deferred, state unchanged, NO writes.
    await tick();
    await tick();
    assert.deepEqual(writes, [], "periodic ticks during an active batch never reseed");
    assert.equal(_loadReseedState(statePath).completedByProjectVersion.busy915, undefined, "state stays pending while deferred");
    assert.ok(!lines.some((l) => /busy915/.test(l)), "periodic deferral is NOT logged (no per-tick spam)");

    // Batch clears → next tick reseeds, no restart needed.
    batchActive = false;
    const out = await tick();
    assert.equal(out.decisions[0].action, "reseeded");
    assert.deepEqual(writes, ["busy915"], "reseed runs on the tick after the batch clears");
    assert.equal(_loadReseedState(statePath).completedByProjectVersion.busy915, "2.1.0", "state advances once reseeded");

    // Further ticks are a no-op skip (idempotent).
    writes.length = 0;
    const out2 = await tick();
    assert.equal(out2.decisions[0].action, "skip");
    assert.deepEqual(writes, [], "already-current project is skipped on later ticks");
  }

  // 12. #915: periodic=false (startup) still logs the deferral; periodic=true
  //     suppresses it — same decision either way.
  {
    const cfg = { projects: [{ id: "loud", working_dir: "/tmp/loud" }] };
    const mk = (periodic) => {
      const dir = tmp(`log-${periodic}`);
      const statePath = path.join(dir, "state.json");
      const { log, lines } = quietLog();
      return { lines, run: () => autoReseedOnStartup(cfg, {
        version: "2.1.0", statePath, log, periodic,
        getProgress: async () => ({ items: [{ status: "in_review" }], complete: false }),
      }) };
    };
    const boot = mk(false); const bootOut = await boot.run();
    const tickCtx = mk(true); const tickOut = await tickCtx.run();
    assert.equal(bootOut.decisions[0].action, "deferred");
    assert.equal(tickOut.decisions[0].action, "deferred");
    assert.ok(boot.lines.some((l) => /loud/.test(l)), "startup logs the deferral");
    assert.ok(!tickCtx.lines.some((l) => /loud/.test(l)), "periodic tick suppresses the benign active-batch deferral log");
  }

  // 13. #922: periodic + batch-state check THREW → the error deferral is
  //     visible but THROTTLED — logs on the first occurrence, stays silent
  //     within the window, then re-logs once per PERIODIC_DEFER_LOG_EVERY ticks.
  {
    _periodicDeferStreak.clear();
    const cfg = { projects: [{ id: "stuck13", working_dir: "/tmp/stuck13" }] };
    const statePath = path.join(tmp("stuck13"), "state.json");
    const { log, lines } = quietLog();
    const tick = () => autoReseedOnStartup(cfg, {
      version: "2.1.0", statePath, log, periodic: true,
      getProgress: async () => { throw new Error("gh down"); },
    });
    await tick(); // tick 1
    assert.equal(lines.filter((l) => /stuck13/.test(l)).length, 1, "periodic error-deferral logs on the FIRST occurrence (not silent)");
    assert.ok(lines.some((l) => /still deferred after 1 periodic/.test(l)), "first stuck log carries the escalation hint");
    for (let i = 2; i < PERIODIC_DEFER_LOG_EVERY; i++) await tick(); // ticks 2..N-1
    assert.equal(lines.filter((l) => /stuck13/.test(l)).length, 1, "error-deferrals within the window are throttled (no per-tick spam)");
    await tick(); // tick N == PERIODIC_DEFER_LOG_EVERY
    assert.equal(lines.filter((l) => /stuck13/.test(l)).length, 2, "re-logs once per PERIODIC_DEFER_LOG_EVERY ticks");
    assert.ok(lines.some((l) => new RegExp(`after ${PERIODIC_DEFER_LOG_EVERY} periodic`).test(l)), "escalation log reports the streak length");
    // Fail-closed unchanged: a thrown batch-state check still defers, never reseeds.
    const out = await tick();
    assert.equal(out.decisions[0].action, "deferred", "thrown batch-state check still defers (fail-closed preserved)");
  }

  // 14. #922: periodic + batch state null (unknown) is ALSO surfaced (throttled),
  //     not silently dropped — same error class as a throw.
  {
    _periodicDeferStreak.clear();
    const cfg = { projects: [{ id: "null14", working_dir: "/tmp/null14" }] };
    const statePath = path.join(tmp("null14"), "state.json");
    const { log, lines } = quietLog();
    await autoReseedOnStartup(cfg, {
      version: "2.1.0", statePath, log, periodic: true,
      getProgress: async () => null, isActiveFromProgress: () => null,
    });
    assert.ok(lines.some((l) => /null14.*deferred — batch state unknown/.test(l)), "periodic null-state deferral is visible (throttled), not silent");
  }

  // 15. #922: a BENIGN active-batch deferral on the periodic tick stays silent
  //     (no spam) AND does not accumulate a stuck-streak (#915 preserved).
  {
    _periodicDeferStreak.clear();
    const cfg = { projects: [{ id: "busy15", working_dir: "/tmp/busy15" }] };
    const statePath = path.join(tmp("busy15"), "state.json");
    const { log, lines } = quietLog();
    const tick = () => autoReseedOnStartup(cfg, {
      version: "2.1.0", statePath, log, periodic: true,
      getProgress: async () => ({ items: [{ status: "in_review" }], complete: false }),
    });
    await tick(); await tick(); await tick();
    assert.ok(!lines.some((l) => /busy15/.test(l)), "benign active-batch deferral is never logged on the periodic tick");
    assert.ok(!_periodicDeferStreak.has("busy15"), "benign active deferral does not accumulate a stuck-streak");
  }

  // 16. #922: the stuck-streak RESETS when the project stops error-deferring, so
  //     a fresh stuck episode logs immediately; and boot (non-periodic) logs
  //     every error-deferral with no throttle.
  {
    _periodicDeferStreak.clear();
    const cfg = { projects: [{ id: "reset16", working_dir: "/tmp/reset16" }] };
    const statePath = path.join(tmp("reset16"), "state.json");
    const { log, lines } = quietLog();
    let mode = "throw";
    const tick = () => autoReseedOnStartup(cfg, {
      version: "2.1.0", statePath, log, periodic: true,
      getProgress: async () => { if (mode === "throw") throw new Error("blip"); return { items: [{ status: "in_review" }], complete: false }; },
    });
    await tick(); // throw → streak 1 → logs
    assert.equal(lines.filter((l) => /reset16/.test(l)).length, 1, "first stuck episode logs");
    mode = "active"; await tick(); // benign active → clears streak, silent
    assert.ok(!_periodicDeferStreak.has("reset16"), "streak cleared once the project is no longer error-deferred");
    mode = "throw"; await tick(); // fresh episode → logs immediately
    assert.equal(lines.filter((l) => /reset16/.test(l)).length, 2, "a fresh stuck episode logs immediately (streak reset, not waiting out the window)");

    const { log: blog, lines: blines } = quietLog();
    const boot = () => autoReseedOnStartup(cfg, {
      version: "2.1.0", statePath, log: blog, periodic: false,
      getProgress: async () => { throw new Error("blip"); },
    });
    await boot(); await boot(); await boot();
    assert.equal(blines.filter((l) => /reset16/.test(l)).length, 3, "boot (non-periodic) logs every error-deferral — no throttle");
  }

  console.log("routes.autoReseed.test.js: all assertions passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
