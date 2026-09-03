"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ROLE_IDS,
  configuredRepositoryOwnership,
  provisionRepositoryWorktrees,
  renderProjectRepositoryMap,
  writeProjectRepositoryMap,
} = require("./repository-provisioning");

const policy = { version: 1, mode: "ci-less", evidence_keys: ["operator"] };

function repositories() {
  return [
    { key: "web", repo: "Acme/Web", working_dir: "/workspace/web", primary: true, ci_policy: policy },
    { key: "api", repo: "Acme/Api", working_dir: "/workspace/api", primary: false, ci_policy: policy },
  ];
}

function fakeFs(existing) {
  const present = new Set([...existing].map((value) => path.normalize(value)));
  return {
    existsSync(value) { return present.has(path.normalize(value)); },
  };
}

function successfulRunner(calls, options = {}) {
  return async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const joined = args.join(" ");
    const base = args[1];
    const repo = base.endsWith("/web") || base.endsWith("/web-head") || base.endsWith("/web-re1") || base.endsWith("/web-re2") || base.endsWith("/web-dev")
      ? "acme/web"
      : "acme/api";
    const isWorktree = /\/(?:web|api)-(?:head|re1|re2|dev)$/.test(base || "");
    if (cmd === "gh" && joined.startsWith("repo clone ")) return { ok: true, output: "" };
    if (cmd !== "git") return { ok: false, output: "unexpected command" };
    if (joined.endsWith("rev-parse --show-toplevel")) {
      return { ok: true, output: options.topLevelMismatchPath === base ? "/unexpected/worktree" : base };
    }
    if (joined.endsWith("remote get-url origin")) {
      const remote = options.remoteMismatchPath === base ? "other/repository" : repo;
      return { ok: true, output: `https://github.com/${remote}.git` };
    }
    if (joined.endsWith("rev-parse --verify HEAD")) return { ok: true, output: "a".repeat(40) };
    if (joined.endsWith("symbolic-ref --quiet --short refs/remotes/origin/HEAD")) {
      return options.originHeadUnavailable ? { ok: false, output: "" } : { ok: true, output: "origin/main" };
    }
    if (joined.includes("show-ref --verify --quiet refs/heads/worktree-")) return { ok: false, output: "" };
    if (isWorktree && joined.endsWith("rev-parse --git-common-dir")) {
      return { ok: true, output: path.join("..", path.basename(base).replace(/-(head|re1|re2|dev)$/, ""), ".git") };
    }
    if (isWorktree && joined.endsWith("branch --show-current")) return { ok: true, output: `worktree-${base.match(/-(head|re1|re2|dev)$/)[1]}` };
    if (isWorktree && joined.endsWith("status --porcelain --untracked-files=all")) {
      return { ok: true, output: options.dirtyPath === base ? " M user-file" : "" };
    }
    if (joined.includes(" worktree add -b worktree-")) return { ok: true, output: "" };
    return { ok: false, output: `unexpected git call: ${joined}` };
  };
}

