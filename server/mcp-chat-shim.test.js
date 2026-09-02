"use strict";

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { ensureSecureDir } = require("./config");
const fileChat = require("./file-chat");
const {
  createIssueContractRevisionHandler,
  issueContractRevision,
} = require("./issue-contract-revision");

const crypto = require("crypto");

const PROJECT = "__mcp_shim_test__";
const OTHER_PROJECT = "__mcp_shim_other__";
const AGENT = "dev";
const TEST_TOKEN = crypto.randomBytes(16).toString("hex");
const HEAD_RESUME_TOKEN = crypto.randomBytes(16).toString("hex");
const SHIM = path.join(__dirname, "mcp-chat-shim.js");
const ROLES = ["head", "dev", "re1", "re2"];

let server;
let serverPort;
const issueFetches = [];
const chatResumeRequests = [];
const workTaskReviewRequests = [];
const workTaskBuildRequests = [];
const deliveryCandidateRequests = [];
let chatResumeFailure = false;
let admissionGeneration = 7;
let registeredFingerprint = "queue-observation-a";

function sendJsonRpc(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function readResponse(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for response")), 5000);
    const handler = (data) => {
      clearTimeout(timeout);
      proc.stdout.removeListener("data", handler);
      try {
        resolve(JSON.parse(data.toString().trim().split("\n").pop()));
      } catch (e) {
        reject(e);
      }
    };
    proc.stdout.on("data", handler);
  });
}

