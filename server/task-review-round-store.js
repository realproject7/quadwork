"use strict";

// #1059 M2: a deliberately narrow, durable store for the already-sealed
// TaskReviewRound contract.  It owns one owner-only document per registered
// installation/project scope.  It is not a generic persistence layer: callers
// can open an exact round, submit through a trusted reviewer context, read
// only their own sealed receipt, or cancel the exact round from trusted
// archive/candidate state.  There is intentionally no pruning or delivery
// authority here.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDurableStoreFiles } = require("./durable-store-files");
const {
  assertWorkTaskRef,
  workTaskKey,
} = require("./work-task-manifest");
const {
  assertTaskReviewRoundRef,
  taskReviewRoundKey,
  assertTaskReviewRound,
  openTaskReviewRound,
  submitTaskReviewReceipt,
  viewTaskReviewRound,
  cancelTaskReviewRound,
  planSealedTaskReviewPropagation,
} = require("./task-review-round");

const TASK_REVIEW_ROUND_STORE_VERSION = 1;
const TASK_REVIEW_ROUND_STORE_DIRECTORY = "task-review-rounds";
const TASK_REVIEW_ROUND_STORE_FILENAME_SUFFIX = ".json";
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_ROUNDS_PER_PROJECT = 64;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const FILE_CODES = Object.freeze({
  options: "invalid_task_review_round_store_options",
  unreadable: "task_review_round_store_unreadable",
  symlink_rejected: "task_review_round_store_unsafe",
  insecure_permissions: "task_review_round_store_unsafe",
  write_failed: "task_review_round_store_persist_failed",
  locked: "task_review_round_store_locked",
  lock_unsafe: "task_review_round_store_unsafe",
  lock_failed: "task_review_round_store_persist_failed",
  lock_acquire_changed: "task_review_round_store_unsafe",
  lock_release_changed: "task_review_round_store_unsafe",
  lock_release_failed: "task_review_round_store_persist_failed",
});

class TaskReviewRoundStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "TaskReviewRoundStoreError";
    this.code = code;
  }
}

function fail(code, message) { throw new TaskReviewRoundStoreError(code, message); }
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be an object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function cloneFreeze(value) { return freeze(clone(value)); }

function absoluteDirectory(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 1024 || !path.isAbsolute(value) || /[\u0000\r\n]/.test(value)) {
    fail("task_review_round_store_root_invalid", "store root must be a bounded absolute path");
  }
  const normalized = path.resolve(value);
  if (normalized === path.parse(normalized).root) {
    fail("task_review_round_store_root_invalid", "store root must not be a filesystem root");
  }
  return normalized;
}

function scopeFromRef(ref, code = "invalid_task_review_round_store_scope") {
  try { assertTaskReviewRoundRef(ref, code); }
  catch (error) {
    if (error instanceof TaskReviewRoundStoreError) throw error;
    fail(code, "review-round scope is invalid");
  }
  return { installation_id: ref.installation_id, project_id: ref.project_id };
}

// A project-scope owner, for the one server-internal listing below.  It never
// reaches a filesystem path directly: both fields are only hashed into the
// existing per-project document name.
function archiveScope(value, code = "invalid_task_review_round_store_scope") {
  exact(value, ["installation_id", "project_id"], code);
  if (typeof value.installation_id !== "string" || value.installation_id.length === 0 || value.installation_id.length > 128 ||
      typeof value.project_id !== "string" || value.project_id.length === 0 || value.project_id.length > 128) {
    fail(code, "review-round scope is invalid");
  }
  return { installation_id: value.installation_id, project_id: value.project_id };
}

function candidateDigest(value, code = "invalid_task_review_round_store_candidate") {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(code, "candidate digest is invalid");
  return value;
}

function scopeFilename(scope) {
  return `${hash({ version: TASK_REVIEW_ROUND_STORE_VERSION, installation_id: scope.installation_id, project_id: scope.project_id })}${TASK_REVIEW_ROUND_STORE_FILENAME_SUFFIX}`;
}