(async () => {
  const basePaths = [
    "/workspace/web", "/workspace/web/.git",
    "/workspace/api", "/workspace/api/.git",
  ];

  let calls = [];
  let result = await provisionRepositoryWorktrees({
    projectId: "alpha",
    repositories: repositories(),
    config: { projects: [] },
    runner: successfulRunner(calls),
    fsImpl: fakeFs(basePaths),
  });
  assert.equal(result.ok, true);
  assert.equal(result.created.filter((entry) => entry.role).length, 8, "two repositories get four role worktrees each");
  assert.deepEqual(result.created.filter((entry) => entry.role).map((entry) => entry.role).sort(), [...ROLE_IDS, ...ROLE_IDS].sort());
  assert.ok(calls.every((entry) => entry.cmd !== "sh" && entry.cmd !== "bash"), "all process calls remain direct argument-array invocations");
  assert.ok(!calls.some((entry) => entry.args.includes("prune") || entry.args.includes("--detach")), "V2 provisioner never prunes or detached-falls-back");
  console.log("  PASS: a two-repository plan creates exactly eight role worktrees without destructive fallback");

  const dirty = "/workspace/api-dev";
  calls = [];
  result = await provisionRepositoryWorktrees({
    projectId: "alpha",
    repositories: repositories(),
    config: { projects: [] },
    runner: successfulRunner(calls, { dirtyPath: dirty }),
    fsImpl: fakeFs([...basePaths, dirty]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "reserved_worktree_dirty");
  assert.equal(result.role, "dev");
  assert.ok(!calls.some((entry) => entry.args.includes("worktree") && entry.args.includes("add")), "dirty reserved path blocks before a new worktree is made");
  console.log("  PASS: a dirty reserved worktree is diagnosed and left untouched");

  calls = [];
  result = await provisionRepositoryWorktrees({
    projectId: "alpha",
    repositories: repositories(),
    config: { projects: [] },
    runner: successfulRunner(calls, { remoteMismatchPath: "/workspace/api" }),
    fsImpl: fakeFs(basePaths),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "base_remote_mismatch");
  assert.equal(result.repo_key, "api");
  assert.ok(!calls.some((entry) => entry.args.includes("worktree") && entry.args.includes("add")), "remote mismatch blocks before a new worktree is made");
  console.log("  PASS: a mismatched base remote is rejected without creating a worktree");

  calls = [];
  result = await provisionRepositoryWorktrees({
    projectId: "alpha",
    repositories: repositories(),
    config: { projects: [] },
    runner: successfulRunner(calls, { originHeadUnavailable: true }),
    fsImpl: fakeFs(basePaths),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "default_branch_unavailable");
  assert.equal(result.repo_key, "web");
  assert.ok(!calls.some((entry) => entry.args.includes("worktree") && entry.args.includes("add")), "unverified origin/HEAD blocks before a new worktree is made");
  console.log("  PASS: an unverified origin default branch cannot be recorded from the checkout branch");

  const mismatchedPath = "/workspace/web-head";
  calls = [];
  result = await provisionRepositoryWorktrees({
    projectId: "alpha",
    repositories: repositories(),
    config: { projects: [] },
    runner: successfulRunner(calls, { topLevelMismatchPath: mismatchedPath }),
    fsImpl: fakeFs([...basePaths, mismatchedPath]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "reserved_worktree_mismatch");
  assert.equal(result.role, "head");
  assert.ok(!calls.some((entry) => entry.args.includes("worktree") && entry.args.includes("add")), "mismatched reserved path blocks before any worktree creation");
  console.log("  PASS: a mismatched reserved worktree is left untouched");

  const ownership = configuredRepositoryOwnership({
    projects: [{ id: "other", repo: "Acme/Web", working_dir: "/somewhere", archived: false }],
  }, "alpha", repositories());
  assert.deepEqual(ownership, {
    ok: false,
    code: "repository_owned_by_active_project",
    project_id: "other",
    state: "active_repository_owner",
    repo_key: "web",
  });
  console.log("  PASS: active-project ownership blocks before provisioning");

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-1032-map-"));
  try {
    const map = renderProjectRepositoryMap({
      projectId: "alpha",
      repositories: repositories().map((repository) => ({
        ...repository,
        default_branch: "main",
        worktrees: Object.fromEntries(ROLE_IDS.map((role) => [role, `/custom/${repository.key}-${role}`])),
      })),
    });
    assert.match(map, /head: \/custom\/web-head/);
    assert.match(map, /dev: \/custom\/api-dev/);
    assert.match(map, /Each role must use only its own role row/);
    assert.ok(!map.includes("operator"), "CI evidence values are not rendered into the map");
    const mapPath = writeProjectRepositoryMap({ configDir: temporary, projectId: "alpha", content: map });
    assert.equal(fs.readFileSync(mapPath, "utf8"), map);
    assert.equal(fs.statSync(mapPath).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.dirname(mapPath)).filter((name) => name.includes(".tmp")).length, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("  PASS: repository map is atomic-mode-safe and redacts policy data");

  console.log("\n7 passed, 0 failed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
