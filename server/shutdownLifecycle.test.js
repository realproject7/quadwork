"use strict";

// Deterministic failure/ownership cases complement shutdownCleanup's real PTYs.
// Signal-zero probes below recognize only fictitious PIDs; no OS signals occur.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-shutdown-lifecycle-"));
const originalHome = os.homedir;
const originalKill = process.kill;
const originalSkipListen = process.env.QUADWORK_SKIP_LISTEN;
os.homedir = () => temp;
process.env.QUADWORK_SKIP_LISTEN = "1";
fs.mkdirSync(path.join(temp, ".quadwork"));
fs.writeFileSync(path.join(temp, ".quadwork", "config.json"), JSON.stringify({
  temp_cleanup: { enabled: false },
  projects: [{ id: "fixture", name: "fixture", working_dir: temp, agents: {} }],
}));
const runtime = require("./index");
const dispatcher = require("./pty-dispatcher");
const fictitious = new Set([90000001, 90000002, 90000003, 90000004]);
process.kill = (pid, signal) => {
  assert.equal(signal, 0, "the implementation only probes; each PTY object owns signaling");
  assert.equal(fictitious.has(pid), true, "no unrelated PID may be probed");
  return true;
};
function session(role, term) {
  const value = { projectId: "fixture", agentId: role, term, state: "running", lifecycleState: "verified", viewers: new Set() };
  runtime.agentSessions.set(`fixture/${role}`, value);
  return value;
}

(async () => {
  // An exit observation invalidates a PID even when signal-zero would now find
  // a replacement process. The old owner must never receive a later SIGKILL.
  let observeExit;
  const reusedSignals = [];
  session("exited", {
    pid: 90000001,
    onExit: (callback) => { observeExit = callback; return { dispose() {} }; },
    kill: (signal) => { reusedSignals.push(signal); queueMicrotask(() => observeExit({ exitCode: 0 })); },
  });
  const exited = await runtime.stopAgentSession("fixture/exited");
  assert.equal(exited.ok, true);
  assert.deepEqual(reusedSignals, [undefined], "exit observation forbids escalation against a reused PID");

  const replacementSignals = [];
  const replacement = { pid: 90000003, kill: (signal) => replacementSignals.push(signal) };
  let changing;
  changing = session("changed", {
    pid: 90000002,
    kill: () => { changing.term = replacement; },
  });
  const changed = await runtime.stopAgentSession("fixture/changed");
  assert.equal(changed.ok, false);
  assert.equal(changing.term, replacement, "a changed owner is retained instead of silently cleared");
  assert.deepEqual(replacementSignals, [], "a replacement PTY is never signaled by the earlier stop");
  runtime.agentSessions.delete("fixture/changed");

  const signals = [];
  const stubborn = session("stubborn", { pid: 90000004, kill: (signal) => signals.push(signal) });
  let viewerClosed = 0;
  stubborn.viewers.add({ readyState: 1, close() { viewerClosed += 1; }, terminate() { this.readyState = 3; } });
  let proxyClosed = 0;
  runtime.mcpProxies.set("fixture/stubborn", { server: { close(callback) { proxyClosed += 1; callback(); } } });
  let delayedWrites = 0;
  dispatcher._submitTimers.set("fixture/stubborn", setTimeout(() => { delayedWrites += 1; }, 100));
  dispatcher._pendingWake.set("fixture/stubborn", { pending: true });

  const first = runtime.shutdown();
  assert.equal(runtime.shutdown(), first);
  assert.equal(dispatcher._submitTimers.has("fixture/stubborn"), false, "deferred submits cancel synchronously");
  assert.equal(dispatcher._pendingWake.has("fixture/stubborn"), false);
  const result = await first;
  assert.equal(result.ok, false, "a surviving owned child cannot yield successful shutdown");
  assert.equal(result.cleanup_errors.some((error) => error.code === "pty_stop_failed"), true);
  assert.deepEqual(signals, [undefined, "SIGKILL"], "graceful termination and forced termination each run once");
  assert.equal(stubborn.state, "error");
  assert.equal(stubborn.lifecycleState, "unknown", "failed cleanup does not claim the session stopped");
  assert.equal(viewerClosed, 1);
  assert.equal(proxyClosed, 1);
  assert.equal(delayedWrites, 0);
  assert.equal(await runtime.shutdown(), result);
  assert.deepEqual(signals, [undefined, "SIGKILL"]);
  console.log("shutdownLifecycle.test.js: bounded failure, owner replacement, exit observation, cancellation and idempotence passed");
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  process.kill = originalKill;
  os.homedir = originalHome;
  if (originalSkipListen === undefined) delete process.env.QUADWORK_SKIP_LISTEN;
  else process.env.QUADWORK_SKIP_LISTEN = originalSkipListen;
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
});
