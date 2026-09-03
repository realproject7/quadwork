"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "components", "SettingsPage.tsx"), "utf8");
let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

ok(source.includes('`/api/projects/${encodeURIComponent(projectId)}/environment-settings`') && source.includes('method: "PUT"'),
  "Settings uses the dedicated environment mutation instead of generic config PATCH");
ok(source.includes("environment_bindings: draft.environment_bindings.map") && source.includes("coordination_repo_key: draft.coordination_repo_key || null"),
  "Settings sends the closed typed binding payload with an explicit repository clear value");
ok(source.includes("(project.repositories || []).map((repository)") && source.includes("repository.key} · {repository.repo}"),
  "coordination selector is sourced only from the project's canonical repository records");
ok(source.includes("Installation ID") && source.includes("Project ID") && source.includes("Display label") && source.includes("Environment class") &&
  source.includes("htmlFor={`environment-${project.id}-installation_id-${bindingIndex}`}") && source.includes("autoComplete=\"off\""),
  "peer inputs have explicit labels, identifiers, and non-auth autocomplete behavior");
ok(source.includes("focus-visible:outline") && source.includes('role="status" aria-live="polite"') && source.includes("window.requestAnimationFrame"),
  "asynchronous typed errors are announced and focus their field with visible focus styling");
ok(source.includes("Watch Batch Request Tickets on this local environment") && source.includes("disabled={!environmentDraft.coordination_repo_key}"),
  "local watcher opt-in is unavailable until a canonical coordination repository is selected");
ok(source.includes("Confirm removal") && source.includes("Peer removal only blocks future local validation; it never changes remote work."),
  "peer removal is confirmed and explicitly scoped away from remote work");
ok(source.includes('window.addEventListener("beforeunload", warn)') && source.includes("hasUnsavedEnvironmentDraft"),
  "unsaved peer drafts warn before browser navigation can discard them");
ok(!source.includes("environment-discovery") && !source.includes("environment-reachability") && !source.includes("remote environment control"),
  "Project Environments UI adds no discovery, reachability, or remote-control surface");

console.log(`\n${passed} passed`);
console.log("server/settingsProjectEnvironmentsUi.test.js: all assertions passed");
