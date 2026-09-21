"use strict";

// #1161: ticket review starts before a WorkTask manifest exists.  This small,
// server-owned control is intentionally separate from the manifest domain: it
// can establish exactly one owned review assignment, but it cannot edit an
// existing assignment, add a second issue, select a path, or create Dev work.

const path = require("node:path");

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, fields) {
  if (!plain(value)) throw new TypeError("ticket-review admission options must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new TypeError("ticket-review admission options have unknown or missing fields");
  }
}

function detail({ applied, code, repository_key = null, issue = null, batch = null, attempt = null, idempotent = false }) {
  return Object.freeze({ applied, code, repository_key, issue, batch, attempt, idempotent });
}

function activeSpan(queueText) {
  const newline = queueText.includes("\r\n") ? "\r\n" : "\n";
  const lines = queueText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##[ \t]+Active Batch[ \t]*$/i.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##[ \t]+\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { lines, newline, start, end };
}

function emptyActiveBatch(span) {
  const body = span.lines.slice(span.start + 1, span.end).filter((line) => line.trim() !== "");
  // The seeded template has one explanatory no-active-batch line.  Requiring
  // exactly that shape prevents Head from overwriting any active, incomplete,
  // foreign, or manually reconstructed queue state.
  return body.length === 1 && /^\(no active batch(?: yet)?\s*[—-].*\)$/i.test(body[0].trim());
}

function nextBatchNumber(queueText) {
  // Ignore the Rules section, whose illustrative grammar contains Batch: 1.
  const rules = queueText.search(/^##[ \t]+Rules[ \t]*$/im);
  const candidate = rules >= 0 ? queueText.slice(0, rules) : queueText;
  let highest = 0;
  for (const match of candidate.matchAll(/^\s*\*\*Batch:\*\*\s*(\d+)\s*$/gim)) {
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1 || number >= Number.MAX_SAFE_INTEGER) return null;
    highest = Math.max(highest, number);
  }
  return highest + 1;
}

function sameOwnedTicketReview(context, repositoryKey, issue) {
  const items = context?.parsed?.workItems;
  const item = Array.isArray(items) && items.length === 1 ? (items[0].ref || items[0]) : null;
  return context?.batchType === "ticket-review" && context?.parsed?.provenance === "owned" &&
    context?.parsed?.errors?.length === 0 && Number.isSafeInteger(context?.parsed?.batchNumber) &&
    typeof context?.parsed?.assignmentAttempt === "string" && item?.repoKey === repositoryKey &&
    item.number === issue && item.kind === "issue";
}

function createHeadTicketReviewAdmission(options) {
  exact(options, ["config_dir", "read_config", "read_live_batch_context", "write_secure_file", "random_id"]);
  if (typeof options.config_dir !== "string" || !options.config_dir ||
      typeof options.read_config !== "function" || typeof options.read_live_batch_context !== "function" ||
      typeof options.write_secure_file !== "function" || typeof options.random_id !== "function") {
    throw new TypeError("ticket-review admission dependencies are invalid");
  }

  return Object.freeze({
    begin({ project_id, ticket_review }) {
      if (typeof project_id !== "string" || !PROJECT_RE.test(project_id) || !plain(ticket_review) ||
          Object.keys(ticket_review).length !== 2 || typeof ticket_review.repository_key !== "string" ||
          !REPOSITORY_KEY_RE.test(ticket_review.repository_key) || !Number.isSafeInteger(ticket_review.issue) ||
          ticket_review.issue < 1) {
        return detail({ applied: false, code: "ticket_review_request_invalid" });
      }
      const repository_key = ticket_review.repository_key;
      const issue = ticket_review.issue;
      let context;
      let config;
      try {
        context = options.read_live_batch_context(project_id);
        config = options.read_config();
      } catch {
        return detail({ applied: false, code: "ticket_review_context_unavailable", repository_key, issue });
      }
      const project = plain(config) && Array.isArray(config.projects)
        ? config.projects.find((entry) => plain(entry) && entry.id === project_id && entry.archived !== true)
        : null;
      if (!project || !context || context.project?.id !== project_id || context.cfg?.installation_id !== config.installation_id ||
          typeof config.installation_id !== "string" || !config.installation_id) {
        return detail({ applied: false, code: "ticket_review_project_unavailable", repository_key, issue });
      }
      const binding = Array.isArray(context.repositories)
        ? context.repositories.find((entry) => plain(entry) && entry.key === repository_key && typeof entry.repo === "string" && entry.repo)
        : null;
      if (!binding) return detail({ applied: false, code: "ticket_review_repository_unregistered", repository_key, issue });

      // This is the durable idempotency predicate: after a process restart a
      // retried request for the same sole ticket returns the existing server-
      // owned assignment without a queue rewrite.  It never treats a broader
      // or different active batch as a retry.
      if (sameOwnedTicketReview(context, repository_key, issue)) {
        return detail({ applied: true, code: "ticket_review_already_started", repository_key, issue,
          batch: context.parsed.batchNumber, attempt: context.parsed.assignmentAttempt, idempotent: true });
      }
      if (context.queueReadOk !== true) return detail({ applied: false, code: "ticket_review_queue_missing", repository_key, issue });
      if (context.parsed?.errors?.length || context.parsed?.workItems?.length || context.parsed?.batchNumber !== null ||
          context.batchType !== "code") {
        return detail({ applied: false, code: "ticket_review_active_batch_present", repository_key, issue });
      }
      const span = activeSpan(context.queueText);
      if (!span || !emptyActiveBatch(span)) {
        return detail({ applied: false, code: "ticket_review_queue_not_empty", repository_key, issue });
      }
      const batch = nextBatchNumber(context.queueText);
      const entropy = options.random_id();
      const attempt = typeof entropy === "string" ? `ticket_review_${entropy.replace(/-/g, "")}` : "";
      if (!Number.isSafeInteger(batch) || batch < 1 || !ATTEMPT_RE.test(attempt)) {
        return detail({ applied: false, code: "ticket_review_admission_unavailable", repository_key, issue });
      }
      const replacement = [
        "## Active Batch",
        "",
        `**Batch:** ${batch}`,
        "**Batch type:** ticket-review",
        `**Installation:** ${config.installation_id}`,
        `**Assignment attempt:** ${attempt}`,
        `- ${binding.repo}#${issue} — queued`,
      ];
      span.lines.splice(span.start, span.end - span.start, ...replacement);
      try {
        options.write_secure_file(path.join(options.config_dir, project_id, "OVERNIGHT-QUEUE.md"), span.lines.join(span.newline));
      } catch {
        return detail({ applied: false, code: "ticket_review_queue_write_failed", repository_key, issue });
      }
      return detail({ applied: true, code: "ticket_review_started", repository_key, issue, batch, attempt });
    },
  });
}

module.exports = { createHeadTicketReviewAdmission };
