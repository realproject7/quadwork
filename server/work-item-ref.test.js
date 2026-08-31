"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  WorkItemRefError,
  parseWorkItemToken,
  parseWorkItemLine,
  parseWorkItemLines,
  assertWorkItemRef,
  serializeWorkItemRef,
  serializeWorkItemRefApi,
  workItemKey,
  validateAssignmentProvenance,
  validateOwnershipProvenance,
  ownershipKey,
} = require("./work-item-ref");

const repositories = [
  { key: "web", repo: "Owner/Product-Web", primary: true },
  { key: "api", repo: "owner/product-api", primary: false },
];
const single = [{ key: "primary", repo: "owner/legacy", primary: true }];

function code(result) {
  return result && result.diagnostic && result.diagnostic.code;
}

// Canonical qualified identity resolves case-insensitively but preserves the
// registered repository spelling and project-local immutable key.
{
  const parsed = parseWorkItemToken("owner/product-web#42", { repositories, kind: "issue" });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ref, { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" });
  assert.equal(parsed.token, "Owner/Product-Web#42");
  assert.equal(parsed.legacyUnowned, false);
  assert.deepEqual(serializeWorkItemRefApi(parsed.ref), {
    repo_key: "web", repo: "Owner/Product-Web", number: 42, kind: "issue",
  });
}

// The repository and kind are part of identity: same-number cross-repository
// items and issue-vs-PR references never collide.
{
  const webIssue = parseWorkItemToken("Owner/Product-Web#42", { repositories, kind: "issue" }).ref;
  const apiIssue = parseWorkItemToken("owner/product-api#42", { repositories, kind: "issue" }).ref;
  const webPr = parseWorkItemToken("Owner/Product-Web#42", { repositories, kind: "pr" }).ref;
  assert.notEqual(workItemKey(webIssue), workItemKey(apiIssue));
  assert.notEqual(workItemKey(webIssue), workItemKey(webPr));
  assert.equal(serializeWorkItemRef(webPr), "Owner/Product-Web#42");
}

// Bare refs are an explicit V1-only compatibility result and never acquire
// ownership. They are forbidden by default and ambiguous for multi-repo.
{
  assert.equal(code(parseWorkItemToken("#42", { repositories: single })), "bare_ref_forbidden");
  const legacy = parseWorkItemToken("#42", { repositories: single, allowLegacyBare: true });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.legacyUnowned, true);
  assert.deepEqual(legacy.ref, { repoKey: "primary", repo: "owner/legacy", number: 42, kind: "issue" });
  assert.equal(code(parseWorkItemToken("#42", { repositories, allowLegacyBare: true })), "bare_ref_ambiguous");
}

// Unknown, malformed, zero, overflow, whitespace, and leading-zero tokens fail
// closed with stable diagnostics. No token falls back to primary.
{
  const cases = [
    ["other/repo#42", "unknown_repository"],
    ["owner/product-web#0", "invalid_work_item_number"],
    ["owner/product-web#00042", "invalid_work_item_number"],
    ["owner/product-web#10000000", "invalid_work_item_number"],
    ["owner/product-web#x", "invalid_work_item_number"],
    ["owner/product-web", "invalid_work_item_ref"],
    [" owner/product-web#42", "invalid_work_item_ref"],
    ["owner//product-web#42", "invalid_work_item_ref"],
  ];
  for (const [token, expected] of cases) {
    assert.equal(code(parseWorkItemToken(token, { repositories })), expected, token);
  }
}

// The caller-supplied registry is itself fail-closed; ambiguity cannot be
// smuggled in with duplicate keys or canonical repo aliases.
{
  assert.equal(code(parseWorkItemToken("owner/a#1", { repositories: [] })), "invalid_repository_registry");
  assert.equal(code(parseWorkItemToken("owner/a#1", { repositories: [
    { key: "a", repo: "owner/a" }, { key: "a", repo: "owner/b" },
  ] })), "duplicate_repository_key");
  assert.equal(code(parseWorkItemToken("owner/a#1", { repositories: [
    { key: "a", repo: "Owner/A" }, { key: "b", repo: "owner/a" },
  ] })), "duplicate_registered_repository");
}

// Existing list-marker, checkbox, bracket, and prose rejection behavior is
// preserved while the qualified token remains the first structural token.
{
  const line = parseWorkItemLine("- [x] [Owner/Product-Web#42] — visible title", { repositories });
  assert.equal(line.ok, true);
  assert.equal(line.ignored, false);
  assert.equal(line.remainder, "visible title");
  assert.equal(parseWorkItemLine("Tracking umbrella: Owner/Product-Web#42", { repositories }).ignored, true);
  assert.equal(parseWorkItemLine("- prose mentioning #42", { repositories }).ignored, true);
  assert.equal(parseWorkItemLine("- docs/runbook.md changed; see #42", { repositories }).ignored, true);
  assert.equal(parseWorkItemLine("- https://example.test/docs#42 context", { repositories }).ignored, true);
  assert.equal(code(parseWorkItemLine("- Owner/Product-Web #42", { repositories })), "invalid_work_item_ref");
  assert.equal(code(parseWorkItemLine("- Other/Repo #42", { repositories })), "invalid_work_item_ref");
  assert.equal(code(parseWorkItemLine("- Other/repo.js #42", { repositories })), "invalid_work_item_ref");
  assert.equal(code(parseWorkItemLine("- Owner//Product-Web#42", { repositories })), "invalid_work_item_ref");
  assert.equal(parseWorkItemLine("- https://docs.example/path #42 context", { repositories }).ignored, true);
  assert.equal(code(parseWorkItemLine("- [Owner/Product-Web #42]", { repositories })), "invalid_work_item_ref");
  assert.equal(code(parseWorkItemLine("- [Other/Repo #42]", { repositories })), "invalid_work_item_ref");
  assert.equal(code(parseWorkItemLine("- [Owner//Product-Web#42]", { repositories })), "invalid_work_item_ref");
  assert.equal(code(parseWorkItemLine("- [Owner/Product-Web#42", { repositories })), "invalid_work_item_line");
}

