"use strict";

// Reads only the existing conditional REST snapshot assembled by routes.js.
// It intentionally cannot fetch GitHub: cold, stale, or body-less cache data
// is a fail-closed absence rather than a reason to start a second poller.

const REVISION_RE = /^[a-f0-9]{64}$/;

function currentContractObservation(snapshot, issueNumber, now = Date.now(), maxAgeMs = 90_000) {
  if (!snapshot || !Number.isSafeInteger(issueNumber) || issueNumber < 1 || !Number.isFinite(snapshot.ts) ||
      !Number.isFinite(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || now - snapshot.ts > maxAgeMs) {
    return null;
  }
  const issue = Array.isArray(snapshot.issues) ? snapshot.issues.find((entry) => entry?.number === issueNumber) : null;
  if (!issue || !REVISION_RE.test(issue.contract_revision)) return null;
  return Object.freeze({ contract_revision: issue.contract_revision, observed_at: new Date(snapshot.ts).toISOString(), source: "github_conditional_rest_cache" });
}

module.exports = { currentContractObservation };
