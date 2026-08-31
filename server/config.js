const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { parseRuntimeResources } = require("./resource-policy");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const CONFIG_LOCK_PATH = path.join(os.homedir(), ".quadwork", "config.lock");

const DEFAULT_CONFIG = {
  port: 8400,
  operator_name: "user",
  projects: [],
};

const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const LEGACY_PRIMARY_REPOSITORY_KEY = "primary";
const INTERNAL_CONFIG_WRITE = Symbol("internalConfigWrite");
const INTERNAL_CONFIG_WRITE_AUTHORITY = Object.freeze({});
// Process-wide authority for projects that have passed unarchive ownership
// validation but are still proving that their archived runtime is quiescent.
// Every V2 config commit consults this map, so no other mutation path can make
// a colliding project active or change the reserved identity mid-cleanup.
const v2OwnershipReservations = new Map();
let configWriteLockDepth = 0;

class ConfigurationValidationError extends Error {
  constructor(code, field, message, ownerProjectId) {
    super(message);
    this.name = "ConfigurationValidationError";
    this.code = code;
    this.field = field;
    if (ownerProjectId !== undefined) this.owner_project_id = ownerProjectId;
  }
}

function validationError(code, field, message, ownerProjectId) {
  return new ConfigurationValidationError(code, field, message, ownerProjectId);
}

function liveProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && error.code === "EPERM";
  }
}

function readConfigLockOwner() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_LOCK_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function acquireConfigWriteLock() {
  ensureSecureDir(path.dirname(CONFIG_LOCK_PATH));
  const token = crypto.randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token });
  const candidatePath = `${CONFIG_LOCK_PATH}.${process.pid}.${token}.tmp`;
  try {
    writeSecureFile(candidatePath, payload);
    // Link a fully-written inode into the fixed lock name. Unlike open+write,
    // another process can never observe an empty/partial owner record.
    fs.linkSync(candidatePath, CONFIG_LOCK_PATH);
    return token;
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    const owner = readConfigLockOwner();
    const message = owner && liveProcess(owner.pid)
      ? "configuration is being updated; retry the operation"
      : "configuration write lock is stale; verify no QuadWork writer is running, then remove config.lock";
    // Never auto-delete a stale-looking lock: read→unlink has an unavoidable
    // cross-process replacement race without an OS advisory-lock primitive.
    // Fail closed and require an explicit operator recovery instead.
    throw validationError("config_write_busy", "config", message);
  } finally {
    try { fs.unlinkSync(candidatePath); } catch {}
  }
}

function releaseConfigWriteLock(token) {
  if (!token) return;
  const owner = readConfigLockOwner();
  if (!owner || owner.pid !== process.pid || owner.token !== token) return;
  try { fs.unlinkSync(CONFIG_LOCK_PATH); } catch {}
}

function withConfigWriteLock(operation) {
  if (configWriteLockDepth > 0) return operation();
  const token = acquireConfigWriteLock();
  configWriteLockDepth = 1;
  try {
    return operation();
  } finally {
    configWriteLockDepth = 0;
    releaseConfigWriteLock(token);
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneConfigurationValue(value) {
  if (Array.isArray(value)) return value.map(cloneConfigurationValue);
  if (value && typeof value === "object") {
    const clone = {};
    for (const [key, child] of Object.entries(value)) clone[key] = cloneConfigurationValue(child);
    return clone;
  }
  return value;
}

function canonicalRepositoryName(repo) {
  return typeof repo === "string" ? repo.trim().toLowerCase() : null;
}

function normalizeAbsoluteWorkingDir(workingDir) {
  if (typeof workingDir !== "string" || !path.isAbsolute(workingDir)) return workingDir;
  return path.normalize(path.resolve(workingDir));
}

/**
 * Pure compatibility normalizer for a persisted project record.
 *
 * A legacy scalar project receives the fixed reserved key `primary`. Deriving a
 * key from a repository name would make the supposedly immutable identity
 * change when a repository is renamed. This helper never mutates or persists
 * its input and never creates an installation identity.
 */
function normalizeProjectRepositories(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) return [];

  const source = Array.isArray(project.repositories)
    ? project.repositories
    : (hasOwn(project, "repo") || hasOwn(project, "working_dir"))
      ? [{
          key: LEGACY_PRIMARY_REPOSITORY_KEY,
          repo: project.repo,
          working_dir: project.working_dir,
          primary: true,
        }]
      : [];

  return source.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return {
      ...cloneConfigurationValue(entry),
      repo: typeof entry.repo === "string" ? entry.repo.trim() : entry.repo,
      working_dir: normalizeAbsoluteWorkingDir(entry.working_dir),
      primary: entry.primary === true,
    };
  });
}

