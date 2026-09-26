"use strict";

// #1172: model discovery (server/agent-model-catalog.js). Each source runs a
// real child process — `node -e <script>` standing in for a provider CLI — so
// the timeout, exit-code, missing-binary and parse paths are the production
// execFile paths, not a stubbed runner. No provider CLI is ever started here.
// #1176: discovery runs one resolved executable per target; here the node
// binary is each target's executable and the script is the source's args.

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseCodexModels,
  parseGrokModels,
  discoveryTargets,
  discoverAgentModels,
  createModelCatalogCache,
  DISCOVERY_SOURCES,
  DISCOVERY_TIMEOUT_MS,
} = require("./agent-model-catalog");

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

// Shape of `codex debug models` (codex-cli 0.153.1): { models: [{ slug,
// visibility, ... }] }, "hide" entries being internal.
const CODEX_FIXTURE = JSON.stringify({
  models: [
    { slug: "gpt-7-nova", display_name: "GPT-7-Nova", visibility: "list", priority: 1 },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 3 },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", priority: 4 },
    { slug: 'bad"slug', visibility: "list" },
    { slug: "-flag", visibility: "list" },
  ],
});

// Exact `grok models` stdout (grok 0.2.118, not logged in; exit 0, empty stderr).
const GROK_UNAUTHENTICATED = "You are not authenticated.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n";

// A source whose fixed args are `-e <script>`, parsed like codex's; run with
// the node binary as its executable.
const nodeSource = (script) => ({ name: "codex debug models", command: "codex", args: ["-e", script], parse: parseCodexModels });
const printFixture = `process.stdout.write(${JSON.stringify(CODEX_FIXTURE)})`;
// Every source gets one target: the node binary, or `executable` if given.
const discover = (sources, { executable = process.execPath, ...opts } = {}) => discoverAgentModels({
  sources,
  targets: Object.keys(sources).map((backend) => ({ backend, executable })),
  ...opts,
});

