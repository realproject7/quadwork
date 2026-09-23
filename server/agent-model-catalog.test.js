"use strict";

// #1172: model discovery (server/agent-model-catalog.js). Each source runs a
// real child process — `node -e <script>` standing in for a provider CLI — so
// the timeout, exit-code, missing-binary and parse paths are the production
// execFile paths, not a stubbed runner. No provider CLI is ever started here.

const fs = require("fs");
const path = require("path");
const {
  parseCodexModels,
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

// A source that runs `node -e <script>` and parses stdout like codex's does.
const nodeSource = (script) => ({ command: process.execPath, args: ["-e", script], parse: parseCodexModels });
const printFixture = `process.stdout.write(${JSON.stringify(CODEX_FIXTURE)})`;

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
  ok(Object.keys(DISCOVERY_SOURCES).join(",") === "codex",
    "only codex has a discovery source; claude/gemini/grok use the shipped list");
  ok(DISCOVERY_TIMEOUT_MS > 0 && DISCOVERY_TIMEOUT_MS <= 10000, "discovery has a bounded timeout");

  // ── AC1: a discovered model is returned ──
  {
    const r = await discoverAgentModels({ sources: { codex: nodeSource(printFixture) } });
    ok(r.models.codex && r.models.codex.join(",") === "gpt-7-nova,gpt-6-astra", "AC1: discovered models are returned per backend");
    ok(Object.keys(r.errors).length === 0, "a successful discovery reports no error");
  }

  // ── AC8: every failure drops the backend (→ shipped list) and never throws ──
  const failures = {
    "missing CLI": { command: path.join(__dirname, "no-such-cli-1172"), args: [], parse: parseCodexModels },
    "non-zero exit (e.g. not logged in / offline)": nodeSource('process.stderr.write("not logged in"); process.exit(1)'),
    "changed output format": nodeSource('process.stdout.write("Available models:\\n  gpt-7\\n")'),
    "empty list": nodeSource('process.stdout.write(JSON.stringify({ models: [] }))'),
  };
  for (const [label, source] of Object.entries(failures)) {
    const r = await discoverAgentModels({ sources: { codex: source } });
    ok(!("codex" in r.models) && typeof r.errors.codex === "string" && r.errors.codex.length > 0 && !/not logged in/.test(r.errors.codex),
      `AC8: ${label} → no discovered list, short error recorded without CLI stderr (${r.errors.codex})`);
  }

  // ── AC7/AC8: timeout is bounded and falls back ──
  {
    const started = Date.now();
    const r = await discoverAgentModels({
      sources: { codex: nodeSource("setTimeout(() => {}, 30000)"), other: nodeSource(printFixture) },
      timeoutMs: 300,
    });
    const elapsed = Date.now() - started;
    ok(!("codex" in r.models) && /timed out/.test(r.errors.codex || ""), "AC8: a hung CLI times out → no discovered list");
    ok(elapsed < 5000, `AC7: the timeout bounds discovery (${elapsed}ms for a 30s hang)`);
    ok(r.models.other && r.models.other.length === 2, "a timeout on one backend does not drop another backend's result");
  }

  // ── stdin is closed: a CLI waiting for prompt input gets EOF, not a hang ──
  {
    const waitsForInput = 'process.stdin.on("data", () => {}); process.stdin.on("end", () => { process.stderr.write("login required"); process.exit(1); });';
    const started = Date.now();
    const r = await discoverAgentModels({ sources: { codex: nodeSource(waitsForInput) }, timeoutMs: 4000 });
    ok(!("codex" in r.models) && r.errors.codex === "exited with code 1" && Date.now() - started < 4000,
      "AC8: a CLI that would prompt reads EOF and fails fast (no prompt can wait on the operator)");
  }

  // ── AC7: cache — one run per TTL window, concurrent callers share it ──
  {
    let calls = 0;
    let clock = 1000;
    const get = createModelCatalogCache({
      discover: async () => { calls++; return { models: { codex: [`m${calls}`] }, errors: {} }; },
      ttlMs: 60000,
      now: () => clock,
    });
    const [a, b] = await Promise.all([get(), get()]);
    ok(calls === 1 && a === b, "AC7: concurrent callers share one discovery run");
    await get();
    ok(calls === 1, "AC7: a cached result is reused within the TTL (no rerun per render/open)");
    clock += 60001;
    const c = await get();
    ok(calls === 2 && c.models.codex[0] === "m2", "AC7: discovery reruns after the TTL expires");
  }
  {
    const get = createModelCatalogCache({ discover: async () => { throw new Error("boom"); } });
    const r = await get();
    ok(r && typeof r.models === "object" && Object.keys(r.models).length === 0 && /boom/.test(r.errors.discovery),
      "AC8: a throwing discover still resolves (empty models → shipped lists)");
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
