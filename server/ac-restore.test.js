const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `ac-restore-test-${process.pid}-${Date.now()}`);

const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const { restoreProject, convertToAcFormat, contentHash } = require("./ac-restore");
const { migrateProject } = require("./migrate-ac");

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanup);

// --- Test: convertToAcFormat maps fields correctly ---
{
  const record = {
    id: 0,
    seq: 0,
    ts: "2026-05-20T10:00:00.000Z",
    sender: "dev",
    channel: "general",
    type: "message",
    text: "hello",
    mentions: ["head"],
    _legacy: { uid: "abc-123", time: "10:00:00", attachments: [] },
  };
  const ac = convertToAcFormat(record);
  assert.equal(ac.id, 0);
  assert.equal(ac.sender, "dev");
  assert.equal(ac.text, "hello");
  assert.equal(ac.timestamp, "2026-05-20T10:00:00.000Z");
  assert.equal(ac.uid, "abc-123");
  assert.equal(ac.time, "10:00:00");
  assert.deepEqual(ac.attachments, []);
  assert.equal(ac._quadwork_restored_id, 0);
  console.log("PASS: convertToAcFormat maps fields correctly and restores _legacy");
}

// --- Test: basic restore ---
{
  const projectId = "test-restore";
  const chatDir = path.join(TEST_DIR, ".quadwork", projectId, "chat");
  fs.mkdirSync(chatDir, { recursive: true });

  const records = [
    { id: 0, seq: 0, ts: "2026-05-20T10:00:00.000Z", sender: "user", channel: "general", type: "message", text: "hello @dev", mentions: ["dev"] },
    { id: 1, seq: 1, ts: "2026-05-20T10:00:10.000Z", sender: "dev", channel: "general", type: "message", text: "hi @user", mentions: ["user"] },
  ];
  fs.writeFileSync(path.join(chatDir, "general.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const result = restoreProject(projectId);
  assert.ok(result);
  assert.equal(result.restored, 2);

  const acLogPath = path.join(TEST_DIR, ".quadwork", projectId, "agentchattr", "data", "agentchattr_log.jsonl");
  assert.ok(fs.existsSync(acLogPath));
  const acLines = fs.readFileSync(acLogPath, "utf-8").trim().split("\n");
  assert.equal(acLines.length, 2);

  const ac0 = JSON.parse(acLines[0]);
  assert.equal(ac0.sender, "user");
  assert.equal(ac0._quadwork_restored_id, 0);
  console.log("PASS: basic restore writes AC JSONL");
}

// --- Test: idempotent — re-run produces no duplicates ---
{
  const projectId = "test-restore";
  const result = restoreProject(projectId);
  assert.ok(result);
  assert.equal(result.restored, 0);
  assert.equal(result.skipped, 2);

  const acLogPath = path.join(TEST_DIR, ".quadwork", projectId, "agentchattr", "data", "agentchattr_log.jsonl");
  const acLines = fs.readFileSync(acLogPath, "utf-8").trim().split("\n");
  assert.equal(acLines.length, 2, "no duplicates");
  console.log("PASS: re-running ac-restore produces no duplicates");
}

// --- Test: skips migration system messages ---
{
  const projectId = "test-skip-sysmsg";
  const chatDir = path.join(TEST_DIR, ".quadwork", projectId, "chat");
  fs.mkdirSync(chatDir, { recursive: true });

  const records = [
    { id: 0, seq: 0, ts: "2026-05-20T10:00:00.000Z", sender: "user", channel: "general", type: "message", text: "hello", mentions: [] },
    { id: 1, seq: 1, ts: "2026-05-20T10:00:01.000Z", sender: "system", channel: "general", type: "system", text: "Chat history migrated from AC (1 messages)", mentions: [] },
  ];
  fs.writeFileSync(path.join(chatDir, "general.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const result = restoreProject(projectId);
  assert.equal(result.restored, 1);
  assert.equal(result.skipped, 1);
  console.log("PASS: skips migration system messages");
}

// --- Test: round-trip (AC → migrate → ac-restore → migrate) is field-stable ---
{
  const projectId = "test-roundtrip";
  const acDataDir = path.join(TEST_DIR, ".quadwork", projectId, "agentchattr", "data");
  fs.mkdirSync(acDataDir, { recursive: true });

  const originalAc = [
    { id: 0, uid: "aaa", sender: "user", text: "hello @dev", type: "chat", timestamp: 1777370000, time: "10:00:00", attachments: [], channel: "general" },
    { id: 1, uid: "bbb", sender: "dev", text: "hi @user", type: "chat", timestamp: 1777370010, time: "10:00:10", attachments: [], channel: "general", reply_to: 0 },
  ];
  fs.writeFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), originalAc.map((r) => JSON.stringify(r)).join("\n") + "\n");

  // Step 1: migrate AC → file-chat
  migrateProject(projectId);

  const chatFile = path.join(TEST_DIR, ".quadwork", projectId, "chat", "general.jsonl");
  const migratedLines = fs.readFileSync(chatFile, "utf-8").trim().split("\n");
  const migratedRecords = migratedLines.map((l) => JSON.parse(l));

  // Step 2: ac-restore with original AC log still present — dedup should
  // prevent duplicates since the same messages already exist in AC format
  const acLogBefore = fs.readFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), "utf-8");
  const acLinesBefore = acLogBefore.trim().split("\n").length;

  restoreProject(projectId);

  const restoredAcLines = fs.readFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), "utf-8").trim().split("\n");
  // Original 2 AC records should still be there, no duplicates appended
  assert.equal(restoredAcLines.length, acLinesBefore, "no duplicates appended when original AC records present");

  const restored0 = JSON.parse(restoredAcLines[0]);
  assert.equal(restored0.sender, "user");
  assert.equal(restored0.text, "hello @dev");
  assert.equal(restored0.uid, "aaa");

  const restored1 = JSON.parse(restoredAcLines[1]);
  assert.equal(restored1.sender, "dev");
  assert.equal(restored1.uid, "bbb");
  assert.equal(restored1.reply_to, 0);

  console.log("PASS: round-trip AC → migrate → ac-restore preserves fields");
}

// --- Test: no general.jsonl returns null ---
{
  const result = restoreProject("nonexistent-project");
  assert.equal(result, null);
  console.log("PASS: no general.jsonl returns null");
}

// --- Test: content hash dedup against existing AC records ---
{
  const projectId = "test-hash-dedup";
  const chatDir = path.join(TEST_DIR, ".quadwork", projectId, "chat");
  const acDataDir = path.join(TEST_DIR, ".quadwork", projectId, "agentchattr", "data");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.mkdirSync(acDataDir, { recursive: true });

  // Pre-existing AC record (no _quadwork_restored_id marker)
  const existingAc = { id: 0, sender: "user", text: "hello", channel: "general", timestamp: "2026-05-20T10:00:00.000Z", type: "message" };
  fs.writeFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), JSON.stringify(existingAc) + "\n");

  // File-chat record with same content
  const fileRecord = { id: 0, seq: 0, ts: "2026-05-20T10:00:00.000Z", sender: "user", channel: "general", type: "message", text: "hello", mentions: [] };
  fs.writeFileSync(path.join(chatDir, "general.jsonl"), JSON.stringify(fileRecord) + "\n");

  const result = restoreProject(projectId);
  assert.equal(result.restored, 0);
  assert.equal(result.skipped, 1);

  const acLines = fs.readFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), "utf-8").trim().split("\n");
  assert.equal(acLines.length, 1, "no duplicate appended");
  console.log("PASS: content hash dedup prevents duplicates against existing AC records");
}

console.log("\nAll ac-restore tests passed.");
