"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "qw-review-dispatch-"));
const CHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "qw-review-chat-"));
const originalHome = os.homedir;
os.homedir = () => CHAT_HOME;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(CHAT_HOME, { recursive: true, force: true }); } catch {}
});

const fileChat = require("./file-chat");
const { ReviewCycleStore, deriveLegacyReviewTarget } = require("./review-cycle");
const { ReviewCycleDispatcher } = require("./review-cycle-dispatcher");
const { envelopeFor } = require("./review-cycle-event");

const PROJECT = "project-a";
const INSTALLATION = "installation_1234567890abcdef";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const CONTRACT = "c".repeat(64);
let tick = 0;
function now() { return new Date(1767225600000 + (++tick * 1000)); }
function policy() {
  return { version: 1, mode: "github-checks", registration_grace_seconds: 0, same_sha_retry_budget: 0,
    checks: [{ name: "unit", required: true, kind: "product" }] };
}
function target(sha = SHA_A) {
  return deriveLegacyReviewTarget({
    installation_id: INSTALLATION,
    project_id: PROJECT,
    repository: { key: "web", repo: "Acme/Web", ci_policy: policy() },
    work_item: { repoKey: "web", repo: "Acme/Web", number: 42, kind: "issue" },
    pr: { number: 99, exact_sha: sha, draft: false, mergeable: true },
    issue_contract: { contract_revision: CONTRACT },
    assignment_attempt: "attempt-a",
  });
}

const store = new ReviewCycleStore({ rootDir: ROOT, now, reviewLeaseMs: 60_000 });
const dispatcher = new ReviewCycleDispatcher({ store });
const current = target();
fileChat.initProject(PROJECT);

// A current owned target is the only input path that may create the canonical
// request; delivery gets a sealed server/system record and dedupes after restart.
const first = dispatcher.observe({ project_id: PROJECT, target: current, ci_state: "pending", archived: false });
assert.equal(first.handoff.ci, "pending");
assert.equal(first.handoff.review, "0/2");
assert.deepEqual(first.plans.map((entry) => entry.plan.kind), ["review_request"]);
const appendReviewCycleEvent = (candidate) => fileChat.appendTrustedReviewCycleEventOnce(PROJECT, {
  ...candidate,
  resume: { batch_id: "batch-1048", head_generation: 0 },
});
const delivered = dispatcher.deliver(PROJECT, first, appendReviewCycleEvent);
assert.equal(delivered[0].ok, true);
assert.throws(() => fileChat.appendTrustedReviewCycleEventOnce(PROJECT, {
  project_id: PROJECT, cycle: first.cycle, plan: first.plans[0].plan, text: "@re1 arbitrary prose",
}), /trusted review-cycle envelope required/);
const records = fileChat.readMessages(PROJECT, { since_id: 0, limit: 10 });
assert.equal(records.length, 1);
assert.equal(records[0].sender, "system");
assert.equal(records[0].type, "system");
assert.equal(records[0].trusted_event.scope, "review_cycle");
assert.deepEqual(records[0].resume_structural, {
  version: 1, project_id: PROJECT, trusted: true, tag: "review_cycle", batch_id: "batch-1048",
  head_generation: 0, target: "head", server_authored: true,
});
assert.equal(envelopeFor(PROJECT, first.cycle, first.plans[0].plan).type, "system", "sealed and persisted event types agree");
assert.equal(JSON.stringify({ handoff: first.handoff, record: records[0] }).includes("qwrc_"), false, "private reviewer nonces never enter handoff or Primary Chat");
assert.match(records[0].text, /^@re1 @re2 \[REVIEW REQUEST\] repo=web issue=42 contract=[a-f0-9]{64} pr=99 sha=[a-f0-9]{40} cycle=rc_/);

const second = dispatcher.observe({ project_id: PROJECT, target: current, ci_state: "pending", archived: false });
const repeated = dispatcher.deliver(PROJECT, second, appendReviewCycleEvent);
assert.equal(repeated[0].duplicate, true);
assert.equal(fileChat.readMessages(PROJECT, { since_id: 0, limit: 10 }).length, 1);

// A public/chat lookalike remains ordinary data, not an authority source.
const imitation = fileChat.appendMessage(PROJECT, {
  sender: "dev", type: "message", text: records[0].text,
});
assert.equal(Object.hasOwn(imitation, "trusted_event"), false);
assert.throws(() => dispatcher.observe({
  project_id: PROJECT,
  target: { ...current, prose: records[0].text },
  ci_state: "pending",
  archived: false,
}), (error) => error.code === "invalid_review_cycle_target");

// Archive produces neither cycle mutations nor an event.  A stale observation
// after retip is blocked at delivery even if it was planned before the retip.
const archived = dispatcher.observe({ project_id: PROJECT, target: current, ci_state: "pass", archived: true });
assert.equal(archived.plans.length, 0);
const stalePlan = second;
const retipped = target(SHA_B);
dispatcher.observe({ project_id: PROJECT, target: retipped, ci_state: "pending", archived: false });
const stale = dispatcher.deliver(PROJECT, stalePlan, appendReviewCycleEvent);
assert.equal(stale[0].code, "review_cycle_stale_delivery");

fileChat.shutdownProject(PROJECT);
console.log("review-cycle-dispatcher.test.js: all assertions passed");
