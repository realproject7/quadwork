"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { canonicalSha, normalizeCiPolicy } = require("./ci-evidence-policy");
const { assertDeliveryCandidateRef, deliveryCandidateKey } = require("./delivery-candidate");

const PROJECT_ROLES = new Set(["head", "dev", "re1", "re2"]);
const DELIVERY_TARGET_KIND = "delivery_candidate_pr";
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const RECORD_ID_RE = /^ce_[a-f0-9]{32}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;

class CiEvidenceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "CiEvidenceError";
    this.code = code;
    this.status = status;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CiEvidenceError(code, "request must be an object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CiEvidenceError(code, "request contains an unknown or missing authority field");
  }
}

function normalizedItem(value) {
  exactObject(value, ["repo_key", "repo", "number", "kind"], "invalid_ci_evidence_item");
  if (typeof value.repo_key !== "string" || !REPOSITORY_KEY_RE.test(value.repo_key) ||
      typeof value.repo !== "string" || !REPOSITORY_RE.test(value.repo) ||
      !Number.isSafeInteger(value.number) || value.number < 1 ||
      value.kind !== "issue") {
    throw new CiEvidenceError("invalid_ci_evidence_item", "item must be one canonical issue WorkItemRef");
  }
  return Object.freeze({
    repo_key: value.repo_key,
    repo: value.repo,
    number: value.number,
    kind: value.kind,
  });
}

function normalizedSubmitRequest(body) {
  exactObject(body, [
    "assignment_attempt",
    "contract_revision",
    "repo_key",
    "item",
    "pr_number",
    "exact_sha",
    "policy_version",
    "results",
  ], "invalid_ci_evidence_request");
  if (typeof body.assignment_attempt !== "string" || body.assignment_attempt.length === 0 || body.assignment_attempt.length > 128 ||
      typeof body.contract_revision !== "string" || !REVISION_RE.test(body.contract_revision) ||
      typeof body.repo_key !== "string" || !REPOSITORY_KEY_RE.test(body.repo_key) ||
      !Number.isSafeInteger(body.pr_number) || body.pr_number < 1 ||
      !Number.isSafeInteger(body.policy_version) || body.policy_version < 1 ||
      !canonicalSha(body.exact_sha) || !Array.isArray(body.results) || body.results.length === 0 || body.results.length > 64) {
    throw new CiEvidenceError("invalid_ci_evidence_request", "CI evidence identity is invalid");
  }
  const item = normalizedItem(body.item);
  if (item.repo_key !== body.repo_key) throw new CiEvidenceError("invalid_ci_evidence_item", "item repo_key must match repo_key");
  return Object.freeze({
    assignment_attempt: body.assignment_attempt,
    contract_revision: body.contract_revision,
    repo_key: body.repo_key,
    item,
    pr_number: body.pr_number,
    exact_sha: canonicalSha(body.exact_sha),
    policy_version: body.policy_version,
    results: body.results,
  });
}

// #1060 extends the existing CI-less receipt store with one closed final-PR
// identity. A local WorkTask is deliberately not accepted here: only a
// composed repository Delivery Candidate can carry final-hosted-check proof.
function normalizedDeliveryCandidateSubmitRequest(body) {
  exactObject(body, [
    "delivery_candidate_ref",
    "pr_number",
    "exact_sha",
    "policy_version",
    "results",
  ], "invalid_delivery_ci_evidence_request");
  let deliveryCandidateRef;
  try { deliveryCandidateRef = assertDeliveryCandidateRef(body.delivery_candidate_ref); }
  catch { throw new CiEvidenceError("invalid_delivery_ci_evidence_request", "Delivery Candidate reference is invalid"); }
  if (!Number.isSafeInteger(body.pr_number) || body.pr_number < 1 || !canonicalSha(body.exact_sha) ||
      !Number.isSafeInteger(body.policy_version) || body.policy_version < 1 ||
      !Array.isArray(body.results) || body.results.length === 0 || body.results.length > 64) {
    throw new CiEvidenceError("invalid_delivery_ci_evidence_request", "Delivery Candidate CI evidence identity is invalid");
  }
  return Object.freeze({
    delivery_candidate_ref: Object.freeze({ ...deliveryCandidateRef }),
    pr_number: body.pr_number,
    exact_sha: canonicalSha(body.exact_sha),
    policy_version: body.policy_version,
    results: body.results,
  });
}

