"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  renderProjectGithubMarkdown,
  parseProjectGithubMarkdown,
  extractGithubNotes,
} = require("./github-state-markdown");

const NOW = Date.parse("2026-08-31T00:00:00.000Z");

function issue(number, title, repo) {
  return {
    number,
    title,
    state: "OPEN",
    url: `https://github.com/${repo}/issues/${number}`,
    assignees: [{ login: "alice" }],
  };
}

function pr(number, title, repo, role) {
  return {
    number,
    title,
    state: "OPEN",
    url: `https://github.com/${repo}/pull/${number}`,
    assignees: [],
    reviews: [{
      state: "APPROVED",
      submittedAt: "2026-08-31T01:02:03Z",
      body: `${role}: APPROVE`,
    }],
  };
}

function repositoryState(repoKey, repo, primary, options = {}) {
  return {
    repo_key: repoKey,
    repo,
    primary,
    snapshot: {
      issues: options.issues || [],
      prs: options.prs || [],
      closedIssues: options.closedIssues || [],
      mergedPrs: options.mergedPrs || [],
    },
    meta: options.meta || { generatedAt: NOW, staleCycles: 0 },
  };
}

function expectParseFailure(markdown, code) {
  const parsed = parseProjectGithubMarkdown(markdown);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, code);
}

// Two repositories preserve config order, attach identity to every row, and
// distinguish the same issue/PR number without a bare-number collision.
{
  const states = [
    repositoryState("web", "Owner/Product-Web", true, {
      issues: [issue(42, "web issue", "Owner/Product-Web")],
      prs: [pr(42, "web pr", "Owner/Product-Web", "RE1")],
    }),
    repositoryState("api", "Owner/Product-Api", false, {
      issues: [issue(42, "api issue", "Owner/Product-Api")],
      prs: [pr(42, "api pr", "Owner/Product-Api", "RE2")],
      meta: { generatedAt: NOW - 60_000, staleCycles: 2, stale: true },
    }),
  ];
  const notes = "Decision log\n## Plan\n- preserve this heading";
  const markdown = renderProjectGithubMarkdown("Product", states, notes);
  const parsed = parseProjectGithubMarkdown(markdown);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, "v2");
  assert.deepEqual(parsed.repositories.map((repository) => repository.repo_key), ["web", "api"]);
  assert.deepEqual(parsed.openIssues.map((row) => `${row.repo_key}:${row.repo}#${row.number}`), [
    "web:Owner/Product-Web#42",
    "api:Owner/Product-Api#42",
  ]);
  assert.deepEqual(parsed.openPRs.map((row) => `${row.repo_key}#${row.number}`), ["web#42", "api#42"]);
  assert.equal(parsed.reviewDetail["web#42"].repo, "Owner/Product-Web");
  assert.equal(parsed.reviewDetail["web#42"].re1.state, "APPROVED");
  assert.equal(parsed.reviewDetail["api#42"].re2.state, "APPROVED");
  assert.equal(parsed.repositories[0].stale, false);
  assert.equal(parsed.repositories[1].stale, true);
  assert.equal(parsed.repositories[1].staleCycles, 2);
  assert.equal(parsed.notes, notes);
  assert.equal(extractGithubNotes(markdown), notes);
}

// Renderer validation is fail-closed before it can produce ambiguous groups.
{
  assert.throws(
    () => renderProjectGithubMarkdown("P", [
      repositoryState("web", "Owner/Web", true),
      repositoryState("web", "Owner/Api", false),
    ], "n"),
    (error) => error && error.code === "duplicate_repository_key",
  );
  assert.throws(
    () => renderProjectGithubMarkdown("P", [
      repositoryState("web", "Owner/Web", true),
      repositoryState("api", "owner/WEB", false),
    ], "n"),
    (error) => error && error.code === "duplicate_repository",
  );
  assert.throws(
    () => renderProjectGithubMarkdown("P", [
      repositoryState("web", "Owner/Web", false),
      repositoryState("api", "Owner/Api", false),
    ], "n"),
    (error) => error && error.code === "invalid_primary_repository_count",
  );
  assert.throws(
    () => renderProjectGithubMarkdown("P", [
      repositoryState("web", "Owner/Web", true, { issues: [issue(1, "a", "Owner/Web"), issue(1, "b", "Owner/Web")] }),
    ], "n"),
    (error) => error && error.code === "duplicate_github_item",
  );
}

