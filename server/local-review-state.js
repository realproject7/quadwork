"use strict";

const {
  STATE_VERSION, REVIEW_ROLES, ReviewError, assertClean, baseDescriptor,
  currentBranch, currentHead, detectDefaultBase, git, isAncestor, normalizeRole,
  normalizeTaskId, readMetadata, readRef, refsFor, resolveCommit,
  resolveRepository, updateRefsTransaction, writeMetadata,
} = require("./local-review-common");
const { installPrePushGuard } = require("./local-review-worktree");

function createCandidate(options) {
  const repo = resolveRepository(options.repo || process.cwd());
  const task = normalizeTaskId(options.task);
  assertClean(repo);
  const branch = currentBranch(repo);
  if (["main", "master"].includes(branch)) {
    throw new ReviewError(`Refusing to create a review candidate from protected branch '${branch}'.`, "PROTECTED_BRANCH");
  }
  const candidateSha = currentHead(repo);
  const chosenBase = options.base || detectDefaultBase(repo);
  const baseSha = resolveCommit(repo, chosenBase);
  if (!isAncestor(repo, baseSha, candidateSha)) {
    throw new ReviewError(
      `Base ${chosenBase} (${baseSha.slice(0, 12)}) is not an ancestor of candidate ${candidateSha.slice(0, 12)}. Rebase onto the intended base first.`,
      "BASE_NOT_ANCESTOR"
    );
  }

  const refs = refsFor(task);
  updateRefsTransaction(repo, [
    `update ${refs.candidate} ${candidateSha}`,
    `update ${refs.base} ${baseSha}`,
    `delete ${refs.re1}`,
    `delete ${refs.re2}`,
    `delete ${refs.published}`,
  ]);

  const now = new Date().toISOString();
  const previous = readMetadata(repo, task);
  const descriptor = baseDescriptor(chosenBase);
  const metadata = {
    version: STATE_VERSION,
    task,
    repository: repo,
    branch,
    candidateSha,
    base: {
      ref: chosenBase,
      sha: baseSha,
      remote: descriptor.remote,
      branch: descriptor.branch,
      refreshable: descriptor.refreshable,
    },
    approvals: {},
    publication: null,
    createdAt: previous.createdAt || now,
    candidateAt: now,
    updatedAt: now,
  };
  writeMetadata(repo, task, metadata);
  const guard = installPrePushGuard(repo);
  return { ...metadata, guard };
}

function approveCandidate(options) {
  const repo = resolveRepository(options.repo || process.cwd());
  const task = normalizeTaskId(options.task);
  const role = normalizeRole(options.role);
  const refs = refsFor(task);
  const candidateSha = readRef(repo, refs.candidate);
  if (!candidateSha) throw new ReviewError(`No local review candidate exists for #${task}.`, "NO_CANDIDATE");

  const attestedSha = resolveCommit(repo, options.sha || "HEAD");
  if (attestedSha !== candidateSha) {
    throw new ReviewError(
      `${role} attempted to approve ${attestedSha.slice(0, 12)}, but the current candidate is ${candidateSha.slice(0, 12)}. Refresh the review worktree and review the exact candidate.`,
      "STALE_APPROVAL"
    );
  }

  git(repo, ["update-ref", refs[role], candidateSha]);
  const metadata = readMetadata(repo, task);
  const now = new Date().toISOString();
  metadata.version = STATE_VERSION;
  metadata.task = task;
  metadata.candidateSha = candidateSha;
  metadata.approvals = metadata.approvals || {};
  metadata.approvals[role] = {
    sha: candidateSha,
    approvedAt: now,
    summary: String(options.summary || "").trim().slice(0, 2000),
  };
  metadata.updatedAt = now;
  writeMetadata(repo, task, metadata);
  return { repo, task, role, candidateSha, approvedAt: now };
}

function reviewStatus(options) {
  const repo = resolveRepository(options.repo || process.cwd());
  const task = normalizeTaskId(options.task);
  const refs = refsFor(task);
  const metadata = readMetadata(repo, task);
  const candidateSha = readRef(repo, refs.candidate);
  const baseSha = readRef(repo, refs.base);
  const approvals = {
    re1: readRef(repo, refs.re1),
    re2: readRef(repo, refs.re2),
  };
  const publishedSha = readRef(repo, refs.published);
  const ready = Boolean(candidateSha && baseSha && approvals.re1 === candidateSha && approvals.re2 === candidateSha);
  return {
    version: STATE_VERSION,
    repo,
    task,
    branch: metadata.branch || null,
    candidateSha,
    base: {
      ref: metadata.base?.ref || null,
      sha: baseSha,
      remote: metadata.base?.remote || null,
      branch: metadata.base?.branch || null,
      refreshable: metadata.base?.refreshable !== false,
    },
    approvals,
    approvalMetadata: metadata.approvals || {},
    publishedSha,
    publication: metadata.publication || null,
    readyToPublish: ready,
  };
}

function assertPublishReady(repo, task) {
  const status = reviewStatus({ repo, task });
  if (!status.candidateSha) throw new ReviewError(`No local review candidate exists for #${task}.`, "NO_CANDIDATE");
  if (!status.base.sha) throw new ReviewError(`Candidate #${task} has no pinned base commit. Re-create it.`, "NO_BASE");
  for (const role of REVIEW_ROLES) {
    if (status.approvals[role] !== status.candidateSha) {
      throw new ReviewError(
        `${role} has not approved candidate ${status.candidateSha.slice(0, 12)}. Both exact-SHA approvals are required before any push.`,
        "MISSING_APPROVAL"
      );
    }
  }
  return status;
}

module.exports = { approveCandidate, assertPublishReady, createCandidate, reviewStatus };
