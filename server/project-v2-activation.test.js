"use strict";

const assert = require("node:assert/strict");
const { firstActivationLegacyGuard, targetActivationGuard } = require("./project-v2-activation");

const config = {
  projects: [
    { id: "target", repo: "Acme/Target", working_dir: "/work/target" },
    { id: "idle", repo: "Acme/Idle", working_dir: "/work/idle" },
    { id: "busy", repo: "Acme/Busy", working_dir: "/work/busy" },
  ],
};

let result = firstActivationLegacyGuard(config, "target", (project) => (
  project.id === "busy" ? { state: "legacy_unowned_executable" } : { state: "clear" }
));
assert.deepEqual(result, {
  ok: false,
  code: "first_activation_legacy_project_blocked",
  project_id: "busy",
  state: "legacy_unowned_executable",
});
console.log("  PASS: first activation is globally blocked by another executable legacy queue");

result = firstActivationLegacyGuard(config, "target", (project) => (
  project.id === "busy" ? { state: "open_assignment" } : { state: "clear" }
));
assert.deepEqual(result, {
  ok: false,
  code: "first_activation_legacy_project_blocked",
  project_id: "busy",
  state: "open_assignment",
});
console.log("  PASS: first activation is globally blocked by another legacy assignment");

result = firstActivationLegacyGuard(config, "target", (project) => (
  project.id === "busy" ? { state: "state_unavailable" } : { state: "clear" }
));
assert.deepEqual(result, {
  ok: false,
  code: "first_activation_legacy_project_blocked",
  project_id: "busy",
  state: "state_unavailable",
});
console.log("  PASS: another legacy project's unreadable state fails closed");

result = firstActivationLegacyGuard({ ...config, installation_id: "installation_1234567890abcdef" }, "target", () => ({ state: "active_batch" }));
assert.deepEqual(result, { ok: true, first_activation: false });
console.log("  PASS: the cross-project guard applies only to the global first activation");

result = targetActivationGuard({ id: "target", archived: false }, () => ({ state: "active_batch" }));
assert.deepEqual(result, { ok: false, code: "project_not_quiesced", state: "active_batch" });
assert.deepEqual(targetActivationGuard({ id: "target", archived: true }, () => ({ state: "clear" })), {
  ok: false,
  code: "project_archived",
  state: "archived",
});
assert.deepEqual(targetActivationGuard({ id: "target", archived: false }, () => ({ state: "clear" })), { ok: true });
console.log("  PASS: target activation requires a non-archived, quiesced project");

console.log("\n5 passed, 0 failed\n");
