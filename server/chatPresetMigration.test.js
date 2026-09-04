// #1073: the chat-preset storage migration, executed rather than pattern-matched.
//
// Every load-bearing string below is a LITERAL recovered from git history, not
// an import from production. Importing the production constant and comparing it
// to itself proves nothing; instead each literal is pinned to the sha256 of the
// bytes that actually shipped, and the migration is then exercised against
// fixtures built from those pinned literals. A drift in either the test copy or
// the production copy therefore fails.
//
//   default-1 "Queue Check — Trigger" has two historical bodies:
//     5a0f882 [#617] original          379 chars  e6394330c492a980…
//     21c5df0 [#808] tightened trigger 796 chars  481cb08c5b96b2ed…
//   default-3 "Check Queue Format" has one historical body, unchanged across
//     5a0f882 and 21c5df0             291 chars  4f2c52252f6a1b2a…

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  DEFAULT_PRESETS,
  STORAGE_KEY,
  loadPresetsFrom,
  migratePresets,
} = require("../src/lib/chatPresetMigration.js");

const sha = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

const QUEUE_CHECK_TITLE = "Queue Check — Trigger";
const QUEUE_FORMAT_TITLE = "Check Queue Format";

// 5a0f882 [#617] — the pre-#808 all-agent pulse.
const PRE_808_QUEUE_CHECK = `@head @dev @re1 @re2 – Queue check.
@head: Merge any PR with both approvals, assign next from ~/.quadwork/{{project}}/OVERNIGHT-QUEUE.md.
@dev: Work on assigned ticket or address review feedback.
@re1 & @re2: Review open PRs. If @dev pushed fixes, re-review. Post verdict on PR AND notify @dev here.
ALL: Communicate via this chat by tagging agents. Your terminal is NOT visible.`;

// 21c5df0 [#808] — the tightened all-agent pulse.
const QUEUE_CHECK_808 = `@head @dev @re1 @re2 – Queue check.
Discovery: read ~/.quadwork/{{project}}/GITHUB.md (or GET /api/github-parsed?project={{project}}) for issue/PR state instead of running gh. If it's absent or stale (>2 cycles / _stale), do ONE direct gh read to confirm. GITHUB.md may lag — confirm with a direct gh read before any merge/review decision.
@head: Merge any PR with both approvals, assign next from ~/.quadwork/{{project}}/OVERNIGHT-QUEUE.md.
@dev: Work on assigned ticket or address review feedback.
@re1 & @re2: Review ONLY PRs you were @mentioned on in this chat (not all open PRs). If @dev pushed fixes, re-review. Post verdict on PR AND notify @dev here.
ALL: If nothing is assigned or pending for you, no-op quietly. Communicate via this chat by tagging agents. Your terminal is NOT visible.`;

// 5a0f882 / 21c5df0 — the V1 bare-`#<number>` queue-format built-in.
const LEGACY_QUEUE_FORMAT = `@head Check your OVERNIGHT-QUEUE.md formatting. Each Active Batch item must start with \`- #<number>\` (dash, space, hash, issue number). Do NOT use \`- Issue #598\` format — only \`- #598 description\`. The Current Batch panel won't recognize items in any other format. Fix if needed and confirm.`;

// The V2 repository-qualified wording the format built-in migrates to.
const QUALIFIED_QUEUE_FORMAT = `@head Check your OVERNIGHT-QUEUE.md formatting without changing repository identity. In V2, each Active Batch item must use the registered repository's exact \`- owner/repo#<number> description\` form. Never rewrite a qualified reference as bare \`#<number>\`; the same number may exist in multiple repositories. Only a pre-activation V1 single-repository queue may retain \`- #<number> description\`. Fix malformed items if needed and report any unknown repository visibly.`;

// --- the recovered bytes, pinned ------------------------------------------
assert.equal(sha(QUEUE_CHECK_TITLE), "905825bf64cf943142d9eba69d7069323871c819aaf45614aaed8ae226458c98",
  "the built-in pulse title is the em-dash spelling both generations shipped");
assert.equal(PRE_808_QUEUE_CHECK.length, 379, "pre-#808 pulse body length");
assert.equal(sha(PRE_808_QUEUE_CHECK), "e6394330c492a980722eab74e9b78d14398bc10650d6d409aac310fb1643b5fb",
  "pre-#808 pulse body is byte-exact 5a0f882");
