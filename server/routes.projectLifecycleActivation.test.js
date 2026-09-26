// #1184: archive, restore and remove never activate V2. On a never-activated
// installation with two legacy projects each action is refused with a message
// that points to the explicit activation flow, config.json keeps its exact
// bytes (no installation_id, no migrated sibling), and no cleanup runs.
// Restoring a project that is not archived stays a read-only no-op. After
// explicit activation the same actions work. Real router, lifecycle controller
// and config boundary against an isolated HOME. Plain node:assert.

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-lifecycle-activation-"));
const CONFIG_DIR = path.join(TEST_HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const CONFIG_LOCK_PATH = path.join(CONFIG_DIR, "config.lock");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const originalHome = os.homedir;
os.homedir = () => TEST_HOME;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const express = require("express");
const router = require("./routes");
const { commitV2Configuration } = require("./config");
const { createProjectLifecycleController, _admissionGenerations } = require("./project-lifecycle");

const REFUSAL = {
  ok: false,
  error: "Activate V2 first: use V2 repository setup on a project, or Add Project (V2 setup) in Settings. Then archive, restore or remove.",
  code: "v2_project_lifecycle_unavailable",
  project_id: "alpha",
};

function legacyProject(id, extra = {}) {
  const workingDir = path.join(TEST_HOME, "repos", id);
  fs.mkdirSync(workingDir, { recursive: true });
  return { id, name: id, repo: `Acme/${id}`, working_dir: workingDir, idle: true, agents: {}, ...extra };
}

function writeLegacy(projects) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ port: 8400, operator_name: "user", projects }, null, 2), { mode: 0o600 });
}

function bytes() {
  return fs.readFileSync(CONFIG_PATH, "utf8");
}

function readDisk() {
  return JSON.parse(bytes());
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
  const cleanupCalls = [];
  const lifecycle = createProjectLifecycleController({
    cleanupProject: async (projectId) => {
      cleanupCalls.push(projectId);
      return { ok: true, resources: {} };
    },
  });
  const app = express();
  app.use(express.json());
  app.set("projectLifecycle", lifecycle);
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  // Every call on the never-activated install leaves config.json, the other
  // project, the config lock, runtime cleanup and live admission untouched.
  async function expectNoChange(label, method, urlPath, body, bravo, status, payload) {
    const before = bytes();
    const response = await request(server, method, urlPath, body);
    assert.equal(response.status, status, `${label}: responds ${status}`);
    assert.deepEqual(response.json, payload, `${label}: exact response payload`);
    assert.equal(bytes(), before, `${label}: config.json keeps its exact bytes`);
    const disk = readDisk();
    assert.equal(Object.prototype.hasOwnProperty.call(disk, "installation_id"), false,
      `${label}: no installation_id is introduced`);
    assert.deepEqual(disk.projects.find((project) => project.id === "bravo"), bravo,
      `${label}: the other project keeps its legacy scalar shape`);
    assert.equal(fs.existsSync(CONFIG_LOCK_PATH), false, `${label}: no config transaction lock is left behind`);
    assert.deepEqual(cleanupCalls, [], `${label}: no runtime cleanup runs`);
    assert.equal(_admissionGenerations.has("alpha"), false, `${label}: live admission is not revoked`);
  }
  const expectRefused = (label, method, urlPath, body, bravo) =>
    expectNoChange(label, method, urlPath, body, bravo, 409, REFUSAL);

  try {
    // Archive (and remove, which archives first) on a never-activated install.
    const activeBravo = legacyProject("bravo");
    writeLegacy([legacyProject("alpha"), activeBravo]);
    await expectRefused("archive", "PUT", "/api/projects/alpha/archive", { archived: true }, activeBravo);
    await expectRefused("remove", "DELETE", "/api/projects/alpha", undefined, activeBravo);

    // Restoring a project that is not archived stays the read-only no-op it
    // was before #1184: 200, no write, no V2 validation.
    await expectNoChange("already-active restore", "PUT", "/api/projects/alpha/archive", { archived: false }, activeBravo, 200, {
      ok: true,
      project_id: "alpha",
      archived: false,
      already_unarchived: true,
      admission_generation: 0,
      resources: {},
      cleanup_errors: [],
    });

    // Restore, and the archived row's cleanup retry, on a never-activated
    // install whose project was archived before V2 lifecycle existed.
    writeLegacy([legacyProject("alpha", { archived: true }), activeBravo]);
    await expectRefused("restore", "PUT", "/api/projects/alpha/archive", { archived: false }, activeBravo);
    await expectRefused("archived retry", "PUT", "/api/projects/alpha/archive", { archived: true }, activeBravo);

    // Settings renders the server message for a non-cleanup refusal and only
    // commits local archive state when the server returned one.
    const settings = fs.readFileSync(path.join(__dirname, "..", "src", "components", "SettingsPage.tsx"), "utf8");
    assert.match(settings, /const message = typeof payload\.error === "string" \? payload\.error : t\.lifecycleFailed;/);
    assert.match(settings, /if \(typeof payload\.archived === "boolean"\) commitLifecycleState\(target\.id, \{ archived: payload\.archived \}\);/);

    // Positive control: after the explicit activation boundary runs, the same
    // restore and archive succeed and never touch the identity or the sibling.
    commitV2Configuration(() => {});
    const activated = readDisk();
    assert.equal(typeof activated.installation_id, "string", "explicit activation introduces installation_id");
    const migratedBravo = activated.projects.find((project) => project.id === "bravo");
    assert.equal(Array.isArray(migratedBravo.repositories), true, "explicit activation migrates every project");

    let response = await request(server, "PUT", "/api/projects/alpha/archive", { archived: false });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.ok, true);
    assert.equal(response.json.archived, false);
    response = await request(server, "PUT", "/api/projects/alpha/archive", { archived: true });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.ok, true);
    assert.equal(response.json.archived, true);
    assert.deepEqual(cleanupCalls, ["alpha", "alpha"], "activated restore and archive run cleanup");
    const after = readDisk();
    assert.equal(after.installation_id, activated.installation_id, "lifecycle keeps the activated identity");
    assert.deepEqual(after.projects.find((project) => project.id === "bravo"), migratedBravo,
      "activated lifecycle leaves the other project unchanged");

    console.log("routes.projectLifecycleActivation.test.js: all assertions passed");
  } finally {
    server.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