function allRepositories(project) {
  return normalizeProjectRepositories(project);
}

function primaryRepository(project) {
  return allRepositories(project).find((entry) => entry && entry.primary === true) || null;
}

function repositoryByKey(project, key) {
  if (typeof key !== "string") return null;
  return allRepositories(project).find((entry) => entry && entry.key === key) || null;
}

function repositoryByCanonicalName(project, repo) {
  const canonical = canonicalRepositoryName(repo);
  if (!canonical) return null;
  return allRepositories(project).find((entry) => canonicalRepositoryName(entry && entry.repo) === canonical) || null;
}

/**
 * The single symbol-scoped scalar compatibility serializer. Persisted V2
 * records never carry scalar repo/working_dir fields; legacy response consumers
 * may temporarily receive values derived from the canonical primary entry.
 */
function serializeProjectCompatibility(project) {
  const repositories = allRepositories(project);
  const primary = primaryRepository({ repositories });
  const compatible = { ...cloneConfigurationValue(project), repositories };
  if (primary) {
    compatible.repo = primary.repo;
    compatible.working_dir = primary.working_dir;
  }
  return compatible;
}

function projectIdForError(project, index) {
  return typeof project?.id === "string" && project.id ? project.id : `projects[${index}]`;
}

function foldPathIdentity(value) {
  return value.normalize("NFC").toLowerCase();
}

function callRealpath(fsImpl, value) {
  const realpath = fsImpl.realpathSync && (fsImpl.realpathSync.native || fsImpl.realpathSync);
  if (typeof realpath !== "function") throw new Error("realpathSync is unavailable");
  return realpath.call(fsImpl.realpathSync, value);
}

function isMissingPathError(err) {
  return err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

// Resolve an existing base directory through symlinks and capture its device /
// inode identity. For a future path, resolve the nearest existing ancestor and
// append the missing suffix before normalizing, so a symlinked parent cannot
// reserve the same future path twice under different spellings.
function workingDirIdentity(workingDir, fsImpl = fs) {
  const absolute = normalizeAbsoluteWorkingDir(workingDir);
  if (typeof absolute !== "string" || !path.isAbsolute(absolute)) {
    throw validationError(
      "invalid_repository_working_dir",
      "repositories.working_dir",
      "repositories.working_dir must be an absolute path",
    );
  }

  let real;
  try {
    real = path.normalize(callRealpath(fsImpl, absolute));
  } catch (err) {
    if (!isMissingPathError(err)) {
      throw validationError(
        "repository_working_dir_identity_unavailable",
        "repositories.working_dir",
        "repositories.working_dir identity could not be verified",
      );
    }
  }

  if (real !== undefined) {
    let stat;
    try {
      stat = fsImpl.statSync(real);
    } catch {
      // A successful realpath followed by any stat failure is a race or an
      // unreadable identity. Never downgrade it to a future-path comparison.
      throw validationError(
        "repository_working_dir_identity_unavailable",
        "repositories.working_dir",
        "repositories.working_dir identity could not be verified",
      );
    }
    if (!stat || stat.dev === undefined || stat.ino === undefined) {
      throw validationError(
        "repository_working_dir_identity_unavailable",
        "repositories.working_dir",
        "repositories.working_dir identity could not be verified",
      );
    }
    if (typeof stat.isDirectory === "function" && !stat.isDirectory()) {
      throw validationError(
        "invalid_repository_working_dir",
        "repositories.working_dir",
        "repositories.working_dir must identify a directory",
      );
    }
    // Existing paths use exact realpath plus dev+ino. On case-sensitive Linux,
    // /A and /a may be different directories and must not be case-folded; on a
    // case-insensitive filesystem aliases resolve to the same object identity.
    const identities = new Set([
      `configured-path:${absolute.normalize("NFC")}`,
      `canonical-path:${real.normalize("NFC")}`,
      `realpath:${real.normalize("NFC")}`,
      `device:${String(stat.dev)}:${String(stat.ino)}`,
    ]);
    return {
      path: absolute,
      state: "existing",
      identities,
      foldedIdentities: new Set([
        foldPathIdentity(absolute),
        foldPathIdentity(real),
      ]),
    };
  }

  const suffix = [];
  let cursor = absolute;
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
    try {
      const realParent = path.normalize(callRealpath(fsImpl, cursor));
      let parentStat;
      try {
        parentStat = fsImpl.statSync(realParent);
      } catch {
        throw validationError(
          "repository_working_dir_identity_unavailable",
          "repositories.working_dir",
          "repositories.working_dir identity could not be verified",
        );
      }
      if (typeof parentStat?.isDirectory === "function" && !parentStat.isDirectory()) {
        throw validationError(
          "invalid_repository_working_dir",
          "repositories.working_dir",
          "repositories.working_dir must have a directory ancestor",
        );
      }
      const future = path.normalize(path.join(realParent, ...suffix));
      // A future path has no inode. Conservatively case-fold its normalized
      // identity so a later case-insensitive creation cannot bypass ownership.
      return {
        path: absolute,
        state: "future",
        identities: new Set([
          `configured-path:${absolute.normalize("NFC")}`,
          `canonical-path:${future.normalize("NFC")}`,
          `future-path:${foldPathIdentity(future)}`,
        ]),
        foldedIdentities: new Set([
          foldPathIdentity(absolute),
          foldPathIdentity(future),
        ]),
      };
    } catch (err) {
      if (err instanceof ConfigurationValidationError) throw err;
      if (!isMissingPathError(err)) {
        throw validationError(
          "repository_working_dir_identity_unavailable",
          "repositories.working_dir",
          "repositories.working_dir identity could not be verified",
        );
      }
    }
  }

  return {
    path: absolute,
    state: "future",
    identities: new Set([
      `configured-path:${absolute.normalize("NFC")}`,
      `canonical-path:${absolute.normalize("NFC")}`,
      `future-path:${foldPathIdentity(absolute)}`,
    ]),
    foldedIdentities: new Set([foldPathIdentity(absolute)]),
  };
}

