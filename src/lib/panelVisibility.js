// #1052: default / migration / persistence-key resolution for the project
// dashboard's three collapsible right-rail panels (Agent Terminals, GitHub,
// Operator Features). Pure and storage-agnostic so the Next.js client and the
// plain-node test runner can import the same production helper (same shape as
// src/lib/injectMode.js). The component owns the localStorage reads/writes.
//
// State is "expanded" booleans, one per panel, persisted per project under
// PANEL_VISIBILITY_KEY_PREFIX + projectId as JSON. The #668 global
// `qw-terminals-collapsed` preference is read as a migration source when the
// per-project value has no `terminals` entry, so it is never silently dropped.

const PANEL_IDS = ["terminals", "github", "operator"];
const DEFAULT_PANEL_VISIBILITY = Object.freeze({ terminals: true, github: true, operator: false });
const PANEL_VISIBILITY_KEY_PREFIX = "qw-panel-visibility:";
const LEGACY_TERMINALS_COLLAPSED_KEY = "qw-terminals-collapsed";

function panelVisibilityKey(projectId) {
  return `${PANEL_VISIBILITY_KEY_PREFIX}${String(projectId || "")}`;
}

/**
 * Resolve the three panel states from raw storage strings. Malformed or
 * missing input falls back per panel to the defaults; each panel resolves
 * independently (no accordion coupling).
 *
 * @param {string|null|undefined} savedRaw     value under panelVisibilityKey(projectId)
 * @param {string|null|undefined} legacyRaw    value under LEGACY_TERMINALS_COLLAPSED_KEY
 * @returns {{ terminals: boolean, github: boolean, operator: boolean }}
 */
function resolvePanelVisibility(savedRaw, legacyRaw) {
  let saved = null;
  if (typeof savedRaw === "string" && savedRaw) {
    try {
      const parsed = JSON.parse(savedRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
    } catch {
      saved = null;
    }
  }
  const result = {};
  for (const id of PANEL_IDS) {
    result[id] = saved && typeof saved[id] === "boolean" ? saved[id] : DEFAULT_PANEL_VISIBILITY[id];
  }
  if (!(saved && typeof saved.terminals === "boolean") && (legacyRaw === "true" || legacyRaw === "false")) {
    result.terminals = legacyRaw !== "true";
  }
  return result;
}

function serializePanelVisibility(state) {
  const out = {};
  for (const id of PANEL_IDS) out[id] = state && state[id] === false ? false : true;
  return JSON.stringify(out);
}

module.exports = {
  DEFAULT_PANEL_VISIBILITY,
  LEGACY_TERMINALS_COLLAPSED_KEY,
  PANEL_IDS,
  panelVisibilityKey,
  resolvePanelVisibility,
  serializePanelVisibility,
};