// Obvious immediate repo-colon-hash variants are executable-looking malformed
// refs and must remain visible to the fail-closed batch parser. URLs and a
// colon followed by intervening prose are ordinary non-executable text.
{
  for (const line of [
    "Owner/Web:#42",
    "[Owner/Web:#42]",
    "Other/Repo:#42",
    "Owner/Web: #42",
  ]) {
    assert.equal(code(parseWorkItemLine(line, { repositories })), "invalid_work_item_ref", line);
  }
  assert.equal(parseWorkItemLine("https://example.test/Owner/Web:#42", { repositories }).ignored, true);
  assert.equal(parseWorkItemLine("Owner/Web: see #42 in prose", { repositories }).ignored, true);

  const mixed = parseWorkItemLines([
    "- Owner/Product-Web#41 valid",
    "- Owner/Product-Web:#42 malformed",
    "- owner/product-api#43 valid",
  ], { repositories });
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.items.map((item) => item.ref.number), [41, 43]);
  assert.deepEqual(mixed.diagnostics.map((item) => item.code), ["invalid_work_item_ref"]);
  assert.equal(mixed.diagnostics[0].line_number, 2);
}

// Batch line parsing permits same numbers in different repositories, rejects
// a duplicate composite ref, and retains visible line diagnostics. Partial
// items never make the result ok:true.
{
  const parsed = parseWorkItemLines([
    "**Batch:** 12",
    "- Owner/Product-Web#42 web",
    "- owner/product-api#42 api",
    "- owner/product-web#42 duplicate",
    "Backlog prose #99",
  ], { repositories });
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.items.map((item) => item.ref.repoKey), ["web", "api"]);
  assert.deepEqual(parsed.diagnostics.map((item) => item.code), ["duplicate_work_item_ref"]);
  assert.equal(parsed.diagnostics[0].line_number, 4);
}

// Structured refs and provenance reject extra generic/authority fields.
{
  const ref = parseWorkItemToken("Owner/Product-Web#42", { repositories }).ref;
  assert.throws(
    () => assertWorkItemRef({ ...ref, task_key: "not-owned-by-1031" }),
    (error) => error instanceof WorkItemRefError && error.code === "invalid_work_item_ref",
  );
  const provenance = {
    installation_id: "installation_alpha_0001",
    batch_number: 12,
    assignment_attempt: "attempt_0001",
  };
  const valid = validateOwnershipProvenance(provenance, ref);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value.ref, ref);
  assert.equal(validateAssignmentProvenance(provenance).ok, true);
  assert.equal(code(validateOwnershipProvenance({ ...provenance, review_id: 7 }, ref)), "invalid_ownership_provenance");
  assert.equal(code(validateOwnershipProvenance({ ...provenance, installation_id: "short" }, ref)), "invalid_installation_id");
  assert.equal(code(validateOwnershipProvenance({ ...provenance, batch_number: 0 }, ref)), "invalid_batch_number");
  assert.equal(code(validateOwnershipProvenance({ ...provenance, assignment_attempt: "" }, ref)), "invalid_assignment_attempt");
  assert.equal(code(validateOwnershipProvenance({ ...provenance, assignment_attempt: "bad attempt" }, ref)), "invalid_assignment_attempt");
}

// Ownership identity changes across installation, batch, attempt, repository,
// number, and kind. It contains no receipt, task, or caller-defined authority.
{
  const web = parseWorkItemToken("Owner/Product-Web#42", { repositories }).ref;
  const api = parseWorkItemToken("owner/product-api#42", { repositories }).ref;
  const webNext = parseWorkItemToken("Owner/Product-Web#43", { repositories }).ref;
  const webPr = parseWorkItemToken("Owner/Product-Web#42", { repositories, kind: "pr" }).ref;
  const base = {
    installation_id: "installation_alpha_0001",
    batch_number: 12,
    assignment_attempt: "attempt_0001",
  };
  const key = ownershipKey(base, web);
  assert.deepEqual(JSON.parse(key).slice(0, 5), [
    "work-item-owner", 1, "installation_alpha_0001", 12, "attempt_0001",
  ]);
  assert.notEqual(key, ownershipKey({ ...base, installation_id: "installation_bravo_0002" }, web));
  assert.notEqual(key, ownershipKey({ ...base, batch_number: 13 }, web));
  assert.notEqual(key, ownershipKey({ ...base, assignment_attempt: "attempt_0002" }, web));
  assert.notEqual(key, ownershipKey(base, api));
  assert.notEqual(key, ownershipKey(base, webNext));
  assert.notEqual(key, ownershipKey(base, webPr));
}

// Purity guard: the module has no config/filesystem/GitHub process dependency.
{
  const source = fs.readFileSync(path.join(__dirname, "work-item-ref.js"), "utf-8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process)["']\s*\)/);
  assert.doesNotMatch(source, /\.\/config|ghJson|fetch\s*\(/);
}

console.log("work-item-ref.test.js: all assertions passed");
