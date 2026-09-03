const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `file-chat-test-${process.pid}-${Date.now()}`);
const QUADWORK_DIR = path.join(TEST_DIR, ".quadwork");

// Override HOME so file-chat writes to temp dir
const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const fileChat = require("./file-chat");
const { canonicalizeBatchRequestAuthority } = require("./batch-request-contract");
const { VERSION: BATCH_REQUEST_VERSION, dedupeKey } = require("./batch-request-subscription");

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanup);

const PROJECT = "test-project";

function batchRequestPlan(projectId, overrides = {}) {
  const repository = "acme/coordination";
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const authority = {
    schema: "quadwork-batch-request/v1",
    request_id: requestId,
    source_installation_id: "installation_source_0001",
    source_project_id: "source-project",
    target_installation_id: "installation_target_0001",
    target_project_id: projectId,
    coordination_repo: repository,
    mode: "implementation",
    work_refs: ["acme/web#42"],
    start_policy: "next-available",
  };
  const digest = canonicalizeBatchRequestAuthority(authority).digest;
  return {
    version: BATCH_REQUEST_VERSION,
    kind: "BATCH REQUEST",
    recipients: ["head"],
    correlation_key: dedupeKey(repository, 42, requestId, digest),
    issue_url: `https://api.github.com/repos/${repository}/issues/42`,
    anchors: { coordination_repo: repository, issue_number: 42, request_id: requestId, authority_digest: digest },
    authority,
    ...overrides,
  };
}

// --- Test: Monotonic ID property ---
{
  fileChat.initProject(PROJECT);
  const ids = [];
  for (let i = 0; i < 100; i++) {
    const msg = fileChat.appendMessage(PROJECT, {
      sender: "dev",
      text: `Message ${i}`,
      channel: "general",
      type: "message",
    });
    ids.push(msg.id);
  }
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] === ids[i - 1] + 1, `ID ${ids[i]} should be ${ids[i - 1] + 1}`);
  }
  console.log("PASS: monotonic ID property (100 messages, sequential IDs)");
  fileChat.shutdownProject(PROJECT);
}

// --- Test: readMessages since_id filtering ---
{
  const P2 = "test-since-id";
  fileChat.initProject(P2);
  for (let i = 0; i < 10; i++) {
    fileChat.appendMessage(P2, {
      sender: "head",
      text: `Batch message ${i}`,
    });
  }
  const allMsgs = fileChat.readMessages(P2, { limit: 50 });
  assert.equal(allMsgs.length, 10);

  const sinceId = allMsgs[5].id;
  const filtered = fileChat.readMessages(P2, { since_id: sinceId, limit: 50 });
  assert.equal(filtered.length, 4);
  assert.ok(filtered.every((m) => m.id > sinceId), "all returned messages should have id > since_id");
  console.log("PASS: readMessages since_id filtering");
  fileChat.shutdownProject(P2);
}

// --- Test: Malformed-line skip ---
{
  const chatDir = fileChat._chatDir(PROJECT);
  fs.mkdirSync(chatDir, { recursive: true });
  const chatFile = fileChat._chatFile(PROJECT);
  // Write some valid lines followed by a corrupt line
  const validLine = JSON.stringify({ id: 1, seq: 1, ts: new Date().toISOString(), sender: "dev", channel: "general", type: "message", text: "valid", mentions: [] });
  const corruptLine = "{invalid json here";
  const validLine2 = JSON.stringify({ id: 2, seq: 2, ts: new Date().toISOString(), sender: "head", channel: "general", type: "message", text: "also valid", mentions: [] });
  fs.writeFileSync(chatFile, validLine + "\n" + corruptLine + "\n" + validLine2 + "\n");

  fileChat.initProject(PROJECT);
  const msgs = fileChat.readMessages(PROJECT, { limit: 50 });
  assert.equal(msgs.length, 2, "should skip corrupt line and return 2 valid messages");
  assert.equal(msgs[0].text, "valid");
  assert.equal(msgs[1].text, "also valid");
  console.log("PASS: malformed-line skip (corrupt trailing line doesn't crash)");
  fileChat.shutdownProject(PROJECT);
}

