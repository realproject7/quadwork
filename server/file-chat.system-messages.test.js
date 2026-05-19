"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const fileChat = require("./file-chat");

const PROJECT = "__system_msg_test__";

function cleanup() {
  try { fileChat.shutdownProject(PROJECT); } catch {}
  const dir = path.join(os.homedir(), ".quadwork", PROJECT);
  try { fs.rmSync(dir, { recursive: true }); } catch {}
}

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      passed++;
      console.log(`  PASS: ${msg}`);
    } else {
      failed++;
      console.error(`  FAIL: ${msg}`);
    }
  }

  // --- Test 1: system message is appended with correct fields ---
  cleanup();
  fileChat.initProject(PROJECT);
  const msg = fileChat.appendMessage(PROJECT, { sender: "system", type: "system", text: "head joined" });
  assert(msg.sender === "system", "sender is 'system'");
  assert(msg.type === "system", "type is 'system'");
  assert(msg.text === "head joined", "text matches lifecycle event");

  // --- Test 2: system messages do not increment loop guard counter ---
  fileChat.resetLoopGuard(PROJECT);
  fileChat.appendMessage(PROJECT, { sender: "system", type: "system", text: "dev joined" });
  fileChat.appendMessage(PROJECT, { sender: "system", type: "system", text: "re1 joined" });
  fileChat.appendMessage(PROJECT, { sender: "system", type: "system", text: "Discord bridge connected" });
  fileChat.checkLoopGuard(PROJECT, { sender: "system", type: "system" }, 3);
  assert(!fileChat.isLoopGuardPaused(PROJECT), "system messages do not trigger loop guard");

  // --- Test 3: system messages appear in readMessages output ---
  const messages = fileChat.readMessages(PROJECT, { limit: 10 });
  const systemMsgs = messages.filter((m) => m.type === "system");
  assert(systemMsgs.length === 4, `readMessages returns system messages (got ${systemMsgs.length})`);

  // --- Test 4: system messages have no @mentions parsed ---
  const bridgeMsg = fileChat.appendMessage(PROJECT, { sender: "system", type: "system", text: "Telegram bridge disconnected" });
  assert(
    !bridgeMsg.mentions || bridgeMsg.mentions.length === 0,
    "bridge system message has no mentions"
  );

  // --- Test 5: mixed agent + system messages — only agent messages count for loop guard ---
  fileChat.resetLoopGuard(PROJECT);
  for (let i = 0; i < 2; i++) {
    const agentMsg = fileChat.appendMessage(PROJECT, { sender: "head", type: "message", text: `msg ${i}` });
    fileChat.checkLoopGuard(PROJECT, agentMsg, 5);
  }
  fileChat.appendMessage(PROJECT, { sender: "system", type: "system", text: "re2 restarted" });
  fileChat.checkLoopGuard(PROJECT, { sender: "system", type: "system" }, 5);
  assert(!fileChat.isLoopGuardPaused(PROJECT), "system messages interleaved with agent messages don't affect hop count");

  cleanup();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
