"use strict";

// The legacy V1 workflow is bundled with this server during the V2 transition;
// it is not inferred from a caller path, worktree, or client assertion.  This
// narrow read capability records that installed compatibility fact alongside a
// V2 candidate while binding it to the live installation/project identity.

const VERSION = 1;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class CanonicalInstalledStateError extends Error {
  constructor(code, message = code) { super(message); this.name = "CanonicalInstalledStateError"; this.code = code; }
}
function fail(code, message) { throw new CanonicalInstalledStateError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) { if (!plain(value)) fail(code, "value must be a plain object"); const actual = Object.keys(value).sort(), expected = [...fields].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, "value has unknown or missing fields"); }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) Object.freeze(value); return value; }
function identity(value) {
  exact(value, ["version", "installation_id", "project_id"], "invalid_canonical_installed_state_identity");
  if (value.version !== VERSION || !INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id)) fail("invalid_canonical_installed_state_identity", "identity is invalid");
  return value;
}
function createCanonicalInstalledStateReader(options) {
  exact(options, ["read_config"], "invalid_canonical_installed_state_options");
  if (typeof options.read_config !== "function") fail("invalid_canonical_installed_state_options", "config reader is required");
  return function readCanonicalInstalledState(value) {
    const requested = identity(value);
    let config;
    try { config = options.read_config(); } catch { fail("canonical_installed_state_unavailable", "configuration is unavailable"); }
    if (!plain(config) || config.installation_id !== requested.installation_id || !Array.isArray(config.projects)) {
      fail("canonical_installed_state_unavailable", "installation is unavailable");
    }
    const projects = config.projects.filter((project) => plain(project) && project.id === requested.project_id && project.archived !== true);
    if (projects.length !== 1) fail("canonical_installed_state_unavailable", "project is unavailable");
    return freeze({ version: VERSION, installation_id: requested.installation_id, project_id: requested.project_id, v1_state: "present" });
  };
}
module.exports = { VERSION, CanonicalInstalledStateError, createCanonicalInstalledStateReader };
