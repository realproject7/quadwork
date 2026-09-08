"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { promisify } = require("node:util");
const execFile = promisify(cp.execFile);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-activation-")));
const originalHome = os.homedir;
os.homedir = () => root;
const configDir = path.join(root, ".quadwork");
fs.mkdirSync(configDir, { mode: 0o700 });
const configPath = path.join(configDir, "config.json");
const originalConfig = { port: 8400, operator_name: "fixture", projects: [] };
fs.writeFileSync(configPath, JSON.stringify(originalConfig), { mode: 0o600 });
const gitEnv = { HOME: root, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const calls = [];
// Existing resource-executor seam: real disposable Git, fixed by-name GitHub
// reads. This checks activation/file-chat semantics, not Linux containment.
const restoreExecutor = require("./__tests__/resource-executor-fixture").installResourceExecutorFixture({
  runControlChild: async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === "gh") {
      assert.deepEqual(args.slice(0, 2), ["repo", "view"]);
      assert.match(args[2], /^acme\/(fresh|chat-failure|seed-failure|queue-failure)$/);
      return { stdout: JSON.stringify({ nameWithOwner: args[2], viewerPermission: "WRITE", defaultBranchRef: { name: "main" } }), stderr: "" };
    }
    assert.equal(command, "git");
    assert.equal(args[0], "-C");
    assert.ok(args[1].startsWith(root + path.sep), "Git stays inside disposable repository paths");
    assert.ok(["rev-parse", "remote", "symbolic-ref", "show-ref", "branch", "status", "worktree"].includes(args[2]));
    return execFile(command, args, { ...options, env: gitEnv });
  },
});
const routes = require("./routes");
const fileChat = require("./file-chat");
const createdProjects = [];
function git(base, ...args) {
  return cp.execFileSync("git", ["-C", base, ...args], { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function project(id) {
  createdProjects.push(id);
  const base = path.join(root, id); fs.mkdirSync(base);
  git(base, "init", "-b", "main");
  // Managed role docs are ignored in this fixture so subsequent activation
  // meets the unchanged clean-worktree precondition. No dirty-tree bypass.
  fs.writeFileSync(path.join(base, ".gitignore"), "/AGENTS.md\n/CLAUDE.md\n/DESIGN-GUIDE.md\n");
  fs.writeFileSync(path.join(base, "README.md"), "# Fixture\n");
  git(base, "add", ".");
  git(base, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
  git(base, "remote", "add", "origin", `https://github.com/acme/${id}.git`);
  git(base, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(base, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return {
    id, name: `Fixture ${id}`, confirm: true,
    repositories: [{ key: "primary", repo: `acme/${id}`, working_dir: base, primary: true, ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["unit", "typecheck", "build"] } }],
    agents: Object.fromEntries(["head", "re1", "re2", "dev"].map((role) => [role, { cwd: `${base}-${role}`, command: "codex", auto_approve: false }])),
  };
}
function request(server, url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: url, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      let data = ""; res.setEncoding("utf8"); res.on("data", (part) => { data += part; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end(payload);
  });
}
function worktreeAdds() { return calls.filter((call) => call[0] === "git" && call[3] === "worktree" && call[4] === "add").length; }

(async () => {
  const app = express(); app.use(express.json());
  const sessions = new Map(); app.set("activeSessions", sessions);
  let dispatched = 0;
  routes.setPtyDispatchCallback(() => { dispatched++; });
  app.use(routes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  async function activate(candidate) {
    const beforeDispatch = dispatched;
    const response = await request(server, "/api/setup?step=activate-v2", candidate);
    assert.equal(dispatched, beforeDispatch, "activation does not dispatch a worker");
    return response;
  }
  try {
    const fresh = project("fresh");
    assert.equal(fileChat.isProjectInitialized(fresh.id), false);
    // Existing getNextId is a read/recovery helper and is not ownership proof.
    assert.equal(fileChat.getNextId(fresh.id), 1);
    assert.equal(fileChat.isProjectInitialized(fresh.id), false);
    let response = await activate(fresh);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    assert.equal(response.body.activation_committed, true);
    assert.equal(response.body.created.filter((entry) => entry.role).length, 4);
    assert.equal(worktreeAdds(), 4);
    assert.equal(fileChat.isProjectInitialized(fresh.id), true);
    assert.equal(dispatched, 0, "activation starts and dispatches no worker");
    const dir = path.join(configDir, fresh.id);
    for (const name of ["OVERNIGHT-QUEUE.md", "GITHUB.md"]) assert.ok(fs.readFileSync(path.join(dir, name), "utf8").includes("Fixture fresh"));
    response = await request(server, "/api/chat?project=fresh", { text: "First message without restart" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.message.id, 1);
    const chatFile = path.join(dir, "chat", "general.jsonl");
    const history = fs.readFileSync(chatFile, "utf8");
    const queue = "# Operator queue\n\n## Active Batch\n\n## Notes\nKeep this edit.\n";
    const github = "# Operator GitHub notes\nKeep this file.\n";
    fs.writeFileSync(path.join(dir, "OVERNIGHT-QUEUE.md"), queue);
    fs.writeFileSync(path.join(dir, "GITHUB.md"), github);
    const nextId = fileChat.getNextId(fresh.id), beforeAdds = worktreeAdds();
    response = await activate(fresh);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(worktreeAdds(), beforeAdds);
    assert.equal(response.body.reused.length, 4);
    assert.equal(fs.readFileSync(path.join(dir, "OVERNIGHT-QUEUE.md"), "utf8"), queue);
    assert.equal(fs.readFileSync(path.join(dir, "GITHUB.md"), "utf8"), github);
    assert.equal(fs.readFileSync(chatFile, "utf8"), history);
    assert.equal(fileChat.getNextId(fresh.id), nextId);
    response = await request(server, "/api/chat?project=fresh", { text: "Second message after activation retry" });
    assert.equal(response.body.message.id, 2);

    const chatFailure = project("chat-failure");
    const chatDir = path.join(configDir, chatFailure.id, "chat"); fs.mkdirSync(chatDir, { recursive: true, mode: 0o700 });
    const saved = JSON.stringify({ id: 7, seq: 7, sender: "user", text: "Existing history", ts: new Date().toISOString(), mentions: [] }) + "\n";
    const savedFile = path.join(chatDir, "general.jsonl"); fs.writeFileSync(savedFile, saved, { mode: 0o600 });
    const read = fs.readFileSync;
    fs.readFileSync = function (target, ...args) {
      if (target === savedFile) { const error = new Error("fixture read failed"); error.code = "EIO"; throw error; }
      return read.call(this, target, ...args);
    };
    try { response = await activate(chatFailure); }
    finally { fs.readFileSync = read; }
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "project_runtime_initialization_failed");
    assert.equal(response.body.initialization_step, "file_chat");
    assert.equal(response.body.activation_committed, true);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).projects.some((entry) => entry.id === chatFailure.id), true);
    assert.equal(fileChat.isProjectInitialized(chatFailure.id), false);
    assert.equal(fs.existsSync(path.join(chatDir, ".writer.pid")), false, "failed recovery releases only its acquired writer lock");
    const afterFailureAdds = worktreeAdds();
    response = await activate(chatFailure);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(worktreeAdds(), afterFailureAdds);
    assert.equal(fs.readFileSync(savedFile, "utf8"), saved);
    response = await request(server, "/api/chat?project=chat-failure", { text: "Recovered after failed initialization" });
    assert.equal(response.body.message.id, 8);

    const seedFailure = project("seed-failure");
    const seedDir = path.join(configDir, seedFailure.id); fs.mkdirSync(seedDir, { recursive: true, mode: 0o700 });
    // The safe seed helper silently skips an existing path, even a directory.
    fs.mkdirSync(path.join(seedDir, "GITHUB.md"));
    const beforeSeedConfig = fs.readFileSync(configPath, "utf8");
    response = await activate(seedFailure);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "project_runtime_initialization_failed");
    assert.equal(response.body.initialization_step, "github");
    assert.equal(response.body.activation_committed, false);
    assert.equal(response.body.created.filter((entry) => entry.role).length, 4, "failure reports retained provisioned worktrees");
    assert.equal(fs.readFileSync(configPath, "utf8"), beforeSeedConfig);
    assert.equal(fileChat.isProjectInitialized(seedFailure.id), false);
    const seedAdds = worktreeAdds();
    fs.rmdirSync(path.join(seedDir, "GITHUB.md"));
    const foreignTarget = path.join(root, "untouched-github.md");
    fs.symlinkSync(foreignTarget, path.join(seedDir, "GITHUB.md"));
    response = await activate(seedFailure);
    assert.equal(response.status, 409);
    assert.equal(response.body.initialization_step, "github");
    assert.equal(response.body.activation_committed, false);
    assert.equal(fs.readFileSync(configPath, "utf8"), beforeSeedConfig);
    assert.equal(worktreeAdds(), seedAdds);
    assert.equal(fs.existsSync(foreignTarget), false, "create-only seed never follows a dangling link");
    fs.unlinkSync(path.join(seedDir, "GITHUB.md"));
    const editedQueue = "# Preserved after partial setup\n\n## Active Batch\n\n";
    fs.writeFileSync(path.join(seedDir, "OVERNIGHT-QUEUE.md"), editedQueue);
    response = await activate(seedFailure);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(worktreeAdds(), seedAdds);
    assert.equal(fs.readFileSync(path.join(seedDir, "OVERNIGHT-QUEUE.md"), "utf8"), editedQueue);
    assert.ok(fs.statSync(path.join(seedDir, "GITHUB.md")).isFile());

    const queueFailure = project("queue-failure");
    const queueFile = path.join(configDir, queueFailure.id, "OVERNIGHT-QUEUE.md");
    const beforeQueueConfig = fs.readFileSync(configPath, "utf8");
    const write = fs.writeFileSync;
    fs.writeFileSync = function (target, ...args) {
      if (target === queueFile) { const error = new Error("fixture queue write failed"); error.code = "EIO"; throw error; }
      return write.call(this, target, ...args);
    };
    try { response = await activate(queueFailure); }
    finally { fs.writeFileSync = write; }
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "project_runtime_initialization_failed");
    assert.equal(response.body.initialization_step, "queue");
    assert.equal(response.body.activation_committed, false);
    assert.equal(response.body.created.filter((entry) => entry.role).length, 4);
    assert.equal(fs.readFileSync(configPath, "utf8"), beforeQueueConfig);
    assert.equal(fileChat.isProjectInitialized(queueFailure.id), false);
    assert.equal(fs.existsSync(queueFile), false, "swallowed seed-write failure cannot report successful activation");
    const queueFailureAdds = worktreeAdds();
    response = await activate(queueFailure);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(worktreeAdds(), queueFailureAdds);
    assert.equal(response.body.reused.length, 4);
    assert.ok(fs.statSync(queueFile).isFile());
    assert.equal(fileChat.isProjectInitialized(queueFailure.id), true);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).operator_name, originalConfig.operator_name);
    assert.equal(sessions.size, 0);
    console.log("routes.v2ActivationRuntime.test.js: real Git/Express/file-chat fresh activation, first chat, preservation and pre/post-commit failure/retry passed");
  } finally {
    routes.setPtyDispatchCallback(null);
    for (const id of createdProjects) fileChat.shutdownProject(id);
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  restoreExecutor(); os.homedir = originalHome; fs.rmSync(root, { recursive: true, force: true });
});
