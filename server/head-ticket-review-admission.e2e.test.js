"use strict";

// #1161: this is deliberately a product-runtime regression, not a unit test
// of the admission helper. A spawned Head MCP client starts the review through
// index.js's real control route. A separate spawned reviewer MCP client then
// reaches the real issue-contract route, whose resolver proves the durable
// server record, the live queue and the registered repository all agree.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-ticket-review-e2e-"));
const originalHome = os.homedir;
const originalPath = process.env.PATH;
os.homedir = () => TMP;
process.env.HOME = TMP;
process.env.QUADWORK_SKIP_LISTEN = "1";
// Keep the test directly runnable, including by an independent reviewer. The
// test runtime facade is an in-memory test-only capability; production code
// receives neither this environment value nor its exported session map.
process.env.QUADWORK_TEST_RUNTIME = "1";

// A fresh npm package excludes test files, so this source test also serves as
// its external product harness when QUADWORK_PRODUCT_ROOT names that package.
// Defaulting to the repository root keeps the normal source-tree regression
// unchanged.
const PRODUCT_ROOT = process.env.QUADWORK_PRODUCT_ROOT || path.resolve(__dirname, "..");

const CONFIG_DIR = path.join(TMP, ".quadwork");
const PROJECT = "alpha";
const INSTALLATION = "installation_alpha_00001";
const HEAD_TOKEN = "head-ticket-review-e2e-token-0001";
const REVIEWER_TOKEN = "reviewer-ticket-review-e2e-token-0001";
const REPO_DIR = path.join(TMP, "repo");
const HEAD_DIR = path.join(TMP, "head");
const BIN_DIR = path.join(TMP, "bin");
const HEAD_SHIM = path.join(PRODUCT_ROOT, "server", "mcp-head-control-shim.js");
const CHAT_SHIM = path.join(PRODUCT_ROOT, "server", "mcp-chat-shim.js");

for (const directory of [path.join(CONFIG_DIR, PROJECT), REPO_DIR, HEAD_DIR, BIN_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.chmodSync(CONFIG_DIR, 0o700);
fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({
  installation_id: INSTALLATION,
  port: 8400,
  projects: [{
    id: PROJECT,
    name: "Alpha",
    archived: false,
    chat_mode: "file",
    repositories: [{ key: "primary", repo: "Acme/Alpha", working_dir: REPO_DIR, primary: true, ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["operator"] } }],
    agents: { head: { cwd: HEAD_DIR, command: process.execPath } },
  }],
}));
fs.writeFileSync(path.join(CONFIG_DIR, PROJECT, "OVERNIGHT-QUEUE.md"), [
  "# Alpha — Overnight Queue",
  "",
  "## Active Batch",
  "",
  "(no active batch yet — operator will assign one via chat. Head will use batch number 1 for the first batch.)",
  "",
  "## Backlog",
  "",
  "(none)",
  "",
  "## Rules",
  "",
  "**Batch:** 1",
].join("\n"));

// The real handler calls the configured authenticated GitHub CLI. This local
// executable is its only external boundary replacement: it returns the exact
// issue identity the route asked for, so the runtime's source validation still
// runs unchanged and no network credential is needed in the test.
const ghPath = path.join(BIN_DIR, "gh");
fs.writeFileSync(ghPath, [
  "#!/bin/sh",
  "case \"$*\" in",
  "  *'/repos/acme/alpha/issues/42'*) printf '%s\\n' '{\"number\":42,\"repository_url\":\"https://api.github.com/repos/acme/alpha\",\"body\":\"Alpha ticket contract\\n\"}' ;;",
  "  *) exit 1 ;;",
  "esac",
].join("\n"));
fs.chmodSync(ghPath, 0o755);
process.env.PATH = `${BIN_DIR}${path.delimiter}${originalPath || ""}`;

const routes = require(path.join(PRODUCT_ROOT, "server", "routes"));
const fileChat = require(path.join(PRODUCT_ROOT, "server", "file-chat"));
const { captureProjectAdmission } = require(path.join(PRODUCT_ROOT, "server", "project-lifecycle"));
const runtime = require(path.join(PRODUCT_ROOT, "server", "index"));