function identitiesOverlap(left, right) {
  for (const identity of left.identities) {
    if (right.identities.has(identity)) return true;
  }
  // Existing paths on case-sensitive Linux are distinguished by exact
  // realpath+dev+ino. If either observation is a future path, no inode exists
  // to prove case distinction, so conservatively compare the folded canonical
  // candidates across the state boundary.
  if (left.state && right.state && left.state !== right.state &&
      left.foldedIdentities && right.foldedIdentities) {
    for (const identity of left.foldedIdentities) {
      if (right.foldedIdentities.has(identity)) return true;
    }
  }
  return false;
}

function validateInstallationId(value) {
  if (typeof value !== "string" || !INSTALLATION_ID_RE.test(value)) {
    throw validationError(
      "invalid_installation_id",
      "installation_id",
      "installation_id is missing or invalid",
    );
  }
  return value;
}

function inactiveWorkingDirIdentity(workingDir) {
  const absolute = normalizeAbsoluteWorkingDir(workingDir);
  if (typeof absolute !== "string" || !path.isAbsolute(absolute)) {
    throw validationError(
      "invalid_repository_working_dir",
      "repositories.working_dir",
      "repositories.working_dir must be an absolute path",
    );
  }
  return {
    path: absolute,
    identities: new Set([`inactive-path:${foldPathIdentity(absolute)}`]),
  };
}

