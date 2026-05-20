const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `migrate-ac-test-${process.pid}-${Date.now()}`);

const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const { migrateProject, convertAcRecord } = require("./migrate-ac");

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanup);

// --- Test: convertAcRecord converts Unix timestamp to ISO ---
{
  const record = {
    id: 5,
    uid: "abc-123",
    sender: "dev",
    text: "hello @head",
    type: "chat",
    timestamp: 1777370726.154467,
    time: "19:05:26",
    attachments: [],
    channel: "general",
  };
  const result = convertAcRecord(record, 0);
  assert.equal(result.id, 0);
  assert.equal(result.seq, 0);
  assert.equal(result.sender, "dev");
  assert.equal(result.text, "hello @head");
  assert.equal(result.type, "message");
  assert.equal(result.channel, "general");
  assert.deepEqual(result.mentions, ["head"]);
  assert.ok(result.ts.includes("T"), "ts should be ISO format");
  assert.ok(result._legacy, "should have _legacy");
  assert.equal(result._legacy.uid, "abc-123");
  assert.equal(result._legacy.time, "19:05:26");
  assert.deepEqual(result._legacy.attachments, []);
  assert.equal(result._legacy.id, undefined, "known field id should not be in _legacy");
  console.log("PASS: convertAcRecord converts Unix timestamp and preserves unknown fields");
}

// --- Test: convertAcRecord preserves system type ---
{
  const record = { sender: "system", text: "paused", type: "system", timestamp: 1777370726 };
  const result = convertAcRecord(record, 1);
  assert.equal(result.type, "system");
  console.log("PASS: convertAcRecord preserves system type");
}

// --- Test: convertAcRecord maps non-system types to message ---
{
  const record = { sender: "dev", text: "left", type: "leave", timestamp: 1777370726 };
  const result = convertAcRecord(record, 2);
  assert.equal(result.type, "message");
  assert.equal(result._legacy.type, "leave");
  console.log("PASS: convertAcRecord maps non-system type to message, preserves original in _legacy");
}

// --- Test: round-trip migration ---
{
  const projectId = "test-roundtrip";
  const acDataDir = path.join(TEST_DIR, ".quadwork", projectId, "agentchattr", "data");
  fs.mkdirSync(acDataDir, { recursive: true });

  const acRecords = [
    { id: 0, uid: "a", sender: "user", text: "hello @dev", type: "chat", timestamp: 1777370000, time: "10:00:00", attachments: [], channel: "general" },
    { id: 1, uid: "b", sender: "dev", text: "hi @user", type: "chat", timestamp: 1777370010, time: "10:00:10", attachments: [], channel: "general", reply_to: 0 },
    { id: 2, uid: "c", sender: "system", text: "paused", type: "system", timestamp: 1777370020, time: "10:00:20", attachments: [], channel: "general" },
  ];
  const acContent = acRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), acContent);

  const result = migrateProject(projectId);
  assert.ok(result, "migration should return stats");
  assert.equal(result.messages, 3);
  assert.equal(result.skipped, 0);

  const chatDir = path.join(TEST_DIR, ".quadwork", projectId, "chat");
  const outputPath = path.join(chatDir, "general.jsonl");
  assert.ok(fs.existsSync(outputPath), "general.jsonl should exist");

  const outputLines = fs.readFileSync(outputPath, "utf-8").trim().split("\n");
  assert.equal(outputLines.length, 4, "3 records + 1 system message");

  const parsed = outputLines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].sender, "user");
  assert.equal(parsed[0].text, "hello @dev");
  assert.deepEqual(parsed[0].mentions, ["dev"]);
  assert.equal(parsed[0]._legacy.uid, "a");

  assert.equal(parsed[1]._legacy.reply_to, 0);

  assert.equal(parsed[2].type, "system");

  assert.equal(parsed[3].sender, "system");
  assert.ok(parsed[3].text.includes("3 messages"));

  const migratedPath = path.join(chatDir, ".migrated");
  assert.ok(fs.existsSync(migratedPath), ".migrated should exist");
  const manifest = JSON.parse(fs.readFileSync(migratedPath, "utf-8"));
  assert.equal(manifest.messages, 3);
  assert.equal(manifest.skipped, 0);

  // Verify AC source is untouched
  const acSource = fs.readFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), "utf-8");
  assert.equal(acSource, acContent, "AC log should be untouched");

  console.log("PASS: round-trip migration preserves all records");
}

// --- Test: invalid lines are skipped ---
{
  const projectId = "test-invalid-lines";
  const acDataDir = path.join(TEST_DIR, ".quadwork", projectId, "agentchattr", "data");
  fs.mkdirSync(acDataDir, { recursive: true });

  const acContent = [
    JSON.stringify({ id: 0, sender: "user", text: "hello", type: "chat", timestamp: 1777370000 }),
    "this is not json",
    JSON.stringify({ id: 2, sender: "dev", text: "world", type: "chat", timestamp: 1777370010 }),
    "{broken json",
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), acContent);

  const result = migrateProject(projectId);
  assert.equal(result.messages, 2);
  assert.equal(result.skipped, 2);

  console.log("PASS: invalid lines are skipped and counted");
}

// --- Test: re-running migration is a no-op ---
{
  const projectId = "test-roundtrip"; // already migrated above
  const result = migrateProject(projectId);
  assert.equal(result, null, "should be no-op");
  console.log("PASS: re-running migration on migrated project is a no-op");
}

// --- Test: existing general.jsonl without .migrated skips ---
{
  const projectId = "test-phase1";
  const chatDir = path.join(TEST_DIR, ".quadwork", projectId, "chat");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, "general.jsonl"), '{"id":0}\n');

  const acDataDir = path.join(TEST_DIR, ".quadwork", projectId, "agentchattr", "data");
  fs.mkdirSync(acDataDir, { recursive: true });
  fs.writeFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), '{"id":0,"sender":"user","text":"test","type":"chat","timestamp":1}\n');

  const result = migrateProject(projectId);
  assert.equal(result, null, "should skip Phase 1 test project");
  console.log("PASS: existing general.jsonl without .migrated is skipped (Phase 1)");
}

// --- Test: AC log with only invalid lines is skipped ---
{
  const projectId = "test-all-invalid";
  const acDataDir = path.join(TEST_DIR, ".quadwork", projectId, "agentchattr", "data");
  fs.mkdirSync(acDataDir, { recursive: true });

  const acContent = "not json\nalso not json\n{broken\n";
  fs.writeFileSync(path.join(acDataDir, "agentchattr_log.jsonl"), acContent);

  const result = migrateProject(projectId);
  assert.equal(result, null, "should skip when all lines are invalid");

  const chatDir = path.join(TEST_DIR, ".quadwork", projectId, "chat");
  assert.ok(!fs.existsSync(path.join(chatDir, "general.jsonl")), "should not create general.jsonl");
  assert.ok(!fs.existsSync(path.join(chatDir, ".migrated")), "should not create .migrated");
  console.log("PASS: AC log with only invalid lines is skipped gracefully");
}

// --- Test: no AC log means nothing to migrate ---
{
  const projectId = "test-new-project";
  const result = migrateProject(projectId);
  assert.equal(result, null);
  console.log("PASS: no AC log means nothing to migrate");
}

console.log("\nAll migrate-ac tests passed.");