// --- Test: Startup tail-scan recovery ---
{
  const chatDir = fileChat._chatDir(PROJECT);
  fs.mkdirSync(chatDir, { recursive: true });
  const chatFile = fileChat._chatFile(PROJECT);
  // Write messages with IDs 50-54
  const lines = [];
  for (let i = 50; i <= 54; i++) {
    lines.push(JSON.stringify({ id: i, seq: i, ts: new Date().toISOString(), sender: "dev", channel: "general", type: "message", text: `msg ${i}`, mentions: [] }));
  }
  fs.writeFileSync(chatFile, lines.join("\n") + "\n");

  fileChat.initProject(PROJECT);
  const nextId = fileChat.getNextId(PROJECT);
  assert.equal(nextId, 55, "next ID should be 55 after recovering from file with max ID 54");

  const newMsg = fileChat.appendMessage(PROJECT, { sender: "dev", text: "after restart" });
  assert.equal(newMsg.id, 55, "first message after restart should have ID 55");
  console.log("PASS: startup tail-scan recovery (restart recovers correct next ID)");
  fileChat.shutdownProject(PROJECT);
}

// --- Test: parseMentions ---
{
  const mentions = fileChat.parseMentions("@dev Please review @re1 and @re2");
  assert.deepEqual(mentions, ["dev", "re1", "re2"]);

  const noMentions = fileChat.parseMentions("No mentions here");
  assert.deepEqual(noMentions, []);

  const dupes = fileChat.parseMentions("@dev @dev @dev");
  assert.deepEqual(dupes, ["dev"], "duplicate mentions should be deduplicated");
  console.log("PASS: parseMentions");
}

// --- Test: Cache serves recent messages without disk reads ---
{
  const chatDir = fileChat._chatDir(PROJECT);
  fs.mkdirSync(chatDir, { recursive: true });
  const chatFile = fileChat._chatFile(PROJECT);
  fs.writeFileSync(chatFile, "");

  fileChat.initProject(PROJECT);
  for (let i = 0; i < 5; i++) {
    fileChat.appendMessage(PROJECT, { sender: "dev", text: `cache test ${i}` });
  }

  // Remove file to prove cache is serving
  fs.unlinkSync(chatFile);
  const cached = fileChat.readMessages(PROJECT, { limit: 50 });
  assert.equal(cached.length, 5, "cache should serve 5 messages even with file deleted");
  console.log("PASS: in-memory cache serves recent messages without disk reads");
  fileChat.shutdownProject(PROJECT);
}

// --- Test: File permissions ---
{
  fileChat.initProject(PROJECT);
  fileChat.appendMessage(PROJECT, { sender: "dev", text: "permissions test" });
  const chatDir = fileChat._chatDir(PROJECT);
  const chatFile = fileChat._chatFile(PROJECT);

  const dirStat = fs.statSync(chatDir);
  assert.equal(dirStat.mode & 0o777, 0o700, "chat dir should have 0700 permissions");

  const fileStat = fs.statSync(chatFile);
  assert.equal(fileStat.mode & 0o777, 0o600, "chat file should have 0600 permissions");
  console.log("PASS: file permissions (0700 dir, 0600 file)");
  fileChat.shutdownProject(PROJECT);
}

