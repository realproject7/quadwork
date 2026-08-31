const {
  readConfig,
  commitV2Configuration,
  validateV2Configuration,
} = require("./config");

const admissionGenerations = new Map();
const projectLifecycleLocks = new Map();

class ProjectLifecycleError extends Error {
  constructor(code, projectId, message, status = 409) {
    super(message);
    this.name = "ProjectLifecycleError";
    this.code = code;
    this.project_id = projectId;
    this.status = status;
  }
}

function lifecycleError(code, projectId, message, status) {
  return new ProjectLifecycleError(code, projectId, message, status);
}

function requireProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw lifecycleError("invalid_project_id", projectId, "project id is required", 400);
  }
  return projectId;
}

function projectFromConfig(config, projectId) {
  if (!config || !Array.isArray(config.projects)) return null;
  return config.projects.find((project) => project && project.id === projectId) || null;
}

function unarchiveCandidate(projectId, config, validateConfiguration = validateV2Configuration) {
  requireProjectId(projectId);
  const project = projectFromConfig(config, projectId);
  if (!project) throw lifecycleError("unknown_project", projectId, "project is not configured", 404);
  if (Object.prototype.hasOwnProperty.call(project, "archived") && typeof project.archived !== "boolean") {
    throw lifecycleError("invalid_project_archive_state", projectId, "project archive state is invalid", 503);
  }
  if (project.archived !== true) return { already_unarchived: true };

  // Validate the active ownership candidate before touching any remaining
  // archived runtime. A repository/path collision must leave both the durable
  // barrier and the stopped-resource set byte-for-byte unchanged.
  const candidate = {
    ...config,
    projects: config.projects.map((entry) => entry === project ? { ...entry, archived: false } : entry),
  };
  validateConfiguration(candidate, { previousConfig: config });
  return { already_unarchived: false };
}

function admissionState(projectId, config, options = {}) {
  requireProjectId(projectId);
  let current = config;
  if (current === undefined) {
    try {
      current = (options.readConfig || readConfig)();
    } catch {
      return { admitted: false, code: "project_config_unavailable", status: 503, project: null };
    }
  }
  const project = projectFromConfig(current, projectId);
  if (!project) return { admitted: false, code: "unknown_project", status: 404, project: null };
  if (Object.prototype.hasOwnProperty.call(project, "archived") && typeof project.archived !== "boolean") {
    return { admitted: false, code: "invalid_project_archive_state", status: 503, project };
  }
  if (project.archived === true) {
    return { admitted: false, code: "project_archived", status: 409, project };
  }
  return { admitted: true, code: null, status: 200, project };
}

// Unknown projects and unreadable configuration are treated as unavailable.
// Runtime callers must fail closed instead of guessing that work is admitted.
function isProjectArchived(projectId, config, options = {}) {
  return !admissionState(projectId, config, options).admitted;
}

function assertProjectAdmitted(projectId, config, options = {}) {
  const state = admissionState(projectId, config, options);
  if (state.admitted) return state.project;
  const messages = {
    project_config_unavailable: "project configuration is unavailable",
    unknown_project: "project is not configured",
    project_archived: "project is archived",
    invalid_project_archive_state: "project archive state is invalid",
  };
  throw lifecycleError(
    state.code,
    projectId,
    messages[state.code] || "project is not admitted",
    state.status,
  );
}

function currentAdmissionGeneration(projectId) {
  return admissionGenerations.get(projectId) || 0;
}

function revokeProjectAdmission(projectId) {
  requireProjectId(projectId);
  const next = currentAdmissionGeneration(projectId) + 1;
  admissionGenerations.set(projectId, next);
  return next;
}

function captureProjectAdmission(projectId, options = {}) {
  // Lease issuance always re-reads the live persisted authority. Accepting a
  // caller snapshot here would let a stale pre-archive config mint a fresh
  // post-revocation token.
  assertProjectAdmitted(projectId, undefined, options);
  return Object.freeze({
    project_id: projectId,
    generation: currentAdmissionGeneration(projectId),
  });
}

function isAdmissionCurrent(token, options = {}) {
  if (!token || typeof token.project_id !== "string" || !Number.isInteger(token.generation)) {
    return false;
  }
  if (token.generation !== currentAdmissionGeneration(token.project_id)) return false;
  // As with issuance, completion checks consult live persisted authority. A
  // stale caller snapshot must never re-authorize post-await fan-out or writes.
  return !isProjectArchived(token.project_id, undefined, options);
}

function safeCleanupError(error, fallbackResource = "project") {
  const source = error && typeof error === "object" ? error : {};
  const resource = typeof source.resource === "string" && source.resource
    ? source.resource.slice(0, 64)
    : fallbackResource;
  const code = typeof source.code === "string" && source.code
    ? source.code.slice(0, 64)
    : "cleanup_failed";
  const rawMessage = typeof source.message === "string"
    ? source.message
    : typeof error === "string"
      ? error
      : "project cleanup failed";
  return {
    resource,
    code,
    message: rawMessage.replace(/[\r\n\t]+/g, " ").slice(0, 300),
  };
}

function normalizeResourceCounts(resources) {
  if (resources === undefined) return { valid: true, counts: {} };
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    return { valid: false, counts: {} };
  }
  const normalized = {};
  for (const [key, value] of Object.entries(resources)) {
    if (typeof key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      return { valid: false, counts: {} };
    }
    if (!Number.isSafeInteger(value) || value < 0) return { valid: false, counts: {} };
    normalized[key] = value;
  }
  return { valid: true, counts: normalized };
}

