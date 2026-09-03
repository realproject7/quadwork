"use strict";

const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const PROJECT_ROLES = new Set(["head", "dev", "re1", "re2"]);
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;

class IssueContractRevisionError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "IssueContractRevisionError";
    this.code = code;
    this.status = status;
  }
}

function revisionError(code, message, status) {
  return new IssueContractRevisionError(code, message, status);
}

function canonicalRepository(repo) {
  return typeof repo === "string" && REPOSITORY_RE.test(repo)
    ? repo.toLowerCase()
    : null;
}

/**
 * Canonical issue-body bytes for #1033.
 *
 * This intentionally performs only newline normalization plus terminal-LF-run
 * canonicalization. In particular, it does not trim spaces/tabs or normalize
 * Unicode, because either operation would collapse contract-significant text.
 */
function canonicalIssueContractBody(body) {
  if (body === null) return "";
  if (typeof body !== "string") {
    throw revisionError("issue_contract_source_mismatch", "GitHub issue body is invalid");
  }
  if (body === "") return "";
  const normalized = body.replace(/\r\n?/g, "\n");
  return `${normalized.replace(/\n+$/g, "")}\n`;
}

function issueContractRevision(body) {
  return crypto
    .createHash("sha256")
    .update(canonicalIssueContractBody(body), "utf8")
    .digest("hex");
}

async function authenticatedGithubIssueGet(repo, issue) {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["api", "--method", "GET", `/repos/${repo}/issues/${issue}`],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch {
    throw revisionError("issue_contract_read_failed", "Could not read the live GitHub issue contract");
  }
}

function repositoryFromApiUrl(repositoryUrl) {
  if (typeof repositoryUrl !== "string") return null;
  const match = /\/repos\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/?$/.exec(repositoryUrl);
  return match ? canonicalRepository(match[1]) : null;
}

async function fetchIssueContractRevision({ repo, issue, requestIssue = authenticatedGithubIssueGet, now = () => new Date() }) {
  const canonicalRepo = canonicalRepository(repo);
  if (!canonicalRepo) {
    throw revisionError("invalid_issue_contract_target", "Registered repository is invalid", 400);
  }
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw revisionError("invalid_issue_contract_target", "Issue number is invalid", 400);
  }

  let payload;
  try {
    payload = await requestIssue(canonicalRepo, issue);
  } catch (error) {
    if (error instanceof IssueContractRevisionError) throw error;
    throw revisionError("issue_contract_read_failed", "Could not read the live GitHub issue contract");
  }
  const sourceRepo = repositoryFromApiUrl(payload?.repository_url);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.number !== issue || sourceRepo !== canonicalRepo ||
      Object.prototype.hasOwnProperty.call(payload, "pull_request") ||
      !(payload.body === null || typeof payload.body === "string")) {
    throw revisionError("issue_contract_source_mismatch", "Live GitHub issue did not match the requested contract target");
  }

  const observed = now();
  const observedAt = observed instanceof Date ? observed.toISOString() : new Date(observed).toISOString();
  return Object.freeze({
    repo: canonicalRepo,
    issue,
    contract_revision: issueContractRevision(payload.body),
    observed_at: observedAt,
    source: "github_authenticated_rest",
    source_status: "ok",
  });
}

function exactRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  return keys.length === 2 && keys[0] === "issue" && keys[1] === "repo_key";
}

function validRevisionResult(revision, observed) {
  return !!revision && typeof revision === "object" && !Array.isArray(revision) &&
    revision.repo === canonicalRepository(observed.repo) &&
    revision.issue === observed.issue &&
    /^[a-f0-9]{64}$/.test(revision.contract_revision) &&
    typeof revision.observed_at === "string" && !Number.isNaN(Date.parse(revision.observed_at)) &&
    revision.source === "github_authenticated_rest" && revision.source_status === "ok";
}

