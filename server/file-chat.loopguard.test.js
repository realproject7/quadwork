"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const fileChat = require("./file-chat");

const PROJECT = "__loop_guard_test__";

function cleanup() {
  try { fileChat.shutdownProject(PROJECT); } catch {}
  try { fileChat.resetLoopGuard(PROJECT); } catch {}
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

  console.log("\n--- Loop Guard Tests ---\n");

  // Test 1: agent messages trigger pause at threshold
  cleanup();
  fileChat.initProject(PROJECT);

  const maxHops = 5;
  for (let i = 0; i < maxHops; i++) {
    const msg = fileChat.appendMessage(PROJECT, {
      sender: "head",
      text: `agent message ${i + 1}`,
      channel: "general",
    });
    fileChat.checkLoopGuard(PROJECT, msg, maxHops);
  }
  assert(fileChat.isLoopGuardPaused(PROJECT), `pauses after ${maxHops} agent messages`);

  // Check that a system message was appended
  const msgs = fileChat.readMessages(PROJECT, { limit: 50 });
  const systemMsg = msgs.find((m) => m.sender === "system" && m.text.includes("Loop guard"));
  assert(!!systemMsg, "system pause message appended");

  // Test 2: user message resets counter
  cleanup();
  fileChat.initProject(PROJECT);

  for (let i = 0; i < 3; i++) {
    const msg = fileChat.appendMessage(PROJECT, { sender: "dev", text: `msg ${i}` });
    fileChat.checkLoopGuard(PROJECT, msg, maxHops);
  }
  assert(!fileChat.isLoopGuardPaused(PROJECT), "not paused after 3 of 5 hops");

  const userMsg = fileChat.appendMessage(PROJECT, { sender: "user", text: "ok" });
  fileChat.checkLoopGuard(PROJECT, userMsg, maxHops);

  // Now send another batch — should start from 0
  for (let i = 0; i < 4; i++) {
    const msg = fileChat.appendMessage(PROJECT, { sender: "re1", text: `after reset ${i}` });
    fileChat.checkLoopGuard(PROJECT, msg, maxHops);
  }
  assert(!fileChat.isLoopGuardPaused(PROJECT), "not paused after user reset + 4 more hops");

  // Test 3: /continue resumes
  cleanup();
  fileChat.initProject(PROJECT);

  for (let i = 0; i < maxHops; i++) {
    const msg = fileChat.appendMessage(PROJECT, { sender: "head", text: `loop ${i}` });
    fileChat.checkLoopGuard(PROJECT, msg, maxHops);
  }
  assert(fileChat.isLoopGuardPaused(PROJECT), "paused before /continue");

  const continueMsg = fileChat.appendMessage(PROJECT, { sender: "user", text: "/continue" });
  fileChat.checkLoopGuard(PROJECT, continueMsg, maxHops);
  assert(!fileChat.isLoopGuardPaused(PROJECT), "/continue resumes loop guard");

  const allMsgs = fileChat.readMessages(PROJECT, { limit: 100 });
  const resumeMsg = allMsgs.find((m) => m.text === "Loop guard resumed.");
  assert(!!resumeMsg, "/continue appends 'Loop guard resumed.' system message");

  // Test 4: system messages don't count as hops
  cleanup();
  fileChat.initProject(PROJECT);

  for (let i = 0; i < 3; i++) {
    const msg = fileChat.appendMessage(PROJECT, { sender: "dev", text: `agent ${i}` });
    fileChat.checkLoopGuard(PROJECT, msg, maxHops);
  }
  const sysMsg = fileChat.appendMessage(PROJECT, { sender: "system", text: "status", type: "system" });
  fileChat.checkLoopGuard(PROJECT, sysMsg, maxHops);
  // Should still be at 3 hops, not 4
  const agentAfter = fileChat.appendMessage(PROJECT, { sender: "dev", text: "agent 3" });
  fileChat.checkLoopGuard(PROJECT, agentAfter, maxHops);
  assert(!fileChat.isLoopGuardPaused(PROJECT), "system messages don't count as hops (4 agent + 1 system = not paused at 5)");

  // Cleanup
  cleanup();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