function validateRepositoryEntries(project, projectIndex, fsImpl, options = {}) {
  const ownerId = projectIdForError(project, projectIndex);
  if (!Array.isArray(project.repositories) || project.repositories.length === 0) {
    throw validationError(
      "repositories_required",
      "repositories",
      "repositories must contain at least one entry",
    );
  }

  const entries = normalizeProjectRepositories(project);
  const keys = new Set();
  const repos = new Set();
  const pathIdentities = [];
  let primaryCount = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw validationError("invalid_repository", "repositories", "repository entry is invalid");
    }
    if (typeof entry.key !== "string" || !REPOSITORY_KEY_RE.test(entry.key)) {
      throw validationError(
        "invalid_repository_key",
        "repositories.key",
        "repositories.key is invalid",
      );
    }
    if (keys.has(entry.key)) {
      throw validationError(
        "duplicate_repository_key",
        "repositories.key",
        `repositories.key is duplicated in project ${JSON.stringify(ownerId)}`,
        ownerId,
      );
    }
    keys.add(entry.key);

    if (typeof entry.repo !== "string" || !GITHUB_REPOSITORY_RE.test(entry.repo)) {
      throw validationError(
        "invalid_repository_name",
        "repositories.repo",
        "repositories.repo must be an owner/name value",
      );
    }
    const canonicalRepo = canonicalRepositoryName(entry.repo);
    if (repos.has(canonicalRepo)) {
      throw validationError(
        "duplicate_repository",
        "repositories.repo",
        `repositories.repo is duplicated in project ${JSON.stringify(ownerId)}`,
        ownerId,
      );
    }
    repos.add(canonicalRepo);

    const pathIdentity = options.resolveIdentity === false
      ? inactiveWorkingDirIdentity(entry.working_dir)
      : workingDirIdentity(entry.working_dir, fsImpl);
    if (pathIdentities.some((other) => identitiesOverlap(other, pathIdentity))) {
      throw validationError(
        "duplicate_repository_working_dir",
        "repositories.working_dir",
        `repositories.working_dir is duplicated in project ${JSON.stringify(ownerId)}`,
        ownerId,
      );
    }
    pathIdentities.push(pathIdentity);
    if (entry.primary === true) primaryCount += 1;
  }

  if (primaryCount !== 1) {
    throw validationError(
      "invalid_primary_repository_count",
      "repositories.primary",
      "repositories must contain exactly one primary entry",
    );
  }

  return entries.map((entry, index) => ({
    entry,
    canonicalRepo: canonicalRepositoryName(entry.repo),
    pathIdentity: pathIdentities[index],
  }));
}

function validateImmutableRepositoryKeys(candidateProject, candidate, previousProject, projectIndex, fsImpl, options = {}) {
  if (!previousProject) return;
  const previousEntries = normalizeProjectRepositories(previousProject);
  for (const previous of previousEntries) {
    if (!previous || typeof previous !== "object") continue;
    const previousRepo = canonicalRepositoryName(previous.repo);
    const previousPath = options.resolveIdentity === false
      ? inactiveWorkingDirIdentity(previous.working_dir)
      : workingDirIdentity(previous.working_dir, fsImpl);
    const matching = candidate.find(({ canonicalRepo, pathIdentity }) =>
      (previousRepo && canonicalRepo === previousRepo) ||
      (previousPath && identitiesOverlap(pathIdentity, previousPath)));
    if (matching && matching.entry.key !== previous.key) {
      throw validationError(
        "immutable_repository_key",
        "repositories.key",
        `repositories.key is immutable in project ${JSON.stringify(projectIdForError(candidateProject, projectIndex))}`,
        projectIdForError(candidateProject, projectIndex),
      );
    }
  }
}

/** Validate a fully activated (array-only) V2 configuration without mutation. */
function validateV2Configuration(config, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw validationError("invalid_configuration", "config", "configuration is invalid");
  }
  validateInstallationId(config.installation_id);
  if (!Array.isArray(config.projects)) {
    throw validationError("invalid_projects", "projects", "projects must be an array");
  }

  const previousById = new Map(
    Array.isArray(options.previousConfig?.projects)
      ? options.previousConfig.projects
        .filter((project) => project && typeof project.id === "string")
        .map((project) => [project.id, project])
      : [],
  );
  const activeRepos = new Map();
  const activePaths = [];

  config.projects.forEach((project, index) => {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw validationError("invalid_project", "projects", "project entry is invalid");
    }
    if (hasOwn(project, "repo") || hasOwn(project, "working_dir")) {
      throw validationError(
        "legacy_repository_scalars_persisted",
        "repositories",
        "activated projects must persist repositories without legacy scalar fields",
      );
    }
    const resolveIdentity = project.archived !== true;
    const validated = validateRepositoryEntries(project, index, fsImpl, { resolveIdentity });
    validateImmutableRepositoryKeys(
      project,
      validated,
      previousById.get(project.id),
      index,
      fsImpl,
      { resolveIdentity },
    );

    // `idle` is an execution flag, not archival state. Only explicit archived
    // projects release their repository/path ownership claim.
    if (project.archived === true) return;
    const ownerId = projectIdForError(project, index);
    for (const { canonicalRepo, pathIdentity } of validated) {
      const repoOwner = activeRepos.get(canonicalRepo);
      if (repoOwner !== undefined) {
        throw validationError(
          "repository_owned_by_active_project",
          "repositories.repo",
          `repositories.repo is already owned by active project ${JSON.stringify(repoOwner)}`,
          repoOwner,
        );
      }
      const pathOwner = activePaths.find(({ identity }) =>
        identitiesOverlap(identity, pathIdentity));
      if (pathOwner) {
        throw validationError(
          "repository_working_dir_owned_by_active_project",
          "repositories.working_dir",
          `repositories.working_dir is already owned by active project ${JSON.stringify(pathOwner.ownerId)}`,
          pathOwner.ownerId,
        );
      }
      activeRepos.set(canonicalRepo, ownerId);
      activePaths.push({ identity: pathIdentity, ownerId });
    }
  });

  return config;
}

