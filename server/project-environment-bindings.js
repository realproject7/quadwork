"use strict";

// Pure M1 core for the manual Project Environments record. This module owns no
// I/O, discovery, session, network, config, or route authority. Later settings
// and seed writers supply persistence and the canonical repository accessor.

const ENVIRONMENT_CLASSES = Object.freeze(["local", "vps", "other"]);
const ENVIRONMENT_CLASS_SET = new Set(ENVIRONMENT_CLASSES);
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CANONICAL_REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BINDING_FIELDS = new Set([
  "installation_id",
  "project_id",
  "label",
  "environment_class",
]);

class ProjectEnvironmentBindingError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "ProjectEnvironmentBindingError";
    this.code = code;
    this.field = field;
    this.status = 400;
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  }
  return value;
}

function bindingError(code, field, message) {
  throw new ProjectEnvironmentBindingError(code, field, message);
}

function requireInstallationId(value, field = "installation_id") {
  if (typeof value !== "string" || !INSTALLATION_ID_RE.test(value)) {
    bindingError("invalid_installation_id", field, "installation_id is missing or invalid");
  }
  return value;
}

function requireProjectId(value, field = "project_id") {
  if (typeof value !== "string" || !PROJECT_ID_RE.test(value)) {
    bindingError("invalid_project_id", field, "project_id is missing or invalid");
  }
  return value;
}

function normalizeBinding(binding, index, currentIdentity) {
  const fieldPrefix = `environment_bindings[${index}]`;
  if (!isPlainObject(binding)) {
    bindingError("invalid_environment_binding", fieldPrefix, "environment binding must be an object");
  }
  for (const key of Object.keys(binding)) {
    if (!BINDING_FIELDS.has(key)) {
      bindingError("invalid_environment_binding_field", `${fieldPrefix}.${key}`, "environment binding contains an unsupported field");
    }
  }
  for (const key of BINDING_FIELDS) {
    if (!hasOwn(binding, key)) {
      bindingError("missing_environment_binding_field", `${fieldPrefix}.${key}`, "environment binding is missing a required field");
    }
  }

  const installationId = requireInstallationId(binding.installation_id, `${fieldPrefix}.installation_id`);
  const projectId = requireProjectId(binding.project_id, `${fieldPrefix}.project_id`);
  if (installationId === currentIdentity.installation_id && projectId === currentIdentity.project_id) {
    bindingError("environment_binding_self", fieldPrefix, "the current installation/project must not be stored as a peer");
  }
  if (typeof binding.label !== "string" || binding.label.trim().length === 0 ||
      binding.label.length > 120 || /[\r\n\u0000]/.test(binding.label)) {
    bindingError("invalid_environment_label", `${fieldPrefix}.label`, "environment label must be a non-empty single line up to 120 characters");
  }
  if (typeof binding.environment_class !== "string" || !ENVIRONMENT_CLASS_SET.has(binding.environment_class)) {
    bindingError("invalid_environment_class", `${fieldPrefix}.environment_class`, "environment_class must be local, vps, or other");
  }

  // Explicit allow-list: the normalized peer never inherits arbitrary input
  // metadata such as paths, addresses, hosts, capabilities, or credentials.
  return Object.freeze({
    installation_id: installationId,
    project_id: projectId,
    label: binding.label.trim(),
    environment_class: binding.environment_class,
  });
}

function resolveCoordinationRepository(project, coordinationRepoKey, resolveCanonicalRepository) {
  if (coordinationRepoKey === null) return null;
  if (typeof resolveCanonicalRepository !== "function") {
    bindingError("coordination_repository_accessor_required", "coordination_repo_key", "a canonical repository accessor is required");
  }
  let canonicalRepository;
  try {
    canonicalRepository = resolveCanonicalRepository(project, coordinationRepoKey);
  } catch {
    bindingError("coordination_repository_not_found", "coordination_repo_key", "the selected coordination repository is no longer registered");
  }
  if (typeof canonicalRepository !== "string" || !CANONICAL_REPOSITORY_RE.test(canonicalRepository)) {
    bindingError("coordination_repository_not_found", "coordination_repo_key", "the selected coordination repository is no longer registered");
  }
  return Object.freeze({
    key: coordinationRepoKey,
    canonical_repository: canonicalRepository,
  });
}

