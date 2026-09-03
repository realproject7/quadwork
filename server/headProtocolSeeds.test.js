// #1033: shipped Head/worker seeds must agree on PO authority, review routing,
// terminal status, and feature-gated compatibility. Plain node:assert.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const head = read("templates/seeds/head.AGENTS.md");
const dev = read("templates/seeds/dev.AGENTS.md");
const re1 = read("templates/seeds/re1.AGENTS.md");
const re2 = read("templates/seeds/re2.AGENTS.md");
const playbook = read("templates/seeds/HEAD-PO-PLAYBOOK.md");
const reviewDocs = read("docs/review-batches.md");
const allContracts = [head, dev, re1, re2, playbook, reviewDocs].join("\n");

assert.ok(head.split("\n").length < 140, "always-loaded Head seed stays concise");
assert.ok(head.includes("~/.quadwork/{{project_id}}/HEAD-PO-PLAYBOOK.md"));
assert.ok(!head.includes("memory/head.md"), "Head has no private workflow-state file");
for (const phrase of ["Mandatory session start", "Authority and boundaries", "Assignment and status authority", "Gate, merge, and closure"]) {
  assert.ok(head.includes(phrase), `Head seed includes ${phrase}`);
}
for (const status of ["STATUS DONE", "STATUS WAITING", "STATUS BLOCKED"]) {
  for (const [name, seed] of [["head", head], ["dev", dev], ["re1", re1], ["re2", re2]]) {
    assert.ok(seed.includes(status), `${name} seed includes ${status}`);
  }
}

const assignment = "[ASSIGN REVIEW-BATCH] installation_id=<id> repo=<repo-key> batch=<n> item=<owner/repo#n> attempt=<id> mode=<ticket-review|pr-review> revision=<issue-body-sha256|pr-sha>";
for (const [name, text] of [["head", head], ["re1", re1], ["re2", re2], ["playbook", playbook], ["docs", reviewDocs]]) {
  assert.ok(text.includes(assignment), `${name} carries the exact review-only assignment contract`);
}
assert.ok(dev.includes("Dev has no role in `ticket-review` or `pr-review`"));
assert.ok(!dev.includes("you are the **review driver**"));
assert.ok(reviewDocs.includes("Head-driven, review-only"));
assert.ok(reviewDocs.includes("Dev has no review-driver"));

