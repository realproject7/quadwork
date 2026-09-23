// #343/#367/#931/#1172: backend-specific model catalog + the helpers that keep
// a per-agent model valid for its CLI. Kept as pure data + logic (NO React) so
// it is shared by AgentModelsWidget + SettingsPage AND can be unit-tested
// directly under node (see server/agentModels.test.js).
//
// Empty string = "use the CLI's own default" (no -c / --model flag passed at
// all) — valid for every CLI, and what a new or unset agent runs on.
//
// #1172: the lists below are only the SHIPPED FALLBACK. When a CLI has its own
// discovery source (today: `codex debug models` and `grok models`, via GET
// /api/agent-model-catalog → server/agent-model-catalog.js) its discovered list
// replaces the shipped one, so a new model is selectable without a QuadWork
// release. Backends without a discovery source (claude, gemini) use the
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
  // #1023: xAI Grok Build CLI. There is no "latest"-style alias. #1172: this
  // row is the fallback; `grok models` discovery supplies the live list.
  grok: [
    { value: "", label: "(CLI default)" },
    { value: "grok-4.5", label: "grok-4.5" },
  ],
};

// #1172: the one accepted model-id shape lives in the plain-JS modelId.js,
// shared with the server's write routes and spawn path.
import { isValidModelId } from "./modelId.js";
export { MODEL_ID_PATTERN, isValidModelId } from "./modelId.js";

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

// Why a saved model is not one of the backend's listed rows:
//   - "other_backend": known for a different CLI and not this one; a Settings
//     save heals it to "" (CLI default) — see sanitizeModel;
//   - "invalid": fails MODEL_ID_PATTERN; refused on save and never spawned;
//   - "not_offered": discovery for this backend succeeded and did not list it;
//   - "not_known": no discovered list for this backend (no discovery source,
//     discovery failed, or still loading) and the shipped list lacks it — the
//     CLI was not checked, so nothing is claimed about what it offers.
export type ModelChoiceFlag = "other_backend" | "invalid" | "not_offered" | "not_known";

// The <select> rows for one agent, shared by both surfaces: the CLI-default
// row, the backend's listed models, and — if the saved model is not listed —
// that saved model, kept selectable (the surfaces show what the agent actually
// runs) with a ModelChoiceFlag.
export function modelChoices(backend: string, saved: string | undefined | null, discovered?: DiscoveredModels) {
  const rows: { value: string; label: string; flag?: ModelChoiceFlag }[] = [...optionsForBackend(backend, discovered)];
  if (saved && !rows.some((o) => o.value === saved)) {
    const flag: ModelChoiceFlag = !isValidModelId(saved)
      ? "invalid"
      : sanitizeModel(backend, saved, discovered) === ""
        ? "other_backend"
        : (discovered?.[backend]?.length ?? 0) > 0 ? "not_offered" : "not_known";
    rows.push({ value: saved, label: saved, flag });
  }
  return rows;
}

// Flag suffixes, keyed by ModelChoiceFlag. One copy for both surfaces so the
// Settings row and the Agent Models modal say the same thing.
export const MODEL_FLAG_COPY: Record<"en" | "ko", Record<ModelChoiceFlag, string>> = {
  en: {
    other_backend: "(another CLI's model; Save in Settings resets it to CLI default)",
    invalid: "(invalid id)",
    not_offered: "(not offered by CLI)",
    not_known: "(not in the known list)",
  },
  ko: {
    other_backend: "(다른 CLI의 모델, 설정에서 저장하면 CLI 기본값으로 재설정)",
    invalid: "(잘못된 ID)",
    not_offered: "(CLI 목록에 없음)",
    not_known: "(알려진 목록에 없음)",
  },
};
