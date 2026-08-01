// #1023: which CLI should a newly-added project default its agents to when the
// configured default_backend isn't actually installed?
//
// The old inline chain in SettingsPage.addProject could only ever answer
// "claude" or "codex", so a grok-only machine seeded the uninstalled "claude" —
// and so did a gemini-only one, the same pre-existing bug (fixed deliberately;
// see the ticket's operator ruling). Structurally a hardcoded two-arm chain
// cannot express a fourth backend.
//
// This is a loop over the caller's own backend list, NOT a backend registry:
// the list is passed in, so this module knows nothing about which backends
// exist. Extracted as a pure module (same rationale as injectMode.js) because
// addProject is a React-only surface — this way the node test exercises the
// SAME code the UI runs rather than a mirror of it.

/**
 * The first backend in `backendValues` that `cliStatus` reports as installed.
 *
 * @param {Record<string, boolean>|null} cliStatus - /api/cli-status response
 * @param {string[]} backendValues - candidate backends, in preference order
 * @param {string} [fallback] - used when cliStatus is unknown or nothing matches
 */
function firstInstalledBackend(cliStatus, backendValues, fallback = "claude") {
  if (!cliStatus) return fallback;
  return (backendValues || []).find((v) => cliStatus[v]) || fallback;
}

module.exports = { firstInstalledBackend };
