"use strict";

const fs = require("fs");
const path = require("path");
const {
  ReviewError, assertClean, currentBranch, currentHead, exec, git, isAncestor,
  normalizeTaskId, readMetadata, refsFor, resolveCommit, resolveRepository,
  tryExec, tryGit, writeMetadata,
} = require("./local-review-common");
const { assertPublishReady, reviewStatus } = require("./local-review-state");

const PR_JSON_FIELDS = "number,url,headRefName,headRefOid,baseRefName,state,isDraft,mergeable,mergeStateStatus";

function readPr(repo, selector) {
  const result = tryExec("gh", ["pr", "view", String(selector), "--json", PR_JSON_FIELDS], { cwd: repo });
  if (!result.ok || !result.output) return null;
  try {
    const parsed = JSON.parse(result.output);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    throw new ReviewError(`GitHub returned invalid PR JSON: ${error.message}`, "INVALID_PR_JSON");
  }
}

function existingPrForBranch(repo, branch) {
  return readPr(repo, branch);
}

function assertExistingPrCanPublish(pr, status, expectedBase) {
  if (!pr) return null;
  if (String(pr.state || "").toUpperCase() !== "OPEN") {
    throw new ReviewError(`PR #${pr.number || "?"} is not open.`, "PR_NOT_OPEN");
  }
  if (pr.headRefName && status.branch && pr.headRefName !== status.branch) {
    throw new ReviewError(`PR #${pr.number} head branch '${pr.headRefName}' is not reviewed branch '${status.branch}'.`, "PR_BRANCH_MISMATCH");
  }
  if (expectedBase && pr.baseRefName && pr.baseRefName !== expectedBase) {
    throw new ReviewError(`PR #${pr.number} targets '${pr.baseRefName}', not reviewed base '${expectedBase}'.`, "PR_BASE_MISMATCH");
  }
  return pr;
}

function assertPrMatchesCandidate(pr, status, expectedBase, options = {}) {
  if (!pr) throw new ReviewError("No pull request exists for the published branch.", "PR_NOT_FOUND");
  if (String(pr.state || "").toUpperCase() !== "OPEN") {
    throw new ReviewError(`PR #${pr.number || "?"} is not open.`, "PR_NOT_OPEN");
  }
  if (pr.headRefName && status.branch && pr.headRefName !== status.branch) {
    throw new ReviewError(`PR #${pr.number} head branch '${pr.headRefName}' is not reviewed branch '${status.branch}'.`, "PR_BRANCH_MISMATCH");
  }
  if (String(pr.headRefOid || "").toLowerCase() !== status.candidateSha) {
    throw new ReviewError(
      `PR #${pr.number} head ${String(pr.headRefOid || "missing").slice(0, 12)} does not match approved candidate ${status.candidateSha.slice(0, 12)}.`,
      "PR_HEAD_MISMATCH"
    );
  }
  if (expectedBase && pr.baseRefName && pr.baseRefName !== expectedBase) {
    throw new ReviewError(`PR #${pr.number} targets '${pr.baseRefName}', not reviewed base '${expectedBase}'.`, "PR_BASE_MISMATCH");
  }
  if (options.requireReady && pr.isDraft) {
    throw new ReviewError(`PR #${pr.number} is still a draft and is not eligible for formal approval or merge.`, "PR_NOT_READY");
  }
  return pr;
}

