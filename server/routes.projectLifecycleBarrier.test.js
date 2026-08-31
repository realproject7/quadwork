// #1034: project archive/unarchive/removal routes delegate to the lifecycle
// controller, return stable typed failures, and the owned UI waits for the
// server result before committing local state. Plain node:assert fixture.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const TMP = path.join(os.tmpdir(), `routes-lifecycle-${process.pid}-${Date.now()}`);
fs.mkdirSync(path.join(TMP, ".quadwork"), { recursive: true });
fs.writeFileSync(path.join(TMP, ".quadwork", "config.json"), JSON.stringify({
  port: 8400,
  projects: [{ id: "alpha", name: "Alpha", archived: false }],
}));

const originalHomedir = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => {
  os.homedir = originalHomedir;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const express = require("express");
const router = require("./routes");
const fileChat = require("./file-chat");
const telegramBridge = require("./bridges/telegram");
const discordBridge = require("./bridges/discord");
const { ProjectLifecycleError, captureProjectAdmission, revokeProjectAdmission } = require("./project-lifecycle");
const { ConfigurationValidationError } = require("./config");
const { ownershipKey, serializeWorkItemRefApi } = require("./work-item-ref");

function request(server, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method,
      path: pathname,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const calls = [];
  const lifecycle = {
    async archiveProject(id) {
      calls.push(["archive", id]);
      return { ok: true, project_id: id, archived: true, already_archived: false, admission_generation: 1, resources: { sessions: 1 }, cleanup_errors: [] };
    },
    async unarchiveProject(id) {
      calls.push(["unarchive", id]);
      return { ok: true, project_id: id, archived: false, already_unarchived: false, admission_generation: 1, resources: {}, cleanup_errors: [] };
    },
    async removeProject(id) {
      calls.push(["remove", id]);
      return { ok: false, project_id: id, archived: true, removed: false, admission_generation: 2, resources: { sessions: 1 }, cleanup_errors: [{ resource: "worktree", code: "cleanup_busy", message: "retry after the task exits" }] };
    },
  };
  const app = express();
  app.use(express.json());
  app.set("projectLifecycle", lifecycle);
  let triggerSyncs = 0;
  app.set("syncTriggers", () => { triggerSyncs += 1; });
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    let response = await request(server, "PUT", "/api/projects/alpha/archive", { archived: true });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.pop(), ["archive", "alpha"]);
    assert.equal(response.json.archived, true);
    assert.deepEqual(response.json.cleanup_errors, []);

    response = await request(server, "PUT", "/api/projects/alpha/archive", { archived: false });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.pop(), ["unarchive", "alpha"]);
    assert.equal(response.json.archived, false);
    assert.equal(triggerSyncs, 0, "unarchive does not auto-start trigger demand");

    response = await request(server, "DELETE", "/api/projects/alpha");
    assert.equal(response.status, 503);
    assert.deepEqual(calls.pop(), ["remove", "alpha"]);
    assert.equal(response.json.code, "project_cleanup_incomplete");
    assert.equal(response.json.removed, false);
    assert.deepEqual(response.json.cleanup_errors, [{ resource: "worktree", code: "cleanup_busy", message: "retry after the task exits" }]);

    lifecycle.unarchiveProject = async () => { throw new ConfigurationValidationError("repository_working_dir_collision", "projects.repositories.working_dir", "collision", "bravo"); };
    response = await request(server, "PUT", "/api/projects/alpha/archive", { archived: false });
    assert.equal(response.status, 409);
    assert.deepEqual(response.json, {
      ok: false,
      error: "V2 configuration validation failed",
      code: "repository_working_dir_collision",
      field: "projects.repositories.working_dir",
      owner_project_id: "bravo",
      project_id: "alpha",
    });

    lifecycle.archiveProject = async () => { throw new ProjectLifecycleError("project_archived", "alpha", "project is archived", 409); };
    response = await request(server, "PUT", "/api/projects/alpha/archive", { archived: true });
    assert.equal(response.status, 409);
    assert.deepEqual(response.json, { ok: false, error: "project is archived", code: "project_archived", project_id: "alpha" });

    response = await request(server, "PUT", "/api/projects/alpha/archive", { archived: "yes" });
    assert.equal(response.status, 400);
    assert.equal(response.json.code, "invalid_archive_state");

    const originalTelegramStop = telegramBridge.stop;
    try {
      let asyncStopResolved = false;
      telegramBridge.stop = async () => {
        await Promise.resolve();
        asyncStopResolved = true;
        return { ok: true, resources: { telegram: 1 }, cleanup_errors: [] };
      };
      response = await request(server, "POST", "/api/telegram?action=stop", { project_id: "alpha" });
      assert.equal(response.status, 200);
      assert.equal(asyncStopResolved, true, "Telegram stop awaits the strict async bridge result");
      assert.equal(response.json.ok, true);

      telegramBridge.stop = async () => ({
        ok: false,
        resources: {},
        cleanup_errors: [{ resource: "telegram", code: "cleanup_busy", message: "still stopping" }],
      });
      response = await request(server, "POST", "/api/telegram?action=stop", { project_id: "alpha" });
      assert.equal(response.status, 503);
      assert.equal(response.json.code, "bridge_cleanup_incomplete");
    } finally {
      telegramBridge.stop = originalTelegramStop;
    }

    const bridgeConfigPath = path.join(TMP, ".quadwork", "config.json");
    const bridgeInstallationId = "installation_bridge_00000001";
    const bridgeRepositories = [{ key: "primary", repo: "Acme/Alpha", working_dir: "/tmp/alpha", primary: true }];
    const bridgeQueue = [
      "## Active Batch",
      "**Batch:** 7",
      "**Batch type:** code",
      `**Installation ID:** ${bridgeInstallationId}`,
      "**Assignment attempt:** bridge_attempt_a",
      "- Acme/Alpha#42 active",
    ].join("\n");
    fs.mkdirSync(path.join(TMP, ".quadwork", "alpha"), { recursive: true });
    fs.writeFileSync(path.join(TMP, ".quadwork", "alpha", "OVERNIGHT-QUEUE.md"), bridgeQueue);
    fs.writeFileSync(bridgeConfigPath, JSON.stringify({ installation_id: bridgeInstallationId, projects: [{
      id: "alpha",
      name: "Alpha",
      archived: false,
      repositories: bridgeRepositories,
      telegram: { bot_token: "telegram-token", chat_id: "chat" },
      discord: { bot_token: "discord-token", channel_id: "channel" },
    }] }));
    const bridgeParsed = router.parseActiveBatch(bridgeQueue, {
      repositories: bridgeRepositories,
      installationId: bridgeInstallationId,
    });
    const bridgeAssignment = {
      installation_id: bridgeInstallationId,
      batch_number: bridgeParsed.batchNumber,
      assignment_attempt: bridgeParsed.assignmentAttempt,
      provenance: "owned",
      assignment_key: bridgeParsed.assignmentKey,
      assignment_items: bridgeParsed.workItems.map((item) => ({
        work_item_ref: serializeWorkItemRefApi(item.ref),
        ownership_key: ownershipKey({
          installation_id: bridgeInstallationId,
          batch_number: bridgeParsed.batchNumber,
          assignment_attempt: bridgeParsed.assignmentAttempt,
        }, item.ref),
      })).sort((a, b) => a.ownership_key.localeCompare(b.ownership_key)),
    };
    for (const [name, bridge] of [["telegram", telegramBridge], ["discord", discordBridge]]) {
      const original = { start: bridge.start, stop: bridge.stop, isRunning: bridge.isRunning };
      const bridgeCalls = { start: 0, stop: 0, isRunning: 0 };
      let latestStartOptions = null;
      try {
        bridge.start = async (...args) => {
          bridgeCalls.start += 1;
          latestStartOptions = args[4];
          return { ok: true };
        };
        bridge.stop = async () => { bridgeCalls.stop += 1; return { ok: true, resources: {}, cleanup_errors: [] }; };
        bridge.isRunning = () => { bridgeCalls.isRunning += 1; return false; };

        const currentAdmission = captureProjectAdmission("alpha");
        response = await request(server, "POST", `/api/${name}?action=start`, {
          project_id: "alpha",
          admission_generation: currentAdmission.generation,
          ...bridgeAssignment,
        });
        assert.equal(response.status, 200, `${name} current-generation start succeeds`);
        assert.equal(response.json.ok, true);
        assert.equal(typeof latestStartOptions?.isAuthorityCurrent, "function",
          `${name} start injects a persistent runtime authority guard`);
        assert.equal(latestStartOptions.isAuthorityCurrent(), true,
          `${name} injected authority is current before rollover`);
        assert.equal(latestStartOptions.automationIdentity.admission_generation, currentAdmission.generation);
        assert.equal(latestStartOptions.automationIdentity.compatibility_mode, "v2");
        assert.equal(latestStartOptions.automationIdentity.assignment_key, bridgeAssignment.assignment_key,
          `${name} carries the server-validated assignment identity to inbound chat`);
        response = await request(server, "POST", `/api/${name}?action=stop`, {
          project_id: "alpha",
          admission_generation: currentAdmission.generation,
          ...bridgeAssignment,
        });
        assert.equal(response.status, 200, `${name} current-generation stop succeeds`);
        assert.equal(response.json.ok, true);
        assert.equal(bridgeCalls.start, 1);
        assert.equal(bridgeCalls.stop, 1);

        const beforeMissingAssignment = { ...bridgeCalls };
        response = await request(server, "POST", `/api/${name}?action=start`, {
          project_id: "alpha",
          admission_generation: currentAdmission.generation,
        });
        assert.equal(response.status, 409, `${name} automated start requires exact assignment identity`);
        assert.equal(response.json.code, "project_assignment_changed");
        assert.deepEqual(bridgeCalls, beforeMissingAssignment, `${name} missing assignment makes zero bridge calls`);
        response = await request(server, "POST", `/api/${name}?action=stop`, {
          project_id: "alpha",
          admission_generation: currentAdmission.generation,
          ...bridgeAssignment,
          assignment_items: [],
        });
        assert.equal(response.status, 409, `${name} rejects a mismatched per-item ownership set`);
        assert.equal(response.json.code, "project_assignment_changed");
        assert.deepEqual(bridgeCalls, beforeMissingAssignment, `${name} ownership mismatch makes zero bridge calls`);

        let rolloverGuardCurrent = true;
        bridge.start = async (...args) => {
          bridgeCalls.start += 1;
          fs.writeFileSync(
            path.join(TMP, ".quadwork", "alpha", "OVERNIGHT-QUEUE.md"),
            bridgeQueue.replace("bridge_attempt_a", "bridge_attempt_b"),
          );
          rolloverGuardCurrent = args[4].isAuthorityCurrent();
          return { ok: true };
        };
        response = await request(server, "POST", `/api/${name}?action=start`, {
          project_id: "alpha",
          admission_generation: currentAdmission.generation,
          ...bridgeAssignment,
        });
        assert.equal(response.status, 409, `${name} start rejects an assignment rollover during await`);
        assert.equal(response.json.code, "project_assignment_changed", `${name} rollover is not mislabeled archived`);
        assert.equal(rolloverGuardCurrent, false, `${name} runtime guard observes assignment-attempt rollover`);
        assert.equal(bridgeCalls.stop, 2, `${name} rolls back the just-started stale bridge`);
        fs.writeFileSync(path.join(TMP, ".quadwork", "alpha", "OVERNIGHT-QUEUE.md"), bridgeQueue);

        bridge.start = async () => {
          bridgeCalls.start += 1;
          fs.writeFileSync(
            path.join(TMP, ".quadwork", "alpha", "OVERNIGHT-QUEUE.md"),
            bridgeQueue.replace(bridgeInstallationId, "installation_bridge_foreign01"),
          );
          return { ok: true };
        };
        response = await request(server, "POST", `/api/${name}?action=start`, {
          project_id: "alpha",
          admission_generation: currentAdmission.generation,
          ...bridgeAssignment,
        });
        assert.equal(response.status, 409, `${name} start rejects an installation provenance rollover during await`);
        assert.equal(response.json.code, "project_assignment_changed");
        assert.equal(bridgeCalls.stop, 3, `${name} rolls back a bridge started under stale installation provenance`);
        fs.writeFileSync(path.join(TMP, ".quadwork", "alpha", "OVERNIGHT-QUEUE.md"), bridgeQueue);
        bridge.start = async (...args) => {
          bridgeCalls.start += 1;
          latestStartOptions = args[4];
          return { ok: true };
        };

        // Preactivation, single-repository bare queues retain the legacy
        // compatibility-mode automation contract. They are never promoted to V2
        // ownership, while activated/unowned queues above remain fail-closed.
        const legacyQueue = [
          "## Active Batch",
          "**Batch:** 7",
          "**Batch type:** code",
          "- #42 active",
        ].join("\n");
        fs.writeFileSync(path.join(TMP, ".quadwork", "alpha", "OVERNIGHT-QUEUE.md"), legacyQueue);
        fs.writeFileSync(bridgeConfigPath, JSON.stringify({ projects: [{
          id: "alpha",
          name: "Alpha",
          archived: false,
          repo: "Acme/Alpha",
          working_dir: "/tmp/alpha",
          telegram: { bot_token: "telegram-token", chat_id: "chat" },
          discord: { bot_token: "discord-token", channel_id: "channel" },
        }] }));
        const beforeLegacy = { ...bridgeCalls };
        response = await request(server, "POST", `/api/${name}?action=start`, {
          project_id: "alpha",
          compatibility_mode: "v1",
        });
        assert.equal(response.status, 200, `${name} V1 admission-only automated start remains compatible`);
        assert.equal(latestStartOptions.isAuthorityCurrent(), true,
          `${name} V1 automation receives a live compatibility guard`);
        assert.equal(latestStartOptions.automationIdentity.compatibility_mode, "v1");
        assert.equal(latestStartOptions.automationIdentity.admission_generation, currentAdmission.generation,
          `${name} V1 inbound carry remains admission-bound`);
        response = await request(server, "POST", `/api/${name}?action=stop`, {
          project_id: "alpha",
          compatibility_mode: "v1",
        });
        assert.equal(response.status, 200, `${name} V1 admission-only automated stop remains compatible`);
        assert.equal(bridgeCalls.start, beforeLegacy.start + 1);
        assert.equal(bridgeCalls.stop, beforeLegacy.stop + 1);
        fs.writeFileSync(path.join(TMP, ".quadwork", "alpha", "OVERNIGHT-QUEUE.md"), bridgeQueue);
        fs.writeFileSync(bridgeConfigPath, JSON.stringify({ installation_id: bridgeInstallationId, projects: [{
          id: "alpha",
          name: "Alpha",
          archived: false,
          repositories: bridgeRepositories,
          telegram: { bot_token: "telegram-token", chat_id: "chat" },
          discord: { bot_token: "discord-token", channel_id: "channel" },
        }] }));

        response = await request(server, "POST", `/api/${name}?action=start`, {
          project_id: "alpha",
          admission_generation: -1,
        });
        assert.equal(response.status, 400, `${name} rejects an invalid admission generation`);
        assert.equal(response.json.code, "invalid_admission_generation");

        const staleAdmission = captureProjectAdmission("alpha");
        revokeProjectAdmission("alpha");
        fs.writeFileSync(bridgeConfigPath, JSON.stringify({ installation_id: bridgeInstallationId, projects: [{ id: "alpha", archived: true, repositories: bridgeRepositories }] }));
        fs.writeFileSync(bridgeConfigPath, JSON.stringify({ installation_id: bridgeInstallationId, projects: [{
          id: "alpha",
          name: "Alpha",
          archived: false,
          repositories: bridgeRepositories,
          telegram: { bot_token: "telegram-token", chat_id: "chat" },
          discord: { bot_token: "discord-token", channel_id: "channel" },
        }] }));
        const beforeStale = { ...bridgeCalls };
        for (const action of ["start", "stop"]) {
          response = await request(server, "POST", `/api/${name}?action=${action}`, {
            project_id: "alpha",
            admission_generation: staleAdmission.generation,
            ...bridgeAssignment,
          });
          assert.equal(response.status, 409, `${name} stale ${action} is rejected after archive→unarchive`);
          assert.deepEqual(response.json, {
            ok: false,
            error: "project admission changed; refresh and retry",
            code: "project_admission_changed",
            project_id: "alpha",
          });
        }
        assert.deepEqual(bridgeCalls, beforeStale, `${name} stale start/stop make zero bridge calls`);

        response = await request(server, "POST", `/api/${name}?action=start`, { project_id: "alpha" });
        assert.equal(response.status, 200, `${name} manual start without a generation remains compatible`);
        assert.equal(latestStartOptions.automationIdentity, null,
          `${name} true manual start keeps inbound chat unbound`);
        assert.equal(latestStartOptions.isAuthorityCurrent(), true,
          `${name} manual runtime remains protected by project admission`);
      } finally {
        bridge.start = original.start;
        bridge.stop = original.stop;
        bridge.isRunning = original.isRunning;
      }
    }

    // A carried admission generation closes the archive→unarchive receiver
    // race even when the assignment text itself is restored byte-for-byte.
    fileChat.initProject("alpha");
    let staleInboundDispatches = 0;
    router.setPtyDispatchCallback(() => { staleInboundDispatches += 1; });
    const staleInboundAdmission = captureProjectAdmission("alpha");
    revokeProjectAdmission("alpha");
    fs.writeFileSync(bridgeConfigPath, JSON.stringify({ installation_id: bridgeInstallationId, projects: [{
      id: "alpha",
      name: "Alpha",
      archived: false,
      repositories: bridgeRepositories,
    }] }));
    const beforeStaleInbound = fileChat.readMessages("alpha", {}).length;
    response = await request(server, "POST", "/api/chat?project=alpha", {
      project: "alpha",
      text: "stale bridge inbound",
      admission_generation: staleInboundAdmission.generation,
      ...bridgeAssignment,
    });
    assert.equal(response.status, 409, "stale bridge admission is rejected at the chat receiver");
    assert.equal(response.json.code, "project_admission_changed");
    assert.equal(fileChat.readMessages("alpha", {}).length, beforeStaleInbound,
      "stale admission performs zero chat append");
    assert.equal(staleInboundDispatches, 0, "stale admission performs zero PTY dispatch");
    router.setPtyDispatchCallback(null);

    const settings = fs.readFileSync(path.join(__dirname, "..", "src", "components", "SettingsPage.tsx"), "utf-8");
    assert.match(settings, /projectLifecyclePending/);
    assert.match(settings, /cleanup_errors/);
    assert.match(settings, /retryCleanup/);
    assert.match(settings, /projectLifecycleErrors\[project\.id\][\s\S]*onClick=\{\(\) => archiveProject\(idx\)\}/);
    assert.match(settings, /await fetch\(`\/api\/projects\/\$\{encodeURIComponent\(target\.id\)\}\/archive`/);
    assert.match(settings, /if \(payload\.removed === true\)/);

    const controlBar = fs.readFileSync(path.join(__dirname, "..", "src", "components", "ControlBar.tsx"), "utf-8");
    assert.match(controlBar, /\/api\/caffeinate\/status\?project=\$\{encodeURIComponent\(projectId\)\}/);
    assert.match(controlBar, /JSON\.stringify\(\{ project_id: projectId, duration:/);
    assert.match(controlBar, /JSON\.stringify\(\{ project_id: projectId \}\)/);

    assert.equal(typeof router.cancelProjectBackground, "function");
    const cleanup = await router.cancelProjectBackground("alpha");
    assert.equal(cleanup.ok, true);
    assert.ok(cleanup.resources && Array.isArray(cleanup.cleanup_errors));
    const cleanupRetry = await router.cancelProjectBackground("alpha");
    assert.deepEqual(cleanupRetry.resources, { github_demand: 0, github_leases: 0, batch_progress: 0 }, "background cleanup retry reports exact zero counts");

    // Username discovery is an external await. An archive→unarchive cycle
    // invalidates its admission generation, so the stale response must not
    // overwrite the fresh config (and archived status reads make zero calls).
    const originalFetch = global.fetch;
    try {
      for (const bridge of ["telegram", "discord"]) {
        fs.writeFileSync(bridgeConfigPath, JSON.stringify({ projects: [{
          id: "alpha",
          name: "Alpha",
          archived: false,
          [bridge]: bridge === "telegram"
            ? { bot_token: "telegram-token", chat_id: "chat" }
            : { bot_token: "discord-token", channel_id: "channel" },
        }] }));
        let releaseFetch;
        let signalFetch;
        const fetchStarted = new Promise((resolve) => { signalFetch = resolve; });
        const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
        let fetchCalls = 0;
        global.fetch = async () => {
          fetchCalls += 1;
          signalFetch();
          await fetchGate;
          return bridge === "telegram"
            ? { ok: true, json: async () => ({ ok: true, result: { username: "stale-telegram" } }) }
            : { ok: true, json: async () => ({ username: "stale-discord" }) };
        };
        const pendingStatus = request(server, "GET", `/api/${bridge}?project=alpha`);
        await fetchStarted;
        revokeProjectAdmission("alpha");
        fs.writeFileSync(bridgeConfigPath, JSON.stringify({ projects: [{ id: "alpha", archived: true }] }));
        fs.writeFileSync(bridgeConfigPath, JSON.stringify({ projects: [{
          id: "alpha",
          name: "Alpha",
          archived: false,
          [bridge]: bridge === "telegram"
            ? { bot_token: "telegram-token", chat_id: "chat" }
            : { bot_token: "discord-token", channel_id: "channel" },
        }] }));
        releaseFetch();
        const status = await pendingStatus;
        assert.equal(status.status, 200);
        assert.equal(status.json.bot_username, "", `${bridge} stale username is not returned after an archive cycle`);
        const stored = JSON.parse(fs.readFileSync(bridgeConfigPath, "utf-8"));
        assert.equal(stored.projects[0][bridge].bot_username, undefined,
          `${bridge} stale username does not write through a fresh field-scoped mutation`);
        assert.equal(fetchCalls, 1);
      }

      fs.writeFileSync(bridgeConfigPath, JSON.stringify({ projects: [{ id: "alpha", archived: true }] }));
      let archivedFetches = 0;
      global.fetch = async () => { archivedFetches += 1; throw new Error("archived status must not fetch"); };
      const [telegramArchived, discordArchived] = await Promise.all([
        request(server, "GET", "/api/telegram?project=alpha"),
        request(server, "GET", "/api/discord?project=alpha"),
      ]);
      assert.equal(telegramArchived.json.archived, true);
      assert.equal(discordArchived.json.archived, true);
      assert.equal(archivedFetches, 0, "archived bridge status performs zero external fetches");
    } finally {
      global.fetch = originalFetch;
    }

    // Concurrent demand from the same project is represented by exact owner
    // records, not a project-id bucket. Cleanup revokes/counts both records and
    // a retry reports zero without letting the abandoned request publish.
    fs.writeFileSync(bridgeConfigPath, JSON.stringify({ projects: [
      { id: "alpha", name: "Alpha", repo: "owner/exact", archived: false },
    ] }));
    const exactOwnerA = captureProjectAdmission("alpha");
    const exactOwnerB = captureProjectAdmission("alpha");
    let releaseExact;
    const exactGate = new Promise((resolve) => { releaseExact = resolve; });
    let exactFetches = 0;
    const exactFetcher = async (_repo, isCurrent) => {
      exactFetches += 1;
      await exactGate;
      return isCurrent()
        ? { status: "ok", data: { issues: [], prs: [], closedIssues: [], mergedPrs: [] } }
        : { status: "cancelled", data: null };
    };
    const exactRefreshA = router.refreshRepoRest("owner/exact", [exactOwnerA], exactFetcher);
    const exactRefreshB = router.refreshRepoRest("owner/exact", [exactOwnerB], exactFetcher);
    assert.equal(router._restRefreshing.get("owner/exact").owners.size, 2,
      "same-project concurrent demand retains exact owner identity");
    const exactCleanup = await router.cancelProjectBackground("alpha");
    assert.equal(exactCleanup.resources.github_leases, 2, "cleanup reports both exact owner records");
    assert.equal((await router.cancelProjectBackground("alpha")).resources.github_leases, 0,
      "exact owner cleanup retry is idempotent");
    releaseExact();
    await Promise.all([exactRefreshA, exactRefreshB]);
    assert.equal(exactFetches, 1, "same-project demand coalesces one raw request");
    assert.equal(router._graphqlCache.has("owner/exact"), false,
      "ownerless exact request cannot publish after cleanup");

    // Archive during the first by-number issue request: no Search/timeline/PR/
    // reviews fan-out may start after that await completes.
    let itemCurrent = true;
    let releaseIssue;
    const issueGate = new Promise((resolve) => { releaseIssue = resolve; });
    const itemCalls = [];
    const itemProgress = router.progressForItemRest(
      "owner/repo",
      17,
      () => itemCurrent,
      {
        ghJsonExecAsync: async (args) => {
          itemCalls.push(args.join(" "));
          await issueGate;
          return { number: 17, title: "Issue", state: "open", html_url: "https://example.test/17" };
        },
        searchLinkedPrItems: async () => {
          itemCalls.push("search");
          return [];
        },
      },
    );
    itemCurrent = false;
    releaseIssue();
    await assert.rejects(itemProgress, (error) => error?.code === "project_admission_revoked");
    assert.equal(itemCalls.length, 1, "archive during issue await suppresses all later GitHub fan-out");

    // An archive→unarchive cycle invalidates the old admission generation. A
    // result assembled under that lease must not be republished for 60 seconds.
    const cacheConfigPath = path.join(TMP, ".quadwork", "config.json");
    fs.writeFileSync(cacheConfigPath, JSON.stringify({ projects: [{ id: "cache", archived: false }] }));
    const cacheLease = captureProjectAdmission("cache");
    revokeProjectAdmission("cache");
    fs.writeFileSync(cacheConfigPath, JSON.stringify({ projects: [{ id: "cache", archived: false }] }));
    assert.equal(
      router.shouldPublishProjectsCache([{ id: "cache", state: "active" }], new Map([["cache", cacheLease]])),
      false,
      "archive→unarchive rejects aggregate /api/projects publication from the old generation",
    );
    assert.equal(
      router.shouldPublishProjectsCache([{ id: "cache", state: "archived", _archived: true }], new Map()),
      false,
      "restore rejects an archived presentation assembled while the barrier was active",
    );

    // A and B share one repo. Revoking A while the raw request is in flight
    // must not cancel B's still-current ownership or suppress the shared cache.
    const configPath = path.join(TMP, ".quadwork", "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ projects: [
      { id: "alpha", name: "Alpha", repo: "owner/shared", archived: false },
      { id: "bravo", name: "Bravo", repo: "owner/shared", archived: false },
    ] }));
    const alphaLease = captureProjectAdmission("alpha");
    const bravoLease = captureProjectAdmission("bravo");
    let releaseShared;
    const sharedGate = new Promise((resolve) => { releaseShared = resolve; });
    let sharedFetches = 0;
    const sharedFetcher = async (_repo, isCurrent) => {
      sharedFetches += 1;
      await sharedGate;
      return isCurrent()
        ? { status: "ok", data: { issues: [], prs: [], closedIssues: [], mergedPrs: [] } }
        : { status: "cancelled", data: null };
    };
    const alphaRefresh = router.refreshRepoRest("owner/shared", [alphaLease], sharedFetcher);
    const bravoRefresh = router.refreshRepoRest("owner/shared", [bravoLease], sharedFetcher);
    revokeProjectAdmission("alpha");
    fs.writeFileSync(configPath, JSON.stringify({ projects: [
      { id: "alpha", name: "Alpha", repo: "owner/shared", archived: true },
      { id: "bravo", name: "Bravo", repo: "owner/shared", archived: false },
    ] }));
    releaseShared();
    await Promise.all([alphaRefresh, bravoRefresh]);
    assert.equal(sharedFetches, 1, "shared repo coalesces one raw request");
    assert.ok(router._graphqlCache.has("owner/shared"), "A revocation preserves B-owned shared cache publication");

    // With A as the only owner, the same revocation suppresses publication.
    fs.writeFileSync(configPath, JSON.stringify({ projects: [
      { id: "alpha", name: "Alpha", repo: "owner/only", archived: false },
    ] }));
    const onlyLease = captureProjectAdmission("alpha");
    let releaseOnly;
    const onlyGate = new Promise((resolve) => { releaseOnly = resolve; });
    const onlyRefresh = router.refreshRepoRest("owner/only", [onlyLease], async (_repo, isCurrent) => {
      await onlyGate;
      return isCurrent()
        ? { status: "ok", data: { issues: [{ number: 1 }], prs: [], closedIssues: [], mergedPrs: [] } }
        : { status: "cancelled", data: null };
    });
    revokeProjectAdmission("alpha");
    fs.writeFileSync(configPath, JSON.stringify({ projects: [
      { id: "alpha", name: "Alpha", repo: "owner/only", archived: true },
    ] }));
    releaseOnly();
    await onlyRefresh;
    assert.equal(router._graphqlCache.has("owner/only"), false, "only-owner revocation suppresses shared cache publication");

    console.log("routes.projectLifecycleBarrier.test.js: all assertions passed");
  } finally {
    server.close();
  }
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