function startJsonRpcShim(script, args) {
  const proc = spawn("node", [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
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
      const timer = setTimeout(() => reject(new Error("timed out waiting for MCP response")), 15000);
      waiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }
  let nextId = 1;
  return {
    proc,
    async call(name, argumentsValue) {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: argumentsValue } })}\n`);
      const response = await read();
      if (response.error) return { error: response.error };
      return JSON.parse(response.result.content[0].text);
    },
    async initialize() {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "alpha-e2e", version: "1" } } })}\n`);
      const response = await read();
      assert.ok(response.result?.serverInfo?.name, "MCP shim initializes");
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async stop() {
      proc.stdin.end();
      await new Promise((resolve) => proc.once("close", resolve));
    },
  };
}

let server = null;
let headShim = null;
let reviewerShim = null;
function cleanup() {
  try { headShim?.proc.kill(); } catch {}
  try { reviewerShim?.proc.kill(); } catch {}
  try { server?.close(); } catch {}
  try { fileChat.shutdownProject(PROJECT); } catch {}
  os.homedir = originalHome;
  process.env.PATH = originalPath;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

(async () => {
  let passed = 0;
  const ok = (value, message) => { assert.ok(value, message); passed += 1; console.log(`  PASS: ${message}`); };
  console.log("\n--- Alpha ticket-review admission product E2E ---\n");

  fileChat.initProject(PROJECT);
  const admission = captureProjectAdmission(PROJECT);
  runtime.agentSessions.set(`${PROJECT}/head`, {
    projectId: PROJECT, agentId: "head", state: "running", lifecycleState: "verified", generationId: "alpha-head-1",
    operationId: "alpha-operation-1", backend: "claude", lastOutputAt: Date.now(), startedAt: new Date().toISOString(),
    viewers: new Set(), viewerDims: new Map(), scrollback: Buffer.alloc(0),
    term: { pid: process.pid, write() {}, kill() {}, onData() { return { dispose() {} }; } },
  });
  fileChat.registerShimToken(PROJECT, "head", HEAD_TOKEN);
  fileChat.registerShimToken(PROJECT, "re1", REVIEWER_TOKEN);
  runtime.headControlRuntime.registerHeadToken({ project_id: PROJECT, generation: admission.generation, token: HEAD_TOKEN });
  server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  headShim = startJsonRpcShim(HEAD_SHIM, ["--project", PROJECT, "--agent", "head", "--generation", String(admission.generation), "--port", String(port), "--token", HEAD_TOKEN]);
  reviewerShim = startJsonRpcShim(CHAT_SHIM, ["--project", PROJECT, "--agent", "re1", "--port", String(port), "--token", REVIEWER_TOKEN]);

  try {
    await headShim.initialize();
    await reviewerShim.initialize();
    const started = await headShim.call("begin_ticket_review", {
      idempotency_key: "alpha_ticket_review_start",
      correlation_id: "alpha_ticket_review_corr",
      ticket_review: { repository_key: "primary", issue: 42 },
    });
    assert.equal(started.decision?.code, "head_control_applied");
    assert.equal(started.detail?.code, "ticket_review_started");
    assert.equal(started.detail?.repository_key, "primary");
    assert.equal(started.detail?.issue, 42);
    const context = routes.readLiveBatchContext(PROJECT);
    assert.equal(context.batchType, "ticket-review");
    assert.equal(context.parsed.workItems.length, 1);
    assert.equal(context.parsed.workItems[0].ref.number, 42);
    ok(true, "authenticated Head MCP establishes exactly one real Alpha ticket-review assignment through index.js");

    const revision = await reviewerShim.call("issue_contract_revision", { repo_key: "primary", issue: 42 });
    assert.equal(revision.ok, true);
    assert.equal(revision.repo, "acme/alpha");
    assert.equal(revision.issue, 42);
    assert.match(revision.contract_revision, /^[a-f0-9]{64}$/);
    ok(true, "the real issue_contract_revision route accepts only the server-admitted Alpha ticket target");

    const crossRepository = await reviewerShim.call("issue_contract_revision", { repo_key: "other", issue: 42 });
    assert.equal(crossRepository.error?.code, -32000);
    assert.match(crossRepository.error?.message || "", /API error 403/);
    ok(true, "the real resolver refuses a cross-repository ticket contract read");

    fs.unlinkSync(path.join(CONFIG_DIR, PROJECT, "ticket-review-admission.json"));
    const forgedQueue = await reviewerShim.call("issue_contract_revision", { repo_key: "primary", issue: 42 });
    assert.equal(forgedQueue.error?.code, -32000);
    assert.match(forgedQueue.error?.message || "", /API error 403/);
    ok(true, "an owned-looking queue without the durable server admission record remains forbidden");
  } finally {
    await headShim.stop();
    headShim = null;
    await reviewerShim.stop();
    reviewerShim = null;
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
