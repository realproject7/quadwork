"use strict";

// #1036/#1044: drive the Head-only Project Monitor, the read surfaces, and
// bounded worker recovery the way a real Head does: a spawned Head-control
// MCP shim -> the real Express app's /api/head-control route -> the
// server-composed runtime -> index.js's monitor/lifecycle owners.  Real PTYs
// are spawned for the worker (`/usr/bin/true` exits at once, which is exactly
// the structured loss the recovery path must see).  Nothing here asserts
// against source text.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-monitor-"));
const originalHome = os.homedir;
os.homedir = () => TMP;
process.env.HOME = TMP;
process.env.QUADWORK_SKIP_LISTEN = "1";

const CONFIG_DIR = path.join(TMP, ".quadwork");
const PROJECT = "monitored";
const INSTALLATION = "installation_monitor_0000001";
const TOKEN = "head-control-monitor-token-0001";
const GENERATION_CLOCK = { value: null };
const REPO_DIR = path.join(TMP, "repo");
const WORKTREES = { head: path.join(TMP, "repo-head"), dev: path.join(TMP, "repo-dev") };
for (const dir of [path.join(CONFIG_DIR, PROJECT), REPO_DIR, ...Object.values(WORKTREES)]) fs.mkdirSync(dir, { recursive: true });
// The durable Head-control domain refuses a config directory that is not 0700.
fs.chmodSync(CONFIG_DIR, 0o700);
const TRUE_BIN = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";

fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({
  installation_id: INSTALLATION,
  port: 8400,
  projects: [{
    id: PROJECT,
    name: PROJECT,
    archived: false,
    chat_mode: "file",
    repositories: [{ key: "primary", repo: "Owner/Repo", working_dir: REPO_DIR, primary: true, ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["operator"] } }],
    agents: {
      head: { cwd: WORKTREES.head, command: TRUE_BIN },
      dev: { cwd: WORKTREES.dev, command: TRUE_BIN },
    },
  }],
}));
fs.writeFileSync(path.join(CONFIG_DIR, PROJECT, "OVERNIGHT-QUEUE.md"), [
  "## Active Batch",
  "**Batch:** 7",
  "**Batch type:** code",
  `**Installation ID:** ${INSTALLATION}`,
  "**Assignment attempt:** attempt_a",
  "- Owner/Repo#42 active",
  "- Owner/Repo#43 queued",
].join("\n"));

const routes = require("./routes");
const fileChat = require("./file-chat");
const { captureProjectAdmission } = require("./project-lifecycle");
const { ownershipKey, serializeWorkItemRefApi } = require("./work-item-ref");
const runtime = require("./index");
const SHIM = path.join(__dirname, "mcp-head-control-shim.js");

function seedProgress(overrides = {}) {
  const context = routes.readLiveBatchContext(PROJECT);
  const parsed = context.parsed;
  const admission = captureProjectAdmission(PROJECT);
  const provenance = { installation_id: INSTALLATION, batch_number: parsed.batchNumber, assignment_attempt: parsed.assignmentAttempt };
  const identity = {
    admission_generation: admission.generation,
    compatibility_mode: "v2",
    batch_observation_fingerprint: context.fingerprint,
    installation_id: INSTALLATION,
    batch_number: parsed.batchNumber,
    assignment_attempt: parsed.assignmentAttempt,
    provenance: "owned",
    assignment_key: parsed.assignmentKey,
    assignment_items: parsed.workItems.map((item) => ({ work_item_ref: serializeWorkItemRefApi(item.ref), ownership_key: ownershipKey(provenance, item.ref) })),
    current: true,
    owned: true,
    multi_repository: false,
  };
  const rows = overrides.rows || parsed.workItems.map(() => ({ status: "queued", live_pr: null, review_handoff: null }));
  const data = {
    ...identity,
    batch_type: "code",
    active: true,
    complete: overrides.complete === true,
    completeConfirmed: overrides.complete === true,
    liveActiveBatchCleared: false,
    items: parsed.workItems.map((item, index) => ({
      ...identity,
      repo_key: item.repoKey, repo: item.repo, number: item.number, kind: item.kind,
      issue_number: item.number,
      work_item_ref: serializeWorkItemRefApi(item.ref),
      ownership_key: ownershipKey(provenance, item.ref),
      ...rows[index],
    })),
  };
  routes._batchProgressCache.set(PROJECT, { ts: Date.now(), fingerprint: context.fingerprint, admission_generation: admission.generation, data });
  return { parsed, admission };
}

