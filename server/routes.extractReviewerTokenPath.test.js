// #854: _extractReviewerTokenPath unit tests. Pure parser — covers the
// common shell forms an operator might have edited a worktree AGENTS.md
// into so the re-seed substitution preserves their custom token path
// instead of clobbering it with the default.
//
// Plain node:assert script — auto-discovered by the #836 cross-platform
// runner. Run directly with `node server/routes.extractReviewerTokenPath.test.js`.

const assert = require("node:assert/strict");
const { _extractReviewerTokenPath } = require("./routes");

// 1) Canonical seed form — `export GH_TOKEN=$(cat <path>)`. The exact line
//    `templates/seeds/re1.AGENTS.md` ships with, after substitution.
{
  const txt = `## GitHub Authentication\nexport GH_TOKEN=$(cat /Users/cho/.local/reviewer-token)\nNext section...`;
  assert.equal(_extractReviewerTokenPath(txt), "/Users/cho/.local/reviewer-token");
}

// 2) No `export` prefix — operator may have stripped it (still a valid shell line).
{
  const txt = `GH_TOKEN=$(cat /custom/path)\n`;
  assert.equal(_extractReviewerTokenPath(txt), "/custom/path");
}

// 3) Outer double-quote wrapping — `"$(cat …)"`. Common operator edit when
//    they paste a snippet from elsewhere.
{
  const txt = `export GH_TOKEN="$(cat /opt/secrets/gh-token)"\n`;
  assert.equal(_extractReviewerTokenPath(txt), "/opt/secrets/gh-token");
}

// 4) Inner double-quoted path (path with spaces).
{
  const txt = `export GH_TOKEN=$(cat "/Users/op/My Tokens/gh.token")\n`;
  assert.equal(_extractReviewerTokenPath(txt), "/Users/op/My Tokens/gh.token");
}

// 5) Inner single-quoted path.
{
  const txt = `GH_TOKEN=$(cat '/srv/tokens/gh-prod')\n`;
  assert.equal(_extractReviewerTokenPath(txt), "/srv/tokens/gh-prod");
}

// 6) Outer + inner double quotes together.
{
  const txt = `export GH_TOKEN="$(cat "/path with spaces/tok")"\n`;
  assert.equal(_extractReviewerTokenPath(txt), "/path with spaces/tok");
}

// 7) Indented (inside a fenced code block in the existing AGENTS.md).
{
  const txt = `\`\`\`bash\n    export GH_TOKEN=$(cat /tab/indented/token)\n\`\`\`\n`;
  assert.equal(_extractReviewerTokenPath(txt), "/tab/indented/token");
}

// 8) Tabs between tokens — `export\tGH_TOKEN  =\t$(cat …)`.
{
  const txt = `export\tGH_TOKEN\t=\t$(cat /tabbed/token)\n`;
  assert.equal(_extractReviewerTokenPath(txt), "/tabbed/token");
}

// 9) Multiple GH_TOKEN lines — first match wins. (Operators shouldn't have
//    two, but if they do we don't crash; canonical first-line picks up the
//    one that's documented/used.)
{
  const txt = `export GH_TOKEN=$(cat /first/path)\n# Or alternately:\nGH_TOKEN=$(cat /second/path)\n`;
  assert.equal(_extractReviewerTokenPath(txt), "/first/path");
}

// 10) Different `cat` invocation forms inside `$()` — extra whitespace.
{
  assert.equal(_extractReviewerTokenPath(`GH_TOKEN=$( cat /spaced )`), "/spaced");
  assert.equal(_extractReviewerTokenPath(`GH_TOKEN=$(cat  /double-space)`), "/double-space");
}

// 11) No GH_TOKEN line at all — head/dev seeds. Returns null so the resolver
//     falls through to cfg / default (the placeholder isn't even present in
//     those templates anyway).
{
  const txt = `# Dev\n\nNo authentication section here.\n`;
  assert.equal(_extractReviewerTokenPath(txt), null);
}

// 12) GH_TOKEN set to a literal value (no `$(cat …)`) — we can't preserve a
//     path that isn't there. Returns null; the substitution falls through
//     to the default and the operator's literal-value line is preserved as
//     a custom section by the #845 merger if they keep it under a non-canonical
//     H2 (here it's inline in the same fresh section, so the fresh template
//     will replace it — which is acceptable because there's no path to keep).
{
  const txt = `export GH_TOKEN=ghp_HARDCODED_LITERAL_TOKEN\n`;
  assert.equal(_extractReviewerTokenPath(txt), null);
}

// 13) GH_TOKEN line that references the placeholder verbatim (pre-substitution
//     content somehow round-tripped). Returns the literal placeholder text —
//     the resolver caller will pass it back into substitution unchanged, which
//     is functionally equivalent to using the default for re-seeding purposes.
//     Documented behavior to keep the extractor a true round-trip.
{
  const txt = `export GH_TOKEN=$(cat {{reviewer_token_path}})\n`;
  assert.equal(_extractReviewerTokenPath(txt), "{{reviewer_token_path}}");
}

// 14) Empty / null / non-string inputs — never throw, return null.
{
  assert.equal(_extractReviewerTokenPath(""), null);
  assert.equal(_extractReviewerTokenPath(null), null);
  assert.equal(_extractReviewerTokenPath(undefined), null);
  assert.equal(_extractReviewerTokenPath(123), null);
  assert.equal(_extractReviewerTokenPath({}), null);
}

// 15) Substring `GH_TOKEN` in prose (not on a line of its own setting it) —
//     no match, returns null. Anchored on line start, so prose like "set
//     GH_TOKEN somehow" doesn't trigger.
{
  const txt = `Run something like \`GH_TOKEN=...\` here.\nNo real setter.\n`;
  assert.equal(_extractReviewerTokenPath(txt), null);
}

console.log("routes.extractReviewerTokenPath.test.js: all assertions passed (15 cases)");
