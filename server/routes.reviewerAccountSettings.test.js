// #949: Settings reviewer-account plumbing. The API must expose token status
// without the token value, save/rotate the token securely, and update
// reviewer_github_user through a field-scoped endpoint.
//
// Plain node:assert script — run with
// `node server/routes.reviewerAccountSettings.test.js`.

const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = "/memhome";
const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const CONFIG_DIR = path.join(TEST_DIR, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const TOKEN_PATH = path.join(CONFIG_DIR, "reviewer-token");

const real = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  mkdirSync: fs.mkdirSync,
  chmodSync: fs.chmodSync,
  statSync: fs.statSync,
  rmSync: fs.rmSync,
  renameSync: fs.renameSync,
  linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync,
};
const files = new Map([[CONFIG_PATH, JSON.stringify({ port: 8400, reviewer_github_user: "old-reviewer", projects: [] }, null, 2)]]);
const modes = new Map();
const dirs = new Set([CONFIG_DIR]);

fs.existsSync = function stubExistsSync(p) {
  const key = String(p);
  if (key.startsWith(TEST_DIR)) return files.has(key) || dirs.has(key);
  return real.existsSync.apply(this, arguments);
};
fs.readFileSync = function stubReadFileSync(p, ...rest) {
  const key = String(p);
  if (key.startsWith(TEST_DIR)) {
    if (!files.has(key)) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return files.get(key);
  }
  return real.readFileSync.call(this, p, ...rest);
};
fs.writeFileSync = function stubWriteFileSync(p, data, opts = {}) {
  const key = String(p);
  if (key.startsWith(TEST_DIR)) {
    files.set(key, String(data));
    if (opts && opts.mode) modes.set(key, opts.mode);
    return;
  }
  return real.writeFileSync.apply(this, arguments);
};
fs.mkdirSync = function stubMkdirSync(p, ...rest) {
  const key = String(p);
  if (key.startsWith(TEST_DIR)) { dirs.add(key); return; }
  return real.mkdirSync.call(this, p, ...rest);
};
fs.chmodSync = function stubChmodSync(p, mode) {
  const key = String(p);
  if (key.startsWith(TEST_DIR)) { modes.set(key, mode); return; }
  return real.chmodSync.apply(this, arguments);
};
fs.statSync = function stubStatSync(p, ...rest) {
  const key = String(p);
  if (key.startsWith(TEST_DIR)) return { mode: modes.get(key) || 0o600 };
  return real.statSync.call(this, p, ...rest);
};
// #971: writeConfig is now atomic (tmp write + renameSync) — model rename in the
// in-memory store so the config PUT/field-scoped writes still work here.
fs.renameSync = function stubRenameSync(src, dst) {
  const s = String(src), d = String(dst);
  if (s.startsWith(TEST_DIR) || d.startsWith(TEST_DIR)) {
    if (!files.has(s)) { const err = new Error("ENOENT"); err.code = "ENOENT"; throw err; }
    files.set(d, files.get(s));
    if (modes.has(s)) modes.set(d, modes.get(s));
    files.delete(s); modes.delete(s);
    return;
  }
  return real.renameSync.apply(this, arguments);
};
fs.linkSync = function stubLinkSync(src, dst) {
  const s = String(src), d = String(dst);
  if (s.startsWith(TEST_DIR) || d.startsWith(TEST_DIR)) {
    if (!files.has(s)) { const err = new Error("ENOENT"); err.code = "ENOENT"; throw err; }
    if (files.has(d)) { const err = new Error("EEXIST"); err.code = "EEXIST"; throw err; }
    files.set(d, files.get(s));
    if (modes.has(s)) modes.set(d, modes.get(s));
    return;
  }
  return real.linkSync.apply(this, arguments);
};
fs.unlinkSync = function stubUnlinkSync(p) {
  const key = String(p);
  if (key.startsWith(TEST_DIR)) {
    if (!files.has(key)) { const err = new Error("ENOENT"); err.code = "ENOENT"; throw err; }
    files.delete(key); modes.delete(key);
    return;
  }
  return real.unlinkSync.apply(this, arguments);
};

