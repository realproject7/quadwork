"use strict";

// #1176: SettingsPage's real handlers, run without a DOM library (the
// ts.transpileModule precedent in server/terminalLifecycleControls.test.js).
// The component runs with in-memory hooks and a fetch double serving a fixture
// config; each check reads the rendered element tree or the PATCH /api/config
// body Save sends. Nothing is matched against source text, so a
// formatting-only change to the component cannot break these tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { CUSTOM_MODEL_VALUE } = require("../src/lib/agentModels.ts");

const FILE = path.join(__dirname, "../src/components/SettingsPage.tsx");
const JS = ts.transpileModule(fs.readFileSync(FILE, "utf8"), {
  fileName: FILE,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Real shared modules; stand-ins only for the Next.js runtime and two child
// components these checks never render. mount() stands in for the locale context.
const DEPENDENCIES = {
  "react/jsx-runtime": () => require("react/jsx-runtime"),
  "next/navigation": () => ({ useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => ({ get: () => null }) }),
  "@/lib/agentModels": () => require("../src/lib/agentModels.ts"),
  "@/lib/injectMode": () => require("../src/lib/injectMode.js"),
  "@/lib/idle": () => require("../src/lib/idle.ts"),
  "./ActiveSwitch": () => ({ default: () => null }),
  "./ConfirmModal": () => ({ default: () => null }),
};

function* walk(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!node || typeof node !== "object") return;
  yield node;
  yield* walk(node.props && node.props.children);
}
const find = (node, match) => { for (const n of walk(node)) if (match(n)) return n; return undefined; };
const text = (node) => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && node.props ? text(node.props.children) : "";
};
const hasOption = (select, value) => [...walk(select.props.children)].some((n) => n.type === "option" && n.props.value === value);
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };

// Mounts Settings on `config` (GET /api/config) and runs its mount effects.
// #1183: `locale` and `archiveReply` (the archive route's response) are optional.
async function mount(config, { locale = "en", archiveReply = null } = {}) {
  const cells = [];
  let cursor = 0;
  let effects = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], (value) => { cells[index] = typeof value === "function" ? value(cells[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => { effects.push(fn); },
  };
  const requests = [];
  const respond = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === "/api/config" && !options.method) return respond(JSON.parse(JSON.stringify(config)));
    if (url === "/api/cli-status") return respond({ claude: true, codex: true, gemini: true, grok: true });
    if (url === "/api/agent-model-catalog") return respond({ models: {}, errors: {} });
    if (/^\/api\/projects\/[^/]+\/archive$/.test(url)) {
      return archiveReply ? archiveReply(JSON.parse(options.body)) : respond({ ok: true, archived: JSON.parse(options.body).archived });
    }
    return respond({ ok: true });
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", "fetch", JS)((name) => {
    if (name === "react") return hooks;
    if (name === "@/components/LocaleProvider") return { useLocale: () => ({ locale, setLocale() {} }) };
    if (DEPENDENCIES[name]) return DEPENDENCIES[name]();
    throw new Error(`Unexpected dependency ${name}`);
  }, mod, mod.exports, fetch);
  const render = () => { cursor = 0; return mod.exports.default(); };
  render();
  const onMount = effects;
  effects = [];
  for (const effect of onMount) effect();
  await flush();
  return {
    render,
    patches: () => requests.filter((r) => r.url === "/api/config" && r.options.method === "PATCH").map((r) => JSON.parse(r.options.body)),
    agentRow: (projectId, agentId) => find(find(render(), (n) => n.props && n.props.id === `project-${projectId}`), (n) => n.key === agentId),
    save: async () => { await find(render(), (n) => n.type === "button" && text(n) === "Save").props.onClick(); await flush(); },
  };
}
const commandSelect = (row) => find(row, (n) => n.type === "select" && hasOption(n, "claude") && hasOption(n, "codex"));
const modelSelect = (row) => find(row, (n) => n.type === "select" && hasOption(n, CUSTOM_MODEL_VALUE));
const saveError = (tree) => find(tree, (n) => n.props && n.props.role === "alert" && /Not saved/.test(text(n)));