function monitorEvents() {
  return fileChat.readMessages(PROJECT, { since_id: 0, limit: 200 }).filter((record) => record.type === "trusted_event");
}
function monitorState() {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, PROJECT, "monitor-state.json"), "utf8"));
}
async function until(predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startShim(port) {
  const proc = spawn("node", [SHIM, "--project", PROJECT, "--agent", "head", "--generation", String(GENERATION_CLOCK.value), "--port", String(port), "--token", TOKEN], { stdio: ["pipe", "pipe", "pipe"] });
  let buffered = "";
  const queue = [];
  const waiters = [];
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message); else queue.push(message);
    }
  });
  function read() {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for shim response")), 15000);
      waiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }
  let nextId = 100;
  return {
    proc,
    send(message) { proc.stdin.write(JSON.stringify(message) + "\n"); return read(); },
    async handshake() {
      const initialized = await this.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0.0" } } });
      assert.equal(initialized.result?.serverInfo?.name, "quadwork-head-control");
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = await this.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      return listed.result.tools.map((tool) => tool.name);
    },
    async call(name, argumentsValue) {
      const response = await this.send({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: argumentsValue } });
      if (response.error) return { error: response.error };
      return JSON.parse(response.result.content[0].text);
    },
    stop() { proc.stdin.end(); return new Promise((resolve) => proc.once("close", resolve)); },
  };
}