// #1051: RE1 and RE2 have the same narrowly-scoped, idempotent ticket-review
// comment policy. It is evidence only: Head still owns state transitions and
// batch closure, and the policy must not be mistaken for a credential control.
for (const [name, seed, role] of [["re1", re1, "RE1"], ["re2", re2, "RE2"]]) {
  assert.ok(seed.includes("One explicitly gated `gh issue comment`"),
    `${name} allows only the explicit ticket-review comment exception`);
  assert.ok(seed.includes("server-authenticated, Head-qualified"),
    `${name} requires a current Head-qualified assignment`);
  assert.ok(seed.includes("issue_contract_revision"),
    `${name} calls the project/agent-bound issue revision operation`);
  assert.ok(seed.includes("current server-issued `contract_revision`"),
    `${name} requires the current server-issued revision`);
  assert.ok(seed.includes("only `repo_key` and `issue`"),
    `${name} supplies only the role-bound revision inputs`);
  assert.ok(seed.includes("never** reproduce, hash, or derive its revision locally"),
    `${name} never derives the issue revision locally`);
  assert.ok(seed.includes("live `main` ref SHA"),
    `${name} records a live main SHA`);
  assert.ok(seed.includes("quadwork-ticket-review-v1"),
    `${name} carries the idempotency marker`);
  assert.ok(seed.includes(`reviewer=${role}`),
    `${name} binds the marker to its reviewer identity`);
  assert.ok(seed.includes(`- Role: ${role}`),
    `${name} requires an explicit reviewer role in the verdict body`);
  assert.ok(seed.includes("make **at most one** `gh issue comment` call"),
    `${name} limits a full assignment identity to one comment write`);
  assert.ok(seed.includes("Immediately re-read live comments"),
    `${name} requires an idempotent read-back`);
  assert.ok(seed.includes("against the server-issued revision"),
    `${name} binds idempotency and read-back to the server-issued revision`);
  assert.ok(seed.includes("Head remains the review-batch closer"),
    `${name} preserves Head as batch closer`);
  assert.ok(seed.includes("not a server comment proxy and not a claim of credential-level enforcement"),
    `${name} does not claim credential-level enforcement`);
  assert.match(seed, /NO GitHub write[\s\S]*gh issue edit[\s\S]*mutating `gh api` methods/,
    `${name} forbids unrelated GitHub writes`);
}
const ticketReviewPolicy = (seed) => seed.slice(
  seed.indexOf("### ticket-review batches\n"),
  seed.indexOf("### pr-review batches\n"),
);
assert.equal(
  ticketReviewPolicy(re1).replaceAll("RE1", "REVIEWER"),
  ticketReviewPolicy(re2).replaceAll("RE2", "REVIEWER"),
  "RE1 and RE2 carry symmetric ticket-review comment policies",
);
for (const [name, text] of [["playbook", playbook], ["docs", reviewDocs]]) {
  assert.ok(text.includes("credential-level enforcement"),
    `${name} describes the limited policy without an enforcement claim`);
  assert.ok(text.includes("issue_contract_revision"),
    `${name} requires the project/agent-bound revision operation`);
  assert.ok(text.includes("never derive or hash"),
    `${name} rejects local revision derivation`);
  assert.match(text, /Head remains the review-batch\s+closer/,
    `${name} keeps Head as the review-batch closer`);
  assert.ok(text.includes("#1048"), `${name} preserves implementation-review routing`);
}

// #1048 cutover: the server's exact-SHA dispatcher is the sole implementation
// review route. No seed may keep the V1 `@re1 @re2` fanout or an "until
// advertised" dual route.
const reviewRequest = "@re1 @re2 [REVIEW REQUEST] repo=<key> issue=<n> contract=<sha256> pr=<n> sha=";
for (const [name, text] of [["head", head], ["dev", dev], ["re1", re1], ["re2", re2], ["playbook", playbook]]) {
  assert.ok(text.includes("#1048"), `${name} names the dispatcher ticket`);
  assert.ok(text.includes(reviewRequest), `${name} carries the server review request record`);
  if (name !== "re1" && name !== "re2") assert.ok(text.includes("[MERGE GATE DUE]"), `${name} names the Head gate event`);
  assert.doesNotMatch(text, /installed V1|V1 route|V1 fanout|until (?:the server )?advertise|before the server advertises #1048/i,
    `${name} leaves no pre-#1048 dual route`);
}
assert.ok(dev.includes("never @mention reviewers for a PR"), "Dev seed forbids reviewer fanout");
assert.ok(!dev.includes("@re1 @re2 please review"), "Dev seed drops the legacy fanout example");
for (const [name, seed] of [["re1", re1], ["re2", re2]]) {
  assert.ok(seed.includes("issue_review_cycle_nonce") && seed.includes("submit_review_cycle_receipt"),
    `${name} binds its verdict through the nonce receipt`);
  assert.ok(seed.includes("your old receipt\nnever carries forward"), `${name} never carries an old-SHA verdict forward`);
}
assert.ok(playbook.includes("[CONTRACT CHANGED]") && head.includes("[CONTRACT CHANGED]"),
  "Head learns the contract-change cycle invalidation");

// #1046: Head owns the Batch Request decision and completion report.
const batchRequest = "@head [BATCH REQUEST] request=<uuid> issue=";
for (const [name, text] of [["head", head], ["playbook", playbook]]) {
  assert.ok(text.includes(batchRequest), `${name} carries the Batch Request notice`);
  assert.ok(text.includes("## Completion report"), `${name} requires the completion report before closure`);
  assert.match(text, /re-read the live issue/i, `${name} requires a live re-read`);
  assert.ok(text.includes("BLOCKED"), `${name} allows a BLOCKED decision`);
}
assert.match(playbook, /queue[\s\S]{0,200}hold[\s\S]{0,200}BLOCKED/i, "playbook lists queue, hold, and BLOCKED");
assert.ok(playbook.includes("quadwork:batch-request") && playbook.includes("quadwork-batch-request/v1"),
  "playbook names the real label and schema");

