// #937: single source of truth for the backend → MCP injection-mode mapping.
// The setup wizard (bin/quadwork.js), the add-project route (server/routes.js),
// and the spawn default (server/index.js) all derive `mcp_inject` from an
// agent's command — codex → "proxy_flag", gemini → "env", everything else
// → "flag". Before this helper the mapping was copy-pasted in all three, and
// the Settings UI's command-change/save flow didn't touch mcp_inject at all,
// so converting an agent to gemini left a stale "flag" and crashed the CLI
// (it was spawned with `--mcp-config`, which Gemini doesn't accept).
//
// Plain JS on purpose (not .ts): this module is required by Node production
// code (bin/quadwork.js, server/*.js) which runs on Node >=20 — without .ts
// type-stripping — and imported by the Settings UI (tsconfig allowJs).

/**
 * Resolve a command string to its CLI base name, matching how the spawn paths
 * derive it: strip any directory and take the first whitespace-separated token.
 * e.g. "gemini" / "/usr/bin/gemini" / "claude --foo" → "gemini" / "gemini" / "claude".
 */
function cliBaseFromCommand(command) {
  return String(command || "claude").split("/").pop().split(" ")[0];
}

/**
 * MCP injection mode for an agent's command:
 *   codex → "proxy_flag", gemini → "env", grok → "project_toml",
 *   everything else → "flag".
 *
 * #1023: grok has no --mcp-config-style flag at all. Its only "always on" MCP
 * source is a native TOML config, so the spawn path writes a project-scoped
 * <cwd>/.grok/config.toml instead of passing a flag.
 */
function injectModeForCommand(command) {
  const cliBase = cliBaseFromCommand(command);
  if (cliBase === "codex") return "proxy_flag";
  if (cliBase === "gemini") return "env";
  if (cliBase === "grok") return "project_toml";
  return "flag";
}

module.exports = { cliBaseFromCommand, injectModeForCommand };
