// #845: reseedAgentsMd merger tests. Plain node:assert script — no test
// runner is wired up. Run with `node server/routes.reseedAgentsMd.test.js`.
//
// reseedAgentsMd is re-exported from server/routes.js for this test only;
// it has no production callers outside routes.js. The function is pure
// (in-memory strings only) so it does not need a temp-fs harness.

const assert = require("node:assert/strict");
const { reseedAgentsMd } = require("./routes");

const FRESH = `# Dev — Full-Stack Builder

## Role
Implement features.

## Workflow
1. Read assignment.
2. Open PR.

## Communication
Use chat_send.
`;

// 1) Empty / missing existing content → fresh template verbatim, no trailer.
{
  const out = reseedAgentsMd("", FRESH);
  assert.equal(out.content, FRESH, "empty existing → fresh verbatim");
  assert.deepEqual(out.preservedHeadings, [], "no preserved headings");

  const out2 = reseedAgentsMd("   \n\n", FRESH);
  assert.equal(out2.content, FRESH, "whitespace-only existing → fresh verbatim");

  const out3 = reseedAgentsMd(null, FRESH);
  assert.equal(out3.content, FRESH, "null existing → fresh verbatim");
}

// 2) Existing with ONLY canonical headings (same as template) → fresh
//    template wins, stale content discarded, nothing preserved. This is
//    the #845 root case: agents launch with current rules, not the stale
//    pre-#809 instructions.
{
  const stale = `# Dev — Old Title

## Role
OUTDATED role text that must be replaced.

## Workflow
Old workflow.

## Communication
Stale communication rules referencing gh pr list.
`;
  const out = reseedAgentsMd(stale, FRESH);
  assert.equal(out.content, FRESH, "all-canonical existing → fresh wins, no trailer");
  assert.deepEqual(out.preservedHeadings, []);
  assert.ok(!out.content.includes("OUTDATED"), "stale body discarded");
  assert.ok(!out.content.includes("gh pr list"), "stale communication discarded");
}

// 3) Existing with a `## Notes` operator section → preserved at the end
//    under the marker comment, canonical sections still come from fresh.
{
  const existing = `# Dev — Old Title

## Role
OLD role.

## Notes
- Local dev: run npm run dev before pushing.
- This project uses a custom GH token at ~/.local/token.
`;
  const out = reseedAgentsMd(existing, FRESH);
  assert.ok(out.content.startsWith("# Dev — Full-Stack Builder"), "fresh title at top");
  assert.ok(!out.content.includes("OLD role"), "stale Role body discarded");
  assert.ok(out.content.includes("<!-- Operator notes preserved from prior AGENTS.md (#845) -->"), "trailer marker present");
  assert.ok(out.content.includes("## Notes"), "Notes heading preserved");
  assert.ok(out.content.includes("Local dev: run npm run dev"), "Notes body preserved");
  assert.ok(out.content.includes("custom GH token"), "Notes body preserved (line 2)");
  assert.deepEqual(out.preservedHeadings, ["Notes"]);
}

// 4) Multiple custom sections preserved in original order; canonical
//    sections in fresh are not duplicated.
{
  const existing = `# Dev

## Role
old

## Project-Specific Quirks
This repo has an unusual build chain.

## Notes
- Don't touch the migrations folder without asking.

## Workflow
old workflow
`;
  const out = reseedAgentsMd(existing, FRESH);
  assert.deepEqual(out.preservedHeadings, ["Project-Specific Quirks", "Notes"], "order preserved");
  assert.ok(out.content.includes("## Project-Specific Quirks"));
  assert.ok(out.content.includes("unusual build chain"));
  assert.ok(out.content.includes("## Notes"));
  assert.ok(out.content.includes("migrations folder"));
  // Canonical Role and Workflow appear EXACTLY once each (from fresh).
  const roleMatches = out.content.match(/^## Role\b/gm) || [];
  const workflowMatches = out.content.match(/^## Workflow\b/gm) || [];
  assert.equal(roleMatches.length, 1, "## Role appears exactly once");
  assert.equal(workflowMatches.length, 1, "## Workflow appears exactly once");
}

// 5) Heading match is case-insensitive and whitespace-normalized — a
//    stale "## role" or "##  Role  " block is NOT preserved as custom.
{
  const existing = `# Dev

## role
mixed case heading

##  Workflow
trailing spaces

## CustomBoxOnly
keep me
`;
  const out = reseedAgentsMd(existing, FRESH);
  assert.deepEqual(out.preservedHeadings, ["CustomBoxOnly"], "only the genuinely-custom heading is preserved");
  assert.ok(!out.content.includes("mixed case heading"));
  assert.ok(!out.content.includes("trailing spaces"));
  assert.ok(out.content.includes("keep me"));
}

// 6) H3+ subsections inside a custom H2 stay nested under their parent
//    (no orphaning). They must NOT be treated as their own H2 blocks.
{
  const existing = [
    "# Dev",
    "",
    "## Notes",
    "",
    "### Local setup",
    "Run `npm install` first.",
    "",
    "### Common pitfalls",
    "The build cache lies — `rm -rf .next` when in doubt.",
    "",
  ].join("\n");
  const out = reseedAgentsMd(existing, FRESH);
  assert.deepEqual(out.preservedHeadings, ["Notes"]);
  assert.ok(out.content.includes("### Local setup"), "H3 subsection survives under its parent");
  assert.ok(out.content.includes("### Common pitfalls"));
  assert.ok(out.content.includes("npm install"));
  assert.ok(out.content.includes("rm -rf .next"));
}

// 7) Fresh template's trailing whitespace is normalized so the trailer
//    attaches cleanly (no triple blank lines).
{
  const freshWithTrailing = FRESH + "\n\n\n";
  const existing = `## Notes\n- a note\n`;
  const out = reseedAgentsMd(existing, freshWithTrailing);
  assert.ok(!/\n\n\n\n/.test(out.content), "no run of >2 consecutive blank lines");
  assert.ok(out.content.endsWith("\n"), "ends with single newline");
}

// 8) Placeholder substitution is the caller's job (the endpoint substitutes
//    {{project_name}} / {{reviewer_*}} BEFORE calling the merger). Verify
//    the merger does not touch placeholders so an operator can preserve
//    legitimate literal {{...}} text in a custom section.
{
  const existing = "## Notes\nWe document our placeholder convention as `{{project_name}}` for examples.\n";
  const out = reseedAgentsMd(existing, FRESH);
  assert.ok(out.content.includes("`{{project_name}}`"), "merger leaves placeholders untouched in custom sections");
}

console.log("routes.reseedAgentsMd.test.js: all assertions passed (8 cases)");