assert.equal(QUEUE_CHECK_808.length, 796, "#808 pulse body length");
assert.equal(sha(QUEUE_CHECK_808), "481cb08c5b96b2ed627246250e1fb087de08b5944c0daa3ab91b3032ecb47306",
  "#808 pulse body is byte-exact 21c5df0");
assert.notEqual(PRE_808_QUEUE_CHECK, QUEUE_CHECK_808, "the two generations are genuinely different bodies");
assert.equal(sha(LEGACY_QUEUE_FORMAT), "4f2c52252f6a1b2afe2c201628478f3f7f8e07283187a2fbb3326f110922eb0e",
  "legacy queue-format body is byte-exact");
assert.equal(sha(QUALIFIED_QUEUE_FORMAT), "dd092f1f4b444a6ee1e0525d2474b8c56510e1f51c00c555f252ab8d08984578",
  "qualified queue-format body is byte-exact");

const GENERATIONS = [
  ["pre-#808 (5a0f882)", PRE_808_QUEUE_CHECK],
  ["#808 (21c5df0)", QUEUE_CHECK_808],
];

const survivor = { id: "default-4", title: "Agent Online Check", message: "@head Are you online?" };
const idsOf = (list) => list.map((entry) => (entry && typeof entry === "object" ? entry.id : entry));
const builtinPulse = (message) => ({ id: "default-1", title: QUEUE_CHECK_TITLE, message });

// --- the seed itself ------------------------------------------------------
assert.deepEqual(DEFAULT_PRESETS.map((p) => p.id), ["default-2", "default-3", "default-4"],
  "the retired pulse is not seeded into a fresh installation");
assert.equal(STORAGE_KEY, "qw-chat-presets", "storage key is the one shipped installations already wrote");
assert.equal(migratePresets(DEFAULT_PRESETS).changed, false, "the current seed needs no migration");

// --- every untouched generation is retired --------------------------------
for (const [label, message] of GENERATIONS) {
  const result = migratePresets([builtinPulse(message), survivor]);
  assert.equal(result.changed, true, `${label}: an untouched cached pulse is a change`);
  assert.deepEqual(idsOf(result.presets), ["default-4"], `${label}: the untouched cached pulse is removed`);
}

// --- a title-only edit is never deleted -----------------------------------
for (const [label, message] of GENERATIONS) {
  const renamed = { id: "default-1", title: "Morning pulse", message };
  const result = migratePresets([renamed, survivor]);
  assert.equal(result.changed, false, `${label}: a renamed pulse is not a migration`);
  assert.deepEqual(result.presets, [renamed, survivor], `${label}: a renamed pulse survives untouched`);
  assert.equal(result.presets[0], renamed, `${label}: a renamed pulse is returned by identity`);
}

// --- a body edit is never deleted -----------------------------------------
for (const [label, message] of GENERATIONS) {
  const edited = builtinPulse(`${message}\nAlso: check the staging box.`);
  const result = migratePresets([edited, survivor]);
  assert.equal(result.changed, false, `${label}: an edited body is not a migration`);
  assert.deepEqual(result.presets, [edited, survivor], `${label}: an edited body survives untouched`);
}

// --- mismatched title/body combinations are never deleted -----------------
const crossed = [
  { id: "default-1", title: QUEUE_FORMAT_TITLE, message: QUEUE_CHECK_808 },
  { id: "default-1", title: QUEUE_CHECK_TITLE, message: LEGACY_QUEUE_FORMAT },
  { id: "default-1", title: QUEUE_CHECK_TITLE, message: QUALIFIED_QUEUE_FORMAT },
  { id: "default-1", title: "", message: PRE_808_QUEUE_CHECK },
];
for (const entry of crossed) {
  const result = migratePresets([entry]);
  assert.equal(result.changed, false, `mismatched pair ${JSON.stringify(entry.title)} is not a built-in`);
  assert.deepEqual(result.presets, [entry], `mismatched pair ${JSON.stringify(entry.title)} survives`);
}

// --- a user-authored entry that merely copies a built-in body survives ----
for (const [label, message] of GENERATIONS) {
  const authored = { id: "preset-1748500000000", title: QUEUE_CHECK_TITLE, message };
  const result = migratePresets([authored]);
  assert.equal(result.changed, false, `${label}: a user-authored id is not a built-in`);
  assert.deepEqual(result.presets, [authored], `${label}: a user-authored copy survives`);
}