function recordKey(ref, digest) {
  const scope = scopeFromRef(ref);
  return hash({
    version: TASK_REVIEW_ROUND_STORE_VERSION,
    installation_id: scope.installation_id,
    project_id: scope.project_id,
    review_round_key: taskReviewRoundKey(ref),
    candidate_digest: candidateDigest(digest),
  });
}

function documentPayload(document) {
  return {
    version: document.version,
    installation_id: document.installation_id,
    project_id: document.project_id,
    records: clone(document.records),
  };
}

function emptyDocument(scope) {
  return {
    version: TASK_REVIEW_ROUND_STORE_VERSION,
    installation_id: scope.installation_id,
    project_id: scope.project_id,
    records: Object.create(null),
    document_digest: null,
  };
}

function finalizeDocument(value) {
  const next = {
    version: value.version,
    installation_id: value.installation_id,
    project_id: value.project_id,
    records: clone(value.records),
  };
  next.document_digest = hash(documentPayload(next));
  assertDocument(next, { installation_id: next.installation_id, project_id: next.project_id });
  return next;
}

function assertRecord(value, scope, key) {
  exact(value, ["round"], "task_review_round_store_invalid");
  try { assertTaskReviewRound(value.round); }
  catch { fail("task_review_round_store_invalid", "stored round is invalid"); }
  const round = value.round;
  if (round.review_round_ref.installation_id !== scope.installation_id || round.review_round_ref.project_id !== scope.project_id ||
      recordKey(round.review_round_ref, round.candidate_digest) !== key) {
    fail("task_review_round_store_invalid", "stored round identity does not match its project scope");
  }
  return { round: clone(round) };
}

function assertDocument(value, scope) {
  exact(value, ["version", "installation_id", "project_id", "records", "document_digest"], "task_review_round_store_invalid");
  if (value.version !== TASK_REVIEW_ROUND_STORE_VERSION || value.installation_id !== scope.installation_id || value.project_id !== scope.project_id ||
      !plain(value.records) || !DIGEST_RE.test(value.document_digest)) {
    fail("task_review_round_store_invalid", "stored document identity is invalid");
  }
  const entries = Object.entries(value.records);
  if (entries.length > MAX_ROUNDS_PER_PROJECT) fail("task_review_round_store_invalid", "stored document exceeds its round bound");
  const records = Object.create(null);
  for (const [key, entry] of entries) {
    if (!DIGEST_RE.test(key)) fail("task_review_round_store_invalid", "stored round key is invalid");
    records[key] = assertRecord(entry, scope, key);
  }
  const normalized = {
    version: value.version,
    installation_id: value.installation_id,
    project_id: value.project_id,
    records,
    document_digest: value.document_digest,
  };
  if (normalized.document_digest !== hash(documentPayload(normalized))) {
    fail("task_review_round_store_invalid", "stored document digest is invalid");
  }
  return normalized;
}

function ownerUid() {
  try { return typeof process.getuid === "function" ? process.getuid() : null; }
  catch { return null; }
}

function secureDirectory(fsImpl, directory) {
  try { fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch { fail("task_review_round_store_persist_failed", "could not create store directory"); }
  let stat;
  try { stat = fsImpl.lstatSync(directory); }
  catch { fail("task_review_round_store_persist_failed", "could not inspect store directory"); }
  const uid = ownerUid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    fail("task_review_round_store_unsafe", "store directory is unsafe");
  }
  try { fsImpl.chmodSync(directory, 0o700); }
  catch { fail("task_review_round_store_persist_failed", "could not secure store directory"); }
  try { stat = fsImpl.lstatSync(directory); }
  catch { fail("task_review_round_store_persist_failed", "could not recheck store directory"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (uid !== null && stat.uid !== uid)) {
    fail("task_review_round_store_unsafe", "store directory permissions are unsafe");
  }
}

function verifyExistingDirectory(fsImpl, directory) {
  let stat;
  try { stat = fsImpl.lstatSync(directory); }
  catch { fail("task_review_round_store_unreadable", "store directory is unreadable"); }
  const uid = ownerUid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (uid !== null && stat.uid !== uid)) {
    fail("task_review_round_store_unsafe", "store directory is unsafe");
  }
}

