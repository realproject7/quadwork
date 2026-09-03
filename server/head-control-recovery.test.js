"use strict";

// #1053/#1044: drive worker recovery the way a real Head does (spawned
// Head-control MCP shim -> /api/head-control -> runtime -> index.js owners ->
// governor -> real node-pty) against a REAL dirty git worktree, and prove:
//   - read-only repository facts are captured before every recovery admission
//     and reach Head through recover_worker's detail (and the operator through
//     the restart result), while the worktree survives byte-unchanged;
//   - an open #1053 circuit admits exactly one Head-authorized trial, an exact
//     duplicate is replayed, a chained Head attempt is refused, the real
//     watchdog stays refused throughout, and a fresh operator action may
//     authorize another trial;
//   - a trial clears the circuit only when the recovered generation acts
//     through its own MCP wiring (an authenticated chat post with the token
//     minted for that spawn), never on its first PTY bytes, after which the
//     real watchdog is admitted again.
// Nothing here asserts against source text.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-head-recovery-"));
const originalHome = os.homedir;
os.homedir = () => TMP;
process.env.HOME = TMP;
process.env.QUADWORK_SKIP_LISTEN = "1";

const CONFIG_DIR = path.join(TMP, ".quadwork");
const PROJECT = "recovered";
const INSTALLATION = "installation_recover_000001";
const TOKEN = "head-control-recovery-token-001";
const REPO_DIR = path.join(TMP, "repo");
const REMOTE_DIR = path.join(TMP, "origin.git");
const WORKTREES = { head: path.join(TMP, "repo-head"), dev: path.join(TMP, "repo-dev") };
for (const dir of [path.join(CONFIG_DIR, PROJECT), REPO_DIR, WORKTREES.head]) fs.mkdirSync(dir, { recursive: true });
fs.chmodSync(CONFIG_DIR, 0o700);
const TRUE_BIN = fs.existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };
function sh(cwd, args) { return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
// The dev role worktree is a real linked worktree with an upstream, one
// unpushed commit, a modified tracked file, and an untracked file.
sh(REPO_DIR, ["init", "-q", "-b", "main"]);
fs.writeFileSync(path.join(REPO_DIR, "README.md"), "base\n");
sh(REPO_DIR, ["add", "README.md"]);
sh(REPO_DIR, ["commit", "-q", "-m", "base"]);
sh(TMP, ["init", "-q", "--bare", REMOTE_DIR]);
sh(REPO_DIR, ["remote", "add", "origin", REMOTE_DIR]);
sh(REPO_DIR, ["push", "-q", "-u", "origin", "main"]);
sh(REPO_DIR, ["worktree", "add", "-q", "-b", "task/42-recovery", WORKTREES.dev, "main"]);
sh(WORKTREES.dev, ["push", "-q", "-u", "origin", "task/42-recovery"]);
fs.writeFileSync(path.join(WORKTREES.dev, "feature.txt"), "wip\n");
sh(WORKTREES.dev, ["add", "feature.txt"]);
sh(WORKTREES.dev, ["commit", "-q", "-m", "feature"]);
fs.writeFileSync(path.join(WORKTREES.dev, "README.md"), "dirty uncommitted work\n");
fs.writeFileSync(path.join(WORKTREES.dev, "untracked.txt"), "never committed\n");
const DEV_HEAD = sh(WORKTREES.dev, ["rev-parse", "HEAD"]);
const PR_TIP = "b".repeat(40);

// Two stand-ins for a worker CLI.  One only paints its terminal.  The other
// does what a real CLI does with the `--mcp-config` it is spawned with: it
// starts the chat shim named there and posts through it with the token minted
// for this spawn (only the server port is patched, because the test server
// listens on an ephemeral port).  Neither touches the worktree.
const BYTES_ONLY_CLI = path.join(TMP, "bytes-only-cli.sh");
fs.writeFileSync(BYTES_ONLY_CLI, "#!/bin/sh\necho ready\nsleep 0.3\n", { mode: 0o755 });
const SHIM_CLI = path.join(TMP, "shim-cli.js");
fs.writeFileSync(SHIM_CLI, `#!/usr/bin/env node
const fs = require("fs");
const { spawn } = require("child_process");
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config") + 1], "utf8"));
const chat = config.mcpServers.chat;
const args = chat.args.map((value, index) => (chat.args[index - 1] === "--port" ? process.env.QW_TEST_SERVER_PORT : value));
process.stdout.write("ready\\n");
const shim = spawn(chat.command, args, { stdio: ["pipe", "pipe", "inherit"] });
shim.stdout.on("data", (chunk) => { if (String(chunk).includes('"id":3')) shim.stdin.end(); });
shim.on("close", () => process.exit(0));
for (const message of [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "worker-cli", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "chat_send", arguments: { message: "recovered and reporting in" } } },
]) shim.stdin.write(JSON.stringify(message) + "\\n");
`, { mode: 0o755 });
function setDevCommand(command) {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));
  cfg.projects[0].agents.dev.command = command;
  fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify(cfg));
}