/** Pure, idempotent scalar-to-array migration; it never writes its input. */
function migrateConfigurationToV2(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const cloned = cloneConfigurationValue(config);
  const projects = Array.isArray(cloned.projects)
    ? cloned.projects.map((project) => {
        if (!project || typeof project !== "object" || Array.isArray(project)) return project;
        const migrated = {
          ...project,
          repositories: normalizeProjectRepositories(project),
        };
        delete migrated.repo;
        delete migrated.working_dir;
        return migrated;
      })
    : cloned.projects;
  return { ...cloned, projects };
}

function reservationProject(config, projectId) {
  return Array.isArray(config?.projects)
    ? config.projects.find((project) => project && project.id === projectId) || null
    : null;
}

function repositoryOwnershipSignature(project) {
  return JSON.stringify(normalizeProjectRepositories(project));
}

function reservationError(projectId, message = "project repository ownership is reserved") {
  return validationError(
    "project_ownership_reserved",
    "projects",
    message,
    projectId,
  );
}

function assertReservationIdentity(candidate, reservation) {
  const project = reservationProject(candidate, reservation.project_id);
  if (!project) {
    throw reservationError(reservation.project_id, "reserved project cannot be removed");
  }
  if (repositoryOwnershipSignature(project) !== reservation.ownership_signature) {
    throw reservationError(reservation.project_id, "reserved project ownership cannot be changed");
  }
  return project;
}

function candidateWithReservedOwnership(candidate) {
  const projected = cloneConfigurationValue(candidate);
  for (const reservation of v2OwnershipReservations.values()) {
    const project = assertReservationIdentity(projected, reservation);
    project.archived = false;
  }
  return projected;
}

function assertV2OwnershipReservationCommit(candidate, options = {}) {
  const authorizedReservation = options.ownershipReservation;
  if (v2OwnershipReservations.size > 0) {
    for (const reservation of v2OwnershipReservations.values()) {
      const project = assertReservationIdentity(candidate, reservation);
      if (project.archived !== true && authorizedReservation !== reservation) {
        throw reservationError(
          reservation.project_id,
          "reserved project cannot be activated before cleanup completes",
        );
      }
    }
    // Project every in-flight reservation as active while validating other
    // mutations. This makes a colliding activation fail before its own token
    // check and, critically, before any config bytes are written.
    validateV2Configuration(candidateWithReservedOwnership(candidate), {
      previousConfig: options.previousConfig || candidate,
      fsImpl: options.fsImpl || fs,
    });
  }

  // An existing archived project may become active only through the exact
  // reservation that proved collision safety before cleanup. New projects are
  // intentionally outside this transition rule, and removal remains legal
  // after archive cleanup because there is no active candidate to publish.
  for (const previous of options.previousConfig?.projects || []) {
    if (!previous || previous.archived !== true || typeof previous.id !== "string") continue;
    const next = reservationProject(candidate, previous.id);
    if (!next || next.archived === true) continue;
    const reservation = v2OwnershipReservations.get(previous.id);
    if (!reservation || authorizedReservation !== reservation) {
      throw reservationError(
        previous.id,
        "archived project activation requires its cleanup reservation",
      );
    }
  }
}

/**
 * Synchronously reserve the active repository/path identity for an unarchive.
 * The returned opaque token is the only authority allowed to publish that
 * project's archived=false transition while cleanup is in flight.
 */
function reserveV2ProjectOwnership(projectId, config, options = {}) {
  if (typeof projectId !== "string" || !projectId) {
    throw reservationError(projectId, "project id is required for ownership reservation");
  }
  if (v2OwnershipReservations.has(projectId)) {
    throw reservationError(projectId, "project ownership is already reserved");
  }
  const project = reservationProject(config, projectId);
  if (!project) throw reservationError(projectId, "project is not configured");

  const reservation = Object.freeze({
    project_id: projectId,
    ownership_signature: repositoryOwnershipSignature(project),
  });
  const projected = cloneConfigurationValue(config);
  const target = reservationProject(projected, projectId);
  target.archived = false;
  for (const existing of v2OwnershipReservations.values()) {
    assertReservationIdentity(projected, existing).archived = false;
  }

  const validate = options.validateV2Configuration || validateV2Configuration;
  validate(projected, {
    previousConfig: config,
    fsImpl: options.fsImpl || fs,
  });
  // Validation and publication are synchronous, so no competing reservation
  // or config commit can interleave between them in this Node process.
  v2OwnershipReservations.set(projectId, reservation);
  return reservation;
}