function remoteBranchSha(repo, remote, branch) {
  const result = tryGit(repo, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
  if (!result.ok || !result.output) return null;
  const sha = result.output.split(/\s+/)[0];
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
}

function refreshAndAssertBase(repo, status, remote, skipBaseRefresh) {
  if (skipBaseRefresh || status.base.refreshable === false || !status.base.branch) return;
  const baseBranch = status.base.branch;
  git(repo, ["fetch", "--quiet", remote, baseBranch]);
  const remoteBase = resolveCommit(repo, `refs/remotes/${remote}/${baseBranch}`);
  if (remoteBase !== status.base.sha) {
    throw new ReviewError(
      `${remote}/${baseBranch} moved from ${status.base.sha.slice(0, 12)} to ${remoteBase.slice(0, 12)} after review. Rebase/merge the new base, run tests, create a new candidate, and obtain fresh approvals locally.`,
      "BASE_MOVED"
    );
  }
}

function verifyPublishedCandidate(options) {
  const repo = resolveRepository(options.repo || process.cwd());
  const task = normalizeTaskId(options.task);
  const status = assertPublishReady(repo, task);
  if (status.publishedSha !== status.candidateSha) {
    throw new ReviewError(
      `Candidate ${status.candidateSha.slice(0, 12)} has not been recorded as the published SHA. Run the validated publish command first.`,
      "NOT_PUBLISHED"
    );
  }
  if (!status.branch) throw new ReviewError(`Candidate #${task} has no reviewed branch name.`, "NO_BRANCH");

  const remote = options.remote || status.base.remote || "origin";
  const baseBranch = options.base || status.base.branch || "main";
  refreshAndAssertBase(repo, status, remote, Boolean(options.skipBaseRefresh));
  const remoteSha = remoteBranchSha(repo, remote, status.branch);
  if (remoteSha !== status.candidateSha) {
    throw new ReviewError(
      `${remote}/${status.branch} is ${remoteSha ? remoteSha.slice(0, 12) : "missing"}, not approved candidate ${status.candidateSha.slice(0, 12)}.`,
      "REMOTE_MISMATCH"
    );
  }
  if (!tryExec("gh", ["--version"], { cwd: repo }).ok) {
    throw new ReviewError("GitHub CLI (gh) is required to verify the remote PR.", "GH_REQUIRED");
  }
  const selector = options.pr || status.publication?.pr?.number || status.branch;
  const pr = assertPrMatchesCandidate(readPr(repo, selector), status, baseBranch, { requireReady: true });
  return { repo, task, remote, baseBranch, candidateSha: status.candidateSha, branch: status.branch, pr };
}

function publishCandidate(options) {
  const repo = resolveRepository(options.repo || process.cwd());
  const task = normalizeTaskId(options.task);
  assertClean(repo);
  let status = assertPublishReady(repo, task);
  const head = currentHead(repo);
  const branch = currentBranch(repo);
  if (head !== status.candidateSha) {
    throw new ReviewError(
      `Current HEAD ${head.slice(0, 12)} is not candidate ${status.candidateSha.slice(0, 12)}. Publish from the Dev worktree at the approved candidate.`,
      "HEAD_MISMATCH"
    );
  }
  if (status.branch && branch !== status.branch) {
    throw new ReviewError(`Current branch '${branch}' is not reviewed branch '${status.branch}'.`, "BRANCH_MISMATCH");
  }

  const remote = options.remote || status.base.remote || "origin";
  const baseBranch = options.base || status.base.branch || "main";
  refreshAndAssertBase(repo, status, remote, Boolean(options.skipBaseRefresh));
  if (!isAncestor(repo, status.base.sha, status.candidateSha)) {
    throw new ReviewError("The pinned base is no longer an ancestor of the candidate.", "BASE_NOT_ANCESTOR");
  }

  const noPr = Boolean(options.noPr);
  let existingPr = null;
  if (!noPr) {
    if (!tryExec("gh", ["--version"], { cwd: repo }).ok) {
      throw new ReviewError("GitHub CLI (gh) is required to create or find the final PR. Use --no-pr only for an intentional manual PR flow.", "GH_REQUIRED");
    }
    existingPr = assertExistingPrCanPublish(existingPrForBranch(repo, branch), status, baseBranch);
    if (!existingPr && (!String(options.title || "").trim() || !options.bodyFile)) {
      throw new ReviewError("A new PR requires both a non-empty --title and --body-file. Validation happens before the branch is pushed.", "PR_DETAILS_REQUIRED");
    }
    if (options.bodyFile) {
      const bodyPath = path.resolve(options.bodyFile);
      if (!fs.existsSync(bodyPath)) {
        throw new ReviewError(`PR body file does not exist: ${options.bodyFile}`, "BODY_FILE_MISSING");
      }
      if (!fs.readFileSync(bodyPath, "utf8").trim()) {
        throw new ReviewError(`PR body file is empty: ${options.bodyFile}`, "BODY_FILE_EMPTY");
      }
    }
  }

  const beforeRemoteSha = remoteBranchSha(repo, remote, branch);
  const pushNeeded = beforeRemoteSha !== status.candidateSha;
  if (options.dryRun) {
    return {
      repo, task, branch, candidateSha: status.candidateSha, remote, baseBranch,
      pushNeeded, existingPr, dryRun: true, readyToPublish: true,
    };
  }

  if (pushNeeded) {
    const env = { ...process.env, QUADWORK_REVIEW_PUBLISH: "1" };
    exec("git", ["-C", repo, "push", "-u", remote, `${branch}:refs/heads/${branch}`], { env, timeout: 300000 });
  }

  const pushedRemoteSha = remoteBranchSha(repo, remote, branch);
  if (pushedRemoteSha !== status.candidateSha) {
    throw new ReviewError(
      `Remote branch verification failed: ${remote}/${branch} is ${pushedRemoteSha ? pushedRemoteSha.slice(0, 12) : "missing"}, expected ${status.candidateSha.slice(0, 12)}.`,
      "REMOTE_MISMATCH"
    );
  }

  let pr = existingPr;
  if (!noPr && !pr) {
    const args = [
      "pr", "create",
      "--head", branch,
      "--base", baseBranch,
      "--title", options.title,
      "--body-file", path.resolve(options.bodyFile),
    ];
    if (options.draft) args.push("--draft");
    const url = exec("gh", args, { cwd: repo, timeout: 120000 }).split("\n").pop().trim();
    const numberMatch = url.match(/\/pull\/(\d+)(?:\/)?$/);
    pr = readPr(repo, numberMatch ? Number(numberMatch[1]) : branch);
  } else if (!noPr) {
    pr = readPr(repo, pr.number || branch);
  }
  if (!noPr) pr = assertPrMatchesCandidate(pr, status, baseBranch);

  git(repo, ["update-ref", refsFor(task).published, status.candidateSha]);
  const metadata = readMetadata(repo, task);
  const now = new Date().toISOString();
  metadata.publication = {
    sha: status.candidateSha,
    branch,
    remote,
    pushed: pushNeeded,
    pushedAt: now,
    pr: pr ? { number: pr.number, url: pr.url } : null,
  };
  metadata.updatedAt = now;
  writeMetadata(repo, task, metadata);
  status = reviewStatus({ repo, task });
  return {
    repo, task, branch, candidateSha: status.candidateSha, remote, baseBranch,
    pushNeeded, pr, dryRun: false, readyToPublish: true, publication: status.publication,
  };
}

module.exports = {
  assertExistingPrCanPublish, assertPrMatchesCandidate, existingPrForBranch, publishCandidate, readPr,
  refreshAndAssertBase, remoteBranchSha, verifyPublishedCandidate,
};
