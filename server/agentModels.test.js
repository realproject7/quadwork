// #931: the per-agent Settings Model dropdown was hardcoded to Claude models,
// so a codex/gemini agent could be saved with a Claude model (e.g. "sonnet")
// that its CLI can't use. The fix routes both the dropdown and the save path
// through the pure helpers in src/lib/agentModels.ts. This test pins those
// helpers — most importantly that an invalid existing model (codex + "sonnet")
// is healed to the first valid codex model on save, and that "" (CLI default)
// is never clobbered. Plain node:assert script (run via server/run-tests.js).
//
// Node strips the TS types at require-time, so we can exercise the real shared
// module the components use — no duplicated logic, no transpile step.

const {
  optionsForBackend,
  modelsForBackend,
  effectiveModel,
  sanitizeModel,
} = require("../src/lib/agentModels.ts");

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

// ── optionsForBackend: raw lists incl. the "" CLI-default row ──
ok(optionsForBackend("codex").some((o) => o.value === ""), "optionsForBackend(codex) includes the (CLI default) row");
ok(optionsForBackend("codex").some((o) => o.value === "gpt-5.4"), "optionsForBackend(codex) lists codex models");
ok(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].every((s) => optionsForBackend("codex").some((o) => o.value === s)), "#999: optionsForBackend(codex) includes the GPT-5.6 Sol/Terra/Luna slugs");
ok(optionsForBackend("nope").length === 1 && optionsForBackend("nope")[0].value === "", "optionsForBackend(unknown) → single CLI-default row");

// ── modelsForBackend: concrete (non-"") options, claude fallback ──
ok(modelsForBackend("codex").every((o) => o.value !== ""), "modelsForBackend(codex) strips the (CLI default) row");
ok(modelsForBackend("codex")[0].value === "gpt-5.4", "modelsForBackend(codex)[0] is the first concrete codex model");
ok(modelsForBackend("gemini")[0].value === "gemini-2.5-pro", "modelsForBackend(gemini)[0] is the first concrete gemini model");
ok(modelsForBackend("claude")[0].value === "opus", "modelsForBackend(claude)[0] is opus (not the CLI-default row)");
ok(modelsForBackend("nope").length > 0 && modelsForBackend("nope")[0].value === "opus", "modelsForBackend(unknown) falls back to Claude's concrete list");

// ── effectiveModel: what the dropdown DISPLAYS ──
ok(effectiveModel("claude", "sonnet") === "sonnet", "effectiveModel keeps a valid claude model");
ok(effectiveModel("codex", "gpt-5") === "gpt-5", "effectiveModel keeps a valid codex model");
ok(effectiveModel("codex", "sonnet") === "gpt-5.4", "effectiveModel: a stale Claude 'sonnet' on a codex agent shows the first codex model (not blank, not 'sonnet')");
ok(effectiveModel("codex", "") === "gpt-5.4", "effectiveModel: unset model defaults to the backend's first option (#931 AC2 — not 'sonnet')");
ok(effectiveModel("claude", undefined) === "opus", "effectiveModel: undefined model defaults to the backend's first option");
ok(effectiveModel("gemini", "gpt-5") === "gemini-2.5-pro", "effectiveModel: a cross-backend value resolves to the gemini first option");

// ── sanitizeModel: what gets PERSISTED on save ──
ok(sanitizeModel("codex", "sonnet") === "gpt-5.4", "#931 core: saving a codex agent with 'sonnet' persists the first valid codex model");
ok(sanitizeModel("gemini", "opus") === "gemini-2.5-pro", "sanitizeModel heals a Claude model on a gemini agent");
ok(sanitizeModel("codex", "gpt-4o") === "gpt-4o", "sanitizeModel keeps an already-valid codex model");
ok(sanitizeModel("claude", "claude-opus-4-8") === "claude-opus-4-8", "sanitizeModel keeps a valid pinned claude model");
ok(sanitizeModel("claude", "claude-fable-5") === "claude-fable-5", "#958: sanitizeModel keeps claude-fable-5 (new family, not covered by the opus/sonnet aliases)");
ok(sanitizeModel("codex", "") === "", "sanitizeModel keeps '' (CLI default) — valid for every CLI, never clobbered");
ok(sanitizeModel("gemini", undefined) === "", "sanitizeModel maps undefined → '' (CLI default), not a fabricated model");

// ── #935: SettingsPage.save() normalizes the butler model the same way it ──
// normalizes per-agent models. The save path is a React component (no harness),
// so we pin the exact expression save() applies to config.butler. A butler left
// invalid (hand-edited config / never command-changed) must heal on save, while
// "" (CLI default) is preserved.
const normalizeButler = (butler) =>
  butler
    ? { ...butler, model: sanitizeModel(butler.command || "claude", butler.model) }
    : butler;
ok(normalizeButler({ command: "codex", model: "opus" }).model === "gpt-5.4", "#935: save() heals an invalid butler model (codex + 'opus') to the first valid codex model");
ok(normalizeButler({ command: "gemini", model: "sonnet" }).model === "gemini-2.5-pro", "#935: save() heals a cross-backend butler model (gemini + 'sonnet')");
ok(normalizeButler({ command: "codex", model: "" }).model === "", "#935: save() preserves '' (CLI default) on the butler");
ok(normalizeButler({ command: "claude", model: "opus" }).model === "opus", "#935: save() keeps an already-valid butler model");
ok(normalizeButler({ command: "codex" }).model === "", "#935: save() maps an unset butler model → '' (CLI default), not a fabricated model");
ok(normalizeButler(undefined) === undefined, "#935: save() leaves a missing butler config untouched");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