function normalizeProjectEnvironmentSettings(input) {
  if (!isPlainObject(input)) {
    bindingError("invalid_environment_settings", "environment_settings", "environment settings input is invalid");
  }
  const installationId = requireInstallationId(input.installation_id);
  if (!isPlainObject(input.project)) {
    bindingError("invalid_project", "project", "project is invalid");
  }
  const sourceProject = cloneValue(input.project);
  const currentIdentity = Object.freeze({
    installation_id: installationId,
    project_id: requireProjectId(sourceProject.id, "project.id"),
  });
  const rawBindings = hasOwn(sourceProject, "environment_bindings")
    ? sourceProject.environment_bindings
    : [];
  if (!Array.isArray(rawBindings)) {
    bindingError("invalid_environment_bindings", "environment_bindings", "environment_bindings must be an array");
  }
  const identities = new Set();
  const bindings = rawBindings.map((binding, index) => {
    const normalized = normalizeBinding(binding, index, currentIdentity);
    const identity = `${normalized.installation_id}\u0000${normalized.project_id}`;
    if (identities.has(identity)) {
      bindingError("duplicate_environment_binding", `environment_bindings[${index}]`, "environment binding identity is already registered");
    }
    identities.add(identity);
    return normalized;
  });

  let coordinationRepoKey = null;
  if (hasOwn(sourceProject, "coordination_repo_key")) {
    if (typeof sourceProject.coordination_repo_key !== "string" ||
        !REPOSITORY_KEY_RE.test(sourceProject.coordination_repo_key)) {
      bindingError("invalid_coordination_repository_key", "coordination_repo_key", "coordination_repo_key is missing or invalid");
    }
    coordinationRepoKey = sourceProject.coordination_repo_key;
  }
  const watchBatchRequests = hasOwn(sourceProject, "watch_batch_requests")
    ? sourceProject.watch_batch_requests
    : false;
  if (typeof watchBatchRequests !== "boolean") {
    bindingError("invalid_watch_batch_requests", "watch_batch_requests", "watch_batch_requests must be a boolean");
  }
  if (watchBatchRequests && coordinationRepoKey === null) {
    bindingError("coordination_repository_required", "coordination_repo_key", "select a registered coordination repository before enabling the local watcher");
  }
  const coordinationRepository = resolveCoordinationRepository(
    sourceProject,
    coordinationRepoKey,
    input.resolveCanonicalRepository,
  );

  const project = {
    ...sourceProject,
    environment_bindings: bindings.map((binding) => ({ ...binding })),
    watch_batch_requests: watchBatchRequests,
  };
  if (coordinationRepoKey === null) delete project.coordination_repo_key;

  return Object.freeze({
    project: Object.freeze(project),
    current_identity: currentIdentity,
    coordination_repository: coordinationRepository,
  });
}

function validateProjectEnvironmentSettings(input) {
  try {
    return Object.freeze({ ok: true, value: normalizeProjectEnvironmentSettings(input) });
  } catch (error) {
    if (error instanceof ProjectEnvironmentBindingError) {
      return Object.freeze({
        ok: false,
        error: Object.freeze({ code: error.code, field: error.field, message: error.message }),
      });
    }
    throw error;
  }
}

function disableWatcherForArchive(project) {
  if (!isPlainObject(project)) {
    bindingError("invalid_project", "project", "project is invalid");
  }
  return Object.freeze({ ...cloneValue(project), watch_batch_requests: false });
}

function disableWatcherForUnarchive(project) {
  // Unarchive never revives a local subscription. Re-enabling is an explicit
  // later Settings action after the project is admitted again.
  return disableWatcherForArchive(project);
}

const archiveProjectEnvironmentSettings = disableWatcherForArchive;
const unarchiveProjectEnvironmentSettings = disableWatcherForUnarchive;

function hasRegisteredPeerBinding(input) {
  const validated = validateProjectEnvironmentSettings(input);
  if (!validated.ok) return false;
  const candidate = input && input.peer;
  if (!isPlainObject(candidate)) return false;
  if (typeof candidate.installation_id !== "string" || typeof candidate.project_id !== "string") return false;
  return validated.value.project.environment_bindings.some((binding) =>
    binding.installation_id === candidate.installation_id && binding.project_id === candidate.project_id);
}

function buildProjectEnvironmentsMap(input) {
  const validated = validateProjectEnvironmentSettings(input);
  if (!validated.ok) return validated;
  const value = validated.value;
  const repository = value.coordination_repository;
  // Explicit allow-list only. Never spread the project or peer input into the
  // Head context: future config fields must be deliberately admitted here.
  const payload = Object.freeze({
    current: Object.freeze({
      installation_id: value.current_identity.installation_id,
      project_id: value.current_identity.project_id,
    }),
    peers: Object.freeze(value.project.environment_bindings.map((binding) => Object.freeze({
      installation_id: binding.installation_id,
      project_id: binding.project_id,
      label: binding.label,
      environment_class: binding.environment_class,
    }))),
    coordination_repository: repository === null ? null : Object.freeze({
      key: repository.key,
      canonical_repository: repository.canonical_repository,
    }),
    watch_batch_requests: value.project.watch_batch_requests,
  });
  return Object.freeze({ ok: true, payload });
}

function renderProjectEnvironmentsMap(input) {
  const built = buildProjectEnvironmentsMap(input);
  if (!built.ok) return built;
  return Object.freeze({ ok: true, payload: built.payload, content: `${JSON.stringify(built.payload, null, 2)}\n` });
}

module.exports = {
  ENVIRONMENT_CLASSES,
  ProjectEnvironmentBindingError,
  normalizeProjectEnvironmentSettings,
  validateProjectEnvironmentSettings,
  disableWatcherForArchive,
  disableWatcherForUnarchive,
  archiveProjectEnvironmentSettings,
  unarchiveProjectEnvironmentSettings,
  hasRegisteredPeerBinding,
  buildProjectEnvironmentsMap,
  renderProjectEnvironmentsMap,
};