// --- malformed-but-parseable unrelated entries are preserved by identity --
const malformed = [null, "default-1", 42, [], {}, { id: "default-1" }, { id: "default-1", title: QUEUE_CHECK_TITLE }];
const malformedResult = migratePresets(malformed.slice());
assert.equal(malformedResult.changed, false, "malformed entries are not a migration");
assert.deepEqual(malformedResult.presets, malformed, "malformed entries survive verbatim");
assert.deepEqual(migratePresets([{ id: "default-1", title: QUEUE_CHECK_TITLE, message: null }]).presets,
  [{ id: "default-1", title: QUEUE_CHECK_TITLE, message: null }], "a null body is not a built-in body");
assert.throws(() => migratePresets({ id: "default-1" }), TypeError, "a non-array payload is rejected, not coerced");

// --- the queue-format migration still rewrites, and only the body ---------
const legacyFormat = { id: "default-3", title: QUEUE_FORMAT_TITLE, message: LEGACY_QUEUE_FORMAT };
const formatResult = migratePresets([legacyFormat, survivor]);
assert.equal(formatResult.changed, true, "a cached V1 queue-format built-in migrates");
assert.deepEqual(formatResult.presets, [
  { id: "default-3", title: QUEUE_FORMAT_TITLE, message: QUALIFIED_QUEUE_FORMAT },
  survivor,
], "the V1 queue-format body is replaced in place and nothing else moves");
assert.equal(legacyFormat.message, LEGACY_QUEUE_FORMAT, "the migration does not mutate its input");
assert.equal(migratePresets([{ id: "default-3", title: QUEUE_FORMAT_TITLE, message: QUALIFIED_QUEUE_FORMAT }]).changed,
  false, "an already-qualified queue-format preset is left alone");

// --- idempotence ----------------------------------------------------------
const mixed = [
  builtinPulse(PRE_808_QUEUE_CHECK),
  builtinPulse(QUEUE_CHECK_808),
  { id: "default-1", title: "Morning pulse", message: QUEUE_CHECK_808 },
  legacyFormat,
  survivor,
];
const once = migratePresets(mixed);
assert.equal(once.changed, true, "a mixed cache migrates");
assert.deepEqual(idsOf(once.presets), ["default-1", "default-3", "default-4"],
  "both retired generations go, the renamed one stays");
const twice = migratePresets(once.presets);
assert.equal(twice.changed, false, "re-running the migration changes nothing");
assert.deepEqual(twice.presets, once.presets, "re-running the migration returns the same list");

// --- storage is written only when the value actually changes --------------
function fakeStorage(initial) {
  const calls = [];
  let value = initial;
  return {
    calls,
    getItem: (key) => (key === STORAGE_KEY ? value : null),
    setItem: (key, next) => { calls.push([key, next]); value = next; },
  };
}

const empty = fakeStorage(null);
assert.deepEqual(loadPresetsFrom(empty), DEFAULT_PRESETS, "a fresh installation gets the built-ins");
assert.equal(empty.calls.length, 1, "a fresh installation is seeded exactly once");
assert.deepEqual(JSON.parse(empty.calls[0][1]).map((p) => p.id), ["default-2", "default-3", "default-4"],
  "the seeded payload is the built-in list");

const settled = fakeStorage(JSON.stringify([survivor]));
assert.deepEqual(loadPresetsFrom(settled), [survivor], "an already-migrated cache is returned as stored");
assert.equal(settled.calls.length, 0, "an already-migrated cache is never rewritten");

const stale = fakeStorage(JSON.stringify([builtinPulse(PRE_808_QUEUE_CHECK), legacyFormat, survivor]));
const loaded = loadPresetsFrom(stale);
assert.equal(stale.calls.length, 1, "a stale cache is rewritten exactly once");
assert.deepEqual(idsOf(loaded), ["default-3", "default-4"], "the stale pulse is gone after a load");
assert.deepEqual(JSON.parse(stale.calls[0][1]), loaded, "what was persisted is what was returned");
assert.equal(loadPresetsFrom(stale).length, 2, "a second load re-reads the rewritten cache");
assert.equal(stale.calls.length, 1, "a second load writes nothing further");

const broken = fakeStorage("{not json");
assert.deepEqual(loadPresetsFrom(broken), DEFAULT_PRESETS, "an unparseable cache falls back to the built-ins");
assert.equal(broken.calls.length, 0, "an unparseable cache is never clobbered");

console.log("chat preset migration tests passed");
