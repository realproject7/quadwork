"use strict";
const assert = require("node:assert/strict");
const { CanonicalInstalledStateError, createCanonicalInstalledStateReader } = require("./canonical-installed-state");
const installation_id = "installation_installed_state_0001", project_id = "quadwork";
function throwsCode(fn, code) { assert.throws(fn, (error) => error instanceof CanonicalInstalledStateError && error.code === code); }
function reader(config) { return createCanonicalInstalledStateReader({ read_config: () => config }); }
const current = reader({ installation_id, projects: [{ id: project_id, archived: false }] });
assert.deepEqual(current({ version: 1, installation_id, project_id }), { version: 1, installation_id, project_id, v1_state: "present" });
assert.equal(Object.isFrozen(current({ version: 1, installation_id, project_id })), true);
throwsCode(() => current({ version: 1, installation_id, project_id, v1_state: "present" }), "invalid_canonical_installed_state_identity");
throwsCode(() => reader({ installation_id, projects: [{ id: project_id, archived: true }] })({ version: 1, installation_id, project_id }), "canonical_installed_state_unavailable");
throwsCode(() => reader({ installation_id: "installation_other_0001", projects: [{ id: project_id }] })({ version: 1, installation_id, project_id }), "canonical_installed_state_unavailable");
console.log("canonical-installed-state.test.js: all assertions passed");
