// Internal lifecycle transition authority. This module is deliberately not
// re-exported from config.js: generic config callers may edit configuration,
// but only the project lifecycle controller may mint one of these opaque,
// process-local transition objects.

const activeTransitions = new Map();
let lifecycleCommitter = null;

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function projectFromConfig(config, projectId) {
  return Array.isArray(config?.projects)
    ? config.projects.find((project) => project && project.id === projectId) || null
    : null;
}

function ownershipSignature(project, normalizeProjectRepositories) {
  return JSON.stringify(normalizeProjectRepositories(project));
}

function transitionError(validationError, code, projectId, message) {
  return validationError(code, "projects", message, projectId);
}

function assertCurrentTransition(token, projectId, allowedKinds) {
  return !!token &&
    token.project_id === projectId &&
    allowedKinds.includes(token.kind) &&
    activeTransitions.get(projectId) === token;
}

function beginProjectLifecycleTransition(kind, projectId, config, options = {}) {
  if (!new Set(["archive", "unarchive", "remove"]).has(kind)) {
    throw new TypeError("unknown project lifecycle transition");
  }
  if (typeof projectId !== "string" || !projectId) {
    throw new TypeError("project id is required for lifecycle transition");
  }
  if (activeTransitions.has(projectId)) {
    throw transitionError(
      options.validationError,
      "project_lifecycle_busy",
      projectId,
      "project lifecycle transition is already in progress",
    );
  }

  let signature = null;
  if (kind === "unarchive") {
    const project = projectFromConfig(config, projectId);
    if (!project) {
      throw transitionError(
        options.validationError,
        "project_ownership_reserved",
        projectId,
        "project is not configured",
      );
    }
    signature = ownershipSignature(project, options.normalizeProjectRepositories);

    const projected = clone(config);
    projectFromConfig(projected, projectId).archived = false;
    for (const transition of activeTransitions.values()) {
      if (transition.kind !== "unarchive") continue;
      const reserved = projectFromConfig(projected, transition.project_id);
      if (!reserved || ownershipSignature(reserved, options.normalizeProjectRepositories) !== transition.ownership_signature) {
        throw transitionError(
          options.validationError,
          "project_ownership_reserved",
          transition.project_id,
          "reserved project ownership cannot be changed",
        );
      }
      reserved.archived = false;
    }
    options.validateV2Configuration(projected, {
      previousConfig: config,
      fsImpl: options.fsImpl,
    });
  }

  const token = Object.freeze({ kind, project_id: projectId, ownership_signature: signature });
  activeTransitions.set(projectId, token);
  return token;
}

function releaseProjectLifecycleTransition(token) {
  if (!token || typeof token.project_id !== "string") return;
  if (activeTransitions.get(token.project_id) === token) {
    activeTransitions.delete(token.project_id);
  }
}

function registerProjectLifecycleCommitter(committer) {
  if (typeof committer !== "function") throw new TypeError("lifecycle committer must be a function");
  if (lifecycleCommitter && lifecycleCommitter !== committer) {
    throw new Error("project lifecycle committer is already registered");
  }
  lifecycleCommitter = committer;
}

function commitProjectLifecycleConfiguration(mutator, token, options = {}) {
  if (!lifecycleCommitter) throw new Error("project lifecycle committer is unavailable");
  return lifecycleCommitter(mutator, token, options);
}

function assertProjectLifecycleTransitions(candidate, previousConfig, token, options = {}) {
  const validationError = options.validationError;
  const normalizeProjectRepositories = options.normalizeProjectRepositories;

  for (const transition of activeTransitions.values()) {
    if (transition.kind !== "unarchive") continue;
    const project = projectFromConfig(candidate, transition.project_id);
    if (!project) {
      throw transitionError(
        validationError,
        "project_ownership_reserved",
        transition.project_id,
        "reserved project cannot be removed",
      );
    }
    if (ownershipSignature(project, normalizeProjectRepositories) !== transition.ownership_signature) {
      throw transitionError(
        validationError,
        "project_ownership_reserved",
        transition.project_id,
        "reserved project ownership cannot be changed",
      );
    }
    if (project.archived !== true && token !== transition) {
      throw transitionError(
        validationError,
        "project_ownership_reserved",
        transition.project_id,
        "reserved project cannot be activated before cleanup completes",
      );
    }
  }

  if (activeTransitions.size > 0) {
    const projected = clone(candidate);
    for (const transition of activeTransitions.values()) {
      if (transition.kind !== "unarchive") continue;
      projectFromConfig(projected, transition.project_id).archived = false;
    }
    options.validateV2Configuration(projected, {
      previousConfig: previousConfig || candidate,
      fsImpl: options.fsImpl,
    });
  }

  for (const previous of previousConfig?.projects || []) {
    if (!previous || typeof previous.id !== "string") continue;
    const next = projectFromConfig(candidate, previous.id);
    if (!next) {
      if (!assertCurrentTransition(token, previous.id, ["remove"])) {
        throw transitionError(
          validationError,
          "project_lifecycle_transition_required",
          previous.id,
          "removing a project requires lifecycle cleanup authority",
        );
      }
      continue;
    }

    const wasArchived = previous.archived === true;
    const isArchived = next.archived === true;
    if (!wasArchived && isArchived && !assertCurrentTransition(token, previous.id, ["archive", "remove"])) {
      throw transitionError(
        validationError,
        "project_lifecycle_transition_required",
        previous.id,
        "archiving a project requires lifecycle cleanup authority",
      );
    }
    if (wasArchived && !isArchived && !assertCurrentTransition(token, previous.id, ["unarchive"])) {
      throw transitionError(
        validationError,
        "project_ownership_reserved",
        previous.id,
        "archived project activation requires its cleanup authority",
      );
    }
  }
}

module.exports = {
  beginProjectLifecycleTransition,
  releaseProjectLifecycleTransition,
  registerProjectLifecycleCommitter,
  commitProjectLifecycleConfiguration,
  assertProjectLifecycleTransitions,
};
