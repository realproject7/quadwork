// #931/#1172: the per-agent model helpers shared by the Settings page and the
// Agent Models modal (src/lib/agentModels.ts). #931 routed both surfaces
// through these helpers; #1172 replaced the first-option display/heal with the
// CLI-default display, the cross-backend heal rule, the stale-model flag, the
// CLI-discovered list and model-id validation. Plain node:assert script (run
// via server/run-tests.js).
//
// Node strips the TS types at require-time, so we can exercise the real shared
// module the components use — no duplicated logic, no transpile step.

const fs = require("fs");
const path = require("path");
const {
  MODEL_OPTIONS,
  isValidModelId,
  optionsForBackend,
  modelChoices,
  sanitizeModel,
  CUSTOM_MODEL_VALUE,
  MODEL_FLAG_COPY,
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
const values = (rows) => rows.map((o) => o.value);

// ── optionsForBackend: shipped lists incl. the "" CLI-default row ──
ok(optionsForBackend("codex")[0].value === "", "optionsForBackend(codex) starts with the (CLI default) row");
ok(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].every((s) => values(optionsForBackend("codex")).includes(s)),
  "#1172: shipped codex list matches what `codex debug models` lists (incl. gpt-6-astra, gpt-5.5)");
ok(!["gpt-5.4", "gpt-5", "gpt-4o"].some((s) => values(optionsForBackend("codex")).includes(s)),
  "#1172: shipped codex list drops gpt-5.4 / gpt-5 / gpt-4o, which the CLI no longer lists");
ok(["fable", "opus", "sonnet", "claude-opus-5-5", "claude-opus-5", "claude-fable-5"].every((s) => values(optionsForBackend("claude")).includes(s)),
  "#1172: shipped claude list has the documented fable/opus/sonnet aliases and the claude-opus-5-5 pin");
ok(optionsForBackend("nope").length === 1 && optionsForBackend("nope")[0].value === "", "optionsForBackend(unknown) → single CLI-default row");
ok(optionsForBackend("grok")[0].value === "" && values(optionsForBackend("grok")).includes("grok-4.5"), "#1023: grok is (CLI default) + grok-4.5");

// ── AC1: a discovered model QuadWork has never heard of is selectable ──
const discovered = { codex: ["gpt-7-nova", "gpt-6-astra"] };
ok(values(optionsForBackend("codex", discovered)).join(",") === ",gpt-7-nova,gpt-6-astra",
  "#1172 AC1: a discovered list replaces the shipped one ((CLI default) row first)");
ok(values(modelChoices("codex", "", discovered)).includes("gpt-7-nova"),
  "#1172 AC1: an unknown discovered model (gpt-7-nova) is a selectable row");
ok(values(optionsForBackend("claude", discovered)).join(",") === values(MODEL_OPTIONS.claude).join(","),
  "#1172 AC1: a backend with no discovery result uses the shipped list");
ok(values(optionsForBackend("codex", { codex: [] })).join(",") === values(MODEL_OPTIONS.codex).join(","),
  "#1172 AC8: an empty discovered list falls back to the shipped list");

// ── AC4: an unset model is shown as the CLI default ──
ok(sanitizeModel("codex", null) === "", "#1172 AC4: a null model displays as '' (CLI default), not gpt-5.4");
ok(sanitizeModel("claude", undefined) === "", "#1172 AC4: an undefined model displays as '' (CLI default), not opus");
ok(modelChoices("codex", "")[0].value === "" && modelChoices("codex", "")[0].label === "(CLI default)",
  "#1172 AC4: the CLI-default row is always offered (can be chosen)");
ok(modelChoices("codex", "").every((o) => !o.flag), "#1172 AC4: an unset model adds no flagged row");

// ── Untouched save keeps an unset model unset (regression guard) ──
ok(sanitizeModel("codex", "") === "", "sanitizeModel keeps '' (CLI default) — never clobbered");
ok(sanitizeModel("gemini", undefined) === "", "sanitizeModel maps undefined → '' (CLI default), not a fabricated model");
ok(sanitizeModel("grok", "") === "", "#1023: sanitizeModel keeps '' on grok");

