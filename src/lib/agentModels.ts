// #343/#367/#931/#1172: backend-specific model catalog + the helpers that keep
// a per-agent model valid for its CLI. Kept as pure data + logic (NO React) so
// it is shared by AgentModelsWidget + SettingsPage AND can be unit-tested
// directly under node (see server/agentModels.test.js).
//
// Empty string = "use the CLI's own default" (no -c / --model flag passed at
// all) — valid for every CLI, and what a new or unset agent runs on.
//
// #1172: the lists below are only the SHIPPED FALLBACK. When a CLI has its own
// discovery source (today: `codex debug models`, via GET
// /api/agent-model-catalog → server/agent-model-catalog.js) its discovered list
// replaces the shipped one, so a new model is selectable without a QuadWork
// release. Backends without a discovery source (claude, gemini, grok) use the
// shipped list; any other id can be entered by hand in both surfaces.
export const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  // #1172: refreshed from `codex debug models` (visibility "list", codex-cli
  // 0.153.1). gpt-5.4 / gpt-5 / gpt-4o were dropped — the CLI no longer lists
  // them; an agent still saved on one keeps it and is flagged as not offered.
  codex: [
    { value: "", label: "(CLI default)" },
    { value: "gpt-6-astra", label: "gpt-6-astra" },
    { value: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { value: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    { value: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    { value: "gpt-daybreak-blue-latest", label: "gpt-daybreak-blue-latest" },
    { value: "gpt-5.5", label: "gpt-5.5" },
  ],
  claude: [
    { value: "", label: "(CLI default)" },
    // #841/#1172: CLI-documented aliases (`claude --help` → "an alias for the
    // latest model (e.g. 'fable', 'opus', or 'sonnet')"). They auto-track new
    // releases without a QuadWork update; the pins below are for operators who
    // want a specific version locked in. Claude has no model-listing command.
    { value: "fable", label: "fable (latest)" },
    { value: "opus", label: "opus (latest)" },
    { value: "sonnet", label: "sonnet (latest)" },
    { value: "claude-fable-5", label: "claude-fable-5" },
    { value: "claude-opus-5-5", label: "claude-opus-5-5" },
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
  // #1023: xAI Grok Build CLI. `grok models` on an authenticated account lists
  // exactly one model, which is also the CLI's default; there is no
  // "latest"-style alias, so the "" row is the only auto-tracking mechanism.
  grok: [
    { value: "", label: "(CLI default)" },
    { value: "grok-4.5", label: "grok-4.5" },
  ],
};

// #1172: the one accepted model-id shape. It excludes quotes, whitespace and a
// leading "-", so an id can never break Codex's `-c model="<id>"` quoting or be
// read as a flag. server/agent-model-catalog.js carries the same pattern for
// the write routes and the spawn path (Node can't load this .ts there);
// server/agentModels.test.js asserts the two are identical.
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function isValidModelId(id: unknown): id is string {
  return typeof id === "string" && MODEL_ID_PATTERN.test(id);
}

// Discovered model ids per backend (command basename), as returned by
// GET /api/agent-model-catalog `models`. A backend absent here uses its
// shipped list.
export type DiscoveredModels = Record<string, string[]>;

// Raw option list for a backend (includes the "" CLI-default row). A discovered
// list replaces the shipped one; unknown backends fall back to a single
// CLI-default row.
export function optionsForBackend(backend: string, discovered?: DiscoveredModels) {
  const found = discovered?.[backend];
  if (found && found.length > 0) {
    return [{ value: "", label: "(CLI default)" }, ...found.map((id) => ({ value: id, label: id }))];
  }
  return MODEL_OPTIONS[backend] || [{ value: "", label: "(CLI default)" }];
}

// Every id QuadWork knows for a backend: shipped ∪ discovered.
function knownFor(backend: string, discovered?: DiscoveredModels) {
  return new Set([
    ...(MODEL_OPTIONS[backend] || []).map((o) => o.value),
    ...(discovered?.[backend] || []),
  ].filter((v) => v !== ""));
}

// The model to PERSIST (and display in Settings, so what is shown is what a
// save writes). #1172 heal rule, replacing the #931 first-option heal:
//   - "" / unset stays "" (CLI default);
//   - a model known for a different backend (shipped or discovered) and not
//     for this one heals to "" (e.g. a Claude "sonnet" left on a codex agent);
//   - anything else is kept as-is — never silently rewritten. If the backend
//     does not list it, `modelChoices` flags it.
export function sanitizeModel(backend: string, model: string | undefined | null, discovered?: DiscoveredModels) {
  if (!model) return "";
  if (knownFor(backend, discovered).has(model)) return model;
  const backends = new Set([...Object.keys(MODEL_OPTIONS), ...Object.keys(discovered || {})]);
  for (const other of backends) {
    if (other !== backend && knownFor(other, discovered).has(model)) return "";
  }
  return model;
}

// Sentinel <option> value for "enter a model id by hand". Starts with "_", so
// it can never collide with a valid model id.
export const CUSTOM_MODEL_VALUE = "__custom__";

export type ModelChoiceFlag = "not_offered" | "invalid";

// The <select> rows for one agent, shared by both surfaces: the CLI-default
// row, the backend's listed models, and — if the saved model is not listed —
// that saved model kept selectable with a flag ("not_offered" when it is a
// well-formed id the CLI does not list, "invalid" when it fails
// MODEL_ID_PATTERN and would be refused on save / at spawn).
export function modelChoices(backend: string, saved: string | undefined | null, discovered?: DiscoveredModels) {
  const rows: { value: string; label: string; flag?: ModelChoiceFlag }[] = [...optionsForBackend(backend, discovered)];
  if (saved && !rows.some((o) => o.value === saved)) {
    rows.push({ value: saved, label: saved, flag: isValidModelId(saved) ? "not_offered" : "invalid" });
  }
  return rows;
}
