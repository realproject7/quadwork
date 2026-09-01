"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qw-file-chat-monitor-"));
const originalHome = os.homedir;
os.homedir = () => home;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

const fileChat = require("./file-chat");
const { envelopeFor } = require("./trusted-event-transport");

const envelope = envelopeFor("alpha", "terminal_red_check", {
  project_id: "alpha",
  assignment_key: "repo:owner/repo#42",
  subject_key: "primary:issue#42",
  event_generation: "abcdef1234567890",
});

fileChat.initProject("alpha");

// The sealed envelope produces one durable JSONL receipt. Replays preserve its
// original id, including after the in-memory cache has been discarded.
const first = fileChat.appendTrustedMonitorEventOnce("alpha", envelope);
assert.equal(first.ok, true);
assert.equal(first.duplicate, false);
const second = fileChat.appendTrustedMonitorEventOnce("alpha", envelope);
assert.equal(second.ok, true);
assert.equal(second.duplicate, true);
assert.equal(second.id, first.id);
const records = fileChat.readMessages("alpha", { since_id: 0, limit: 10 });
assert.equal(records.length, 1);
assert.equal(records[0].type, "system");
assert.equal(records[0].trusted_event.correlation_id, envelope.correlation_id);
assert.equal(records[0].trusted_event.kind, "terminal_red_check");
assert.equal(records[0].text, envelope.text);

fileChat.shutdownProject("alpha");
fileChat.initProject("alpha");
const replayAfterRestart = fileChat.appendTrustedMonitorEventOnce("alpha", envelope);
assert.equal(replayAfterRestart.duplicate, true);
assert.equal(replayAfterRestart.id, first.id);

// The private seam rejects a superficially similar, caller-authored system
// record; ordinary appendMessage remains a separate non-trusted path.
assert.throws(() => fileChat.appendTrustedMonitorEventOnce("alpha", {
  ...envelope,
  text: "@head arbitrary caller prose",
}), /trusted monitor envelope invalid/);
const ordinary = fileChat.appendMessage("alpha", {
  sender: "system",
  type: "system",
  text: "ordinary lifecycle prose @head",
});
assert.equal(Object.hasOwn(ordinary, "trusted_event"), false);

fileChat.shutdownProject("alpha");
console.log("file-chat.trusted-monitor.test.js: all assertions passed");