// ── AC6: heal rule ──
ok(sanitizeModel("codex", "sonnet") === "", "#1172 AC6: a Claude 'sonnet' on a codex agent heals to the CLI default (not gpt-5.4)");
ok(sanitizeModel("gemini", "opus") === "", "#1172 AC6: a Claude model on a gemini agent heals to the CLI default");
ok(sanitizeModel("grok", "sonnet") === "", "#1172 AC6: a Claude model on a grok agent heals to the CLI default");
ok(sanitizeModel("claude", "gpt-7-nova", discovered) === "", "#1172 AC6: a model known only from discovery for codex heals on a claude agent");
ok(sanitizeModel("claude", "gpt-7-nova") === "gpt-7-nova", "#1172 AC6: without that discovery it is unknown everywhere, so it is kept");
ok(sanitizeModel("codex", "gpt-5.6-terra") === "gpt-5.6-terra", "sanitizeModel keeps a listed codex model");
ok(sanitizeModel("codex", "gpt-5.6-terra", discovered) === "gpt-5.6-terra",
  "#1172 AC6: a shipped codex model the discovery omits is still known for codex → kept, not healed");
ok(sanitizeModel("claude", "claude-opus-5") === "claude-opus-5", "#1018: a saved claude-opus-5 pin is kept (never healed to the alias)");
ok(sanitizeModel("codex", "gpt-5.4") === "gpt-5.4", "#1172 AC6: an unlisted id known for no backend (gpt-5.4) is kept, never rewritten");
ok(sanitizeModel("codex", "my-proxy/gpt-x") === "my-proxy/gpt-x", "#1172 AC6: a hand-entered id is kept");

// ── AC6: stale-model flag ──
{
  const rows = modelChoices("codex", "gpt-5.4");
  const stale = rows.find((o) => o.value === "gpt-5.4");
  ok(stale && stale.flag === "not_known",
    "#1172 AC6: a kept unlisted model stays selectable; with no discovered list it is flagged not_known (the CLI was not checked)");
  ok(rows.filter((o) => o.flag).length === 1, "#1172 AC6: only the stale row is flagged");
  ok(modelChoices("codex", "gpt-5.4", discovered).find((o) => o.value === "gpt-5.4").flag === "not_offered",
    "#1172 AC6: when discovery for the backend succeeded, an unlisted model is flagged not_offered");
  ok(modelChoices("codex", "gpt-5.4", { grok: ["grok-5"] }).find((o) => o.value === "gpt-5.4").flag === "not_known",
    "#1172 AC6: discovery for another backend does not make this one 'not offered'");
  ok(modelChoices("claude", "my-model").find((o) => o.value === "my-model").flag === "not_known",
    "#1172 AC6: a backend with no discovery source flags an unlisted model not_known");
  {
    const leftover = modelChoices("codex", "sonnet").find((o) => o.value === "sonnet");
    ok(leftover && leftover.flag === "other_backend",
      "#1172 AC6: a cross-backend leftover (sonnet on codex) is shown as-is, flagged other_backend (not displayed as healed)");
  }
  ok(/another CLI/.test(MODEL_FLAG_COPY.en.other_backend) && /Save/.test(MODEL_FLAG_COPY.en.other_backend) && /CLI default/.test(MODEL_FLAG_COPY.en.other_backend),
    "#1172: the other_backend flag says it is another CLI's model and that Save resets it to the CLI default");
  ok(MODEL_FLAG_COPY.en.not_offered === "(not offered by CLI)" && MODEL_FLAG_COPY.en.not_known === "(not in the known list)",
    "#1172: 'not offered by CLI' only for a checked CLI, 'not in the known list' otherwise");
  ok(Object.keys(MODEL_FLAG_COPY.en).sort().join() === Object.keys(MODEL_FLAG_COPY.ko).sort().join(), "#1172: every flag has en + ko copy");
  ok(!values(optionsForBackend("codex")).includes("gpt-5.4"), "#1172: modelChoices never mutates the shipped list");
  ok(!modelChoices("codex", "gpt-7-nova", discovered).some((o) => o.flag), "#1172: a discovered model is not flagged");
  ok(modelChoices("codex", "gpt-6-astra", discovered).find((o) => o.value === "gpt-6-astra").flag === undefined,
    "#1172: a listed saved model is not duplicated or flagged");
  ok(modelChoices("codex", 'gpt"x').find((o) => o.value === 'gpt"x').flag === "invalid",
    "#1172: a saved id failing MODEL_ID_PATTERN is flagged invalid");
}

