const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `bridges-test-${process.pid}-${Date.now()}`);

const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const telegramBridge = require("./telegram");
const discordBridge = require("./discord");

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

process.on("exit", cleanup);

const QW_DIR = path.join(TEST_DIR, ".quadwork");
fs.mkdirSync(QW_DIR, { recursive: true });

// --- Test: Telegram reads Python-written cursor file ---
{
  const cursorFile = path.join(QW_DIR, "tg-bridge-cursor-test-tg.json");
  fs.writeFileSync(cursorFile, JSON.stringify({ last_seen_id: 42 }));
  const sinceId = telegramBridge.readCursor("test-tg");
  assert.equal(sinceId, 42);
  console.log("PASS: Telegram reads Python-written cursor file");
}

// --- Test: Discord reads Python-written cursor file ---
{
  const cursorFile = path.join(QW_DIR, "dc-bridge-cursor-test-dc.json");
  fs.writeFileSync(cursorFile, JSON.stringify({ last_seen_id: 99 }));
  const sinceId = discordBridge.readCursor("test-dc");
  assert.equal(sinceId, 99);
  console.log("PASS: Discord reads Python-written cursor file");
}

// --- Test: Missing cursor file returns 0 ---
{
  const sinceId = telegramBridge.readCursor("nonexistent");
  assert.equal(sinceId, 0);
  console.log("PASS: Missing cursor file returns 0");
}

// --- Test: Telegram isRunning returns false for unstarted project ---
{
  assert.equal(telegramBridge.isRunning("not-started"), false);
  console.log("PASS: isRunning returns false for unstarted project");
}

// --- Test: Discord isRunning returns false for unstarted project ---
{
  assert.equal(discordBridge.isRunning("not-started"), false);
  console.log("PASS: Discord isRunning returns false for unstarted project");
}

// --- Test: getLastError returns null for unstarted project ---
{
  assert.equal(telegramBridge.getLastError("not-started"), null);
  assert.equal(discordBridge.getLastError("not-started"), null);
  console.log("PASS: getLastError returns null for unstarted projects");
}

console.log("\nAll bridge tests passed.");
