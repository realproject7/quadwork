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

for (const text of [dev, re1, re2, head, playbook, reviewDocs]) {
  assert.ok(text.includes("#1048"), "implementation route cutover is explicitly feature-gated");
  assert.match(text, /installed V1|V1 route|V1 fanout/i, "pre-#1048 compatibility remains documented");
}
assert.match(playbook, /\*\*Playbook version:\*\*\s+\d+\.\d+\.\d+/);
for (const phase of ["Intake and proposal", "EPIC and ticket founding", "Ticket-review phase", "PR gate and merge", "Release and operator gates", "Terminal handoff"]) {
  assert.ok(playbook.includes(phase), `playbook includes ${phase}`);
}
assert.doesNotMatch(allContracts, /task_key/i,
  "later execution schema internals are not predeclared in role contracts");
assert.ok(head.includes("prepare_delivery_candidate") && head.includes("compose_delivery_candidate") && head.includes("open_delivery_candidate_final_review"),
  "Head seed documents the advertised Delivery Candidate tools without exposing their internal schema");
assert.ok(head.includes("Never construct a Delivery Candidate reference"),
  "Head seed keeps Git evidence and candidate identity server-derived");

console.log("headProtocolSeeds.test.js: all assertions passed");
