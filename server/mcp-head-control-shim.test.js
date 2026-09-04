"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PROJECT = "quadwork";
const GENERATION = 7;
const TOKEN = "head-control-test-token-123456";
const SHIM = path.join(__dirname, "mcp-head-control-shim.js");
let server;
let port;
let calls = [];
let reply = null;

function resultFor(tool) {
  if (tool === "recent_head_control_audit") return [];
  return { version: 1, decision: { kind: "accepted", code: "head_control_ok" }, result: null, audit: null };
}

function startFixture() {
  return new Promise((resolve) => {
    server = http.createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        calls.push({ method: request.method, url: request.url, headers: request.headers, body });
        const planned = reply || { status: 200, json: { ok: true, result: resultFor(body?.request?.tool) } };
        reply = null;
        response.statusCode = planned.status;
        response.setHeader("Content-Type", "application/json");
        response.end(planned.raw === undefined ? JSON.stringify(planned.json) : planned.raw);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
}

function startShim() {
  const proc = spawn("node", [SHIM,
    "--project", PROJECT,
    "--agent", "head",
    "--generation", String(GENERATION),
    "--port", String(port),
    "--token", TOKEN,
  ], { stdio: ["pipe", "pipe", "pipe"] });
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
      if (waiter) waiter.resolve(message);
      else queue.push(message);
    }
  });
  function read() {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for shim response")), 5000);
      waiters.push({ resolve: (value) => { clearTimeout(timer); resolve(value); } });
    });
  }
  return {
    proc,
    async send(message) {
      proc.stdin.write(JSON.stringify(message) + "\n");
      return read();
    },
  };
}

async function stopShim(shim) {
  shim.proc.stdin.end();
  await new Promise((resolve) => shim.proc.once("close", resolve));
}

function call(id, name, argumentsValue) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: argumentsValue } };
}