const agent = (command, model, extra = {}) => ({ display_name: "", command, cwd: "/w", model, agents_md: "", ...extra });

test("#1172 AC5 / #1176: changing an agent's command resets its model to the CLI default", async () => {
  const ui = await mount({ port: 8400, projects: [{ id: "p1", name: "p1", agents: {
    dev: agent("codex", "my-proxy/gpt-x", { mcp_inject: "proxy_flag" }),
    head: agent("claude", "opus", { mcp_inject: "flag" }),
  } }] });
  assert.equal(modelSelect(ui.agentRow("p1", "dev")).props.value, "my-proxy/gpt-x", "fixture: the hand-entered model is shown");

  commandSelect(ui.agentRow("p1", "dev")).props.onChange({ target: { value: "claude" } });
  commandSelect(ui.agentRow("p1", "head")).props.onChange({ target: { value: "grok" } });
  assert.equal(commandSelect(ui.agentRow("p1", "dev")).props.value, "claude");
  assert.equal(modelSelect(ui.agentRow("p1", "dev")).props.value, "", "the model select shows (CLI default)");
  assert.equal(modelSelect(ui.agentRow("p1", "head")).props.value, "", "a pinned model is reset too, not carried to the new CLI");

  await ui.save();
  const [body] = ui.patches();
  // The save-time heal keeps a hand-entered id, so only the reset clears it.
  assert.deepEqual(
    { command: body.projects[0].agents.dev.command, model: body.projects[0].agents.dev.model, mcp_inject: body.projects[0].agents.dev.mcp_inject },
    { command: "claude", model: "", mcp_inject: "flag" });
  assert.equal(body.projects[0].agents.head.model, "");
});

test("#1176: an archived project's invalid model gets a notice, never blocks Save, and is never sent", async () => {
  const ui = await mount({ port: 8400, projects: [
    { id: "p1", name: "p1", agents: {
      dev: agent("claude", "opus", { mcp_inject: "flag" }),
      re1: agent("codex", "sonnet", { mcp_inject: "proxy_flag" }),
    } },
    { id: "arch", name: "Old Project", archived: true, agents: {
      dev: agent("codex", 'bad"id', { mcp_inject: "flag" }),
      head: agent("codex", "sonnet", { mcp_inject: "flag" }),
    } },
  ] });
  const notice = () => find(find(ui.render(), (n) => n.key === "arch" && n.type === "div"), (n) => n.props && n.props.role === "status");
  assert.ok(notice(), "the archived row shows a notice");
  assert.match(text(notice()), /Old Project\/dev/, "the notice names the project and the agent");
  assert.doesNotMatch(text(notice()), /Old Project\/head/, "only the invalid agent is named");

  await ui.save();
  assert.equal(saveError(ui.render()), undefined, "Save is not blocked");
  const [body] = ui.patches();
  assert.ok(body, "Save sent the PATCH");
  assert.deepEqual(body.projects.map((p) => p.id), ["p1"],
    "the archived project is not in the body, so PATCH /api/config leaves its stored agents unchanged (no rewrite, no heal)");
  assert.equal(body.projects[0].agents.re1.model, "", "an active project is still healed (a Claude model left on codex)");
  assert.ok(notice(), "the notice stays after Save: the archived agents were not rewritten");

  // Restored after that Save, the project shows its agents as stored.
  await find(find(ui.render(), (n) => n.key === "arch" && n.type === "div"), (n) => n.type === "button" && text(n) === "Restore").props.onClick();
  assert.equal(modelSelect(ui.agentRow("arch", "head")).props.value, "sonnet", "the leftover was not healed in Settings either");
  assert.equal(modelSelect(ui.agentRow("arch", "dev")).props.value, 'bad"id');
});