function normalizedResults(rawResults, policy) {
  const normalizedPolicy = normalizeCiPolicy(policy);
  if (normalizedPolicy.mode !== "ci-less") {
    throw new CiEvidenceError("ci_evidence_policy_not_ci_less", "repository does not allow CI-less evidence", 409);
  }
  const expected = new Set(normalizedPolicy.evidence_keys);
  const seen = new Set();
  const results = rawResults.map((result) => {
    exactObject(result, ["key", "outcome", "exit_code", "evidence_ref"], "invalid_ci_evidence_result");
    if (typeof result.key !== "string" || !expected.has(result.key) || seen.has(result.key) ||
        !["pass", "fail"].includes(result.outcome) ||
        !Number.isSafeInteger(result.exit_code) || result.exit_code < 0 || result.exit_code > 255 ||
        typeof result.evidence_ref !== "string" || result.evidence_ref.length === 0 || result.evidence_ref.length > 512 ||
        /[\r\n\u0000]/.test(result.evidence_ref)) {
      throw new CiEvidenceError("invalid_ci_evidence_result", "evidence results must contain each configured data key exactly once");
    }
    seen.add(result.key);
    return Object.freeze({
      key: result.key,
      outcome: result.outcome,
      exit_code: result.exit_code,
      evidence_ref: result.evidence_ref,
    });
  });
  if (seen.size !== expected.size) {
    throw new CiEvidenceError("incomplete_ci_evidence", "all configured evidence keys are required");
  }
  return Object.freeze(results.sort((left, right) => left.key.localeCompare(right.key)));
}

function normalizedTarget(target, request, projectId) {
  if (!target || typeof target !== "object" || Array.isArray(target) || target.project_id !== projectId ||
      typeof target.installation_id !== "string" || target.installation_id.length === 0 ||
      typeof target.repo_key !== "string" || target.repo_key !== request.repo_key ||
      typeof target.repo !== "string" || !REPOSITORY_RE.test(target.repo) ||
      target.assignment_attempt !== request.assignment_attempt || target.contract_revision !== request.contract_revision ||
      target.pr_number !== request.pr_number || canonicalSha(target.exact_sha) !== request.exact_sha ||
      target.policy_version !== request.policy_version) {
    throw new CiEvidenceError("ci_evidence_target_changed", "current assignment, contract, PR tip, or policy changed", 409);
  }
  const item = normalizedItem(target.item);
  if (stableJson(item) !== stableJson(request.item)) {
    throw new CiEvidenceError("ci_evidence_target_changed", "current assignment item changed", 409);
  }
  let policy;
  try { policy = normalizeCiPolicy(target.policy); } catch {
    throw new CiEvidenceError("ci_evidence_policy_unavailable", "current CI policy is unavailable", 409);
  }
  if (policy.mode !== "ci-less" || policy.version !== request.policy_version) {
    throw new CiEvidenceError("ci_evidence_policy_changed", "current repository CI policy changed", 409);
  }
  return Object.freeze({
    version: 1,
    project_id: projectId,
    installation_id: target.installation_id,
    repo_key: target.repo_key,
    repo: target.repo,
    item,
    assignment_attempt: target.assignment_attempt,
    contract_revision: target.contract_revision,
    pr_number: target.pr_number,
    exact_sha: request.exact_sha,
    policy_version: policy.version,
    policy,
  });
}

