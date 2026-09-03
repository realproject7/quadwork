// #855: _resolveReseedTargets + _canonicalAgentSlug tests. Verifies the
// re-seed path walks the project's configured agents from `cwd` (rather
// than reconstructing `${dirName}-${agentKey}`) and maps legacy agent keys
// to canonical seed-template slugs.
//
// Pure helpers — no fs touching, no temp-dir harness needed. Run with
// `node server/routes.resolveReseedTargets.test.js` (the cross-platform
// runner from #836 auto-discovers it).

const assert = require("node:assert/strict");
const path = require("node:path");
const { _resolveReseedTargets, _resolveRepositoryReseedTargets, _canonicalAgentSlug } = require("./routes");

// 1) Canonical key map — legacy reviewer1/reviewer2/t1..t3 → canonical
//    head/re1/re2/dev. Unknown / already-canonical keys pass through so
//    future agent slugs don't need a code change.
{
  assert.equal(_canonicalAgentSlug("reviewer1"), "re1");
  assert.equal(_canonicalAgentSlug("reviewer2"), "re2");
  assert.equal(_canonicalAgentSlug("t1"), "head");
  assert.equal(_canonicalAgentSlug("t2a"), "re1");
  assert.equal(_canonicalAgentSlug("t2b"), "re2");
  assert.equal(_canonicalAgentSlug("t3"), "dev");
  // Canonical keys → themselves.
  for (const k of ["head", "re1", "re2", "dev"]) assert.equal(_canonicalAgentSlug(k), k);
  // Unknown keys → themselves (no surprise rewrite).
  assert.equal(_canonicalAgentSlug("ops"), "ops");
}

// 2) Legacy reviewer1/reviewer2 worktrees — the exact #855 regression case.
//    Resolver must yield each configured agent's `cwd` verbatim AND map it
//    to the canonical seed-template slug (re1/re2), so the loop writes the
//    fresh re1/re2 AGENTS.md into the legacy-named worktree dir.
{
  const project = {
    working_dir: "/Users/op/Projects/plotlink",
    agents: {
      head: { cwd: "/Users/op/Projects/plotlink-head" },
      dev:  { cwd: "/Users/op/Projects/plotlink-dev" },
      re1:  { cwd: "/Users/op/Projects/plotlink-reviewer1" },
      re2:  { cwd: "/Users/op/Projects/plotlink-reviewer2" },
    },
  };
  const targets = _resolveReseedTargets(project);
  assert.equal(targets.length, 4);
  const byKey = Object.fromEntries(targets.map((t) => [t.agentKey, t]));

  assert.deepEqual(byKey.head, {
    agentKey: "head", canonical: "head", wtDir: "/Users/op/Projects/plotlink-head",
  });
  assert.deepEqual(byKey.dev, {
    agentKey: "dev", canonical: "dev", wtDir: "/Users/op/Projects/plotlink-dev",
  });
  // re1's worktree dir keeps its legacy `*-reviewer1` name (from config cwd),
  // but the seed template is canonical `re1.AGENTS.md`. Same for re2. This is
  // the exact bug #855 fixes — the old loop computed `plotlink-re1` and so
  // never wrote into `plotlink-reviewer1`.
  assert.deepEqual(byKey.re1, {
    agentKey: "re1", canonical: "re1", wtDir: "/Users/op/Projects/plotlink-reviewer1",
  });
  assert.deepEqual(byKey.re2, {
    agentKey: "re2", canonical: "re2", wtDir: "/Users/op/Projects/plotlink-reviewer2",
  });
}

// 3) Legacy AGENT KEYS (`reviewer1`/`reviewer2`/`t1..t3`) — older configs
//    used these as the actual `project.agents` keys. Resolver must still
//    map them to canonical seed templates.
{
  const project = {
    working_dir: "/tmp/legacy",
    agents: {
      t1:  { cwd: "/tmp/legacy-t1" },
      t2a: { cwd: "/tmp/legacy-t2a" },
      t2b: { cwd: "/tmp/legacy-t2b" },
      t3:  { cwd: "/tmp/legacy-t3" },
    },
  };
  const targets = _resolveReseedTargets(project);
  const canonicals = Object.fromEntries(targets.map((t) => [t.agentKey, t.canonical]));
  assert.deepEqual(canonicals, { t1: "head", t2a: "re1", t2b: "re2", t3: "dev" });
  // Worktree paths preserved verbatim from config (no rewrite to `*-head`).
  const wts = Object.fromEntries(targets.map((t) => [t.agentKey, t.wtDir]));
  assert.deepEqual(wts, {
    t1: "/tmp/legacy-t1", t2a: "/tmp/legacy-t2a",
    t2b: "/tmp/legacy-t2b", t3: "/tmp/legacy-t3",
  });
}

