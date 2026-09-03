"use strict";

// #1036: the compatibility trigger routes now drive the fixed Head-only
// Project Monitor.  This proves, through the real route handlers, that no
// caller can persist or replay a pulse: legacy trigger fields are retained
// only as disabled migration data, authoring inputs are rejected, a
// non-ready project cannot start, and a live batch yields structured Head
// events only on a transition.  Zero worker wakes, zero generic prose.

const assert = require("node:assert/strict");
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
const REPO_DIR = path.join(TMP, "repo");
const LEGACY_MESSAGE = "@head @re1 @re2 @dev — Queue check. RE1/RE2: Review ONLY PRs you were @mentioned on";
fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });
fs.chmodSync(CONFIG_DIR, 0o700);

function writeConfig({ ciPolicy = true, legacy = true, idle = false } = {}) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    installation_id: INSTALLATION,
    port: 8400,
    projects: [{
      id: PROJECT,
      archived: false,
      idle,
      chat_mode: "file",
      repositories: [{ key: "primary", repo: "Owner/Repo", working_dir: REPO_DIR, primary: true, ...(ciPolicy ? { ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["operator"] } } : {}) }],
      agents: { head: {} },
      ...(legacy ? {
        trigger_enabled: true,
        trigger_interval: 1,
        trigger_interval_min: 1,
        trigger_duration_min: 180,
        trigger_message: LEGACY_MESSAGE,
      } : {}),
    }],
  }));
}
function writeQueue(items = ["- Owner/Repo#42 active", "- Owner/Repo#43 queued"]) {
  fs.writeFileSync(QUEUE_PATH, ["## Active Batch", "**Batch:** 7", "**Batch type:** code", `**Installation ID:** ${INSTALLATION}`, "**Assignment attempt:** attempt_a", ...items].join("\n"));
}

writeConfig();
writeQueue();

const routes = require("./routes");
const fileChat = require("./file-chat");
const { captureProjectAdmission } = require("./project-lifecycle");
const { ownershipKey, serializeWorkItemRefApi } = require("./work-item-ref");
const runtime = require("./index");

function seedProgress({ rows = null, complete = false } = {}) {
  const context = routes.readLiveBatchContext(PROJECT);
  const parsed = context.parsed;
  const admission = captureProjectAdmission(PROJECT);
  const provenance = { installation_id: INSTALLATION, batch_number: parsed.batchNumber, assignment_attempt: parsed.assignmentAttempt };
  const identity = {
    admission_generation: admission.generation, compatibility_mode: "v2", batch_observation_fingerprint: context.fingerprint,
    installation_id: INSTALLATION, batch_number: parsed.batchNumber, assignment_attempt: parsed.assignmentAttempt, provenance: "owned",
    assignment_key: parsed.assignmentKey,
    assignment_items: parsed.workItems.map((item) => ({ work_item_ref: serializeWorkItemRefApi(item.ref), ownership_key: ownershipKey(provenance, item.ref) })),
    current: true, owned: true, multi_repository: false,
  };
  const rowFacts = rows || parsed.workItems.map(() => ({ status: "queued", live_pr: null, review_handoff: null }));
  const data = {
    ...identity, batch_type: "code", active: true, complete, completeConfirmed: complete, liveActiveBatchCleared: false,
    items: parsed.workItems.map((item, index) => ({
      ...identity, repo_key: item.repoKey, repo: item.repo, number: item.number, kind: item.kind, issue_number: item.number,
      work_item_ref: serializeWorkItemRefApi(item.ref), ownership_key: ownershipKey(provenance, item.ref), ...rowFacts[index],
    })),
  };
  routes._batchProgressCache.set(PROJECT, { ts: Date.now(), fingerprint: context.fingerprint, admission_generation: admission.generation, data });
  return identity;
}

function responseSpy() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}
async function route(handler, body = {}) {
  const res = responseSpy();
  await handler({ params: { project: PROJECT }, body }, res);
  return res;
}
function config() { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
function monitorEvents() { return fileChat.readMessages(PROJECT, { since_id: 0, limit: 200 }).filter((record) => record.type === "trusted_event"); }
function monitorState() { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, PROJECT, "monitor-state.json"), "utf8")); }