function normalizedDeliveryCandidateTarget(target, request, projectId) {
  exactObject(target, [
    "version",
    "target_kind",
    "project_id",
    "installation_id",
    "repo_key",
    "repo",
    "delivery_candidate_ref",
    "delivery_manifest_digest",
    "pr_number",
    "exact_sha",
    "policy_version",
    "policy",
  ], "delivery_ci_evidence_target_changed");
  let ref;
  try { ref = assertDeliveryCandidateRef(target.delivery_candidate_ref); }
  catch { throw new CiEvidenceError("delivery_ci_evidence_target_changed", "Delivery Candidate reference changed", 409); }
  if (target.version !== 1 || target.target_kind !== DELIVERY_TARGET_KIND || target.project_id !== projectId ||
      typeof target.installation_id !== "string" || target.installation_id.length === 0 ||
      typeof target.repo_key !== "string" || !REPOSITORY_KEY_RE.test(target.repo_key) ||
      typeof target.repo !== "string" || !REPOSITORY_RE.test(target.repo) ||
      ref.installation_id !== target.installation_id || ref.project_id !== projectId || ref.repository_key !== target.repo_key ||
      deliveryCandidateKey(ref) !== deliveryCandidateKey(request.delivery_candidate_ref) ||
      typeof target.delivery_manifest_digest !== "string" || !REVISION_RE.test(target.delivery_manifest_digest) ||
      target.pr_number !== request.pr_number || canonicalSha(target.exact_sha) !== request.exact_sha ||
      target.policy_version !== request.policy_version) {
    throw new CiEvidenceError("delivery_ci_evidence_target_changed", "current Delivery Candidate, PR tip, or policy changed", 409);
  }
  let policy;
  try { policy = normalizeCiPolicy(target.policy); } catch {
    throw new CiEvidenceError("ci_evidence_policy_unavailable", "current CI policy is unavailable", 409);
  }
  if (policy.mode !== "ci-less" || policy.version !== request.policy_version) {
    throw new CiEvidenceError("ci_evidence_policy_changed", "current Delivery Candidate CI policy changed", 409);
  }
  return Object.freeze({
    version: 1,
    target_kind: DELIVERY_TARGET_KIND,
    project_id: projectId,
    installation_id: target.installation_id,
    repo_key: target.repo_key,
    repo: target.repo,
    delivery_candidate_ref: Object.freeze({ ...ref }),
    delivery_manifest_digest: target.delivery_manifest_digest,
    pr_number: target.pr_number,
    exact_sha: request.exact_sha,
    policy_version: policy.version,
    policy,
  });
}

function recordIdentity(target) {
  if (target?.target_kind === DELIVERY_TARGET_KIND) {
    return Object.freeze({
      version: target.version,
      target_kind: DELIVERY_TARGET_KIND,
      project_id: target.project_id,
      installation_id: target.installation_id,
      repo_key: target.repo_key,
      repo: target.repo,
      delivery_candidate_ref: target.delivery_candidate_ref,
      delivery_manifest_digest: target.delivery_manifest_digest,
      pr_number: target.pr_number,
      exact_sha: target.exact_sha,
      policy_version: target.policy_version,
    });
  }
  return Object.freeze({
    version: target.version,
    project_id: target.project_id,
    installation_id: target.installation_id,
    repo_key: target.repo_key,
    repo: target.repo,
    item: target.item,
    assignment_attempt: target.assignment_attempt,
    contract_revision: target.contract_revision,
    pr_number: target.pr_number,
    exact_sha: target.exact_sha,
    policy_version: target.policy_version,
  });
}

function redactedRecord(record) {
  if (!record || typeof record !== "object") return null;
  return Object.freeze({
    record_id: record.record_id,
    identity: record.identity,
    observed_at: record.observed_at,
    results: Object.freeze((record.results || []).map((result) => Object.freeze({
      key: result.key,
      outcome: result.outcome,
      exit_code: result.exit_code,
      evidence_ref_digest: sha256(result.evidence_ref),
    }))),
  });
}

class CiEvidenceStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(os.homedir(), ".quadwork");
    this.fs = options.fsImpl || fs;
    this.now = options.now || (() => new Date());
    // One process owns the HTTP server. Serialize receipt transactions per
    // project so two different Dev submissions cannot both read an old
    // document and atomically replace one another's record.
    this._projectWrites = new Map();
  }

  filePath(projectId) {
    if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
      throw new CiEvidenceError("invalid_ci_evidence_project", "project identity is invalid", 403);
    }
    return path.join(this.rootDir, projectId, "ci-evidence.json");
  }

  readDocument(projectId) {
    const filePath = this.filePath(projectId);
    try {
      const parsed = JSON.parse(this.fs.readFileSync(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 ||
          !parsed.records || typeof parsed.records !== "object" || Array.isArray(parsed.records)) {
        throw new CiEvidenceError("ci_evidence_store_unreadable", "CI evidence store is invalid", 503);
      }
      return parsed;
    } catch (error) {
      if (error && error.code === "ENOENT") return { version: 1, records: {} };
      if (error instanceof CiEvidenceError) throw error;
      throw new CiEvidenceError("ci_evidence_store_unreadable", "CI evidence store could not be read", 503);
    }
  }

  writeDocument(projectId, document) {
    const destination = this.filePath(projectId);
    const directory = path.dirname(destination);
    try {
      this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.fs.chmodSync(directory, 0o700);
      const candidate = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
      this.fs.writeFileSync(candidate, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      this.fs.chmodSync(candidate, 0o600);
      this.fs.renameSync(candidate, destination);
      this.fs.chmodSync(destination, 0o600);
    } catch (error) {
      if (error instanceof CiEvidenceError) throw error;
      throw new CiEvidenceError("ci_evidence_store_write_failed", "CI evidence store could not be persisted", 503);
    }
  }

  /**
   * Serialize the complete read/validate/write transaction for one project.
   * The caller keeps its final authority validation inside this critical
   * section immediately before `upsert`, so a rejected admission never leaves
   * a durable receipt behind. This does not accept a path from the caller.
   */
  async withProjectWrite(projectId, operation) {
    if (typeof operation !== "function") throw new TypeError("CI evidence write operation must be a function");
    this.filePath(projectId); // validate the server-derived map key up front
    const previous = this._projectWrites.get(projectId) || Promise.resolve();
    let release;
    const completion = new Promise((resolve) => { release = resolve; });
    const chain = previous.catch(() => {}).then(() => completion);
    this._projectWrites.set(projectId, chain);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this._projectWrites.get(projectId) === chain) this._projectWrites.delete(projectId);
    }
  }

  upsert(target, results) {
    const identity = recordIdentity(target);
    const identityHash = sha256(identity);
    const recordDigest = sha256({ identity, results });
    const document = this.readDocument(target.project_id);
    const existing = document.records[identityHash];
    if (existing?.record_digest === recordDigest) return existing;
    const now = this.now();
    const observedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const record = Object.freeze({
      record_id: `ce_${recordDigest.slice(0, 32)}`,
      record_digest: recordDigest,
      identity_hash: identityHash,
      identity,
      observed_at: observedAt,
      results,
    });
    document.records[identityHash] = record;
    this.writeDocument(target.project_id, document);
    return record;
  }

  readByIdentity(target) {
    const document = this.readDocument(target.project_id);
    return document.records[sha256(recordIdentity(target))] || null;
  }

  readByRecordId(projectId, recordId) {
    if (typeof recordId !== "string" || !RECORD_ID_RE.test(recordId)) return null;
    const document = this.readDocument(projectId);
    return Object.values(document.records).find((record) => record?.record_id === recordId) || null;
  }
}