function createIssueContractRevisionHandler(options = {}) {
  const resolveShimPrincipal = options.resolveShimPrincipal;
  const captureAdmission = options.captureProjectAdmission;
  const admissionCurrent = options.isAdmissionCurrent;
  const resolveRegisteredIssue = options.resolveRegisteredIssue;
  const fetchRevision = options.fetchRevision || fetchIssueContractRevision;
  if (typeof resolveShimPrincipal !== "function" || typeof captureAdmission !== "function" ||
      typeof admissionCurrent !== "function" || typeof resolveRegisteredIssue !== "function") {
    throw new TypeError("issue contract handler dependencies are required");
  }

  return async function issueContractRevisionHandler(req, res) {
    const principal = resolveShimPrincipal(req.headers["x-chat-token"]);
    if (!principal || !PROJECT_ROLES.has(principal.agentId)) {
      return res.status(403).json({ ok: false, code: "issue_contract_forbidden", source_status: "failed" });
    }
    const claimedActor = req.headers["x-chat-sender"];
    if ((claimedActor !== undefined && claimedActor !== principal.agentId) ||
        Object.keys(req.query || {}).length > 0 || !exactRequestBody(req.body)) {
      return res.status(400).json({ ok: false, code: "invalid_issue_contract_request", source_status: "failed" });
    }

    const repoKey = req.body.repo_key;
    const issue = req.body.issue;
    if (typeof repoKey !== "string" || !REPOSITORY_KEY_RE.test(repoKey) ||
        !Number.isSafeInteger(issue) || issue < 1) {
      return res.status(400).json({ ok: false, code: "invalid_issue_contract_target", source_status: "failed" });
    }

    let admission;
    let observed;
    try {
      admission = captureAdmission(principal.projectId);
      observed = resolveRegisteredIssue(principal.projectId, repoKey, issue);
    } catch {
      return res.status(503).json({ ok: false, code: "issue_contract_project_unavailable", source_status: "failed" });
    }
    if (!admissionCurrent(admission)) {
      return res.status(409).json({ ok: false, code: "issue_contract_admission_changed", source_status: "failed" });
    }
    if (!observed || canonicalRepository(observed.repo) === null || observed.issue !== issue ||
        typeof observed.fingerprint !== "string" || !observed.fingerprint) {
      return res.status(403).json({ ok: false, code: "issue_contract_target_forbidden", source_status: "failed" });
    }

    try {
      const revision = await fetchRevision({ repo: observed.repo, issue });
      if (!validRevisionResult(revision, observed)) {
        throw revisionError("issue_contract_source_mismatch", "Issue revision result did not match the registered target");
      }
      if (!admissionCurrent(admission)) {
        return res.status(409).json({ ok: false, code: "issue_contract_admission_changed", source_status: "failed" });
      }
      let current;
      try {
        current = resolveRegisteredIssue(principal.projectId, repoKey, issue);
      } catch {
        current = null;
      }
      if (!current || canonicalRepository(current.repo) !== canonicalRepository(observed.repo) ||
          current.issue !== observed.issue || current.fingerprint !== observed.fingerprint ||
          !admissionCurrent(admission)) {
        return res.status(409).json({ ok: false, code: "issue_contract_target_changed", source_status: "failed" });
      }
      return res.json({
        ok: true,
        repo_key: repoKey,
        repo: revision.repo,
        issue: revision.issue,
        contract_revision: revision.contract_revision,
        observed_at: revision.observed_at,
        source: revision.source,
        source_status: revision.source_status,
      });
    } catch (error) {
      const status = error instanceof IssueContractRevisionError ? error.status : 502;
      const code = error instanceof IssueContractRevisionError ? error.code : "issue_contract_read_failed";
      return res.status(status).json({ ok: false, code, source_status: "failed" });
    }
  };
}

module.exports = {
  PROJECT_ROLES,
  IssueContractRevisionError,
  canonicalIssueContractBody,
  issueContractRevision,
  fetchIssueContractRevision,
  createIssueContractRevisionHandler,
};
