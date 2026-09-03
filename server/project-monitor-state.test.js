"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MONITOR_STATE_FILENAME,
  ProjectMonitorStateError,
  createProjectMonitorStateStore,
  initialMonitorState,
} = require("./project-monitor-state");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "qw-monitor-state-"));
process.on("exit", () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

const anchors = {
  project_id: "alpha",
  assignment_key: "repo:owner/repo#42",
  subject_key: "primary:issue#42",
  event_generation: "abcdef1234567890",
};

// Reading a missing state is read-only. The first explicit persistence is an
// owner-only, atomic file and includes no transcript/terminal data.
{
  const store = createProjectMonitorStateStore({ homeDir: home, randomBytes: () => Buffer.alloc(12, 7) });
  const missing = store.load("alpha");
  assert.equal(missing.mode, "suspended");
  assert.equal(fs.existsSync(store.pathFor("alpha")), false);

  const state = initialMonitorState("enabled");
  state.observation_hash = "a".repeat(64);
  state.unresolved["waiting_overdue:a"] = {
    key: "waiting_overdue:a",
    kind: "waiting_overdue",
    anchors,
    due_at: 1_800_000_000_000,
  };
  state.deliveries["b".repeat(64)] = {
    kind: "waiting_overdue",
    phase: "appended",
    anchors,
    anchor_hash: "c".repeat(64),
    chat_event_id: "17",
    delivery_generation: null,
  };
  const saved = store.save("alpha", state);
  const statePath = store.pathFor("alpha");
  assert.equal(path.basename(statePath), MONITOR_STATE_FILENAME);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);
  assert.equal(saved.deliveries["b".repeat(64)].phase, "appended");
  const raw = fs.readFileSync(statePath, "utf8");
  assert.equal(raw.includes("terminal bytes"), false);
  assert.equal(raw.includes("[STATUS]"), false);
  assert.equal(createProjectMonitorStateStore({ homeDir: home }).load("alpha").unresolved["waiting_overdue:a"].due_at, 1_800_000_000_000);
}

// Archive compacts all unresolved and pending-delivery state; later unarchive
// must be an explicit fresh start rather than a stale replay.
{
  const store = createProjectMonitorStateStore({ homeDir: home });
  const archived = initialMonitorState("archived");
  archived.observation_hash = "d".repeat(64);
  archived.unresolved.old = { key: "old", kind: "blocked", anchors, due_at: 1 };
  archived.deliveries["e".repeat(64)] = {
    kind: "blocked", phase: "recorded", anchors, anchor_hash: "f".repeat(64), chat_event_id: null, delivery_generation: null,
  };
  const saved = store.save("alpha", archived);
  assert.deepEqual(Object.keys(saved.unresolved), []);
  assert.deepEqual(Object.keys(saved.deliveries), []);
}

// A project directory symlink is rejected before any temp file/write follows
// it. This protects the monitor receipt from escaping ~/.quadwork.
{
  const unsafeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qw-monitor-state-unsafe-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-monitor-state-external-"));
  try {
    fs.mkdirSync(path.join(unsafeHome, ".quadwork"));
    fs.symlinkSync(external, path.join(unsafeHome, ".quadwork", "beta"));
    const store = createProjectMonitorStateStore({ homeDir: unsafeHome });
    assert.throws(() => store.save("beta", initialMonitorState("enabled")), (error) =>
      error instanceof ProjectMonitorStateError && error.code === "monitor_state_unsafe");
  } finally {
    fs.rmSync(unsafeHome, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
}

console.log("project-monitor-state.test.js: all assertions passed");
