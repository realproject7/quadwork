// #1031: repository-qualified batch identity and ownership integration.
// Plain node:assert script.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const INSTALLATION_ID = "installation_0000000000000001";
const repositories = [
  { key: "web", repo: "Acme/Web", working_dir: "/tmp/web", primary: true },
  { key: "api", repo: "Acme/API", working_dir: "/tmp/api", primary: false },
];
let config = { installation_id: INSTALLATION_ID, projects: [{ id: "p", repositories }] };
let queue = "";
let writtenSnapshot = null;
let githubFileText = null;
let ghCalls = 0;

const realRead = fs.readFileSync;
const realExec = cp.execFile;
fs.readFileSync = function readStub(file, ...rest) {
  if (file === CONFIG_PATH) return JSON.stringify(config);
  if (typeof file === "string" && file.endsWith("OVERNIGHT-QUEUE.md")) return queue;
  if (typeof file === "string" && file.endsWith("batch-progress-cache.json")) {
    if (writtenSnapshot) return JSON.stringify(writtenSnapshot);
    const error = new Error("missing snapshot"); error.code = "ENOENT"; throw error;
  }
  if (typeof file === "string" && file.endsWith("GITHUB.md")) {
    if (githubFileText !== null) return githubFileText;
    const error = new Error("missing board"); error.code = "ENOENT"; throw error;
  }
  return realRead.call(this, file, ...rest);
};
fs.writeFileSync = function writeStub(file, data) {
  if (typeof file === "string" && file.endsWith("batch-progress-cache.json")) writtenSnapshot = JSON.parse(data);
};
fs.mkdirSync = () => {};
fs.statSync = () => ({ mode: 0o700, isDirectory: () => true });
fs.renameSync = () => {};
fs.unlinkSync = () => {};
cp.execFile = function execStub(file, args, opts, callback) {
  ghCalls += 1;
  const cb = typeof opts === "function" ? opts : callback;
  if (typeof cb === "function") return cb(new Error("unexpected gh call"), "", "");
  return realExec.apply(this, arguments);
};

const routes = require("./routes");
const { renderProjectGithubMarkdown } = require("./github-state-markdown");
const { workItemKey } = require("./work-item-ref");
const {
  parseActiveBatch,
  parseReviewItems,
  getOrComputeBatchProgress,
  progressFromSnapshot,
  progressFromGithubFile,
  progressForItemRest,
  pickLinkedPrFromSearch,
  validateCurrentOwnedAssignment,
  readLiveBatchContext,
  _batchProgressCache,
  _graphqlCache,
} = routes;

function active(lines, { type = "code", attempt = "attempt_a", installation = INSTALLATION_ID } = {}) {
  return [
    "# Overnight Queue", "", "## Active Batch", "", "**Batch:** 12",
    `**Batch type:** ${type}`,
    `**Installation ID:** ${installation}`,
    `**Assignment attempt:** ${attempt}`,
    "", ...lines, "", "## Holds", "", "- Acme/Web#999 ignored hold",
  ].join("\n");
}

