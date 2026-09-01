"use strict";

// #1032 activation guards are pure. Routes supply a narrow queue/assignment
// observation; this module never reads config, queue files, or runtime state.

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function isLegacyScalarProject(project) {
  return !!project && typeof project === "object" && !Array.isArray(project) &&
    !Array.isArray(project.repositories) && (hasOwn(project, "repo") || hasOwn(project, "working_dir"));
}

function normalizedObservation(observation) {
  const state = typeof observation?.state === "string" ? observation.state : "state_unavailable";
  return state;
}

function firstActivationLegacyGuard(config, targetProjectId, observeProject) {
  if (hasOwn(config, "installation_id")) return Object.freeze({ ok: true, first_activation: false });
  const projects = Array.isArray(config?.projects) ? config.projects : [];
  for (const project of projects) {
    if (!isLegacyScalarProject(project) || project.id === targetProjectId) continue;
    let state;
    try { state = normalizedObservation(observeProject(project)); }
    catch { state = "state_unavailable"; }
    if (state !== "clear") {
      return Object.freeze({
        ok: false,
        code: "first_activation_legacy_project_blocked",
        project_id: typeof project.id === "string" ? project.id : "unknown",
        state,
      });
    }
  }
  return Object.freeze({ ok: true, first_activation: true });
}

function targetActivationGuard(project, observeProject) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    return Object.freeze({ ok: false, code: "project_not_found" });
  }
  if (project.archived === true) return Object.freeze({ ok: false, code: "project_archived", state: "archived" });
  let state;
  try { state = normalizedObservation(observeProject(project)); }
  catch { state = "state_unavailable"; }
  if (state !== "clear") return Object.freeze({ ok: false, code: "project_not_quiesced", state });
  return Object.freeze({ ok: true });
}

module.exports = {
  isLegacyScalarProject,
  firstActivationLegacyGuard,
  targetActivationGuard,
};