function spawnShim(project, agent, token) {
  return spawn("node", [SHIM, "--project", project, "--agent", agent, "--port", String(serverPort), "--token", token], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function stopShim(proc) {
  proc.stdin.end();
  await new Promise((resolve) => proc.on("close", resolve));
}

function startTestServer() {
  return new Promise((resolve) => {
    const express = require("express");
    const app = express();
    app.use(express.json());

    app.post("/api/issue-contract-revision", createIssueContractRevisionHandler({
      resolveShimPrincipal: fileChat.resolveShimPrincipal,
      captureProjectAdmission: (projectId) => ({ project_id: projectId, generation: admissionGeneration }),
      isAdmissionCurrent: (token) => token?.generation === admissionGeneration,
      resolveRegisteredIssue: (projectId, repoKey, issue) => {
        if (projectId === PROJECT && repoKey === "web" && issue === 42) {
          return { repo: "Acme/Web", issue, fingerprint: registeredFingerprint };
        }
        if (projectId === OTHER_PROJECT && repoKey === "api" && issue === 42) {
          return { repo: "Other/API", issue, fingerprint: registeredFingerprint };
        }
        return null;
      },
      fetchRevision: async ({ repo, issue }) => {
        issueFetches.push({ repo, issue });
        return {
          repo: repo.toLowerCase(),
          issue,
          contract_revision: issueContractRevision("Live contract\r\n\r\n"),
          observed_at: "2026-08-29T12:34:56.000Z",
          source: "github_authenticated_rest",
          source_status: "ok",
        };
      },
    }));

    // CI-less handler authorization/persistence is exercised directly in
    // ci-less-evidence.test.js.  This shim fixture verifies the role-specific
    // tool list and that a forged hidden tools/call still reaches a server
    // boundary which rejects it.
    app.post("/api/ci-evidence", (req, res) => res.status(403).json({ ok: false, code: "ci_evidence_forbidden" }));
    app.post("/api/ci-evidence/read", (req, res) => res.status(404).json({ ok: false, code: "ci_evidence_record_not_found" }));

    app.post("/api/chat-resume", (req, res) => {
      const token = req.headers["x-chat-token"];
      const principal = fileChat.resolveShimPrincipal(token);
      if (!principal || principal.projectId !== PROJECT || principal.agentId !== "head") {
        return res.status(403).json({ error: `bad token=${token}`, path: "/private/chat-resume" });
      }
      if (chatResumeFailure) {
        return res.status(503).json({ error: `source secret=${token}`, path: "/private/chat-resume" });
      }
      chatResumeRequests.push({
        body: req.body,
        headers: {
          token,
          sender: req.headers["x-chat-sender"],
        },
      });
      res.json({ ok: true, records: [], next_cursor: null });
    });

    app.post("/api/work-task-review/open", (req, res) => {
      const principal = fileChat.resolveShimPrincipal(req.headers["x-chat-token"]);
      if (!principal || principal.projectId !== PROJECT || principal.agentId !== "head") return res.status(403).json({ ok: false });
      workTaskReviewRequests.push({ kind: "open", token: req.headers["x-chat-token"], body: req.body });
      res.json({ ok: true, outcome: "opened" });
    });
    app.post("/api/work-task-build", (req, res) => {
      const principal = fileChat.resolveShimPrincipal(req.headers["x-chat-token"]);
      if (!principal || principal.projectId !== PROJECT || principal.agentId !== "head") return res.status(403).json({ ok: false });
      workTaskBuildRequests.push({ token: req.headers["x-chat-token"], body: req.body });
      res.json({ ok: true, outcome: "assigned" });
    });
    app.post("/api/work-task-review/receipt", (req, res) => {
      const principal = fileChat.resolveShimPrincipal(req.headers["x-chat-token"]);
      if (!principal || principal.projectId !== PROJECT || !["re1", "re2"].includes(principal.agentId)) return res.status(403).json({ ok: false });
      workTaskReviewRequests.push({ kind: "receipt", role: principal.agentId, token: req.headers["x-chat-token"], body: req.body });
      res.json({ ok: true, outcome: "sealed", view: { status: "sealed" } });
    });
    app.post("/api/work-task-review/reconcile", (req, res) => {
      const principal = fileChat.resolveShimPrincipal(req.headers["x-chat-token"]);
      if (!principal || principal.projectId !== PROJECT || principal.agentId !== "head") return res.status(403).json({ ok: false });
      workTaskReviewRequests.push({ kind: "reconcile", token: req.headers["x-chat-token"], body: req.body });
      res.json({ ok: true, outcome: "reconciled", resolution: "accepted" });
    });
    app.post("/api/delivery-candidate/prepare", (req, res) => {
      const principal = fileChat.resolveShimPrincipal(req.headers["x-chat-token"]);
      if (!principal || principal.projectId !== PROJECT || principal.agentId !== "head") return res.status(403).json({ ok: false });
      deliveryCandidateRequests.push({ kind: "prepare", token: req.headers["x-chat-token"], body: req.body });
      res.json({ ok: true, outcome: "prepared" });
    });
    app.post("/api/delivery-candidate/compose", (req, res) => {
      const principal = fileChat.resolveShimPrincipal(req.headers["x-chat-token"]);
      if (!principal || principal.projectId !== PROJECT || principal.agentId !== "head") return res.status(403).json({ ok: false });
      deliveryCandidateRequests.push({ kind: "compose", token: req.headers["x-chat-token"], body: req.body });
      res.json({ ok: true, outcome: "composed" });
    });

    app.get("/api/chat", (req, res) => {
      const msgs = fileChat.readMessages(PROJECT, {
        since_id: Number(req.query.since_id) || 0,
        limit: Number(req.query.limit) || 50,
      });
      res.json(msgs);
    });

    app.post("/api/chat", (req, res) => {
      const shimSender = req.headers["x-chat-sender"];
      const shimToken = req.headers["x-chat-token"];
      let sender = "user";
      if (shimSender && shimToken) {
        if (!fileChat.validateShimToken(PROJECT, shimSender, shimToken)) {
          return res.status(403).json({ error: "Invalid shim token" });
        }
        sender = shimSender;
      }
      const msg = fileChat.appendMessage(PROJECT, {
        sender,
        text: req.body.text || "",
        channel: req.body.channel || "general",
        type: "message",
      });
      res.json({ ok: true, message: msg });
    });

    server = app.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      passed++;
      console.log(`  PASS: ${msg}`);
    } else {
      failed++;
      console.error(`  FAIL: ${msg}`);
    }
  }

  // Setup
  fileChat.initProject(PROJECT);
  fileChat.registerShimToken(PROJECT, AGENT, TEST_TOKEN);
  await startTestServer();

  const shim = spawnShim(PROJECT, AGENT, TEST_TOKEN);

  shim.stderr.on("data", (d) => process.stderr.write(`[shim stderr] ${d}`));

  // Test 1: initialize
  console.log("\n--- MCP Shim Conformance Tests ---\n");
  sendJsonRpc(shim, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const initResp = await readResponse(shim);
  assert(initResp.result?.protocolVersion === "2024-11-05", "initialize returns protocol version");
  assert(initResp.result?.capabilities?.tools != null, "initialize returns tools capability");

  // Send initialized notification
  sendJsonRpc(shim, { jsonrpc: "2.0", method: "initialized" });
  await new Promise((r) => setTimeout(r, 100));

  // Test 2: tools/list
  sendJsonRpc(shim, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listResp = await readResponse(shim);
  const toolNames = (listResp.result?.tools || []).map((t) => t.name);
  assert(toolNames.includes("chat_send"), "tools/list includes chat_send");
  assert(toolNames.includes("chat_read"), "tools/list includes chat_read");
  assert(toolNames.includes("issue_contract_revision"), "tools/list exposes issue_contract_revision to dev");
  assert(toolNames.includes("submit_ci_evidence"), "tools/list exposes submit_ci_evidence only to dev");
  assert(toolNames.includes("submit_work_task_candidate"), "tools/list exposes the local-only WorkTask candidate receipt only to dev");
  assert(toolNames.includes("read_ci_evidence"), "tools/list exposes redacted CI evidence reads to dev");
  assert(!toolNames.includes("chat_resume"), "tools/list hides Head-only chat_resume from dev");
  assert(!toolNames.includes("assign_work_task_build"), "tools/list hides Head-only WorkTask build assignment from dev");
  assert(!toolNames.includes("open_work_task_independent_review"), "tools/list hides Head-only WorkTask review opening from dev");
  assert(!toolNames.includes("reconcile_work_task_review"), "tools/list hides Head-only WorkTask review reconciliation from dev");
  assert(!toolNames.includes("prepare_delivery_candidate") && !toolNames.includes("compose_delivery_candidate"),
    "tools/list hides Head-only Delivery Candidate tools from dev");
  assert(!toolNames.includes("issue_review_cycle_nonce") && !toolNames.includes("submit_review_cycle_receipt"),
    "tools/list hides reviewer-only review-cycle receipt tools from dev");
  assert(!toolNames.includes("submit_work_task_review_receipt"), "tools/list hides independent WorkTask review receipts from dev");

  for (const role of ROLES.filter((role) => role !== AGENT)) {
    const token = crypto.randomBytes(16).toString("hex");
    fileChat.registerShimToken(PROJECT, role, token);
    const roleShim = spawnShim(PROJECT, role, token);
    sendJsonRpc(roleShim, { jsonrpc: "2.0", id: 20, method: "tools/list", params: {} });
    const roleList = await readResponse(roleShim);
    assert((roleList.result?.tools || []).some((tool) => tool.name === "issue_contract_revision"),
      `tools/list exposes issue_contract_revision to ${role}`);
    assert((roleList.result?.tools || []).some((tool) => tool.name === "read_ci_evidence"),
      `tools/list exposes read_ci_evidence to ${role}`);
    assert(!(roleList.result?.tools || []).some((tool) => tool.name === "submit_ci_evidence"),
      `tools/list hides submit_ci_evidence from ${role}`);
    assert(!(roleList.result?.tools || []).some((tool) => tool.name === "submit_work_task_candidate"),
      `tools/list hides WorkTask candidate receipt from ${role}`);
    const roleToolNames = (roleList.result?.tools || []).map((tool) => tool.name);
    const reviewerRole = role === "re1" || role === "re2";
    assert(roleToolNames.includes("chat_resume") === (role === "head"),
      `tools/list exposes chat_resume only to authenticated Head role ${role}`);
    assert(roleToolNames.includes("assign_work_task_build") === (role === "head"),
      `tools/list exposes WorkTask build assignment only to authenticated Head role ${role}`);
    assert(roleToolNames.includes("open_work_task_independent_review") === (role === "head"),
      `tools/list exposes WorkTask review opening only to authenticated Head role ${role}`);
    assert(roleToolNames.includes("reconcile_work_task_review") === (role === "head"),
      `tools/list exposes WorkTask review reconciliation only to authenticated Head role ${role}`);
    assert(roleToolNames.includes("prepare_delivery_candidate") === (role === "head") &&
      roleToolNames.includes("compose_delivery_candidate") === (role === "head"),
    `tools/list exposes Delivery Candidate preparation/composition only to authenticated Head role ${role}`);
    assert(roleToolNames.includes("issue_review_cycle_nonce") === reviewerRole,
      `tools/list exposes review-cycle nonce issuance only to reviewer role ${role}`);
    assert(roleToolNames.includes("submit_review_cycle_receipt") === reviewerRole,
      `tools/list exposes review-cycle receipt submission only to reviewer role ${role}`);
    assert(roleToolNames.includes("submit_work_task_review_receipt") === reviewerRole,
      `tools/list exposes independent WorkTask receipt sealing only to reviewer role ${role}`);
    await stopShim(roleShim);
  }

  // The Head-only call forwards only the two page arguments and the existing
  // shim token.  It must not grow a caller-selected identity/endpoint surface.
  fileChat.registerShimToken(PROJECT, "head", HEAD_RESUME_TOKEN);
  const headShim = spawnShim(PROJECT, "head", HEAD_RESUME_TOKEN);
  sendJsonRpc(headShim, { jsonrpc: "2.0", id: 21, method: "tools/call", params: {
    name: "chat_resume", arguments: { cursor: null, limit: 2 },
  } });
  const resumeResp = await readResponse(headShim);
  assert(resumeResp.result?.content?.[0]?.type === "text", "authenticated Head can call chat_resume");
  assert(JSON.parse(resumeResp.result.content[0].text).ok === true, "chat_resume returns the fixed endpoint response");
  assert(chatResumeRequests.length === 1 && JSON.stringify(chatResumeRequests[0].body) === JSON.stringify({ cursor: null, limit: 2 }),
    "chat_resume forwards only the exact cursor and bounded limit arguments");
  assert(chatResumeRequests[0].headers.token === HEAD_RESUME_TOKEN && chatResumeRequests[0].headers.sender === undefined,
    "chat_resume authenticates with the existing shim token only");

  const buildArguments = { event_id: "assign_build_001", work_task_ref: { task_key: "build" } };
  sendJsonRpc(headShim, { jsonrpc: "2.0", id: 210, method: "tools/call", params: {
    name: "assign_work_task_build", arguments: buildArguments,
  } });
  const buildResp = await readResponse(headShim);
  assert(JSON.parse(buildResp.result?.content?.[0]?.text || "{}").outcome === "assigned",
    "authenticated Head can call the fixed WorkTask build assignment endpoint");
  assert(workTaskBuildRequests.length === 1 && workTaskBuildRequests[0].token === HEAD_RESUME_TOKEN &&
    JSON.stringify(workTaskBuildRequests[0].body) === JSON.stringify(buildArguments),
  "Head build assignment forwards only its typed arguments and existing shim token");

  const openArguments = { event_id: "open_review_001", work_task_ref: { task_key: "review" }, attempt: "attempt_001", round: 1 };
  sendJsonRpc(headShim, { jsonrpc: "2.0", id: 211, method: "tools/call", params: {
    name: "open_work_task_independent_review", arguments: openArguments,
  } });
  const openReviewResp = await readResponse(headShim);
  assert(JSON.parse(openReviewResp.result?.content?.[0]?.text || "{}").outcome === "opened",
    "authenticated Head can open the fixed WorkTask review endpoint");
  assert(workTaskReviewRequests.length === 1 && workTaskReviewRequests[0].kind === "open" &&
    workTaskReviewRequests[0].token === HEAD_RESUME_TOKEN && JSON.stringify(workTaskReviewRequests[0].body) === JSON.stringify(openArguments),
  "Head review opening forwards only its typed arguments and existing shim token");

  const reconcileArguments = { work_task_ref: { task_key: "review" }, review_round_ref: { attempt: "attempt_001" }, candidate_digest: "e".repeat(64) };
  sendJsonRpc(headShim, { jsonrpc: "2.0", id: 212, method: "tools/call", params: {
    name: "reconcile_work_task_review", arguments: reconcileArguments,
  } });
  const reconcileReviewResp = await readResponse(headShim);
  assert(JSON.parse(reconcileReviewResp.result?.content?.[0]?.text || "{}").outcome === "reconciled",
    "authenticated Head can call the fixed WorkTask review reconciliation endpoint");
  assert(workTaskReviewRequests.length === 2 && workTaskReviewRequests[1].kind === "reconcile" &&
    workTaskReviewRequests[1].token === HEAD_RESUME_TOKEN && JSON.stringify(workTaskReviewRequests[1].body) === JSON.stringify(reconcileArguments),
  "Head review reconciliation forwards only its typed arguments and existing shim token");

  const prepareArguments = { repository_key: "web" };
  sendJsonRpc(headShim, { jsonrpc: "2.0", id: 213, method: "tools/call", params: {
    name: "prepare_delivery_candidate", arguments: prepareArguments,
  } });
  const preparedDelivery = await readResponse(headShim);
  assert(JSON.parse(preparedDelivery.result?.content?.[0]?.text || "{}").outcome === "prepared",
    "authenticated Head can prepare a Delivery Candidate through the fixed endpoint");
  assert(deliveryCandidateRequests.length === 1 && deliveryCandidateRequests[0].kind === "prepare" &&
    deliveryCandidateRequests[0].token === HEAD_RESUME_TOKEN && JSON.stringify(deliveryCandidateRequests[0].body) === JSON.stringify(prepareArguments),
  "Delivery Candidate preparation forwards only the typed repository key and existing Head token");

  const composeArguments = { delivery_candidate_ref: { version: 1 }, expected_revision: 0, correlation_id: "compose_001", idempotency_key: "compose_001" };
  sendJsonRpc(headShim, { jsonrpc: "2.0", id: 214, method: "tools/call", params: {
    name: "compose_delivery_candidate", arguments: composeArguments,
  } });
  const composedDelivery = await readResponse(headShim);
  assert(JSON.parse(composedDelivery.result?.content?.[0]?.text || "{}").outcome === "composed",
    "authenticated Head can compose a Delivery Candidate through the fixed endpoint");
  assert(deliveryCandidateRequests.length === 2 && deliveryCandidateRequests[1].kind === "compose" &&
    deliveryCandidateRequests[1].token === HEAD_RESUME_TOKEN && JSON.stringify(deliveryCandidateRequests[1].body) === JSON.stringify(composeArguments),
  "Delivery Candidate composition forwards only its typed candidate revision and existing Head token");

  for (const invalid of [
    {},
    { cursor: null, limit: 0 },
    { cursor: null, limit: 65 },
    { cursor: 7, limit: 1 },
    { cursor: null, limit: 1, project: OTHER_PROJECT },
  ]) {
    sendJsonRpc(headShim, { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "chat_resume", arguments: invalid } });
    const invalidResp = await readResponse(headShim);
    assert(invalidResp.error?.code === -32602 && invalidResp.error.message === "Invalid chat_resume arguments",
      "chat_resume rejects malformed or identity-injecting arguments before transport");
  }
  assert(chatResumeRequests.length === 1, "invalid chat_resume arguments never reach the fixed endpoint");

  sendJsonRpc(shim, { jsonrpc: "2.0", id: 23, method: "tools/call", params: {
    name: "chat_resume", arguments: { cursor: null, limit: 1 },
  } });
  const hiddenResume = await readResponse(shim);
  assert(hiddenResume.error?.code === -32601, "non-Head hidden chat_resume calls are denied locally");
  assert(chatResumeRequests.length === 1, "non-Head chat_resume calls never reach the fixed endpoint");

  sendJsonRpc(shim, { jsonrpc: "2.0", id: 230, method: "tools/call", params: {
    name: "assign_work_task_build", arguments: buildArguments,
  } });
  const hiddenBuild = await readResponse(shim);
  assert(hiddenBuild.error?.code === -32601, "non-Head hidden WorkTask build assignment calls are denied locally");
  assert(workTaskBuildRequests.length === 1, "non-Head build assignment calls never reach the fixed endpoint");

  sendJsonRpc(shim, { jsonrpc: "2.0", id: 231, method: "tools/call", params: {
    name: "open_work_task_independent_review", arguments: openArguments,
  } });
  const hiddenOpen = await readResponse(shim);
  assert(hiddenOpen.error?.code === -32601, "non-Head hidden WorkTask review opening calls are denied locally");
  assert(workTaskReviewRequests.length === 2, "non-Head review opening calls never reach the fixed endpoint");

  sendJsonRpc(shim, { jsonrpc: "2.0", id: 232, method: "tools/call", params: {
    name: "prepare_delivery_candidate", arguments: prepareArguments,
  } });
  const hiddenPrepare = await readResponse(shim);
  assert(hiddenPrepare.error?.code === -32601, "non-Head hidden Delivery Candidate preparation is denied locally");
  assert(deliveryCandidateRequests.length === 2, "non-Head Delivery Candidate preparation never reaches the fixed endpoint");

  chatResumeFailure = true;
  sendJsonRpc(headShim, { jsonrpc: "2.0", id: 24, method: "tools/call", params: {
    name: "chat_resume", arguments: { cursor: null, limit: 1 },
  } });
  const failedResume = await readResponse(headShim);
  assert(failedResume.error?.code === -32000 && failedResume.error.message === "chat_resume unavailable",
    "chat_resume redacts endpoint failures");
  assert(!JSON.stringify(failedResume).includes(HEAD_RESUME_TOKEN) && !JSON.stringify(failedResume).includes("/private/chat-resume"),
    "chat_resume never exposes token or endpoint diagnostics");
  await stopShim(headShim);

  const re1ReceiptToken = crypto.randomBytes(16).toString("hex");
  fileChat.registerShimToken(PROJECT, "re1", re1ReceiptToken);
  const re1Shim = spawnShim(PROJECT, "re1", re1ReceiptToken);
  const receiptArguments = { review_round_ref: { work_task_ref: { task_key: "review" } }, candidate_digest: "e".repeat(64), receipt: { receipt_id: "receipt_re1_01" } };
  sendJsonRpc(re1Shim, { jsonrpc: "2.0", id: 241, method: "tools/call", params: {
    name: "submit_work_task_review_receipt", arguments: receiptArguments,
  } });
  const receiptResp = await readResponse(re1Shim);
  assert(JSON.parse(receiptResp.result?.content?.[0]?.text || "{}").outcome === "sealed",
    "authenticated reviewer can seal through the fixed WorkTask receipt endpoint");
  assert(workTaskReviewRequests.length === 3 && workTaskReviewRequests[2].kind === "receipt" && workTaskReviewRequests[2].role === "re1" &&
    workTaskReviewRequests[2].token === re1ReceiptToken && JSON.stringify(workTaskReviewRequests[2].body) === JSON.stringify(receiptArguments),
  "review receipt forwards only its typed arguments and existing reviewer token");
  await stopShim(re1Shim);

  // Test 3: chat_send
  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "chat_send", arguments: { message: "hello from shim @user" } },
  });
  const sendResp = await readResponse(shim);
  assert(sendResp.result?.content?.[0]?.type === "text", "chat_send returns text content");
  const sendBody = JSON.parse(sendResp.result.content[0].text);
  assert(sendBody.ok === true, "chat_send returns ok: true");
  assert(sendBody.message?.sender === AGENT, "chat_send uses agent sender from X-Chat-Sender header");

  // Test 4: chat_read
  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "chat_read", arguments: {} },
  });
  const readResp = await readResponse(shim);
  assert(readResp.result?.content?.[0]?.type === "text", "chat_read returns text content");
  const readBody = JSON.parse(readResp.result.content[0].text);
  // #932: MCP structuredContent must be a record — chat_read's array of
  // messages is wrapped in an object so gemini's SDK doesn't reject it with
  // `invalid_type` (expected record, received array).
  assert(
    readBody && typeof readBody === "object" && !Array.isArray(readBody),
    "#932: chat_read returns an object (record), not a bare array",
  );
  const messages = readBody.messages;
  assert(Array.isArray(messages), "#932: chat_read wraps the message array under `messages`");
  assert(messages.length >= 1, "chat_read contains the sent message");
  assert(messages[messages.length - 1]?.text === "hello from shim @user", "chat_read message text matches");

  // Test 5: chat_read with since_id
  const lastId = messages[messages.length - 1].id;
  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "chat_send", arguments: { message: "second message" } },
  });
  await readResponse(shim);

  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "chat_read", arguments: { since_id: lastId } },
  });
  const sinceResp = await readResponse(shim);
  const sinceMessages = JSON.parse(sinceResp.result.content[0].text).messages;
  assert(sinceMessages.length === 1, "chat_read with since_id returns only new messages");
  assert(sinceMessages[0]?.text === "second message", "since_id filtered message matches");

  // The read-only contract tool sends only repo_key+issue. Project, actor, and
  // canonical repository are derived by the server from token + live config.
  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "issue_contract_revision", arguments: { repo_key: "web", issue: 42 } },
  });
  const revisionResp = await readResponse(shim);
  const revisionBody = JSON.parse(revisionResp.result.content[0].text);
  assert(revisionBody.ok === true, "issue_contract_revision succeeds for a registered project repository");
  assert(revisionBody.repo === "acme/web" && revisionBody.issue === 42,
    "issue revision returns canonical repository and issue as separate fields");
  assert(revisionBody.contract_revision === issueContractRevision("Live contract"),
    "issue revision returns the server-computed canonical digest");
  assert(revisionBody.observed_at === "2026-08-29T12:34:56.000Z" && revisionBody.source_status === "ok",
    "issue revision returns observation time and source status");
  assert(issueFetches.length === 1 && issueFetches[0].repo === "Acme/Web" && issueFetches[0].issue === 42,
    "server resolves the canonical target from the bound project's live repository registry");

  for (const [label, forged] of [
    ["caller project", { repo_key: "web", issue: 42, project: OTHER_PROJECT }],
    ["caller actor", { repo_key: "web", issue: 42, actor: "head" }],
    ["caller repository", { repo_key: "web", issue: 42, repo: "other/api" }],
    ["caller body", { repo_key: "web", issue: 42, body: "forged" }],
  ]) {
    sendJsonRpc(shim, {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "issue_contract_revision", arguments: forged },
    });
    const forgedResp = await readResponse(shim);
    assert(forgedResp.error?.code === -32000 && /API error 400/.test(forgedResp.error.message),
      `server rejects ${label} identity/body injection`);
  }
  assert(issueFetches.length === 1, "rejected identity/body forgeries perform no GitHub read");

  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: { name: "issue_contract_revision", arguments: { repo_key: "api", issue: 42 } },
  });
  const crossRepoResp = await readResponse(shim);
  assert(crossRepoResp.error?.code === -32000 && /API error 403/.test(crossRepoResp.error.message),
    "bound project cannot read another project's registered repository key");

  sendJsonRpc(shim, {
    jsonrpc: "2.0",
    id: 35,
    method: "tools/call",
    params: { name: "issue_contract_revision", arguments: { repo_key: "web", issue: 41 } },
  });
  const unregisteredItemResp = await readResponse(shim);
  assert(unregisteredItemResp.error?.code === -32000 && /API error 403/.test(unregisteredItemResp.error.message),
    "registered repository cannot be used as an arbitrary issue digest oracle");

  const nonRole = "observer";
  const nonRoleToken = crypto.randomBytes(16).toString("hex");
  fileChat.registerShimToken(PROJECT, nonRole, nonRoleToken);
  const nonRoleShim = spawnShim(PROJECT, nonRole, nonRoleToken);
  sendJsonRpc(nonRoleShim, { jsonrpc: "2.0", id: 32, method: "tools/list", params: {} });
  const nonRoleList = await readResponse(nonRoleShim);
  assert(!(nonRoleList.result?.tools || []).some((tool) => tool.name === "issue_contract_revision"),
    "tools/list hides issue_contract_revision from non-project roles");
  assert(!(nonRoleList.result?.tools || []).some((tool) => tool.name === "submit_ci_evidence"),
    "tools/list hides submit_ci_evidence from non-project roles");
  assert(!(nonRoleList.result?.tools || []).some((tool) => tool.name === "read_ci_evidence"),
    "tools/list hides read_ci_evidence from non-project roles");
  sendJsonRpc(nonRoleShim, {
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: { name: "issue_contract_revision", arguments: { repo_key: "web", issue: 42 } },
  });
  const forgedCall = await readResponse(nonRoleShim);
  assert(forgedCall.error?.code === -32000 && /API error 403/.test(forgedCall.error.message),
    "forged hidden tools/call is rejected by the server authorization boundary");
  sendJsonRpc(nonRoleShim, {
    jsonrpc: "2.0",
    id: 36,
    method: "tools/call",
    params: { name: "submit_ci_evidence", arguments: {} },
  });
  const forgedCiSubmit = await readResponse(nonRoleShim);
  assert(forgedCiSubmit.error?.code === -32000 && /API error 403/.test(forgedCiSubmit.error.message),
    "forged hidden CI evidence tools/call is rejected at the server boundary");
  await stopShim(nonRoleShim);

  const badTokenShim = spawnShim(PROJECT, "head", "forged-token");
  sendJsonRpc(badTokenShim, {
    jsonrpc: "2.0",
    id: 34,
    method: "tools/call",
    params: { name: "issue_contract_revision", arguments: { repo_key: "web", issue: 42 } },
  });
  const badAuth = await readResponse(badTokenShim);
  assert(badAuth.error?.code === -32000 && /API error 403/.test(badAuth.error.message),
    "forged shim token cannot call issue_contract_revision");
  await stopShim(badTokenShim);

  const oldRotatedToken = crypto.randomBytes(16).toString("hex");
  const newRotatedToken = crypto.randomBytes(16).toString("hex");
  fileChat.registerShimToken(OTHER_PROJECT, "head", oldRotatedToken);
  fileChat.registerShimToken(OTHER_PROJECT, "head", newRotatedToken);
  assert(fileChat.resolveShimPrincipal(oldRotatedToken) === null,
    "shim token rotation revokes the old principal secret");
  assert(fileChat.resolveShimPrincipal(newRotatedToken)?.projectId === OTHER_PROJECT,
    "shim token reverse lookup derives the current bound project");
  fileChat.shutdownProject(OTHER_PROJECT);
  assert(fileChat.resolveShimPrincipal(newRotatedToken) === null,
    "project shutdown revokes role-tool tokens before same-id reuse");

  // Test 6: ping
  sendJsonRpc(shim, { jsonrpc: "2.0", id: 7, method: "ping" });
  const pingResp = await readResponse(shim);
  assert(pingResp.id === 7 && pingResp.result != null, "ping responds");

  // Cleanup
  await stopShim(shim);
  server.close();
  fileChat.shutdownProject(PROJECT);

  // Clean up test files
  const testDir = path.join(os.homedir(), ".quadwork", PROJECT);
  try { fs.rmSync(testDir, { recursive: true }); } catch {}

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  if (server) server.close();
  process.exit(1);
});