function requestPrincipal(req, resolveShimPrincipal, roles, code) {
  const principal = resolveShimPrincipal(req.headers?.["x-chat-token"]);
  const claimedActor = req.headers?.["x-chat-sender"];
  if (!principal || !roles.has(principal.agentId)) {
    throw new CiEvidenceError(code, "shim principal is not authorized", 403);
  }
  if (claimedActor !== undefined && claimedActor !== principal.agentId) {
    throw new CiEvidenceError("invalid_ci_evidence_request", "caller actor must be derived from shim token");
  }
  return principal;
}

function createCiLessEvidenceSubmitHandler(options = {}) {
  const resolveShimPrincipal = options.resolveShimPrincipal;
  const captureProjectAdmission = options.captureProjectAdmission;
  const isAdmissionCurrent = options.isAdmissionCurrent;
  const resolveCurrentTarget = options.resolveCurrentTarget;
  const store = options.store || new CiEvidenceStore(options);
  if (typeof resolveShimPrincipal !== "function" || typeof captureProjectAdmission !== "function" ||
      typeof isAdmissionCurrent !== "function" || typeof resolveCurrentTarget !== "function") {
    throw new TypeError("CI-less evidence handler dependencies are required");
  }

  return async function submitCiEvidence(req, res) {
    try {
      const principal = requestPrincipal(req, resolveShimPrincipal, new Set(["dev"]), "ci_evidence_forbidden");
      if (Object.keys(req.query || {}).length !== 0) throw new CiEvidenceError("invalid_ci_evidence_request", "query identity is not accepted");
      const request = normalizedSubmitRequest(req.body);
      const admission = captureProjectAdmission(principal.projectId);
      if (!isAdmissionCurrent(admission)) throw new CiEvidenceError("ci_evidence_admission_changed", "project admission changed", 409);
      const readBack = await store.withProjectWrite(principal.projectId, async () => {
        // This resolver performs the live assignment/contract/PR re-read. It
        // must occur inside the serialized transaction because a request can
        // have waited behind another Dev receipt for this project.
        const target = normalizedTarget(
          await resolveCurrentTarget(principal.projectId, request),
          request,
          principal.projectId,
        );
        if (!isAdmissionCurrent(admission)) {
          throw new CiEvidenceError("ci_evidence_admission_changed", "project admission changed", 409);
        }
        const results = normalizedResults(request.results, target.policy);
        // No await occurs between this final authority check and the atomic
        // replacement. In-process lifecycle changes therefore cannot leave a
        // rejected request's receipt on disk.
        if (!isAdmissionCurrent(admission)) {
          throw new CiEvidenceError("ci_evidence_admission_changed", "project admission changed", 409);
        }
        const record = store.upsert(target, results);
        const persisted = store.readByIdentity(target);
        if (!persisted || persisted.record_id !== record.record_id || persisted.record_digest !== record.record_digest) {
          throw new CiEvidenceError("ci_evidence_store_readback_failed", "CI evidence persistence could not be verified", 503);
        }
        return persisted;
      });
      return res.json({ ok: true, record: redactedRecord(readBack) });
    } catch (error) {
      const failure = error instanceof CiEvidenceError
        ? error
        : new CiEvidenceError("ci_evidence_target_unavailable", "current CI evidence target could not be read", 503);
      return res.status(failure.status).json({ ok: false, code: failure.code });
    }
  };
}

