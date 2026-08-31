"use strict";

// #1031: scheduled trigger authority survives into every cadence pulse and
// through the internal /api/chat hop. A queue rollover at either boundary must
// produce zero chat persistence and zero PTY dispatch. Manual and explicit
// pre-activation V1 paths remain compatible.

const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-trigger-authority-"));
const originalHome = os.homedir;
os.homedir = () => TMP;
process.env.HOME = TMP;
process.env.QUADWORK_SKIP_LISTEN = "1";

const CONFIG_DIR = path.join(TMP, ".quadwork");
const PROJECT = "authority";
const QUEUE_PATH = path.join(CONFIG_DIR, PROJECT, "OVERNIGHT-QUEUE.md");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const INSTALLATION = "installation_trigger_00000001";
const REPOSITORY = { key: "primary", repo: "Owner/Repo", working_dir: path.join(TMP, "repo"), primary: true };
fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
fs.mkdirSync(REPOSITORY.working_dir, { recursive: true });

function writeConfig({
  activated = true,
  triggerEnabled = false,
  triggerAuto = false,
  telegramAuto = false,
  discordAuto = false,
  port = 8400,
} = {}) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    ...(activated ? { installation_id: INSTALLATION } : {}),
    port,
    projects: [{
      id: PROJECT,
      archived: false,
      repositories: [REPOSITORY],
      agents: { head: {} },
      trigger_auto: triggerAuto,
      telegram_auto: telegramAuto,
      discord_auto: discordAuto,
      trigger_enabled: triggerEnabled,
      trigger_interval: 1,
      trigger_message: "queue pulse",
    }],
  }));
}

function writeV2Queue(attempt) {
  fs.writeFileSync(QUEUE_PATH, [
    "## Active Batch",
    "**Batch:** 7",
    "**Batch type:** code",
    `**Installation ID:** ${INSTALLATION}`,
    `**Assignment attempt:** ${attempt}`,
    "- Owner/Repo#42 active",
  ].join("\n"));
}

function writeV1Queue() {
  fs.writeFileSync(QUEUE_PATH, [
    "## Active Batch",
    "**Batch:** 3",
    "**Batch type:** code",
    "- #42 legacy active",
  ].join("\n"));
}

writeConfig();
writeV2Queue("attempt_a");

const routes = require("./routes");
const fileChat = require("./file-chat");
const { captureProjectAdmission, revokeProjectAdmission } = require("./project-lifecycle");
const { ownershipKey, serializeWorkItemRefApi } = require("./work-item-ref");
const runtime = require("./index");

function currentV2Body() {
  const context = routes.readLiveBatchContext(PROJECT);
  const parsed = context.parsed;
  const provenance = {
    installation_id: INSTALLATION,
    batch_number: parsed.batchNumber,
    assignment_attempt: parsed.assignmentAttempt,
  };
  return {
    installation_id: INSTALLATION,
    batch_number: parsed.batchNumber,
    assignment_attempt: parsed.assignmentAttempt,
    provenance: "owned",
    assignment_key: parsed.assignmentKey,
    assignment_items: parsed.workItems.map((item) => ({
      work_item_ref: serializeWorkItemRefApi(item.ref),
      ownership_key: ownershipKey(provenance, item.ref),
    })),
  };
}