async function run() {
  let passed = 0;
  function ok(value, message) {
    assert.ok(value, message);
    passed += 1;
    console.log(`  PASS: ${message}`);
  }

  const invalid = spawnSync("node", [SHIM, "--project", PROJECT, "--agent", "dev", "--generation", "7", "--port", "1", "--token", TOKEN]);
  const invalidOutput = invalid.stdout.toString() + invalid.stderr.toString();
  ok(invalid.status === 1 && !invalidOutput.includes(TOKEN), "launch identity requires the fixed Head role without printing its token");

  await startFixture();
  const shim = startShim();
  try {
    console.log("\n--- Head-control MCP shim tests ---\n");
    // A real MCP client always sends protocolVersion/capabilities/clientInfo
    // on initialize, a params-less notifications/initialized, and may page
    // tools/list with a cursor.  None of these may be rejected.
    const initialized = await shim.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: "claude-code", version: "1.0.0" },
    } });
    ok(initialized.result?.protocolVersion === "2024-11-05" && initialized.result?.serverInfo?.name === "quadwork-head-control",
      "a spec-conforming initialize handshake returns the Head-control MCP identity");
    shim.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const listed = await shim.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "page-one" } });
    const tools = listed.result?.tools;
    assert.equal(listed.error, undefined);
    const listedAgain = await shim.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(listedAgain.result?.tools?.map((tool) => tool.name), tools.map((tool) => tool.name));
    assert.deepEqual(tools.map((tool) => tool.name), [
      "get_pipeline_status", "put_batch_manifest", "freeze_batch_manifest", "cut_batch",
      "retire_batch", "abandon_batch_manifest", "queue_local_correction", "read_propagation_stop",
      "get_project_status", "review_handoff", "project_monitor", "recover_worker", "recent_head_control_audit",
    ]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      const fields = Object.keys(tool.inputSchema.properties || {});
      assert(!fields.includes("project") && !fields.includes("project_id") && !fields.includes("actor") &&
        !fields.includes("generation") && !fields.includes("action"));
    }
    ok(true, "tools/list has exactly the thirteen static Head-control operations and no caller binding or action selector");

    const statusArgs = { idempotency_key: "idem_status_001", correlation_id: "corr_status_001" };
    const status = await shim.send(call(3, "get_pipeline_status", statusArgs));
    assert.equal(status.result?.content?.[0]?.type, "text");
    assert.deepEqual(JSON.parse(status.result.content[0].text), resultFor("get_pipeline_status"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "/api/head-control");
    assert.equal(calls[0].headers["x-head-control-token"], TOKEN);
    assert.deepEqual(calls[0].body, {
      version: 1,
      binding: { project_id: PROJECT, actor: "head", generation: GENERATION },
      request: { tool: "get_pipeline_status", arguments: statusArgs },
    });
    ok(true, "a static tool sends token authentication and the fixed Head binding envelope on the one endpoint");

    for (const [label, argumentsValue] of [
      ["project", { ...statusArgs, project: "other" }],
      ["actor", { ...statusArgs, actor: "dev" }],
      ["generation", { ...statusArgs, generation: 0 }],
      ["action", { ...statusArgs, action: "cut_batch" }],
    ]) {
      const rejected = await shim.send(call(10, "get_pipeline_status", argumentsValue));
      assert.equal(rejected.error?.code, -32602);
      assert.equal(calls.length, 1);
      ok(true, `forged ${label} selector is rejected before the HTTP boundary`);
    }
    const hidden = await shim.send(call(20, "publish_batch", {}));
    assert.equal(hidden.error?.code, -32601);
    assert.equal(calls.length, 1);
    const malformedParams = await shim.send({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "get_pipeline_status", arguments: statusArgs, extra: true } });
    assert.equal(malformedParams.error?.code, -32602);
    assert.equal(calls.length, 1);
    ok(true, "tools/call still rejects unknown params fields after the handshake was loosened");
    const unknownMethod = await shim.send({ jsonrpc: "2.0", id: 22, method: "control/anything", params: {} });
    assert.equal(unknownMethod.error?.code, -32601);
    const nestedUnknown = await shim.send(call(23, "cut_batch", {
      expected_revision: 2,
      idempotency_key: "idem_nested_unknown",
      correlation_id: "corr_nested_unknown",
      cut: { tasks: [{ exact_task: "task-one" }], action: "put_batch_manifest" },
    }));
    assert.equal(nestedUnknown.error?.code, -32602);
    assert.equal(calls.length, 1);
    ok(true, "unknown tools and fields cannot become arbitrary operations");

    const putArgs = {
      expected_revision: 0,
      idempotency_key: "idem_put_001",
      correlation_id: "corr_put_001",
      manifest: { version: 1, tasks: [] },
    };
    const put = await shim.send(call(24, "put_batch_manifest", putArgs));
    assert.equal(put.error, undefined);
    const freeze = await shim.send(call(25, "freeze_batch_manifest", {
      expected_revision: 1, idempotency_key: "idem_freeze_001", correlation_id: "corr_freeze_001",
    }));
    assert.equal(freeze.error, undefined);
    const cut = await shim.send(call(26, "cut_batch", {
      expected_revision: 2,
      idempotency_key: "idem_cut_001",
      correlation_id: "corr_cut_001",
      cut: { tasks: [{ exact_task: "task-one" }] },
    }));
    assert.equal(cut.error, undefined);
    const taskRef = { task_key: "task-one" };
    const stop = await shim.send(call(40, "read_propagation_stop", {
      idempotency_key: "idem_stop_001", correlation_id: "corr_stop_001", work_task_ref: taskRef,
    }));
    assert.equal(stop.error, undefined);
    const correction = await shim.send(call(41, "queue_local_correction", {
      expected_revision: 3, idempotency_key: "idem_corr_001", correlation_id: "corr_corr_001",
      correction: { work_task_ref: taskRef, review_round_ref: { round: 1 }, candidate_digest: "e".repeat(64) },
    }));
    assert.equal(correction.error, undefined);
    const retire = await shim.send(call(42, "retire_batch", {
      expected_revision: 4, idempotency_key: "idem_retire_001", correlation_id: "corr_retire_001",
    }));
    assert.equal(retire.error, undefined);
    const abandon = await shim.send(call(44, "abandon_batch_manifest", {
      expected_revision: 5, idempotency_key: "idem_abandon_001", correlation_id: "corr_abandon_001",
    }));
    assert.equal(abandon.error, undefined);
    const audit = await shim.send(call(27, "recent_head_control_audit", {}));
    assert.deepEqual(JSON.parse(audit.result.content[0].text), []);
    assert.deepEqual(calls.slice(1).map((entry) => entry.body.request.tool), [
      "put_batch_manifest", "freeze_batch_manifest", "cut_batch", "read_propagation_stop", "queue_local_correction", "retire_batch", "abandon_batch_manifest", "recent_head_control_audit",
    ]);
    assert.deepEqual(calls[4].body.request.arguments, { idempotency_key: "idem_stop_001", correlation_id: "corr_stop_001", work_task_ref: taskRef });
    assert.deepEqual(calls[5].body.request.arguments.correction, { work_task_ref: taskRef, review_round_ref: { round: 1 }, candidate_digest: "e".repeat(64) });
    assert.deepEqual(calls[6].body.request.arguments, { expected_revision: 4, idempotency_key: "idem_retire_001", correlation_id: "corr_retire_001" });
    assert.deepEqual(calls[7].body.request.arguments, { expected_revision: 5, idempotency_key: "idem_abandon_001", correlation_id: "corr_abandon_001" });
    assert.ok(calls.slice(4, 8).every((entry) => JSON.stringify(entry.body.binding) === JSON.stringify({ project_id: PROJECT, actor: "head", generation: GENERATION })));
    for (const [label, name, argumentsValue] of [
      ["retire with a payload", "retire_batch", { expected_revision: 4, idempotency_key: "idem_retire_bad", correlation_id: "corr_retire_bad", manifest: {} }],
      ["abandon with a caller digest", "abandon_batch_manifest", { expected_revision: 5, idempotency_key: "idem_abandon_bad", correlation_id: "corr_abandon_bad", manifest_digest: "e".repeat(64) }],
      ["stop read pinning a revision", "read_propagation_stop", { expected_revision: 4, idempotency_key: "idem_stop_bad", correlation_id: "corr_stop_bad", work_task_ref: taskRef }],
      ["correction with a nested selector", "queue_local_correction", { expected_revision: 4, idempotency_key: "idem_corr_bad", correlation_id: "corr_corr_bad", correction: { work_task_ref: taskRef, review_round_ref: {}, candidate_digest: "e".repeat(64), actor: "head" } }],
    ]) {
      const rejected = await shim.send(call(43, name, argumentsValue));
      assert.equal(rejected.error?.code, -32602, label);
    }
    assert.equal(calls.length, 9);
    ok(true, "each listed operation maps to its static endpoint command without a generic action field");

    reply = { status: 200, raw: "not-json" };
    const malformed = await shim.send(call(30, "get_pipeline_status", {
      idempotency_key: "idem_bad_json", correlation_id: "corr_bad_json",
    }));
    assert.equal(malformed.error?.code, -32000);
    assert(!JSON.stringify(malformed).includes(TOKEN));
    reply = { status: 503, json: { ok: false, diagnostic: TOKEN } };
    const non2xx = await shim.send(call(31, "get_pipeline_status", {
      idempotency_key: "idem_non_2xx", correlation_id: "corr_non_2xx",
    }));
    assert.equal(non2xx.error?.code, -32000);
    assert(!JSON.stringify(non2xx).includes(TOKEN));
    reply = { status: 200, json: { ok: true, result: { echoed: TOKEN } } };
    const echoed = await shim.send(call(32, "get_pipeline_status", {
      idempotency_key: "idem_echoed", correlation_id: "corr_echoed",
    }));
    assert.equal(echoed.error?.code, -32000);
    assert(!JSON.stringify(echoed).includes(TOKEN));
    ok(true, "malformed, non-success, and secret-bearing responses fail closed without exposing the launch token");

    const source = fs.readFileSync(SHIM, "utf8");
    assert.match(source, /require\("node:http"\)/);
    assert.match(source, /require\("node:readline"\)/);
    assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process|https|net|tls|dgram|worker_threads)["']\s*\)/);
    // The recover_worker tool's `recovery` field and description necessarily
    // spell the word; strip that identifier so the guard still catches a real
    // module import or process capability.
    assert.doesNotMatch(source.replace(/\b(?:recovery|RECOVERY_REASONS)\b/g, ""), /mcp-chat-shim|mcp-operator|file-chat|project-monitor|recovery|github|child_process|exec\s*\(|spawn\s*\(|shell|routes\.js|index\.js/i);
    ok(true, "the shim imports only stdio and its fixed loopback transport, with no broader capability surface");
  } finally {
    await stopShim(shim);
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${passed} passed`);
}

run().catch(async (error) => {
  console.error(error);
  if (server) await new Promise((resolve) => server.close(resolve));
  process.exit(1);
});
