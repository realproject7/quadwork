"use strict";

// #1032 end-to-end route proof with real config/map writes and fake direct
// execFile results. No shell is invoked; git/gh command arrays are asserted by
// the provisioner tests separately.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const util = require("util");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-v2-setup-"));
const originalHomedir = os.homedir;
const originalExecFile = childProcess.execFile;
os.homedir = () => TEST_HOME;

const CONFIG_DIR = path.join(TEST_HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

let dirtyPath = null;
let githubMode = "ok";
let provisionHook = null;
const activeSessions = new Map();
let commandCalls = [];
function fakeExecFile(cmd, args, options, callback) {
  const done = typeof options === "function" ? options : callback;
  commandCalls.push({ cmd, args: [...args] });
  const base = args[1];
  const roleMatch = typeof base === "string" && base.match(/-(head|re1|re2|dev)$/);
  const repository = typeof base === "string" && (base.includes("target-api") || base.endsWith("/api")) ? "acme/api" : "acme/target";
  let stdout = "";
  if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
    const requested = String(args[2] || "").toLowerCase();
    stdout = JSON.stringify({
      nameWithOwner: githubMode === "identity-mismatch" ? "other/mismatch" : requested,
      viewerPermission: githubMode === "readonly" ? "READ" : "WRITE",
      defaultBranchRef: { name: "main" },
    });
  } else if (cmd === "git" && args.slice(2).join(" ") === "rev-parse --show-toplevel") stdout = base;
  else if (cmd === "git" && args.slice(2).join(" ") === "remote get-url origin") stdout = `https://github.com/${repository}.git`;
  else if (cmd === "git" && args.slice(2).join(" ") === "rev-parse --verify HEAD") stdout = "a".repeat(40);
  else if (cmd === "git" && args.slice(2).join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") stdout = "origin/main";
  else if (cmd === "git" && args.slice(2).join(" ") === "rev-parse --git-common-dir") {
    const baseName = repository === "acme/api" ? "target-api" : "target";
    stdout = path.join("..", baseName, ".git");
  } else if (cmd === "git" && args.slice(2).join(" ") === "branch --show-current") stdout = `worktree-${roleMatch?.[1] || "head"}`;
  else if (cmd === "git" && args.slice(2).join(" ") === "status --porcelain --untracked-files=all") stdout = base === dirtyPath ? " M operator-file" : "";
  else {
    return process.nextTick(() => done(new Error(`unexpected command: ${cmd} ${args.join(" ")}`), "", "unexpected command"));
  }
  if (cmd === "git" && provisionHook) {
    const hook = provisionHook;
    provisionHook = null;
    hook();
  }
  process.nextTick(() => done(null, stdout, ""));
}
fakeExecFile[util.promisify.custom] = (cmd, args, options) => new Promise((resolve, reject) => {
  fakeExecFile(cmd, args, options, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});
childProcess.execFile = fakeExecFile;

const routes = require("./routes");

function readBytes() { return fs.readFileSync(CONFIG_PATH, "utf8"); }
function writeConfig(value) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2), { mode: 0o600 }); }
function writeQueue(projectId, content = "# Queue\n\n## Active Batch\n\n") {
  const directory = path.join(CONFIG_DIR, projectId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "OVERNIGHT-QUEUE.md"), content);
}

function makeWorktrees(root) {
  const base = path.join(root, "target");
  const api = path.join(root, "target-api");
  for (const directory of [base, api]) fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
  const agents = {};
  for (const role of ["head", "re1", "re2", "dev"]) {
    const primary = path.join(root, `custom-target-${role}`);
    const secondary = path.join(root, `target-api-${role}`);
    fs.mkdirSync(primary, { recursive: true });
    fs.mkdirSync(secondary, { recursive: true });
    agents[role] = { cwd: primary, command: "codex", auto_approve: true };
  }
  return { base, api, agents };
}

function repositories(paths) {
  return [
    { key: "primary", repo: "Acme/Target", working_dir: paths.base, primary: true, ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["operator"] } },
    { key: "api", repo: "Acme/Api", working_dir: paths.api, primary: false, ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["operator"] } },
  ];
}

function legacyProject(id, paths) {
  return { id, name: id, repo: "Acme/Target", working_dir: paths.base, agents: paths.agents, chat_mode: "file" };
}

