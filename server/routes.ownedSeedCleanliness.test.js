"use strict";

// Real supported HTTP activation/reseed and Git candidate/reuse. Only GitHub
// permission facts use the existing fixture; no worker, network, ignore rule,
// seed deletion, or seed commit makes the positive path pass.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const http = require("node:http");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-owned-seeds-")));
const originalHome = os.homedir;
const originalEnv = { ...process.env };
os.homedir = () => root;
Object.assign(process.env, { HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const configDir = path.join(root, ".quadwork");
fs.mkdirSync(configDir, { mode: 0o700 });
const configPath = path.join(configDir, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ port: 8400, operator_name: "fixture", projects: [] }), { mode: 0o600 });
const git = (cwd, ...args) => cp.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const restore = require("./__tests__/resource-executor-fixture").installResourceExecutorFixture({
  runControlChild: async (command, args, options) => {
    if (command === "gh") {
      assert.deepEqual(args.slice(0, 2), ["repo", "view"]);
      assert.ok(["acme/first", "acme/second"].includes(args[2]));
      return { stdout: JSON.stringify({ nameWithOwner: args[2], viewerPermission: "WRITE", defaultBranchRef: { name: "main" } }), stderr: "" };
    }
    assert.equal(command, "git");
    assert.equal(args[0], "-C");
    assert.ok(args[1].startsWith(root + path.sep));
    return new Promise((resolve, reject) => cp.execFile(command, args, options, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
  },
});
const routes = require("./routes");
const fileChat = require("./file-chat");
const { buildBatchManifest } = require("./work-task-manifest");
const { createManagedWorktreeObserver } = require("./work-task-managed-worktree");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const roles = ["head", "re1", "re2", "dev"];
function commit(cwd, message) {
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", message);
}
const repositories = ["first", "second"].map((key, index) => {
  const base = path.join(root, key);
  fs.mkdirSync(base); git(base, "init", "-b", "main");
  fs.writeFileSync(path.join(base, "README.md"), "# Local Git fixture\n");
  // Tracked instructions belong to the repository and must survive activation.
  fs.writeFileSync(path.join(base, "CLAUDE.md"), "# Repository-authored instructions\n");
  git(base, "add", "."); commit(base, "base");
  git(base, "remote", "add", "origin", `https://github.com/acme/${key}.git`);
  git(base, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(base, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { key, repo: `acme/${key}`, working_dir: base, primary: index === 0, ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["unit", "typecheck", "build"] } };
});
const request = { id: "fresh", name: "Fresh", confirm: true, repositories,
  agents: Object.fromEntries(roles.map((role) => [role, { cwd: `${repositories[0].working_dir}-${role}`, command: "codex", auto_approve: false }])) };
const express = require("express");
const app = express(); app.use(express.json()); app.set("readSessionLiveness", () => []); app.use(routes);
const server = app.listen(0, "127.0.0.1");
function post(url, value) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: url, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let data = ""; res.on("data", (s) => { data += s; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }); req.on("error", reject); req.end(body);
  });
}
const activate = () => post("/api/setup?step=activate-v2", request);
const reseed = () => post("/api/projects/fresh/reseed-agents", {}); // Real idle admission, no force.
function receipt(worktree, name = "AGENTS.md") {
  const admin = fs.readFileSync(path.join(worktree, ".git"), "utf8").trim().slice("gitdir: ".length);
  return path.join(admin, `quadwork-owned-seed-${name}.json`);
}
(async () => {
  try {
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
    const activated = await activate(); assert.equal(activated.status, 200, JSON.stringify(activated));
    assert.equal(activated.body.created.length, 8);
    const cfg = JSON.parse(fs.readFileSync(configPath)); const project = cfg.projects[0];
    const candidates = [];
    for (const repository of repositories) {
      for (const role of roles) {
        const cwd = `${repository.working_dir}-${role}`;
        assert.equal(git(cwd, "status", "--porcelain", "--untracked-files=all"), "?? AGENTS.md\n?? DESIGN-GUIDE.md");
        assert.equal(fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8"), "# Repository-authored instructions\n");
        assert.equal(fs.statSync(receipt(cwd)).mode & 0o777, 0o600);
      }
      const dev = `${repository.working_dir}-dev`, baseSha = git(dev, "rev-parse", "HEAD");
      fs.appendFileSync(path.join(dev, "README.md"), "\nCommitted candidate.\n"); git(dev, "add", "README.md"); commit(dev, "candidate");
      const candidateSha = git(dev, "rev-parse", "HEAD");
      const ref = buildBatchManifest({ version: 1, installation_id: cfg.installation_id, project_id: project.id, delivery_mode: "integrated", tasks: [{ task_key: "build", repository_key: repository.key, work_item: { repoKey: repository.key, repo: repository.repo, number: 42, kind: "issue" }, goal: "Inspect committed candidate", file_boundary: ["README.md"], validation: ["node:test"], dependencies: [] }] }, {
        resolveRegisteredIdentity(input) { return { ...input, issue_body_revision: "c".repeat(64) }; },
      }).tasks[0].ref;
      const observer = createManagedWorktreeObserver({ repositories: project.repositories, primary_agent_cwds: Object.fromEntries(Object.entries(project.agents).map(([role, agent]) => [role, agent.cwd])), repository_worktrees: project.repository_worktrees || {}, canonicalize_path: (req) => fs.realpathSync(req.path), run_git: (req) => {
        try { return { ok: true, output: git(req.cwd, ...req.args) }; } catch (error) { return { ok: false, output: String(error.stdout || "") }; }
      } });
      const input = { version: 1, work_task_ref: ref, base_sha: baseSha, candidate_sha: candidateSha, branch: "worktree-dev", worktree: { repository_key: repository.key, worktree_id: `wt_${repository.key}_dev`, path: dev } };
      const options = { canonicalizePath: observer.canonicalizePath, inspectManagedWorktree: observer.inspectManagedWorktree, readCanonicalInstalledState: (identity) => ({ ...identity, v1_state: "absent" }) };
      const check = () => buildWorkTaskCandidate(input, options);
      assert.equal(check().candidate_sha, candidateSha);
      candidates.push({ dev, check });
    }
    assert.equal((await activate()).status, 200, "repeat activation reuses generated-seed worktrees");
    assert.equal((await reseed()).status, 200, "normal idle reseed succeeds");
    const automatic = await routes.autoReseedOnStartup(cfg, { version: "1101-proof", statePath: path.join(configDir, "proof-reseed-state.json"), log: () => {} });
    assert.equal(automatic.decisions[0].action, "reseeded", "V2 automatic reseed uses the same owner");
    for (const candidate of candidates) candidate.check();
    const { dev, check } = candidates[0]; const seed = path.join(dev, "AGENTS.md");
    const clean = fs.readFileSync(seed);
    const dirty = async () => {
      assert.throws(check, (error) => error.code === "managed_worktree_unavailable");
      const retry = await activate(); assert.equal(retry.status, 409); assert.equal(retry.body.code, "reserved_worktree_dirty");
    };
    // Legacy generated bytes recover through the supported reseed owner. The
    // generated file remains present throughout; activation never self-adopts.
    fs.unlinkSync(receipt(dev));
    await dirty(); assert.equal((await reseed()).status, 200);
    assert.deepEqual(fs.readFileSync(seed), clean); check();

    fs.writeFileSync(path.join(dev, "operator.txt"), "untracked user file\n");
    await dirty(); fs.unlinkSync(path.join(dev, "operator.txt")); check();

    fs.appendFileSync(seed, "\nOperator edit\n"); const modified = fs.readFileSync(seed);
    await dirty(); assert.equal((await reseed()).status, 500);
    assert.deepEqual(fs.readFileSync(seed), modified, "modified owned seed is preserved");
    fs.writeFileSync(seed, clean); check();

    // Replacement with even identical bytes has a different file identity.
    const saved = path.join(root, "saved-seed"); fs.renameSync(seed, saved); fs.writeFileSync(seed, clean);
    await dirty(); assert.equal((await reseed()).status, 500);
    fs.unlinkSync(seed); fs.renameSync(saved, seed); check();

    fs.renameSync(seed, saved); const foreign = path.join(root, "foreign.md"); fs.writeFileSync(foreign, "foreign target\n"); fs.symlinkSync(foreign, seed);
    await dirty(); assert.equal((await reseed()).status, 500);
    assert.equal(fs.readFileSync(foreign, "utf8"), "foreign target\n");
    fs.unlinkSync(seed); fs.renameSync(saved, seed); check();

    const receiptFile = receipt(dev); const savedReceipt = fs.readFileSync(receiptFile);
    const wrong = JSON.parse(savedReceipt); wrong.binding.worktree = candidates[1].dev;
    fs.writeFileSync(receiptFile, JSON.stringify(wrong)); await dirty(); assert.equal((await reseed()).status, 500);
    fs.writeFileSync(receiptFile, savedReceipt); check();

    const savedReceiptPath = path.join(root, "receipt-backup"); fs.renameSync(receiptFile, savedReceiptPath); fs.symlinkSync(savedReceiptPath, receiptFile);
    await dirty(); assert.equal((await reseed()).status, 500);
    assert.deepEqual(fs.readFileSync(savedReceiptPath), savedReceipt);
    fs.unlinkSync(receiptFile); fs.renameSync(savedReceiptPath, receiptFile); check();

    fs.unlinkSync(receiptFile); fs.writeFileSync(seed, "# Foreign untracked instructions\n");
    await dirty(); assert.equal((await reseed()).status, 500);
    assert.equal(fs.readFileSync(seed, "utf8"), "# Foreign untracked instructions\n");
    fs.writeFileSync(seed, clean); assert.equal((await reseed()).status, 200); check();

    // Tracked generated-looking content is never hidden or overwritten.
    git(dev, "add", "AGENTS.md"); commit(dev, "repository adopts instructions");
    fs.appendFileSync(seed, "\nRepository operator edit\n"); const tracked = fs.readFileSync(seed);
    await dirty(); assert.equal((await reseed()).status, 200);
    assert.deepEqual(fs.readFileSync(seed), tracked);
    assert.match(git(dev, "status", "--porcelain"), /M AGENTS\.md/);
    console.log("routes.ownedSeedCleanliness.test.js: PASS (two real repositories, eight worktrees, activation/candidates/reuse/idle reseed/recovery; tracked, foreign, modified, replaced, symlink, wrong-path, unrelated-file guards)");
  } finally {
    fileChat.removeProject?.("fresh"); fileChat.stopWatching?.();
    await new Promise((resolve) => server.close(resolve)); restore(); os.homedir = originalHome;
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, key)) delete process.env[key];
    Object.assign(process.env, originalEnv); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
