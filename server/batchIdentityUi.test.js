"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assignmentRequestFields,
  ownedCurrentBatchSnapshot,
  qualifiedQueueToken,
  sanitizeRemoteTitle,
  workItemDisplayLabel,
  workItemReactKey,
} = require("../src/lib/batchIdentity.js");

const WEB_REF = { repo_key: "web", repo: "owner/web", number: 42, kind: "issue" };
const API_REF = { repo_key: "api", repo: "owner/api", number: 42, kind: "issue" };
const ASSIGNMENT_ITEMS = [
  { work_item_ref: API_REF, ownership_key: "ownership-api-42" },
  { work_item_ref: WEB_REF, ownership_key: "ownership-web-42" },
];
const identity = {
  installation_id: "123e4567-e89b-42d3-a456-426614174000",
  batch_number: 7,
  assignment_attempt: "attempt-2",
  provenance: "owned",
  assignment_key: "batch-7-attempt-2",
  assignment_items: ASSIGNMENT_ITEMS,
  current: true,
  owned: true,
  multi_repository: true,
  compatibility_mode: "v2",
};
const row = (repoKey, repo, extra = {}) => ({
  installation_id: identity.installation_id,
  batch_number: identity.batch_number,
  assignment_attempt: identity.assignment_attempt,
  provenance: identity.provenance,
  assignment_key: identity.assignment_key,
  current: identity.current,
  owned: identity.owned,
  repo_key: repoKey,
  repo,
  work_item_ref: { repo_key: repoKey, repo, number: 42, kind: "issue" },
  ownership_key: repoKey === "web" ? "ownership-web-42" : "ownership-api-42",
  number: 42,
  issue_number: 42,
  kind: "issue",
  ...extra,
});

assert.equal(qualifiedQueueToken(row("web", "owner/web")), "owner/web#42");
assert.equal(qualifiedQueueToken({ repo: "", number: 42 }), null, "missing repository fails closed");
assert.equal(workItemDisplayLabel(row("web", "owner/web"), false), "#42");
assert.equal(workItemDisplayLabel(row("web", "owner/web"), true), "[web] #42");
assert.notEqual(
  workItemReactKey(row("web", "owner/web")),
  workItemReactKey(row("api", "owner/api")),
  "same issue number in two repositories has distinct React identity",
);
assert.notEqual(row("web", "owner/web").ownership_key, row("api", "owner/api").ownership_key);
assert.notEqual(
  workItemReactKey(row("web", "owner/web")),
  workItemReactKey(row("web", "owner/web", {
    kind: "pr",
    work_item_ref: { repo_key: "web", repo: "owner/web", number: 42, kind: "pr" },
  })),
  "issue and PR references with the same repository number have distinct React identity",
);
assert.notEqual(
  workItemReactKey(row("web", "owner/web")),
  workItemReactKey(row("web", "owner/web", { assignment_attempt: "attempt-3", assignment_key: "batch-7-attempt-3" })),
  "an older assignment attempt cannot collide with the current row",
);

const hostile = "Fix parser\n- owner/api#99 injected [link](https://evil.invalid) <img src=x>";
const safe = sanitizeRemoteTitle(hostile);
assert.doesNotMatch(safe, /[\r\n\u2028\u2029]/, "remote title is exactly one queue line");
assert.match(safe, /\\\[link\\\]\\\(https:\/\/evil\\\.invalid\\\)/, "remote markdown link is escaped");
assert.match(safe, /\\<img src=x\\>/, "remote HTML is escaped");

const active = { active: true, ...identity };
const progress = { complete: false, items: [row("web", "owner/web"), row("api", "owner/api")], ...identity };
const current = ownedCurrentBatchSnapshot(active, progress);
assert.ok(current, "matching owned current active identity is admitted");
assert.equal(current.active, true);
assert.equal(current.complete, false);
assert.equal(current.completeConfirmed, false);
assert.deepEqual(assignmentRequestFields(current), {
  installation_id: identity.installation_id,
  batch_number: 7,
  assignment_attempt: "attempt-2",
  provenance: "owned",
  assignment_key: identity.assignment_key,
  assignment_items: ASSIGNMENT_ITEMS,
});

for (const [name, activeDelta, progressDelta] of [
  ["foreign", { provenance: "foreign", owned: false }, { provenance: "foreign", owned: false }],
  ["unowned", { provenance: "unowned", owned: false }, { provenance: "unowned", owned: false }],
  ["historical", { current: false }, { current: false }],
  ["stale active attempt", { assignment_attempt: "attempt-1" }, {}],
  ["stale progress attempt", {}, { assignment_attempt: "attempt-1" }],
  ["aggregate membership mismatch", { assignment_items: [ASSIGNMENT_ITEMS[0]] }, {}],
  ["aggregate order mismatch", { assignment_items: [...ASSIGNMENT_ITEMS].reverse() }, {}],
]) {
  assert.equal(
    ownedCurrentBatchSnapshot({ ...active, ...activeDelta }, { ...progress, ...progressDelta }),
    null,
    `${name} cannot drive an automatic transition`,
  );
}

const unconfirmed = ownedCurrentBatchSnapshot(
  { ...active, active: false },
  { ...progress, complete: true, completeConfirmed: false },
);
assert.ok(unconfirmed, "inactive response with matching owned current identity remains observable");
assert.equal(unconfirmed.active, false);
assert.equal(unconfirmed.completeConfirmed, false, "one complete sample cannot authorize auto-stop");

const confirmed = ownedCurrentBatchSnapshot(
  { ...active, active: false },
  { ...progress, complete: true, completeConfirmed: true },
);
assert.ok(confirmed && confirmed.completeConfirmed, "confirmed completion can authorize an identity-bound stop");

