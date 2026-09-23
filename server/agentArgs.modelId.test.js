"use strict";

// #1172: model ids through the real server — the agent-models PUT route, the
// spawn path (buildAgentArgs) and GET /api/agent-model-catalog.
//
// A temp HOME holds the config, and a fake `codex` and `grok` placed first on
// PATH stand in for the provider CLIs: each prints a `codex debug models` /
// `grok models`-shaped fixture and appends to a marker file on every run, so
// the test can prove when discovery ran (the catalog route) and when it did
// not (the spawn path). No real provider CLI is started. The Settings save
// path (PATCH /api/config) is driven through the same app. QUADWORK_SKIP_LISTEN keeps the server port unbound;
// the app is mounted on an ephemeral port instead.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-model-id-"));
const FAKE_BIN = path.join(TMP_HOME, "bin");
const MARKER = path.join(TMP_HOME, "codex-runs.log");
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";

const SHIM = process.platform !== "win32";
if (SHIM) {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  const fixture = JSON.stringify({ models: [
    { slug: "gpt-7-nova", visibility: "list" },
    { slug: "gpt-hidden", visibility: "hide" },
  ] });
  const grokFixture = "You are not authenticated.\n\nDefault model: grok-5\n\nAvailable models:\n  * grok-5 (default)\n  * grok-4.5\n";
  for (const [cli, out] of [["codex", fixture], ["grok", grokFixture]]) {
    fs.writeFileSync(path.join(FAKE_BIN, cli),
      `#!${process.execPath}\n` +
      `require("fs").appendFileSync(${JSON.stringify(MARKER)}, ${JSON.stringify(cli + " ")} + process.argv.slice(2).join(" ") + "\\n");\n` +
      `process.stdout.write(${JSON.stringify(out)});\n`,
      { mode: 0o755 });
  }
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH}`;
}

const CONFIG_PATH = path.join(TMP_HOME, ".quadwork", "config.json");
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  port: 8400,
  projects: [{
    id: "p1",
    working_dir: path.join(TMP_HOME, "p1"),
    agents: {
      head: { command: "codex" },
      dev: { command: "claude" },
      re1: { command: "/opt/tools/bin/codex --profile x" },
      codex_valid: { command: "codex", model: "gpt-5.6-terra" },
      codex_quote: { command: "codex", model: 'gpt"; rm -rf ~; "' },
      codex_dash: { command: "codex", model: "-c" },
      codex_space: { command: "codex", model: "gpt 5" },
      claude_dash: { command: "claude", model: "--dangerously-skip-permissions" },
      claude_space: { command: "claude", model: "opus --print" },
      claude_valid: { command: "claude", model: "claude-opus-5-5" },
      gemini_quote: { command: "gemini", model: 'x"y' },
      grok_valid: { command: "grok", model: "grok-4.5" },
    },
  }, {
    // Settings-save (PATCH) fixture: only well-formed models.
    id: "p2",
    name: "p2",
    working_dir: path.join(TMP_HOME, "p2"),
    agents: { head: { command: "codex", model: "gpt-5.5" }, dev: { command: "claude" } },
  }],
}));

const { buildAgentArgs, app } = require("./index");

let passed = 0;
let failed = 0;
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`  PASS: ${m}`);
  } else {
    failed++;
    console.error(`  FAIL: ${m}`);
  }
};
const readCfg = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const markerRuns = () => (fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf-8").split("\n").filter(Boolean) : []);
const modelArg = (args) => { const i = args.indexOf("--model"); return i >= 0 ? args[i + 1] : undefined; };
const codexModelArgs = (args) => args.filter((a) => /^model=/.test(a));

function req(server, { method = "GET", urlPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port: server.address().port, method, path: urlPath,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {} },
    (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || "null") })); });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  // ── AC3: spawn never passes an invalid stored id ──
  {
    const { args } = await buildAgentArgs("p1", "codex_valid");
    ok(codexModelArgs(args).join() === 'model="gpt-5.6-terra"', "AC3: a valid codex id is passed as -c model=\"<id>\"");
  }
  for (const agent of ["codex_quote", "codex_dash", "codex_space"]) {
    const { args } = await buildAgentArgs("p1", agent);
    ok(codexModelArgs(args).length === 0, `AC3: codex ${agent.replace("codex_", "")} id is not passed (CLI default)`);
    ok(args.includes("--dangerously-bypass-approvals-and-sandbox"), `AC3: ${agent} still spawns with its permission flag`);
  }
  for (const agent of ["claude_dash", "claude_space", "gemini_quote"]) {
    const { args } = await buildAgentArgs("p1", agent);
    ok(!args.includes("--model"), `AC3: ${agent} → no --model (invalid id never read as a flag)`);
  }
  ok(modelArg((await buildAgentArgs("p1", "claude_valid")).args) === "claude-opus-5-5", "AC3: a valid claude id is passed as --model <id>");
  ok(modelArg((await buildAgentArgs("p1", "grok_valid")).args) === "grok-4.5", "AC3: a valid grok id is passed as --model <id>");
  ok(codexModelArgs((await buildAgentArgs("p1", "head")).args).length === 0, "an unset codex model passes no -c model= (CLI default)");

  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    // ── AC3: the PUT route rejects ids outside MODEL_ID_PATTERN ──
    const put = (agentId, body) => req(server, { method: "PUT", urlPath: `/api/project/p1/agent-models/${agentId}`, body });
    for (const bad of ['gpt"5', "-rf", "--model", "gpt 5", "a".repeat(129)]) {
      const r = await put("dev", { model: bad });
      ok(r.body.ok === false && /Invalid model id/.test(r.body.error), `AC3: PUT rejects ${JSON.stringify(bad.slice(0, 12))}`);
      ok(readCfg().projects[0].agents.dev.model === undefined, `AC3: a rejected ${JSON.stringify(bad.slice(0, 12))} is not persisted`);
    }
    {
      const r = await put("dev", { model: "claude-opus-5-5" });
      ok(r.body.ok === true && readCfg().projects[0].agents.dev.model === "claude-opus-5-5", "AC2/AC3: PUT persists a valid id");
      const r2 = await put("dev", { model: "  my-org/custom:v2@1  " });
      ok(r2.body.ok === true && readCfg().projects[0].agents.dev.model === "my-org/custom:v2@1", "AC2: PUT persists a trimmed hand-entered id");
      const r3 = await put("dev", { model: "" });
      ok(r3.body.ok === true && readCfg().projects[0].agents.dev.model === undefined, "AC4: PUT '' returns the agent to the CLI default");
    }
    {
      const r = await req(server, { urlPath: "/api/project/p1/agent-models" });
      const row = (id) => r.body.agents.find((a) => a.agent_id === id);
      ok(row("head").backend === "codex" && row("head").model === "", "AC4: GET reports an unset model as '' (CLI default)");
      ok(row("re1").backend === "codex", "AC7: GET keys a path-qualified command by its basename (cliBaseFromCommand)");
    }

    // ── AC3: the Settings save path (PATCH /api/config) rejects invalid ids ──
    {
      const p2 = () => readCfg().projects.find((p) => p.id === "p2");
      const patchAgents = (agents) => req(server, { method: "PATCH", urlPath: "/api/config",
        body: { projects: [{ id: "p2", name: "p2", agents }] } });
      const before = JSON.stringify(readCfg());
      for (const bad of ['gpt"5', "-rf", "gpt 5"]) {
        const r = await patchAgents({ ...p2().agents, dev: { command: "claude", model: bad } });
        ok(r.status === 400 && r.body.ok === false && r.body.error === "Invalid model id for p2/dev",
          `AC3: PATCH /api/config rejects ${JSON.stringify(bad)} (400, names only the bad agent)`);
      }
      ok(JSON.stringify(readCfg()) === before, "AC3: a rejected PATCH writes nothing");
      const r = await patchAgents({ head: { command: "codex", model: "" }, dev: { command: "claude", model: "claude-opus-5-5" } });
      ok(r.status === 200 && p2().agents.dev.model === "claude-opus-5-5" && p2().agents.head.model === "",
        "AC3/AC4: PATCH persists a valid id and an unset ('') model");
      const r2 = await req(server, { method: "PATCH", urlPath: "/api/config", body: { operator_name: "op" } });
      ok(r2.status === 200, "a PATCH with no projects is unaffected by the model check");
    }

    if (!SHIM) {
      console.log("  SKIP: PATH-shim discovery checks (POSIX shebang shim; not run on Windows)");
    } else {
      // ── AC7: the spawn path never runs discovery ──
      ok(markerRuns().length === 0, "AC7: spawning codex/grok agents never ran `codex debug models` / `grok models`");

      // ── AC1/AC7: the catalog route runs discovery once and caches it ──
      const first = await req(server, { urlPath: "/api/agent-model-catalog" });
      ok(first.status === 200 && JSON.stringify(first.body.models.codex) === '["gpt-7-nova"]',
        "AC1: GET /api/agent-model-catalog returns the model the installed CLI lists (unknown to QuadWork)");
      ok(JSON.stringify(first.body.models.grok) === '["grok-5","grok-4.5"]',
        "AC1: the catalog route returns the models `grok models` lists (grok-5 unknown to QuadWork)");
      ok(markerRuns().sort().join("|") === "codex debug models|grok models", "AC7: the route ran exactly `codex debug models` and `grok models`, once each");
      ok(!("claude" in first.body.models) && !("gemini" in first.body.models), "AC1: backends with no discovery source are absent (shipped list)");
      await req(server, { urlPath: "/api/agent-model-catalog" });
      ok(markerRuns().length === 2, "AC7: a second open within the TTL is served from cache");
      await buildAgentArgs("p1", "codex_valid");
      await buildAgentArgs("p1", "grok_valid");
      ok(markerRuns().length === 2, "AC7: spawning after discovery still never runs it");
    }
  } finally {
    server.close();
  }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});
