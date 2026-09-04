// #1073: shared, pure chat-preset storage migration.
// Plain JS is intentional: the Next.js UI imports it through `allowJs`, while
// the plain-node test runner can require the same production implementation
// instead of asserting on component source text.

const STORAGE_KEY = "qw-chat-presets";

const LEGACY_QUEUE_FORMAT_PRESET = `@head Check your OVERNIGHT-QUEUE.md formatting. Each Active Batch item must start with \`- #<number>\` (dash, space, hash, issue number). Do NOT use \`- Issue #598\` format — only \`- #598 description\`. The Current Batch panel won't recognize items in any other format. Fix if needed and confirm.`;
const QUALIFIED_QUEUE_FORMAT_PRESET = `@head Check your OVERNIGHT-QUEUE.md formatting without changing repository identity. In V2, each Active Batch item must use the registered repository's exact \`- owner/repo#<number> description\` form. Never rewrite a qualified reference as bare \`#<number>\`; the same number may exist in multiple repositories. Only a pre-activation V1 single-repository queue may retain \`- #<number> description\`. Fix malformed items if needed and report any unknown repository visibly.`;

// The retired all-agent pulse preset. The Monitor now writes structured events
// to @head only; an untouched cached copy of this built-in is dropped below.
// BOTH generations that ever shipped as `default-1` are listed. An installation
// that cached the defaults before #808 still holds the original body, which
// matched nothing, so its retired pulse survived every later load.
const QUEUE_CHECK_BUILTIN_TITLE = "Queue Check — Trigger";

// 5a0f882 [#617] — the original pulse.
const PRE_808_QUEUE_CHECK_PRESET = `@head @dev @re1 @re2 – Queue check.
@head: Merge any PR with both approvals, assign next from ~/.quadwork/{{project}}/OVERNIGHT-QUEUE.md.
@dev: Work on assigned ticket or address review feedback.
@re1 & @re2: Review open PRs. If @dev pushed fixes, re-review. Post verdict on PR AND notify @dev here.
ALL: Communicate via this chat by tagging agents. Your terminal is NOT visible.`;

// 21c5df0 [#808] — GITHUB.md-first discovery, @mention-scoped review.
const LEGACY_QUEUE_CHECK_PRESET = `@head @dev @re1 @re2 – Queue check.
Discovery: read ~/.quadwork/{{project}}/GITHUB.md (or GET /api/github-parsed?project={{project}}) for issue/PR state instead of running gh. If it's absent or stale (>2 cycles / _stale), do ONE direct gh read to confirm. GITHUB.md may lag — confirm with a direct gh read before any merge/review decision.
@head: Merge any PR with both approvals, assign next from ~/.quadwork/{{project}}/OVERNIGHT-QUEUE.md.
@dev: Work on assigned ticket or address review feedback.
@re1 & @re2: Review ONLY PRs you were @mentioned on in this chat (not all open PRs). If @dev pushed fixes, re-review. Post verdict on PR AND notify @dev here.
ALL: If nothing is assigned or pending for you, no-op quietly. Communicate via this chat by tagging agents. Your terminal is NOT visible.`;

// A cached built-in counts as untouched only when its id, title AND message all
// match a generation exactly. Matching on id + message alone silently deleted
// the preset of anyone who had renamed the built-in but kept its body.
const RETIRED_QUEUE_CHECK_BUILTINS = [
  { id: "default-1", title: QUEUE_CHECK_BUILTIN_TITLE, message: PRE_808_QUEUE_CHECK_PRESET },
  { id: "default-1", title: QUEUE_CHECK_BUILTIN_TITLE, message: LEGACY_QUEUE_CHECK_PRESET },
];

const DEFAULT_PRESETS = [
  {
    id: "default-2",
    title: "Suffix Reminder",
    message: `All agents: ignore numeric suffixes in your identity. dev, dev-1, dev-2 are the same Dev agent. re1, re1-2 are the same RE1. re2, re2-2 are the same RE2. head, head-2 are the same Head. When tagging others, use the base name (@dev, @re1, @re2, @head). When checking for mentions to you, match your base role name regardless of suffix.`,
  },
  {
    id: "default-3",
    title: "Check Queue Format",
    message: QUALIFIED_QUEUE_FORMAT_PRESET,
  },
  {
    id: "default-4",
    title: "Agent Online Check",
    message: `@head Are you online? If so, ping @dev, @re1, and @re2 to confirm whether they are online and available.`,
  },
];

function isPresetRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetiredQueueCheckBuiltin(preset) {
  if (!isPresetRecord(preset)) return false;
  return RETIRED_QUEUE_CHECK_BUILTINS.some(
    (builtin) =>
      preset.id === builtin.id &&
      preset.title === builtin.title &&
      preset.message === builtin.message
  );
}

function isLegacyQueueFormatBuiltin(preset) {
  return (
    isPresetRecord(preset) &&
    preset.id === "default-3" &&
    preset.message === LEGACY_QUEUE_FORMAT_PRESET
  );
}

/**
 * Migrate a parsed preset list. Only untouched built-ins are touched: a cached
 * copy of the retired all-agent pulse is dropped, and a cached copy of the V1
 * queue-format built-in is rewritten to the repository-qualified V2 wording.
 * Anything else — user edits, user-authored entries, unrelated records — is
 * returned by identity. `changed` is false whenever nothing was rewritten, so
 * the caller can leave storage untouched.
 */
function migratePresets(parsed) {
  if (!Array.isArray(parsed)) throw new TypeError("stored presets are not an array");
  let changed = false;
  const presets = [];
  for (const preset of parsed) {
    if (isRetiredQueueCheckBuiltin(preset)) {
      changed = true;
      continue;
    }
    if (isLegacyQueueFormatBuiltin(preset)) {
      changed = true;
      presets.push({ ...preset, message: QUALIFIED_QUEUE_FORMAT_PRESET });
      continue;
    }
    presets.push(preset);
  }
  return { presets, changed };
}

/**
 * Read, migrate and persist presets through any `getItem`/`setItem` storage.
 * Storage is written only on first seed or when the migration actually changed
 * something; an unmigratable payload falls back to the built-ins in memory
 * without overwriting whatever the user has stored.
 */
function loadPresetsFrom(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      storage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_PRESETS));
      return DEFAULT_PRESETS;
    }
    const { presets, changed } = migratePresets(JSON.parse(raw));
    if (changed) storage.setItem(STORAGE_KEY, JSON.stringify(presets));
    return presets;
  } catch {
    return DEFAULT_PRESETS;
  }
}

module.exports = {
  DEFAULT_PRESETS,
  STORAGE_KEY,
  loadPresetsFrom,
  migratePresets,
};