function releaseV2ProjectOwnership(reservation) {
  if (!reservation || typeof reservation.project_id !== "string") return;
  if (v2OwnershipReservations.get(reservation.project_id) === reservation) {
    v2OwnershipReservations.delete(reservation.project_id);
  }
}

// Reserved sender names that the operator must NOT be able to claim.
const RESERVED_OPERATOR_NAMES = new Set([
  "head",
  "dev",
  "re1",
  "re2",
  "reviewer1",
  "reviewer2",
  "t1",
  "t2a",
  "t2b",
  "t3",
  "system",
]);

// Sanitize operator display name: 1–32 alnum + dash + underscore,
// reject reserved agent identities.
function sanitizeOperatorName(value) {
  if (typeof value !== "string") return "user";
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleaned) return "user";
  const truncated = cleaned.slice(0, 32);
  if (RESERVED_OPERATOR_NAMES.has(truncated.toLowerCase())) return "user";
  return truncated;
}

// Migration: rename old agent keys to new ones.
// Keep this map — it migrates pre-v1.8 configs on startup so existing
// installs transition to the canonical head/dev/re1/re2 slugs.
const AGENT_KEY_MAP = { t1: "head", t2a: "re1", t2b: "re2", t3: "dev", reviewer1: "re1", reviewer2: "re2" };

