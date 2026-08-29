"use strict";

const {
  HOOK_MARKER, REVIEW_REF_ROOT, ReviewError, managedReviewPath, normalizeRole,
  normalizeTaskId, readMetadata, refsFor,
} = require("./local-review-common");
const { installPrePushGuard, prepareReviewWorktree } = require("./local-review-worktree");
const { approveCandidate, createCandidate, reviewStatus } = require("./local-review-state");
const { assertExistingPrCanPublish, publishCandidate, readPr, verifyPublishedCandidate } = require("./local-review-publish");

function formatStatus(status) {
  const short = (sha) => sha ? sha.slice(0, 12) : "—";
  const approval = (role) => status.approvals[role] === status.candidateSha
    ? `approved ${short(status.approvals[role])}`
    : status.approvals[role]
      ? `STALE ${short(status.approvals[role])}`
      : "pending";
  return [
    `Local review gate #${status.task}`,
    `  Branch:    ${status.branch || "—"}`,
    `  Base:      ${status.base.ref || "—"} @ ${short(status.base.sha)}`,
    `  Candidate: ${short(status.candidateSha)}`,
    `  RE1:       ${approval("re1")}`,
    `  RE2:       ${approval("re2")}`,
    `  Published: ${short(status.publishedSha)}`,
    `  Ready:     ${status.readyToPublish ? "YES — publish once" : "NO"}`,
  ].join("\n");
}

function parseCliArgs(argv) {
  const positionals = [];
  const flags = {};
  const booleanFlags = new Set(["json", "draft", "no-pr", "dry-run", "skip-base-refresh", "in-place"]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (booleanFlags.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new ReviewError(`--${name} requires a value.`, "MISSING_FLAG_VALUE");
    }
    flags[name] = next;
    index++;
  }
  return { positionals, flags };
}

function reviewUsage() {
  return `Usage: quadwork review <command> <task> [options]\n\nCommands:\n  candidate <task> [--base origin/main] [--repo PATH]\n      Pin the clean Dev HEAD as a local candidate and invalidate old approvals.\n\n  checkout <task> --role re1|re2 [--in-place] [--repo PATH]\n      Check out the exact candidate. --in-place reuses the reviewer's configured worktree.\n\n  approve <task> --role re1|re2 [--sha SHA] [--summary TEXT] [--repo PATH]\n      Record an exact-SHA local approval. Run from the review worktree or pass --sha.\n\n  status <task> [--json] [--repo PATH]\n      Show candidate, base, approvals and publication state.\n\n  verify <task> [--pr NUMBER] [--json] [options]\n      Prove local approvals, published ref, remote branch, PR head/base, and non-draft state all match.\n      Options: --remote origin --base main --skip-base-refresh --repo PATH\n\n  publish <task> --title TITLE --body-file FILE [options]\n      After both approvals, refresh the base, push exactly once and create/find the PR.\n      Options: --remote origin --base main --draft --no-pr --dry-run\n               --skip-base-refresh --repo PATH\n`;
}

function runReviewCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const cwd = io.cwd || process.cwd();
  try {
    const { positionals, flags } = parseCliArgs(argv);
    const command = positionals[0];
    const task = positionals[1];
    if (!command || ["help", "-h", "--help"].includes(command)) {
      stdout.write(reviewUsage());
      return 0;
    }
    if (!task) throw new ReviewError(`Missing task ID.\n\n${reviewUsage()}`, "MISSING_TASK");
    const repo = flags.repo || cwd;

    if (command === "candidate") {
      const result = createCandidate({ repo, task, base: flags.base });
      stdout.write(`Candidate #${result.task}: ${result.candidateSha}\n`);
      stdout.write(`Base: ${result.base.ref} @ ${result.base.sha}\n`);
      stdout.write("Previous approvals were invalidated. Review locally; do not push this checkpoint.\n");
      if (result.guard.installed) stdout.write(`Push guard: active (${result.guard.path})\n`);
      else stderr.write(`Warning: push guard not installed — ${result.guard.reason}\n`);
      return 0;
    }

    if (command === "checkout") {
      const result = prepareReviewWorktree({ repo, task, role: flags.role, inPlace: flags["in-place"] });
      stdout.write(`${result.path}\n`);
      return 0;
    }

    if (command === "approve") {
      const result = approveCandidate({ repo, task, role: flags.role, sha: flags.sha, summary: flags.summary });
      stdout.write(`${result.role} approved candidate ${result.candidateSha}\n`);
      return 0;
    }

    if (command === "status") {
      const status = reviewStatus({ repo, task });
      stdout.write(flags.json ? `${JSON.stringify(status, null, 2)}\n` : `${formatStatus(status)}\n`);
      return 0;
    }

    if (command === "verify") {
      const result = verifyPublishedCandidate({
        repo, task, pr: flags.pr, remote: flags.remote, base: flags.base,
        skipBaseRefresh: flags["skip-base-refresh"],
      });
      stdout.write(flags.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `VERIFIED: PR #${result.pr.number} head ${result.candidateSha} matches both local approvals and ${result.remote}/${result.branch}\n`);
      return 0;
    }

    if (command === "publish") {
      const result = publishCandidate({
        repo,
        task,
        title: flags.title,
        bodyFile: flags["body-file"],
        remote: flags.remote,
        base: flags.base,
        draft: flags.draft,
        noPr: flags["no-pr"],
        dryRun: flags["dry-run"],
        skipBaseRefresh: flags["skip-base-refresh"],
      });
      if (result.dryRun) {
        stdout.write(`READY: ${result.candidateSha}\n`);
        stdout.write(`Push required: ${result.pushNeeded ? "yes" : "no"}\n`);
        return 0;
      }
      stdout.write(`Published ${result.candidateSha} to ${result.remote}/${result.branch}\n`);
      if (result.pr?.url) stdout.write(`PR: ${result.pr.url}\n`);
      return 0;
    }

    throw new ReviewError(`Unknown review command '${command}'.\n\n${reviewUsage()}`, "UNKNOWN_COMMAND");
  } catch (error) {
    const message = error instanceof ReviewError ? error.message : String(error.stack || error.message || error);
    stderr.write(`quadwork review: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runReviewCli(process.argv.slice(2));
}

module.exports = {
  HOOK_MARKER, REVIEW_REF_ROOT, ReviewError, approveCandidate, assertExistingPrCanPublish, createCandidate,
  formatStatus, installPrePushGuard, managedReviewPath, normalizeRole,
  normalizeTaskId, prepareReviewWorktree, publishCandidate, readMetadata, readPr,
  refsFor, reviewStatus, reviewUsage, runReviewCli, verifyPublishedCandidate,
};