// #1058: Dev knows what a WorkTask is and that a candidate never publishes.
assert.ok(dev.includes("submit_work_task_candidate"), "Dev seed names the candidate submission tool");
assert.match(dev, /never `git push`es, opens a PR, starts CI, merges/, "Dev seed forbids candidate publication");
for (const tool of ["put_batch_manifest", "freeze_batch_manifest", "assign_work_task_build", "open_work_task_independent_review", "reconcile_work_task_review", "cut_batch"]) {
  assert.ok(head.includes(tool) && playbook.includes(tool), `Head seeds name ${tool}`);
}
const queue = read("templates/OVERNIGHT-QUEUE.md");
assert.ok(queue.includes("- owner/repo#<n> — <state>"), "queue rules carry the repository-qualified item grammar");
assert.ok(queue.includes("  - <task_key> — <state>"), "queue rules carry the nested task grammar");
assert.ok(!queue.includes("One ticket assigned to Dev at a time"), "queue rules are no longer ticket-serial");
for (const state of ["candidate_ready", "independent_review", "staged", "deferred"]) {
  assert.ok(queue.includes(state) && playbook.includes(state), `task state ${state} is taught`);
}

// #1059: reviewers seal an independent receipt and never read the peer's.
const workTaskReview = (seed) => seed.slice(seed.indexOf("## WorkTask review rounds\n"), seed.indexOf("## Review-only batches\n"));
for (const [name, seed] of [["re1", re1], ["re2", re2]]) {
  const section = workTaskReview(seed);
  assert.ok(section.includes("submit_work_task_review_receipt"), `${name} names the receipt tool`);
  assert.ok(section.includes("Seal your first pass before anything else is said"), `${name} seals before discussing`);
  assert.ok(section.includes("Post no finding detail in chat while the round is sealed"), `${name} keeps sealed findings private`);
  assert.ok(section.includes("A new candidate SHA cancels the round and both receipts"), `${name} drops receipts on retip`);
  assert.doesNotMatch(section, /wait for (?:re1|re2)|read (?:re1|re2)'s verdict|after (?:re1|re2) (?:approves|submits)/i,
    `${name} never defers to the peer reviewer`);
}
assert.equal(
  workTaskReview(re1).replaceAll("RE1", "REVIEWER").replaceAll("RE2", "PEER"),
  workTaskReview(re2).replaceAll("RE2", "REVIEWER").replaceAll("RE1", "PEER"),
  "RE1 and RE2 carry symmetric WorkTask review protocols",
);
assert.match(playbook, /\*\*Playbook version:\*\*\s+\d+\.\d+\.\d+/);
for (const phase of ["Intake and proposal", "EPIC and ticket founding", "Ticket-review phase", "PR gate and merge", "Release and operator gates", "Terminal handoff"]) {
  assert.ok(playbook.includes(phase), `playbook includes ${phase}`);
}
// #1058 shipped the WorkTask schema (`server/work-task-manifest.js`), so role
// contracts may now teach `task_key`; what they may not carry is placeholder
// text for undefined protocol.
assert.doesNotMatch(allContracts, /\bTBD\b|to be defined|placeholder protocol/i,
  "role contracts carry no placeholder protocol");
assert.ok(head.includes("prepare_delivery_candidate") && head.includes("compose_delivery_candidate") && head.includes("plan_delivery_candidate_publication") && head.includes("open_delivery_candidate_final_review"),
  "Head seed documents the advertised Delivery Candidate tools without exposing their internal schema");
assert.ok(head.includes("Never construct a Delivery Candidate reference"),
  "Head seed keeps Git evidence and candidate identity server-derived");

console.log("headProtocolSeeds.test.js: all assertions passed");
