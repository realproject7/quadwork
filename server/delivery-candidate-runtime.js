"use strict";

// #1060 M7: fixed Head-token bridge for a repository Delivery Candidate. It
// owns authentication and server composition only: pipeline/review provenance,
// Git-object evidence, durable candidate state, and proof composition remain
// closed injected authorities. Head never supplies a worktree path, base SHA,
// review receipt, tree, patch, or repository identity.

const { buildDeliveryManifest, assertDeliveryCandidateRef } = require("./delivery-candidate");

const VERSION = 1;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

class DeliveryCandidateRuntimeError extends Error {
  constructor(code, message = code) { super(message); this.name = "DeliveryCandidateRuntimeError"; this.code = code; }
}
function fail(code, message) { throw new DeliveryCandidateRuntimeError(code, message); }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail(code, "value has an unknown or missing field");
}
function clone(value) { return Array.isArray(value) ? value.map(clone) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value; }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
function safeCode(error, fallback) { return typeof error?.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(error.code) ? error.code : fallback; }
function sameBinding(left, right) { return left.installation_id === right.installation_id && left.project_id === right.project_id && left.role === right.role && left.generation === right.generation; }
function verified(session, projectId, role) {
  return !!session && session.projectId === projectId && session.agentId === role && session.state === "running" && !!session.term && session.lifecycleState === "verified";
}

function options(value) {
  exact(value, ["config_dir", "fs", "read_config", "capture_project_admission", "is_admission_current", "resolve_shim_principal", "agent_sessions", "read_delivery_source", "read_delivery_evidence", "create_candidate_store", "create_composition_service", "repository_objects_for"], "invalid_delivery_candidate_runtime_options");
  if (typeof value.config_dir !== "string" || !value.fs || typeof value.read_config !== "function" || typeof value.capture_project_admission !== "function" ||
      typeof value.is_admission_current !== "function" || typeof value.resolve_shim_principal !== "function" || !value.agent_sessions || typeof value.agent_sessions.get !== "function" ||
      typeof value.read_delivery_source !== "function" || typeof value.read_delivery_evidence !== "function" || typeof value.create_candidate_store !== "function" ||
      typeof value.create_composition_service !== "function" || typeof value.repository_objects_for !== "function") {
    fail("invalid_delivery_candidate_runtime_options", "runtime dependencies are invalid");
  }
  return value;
}
function source(value, owner) {
  exact(value, ["version", "registered_repository", "frozen_batch_manifest", "delivery_mode", "cut_id", "base_sha", "staged_tasks", "deferred_exclusions"], "delivery_candidate_source_invalid");
  if (value.version !== VERSION || !plain(value.registered_repository) || value.registered_repository.installation_id !== owner.installation_id ||
      value.registered_repository.project_id !== owner.project_id || !REPOSITORY_KEY_RE.test(value.registered_repository.repository_key) ||
      value.registered_repository.repository_key !== value.frozen_batch_manifest?.tasks?.find((entry) => entry?.ref?.repository_key === value.registered_repository.repository_key)?.ref?.repository_key ||
      !Array.isArray(value.staged_tasks) || value.staged_tasks.length === 0 || !Array.isArray(value.deferred_exclusions)) {
    fail("delivery_candidate_source_invalid", "server delivery source is invalid");
  }
  return clone(value);
}
function evidence(value, owner, repositoryKey) {
  exact(value, ["version", "installation_id", "project_id", "repository_key", "result_sha", "evidence"], "delivery_candidate_evidence_invalid");
  if (value.version !== VERSION || value.installation_id !== owner.installation_id || value.project_id !== owner.project_id || value.repository_key !== repositoryKey) {
    fail("delivery_candidate_evidence_invalid", "server delivery evidence does not match its candidate");
  }
  return clone(value);
}

