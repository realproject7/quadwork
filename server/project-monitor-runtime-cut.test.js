"use strict";

// M2 cut test: durable Monitor state → sealed JSONL receipt → shared deferred
// PTY path. It uses a busy fake Head and direct deadline-free facts, so there
// is no real sleep or scheduler involved.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qw-monitor-runtime-cut-"));
const originalHome = os.homedir;
os.homedir = () => home;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

const fileChat = require("./file-chat");
const { createProjectMonitorStateStore, initialMonitorState } = require("./project-monitor-state");
const { createTrustedEventTransport } = require("./trusted-event-transport");
const { createProjectMonitorController } = require("./project-monitor");
const { dispatchTrustedMonitorEvent, cancelProject, _pendingWake } = require("./pty-dispatcher");

const projectId = "alpha";
const assignment = {
  assignment_key: "repo:owner/repo#42",
  subject_key: "primary:issue#42",
  cycle_id: "cycle-7",
};
const store = createProjectMonitorStateStore({ homeDir: home });
store.save(projectId, initialMonitorState("enabled"));
fileChat.initProject(projectId);

const writes = [];
function headSession(generation) {
  return {
    projectId,
    agentId: "head",
    state: "running",
    lifecycleState: "verified",
    generationId: generation,
    lastOutputAt: Date.now(), // busy: force shared pending/defer without waiting
    term: {
      write: (text) => writes.push(text),
      onData: () => ({ dispose() {} }),
    },
  };
}
const sessions = new Map([[`${projectId}/head`, headSession("head-old")]]);
let wakeCalls = 0;
const transport = createTrustedEventTransport({
  stateStore: store,
  isProjectAdmitted: () => true,
  appendTrustedEventOnce: (envelope) => fileChat.appendTrustedMonitorEventOnce(projectId, {
    ...envelope,
    resume: { batch_id: "batch-1047", head_generation: 0 },
  }),
  currentTrustedRecipientGeneration: ({ envelope }) => {
    const session = sessions.get(`${projectId}/head`);
    if (!session || session.lifecycleState !== "verified") return null;
    return envelope.anchors.assignment_key === assignment.assignment_key && envelope.anchors.subject_key === assignment.subject_key
      ? session.generationId : null;
  },
  wakeTrustedRecipient: ({ envelope }) => {
    wakeCalls += 1;
    return dispatchTrustedMonitorEvent(projectId, envelope, sessions, {
      isProjectAdmitted: () => true,
      isTrustedEventCurrent: (event, session) => event.anchors.assignment_key === assignment.assignment_key
        && event.anchors.subject_key === assignment.subject_key && session.lifecycleState === "verified",
      safeWrite: (term, text) => { term.write(text); return true; },
    });
  },
});
const controller = createProjectMonitorController({ stateStore: store, transport });

(async () => {
  const first = await controller.observe({
    project_id: projectId,
    readiness: true,
    assignment,
    ci: { required_state: "red" },
  });
  assert.equal(first.changed, true);
  assert.equal(wakeCalls, 1);
  assert.equal(_pendingWake.has(`${projectId}/head`), true);
  assert.equal(fileChat.readMessages(projectId, { since_id: 0, limit: 10 }).length, 1);

  // The old Head exits before deferred injection. Project cancellation removes
  // only its pending dispatcher work; the appended Monitor receipt remains.
  cancelProject(projectId);
  sessions.set(`${projectId}/head`, headSession("head-new"));
  assert.equal(_pendingWake.has(`${projectId}/head`), false);

  const retried = await controller.resumePending(projectId);
  assert.equal(retried.resumed, 1);
  assert.equal(wakeCalls, 2);
  assert.equal(_pendingWake.has(`${projectId}/head`), true);
  assert.equal(fileChat.readMessages(projectId, { since_id: 0, limit: 10 }).length, 1,
    "new generation reuses the original JSONL receipt");

  const duplicate = await controller.resumePending(projectId);
  assert.equal(duplicate.resumed, 0);
  assert.equal(wakeCalls, 2, "same verified new generation receives no duplicate wake");
  assert.equal(writes.length, 0, "busy path never bypasses the shared dispatcher with a direct write");

  cancelProject(projectId);
  fileChat.shutdownProject(projectId);
  console.log("project-monitor-runtime-cut.test.js: all assertions passed");
})().catch((error) => {
  try { cancelProject(projectId); } catch {}
  try { fileChat.shutdownProject(projectId); } catch {}
  console.error(error);
  process.exit(1);
});