function migrateAgentKeys(config, options = {}) {
  let changed = false;
  if (config.projects) {
    for (const project of config.projects) {
      if (!project.agents) continue;
      for (const [oldKey, newKey] of Object.entries(AGENT_KEY_MAP)) {
        if (project.agents[oldKey] && !project.agents[newKey]) {
          project.agents[newKey] = project.agents[oldKey];
          delete project.agents[oldKey];
          changed = true;
        }
      }
    }
  }
  if (changed && options.persist !== false) {
    try {
      writeSecureFile(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch {}
  }
  return config;
}

function readConfigDocument() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { config: cloneConfigurationValue(DEFAULT_CONFIG), missing: true };
    }
    throw new Error(`Cannot read config at ${CONFIG_PATH}: ${err.message}`);
  }

  try {
    return { config: JSON.parse(raw), missing: false };
  } catch (err) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${err.message}`);
  }
}

function readConfig() {
  const { config, missing } = readConfigDocument();
  if (missing) {
    // Config file doesn't exist — preserve the historical startup behavior.
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) ensureSecureDir(dir);
    writeSecureFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return config;
  }
  return migrateAgentKeys(config);
}

// #1038: strict, side-effect-free runtime resource policy access. This path is
// intentionally separate from readConfig(): readConfig creates a default file
// and may persist legacy migrations, while resource preflight must be read-only.
// Absence is meaningful and remains null; the proposal is never injected here.
function getRuntimeResources(config) {
  const raw = config && typeof config === "object" && !Array.isArray(config)
    ? config.runtime_resources
    : undefined;
  return parseRuntimeResources(raw);
}

function readRuntimeResources(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const configPath = options.configPath || CONFIG_PATH;
  let raw;
  try {
    raw = fsImpl.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new Error("Cannot read runtime_resources configuration");
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("Invalid QuadWork configuration JSON");
  }
  return getRuntimeResources(config);
}

/**
 * Resolve the configured cwd for a project/agent pair.
 * Returns null if not found.
 */
function resolveAgentCwd(projectId, agentId) {
  const config = readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const agent = project.agents && project.agents[agentId];
  if (!agent || !agent.cwd) return null;
  return agent.cwd;
}

/**
 * Resolve the configured command for a project/agent pair.
 * Returns null if not found (caller should fall back to default shell).
 */
function resolveAgentCommand(projectId, agentId) {
  const config = readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const agent = project.agents && project.agents[agentId];
  if (!agent || !agent.command) return null;
  return agent.command;
}

/**
 * Resolve AgentChattr connection for a project (per-project → global fallback).
 */
function resolveProjectChattr(projectId) {
  const config = readConfig();
  const project = projectId ? config.projects?.find((p) => p.id === projectId) : null;

  // Resolution order for AgentChattr install dir:
  //   1. project.agentchattr_dir   — per-project clone (Option B, #181)
  //   2. config.agentchattr_dir    — legacy global clone (v1 backward compat)
  //   3. ~/.quadwork/{projectId}/agentchattr — per-project default
  //
  // Phase 1A (#182) is schema-only: project.agentchattr_dir is now written
  // on every new project, but the actual clone-on-create logic does not
  // land until #183/#184/#185. Until then, if the project field points at
  // a directory that does not yet contain a working install, fall back to
  // the legacy global so existing setups (and brand-new projects on a v1
  // host) keep starting AgentChattr from the working clone.
  const perProjectDefault = projectId
    ? path.join(os.homedir(), ".quadwork", projectId, "agentchattr")
    : path.join(os.homedir(), ".quadwork", "agentchattr");
  const legacyGlobal = config.agentchattr_dir || path.join(os.homedir(), ".quadwork", "agentchattr");
  let dir = project?.agentchattr_dir || legacyGlobal || perProjectDefault;
  if (!fs.existsSync(path.join(dir, "run.py")) && fs.existsSync(path.join(legacyGlobal, "run.py"))) {
    dir = legacyGlobal;
  }

  return {
    url: project?.agentchattr_url || config.agentchattr_url || "http://127.0.0.1:8300",
    token: project?.agentchattr_token || config.agentchattr_token || null,
    mcp_http_port: project?.mcp_http_port || null,
    mcp_sse_port: project?.mcp_sse_port || null,
    dir,
  };
}

// --- #540: Secure file/directory helpers ---
// All paths under ~/.quadwork/ may contain secrets (tokens, configs,
// chat exports). Use these helpers instead of raw fs calls to ensure
// restrictive permissions on multi-user systems.

/** Create a directory with 0o700 (owner-only). Hardens existing dirs too. */
function ensureSecureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync mode only applies on creation — chmod existing dirs.
  try { fs.chmodSync(dir, 0o700); } catch {}
}

/** Write a file with 0o600 (owner-only read/write). Hardens existing files too. */
function writeSecureFile(filePath, data, extraOpts = {}) {
  fs.writeFileSync(filePath, data, { mode: 0o600, ...extraOpts });
  // writeFileSync mode only applies on creation — chmod existing files.
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

// #971: write config.json ATOMICALLY (write a tmp file, then renameSync onto
// the target — the same crash-safe pattern migrate-ac.js uses). The old
// in-place writeFileSync could truncate config.json to zero bytes if the
// process died mid-write, losing the entire config; rename() is atomic on the
// same filesystem, so a reader always sees either the old or the new file, never
// a partial one. The tmp name carries the pid so two processes can't collide.
function writeConfig(cfg, options = {}) {
  return withConfigWriteLock(() => writeConfigUnlocked(cfg, options));
}

function writeConfigUnlocked(cfg, options = {}) {
  // Legacy field-scoped writers still converge here. While an unarchive owns
  // a reservation, make this low-level atomic boundary enforce the same
  // authority so a stale whole-document write cannot bypass V2 commits.
  const internalWrite = options[INTERNAL_CONFIG_WRITE] === INTERNAL_CONFIG_WRITE_AUTHORITY;
  let previousConfig = internalWrite ? options.previousConfig : null;
  if (!previousConfig && typeof cfg?.installation_id === "string") {
    try {
      previousConfig = readConfigDocument().config;
    } catch (error) {
      // Once activated, inability to establish the live previous state must
      // never downgrade into an unchecked low-level overwrite.
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  assertV2OwnershipReservationCommit(cfg, {
    previousConfig,
    ownershipReservation: internalWrite ? options.ownershipReservation : null,
    fsImpl: internalWrite ? options.fsImpl : fs,
  });
  const data = JSON.stringify(cfg, null, 2);
  const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeSecureFile(tmpPath, data); // 0o600
  try {
    fs.renameSync(tmpPath, CONFIG_PATH); // atomic commit; keeps the tmp's 0o600
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* leave nothing behind */ }
    throw err;
  }
}

// #971: single serialization point for read-modify-write config mutations.
// Runs synchronously (Node can't interleave a sync block), so it reads the
// freshest on-disk config, applies `mutator`, and atomically writes — a
// concurrent caller can't clobber it with a stale whole-config snapshot. Server
// mutators and the field-scoped endpoints go through here instead of doing their
// own GET→mutate→writeConfig. Returns the mutated config.
function updateConfig(mutator, options = {}) {
  return withConfigWriteLock(() => {
    const { config: cfg, missing } = readConfigDocument();
    // Apply the old agent-key migration in memory. A failed mutator must not
    // trigger readConfig()'s eager legacy write before the candidate validates.
    migrateAgentKeys(cfg, { persist: false });
    const previousConfig = cloneConfigurationValue(cfg);
    mutator(cfg);
    if (missing) ensureSecureDir(path.dirname(CONFIG_PATH));
    writeConfig(cfg, {
      ...options,
      previousConfig,
      [INTERNAL_CONFIG_WRITE]: INTERNAL_CONFIG_WRITE_AUTHORITY,
    });
    return cfg;
  });
}

/**
 * Sole serialized V2 activation/mutation boundary.
 *
 * It generates an opaque ID exactly once when the persisted field is absent,
 * rejects deletion/rotation, migrates scalar repositories in memory, validates
 * the complete candidate against the previous snapshot, then performs the one
 * atomic write used by updateConfig(). It is intentionally not wired to any
 * startup/read/route path in #1029.
 */
function commitV2Configuration(mutator = () => {}, options = {}) {
  if (typeof mutator !== "function") throw new TypeError("mutator must be a function");
  const idGenerator = options.idGenerator || (() => crypto.randomUUID());
  if (typeof idGenerator !== "function") throw new TypeError("idGenerator must be a function");

  return updateConfig((cfg) => {
    const previousConfig = cloneConfigurationValue(cfg);
    const hadInstallationId = hasOwn(cfg, "installation_id");
    const committedInstallationId = hadInstallationId ? cfg.installation_id : idGenerator();
    cfg.installation_id = committedInstallationId;

    mutator(cfg);
    if (!hasOwn(cfg, "installation_id") || cfg.installation_id !== committedInstallationId) {
      throw validationError(
        "installation_id_rotation_forbidden",
        "installation_id",
        "installation_id cannot be deleted or replaced",
      );
    }

    // An already-activated installation must remain array-only. Migration is
    // reserved for the first explicit activation; otherwise a later route
    // could smuggle legacy scalars into a candidate and have them silently
    // stripped instead of rejected.
    const candidate = hadInstallationId
      ? cloneConfigurationValue(cfg)
      : migrateConfigurationToV2(cfg);
    validateV2Configuration(candidate, {
      previousConfig,
      fsImpl: options.fsImpl || fs,
    });
    assertV2OwnershipReservationCommit(candidate, {
      previousConfig,
      ownershipReservation: options.ownershipReservation,
      fsImpl: options.fsImpl || fs,
    });
    for (const key of Object.keys(cfg)) delete cfg[key];
    Object.assign(cfg, candidate);
  }, {
    ownershipReservation: options.ownershipReservation,
    fsImpl: options.fsImpl || fs,
  });
}

/**
 * Compatibility boundary for legacy CLI writers. Activation is decided from
 * the live document while the cross-process lock is held, never from the
 * caller's potentially stale snapshot.
 */
function commitConfigurationSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("configuration snapshot must be an object");
  }
  return withConfigWriteLock(() => {
    const { config: live } = readConfigDocument();
    if (hasOwn(live, "installation_id")) {
      return commitV2Configuration((fresh) => {
        for (const key of Object.keys(fresh)) delete fresh[key];
        Object.assign(fresh, cloneConfigurationValue(snapshot));
      });
    }
    return writeConfig(cloneConfigurationValue(snapshot));
  });
}

module.exports = {
  readConfig,
  readRuntimeResources,
  getRuntimeResources,
  resolveAgentCwd,
  resolveAgentCommand,
  resolveProjectChattr,
  sanitizeOperatorName,
  CONFIG_PATH,
  ensureSecureDir,
  writeSecureFile,
  writeConfig,
  updateConfig,
  ConfigurationValidationError,
  normalizeProjectRepositories,
  allRepositories,
  primaryRepository,
  repositoryByKey,
  repositoryByCanonicalName,
  serializeProjectCompatibility,
  workingDirIdentity,
  validateV2Configuration,
  migrateConfigurationToV2,
  reserveV2ProjectOwnership,
  releaseV2ProjectOwnership,
  commitV2Configuration,
  commitConfigurationSnapshot,
};
