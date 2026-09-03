// #1029: existing config endpoints preserve the server-owned installation ID
// and reject attempts to introduce or rotate it outside the V2 commit boundary.

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-routes-installation-"));
const CONFIG_DIR = path.join(TEST_HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const originalHome = os.homedir;
os.homedir = () => TEST_HOME;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const express = require("express");
const router = require("./routes");
const { writeConfig, commitV2Configuration } = require("./config");
const {
  createProjectLifecycleController,
  captureProjectAdmission,
  isAdmissionCurrent,
  _admissionGenerations,
} = require("./project-lifecycle");

const INSTALLATION_ID = "installation_1234567890abcdef";

function readDisk() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function bytes() {
  return fs.readFileSync(CONFIG_PATH, "utf8");
}

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method,
      path: urlPath,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(raw); }
        catch { return reject(new Error(`non-JSON response ${res.statusCode}: ${raw.slice(0, 500)}`)); }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const canonicalProject = {
      id: "p",
      name: "Project",
      idle: true,
      repositories: [{
        key: "primary",
        repo: "Acme/Project",
        working_dir: path.join(TEST_HOME, "project"),
        primary: true,
        ci_policy: { version: 1, mode: "ci-less", evidence_keys: ["operator"] },
      }],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      installation_id: INSTALLATION_ID,
      session_token: "route-test-session-secret",
      port: 8400,
      projects: [canonicalProject],
    }, null, 2), { mode: 0o600 });

    // The route-local reader derives V1 scalar compatibility from the primary
    // entry, but a legacy read-modify-write never persists those derived fields.
    let response = await request(server, "GET", "/api/projects");
    assert.equal(response.status, 200);
    assert.equal(response.json.projects[0].repo, "Acme/Project");
    response = await request(server, "PUT", "/api/loop-guard?project=p", { value: 12 });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(readDisk().projects[0].repositories));
    assert.equal(Object.prototype.hasOwnProperty.call(readDisk().projects[0], "repo"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(readDisk().projects[0], "working_dir"), false);

    // A stale full snapshot may omit the server-owned field; the endpoint must
    // carry it forward. Echoing the same value is also harmless.
    response = await request(server, "PUT", "/api/config", { port: 8401, projects: [canonicalProject] });
    assert.equal(response.status, 200);
    assert.equal(readDisk().installation_id, INSTALLATION_ID);
    assert.equal(readDisk().session_token, "route-test-session-secret");

    response = await request(server, "PUT", "/api/config", {
      installation_id: INSTALLATION_ID,
      port: 8402,
      projects: [canonicalProject],
    });
    assert.equal(response.status, 200);
    assert.equal(readDisk().installation_id, INSTALLATION_ID);
    assert.equal(readDisk().session_token, "route-test-session-secret");

    // Whole-config reconciliation uses the fresh state read under config.lock,
    // not the snapshot captured before a lifecycle transition.
    const lifecycle = createProjectLifecycleController({
      cleanupProject: async () => ({ ok: true, resources: {} }),
    });
    const staleActiveSnapshot = readDisk();
    const archived = await lifecycle.archiveProject("p");
    assert.equal(archived.ok, true);
    staleActiveSnapshot.port = 8403;
    response = await request(server, "PUT", "/api/config", staleActiveSnapshot);
    assert.equal(response.status, 200);
    assert.equal(readDisk().projects[0].archived, true,
      "stale active PUT cannot restore a freshly archived project");
    assert.equal(readDisk().projects[0].admission_generation, archived.admission_generation,
      "stale active PUT cannot reset the archive's durable admission generation");
    assert.equal(readDisk().project_admission_generations.p, archived.admission_generation,
      "stale active PUT cannot reset the installation admission tombstone");

    const staleArchivedSnapshot = readDisk();
    const restored = await lifecycle.unarchiveProject("p");
    assert.equal(restored.ok, true);
    staleArchivedSnapshot.port = 8404;
    response = await request(server, "PUT", "/api/config", staleArchivedSnapshot);
    assert.equal(response.status, 200);
    assert.equal(readDisk().projects[0].archived, false,
      "stale archived PUT cannot rearchive a freshly restored project");
    assert.equal(readDisk().projects[0].admission_generation, restored.admission_generation,
      "stale archived PUT cannot roll back the unarchive generation");
    assert.equal(readDisk().project_admission_generations.p, restored.admission_generation,
      "stale archived PUT cannot roll back the installation admission tombstone");

    // Full replacement and section merge both reject rotation without writing.
    for (const method of ["PUT", "PATCH"]) {
      const before = bytes();
      response = await request(server, method, "/api/config", {
        installation_id: "installation_replacement_123",
        port: 9999,
        projects: [canonicalProject],
      });
      assert.equal(response.status, 409, `${method} rejects identity rotation`);
      assert.equal(bytes(), before, `${method} rejection leaves bytes unchanged`);
      assert.ok(!JSON.stringify(response.json).includes("installation_replacement_123"));
    }

    // Section writes and project flag writes do not need the ID in their body
    // and preserve it through the serialized updateConfig boundary.
    response = await request(server, "PATCH", "/api/config", { operator_name: "alice" });
    assert.equal(response.status, 200);
    assert.equal(readDisk().installation_id, INSTALLATION_ID);
    response = await request(server, "PATCH", "/api/projects/p/flags", { idle: true });
    assert.equal(response.status, 200);
    assert.equal(readDisk().installation_id, INSTALLATION_ID);

    function expectSafeConflict(result, before, label, forbidden = []) {
      assert.equal(result.status, 409, `${label}: rejected with conflict`);
      assert.equal(bytes(), before, `${label}: prior bytes remain unchanged`);
      assert.equal(result.json.error, "V2 configuration validation failed", `${label}: safe typed error`);
      assert.equal(typeof result.json.code, "string", `${label}: stable error code`);
      assert.equal(typeof result.json.field, "string", `${label}: canonical field`);
      const serialized = JSON.stringify(result.json);
      for (const value of forbidden) assert.ok(!serialized.includes(value), `${label}: candidate value is redacted`);
    }

    // Activated full writes cannot persist a scalar/array dual source. The
    // commit boundary rejects rather than silently stripping the injected data.
    {
      const candidate = readDisk();
      candidate.projects[0].repo = "PrivateOwner/InjectedRepo";
      candidate.projects[0].working_dir = "/private/injected/path";
      const before = bytes();
      response = await request(server, "PUT", "/api/config", candidate);
      expectSafeConflict(response, before, "dual-source PUT", ["PrivateOwner", "/private/injected/path"]);
      assert.equal(response.json.code, "legacy_repository_scalars_persisted");
    }

    // An unchanged key cannot be used as a generic-route escape hatch for a
    // repository retarget, base move, primary flip, or CI-policy change. The
    // explicit quiesced V2 topology transaction is the only writer for each.
    for (const [field, method, mutate] of [
      ["repo", "PUT", (entry) => { entry.repo = "Acme/Retargeted"; }],
      ["working_dir", "PATCH", (entry) => { entry.working_dir = path.join(TEST_HOME, "moved-project"); }],
      ["primary", "PUT", (entry) => { entry.primary = false; }],
      ["ci_policy", "PATCH", (entry) => { entry.ci_policy = { version: 1, mode: "ci-less", evidence_keys: ["release"] }; }],
    ]) {
      const disk = readDisk();
      const incoming = JSON.parse(JSON.stringify(disk.projects[0]));
      mutate(incoming.repositories[0]);
      const before = bytes();
      response = await request(server, method, "/api/config", method === "PUT"
        ? { ...disk, projects: [incoming] }
        : { projects: [incoming] });
      expectSafeConflict(response, before, `same-key ${field} ${method}`);
      assert.equal(response.json.code, "generic_repository_topology_change_forbidden");
    }

    // Generic activated routes freeze the existing key topology. Rotating key,
    // repo and path together cannot disguise the key change as remove+add.
    {
      const incoming = JSON.parse(JSON.stringify(readDisk().projects[0]));
      incoming.idle = false; // route must preserve the on-disk true flag
      incoming.repositories[0].key = "rotated";
      incoming.repositories[0].repo = "Acme/Renamed";
      incoming.repositories[0].working_dir = path.join(TEST_HOME, "renamed-project");
      const before = bytes();
      response = await request(server, "PATCH", "/api/config", { projects: [incoming] });
      expectSafeConflict(response, before, "simultaneous key/repo/path PATCH");
      assert.equal(response.json.code, "generic_repository_topology_change_forbidden");
      assert.equal(readDisk().projects[0].idle, true);
    }

    const apiRepository = {
      key: "api",
      repo: "Acme/Api",
      working_dir: path.join(TEST_HOME, "project-api"),
      primary: false,
    };
    {
      const incoming = JSON.parse(JSON.stringify(readDisk().projects[0]));
      incoming.repositories.push(apiRepository);
      const before = bytes();
      response = await request(server, "PATCH", "/api/config", { projects: [incoming] });
      expectSafeConflict(response, before, "repository key add PATCH");
      assert.equal(response.json.code, "generic_repository_topology_change_forbidden");
    }

    // The explicit controlled boundary remains capable of a future #1032
    // topology change; generic routes still cannot remove that committed key.
    commitV2Configuration((cfg) => {
      cfg.projects[0].repositories.push(apiRepository);
    });
    {
      const incoming = JSON.parse(JSON.stringify(readDisk().projects[0]));
      incoming.repositories = incoming.repositories.filter((entry) => entry.key !== "api");
      const before = bytes();
      response = await request(server, "PATCH", "/api/config", { projects: [incoming] });
      expectSafeConflict(response, before, "repository key remove PATCH");
      assert.equal(response.json.code, "generic_repository_topology_change_forbidden");
    }

    {
      const candidate = readDisk();
      candidate.projects[0].id = "renamed-project-id";
      const before = bytes();
      response = await request(server, "PUT", "/api/config", candidate);
      expectSafeConflict(response, before, "project identity rename PUT");
      assert.equal(response.json.code, "generic_project_identity_change_forbidden");
    }

    // Add a second project through the explicit controlled boundary. Generic
    // PATCH now rejects any repository-record mutation before it can become an
    // ownership collision, keeping topology exclusive to explicit activation.
    const secondProject = {
      id: "p2",
      name: "Project Two",
      idle: true,
      repositories: [{
        key: "primary",
        repo: "Acme/ProjectTwo",
        working_dir: path.join(TEST_HOME, "project-two"),
        primary: true,
      }],
    };
    commitV2Configuration((cfg) => { cfg.projects.push(secondProject); });
    assert.equal(readDisk().session_token, "route-test-session-secret");
    for (const [field, value] of [
      ["repo", "acme/PROJECT"],
      ["working_dir", path.join(TEST_HOME, "project")],
    ]) {
      const incoming = JSON.parse(JSON.stringify(readDisk().projects.find((entry) => entry.id === "p2")));
      incoming.repositories[0][field] = value;
      const before = bytes();
      response = await request(server, "PATCH", "/api/config", { projects: [incoming] });
      expectSafeConflict(response, before, `${field} generic topology mutation`, [String(value)]);
      assert.equal(response.json.code, "generic_repository_topology_change_forbidden");
    }

    // An invalid generic repository rewrite is blocked as topology drift
    // before schema validation, without echoing values or changing state.
    {
      const candidate = readDisk();
      candidate.projects[1].repositories[0].repo = "private-invalid-repository-value";
      const before = bytes();
      response = await request(server, "PUT", "/api/config", candidate);
      expectSafeConflict(response, before, "invalid canonical PUT", ["private-invalid-repository-value"]);
      assert.equal(response.json.code, "generic_repository_topology_change_forbidden");
      assert.equal(readDisk().session_token, "route-test-session-secret");
    }

    const preRemoveToken = captureProjectAdmission("p2");
    const removed = await lifecycle.removeProject("p2");
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.equal(readDisk().projects.some((project) => project.id === "p2"), false,
      "real lifecycle controller alone can commit archive cleanup and removal");
    assert.equal(readDisk().project_admission_generations.p2, removed.admission_generation,
      "removal keeps an installation-scoped admission tombstone");

    commitV2Configuration((cfg) => { cfg.projects.push(secondProject); });
    const reusedToken = captureProjectAdmission("p2");
    assert.equal(reusedToken.generation, removed.admission_generation,
      "same-id recreation inherits the removal high-water mark");
    response = await request(server, "PATCH", "/api/config", {
      projects: [{ id: "p2", name: "Project Two Reused" }],
    });
    assert.equal(response.status, 200, "ordinary config edits remain available after same-id recreation");
    assert.equal(readDisk().projects.find((project) => project.id === "p2").name, "Project Two Reused");
    const reusedArchived = await lifecycle.archiveProject("p2");
    assert.equal(reusedArchived.ok, true, "same-id recreation can be archived without restarting the process");
    assert.equal(reusedArchived.admission_generation, removed.admission_generation + 1);
    const reusedRestored = await lifecycle.unarchiveProject("p2");
    assert.equal(reusedRestored.ok, true);
    _admissionGenerations.clear();
    assert.equal(isAdmissionCurrent(preRemoveToken), false,
      "process restart cannot resurrect authority from before same-id recreation");
    assert.equal(captureProjectAdmission("p2").generation, reusedRestored.admission_generation,
      "restart reads the recreated project's durable installation epoch");

    const magicProject = {
      id: "__proto__",
      name: "Prototype-safe Project",
      repositories: [{
        key: "primary",
        repo: "Acme/PrototypeSafe",
        working_dir: path.join(TEST_HOME, "prototype-safe"),
        primary: true,
      }],
    };
    commitV2Configuration((cfg) => { cfg.projects.push(magicProject); });
    const magicOldToken = captureProjectAdmission("__proto__");
    const magicRemoved = await lifecycle.removeProject("__proto__");
    assert.equal(magicRemoved.removed, true);
    assert.equal(Object.prototype.hasOwnProperty.call(readDisk().project_admission_generations, "__proto__"), true,
      "prototype-magic ids persist an own tombstone through the real config boundary");
    commitV2Configuration((cfg) => { cfg.projects.push(magicProject); });
    const magicArchived = await lifecycle.archiveProject("__proto__");
    assert.equal(magicArchived.ok, true, "prototype-magic same-id recreation remains lifecycle-live");
    _admissionGenerations.clear();
    assert.equal(isAdmissionCurrent(magicOldToken), false,
      "prototype-magic same-id recreation cannot resurrect pre-remove authority after restart");

    const legacyArchived = {
      id: "legacy-archived",
      name: "Legacy Archived",
      archived: true,
      admission_generation: 4,
      repositories: [{
        key: "primary",
        repo: "Acme/LegacyArchived",
        working_dir: path.join(TEST_HOME, "legacy-archived"),
        primary: true,
      }],
    };
    const legacyDocument = readDisk();
    legacyDocument.projects.push(legacyArchived);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(legacyDocument, null, 2), { mode: 0o600 });
    const legacyRetry = await lifecycle.archiveProject("legacy-archived");
    assert.equal(legacyRetry.ok, true, "legacy archived cleanup can retry while backfilling its tombstone");
    assert.equal(legacyRetry.admission_generation, 4, "idempotent archive backfill does not mint a new epoch");
    assert.equal(readDisk().project_admission_generations["legacy-archived"], 4);
    const legacyRemoved = await lifecycle.removeProject("legacy-archived");
    assert.equal(legacyRemoved.removed, true, "legacy archived project remains removable after registry upgrade");

    const legacyZero = {
      id: "legacy-zero",
      name: "Legacy Zero",
      archived: true,
      repositories: [{
        key: "primary",
        repo: "Acme/LegacyZero",
        working_dir: path.join(TEST_HOME, "legacy-zero"),
        primary: true,
      }],
    };
    const legacyZeroDocument = readDisk();
    legacyZeroDocument.projects.push(legacyZero);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(legacyZeroDocument, null, 2), { mode: 0o600 });
    const preUpgradeZeroToken = Object.freeze({ project_id: "legacy-zero", generation: 0 });
    const legacyZeroRemoved = await lifecycle.removeProject("legacy-zero");
    assert.equal(legacyZeroRemoved.removed, true);
    assert.equal(legacyZeroRemoved.admission_generation, 1,
      "first lifecycle touch advances a pre-epoch archived project above generation zero");
    assert.equal(readDisk().project_admission_generations["legacy-zero"], 1);
    commitV2Configuration((cfg) => { cfg.projects.push({ ...legacyZero, archived: false }); });
    _admissionGenerations.clear();
    assert.equal(isAdmissionCurrent(preUpgradeZeroToken), false,
      "legacy generation-zero authority cannot revive after remove and same-id recreation");

    // Before activation, neither full endpoint may accept a caller-supplied ID.
    fs.unlinkSync(CONFIG_PATH);
    writeConfig({ port: 8400, projects: [] });
    for (const method of ["PUT", "PATCH"]) {
      const before = bytes();
      response = await request(server, method, "/api/config", {
        installation_id: INSTALLATION_ID,
        port: 8401,
        projects: [],
      });
      assert.equal(response.status, 409, `${method} cannot introduce installation ID`);
      assert.equal(bytes(), before, `${method} introduction rejection is atomic`);
    }

    console.log("routes.installationIdentity.test.js: all assertions passed");
  } finally {
    server.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