async function main() {
  // ── parser ──
  ok(parseCodexModels(CODEX_FIXTURE).join(",") === "gpt-7-nova,gpt-6-astra",
    "parseCodexModels keeps visibility:list slugs, drops hidden and ill-formed ids");
  let threw = false;
  try { parseCodexModels('{"data":[]}'); } catch { threw = true; }
  ok(threw, "parseCodexModels throws on a changed output shape");

  // ── the production source is keyed by command basename and read-only ──
  ok(DISCOVERY_SOURCES.codex.command === "codex" && DISCOVERY_SOURCES.codex.args.join(" ") === "debug models",
    "codex discovery runs `codex debug models`");
  ok(DISCOVERY_SOURCES.grok.command === "grok" && DISCOVERY_SOURCES.grok.args.join(" ") === "models",
    "grok discovery runs `grok models`");
  ok(Object.keys(DISCOVERY_SOURCES).sort().join(",") === "codex,grok",
    "only codex and grok have a discovery source; claude/gemini use the shipped list");

  // ── grok parser: the "* <id>" rows under "Available models:" ──
  ok(parseGrokModels(GROK_UNAUTHENTICATED).join(",") === "grok-4.5",
    "parseGrokModels reads grok 0.2.118's unauthenticated output (grok-4.5, '(default)' suffix stripped)");
  ok(parseGrokModels("Default model: grok-5\n\nAvailable models:\n  * grok-5 (default)\n  * grok-5-mini\n  * grok-4.5\n").join(",") === "grok-5,grok-5-mini,grok-4.5",
    "parseGrokModels lists every row, default or not");
  ok(parseGrokModels("Available models:\r\n  * grok-5 (default)\r\n").join(",") === "grok-5", "parseGrokModels accepts CRLF output");
  ok(parseGrokModels('Available models:\n  * grok"x\n  * -flag\n  * grok-5\n').join(",") === "grok-5",
    "parseGrokModels drops ids outside MODEL_ID_PATTERN");
  ok(parseGrokModels("Available models:\n  * grok-5\n\nTip: run grok --help\n").join(",") === "grok-5",
    "parseGrokModels stops at the blank line ending the list");
  for (const [label, out] of [
    ["no 'Available models:' header", "Default model: grok-4.5\n"],
    ["a row of another shape", "Available models:\n  - grok-4.5\n"],
    ["a table row", "Available models:\n  grok-4.5   default   256k\n"],
  ]) {
    let failedParse = false;
    try { parseGrokModels(out); } catch { failedParse = true; }
    ok(failedParse, `parseGrokModels throws on a changed format (${label})`);
  }
  ok(DISCOVERY_TIMEOUT_MS > 0 && DISCOVERY_TIMEOUT_MS <= 10000, "discovery has a bounded timeout");

  // ── AC1: a discovered model is returned ──
  {
    const r = await discover({ codex: nodeSource(printFixture) });
    ok(r.models.codex && r.models.codex.join(",") === "gpt-7-nova,gpt-6-astra", "AC1: discovered models are returned per backend");
    ok(Object.keys(r.errors).length === 0, "a successful discovery reports no error");
  }
  {
    const grokSource = (script) => ({ ...nodeSource(script), name: "grok models", parse: parseGrokModels });
    const r = await discover({
      grok: grokSource(`process.stdout.write(${JSON.stringify(GROK_UNAUTHENTICATED)})`),
    });
    ok(r.models.grok && r.models.grok.join(",") === "grok-4.5", "AC1: grok models discovered through a child process");
    for (const [label, script] of [
      ["changed format", 'process.stdout.write("Models: grok-4.5\\n")'],
      ["empty list", 'process.stdout.write("Available models:\\n")'],
      ["non-zero exit", "process.exit(2)"],
    ]) {
      const f = await discover({ grok: grokSource(script) });
      ok(!("grok" in f.models) && typeof f.errors.grok === "string", `AC8: grok ${label} → shipped list (${f.errors.grok})`);
    }
    const t = await discover({ grok: grokSource("setTimeout(() => {}, 30000)") }, { timeoutMs: 300 });
    ok(!("grok" in t.models) && /timed out/.test(t.errors.grok || ""), "AC8: a hung `grok models` times out → shipped list");
  }

  // ── AC8: every failure drops the backend (→ shipped list) and never throws ──
  const failures = {
    "missing CLI": [nodeSource(""), path.join(__dirname, "no-such-cli-1172")],
    "non-zero exit (e.g. not logged in / offline)": [nodeSource('process.stderr.write("not logged in"); process.exit(1)')],
    "changed output format": [nodeSource('process.stdout.write("Available models:\\n  gpt-7\\n")')],
    "empty list": [nodeSource('process.stdout.write(JSON.stringify({ models: [] }))')],
  };
  for (const [label, [source, executable]] of Object.entries(failures)) {
    const r = await discover({ codex: source }, { executable });
    ok(!("codex" in r.models) && typeof r.errors.codex === "string" && r.errors.codex.length > 0 && !/not logged in/.test(r.errors.codex),
      `AC8: ${label} → no discovered list, short error recorded without CLI stderr (${r.errors.codex})`);
  }
  {
    const r = await discover({ codex: nodeSource("") }, { executable: path.join(__dirname, "no-such-cli-1172") });
    ok(r.errors.codex === "codex not found", "#1176: a missing executable reports the fixed \"codex not found\" (never the path)");
    const none = await discoverAgentModels({ targets: [], sources: { codex: nodeSource(printFixture) } });
    ok(!("codex" in none.models) && none.errors.codex === "codex not found",
      "#1176: a backend with no resolved executable runs nothing and reports \"codex not found\"");
  }

  // ── parse failures report a fixed message, never text from the CLI output ──
  for (const [label, out] of [
    ["invalid JSON", "SECRET-acct-9f3e not json"],
    ["JSON of another shape", JSON.stringify({ SECRET: "acct-9f3e" })],
    ["JSON that is not an object", JSON.stringify("SECRET-acct-9f3e")],
  ]) {
    const r = await discover({ codex: nodeSource(`process.stdout.write(${JSON.stringify(out)})`) });
    ok(r.errors.codex === "unexpected `codex debug models` output",
      `AC8: ${label} → the fixed "unexpected \`codex debug models\` output" message (got ${JSON.stringify(r.errors.codex)})`);
  }
  {
    const r = await discover({
      grok: { ...nodeSource('process.stdout.write("Available models:\\n  SECRET-acct-9f3e grok\\n")'), name: "grok models", parse: parseGrokModels },
    });
    ok(r.errors.grok === "unexpected `grok models` output", "AC8: a grok parse failure reports the fixed message");
  }

  // ── AC7/AC8: timeout is bounded and falls back ──
  {
    const started = Date.now();
    const r = await discover({ codex: nodeSource("setTimeout(() => {}, 30000)"), other: nodeSource(printFixture) }, { timeoutMs: 300 });
    const elapsed = Date.now() - started;
    ok(!("codex" in r.models) && /timed out/.test(r.errors.codex || ""), "AC8: a hung CLI times out → no discovered list");
    ok(elapsed < 5000, `AC7: the timeout bounds discovery (${elapsed}ms for a 30s hang)`);
    ok(r.models.other && r.models.other.length === 2, "a timeout on one backend does not drop another backend's result");
  }

  // ── a timeout kills the CLI's whole process group (no orphaned helpers) ──
  if (process.platform === "win32") {
    console.log("  SKIP: process-group kill check (POSIX process groups; not run on Windows)");
  } else {
    const pidFile = path.join(os.tmpdir(), `qw-1172-grandchild-${process.pid}.pid`);
    try { fs.rmSync(pidFile, { force: true }); } catch {}
    // Stand-in CLI: starts a detached-from-its-stdio sleeping helper, records
    // its pid, then hangs itself.
    const spawnsHelper =
      'const { spawn } = require("child_process");' +
      `const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });` +
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));` +
      "setTimeout(() => {}, 30000);";
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const r = await discover({ codex: nodeSource(spawnsHelper) }, { timeoutMs: 1000 });
    const helperPid = Number(fs.readFileSync(pidFile, "utf8"));
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      gone = !alive(helperPid);
      if (!gone) await new Promise((res) => setTimeout(res, 50));
    }
    ok(/timed out/.test(r.errors.codex || ""), "AC7: the stand-in that spawned a helper timed out");
    ok(helperPid > 0 && gone, "AC7: the helper (grandchild) is gone after the timeout — the whole group was killed");
    if (!gone) { try { process.kill(helperPid, "SIGKILL"); } catch {} }
    try { fs.rmSync(pidFile, { force: true }); } catch {}
  }

  // ── stdin is closed: a CLI waiting for prompt input gets EOF, not a hang ──
  {
    const waitsForInput = 'process.stdin.on("data", () => {}); process.stdin.on("end", () => { process.stderr.write("login required"); process.exit(1); });';
    const started = Date.now();
    const r = await discover({ codex: nodeSource(waitsForInput) }, { timeoutMs: 4000 });
    ok(!("codex" in r.models) && r.errors.codex === "exited with code 1" && Date.now() - started < 4000,
      "AC8: a CLI that would prompt reads EOF and fails fast (no prompt can wait on the operator)");
  }

  // ── #1176: targets, one per resolved executable (the resolver's answer) ──
  {
    const resolved = { codex: "/p/codex", grok: "/p/grok", "/opt/a/codex": "/opt/a/codex", "/opt/b/grok": "/opt/b/grok", "/p/codex": "/p/codex" };
    const asked = [];
    const resolve = (command) => { asked.push(command); return resolved[command] || null; };
    const targets = discoveryTargets(["codex", "/opt/a/codex", "claude", "/opt/b/grok", undefined, "codex --profile x", "/p/codex", "/opt/missing/codex"], resolve);
    ok(JSON.stringify(targets) === JSON.stringify([
      { backend: "codex", executable: "/p/codex" },
      { backend: "grok", executable: "/p/grok" },
      { backend: "codex", executable: "/opt/a/codex" },
      { backend: "grok", executable: "/opt/b/grok" },
    ]), "#1176: each bare CLI name's executable, then each agent command's own; one target per resolved executable");
    ok(!asked.includes("claude") && !asked.includes(undefined),
      "#1176: a command with no discovery source (claude, unset) is never resolved or run");
    ok(discoveryTargets(["gemini"], () => null).length === 0, "#1176: nothing resolved → no targets");
  }

  // ── #1176: each target runs its own executable with the source's fixed args ──
  if (process.platform === "win32") {
    console.log("  SKIP: executable-per-target check (POSIX shebang stand-ins; not run on Windows)");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-1176-exec-"));
    const marker = path.join(dir, "runs.log");
    const standIn = (name, slugs) => {
      fs.mkdirSync(path.join(dir, name));
      const file = path.join(dir, name, "codex");
      fs.writeFileSync(file, `#!${process.execPath}\n` +
        `require("fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + " ")} + process.argv.slice(2).join(" ") + "\\n");\n` +
        `process.stdout.write(${JSON.stringify(JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: "list" })) }))});\n`, { mode: 0o755 });
      return file;
    };
    const onPath = standIn("path", ["gpt-7-nova", "gpt-6-astra"]);
    const pinned = standIn("pinned", ["gpt-6-astra", "gpt-pinned-1"]);
    const r = await discoverAgentModels({
      sources: { codex: DISCOVERY_SOURCES.codex },
      targets: [{ backend: "codex", executable: onPath }, { backend: "codex", executable: pinned }],
    });
    ok(r.models.codex && r.models.codex.join(",") === "gpt-7-nova,gpt-6-astra,gpt-pinned-1",
      "#1176: a backend lists the union of its executables' models, in target order, de-duplicated");
    const runs = fs.readFileSync(marker, "utf8").split("\n").filter(Boolean).sort();
    ok(runs.join("|") === "path debug models|pinned debug models",
      "#1176: each resolved executable ran once, with the fixed `debug models` arguments");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── AC7/#1176: cache per resolved executable, one run per TTL window ──
  {
    const calls = [];
    let clock = 1000;
    const get = createModelCatalogCache({
      list: async (source, executable) => { calls.push(executable); return [`m${calls.length}`]; },
      ttlMs: 60000,
      now: () => clock,
    });
    const a1 = { backend: "codex", executable: "/p/codex" };
    const [a, b] = await Promise.all([get([a1]), get([a1])]);
    ok(calls.length === 1 && a.models.codex.join() === "m1" && b.models.codex.join() === "m1",
      "AC7: concurrent callers share one discovery run");
    await get([a1]);
    ok(calls.length === 1, "AC7: a cached result is reused within the TTL (no rerun per render/open)");
    const withPinned = await get([a1, { backend: "codex", executable: "/opt/a/codex" }]);
    ok(calls.length === 2 && calls[1] === "/opt/a/codex" && withPinned.models.codex.join() === "m1,m2",
      "#1176: a newly configured executable runs once; the cached one is not rerun");
    await get([a1, { backend: "codex", executable: "/opt/a/codex" }]);
    ok(calls.length === 2, "#1176: each executable keeps its own cache entry");
    clock += 60001;
    const c = await get([a1]);
    ok(calls.length === 3 && c.models.codex.join() === "m3", "AC7: discovery reruns after the TTL expires");
  }
  {
    let calls = 0;
    const get = createModelCatalogCache({ list: async () => { calls++; throw new Error("boom"); } });
    const t = [{ backend: "codex", executable: "/p/codex" }];
    const r = await get(t);
    ok(r && typeof r.models === "object" && !("codex" in r.models) && r.errors.codex === "boom" && r.errors.grok === "grok not found",
      "AC8: a throwing run still resolves (that backend reports the error → shipped list)");
    await get(t);
    ok(calls === 1, "AC7: a failed run is cached too (reused for the TTL)");
  }

  // ── AC7: the spawn path never references discovery ──
  {
    const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
    const start = src.indexOf("async function buildAgentArgs(");
    const end = src.indexOf("\n}\n", start);
    const body = src.slice(start, end);
    ok(start > 0 && !/getAgentModelCatalog|discoverAgentModels|createModelCatalogCache|agent-model-catalog\b/.test(body),
      "AC7: buildAgentArgs never calls model discovery");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
