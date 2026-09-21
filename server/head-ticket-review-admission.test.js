"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHeadTicketReviewAdmission } = require("./head-ticket-review-admission");
const { parseActiveBatch } = require("./routes");

const installation_id = "installationticket01";
const project_id = "quadwork";
const repository = { key: "primary", repo: "example/quadwork", cache_repo: "example/quadwork" };

function emptyContext(queueText) {
  return {
    cfg: { installation_id },
    project: { id: project_id },
    repositories: [repository],
    queueText,
    queueReadOk: true,
    batchType: "code",
    parsed: { workItems: [], errors: [], batchNumber: null, provenance: "legacy_unowned", assignmentAttempt: null },
  };
}

function fixture() {
  const config_dir = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-ticket-review-"));
  const queuePath = path.join(config_dir, project_id, "OVERNIGHT-QUEUE.md");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const initial = [
    "# Queue",
    "",
    "## Active Batch",
    "",
    "(no active batch yet — operator will assign one via chat. Head will use batch number 1 for the first batch.)",
    "",
    "## Backlog",
    "",
    "(none)",
    "",
    "## Rules",
    "",
    "**Batch:** 1",
  ].join("\n");
  fs.writeFileSync(queuePath, initial);
  let context = emptyContext(initial);
  let writes = 0;
  const admission = createHeadTicketReviewAdmission({
    config_dir,
    read_config: () => ({ installation_id, projects: [{ id: project_id, archived: false }] }),
    read_live_batch_context: () => context,
    write_secure_file(file, content) {
      writes += 1;
      assert.equal(file, queuePath);
      fs.writeFileSync(file, content);
      context = {
        ...emptyContext(content),
        batchType: "ticket-review",
        parsed: {
          workItems: [{ ref: { repoKey: "primary", repo: repository.repo, number: 42, kind: "issue" } }],
          errors: [], batchNumber: 1, provenance: "owned", assignmentAttempt: "ticket_review_seed_1",
        },
      };
    },
    random_id: () => "seed-1",
  });
  return { admission, queuePath, initial, writes: () => writes, setContext: (next) => { context = next; }, cleanup: () => fs.rmSync(config_dir, { recursive: true, force: true }) };
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

{
  const live = fixture();
  try {
    const started = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 42 } });
    assert.deepEqual(started, { applied: true, code: "ticket_review_started", repository_key: "primary", issue: 42, batch: 1, attempt: "ticket_review_seed1", idempotent: false });
    const queue = fs.readFileSync(live.queuePath, "utf8");
    assert.match(queue, /\*\*Batch type:\*\* ticket-review/);
    assert.match(queue, /\*\*Installation:\*\* installationticket01/);
    assert.match(queue, /- example\/quadwork#42 — queued/);
    assert.match(queue, /## Backlog\n\n\(none\)/);
    const parsed = parseActiveBatch(queue, { repositories: [repository], installationId: installation_id });
    assert.equal(parsed.provenance, "owned");
    assert.equal(parsed.workItems.length, 1);
    assert.deepEqual(parsed.workItems[0].ref, { repoKey: "primary", repo: "example/quadwork", number: 42, kind: "issue" });
    ok(true, "a Head-owned request replaces only the seeded empty active section with one registered ticket-review assignment");

    const retry = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 42 } });
    assert.deepEqual(retry, { applied: true, code: "ticket_review_already_started", repository_key: "primary", issue: 42, batch: 1, attempt: "ticket_review_seed_1", idempotent: true });
    assert.equal(live.writes(), 1);
    ok(true, "the same sole owned assignment is durable-idempotent without rewriting the queue");
  } finally { live.cleanup(); }
}

{
  const live = fixture();
  try {
    live.setContext({ ...emptyContext(live.initial), project: { id: "other" } });
    const foreignProject = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 42 } });
    assert.equal(foreignProject.code, "ticket_review_project_unavailable");
    assert.equal(live.writes(), 0);
    ok(true, "a cross-project live context cannot be used to create an assignment");
  } finally { live.cleanup(); }
}

{
  const live = fixture();
  try {
    const foreign = live.admission.begin({ project_id, ticket_review: { repository_key: "other", issue: 42 } });
    assert.equal(foreign.code, "ticket_review_repository_unregistered");
    assert.equal(live.writes(), 0);
    const malformed = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 0 } });
    assert.equal(malformed.code, "ticket_review_request_invalid");
    assert.equal(live.writes(), 0);
    ok(true, "a cross-repository target or malformed issue cannot create an assignment");
  } finally { live.cleanup(); }
}

{
  const live = fixture();
  try {
    const active = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 43 } });
    assert.equal(active.applied, true);
    const different = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 44 } });
    assert.equal(different.code, "ticket_review_active_batch_present");
    assert.equal(live.writes(), 1);
    ok(true, "an existing owned ticket review cannot be broadened or retargeted by a later Head request");
  } finally { live.cleanup(); }
}

console.log(`\n${passed} passed`);
