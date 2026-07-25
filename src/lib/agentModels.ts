// #343/#367/#931: backend-specific model catalog + the helpers that keep a
// per-agent (and butler) model valid for its CLI. Kept as pure data + logic
// (NO React) so it is shared by AgentModelsWidget + SettingsPage AND can be
// unit-tested directly under node (see server/agentModels.test.js).
//
// Empty string = "use the CLI's own default" (no -c / --model flag passed at
// all) — valid for every CLI. The lists below are the known-good slugs we ship
// with this release; operators who need something bleeding edge can still
// override by editing ~/.quadwork/config.json directly.
export const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  codex: [
    { value: "", label: "(CLI default)" },
    { value: "gpt-5.4", label: "gpt-5.4" },
    { value: "gpt-5", label: "gpt-5" },
    { value: "gpt-4o", label: "gpt-4o" },
    // #999: GPT-5.6 Sol/Terra/Luna — new concrete slugs. Appended AFTER the
    // existing rows so modelsForBackend("codex")[0] stays "gpt-5.4" (the #931
    // default/heal target). Same append pattern as the #958 Fable-5 row.
    { value: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { value: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    { value: "gpt-5.6-luna", label: "gpt-5.6-luna" },
  ],
  claude: [
    { value: "", label: "(CLI default)" },
    // #841: CLI-documented aliases (`claude --help` → "alias for the latest
    // model"). Auto-track new Opus/Sonnet releases without needing a QuadWork
    // update; pinned `claude-opus-4-X` rows below remain for operators who
    // want a specific version locked in.
    { value: "opus", label: "opus (latest)" },
    { value: "sonnet", label: "sonnet (latest)" },
    // #958: Fable 5 is a new model family, so the opus/sonnet aliases above
    // never resolve to it — it needs its own pinned row. Deliberately NOT the
    // first concrete row: modelsForBackend("claude")[0] ("opus") is the
    // default/heal target and must stay put (#931).
    { value: "claude-fable-5", label: "claude-fable-5" },
    // #1018: Claude Opus 5 pin for operators who need a reproducible version
    // rather than the moving `opus` alias (which already resolves to it). Sits
    // after `claude-fable-5` and before the 4.x pins — newest pin first — and
    // never first, so modelsForBackend("claude")[0] stays "opus" (#931).
    { value: "claude-opus-5", label: "claude-opus-5" },
    { value: "claude-opus-4-8", label: "claude-opus-4-8" },
    { value: "claude-opus-4-7", label: "claude-opus-4-7" },
    { value: "claude-opus-4-6", label: "claude-opus-4-6" },
    { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5" },
  ],
  gemini: [
    { value: "", label: "(CLI default)" },
    { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
  ],
};

// Raw option list for a backend (includes the "" CLI-default row). Unknown
// backends fall back to a single CLI-default row.
export function optionsForBackend(backend: string) {
  return MODEL_OPTIONS[backend] || [{ value: "", label: "(CLI default)" }];
}

// Concrete (non-"") model options for a backend — used by the inline Settings
// dropdowns, which don't offer the "" CLI-default row. Unknown backends (or a
// backend with no concrete models) fall back to Claude's list, so the dropdown
// is never empty and `[0]` is always defined.
export function modelsForBackend(backend: string) {
  const opts = optionsForBackend(backend).filter((o) => o.value !== "");
  return opts.length > 0 ? opts : optionsForBackend("claude").filter((o) => o.value !== "");
}

// The model to DISPLAY in an inline dropdown: the saved model if it is a
// concrete valid option for the backend, else the backend's first concrete
// option — so an unset ("") or stale/cross-backend value (e.g. a Claude
// "sonnet" left on a codex agent) never renders blank or as the wrong model.
export function effectiveModel(backend: string, model: string | undefined) {
  const opts = modelsForBackend(backend);
  return model && opts.some((o) => o.value === model) ? model : opts[0].value;
}

// The model to PERSIST: heal a non-empty model that is not valid for the
// backend (the #931 bug — the old hardcoded dropdown could save a Claude model
// onto a codex/gemini agent, which the spawn path then forwards as an invalid
// `-c model=` / `--model`). "" is kept as-is — it means "use the CLI default",
// which is valid for every CLI, so we never clobber a deliberate default.
export function sanitizeModel(backend: string, model: string | undefined) {
  if (!model) return model ?? "";
  const opts = modelsForBackend(backend);
  return opts.some((o) => o.value === model) ? model : opts[0].value;
}