function normalizeCleanupResult(result) {
  const source = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const rawErrors = Array.isArray(source.cleanup_errors)
    ? source.cleanup_errors
    : Array.isArray(source.errors)
      ? source.errors
      : [];
  const cleanupErrors = rawErrors.map((error) => safeCleanupError(error));
  const resources = normalizeResourceCounts(source.resources);
  if (!resources.valid) {
    cleanupErrors.push(safeCleanupError({
      resource: "project",
      code: "invalid_cleanup_result",
      message: "project cleanup returned invalid resource counts",
    }));
  }
  if ((source.cleanup_errors !== undefined && !Array.isArray(source.cleanup_errors)) ||
      (source.errors !== undefined && !Array.isArray(source.errors))) {
    cleanupErrors.push(safeCleanupError({
      resource: "project",
      code: "invalid_cleanup_result",
      message: "project cleanup returned an invalid error list",
    }));
  }
  if (source.ok !== true && cleanupErrors.length === 0) {
    cleanupErrors.push(safeCleanupError({
      resource: "project",
      code: "cleanup_incomplete",
      message: "project cleanup did not complete",
    }));
  }
  return {
    ok: source.ok === true && cleanupErrors.length === 0,
    resources: resources.counts,
    cleanup_errors: cleanupErrors,
  };
}

function createProjectLifecycleController(options = {}) {
  const commitConfiguration = options.commitV2Configuration || commitV2Configuration;
  const cleanupProject = options.cleanupProject;
  const revokeAdmission = options.revokeProjectAdmission || revokeProjectAdmission;
  const readConfiguration = options.readConfig || readConfig;
  const validateConfiguration = options.validateV2Configuration || validateV2Configuration;

  function serialize(projectId, operation) {
    requireProjectId(projectId);
    const previous = projectLifecycleLocks.get(projectId) || Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    projectLifecycleLocks.set(projectId, tail);
    tail.finally(() => {
      if (projectLifecycleLocks.get(projectId) === tail) projectLifecycleLocks.delete(projectId);
    });
    return run;
  }

  async function commitArchived(projectId, archived) {
    let previousArchived = null;
    await commitConfiguration((config) => {
      const project = projectFromConfig(config, projectId);
      if (!project) {
        throw lifecycleError("unknown_project", projectId, "project is not configured", 404);
      }
      previousArchived = project.archived === true;
      project.archived = archived;
    });
    return previousArchived;
  }

  async function cleanupArchivedProject(projectId) {
    if (typeof cleanupProject !== "function") {
      return normalizeCleanupResult({
        ok: false,
        cleanup_errors: [{
          resource: "project",
          code: "cleanup_unavailable",
          message: "project cleanup controller is unavailable",
        }],
      });
    }
    try {
      return normalizeCleanupResult(await cleanupProject(projectId));
    } catch (error) {
      return normalizeCleanupResult({ ok: false, cleanup_errors: [safeCleanupError(error)] });
    }
  }

  async function archiveUnlocked(projectId) {
    const wasArchived = await commitArchived(projectId, true);
    const generation = revokeAdmission(projectId);
    const cleanup = await cleanupArchivedProject(projectId);
    return {
      ok: cleanup.ok,
      project_id: projectId,
      archived: true,
      already_archived: wasArchived === true,
      admission_generation: generation,
      resources: cleanup.resources,
      cleanup_errors: cleanup.cleanup_errors,
    };
  }

  function archiveProject(projectId) {
    return serialize(projectId, () => archiveUnlocked(projectId));
  }

  function unarchiveProject(projectId) {
    return serialize(projectId, async () => {
      let current;
      try {
        current = readConfiguration();
      } catch {
        throw lifecycleError("project_config_unavailable", projectId, "project configuration is unavailable", 503);
      }
      const preflight = unarchiveCandidate(projectId, current, validateConfiguration);
      if (preflight.already_unarchived) {
        return {
          ok: true,
          project_id: projectId,
          archived: false,
          already_unarchived: true,
          admission_generation: currentAdmissionGeneration(projectId),
          resources: {},
          cleanup_errors: [],
        };
      }

      // A prior archive may have returned partial cleanup. Re-run the same
      // idempotent quiesce path while the persisted admission barrier is still
      // set; only a truthful all-clear may make the project eligible again.
      const cleanup = await cleanupArchivedProject(projectId);
      if (!cleanup.ok) {
        return {
          ok: false,
          project_id: projectId,
          archived: true,
          already_unarchived: false,
          admission_generation: currentAdmissionGeneration(projectId),
          resources: cleanup.resources,
          cleanup_errors: cleanup.cleanup_errors,
        };
      }

      await commitArchived(projectId, false);
      return {
        ok: true,
        project_id: projectId,
        archived: false,
        already_unarchived: false,
        admission_generation: currentAdmissionGeneration(projectId),
        resources: cleanup.resources,
        cleanup_errors: [],
      };
    });
  }

  function removeProject(projectId) {
    return serialize(projectId, async () => {
      const archived = await archiveUnlocked(projectId);
      if (!archived.ok) return { ...archived, removed: false };
      await commitConfiguration((config) => {
        const before = Array.isArray(config.projects) ? config.projects.length : 0;
        config.projects = (config.projects || []).filter((project) => project && project.id !== projectId);
        if (config.projects.length === before) {
          throw lifecycleError("unknown_project", projectId, "project is not configured", 404);
        }
      });
      return { ...archived, removed: true };
    });
  }

  return Object.freeze({ archiveProject, unarchiveProject, removeProject });
}

module.exports = {
  ProjectLifecycleError,
  isProjectArchived,
  assertProjectAdmitted,
  captureProjectAdmission,
  isAdmissionCurrent,
  revokeProjectAdmission,
  unarchiveCandidate,
  createProjectLifecycleController,
};