let server = null;
let shim = null;
function cleanup() {
  try { if (shim) shim.proc.kill(); } catch {}
  try { if (server) server.close(); } catch {}
  for (const [key, session] of runtime.agentSessions) {
    if (key.startsWith(`${PROJECT}/`) && session?.term && typeof session.term.kill === "function") { try { session.term.kill(); } catch {} }
  }
  try { fileChat.shutdownProject(PROJECT); } catch {}
  os.homedir = originalHome;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

(async () => {
  let passed = 0;
  const ok = (value, message) => { assert.ok(value, message); passed += 1; console.log(`  PASS: ${message}`); };
  console.log("\n--- Head-only Project Monitor and recovery end-to-end (shim -> route -> runtime -> index.js owners) ---\n");

  fileChat.initProject(PROJECT);
  const { parsed, admission } = seedProgress();
  GENERATION_CLOCK.value = admission.generation;
  // A verified Head session is the recipient for monitor events and the launch
  // binding for the Head-control route; its fake PTY records every wake.
  const headWrites = [];
  runtime.agentSessions.set(`${PROJECT}/head`, {
    projectId: PROJECT, agentId: "head", state: "running", lifecycleState: "verified", generationId: "gen-head-1",
    operationId: "op-head-1", backend: "claude", lastOutputAt: Date.now(), startedAt: new Date().toISOString(),
    viewers: new Set(), viewerDims: new Map(), scrollback: Buffer.alloc(0),
    term: { pid: process.pid, write(text) { headWrites.push(text); }, kill() {}, onData() { return { dispose() {} }; } },
  });
  fileChat.registerShimToken(PROJECT, "head", TOKEN);
  runtime.headControlRuntime.registerHeadToken({ project_id: PROJECT, generation: admission.generation, token: TOKEN });
  server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  shim = startShim(port);
  try {
    const tools = await shim.handshake();
    assert.deepEqual(tools.slice(-5), ["get_project_status", "review_handoff", "project_monitor", "recover_worker", "recent_head_control_audit"]);

    // 1. Observe first: the read surface shows the qualified assignment,
    //    suspended monitor, worker facts with observation times, and capacity.
    const status = await shim.call("get_project_status", { idempotency_key: "idem_status_1", correlation_id: "corr_status_1" });
    assert.equal(status.decision.code, "head_control_project_observed");
    assert.equal(status.detail.readiness.ok, true);
    assert.equal(status.detail.assignment.attempt, "attempt_a");
    assert.equal(status.detail.assignment.subject.subject_key, "primary:issue#42");
    assert.equal(status.detail.monitor.mode, "suspended");
    assert.equal(status.detail.observations.progression.next_loaded_unassigned, true);
    assert.equal(status.detail.workers.dev.state, "stopped");
    assert.equal(status.detail.workers.head.verification_state, "verified");
    assert.equal(typeof status.detail.workers.head.last_output_at, "string");
    assert.equal(status.detail.capacity.platform, process.platform);
    assert.equal(Object.hasOwn(status.detail.workers.head, "pid"), false);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(TOKEN));
    ok(true, "get_project_status reads assignment, monitor, worker health with observation times, and capacity through the real route");

    // 2. start: enabled, one evaluation, exactly one Head-only event for the
    //    loaded-but-unassigned subject; the fixed text names no worker.
    const started = await shim.call("project_monitor", { idempotency_key: "idem_monitor_start", correlation_id: "corr_monitor_start", command: "start" });
    assert.equal(started.decision.code, "head_control_applied");
    assert.equal(started.detail.mode, "enabled");
    assert.equal(started.detail.evaluation.changed, true);
    assert.deepEqual(started.detail.evaluation.conditions.map((condition) => condition.kind), ["next_loaded_unassigned"]);
    assert.equal(monitorState().mode, "enabled");
    let events = monitorEvents();
    assert.equal(events.length, 1);
    assert.match(events[0].text, /^@head \[QW-MONITOR:next_loaded_unassigned\] assignment=b7-[a-f0-9]{16} subject=primary:issue#42 event=/);
    assert.doesNotMatch(events[0].text, /@dev|@re1|@re2|Review open PRs|Queue check/);
    const delivery = Object.values(monitorState().deliveries)[0];
    assert.equal(delivery.kind, "next_loaded_unassigned");
    assert.equal(delivery.delivery_generation, "gen-head-1");
    ok(true, "project_monitor start enables the monitor and writes exactly one Head-only structured event bound to the verified Head generation");

    // 3. evaluate_now on unchanged facts: zero writes, zero wakes.
    const unchanged = await shim.call("project_monitor", { idempotency_key: "idem_monitor_eval_1", correlation_id: "corr_monitor_eval_1", command: "evaluate_now" });
    assert.equal(unchanged.decision.code, "head_control_applied");
    assert.equal(unchanged.detail.changed, false);
    assert.equal(monitorEvents().length, 1);
    const replayed = await shim.call("project_monitor", { idempotency_key: "idem_monitor_eval_1", correlation_id: "corr_monitor_eval_1", command: "evaluate_now" });
    assert.equal(replayed.decision.kind, "replayed");
    ok(true, "an unchanged evaluation writes nothing and an exact retry is replayed from its receipt");

    // 4. A terminal-red CI observation on the current subject is one new event.
    seedProgress({ rows: [
      { status: "in_review", live_pr: { number: 7, tip: "a".repeat(40) }, review_handoff: { cycle_id: "rc_" + "1".repeat(32), repo_key: "primary", pr_number: 7, exact_sha: "a".repeat(40), readiness: "ready", ci: "product_failure", review: "0/2", mergeable: true, head_gate_due: false, dev_fix_owner: true } },
      { status: "queued", live_pr: null, review_handoff: null },
    ] });
    const red = await shim.call("project_monitor", { idempotency_key: "idem_monitor_eval_2", correlation_id: "corr_monitor_eval_2", command: "evaluate_now" });
    assert.equal(red.detail.changed, true);
    assert.deepEqual(red.detail.conditions.map((condition) => condition.kind), ["terminal_red_check"]);
    events = monitorEvents();
    assert.equal(events.length, 2);
    assert.match(events[1].text, /^@head \[QW-MONITOR:terminal_red_check\] .*sha=|^@head \[QW-MONITOR:terminal_red_check\] /);
    const handoff = await shim.call("review_handoff", { idempotency_key: "idem_handoff_1", correlation_id: "corr_handoff_1" });
    assert.equal(handoff.decision.code, "head_control_handoff_observed");
    assert.equal(handoff.detail.subject.subject_key, "primary:issue#42");
    assert.equal(handoff.detail.cycle, null, "a handoff with no durable current cycle is explicit, never presented as live");
    ok(true, "a terminal-red transition on the current subject produces one more Head event and review_handoff exposes the subject truthfully");

    // 5. Recovery preconditions: no loss evidence yet.
    const noLoss = await shim.call("recover_worker", { idempotency_key: "idem_recover_0", correlation_id: "corr_recover_0", recovery: { agent: "dev", expected_generation: "gen-none", assignment_attempt: "attempt_a", reason_code: "process_exited" } });
    assert.equal(noLoss.decision.kind, "denied");
    assert.equal(noLoss.decision.code, "head_control_recovery_refused");
    assert.equal(noLoss.detail.reason, "no_loss_evidence");
    const headRecovery = await shim.call("recover_worker", { idempotency_key: "idem_recover_head", correlation_id: "corr_recover_head", recovery: { agent: "head", expected_generation: "gen-head-1", assignment_attempt: "attempt_a", reason_code: "process_exited" } });
    assert.equal(headRecovery.error?.code, -32602, "the shim refuses a Head recovery before any request");
    ok(true, "recover_worker is refused without structured loss evidence and never accepts head");

    // 6. A real worker generation that exits is structured loss; the monitor
    //    observes the exit and Head can recover exactly that generation once.
    const launched = await runtime.spawnAgentPty(PROJECT, "dev", { lifecycleSource: "operator_start", operatorAuthorized: true, explicitRole: true, suppressLifecycleMsg: true });
    assert.equal(launched.ok, true);
    const lostGeneration = launched.lifecycle.generation_id;
    await until(() => runtime.agentSessions.get(`${PROJECT}/dev`)?.lifecycleState === "exited", "dev exit");
    await until(() => monitorEvents().length === 3, "worker exit event");
    assert.match(monitorEvents()[2].text, /^@head \[QW-MONITOR:worker_exit_before_status\] /);
    const afterExit = await shim.call("get_project_status", { idempotency_key: "idem_status_2", correlation_id: "corr_status_2" });
    assert.equal(afterExit.detail.workers.dev.state, "exited");
    assert.equal(afterExit.detail.workers.dev.generation_id, lostGeneration);
    assert.equal(afterExit.detail.workers.dev.health, "exited");
    const stale = await shim.call("recover_worker", { idempotency_key: "idem_recover_stale", correlation_id: "corr_recover_stale", recovery: { agent: "dev", expected_generation: "gen-stale", assignment_attempt: "attempt_a", reason_code: "process_exited" } });
    assert.equal(stale.detail.reason, "stale_expected_generation");
    const wrongAttempt = await shim.call("recover_worker", { idempotency_key: "idem_recover_attempt", correlation_id: "corr_recover_attempt", recovery: { agent: "dev", expected_generation: lostGeneration, assignment_attempt: "attempt_b", reason_code: "process_exited" } });
    assert.equal(wrongAttempt.detail.reason, "assignment_not_current");
    const recovered = await shim.call("recover_worker", { idempotency_key: "idem_recover_1", correlation_id: "corr_recover_1", recovery: { agent: "dev", expected_generation: lostGeneration, assignment_attempt: "attempt_a", reason_code: "process_exited" } });
    assert.equal(recovered.decision.code, "head_control_applied");
    assert.equal(recovered.detail.outcome, "spawned");
    assert.equal(recovered.detail.recovered, false, "spawned is never reported as recovery");
    assert.notEqual(recovered.detail.operation.generation_id, lostGeneration);
    await until(() => runtime.agentSessions.get(`${PROJECT}/dev`)?.lifecycleState === "exited" && runtime.agentSessions.get(`${PROJECT}/dev`)?.generationId !== lostGeneration, "recovered generation exit");
    const secondGeneration = runtime.agentSessions.get(`${PROJECT}/dev`).generationId;
    const circuit = await shim.call("recover_worker", { idempotency_key: "idem_recover_2", correlation_id: "corr_recover_2", recovery: { agent: "dev", expected_generation: secondGeneration, assignment_attempt: "attempt_a", reason_code: "process_exited" } });
    assert.equal(circuit.decision.code, "head_control_recovery_refused");
    assert.equal(circuit.detail.reason, "circuit_open", "a second early exit opens the #1053 circuit and Head cannot chain another trial");
    assert.equal(fs.readdirSync(WORKTREES.dev).length, 0, "recovery touched no worktree contents");
    ok(true, "a real exited generation is recovered exactly once through the governor, reported as spawned, and the circuit refuses a chained trial");

    // 7. Audit and stop.
    const audit = await shim.call("recent_head_control_audit", {});
    assert.deepEqual(audit.filter((record) => record.action === "recover_worker").map((record) => record.decision), ["denied", "denied", "denied", "accepted", "denied"]);
    assert.ok(audit.every((record) => !Object.hasOwn(record, "detail") && !Object.hasOwn(record, "payload")));
    const stopped = await shim.call("project_monitor", { idempotency_key: "idem_monitor_stop", correlation_id: "corr_monitor_stop", command: "stop" });
    assert.equal(stopped.detail.mode, "suspended");
    assert.equal(monitorState().mode, "suspended");
    const suspendedEvaluation = await shim.call("project_monitor", { idempotency_key: "idem_monitor_eval_3", correlation_id: "corr_monitor_eval_3", command: "evaluate_now" });
    assert.equal(suspendedEvaluation.decision.code, "head_control_monitor_refused");
    assert.equal(suspendedEvaluation.detail.reason, "monitor_suspended");
    assert.equal(monitorEvents().length, 3);
    ok(true, "every control is a redacted durable audit record, stop suspends, and a suspended monitor evaluates nothing");
  } finally {
    await shim.stop();
    shim = null;
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  console.log(`\n${passed} passed`);
  cleanup();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
