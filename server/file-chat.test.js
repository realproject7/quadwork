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

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanup);

const PROJECT = "test-project";

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

console.log("\nAll file-chat tests passed.");
cleanup();
