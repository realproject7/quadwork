// #1023: SettingsPage.addProject seeds a new project's agents with the
// configured default_backend, falling back to an installed CLI when that
// backend isn't actually present. The old fallback was a hardcoded
// claude-or-codex chain, so a GROK-only machine seeded the uninstalled
// "claude" — and so did a GEMINI-only machine, the same pre-existing bug this
// ticket fixes deliberately along the way.
//
// addProject is a React component with no test harness, so — exactly like the
// #935 butler-model mirror in agentModels.test.js — this pins the EXPRESSION
// the component applies rather than importing it. Extracting it to a shared
// module would have made this test exercise the real code, but that module had
// a single call site, which the ticket's no-new-abstraction boundary and the
// kill-list both reject (@re1 on PR #1024); the mirror is the accepted cost.
//
// Be clear about what that costs: this pins the fallback SEMANTICS, and it
// fails if the intended behavior is wrong — but it cannot fail if someone
// reverts SettingsPage.tsx alone. Keep the two in sync; the mirror below copies
// the expression at SettingsPage.tsx:714-723 (the TS `as keyof` casts dropped,
// since plain JS doesn't need them).

// The BACKENDS rows SettingsPage renders, in order — the component's `find`
// walks these, so the "first installed" preference here is the real one.
const BACKENDS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "grok", label: "Grok CLI" },
];

// Mirror of SettingsPage.addProject's default-backend selection.
const defaultCmdFor = (cliStatus, configured = "claude") => {
  const configuredAvailable = !cliStatus || cliStatus[configured] !== false;
  return configuredAvailable
    ? configured
    : (cliStatus && BACKENDS.find((b) => cliStatus[b.value])?.value) || "claude";
};

const only = (name) => Object.fromEntries(BACKENDS.map((b) => [b.value, b.value === name]));

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

// ── The two acceptance criteria. `configured` is the saved default_backend;
// "claude" is the value a fresh config carries, and the bug was that it stuck
// even when claude wasn't installed. ──
ok(
  defaultCmdFor(only("grok")) === "grok",
  "#1023 AC: on a grok-only machine the new-project default is grok, NOT the uninstalled claude",
);
ok(
  defaultCmdFor(only("gemini")) === "gemini",
  "#1023 AC: on a gemini-only machine it is gemini — the pre-existing bug fixed along the way",
);

// ── #212 preserved: an installed configured backend always wins over the
// fallback, so this fix cannot override a deliberate operator choice. ──
ok(defaultCmdFor(only("grok"), "grok") === "grok", "#212: a configured+installed grok default is honored");
ok(
  defaultCmdFor({ claude: true, codex: true, gemini: false, grok: true }, "codex") === "codex",
  "#212: the configured backend wins over the first-installed order when it is available",
);

// ── No regression for the combinations the old chain already handled ──
ok(defaultCmdFor(only("claude")) === "claude", "claude-only machine → claude");
ok(defaultCmdFor(only("codex")) === "codex", "codex-only machine → codex");
ok(
  defaultCmdFor({ claude: false, codex: true, gemini: true, grok: false }) === "codex",
  "a multi-install combo without claude → the first installed one, not claude",
);

// ── Fail-safe directions ──
ok(defaultCmdFor(null) === "claude", "unknown CLI status (fetch failed / not yet loaded) → the claude default");
ok(
  defaultCmdFor({ claude: false, codex: false, gemini: false, grok: false }) === "claude",
  "nothing installed → the claude default rather than an empty command",
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
