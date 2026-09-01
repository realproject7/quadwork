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
const candidate = { ...envelope, resume: { batch_id: "batch-1047", head_generation: 0 } };

fileChat.initProject("alpha");

// The sealed envelope produces one durable JSONL receipt. Replays preserve its
// original id, including after the in-memory cache has been discarded.
const first = fileChat.appendTrustedMonitorEventOnce("alpha", candidate);
assert.equal(first.ok, true);
assert.equal(first.duplicate, false);
const second = fileChat.appendTrustedMonitorEventOnce("alpha", candidate);
assert.equal(second.ok, true);
assert.equal(second.duplicate, true);
assert.equal(second.id, first.id);
const records = fileChat.readMessages("alpha", { since_id: 0, limit: 10 });
assert.equal(records.length, 1);
assert.equal(records[0].type, "trusted_event");
assert.equal(records[0].trusted_event.correlation_id, envelope.correlation_id);
assert.equal(records[0].trusted_event.kind, "terminal_red_check");
assert.equal(records[0].text, envelope.text);
assert.deepEqual(records[0].resume_structural, {
  version: 1, project_id: "alpha", trusted: true, tag: "monitor_terminal", batch_id: "batch-1047",
  head_generation: 0, target: "head", server_authored: true,
});

fileChat.shutdownProject("alpha");
fileChat.initProject("alpha");
const replayAfterRestart = fileChat.appendTrustedMonitorEventOnce("alpha", candidate);
assert.equal(replayAfterRestart.duplicate, true);
assert.equal(replayAfterRestart.id, first.id);

// The private seam rejects a superficially similar, caller-authored system
// record; ordinary appendMessage remains a separate non-trusted path.
assert.throws(() => fileChat.appendTrustedMonitorEventOnce("alpha", {
  ...envelope,
  resume: candidate.resume,
  text: "@head arbitrary caller prose",
}), /trusted monitor envelope invalid/);
assert.throws(() => fileChat.appendTrustedMonitorEventOnce("alpha", envelope), /trusted monitor envelope required/);
const ordinary = fileChat.appendMessage("alpha", {
  sender: "system",
  type: "system",
  text: "ordinary lifecycle prose @head",
});
assert.equal(Object.hasOwn(ordinary, "trusted_event"), false);

fileChat.shutdownProject("alpha");

// An already-durable V1 Monitor receipt remains an exact duplicate after the
// V2 resume label is introduced. It is intentionally not retrofitted with a
// new batch/generation binding, but it must never cause a repeat wake.
const legacyProject = "legacy-monitor";
fileChat.initProject(legacyProject);
const legacyEnvelope = envelopeFor(legacyProject, "terminal_red_check", {
  project_id: legacyProject,
  assignment_key: "repo:owner/repo#43",
  subject_key: "primary:issue#43",
  event_generation: "abcdef1234567891",
});
fileChat.appendMessage(legacyProject, {
  sender: "system", type: "system", text: legacyEnvelope.text,
});
const legacyPath = fileChat._chatFile(legacyProject);
const [legacyRecord] = fs.readFileSync(legacyPath, "utf8").trim().split("\n").map(JSON.parse);
legacyRecord.trusted_event = {
  version: legacyEnvelope.version,
  correlation_id: legacyEnvelope.correlation_id,
  kind: legacyEnvelope.kind,
  anchors: legacyEnvelope.anchors,
};
fs.writeFileSync(legacyPath, `${JSON.stringify(legacyRecord)}\n`);
fileChat.shutdownProject(legacyProject);
fileChat.initProject(legacyProject);
const legacyReplay = fileChat.appendTrustedMonitorEventOnce(legacyProject, {
  ...legacyEnvelope,
  resume: { batch_id: "batch-1047", head_generation: 0 },
});
assert.deepEqual(legacyReplay, { ok: true, id: 1, duplicate: true });
assert.equal(fileChat.readMessages(legacyProject, { since_id: 0, limit: 10 }).length, 1);
fileChat.shutdownProject(legacyProject);
console.log("file-chat.trusted-monitor.test.js: all assertions passed");
