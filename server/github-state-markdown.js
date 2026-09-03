"use strict";

// Pure codec for the repository-qualified GITHUB.md document introduced by
// #1030.  This module intentionally owns no filesystem state: callers assemble
// every repository's last-good snapshot, render one complete string, and commit
// that string atomically at the integration boundary.

const DOCUMENT_MARKER = "<!-- quadwork-github-state:v2 -->";
const GROUP_START = "<!-- quadwork-repository:start -->";
const GROUP_END = "<!-- quadwork-repository:end -->";
const NOTES_HEADER = "## Notes";
const DEFAULT_NOTES = [
  "_Advisory only. Cached repository state is not merge-authoritative.",
  "Head must re-check the exact pull request and SHA live before merging._",
].join("\n");

const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ITEM_RE = /^- \[#(\d{1,7})\]\((\S+)\) · (OPEN|CLOSED|MERGED) · \[([^\]]*)\] · (.*)$/;
const REVIEW_RE = /^- #(\d{1,7}) · (re1|re2):([A-Z_]+) · (\S+)$/;
const FRESHNESS_RE = /^> \*\*Generated:\*\* (\S+) · staleCycles: (\d+) · stale: (true|false)$/;

const SECTION_SPECS = Object.freeze([
  ["issues", "Open Issues"],
  ["prs", "Open PRs"],
  ["closedIssues", "Recently Closed Issues"],
  ["mergedPrs", "Recently Merged PRs"],
]);

function markdownError(code, message) {
  const error = new Error(message);
  error.name = "GithubStateMarkdownError";
  error.code = code;
  return error;
}

function fail(code, message) {
  throw markdownError(code, message);
}

function normalizeText(text) {
  return String(text == null ? "" : text).replace(/\r\n?/g, "\n");
}

function safeInline(value) {
  return normalizeText(value)
    .replace(/\n+/g, " ")
    .replace(/<!--|-->|[·\[\]<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUrl(value) {
  const raw = normalizeText(value).trim();
  if (!raw || raw === "-") return "-";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "-";
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    return "-";
  }
  return parsed.toString().replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

function validateRepositoryIdentity(repoKey, repo) {
  if (typeof repoKey !== "string" || !REPOSITORY_KEY_RE.test(repoKey)) {
    fail("invalid_repository_key", "repository group has an invalid repo_key");
  }
  if (typeof repo !== "string" || !REPOSITORY_RE.test(repo)) {
    fail("invalid_repository", "repository group has an invalid repo");
  }
  return { repo_key: repoKey, repo, canonical_repo: repo.toLowerCase() };
}

function normalizedMeta(meta) {
  const source = meta && typeof meta === "object" ? meta : {};
  const staleCycles = Number.isSafeInteger(source.staleCycles) && source.staleCycles >= 0
    ? source.staleCycles
    : 0;
  let generatedAt = null;
  if (typeof source.generatedAt === "number" && Number.isFinite(source.generatedAt) && source.generatedAt > 0) {
    generatedAt = new Date(source.generatedAt).toISOString();
  } else if (typeof source.generatedAt === "string" && source.generatedAt && !Number.isNaN(Date.parse(source.generatedAt))) {
    generatedAt = new Date(source.generatedAt).toISOString();
  }
  return {
    generatedAt,
    staleCycles,
    stale: source.stale === true || staleCycles > 0 || generatedAt === null,
  };
}

function safeAssignees(assignees) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(assignees) ? assignees : []) {
    const login = typeof entry === "string" ? entry : entry && entry.login;
    if (typeof login !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) || seen.has(login)) continue;
    seen.add(login);
    result.push({ login });
  }
  return result;
}

function normalizedItem(item, fallbackState) {
  if (!item || typeof item !== "object" || !Number.isSafeInteger(item.number) || item.number < 1 || item.number > 9_999_999) {
    fail("invalid_github_item", "GitHub item number is invalid");
  }
  const state = safeInline(item.state || fallbackState).toUpperCase();
  if (!new Set(["OPEN", "CLOSED", "MERGED"]).has(state)) {
    fail("invalid_github_item", "GitHub item state is invalid");
  }
  return {
    number: item.number,
    url: safeUrl(item.url),
    state,
    assignees: safeAssignees(item.assignees),
    title: safeInline(item.title) || "(untitled)",
  };
}

function renderItem(item, fallbackState) {
  const value = normalizedItem(item, fallbackState);
  const assignees = value.assignees.map(({ login }) => `@${login}`).join(", ");
  return `- [#${value.number}](${value.url}) · ${value.state} · [${assignees}] · ${value.title}`;
}

function reviewRole(review) {
  const body = normalizeText(review && review.body).trim();
  if (/^(?:RE2|Reviewer2|T2b)\b/i.test(body)) return "re2";
  if (/^(?:RE1|Reviewer1|T2a)\b/i.test(body) || /^##\s*Verdict/i.test(body)) return "re1";
  return null;
}

function renderedReviews(prs) {
  const lines = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    normalizedItem(pr, "OPEN");
    const latest = new Map();
    for (const review of Array.isArray(pr.reviews) ? pr.reviews : []) {
      const role = reviewRole(review);
      if (!role) continue;
      const state = safeInline(review.state).toUpperCase();
      if (!/^[A-Z_]+$/.test(state)) continue;
      const submittedAt = safeInline(review.submittedAt);
      const timestamp = submittedAt && !/\s/.test(submittedAt) ? submittedAt : "-";
      const observedAt = timestamp === "-" ? 0 : Date.parse(timestamp) || 0;
      const previous = latest.get(role);
      if (!previous || observedAt >= previous.observedAt) latest.set(role, { state, timestamp, observedAt });
    }
    for (const role of ["re1", "re2"]) {
      const review = latest.get(role);
      if (review) lines.push(`- #${pr.number} · ${role}:${review.state} · ${review.timestamp}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function renderedList(items, fallbackState) {
  if (!Array.isArray(items) || items.length === 0) return "(none)";
  const seen = new Set();
  return items.map((item) => {
    if (item && seen.has(item.number)) fail("duplicate_github_item", "GitHub list contains a duplicate item number");
    if (item) seen.add(item.number);
    return renderItem(item, fallbackState);
  }).join("\n");
}

function renderRepositoryGroup(state) {
  const identity = validateRepositoryIdentity(state && state.repo_key, state && state.repo);
  if (typeof state.primary !== "boolean") fail("invalid_primary_repository", "repository group primary must be boolean");
  const snapshot = state.snapshot && typeof state.snapshot === "object" ? state.snapshot : {};
  const meta = normalizedMeta(state.meta);
  return [
    GROUP_START,
    `## Repository: ${identity.repo_key}`,
    `> **Repo:** ${identity.repo}`,
    `> **Primary:** ${state.primary}`,
    `> **Generated:** ${meta.generatedAt || "never"} · staleCycles: ${meta.staleCycles} · stale: ${meta.stale}`,
    "",
    "### Open Issues",
    "",
    renderedList(snapshot.issues, "OPEN"),
    "",
    "### Open PRs",
    "",
    renderedList(snapshot.prs, "OPEN"),
    "",
    "### Recently Closed Issues",
    "",
    renderedList(snapshot.closedIssues, "CLOSED"),
    "",
    "### Recently Merged PRs",
    "",
    renderedList(snapshot.mergedPrs, "MERGED"),
    "",
    "### Review Detail",
    "",
    renderedReviews(snapshot.prs),
    GROUP_END,
  ].join("\n");
}

function validatedRepositoryStates(repositoryStates) {
  if (!Array.isArray(repositoryStates) || repositoryStates.length === 0) {
    fail("repositories_required", "at least one repository state is required");
  }
  const keys = new Set();
  const repos = new Set();
  let primaries = 0;
  for (const state of repositoryStates) {
    const identity = validateRepositoryIdentity(state && state.repo_key, state && state.repo);
    if (keys.has(identity.repo_key)) fail("duplicate_repository_key", "repository group key is duplicated");
    if (repos.has(identity.canonical_repo)) fail("duplicate_repository", "canonical repository group is duplicated");
    keys.add(identity.repo_key);
    repos.add(identity.canonical_repo);
    if (state.primary === true) primaries += 1;
  }
  if (primaries !== 1) fail("invalid_primary_repository_count", "exactly one repository group must be primary");
  return repositoryStates;
}

function normalizeNotes(notesBody) {
  const notes = normalizeText(notesBody).trim();
  return notes || DEFAULT_NOTES;
}

function renderProjectGithubMarkdown(projectName, repositoryStates, notesBody) {
  const groups = validatedRepositoryStates(repositoryStates).map(renderRepositoryGroup);
  return [
    DOCUMENT_MARKER,
    `# ${safeInline(projectName)} — GitHub State`,
    "",
    "> Machine-generated by QuadWork. Repository sections are overwritten atomically.",
    "> Cached state is advisory; merge and review decisions require targeted live reads.",
    "",
    "---",
    "",
    groups.join("\n\n---\n\n"),
    "",
    "---",
    "",
    NOTES_HEADER,
    "",
    normalizeNotes(notesBody),
    "",
  ].join("\n");
}

function notesBoundary(text) {
  const normalized = normalizeText(text);
  const match = /^## Notes[ \t]*$/m.exec(normalized);
  if (!match) return null;
  const bodyStart = normalized.indexOf("\n", match.index + match[0].length);
  return {
    normalized,
    headerStart: match.index,
    bodyStart: bodyStart === -1 ? normalized.length : bodyStart + 1,
  };
}

function extractGithubNotes(text) {
  const boundary = notesBoundary(text);
  if (!boundary) return DEFAULT_NOTES;
  return normalizeNotes(boundary.normalized.slice(boundary.bodyStart));
}

function parseItemList(body, identity, label) {
  const content = body.trim();
  if (content === "(none)") return [];
  if (!content || content.split("\n").some((line) => line.trim() === "(none)")) {
    fail("malformed_repository_group", `${label} is malformed`);
  }
  const items = [];
  const seen = new Set();
  for (const line of content.split("\n")) {
    const match = ITEM_RE.exec(line);
    if (!match) fail("malformed_github_item", `${label} contains a malformed item`);
    const number = Number(match[1]);
    if (seen.has(number)) fail("duplicate_github_item", `${label} contains a duplicate item number`);
    if (safeUrl(match[2]) !== match[2]) fail("malformed_github_item", `${label} contains an unsafe URL`);
    if (safeInline(match[5]) !== match[5].trim()) fail("malformed_github_item", `${label} contains an unsafe title`);
    const assignees = [];
    const assigneeLogins = new Set();
    if (match[4]) {
      for (const raw of match[4].split(",")) {
        const token = raw.trim();
        const assignee = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/.exec(token);
        if (!assignee || assigneeLogins.has(assignee[1])) {
          fail("malformed_github_item", `${label} contains malformed assignees`);
        }
        assigneeLogins.add(assignee[1]);
        assignees.push({ login: assignee[1] });
      }
    }
    seen.add(number);
    items.push({
      repo_key: identity.repo_key,
      repo: identity.repo,
      number,
      url: match[2],
      state: match[3],
      assignees,
      title: match[5].trim(),
    });
  }
  return items;
}

function parseReviewList(body, identity, prs) {
  const content = body.trim();
  if (content === "(none)") return {};
  if (!content || content.split("\n").some((line) => line.trim() === "(none)")) {
    fail("malformed_repository_group", "Review Detail is malformed");
  }
  const prNumbers = new Set(prs.map((pr) => pr.number));
  const result = {};
  for (const line of content.split("\n")) {
    const match = REVIEW_RE.exec(line);
    if (!match) fail("malformed_review_detail", "Review Detail contains a malformed row");
    const number = Number(match[1]);
    if (!prNumbers.has(number)) fail("orphan_review_detail", "Review Detail references an unknown pull request");
    if (match[4] !== "-" && Number.isNaN(Date.parse(match[4]))) {
      fail("malformed_review_detail", "Review Detail contains a malformed timestamp");
    }
    const composite = `${identity.repo_key}#${number}`;
    const role = match[2];
    const entry = result[composite] || (result[composite] = {
      repo_key: identity.repo_key,
      repo: identity.repo,
      number,
    });
    if (entry[role]) fail("duplicate_review_detail", "Review Detail duplicates a repository-qualified role");
    entry[role] = { state: match[3], submittedAt: match[4] };
  }
  return result;
}

function parseFreshness(line) {
  const match = FRESHNESS_RE.exec(line);
  if (!match) fail("malformed_repository_group", "repository freshness metadata is malformed");
  if (match[1] !== "never" && (Number.isNaN(Date.parse(match[1])) || new Date(match[1]).toISOString() !== match[1])) {
    fail("malformed_repository_group", "repository generated timestamp is malformed");
  }
  const staleCycles = Number(match[2]);
  const stale = match[3] === "true";
  if (!stale && (match[1] === "never" || staleCycles > 0)) {
    fail("malformed_repository_group", "repository freshness metadata is inconsistent");
  }
  return {
    generatedAt: match[1] === "never" ? null : match[1],
    staleCycles,
    stale,
  };
}

function splitStrictSections(body, headings) {
  const escaped = headings.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const expression = new RegExp(
    `^### ${escaped[0]}\\n\\n([\\s\\S]*?)\\n\\n` +
    `### ${escaped[1]}\\n\\n([\\s\\S]*?)\\n\\n` +
    `### ${escaped[2]}\\n\\n([\\s\\S]*?)\\n\\n` +
    `### ${escaped[3]}\\n\\n([\\s\\S]*?)\\n\\n` +
    `### ${escaped[4]}\\n\\n([\\s\\S]*)$`,
  );
  const match = expression.exec(body);
  if (!match) fail("malformed_repository_group", "repository machine sections are missing, reordered, or malformed");
  return match.slice(1);
}

function parseV2Group(groupText) {
  const lines = groupText.split("\n");
  if (lines.length < 7 || lines[0] !== GROUP_START || lines[lines.length - 1] !== GROUP_END) {
    fail("malformed_repository_group", "repository group markers are malformed");
  }
  const keyMatch = /^## Repository: ([a-z][a-z0-9-]{0,31})$/.exec(lines[1]);
  const repoMatch = /^> \*\*Repo:\*\* (\S+)$/.exec(lines[2]);
  const primaryMatch = /^> \*\*Primary:\*\* (true|false)$/.exec(lines[3]);
  if (!keyMatch || !repoMatch || !primaryMatch || lines[5] !== "") {
    fail("malformed_repository_group", "repository group header is malformed");
  }
  const identity = validateRepositoryIdentity(keyMatch[1], repoMatch[1]);
  const meta = parseFreshness(lines[4]);
  const sections = splitStrictSections(
    lines.slice(6, -1).join("\n"),
    [...SECTION_SPECS.map(([, heading]) => heading), "Review Detail"],
  );
  const issues = parseItemList(sections[0], identity, "Open Issues");
  const prs = parseItemList(sections[1], identity, "Open PRs");
  const closedIssues = parseItemList(sections[2], identity, "Recently Closed Issues");
  const mergedPrs = parseItemList(sections[3], identity, "Recently Merged PRs");
  const reviewDetail = parseReviewList(sections[4], identity, prs);
  return {
    repo_key: identity.repo_key,
    repo: identity.repo,
    primary: primaryMatch[1] === "true",
    ...meta,
    issues,
    prs,
    closedIssues,
    mergedPrs,
    reviewDetail,
  };
}

function aggregateParsed(format, repositories, notes) {
  const reviewDetail = {};
  for (const repository of repositories) Object.assign(reviewDetail, repository.reviewDetail);
  const result = {
    ok: true,
    format,
    repositories,
    openIssues: repositories.flatMap((repository) => repository.issues),
    openPRs: repositories.flatMap((repository) => repository.prs),
    closedIssues: repositories.flatMap((repository) => repository.closedIssues),
    mergedPrs: repositories.flatMap((repository) => repository.mergedPrs),
    reviewDetail,
    notes,
  };
  // Preserve the existing one-repository parsed projection while adding the
  // repository-qualified form. Multi-repository documents intentionally have
  // no ambiguous global freshness or bare-number review key.
  if (repositories.length === 1) {
    const repository = repositories[0];
    result.generatedAt = repository.generatedAt;
    result.staleCycles = repository.staleCycles;
    result.stale = repository.stale;
    for (const entry of Object.values(repository.reviewDetail)) {
      result.reviewDetail[String(entry.number)] = entry;
    }
  }
  return result;
}

function parseV2(text, boundary) {
  const machineWithNotesSeparator = text.slice(0, boundary.headerStart).trimEnd();
  if (!machineWithNotesSeparator.endsWith("\n\n---")) {
    fail("malformed_github_document", "GitHub state document Notes separator is malformed");
  }
  const machine = machineWithNotesSeparator.slice(0, -5);
  const prefix = [
    DOCUMENT_MARKER,
    /^# .* — GitHub State$/,
    "",
    "> Machine-generated by QuadWork. Repository sections are overwritten atomically.",
    "> Cached state is advisory; merge and review decisions require targeted live reads.",
    "",
    "---",
    "",
  ];
  const lines = machine.split("\n");
  for (let index = 0; index < prefix.length; index += 1) {
    const expected = prefix[index];
    const actual = lines[index];
    if (expected instanceof RegExp ? !expected.test(actual || "") : actual !== expected) {
      fail("malformed_github_document", "GitHub state document header is malformed");
    }
  }
  const groupRegion = lines.slice(prefix.length).join("\n");
  if (!groupRegion || groupRegion.includes(`${GROUP_END}\n${GROUP_START}`)) {
    fail("malformed_github_document", "repository group separators are malformed");
  }
  const groupTexts = groupRegion.split(`\n\n---\n\n`);
  if (groupTexts.length === 0 || groupTexts.some((group) => !group)) {
    fail("malformed_github_document", "repository groups are missing");
  }
  const repositories = groupTexts.map(parseV2Group);
  const keys = new Set();
  const repos = new Set();
  let primaries = 0;
  for (const repository of repositories) {
    const canonical = repository.repo.toLowerCase();
    if (keys.has(repository.repo_key)) fail("duplicate_repository_key", "repository group key is duplicated");
    if (repos.has(canonical)) fail("duplicate_repository", "canonical repository group is duplicated");
    keys.add(repository.repo_key);
    repos.add(canonical);
    if (repository.primary) primaries += 1;
  }
  if (primaries !== 1) fail("invalid_primary_repository_count", "exactly one repository group must be primary");
  return aggregateParsed("v2", repositories, extractGithubNotes(text));
}

function legacySection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)## ${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text);
  if (!match) fail("malformed_legacy_document", `legacy ${heading} section is missing`);
  return match[1].trim().replace(/\n\n---$/, "").trim();
}

function parseLegacy(text) {
  const repoMatch = /^> \*\*Repo:\*\* (\S+)$/m.exec(text);
  if (!repoMatch) fail("malformed_legacy_document", "legacy repository identity is missing");
  const identity = validateRepositoryIdentity("primary", repoMatch[1]);
  const freshMatch = /^> \*\*Generated:\*\* (\S+) · staleCycles: (\d+) · stale: (true|false)$/m.exec(text);
  const meta = freshMatch ? parseFreshness(freshMatch[0]) : { generatedAt: null, staleCycles: 0, stale: true };
  const issues = parseItemList(legacySection(text, "Open Issues"), identity, "Open Issues");
  const prs = parseItemList(legacySection(text, "Open PRs"), identity, "Open PRs");
  const closedIssues = parseItemList(legacySection(text, "Recently Closed Issues"), identity, "Recently Closed Issues");
  const mergedPrs = parseItemList(legacySection(text, "Recently Merged PRs"), identity, "Recently Merged PRs");
  const reviewDetail = parseReviewList(legacySection(text, "Review Detail"), identity, prs);
  return aggregateParsed("legacy", [{
    repo_key: identity.repo_key,
    repo: identity.repo,
    primary: true,
    ...meta,
    issues,
    prs,
    closedIssues,
    mergedPrs,
    reviewDetail,
  }], extractGithubNotes(text));
}

function parseProjectGithubMarkdown(text) {
  try {
    if (typeof text !== "string" || !text.trim()) fail("empty_github_document", "GitHub state document is empty");
    const normalized = normalizeText(text);
    const boundary = notesBoundary(normalized);
    if (!boundary) fail("missing_notes_section", "GitHub state document is missing its Notes section");
    if (normalized.startsWith(`${DOCUMENT_MARKER}\n`)) return parseV2(normalized, boundary);
    return parseLegacy(normalized);
  } catch (error) {
    if (error && error.name === "GithubStateMarkdownError") {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "GitHub state document is malformed", code: "malformed_github_document" };
  }
}

module.exports = {
  renderProjectGithubMarkdown,
  parseProjectGithubMarkdown,
  extractGithubNotes,
};
