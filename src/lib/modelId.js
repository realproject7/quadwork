// #1172: single source of truth for the accepted agent model-id shape. It
// excludes quotes, whitespace and a leading "-", so an id can never break
// Codex's `-c model="<id>"` quoting or be read as a flag. Used by the
// agent-models PUT route, the config write routes and the spawn path
// (server/agent-model-catalog.js) and by both Settings surfaces
// (src/lib/agentModels.ts).
//
// Plain JS on purpose (not .ts), like injectMode.js: it is required by Node
// production code under server/ and shipped via package.json `files`.

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

/**
 * @param {unknown} id
 * @returns {id is string}
 */
function isValidModelId(id) {
  return typeof id === "string" && MODEL_ID_PATTERN.test(id);
}

module.exports = { MODEL_ID_PATTERN, isValidModelId };
