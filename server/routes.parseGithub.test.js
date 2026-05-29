// #807 (#805 step 2): GITHUB.md render/parse tests. Plain node:assert script —
// no test runner is wired up. Run with
// `node server/routes.parseGithub.test.js`.
//
// renderGithubMarkdown / parseGithub / attributeReviewsByRole are re-exported
// from server/routes.js strictly for this test. Verifies the server-authored
// file round-trips, is injection-safe, attributes reviewers by body-marker ROLE
// (not GitHub login), and distinguishes a parse error from an empty section.

const assert = require("node:assert/strict");
const { renderGithubMarkdown, parseGithub, attributeReviewsByRole, _githubLiveStale, _extractNotesBody, GITHUB_FRESH_TTL_MS } = require("./routes");

const META = { generatedAt: Date.parse("2026-05-29T15:00:00.000Z"), staleCycles: 0 };

function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // ── 1) Render → parse round trip ──
  {
    const snapshot = {
      issues: [{ number: 42, title: "Fix the thing", state: "OPEN", url: "https://x/i/42", assignees: [{ login: "alice" }] }],
      prs: [{ number: 100, title: "Add feature", state: "OPEN", url: "https://x/p/100", assignees: [], reviews: [] }],
      closedIssues: [{ number: 9, title: "Done", state: "CLOSED", url: "https://x/i/9", assignees: [] }],
      mergedPrs: [{ number: 30, title: "Merged it", state: "MERGED", url: "https://x/p/30", assignees: [] }],
    };
    const md = renderGithubMarkdown("Proj", "o/r", snapshot, META, "keep me");
    const p = parseGithub(md);
    ok(p.ok === true, "valid file parses ok:true");
    ok(p.openIssues.length === 1 && p.openIssues[0].number === 42, "open issue parsed");
    ok(p.openIssues[0].state === "OPEN" && p.openIssues[0].url === "https://x/i/42", "issue state+url parsed");
    ok(p.openIssues[0].title === "Fix the thing", "issue title parsed");
    ok(p.openIssues[0].assignees.length === 1 && p.openIssues[0].assignees[0].login === "alice", "issue assignees parsed");
    ok(p.openPRs[0].number === 100 && p.openPRs[0].state === "OPEN", "open PR parsed");
    ok(p.openPRs[0].assignees.length === 0, "empty assignees round-trip to [] (no phantom 'none')");
    ok(p.closedIssues[0].number === 9 && p.closedIssues[0].state === "CLOSED", "closed issue parsed");
    ok(p.mergedPrs[0].number === 30 && p.mergedPrs[0].state === "MERGED", "merged PR parsed");
    ok(p.generatedAt === "2026-05-29T15:00:00.000Z" && p.staleCycles === 0 && p.stale === false, "freshness header parsed");
    ok(md.includes("keep me"), "Notes body preserved in render");
  }

  // ── 2) Injection safety: a title can't emit a section marker or break a row ──
  {
    const evil = "pwned\n## Notes\nINJECTED\n- [#999](http://evil) · OPEN · [] · x";
    const snapshot = { issues: [{ number: 1, title: evil, state: "OPEN", url: "https://x/1", assignees: [] }], prs: [], closedIssues: [], mergedPrs: [] };
    const md = renderGithubMarkdown("P", "o/r", snapshot, META, "real notes");
    const p = parseGithub(md);
    ok(p.ok === true, "injection attempt still parses ok");
    ok(p.openIssues.length === 1, "exactly one open issue (newline injection collapsed, no extra row)");
    ok(p.openIssues[0].number === 1, "the real issue number, not the injected #999");
    ok(!p.openIssues[0].title.includes("\n"), "title is single-line after sanitize");
    ok(p.reviewDetail && Object.keys(p.reviewDetail).length === 0, "injected '## Notes' did not create a new section / leak");
    // The preserved Notes is the real one, not the injected text.
    ok(/real notes/.test(md) && md.indexOf("INJECTED") === md.lastIndexOf("INJECTED"), "injected text appears only inside the sanitized line, not as a section");
  }

  // ── 3) Prose #N does not leak into lists ──
  {
    const snapshot = { issues: [], prs: [], closedIssues: [], mergedPrs: [] };
    let md = renderGithubMarkdown("P", "o/r", snapshot, META, "See #293 for context. Tracking umbrella: #294.");
    // Inject prose lines into the Open Issues section body.
    md = md.replace("## Open Issues\n\n(none)", "## Open Issues\n\n(none)\nSee #295 for context.\nTracking umbrella: #296");
    const p = parseGithub(md);
    ok(p.ok === true && p.openIssues.length === 0, "prose #N lines do not become list items");
  }

  // ── 4) Review Detail: body-marker ROLE, not login (same author, two reviews) ──
  {
    const reviews = [
      { state: "CHANGES_REQUESTED", author: { login: "shared" }, submittedAt: "2026-05-01T00:00:00Z", body: "RE1: needs work" },
      { state: "APPROVED", author: { login: "shared" }, submittedAt: "2026-05-02T00:00:00Z", body: "RE2: APPROVE" },
    ];
    const roles = attributeReviewsByRole(reviews);
    ok(roles.re1 && roles.re1.state === "CHANGES_REQUESTED", "re1 attributed from RE1 marker (shared login)");
    ok(roles.re2 && roles.re2.state === "APPROVED", "re2 attributed from RE2 marker (same login, not collapsed)");

    const snapshot = { issues: [], prs: [{ number: 818, title: "pr", state: "OPEN", url: "https://x/818", assignees: [], reviews }], closedIssues: [], mergedPrs: [] };
    const p = parseGithub(renderGithubMarkdown("P", "o/r", snapshot, META, "n"));
    ok(p.reviewDetail[818] && p.reviewDetail[818].re1.state === "CHANGES_REQUESTED" && p.reviewDetail[818].re2.state === "APPROVED",
       "Review Detail round-trips both roles for the PR");
  }

  // ── 5) Latest-per-role wins; a body quoting the other role doesn't double-count ──
  {
    const reviews = [
      { state: "APPROVED", author: { login: "shared" }, submittedAt: "2026-05-01T00:00:00Z", body: "RE1: lgtm" },
      { state: "CHANGES_REQUESTED", author: { login: "shared" }, submittedAt: "2026-05-03T00:00:00Z", body: "RE1: actually no" },
      // This review QUOTES re2 but is authored as re1's verdict prefix → attributed to re1, not re2.
      { state: "COMMENTED", author: { login: "shared" }, submittedAt: "2026-05-02T00:00:00Z", body: "RE1: re2 said something" },
    ];
    const roles = attributeReviewsByRole(reviews);
    ok(roles.re1 && roles.re1.state === "CHANGES_REQUESTED", "latest re1 review wins (2026-05-03)");
    ok(roles.re2 === null, "a body merely mentioning re2 does not count as a re2 review");
  }

  // ── 6) Ambiguous / marker-less reviews are UNCOUNTED (never over-count) ──
  {
    const roles = attributeReviewsByRole([
      { state: "APPROVED", author: { login: "shared" }, submittedAt: "2026-05-01T00:00:00Z", body: "looks good to me" },
    ]);
    ok(roles.re1 === null && roles.re2 === null, "marker-less review is uncounted");
    ok(attributeReviewsByRole([]).re1 === null, "no reviews → no roles");
  }

  // ── 7) `## Verdict` prefix attributes to re1 (mirrors GitHubPanel) ──
  {
    const roles = attributeReviewsByRole([
      { state: "APPROVED", author: { login: "shared" }, submittedAt: "2026-05-01T00:00:00Z", body: "## Verdict\nAPPROVE" },
    ]);
    ok(roles.re1 && roles.re1.state === "APPROVED", "'## Verdict' body attributes to re1");
  }

  // ── 8) Parse error vs legitimately empty section ──
  {
    ok(parseGithub("").ok === false, "empty string → parse error");
    ok(parseGithub(null).ok === false, "non-string → parse error");
    ok(parseGithub("# Random\n\nnot our file at all").ok === false, "file with no machine headers → parse error");

    const emptySnap = { issues: [], prs: [], closedIssues: [], mergedPrs: [] };
    const p = parseGithub(renderGithubMarkdown("P", "o/r", emptySnap, META, "n"));
    ok(p.ok === true, "valid file with all-empty sections → ok:true (NOT an error)");
    ok(p.openIssues.length === 0 && p.openPRs.length === 0, "empty sections parse to empty arrays");
    ok(Object.keys(p.reviewDetail).length === 0, "no review detail → empty object");
  }

  // ── 9) Freshness: stale when never generated / staleCycles > 0 ──
  {
    const snap = { issues: [], prs: [], closedIssues: [], mergedPrs: [] };
    const pNever = parseGithub(renderGithubMarkdown("P", "o/r", snap, { generatedAt: 0, staleCycles: 3 }, "n"));
    ok(pNever.generatedAt === null && pNever.staleCycles === 3 && pNever.stale === true, "never-generated / staleCycles>0 → stale:true, generatedAt:null");
  }

  // ── 10) Live staleness uses a FIXED window, not adaptiveTTL (re1 review) ──
  // The bug: computing against adaptiveTTL → Infinity under critical rate-limit
  // hid unbounded staleness. A fixed window must flag old data as stale.
  {
    ok(_githubLiveStale(false, 1000) === false, "fresh data (age within window) → not stale");
    ok(_githubLiveStale(false, GITHUB_FRESH_TTL_MS + 1) === true, "age beyond the fixed window → stale (the rate-limited case)");
    ok(_githubLiveStale(false, null) === true, "no generatedAt (null age) → stale");
    // #827: a malformed/corrupted `generatedAt` → Date.parse NaN. Must be
    // treated as stale/unknown, NOT fresh (NaN > window is false, which hid it).
    ok(_githubLiveStale(false, NaN) === true, "NaN age (unparseable generatedAt) → stale, not hidden");
    ok(_githubLiveStale(true, 0) === true, "header already stale → stale regardless of age");
    ok(typeof GITHUB_FRESH_TTL_MS === "number" && Number.isFinite(GITHUB_FRESH_TTL_MS), "freshness window is a finite constant (never Infinity)");
  }

  // ── 11) ## Notes round-trip: render → extract → re-render (re2 review) ──
  // The bug: an UNANCHORED Notes regex matched the `## Notes` reference in the
  // header instructions, so regeneration overwrote real notes with "---".
  {
    const snap = { issues: [], prs: [], closedIssues: [], mergedPrs: [] };
    const note = "Operator note: hold #999 until infra lands.";
    const md1 = renderGithubMarkdown("P", "o/r", snap, META, note);
    const extracted = _extractNotesBody(md1);
    ok(extracted === note, "extract pulls the REAL Notes section, not the header's `## Notes` reference");
    // The actual regeneration path: feed the extracted notes back into a re-render.
    const md2 = renderGithubMarkdown("P", "o/r", snap, META, extracted);
    ok(_extractNotesBody(md2) === note, "notes survive a full render→extract→re-render cycle (no '---' clobber)");
    ok(!/##\s+Notes[\s\S]*\n---\s*$/.test(md2.split("## Notes")[1] || ""), "regenerated Notes body is the note, not a separator");
  }

  // ── 12) A human note containing its own `## ` heading is preserved ──
  {
    const snap = { issues: [], prs: [], closedIssues: [], mergedPrs: [] };
    const note = "Decisions:\n## Plan\n- do the thing\n## Risks\n- none";
    const md = renderGithubMarkdown("P", "o/r", snap, META, note);
    ok(_extractNotesBody(md) === note, "note with its own ## headings is not truncated");
  }

  // ── 13) No Notes section at all → default notes (not a crash) ──
  {
    ok(_extractNotesBody("# Random file\n## Open Issues\n\n(none)") !== "", "missing Notes section → non-empty default");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