// 4) Mixed legacy + canonical (e.g. operator renamed only the reviewers but
//    left head/dev as defaults). Each key resolves independently.
{
  const project = {
    working_dir: "/tmp/mix",
    agents: {
      head:      { cwd: "/tmp/mix-head" },
      dev:       { cwd: "/tmp/mix-dev" },
      reviewer1: { cwd: "/tmp/mix-reviewer1" },
      reviewer2: { cwd: "/tmp/mix-reviewer2" },
    },
  };
  const targets = _resolveReseedTargets(project);
  const summary = targets.map((t) => `${t.agentKey}→${t.canonical}@${t.wtDir}`).sort();
  assert.deepEqual(summary, [
    "dev→dev@/tmp/mix-dev",
    "head→head@/tmp/mix-head",
    "reviewer1→re1@/tmp/mix-reviewer1",
    "reviewer2→re2@/tmp/mix-reviewer2",
  ]);
}

// 5) Fallback when project has NO `agents` map (very old config) — resolver
//    walks the canonical default list and computes sibling paths so the
//    behavior matches the pre-#855 default-layout case.
{
  const project = { working_dir: "/srv/oldproj" };
  const targets = _resolveReseedTargets(project);
  assert.equal(targets.length, 4);
  assert.deepEqual(targets.map((t) => t.agentKey), ["head", "re1", "re2", "dev"]);
  assert.deepEqual(targets.map((t) => t.canonical), ["head", "re1", "re2", "dev"]);
  for (const t of targets) {
    assert.equal(t.wtDir, path.join("/srv", `oldproj-${t.canonical}`));
  }
}

// 6) Agent config without `cwd` — falls back to sibling computation using the
//    canonical slug (so a legacy key without a stored cwd still lands in a
//    sensible default, not undefined).
{
  const project = {
    working_dir: "/srv/half",
    agents: {
      reviewer1: {},  // no cwd
      re2: { cwd: "/srv/half-reviewer2" },
    },
  };
  const targets = _resolveReseedTargets(project);
  const byKey = Object.fromEntries(targets.map((t) => [t.agentKey, t]));
  assert.equal(byKey.reviewer1.wtDir, path.join("/srv", "half-re1"));
  assert.equal(byKey.reviewer1.canonical, "re1");
  assert.equal(byKey.re2.wtDir, "/srv/half-reviewer2");
}

// 7) Project without `working_dir` → empty target list (the route handler
//    already 400s before this is called, but the helper must not throw).
{
  assert.deepEqual(_resolveReseedTargets({}), []);
  assert.deepEqual(_resolveReseedTargets({ working_dir: "" }), []);
  assert.deepEqual(_resolveReseedTargets(null), []);
}

// 8) V2 repository expansion keeps the configured primary role paths but
// seeds only the matching role in a secondary repository. It never derives a
// second agent/session identity from the additional repository.
{
  const project = {
    id: "multi",
    repositories: [
      { key: "web", repo: "Acme/Web", working_dir: "/srv/web", primary: true },
      { key: "api", repo: "Acme/Api", working_dir: "/srv/api", primary: false },
    ],
    agents: {
      head: { cwd: "/custom/web-head" },
      re1: { cwd: "/custom/web-re1" },
      re2: { cwd: "/custom/web-re2" },
      dev: { cwd: "/custom/web-dev" },
    },
  };
  const targets = _resolveRepositoryReseedTargets(project);
  assert.equal(targets.length, 8);
  const primary = targets.filter((target) => target.primaryRepository);
  const api = targets.filter((target) => target.repositoryKey === "api");
  assert.deepEqual(primary.map((target) => target.wtDir).sort(), [
    "/custom/web-dev", "/custom/web-head", "/custom/web-re1", "/custom/web-re2",
  ]);
  assert.deepEqual(api.map((target) => `${target.agentKey}@${target.wtDir}`).sort(), [
    "dev@/srv/api-dev", "head@/srv/api-head", "re1@/srv/api-re1", "re2@/srv/api-re2",
  ]);
  assert.ok(api.every((target) => target.agentKey === target.canonical), "secondary seed stays in the same role row");
}

console.log("routes.resolveReseedTargets.test.js: all assertions passed (8 cases)");