// --- Test: closed Batch Request notice append + exact correlation dedupe ---
{
  const batchProject = "test-batch-request";
  const candidate = {
    project_id: batchProject,
    head_generation: 0,
    notification: batchRequestPlan(batchProject),
  };
  fileChat.initProject(batchProject);
  const first = fileChat.appendTrustedBatchRequestOnce(batchProject, candidate);
  const second = fileChat.appendTrustedBatchRequestOnce(batchProject, candidate);
  assert.deepEqual(first, { ok: true, id: 1, duplicate: false });
  assert.deepEqual(second, { ok: true, id: 1, duplicate: true });
  const [record] = fileChat.readMessages(batchProject, { limit: 10 });
  assert.equal(record.sender, "system");
  assert.equal(record.type, "system");
  assert.deepEqual(record.mentions, ["head"]);
  assert.equal(record.resume_structural.tag, "batch_request");
  assert.equal(record.resume_structural.head_generation, 0);
  assert.equal(record.resume_structural.trusted, true);
  assert.equal(record.trusted_event.scope, "batch_request");
  assert.equal(JSON.stringify(record).includes("work_refs"), false);
  assert.throws(() => fileChat.appendTrustedBatchRequestOnce(batchProject, {
    ...candidate,
    notification: batchRequestPlan(batchProject, { recipients: ["head", "dev"] }),
  }));
  assert.equal(fileChat.readMessages(batchProject, { limit: 10 }).length, 1);
  console.log("PASS: closed Batch Request notice append, resume tagging, and exact dedupe");
  fileChat.shutdownProject(batchProject);
}

// #1047: lifecycle receipts are fixed server records, deduped by the actual
// Head operation/session generation rather than reconnect count.  The private
// recovery reader rejects corrupt history instead of following readMessages'
// availability-first malformed-line skip behaviour.
{
  const lifecycleProject = "file-chat-head-lifecycle";
  fileChat.initProject(lifecycleProject);
  const candidate = {
    version: 1,
    project_id: lifecycleProject,
    installation_id: "installation1047a",
    head_generation: 0,
    operation_id: "operation-1047-a",
    session_generation: "generation-1047-a",
    reason: "operator_restart",
    batch_id: null,
  };
  assert.deepEqual(fileChat.appendTrustedHeadLifecycleOnce(lifecycleProject, candidate), { ok: true, id: 1, duplicate: false });
  assert.deepEqual(fileChat.appendTrustedHeadLifecycleOnce(lifecycleProject, candidate), { ok: true, id: 1, duplicate: true });
  const source = fileChat.readPrimaryChatResumeRecords(lifecycleProject);
  assert.equal(source.freshness, "live");
  assert.equal(source.records.length, 1);
  assert.equal(source.records[0].resume_structural.tag, "head_lifecycle");
  assert.equal(source.records[0].resume_structural.head_generation, 0);
  assert.equal(fileChat.findPrimaryChatResumeBatchStart(lifecycleProject, "batch-1047", 0), null);
  const lifecycleChatFile = path.join(os.homedir(), ".quadwork", lifecycleProject, "chat", "general.jsonl");
  fs.appendFileSync(lifecycleChatFile, "{malformed\n");
  assert.throws(() => fileChat.readPrimaryChatResumeRecords(lifecycleProject), /malformed/);
  console.log("PASS: Head lifecycle receipt and strict Primary Chat resume source");
  fileChat.shutdownProject(lifecycleProject);
}

{
  const operatorProject = "file-chat-operator-mention";
  fileChat.initProject(operatorProject);
  const record = fileChat.appendTrustedOperatorHeadMention(operatorProject, {
    text: "@head please inspect the exact queued item",
    attachments: [{ name: "evidence.png" }],
    batch_id: "batch-1047",
    head_generation: 0,
  });
  assert.equal(record.sender, "user");
  assert.equal(record.resume_structural.tag, "operator_head_mention");
  assert.equal(record.resume_structural.server_authored, false);
  assert.equal(fileChat.findPrimaryChatResumeBatchStart(operatorProject, "batch-1047", 0), 0,
    "an authenticated operator-to-Head request provides the active resume boundary");
  assert.throws(() => fileChat.appendTrustedOperatorHeadMention(operatorProject, {
    text: "please inspect the exact queued item",
    attachments: null,
    batch_id: null,
    head_generation: 0,
  }));
  console.log("PASS: explicit operator-to-Head recovery tag");
  fileChat.shutdownProject(operatorProject);
}

console.log("\nAll file-chat tests passed.");
cleanup();