// Parser independently rejects duplicated identities, missing machine sections,
// malformed list rows, and review rows that are not scoped to a PR in the group.
{
  const markdown = renderProjectGithubMarkdown("P", [
    repositoryState("web", "Owner/Web", true, { prs: [pr(7, "p", "Owner/Web", "RE1")] }),
    repositoryState("api", "Owner/Api", false),
  ], "n");
  expectParseFailure(markdown.replace("## Repository: api", "## Repository: web"), "duplicate_repository_key");
  expectParseFailure(markdown.replace("Owner/Api", "owner/WEB"), "duplicate_repository");
  expectParseFailure(markdown.replace("### Recently Closed Issues", "### Closed"), "malformed_repository_group");
  expectParseFailure(markdown.replace("- [#7]", "* [#7]"), "malformed_github_item");
  expectParseFailure(markdown.replace("- #7 · re1:APPROVED", "- #99 · re1:APPROVED"), "orphan_review_detail");
  expectParseFailure(markdown.replace("staleCycles: 0 · stale: false", "staleCycles: 1 · stale: false"), "malformed_repository_group");
}

// Remote titles/project labels cannot create a Notes or repository boundary.
// Operator Notes remain opaque and may contain their own headings and marker-like
// text without being parsed as machine state.
{
  const hostileTitle = "hello\n## Notes\nSTOLEN\n<!-- quadwork-repository:start --> · [x] <script>";
  const notes = [
    "Operator-owned",
    "## Repository: fake",
    "<!-- quadwork-repository:start -->",
    "## Risks",
    "- keep this exactly",
  ].join("\n");
  const markdown = renderProjectGithubMarkdown("P\n## Notes\nBAD", [
    repositoryState("web", "Owner/Web", true, { issues: [issue(1, hostileTitle, "Owner/Web")] }),
  ], notes);
  const parsed = parseProjectGithubMarkdown(markdown);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repositories.length, 1);
  assert.equal(parsed.openIssues.length, 1);
  assert.equal(parsed.openIssues[0].title.includes("\n"), false);
  assert.equal(parsed.openIssues[0].title.includes("<script>"), false);
  assert.equal(parsed.notes, notes);
  assert.equal(extractGithubNotes(markdown), notes);
}

// Existing one-repository documents remain readable as a primary projection.
{
  const legacy = [
    "# Legacy — GitHub State",
    "",
    "> **Repo:** Owner/Legacy",
    "> **Generated:** 2026-08-31T00:00:00.000Z · staleCycles: 0 · stale: false",
    "",
    "## Open Issues",
    "",
    "- [#42](https://github.com/Owner/Legacy/issues/42) · OPEN · [@alice] · legacy issue",
    "- [#43](https://github.com/Owner/Legacy/issues/43) · OPEN · [] · second legacy issue",
    "",
    "---",
    "",
    "## Open PRs",
    "",
    "- [#42](https://github.com/Owner/Legacy/pull/42) · OPEN · [] · legacy pr",
    "",
    "---",
    "",
    "## Recently Closed Issues",
    "",
    "(none)",
    "",
    "---",
    "",
    "## Recently Merged PRs",
    "",
    "(none)",
    "",
    "---",
    "",
    "## Review Detail",
    "",
    "- #42 · re1:APPROVED · 2026-08-31T01:02:03Z",
    "",
    "---",
    "",
    "## Notes",
    "",
    "Legacy note\n## Keep\nthis",
    "",
  ].join("\n");
  const parsed = parseProjectGithubMarkdown(legacy);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, "legacy");
  assert.equal(parsed.repositories[0].repo_key, "primary");
  assert.equal(parsed.repositories[0].primary, true);
  assert.equal(parsed.openIssues[0].repo, "Owner/Legacy");
  assert.equal(parsed.openIssues[1].number, 43);
  assert.equal(parsed.openPRs[0].repo_key, "primary");
  assert.equal(parsed.reviewDetail["primary#42"].number, 42);
  assert.equal(parsed.reviewDetail[42].re1.state, "APPROVED");
  assert.equal(parsed.generatedAt, "2026-08-31T00:00:00.000Z");
  assert.equal(parsed.stale, false);
  assert.equal(parsed.notes, "Legacy note\n## Keep\nthis");
}

// The production module stays pure: it has no filesystem import or API use.
{
  const source = fs.readFileSync(path.join(__dirname, "github-state-markdown.js"), "utf8");
  assert.equal(/require\(["'](?:node:)?fs["']\)/.test(source), false);
  assert.equal(/\b(?:read|write|rename|unlink|mkdir|stat|lstat)File?Sync\b/.test(source), false);
}

console.log("github-state-markdown.test.js: all assertions passed");
