// #1033/#1048: shipped Head/worker seeds must agree on PO authority, review
// routing, terminal status, and the atomic implementation-review cutover.
// Plain node:assert.

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

for (const text of [dev, playbook, reviewDocs]) {
  assert.ok(text.includes("#1048"), "implementation route cutover is explicitly feature-gated");
}
assert.match(dev, /implementation review routing is server-owned/i,
  "Dev documents that it no longer owns implementation-review fanout");
for (const [name, text] of [["head", head], ["re1", re1], ["re2", re2], ["playbook", playbook]]) {
  assert.match(text, /server(?:'s|-originated|[- ]owned).*\[REVIEW REQUEST\]|\[REVIEW REQUEST\].*server/i,
    `${name} documents the post-#1048 server-owned exact-SHA review route`);
}
assert.doesNotMatch([head, dev, re1, re2, playbook].join("\n"),
  /\[ASSIGN REVIEW\](?!-BATCH)/,
  "post-#1048 implementation seeds contain no legacy free-form review fanout");
assert.match(playbook, /\*\*Playbook version:\*\*\s+\d+\.\d+\.\d+/);
for (const phase of ["Intake and proposal", "EPIC and ticket founding", "Ticket-review phase", "PR gate and merge", "Release and operator gates", "Terminal handoff"]) {
  assert.ok(playbook.includes(phase), `playbook includes ${phase}`);
}
assert.doesNotMatch(allContracts, /task_key|delivery[_ -]candidate/i,
  "later execution/delivery schemas are not predeclared");

console.log("headProtocolSeeds.test.js: all assertions passed");
