// #1034: the separate CLI process must converge on the same durable archived
// barrier and canonical V2 commit boundary as the running server.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-bin-v2-"));
const CONFIG_DIR = path.join(TEST_HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const originalHome = os.homedir;
os.homedir = () => TEST_HOME;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const {
  cleanupLegacyAgentChattrAfterConfirmation,
  cleanupLegacyProjectAfterConfirmation,
  writeConfig,
  writeQuadWorkConfig,
} = require("../bin/quadwork");

const installationId = "installation_cli_v2_123456";
const setup = (projectName, repo, workingDir) => ({
  projectName,
  repo,
  absDir: workingDir,
  backend: "codex",
  backends: {},
  worktrees: Object.fromEntries(
    ["head", "re1", "re2", "dev"].map((agent) => [agent, `${workingDir}-${agent}`]),
  ),
});

const existingDir = path.join(TEST_HOME, "existing");
const replacementDir = path.join(TEST_HOME, "replacement");
const newDir = path.join(TEST_HOME, "new-project");
for (const dir of [existingDir, replacementDir, newDir]) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  installation_id: installationId,
  projects: [{
    id: "archived",
    name: "Archived",
    archived: true,
    repositories: [{ key: "primary", repo: "Acme/Existing", working_dir: existingDir, primary: true }],
    agents: {},
  }],
}, null, 2));

const before = fs.readFileSync(CONFIG_PATH, "utf8");
const staleCliSnapshot = JSON.parse(before);
staleCliSnapshot.projects[0].archived = false;
assert.throws(
  () => writeConfig(staleCliSnapshot),
  (error) => error?.code === "project_ownership_reserved",
  "every activated CLI writer rechecks the live archived barrier",
);
assert.equal(fs.readFileSync(CONFIG_PATH, "utf8"), before, "rejected stale CLI writer leaves config byte-identical");

const missingIdentitySnapshot = JSON.parse(before);
delete missingIdentitySnapshot.installation_id;
missingIdentitySnapshot.projects[0].archived = false;
assert.throws(
  () => writeConfig(missingIdentitySnapshot),
  (error) => error?.code === "installation_id_rotation_forbidden",
  "stale CLI snapshot cannot select the legacy writer by omitting installation_id",
);
assert.equal(fs.readFileSync(CONFIG_PATH, "utf8"), before, "identity-omission bypass leaves config byte-identical");

const archivedRuntimeDir = path.join(CONFIG_DIR, "archived");
fs.mkdirSync(archivedRuntimeDir, { recursive: true });
fs.writeFileSync(path.join(archivedRuntimeDir, "keep.txt"), "runtime-state");
assert.throws(
  () => cleanupLegacyProjectAfterConfirmation("archived"),
  (error) => error?.code === "v2_cleanup_requires_lifecycle",
  "post-confirm cleanup rechecks live activation before deleting a project directory",
);
assert.equal(fs.readFileSync(CONFIG_PATH, "utf8"), before, "cleanup activation refusal leaves config byte-identical");
assert.equal(fs.readFileSync(path.join(archivedRuntimeDir, "keep.txt"), "utf8"), "runtime-state",
  "cleanup activation refusal leaves the project directory untouched");
assert.throws(
  () => cleanupLegacyProjectAfterConfirmation(".."),
  (error) => error?.code === "invalid_project_id",
  "cleanup rejects a target outside the direct QuadWork project directory",
);
for (const reserved of [".env", "config.lock"]) {
  const reservedPath = path.join(CONFIG_DIR, reserved);
  fs.writeFileSync(reservedPath, "control-state", { mode: 0o600 });
  assert.throws(
    () => cleanupLegacyProjectAfterConfirmation(reserved),
    (error) => error?.code === "invalid_project_id",
    `cleanup rejects reserved control entry ${reserved}`,
  );
  assert.equal(fs.readFileSync(reservedPath, "utf8"), "control-state");
  fs.unlinkSync(reservedPath);
}

assert.throws(
  () => writeQuadWorkConfig(setup("archived", "Acme/Replacement", replacementDir)),
  (error) => error?.code === "project_ownership_reserved",
  "a separate CLI setup cannot bypass the durable archived barrier",
);
assert.equal(fs.readFileSync(CONFIG_PATH, "utf8"), before, "rejected CLI setup leaves config byte-identical");

writeQuadWorkConfig(setup("new-project", "Acme/NewProject", newDir));
const committed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const added = committed.projects.find((project) => project.id === "new-project");
assert.ok(added, "CLI adds a new project through the V2 boundary");
assert.equal(Object.prototype.hasOwnProperty.call(added, "repo"), false);
assert.equal(Object.prototype.hasOwnProperty.call(added, "working_dir"), false);
assert.deepEqual(added.repositories, [{
  key: "primary",
  repo: "Acme/NewProject",
  working_dir: newDir,
  primary: true,
}]);

// The same post-confirm boundary still supports V1 cleanup and operates on the
// fresh locked snapshot rather than the stale preview shown before a prompt.
fs.unlinkSync(CONFIG_PATH);
const legacyTargetDir = path.join(CONFIG_DIR, "legacy-target");
fs.mkdirSync(legacyTargetDir, { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  port: 8400,
  concurrent_field: "preserve",
  projects: [{ id: "keep" }, { id: "legacy-target" }],
}, null, 2));
const cleanup = cleanupLegacyProjectAfterConfirmation("legacy-target");
assert.equal(cleanup.removedDirectory, true);
assert.equal(cleanup.removedConfigEntry, true);
const legacyCommitted = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
assert.deepEqual(legacyCommitted.projects, [{ id: "keep" }]);
assert.equal(legacyCommitted.concurrent_field, "preserve");
assert.equal(fs.existsSync(legacyTargetDir), false);

const legacyInstallDir = path.join(CONFIG_DIR, "agentchattr");
fs.mkdirSync(legacyInstallDir, { recursive: true });
fs.writeFileSync(path.join(legacyInstallDir, "keep.txt"), "legacy-runtime");
assert.throws(
  () => cleanupLegacyAgentChattrAfterConfirmation(),
  (error) => error?.code === "legacy_agentchattr_still_required" && error.project_ids.includes("keep"),
  "post-confirm legacy cleanup rechecks fresh project dependencies under config lock",
);
assert.equal(fs.readFileSync(path.join(legacyInstallDir, "keep.txt"), "utf8"), "legacy-runtime");

const keepClone = path.join(CONFIG_DIR, "keep", "agentchattr");
for (const entry of ["run.py", "config.toml", path.join(".venv", "bin", "python")]) {
  const target = path.join(keepClone, entry);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "ready");
}
const legacyCleanup = cleanupLegacyAgentChattrAfterConfirmation();
assert.equal(legacyCleanup.removed, true);
assert.equal(fs.existsSync(legacyInstallDir), false);

console.log("bin V2 config boundary: PASS");
