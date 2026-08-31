// #1034: the setup add-config route must enter an activated installation
// through the canonical V2 commit boundary. Plain node:assert regression.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "qw-setup-v2-"));
const CONFIG_DIR = path.join(TMP, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const existingDir = path.join(TMP, "existing");
const addedDir = path.join(TMP, "added");
const invalidDir = path.join(TMP, "invalid");
const collisionDir = path.join(TMP, "collision");
const legacyDir = path.join(TMP, "legacy");
for (const dir of [CONFIG_DIR, existingDir, addedDir, invalidDir, collisionDir, legacyDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  installation_id: "routes_setup_installation_123",
  port: 8400,
  projects: [{
    id: "existing",
    name: "Existing",
    repositories: [{
      key: "primary",
      repo: "Acme/Existing",
      working_dir: existingDir,
      primary: true,
    }],
    archived: false,
  }],
}, null, 2));

const originalHomedir = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => {
  os.homedir = originalHomedir;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const express = require("express");
const router = require("./routes");

function request(server, body, step = "add-config") {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method: "POST",
      path: `/api/setup?step=${step}`,
      headers: { "content-type": "application/json", "content-length": payload.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function diskBytes() {
  return fs.readFileSync(CONFIG_PATH, "utf-8");
}

(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const addedHeadDir = `${addedDir}-head`;
    fs.mkdirSync(addedHeadDir, { recursive: true });
    let response = await request(server, {
      workingDir: addedDir,
      projectName: "Added Display Name",
      repo: "Acme/Added",
      reviewerUser: "",
      reviewerTokenPath: "",
    }, "seed-files");
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    const seededHead = fs.readFileSync(path.join(addedHeadDir, "AGENTS.md"), "utf-8");
    assert.ok(seededHead.includes("~/.quadwork/added/HEAD-PO-PLAYBOOK.md"),
      "Head seed uses the exact project id rather than display name");
    assert.equal(seededHead.includes("{{project_id}}"), false);

    response = await request(server, {
      id: "added",
      name: "Added",
      repo: "Acme/Added",
      workingDir: addedDir,
      backends: { head: "codex", re1: "codex", re2: "codex", dev: "codex" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    let config = JSON.parse(diskBytes());
    const added = config.projects.find((project) => project.id === "added");
    assert.ok(added);
    assert.equal(Object.prototype.hasOwnProperty.call(added, "repo"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(added, "working_dir"), false);
    assert.deepEqual(added.repositories, [{
      key: "primary",
      repo: "Acme/Added",
      working_dir: addedDir,
      primary: true,
    }]);
    const addedPlaybook = path.join(CONFIG_DIR, "added", "HEAD-PO-PLAYBOOK.md");
    assert.equal(fs.existsSync(addedPlaybook), true, "activated setup seeds the Head PO playbook");
    assert.match(fs.readFileSync(addedPlaybook, "utf-8"), /\*\*Playbook version:\*\*\s+1\.0\.0/);
    assert.ok(fs.readFileSync(addedPlaybook, "utf-8").includes("~/.quadwork/added/HEAD-PO-PLAYBOOK.md"),
      "installed playbook self-path uses project id, not display name");

    let before = diskBytes();
    response = await request(server, {
      id: "invalid",
      name: "Invalid",
      repo: "not-a-repository",
      workingDir: invalidDir,
      backends: {},
    });
    assert.equal(response.status, 409);
    assert.equal(response.json.code, "invalid_repository_name");
    assert.equal(diskBytes(), before, "invalid activated setup is atomic");

    before = diskBytes();
    response = await request(server, {
      id: "collision",
      name: "Collision",
      repo: "acme/existing",
      workingDir: collisionDir,
      backends: {},
    });
    assert.equal(response.status, 409);
    assert.equal(response.json.code, "repository_owned_by_active_project");
    assert.equal(diskBytes(), before, "repository collision is atomic");

    before = diskBytes();
    response = await request(server, {
      id: "existing",
      name: "Stale Duplicate",
      repo: "Acme/Different",
      workingDir: collisionDir,
      backends: {},
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.message, "Project already in config");
    assert.equal(diskBytes(), before, "fresh duplicate-id detection leaves activated config unchanged");

    config = JSON.parse(diskBytes());
    assert.deepEqual(config.projects.map((project) => project.id), ["existing", "added"]);

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ port: 8400, projects: [] }, null, 2));
    response = await request(server, {
      id: "legacy",
      name: "Legacy",
      repo: "Acme/Legacy",
      workingDir: legacyDir,
      backends: {},
    });
    assert.equal(response.status, 200);
    const legacy = JSON.parse(diskBytes()).projects[0];
    assert.equal(legacy.repo, "Acme/Legacy");
    assert.equal(legacy.working_dir, legacyDir);
    assert.equal(Object.prototype.hasOwnProperty.call(legacy, "repositories"), false,
      "pre-activation setup retains the V1 scalar shape");
    assert.equal(fs.existsSync(path.join(CONFIG_DIR, "legacy", "HEAD-PO-PLAYBOOK.md")), true,
      "legacy setup seeds the same Head PO playbook");
    console.log("routes.setupActivatedConfig.test.js: all assertions passed");
  } finally {
    server.close();
  }
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
