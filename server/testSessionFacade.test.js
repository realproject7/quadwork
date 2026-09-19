"use strict";

// The facade exists solely for isolated legacy test processes. These checks
// execute both boundaries: a clean child import without the flag has neither
// public nor _test access, while a flagged process rejects replacing a
// pre-existing reviewed entry with an ordinary session.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "qw-session-facade-"));
const configDir = path.join(home, ".quadwork");
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ projects: [], temp_cleanup: { enabled: false } }), { mode: 0o600 });

test("normal imports have no mutable legacy session facade", () => {
  const script = `
    const os = require("node:os");
    os.homedir = () => process.env.QW_FACADE_HOME;
    process.env.HOME = process.env.QW_FACADE_HOME;
    process.env.QUADWORK_SKIP_LISTEN = "1";
    delete process.env.QUADWORK_TEST_RUNTIME;
    const runtime = require("./server/index");
    const absent = !Object.hasOwn(runtime, "agentSessions") && !Object.hasOwn(runtime._test, "agentSessions");
    Promise.resolve(runtime.shutdown()).then(() => process.exit(absent ? 0 : 1));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, QW_FACADE_HOME: home, QUADWORK_TEST_RUNTIME: "" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

const originalHome = os.homedir;
os.homedir = () => home;
process.env.HOME = home;
process.env.QUADWORK_SKIP_LISTEN = "1";
process.env.QUADWORK_TEST_RUNTIME = "1";
const runtime = require("./index");

test("flagged facade rejects any reviewed entry or replacement", () => {
  assert.equal(Object.hasOwn(runtime._test, "agentSessions"), true);
  assert.equal(Object.hasOwn(runtime._test, "createSessionFacade"), true);
  const sessions = new Map([
    ["reviewed", { reviewedExecution: true }],
    ["ordinary", { reviewedExecution: false }],
  ]);
  const facade = runtime._test.createSessionFacade(sessions);
  assert.throws(() => facade.set("reviewed", { reviewedExecution: false }), /reviewed_session_test_hook_denied/);
  assert.throws(() => facade.set("ordinary", { reviewedExecution: true }), /reviewed_session_test_hook_denied/);
  assert.equal(sessions.get("reviewed").reviewedExecution, true);
  assert.equal(sessions.get("ordinary").reviewedExecution, false);
  facade.set("ordinary", { reviewedExecution: false, replacement: true });
  assert.equal(sessions.get("ordinary").replacement, true);
});

test.after(async () => {
  await runtime.shutdown();
  os.homedir = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});