function fingerprint(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      hash.update(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}
function worktreeObservation() {
  return { fingerprint: fingerprint(WORKTREES.dev), status: sh(WORKTREES.dev, ["status", "--porcelain"]), head: sh(WORKTREES.dev, ["rev-parse", "HEAD"]), branch: sh(WORKTREES.dev, ["symbolic-ref", "--short", "HEAD"]) };
}
const INITIAL_WORKTREE = worktreeObservation();

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

function seedProgress() {
  const context = routes.readLiveBatchContext(PROJECT);
  const parsed = context.parsed;
  const admission = captureProjectAdmission(PROJECT);
  const provenance = { installation_id: INSTALLATION, batch_number: parsed.batchNumber, assignment_attempt: parsed.assignmentAttempt };
  const identity = {
    admission_generation: admission.generation, compatibility_mode: "v2", batch_observation_fingerprint: context.fingerprint,
    installation_id: INSTALLATION, batch_number: parsed.batchNumber, assignment_attempt: parsed.assignmentAttempt,
    provenance: "owned", assignment_key: parsed.assignmentKey,
    assignment_items: parsed.workItems.map((item) => ({ work_item_ref: serializeWorkItemRefApi(item.ref), ownership_key: ownershipKey(provenance, item.ref) })),
    current: true, owned: true, multi_repository: false,
  };
  // The server already knows a PR/tip for the active subject; recovery must
  // report it beside the git facts rather than invent one.
  const rows = [{ status: "in_progress", live_pr: { number: 7, tip: PR_TIP }, review_handoff: null }, { status: "queued", live_pr: null, review_handoff: null }];
  const data = {
    ...identity, batch_type: "code", active: true, complete: false, completeConfirmed: false, liveActiveBatchCleared: false,
    items: parsed.workItems.map((item, index) => ({
      ...identity, repo_key: item.repoKey, repo: item.repo, number: item.number, kind: item.kind, issue_number: item.number,
      work_item_ref: serializeWorkItemRefApi(item.ref), ownership_key: ownershipKey(provenance, item.ref), ...rows[index],
    })),
  };
  routes._batchProgressCache.set(PROJECT, { ts: Date.now(), fingerprint: context.fingerprint, admission_generation: admission.generation, data });
  return { parsed, admission };
}

async function until(predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
function devSession() { return runtime.agentSessions.get(`${PROJECT}/dev`); }
async function devFacts() { return (await runtime.readHeadProjectStatus(PROJECT)).workers.dev; }
async function devExited(previousGeneration, label) {
  await until(() => devSession()?.lifecycleState === "exited" && devSession()?.generationId !== previousGeneration, label);
  return devSession().generationId;
}

function startShim(port, generation) {
  const proc = spawn("node", [SHIM, "--project", PROJECT, "--agent", "head", "--generation", String(generation), "--port", String(port), "--token", TOKEN], { stdio: ["pipe", "pipe", "pipe"] });
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
function recover(shim, suffix, generation) {
  return shim.call("recover_worker", { idempotency_key: `idem_recover_${suffix}`, correlation_id: `corr_recover_${suffix}`, recovery: { agent: "dev", expected_generation: generation, assignment_attempt: "attempt_a", reason_code: "process_exited" } });
}
// The real watchdog entry point with the self-heal respawn breaker held open,
// so the only thing that can refuse the automatic respawn is the governor.
async function watchdogRespawnAttempt() {
  const errors = [];
  await runtime.watchdogCheck({ shouldRespawn: () => "respawn", log: () => {}, errorLog: (message) => errors.push(message), emitSystemMessage: () => {} });
  return errors;
}
function assertRepositoryFacts(repository, label) {
  assert.equal(repository.available, true, `${label}: facts captured`);
  assert.equal(repository.path, WORKTREES.dev);
  assert.equal(repository.worktree.linked_worktree, true);
  assert.equal(fs.realpathSync(repository.worktree.common_dir), fs.realpathSync(path.join(REPO_DIR, ".git")));
  assert.equal(repository.branch, "task/42-recovery");
  assert.equal(repository.upstream, "origin/task/42-recovery");
  assert.equal(repository.head, DEV_HEAD);
  assert.equal(repository.ahead, 1);
  assert.equal(repository.behind, 0);
  assert.equal(repository.status.clean, false);
  assert.deepEqual(repository.status.entries, [" M README.md", "?? untracked.txt"]);
  assert.deepEqual(repository.known_prs, [{ subject: "primary:issue#42", pr: { number: 7, tip: PR_TIP } }, { subject: "primary:issue#43", pr: null }]);
  assert.equal(typeof repository.captured_at, "string");
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
  console.log("\n--- #1053 repository facts and the #1044 Head circuit trial end-to-end (shim -> route -> runtime -> governor -> node-pty) ---\n");

  fileChat.initProject(PROJECT);
  const { admission } = seedProgress();
  runtime.agentSessions.set(`${PROJECT}/head`, {
    projectId: PROJECT, agentId: "head", state: "running", lifecycleState: "verified", generationId: "gen-head-1",
    operationId: "op-head-1", backend: "claude", lastOutputAt: Date.now(), startedAt: new Date().toISOString(),
    viewers: new Set(), viewerDims: new Map(), scrollback: Buffer.alloc(0),
    term: { pid: process.pid, write() {}, kill() {}, onData() { return { dispose() {} }; } },
  });
  fileChat.registerShimToken(PROJECT, "head", TOKEN);
  runtime.headControlRuntime.registerHeadToken({ project_id: PROJECT, generation: admission.generation, token: TOKEN });
  server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  process.env.QW_TEST_SERVER_PORT = String(server.address().port);
  shim = startShim(server.address().port, admission.generation);
  // #1038 fails Linux worker admission closed when no systemd resource scope is
  // available, so a real PTY cannot be launched on CI without the in-process
  // containment fixture the runtime exposes for exactly this case. It is a
  // capability held in memory, not a route/config/environment value, so it
  // cannot grant production authority — and it is not VPS or staging evidence.
  // Without it these end-to-end tests pass on macOS (where containment is
  // reported unsupported) and fail on Linux, which is the product behaving
  // correctly, not a defect to be relaxed.
  const releaseContainment = runtime._test.installLifecycleTestFixture(PROJECT, "dev", "linux-contained");
  try {
    const tools = await shim.handshake();
    assert.ok(tools.includes("recover_worker"));

    // 1. A first operator start is not a recovery: no prior loss, no facts.
    const launched = await runtime.spawnAgentPty(PROJECT, "dev", { lifecycleSource: "operator_start", operatorAuthorized: true, explicitRole: true, suppressLifecycleMsg: true });
    assert.equal(launched.ok, true);
    assert.equal(launched.repository, null);
    const generation1 = launched.lifecycle.generation_id;
    await until(() => devSession()?.lifecycleState === "exited", "first exit");
    ok(true, "a first start captures nothing: there is no loss to recover from");

    // 2. Head's recovery of the lost generation reports the dirty worktree,
    //    branch/upstream, HEAD/origin relation, and the known PR before the
    //    new generation exists; the result is `spawned`, never recovered.
    seedProgress();
    const first = await recover(shim, "1", generation1);
    assert.equal(first.decision.code, "head_control_applied");
    assert.equal(first.detail.outcome, "spawned");
    assert.equal(first.detail.recovered, false);
    assertRepositoryFacts(first.detail.repository, "first recovery");
    assert.doesNotMatch(JSON.stringify(first), new RegExp(TOKEN));
    const generation2 = await devExited(generation1, "second exit");
    ok(true, "recover_worker returns read-only repository facts (dirty status, branch, upstream, ahead/behind, HEAD, known PR) with the spawned result");

    // 3. The bounded automatic retry is exhausted: the circuit opens, the
    //    refusal still carries the facts captured before the governor decided.
    seedProgress();
    const opened = await recover(shim, "2", generation2);
    assert.equal(opened.decision.code, "head_control_recovery_refused");
    assert.equal(opened.detail.reason, "circuit_open");
    assert.equal(opened.detail.operation.state, "rejected");
    assert.equal(opened.detail.operation.circuit.open, true);
    assert.equal(opened.detail.operation.circuit.head_trial_operation_id, null);
    assertRepositoryFacts(opened.detail.repository, "refused recovery");
    const status = await shim.call("get_project_status", { idempotency_key: "idem_status_1", correlation_id: "corr_status_1" });
    assert.equal(status.detail.workers.dev.generation_id, generation2);
    assert.equal(status.detail.workers.dev.circuit.open, true);
    const lossCorrelation = status.detail.workers.dev.circuit.loss_correlation;
    assert.equal(typeof lossCorrelation, "string");
    ok(true, "an exhausted automatic retry opens the circuit; the refusal and the status read both expose it with the facts");

    // 4. The real watchdog is an automatic caller: refused by the governor on
    //    the open circuit, no process, no generation change.
    seedProgress();
    let watchdog = await watchdogRespawnAttempt();
    assert.equal(watchdog.length, 1);
    assert.match(watchdog[0], /auto-respawn failed: circuit_open/);
    assert.equal(devSession().generationId, generation2);
    ok(true, "the watchdog's automatic respawn is refused on the open circuit through the real entry point");

    // 5. Head takes the one permitted explicit trial by naming the exact lost
    //    generation for the current assignment; the server binds the loss
    //    correlation from its own record.  The circuit stays open with the
    //    trial recorded; an exact duplicate is replayed, not re-spawned.
    seedProgress();
    const trial = await recover(shim, "3", generation2);
    assert.equal(trial.decision.code, "head_control_applied");
    assert.equal(trial.detail.outcome, "spawned");
    assert.equal(trial.detail.recovered, false);
    assert.equal(trial.detail.operation.circuit.open, true);
    assert.equal(trial.detail.operation.circuit.trial_operation_id, trial.detail.operation.operation_id);
    assert.equal(trial.detail.operation.circuit.head_trial_operation_id, trial.detail.operation.operation_id);
    assert.equal(trial.detail.operation.circuit.loss_correlation, lossCorrelation);
    assertRepositoryFacts(trial.detail.repository, "head trial");
    const duplicate = await recover(shim, "3", generation2);
    assert.equal(duplicate.decision.kind, "replayed");
    const generation3 = await devExited(generation2, "trial exit");
    assert.equal(generation3, trial.detail.operation.generation_id);
    ok(true, "an authenticated Head takes exactly one circuit trial and its duplicate observes the same operation");

    // 6. A failed Head trial cannot be chained by Head; automatic callers stay
    //    refused; only a fresh operator action authorizes another trial.
    seedProgress();
    const chained = await recover(shim, "4", generation3);
    assert.equal(chained.decision.code, "head_control_recovery_refused");
    assert.equal(chained.detail.reason, "head_trial_consumed");
    assert.equal(chained.detail.operation.circuit.open, true);
    assert.equal(chained.detail.operation.circuit.head_trial_operation_id, trial.detail.operation.operation_id);
    watchdog = await watchdogRespawnAttempt();
    assert.match(watchdog[0] || "", /auto-respawn failed: circuit_open/);
    assert.equal(devSession().generationId, generation3);
    seedProgress();
    const operator = await runtime.restartAgentSession(`${PROJECT}/dev`, {
      reason: "manual", clearSelfHeal: true, lifecycleSource: "operator_restart", operatorAuthorized: true, explicitRole: true,
      expectedGeneration: generation3, lossCorrelation,
    });
    assert.equal(operator.ok, true);
    assert.equal(operator.lifecycle.state, "spawned");
    assert.equal(operator.lifecycle.circuit.open, true);
    assert.equal(operator.lifecycle.circuit.trial_operation_id, operator.lifecycle.operation_id);
    assertRepositoryFacts(operator.repository, "operator trial");
    const generation4 = await devExited(generation3, "operator trial exit");
    assert.equal(generation4, operator.lifecycle.generation_id);
    ok(true, "Head cannot chain a second trial, the watchdog remains refused, and a fresh operator restart may authorize one more");

    // 6b. A trial's first PTY bytes are not recovery: a worker that only
    //     paints its terminal and exits leaves the circuit open, so a
    //     banner-then-crash can never reset the bounded retry budget.
    setDevCommand(BYTES_ONLY_CLI);
    seedProgress();
    const painted = await runtime.restartAgentSession(`${PROJECT}/dev`, {
      reason: "manual", clearSelfHeal: true, lifecycleSource: "operator_restart", operatorAuthorized: true, explicitRole: true,
      expectedGeneration: generation4, lossCorrelation,
    });
    assert.equal(painted.ok, true);
    assert.equal(painted.lifecycle.circuit.trial_operation_id, painted.lifecycle.operation_id);
    const paintedFacts = await until(async () => {
      const facts = await devFacts();
      return facts.generation_id === painted.lifecycle.generation_id && facts.verification_state === "verified" ? facts : null;
    }, "bytes-only trial persisted as verified");
    assert.equal(paintedFacts.circuit.open, true, "first PTY bytes alone do not clear the circuit");
    assert.equal(paintedFacts.last_chat_at, null);
    const generation5 = await devExited(generation4, "bytes-only trial exit");
    assert.equal((await devFacts()).circuit.open, true);
    assert.equal((await devFacts()).circuit.expected_generation, generation5);
    seedProgress();
    assert.match((await watchdogRespawnAttempt())[0] || "", /auto-respawn failed: circuit_open/);
    ok(true, "a trial that only paints its terminal is verified but leaves the circuit open, and the watchdog stays refused");

    // 6c. A trial whose CLI starts the chat shim from its own --mcp-config and
    //     posts with the token minted for this spawn is the recovered
    //     generation acting; that clears the circuit, and the real watchdog is
    //     admitted again on the next exit.
    setDevCommand(SHIM_CLI);
    seedProgress();
    const acting = await runtime.restartAgentSession(`${PROJECT}/dev`, {
      reason: "manual", clearSelfHeal: true, lifecycleSource: "operator_restart", operatorAuthorized: true, explicitRole: true,
      expectedGeneration: generation5, lossCorrelation,
    });
    assert.equal(acting.ok, true);
    assert.equal(acting.lifecycle.circuit.open, true);
    const cleared = await until(async () => {
      const facts = await devFacts();
      return facts.generation_id === acting.lifecycle.generation_id && facts.circuit.open === false ? facts : null;
    }, "circuit cleared by the worker's authenticated post");
    // The stand-in exits right after posting, so the record is observed either
    // still verified or already exited; only the verified transition clears.
    assert.ok(["verified", "exited"].includes(cleared.state), `cleared while ${cleared.state}`);
    assert.equal(cleared.circuit.head_trial_operation_id, null);
    assert.equal(cleared.circuit.trial_operation_id, null);
    assert.equal(cleared.circuit.automatic_retries, 0);
    assert.equal(cleared.circuit.loss_correlation, null);
    assert.equal(typeof cleared.last_chat_at, "string");
    const posted = fileChat.readMessages(PROJECT, { limit: 50 }).filter((message) => message.sender === "dev");
    assert.equal(posted.length, 1, "exactly one authenticated dev post reached the chat");
    assert.match(posted[0].text, /recovered and reporting in/);
    const generation6 = await devExited(generation5, "acting trial exit");
    assert.equal(generation6, acting.lifecycle.generation_id);
    seedProgress();
    assert.deepEqual(await watchdogRespawnAttempt(), [], "the watchdog's automatic respawn is admitted once the circuit is cleared");
    const generation7 = await devExited(generation6, "watchdog respawn exit");
    assert.notEqual(generation7, generation6);
    assert.equal((await devFacts()).circuit.open, false);
    ok(true, "a trial that posts through its own shim token clears the circuit, and the real watchdog is admitted again");

    // 7. Every recovery left the dirty worktree byte-unchanged.
    assert.deepEqual(worktreeObservation(), INITIAL_WORKTREE);
    assert.equal(fs.readFileSync(path.join(WORKTREES.dev, "README.md"), "utf8"), "dirty uncommitted work\n");
    const audit = await shim.call("recent_head_control_audit", {});
    assert.deepEqual(audit.filter((record) => record.action === "recover_worker").map((record) => record.decision), ["accepted", "denied", "accepted", "denied"]);
    ok(true, "dirty WIP, the unpushed commit, and the branch survived four recoveries byte-unchanged, and every decision is audited");
  } finally {
    releaseContainment();
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