function verifyExistingFile(fsImpl, filePath) {
  let stat;
  try { stat = fsImpl.lstatSync(filePath); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    fail("task_review_round_store_unreadable", "store file is unreadable");
  }
  const uid = ownerUid();
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid)) {
    fail("task_review_round_store_unsafe", "store file is unsafe");
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 2 || stat.size > MAX_DOCUMENT_BYTES) {
    fail("task_review_round_store_invalid", "store file exceeds its hard bound");
  }
  return stat;
}

function safeReadDocument(fsImpl, rootDir, scope) {
  const directory = path.join(rootDir, TASK_REVIEW_ROUND_STORE_DIRECTORY);
  const filePath = path.join(directory, scopeFilename(scope));
  const file = verifyExistingFile(fsImpl, filePath);
  if (file === null) return { document: emptyDocument(scope), exists: false, filePath };
  verifyExistingDirectory(fsImpl, rootDir);
  verifyExistingDirectory(fsImpl, directory);
  let raw;
  try { raw = fsImpl.readFileSync(filePath, "utf8"); }
  catch { fail("task_review_round_store_unreadable", "store file could not be read"); }
  if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) fail("task_review_round_store_invalid", "store document exceeds its hard bound");
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail("task_review_round_store_invalid", "store document is not valid JSON"); }
  return { document: assertDocument(parsed, scope), exists: true, filePath };
}

function secureStoreDirectories(fsImpl, rootDir) {
  secureDirectory(fsImpl, rootDir);
  const directory = path.join(rootDir, TASK_REVIEW_ROUND_STORE_DIRECTORY);
  secureDirectory(fsImpl, directory);
  return directory;
}

// The project writer lock is held across read -> pure transition -> atomic
// replace.  A failed release leaves a 0600 lock behind, which every later
// mutation fails closed on rather than guessing that it is stale.
function withProjectWriterLock(store, scope, action) {
  const directory = secureStoreDirectories(store.fs, store.rootDir);
  return store.files.withWriterLock(path.join(directory, scopeFilename(scope)), action);
}

function writeDocument(store, scope, document) {
  const normalized = finalizeDocument(document);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DOCUMENT_BYTES) {
    fail("task_review_round_store_over_bound", "store document exceeds its hard bound");
  }
  const directory = secureStoreDirectories(store.fs, store.rootDir);
  store.files.writeFileAtomically(path.join(directory, scopeFilename(scope)), serialized);
  return cloneFreeze(normalized);
}

function statusProjection(round) {
  return cloneFreeze({
    version: TASK_REVIEW_ROUND_STORE_VERSION,
    status: round.status,
    review_round_ref: clone(round.review_round_ref),
    candidate_digest: round.candidate_digest,
  });
}

function sameOpening(existing, opened) {
  return stable({
    review_round_ref: existing.review_round_ref,
    candidate_digest: existing.candidate_digest,
    opened_at: existing.opened_at,
    reviewer_assignments: existing.reviewer_assignments,
  }) === stable({
    review_round_ref: opened.review_round_ref,
    candidate_digest: opened.candidate_digest,
    opened_at: opened.opened_at,
    reviewer_assignments: opened.reviewer_assignments,
  });
}

function releaseProjection(round) {
  return {
    version: TASK_REVIEW_ROUND_STORE_VERSION,
    transaction: "two_current_sealed_receipts",
    candidate_digest: round.candidate_digest,
    released_at: round.release.released_at,
  };
}