async function run() {
  // Composite grammar: same number on two repositories is valid and distinct.
  queue = active(["- Acme/Web#42 first", "- Acme/API#42 second"]);
  let parsed = parseActiveBatch(queue, { repositories, installationId: INSTALLATION_ID });
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.provenance, "owned");
  assert.equal(parsed.workItems.length, 2);
  assert.notEqual(parsed.workItems[0].key, parsed.workItems[1].key);
  assert.deepEqual(parsed.workItems.map((item) => item.repoKey), ["web", "api"]);

  // Multi-repo bare, unknown, malformed, and duplicate refs fail the whole parse.
  for (const [line, code] of [
    ["- #42 ambiguous", "bare_ref_forbidden"],
    ["- Other/Repo#42 unknown", "unknown_repository"],
    ["- Acme/Web#0 malformed", "invalid_work_item_number"],
  ]) {
    parsed = parseActiveBatch(active([line]), { repositories, installationId: INSTALLATION_ID });
    assert.equal(parsed.errors[0]?.code, code, line);
  }
  parsed = parseActiveBatch(active(["- Acme/Web#42 first", "- acme/web#42 duplicate"]), { repositories, installationId: INSTALLATION_ID });
  assert.equal(parsed.errors[0]?.code, "duplicate_work_item_ref");
  for (const malformedLine of [
    "- Other/Repo#42 unknown",
    "- Other/Repo #42 unknown split",
    "- Other/repo.js #42 unknown split",
    "- Acme//Web#42 malformed",
    "- [Other/Repo #42] bracketed split",
    "- [Acme//Web#42] bracketed malformed",
  ]) {
    parsed = parseActiveBatch(active(["- Acme/Web#41 valid", malformedLine]), { repositories, installationId: INSTALLATION_ID });
    assert.ok(parsed.errors.length > 0, `${malformedLine} must reject the whole assignment instead of executing a valid subset`);
  }
  parsed = parseActiveBatch(active(["- https://docs.example/path#anchor prose", "- Acme/Web#41 valid"]), { repositories, installationId: INSTALLATION_ID });
  assert.equal(parsed.errors.length, 0, "URL prose retains the existing ignored-line behavior");
  assert.deepEqual(parsed.issueNumbers, [41]);

  // Queue metadata is structure, never an item-title substring. A hostile
  // remote title cannot mint local ownership or switch the batch execution mode.
  const injectedTitleQueue = [
    "## Active Batch",
    `- Acme/Web#42 remote **Batch:** 12 **Batch type:** ticket-review **Installation ID:** ${INSTALLATION_ID} **Assignment attempt:** injected`,
  ].join("\n");
  parsed = parseActiveBatch(injectedTitleQueue, { repositories, installationId: INSTALLATION_ID });
  assert.equal(parsed.batchNumber, null);
  assert.notEqual(parsed.provenance, "owned");
  assert.equal(routes.parseBatchType(injectedTitleQueue), "code");
  const duplicateBatchMetadata = [
    "## Active Batch", "**Batch:** 12", "Batch: 13",
    `**Installation ID:** ${INSTALLATION_ID}`, "**Assignment attempt:** attempt_a", "- Acme/Web#42 valid",
  ].join("\n");
  parsed = parseActiveBatch(duplicateBatchMetadata, { repositories, installationId: INSTALLATION_ID });
  assert.equal(parsed.batchNumber, null, "mixed accepted Batch syntaxes are one duplicate metadata namespace");
  assert.notEqual(parsed.provenance, "owned");

  const conflictingBatchTypes = [
    "## Active Batch", "**Batch:** 12", "**Batch type:** pr-review", "**Batch type:** code",
    `**Installation ID:** ${INSTALLATION_ID}`, "**Assignment attempt:** attempt_a", "- Acme/Web#42 valid",
  ].join("\n");
  parsed = parseActiveBatch(conflictingBatchTypes, { repositories, installationId: INSTALLATION_ID });
  assert.equal(parsed.errors[0]?.code, "duplicate_batch_type");
  assert.notEqual(parsed.provenance, "owned", "ambiguous execution mode must never mint an owned assignment");

  // A compact single-repo token remains parse-compatible but is never stamped
  // as V2-owned merely because installation metadata exists.
  parsed = parseActiveBatch(active(["- #42 legacy"]), { repositories: [repositories[0]], installationId: INSTALLATION_ID });
  assert.deepEqual(parsed.issueNumbers, [42]);
  assert.equal(parsed.provenance, "unowned");
  assert.equal(parsed.assignmentKey, null);

  // Review parsing keeps repository identity even when numbers collide.
  const review = parseReviewItems(active([
    "- Acme/Web#42 — approved",
    "- Acme/API#42 — in-review (1/2)",
  ], { type: "ticket-review" }), { repositories });
  assert.deepEqual(review.map((item) => [item.ref.repoKey, item.issue, item.review_state]), [
    ["web", 42, "approved"], ["api", 42, "in-review"],
  ]);

  // Invalid activated batches are visible diagnostics and make zero GitHub calls.
  ghCalls = 0;
  queue = active(["- #42 ambiguous"]);
  _batchProgressCache.clear();
  let payload = await getOrComputeBatchProgress("p");
  assert.equal(payload.current, true);
  assert.equal(payload.owned, false);
  assert.equal(payload.validation_errors[0].code, "bare_ref_forbidden");
  assert.equal(payload.multi_repository, true);
  assert.equal(ghCalls, 0);

  queue = conflictingBatchTypes;
  _batchProgressCache.clear();
  payload = await getOrComputeBatchProgress("p");
  assert.equal(payload.current, true);
  assert.equal(payload.owned, false);
  assert.equal(payload.validation_errors[0]?.code, "duplicate_batch_type");
  assert.equal(ghCalls, 0, "ambiguous batch type must not perform execution-side GitHub work");

  // Owned code rows resolve each same-number item from its own repository cache.
  queue = active(["- Acme/Web#42 first", "- Acme/API#42 second"]);
  _batchProgressCache.clear();
  _graphqlCache.clear();
  _graphqlCache.set("acme/web", {
    ts: 100,
    issues: [{ number: 42, title: "web issue", state: "OPEN", url: "https://x/web/42" }],
    prs: [], closedIssues: [], mergedPrs: [],
    openPrsWindowComplete: true, closedPrsWindowComplete: true, closedPrIssueNums: [],
  });
  _graphqlCache.set("acme/api", {
    ts: 100,
    issues: [], prs: [],
    closedIssues: [{ number: 42, title: "api issue", state: "CLOSED", url: "https://x/api/42" }],
    mergedPrs: [{ number: 77, title: "[#42] api", state: "MERGED", url: "https://x/api/pr/77" }],
    openPrsWindowComplete: true, closedPrsWindowComplete: true, closedPrIssueNums: [42],
  });
  ghCalls = 0;
  payload = await getOrComputeBatchProgress("p");
  assert.equal(payload.owned, true);
  assert.equal(payload.current, true);
  assert.equal(payload.items.length, 2);
  assert.deepEqual(payload.items.map((item) => [item.repo_key, item.issue_number, item.status]), [
    ["web", 42, "queued"], ["api", 42, "merged"],
  ]);
  assert.ok(payload.items.every((item) =>
    item.number === item.work_item_ref.number && item.kind === item.work_item_ref.kind));
  assert.notEqual(payload.items[0].assignment_key, null);
  assert.equal(payload.assignment_items.length, 2);
  assert.ok(payload.items.every((item) => typeof item.ownership_key === "string"));
  assert.deepEqual(
    payload.items.map((item) => item.ownership_key).sort(),
    payload.assignment_items.map((item) => item.ownership_key).sort(),
  );
  assert.equal(writtenSnapshot.schema_version, 2);
  assert.equal(Object.keys(writtenSnapshot.terminalItems).length, 1);
  assert.equal(ghCalls, 0);

  // Reopening preserves the same owned assignment and composite WorkItemRef.
  // An incomplete live snapshot cannot fully classify the row, but its OPEN
  // issue signal must still defeat and evict the prior merged terminal cache.
  const terminalSnapshot = JSON.parse(JSON.stringify(writtenSnapshot));
  const apiTerminalKey = Object.keys(terminalSnapshot.terminalItems)[0];
  const webTerminalKey = workItemKey({ repoKey: "web", repo: "Acme/Web", number: 42, kind: "issue" });
  const webOwnershipKey = terminalSnapshot.assignment_items.find((entry) =>
    entry.work_item_ref.repo_key === "web").ownership_key;
  terminalSnapshot.terminalItems[webTerminalKey] = {
    ...terminalSnapshot.terminalItems[apiTerminalKey],
    repo_key: "web",
    repo: "Acme/Web",
    title: "web terminal evidence",
    ownership_key: webOwnershipKey,
    work_item_ref: { repo_key: "web", repo: "Acme/Web", number: 42, kind: "issue" },
  };
  writtenSnapshot = JSON.parse(JSON.stringify(terminalSnapshot));
  _batchProgressCache.clear();
  _graphqlCache.set("acme/web", {
    ts: 101,
    issues: [], prs: [], closedIssues: [], mergedPrs: [],
    openPrsWindowComplete: false, closedPrsWindowComplete: false, closedPrIssueNums: [],
  });
  _graphqlCache.set("acme/api", {
    ts: 101,
    issues: [{ number: 42, title: "api issue reopened", state: "OPEN", url: "https://x/api/42" }],
    prs: [], closedIssues: [], mergedPrs: [],
    openPrsWindowComplete: false, closedPrsWindowComplete: false, closedPrIssueNums: [],
  });
  payload = await getOrComputeBatchProgress("p");
  let reopenedApi = payload.items.find((item) => item.repo_key === "api");
  assert.equal(reopenedApi.status, "queued");
  assert.equal(reopenedApi.live_pr, null);
  assert.equal(writtenSnapshot.terminalItems[apiTerminalKey], undefined,
    "live OPEN snapshot evidence evicts the stale composite terminal row");
  assert.equal(payload.items.find((item) => item.repo_key === "web").status, "merged");
  assert.ok(writtenSnapshot.terminalItems[webTerminalKey],
    "same-number terminal evidence for another repository remains isolated");

  // The cold persisted-board path has the same rule. A recently merged PR can
  // make row derivation ambiguous while the issue is OPEN; that ambiguity must
  // degrade to retrying, never resurrect the cached merged result.
  writtenSnapshot = JSON.parse(JSON.stringify(terminalSnapshot));
  _batchProgressCache.clear();
  _graphqlCache.clear();
  githubFileText = renderProjectGithubMarkdown("P", [
    {
      repo_key: "web", repo: "Acme/Web", primary: true,
      snapshot: { issues: [], prs: [], closedIssues: [], mergedPrs: [] },
      meta: { generatedAt: Date.now(), staleCycles: 0 },
    },
    {
      repo_key: "api", repo: "Acme/API", primary: false,
      snapshot: {
        issues: [{ number: 42, title: "api issue reopened", state: "OPEN", url: "https://x/api/42", assignees: [] }],
        prs: [], closedIssues: [],
        mergedPrs: [{ number: 77, title: "[#42] old merge", state: "MERGED", url: "https://x/api/pr/77", assignees: [] }],
      },
      meta: { generatedAt: Date.now(), staleCycles: 0 },
    },
  ], "(none)");
  payload = await getOrComputeBatchProgress("p");
  reopenedApi = payload.items.find((item) => item.repo_key === "api");
  assert.equal(reopenedApi.status, "queued");
  assert.equal(reopenedApi.live_pr, null);
  assert.equal(writtenSnapshot.terminalItems[apiTerminalKey], undefined,
    "persisted OPEN evidence evicts the stale composite terminal row");
  assert.ok(writtenSnapshot.terminalItems[webTerminalKey],
    "persisted evidence eviction remains scoped to the qualified repository");
  githubFileText = null;
  _graphqlCache.set("acme/web", {
    ts: 100,
    issues: [{ number: 42, title: "web issue", state: "OPEN", url: "https://x/web/42" }],
    prs: [], closedIssues: [], mergedPrs: [],
    openPrsWindowComplete: true, closedPrsWindowComplete: true, closedPrIssueNums: [],
  });
  _graphqlCache.set("acme/api", {
    ts: 100,
    issues: [], prs: [],
    closedIssues: [{ number: 42, title: "api issue", state: "CLOSED", url: "https://x/api/42" }],
    mergedPrs: [{ number: 77, title: "[#42] api", state: "MERGED", url: "https://x/api/pr/77" }],
    openPrsWindowComplete: true, closedPrsWindowComplete: true, closedPrIssueNums: [42],
  });

  const codeFingerprint = readLiveBatchContext("p").fingerprint;
  queue = active(["- Acme/Web#42 queued", "- Acme/API#42 queued"], { type: "ticket-review" });
  const reviewFingerprint = readLiveBatchContext("p").fingerprint;
  assert.notEqual(reviewFingerprint, codeFingerprint, "batch type participates in the live assignment observation fingerprint");
  payload = await getOrComputeBatchProgress("p");
  assert.equal(payload.batch_type, "ticket-review", "code cache cannot survive an immediate review-mode rollover");
  assert.ok(payload.items.every((item) => item.review_state === "queued"));

  // Attempt rollover invalidates the 10s project cache immediately.
  const oldKey = payload.assignment_key;
  queue = active(["- Acme/Web#42 first", "- Acme/API#42 second"], { attempt: "attempt_b", type: "code" });
  payload = await getOrComputeBatchProgress("p");
  assert.notEqual(payload.assignment_key, oldKey);
  assert.equal(payload.assignment_attempt, "attempt_b");

  // Automated callers may send the exact assignment set in any order, but
  // malformed or duplicate per-item identity still fails closed.
  const assignmentBody = {
    installation_id: payload.installation_id,
    batch_number: payload.batch_number,
    assignment_attempt: payload.assignment_attempt,
    provenance: payload.provenance,
    assignment_key: payload.assignment_key,
    assignment_items: [...payload.assignment_items].reverse(),
  };
  assert.equal(validateCurrentOwnedAssignment("p", assignmentBody).ok, true);
  assert.equal(validateCurrentOwnedAssignment("p", {
    ...assignmentBody,
    assignment_items: [payload.assignment_items[0], payload.assignment_items[0]],
  }).ok, false);
  assert.equal(validateCurrentOwnedAssignment("p", { provenance: "foreign" }).ok, false,
    "provenance-only automated bodies are partial identity, never manual actions");
  assert.equal(validateCurrentOwnedAssignment("p", { ...assignmentBody, provenance: "foreign" }).ok, false,
    "full automated bodies must carry exact owned provenance");

  const beforeForeignRollover = readLiveBatchContext("p");
  queue = active(["- Acme/Web#42 first", "- Acme/API#42 second"], {
    attempt: "attempt_b",
    installation: "installation_9999999999999999",
  });
  const afterForeignRollover = readLiveBatchContext("p");
  assert.notEqual(afterForeignRollover.fingerprint, beforeForeignRollover.fingerprint,
    "TOCTOU fingerprint includes serialized installation/provenance changes");

  // An explicit activated clear is an exact owned empty-set assignment. It is
  // inactive/current:false but remains route-revalidatable for stop actions.
  queue = active([], { attempt: "attempt_b" });
  _batchProgressCache.clear();
  payload = await getOrComputeBatchProgress("p");
  assert.equal(payload.liveActiveBatchCleared, true);
  assert.equal(payload.current, false);
  assert.equal(payload.owned, true);
  assert.deepEqual(payload.assignment_items, []);
  assert.equal(validateCurrentOwnedAssignment("p", {
    installation_id: payload.installation_id,
    batch_number: payload.batch_number,
    assignment_attempt: payload.assignment_attempt,
    provenance: payload.provenance,
    assignment_key: payload.assignment_key,
    assignment_items: payload.assignment_items,
  }).ok, true);
  parsed = parseActiveBatch(active([], { attempt: "bad!" }), { repositories, installationId: INSTALLATION_ID });
  assert.equal(parsed.assignmentKey, null, "empty-set clear still validates opaque assignment-attempt syntax");
  assert.notEqual(parsed.provenance, "owned");

  // Preactivation one-repository bare queues remain explicitly V1-compatible
  // without being promoted to V2 ownership.
  config = { projects: [{ id: "p", repo: "Acme/Web", working_dir: "/tmp/web" }] };
  queue = ["## Active Batch", "**Batch:** 13", "- #42 legacy"].join("\n");
  writtenSnapshot = null;
  _batchProgressCache.clear();
  payload = await getOrComputeBatchProgress("p");
  assert.equal(payload.compatibility_mode, "v1");
  assert.equal(payload.provenance, "legacy_unowned");
  assert.equal(payload.owned, false);
  assert.equal(payload.items[0].issue_number, 42);
  assert.equal(typeof payload.batch_observation_fingerprint, "string");
  const liveV1Fingerprint = payload.batch_observation_fingerprint;
  assert.equal(validateCurrentOwnedAssignment("p", { admission_generation: 0 }).ok, false);
  assert.equal(validateCurrentOwnedAssignment("p", {
    compatibility_mode: "v1",
    batch_observation_fingerprint: payload.batch_observation_fingerprint,
  }).legacy, true);

  queue = ["## Active Batch", "**Batch:** 13"].join("\n");
  _batchProgressCache.clear();
  payload = await getOrComputeBatchProgress("p");
  assert.equal(payload.compatibility_mode, "v1");
  assert.equal(payload.liveActiveBatchCleared, true);
  assert.notEqual(payload.batch_observation_fingerprint, liveV1Fingerprint);
  assert.equal(validateCurrentOwnedAssignment("p", {
    compatibility_mode: "v1",
    batch_observation_fingerprint: liveV1Fingerprint,
  }).ok, false, "an earlier V1 observation cannot reauthorize against the next queue state");
  assert.equal(validateCurrentOwnedAssignment("p", { compatibility_mode: "v1" }).ok, false);
  assert.equal(validateCurrentOwnedAssignment("p", {
    compatibility_mode: "v1",
    batch_observation_fingerprint: payload.batch_observation_fingerprint,
  }).legacy, true);

  queue = ["## Active Batch", "**Batch:** 13", "- Acme/Web#42 qualified"].join("\n");
  const qualifiedLegacy = validateCurrentOwnedAssignment("p", { admission_generation: 0 });
  assert.equal(qualifiedLegacy.ok, false, "preactivation qualified refs are not V1 compatibility assignments");
  config = { installation_id: INSTALLATION_ID, projects: [{ id: "p", repositories }] };

  // Persisted multi-repo board projection selects the requested group only.
  const persisted = {
    ok: true,
    repositories: [
      { repo_key: "web", repo: "Acme/Web", issues: [{ number: 42, title: "web", url: "w" }], prs: [], closedIssues: [], mergedPrs: [], reviewDetail: {} },
      { repo_key: "api", repo: "Acme/API", issues: [], prs: [{ number: 8, title: "#42 api", state: "OPEN", url: "p", tip: "api-tip" }], closedIssues: [], mergedPrs: [], reviewDetail: {} },
    ],
  };
  const fromFile = progressFromGithubFile(persisted, 42, { repoKey: "api", repo: "Acme/API", number: 42, kind: "issue" });
  assert.equal(fromFile.pr_number, 8);
  assert.equal(fromFile.live_pr.state, "OPEN");
  for (const state of [undefined, "CLOSED", "MERGED"]) {
    const unprovenOpen = progressFromSnapshot({
      issues: [{ number: 42, title: "issue", state: "OPEN", url: "issue" }],
      prs: [{ number: 7, title: "[#42] no proof", state, url: "pr", reviews: [] }],
      mergedPrs: [], closedIssues: [],
      openPrsWindowComplete: true, closedPrsWindowComplete: true, closedPrIssueNums: [],
    }, 42);
    assert.notEqual(unprovenOpen?.status, "in_review");
    assert.notEqual(unprovenOpen?.status, "ready");
    assert.equal(unprovenOpen?.live_pr == null, true);
    const persistedUnproven = progressFromGithubFile({
      ok: true,
      openIssues: [{ number: 42, title: "issue", state: "OPEN", url: "issue" }],
      openPRs: [{ number: 7, title: "#42 no proof", state, url: "pr" }],
      mergedPrs: [], closedIssues: [], reviewDetail: { 7: { re1: { state: "APPROVED" }, re2: { state: "APPROVED" } } },
    }, 42);
    assert.notEqual(persistedUnproven?.status, "in_review");
    assert.notEqual(persistedUnproven?.status, "ready");
    assert.equal(persistedUnproven?.live_pr == null, true);
  }
  const openWithoutTip = progressFromSnapshot({
    issues: [{ number: 42, title: "issue", state: "OPEN", url: "issue" }],
    prs: [{ number: 7, title: "[#42] explicit open", state: "OPEN", url: "pr", reviews: [] }],
    mergedPrs: [], closedIssues: [],
  }, 42, { requireLiveRef: true });
  assert.equal(openWithoutTip, null, "a V2 live row is unproven unless OPEN proof also has number, URL, and tip");

  // OPEN replacement wins over a newer historical merged PR; historical-only
  // lookup can never produce a live/ready row.
  assert.equal(pickLinkedPrFromSearch([
    { number: 90, title: "[#42] old", state: "closed", pull_request: { merged_at: "2026-01-01" } },
    { number: 80, title: "[#42] replacement", state: "open", pull_request: {} },
  ], 42, { issueState: "OPEN" }), 80);
  const calls = [];
  const row = await progressForItemRest("Acme/Web", 42, () => true, {
    searchLinkedPrItems: async () => [{ number: 90, title: "[#42] old", state: "closed", pull_request: { merged_at: "2026-01-01" } }],
    ghJsonExecAsync: async (args) => {
      calls.push(args.join(" "));
      if (args[1].endsWith("/issues/42")) return { number: 42, title: "active", state: "open", html_url: "issue" };
      if (args[1].endsWith("/pulls/90")) return { number: 90, state: "closed", merged: true, html_url: "old", head: { sha: "old-tip" } };
      throw new Error("reviews must not be fetched for historical PR");
    },
  });
  assert.equal(row.status, "queued");
  assert.equal(row.live_pr, null);
  assert.equal(row.historical_pr.state, "MERGED");
  assert.equal(calls.some((call) => call.includes("/reviews")), false);

  const replacement = await progressForItemRest("Acme/Web", 42, () => true, {
    searchLinkedPrItems: async () => [
      { number: 90, title: "[#42] old", state: "closed", pull_request: { merged_at: "2026-01-01" } },
      { number: 80, title: "[#42] replacement", state: "open", pull_request: {} },
    ],
    ghJsonExecAsync: async (args) => {
      if (args[1].endsWith("/issues/42")) return { number: 42, title: "active", state: "open", html_url: "issue" };
      if (args[1].endsWith("/pulls/80")) return { number: 80, state: "open", merged: false, html_url: "new", head: { sha: "new-tip" } };
      if (args[1].endsWith("/pulls/80/reviews?per_page=100")) return [];
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  });
  assert.equal(replacement.status, "in_review");
  assert.deepEqual(replacement.live_pr, { number: 80, url: "new", state: "OPEN", tip: "new-tip" });

  const closedUnmerged = await progressForItemRest("Acme/Web", 43, () => true, {
    searchLinkedPrItems: async () => [{ number: 91, title: "[#43] closed", state: "closed", pull_request: {} }],
    ghJsonExecAsync: async (args) => {
      if (args[1].endsWith("/issues/43")) return { number: 43, title: "closed", state: "closed", html_url: "issue43" };
      if (args[1].endsWith("/pulls/91")) return { number: 91, state: "closed", merged: false, html_url: "closed-pr", head: { sha: "closed-tip" } };
      if (args[1].includes("timeline")) return [];
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  });
  assert.equal(closedUnmerged.live_pr, null);
  assert.equal(closedUnmerged.historical_pr.state, "CLOSED");
  assert.notEqual(closedUnmerged.status, "ready");
  assert.notEqual(closedUnmerged.status, "in_review");

  const detailFailure = await progressForItemRest("Acme/Web", 44, () => true, {
    searchLinkedPrItems: async () => [{ number: 92, title: "[#44] unknown", state: "open", pull_request: {} }],
    ghJsonExecAsync: async (args) => {
      if (args[1].endsWith("/issues/44")) return { number: 44, title: "unknown", state: "open", html_url: "issue44" };
      throw new Error("pull detail unavailable");
    },
  });
  assert.equal(detailFailure.live_pr, null);
  assert.equal(detailFailure.status, "queued");
  assert.notEqual(detailFailure.status, "ready");
  assert.notEqual(detailFailure.status, "in_review");

  console.log("routes.workItemRefBatch.test.js: all assertions passed");
}

run().finally(() => {
  fs.readFileSync = realRead;
  cp.execFile = realExec;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
