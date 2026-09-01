"use strict";

// #1032: static, side-effect-free readiness for the explicit V2 repository
// activation flow. Runtime observers (Monitor, queue, lifecycle) add their
// own live facts; this module deliberately reads neither config nor files.

const { normalizeCiPolicy, CiEvidencePolicyError } = require("./ci-evidence-policy");

const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function reason(code, extra = {}) {
  return Object.freeze({ code, ...extra });
}

/**
 * Return the configuration-only V2 readiness for one project.
 *
 * This is intentionally narrower than config.validateV2Configuration(): the
 * latter validates an entire persisted installation (and may inspect path
 * identity), while this helper gives Settings/setup a stable, typed list of
 * operator-actionable reasons without touching disk or changing its input.
 */
function projectV2Readiness(project) {
  const reasons = [];
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    return Object.freeze({ ready: false, reasons: Object.freeze([reason("invalid_project")]) });
  }

  const persistedScalar = hasOwn(project, "repo") || hasOwn(project, "working_dir");
  if (persistedScalar || !Array.isArray(project.repositories)) {
    reasons.push(reason("legacy_scalar"));
  }

  const repositories = Array.isArray(project.repositories) ? project.repositories : [];
  if (repositories.length === 0) reasons.push(reason("repositories_required"));

  const keys = new Set();
  const names = new Set();
  let primaryCount = 0;
  for (const entry of repositories) {
    const repoKey = typeof entry?.key === "string" ? entry.key : null;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      reasons.push(reason("invalid_repository"));
      continue;
    }
    if (!repoKey || !REPOSITORY_KEY_RE.test(repoKey)) {
      reasons.push(reason("invalid_repository_key", repoKey ? { repo_key: repoKey } : {}));
    } else if (keys.has(repoKey)) {
      reasons.push(reason("duplicate_repository_key", { repo_key: repoKey }));
    } else {
      keys.add(repoKey);
    }

    const repo = typeof entry.repo === "string" ? entry.repo.trim() : "";
    if (!REPOSITORY_RE.test(repo)) {
      reasons.push(reason("invalid_repository_name", repoKey ? { repo_key: repoKey } : {}));
    } else {
      const canonical = repo.toLowerCase();
      if (names.has(canonical)) reasons.push(reason("duplicate_repository", { repo_key: repoKey || undefined }));
      else names.add(canonical);
    }

    if (entry.primary === true) primaryCount += 1;
    if (!hasOwn(entry, "ci_policy")) {
      reasons.push(reason("missing_policy", repoKey ? { repo_key: repoKey } : {}));
    } else {
      try {
        normalizeCiPolicy(entry.ci_policy);
      } catch (error) {
        const policyCode = error instanceof CiEvidencePolicyError && typeof error.code === "string"
          ? error.code
          : "invalid_ci_policy";
        reasons.push(reason("invalid_ci_policy", {
          ...(repoKey ? { repo_key: repoKey } : {}),
          policy_code: policyCode,
        }));
      }
    }
  }
  if (primaryCount !== 1) reasons.push(reason("invalid_primary_repository_count", { primary_count: primaryCount }));

  return Object.freeze({
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

module.exports = { projectV2Readiness };