function responseSpy() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function request(server, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method: "POST",
      path: `/api/chat?project=${PROJECT}`,
      headers: { "content-type": "application/json", "content-length": payload.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function cleanup() {
  for (const info of runtime.triggers.values()) {
    if (info.timer) clearInterval(info.timer);
    if (info.durationTimer) clearTimeout(info.durationTimer);
  }
  runtime.triggers.clear();
  try { fileChat.shutdownProject(PROJECT); } catch {}
  os.homedir = originalHome;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

(async () => {
  // Start route stores the canonical validator result, not mutable request
  // options, and every callback carries that same V2 identity into chat.
  const v2Body = currentV2Body();
  let scheduledPulse = null;
  const originalSetInterval = global.setInterval;
  global.setInterval = (callback) => { scheduledPulse = callback; return { test_timer: true }; };
  const startResponse = responseSpy();
  try {
    runtime.startTriggerSchedule({
      params: { project: PROJECT },
      body: { interval: 1, duration: 0, message: "queue pulse", ...v2Body },
    }, startResponse);
  } finally {
    global.setInterval = originalSetInterval;
  }
  assert.equal(startResponse.statusCode, 200);
  assert.equal(startResponse.payload.enabled, true);
  assert.equal(typeof scheduledPulse, "function");
  assert.deepEqual(runtime.triggers.get(PROJECT).automationBody, {
    compatibility_mode: "v2",
    ...v2Body,
  }, "validated V2 identity is stored on the timer lifecycle");

  const originalFetch = global.fetch;
  const posts = [];
  global.fetch = async (url, options = {}) => {
    posts.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    const sent = await scheduledPulse();
    assert.equal(sent.sent, true);
    assert.equal(posts.length, 1);
    assert.ok(Number.isSafeInteger(posts[0].body.admission_generation));
    const { admission_generation: _admissionGeneration, ...postedBody } = posts[0].body;
    assert.deepEqual(postedBody, {
      text: "queue pulse",
      channel: "general",
      compatibility_mode: "v2",
      ...v2Body,
    }, "each cadence pulse carries the exact V2 discriminator to /api/chat");

    posts.length = 0;
    writeV2Queue("attempt_b");
    const stale = await scheduledPulse();
    assert.equal(stale.code, "project_assignment_changed");
    assert.equal(stale.sent, false);
    assert.equal(posts.length, 0, "timer from the prior assignment performs zero chat fetch after rollover");
    assert.equal(runtime.triggers.has(PROJECT), false,
      "rolled assignment retires its stale interval instead of retrying forever");
  } finally {
    global.fetch = originalFetch;
    runtime.triggers.clear();
  }

  // trigger_auto owns cadence across batch transitions. When A rolls directly
  // to B, the timer must rebind to the freshly joined B identity rather than
  // treating its captured A body as a reason to stop permanently.
  writeConfig({ activated: true, triggerAuto: true });
  writeV2Queue("attempt_auto_a");
  const autoABody = currentV2Body();
  runtime.triggers.set(PROJECT, {
    interval: 60_000,
    timer: null,
    lastSent: null,
    nextAt: Date.now() + 60_000,
    lastError: null,
    automationBody: { compatibility_mode: "v2", ...autoABody },
  });
  writeV2Queue("attempt_auto_b");
  const autoBBody = currentV2Body();
  const autoTop = {
    compatibility_mode: "v2",
    ...autoBBody,
    owned: true,
    current: true,
    multi_repository: false,
  };
  const autoRef = autoBBody.assignment_items[0].work_item_ref;
  const autoProgress = {
    ...autoTop,
    complete: false,
    completeConfirmed: false,
    items: [{
      installation_id: autoBBody.installation_id,
      batch_number: autoBBody.batch_number,
      assignment_attempt: autoBBody.assignment_attempt,
      provenance: "owned",
      assignment_key: autoBBody.assignment_key,
      owned: true,
      current: true,
      repo_key: autoRef.repo_key,
      repo: autoRef.repo,
      number: autoRef.number,
      kind: autoRef.kind,
      work_item_ref: autoRef,
      ownership_key: autoBBody.assignment_items[0].ownership_key,
    }],
  };
  let reboundChatBody = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/api/batch-progress")) return { ok: true, json: async () => autoProgress };
    if (target.includes("/api/batch-active")) return { ok: true, json: async () => ({ ...autoTop, active: true }) };
    reboundChatBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    const rebound = await runtime.sendTriggerMessage(PROJECT, { compatibility_mode: "v2", ...autoABody });
    assert.equal(rebound.sent, true, "trigger_auto cadence survives direct A→B rollover");
    assert.equal(reboundChatBody.assignment_attempt, "attempt_auto_b");
    assert.equal(runtime.triggers.get(PROJECT).automationBody.assignment_attempt, "attempt_auto_b",
      "timer stores the newly joined B identity for subsequent pulses");
  } finally {
    global.fetch = originalFetch;
    runtime.triggers.clear();
  }

  // Completion uses the same retryable bridge transition ledger as the poller.
  // HTTP 200 with {ok:false} must not mark the assignment stopped.
  writeConfig({ activated: true, triggerAuto: true, telegramAuto: true, discordAuto: true });
  const completedProgress = { ...autoProgress, complete: true, completeConfirmed: true };
  const bridgeStopUrls = [];
  let failFirstTelegramStop = true;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/api/batch-progress")) return { ok: true, json: async () => completedProgress };
    if (target.includes("/api/batch-active")) return { ok: true, json: async () => ({ ...autoTop, active: true }) };
    if (target.includes("action=stop")) {
      bridgeStopUrls.push(target);
      if (target.includes("/api/telegram") && failFirstTelegramStop) {
        failFirstTelegramStop = false;
        return { ok: true, json: async () => ({ ok: false, running: true }) };
      }
      return { ok: true, json: async () => ({ ok: true, running: false }) };
    }
    throw new Error(`unexpected completion URL: ${target}`);
  };
  try {
    assert.equal((await runtime.sendTriggerMessage(PROJECT)).stopped, true);
    assert.equal(bridgeStopUrls.length, 2);
    assert.equal((await runtime.sendTriggerMessage(PROJECT)).stopped, true);
    assert.equal(bridgeStopUrls.length, 4,
      "trigger completion retries both bridges after one application-level stop failure");
    assert.equal((await runtime.sendTriggerMessage(PROJECT)).stopped, true);
    assert.equal(bridgeStopUrls.length, 4,
      "trigger completion advances its stop fingerprint only after both bodies confirm success");
  } finally {
    global.fetch = originalFetch;
    runtime.triggers.clear();
  }

  // Explicit V1 remains identity-bound as compatibility_mode=v1; manual starts
  // remain intentionally unbound. Neither path invents V2 ownership.
  writeConfig({ activated: false });
  writeV1Queue();
  const v1Fingerprint = routes.readLiveBatchContext(PROJECT).fingerprint;
  for (const [label, requestBody, expectedAuthority] of [
    ["v1", { interval: 1, compatibility_mode: "v1", batch_observation_fingerprint: v1Fingerprint },
      { compatibility_mode: "v1", batch_observation_fingerprint: v1Fingerprint }],
    ["manual", { interval: 1 }, null],
  ]) {
    let pulse = null;
    global.setInterval = (callback) => { pulse = callback; return { test_timer: label }; };
    const response = responseSpy();
    try {
      runtime.startTriggerSchedule({ params: { project: PROJECT }, body: requestBody }, response);
    } finally {
      global.setInterval = originalSetInterval;
    }
    assert.equal(response.statusCode, 200, `${label} start accepted`);
    assert.deepEqual(runtime.triggers.get(PROJECT).automationBody, expectedAuthority,
      `${label} timer stores only its intended authority`);
    let chatBody = null;
    global.fetch = async (_url, options = {}) => {
      chatBody = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => "" };
    };
    try { assert.equal((await pulse()).sent, true); }
    finally { global.fetch = originalFetch; runtime.triggers.clear(); }
    assert.deepEqual(
      Object.fromEntries(Object.entries(chatBody).filter(([key]) =>
        key === "compatibility_mode" || key === "batch_observation_fingerprint")),
      expectedAuthority || {},
      `${label} chat pulse does not fabricate V2 identity`,
    );
  }

  // Config sync is a legacy/manual restoration path. It may restore cadence,
  // but it has no receipt from the live assignment join and stores null.
  writeConfig({ activated: true, triggerEnabled: true });
  writeV2Queue("attempt_sync");
  global.setInterval = () => ({ sync_timer: true });
  try { runtime.syncTriggersFromConfig(); }
  finally { global.setInterval = originalSetInterval; }
  assert.equal(runtime.triggers.get(PROJECT).automationBody, null,
    "config sync does not fabricate V2 assignment authority");
  runtime.triggers.clear();

  // Receiver-side deferred rollover: the request carries an identity captured
  // before queue replacement. /api/chat revalidates after transport and before
  // appendMessage/PTY dispatch, so the stale request leaves both counts fixed.
  fileChat.initProject(PROJECT);
  let dispatches = 0;
  let lastDispatchGuard = null;
  routes.setPtyDispatchCallback((_projectId, _message, guard) => {
    dispatches += 1;
    lastDispatchGuard = guard;
  });
  const app = express();
  app.use(express.json());
  app.use(routes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    writeConfig({ activated: true, port: server.address().port });
    writeV2Queue("attempt_receiver_a");
    const receiverBody = currentV2Body();

    const transportFetch = global.fetch;
    global.fetch = async (...args) => {
      // Sender-side validation has already returned. Roll the queue before the
      // actual HTTP receiver runs to exercise the fetch-await TOCTOU boundary.
      writeV2Queue("attempt_receiver_b");
      return transportFetch(...args);
    };
    try {
      const deferred = await runtime.sendTriggerMessage(PROJECT, receiverBody);
      assert.equal(deferred.sent, false);
      assert.equal(deferred.code, "project_assignment_changed");
    } finally {
      global.fetch = transportFetch;
    }
    assert.equal(fileChat.readMessages(PROJECT, {}).length, 0,
      "fetch-await rollover performs zero appendMessage mutation");
    assert.equal(dispatches, 0, "fetch-await rollover performs zero PTY dispatch");

    writeV2Queue("attempt_receiver_c");
    const freshReceiverBody = currentV2Body();
    let response = await request(server, { text: "owned V2", ...freshReceiverBody });
    assert.equal(response.status, 200, "current V2 chat authority succeeds");
    assert.equal(fileChat.readMessages(PROJECT, {}).length, 1);
    assert.equal(dispatches, 1);
    assert.equal(typeof lastDispatchGuard, "function", "identity-bound chat delegates its live guard to delayed PTY work");

    writeV2Queue("attempt_receiver_d");
    assert.equal(lastDispatchGuard(), false, "delegated PTY guard observes assignment rollover after receiver dispatch");
    response = await request(server, { text: "stale V2", ...freshReceiverBody });
    assert.equal(response.status, 409, "rolled V2 chat authority is rejected at the receiver");
    assert.equal(response.json.code, "project_assignment_changed");
    assert.equal(fileChat.readMessages(PROJECT, {}).length, 1,
      "deferred rollover performs zero appendMessage mutation");
    assert.equal(dispatches, 1, "deferred rollover performs zero PTY dispatch");

    // Authority is rechecked separately at each irreversible boundary. If the
    // assignment rolls immediately after a valid append, the old assignment's
    // message is retained but it must never wake a PTY in the new assignment.
    writeV2Queue("attempt_receiver_e");
    const appendBoundaryBody = currentV2Body();
    const originalAppendMessage = fileChat.appendMessage;
    const beforeAppendBoundary = fileChat.readMessages(PROJECT, {}).length;
    const dispatchesBeforeAppendBoundary = dispatches;
    fileChat.appendMessage = (...args) => {
      const message = originalAppendMessage(...args);
      writeV2Queue("attempt_receiver_f");
      return message;
    };
    try {
      response = await request(server, { text: "roll after append", ...appendBoundaryBody });
    } finally {
      fileChat.appendMessage = originalAppendMessage;
    }
    assert.equal(response.status, 200, "chat append that was current at its boundary remains accepted");
    assert.equal(fileChat.readMessages(PROJECT, {}).length, beforeAppendBoundary + 1);
    assert.equal(dispatches, dispatchesBeforeAppendBoundary,
      "rollover between chat append and PTY boundary suppresses stale dispatch");

    // The local admission lease also crosses the HTTP hop. Archive→unarchive
    // can restore identical queue bytes, so assignment identity alone cannot
    // distinguish a request issued by the prior project generation.
    writeConfig({ activated: true, port: server.address().port });
    writeV2Queue("attempt_admission");
    const admissionBody = currentV2Body();
    const beforeAdmissionRollover = fileChat.readMessages(PROJECT, {}).length;
    const dispatchesBeforeAdmissionRollover = dispatches;
    global.fetch = async (...args) => {
      revokeProjectAdmission(PROJECT);
      writeConfig({ activated: true, port: server.address().port });
      captureProjectAdmission(PROJECT);
      return transportFetch(...args);
    };
    try {
      const staleAdmission = await runtime.sendTriggerMessage(PROJECT, admissionBody);
      assert.equal(staleAdmission.sent, false);
      assert.equal(staleAdmission.code, "project_assignment_changed");
    } finally {
      global.fetch = transportFetch;
    }
    assert.equal(fileChat.readMessages(PROJECT, {}).length, beforeAdmissionRollover,
      "archive→unarchive during transport performs zero stale append");
    assert.equal(dispatches, dispatchesBeforeAdmissionRollover,
      "archive→unarchive during transport performs zero stale PTY dispatch");

    writeConfig({ activated: false, port: server.address().port });
    writeV1Queue();
    response = await request(server, {
      text: "owned V1",
      compatibility_mode: "v1",
      batch_observation_fingerprint: routes.readLiveBatchContext(PROJECT).fingerprint,
    });
    assert.equal(response.status, 200, "current explicit V1 chat authority succeeds");
    response = await request(server, { text: "manual chat" });
    assert.equal(response.status, 200, "manual chat without identity remains compatible");
    assert.equal(lastDispatchGuard, null,
      "manual chat keeps only the project-admission delayed guard and is not misclassified as assignment-bound");
    assert.equal(fileChat.readMessages(PROJECT, {}).length, 4);
    assert.equal(dispatches, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("triggerAssignmentLifecycle.test.js: all assertions passed");
  cleanup();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