function post(server, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method: "POST",
      path: urlPath,
      headers: { "content-type": "application/json", "content-length": payload.length },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function assertNoRoleWorktreeCreation(label) {
  assert.ok(!commandCalls.some((call) => call.cmd === "git" && call.args.includes("worktree") && call.args.includes("add")), label);
}

(async () => {
  const app = express();
  app.use(express.json());
  app.set("activeSessions", activeSessions);
  app.use(routes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-v2-worktrees-"));
  const paths = makeWorktrees(root);
  const requestBody = { id: "target", repositories: repositories(paths), confirm: true };
  try {
    // A dirty reserved path must fail before commit and retain byte-identical
    // V1 config, including the absence of installation_id.
    writeConfig({ projects: [legacyProject("target", paths)] });
    writeQueue("target");
    dirtyPath = paths.agents.dev.cwd;
    commandCalls = [];
    let before = readBytes();
    let response = await post(server, "/api/setup?step=activate-v2", requestBody);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "reserved_worktree_dirty");
    assert.equal(readBytes(), before, "pre-final provisioning failure leaves V1 config byte-identical");
    assert.equal(JSON.parse(readBytes()).installation_id, undefined);
    console.log("  PASS: failed provisioning leaves config unchanged before final activation commit");

    // Final activation does not trust a prior verify request: read-only GitHub
    // access blocks before a worktree command or config mutation.
    dirtyPath = null;
    githubMode = "readonly";
    writeConfig({ projects: [legacyProject("target", paths)] });
    writeQueue("target");
    before = readBytes();
    commandCalls = [];
    response = await post(server, "/api/setup?step=activate-v2", requestBody);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { ok: false, code: "repository_push_access_required", repo_key: "primary" });
    assert.equal(readBytes(), before);
    assertNoRoleWorktreeCreation("read-only activation cannot create a role worktree");
    assert.equal(commandCalls.filter((call) => call.cmd === "git").length, 0, "read-only activation never reaches git provisioning");
    console.log("  PASS: direct activation independently rejects read-only repository access");

    // Provisioning also has its own canonical GitHub identity gate; it cannot
    // rely on the Setup UI having called verify-repositories first.
    githubMode = "identity-mismatch";
    before = readBytes();
    commandCalls = [];
    response = await post(server, "/api/setup?step=provision-repositories", { id: "target", repositories: repositories(paths) });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { ok: false, code: "repository_identity_mismatch", repo_key: "primary" });
    assert.equal(readBytes(), before);
    assertNoRoleWorktreeCreation("identity-mismatched provision cannot create a role worktree");
    assert.equal(commandCalls.filter((call) => call.cmd === "git").length, 0, "identity mismatch never reaches git provisioning");
    console.log("  PASS: direct provisioning independently rejects canonical identity mismatch");

    githubMode = "ok";
    commandCalls = [];
    response = await post(server, "/api/setup?step=provision-repositories", { id: "../target", repositories: repositories(paths) });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { ok: false, code: "invalid_project_id" });
    assert.equal(commandCalls.length, 0, "invalid project id never reaches a command or provisioner");
    response = await post(server, "/api/setup?step=verify-repositories", { id: "../target", repositories: repositories(paths) });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { ok: false, code: "invalid_project_id" });
    assert.equal(commandCalls.length, 0, "invalid verify id never reaches repository access");
    console.log("  PASS: invalid project ids fail before provisioning");

    // Existing projects are topology-frozen while any injected live role
    // session exists, for both dry provisioning and final activation.
    activeSessions.set("target/dev", { projectId: "target", agentId: "dev", state: "running" });
    before = readBytes();
    commandCalls = [];
    response = await post(server, "/api/setup?step=provision-repositories", { id: "target", repositories: repositories(paths) });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { ok: false, code: "active_session", role: "dev" });
    assert.equal(readBytes(), before);
    assert.equal(commandCalls.length, 0, "live session provision block precedes external verification");
    response = await post(server, "/api/setup?step=activate-v2", requestBody);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { ok: false, code: "active_session", role: "dev" });
    assert.equal(readBytes(), before);
    assert.equal(commandCalls.length, 0, "live session activation block precedes external verification");
    activeSessions.clear();
    console.log("  PASS: live target sessions block both provisioning and activation before side effects");

    // Any other legacy project's executable queue blocks the one global first
    // migration before provision or config write.
    dirtyPath = null;
    writeConfig({
      projects: [
        legacyProject("target", paths),
        { id: "other", repo: "Acme/Other", working_dir: path.join(root, "other") },
      ],
    });
    writeQueue("target");
    writeQueue("other", "# Queue\n\n## Active Batch\n\n**Batch:** 2\n\n- #42 active legacy work\n");
    before = readBytes();
    response = await post(server, "/api/setup?step=activate-v2", requestBody);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      ok: false,
      code: "first_activation_legacy_project_blocked",
      project_id: "other",
      state: "legacy_unowned_executable",
    });
    assert.equal(readBytes(), before, "cross-project first-activation block cannot mutate config");
    console.log("  PASS: global first activation returns only typed project/state evidence and requires quiesce/retry");

    // A role that starts while the already-checked worktrees are being
    // revalidated is caught again by the captured live-session observer inside
    // the serialized final config transaction.
    writeConfig({ projects: [legacyProject("target", paths)] });
    writeQueue("target");
    before = readBytes();
    provisionHook = () => activeSessions.set("target/re1", { projectId: "target", agentId: "re1", state: "running" });
    commandCalls = [];
    response = await post(server, "/api/setup?step=activate-v2", requestBody);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "active_session");
    assert.equal(response.body.role, "re1");
    assert.equal(readBytes(), before, "commit-time session recheck prevents configuration activation");
    activeSessions.clear();
    console.log("  PASS: commit-time live-session recheck rejects a topology race");

    // A concurrent registration can claim the same canonical repository after
    // the pre-provision check. The final config transaction rechecks ownership
    // and keeps its own activation out of the changed document.
    writeConfig({ projects: [legacyProject("target", paths)] });
    writeQueue("target");
    provisionHook = () => writeConfig({
      projects: [
        legacyProject("target", paths),
        {
          id: "other",
          name: "Other",
          agents: {},
          repositories: [{
            key: "primary",
            repo: "Acme/Target",
            working_dir: path.join(root, "other"),
            primary: true,
            ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["operator"] },
          }],
        },
      ],
    });
    commandCalls = [];
    response = await post(server, "/api/setup?step=activate-v2", requestBody);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "repository_owned_by_active_project");
    assert.equal(response.body.project_id, "other");
    const racedConfig = JSON.parse(readBytes());
    assert.equal(racedConfig.installation_id, undefined, "ownership race cannot activate the config");
    assert.equal(Object.hasOwn(racedConfig.projects.find((project) => project.id === "target"), "repo"), true,
      "ownership race leaves the target in its legacy source shape");
    console.log("  PASS: commit-time repository ownership recheck rejects a registration race");

    // Clear the other project from config, then prove the actual final commit
    // persists arrays only and emits an atomic map without starting sessions.
    writeConfig({ projects: [legacyProject("target", paths)] });
    writeQueue("target");
    commandCalls = [];
    response = await post(server, "/api/setup?step=activate-v2", requestBody);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    assert.equal(response.body.created.length, 0, "all clean reserved worktrees were reused");
    assert.equal(response.body.reused.length, 8);
    const disk = JSON.parse(readBytes());
    assert.equal(typeof disk.installation_id, "string");
    assert.ok(disk.installation_id.length >= 16);
    assert.equal(Object.hasOwn(disk.projects[0], "repo"), false);
    assert.equal(Object.hasOwn(disk.projects[0], "working_dir"), false);
    assert.deepEqual(disk.projects[0].repositories.map((entry) => entry.key), ["primary", "api"]);
    assert.equal(disk.projects[0].agents.dev.cwd, paths.agents.dev.cwd, "legacy primary cwd survives activation");
    const mapPath = path.join(CONFIG_DIR, "target", "PROJECT-REPOS.md");
    assert.equal(fs.statSync(mapPath).mode & 0o777, 0o600);
    const map = fs.readFileSync(mapPath, "utf8");
    assert.ok(map.includes(paths.agents.dev.cwd), "map retains the verified legacy primary role path");
    assert.match(map, /api-dev/);
    assert.ok(!map.includes("operator"), "map contains no policy evidence keys");
    console.log("  PASS: final activation commits canonical arrays and an atomic redacted map without session start/restart");
  } finally {
    server.close();
    childProcess.execFile = originalExecFile;
    os.homedir = originalHomedir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  }
  console.log("\n10 passed, 0 failed\n");
})().catch((error) => {
  childProcess.execFile = originalExecFile;
  os.homedir = originalHomedir;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exitCode = 1;
});