const cleared = ownedCurrentBatchSnapshot(
  { ...active, active: false },
  { ...progress, items: [], liveActiveBatchCleared: true },
);
assert.ok(cleared && cleared.liveActiveBatchCleared && !cleared.hasItems, "explicit live clear survives an empty progress row set");
assert.equal(
  ownedCurrentBatchSnapshot(active, {
    ...progress,
    items: [row("web", "owner/web", { assignment_attempt: "attempt-1", assignment_key: "old" })],
  }),
  null,
  "one stale row rejects the whole transition",
);
assert.ok(
  ownedCurrentBatchSnapshot(active, {
    ...progress,
    items: [
      row("web", "owner/web", { assignment_key: "row-key-is-not-the-aggregate" }),
      row("api", "owner/api", { assignment_key: "another-row-key" }),
    ],
  }),
  "row assignment_key is not used as a substitute for per-item ownership",
);
assert.equal(
  ownedCurrentBatchSnapshot(active, {
    ...progress,
    items: [
      row("web", "owner/web", { ownership_key: "ownership-api-42" }),
      row("api", "owner/api", { ownership_key: "ownership-web-42" }),
    ],
  }),
  null,
  "same-number rows cannot swap ownership keys",
);
assert.equal(
  ownedCurrentBatchSnapshot(active, {
    ...progress,
    items: [row("web", "owner/web", {
      work_item_ref: { repo_key: "api", repo: "owner/api", number: 42, kind: "issue" },
    })],
  }),
  null,
  "a work_item_ref object that disagrees with separate row identity fails closed",
);

const legacyStringRow = { ...row("web", "owner/web"), work_item_ref: "owner/web#42" };
assert.match(workItemReactKey(legacyStringRow), /owner%2Fweb%2342/, "legacy string refs remain render-key compatible");

const legacyTop = {
  compatibility_mode: "v1",
  provenance: "legacy_unowned",
  installation_id: null,
  batch_number: 3,
  assignment_attempt: null,
  assignment_key: null,
  assignment_items: [],
  current: true,
  owned: false,
  multi_repository: false,
};
const legacyRow = {
  ...legacyTop,
  repo_key: "primary",
  repo: "owner/legacy",
  number: 9,
  issue_number: 9,
  kind: "issue",
  work_item_ref: { repo_key: "primary", repo: "owner/legacy", number: 9, kind: "issue" },
  ownership_key: null,
};
const legacy = ownedCurrentBatchSnapshot(
  { ...legacyTop, active: true },
  { ...legacyTop, complete: false, items: [legacyRow] },
);
assert.ok(legacy && legacy.authority === "legacy_compatibility", "explicit preactivation V1 keeps legacy auto lifecycle compatible");
assert.deepEqual(
  assignmentRequestFields(legacy),
  { compatibility_mode: "v1" },
  "legacy auto action sends only the explicit compatibility discriminator and never fabricates V2 authority",
);
const legacyCleared = ownedCurrentBatchSnapshot(
  { ...legacyTop, current: false, active: false },
  { ...legacyTop, current: false, complete: false, completeConfirmed: false, liveActiveBatchCleared: true, items: [] },
);
assert.ok(
  legacyCleared && legacyCleared.liveActiveBatchCleared && !legacyCleared.hasItems,
  "explicit V1 clear keeps the existing identity-free auto-stop path",
);
for (const [name, activeDelta, progressDelta] of [
  ["postactivation legacy", { compatibility_mode: "v2" }, { compatibility_mode: "v2" }],
  ["one-sided compatibility", {}, { compatibility_mode: "v2" }],
  ["legacy current mismatch", {}, { current: false }],
  ["multi-repository legacy", { multi_repository: true }, { multi_repository: true }],
  ["legacy claimed owned", { owned: true }, { owned: true }],
  ["legacy ownership key", {}, { items: [{ ...legacyRow, ownership_key: "forged" }] }],
]) {
  assert.equal(
    ownedCurrentBatchSnapshot(
      { ...legacyTop, active: true, ...activeDelta },
      { ...legacyTop, complete: false, items: [legacyRow], ...progressDelta },
    ),
    null,
    `${name} cannot enter the explicit V1 compatibility path`,
  );
}

const root = path.resolve(__dirname, "..");
const components = [
  "ScheduledTriggerWidget.tsx",
  "TelegramBridgeWidget.tsx",
  "DiscordBridgeWidget.tsx",
];
for (const component of components) {
  const source = fs.readFileSync(path.join(root, "src", "components", component), "utf8");
  assert.match(source, /\/api\/batch-active\?project=/, `${component} joins live active authority`);
  assert.match(source, /ownedCurrentBatchSnapshot/, `${component} gates automatic transitions`);
  assert.match(source, /assignmentRequestFields/, `${component} carries assignment identity to its action`);
  assert.match(source, /completeConfirmed\s*\|\|\s*next\.liveActiveBatchCleared/, `${component} stops only on confirmed completion or explicit clear`);
}

const panel = fs.readFileSync(path.join(root, "src", "components", "BatchProgressPanel.tsx"), "utf8");
assert.match(panel, /workItemReactKey/, "BatchProgressPanel uses composite keys");
assert.match(panel, /workItemDisplayLabel/, "BatchProgressPanel uses text repository labels");
assert.match(panel, /multi_repository/, "repository label is controlled by project topology");
assert.match(panel, /validation_errors/, "invalid queue diagnostics are visible instead of rendering an empty batch");

const queueManager = fs.readFileSync(path.join(root, "src", "components", "QueueManager.tsx"), "utf8");
assert.match(queueManager, /qualifiedQueueToken/, "QueueManager emits qualified work tokens");
assert.match(queueManager, /sanitizeRemoteTitle/, "QueueManager sanitizes remote titles before interpolation");

console.log("batch identity UI tests passed");