function createDeliveryCandidateCiLessEvidenceSubmitHandler(options = {}) {
  const resolveShimPrincipal = options.resolveShimPrincipal;
  const captureProjectAdmission = options.captureProjectAdmission;
  const isAdmissionCurrent = options.isAdmissionCurrent;
  const resolveCurrentTarget = options.resolveCurrentTarget;
  const store = options.store || new CiEvidenceStore(options);
  if (typeof resolveShimPrincipal !== "function" || typeof captureProjectAdmission !== "function" ||
      typeof isAdmissionCurrent !== "function" || typeof resolveCurrentTarget !== "function") {
    throw new TypeError("Delivery Candidate CI-less evidence handler dependencies are required");
  }

  return async function submitDeliveryCandidateCiEvidence(req, res) {
    try {
      const principal = requestPrincipal(req, resolveShimPrincipal, new Set(["dev"]), "delivery_ci_evidence_forbidden");
      if (Object.keys(req.query || {}).length !== 0) throw new CiEvidenceError("invalid_delivery_ci_evidence_request", "query identity is not accepted");
      const request = normalizedDeliveryCandidateSubmitRequest(req.body);
      const admission = captureProjectAdmission(principal.projectId);
      if (!isAdmissionCurrent(admission)) throw new CiEvidenceError("ci_evidence_admission_changed", "project admission changed", 409);
      const readBack = await store.withProjectWrite(principal.projectId, async () => {
        const target = normalizedDeliveryCandidateTarget(
          await resolveCurrentTarget(principal.projectId, request),
          request,
          principal.projectId,
        );
        if (!isAdmissionCurrent(admission)) {
          throw new CiEvidenceError("ci_evidence_admission_changed", "project admission changed", 409);
        }
        const results = normalizedResults(request.results, target.policy);
        if (!isAdmissionCurrent(admission)) {
          throw new CiEvidenceError("ci_evidence_admission_changed", "project admission changed", 409);
        }
        const record = store.upsert(target, results);
        const persisted = store.readByIdentity(target);
        if (!persisted || persisted.record_id !== record.record_id || persisted.record_digest !== record.record_digest) {
          throw new CiEvidenceError("ci_evidence_store_readback_failed", "CI evidence persistence could not be verified", 503);
        }
        return persisted;
      });
      return res.json({ ok: true, record: redactedRecord(readBack) });
    } catch (error) {
      const failure = error instanceof CiEvidenceError
        ? error
        : new CiEvidenceError("delivery_ci_evidence_target_unavailable", "current Delivery Candidate CI evidence target could not be read", 503);
      return res.status(failure.status).json({ ok: false, code: failure.code });
    }
  };
}

function createCiLessEvidenceReadHandler(options = {}) {
  const resolveShimPrincipal = options.resolveShimPrincipal;
  const store = options.store || new CiEvidenceStore(options);
  if (typeof resolveShimPrincipal !== "function") throw new TypeError("CI-less evidence read handler requires shim principal resolver");
  return function readCiEvidence(req, res) {
    try {
      const principal = requestPrincipal(req, resolveShimPrincipal, PROJECT_ROLES, "ci_evidence_read_forbidden");
      if (Object.keys(req.query || {}).length !== 0) throw new CiEvidenceError("invalid_ci_evidence_read", "query identity is not accepted");
      exactObject(req.body, ["record_id"], "invalid_ci_evidence_read");
      const record = store.readByRecordId(principal.projectId, req.body.record_id);
      if (!record) throw new CiEvidenceError("ci_evidence_record_not_found", "CI evidence record was not found", 404);
      return res.json({ ok: true, record: redactedRecord(record) });
    } catch (error) {
      const failure = error instanceof CiEvidenceError
        ? error
        : new CiEvidenceError("ci_evidence_store_unreadable", "CI evidence store could not be read", 503);
      return res.status(failure.status).json({ ok: false, code: failure.code });
    }
  };
}

module.exports = {
  PROJECT_ROLES,
  CiEvidenceError,
  CiEvidenceStore,
  normalizedSubmitRequest,
  normalizedDeliveryCandidateSubmitRequest,
  normalizedDeliveryCandidateTarget,
  normalizedResults,
  redactedRecord,
  createCiLessEvidenceSubmitHandler,
  createDeliveryCandidateCiLessEvidenceSubmitHandler,
  createCiLessEvidenceReadHandler,
};