// This is the sole non-reviewer projection of a released round.  It is for a
// later server-internal reconciliation service only, so it intentionally
// carries verdict anchors but not peer findings or receipt bodies.  The public
// reviewer read path below remains restricted to the caller's own receipt.
function reconciliationProjection(round) {
  if (round.status !== "released" || round.release === null || round.receipts.length !== 2) {
    fail("task_review_round_not_released", "review round has no terminal sealed release");
  }
  return cloneFreeze({
    version: TASK_REVIEW_ROUND_STORE_VERSION,
    review_round_ref: clone(round.review_round_ref),
    candidate_digest: round.candidate_digest,
    round_digest: round.round_digest,
    released_at: round.release.released_at,
    receipt_verdicts: round.release.receipts.map((sealed) => ({
      reviewer_role: sealed.reviewer_role,
      reviewer_generation: sealed.reviewer_generation,
      receipt_id: sealed.receipt.receipt_id,
      receipt_digest: sealed.receipt.receipt_digest,
      verdict: sealed.receipt.verdict,
    })),
  });
}

// A Delivery Candidate needs exact released-round provenance anchors, but
// never reviewer findings or receipt bodies. This server-internal read seam
// has no HTTP/MCP route; reviewer reads below remain own-receipt-only.
function deliveryProjection(round) {
  if (round.status !== "released" || round.release === null || round.receipts.length !== 2) {
    fail("task_review_round_not_released", "review round has no terminal sealed release");
  }
  return cloneFreeze({
    version: TASK_REVIEW_ROUND_STORE_VERSION,
    status: "released",
    review_round_ref: clone(round.review_round_ref),
    round_digest: round.round_digest,
    candidate_digest: round.candidate_digest,
    current_sha: round.review_round_ref.candidate_sha,
    receipt_anchors: round.release.receipts.map((sealed) => ({
      reviewer_role: sealed.reviewer_role,
      reviewer_generation: sealed.reviewer_generation,
      receipt_id: sealed.receipt.receipt_id,
      receipt_digest: sealed.receipt.receipt_digest,
      verdict: sealed.receipt.verdict,
    })),
  });
}
function candidateRequest(value, code) {
  exact(value, ["version", "work_task_ref", "candidate_digest"], code);
  if (value.version !== TASK_REVIEW_ROUND_STORE_VERSION) fail(code, "request version is invalid");
  try { assertWorkTaskRef(value.work_task_ref); }
  catch { fail(code, "work task reference is invalid"); }
  return {
    work_task_ref: clone(value.work_task_ref),
    candidate_digest: candidateDigest(value.candidate_digest, code),
  };
}
function roundsForCandidate(document, request) {
  return Object.values(document.records)
    .map((record) => record.round)
    .filter((round) => round.candidate_digest === request.candidate_digest &&
      workTaskKey(round.review_round_ref.work_task_ref) === workTaskKey(request.work_task_ref));
}

function ownReceiptProjection(round, trustedContext) {
  // Let the pure contract authenticate the trusted role/generation before this
  // store projects anything.  Its released view is intentionally discarded:
  // the durable store never exposes a peer receipt or peer finding through a
  // reviewer read path.
  const validated = viewTaskReviewRound(round, trustedContext);
  if (validated.status === "sealed" || validated.status === "cancelled") return cloneFreeze(validated);
  const own = round.receipts.find((entry) => entry.reviewer_role === trustedContext.reviewer_role);
  return cloneFreeze({
    version: TASK_REVIEW_ROUND_STORE_VERSION,
    status: "released",
    review_round_ref: clone(round.review_round_ref),
    own_receipt: own ? clone(own.receipt) : null,
    release: releaseProjection(round),
  });
}

function recordFor(document, ref, digest) {
  const key = recordKey(ref, digest);
  const record = document.records[key];
  if (!record) fail("task_review_round_not_found", "no exact persisted review round exists");
  return { key, round: record.round };
}