function createDeliveryCandidateRuntime(value) {
  const deps = options(value);
  function activeHead(token) {
    let principal, admission, config;
    try { principal = deps.resolve_shim_principal(token); admission = principal && deps.capture_project_admission(principal.projectId); config = deps.read_config(); }
    catch { fail("delivery_candidate_principal_unavailable", "Head principal is unavailable"); }
    const project = Array.isArray(config?.projects) ? config.projects.filter((entry) => plain(entry) && entry.id === principal?.projectId && entry.archived !== true) : [];
    if (!principal || principal.agentId !== "head" || typeof principal.projectId !== "string" || !admission || admission.project_id !== principal.projectId ||
        !Number.isSafeInteger(admission.generation) || admission.generation < 0 || deps.is_admission_current(admission) !== true ||
        !INSTALLATION_RE.test(config?.installation_id) || project.length !== 1 || !verified(deps.agent_sessions.get(`${principal.projectId}/head`), principal.projectId, "head")) {
      fail("delivery_candidate_principal_unavailable", "Head principal is unavailable");
    }
    return freeze({ installation_id: config.installation_id, project_id: principal.projectId, role: "head", generation: admission.generation });
  }
  function runtimeService(owner, token, ref) {
    let store, objects;
    try {
      store = deps.create_candidate_store({ config_dir: deps.config_dir, fs: deps.fs });
      objects = deps.repository_objects_for(freeze({ version: VERSION, head_binding: clone(owner), delivery_candidate_ref: clone(ref) }));
    } catch (error) { fail(safeCode(error, "delivery_candidate_runtime_unavailable"), "Delivery Candidate runtime is unavailable"); }
    try {
      return deps.create_composition_service({
        binding: clone(owner), candidate_store: store, repository_objects: objects,
        resolve_head_authorization: () => {
          const live = activeHead(token);
          if (!sameBinding(live, owner) || live.project_id !== ref.project_id || live.installation_id !== ref.installation_id) {
            fail("delivery_candidate_principal_unavailable", "Head principal changed");
          }
          return freeze({ version: VERSION, head_binding: clone(owner), archived: false });
        },
      });
    } catch (error) { fail(safeCode(error, "delivery_candidate_runtime_unavailable"), "Delivery Candidate composition service is unavailable"); }
  }
  function prepare(request) {
    if (!plain(request)) fail("invalid_delivery_candidate_runtime_request", "delivery request is invalid");
    exact(request.body, ["repository_key"], "invalid_delivery_candidate_prepare_request");
    if (!REPOSITORY_KEY_RE.test(request.body.repository_key)) fail("invalid_delivery_candidate_prepare_request", "repository key is invalid");
    const owner = activeHead(request.token);
    let staged, observed;
    try { staged = source(deps.read_delivery_source(freeze({ version: VERSION, installation_id: owner.installation_id, project_id: owner.project_id, repository_key: request.body.repository_key })), owner); }
    catch (error) { if (error instanceof DeliveryCandidateRuntimeError) throw error; fail(safeCode(error, "delivery_candidate_source_unavailable"), "Delivery Candidate source is unavailable"); }
    if (staged.registered_repository.repository_key !== request.body.repository_key) fail("delivery_candidate_source_invalid", "Delivery Candidate source repository is mismatched");
    try { observed = evidence(deps.read_delivery_evidence(freeze({ version: VERSION, head_binding: clone(owner), delivery_source: clone(staged) })), owner, request.body.repository_key); }
    catch (error) { if (error instanceof DeliveryCandidateRuntimeError) throw error; fail(safeCode(error, "delivery_candidate_evidence_unavailable"), "Delivery Candidate evidence is unavailable"); }
    const ref = { version: VERSION, installation_id: owner.installation_id, project_id: owner.project_id, repository_key: request.body.repository_key,
      batch_manifest_digest: staged.frozen_batch_manifest.manifest_digest, delivery_mode: staged.delivery_mode, base_sha: staged.base_sha,
      result_sha: observed.result_sha, cut_id: staged.cut_id };
    let manifest;
    try {
      manifest = buildDeliveryManifest({ version: VERSION, delivery_candidate_ref: ref, frozen_batch_manifest: staged.frozen_batch_manifest,
        staged_tasks: staged.staged_tasks, deferred_exclusions: staged.deferred_exclusions, evidence: observed.evidence }, {
        resolveRegisteredRepository: () => clone(staged.registered_repository),
      });
    } catch (error) { fail(safeCode(error, "delivery_candidate_prepare_rejected"), "Delivery Candidate manifest is rejected"); }
    try { return runtimeService(owner, request.token, ref).initializeCandidate({ head_binding: clone(owner), delivery_candidate_ref: clone(ref), delivery_manifest: manifest }); }
    catch (error) { if (error instanceof DeliveryCandidateRuntimeError) throw error; fail(safeCode(error, "delivery_candidate_prepare_unavailable"), "Delivery Candidate preparation is unavailable"); }
  }
  function compose(request) {
    if (!plain(request)) fail("invalid_delivery_candidate_runtime_request", "delivery request is invalid");
    const owner = activeHead(request.token);
    let ref;
    try { ref = assertDeliveryCandidateRef(request.body?.delivery_candidate_ref); }
    catch { fail("invalid_delivery_candidate_compose_request", "Delivery Candidate reference is invalid"); }
    if (ref.installation_id !== owner.installation_id || ref.project_id !== owner.project_id) fail("delivery_candidate_principal_unavailable", "Delivery Candidate is outside the current Head project");
    try { return runtimeService(owner, request.token, ref).composeCandidate({ head_binding: clone(owner), delivery_candidate_ref: clone(ref), expected_revision: request.body?.expected_revision, correlation_id: request.body?.correlation_id, idempotency_key: request.body?.idempotency_key }); }
    catch (error) { if (error instanceof DeliveryCandidateRuntimeError) throw error; fail(safeCode(error, "delivery_candidate_composition_unavailable"), "Delivery Candidate composition is unavailable"); }
  }
  return freeze({ prepare, compose });
}

module.exports = { VERSION, DeliveryCandidateRuntimeError, createDeliveryCandidateRuntime };
