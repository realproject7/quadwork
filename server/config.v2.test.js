// #1029: canonical V2 repository schema, collision safety, immutable identity,
// and the sole atomic activation boundary.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-config-v2-"));
const CONFIG_DIR = path.join(TEST_HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const REPOS_DIR = path.join(TEST_HOME, "repos");
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(REPOS_DIR, { recursive: true });

const originalHome = os.homedir;
os.homedir = () => TEST_HOME;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const configApi = require("./config");
const {
  allRepositories,
  primaryRepository,
  repositoryByKey,
  repositoryByCanonicalName,
  serializeProjectCompatibility,
  validateV2Configuration,
  migrateConfigurationToV2,
  reserveV2ProjectOwnership,
  releaseV2ProjectOwnership,
  commitV2Configuration,
  writeConfig,
  readConfig,
} = configApi;

const INSTALLATION_ID = "installation_1234567890abcdef";
let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

function expectCode(fn, code, message) {
  let thrown;
  try { fn(); } catch (err) { thrown = err; }
  assert.ok(thrown, `${message}: expected an error`);
  assert.equal(thrown.code, code, `${message}: error code`);
  assert.ok(thrown.field, `${message}: error has a canonical field`);
  passed += 1;
  console.log(`  PASS: ${message}`);
  return thrown;
}

function repoDir(name) {
  const dir = path.join(REPOS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function repository(key, repo, workingDir, primary = true, extra = {}) {
  return { key, repo, working_dir: workingDir, primary, ...extra };
}

function project(id, repositories, extra = {}) {
  return { id, name: id, repositories, ...extra };
}

function activated(projects) {
  return { installation_id: INSTALLATION_ID, projects };
}

function diskBytes() {
  return fs.readFileSync(CONFIG_PATH, "utf8");
}

// Existing archived projects cannot be activated through either public config
// boundary unless lifecycle cleanup first owns the exact reservation token.
{
  const pathForTokenGate = repoDir("reservation-token-gate");
  writeConfig(activated([
    project("token-gate", [repository("primary", "Acme/TokenGate", pathForTokenGate)], { archived: true }),
  ]));
  const before = diskBytes();
  expectCode(
    () => commitV2Configuration((cfg) => { cfg.projects[0].archived = false; }),
    "project_ownership_reserved",
    "public V2 commit cannot unarchive without a cleanup reservation token",
  );
  assert.equal(diskBytes(), before);

  const staleWholeDocument = readConfig();
  staleWholeDocument.projects[0].archived = false;
  expectCode(
    () => writeConfig(staleWholeDocument),
    "project_ownership_reserved",
    "low-level write cannot unarchive without a cleanup reservation token",
  );
  assert.equal(diskBytes(), before);

  expectCode(
    () => writeConfig(staleWholeDocument, { previousConfig: staleWholeDocument }),
    "project_ownership_reserved",
    "exported low-level writer ignores a caller-forged previous snapshot",
  );
  assert.equal(diskBytes(), before);
}

// An in-flight unarchive reservation participates in the same authority as
// every generic V2 commit. A competing activation or identity rewrite fails
// before it can publish, while the opaque reservation can publish only its own
// final archived=false transition.
{
  const sharedPath = repoDir("reserved-shared");
  const alternatePath = repoDir("reserved-alternate");
  writeConfig(activated([
    project("reserved-a", [repository("primary", "Acme/Reserved", sharedPath)], { archived: true }),
    project("reserved-b", [repository("primary", "Acme/Reserved", sharedPath)], { archived: true }),
  ]));
  const reservation = reserveV2ProjectOwnership("reserved-a", readConfig());
  try {
    const before = diskBytes();
    expectCode(
      () => commitV2Configuration((cfg) => { cfg.projects[1].archived = false; }),
      "repository_owned_by_active_project",
      "generic commit cannot activate an owner that collides with an in-flight unarchive",
    );
    assert.equal(diskBytes(), before);

    expectCode(
      () => commitV2Configuration((cfg) => {
        cfg.projects[0].repositories[0].repo = "Acme/Alternate";
        cfg.projects[0].repositories[0].working_dir = alternatePath;
      }),
      "project_ownership_reserved",
      "generic commit cannot rewrite an in-flight reservation identity",
    );
    assert.equal(diskBytes(), before);

    expectCode(
      () => commitV2Configuration((cfg) => { cfg.projects[0].archived = false; }),
      "project_ownership_reserved",
      "generic commit cannot publish a reserved activation without its token",
    );
    assert.equal(diskBytes(), before);

    const staleWholeDocument = readConfig();
    staleWholeDocument.projects[1].archived = false;
    expectCode(
      () => writeConfig(staleWholeDocument),
      "repository_owned_by_active_project",
      "low-level stale write cannot bypass an in-flight ownership reservation",
    );
    assert.equal(diskBytes(), before);

    commitV2Configuration(
      (cfg) => { cfg.projects[0].archived = false; },
      { ownershipReservation: reservation },
    );
    ok(readConfig().projects[0].archived === false, "reservation token publishes only the validated activation");
  } finally {
    releaseV2ProjectOwnership(reservation);
  }
}

// An explicit fresh-install activation does not need an eager default write:
// ID, project mutation and canonical schema land in exactly one rename.
{
  const freshPath = repoDir("fresh-install");
  try { fs.unlinkSync(CONFIG_PATH); } catch {}
  const originalRename = fs.renameSync;
  let renames = 0;
  let rngCalls = 0;
  fs.renameSync = (...args) => { renames += 1; return originalRename(...args); };
  try {
    commitV2Configuration((cfg) => {
      cfg.projects.push({
        id: "fresh",
        repo: "Acme/Fresh",
        working_dir: freshPath,
      });
    }, {
      idGenerator: () => { rngCalls += 1; return INSTALLATION_ID; },
    });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(rngCalls, 1);
  assert.equal(renames, 1);
  assert.equal(readConfig().installation_id, INSTALLATION_ID);
  ok(readConfig().projects[0].repositories[0].key === "primary", "fresh activation uses one RNG call and one atomic rename");
}

// Pure legacy normalization uses the reserved stable key, never repo-derived
// identity, and cannot touch the filesystem.
{
  const legacy = { id: "legacy", repo: "Owner/Web", working_dir: path.join(REPOS_DIR, "..", "repos", "web") };
  const originalRealpath = fs.realpathSync;
  const originalStat = fs.statSync;
  fs.realpathSync = () => { throw new Error("normalizer touched fs"); };
  fs.statSync = () => { throw new Error("normalizer touched fs"); };
  let normalized;
  try { normalized = allRepositories(legacy); } finally {
    fs.realpathSync = originalRealpath;
    fs.statSync = originalStat;
  }
  assert.deepEqual(normalized, [{ key: "primary", repo: "Owner/Web", working_dir: path.join(REPOS_DIR, "web"), primary: true }]);
  ok(!Object.prototype.hasOwnProperty.call(legacy, "repositories"), "legacy normalization is pure and uses fixed key `primary`");
}

// Canonical accessor behavior, display order, case-insensitive repo lookup,
// and deep isolation of the reserved ci_policy extension.
{
  const p = project("access", [
    repository("worker", "Owner/Worker", repoDir("access-worker"), false),
    repository("web", "Owner/Web", repoDir("access-web"), true, { ci_policy: { required: ["unit"] } }),
  ]);
  assert.deepEqual(allRepositories(p).map((entry) => entry.key), ["worker", "web"]);
  assert.equal(primaryRepository(p).key, "web");
  assert.equal(repositoryByKey(p, "worker").repo, "Owner/Worker");
  assert.equal(repositoryByCanonicalName(p, "owner/WEB").key, "web");
  const compatible = serializeProjectCompatibility(p);
  assert.equal(compatible.repo, "Owner/Web");
  assert.equal(compatible.working_dir, repoDir("access-web"));
  compatible.repositories[1].ci_policy.required.push("mutated");
  ok(p.repositories[1].ci_policy.required.length === 1, "accessors return deep-isolated ci_policy data");
}

// Positive schema and the core per-project negative invariants.
{
  const a = repoDir("schema-a");
  const b = repoDir("schema-b");
  const base = activated([project("p", [repository("web", "Owner/Web", a)])]);
  assert.equal(validateV2Configuration(base), base);
  ok(true, "valid canonical V2 configuration passes");

  expectCode(() => validateV2Configuration({ projects: base.projects }), "invalid_installation_id", "missing installation identity is rejected");
  expectCode(() => validateV2Configuration({ installation_id: "short", projects: base.projects }), "invalid_installation_id", "invalid installation identity is rejected");
  expectCode(() => validateV2Configuration(activated([project("p", [])])), "repositories_required", "zero repositories are rejected");
  expectCode(() => validateV2Configuration(activated([project("p", [repository("Bad_Key", "Owner/A", a)])])), "invalid_repository_key", "invalid key is rejected");
  expectCode(() => validateV2Configuration(activated([project("p", [repository("web", "Owner/A", a), repository("web", "Owner/B", b, false)])])), "duplicate_repository_key", "duplicate key is rejected");
  expectCode(() => validateV2Configuration(activated([project("p", [repository("web", "Owner/Web", a), repository("api", "owner/WEB", b, false)])])), "duplicate_repository", "case-aliased repository is rejected");
  expectCode(() => validateV2Configuration(activated([project("p", [repository("web", "Owner/Web", "relative/path")])])), "invalid_repository_working_dir", "non-absolute working directory is rejected");
  const regularFile = path.join(REPOS_DIR, "not-a-directory");
  fs.writeFileSync(regularFile, "file");
  expectCode(() => validateV2Configuration(activated([project("p", [repository("web", "Owner/Web", regularFile)])])), "invalid_repository_working_dir", "existing non-directory working path is rejected");
  expectCode(() => validateV2Configuration(activated([project("p", [repository("web", "Owner/Web", a, false)])])), "invalid_primary_repository_count", "zero primaries are rejected");
  expectCode(() => validateV2Configuration(activated([project("p", [repository("web", "Owner/Web", a), repository("api", "Owner/Api", b)])])), "invalid_primary_repository_count", "multiple primaries are rejected");
  expectCode(() => validateV2Configuration({ ...base, projects: [{ ...base.projects[0], repo: "Owner/Web" }] }), "legacy_repository_scalars_persisted", "persisted scalar/array dual source is rejected");
}

// Existing symlink aliases, future descendants below a symlinked parent, and
// case aliases all collide. Error details name only field + owning project ID.
{
  const target = repoDir("alias-target");
  const alias = path.join(REPOS_DIR, "alias-link");
  fs.symlinkSync(target, alias, "dir");
  let err = expectCode(
    () => validateV2Configuration(activated([
      project("owner-project", [repository("one", "Acme/One", target)]),
      project("candidate-project", [repository("two", "Acme/Two", alias)]),
    ])),
    "repository_working_dir_owned_by_active_project",
    "existing symlink path alias is rejected",
  );
  assert.equal(err.owner_project_id, "owner-project");
  assert.ok(!err.message.includes("Acme/Two"));

  const realParent = repoDir("future-parent");
  const parentAlias = path.join(REPOS_DIR, "future-parent-link");
  fs.symlinkSync(realParent, parentAlias, "dir");
  expectCode(
    () => validateV2Configuration(activated([
      project("one", [repository("one", "Acme/One", path.join(realParent, "future", "repo"))]),
      project("two", [repository("two", "Acme/Two", path.join(parentAlias, "future", "repo"))]),
    ])),
    "repository_working_dir_owned_by_active_project",
    "future child under deepest existing symlink parent is rejected",
  );

  const future = path.join(REPOS_DIR, "CaseOnly", "FutureRepo");
  expectCode(
    () => validateV2Configuration(activated([
      project("one", [repository("one", "Acme/One", future)]),
      project("two", [repository("two", "Acme/Two", future.toLowerCase())]),
    ])),
    "repository_working_dir_owned_by_active_project",
    "future case alias is rejected",
  );

  for (const order of ["existing-then-future", "future-then-existing"]) {
    let targetCalls = 0;
    const transitionFs = {
      realpathSync: (value) => {
        if (value === "/virtual/same") {
          targetCalls += 1;
          const isExisting = order === "existing-then-future"
            ? targetCalls === 1
            : targetCalls > 1;
          if (isExisting) return value;
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }
        return value;
      },
      statSync: (value) => ({
        dev: 31,
        ino: value === "/virtual/same" ? 41 : 40,
        isDirectory: () => true,
      }),
    };
    expectCode(
      () => validateV2Configuration(activated([
        project("one", [repository("one", "Acme/One", "/virtual/same")]),
        project("two", [repository("two", "Acme/Two", "/virtual/same")]),
      ]), { fsImpl: transitionFs }),
      "repository_working_dir_owned_by_active_project",
      `${order} identity transition cannot bypass the common canonical path`,
    );
  }

  for (const order of ["existing-upper/future-lower", "future-upper/existing-lower"]) {
    const firstPath = "/virtual/A";
    const secondPath = "/virtual/a";
    const existingPath = order.startsWith("existing-upper") ? firstPath : secondPath;
    const futurePath = existingPath === firstPath ? secondPath : firstPath;
    const caseTransitionFs = {
      realpathSync: (value) => {
        if (value === existingPath) return value;
        if (value === futurePath) {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }
        return value;
      },
      statSync: (value) => ({
        dev: 51,
        ino: value === existingPath ? 52 : 50,
        isDirectory: () => true,
      }),
    };
    expectCode(
      () => validateV2Configuration(activated([
        project("one", [repository("one", "Acme/One", firstPath)]),
        project("two", [repository("two", "Acme/Two", secondPath)]),
      ]), { fsImpl: caseTransitionFs }),
      "repository_working_dir_owned_by_active_project",
      `${order} case alias is rejected across existence states`,
    );
  }
}

// Device identity is dev+ino (not dev alone), and verification races fail
// closed rather than silently degrading to lexical future-path comparison.
{
  const sameObjectFs = {
    realpathSync: (value) => value,
    statSync: () => ({ dev: 7, ino: 11 }),
  };
  expectCode(
    () => validateV2Configuration(activated([
      project("one", [repository("one", "Acme/One", "/virtual/a")]),
      project("two", [repository("two", "Acme/Two", "/virtual/b")]),
    ]), { fsImpl: sameObjectFs }),
    "repository_working_dir_owned_by_active_project",
    "matching device and inode identity collides",
  );

  const distinctInodeFs = {
    realpathSync: (value) => value,
    statSync: (value) => ({ dev: 7, ino: value.endsWith("/a") ? 11 : 12 }),
  };
  validateV2Configuration(activated([
    project("one", [repository("one", "Acme/One", "/virtual/a")]),
    project("two", [repository("two", "Acme/Two", "/virtual/b")]),
  ]), { fsImpl: distinctInodeFs });
  ok(true, "same device with different inode does not collide");

  const linuxCaseSensitiveFs = {
    realpathSync: (value) => value,
    statSync: (value) => ({ dev: 7, ino: value.endsWith("/A") ? 21 : 22 }),
  };
  validateV2Configuration(activated([
    project("upper", [repository("upper", "Acme/Upper", "/virtual/A")]),
    project("lower", [repository("lower", "Acme/Lower", "/virtual/a")]),
  ]), { fsImpl: linuxCaseSensitiveFs });
  ok(true, "existing Linux case-distinct realpaths remain distinct by dev+ino");

  expectCode(
    () => validateV2Configuration(activated([
      project("p", [repository("one", "Acme/One", "/virtual/no-object-id")]),
    ]), { fsImpl: { realpathSync: (value) => value, statSync: () => ({ dev: 7 }) } }),
    "repository_working_dir_identity_unavailable",
    "existing identity without both dev and inode fails closed",
  );

  for (const code of ["EACCES", "ENOENT"]) {
    const raceFs = {
      realpathSync: (value) => value,
      statSync: () => { const err = new Error(code); err.code = code; throw err; },
    };
    expectCode(
      () => validateV2Configuration(activated([project("p", [repository("one", "Acme/One", "/virtual/a")])]), { fsImpl: raceFs }),
      "repository_working_dir_identity_unavailable",
      `realpath/stat ${code} race fails closed`,
    );
  }
}

// Cross-project repo/path ownership ignores only archived:true. `idle` remains
// active, and validating an unarchive candidate re-runs the same ownership gate.
{
  const a = repoDir("ownership-a");
  const b = repoDir("ownership-b");
  expectCode(
    () => validateV2Configuration(activated([
      project("owner", [repository("one", "Acme/Owned", a)], { idle: true }),
      project("candidate", [repository("two", "acme/OWNED", b)]),
    ])),
    "repository_owned_by_active_project",
    "idle project retains ownership",
  );

  validateV2Configuration(activated([
    project("archived-owner", [repository("one", "Acme/Owned", a)], { archived: true }),
    project("candidate", [repository("two", "acme/OWNED", b)]),
  ]));
  ok(true, "archived project releases active ownership");

  const inaccessibleArchivedFs = {
    realpathSync: (value) => {
      if (value.includes("archived-inaccessible")) {
        const err = new Error("EACCES");
        err.code = "EACCES";
        throw err;
      }
      return value;
    },
    statSync: () => ({ dev: 8, ino: 99 }),
  };
  const inaccessibleArchived = activated([
    project("archived", [repository("archived", "Acme/Archived", "/virtual/archived-inaccessible")], { archived: true }),
    project("active", [repository("active", "Acme/Active", "/virtual/active")]),
  ]);
  validateV2Configuration(inaccessibleArchived, { fsImpl: inaccessibleArchivedFs });
  ok(true, "inaccessible archived path does not block a new active registration");
  expectCode(
    () => validateV2Configuration({
      ...inaccessibleArchived,
      projects: inaccessibleArchived.projects.map((entry) => ({ ...entry, archived: false })),
    }, { previousConfig: inaccessibleArchived, fsImpl: inaccessibleArchivedFs }),
    "repository_working_dir_identity_unavailable",
    "unarchive re-enables full fail-closed path identity verification",
  );

  const previous = activated([
    project("archived-owner", [repository("one", "Acme/Owned", a)], { archived: true }),
    project("current-owner", [repository("two", "Acme/Other", b)]),
  ]);
  const unarchive = activated([
    project("archived-owner", [repository("one", "Acme/Owned", a)], { archived: false }),
    project("current-owner", [repository("two", "acme/OWNED", b)]),
  ]);
  expectCode(
    () => validateV2Configuration(unarchive, { previousConfig: previous }),
    "repository_owned_by_active_project",
    "unarchive candidate re-runs ownership validation",
  );

  writeConfig(previous);
  const before = diskBytes();
  expectCode(
    () => commitV2Configuration((cfg) => {
      cfg.projects[0].archived = false;
      cfg.projects[1].repositories[0].repo = "acme/OWNED";
    }),
    "repository_owned_by_active_project",
    "failed unarchive commit is rejected atomically",
  );
  assert.equal(diskBytes(), before);
}

// Pure migration removes scalar persistence, preserves every unrelated nested
// value and ci_policy, and is structurally idempotent.
{
  const input = {
    port: 9999,
    session_token: "redacted-test-secret",
    runtime_resources: { version: 1, controller: { memory_high_mib: 123 } },
    unknown_top: { nested: [1, { keep: true }] },
    projects: [
      {
        id: "legacy",
        name: "Legacy",
        repo: "Acme/Legacy",
        working_dir: repoDir("migration-legacy"),
        agents: { head: { command: "codex", cwd: "/tmp/head" } },
        flags: { chat_mode: "file" },
        unknown_project: { nested: ["keep"] },
      },
      project("v2", [repository("web", "Acme/Web", repoDir("migration-v2"), true, { ci_policy: { required: ["build"] } })]),
    ],
  };
  const migrated = migrateConfigurationToV2(input);
  const twice = migrateConfigurationToV2(migrated);
  assert.deepEqual(twice, migrated);
  assert.equal(migrated.projects[0].repositories[0].key, "primary");
  assert.ok(!Object.prototype.hasOwnProperty.call(migrated.projects[0], "repo"));
  assert.equal(input.projects[0].repo, "Acme/Legacy");
  assert.deepEqual(migrated.runtime_resources, input.runtime_resources);
  assert.equal(migrated.session_token, input.session_token);
  assert.deepEqual(migrated.unknown_top, input.unknown_top);
  assert.deepEqual(migrated.projects[0].unknown_project, input.projects[0].unknown_project);
  assert.deepEqual(migrated.projects[1].repositories[0].ci_policy, { required: ["build"] });
  migrated.projects[1].repositories[0].ci_policy.required.push("mutated");
  ok(input.projects[1].repositories[0].ci_policy.required.length === 1, "migration is deep-pure, complete, and idempotent");
}

// First activation: RNG exactly once, scalar migration + installation ID in a
// single rename. Subsequent commits never call RNG and retain the identity.
{
  const legacyPath = repoDir("commit-legacy");
  writeConfig({
    port: 8400,
    session_token: "preserve-me",
    unknown: { deep: [1, 2] },
    projects: [{
      id: "legacy",
      name: "Legacy",
      repo: "Acme/Legacy",
      working_dir: legacyPath,
      agents: { head: { command: "codex" } },
      chat_mode: "file",
    }],
  });

  // Ordinary pre-activation reads/writebacks remain scalar and never synthesize
  // either repositories or installation_id before the explicit boundary.
  const preActivation = readConfig();
  assert.equal(Object.prototype.hasOwnProperty.call(preActivation, "installation_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(preActivation.projects[0], "repositories"), false);
  writeConfig(preActivation);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(diskBytes()).projects[0], "repositories"), false);
  ok(true, "ordinary readConfig/startup writeback cannot activate V2 early");

  const originalRename = fs.renameSync;
  let renames = 0;
  fs.renameSync = (...args) => { renames += 1; return originalRename(...args); };
  let rngCalls = 0;
  try {
    commitV2Configuration((cfg) => { cfg.feature_flag = true; }, {
      idGenerator: () => { rngCalls += 1; return INSTALLATION_ID; },
    });
  } finally {
    fs.renameSync = originalRename;
  }
  let committed = readConfig();
  assert.equal(rngCalls, 1);
  assert.equal(renames, 1);
  assert.equal(committed.installation_id, INSTALLATION_ID);
  assert.equal(committed.projects[0].repositories[0].key, "primary");
  assert.ok(!Object.prototype.hasOwnProperty.call(committed.projects[0], "repo"));
  assert.equal(committed.session_token, "preserve-me");
  assert.deepEqual(committed.unknown, { deep: [1, 2] });
  ok(true, "first activation generates ID once and atomically commits migration + mutation");

  rngCalls = 0;
  commitV2Configuration((cfg) => { cfg.feature_flag = "again"; }, {
    idGenerator: () => { rngCalls += 1; return "installation_should_not_rotate"; },
  });
  committed = readConfig();
  assert.equal(rngCalls, 0);
  assert.equal(committed.installation_id, INSTALLATION_ID);
  ok(committed.feature_flag === "again", "idempotent commit preserves installation ID and calls RNG zero times");

  for (const mutate of [
    (cfg) => { delete cfg.installation_id; },
    (cfg) => { cfg.installation_id = "installation_replacement_123"; },
  ]) {
    const before = diskBytes();
    expectCode(() => commitV2Configuration(mutate), "installation_id_rotation_forbidden", "ID deletion/replacement is rejected");
    assert.equal(diskBytes(), before);
  }
}

// Key immutability is previous-config-aware at the commit boundary. Invalid
// activation with legacy agent keys proves validation cannot cause the old
// eager startup migration write or any other byte change.
{
  const immutablePath = repoDir("immutable");
  writeConfig(activated([project("immutable", [repository("stable", "Acme/Stable", immutablePath)])]));
  let before = diskBytes();
  expectCode(
    () => commitV2Configuration((cfg) => { cfg.projects[0].repositories[0].key = "rotated"; }),
    "immutable_repository_key",
    "same canonical repository cannot rotate its stable key",
  );
  assert.equal(diskBytes(), before);

  writeConfig({
    projects: [{
      id: "legacy-invalid",
      repo: "not a github repo",
      working_dir: immutablePath,
      agents: { t1: { command: "old-head" } },
    }],
  });
  before = diskBytes();
  expectCode(
    () => commitV2Configuration(() => {}, { idGenerator: () => INSTALLATION_ID }),
    "invalid_repository_name",
    "failed validation does not persist legacy agent migration or partial V2 state",
  );
  assert.equal(diskBytes(), before);
  ok(JSON.parse(before).projects[0].agents.t1.command === "old-head", "failed activation leaves original config byte-valid and byte-identical");
}

console.log(`\n${passed} passed`);
console.log("server/config.v2.test.js: all assertions passed");
process.exit(0);