// ── AC2/AC3: model-id validation ──
ok(isValidModelId("gpt-5.6-terra") && isValidModelId("claude-opus-5-5") && isValidModelId("org/model:v1@2"),
  "#1172 AC2: well-formed ids are accepted (incl. . _ : / @ -)");
ok(isValidModelId("a") && isValidModelId("a".repeat(128)) && !isValidModelId("a".repeat(129)), "#1172 AC2: 1–128 chars");
ok(!isValidModelId('gpt"5'), "#1172 AC3: a quote is rejected");
ok(!isValidModelId("-rf") && !isValidModelId("--model"), "#1172 AC3: a leading '-' is rejected");
ok(!isValidModelId("gpt 5") && !isValidModelId(" gpt-5") && !isValidModelId("gpt-5\n") && !isValidModelId("gpt\t5"),
  "#1172 AC3: whitespace is rejected");
ok(!isValidModelId("") && !isValidModelId(null) && !isValidModelId(5), "#1172 AC3: empty / non-string is not a model id");
ok(!isValidModelId(CUSTOM_MODEL_VALUE), "#1172: the Other… sentinel can never collide with a valid id");
ok(Object.values(MODEL_OPTIONS).flat().every((o) => o.value === "" || isValidModelId(o.value)), "#1172: every shipped id is well-formed");

// ── Wiring: both surfaces use the shared helpers (source assertions) ──
{
  const settings = fs.readFileSync(path.join(__dirname, "..", "src", "components", "SettingsPage.tsx"), "utf8");
  const modal = fs.readFileSync(path.join(__dirname, "..", "src", "components", "AgentModelsWidget.tsx"), "utf8");
  ok(!/effectiveModel|modelsForBackend/.test(settings), "#1172 AC4: Settings no longer renders the first concrete option for an unset model");
  ok(/const command = e\.target\.value;\s*setCustomModel\([^;]*\);\s*updateAgent\(idx, agentId, \{\s*command,\s*model: "",/.test(settings),
    "#1172 AC5: changing an agent's command resets its model to '' (CLI default)");
  ok(settings.includes("modelChoices(") && settings.includes("CUSTOM_MODEL_VALUE") && settings.includes('fetch("/api/agent-model-catalog")'),
    "#1172 AC1/AC2: Settings lists discovered models and offers hand entry");
  ok(settings.includes("sanitizeModel(cliBaseFromCommand(a.command), a.model, discoveredModels)") && settings.includes("setSaveError(t.invalidModelIds("),
    "#1172 AC3/AC6: Settings save applies the heal rule and refuses an invalid id");
  ok(settings.includes(": agent.model || \"\"}") && settings.includes("modelChoices(cliBaseFromCommand(agent.command), agent.model, discoveredModels)"),
    "#1172: the Settings select shows the raw saved model (what the agent runs), like the modal");
  ok(settings.includes("throw new Error(data.error || `Save failed (${res.status})`)") && settings.includes("setSaveError((err as Error).message)"),
    "#1172: a server-rejected Settings save shows the server's error in the saveError UI");
  ok(modal.includes("if (await update(row.agent_id, { model: id })) setCustomFor(null);"),
    "#1172: a rejected Other… id keeps the input (and its typed text) open");
  ok(settings.includes("${t[m.flag]}") && modal.includes("${t[opt.flag]}") && settings.includes("...MODEL_FLAG_COPY.en") && modal.includes("...MODEL_FLAG_COPY.en"),
    "#1172: both surfaces render the same shared flag wording");
  ok(modal.includes("modelChoices(row.backend, row.model, discovered)") && modal.includes("CUSTOM_MODEL_VALUE") && modal.includes('fetch("/api/agent-model-catalog")'),
    "#1172 AC1/AC2/AC4: the modal lists discovered models, keeps the CLI-default row and offers hand entry");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
