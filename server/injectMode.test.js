// #937: changing an agent's Command in Settings reset the model (#931) but
// not mcp_inject, so converting an agent to gemini left a stale "flag" and the
// CLI crashed on launch (spawned with --mcp-config, which Gemini doesn't take).
// The fix routes the wizard, the add-project route, the spawn default, and the
// Settings command-change/save flow through one shared mapping in
// src/lib/injectMode.js. This test pins that mapping and the save reconciliation
// the component applies to agents (always) and the butler (heal-if-present).
//
// Plain node:assert script (run via server/run-tests.js). It requires the real
// shared module the production code and UI use — no duplicated logic.

const { cliBaseFromCommand, injectModeForCommand } = require("../src/lib/injectMode.js");

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

// ── cliBaseFromCommand: strip directory + args, claude fallback ──
ok(cliBaseFromCommand("gemini") === "gemini", "cliBaseFromCommand keeps a bare command");
ok(cliBaseFromCommand("/usr/bin/codex") === "codex", "cliBaseFromCommand strips a leading path");
ok(cliBaseFromCommand("claude --dangerously-skip-permissions") === "claude", "cliBaseFromCommand strips trailing args");
ok(cliBaseFromCommand("") === "claude", "cliBaseFromCommand falls back to claude for empty");
ok(cliBaseFromCommand(undefined) === "claude", "cliBaseFromCommand falls back to claude for undefined");

// ── injectModeForCommand: the backend → mode mapping (matches bin/quadwork.js) ──
ok(injectModeForCommand("codex") === "proxy_flag", "#937 AC: codex → proxy_flag");
ok(injectModeForCommand("gemini") === "env", "#937 AC: gemini → env (no --mcp-config)");
ok(injectModeForCommand("claude") === "flag", "#937 AC: claude → flag");
ok(injectModeForCommand("grok") === "project_toml", "#1023 AC: grok → project_toml (no MCP flag exists)");
ok(injectModeForCommand("/opt/bin/gemini") === "env", "injectModeForCommand resolves a pathed gemini → env");
ok(injectModeForCommand("/opt/homebrew/bin/grok") === "project_toml", "injectModeForCommand resolves a pathed grok → project_toml");
ok(injectModeForCommand("grok --always-approve") === "project_toml", "injectModeForCommand resolves grok with args → project_toml");
ok(injectModeForCommand("codex -c foo=bar") === "proxy_flag", "injectModeForCommand resolves codex with args → proxy_flag");
ok(injectModeForCommand("") === "flag", "injectModeForCommand: empty command → flag (claude default)");
ok(injectModeForCommand(undefined) === "flag", "injectModeForCommand: undefined command → flag (claude default)");
ok(injectModeForCommand("aider") === "flag", "injectModeForCommand: unknown backend → flag");

// ── save() reconciliation: agents are ALWAYS reconciled (wizard invariant + ──
// the spawn path reads mcp_inject), mirroring SettingsPage.save().
const reconcileAgent = (a) => ({ ...a, mcp_inject: injectModeForCommand(a.command || "claude") });
ok(reconcileAgent({ command: "gemini", mcp_inject: "flag" }).mcp_inject === "env", "#937 core: save heals a stale 'flag' on a gemini-converted agent → 'env'");
ok(reconcileAgent({ command: "codex", mcp_inject: "flag" }).mcp_inject === "proxy_flag", "save heals a codex agent's mcp_inject → proxy_flag");
ok(reconcileAgent({ command: "claude", mcp_inject: "env" }).mcp_inject === "flag", "save heals a claude agent's mcp_inject → flag");
ok(reconcileAgent({ command: "grok", mcp_inject: "flag" }).mcp_inject === "project_toml", "#1023: save heals a stale 'flag' on a grok-converted agent → 'project_toml'");
ok(reconcileAgent({ command: "gemini" }).mcp_inject === "env", "save sets mcp_inject for a legacy agent that lacked one (matches spawn fallback)");
ok(reconcileAgent({ command: "codex", mcp_inject: "proxy_flag" }).mcp_inject === "proxy_flag", "save leaves an already-correct mcp_inject unchanged");

// ── save() reconciliation: the butler is HEAL-IF-PRESENT only (spawn ignores ──
// mcp_inject and the wizard never writes one), mirroring SettingsPage.save().
const reconcileButler = (butler) =>
  butler
    ? {
        ...butler,
        ...(butler.mcp_inject !== undefined
          ? { mcp_inject: injectModeForCommand(butler.command || "claude") }
          : {}),
      }
    : butler;
ok(reconcileButler({ command: "gemini", mcp_inject: "flag" }).mcp_inject === "env", "#937: save heals a stale butler mcp_inject when present → 'env'");
ok(!("mcp_inject" in reconcileButler({ command: "gemini" })), "#937: save does NOT fabricate mcp_inject on a butler that never had one");
ok(reconcileButler(undefined) === undefined, "save leaves a missing butler config untouched");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
