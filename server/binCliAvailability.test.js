"use strict";

const assert = require("node:assert/strict");
const {
  installedAgentCliBackends,
  validateInstalledBackendChoice,
} = require("../bin/quadwork");

for (const backend of ["claude", "codex", "gemini", "grok"]) {
  const available = installedAgentCliBackends((candidate) => candidate === backend);
  assert.deepEqual(available, [backend], `${backend}-only machine is recognized`);
  assert.equal(validateInstalledBackendChoice(backend, available), backend);
}
console.log("  PASS: claude-only, codex-only, gemini-only, and grok-only machines each have one valid default");

const multiple = ["codex", "gemini"];
assert.equal(validateInstalledBackendChoice("gemini", multiple), "gemini");
assert.equal(validateInstalledBackendChoice("claude", multiple), null, "an installed-list mismatch is rejected");
assert.equal(validateInstalledBackendChoice("grok", []), null, "no-CLI state accepts no backend");
console.log("  PASS: multi-CLI choices reject an uninstalled backend and no-CLI is explicit");

console.log("\n2 passed, 0 failed\n");
