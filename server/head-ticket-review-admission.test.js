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
    installationId: installation_id,
    project: { id: project_id },
    repositories: [repository],
    queueText,
    queueReadOk: true,
    batchType: "code",
    parsed: { workItems: [], errors: [], batchNumber: null, provenance: "legacy_unowned", assignmentAttempt: null },
  };
}

function fixture({ failQueueRename = false } = {}) {
  const config_dir = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-ticket-review-"));
  const queuePath = path.join(config_dir, project_id, "OVERNIGHT-QUEUE.md");
  const recordPath = path.join(config_dir, project_id, "ticket-review-admission.json");
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
  let config = { installation_id, projects: [{ id: project_id, archived: false, repositories: [repository] }] };
  let queueWrites = 0;
  const fsFacade = Object.create(fs);
  fsFacade.renameSync = (source, target) => {
    if (target === queuePath) {
      queueWrites += 1;
      if (failQueueRename) throw new Error("queue rename interrupted");
    }
    return fs.renameSync(source, target);
  };
  const admission = createHeadTicketReviewAdmission({
    config_dir,
    fs: fsFacade,
    read_config: () => config,
    read_live_batch_context: () => context,
    all_repositories: (project) => project.repositories || [],
    write_secure_file(file, content) {
      fs.writeFileSync(file, content, { mode: 0o600 });
    },
    ensure_secure_dir(directory) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); },
    random_id: () => "seed-1",
  });
  return { admission, queuePath, recordPath, initial, writes: () => queueWrites, setContext: (next) => { context = next; }, setConfig: (next) => { config = next; }, cleanup: () => fs.rmSync(config_dir, { recursive: true, force: true }) };
}

function ownedContext(queue) {
  const parsed = parseActiveBatch(queue, { repositories: [repository], installationId: installation_id });
  return { ...emptyContext(queue), batchType: "ticket-review", parsed };
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
    assert.equal(fs.statSync(live.recordPath).mode & 0o777, 0o600);
    ok(true, "a Head-owned request replaces only the seeded empty active section with one registered ticket-review assignment");

    live.setContext(ownedContext(queue));
    const retry = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 42 } });
    assert.deepEqual(retry, { applied: true, code: "ticket_review_already_started", repository_key: "primary", issue: 42, batch: 1, attempt: "ticket_review_seed1", idempotent: true });
    assert.equal(live.writes(), 1);
    ok(true, "the same sole owned assignment is durable-idempotent without rewriting the queue");
  } finally { live.cleanup(); }
}

{
  const live = fixture();
  try {
    live.setConfig({ installation_id, projects: [{ id: project_id, archived: false, repositories: [{ ...repository, repo: "example/reconfigured" }] }] });
    const changed = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 42 } });
    assert.equal(changed.code, "ticket_review_repository_changed");
    assert.equal(live.writes(), 0);
    ok(true, "a repository reconfiguration after the live context read cannot create an unusable assignment");
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
    live.setContext(ownedContext(fs.readFileSync(live.queuePath, "utf8")));
    const different = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 44 } });
    assert.equal(different.code, "ticket_review_active_batch_present");
    assert.equal(live.writes(), 1);
    ok(true, "an existing owned ticket review cannot be broadened or retargeted by a later Head request");
  } finally { live.cleanup(); }
}

{
  const live = fixture();
  try {
    const forged = [
      "## Active Batch", "", "**Batch:** 1", "**Batch type:** ticket-review",
      `**Installation:** ${installation_id}`, "**Assignment attempt:** ticket_review_forged",
      "- example/quadwork#42 — queued",
    ].join("\n");
    live.setContext(ownedContext(forged));
    const result = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 42 } });
    assert.equal(result.code, "ticket_review_active_batch_present");
    assert.equal(live.writes(), 0);
    ok(true, "a manually reconstructed owned-looking queue is not an idempotent server admission");
  } finally { live.cleanup(); }
}

{
  const live = fixture({ failQueueRename: true });
  try {
    const result = live.admission.begin({ project_id, ticket_review: { repository_key: "primary", issue: 42 } });
    assert.equal(result.code, "ticket_review_queue_write_failed");
    assert.equal(fs.readFileSync(live.queuePath, "utf8"), live.initial);
    assert.ok(fs.existsSync(live.recordPath), "the server-owned record remains for a safe retry");
    ok(true, "an interrupted queue replacement leaves the original queue byte-for-byte intact");
  } finally { live.cleanup(); }
}

console.log(`\n${passed} passed`);