function cleanup() {
  try { fileChat.shutdownProject(PROJECT); } catch {}
  os.homedir = originalHome;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

(async () => {
  fileChat.initProject(PROJECT);
  const posts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => { posts.push({ url: String(url), options }); throw new Error("no pulse path may fetch"); };
  try {
    // Migration: the persisted permissive pulse becomes disabled legacy data on
    // the first sync; nothing is scheduled and nothing is posted.
    const migrated = runtime.syncTriggersFromConfig();
    assert.equal(migrated.migrated, true);
    let project = config().projects[0];
    for (const field of ["trigger_message", "trigger_interval_min", "trigger_duration_min", "trigger_enabled", "trigger_interval"]) {
      assert.equal(Object.hasOwn(project, field), false, `${field} is removed from the live project entry`);
    }
    assert.equal(project.legacy_trigger.message, LEGACY_MESSAGE);
    assert.equal(project.legacy_trigger.enabled, true);
    assert.equal(project.legacy_trigger.disabled, true);
    assert.equal(runtime.syncTriggersFromConfig().migrated, false, "a second sync is a no-op");
    assert.equal(monitorEvents().length, 0);
    assert.equal(fileChat.readMessages(PROJECT, {}).length, 0, "migration writes no chat");
    assert.equal(posts.length, 0, "migration performs no HTTP work");
    assert.equal(Object.hasOwn(runtime, "sendTriggerMessage"), false, "no pulse sender is exported any more");

    // Authoring inputs are rejected before any state change.
    for (const body of [{ message: LEGACY_MESSAGE }, { interval: 15 }, { duration: 180 }, { interval_min: 5, message: "x" }]) {
      const rejected = await route(runtime.startTriggerSchedule, body);
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.payload.code, "trigger_authoring_removed");
      assert.deepEqual([...rejected.payload.rejected_fields].sort(), Object.keys(body).sort());
    }
    assert.equal(fs.existsSync(path.join(CONFIG_DIR, PROJECT, "monitor-state.json")), false, "a rejected start writes no monitor state");

    // A non-ready project is a typed non-start; an idle project is parked.
    writeConfig({ ciPolicy: false, legacy: false });
    const notReady = await route(runtime.startTriggerSchedule);
    assert.equal(notReady.statusCode, 409);
    assert.equal(notReady.payload.reason, "v2_setup_not_ready");
    assert.ok(notReady.payload.readiness.includes("missing_policy"));
    writeConfig({ legacy: false, idle: true });
    const parked = await route(runtime.startTriggerSchedule);
    assert.deepEqual(parked.payload, { ok: false, idle: true, enabled: false });
    writeConfig({ legacy: false });
    writeQueue(["(none)"]);
    routes._batchProgressCache.clear();
    const emptyStart = await route(runtime.startTriggerSchedule);
    assert.equal(emptyStart.statusCode, 409);
    assert.equal(emptyStart.payload.reason, "no_current_qualified_subject");
    assert.equal(monitorEvents().length, 0, "no start path posts a message");

    // A live qualified batch starts the monitor; the loaded-but-unassigned
    // subject is one structured Head event, and unchanged ticks add nothing.
    writeQueue();
    const identity = seedProgress();
    const started = await route(runtime.startTriggerSchedule, {
      admission_generation: identity.admission_generation, compatibility_mode: "v2", batch_observation_fingerprint: identity.batch_observation_fingerprint,
      installation_id: identity.installation_id, batch_number: identity.batch_number, assignment_attempt: identity.assignment_attempt,
      provenance: "owned", assignment_key: identity.assignment_key, assignment_items: identity.assignment_items,
    });
    assert.equal(started.statusCode, 200, JSON.stringify(started.payload));
    assert.equal(started.payload.enabled, true);
    assert.equal(started.payload.mode, "enabled");
    assert.equal(Object.hasOwn(started.payload, "interval"), false);
    assert.equal(monitorState().mode, "enabled");
    let events = monitorEvents();
    assert.equal(events.length, 1);
    assert.match(events[0].text, /^@head \[QW-MONITOR:next_loaded_unassigned\] assignment=b7-[a-f0-9]{16} subject=primary:issue#42 event=[a-f0-9]{32}$/);
    assert.equal(events[0].trusted_event.kind, "next_loaded_unassigned");
    assert.equal(events[0].sender, "system");
    for (let tick = 0; tick < 3; tick += 1) {
      const evaluated = await runtime.evaluateProjectMonitorNow(PROJECT);
      assert.equal(evaluated.applied, true);
      assert.equal(evaluated.changed, false);
    }
    assert.equal(monitorEvents().length, 1, "repeated unchanged evaluations write nothing");
    const server = runtime.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    let listing;
    try {
      listing = await new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/triggers" }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
        }).on("error", reject);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(listing[PROJECT].enabled, true);
    assert.equal(listing[PROJECT].last_evaluation.changed, false);
    for (const field of ["message", "intervalMin", "durationMin", "interval"]) {
      assert.equal(Object.hasOwn(listing[PROJECT], field), false, `the listing exposes no ${field}`);
    }

    // Terminal state clears conditions; stop suspends; a suspended monitor
    // refuses evaluation; config sync cannot re-enable it.
    seedProgress({ complete: true });
    const terminal = await runtime.evaluateProjectMonitorNow(PROJECT);
    assert.equal(terminal.terminal, true);
    assert.deepEqual(monitorState().unresolved, {});
    const stopped = await route(runtime.suspendProjectMonitor === undefined ? null : async (req, res) => res.json(runtime.suspendProjectMonitor(PROJECT)));
    assert.equal(stopped.payload.mode, "suspended");
    const refused = await runtime.evaluateProjectMonitorNow(PROJECT);
    assert.deepEqual({ applied: refused.applied, reason: refused.reason }, { applied: false, reason: "monitor_suspended" });
    writeConfig({ legacy: true });
    runtime.syncTriggersFromConfig();
    assert.equal(monitorState().mode, "suspended", "a re-appearing legacy trigger_enabled cannot resurrect the monitor");
    assert.equal(config().projects[0].legacy_trigger.disabled, true);
    assert.equal(monitorEvents().length, 1);
    const all = fileChat.readMessages(PROJECT, { since_id: 0, limit: 200 });
    assert.equal(all.length, 1, "the only chat write across the whole lifecycle is the single Head event");
    assert.doesNotMatch(JSON.stringify(all), /@dev|@re1|@re2|Review open PRs|Review ONLY PRs|Queue check/);
    assert.equal(posts.length, 0, "no code path fetched a pulse endpoint");
  } finally {
    global.fetch = originalFetch;
  }

  console.log("triggerAssignmentLifecycle.test.js: all assertions passed");
  cleanup();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
