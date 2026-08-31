// #1031: shared, pure UI helpers for repository-qualified batch identity.
// Plain JS is intentional: the Next.js UI imports it through `allowJs`, while
// the plain-node test runner can require the same production implementation.

const OWNED_PROVENANCE = "owned";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function assignmentAttempt(value) {
  return nonEmptyString(value);
}

/**
 * Remote GitHub titles are data, never queue grammar or rendered markdown.
 * Collapse every line/control separator, then escape inline markdown tokens so
 * a title cannot add a checkbox, heading, link, image, or raw HTML element.
 */
function sanitizeRemoteTitle(value) {
  return String(value == null ? "" : value)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]{}()<>#+.!|])/g, "\\$1");
}

function workItemNumber(row) {
  if (positiveInteger(row && row.number)) return row.number;
  if (positiveInteger(row && row.issue_number)) return row.issue_number;
  if (positiveInteger(row && row.pr_number)) return row.pr_number;
  return null;
}

/** Return the only executable queue token accepted for a V2 work item. */
function qualifiedQueueToken(row) {
  const repo = nonEmptyString(row && row.repo);
  const number = workItemNumber(row);
  return repo && number ? `${repo}#${number}` : null;
}

function workItemRefToken(row) {
  const serialized = nonEmptyString(row && row.work_item_ref);
  const rowKind = row && row.kind === "pr" ? "pr" : row && row.kind === "issue" ? "issue" : "work";
  if (serialized) return `${serialized}:${rowKind}`;
  const ref = row && row.work_item_ref;
  if (ref && typeof ref === "object") {
    const repoKey = nonEmptyString(ref.repo_key);
    const repo = nonEmptyString(ref.repo);
    const number = positiveInteger(ref.number);
    const kind = ref.kind === "pr" ? "pr" : ref.kind === "issue" ? "issue" : null;
    if (repoKey && repo && number && kind) return `${repoKey}:${repo}#${number}:${kind}`;
  }
  const token = qualifiedQueueToken(row);
  return token ? `${token}:${rowKind}` : null;
}

function ownedWorkItemIdentityMatches(row) {
  if (!row || typeof row !== "object" || !row.work_item_ref || typeof row.work_item_ref !== "object") return false;
  const ref = row.work_item_ref;
  const rowRepoKey = nonEmptyString(row.repo_key);
  const rowRepo = nonEmptyString(row.repo);
  const rowNumber = positiveInteger(row.number);
  const rowKind = row.kind === "pr" ? "pr" : row.kind === "issue" ? "issue" : null;
  return !!rowRepoKey && !!rowRepo && !!rowNumber && !!rowKind &&
    nonEmptyString(ref.repo_key) === rowRepoKey &&
    nonEmptyString(ref.repo) === rowRepo &&
    positiveInteger(ref.number) === rowNumber &&
    ref.kind === rowKind;
}

/**
 * React keys retain every authority component as a separate segment. Missing
 * V2 provenance stays explicitly legacy/unowned; it is never inferred local.
 */
function workItemReactKey(row) {
  const provenance = nonEmptyString(row && row.provenance) || "legacy_unowned";
  const installationId = nonEmptyString(row && row.installation_id) || "-";
  const batchNumber = positiveInteger(row && row.batch_number) || "-";
  const attempt = assignmentAttempt(row && row.assignment_attempt) || "-";
  const assignmentKey = nonEmptyString(row && row.assignment_key) || "-";
  const repoKey = nonEmptyString(row && row.repo_key) || "-";
  const repo = nonEmptyString(row && row.repo) || "-";
  const ref = workItemRefToken(row) || "unknown";
  return [provenance, installationId, batchNumber, attempt, assignmentKey, repoKey, repo, ref]
    .map((part) => encodeURIComponent(String(part)))
    .join(":");
}

function workItemDisplayLabel(row, multiRepository) {
  const number = workItemNumber(row);
  const bare = number ? `#${number}` : "#—";
  if (!multiRepository) return bare;
  const repoKey = nonEmptyString(row && row.repo_key);
  return repoKey ? `[${repoKey}] ${bare}` : `[?] ${bare}`;
}

function assignmentIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const installationId = nonEmptyString(value.installation_id);
  const batchNumber = positiveInteger(value.batch_number);
  const attempt = assignmentAttempt(value.assignment_attempt);
  const assignmentKey = nonEmptyString(value.assignment_key);
  if (
    !installationId || !batchNumber || !attempt || !assignmentKey ||
    value.provenance !== OWNED_PROVENANCE || value.current !== true || value.owned !== true
  ) return null;
  return {
    installation_id: installationId,
    batch_number: batchNumber,
    assignment_attempt: attempt,
    provenance: OWNED_PROVENANCE,
    assignment_key: assignmentKey,
  };
}

function sameAssignment(left, right) {
  return !!left && !!right &&
    left.installation_id === right.installation_id &&
    left.batch_number === right.batch_number &&
    left.assignment_attempt === right.assignment_attempt &&
    left.provenance === right.provenance &&
    left.assignment_key === right.assignment_key;
}

/**
 * Join the two live endpoints fail-closed. A sticky progress payload, a
 * foreign/unowned assignment, or even one stale row cannot drive an automatic
 * trigger/bridge transition.
 */
function ownedCurrentBatchSnapshot(active, progress) {
  if (!active || typeof active.active !== "boolean" || !progress || !Array.isArray(progress.items)) return null;
  const activeIdentity = assignmentIdentity(active);
  const progressIdentity = assignmentIdentity(progress);
  if (!sameAssignment(activeIdentity, progressIdentity)) return null;
  const liveActiveBatchCleared = progress.liveActiveBatchCleared === true;
  if (progress.items.length === 0 && !liveActiveBatchCleared) return null;

  for (const row of progress.items) {
    const rowIdentity = assignmentIdentity(row);
    if (!sameAssignment(progressIdentity, rowIdentity)) return null;
    if (!ownedWorkItemIdentityMatches(row)) return null;
  }

  const fingerprint = [
    progressIdentity.installation_id,
    progressIdentity.batch_number,
    progressIdentity.assignment_attempt,
    progressIdentity.assignment_key,
  ].map((part) => encodeURIComponent(String(part))).join(":");

  return {
    fingerprint,
    active: active.active === true,
    complete: progress.complete === true,
    completeConfirmed: progress.completeConfirmed === true,
    liveActiveBatchCleared,
    hasItems: progress.items.length > 0,
    installation_id: progressIdentity.installation_id,
    batch_number: progressIdentity.batch_number,
    assignment_attempt: progressIdentity.assignment_attempt,
    provenance: progressIdentity.provenance,
    assignment_key: progressIdentity.assignment_key,
  };
}

function assignmentRequestFields(snapshot) {
  if (!snapshot) return {};
  return {
    installation_id: snapshot.installation_id,
    batch_number: snapshot.batch_number,
    assignment_attempt: snapshot.assignment_attempt,
    provenance: snapshot.provenance,
    assignment_key: snapshot.assignment_key,
  };
}

module.exports = {
  assignmentRequestFields,
  ownedCurrentBatchSnapshot,
  qualifiedQueueToken,
  sanitizeRemoteTitle,
  workItemDisplayLabel,
  workItemReactKey,
};
