// #1023: SettingsPage.addProject seeds a new project's agents with the
// configured default_backend, falling back to an installed CLI when that
// backend isn't actually present. The old fallback was a hardcoded
// claude-or-codex chain, so a GROK-only machine seeded the uninstalled
// "claude" — and so did a GEMINI-only machine, the same pre-existing bug this
// ticket fixes deliberately along the way.
//
// addProject is a React-only surface with no harness, so the decision was
// extracted into src/lib/defaultBackend.js and this test exercises THAT module
// — the same code the component imports, not a mirror of it. The scope limit is
// worth stating: this pins the fallback logic, not the JSX call site.

const { firstInstalledBackend } = require("../src/lib/defaultBackend.js");

// The BACKENDS order SettingsPage renders (and passes in), so the
// "first installed" preference here is the one the UI actually applies.
const BACKENDS = ["claude", "codex", "gemini", "grok"];
const only = (name) =>
  Object.fromEntries(BACKENDS.map((b) => [b, b === name]));

let passed = 0,
  failed = 0;
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`  PASS: ${m}`);
  } else {
    failed++;
    console.error(`  FAIL: ${m}`);
  }
};

// ── The two acceptance criteria ──
ok(
  firstInstalledBackend(only("grok"), BACKENDS) === "grok",
  "#1023 AC: on a grok-only machine the new-project default is grok, NOT the uninstalled claude",
);
ok(
  firstInstalledBackend(only("gemini"), BACKENDS) === "gemini",
  "#1023 AC: on a gemini-only machine it is gemini — the pre-existing bug fixed along the way",
);

// ── No regression for the combinations the old chain already handled ──
ok(firstInstalledBackend(only("claude"), BACKENDS) === "claude", "claude-only machine → claude");
ok(firstInstalledBackend(only("codex"), BACKENDS) === "codex", "codex-only machine → codex");
ok(
  firstInstalledBackend({ claude: true, codex: true, gemini: false, grok: false }, BACKENDS) === "claude",
  "claude+codex installed → claude (first in the rendered order, unchanged)",
);
ok(
  firstInstalledBackend({ claude: false, codex: true, gemini: true, grok: false }, BACKENDS) === "codex",
  "a multi-install combo without claude → the first installed one, not claude",
);

// ── Fail-safe directions ──
ok(
  firstInstalledBackend(null, BACKENDS) === "claude",
  "unknown CLI status (fetch failed / not yet loaded) → the claude default, not undefined",
);
ok(
  firstInstalledBackend(only("nothing-installed"), BACKENDS) === "claude",
  "nothing installed → the claude default rather than an empty command",
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