class TaskReviewRoundStore {
  constructor(options = {}) {
    this.fs = options.fsImpl || fs;
    this.rootDir = absoluteDirectory(options.rootDir || path.join(os.homedir(), ".quadwork"));
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.files = createDurableStoreFiles({ fs: this.fs, error: TaskReviewRoundStoreError, codes: FILE_CODES, random_bytes: this.randomBytes });
  }

  pathFor(reviewRoundRef) {
    const scope = scopeFromRef(reviewRoundRef);
    return path.join(this.rootDir, TASK_REVIEW_ROUND_STORE_DIRECTORY, scopeFilename(scope));
  }

  openRound(input, trustedAssignments) {
    const opened = openTaskReviewRound(input, trustedAssignments);
    const scope = scopeFromRef(opened.review_round_ref);
    return withProjectWriterLock(this, scope, () => {
      // State is intentionally re-read only after this project-scoped lock is
      // held.  A concurrent opener/receipt/cancellation can therefore never
      // publish a newer document between our read and atomic replace.
      const loaded = safeReadDocument(this.fs, this.rootDir, scope);
      const key = recordKey(opened.review_round_ref, opened.candidate_digest);
      const prior = loaded.document.records[key];
      if (prior) {
        // Receipt/release/cancellation state is expected to change after the
        // immutable opening.  Retrying that same exact opening must not replace
        // it or turn a later sealed state into a conflict.
        if (!sameOpening(prior.round, opened)) {
          fail("task_review_round_conflict", "an exact review-round key already has different immutable opening state");
        }
        return statusProjection(prior.round);
      }
      if (Object.keys(loaded.document.records).length >= MAX_ROUNDS_PER_PROJECT) {
        fail("task_review_round_store_over_bound", "project has reached its sealed review-round bound");
      }
      const next = clone(loaded.document);
      next.records[key] = { round: clone(opened) };
      writeDocument(this, scope, next);
      return statusProjection(opened);
    });
  }

  submitTrustedReceipt(reviewRoundRef, digest, receipt, trustedReviewerContext) {
    const scope = scopeFromRef(reviewRoundRef);
    return withProjectWriterLock(this, scope, () => {
      const loaded = safeReadDocument(this.fs, this.rootDir, scope);
      const located = recordFor(loaded.document, reviewRoundRef, candidateDigest(digest));
      const transition = submitTaskReviewReceipt(located.round, receipt, trustedReviewerContext);
      if (transition.outcome !== "idempotent") {
        const next = clone(loaded.document);
        next.records[located.key] = { round: clone(transition.round) };
        writeDocument(this, scope, next);
      }
      return cloneFreeze({ outcome: transition.outcome, view: ownReceiptProjection(transition.round, trustedReviewerContext) });
    });
  }

  readForTrustedReviewer(reviewRoundRef, digest, trustedReviewerContext) {
    const scope = scopeFromRef(reviewRoundRef);
    const loaded = safeReadDocument(this.fs, this.rootDir, scope);
    const located = recordFor(loaded.document, reviewRoundRef, candidateDigest(digest));
    return ownReceiptProjection(located.round, trustedReviewerContext);
  }

  readReleasedForReconciliation(reviewRoundRef, digest) {
    const scope = scopeFromRef(reviewRoundRef);
    const loaded = safeReadDocument(this.fs, this.rootDir, scope);
    const located = recordFor(loaded.document, reviewRoundRef, candidateDigest(digest));
    return reconciliationProjection(located.round);
  }