const express = require("express");
const router = require("./routes");

function cleanup() {
  os.homedir = origHome;
  fs.existsSync = real.existsSync;
  fs.readFileSync = real.readFileSync;
  fs.writeFileSync = real.writeFileSync;
  fs.mkdirSync = real.mkdirSync;
  fs.chmodSync = real.chmodSync;
  fs.statSync = real.statSync;
  fs.rmSync = real.rmSync;
  fs.renameSync = real.renameSync;
  fs.linkSync = real.linkSync;
  fs.unlinkSync = real.unlinkSync;
}
process.on("exit", cleanup);

function req(server, { method = "GET", urlPath, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  try {
    let status = await req(server, { urlPath: "/api/setup/reviewer-token-status" });
    assert.equal(status.status, 200, "status succeeds");
    assert.equal(status.json.exists, false, "missing token reports exists=false");
    assert.equal(status.json.path, TOKEN_PATH, "status returns path");
    assert.ok(!("token" in status.json), "status never returns token");
    console.log("  PASS: token status omits secret");

    const blank = await req(server, { method: "POST", urlPath: "/api/setup/save-token", body: { token: "   " } });
    assert.equal(blank.status, 400, "blank token rejected");
    assert.equal(fs.existsSync(TOKEN_PATH), false, "blank token does not create file");
    console.log("  PASS: blank token validation");

    const placeholderToken = "test-reviewer-token-placeholder";
    const saved = await req(server, { method: "POST", urlPath: "/api/setup/save-token", body: { token: placeholderToken } });
    assert.equal(saved.status, 200, "token save succeeds");
    assert.equal(saved.json.ok, true, "token save returns ok");
    assert.ok(!JSON.stringify(saved.json).includes(placeholderToken), "save response does not echo token");
    assert.equal(fs.readFileSync(TOKEN_PATH, "utf-8"), `${placeholderToken}\n`, "token written with newline");
    assert.equal(fs.statSync(TOKEN_PATH).mode & 0o777, 0o600, "token file mode is 0600");
    status = await req(server, { urlPath: "/api/setup/reviewer-token-status" });
    assert.equal(status.json.exists, true, "saved token reports exists=true");
    console.log("  PASS: token save is secure and status updates");

    const invalidUser = await req(server, { method: "PUT", urlPath: "/api/reviewer-github-user", body: { reviewer_github_user: "-bad-" } });
    assert.equal(invalidUser.status, 400, "invalid GitHub username rejected");
    assert.equal(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).reviewer_github_user, "old-reviewer", "invalid username does not mutate config");
    console.log("  PASS: reviewer user validation");

    const setUser = await req(server, { method: "PUT", urlPath: "/api/reviewer-github-user", body: { reviewer_github_user: "reviewer-bot" } });
    assert.equal(setUser.status, 200, "valid reviewer user saved");
    assert.equal(setUser.json.reviewer_github_user, "reviewer-bot", "response returns sanitized username only");
    assert.equal(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).reviewer_github_user, "reviewer-bot", "config updated");

    const staleFullSave = await req(server, {
      method: "PUT",
      urlPath: "/api/config",
      body: { port: 8400, reviewer_github_user: "old-reviewer", projects: [] },
    });
    assert.equal(staleFullSave.status, 200, "stale whole-config save succeeds");
    assert.equal(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).reviewer_github_user, "reviewer-bot", "scoped reviewer user survives stale whole-config PUT");

    const clearUser = await req(server, { method: "PUT", urlPath: "/api/reviewer-github-user", body: { reviewer_github_user: "" } });
    assert.equal(clearUser.status, 200, "blank reviewer user clears value");
    assert.equal(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).reviewer_github_user, undefined, "config key removed when blank");
    console.log("  PASS: reviewer user update and clear");

    console.log("\n5 passed, 0 failed\n");
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
