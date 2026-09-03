"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-environment-settings-route-"));
const CONFIG_DIR = path.join(TEST_HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const REPO_DIR = path.join(TEST_HOME, "repo");
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });
const originalHome = os.homedir;
os.homedir = () => TEST_HOME;
process.on("exit", () => {
  os.homedir = originalHome;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

const INSTALLATION_ID = "installation_1234567890abcdef";
const router = require("./routes");

function disk() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
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
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const valid = (label = "Peer VPS") => ({
  environment_bindings: [{
    installation_id: "peerinstall_1234567890abcdef",
    project_id: "peer-project",
    label,
    environment_class: "vps",
  }],
  coordination_repo_key: "primary",
  watch_batch_requests: true,
});

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

(async () => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    installation_id: INSTALLATION_ID,
    unrelated_top_level: { preserve: true },
    projects: [{
      id: "alpha",
      name: "Alpha",
      unrelated_project_field: { preserve: "yes" },
      repositories: [{ key: "primary", repo: "Acme/Alpha", working_dir: REPO_DIR, primary: true }],
    }],
  }, null, 2), { mode: 0o600 });

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    let response = await request(server, "GET", "/api/projects/alpha/environment-settings");
    ok(response.status === 200 && response.json.watch_batch_requests === false,
      "Settings read normalizes missing environment settings to a disabled local watcher");
    ok(response.json.repositories.length === 1 && response.json.repositories[0].canonical_repository === "acme/alpha",
      "Settings selector exposes only canonical configured repository records");

    response = await request(server, "PUT", "/api/projects/alpha/environment-settings", valid());
    ok(response.status === 200 && response.json.ok === true && response.json.environment_bindings[0].label === "Peer VPS",
      "dedicated Settings mutation accepts a typed valid environment binding");
    let persisted = disk();
    const savedProject = persisted.projects[0];
    ok(savedProject.watch_batch_requests === true && savedProject.coordination_repo_key === "primary" &&
      savedProject.unrelated_project_field.preserve === "yes" && persisted.unrelated_top_level.preserve === true,
      "atomic Settings mutation preserves unrelated project and top-level configuration");
    ok(!Object.prototype.hasOwnProperty.call(savedProject, "repo") && !Object.prototype.hasOwnProperty.call(savedProject, "working_dir"),
      "environment mutation never reintroduces legacy repository scalars");

    const mapPath = path.join(CONFIG_DIR, "alpha", "PROJECT-ENVIRONMENTS.md");
    const map = fs.readFileSync(mapPath, "utf8");
    ok((fs.statSync(mapPath).mode & 0o777) === 0o600 && map.includes("acme/alpha") && !map.includes(REPO_DIR),
      "Settings mutation atomically writes a mode-0600 allow-listed map without local paths");

    const beforeGeneric = JSON.stringify(savedProject.environment_bindings);
    response = await request(server, "PATCH", "/api/config", {
      projects: [{
        id: "alpha",
        environment_bindings: [],
        coordination_repo_key: "primary",
        watch_batch_requests: false,
      }],
    });
    ok(response.status === 200 && JSON.stringify(disk().projects[0].environment_bindings) === beforeGeneric &&
      disk().projects[0].watch_batch_requests === true,
      "generic config PATCH cannot modify Settings-bound environment topology or watcher state");

    const beforeInvalid = fs.readFileSync(CONFIG_PATH, "utf8");
    response = await request(server, "PUT", "/api/projects/alpha/environment-settings", {
      ...valid(),
      coordination_repo_key: "removed",
    });
    ok(response.status === 409 && response.json.code === "coordination_repository_not_found" &&
      fs.readFileSync(CONFIG_PATH, "utf8") === beforeInvalid,
      "removed canonical repository key is a typed error and leaves config atomically unchanged");

    fs.appendFileSync(mapPath, "\n## Operator Notes\n\nPreserve this section.\n");
    fs.chmodSync(mapPath, 0o644);
    response = await request(server, "PUT", "/api/projects/alpha/environment-settings", valid("Renamed Peer"));
    const reseededMap = fs.readFileSync(mapPath, "utf8");
    ok(response.status === 200 && reseededMap.includes("## Operator Notes\n\nPreserve this section.") &&
      reseededMap.includes("Renamed Peer") && (fs.statSync(mapPath).mode & 0o777) === 0o600,
      "map reseed preserves operator-owned sections and re-hardens mode 0600");
  } finally {
    server.close();
  }
  console.log(`\n${passed} passed`);
  console.log("server/routes.projectEnvironmentSettings.test.js: all assertions passed");
  process.exit(0);
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
