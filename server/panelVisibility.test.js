"use strict";

// #1052: deterministic seam test for the dashboard right-rail panel state.
// The helper is the single source of truth for defaults, the #668 migration,
// and the persistence key; the React component only reads and writes storage.
// Covering it here keeps the contract enforced by `npm test` rather than by a
// browser pass alone.

const assert = require("node:assert/strict");
const {
  DEFAULT_PANEL_VISIBILITY,
  LEGACY_TERMINALS_COLLAPSED_KEY,
  PANEL_IDS,
  panelVisibilityKey,
  resolvePanelVisibility,
  serializePanelVisibility,
} = require("../src/lib/panelVisibility");

// First visit: Agent Terminals and GitHub open, Operator Features closed.
{
  assert.deepEqual(resolvePanelVisibility(null, null), { terminals: true, github: true, operator: false });
  assert.deepEqual(resolvePanelVisibility(undefined, undefined), DEFAULT_PANEL_VISIBILITY);
  assert.equal(DEFAULT_PANEL_VISIBILITY.operator, false, "Operator Features is collapsed until the operator opens it");
}

// Persistence is per project, so two projects never share panel state.
{
  assert.equal(panelVisibilityKey("alpha"), "qw-panel-visibility:alpha");
  assert.notEqual(panelVisibilityKey("alpha"), panelVisibilityKey("beta"));
  assert.equal(panelVisibilityKey(null), "qw-panel-visibility:");
}

// Each panel resolves independently: collapsing one never closes another, and
// a partial record fills only its missing panels from the defaults.
{
  const saved = resolvePanelVisibility('{"terminals":true,"github":false,"operator":true}', null);
  assert.deepEqual(saved, { terminals: true, github: false, operator: true });

  const partial = resolvePanelVisibility('{"github":false}', null);
  assert.deepEqual(partial, { terminals: true, github: false, operator: false });
}

// Malformed storage must not throw and must not collapse the whole rail.
{
  for (const bad of ["", "not json", "[]", "null", '"github"', "42", '{"github":"no"}']) {
    const resolved = resolvePanelVisibility(bad, null);
    assert.deepEqual(resolved, DEFAULT_PANEL_VISIBILITY, `malformed input ${JSON.stringify(bad)} falls back to defaults`);
    for (const id of PANEL_IDS) assert.equal(typeof resolved[id], "boolean");
  }
}

// #668 migration: the old global collapse flag is honoured exactly once, only
// while the per-project record has no `terminals` entry of its own.
{
  assert.equal(resolvePanelVisibility(null, "true").terminals, false, "legacy collapsed migrates to collapsed");
  assert.equal(resolvePanelVisibility(null, "false").terminals, true, "legacy expanded migrates to expanded");
  assert.equal(resolvePanelVisibility('{"terminals":true}', "true").terminals, true,
    "an explicit per-project value wins over the legacy flag");
  assert.equal(resolvePanelVisibility('{"github":false}', "true").terminals, false,
    "the legacy flag still applies when only other panels were saved");
  assert.equal(resolvePanelVisibility(null, "yes").terminals, true, "an unrecognised legacy value is ignored");
  assert.equal(LEGACY_TERMINALS_COLLAPSED_KEY, "qw-terminals-collapsed");
}

// Serialize -> resolve is stable, so a reload restores exactly what was shown.
{
  for (const state of [
    { terminals: true, github: true, operator: false },
    { terminals: false, github: false, operator: false },
    { terminals: true, github: false, operator: true },
  ]) {
    assert.deepEqual(resolvePanelVisibility(serializePanelVisibility(state), null), state);
  }
  assert.deepEqual(JSON.parse(serializePanelVisibility({})), { terminals: true, github: true, operator: true },
    "serialization records every panel explicitly");
}

// The rail has exactly the three top-level panels the ticket names.
{
  assert.deepEqual(PANEL_IDS, ["terminals", "github", "operator"]);
  assert.deepEqual(Object.keys(DEFAULT_PANEL_VISIBILITY).sort(), [...PANEL_IDS].sort());
}

console.log("panelVisibility.test.js: all assertions passed");
