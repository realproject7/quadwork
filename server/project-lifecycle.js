const {
  readConfig,
  validateV2Configuration,
  normalizeProjectRepositories,
  ConfigurationValidationError,
} = require("./config");
const {
  beginProjectLifecycleTransition,
  releaseProjectLifecycleTransition,
  commitProjectLifecycleConfiguration,
} = require("./project-lifecycle-authority");
const {
  archiveProjectEnvironmentSettings,
  unarchiveProjectEnvironmentSettings,
} = require("./project-environment-bindings");

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

function unarchiveCandidate(
  projectId,
  config,
  validateConfiguration = validateV2Configuration,
) {
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

function reserveUnarchiveOwnership(projectId, config, validateConfiguration) {
  const state = unarchiveCandidate(projectId, config, validateConfiguration);
  if (state.already_unarchived) return { ...state, reservation: null };
  const reservation = beginProjectLifecycleTransition("unarchive", projectId, config, {
    validateV2Configuration: validateConfiguration,
    normalizeProjectRepositories,
    validationError: (code, field, message, ownerProjectId) =>
      new ConfigurationValidationError(code, field, message, ownerProjectId),
  });
  return { ...state, reservation };
}

function releaseUnarchiveOwnership(projectId, reservation) {
  void projectId;
  releaseProjectLifecycleTransition(reservation);
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
  if (Object.prototype.hasOwnProperty.call(current || {}, "project_admission_generations")) {
    const registry = current.project_admission_generations;
    const validShape = !!registry && typeof registry === "object" && !Array.isArray(registry);
    const validEntries = validShape && Object.entries(registry).every(([id, generation]) =>
      !!id && Number.isSafeInteger(generation) && generation >= 0);
    if (!validEntries) {
      return { admitted: false, code: "invalid_project_admission_registry", status: 503, project: null };
    }
  }
  const project = projectFromConfig(current, projectId);
  if (!project) return { admitted: false, code: "unknown_project", status: 404, project: null };
  if (Object.prototype.hasOwnProperty.call(project, "archived") && typeof project.archived !== "boolean") {
    return { admitted: false, code: "invalid_project_archive_state", status: 503, project };
  }
  if (Object.prototype.hasOwnProperty.call(project, "admission_generation") &&
      (!Number.isSafeInteger(project.admission_generation) || project.admission_generation < 0)) {
    return { admitted: false, code: "invalid_project_admission_generation", status: 503, project };
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
    invalid_project_admission_generation: "project admission generation is invalid",
    invalid_project_admission_registry: "project admission registry is invalid",
  };
  throw lifecycleError(
    state.code,
    projectId,
    messages[state.code] || "project is not admitted",
    state.status,
  );
}

function persistedAdmissionGeneration(project) {
  return Number.isSafeInteger(project?.admission_generation) && project.admission_generation >= 0
    ? project.admission_generation
    : 0;
}

function registryAdmissionGeneration(config, projectId) {
  const registry = config?.project_admission_generations;
  if (!registry || !Object.prototype.hasOwnProperty.call(registry, projectId)) return 0;
  const value = registry[projectId];
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function setRegistryAdmissionGeneration(config, projectId, generation) {
  if (!config.project_admission_generations || typeof config.project_admission_generations !== "object" ||
      Array.isArray(config.project_admission_generations)) {
    config.project_admission_generations = {};
  }
  // Assignment to a plain object's `__proto__` key invokes its legacy setter
  // instead of creating an enumerable JSON property. defineProperty keeps every
  // accepted project id as an own, serializable tombstone key.
  Object.defineProperty(config.project_admission_generations, projectId, {
    value: generation,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function currentAdmissionGeneration(projectId, config, options = {}) {
  let durable = 0;
  let current = config;
  if (current === undefined) {
    try { current = (options.readConfig || readConfig)(); }
    catch { current = null; }
  }
  durable = Math.max(
    persistedAdmissionGeneration(projectFromConfig(current, projectId)),
    registryAdmissionGeneration(current, projectId),
  );
  return Math.max(durable, admissionGenerations.get(projectId) || 0);
}

function revokeProjectAdmission(projectId, options = {}) {
  requireProjectId(projectId);
  const requested = options && options.generation;
  const current = currentAdmissionGeneration(projectId, undefined, options);
  const next = Number.isSafeInteger(requested) && requested >= 0
    ? Math.max(requested, current)
    : current + 1;
  admissionGenerations.set(projectId, next);
  return next;
}

function captureProjectAdmission(projectId, options = {}) {
  // Lease issuance always re-reads the live persisted authority. Accepting a
  // caller snapshot here would let a stale pre-archive config mint a fresh
  // post-revocation token.
  let config;
  try { config = (options.readConfig || readConfig)(); }
  catch { config = undefined; }
  assertProjectAdmitted(projectId, config, options);
  return Object.freeze({
    project_id: projectId,
    generation: currentAdmissionGeneration(projectId, config, options),
  });
}

function isAdmissionCurrent(token, options = {}) {
  if (!token || typeof token.project_id !== "string" || !Number.isInteger(token.generation)) {
    return false;
  }
  let config;
  try { config = (options.readConfig || readConfig)(); }
  catch { return false; }
  if (token.generation !== currentAdmissionGeneration(token.project_id, config, options)) return false;
  // As with issuance, completion checks consult live persisted authority. A
  // stale caller snapshot must never re-authorize post-await fan-out or writes.
  return !isProjectArchived(token.project_id, config, options);
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
  const commitConfiguration = options.commitV2Configuration || commitProjectLifecycleConfiguration;
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

  function beginTransition(kind, projectId) {
    return beginProjectLifecycleTransition(kind, projectId, null, {
      normalizeProjectRepositories,
      validateV2Configuration: validateConfiguration,
      validationError: (code, field, message, ownerProjectId) =>
        new ConfigurationValidationError(code, field, message, ownerProjectId),
    });
  }

  async function commitArchived(projectId, archived, lifecycleTransition) {
    let previousArchived = null;
    let generation = null;
    await commitConfiguration((config) => {
      const project = projectFromConfig(config, projectId);
      if (!project) {
        throw lifecycleError("unknown_project", projectId, "project is not configured", 404);
      }
      previousArchived = project.archived === true;
      const currentGeneration = currentAdmissionGeneration(projectId, config);
      // Pre-epoch releases could persist archived:true without any durable
      // generation. The first lifecycle touch must advance that legacy zero,
      // otherwise remove + same-id recreation can revive generation-0 work.
      const needsLegacyArchivedEpoch = archived === true && previousArchived === true && currentGeneration === 0;
      if (previousArchived !== archived || needsLegacyArchivedEpoch) {
        if (currentGeneration >= Number.MAX_SAFE_INTEGER) {
          throw lifecycleError("project_admission_generation_exhausted", projectId, "project admission generation is exhausted", 503);
        }
        generation = currentGeneration + 1;
      } else {
        generation = currentGeneration;
      }
      project.admission_generation = generation;
      setRegistryAdmissionGeneration(config, projectId, generation);
      // The local watcher is part of the durable project state, so archive
      // disables it in the same commit that closes admission—before any
      // asynchronous cleanup/teardown begins. Restore deliberately does not
      // revive it; a later Settings action must opt in again.
      const governedEnvironmentSettings = archived
        ? archiveProjectEnvironmentSettings(project)
        : unarchiveProjectEnvironmentSettings(project);
      project.watch_batch_requests = governedEnvironmentSettings.watch_batch_requests;
      project.archived = archived;
    }, lifecycleTransition);
    return { previousArchived, generation };
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

  async function archiveUnlocked(projectId, lifecycleTransition) {
    const committed = await commitArchived(projectId, true, lifecycleTransition);
    const generation = revokeAdmission(projectId, { generation: committed.generation });
    const cleanup = await cleanupArchivedProject(projectId);
    return {
      ok: cleanup.ok,
      project_id: projectId,
      archived: true,
      already_archived: committed.previousArchived === true,
      admission_generation: generation,
      resources: cleanup.resources,
      cleanup_errors: cleanup.cleanup_errors,
    };
  }

  function archiveProject(projectId) {
    return serialize(projectId, async () => {
      const transition = beginTransition("archive", projectId);
      try {
        return await archiveUnlocked(projectId, transition);
      } finally {
        releaseProjectLifecycleTransition(transition);
      }
    });
  }

  function unarchiveProject(projectId) {
    return serialize(projectId, async () => {
      let current;
      try {
        current = readConfiguration();
      } catch {
        throw lifecycleError("project_config_unavailable", projectId, "project configuration is unavailable", 503);
      }
      const preflight = reserveUnarchiveOwnership(projectId, current, validateConfiguration);
      if (preflight.already_unarchived) {
        return {
          ok: true,
          project_id: projectId,
          archived: false,
          already_unarchived: true,
          admission_generation: currentAdmissionGeneration(projectId, current),
          resources: {},
          cleanup_errors: [],
        };
      }

      try {
        // A prior archive may have returned partial cleanup. Re-run the same
        // idempotent quiesce path while the persisted admission barrier is
        // still set; only a truthful all-clear may make the project eligible.
        const cleanup = await cleanupArchivedProject(projectId);
        if (!cleanup.ok) {
          return {
            ok: false,
            project_id: projectId,
            archived: true,
            already_unarchived: false,
            admission_generation: currentAdmissionGeneration(projectId, current),
            resources: cleanup.resources,
            cleanup_errors: cleanup.cleanup_errors,
          };
        }

        const committed = await commitArchived(projectId, false, preflight.reservation);
        revokeAdmission(projectId, { generation: committed.generation });
        return {
          ok: true,
          project_id: projectId,
          archived: false,
          already_unarchived: false,
          admission_generation: committed.generation,
          resources: cleanup.resources,
          cleanup_errors: [],
        };
      } finally {
        releaseUnarchiveOwnership(projectId, preflight.reservation);
      }
    });
  }

  function removeProject(projectId) {
    return serialize(projectId, async () => {
      const transition = beginTransition("remove", projectId);
      try {
        const archived = await archiveUnlocked(projectId, transition);
        if (!archived.ok) return { ...archived, removed: false };
        await commitConfiguration((config) => {
          const before = Array.isArray(config.projects) ? config.projects.length : 0;
          config.projects = (config.projects || []).filter((project) => project && project.id !== projectId);
          if (config.projects.length === before) {
            throw lifecycleError("unknown_project", projectId, "project is not configured", 404);
          }
        }, transition);
        return { ...archived, removed: true };
      } finally {
        releaseProjectLifecycleTransition(transition);
      }
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
  _admissionGenerations: admissionGenerations,
};
