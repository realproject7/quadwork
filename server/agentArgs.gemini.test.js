"use strict";

// #905: buildAgentArgs must forward a Gemini agent's configured model on the
// spawned command (the model-arg block previously branched only for codex /
// claude, silently dropping a gemini agent's model). These tests assert the
// `--model <slug>` flag IS present for gemini, falls back to the CLI default
// when unset, and that claude / codex are unaffected (no regression).
//
// QUADWORK_SKIP_LISTEN + a temp HOME let us require the server module for its
// exported pure helper without starting the server / binding the port. HOME is
// set BEFORE any require so config.js resolves CONFIG_PATH into the temp dir.

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_HOME = path.join(os.tmpdir(), `quadwork-gemini-test-${process.pid}`);
process.env.HOME = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";

const cfgDir = path.join(TMP_HOME, ".quadwork");
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(
  path.join(cfgDir, "config.json"),
  JSON.stringify({
    port: 8400,
    projects: [
      {
        id: "p1",
        working_dir: "/tmp/p1",
        agents: {
          gemini_model: { command: "gemini", model: "gemini-2.5-pro" },
          gemini_default: { command: "gemini" },
          codex_agent: { command: "codex", model: "gpt-5" },
          claude_agent: { command: "claude", model: "opus" },
          claude_opus5_agent: { command: "claude", model: "claude-opus-5" },
        },
      },
    ],
  }),
);

const { buildAgentArgs } = require("./index");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// args is a flat array like ["--yolo", "--model", "<slug>", ...]; the model
// value is the token right after the "--model" flag.
function modelArg(args) {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
}

async function runTests() {
  {
    const { args } = await buildAgentArgs("p1", "gemini_model");
    assert(args.includes("--model"), "gemini with model → --model flag present");
    assert(modelArg(args) === "gemini-2.5-pro", "gemini forwards the configured model slug");
    assert(args.includes("--yolo"), "gemini still gets its --yolo permission flag");
  }

  {
    const { args } = await buildAgentArgs("p1", "gemini_default");
    assert(!args.includes("--model"), "gemini without model → no --model (CLI default)");
    assert(args.includes("--yolo"), "gemini-default still gets --yolo");
  }

  {
    // No regression: codex keeps its -c model="…" form, not --model.
    const { args } = await buildAgentArgs("p1", "codex_agent");
    assert(args.includes("-c") && args.some((a) => a === 'model="gpt-5"'), "codex still uses -c model=\"…\"");
    assert(!args.includes("--model"), "codex does NOT use --model");
  }

  {
    // No regression: claude keeps --model <slug>.
    const { args } = await buildAgentArgs("p1", "claude_agent");
    assert(modelArg(args) === "opus", "claude still forwards --model <slug>");
  }

  {
    // #1018: a Claude agent pinned to claude-opus-5 launches with that exact
    // slug, and the pin does not disturb the permission / MCP arguments that
    // share this branch.
    const { args } = await buildAgentArgs("p1", "claude_opus5_agent");
    assert(modelArg(args) === "claude-opus-5", "#1018: claude forwards the claude-opus-5 pin verbatim as --model <slug>");
    assert(args.includes("--dangerously-skip-permissions"), "#1018: the pinned claude agent keeps its permission flag");
    assert(args.includes("--mcp-config"), "#1018: the pinned claude agent keeps its --mcp-config MCP argument");
    assert(args.indexOf("--mcp-config") + 1 < args.length && args[args.indexOf("--mcp-config") + 1].endsWith(".json"), "#1018: --mcp-config still points at a written config path");
  }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});