  readReleasedForDelivery(value) {
    const request = candidateRequest(value, "invalid_task_review_delivery_request");
    const scope = {
      installation_id: request.work_task_ref.installation_id,
      project_id: request.work_task_ref.project_id,
    };
    const loaded = safeReadDocument(this.fs, this.rootDir, scope);
    const matches = roundsForCandidate(loaded.document, request);
    if (matches.length === 0) fail("task_review_round_not_found", "no exact persisted review round exists");
    if (matches.length !== 1) fail("task_review_round_delivery_ambiguous", "multiple review rounds match one delivery task");
    return deliveryProjection(matches[0]);
  }

  // Head-private pre-release propagation stop (#1059).  It is derived from the
  // already-sealed receipt state, never persisted or projected separately, so
  // no reviewer read path can observe it.  It returns null when no current
  // round for the candidate carries a sealed propagating finding; the pure
  // contract redacts every receipt, verdict, role, and finding field.
  readSealedPropagationStop(value, trustedHeadContext) {
    const request = candidateRequest(value, "invalid_task_review_propagation_request");
    const scope = {
      installation_id: request.work_task_ref.installation_id,
      project_id: request.work_task_ref.project_id,
    };
    const loaded = safeReadDocument(this.fs, this.rootDir, scope);
    const matches = roundsForCandidate(loaded.document, request).filter((round) => round.status === "current");
    if (matches.length === 0) return null;
    if (matches.length !== 1) fail("task_review_round_propagation_ambiguous", "multiple current review rounds match one candidate");
    try { return cloneFreeze(planSealedTaskReviewPropagation(matches[0], trustedHeadContext)); }
    catch (error) {
      if (error && error.code === "task_review_round_no_propagation_stop") return null;
      throw error;
    }
  }

  // Server-internal, project-scoped listing of the rounds that are still
  // `current`.  It exists so the single project archive transition (#1070) can
  // find exactly the rounds it must cancel without any caller gaining a
  // generic round enumerator.  It projects round identity only -- never a
  // receipt, verdict, finding, reviewer role, or cancellation body -- and it
  // never lists a released or already-cancelled round, so a sealed terminal
  // record is never re-offered for mutation.
  listCurrentRoundAnchors(scope) {
    const owner = archiveScope(scope);
    const loaded = safeReadDocument(this.fs, this.rootDir, owner);
    return cloneFreeze(Object.values(loaded.document.records)
      .map((record) => record.round)
      .filter((round) => round.status === "current")
      .sort((left, right) => taskReviewRoundKey(left.review_round_ref).localeCompare(taskReviewRoundKey(right.review_round_ref)))
      .map((round) => ({ review_round_ref: clone(round.review_round_ref), candidate_digest: round.candidate_digest })));
  }

  cancelFromTrustedState(cancellation) {
    if (!plain(cancellation)) fail("invalid_task_review_cancellation", "trusted cancellation is invalid");
    const scope = scopeFromRef(cancellation.review_round_ref, "invalid_task_review_cancellation");
    return withProjectWriterLock(this, scope, () => {
      const loaded = safeReadDocument(this.fs, this.rootDir, scope);
      const located = recordFor(loaded.document, cancellation.review_round_ref, candidateDigest(cancellation.candidate_digest, "invalid_task_review_cancellation"));
      const nextRound = cancelTaskReviewRound(located.round, cancellation);
      if (nextRound.round_digest !== located.round.round_digest) {
        const next = clone(loaded.document);
        next.records[located.key] = { round: clone(nextRound) };
        writeDocument(this, scope, next);
      }
      return statusProjection(nextRound);
    });
  }
}

function createTaskReviewRoundStore(options) {
  return new TaskReviewRoundStore(options);
}

module.exports = {
  TASK_REVIEW_ROUND_STORE_VERSION,
  TASK_REVIEW_ROUND_STORE_DIRECTORY,
  TASK_REVIEW_ROUND_STORE_FILENAME_SUFFIX,
  MAX_ROUNDS_PER_PROJECT,
  MAX_DOCUMENT_BYTES,
  TaskReviewRoundStoreError,
  TaskReviewRoundStore,
  createTaskReviewRoundStore,
};