test("#1176: an edit made before archiving is not recorded as saved", async () => {
  const ui = await mount({ port: 8400, projects: [
    { id: "p1", name: "p1", agents: { dev: agent("claude", "opus", { mcp_inject: "flag" }) } },
    { id: "p2", name: "p2", agents: { dev: agent("codex", "", { mcp_inject: "proxy_flag" }) } },
  ] });
  modelSelect(ui.agentRow("p1", "dev")).props.onChange({ target: { value: "sonnet" } });
  assert.equal(modelSelect(ui.agentRow("p1", "dev")).props.value, "sonnet", "fixture: the unsaved edit is shown");
  const button = (container, label) => find(container, (n) => n.type === "button" && text(n) === label);
  await button(find(ui.render(), (n) => n.props && n.props.id === "project-p1"), "Archive").props.onClick();

  await ui.save();
  assert.deepEqual(ui.patches()[0].projects.map((p) => p.id), ["p2"], "the archived project is not sent");
  await button(find(ui.render(), (n) => n.key === "p1" && n.type === "div"), "Restore").props.onClick();
  assert.equal(modelSelect(ui.agentRow("p1", "dev")).props.value, "opus",
    "after restore Settings shows the stored model, not the edit Save never sent");
});

test("#1176: an invalid model on an active project still blocks Save and names it", async () => {
  const ui = await mount({ port: 8400, projects: [
    { id: "p1", name: "p1", agents: { dev: agent("claude", 'bad"id', { mcp_inject: "flag" }) } },
    { id: "arch", name: "Old Project", archived: true, agents: { dev: agent("codex", 'bad"id') } },
  ] });
  await ui.save();
  assert.equal(ui.patches().length, 0, "nothing is sent");
  assert.match(text(saveError(ui.render())), /invalid model id for p1\/dev\./, "the error names only the active agent");
});

test("#1183: a restored project whose chat did not start shows Settings copy in the operator's language", async () => {
  // The archive route's reply when the restore commits but the chat does not
  // start. The raw message stands in for server text Settings must not show.
  const reply = () => ({ ok: false, status: 503, json: async () => ({
    ok: false,
    project_id: "arch",
    archived: false,
    already_unarchived: false,
    admission_generation: 2,
    resources: {},
    code: "project_cleanup_incomplete",
    cleanup_errors: [{ resource: "file_chat", code: "file_chat_start_failed", message: "raw server message" }],
  }) });
  for (const [locale, restoreLabel, copy] of [
    ["en", "Restore", "Project chat did not start. Archive and restore the project to retry. If it keeps failing, check the project's chat files. Restarting QuadWork will fail until the cause is fixed."],
    ["ko", "복원", "프로젝트 채팅을 시작하지 못했습니다. 프로젝트를 보관한 뒤 다시 복원해 재시도하세요. 계속 실패하면 프로젝트의 채팅 파일을 확인하세요. 원인을 해결하기 전에는 QuadWork를 재시작해도 실행되지 않습니다."],
  ]) {
    const ui = await mount({ port: 8400, projects: [
      { id: "arch", name: "Old Project", archived: true, agents: { dev: agent("claude", "opus", { mcp_inject: "flag" }) } },
    ] }, { locale, archiveReply: reply });
    const archivedRow = find(ui.render(), (n) => n.key === "arch" && n.type === "div");
    await find(archivedRow, (n) => n.type === "button" && text(n) === restoreLabel).props.onClick();
    const row = find(ui.render(), (n) => n.props && n.props.id === "project-arch");
    assert.ok(row, `${locale}: the committed restore moves the project back to the active list`);
    const alert = find(row, (n) => n.props && n.props.role === "alert");
    assert.equal(text(alert), `file_chat [file_chat_start_failed]: ${copy}`,
      `${locale}: the failed chat start is shown in the operator's language, with its safe retry`);
  }
});
